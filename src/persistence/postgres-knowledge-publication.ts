import type pg from 'pg';
import { z } from 'zod';

import {
  authorizeKnowledgePublication,
  authorizeKnowledgeReview,
} from '../knowledge/knowledge-reviewer.js';
import {
  parseKnowledgePublicationCommand,
  parseKnowledgeReviewCommand,
} from '../knowledge/knowledge-input.js';
import type {
  KnowledgeKind,
  KnowledgePublicationCommand,
  KnowledgeReviewCommand,
  PublishedKnowledgeVersion,
} from '../knowledge/knowledge-types.js';
import {
  PolicyIdempotencyConflictError,
  PolicyRecordNotFoundError,
} from './postgres-takeover-policy.js';
import { withBoundedTransaction, type TransactionSource } from './postgres-transaction.js';

const itemKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/);
const kindSchema = z.enum(['faq', 'business_fact', 'safety_response', 'escalation_response']);

export class KnowledgePublicationConflictError extends Error {
  public override readonly name = 'KnowledgePublicationConflictError';
}

export interface KnowledgeReviewResult {
  readonly state: 'approved' | 'rejected' | 'submitted';
  readonly status: 'applied' | 'duplicate';
  readonly versionRef: string;
}

export interface KnowledgePublicationResult {
  readonly itemKey: string;
  readonly status: 'applied' | 'duplicate';
  readonly versionRef: string;
}

interface ExistingReviewRow {
  readonly action: KnowledgeReviewCommand['action'];
  readonly effective_at: Date;
  readonly reason_code: string;
  readonly reviewer_reference: string;
  readonly version_ref: string;
}

interface VersionIdentityRow {
  readonly id: string;
  readonly item_id: string;
  readonly item_key: string;
  readonly state: 'approved' | 'draft' | 'rejected' | 'submitted';
  readonly version_ref: string;
}

interface ExistingPublicationRow {
  readonly action: KnowledgePublicationCommand['action'];
  readonly effective_at: Date;
  readonly item_key: string;
  readonly prior_version_ref: string | null;
  readonly reason_code: string;
  readonly reviewer_reference: string;
  readonly version_ref: string;
}

interface CurrentPublicationRow {
  readonly action: KnowledgePublicationCommand['action'];
  readonly version_id: string;
  readonly version_ref: string;
}

interface EffectiveVersionRow {
  readonly answer_bn: string;
  readonly answer_en: string;
  readonly item_key: string;
  readonly kind: KnowledgeKind;
  readonly version_number: number;
  readonly version_ref: string;
}

function stateForReviewAction(
  action: KnowledgeReviewCommand['action'],
): KnowledgeReviewResult['state'] {
  if (action === 'submit') return 'submitted';
  return action === 'approve' ? 'approved' : 'rejected';
}

