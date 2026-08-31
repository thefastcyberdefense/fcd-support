import { randomUUID } from 'node:crypto';

import type pg from 'pg';

import {
  parseAttestPrivacyLocationInput,
  parseProcessPrivacyIntentInput,
  parseReviewPrivacyRequestInput,
} from '../policy/privacy-rights-command.js';
import { parsePrivacyIntent } from '../policy/privacy-intent.js';
import type { PrivacyHmacKeyring, PrivacyLocationCode } from '../policy/policy-types.js';
import { requirePrivacyHmacKeyring } from '../policy/privacy-identity.js';
import { requireSupportReviewer } from '../policy/reviewer-principal.js';
import { PostgresDeletionPolicy } from './postgres-deletion-policy.js';
import { PostgresMarketingOptOutPolicy } from './postgres-marketing-opt-out-policy.js';
import { lockAppliedCustomerEvent } from './postgres-policy-helpers.js';
import {
  PolicyIdempotencyConflictError,
  PolicyRecordNotFoundError,
} from './postgres-takeover-policy.js';
import { withBoundedTransaction } from './postgres-transaction.js';

type ReviewedPrivacyIntent = 'access' | 'correction';
type PrivacyRequestState = 'human_review' | 'in_progress' | 'rejected';

export type ProcessPrivacyIntentResult =
  | { readonly status: 'not_a_privacy_intent' }
  | {
      readonly intent: ReviewedPrivacyIntent | 'deletion';
      readonly requestRef: string;
      readonly status: 'duplicate' | 'opened';
    }
  | {
      readonly intent: 'marketing_opt_out';
      readonly categoryRevocations: number;
      readonly linkedIdentities: number;
      readonly pendingIntentsCancelled: number;
      readonly status: 'applied' | 'duplicate';
      readonly suppressionsCreated: number;
    };

export interface ReviewPrivacyRequestResult {
  readonly requestRef: string;
  readonly state: 'in_progress' | 'rejected';
  readonly status: 'applied' | 'duplicate';
}

export interface AttestPrivacyLocationResult {
  readonly locationCode: PrivacyLocationCode;
  readonly requestRef: string;
  readonly state: 'completed' | 'failed' | 'not_applicable';
  readonly status: 'applied' | 'duplicate';
}

interface ExistingOpenRequestRow {
  readonly material_matches: boolean;
  readonly request_ref: string;
}

interface IdentifierRow {
  readonly id: string;
}

interface LockedPrivacyRequestRow {
  readonly id: string;
  readonly request_type: ReviewedPrivacyIntent;
  readonly state: PrivacyRequestState;
}

interface ExistingReviewRow {
  readonly material_matches: boolean;
  readonly request_ref: string;
  readonly resulting_state: 'in_progress' | 'rejected';
}

interface ExistingLocationRow {
  readonly location_code: PrivacyLocationCode;
  readonly material_matches: boolean;
  readonly request_ref: string;
  readonly state: 'completed' | 'failed' | 'not_applicable';
}

const locationCodes = [
  'backup_tombstone_gate',
  'manifest_recordings',
  'meta_provider',
  'offline_archives',
  'operator_exports',
  'pending_outbound',
  'primary_postgres',
] as const satisfies readonly PrivacyLocationCode[];

const nonApplicableByIntent = {
  access: new Set<PrivacyLocationCode>(['backup_tombstone_gate']),
  correction: new Set<PrivacyLocationCode>(['backup_tombstone_gate', 'operator_exports']),
} as const;

function locationState(
  outcomeCode: 'location_complete' | 'location_failed' | 'location_not_applicable',
): 'completed' | 'failed' | 'not_applicable' {
  switch (outcomeCode) {
    case 'location_complete':
      return 'completed';
    case 'location_failed':
      return 'failed';
    case 'location_not_applicable':
      return 'not_applicable';
  }
}

export class PostgresPrivacyRightsPolicy {
  private readonly deletionPolicy: PostgresDeletionPolicy;
  private readonly marketingOptOutPolicy: PostgresMarketingOptOutPolicy;

  public constructor(
    private readonly pool: pg.Pool,
    keyring: PrivacyHmacKeyring,
  ) {
    const validatedKeyring = requirePrivacyHmacKeyring(keyring);
    this.deletionPolicy = new PostgresDeletionPolicy(pool, validatedKeyring);
    this.marketingOptOutPolicy = new PostgresMarketingOptOutPolicy(pool, validatedKeyring);
  }

