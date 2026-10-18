import type pg from 'pg';

import type {
  FaqResolution,
  FaqResolutionPolicy,
  PreparedFaqResolutionText,
} from '../knowledge/faq-resolver.js';
import { PostgresFaqResolver } from '../persistence/postgres-faq-resolver.js';
import { PostgresModelPolicy } from '../persistence/postgres-model-policy.js';

import { PostgresPrivacyRightsPolicy } from '../persistence/postgres-privacy-rights-policy.js';
import { PolicyRecordNotFoundError } from '../persistence/postgres-takeover-policy.js';
import { withBoundedTransaction } from '../persistence/postgres-transaction.js';
import type { PrivacyHmacKeyring } from '../policy/policy-types.js';
import type { ReplyPipelineState } from './reply-pipeline.js';

export class PostgresRuntimeFaqResolver {
  private readonly bounds: FaqResolutionPolicy;
  public constructor(
    private readonly pool: pg.Pool,
    protectedBounds: FaqResolutionPolicy,
  ) {
    // Validate the protected bounds without accepting them as publication/policy authority.
    new PostgresFaqResolver(pool, protectedBounds);
    this.bounds = Object.freeze({ ...protectedBounds });
  }
  public async resolve(input: {
    readonly evaluatedAt: Date;
    readonly sanitizedText: PreparedFaqResolutionText;
  }): Promise<FaqResolution> {
    const approved = await new PostgresModelPolicy(this.pool).resolveFaqPolicy(input.evaluatedAt);
    const policy =
      approved === undefined
        ? {
            minimumSimilarity: 1,
            ambiguityMargin: 0,
            maximumCandidates: this.bounds.maximumCandidates,
          }
        : {
            minimumSimilarity: Math.max(approved.minimumSimilarity, this.bounds.minimumSimilarity),
            ambiguityMargin: Math.max(approved.ambiguityMargin, this.bounds.ambiguityMargin),
            maximumCandidates: Math.min(approved.maximumCandidates, this.bounds.maximumCandidates),
          };
    const resolved = await new PostgresFaqResolver(this.pool, policy).resolve(input);
    // No approved fuzzy threshold means exact reviewed FAQ only, never an enabling default.
    if (
      approved === undefined &&
      resolved.status === 'match' &&
      resolved.matchKind === 'trigram_similarity'
    )
      return { status: 'miss', reasonCode: 'below_threshold' };
    return resolved;
  }
}

/** Composition-only reads return metadata, never message text or customer identifiers. */
export class PostgresReplyRuntimeState implements ReplyPipelineState {
  private readonly privacy: PostgresPrivacyRightsPolicy;
  public constructor(
    private readonly pool: pg.Pool,
    keyring: PrivacyHmacKeyring,
  ) {
    this.privacy = new PostgresPrivacyRightsPolicy(pool, keyring);
  }
  public async loadLanguage(eventId: string): Promise<'bn' | 'en' | undefined> {
    return withBoundedTransaction(this.pool, async (client) => {
      const result = await client.query<{ language: 'bn' | 'en' }>(
        `select
        coalesce(draft.language,gap.language,case when event.message_text ~ '[ঁ-৿]' then 'bn' else 'en' end) as language
        from webhook_events event
        join webhook_event_applications application on application.webhook_event_id=event.id
        left join support_reply_drafts draft on draft.source_webhook_event_id=event.id
        left join knowledge_gap_observations gap on gap.source_webhook_event_id=event.id
        where event.id=$1 and application.outcome='customer_message_applied'
          and event.message_text is not null`,
        [eventId],
      );
      return result.rows[0]?.language;
    });
  }
  public async applyIntake(eventId: string, requestKey: string): Promise<'handled' | 'ordinary'> {
    try {
      const result = await this.privacy.processAppliedEvent({
        sourceWebhookEventId: eventId,
        requestKey,
      });
      return result.status === 'not_a_privacy_intent' ? 'ordinary' : 'handled';
    } catch (error) {
      // Deleted/erased sources cannot be repurposed as ordinary replies after a restart.
      if (error instanceof PolicyRecordNotFoundError) return 'handled';
      throw error;
    }
  }
  public async hasIntent(draftRef: string): Promise<boolean> {
    return withBoundedTransaction(this.pool, async (client) => {
      const result = await client.query<{ present: boolean }>(
        `select exists(select 1 from outbound_intents intent
        join support_reply_drafts draft on draft.id=intent.reply_draft_id where draft.draft_ref=$1) as present`,
        [draftRef],
      );
      return result.rows[0]?.present === true;
    });
  }
}