function datesEqual(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function priorVersionRef(command: KnowledgePublicationCommand): string | undefined {
  return command.action === 'retire' ? undefined : command.priorVersionRef;
}

export class PostgresKnowledgePublication {
  public constructor(private readonly pool: TransactionSource) {}

  public submitVersion(input: unknown, principalInput: unknown): Promise<KnowledgeReviewResult> {
    const command = parseKnowledgeReviewCommand(input);
    if (command.action !== 'submit') throw new TypeError('Submit command action is invalid');
    return this.recordReview(command, principalInput);
  }

  public reviewVersion(input: unknown, principalInput: unknown): Promise<KnowledgeReviewResult> {
    const command = parseKnowledgeReviewCommand(input);
    if (command.action === 'submit') throw new TypeError('Review decision action is invalid');
    return this.recordReview(command, principalInput);
  }

  public publishVersion(
    input: unknown,
    principalInput: unknown,
  ): Promise<KnowledgePublicationResult> {
    const command = parseKnowledgePublicationCommand(input);
    if (command.action !== 'publish') throw new TypeError('Publish command action is invalid');
    return this.recordPublication(command, principalInput);
  }

  public retireItem(input: unknown, principalInput: unknown): Promise<KnowledgePublicationResult> {
    const command = parseKnowledgePublicationCommand(input);
    if (command.action !== 'retire') throw new TypeError('Retire command action is invalid');
    return this.recordPublication(command, principalInput);
  }

  public rollbackItem(
    input: unknown,
    principalInput: unknown,
  ): Promise<KnowledgePublicationResult> {
    const command = parseKnowledgePublicationCommand(input);
    if (command.action !== 'rollback') throw new TypeError('Rollback command action is invalid');
    return this.recordPublication(command, principalInput);
  }

  public async resolveEffectiveVersion(
    itemKey: string,
    evaluatedAt: Date,
  ): Promise<PublishedKnowledgeVersion | undefined> {
    const parsedItemKey = itemKeySchema.safeParse(itemKey);
    if (!parsedItemKey.success || !Number.isFinite(evaluatedAt.getTime())) {
      throw new TypeError('Effective knowledge lookup is invalid');
    }

    return withBoundedTransaction(this.pool, async (client) => {
      const selected = await client.query<EffectiveVersionRow & { readonly action: string }>(
        `select event.action, item.item_key, item.kind, version.version_ref,
                version.version_number, version.answer_en, version.answer_bn
         from knowledge_items as item
         join lateral (
           select action, version_id
           from knowledge_publication_events
           where item_id = item.id and effective_at <= $2
           order by effective_at desc, id desc
           limit 1
         ) as event on true
         join knowledge_versions as version on version.id = event.version_id
         where item.item_key = $1
           and event.action <> 'retire'
           and version.state = 'approved'
           and version.decided_at is not null
           and version.decided_at <= $2`,
        [parsedItemKey.data, evaluatedAt],
      );
      const row = selected.rows[0];
      return row === undefined ? undefined : this.mapEffectiveVersion(row);
    });
  }

  public async listEffectiveVersions(
    kind: KnowledgeKind,
    evaluatedAt: Date,
  ): Promise<readonly PublishedKnowledgeVersion[]> {
    const parsedKind = kindSchema.safeParse(kind);
    if (!parsedKind.success || !Number.isFinite(evaluatedAt.getTime())) {
      throw new TypeError('Effective knowledge list is invalid');
    }

    return withBoundedTransaction(this.pool, async (client) => {
      const selected = await client.query<EffectiveVersionRow>(
        `select item.item_key, item.kind, version.version_ref,
                version.version_number, version.answer_en, version.answer_bn
         from knowledge_items as item
         join lateral (
           select action, version_id
           from knowledge_publication_events
           where item_id = item.id and effective_at <= $2
           order by effective_at desc, id desc
           limit 1
         ) as event on true
         join knowledge_versions as version on version.id = event.version_id
         where item.kind = $1
           and event.action <> 'retire'
           and version.state = 'approved'
           and version.decided_at is not null
           and version.decided_at <= $2
         order by item.item_key`,
        [parsedKind.data, evaluatedAt],
      );
      return selected.rows.map((row) => this.mapEffectiveVersion(row));
    });
  }

  private async recordReview(
    command: KnowledgeReviewCommand,
    principalInput: unknown,
  ): Promise<KnowledgeReviewResult> {
    authorizeKnowledgeReview(command, principalInput);
    const targetState = stateForReviewAction(command.action);

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        command.requestKey,
      ]);
      const existing = await client.query<ExistingReviewRow>(
        `select event.action, event.reviewer_reference, event.reason_code,
                event.effective_at, version.version_ref
         from knowledge_review_events as event
         join knowledge_versions as version on version.id = event.version_id
         where event.request_key = $1`,
        [command.requestKey],
      );
      const existingRow = existing.rows[0];
      if (existingRow !== undefined) {
        const matches =
          existingRow.action === command.action &&
          existingRow.version_ref === command.versionRef &&
          existingRow.reviewer_reference === command.reviewerReference &&
          existingRow.reason_code === command.reasonCode &&
          datesEqual(existingRow.effective_at, command.effectiveAt);
        if (!matches) throw new PolicyIdempotencyConflictError();
        return { state: targetState, status: 'duplicate', versionRef: command.versionRef };
      }

      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        command.versionRef,
      ]);
      const version = await client.query<VersionIdentityRow>(
        `select version.id, version.version_ref, version.state, version.item_id, item.item_key
         from knowledge_versions as version
         join knowledge_items as item on item.id = version.item_id
         where version.version_ref = $1`,
        [command.versionRef],
      );
      const versionId = version.rows[0]?.id;
      if (versionId === undefined) throw new PolicyRecordNotFoundError();

      await client.query(
        `insert into knowledge_review_events
           (version_id, action, reviewer_reference, reason_code, request_key, effective_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          versionId,
          command.action,
          command.reviewerReference,
          command.reasonCode,
          command.requestKey,
          command.effectiveAt,
        ],
      );
      return { state: targetState, status: 'applied', versionRef: command.versionRef };
    });
  }

  private async recordPublication(
    command: KnowledgePublicationCommand,
    principalInput: unknown,
  ): Promise<KnowledgePublicationResult> {
    authorizeKnowledgePublication(command, principalInput);

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        command.requestKey,
      ]);
      const existing = await client.query<ExistingPublicationRow>(
        `select event.action, event.reviewer_reference, event.reason_code,
                event.effective_at, item.item_key, version.version_ref,
                prior.version_ref as prior_version_ref
         from knowledge_publication_events as event
         join knowledge_items as item on item.id = event.item_id
         join knowledge_versions as version on version.id = event.version_id
         left join knowledge_versions as prior on prior.id = event.prior_version_id
         where event.request_key = $1`,
        [command.requestKey],
      );
      const existingRow = existing.rows[0];
      if (existingRow !== undefined) {
        const matches =
          existingRow.action === command.action &&
          existingRow.item_key === command.itemKey &&
          existingRow.version_ref === command.versionRef &&
          existingRow.prior_version_ref === (priorVersionRef(command) ?? null) &&
          existingRow.reviewer_reference === command.reviewerReference &&
          existingRow.reason_code === command.reasonCode &&
          datesEqual(existingRow.effective_at, command.effectiveAt);
        if (!matches) throw new PolicyIdempotencyConflictError();
        return {
          itemKey: command.itemKey,
          status: 'duplicate',
          versionRef: command.versionRef,
        };
      }

      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        command.itemKey,
      ]);
      const target = await client.query<VersionIdentityRow>(
        `select version.id, version.version_ref, version.state, version.item_id, item.item_key
         from knowledge_versions as version
         join knowledge_items as item on item.id = version.item_id
         where item.item_key = $1 and version.version_ref = $2`,
        [command.itemKey, command.versionRef],
      );
      const targetRow = target.rows[0];
      if (targetRow === undefined) throw new PolicyRecordNotFoundError();
      if (targetRow.state !== 'approved') throw new KnowledgePublicationConflictError();

      const laterEvent = await client.query<{ readonly found: boolean }>(
        `select exists (
           select 1 from knowledge_publication_events
           where item_id = $1 and effective_at > $2
         ) as found`,
        [targetRow.item_id, command.effectiveAt],
      );
      if (laterEvent.rows[0]?.found === true) throw new KnowledgePublicationConflictError();

      const current = await client.query<CurrentPublicationRow>(
        `select event.action, event.version_id, version.version_ref
         from knowledge_publication_events as event
         join knowledge_versions as version on version.id = event.version_id
         where event.item_id = $1 and event.effective_at <= $2
         order by event.effective_at desc, event.id desc
         limit 1`,
        [targetRow.item_id, command.effectiveAt],
      );
      const currentRow = current.rows[0];
      const currentVersionRef =
        currentRow === undefined || currentRow.action === 'retire'
          ? undefined
          : currentRow.version_ref;
      const requestedPriorRef = priorVersionRef(command);

      if (command.action === 'publish') {
        if (
          requestedPriorRef !== currentVersionRef ||
          (currentVersionRef !== undefined && currentVersionRef === command.versionRef)
        ) {
          throw new KnowledgePublicationConflictError();
        }
      } else if (command.action === 'retire') {
        if (currentVersionRef !== command.versionRef) {
          throw new KnowledgePublicationConflictError();
        }
      } else {
        if (
          currentVersionRef !== command.priorVersionRef ||
          currentVersionRef === command.versionRef
        ) {
          throw new KnowledgePublicationConflictError();
        }
        const previouslyPublished = await client.query<{ readonly found: boolean }>(
          `select exists (
             select 1 from knowledge_publication_events
             where item_id = $1
               and version_id = $2
               and action in ('publish', 'rollback')
               and effective_at < $3
           ) as found`,
          [targetRow.item_id, targetRow.id, command.effectiveAt],
        );
        if (previouslyPublished.rows[0]?.found !== true) {
          throw new KnowledgePublicationConflictError();
        }
      }

      const priorId =
        requestedPriorRef === undefined
          ? null
          : await this.resolvePriorVersionId(client, targetRow.item_id, requestedPriorRef);
      await client.query(
        `insert into knowledge_publication_events
           (item_id, version_id, action, prior_version_id, reviewer_reference,
            reason_code, effective_at, request_key)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          targetRow.item_id,
          targetRow.id,
          command.action,
          priorId,
          command.reviewerReference,
          command.reasonCode,
          command.effectiveAt,
          command.requestKey,
        ],
      );
      return { itemKey: command.itemKey, status: 'applied', versionRef: command.versionRef };
    });
  }

  private async resolvePriorVersionId(
    client: pg.PoolClient,
    itemId: string,
    versionRef: string,
  ): Promise<string> {
    const selected = await client.query<{ readonly id: string }>(
      `select id from knowledge_versions where item_id = $1 and version_ref = $2`,
      [itemId, versionRef],
    );
    const id = selected.rows[0]?.id;
    if (id === undefined) throw new KnowledgePublicationConflictError();
    return id;
  }

  private mapEffectiveVersion(row: EffectiveVersionRow): PublishedKnowledgeVersion {
    return {
      answers: { bn: row.answer_bn, en: row.answer_en },
      itemKey: row.item_key,
      kind: row.kind,
      versionNumber: row.version_number,
      versionRef: row.version_ref,
    };
  }
}
