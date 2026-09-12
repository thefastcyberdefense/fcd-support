import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { z } from 'zod';

import {
  parseExecuteDeletionInput,
  parseOpenDeletionRequestInput,
  parseReviewDeletionRequestInput,
} from '../policy/deletion-command.js';
import { createIdentityHmac, requirePrivacyHmacKeyring } from '../policy/privacy-identity.js';
import { parsePrivacyIntent } from '../policy/privacy-intent.js';
import type {
  ChannelIdentitySelector,
  DeletionExecutionResult,
  OpenDeletionRequestInput,
  PrivacyHmacKeyring,
} from '../policy/policy-types.js';
import { requireSupportReviewer } from '../policy/reviewer-principal.js';
import { eraseLockedIdentities, type LockedDeletionIdentity } from './postgres-deletion-erasure.js';
import { lockAppliedCustomerEvent } from './postgres-policy-helpers.js';
import {
  PolicyIdempotencyConflictError,
  PolicyRecordNotFoundError,
} from './postgres-takeover-policy.js';
import { withBoundedTransaction } from './postgres-transaction.js';

export type OpenDeletionRequestResult =
  | { readonly status: 'opened'; readonly requestRef: string }
  | { readonly status: 'duplicate'; readonly requestRef: string };

export interface ReviewDeletionRequestResult {
  readonly requestRef: string;
  readonly state: 'human_review' | 'rejected';
  readonly status: 'applied' | 'duplicate';
}

const identitySchema = z.strictObject({
  channel: z.enum(['messenger', 'whatsapp']),
  channelAccountId: z.string().trim().min(1).max(255),
  externalContactId: z.string().trim().min(1).max(255),
});

const requiredDeletionLocations = [
  'primary_postgres',
  'manifest_recordings',
  'meta_provider',
  'pending_outbound',
  'operator_exports',
  'offline_archives',
  'backup_tombstone_gate',
] as const;

interface ExistingOpenRequestRow {
  readonly material_matches: boolean;
  readonly request_ref: string;
}

interface InsertedRequestRow {
  readonly id: string;
}

interface SuppressionMatchRow {
  readonly identity_deleted: boolean;
}

interface LockedDeletionRequestRow {
  readonly contact_id: string;
  readonly id: string;
  readonly received_at: Date;
  readonly source_webhook_event_id: string | null;
  readonly state: string;
}

interface ExistingReviewRow {
  readonly material_matches: boolean;
  readonly request_ref: string;
  readonly resulting_state: 'human_review' | 'rejected';
}

interface ExistingDeletionRunRow {
  readonly conversations_processed: number;
  readonly identities_pseudonymized: number;
  readonly material_matches: boolean;
  readonly messages_cleared: number;
  readonly request_ref: string;
  readonly tombstones_created: number;
}

interface LockedExecutionRequestRow {
  readonly contact_id: string | null;
  readonly id: string;
  readonly state: string;
}

function identitiesMatch(left: ChannelIdentitySelector, right: ChannelIdentitySelector): boolean {
  return (
    left.channel === right.channel &&
    left.channelAccountId === right.channelAccountId &&
    left.externalContactId === right.externalContactId
  );
}

