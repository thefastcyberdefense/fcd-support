import type pg from 'pg';
import { z } from 'zod';

import { parseConsentCommand } from '../policy/consent-command.js';
import { createIdentityHmac, requirePrivacyHmacKeyring } from '../policy/privacy-identity.js';
import type {
  ChannelIdentitySelector,
  ConsentCommand,
  ConsentRecordResult,
  MarketingEligibility,
  PrivacyHmacKeyring,
} from '../policy/policy-types.js';
import { requireSupportReviewer } from '../policy/reviewer-principal.js';
import { insertPolicyAuditOutcome } from './postgres-policy-helpers.js';
import {
  PolicyIdempotencyConflictError,
  PolicyRecordNotFoundError,
} from './postgres-takeover-policy.js';
import { withBoundedTransaction } from './postgres-transaction.js';

const categoryPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const identitySelectorSchema = z.strictObject({
  channel: z.enum(['messenger', 'whatsapp']),
  channelAccountId: z.string().trim().min(1).max(255),
  externalContactId: z.string().trim().min(1).max(255),
});

interface IdentityRow {
  readonly id: string;
}

interface ExistingConsentRow {
  readonly id: string;
  readonly material_matches: boolean;
}

interface ConsentActionRow {
  readonly action: 'grant' | 'revoke';
}

interface SuppressionRow {
  readonly suppressed: boolean;
}

function normalizeIdentity(identity: unknown): ChannelIdentitySelector {
  const parsed = identitySelectorSchema.safeParse(identity);
  if (!parsed.success) {
    throw new TypeError('Identity selector is invalid');
  }
  return parsed.data;
}

