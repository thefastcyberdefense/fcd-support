import { createHash } from 'node:crypto';

import type pg from 'pg';

import {
  parseExplicitMarketingReoptInInput,
  parseMarketingOptOutInput,
} from '../policy/privacy-rights-command.js';
import { createIdentityHmac, requirePrivacyHmacKeyring } from '../policy/privacy-identity.js';
import { parsePrivacyIntent } from '../policy/privacy-intent.js';
import type {
  ChannelIdentitySelector,
  ExplicitMarketingReoptInInput,
  PrivacyHmacKeyring,
} from '../policy/policy-types.js';
import { MARKETING_CATEGORIES } from '../policy/policy-types.js';
import { requireSupportReviewer } from '../policy/reviewer-principal.js';
import { lockAppliedCustomerEvent } from './postgres-policy-helpers.js';
import {
  PolicyIdempotencyConflictError,
  PolicyRecordNotFoundError,
} from './postgres-takeover-policy.js';
import { withBoundedTransaction } from './postgres-transaction.js';

export interface MarketingOptOutResult {
  readonly categoryRevocations: number;
  readonly linkedIdentities: number;
  readonly pendingIntentsCancelled: number;
  readonly status: 'applied' | 'duplicate';
  readonly suppressionsCreated: number;
}

export interface MarketingReoptInResult {
  readonly categoryGrants: number;
  readonly linkedIdentities: number;
  readonly status: 'applied' | 'duplicate';
  readonly suppressionsCleared: number;
}

interface LockedIdentityRow {
  readonly channel: 'messenger' | 'whatsapp';
  readonly channel_account_id: string;
  readonly external_contact_id: string;
  readonly id: string;
}

interface ExistingOptOutRow {
  readonly category_revocations_count: number;
  readonly linked_identities_count: number;
  readonly material_matches: boolean;
  readonly pending_intents_cancelled_count: number;
  readonly suppressions_created_count: number;
}

interface ExistingReoptInRow {
  readonly category_grants_count: number;
  readonly linked_identities_count: number;
  readonly material_matches: boolean;
  readonly suppressions_cleared_count: number;
}

interface IdentifierRow {
  readonly id: string;
}

interface CategoryRow {
  readonly category: string;
}

interface InsertedSuppressionRow {
  readonly inserted: boolean;
}

function selector(row: LockedIdentityRow): ChannelIdentitySelector {
  return {
    channel: row.channel,
    channelAccountId: row.channel_account_id,
    externalContactId: row.external_contact_id,
  };
}

function commandDigest(requestKey: string): string {
  return createHash('sha256').update(requestKey, 'utf8').digest('hex').slice(0, 32);
}

export class PostgresMarketingOptOutPolicy {
  private readonly keyring: PrivacyHmacKeyring;

  public constructor(
    private readonly pool: pg.Pool,
    keyring: PrivacyHmacKeyring,
  ) {
    this.keyring = requirePrivacyHmacKeyring(keyring);
  }