function requireValidDate(value: Date, fieldName: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${fieldName} must be a valid Date`);
  }
}

export class PostgresDeletionPolicy {
  private readonly keyring: PrivacyHmacKeyring;

  public constructor(
    private readonly pool: pg.Pool,
    keyring: PrivacyHmacKeyring,
  ) {
    this.keyring = requirePrivacyHmacKeyring(keyring);
  }

  public async openRequest(input: unknown): Promise<OpenDeletionRequestResult> {
    const command = parseOpenDeletionRequestInput(input);
    return this.openValidatedRequest(command, false);
  }

  public async openIntentRequest(input: unknown): Promise<OpenDeletionRequestResult> {
    const command = parseOpenDeletionRequestInput(input);
    return this.openValidatedRequest(command, true);
  }

  private async openValidatedRequest(
    command: OpenDeletionRequestInput,
    requireExactIntent: boolean,
  ): Promise<OpenDeletionRequestResult> {
    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        command.requestKey,
      ]);

      const source = await lockAppliedCustomerEvent(client, command.sourceWebhookEventId);
      if (
        source === undefined ||
        !identitiesMatch(source, command.identity) ||
        source.occurredAt.getTime() !== command.requestedAt.getTime() ||
        (requireExactIntent && parsePrivacyIntent(source.messageText) !== 'deletion')
      ) {
        throw new PolicyRecordNotFoundError('Authoritative deletion request source not found');
      }

      const existing = await client.query<ExistingOpenRequestRow>(
        `select request_ref,
                request_type = 'deletion'
                  and contact_id = $2::bigint
                  and source_webhook_event_id = $3::bigint
                  and received_at = $4::timestamptz
                  as material_matches
         from privacy_requests
         where open_request_key = $1
         for update`,
        [command.requestKey, source.contactId, command.sourceWebhookEventId, command.requestedAt],
      );
      const replay = existing.rows[0];
      if (replay !== undefined) {
        if (!replay.material_matches) {
          throw new PolicyIdempotencyConflictError('Deletion request key material conflicts');
        }
        return { status: 'duplicate', requestRef: replay.request_ref };
      }

      const requestRef = randomUUID();
      const inserted = await client.query<InsertedRequestRow>(
        `insert into privacy_requests
           (request_ref, request_type, state, contact_id,
            source_webhook_event_id, received_at, open_request_key)
         values ($1, 'deletion', 'awaiting_confirmation', $2, $3, $4, $5)
         returning id`,
        [
          requestRef,
          source.contactId,
          command.sourceWebhookEventId,
          command.requestedAt,
          command.requestKey,
        ],
      );
      const requestId = inserted.rows[0]?.id;
      if (requestId === undefined) {
        throw new Error('Deletion request insert returned no identifier');
      }

      await client.query(
        `insert into privacy_request_locations
           (request_id, location_code, required, state)
         select $1, location_code, true, 'pending'
         from unnest($2::text[]) as location_code`,
        [requestId, [...requiredDeletionLocations]],
      );
      await client.query(
        `insert into privacy_request_events
           (request_id, action, outcome, reason_code, previous_state,
            resulting_state, actor_type, source_webhook_event_id,
            effective_at, request_key)
         values ($1, 'request_received', 'applied', 'customer_requested', null,
                 'awaiting_confirmation', 'customer', $2, $3, $4)`,
        [requestId, command.sourceWebhookEventId, command.requestedAt, command.requestKey],
      );
      await client.query(
        `insert into privacy_notification_intents
           (request_id, notification_type, state, idempotency_key)
         values ($1, 'operator_privacy_request', 'pending', $2)`,
        [requestId, `operator-privacy-request:${requestRef}`],
      );

      return { status: 'opened', requestRef };
    });
  }

  public async executeApprovedRequest(input: unknown): Promise<DeletionExecutionResult> {
    const command = parseExecuteDeletionInput(input);
    const activeKey = this.keyring.keys.get(this.keyring.activeVersion);
    if (activeKey === undefined) throw new Error('Active privacy key is missing');

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        command.requestKey,
      ]);

      const existing = await client.query<ExistingDeletionRunRow>(
        `select request.request_ref,
                run.conversations_processed,
                run.identities_pseudonymized,
                run.messages_cleared,
                run.tombstones_created,
                request.request_ref = $2
                  and run.executed_at = $3::timestamptz
                  as material_matches
         from privacy_deletion_runs as run
         join privacy_requests as request on request.id = run.request_id
         where run.request_key = $1`,
        [command.requestKey, command.requestRef, command.executedAt],
      );
      const replay = existing.rows[0];
      if (replay !== undefined) {
        if (!replay.material_matches) {
          throw new PolicyIdempotencyConflictError('Deletion execution key material conflicts');
        }
        return {
          conversationsProcessed: replay.conversations_processed,
          identitiesPseudonymized: replay.identities_pseudonymized,
          messagesCleared: replay.messages_cleared,
          requestRef: replay.request_ref,
          status: 'duplicate',
          tombstonesCreated: replay.tombstones_created,
        };
      }

      const selectedRequest = await client.query<LockedExecutionRequestRow>(
        `select id, state, contact_id
         from privacy_requests
         where request_ref = $1 and request_type = 'deletion'
         for update`,
        [command.requestRef],
      );
      const request = selectedRequest.rows[0];
      if (request?.contact_id == null || request.state !== 'human_review') {
        throw new PolicyRecordNotFoundError('Approved deletion request not found');
      }
      const lockedContact = await client.query(`select id from contacts where id = $1 for update`, [
        request.contact_id,
      ]);
      if (lockedContact.rows[0] === undefined) {
        throw new PolicyRecordNotFoundError('Deletion contact not found');
      }
      const identities = await client.query<LockedDeletionIdentity>(
        `select id, channel, channel_account_id, external_contact_id
         from channel_identities
         where contact_id = $1
         order by id
         for update`,
        [request.contact_id],
      );
      if (identities.rows.length === 0) {
        throw new PolicyRecordNotFoundError('Deletion identities not found');
      }

      let tombstonesCreated = 0;
      for (const identity of identities.rows) {
        const inserted = await client.query(
          `insert into privacy_suppressions
             (identity_hmac, channel, category, reason_code, effective_at, key_version)
           values ($1, $2, 'deletion_tombstone', 'customer_deletion', $3, $4)
           on conflict (identity_hmac, channel, category, key_version) do nothing
           returning id`,
          [
            createIdentityHmac(
              {
                channel: identity.channel,
                channelAccountId: identity.channel_account_id,
                externalContactId: identity.external_contact_id,
              },
              { key: activeKey, version: this.keyring.activeVersion },
            ),
            identity.channel,
            command.executedAt,
            this.keyring.activeVersion,
          ],
        );
        tombstonesCreated += inserted.rowCount ?? 0;
      }

      const erasure = await eraseLockedIdentities(
        client,
        this.keyring,
        identities.rows,
        command.executedAt,
      );
      await client.query(
        `update privacy_request_locations
         set state = 'completed',
             outcome_code = 'local_erasure_complete',
             checked_at = $2
         where request_id = $1
           and location_code in ('primary_postgres', 'pending_outbound')`,
        [request.id, command.executedAt],
      );
      await client.query(
        `update privacy_requests
         set state = 'in_progress',
             contact_id = null,
             source_webhook_event_id = null,
             updated_at = now(),
             row_version = row_version + 1
         where id = $1`,
        [request.id],
      );
      await client.query(
        `insert into privacy_request_events
           (request_id, action, outcome, reason_code, previous_state,
            resulting_state, actor_type, effective_at, request_key)
         values ($1, 'deletion_executed', 'applied', 'local_erasure_complete',
                 'human_review', 'in_progress', 'deletion_job', $2, $3)`,
        [request.id, command.executedAt, command.requestKey],
      );
      await client.query(
        `insert into privacy_deletion_runs
           (request_id, request_key, executed_at, conversations_processed,
            identities_pseudonymized, messages_cleared, tombstones_created,
            status, completed_at)
         values ($1, $2, $3, $4, $5, $6, $7, 'applied', $3)`,
        [
          request.id,
          command.requestKey,
          command.executedAt,
          erasure.conversationsProcessed,
          erasure.identitiesPseudonymized,
          erasure.messagesCleared,
          tombstonesCreated,
        ],
      );

      return {
        conversationsProcessed: erasure.conversationsProcessed,
        identitiesPseudonymized: erasure.identitiesPseudonymized,
        messagesCleared: erasure.messagesCleared,
        requestRef: command.requestRef,
        status: 'applied',
        tombstonesCreated,
      };
    });
  }

  public async isIdentityDeleted(identity: unknown, evaluatedAt: Date): Promise<boolean> {
    const parsedIdentity = identitySchema.parse(identity);
    requireValidDate(evaluatedAt, 'evaluatedAt');
    const keyVersions: string[] = [];
    const identityHmacs: string[] = [];
    for (const [version, key] of this.keyring.keys) {
      keyVersions.push(version);
      identityHmacs.push(createIdentityHmac(parsedIdentity, { key, version }));
    }

    const selected = await this.pool.query<SuppressionMatchRow>(
      `select exists (
         select 1
         from privacy_suppressions
         where channel = $1
           and category = 'deletion_tombstone'
           and effective_at <= $2
           and (expires_at is null or expires_at > $2)
           and (key_version, identity_hmac) in (
             select * from unnest($3::text[], $4::text[])
           )
       ) as identity_deleted`,
      [parsedIdentity.channel, evaluatedAt, keyVersions, identityHmacs],
    );
    return selected.rows[0]?.identity_deleted ?? false;
  }

  public async reviewRequest(
    input: unknown,
    principal: unknown,
  ): Promise<ReviewDeletionRequestResult> {
    const command = parseReviewDeletionRequestInput(input);
    const reviewer = requireSupportReviewer(principal);
    const resultingState = command.decision === 'approve' ? 'human_review' : 'rejected';
    const outcome = command.decision === 'approve' ? 'applied' : 'rejected';

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        command.requestKey,
      ]);

      const selectedRequest = await client.query<LockedDeletionRequestRow>(
        `select id, state, contact_id, source_webhook_event_id, received_at
         from privacy_requests
         where request_ref = $1
           and request_type = 'deletion'
         for update`,
        [command.requestRef],
      );
      const request = selectedRequest.rows[0];
      if (request?.source_webhook_event_id == null) {
        throw new PolicyRecordNotFoundError('Deletion request not found');
      }

      const source = await lockAppliedCustomerEvent(client, request.source_webhook_event_id);
      const confirmation = await lockAppliedCustomerEvent(
        client,
        command.confirmationWebhookEventId,
      );
      if (
        source === undefined ||
        confirmation === undefined ||
        source.contactId !== request.contact_id ||
        !identitiesMatch(source, confirmation) ||
        confirmation.occurredAt.getTime() < request.received_at.getTime() ||
        command.decidedAt.getTime() < confirmation.occurredAt.getTime()
      ) {
        throw new PolicyRecordNotFoundError('Authoritative deletion confirmation not found');
      }

      const existing = await client.query<ExistingReviewRow>(
        `select request.request_ref,
                history.resulting_state,
                history.action = 'reviewer_decision'
                  and request.request_ref = $2
                  and history.source_webhook_event_id = $3::bigint
                  and history.effective_at = $4::timestamptz
                  and history.reviewer_reference = $5
                  and history.resulting_state = $6
                  and history.outcome = $7
                  and history.reason_code = $8
                  and request.decision_code = $9
                  as material_matches
         from privacy_request_events as history
         join privacy_requests as request on request.id = history.request_id
         where history.request_key = $1`,
        [
          command.requestKey,
          command.requestRef,
          command.confirmationWebhookEventId,
          command.decidedAt,
          reviewer.reviewerRef,
          resultingState,
          outcome,
          command.reasonCode,
          command.verificationMethod,
        ],
      );
      const replay = existing.rows[0];
      if (replay !== undefined) {
        if (!replay.material_matches) {
          throw new PolicyIdempotencyConflictError(
            'Deletion review request key material conflicts',
          );
        }
        return {
          requestRef: replay.request_ref,
          state: replay.resulting_state,
          status: 'duplicate',
        };
      }
      if (request.state !== 'awaiting_confirmation') {
        throw new PolicyIdempotencyConflictError('Deletion request is not awaiting confirmation');
      }

      const updated = await client.query<InsertedRequestRow>(
        `update privacy_requests
         set state = $2,
             decision_at = $3,
             reviewer_reference = $4,
             decision_code = $5,
             reason_code = $6,
             updated_at = now(),
             row_version = row_version + 1
         where id = $1
           and state = 'awaiting_confirmation'
         returning id`,
        [
          request.id,
          resultingState,
          command.decidedAt,
          reviewer.reviewerRef,
          command.verificationMethod,
          command.reasonCode,
        ],
      );
      if (updated.rows[0] === undefined) {
        throw new PolicyIdempotencyConflictError('Deletion request transition conflicted');
      }

      await client.query(
        `insert into privacy_request_events
           (request_id, action, outcome, reason_code, previous_state,
            resulting_state, actor_type, reviewer_reference,
            source_webhook_event_id, effective_at, request_key)
         values ($1, 'reviewer_decision', $2, $3, 'awaiting_confirmation',
                 $4, 'support_reviewer', $5, $6, $7, $8)`,
        [
          request.id,
          outcome,
          command.reasonCode,
          resultingState,
          reviewer.reviewerRef,
          command.confirmationWebhookEventId,
          command.decidedAt,
          command.requestKey,
        ],
      );

      return { requestRef: command.requestRef, state: resultingState, status: 'applied' };
    });
  }
}