function requireValidDate(value: Date, fieldName: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${fieldName} must be a valid Date`);
  }
}

export class PostgresConsentPolicy {
  private readonly keyring: PrivacyHmacKeyring;

  public constructor(
    private readonly pool: pg.Pool,
    keyring: PrivacyHmacKeyring,
  ) {
    this.keyring = requirePrivacyHmacKeyring(keyring);
  }

  public async recordCustomerCommand(input: unknown): Promise<ConsentRecordResult> {
    const command = parseConsentCommand(input);
    if (command.source !== 'customer_message') {
      throw new TypeError('Customer consent command source is invalid');
    }
    return this.recordCommand(command);
  }

  public async recordReviewerCommand(
    input: unknown,
    principal: unknown,
  ): Promise<ConsentRecordResult> {
    const command = parseConsentCommand(input);
    requireSupportReviewer(principal);
    if (command.source !== 'reviewer_recorded') {
      throw new TypeError('Reviewer consent command source is invalid');
    }
    return this.recordCommand(command);
  }

  public async evaluateMarketingEligibility(
    identity: ChannelIdentitySelector,
    category: string,
    evaluatedAt: Date,
  ): Promise<MarketingEligibility> {
    const normalizedIdentity = normalizeIdentity(identity);
    requireValidDate(evaluatedAt, 'evaluatedAt');
    const normalizedCategory = typeof category === 'string' ? category.trim() : '';
    const categoryIsValid = categoryPattern.test(normalizedCategory);

    return withBoundedTransaction(this.pool, async (client) => {
      if (!categoryIsValid) {
        await insertPolicyAuditOutcome(client, {
          decisionType: 'marketing_eligibility',
          evaluatedAt,
          outcome: 'denied',
          reasonCode: 'consent_missing',
        });
        return { eligible: false, reason: 'consent_missing' };
      }

      const selected = await client.query<IdentityRow>(
        `select id
         from channel_identities
         where channel = $1
           and channel_account_id = $2
           and external_contact_id = $3`,
        [
          normalizedIdentity.channel,
          normalizedIdentity.channelAccountId,
          normalizedIdentity.externalContactId,
        ],
      );
      const identityId = selected.rows[0]?.id;
      if (identityId === undefined) {
        await insertPolicyAuditOutcome(client, {
          decisionType: 'marketing_eligibility',
          evaluatedAt,
          outcome: 'denied',
          reasonCode: 'identity_not_found',
        });
        return { eligible: false, reason: 'identity_not_found' };
      }

      const keyVersions: string[] = [];
      const identityHmacs: string[] = [];
      for (const [version, key] of this.keyring.keys) {
        keyVersions.push(version);
        identityHmacs.push(
          createIdentityHmac(normalizedIdentity, {
            key,
            version,
          }),
        );
      }
      const suppression = await client.query<SuppressionRow>(
        `select exists (
           select 1
           from privacy_suppressions
           where channel = $1
             and category in (
               'marketing_opt_out',
               'marketing_opt_out:' || $5
             )
             and effective_at <= $2::timestamptz
             and (expires_at is null or expires_at > $2::timestamptz)
             and (key_version, identity_hmac) in (
               select * from unnest($3::text[], $4::text[])
             )
         ) as suppressed`,
        [normalizedIdentity.channel, evaluatedAt, keyVersions, identityHmacs, normalizedCategory],
      );
      if (suppression.rows[0]?.suppressed === true) {
        await insertPolicyAuditOutcome(client, {
          channelIdentityId: identityId,
          decisionType: 'marketing_eligibility',
          evaluatedAt,
          outcome: 'denied',
          reasonCode: 'global_marketing_opt_out',
        });
        return { eligible: false, reason: 'global_marketing_opt_out' };
      }

      const latest = await client.query<ConsentActionRow>(
        `select action
         from consent_events
         where channel_identity_id = $1
           and category = $2
           and source_at <= $3::timestamptz
         order by source_at desc, id desc
         limit 1`,
        [identityId, normalizedCategory, evaluatedAt],
      );
      const action = latest.rows[0]?.action;
      const eligible = action === 'grant';
      const reason =
        action === 'grant'
          ? 'consent_latest_grant'
          : action === 'revoke'
            ? 'consent_latest_revoke'
            : 'consent_missing';

      await insertPolicyAuditOutcome(client, {
        channelIdentityId: identityId,
        decisionType: 'marketing_eligibility',
        evaluatedAt,
        outcome: eligible ? 'allowed' : 'denied',
        reasonCode: reason,
      });
      return { eligible, reason };
    });
  }

  private async recordCommand(command: ConsentCommand): Promise<ConsentRecordResult> {
    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        command.idempotencyKey,
      ]);

      const findExisting = async (): Promise<ExistingConsentRow | undefined> => {
        const existing = await client.query<ExistingConsentRow>(
          `select consent.id,
                  identity.channel = $2
                    and identity.channel_account_id = $3
                    and identity.external_contact_id = $4
                    and consent.action = $5
                    and consent.category = $6
                    and consent.wording = $7
                    and consent.wording_version = $8
                    and consent.source = $9
                    and consent.source_at = $10::timestamptz
                    and consent.source_webhook_event_id
                      is not distinct from $11::bigint
                    as material_matches
           from consent_events as consent
           join channel_identities as identity
             on identity.id = consent.channel_identity_id
           where consent.idempotency_key = $1`,
          [
            command.idempotencyKey,
            command.identity.channel,
            command.identity.channelAccountId,
            command.identity.externalContactId,
            command.action,
            command.category,
            command.wording,
            command.wordingVersion,
            command.source,
            command.sourceAt,
            command.source === 'customer_message' ? command.sourceWebhookEventId : null,
          ],
        );
        return existing.rows[0];
      };

      const replay = await findExisting();
      if (replay !== undefined) {
        if (!replay.material_matches) {
          throw new PolicyIdempotencyConflictError('Consent key material conflicts');
        }
      }

      const selectedIdentity = await client.query<IdentityRow>(
        `select id
         from channel_identities
         where channel = $1
           and channel_account_id = $2
           and external_contact_id = $3
         for update`,
        [
          command.identity.channel,
          command.identity.channelAccountId,
          command.identity.externalContactId,
        ],
      );
      const identityId = selectedIdentity.rows[0]?.id;
      if (identityId === undefined) {
        throw new PolicyRecordNotFoundError('Channel identity not found');
      }

      if (command.source === 'customer_message') {
        const source = await client.query<IdentityRow>(
          `select source_event.id
           from webhook_events as source_event
           join webhook_event_applications as application
             on application.webhook_event_id = source_event.id
           join conversations
             on conversations.id = application.conversation_id
           where source_event.id = $1
             and source_event.event_kind = 'customer_message'
             and source_event.occurred_at = $2::timestamptz
             and application.outcome = 'customer_message_applied'
             and conversations.channel_identity_id = $3
           for update of source_event, application, conversations`,
          [command.sourceWebhookEventId, command.sourceAt, identityId],
        );
        if (source.rows[0] === undefined) {
          throw new PolicyRecordNotFoundError('Authoritative customer consent source not found');
        }
      }

      if (replay !== undefined) {
        return { consentEventId: replay.id, status: 'duplicate' };
      }

      const inserted = await client.query<IdentityRow>(
        `insert into consent_events
           (channel_identity_id, category, action, wording, wording_version,
            source, source_at, idempotency_key, source_webhook_event_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (idempotency_key) do nothing
         returning id`,
        [
          identityId,
          command.category,
          command.action,
          command.wording,
          command.wordingVersion,
          command.source,
          command.sourceAt,
          command.idempotencyKey,
          command.source === 'customer_message' ? command.sourceWebhookEventId : null,
        ],
      );
      const consentEventId = inserted.rows[0]?.id;
      if (consentEventId === undefined) {
        const concurrentReplay = await findExisting();
        if (concurrentReplay === undefined) {
          throw new Error('Consent insert returned no identifier');
        }
        if (!concurrentReplay.material_matches) {
          throw new PolicyIdempotencyConflictError('Consent key material conflicts');
        }
        return { consentEventId: concurrentReplay.id, status: 'duplicate' };
      }

      await insertPolicyAuditOutcome(client, {
        channelIdentityId: identityId,
        decisionType: 'consent_record',
        evaluatedAt: command.sourceAt,
        outcome: 'applied',
        reasonCode: command.action === 'grant' ? 'consent_grant' : 'consent_revoke',
        ...(command.source === 'customer_message'
          ? { relatedWebhookEventId: command.sourceWebhookEventId }
          : {}),
      });

      return { consentEventId, status: 'applied' };
    });
  }
}