  public async processAppliedEvent(input: unknown): Promise<ProcessPrivacyIntentResult> {
    const command = parseProcessPrivacyIntentInput(input);
    const classified = await withBoundedTransaction(this.pool, async (client) => {
      const source = await lockAppliedCustomerEvent(client, command.sourceWebhookEventId);
      if (source === undefined) {
        throw new PolicyRecordNotFoundError('Authoritative privacy intent source not found');
      }
      return { intent: parsePrivacyIntent(source.messageText), source };
    });
    if (classified.intent === null) return { status: 'not_a_privacy_intent' };
    if (classified.intent === 'marketing_opt_out') {
      const result = await this.marketingOptOutPolicy.apply({
        effectiveAt: classified.source.occurredAt,
        requestKey: command.requestKey,
        sourceWebhookEventId: command.sourceWebhookEventId,
      });
      return { intent: classified.intent, ...result };
    }
    if (classified.intent === 'deletion') {
      const result = await this.deletionPolicy.openIntentRequest({
        identity: {
          channel: classified.source.channel,
          channelAccountId: classified.source.channelAccountId,
          externalContactId: classified.source.externalContactId,
        },
        requestedAt: classified.source.occurredAt,
        requestKey: command.requestKey,
        sourceWebhookEventId: command.sourceWebhookEventId,
      });
      return {
        intent: classified.intent,
        requestRef: result.requestRef,
        status: result.status,
      };
    }
    const reviewedIntent = classified.intent;

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        command.requestKey,
      ]);
      const source = await lockAppliedCustomerEvent(client, command.sourceWebhookEventId);
      if (source === undefined) {
        throw new PolicyRecordNotFoundError('Authoritative privacy intent source not found');
      }
      const intent = parsePrivacyIntent(source.messageText);
      if (intent !== reviewedIntent) {
        throw new PolicyIdempotencyConflictError('Privacy intent source changed during processing');
      }
      return this.openReviewedRequest(client, command, source, reviewedIntent);
    });
  }

  public async reviewRequest(
    input: unknown,
    principal: unknown,
  ): Promise<ReviewPrivacyRequestResult> {
    const command = parseReviewPrivacyRequestInput(input);
    const reviewer = requireSupportReviewer(principal);
    const resultingState = command.decision === 'approve' ? 'in_progress' : 'rejected';
    const outcome = command.decision === 'approve' ? 'applied' : 'rejected';

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        command.requestKey,
      ]);
      const selected = await client.query<LockedPrivacyRequestRow>(
        `select id, request_type, state
         from privacy_requests
         where request_ref = $1
           and request_type in ('access', 'correction')
         for update`,
        [command.requestRef],
      );
      const request = selected.rows[0];
      if (request === undefined) {
        throw new PolicyRecordNotFoundError('Privacy request not found');
      }

      const existing = await client.query<ExistingReviewRow>(
        `select request.request_ref,
                history.resulting_state,
                history.action = 'reviewer_decision'
                  and request.request_ref = $2
                  and history.effective_at = $3::timestamptz
                  and history.reviewer_reference = $4
                  and history.resulting_state = $5
                  and history.outcome = $6
                  and history.reason_code = $7
                  and request.decision_code = $8
                  as material_matches
         from privacy_request_events as history
         join privacy_requests as request on request.id = history.request_id
         where history.request_key = $1`,
        [
          command.requestKey,
          command.requestRef,
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
          throw new PolicyIdempotencyConflictError('Privacy review key material conflicts');
        }
        return {
          requestRef: replay.request_ref,
          state: replay.resulting_state,
          status: 'duplicate',
        };
      }
      if (request.state !== 'human_review') {
        throw new PolicyIdempotencyConflictError('Privacy request is not awaiting review');
      }

      const updated = await client.query<IdentifierRow>(
        `update privacy_requests
         set state = $2,
             decision_at = $3,
             reviewer_reference = $4,
             decision_code = $5,
             reason_code = $6,
             updated_at = now(),
             row_version = row_version + 1
         where id = $1 and state = 'human_review'
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
        throw new PolicyIdempotencyConflictError('Privacy request review conflicted');
      }
      await client.query(
        `insert into privacy_request_events
           (request_id, action, outcome, reason_code, previous_state,
            resulting_state, actor_type, reviewer_reference,
            effective_at, request_key)
         values ($1, 'reviewer_decision', $2, $3, 'human_review',
                 $4, 'support_reviewer', $5, $6, $7)`,
        [
          request.id,
          outcome,
          command.reasonCode,
          resultingState,
          reviewer.reviewerRef,
          command.decidedAt,
          command.requestKey,
        ],
      );
      return { requestRef: command.requestRef, state: resultingState, status: 'applied' };
    });
  }

  public async attestLocation(
    input: unknown,
    principal: unknown,
  ): Promise<AttestPrivacyLocationResult> {
    const command = parseAttestPrivacyLocationInput(input);
    const reviewer = requireSupportReviewer(principal);
    const state = locationState(command.outcomeCode);

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        command.requestKey,
      ]);
      const selected = await client.query<LockedPrivacyRequestRow>(
        `select id, request_type, state
         from privacy_requests
         where request_ref = $1
           and request_type in ('access', 'correction')
         for update`,
        [command.requestRef],
      );
      const request = selected.rows[0];
      if (request === undefined) {
        throw new PolicyRecordNotFoundError('Privacy request not found');
      }

      const existing = await client.query<ExistingLocationRow>(
        `select request.request_ref,
                history.location_code,
                location.state,
                history.action = 'location_checked'
                  and request.request_ref = $2
                  and history.location_code = $3
                  and history.effective_at = $4::timestamptz
                  and history.reviewer_reference = $5
                  and history.reason_code = $6
                  and location.outcome_code = $6
                  as material_matches
         from privacy_request_events as history
         join privacy_requests as request on request.id = history.request_id
         join privacy_request_locations as location
           on location.request_id = request.id
          and location.location_code = history.location_code
         where history.request_key = $1`,
        [
          command.requestKey,
          command.requestRef,
          command.locationCode,
          command.checkedAt,
          reviewer.reviewerRef,
          command.outcomeCode,
        ],
      );
      const replay = existing.rows[0];
      if (replay !== undefined) {
        if (!replay.material_matches) {
          throw new PolicyIdempotencyConflictError('Privacy location key material conflicts');
        }
        return {
          locationCode: replay.location_code,
          requestRef: replay.request_ref,
          state: replay.state,
          status: 'duplicate',
        };
      }
      if (request.state !== 'in_progress') {
        throw new PolicyIdempotencyConflictError('Privacy request is not in progress');
      }

      const updated = await client.query<IdentifierRow>(
        `update privacy_request_locations
         set state = $3,
             outcome_code = $4,
             reviewer_reference = $5,
             checked_at = $6
         where request_id = $1
           and location_code = $2
         returning request_id as id`,
        [
          request.id,
          command.locationCode,
          state,
          command.outcomeCode,
          reviewer.reviewerRef,
          command.checkedAt,
        ],
      );
      if (updated.rows[0] === undefined) {
        throw new PolicyRecordNotFoundError('Privacy request location not found');
      }
      await client.query(
        `insert into privacy_request_events
           (request_id, action, outcome, reason_code, previous_state,
            resulting_state, actor_type, reviewer_reference,
            effective_at, request_key, location_code)
         values ($1, 'location_checked', 'applied', $2, 'in_progress',
                 'in_progress', 'support_reviewer', $3, $4, $5, $6)`,
        [
          request.id,
          command.outcomeCode,
          reviewer.reviewerRef,
          command.checkedAt,
          command.requestKey,
          command.locationCode,
        ],
      );
      return {
        locationCode: command.locationCode,
        requestRef: command.requestRef,
        state,
        status: 'applied',
      };
    });
  }

  private async openReviewedRequest(
    client: pg.PoolClient,
    command: { readonly requestKey: string; readonly sourceWebhookEventId: string },
    source: {
      readonly contactId: string;
      readonly occurredAt: Date;
    },
    intent: ReviewedPrivacyIntent,
  ): Promise<ProcessPrivacyIntentResult> {
    const existing = await client.query<ExistingOpenRequestRow>(
      `select request_ref,
              request_type = $2
                and contact_id = $3::bigint
                and source_webhook_event_id = $4::bigint
                and received_at = $5::timestamptz
                as material_matches
       from privacy_requests
       where open_request_key = $1
       for update`,
      [
        command.requestKey,
        intent,
        source.contactId,
        command.sourceWebhookEventId,
        source.occurredAt,
      ],
    );
    const replay = existing.rows[0];
    if (replay !== undefined) {
      if (!replay.material_matches) {
        throw new PolicyIdempotencyConflictError('Privacy request key material conflicts');
      }
      return { intent, requestRef: replay.request_ref, status: 'duplicate' };
    }

    const requestRef = randomUUID();
    const inserted = await client.query<IdentifierRow>(
      `insert into privacy_requests
         (request_ref, request_type, state, contact_id,
          source_webhook_event_id, received_at, open_request_key)
       values ($1, $2, 'human_review', $3, $4, $5, $6)
       returning id`,
      [
        requestRef,
        intent,
        source.contactId,
        command.sourceWebhookEventId,
        source.occurredAt,
        command.requestKey,
      ],
    );
    const requestId = inserted.rows[0]?.id;
    if (requestId === undefined) {
      throw new Error('Privacy request insert returned no identifier');
    }

    const nonApplicable = nonApplicableByIntent[intent];
    await client.query(
      `insert into privacy_request_locations
         (request_id, location_code, required, state)
       select $1,
              location_code,
              not (location_code = any($3::text[])),
              case
                when location_code = any($3::text[]) then 'not_applicable'
                else 'pending'
              end
       from unnest($2::text[]) as location_code`,
      [requestId, [...locationCodes], [...nonApplicable]],
    );
    await client.query(
      `insert into privacy_request_events
         (request_id, action, outcome, reason_code, previous_state,
          resulting_state, actor_type, source_webhook_event_id,
          effective_at, request_key)
       values ($1, 'request_received', 'applied', 'customer_requested',
               null, 'human_review', 'customer', $2, $3, $4)`,
      [requestId, command.sourceWebhookEventId, source.occurredAt, command.requestKey],
    );
    await client.query(
      `insert into privacy_notification_intents
         (request_id, notification_type, state, idempotency_key)
       values ($1, 'operator_privacy_request', 'pending', $2)`,
      [requestId, `operator-privacy-request:${requestRef}`],
    );

    return { intent, requestRef, status: 'opened' };
  }
}
