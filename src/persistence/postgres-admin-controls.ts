import { createHash, randomUUID } from 'node:crypto';

import type pg from 'pg';
import { z } from 'zod';

import type {
  AdminConsentIdentitySummary,
  AdminOutboundPolicySummary,
  AdminOutboundTemplateSummary,
  AdminPauseStateSummary,
  AdminPrivacyAccessBundle,
  AdminPrivacyAccessBundleEntry,
  AdminPrivacyLocationSummary,
  AdminPrivacyRequestSummary,
  AdminWebsiteSnapshotSummary,
} from '../admin/admin-controls-types.js';
import {
  extractWebsiteSnapshotCandidates,
  fetchOfficialWebsiteSnapshot,
  normalizeWebsiteImportUrl,
} from '../knowledge/website-import.js';
import type { ManifestFetch } from '../model/manifest-client.js';
import type { OutboundPurpose } from '../outbound/outbound-types.js';
import { MARKETING_CATEGORIES, type PrivacyHmacKeyring } from '../policy/policy-types.js';
import { createIdentityHmac, createReplayHmac } from '../policy/privacy-identity.js';
import type { ReviewerPrincipal } from '../policy/policy-types.js';
import { inspectSensitiveText } from '../safety/sensitive-data-gate.js';
import { PostgresKnowledgeRepository } from './postgres-knowledge-repository.js';
import { PostgresOutboundPolicy } from './postgres-outbound-policy.js';
import { PostgresOutboundTemplate } from './postgres-outbound-template.js';

export class AdminControlConfigurationError extends Error {
  public override readonly name = 'AdminControlConfigurationError';
}

export class AdminControlConflictError extends Error {
  public override readonly name = 'AdminControlConflictError';
}

export class WebsiteImportError extends Error {
  public override readonly name = 'WebsiteImportError';
}

const referenceSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const decimalIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/u);
const dateSchema = z.date().refine((value) => Number.isFinite(value.getTime()));

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function insertAdminAuditEvent(
  client: pg.PoolClient,
  input: {
    readonly action: string;
    readonly objectType: string;
    readonly objectRef: string;
    readonly reasonCode: string;
    readonly requestKey: string;
    readonly effectiveAt: Date;
    readonly reviewerRef: string;
    readonly result?: 'applied' | 'duplicate' | 'failed';
  },
): Promise<void> {
  await client.query(
    `insert into admin_audit_events
       (actor_account_id, action, result, object_type, object_ref,
        reason_code, request_key, effective_at)
     values ((select id from admin_accounts where account_ref = $1),
             $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.reviewerRef,
      input.action,
      input.result ?? 'applied',
      input.objectType,
      input.objectRef,
      input.reasonCode,
      input.requestKey,
      input.effectiveAt,
    ],
  );
}

export async function queryPauseStates(
  client: pg.PoolClient,
  limit: number,
): Promise<readonly AdminPauseStateSummary[]> {
  const rows = await client.query<{
    readonly conversation_id: string;
    readonly contact_id: string;
    readonly channel: 'messenger' | 'whatsapp';
    readonly external_contact_id: string;
    readonly ai_paused_until: Date | null;
    readonly last_authorized_resume_at: Date | null;
    readonly last_activity_at: Date;
    readonly last_pause_action: 'pause' | 'resume' | null;
    readonly last_pause_actor_kind: 'business_echo' | 'reviewer' | null;
    readonly last_pause_effective_at: Date | null;
  }>(
    `select conversation_id, contact_id, channel, external_contact_id,
            ai_paused_until, last_authorized_resume_at, last_activity_at,
            last_pause_action, last_pause_actor_kind, last_pause_effective_at
     from admin_pause_states_v
     order by coalesce(ai_paused_until, last_activity_at) desc, conversation_id desc
     limit $1`,
    [limit],
  );
  return rows.rows.map((row) => ({
    conversationId: row.conversation_id,
    contactId: row.contact_id,
    channel: row.channel,
    externalContactId: row.external_contact_id,
    aiPausedUntil: row.ai_paused_until,
    lastAuthorizedResumeAt: row.last_authorized_resume_at,
    lastActivityAt: row.last_activity_at,
    lastPauseAction: row.last_pause_action,
    lastPauseActorKind: row.last_pause_actor_kind,
    lastPauseEffectiveAt: row.last_pause_effective_at,
  }));
}

export async function executeAdminPauseAction(
  client: pg.PoolClient,
  principal: ReviewerPrincipal,
  input: {
    readonly action: 'pause' | 'resume';
    readonly conversationId: string;
    readonly effectiveAt: Date;
    readonly requestKey: string;
  },
): Promise<void> {
  const convId = decimalIdSchema.parse(input.conversationId);
  const effectiveAt = dateSchema.parse(input.effectiveAt);
  const requestKey = referenceSchema.parse(input.requestKey);
  const fn = input.action === 'pause' ? 'admin_pause_conversation' : 'admin_resume_conversation';
  const res = await client.query<{ readonly status: string }>(
    `select status from ${fn}($1::bigint, $2::timestamptz, $3::text, $4::text)`,
    [convId, effectiveAt, principal.reviewerRef, requestKey],
  );
  if (res.rows[0]?.status !== 'duplicate') {
    await insertAdminAuditEvent(client, {
      action: input.action === 'pause' ? 'human_pause_applied' : 'human_pause_resumed',
      objectType: 'conversation',
      objectRef: convId,
      reasonCode: input.action === 'pause' ? 'manual_pause_applied' : 'resume_applied',
      requestKey,
      effectiveAt,
      reviewerRef: principal.reviewerRef,
    });
  }
}

export async function queryPrivacyRequests(
  client: pg.PoolClient,
  limit: number,
): Promise<readonly AdminPrivacyRequestSummary[]> {
  const rows = await client.query<{
    readonly request_ref: string;
    readonly request_type: AdminPrivacyRequestSummary['requestType'];
    readonly state: AdminPrivacyRequestSummary['state'];
    readonly contact_id: string | null;
    readonly received_at: Date;
    readonly decision_at: Date | null;
    readonly completed_at: Date | null;
    readonly decision_code: string | null;
    readonly reason_code: string | null;
    readonly pending_locations: number;
    readonly total_locations: number;
    readonly deletion_status: string | null;
    readonly tombstones_created: number | null;
    readonly access_status: string | null;
    readonly access_record_count: number | null;
    readonly access_bundle_sha256: string | null;
    readonly correction_result_code: string | null;
    readonly correction_field_key: string | null;
  }>(
    `select request_ref, request_type, state, contact_id, received_at,
            decision_at, completed_at, decision_code, reason_code,
            pending_locations, total_locations, deletion_status, tombstones_created,
            access_status, access_record_count, access_bundle_sha256,
            correction_result_code, correction_field_key
     from admin_privacy_requests_v
     order by received_at desc, request_ref desc
     limit $1`,
    [limit],
  );
  return rows.rows.map((row) => ({
    requestRef: row.request_ref,
    requestType: row.request_type,
    state: row.state,
    contactId: row.contact_id,
    receivedAt: row.received_at,
    decisionAt: row.decision_at,
    completedAt: row.completed_at,
    decisionCode: row.decision_code,
    reasonCode: row.reason_code,
    pendingLocations: row.pending_locations,
    totalLocations: row.total_locations,
    deletionStatus: row.deletion_status,
    tombstonesCreated: row.tombstones_created,
    accessStatus: row.access_status,
    accessRecordCount: row.access_record_count,
    accessBundleSha256: row.access_bundle_sha256,
    correctionResultCode: row.correction_result_code,
    correctionFieldKey: row.correction_field_key,
  }));
}

export async function queryPrivacyLocations(
  client: pg.PoolClient,
  requestRef?: string,
): Promise<readonly AdminPrivacyLocationSummary[]> {
  const rows = await client.query<{
    readonly request_ref: string;
    readonly location_code: string;
    readonly required: boolean;
    readonly state: AdminPrivacyLocationSummary['state'];
    readonly outcome_code: string | null;
    readonly reviewer_reference: string | null;
    readonly checked_at: Date | null;
  }>(
    `select request_ref, location_code, required, state, outcome_code,
            reviewer_reference, checked_at
     from admin_privacy_locations_v
     where ($1::text is null or request_ref = $1)
     order by request_ref, location_code
     limit 500`,
    [requestRef ?? null],
  );
  return rows.rows.map((row) => ({
    requestRef: row.request_ref,
    locationCode: row.location_code,
    required: row.required,
    state: row.state,
    outcomeCode: row.outcome_code,
    reviewerReference: row.reviewer_reference,
    checkedAt: row.checked_at,
  }));
}

export async function executeDeletionReview(
  client: pg.PoolClient,
  principal: ReviewerPrincipal,
  input: {
    readonly decision: 'approve' | 'reject';
    readonly decidedAt: Date;
    readonly reasonCode: 'customer_confirmed' | 'identity_ambiguous' | 'request_withdrawn';
    readonly requestKey: string;
    readonly requestRef: string;
    readonly verificationMethod: 'explicit_confirmation' | 'known_name';
  },
): Promise<void> {
  const requestRef = referenceSchema.parse(input.requestRef);
  const requestKey = referenceSchema.parse(input.requestKey);
  const decidedAt = dateSchema.parse(input.decidedAt);
  const res = await client.query<{ readonly status: string }>(
    `select status from admin_review_deletion_request($1,$2,$3,$4,$5,$6,$7)`,
    [
      requestRef,
      input.decision,
      input.reasonCode,
      decidedAt,
      principal.reviewerRef,
      requestKey,
      input.verificationMethod,
    ],
  );
  if (res.rows[0]?.status !== 'duplicate') {
    await insertAdminAuditEvent(client, {
      action: 'privacy_request_reviewed',
      objectType: 'privacy_request',
      objectRef: requestRef,
      reasonCode: input.reasonCode,
      requestKey,
      effectiveAt: decidedAt,
      reviewerRef: principal.reviewerRef,
    });
  }
}

export async function executeDeletionErasure(
  client: pg.PoolClient,
  principal: ReviewerPrincipal,
  keyring: PrivacyHmacKeyring | undefined,
  input: {
    readonly executedAt: Date;
    readonly requestKey: string;
    readonly requestRef: string;
  },
): Promise<void> {
  if (keyring === undefined) {
    throw new AdminControlConfigurationError('PRIVACY_HMAC_KEYRING is not configured');
  }
  const activeKey = keyring.keys.get(keyring.activeVersion);
  if (activeKey === undefined) {
    throw new AdminControlConfigurationError('Active privacy HMAC key is missing');
  }
  const requestRef = referenceSchema.parse(input.requestRef);
  const requestKey = referenceSchema.parse(input.requestKey);
  const executedAt = dateSchema.parse(input.executedAt);

  const targets = await client.query<{
    readonly row_kind: 'identity' | 'webhook_event';
    readonly record_id: string;
    readonly channel: 'messenger' | 'whatsapp';
    readonly channel_account_id: string | null;
    readonly external_contact_id: string | null;
    readonly idempotency_key: string | null;
  }>(
    `select row_kind, record_id, channel, channel_account_id, external_contact_id, idempotency_key from admin_load_deletion_target_data($1)`,
    [requestRef],
  );

  const identityIds: string[] = [];
  const identityHmacs: string[] = [];
  const accountPseudonyms: string[] = [];
  const contactPseudonyms: string[] = [];
  const eventIds: string[] = [];
  const eventReplayKeys: string[] = [];

  for (const row of targets.rows) {
    if (
      row.row_kind === 'identity' &&
      row.channel_account_id !== null &&
      row.external_contact_id !== null
    ) {
      identityIds.push(row.record_id);
      identityHmacs.push(
        createIdentityHmac(
          {
            channel: row.channel,
            channelAccountId: row.channel_account_id,
            externalContactId: row.external_contact_id,
          },
          { key: activeKey, version: keyring.activeVersion },
        ),
      );
      accountPseudonyms.push(`deleted:${randomUUID()}`);
      contactPseudonyms.push(`deleted:${randomUUID()}`);
    } else if (row.row_kind === 'webhook_event' && row.idempotency_key !== null) {
      eventIds.push(row.record_id);
      eventReplayKeys.push(
        `privacy:${keyring.activeVersion}:${createReplayHmac(row.idempotency_key, {
          key: activeKey,
          version: keyring.activeVersion,
        })}`,
      );
    }
  }

  const res = await client.query<{ readonly status: string }>(
    `select status from admin_execute_deletion_erasure($1,$2,$3,$4,$5::bigint[],$6::text[],$7::text[],$8::text[],$9::bigint[],$10::text[])`,
    [
      requestRef,
      executedAt,
      requestKey,
      keyring.activeVersion,
      identityIds,
      identityHmacs,
      accountPseudonyms,
      contactPseudonyms,
      eventIds,
      eventReplayKeys,
    ],
  );
  if (res.rows[0]?.status !== 'duplicate') {
    await insertAdminAuditEvent(client, {
      action: 'privacy_deletion_executed',
      objectType: 'privacy_request',
      objectRef: requestRef,
      reasonCode: 'local_erasure_complete',
      requestKey,
      effectiveAt: executedAt,
      reviewerRef: principal.reviewerRef,
    });
  }
}

export async function executePrivacyReview(
  client: pg.PoolClient,
  principal: ReviewerPrincipal,
  input: {
    readonly decision: 'approve' | 'reject';
    readonly decidedAt: Date;
    readonly reasonCode: 'identity_verified' | 'identity_ambiguous' | 'request_withdrawn';
    readonly requestKey: string;
    readonly requestRef: string;
  },
): Promise<void> {
  const requestRef = referenceSchema.parse(input.requestRef);
  const requestKey = referenceSchema.parse(input.requestKey);
  const decidedAt = dateSchema.parse(input.decidedAt);
  const res = await client.query<{ readonly status: string }>(
    `select status from admin_review_privacy_request($1,$2,$3,$4,$5,$6)`,
    [requestRef, input.decision, input.reasonCode, decidedAt, principal.reviewerRef, requestKey],
  );
  if (res.rows[0]?.status !== 'duplicate') {
    await insertAdminAuditEvent(client, {
      action: 'privacy_request_reviewed',
      objectType: 'privacy_request',
      objectRef: requestRef,
      reasonCode: input.reasonCode,
      requestKey,
      effectiveAt: decidedAt,
      reviewerRef: principal.reviewerRef,
    });
  }
}

export async function executePrivacyAccessCollection(
  client: pg.PoolClient,
  principal: ReviewerPrincipal,
  input: {
    readonly collectedAt: Date;
    readonly requestKey: string;
    readonly requestRef: string;
  },
): Promise<AdminPrivacyAccessBundle> {
  const requestRef = referenceSchema.parse(input.requestRef);
  const requestKey = referenceSchema.parse(input.requestKey);
  const collectedAt = dateSchema.parse(input.collectedAt);

  const loaded = await client.query<{
    readonly contact_id: string;
    readonly preferred_language: string | null;
    readonly channel: 'messenger' | 'whatsapp';
    readonly external_contact_id: string;
    readonly occurred_at: Date | null;
    readonly event_kind: string | null;
    readonly message_text: string | null;
  }>(
    `select contact_id, preferred_language, channel, external_contact_id,
            occurred_at, event_kind, message_text
     from admin_load_approved_access_export_rows($1)`,
    [requestRef],
  );

  const first = loaded.rows[0];
  if (first === undefined) {
    throw new AdminControlConflictError('Access export rows not available');
  }
  const entries: AdminPrivacyAccessBundleEntry[] = loaded.rows
    .filter((row) => row.occurred_at !== null || row.event_kind !== null)
    .map((row) => {
      let sanitizedText: string | null = null;
      if (row.message_text !== null && row.message_text !== '') {
        const inspected = inspectSensitiveText(row.message_text, 'en', {
          maximumInputCodePoints: 4000,
        });
        sanitizedText =
          inspected.status === 'blocked' ? '[REDACTED SENSITIVE CONTENT]' : inspected.sanitizedText;
      }
      return {
        channel: row.channel,
        externalContactId: row.external_contact_id,
        occurredAt: row.occurred_at?.toISOString() ?? null,
        eventKind: row.event_kind,
        sanitizedText,
      };
    });

  const payload = JSON.stringify({
    requestRef,
    contactId: first.contact_id,
    preferredLanguage: first.preferred_language,
    entries,
  });
  const bundleSha256 = sha256(payload);

  const recorded = await client.query<{ readonly status: 'applied' | 'duplicate' }>(
    `select status from admin_record_privacy_access_run($1,$2,$3,$4,$5,$6)`,
    [requestRef, collectedAt, 1, entries.length, bundleSha256, requestKey],
  );
  const status = recorded.rows[0]?.status ?? 'applied';
  if (status !== 'duplicate') {
    await insertAdminAuditEvent(client, {
      action: 'privacy_access_collected',
      objectType: 'privacy_request',
      objectRef: requestRef,
      reasonCode: 'access_collected',
      requestKey,
      effectiveAt: collectedAt,
      reviewerRef: principal.reviewerRef,
    });
  }

  return {
    requestRef,
    contactId: first.contact_id,
    preferredLanguage: first.preferred_language,
    recordCount: entries.length,
    bundleSha256,
    status,
    entries,
  };
}

export async function executePrivacyLocationAttestation(
  client: pg.PoolClient,
  principal: ReviewerPrincipal,
  input: {
    readonly checkedAt: Date;
    readonly locationCode: string;
    readonly outcomeCode: 'location_complete' | 'location_failed' | 'location_not_applicable';
    readonly requestKey: string;
    readonly requestRef: string;
    readonly state: 'completed' | 'failed' | 'not_applicable';
  },
): Promise<void> {
  const requestRef = referenceSchema.parse(input.requestRef);
  const requestKey = referenceSchema.parse(input.requestKey);
  const checkedAt = dateSchema.parse(input.checkedAt);
  const locationCode = z
    .enum([
      'primary_postgres',
      'manifest_recordings',
      'meta_provider',
      'pending_outbound',
      'operator_exports',
      'offline_archives',
      'backup_tombstone_gate',
    ])
    .parse(input.locationCode);

  const res = await client.query<{ readonly status: string }>(
    `select status from admin_attest_privacy_location($1,$2,$3,$4,$5,$6,$7)`,
    [
      requestRef,
      locationCode,
      input.state,
      input.outcomeCode,
      checkedAt,
      principal.reviewerRef,
      requestKey,
    ],
  );
  if (res.rows[0]?.status !== 'duplicate') {
    await insertAdminAuditEvent(client, {
      action: 'privacy_location_attested',
      objectType: 'privacy_request',
      objectRef: requestRef,
      reasonCode: input.outcomeCode,
      requestKey,
      effectiveAt: checkedAt,
      reviewerRef: principal.reviewerRef,
    });
  }
}

export async function executePrivacyCorrection(
  client: pg.PoolClient,
  principal: ReviewerPrincipal,
  input: {
    readonly executedAt: Date;
    readonly fieldKey: string;
    readonly newValue: string;
    readonly requestKey: string;
    readonly requestRef: string;
  },
): Promise<void> {
  const requestRef = referenceSchema.parse(input.requestRef);
  const requestKey = referenceSchema.parse(input.requestKey);
  const executedAt = dateSchema.parse(input.executedAt);
  const fieldKey = z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u)
    .parse(input.fieldKey);
  const newValue = z.string().trim().min(1).max(200).parse(input.newValue);

  const res = await client.query<{ readonly result_code: string; readonly status: string }>(
    `select result_code, status from admin_execute_correction($1,$2,$3,$4,$5,$6)`,
    [requestRef, fieldKey, newValue, executedAt, principal.reviewerRef, requestKey],
  );
  const row = res.rows[0];
  if (row?.status !== 'duplicate') {
    await insertAdminAuditEvent(client, {
      action: 'privacy_correction_executed',
      objectType: 'privacy_request',
      objectRef: requestRef,
      reasonCode: row?.result_code ?? 'correction_executed',
      requestKey,
      effectiveAt: executedAt,
      reviewerRef: principal.reviewerRef,
    });
  }
}

export async function queryConsentIdentities(
  client: pg.PoolClient,
  limit: number,
): Promise<readonly AdminConsentIdentitySummary[]> {
  const rows = await client.query<{
    readonly channel_identity_id: string;
    readonly contact_id: string;
    readonly channel: 'messenger' | 'whatsapp';
    readonly channel_account_id: string;
    readonly external_contact_id: string;
    readonly preferred_language: string | null;
    readonly category: string | null;
    readonly latest_action: 'grant' | 'revoke' | null;
    readonly source_at: Date | null;
  }>(
    `select channel_identity_id, contact_id, channel, channel_account_id,
            external_contact_id, preferred_language, category, latest_action, source_at
     from admin_consent_identities_v
     where external_contact_id not like 'deleted:%'
     order by contact_id desc, channel_identity_id desc, category
     limit $1`,
    [Math.min(500, limit * 4)],
  );
  const byIdentity = new Map<
    string,
    {
      readonly summary: Omit<AdminConsentIdentitySummary, 'categoryStates'>;
      readonly categoryStates: Record<
        string,
        { readonly action: 'grant' | 'revoke'; readonly sourceAt: Date }
      >;
    }
  >();
  for (const row of rows.rows) {
    let entry = byIdentity.get(row.channel_identity_id);
    if (entry === undefined) {
      entry = {
        summary: {
          channelIdentityId: row.channel_identity_id,
          contactId: row.contact_id,
          channel: row.channel,
          channelAccountId: row.channel_account_id,
          externalContactId: row.external_contact_id,
          preferredLanguage: row.preferred_language,
        },
        categoryStates: {},
      };
      byIdentity.set(row.channel_identity_id, entry);
    }
    if (row.category !== null && row.latest_action !== null && row.source_at !== null) {
      entry.categoryStates[row.category] = {
        action: row.latest_action,
        sourceAt: row.source_at,
      };
    }
  }
  return [...byIdentity.values()]
    .slice(0, limit)
    .map((entry) => ({ ...entry.summary, categoryStates: entry.categoryStates }));
}

export async function executeReviewerConsent(
  client: pg.PoolClient,
  principal: ReviewerPrincipal,
  input: {
    readonly action: 'grant' | 'revoke';
    readonly category: string;
    readonly channelIdentityId: string;
    readonly requestKey: string;
    readonly sourceAt: Date;
    readonly wording: string;
    readonly wordingVersion: string;
  },
): Promise<void> {
  const id = decimalIdSchema.parse(input.channelIdentityId);
  const category = z.enum(MARKETING_CATEGORIES).parse(input.category);
  const sourceAt = dateSchema.parse(input.sourceAt);
  const requestKey = referenceSchema.parse(input.requestKey);
  const wording = z.string().trim().min(1).max(500).parse(input.wording);
  const wordingVersion = z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u)
    .parse(input.wordingVersion);

  const res = await client.query<{ readonly status: string }>(
    `select status from admin_record_consent_event($1::bigint,$2,$3,$4,$5,$6,$7)`,
    [id, category, input.action, wording, wordingVersion, sourceAt, requestKey],
  );
  if (res.rows[0]?.status !== 'duplicate') {
    await insertAdminAuditEvent(client, {
      action: 'consent_recorded',
      objectType: 'consent_record',
      objectRef: `${id}:${category}`,
      reasonCode: input.action === 'grant' ? 'consent_grant' : 'consent_revoke',
      requestKey,
      effectiveAt: sourceAt,
      reviewerRef: principal.reviewerRef,
    });
  }
}

export async function executeMarketingReoptIn(
  client: pg.PoolClient,
  principal: ReviewerPrincipal,
  keyring: PrivacyHmacKeyring | undefined,
  input: {
    readonly categories: readonly string[];
    readonly channelIdentityId: string;
    readonly effectiveAt: Date;
    readonly requestKey: string;
    readonly verificationMethod: 'known_name' | 'same_channel_context';
    readonly wording: string;
    readonly wordingVersion: string;
  },
): Promise<void> {
  if (keyring === undefined) {
    throw new AdminControlConfigurationError('PRIVACY_HMAC_KEYRING is not configured');
  }
  const id = decimalIdSchema.parse(input.channelIdentityId);
  const categories = z.array(z.enum(MARKETING_CATEGORIES)).min(1).parse(input.categories);
  const effectiveAt = dateSchema.parse(input.effectiveAt);
  const requestKey = referenceSchema.parse(input.requestKey);
  const wording = z.string().trim().min(1).max(500).parse(input.wording);
  const wordingVersion = z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u)
    .parse(input.wordingVersion);

  const identityRow = await client.query<{
    readonly channel: 'messenger' | 'whatsapp';
    readonly channel_account_id: string;
    readonly external_contact_id: string;
  }>(
    `select channel, channel_account_id, external_contact_id
     from admin_consent_identities_v
     where channel_identity_id = $1
     limit 1`,
    [id],
  );
  const identity = identityRow.rows[0];
  if (identity === undefined) {
    throw new AdminControlConflictError('Channel identity was not found');
  }

  const keyVersions: string[] = [];
  const identityHmacs: string[] = [];
  for (const [version, key] of keyring.keys) {
    keyVersions.push(version);
    identityHmacs.push(
      createIdentityHmac(
        {
          channel: identity.channel,
          channelAccountId: identity.channel_account_id,
          externalContactId: identity.external_contact_id,
        },
        { key, version },
      ),
    );
  }

  const res = await client.query<{ readonly status: string }>(
    `select status from admin_record_marketing_reopt_in($1::bigint,$2::text[],$3,$4,$5,$6,$7,$8::text[],$9::text[],$10)`,
    [
      id,
      categories,
      wording,
      wordingVersion,
      effectiveAt,
      principal.reviewerRef,
      input.verificationMethod,
      identityHmacs,
      keyVersions,
      requestKey,
    ],
  );
  if (res.rows[0]?.status !== 'duplicate') {
    await insertAdminAuditEvent(client, {
      action: 'marketing_reopt_in_recorded',
      objectType: 'consent_record',
      objectRef: id,
      reasonCode: 'explicit_reopt_in',
      requestKey,
      effectiveAt,
      reviewerRef: principal.reviewerRef,
    });
  }
}

export async function queryOutboundPolicies(
  client: pg.PoolClient,
  limit: number,
): Promise<readonly AdminOutboundPolicySummary[]> {
  const rows = await client.query<{
    readonly policy_ref: string;
    readonly version_number: number;
    readonly state: AdminOutboundPolicySummary['state'];
    readonly per_contact_15_minute: number;
    readonly per_contact_24_hour: number;
    readonly global_1_minute: number;
    readonly global_utc_day: number;
    readonly created_at: Date;
  }>(
    `select policy_ref, version_number, state,
            per_contact_15_minute, per_contact_24_hour,
            global_1_minute, global_utc_day, created_at
     from outbound_policy_versions
     order by version_number desc, id desc
     limit $1`,
    [limit],
  );
  return rows.rows.map((row) => ({
    policyRef: row.policy_ref,
    versionNumber: row.version_number,
    state: row.state,
    perContact15Minute: row.per_contact_15_minute,
    perContact24Hour: row.per_contact_24_hour,
    global1Minute: row.global_1_minute,
    globalUtcDay: row.global_utc_day,
    createdAt: row.created_at,
  }));
}

export async function executeOutboundPolicyMutation(
  client: pg.PoolClient,
  principal: ReviewerPrincipal,
  input:
    | {
        readonly kind: 'create';
        readonly policyRef: string;
        readonly requestKey: string;
        readonly createdAt: Date;
        readonly values: unknown;
      }
    | {
        readonly kind: 'transition';
        readonly action: 'activate' | 'approve' | 'retire' | 'submit';
        readonly policyRef: string;
        readonly requestKey: string;
        readonly effectiveAt: Date;
      },
): Promise<void> {
  const service = new PostgresOutboundPolicy({ transactionClient: client });
  if (input.kind === 'create') {
    const result = await service.createVersion(
      {
        createdAt: input.createdAt,
        createdByAccountRef: principal.reviewerRef,
        policyRef: input.policyRef,
        requestKey: input.requestKey,
        values: input.values,
      },
      principal,
    );
    if (result.status !== 'duplicate') {
      await insertAdminAuditEvent(client, {
        action: 'outbound_policy_changed',
        objectType: 'outbound_policy',
        objectRef: result.policyRef,
        reasonCode: 'outbound_policy_created',
        requestKey: input.requestKey,
        effectiveAt: input.createdAt,
        reviewerRef: principal.reviewerRef,
      });
    }
    return;
  }
  const command = {
    effectiveAt: input.effectiveAt,
    policyRef: input.policyRef,
    reasonCode: `outbound_${input.action}`,
    requestKey: input.requestKey,
    reviewerAccountRef: principal.reviewerRef,
  };
  const result =
    input.action === 'submit'
      ? await service.submitVersion(command, principal)
      : input.action === 'approve'
        ? await service.approveVersion(command, principal)
        : input.action === 'activate'
          ? await service.activateVersion(command, principal)
          : await service.retireVersion(command, principal);
  if (result.status !== 'duplicate') {
    await insertAdminAuditEvent(client, {
      action: 'outbound_policy_changed',
      objectType: 'outbound_policy',
      objectRef: result.policyRef,
      reasonCode: command.reasonCode,
      requestKey: input.requestKey,
      effectiveAt: input.effectiveAt,
      reviewerRef: principal.reviewerRef,
    });
  }
}

export async function queryOutboundTemplates(
  client: pg.PoolClient,
  limit: number,
): Promise<readonly AdminOutboundTemplateSummary[]> {
  const rows = await client.query<{
    readonly template_ref: string;
    readonly version_number: number;
    readonly channel_account_id: string;
    readonly template_name: string;
    readonly locale: 'bn_BD' | 'en_US';
    readonly category: OutboundPurpose;
    readonly state: AdminOutboundTemplateSummary['state'];
    readonly created_at: Date;
  }>(
    `select template_ref, version_number, channel_account_id,
            template_name, locale, category, state, created_at
     from outbound_template_versions
     order by created_at desc, id desc
     limit $1`,
    [limit],
  );
  return rows.rows.map((row) => ({
    templateRef: row.template_ref,
    versionNumber: row.version_number,
    channelAccountId: row.channel_account_id,
    templateName: row.template_name,
    locale: row.locale,
    category: row.category,
    state: row.state,
    createdAt: row.created_at,
  }));
}

export async function executeOutboundTemplateMutation(
  client: pg.PoolClient,
  principal: ReviewerPrincipal,
  input:
    | {
        readonly kind: 'create';
        readonly templateRef: string;
        readonly channelAccountId: string;
        readonly providerTemplateId: string;
        readonly templateName: string;
        readonly locale: 'bn_BD' | 'en_US';
        readonly category: OutboundPurpose;
        readonly templateText: string;
        readonly requestKey: string;
        readonly createdAt: Date;
      }
    | {
        readonly kind: 'transition';
        readonly action: 'activate' | 'approve' | 'retire' | 'submit';
        readonly templateRef: string;
        readonly versionNumber: number;
        readonly requestKey: string;
        readonly effectiveAt: Date;
      },
): Promise<void> {
  const service = new PostgresOutboundTemplate({ transactionClient: client });
  if (input.kind === 'create') {
    const result = await service.createVersion(
      {
        category: input.category,
        channel: 'whatsapp',
        channelAccountId: input.channelAccountId,
        contentSha256: sha256(input.templateText),
        createdAt: input.createdAt,
        locale: input.locale,
        providerTemplateId: input.providerTemplateId,
        requestKey: input.requestKey,
        templateName: input.templateName,
        templateRef: input.templateRef,
      },
      principal,
    );
    if (result.status !== 'duplicate') {
      await insertAdminAuditEvent(client, {
        action: 'outbound_template_changed',
        objectType: 'outbound_template',
        objectRef: `${result.templateRef}:${String(result.versionNumber)}`,
        reasonCode: 'outbound_template_created',
        requestKey: input.requestKey,
        effectiveAt: input.createdAt,
        reviewerRef: principal.reviewerRef,
      });
    }
    return;
  }
  const command = {
    effectiveAt: input.effectiveAt,
    reasonCode: `template_${input.action}`,
    requestKey: input.requestKey,
    reviewerAccountRef: principal.reviewerRef,
    templateRef: input.templateRef,
    versionNumber: input.versionNumber,
  };
  const result =
    input.action === 'submit'
      ? await service.submitVersion(command, principal)
      : input.action === 'approve'
        ? await service.approveVersion(command, principal)
        : input.action === 'activate'
          ? await service.activateVersion(command, principal)
          : await service.retireVersion(command, principal);
  if (result.status !== 'duplicate') {
    await insertAdminAuditEvent(client, {
      action: 'outbound_template_changed',
      objectType: 'outbound_template',
      objectRef: `${result.templateRef}:${String(result.versionNumber)}`,
      reasonCode: command.reasonCode,
      requestKey: input.requestKey,
      effectiveAt: input.effectiveAt,
      reviewerRef: principal.reviewerRef,
    });
  }
}

export async function queryWebsiteSnapshots(
  client: pg.PoolClient,
  limit: number,
): Promise<readonly AdminWebsiteSnapshotSummary[]> {
  const rows = await client.query<{
    readonly snapshot_ref: string;
    readonly source_ref: string;
    readonly approved_url: string;
    readonly label: string;
    readonly fetched_at: Date;
    readonly source_sha256: string | null;
    readonly content_sha256: string | null;
    readonly proposed_public_content: string | null;
  }>(
    `select snapshot.snapshot_ref,
            source.source_ref,
            source.approved_url,
            source.label,
            snapshot.fetched_at,
            snapshot.source_sha256,
            snapshot.content_sha256,
            snapshot.proposed_public_content
     from knowledge_source_snapshots as snapshot
     join knowledge_sources as source on source.id = snapshot.source_id
     where source.source_type = 'website'
       and source.approved_url is not null
     order by snapshot.fetched_at desc, snapshot.id desc
     limit $1`,
    [limit],
  );
  return rows.rows.map((row) => ({
    snapshotRef: row.snapshot_ref,
    sourceRef: row.source_ref,
    approvedUrl: row.approved_url,
    label: row.label,
    fetchedAt: row.fetched_at,
    sourceSha256: row.source_sha256,
    contentSha256: row.content_sha256,
    excerpt: row.proposed_public_content,
  }));
}

export async function fetchOrParseWebsiteImport(input: {
  readonly url: string;
  readonly pastedHtmlOrText?: string;
  readonly websiteFetch?: ManifestFetch;
}) {
  try {
    const normalizedUrl = normalizeWebsiteImportUrl(input.url);
    if (input.pastedHtmlOrText !== undefined && input.pastedHtmlOrText.trim() !== '') {
      return extractWebsiteSnapshotCandidates(input.pastedHtmlOrText, normalizedUrl);
    }
    return await fetchOfficialWebsiteSnapshot(normalizedUrl, {
      ...(input.websiteFetch === undefined ? {} : { fetch: input.websiteFetch }),
    });
  } catch (error) {
    throw new WebsiteImportError(error instanceof Error ? error.message : 'website_import_failed');
  }
}

export async function persistWebsiteImportDraft(
  client: pg.PoolClient,
  principal: ReviewerPrincipal,
  input: {
    readonly fetchedAt: Date;
    readonly requestKey: string;
    readonly label: string;
    readonly normalizedUrl: string;
    readonly plainText: string;
    readonly sourceSha256: string;
    readonly contentSha256: string;
    readonly optionalDraft?: {
      readonly versionRef: string;
      readonly itemKey: string;
      readonly kind: 'business_fact' | 'faq';
      readonly questionEn: string;
      readonly questionBn: string;
      readonly answerEn: string;
      readonly answerBn: string;
    };
  },
): Promise<{ readonly sourceRef: string; readonly snapshotRef: string }> {
  const repository = new PostgresKnowledgeRepository({ transactionClient: client });
  const urlHash = sha256(input.normalizedUrl).slice(0, 32);
  const sourceRef = `SOURCE_web_${urlHash}`;

  const existingSource = await client.query<{ readonly source_ref: string }>(
    `select source_ref from knowledge_sources where source_ref = $1`,
    [sourceRef],
  );
  if (existingSource.rows[0] === undefined) {
    await repository.createSource(
      {
        sourceRef,
        sourceType: 'website',
        approvedUrl: input.normalizedUrl,
        label: input.label.slice(0, 200),
        createdByReference: principal.reviewerRef,
        createdAt: input.fetchedAt,
      },
      principal,
    );
  }

  const snapshotRef = `SNAP_${sha256(input.requestKey).slice(0, 32)}`;
  const snapResult = await repository.recordSourceSnapshot(
    {
      snapshotRef,
      sourceRef,
      fetchOutcome: 'retrieved',
      fetchedAt: input.fetchedAt,
      sourceSha256: input.sourceSha256,
      contentSha256: input.contentSha256,
      proposedPublicContent: input.plainText,
      createdByReference: principal.reviewerRef,
      requestKey: input.requestKey,
    },
    principal,
  );
  if (snapResult.status !== 'duplicate') {
    await insertAdminAuditEvent(client, {
      action: 'knowledge_source_imported',
      objectType: 'knowledge_source',
      objectRef: sourceRef,
      reasonCode: 'website_snapshot_captured',
      requestKey: input.requestKey,
      effectiveAt: input.fetchedAt,
      reviewerRef: principal.reviewerRef,
    });
  }

  if (input.optionalDraft !== undefined) {
    const draft = input.optionalDraft;
    const proposalResult = await repository.createProposal(
      {
        aliases: [],
        tags: ['website_import'],
        questions: { en: draft.questionEn, bn: draft.questionBn },
        answers: { en: draft.answerEn, bn: draft.answerBn },
        authorReference: principal.reviewerRef,
        contentSha256: sha256(
          JSON.stringify([draft.questionEn, draft.answerEn, draft.questionBn, draft.answerBn]),
        ),
        sourceSha256: input.sourceSha256,
        sourceRef,
        sourceSnapshotRef: snapshotRef,
        createdAt: input.fetchedAt,
        itemKey: draft.itemKey,
        kind: draft.kind,
        versionRef: draft.versionRef,
        requestKey: `${input.requestKey}:draft`,
      },
      principal,
    );
    if (proposalResult.status !== 'duplicate') {
      await insertAdminAuditEvent(client, {
        action: 'knowledge_proposal_created',
        objectType: 'knowledge_version',
        objectRef: draft.versionRef,
        reasonCode: 'website_draft_created',
        requestKey: `${input.requestKey}:draft`,
        effectiveAt: input.fetchedAt,
        reviewerRef: principal.reviewerRef,
      });
    }
  }

  return { sourceRef, snapshotRef };
}