  public async apply(input: unknown): Promise<MarketingOptOutResult> {
    const command = parseMarketingOptOutInput(input);
    const activeKey = this.keyring.keys.get(this.keyring.activeVersion);
    if (activeKey === undefined) throw new Error('Active privacy key is missing');

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(
        `select pg_advisory_xact_lock(
           hashtextextended('marketing-opt-out-source:' || $1::text, 0::bigint)
         )`,
        [command.sourceWebhookEventId],
      );
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        command.requestKey,
      ]);

      const exactReplay = await this.findExistingOptOut(
        client,
        command.requestKey,
        command.sourceWebhookEventId,
        command.effectiveAt,
      );
      if (exactReplay !== undefined) return this.optOutReplay(exactReplay);

      const logicalReplay = await this.findExistingOptOutBySource(
        client,
        command.sourceWebhookEventId,
        command.effectiveAt,
      );
      if (logicalReplay !== undefined) return this.optOutReplay(logicalReplay);

      const source = await lockAppliedCustomerEvent(client, command.sourceWebhookEventId);
      if (
        source?.occurredAt.getTime() !== command.effectiveAt.getTime() ||
        parsePrivacyIntent(source.messageText) !== 'marketing_opt_out'
      ) {
        throw new PolicyRecordNotFoundError('Authoritative marketing opt-out source not found');
      }

      const contact = await client.query<IdentifierRow>(
        `select id from contacts where id = $1 for update`,
        [source.contactId],
      );
      if (contact.rows[0] === undefined) {
        throw new PolicyRecordNotFoundError('Marketing opt-out contact not found');
      }
      const identities = await client.query<LockedIdentityRow>(
        `select id, channel, channel_account_id, external_contact_id
         from channel_identities
         where contact_id = $1
         order by id
         for update`,
        [source.contactId],
      );
      if (identities.rows.length === 0) {
        throw new PolicyRecordNotFoundError('Linked marketing identities not found');
      }
      const categories = await client.query<CategoryRow>(
        `select distinct consent.category
         from consent_events as consent
         join channel_identities as identity
           on identity.id = consent.channel_identity_id
         where identity.contact_id = $1
         order by consent.category`,
        [source.contactId],
      );

      let categoryRevocations = 0;
      for (const identity of identities.rows) {
        for (const { category } of categories.rows) {
          const inserted = await client.query<IdentifierRow>(
            `insert into consent_events
               (channel_identity_id, category, action, wording,
                wording_version, source, source_at, idempotency_key,
                source_webhook_event_id)
             values ($1, $2, 'revoke', 'STOP MARKETING',
                     'privacy-intent-v1', 'customer_message', $3, $4, $5)
             on conflict (idempotency_key) do nothing
             returning id`,
            [
              identity.id,
              category,
              command.effectiveAt,
              `privacy-optout:${command.sourceWebhookEventId}:${identity.id}:${category}`,
              command.sourceWebhookEventId,
            ],
          );
          if (inserted.rows[0] === undefined) {
            throw new PolicyIdempotencyConflictError(
              'Marketing opt-out consent insertion conflicted',
            );
          }
          categoryRevocations += 1;
        }
      }

      let suppressionsCreated = 0;
      for (const identity of identities.rows) {
        for (const category of MARKETING_CATEGORIES) {
          const suppression = await client.query<InsertedSuppressionRow>(
            `insert into privacy_suppressions
               (identity_hmac, channel, category, reason_code,
                effective_at, key_version, expires_at)
             values ($1, $2, $3, 'customer_opt_out',
                     $4, $5, null)
             on conflict (identity_hmac, channel, category, key_version)
             do update set
               reason_code = 'customer_opt_out',
               effective_at = greatest(
                 privacy_suppressions.effective_at,
                 excluded.effective_at
               ),
               expires_at = null
             returning (xmax = 0) as inserted`,
            [
              createIdentityHmac(selector(identity), {
                key: activeKey,
                version: this.keyring.activeVersion,
              }),
              identity.channel,
              `marketing_opt_out:${category}`,
              command.effectiveAt,
              this.keyring.activeVersion,
            ],
          );
          if (suppression.rows[0]?.inserted) suppressionsCreated += 1;
        }
      }

      const run = await client.query<IdentifierRow>(
        `insert into privacy_marketing_opt_out_runs
           (source_webhook_event_id, request_key, effective_at,
            linked_identities_count, category_revocations_count,
            suppressions_created_count, pending_intents_cancelled_count,
            status)
         values ($1, $2, $3, $4, $5, $6, 0, 'applied')
         returning id`,
        [
          command.sourceWebhookEventId,
          command.requestKey,
          command.effectiveAt,
          identities.rows.length,
          categoryRevocations,
          suppressionsCreated,
        ],
      );
      const runId = run.rows[0]?.id;
      if (runId === undefined) {
        throw new Error('Marketing opt-out run insert returned no identifier');
      }
      await client.query(
        `insert into privacy_notification_intents
           (marketing_opt_out_run_id, notification_type, state, idempotency_key)
         values ($1, 'operator_marketing_opt_out', 'pending', $2)`,
        [runId, `operator-marketing-opt-out:${runId}`],
      );

      return {
        categoryRevocations,
        linkedIdentities: identities.rows.length,
        pendingIntentsCancelled: 0,
        status: 'applied',
        suppressionsCreated,
      };
    });
  }

  public async recordExplicitReoptIn(
    input: unknown,
    principal: unknown,
  ): Promise<MarketingReoptInResult> {
    const command = parseExplicitMarketingReoptInInput(input);
    const reviewer = requireSupportReviewer(principal);

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        command.requestKey,
      ]);
      const contact = await client.query<IdentifierRow>(
        `select contact.id
         from contacts as contact
         join channel_identities as identity
           on identity.contact_id = contact.id
         where identity.channel = $1
           and identity.channel_account_id = $2
           and identity.external_contact_id = $3
         for update of contact`,
        [
          command.identity.channel,
          command.identity.channelAccountId,
          command.identity.externalContactId,
        ],
      );
      const contactId = contact.rows[0]?.id;
      if (contactId === undefined) {
        throw new PolicyRecordNotFoundError('Marketing re-opt-in identity not found');
      }
      const anchor = await client.query<LockedIdentityRow & { readonly contact_id: string }>(
        `select id, contact_id, channel, channel_account_id, external_contact_id
         from channel_identities
         where channel = $1
           and channel_account_id = $2
           and external_contact_id = $3
           and contact_id = $4
         for update`,
        [
          command.identity.channel,
          command.identity.channelAccountId,
          command.identity.externalContactId,
          contactId,
        ],
      );
      const anchorIdentity = anchor.rows[0];
      if (anchorIdentity === undefined) {
        throw new PolicyRecordNotFoundError('Marketing re-opt-in identity not found');
      }

      const replay = await client.query<ExistingReoptInRow>(
        `select linked_identities_count,
                category_grants_count,
                suppressions_cleared_count,
                anchor_channel_identity_id = $2::bigint
                  and category_codes = $3::text[]
                  and effective_at = $4::timestamptz
                  and scope = $5
                  and reviewer_reference = $6
                  and verification_method = $7
                  as material_matches
         from privacy_marketing_reopt_in_runs
         where request_key = $1`,
        [
          command.requestKey,
          anchorIdentity.id,
          [...command.categories],
          command.effectiveAt,
          command.scope,
          reviewer.reviewerRef,
          command.verificationMethod,
        ],
      );
      const existing = replay.rows[0];
      if (existing !== undefined) {
        if (!existing.material_matches) {
          throw new PolicyIdempotencyConflictError('Marketing re-opt-in key material conflicts');
        }
        return {
          categoryGrants: existing.category_grants_count,
          linkedIdentities: existing.linked_identities_count,
          status: 'duplicate',
          suppressionsCleared: existing.suppressions_cleared_count,
        };
      }

      const identities = await this.lockReoptInScope(client, command, anchorIdentity);
      let suppressionsCleared = 0;
      for (const identity of identities) {
        const keyVersions: string[] = [];
        const identityHmacs: string[] = [];
        for (const [version, key] of this.keyring.keys) {
          keyVersions.push(version);
          identityHmacs.push(createIdentityHmac(selector(identity), { key, version }));
        }
        await client.query(
          `insert into privacy_suppressions
             (identity_hmac, channel, category, reason_code,
              effective_at, key_version, expires_at)
           select legacy.identity_hmac,
                  legacy.channel,
                  scoped.category,
                  legacy.reason_code,
                  legacy.effective_at,
                  legacy.key_version,
                  legacy.expires_at
           from privacy_suppressions as legacy
           cross join unnest($4::text[]) as scoped(category)
           where legacy.channel = $1
             and legacy.category = 'marketing_opt_out'
             and (legacy.key_version, legacy.identity_hmac) in (
               select * from unnest($2::text[], $3::text[])
             )
           on conflict (identity_hmac, channel, category, key_version)
           do nothing`,
          [
            identity.channel,
            keyVersions,
            identityHmacs,
            MARKETING_CATEGORIES.map((category) => `marketing_opt_out:${category}`),
          ],
        );
        await client.query(
          `update privacy_suppressions
           set expires_at = $4
           where channel = $1
             and category = 'marketing_opt_out'
             and effective_at < $4::timestamptz
             and (expires_at is null or expires_at > $4::timestamptz)
             and (key_version, identity_hmac) in (
               select * from unnest($2::text[], $3::text[])
             )`,
          [identity.channel, keyVersions, identityHmacs, command.effectiveAt],
        );
        const expired = await client.query(
          `update privacy_suppressions
           set expires_at = $4
           where channel = $1
             and category = any($5::text[])
             and effective_at < $4::timestamptz
             and (expires_at is null or expires_at > $4::timestamptz)
             and (key_version, identity_hmac) in (
               select * from unnest($2::text[], $3::text[])
             )`,
          [
            identity.channel,
            keyVersions,
            identityHmacs,
            command.effectiveAt,
            command.categories.map((category) => `marketing_opt_out:${category}`),
          ],
        );
        suppressionsCleared += expired.rowCount ?? 0;
      }

      const digest = commandDigest(command.requestKey);
      let categoryGrants = 0;
      for (const identity of identities) {
        for (const category of command.categories) {
          const inserted = await client.query<IdentifierRow>(
            `insert into consent_events
               (channel_identity_id, category, action, wording,
                wording_version, source, source_at, idempotency_key)
             values ($1, $2, 'grant', 'EXPLICIT MARKETING RE-OPT-IN',
                     'privacy-intent-v1', 'reviewer_recorded', $3, $4)
             returning id`,
            [
              identity.id,
              category,
              command.effectiveAt,
              `privacy-reoptin:${digest}:${identity.id}:${category}`,
            ],
          );
          if (inserted.rows[0] === undefined) {
            throw new Error('Marketing re-opt-in consent insert returned no identifier');
          }
          categoryGrants += 1;
        }
      }

      await client.query(
        `insert into privacy_marketing_reopt_in_runs
           (request_key, anchor_channel_identity_id, category_codes,
            effective_at, scope, linked_identities_count,
            category_grants_count, suppressions_cleared_count,
            reviewer_reference, verification_method, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'applied')`,
        [
          command.requestKey,
          anchorIdentity.id,
          [...command.categories],
          command.effectiveAt,
          command.scope,
          identities.length,
          categoryGrants,
          suppressionsCleared,
          reviewer.reviewerRef,
          command.verificationMethod,
        ],
      );
      return {
        categoryGrants,
        linkedIdentities: identities.length,
        status: 'applied',
        suppressionsCleared,
      };
    });
  }

  private async findExistingOptOut(
    client: pg.PoolClient,
    requestKey: string,
    sourceWebhookEventId: string,
    effectiveAt: Date,
  ): Promise<ExistingOptOutRow | undefined> {
    const selected = await client.query<ExistingOptOutRow>(
      `select linked_identities_count,
              category_revocations_count,
              suppressions_created_count,
              pending_intents_cancelled_count,
              source_webhook_event_id = $2::bigint
                and effective_at = $3::timestamptz
                as material_matches
       from privacy_marketing_opt_out_runs
       where request_key = $1`,
      [requestKey, sourceWebhookEventId, effectiveAt],
    );
    const row = selected.rows[0];
    if (row !== undefined && !row.material_matches) {
      throw new PolicyIdempotencyConflictError('Marketing opt-out key material conflicts');
    }
    return row;
  }

  private async findExistingOptOutBySource(
    client: pg.PoolClient,
    sourceWebhookEventId: string,
    effectiveAt: Date,
  ): Promise<ExistingOptOutRow | undefined> {
    const selected = await client.query<ExistingOptOutRow>(
      `select linked_identities_count,
              category_revocations_count,
              suppressions_created_count,
              pending_intents_cancelled_count,
              effective_at = $2::timestamptz as material_matches
       from privacy_marketing_opt_out_runs
       where source_webhook_event_id = $1`,
      [sourceWebhookEventId, effectiveAt],
    );
    const row = selected.rows[0];
    if (row !== undefined && !row.material_matches) {
      throw new PolicyIdempotencyConflictError('Marketing opt-out source material conflicts');
    }
    return row;
  }

  private optOutReplay(row: ExistingOptOutRow): MarketingOptOutResult {
    return {
      categoryRevocations: row.category_revocations_count,
      linkedIdentities: row.linked_identities_count,
      pendingIntentsCancelled: row.pending_intents_cancelled_count,
      status: 'duplicate',
      suppressionsCreated: row.suppressions_created_count,
    };
  }

  private async lockReoptInScope(
    client: pg.PoolClient,
    command: ExplicitMarketingReoptInInput,
    anchor: LockedIdentityRow & { readonly contact_id: string },
  ): Promise<readonly LockedIdentityRow[]> {
    if (command.scope === 'source_identity') return [anchor];
    const selected = await client.query<LockedIdentityRow>(
      `select id, channel, channel_account_id, external_contact_id
       from channel_identities
       where contact_id = $1
       order by id
       for update`,
      [anchor.contact_id],
    );
    if (selected.rows.length === 0) {
      throw new PolicyRecordNotFoundError('Linked marketing identities not found');
    }
    return selected.rows;
  }
}
