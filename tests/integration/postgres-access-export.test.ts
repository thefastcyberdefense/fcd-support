import { readFile } from 'node:fs/promises';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  ACCESS_EXPORT_COLLECTOR_NAMES,
  PostgresAccessExport,
} from '../../src/persistence/postgres-access-export.js';
import { PostgresConsentPolicy } from '../../src/persistence/postgres-consent-policy.js';
import { PostgresPrivacyRightsPolicy } from '../../src/persistence/postgres-privacy-rights-policy.js';
import { ACCESS_EXPORT_CATEGORIES } from '../../src/policy/policy-types.js';
import type { ChannelIdentitySelector } from '../../src/policy/policy-types.js';
import {
  insertSyntheticAppliedCustomerEvent,
  insertSyntheticPendingEvent,
  syntheticPrivacyKeyring,
} from './policy-fixtures.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let disposeDatabase: (() => Promise<void>) | undefined;
let pool: pg.Pool;

beforeAll(async () => {
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase('postgres_access_export');
  disposeDatabase = database.dispose;
  pool = database.pool;
});

beforeEach(async () => {
  await pool.query(
    `truncate table
       privacy_marketing_reopt_in_runs, privacy_access_runs,
       privacy_correction_runs, privacy_marketing_opt_out_runs,
       privacy_notification_intents, privacy_request_events,
       privacy_request_locations, privacy_deletion_runs,
       restore_deletion_gates, privacy_requests, privacy_suppressions,
       retention_job_runs, retention_events, conversation_retention_states,
       policy_audit_outcomes, consent_events, human_pause_events,
       webhook_event_applications, conversations, channel_identities,
       contacts, webhook_events, webhook_receipts
     restart identity cascade`,
  );
});

afterAll(async () => {
  await disposeDatabase?.();
});

const reviewer = {
  reviewerRef: 'REVIEWER_TEST_access_export',
  roles: ['support_reviewer'],
} as const;

const subjectWhatsApp = {
  channel: 'whatsapp',
  channelAccountId: 'ACCOUNT_TEST_access_subject_whatsapp',
  externalContactId: 'CONTACT_TEST_access_subject_whatsapp',
} as const;
const subjectMessenger = {
  channel: 'messenger',
  channelAccountId: 'ACCOUNT_TEST_access_subject_messenger',
  externalContactId: 'CONTACT_TEST_access_subject_messenger',
} as const;
const otherIdentity = {
  channel: 'messenger',
  channelAccountId: 'ACCOUNT_TEST_access_other',
  externalContactId: 'CONTACT_TEST_access_other',
} as const;

interface ApprovedAccessFixture {
  readonly otherMarker: string;
  readonly receiptHash: string;
  readonly requestRef: string;
  readonly subjectMarker: string;
  readonly thirdPartyMarker: string;
}

async function identityId(identity: ChannelIdentitySelector): Promise<string> {
  const selected = await pool.query<{ readonly id: string }>(
    `select id
     from channel_identities
     where channel = $1
       and channel_account_id = $2
       and external_contact_id = $3`,
    [identity.channel, identity.channelAccountId, identity.externalContactId],
  );
  const id = selected.rows[0]?.id;
  if (id === undefined) throw new Error('Synthetic access identity was not created');
  return id;
}

async function prepareApprovedAccessFixture(): Promise<ApprovedAccessFixture> {
  const subjectMarker = 'Synthetic subject support detail';
  const otherMarker = 'Synthetic unrelated contact detail';
  const thirdPartyMarker = 'Synthetic third-party contact-card detail';
  const source = await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: 'access-subject-request',
    identity: subjectWhatsApp,
    messageText: 'REQUEST MY DATA',
    occurredAt: new Date('2026-08-31T08:00:00.000Z'),
  });
  const rightsPolicy = new PostgresPrivacyRightsPolicy(pool, syntheticPrivacyKeyring);
  const opened = await rightsPolicy.processAppliedEvent({
    requestKey: 'access-subject-open',
    sourceWebhookEventId: source.eventId,
  });
  if (opened.status !== 'opened' || opened.intent !== 'access') {
    throw new Error('Synthetic access request was not opened');
  }
  await rightsPolicy.reviewRequest(
    {
      decidedAt: new Date('2026-08-31T08:01:00.000Z'),
      decision: 'approve',
      reasonCode: 'identity_verified',
      requestKey: 'access-subject-review',
      requestRef: opened.requestRef,
      verificationMethod: 'same_channel_context',
    },
    reviewer,
  );
  await rightsPolicy.attestLocation(
    {
      checkedAt: new Date('2026-08-31T08:01:30.000Z'),
      locationCode: 'primary_postgres',
      outcomeCode: 'location_complete',
      requestKey: 'access-subject-primary-postgres',
      requestRef: opened.requestRef,
    },
    reviewer,
  );

  const contact = await pool.query<{ readonly id: string }>(
    `select contact_id as id
     from channel_identities
     where channel = $1
       and channel_account_id = $2
       and external_contact_id = $3`,
    [subjectWhatsApp.channel, subjectWhatsApp.channelAccountId, subjectWhatsApp.externalContactId],
  );
  await pool.query(
    `insert into channel_identities
       (contact_id, channel, channel_account_id, external_contact_id,
        first_seen_at, last_seen_at)
     values ($1, $2, $3, $4, $5, $5)`,
    [
      contact.rows[0]?.id,
      subjectMessenger.channel,
      subjectMessenger.channelAccountId,
      subjectMessenger.externalContactId,
      new Date('2026-08-31T08:02:00.000Z'),
    ],
  );
  await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: 'access-subject-linked-message',
    identity: subjectMessenger,
    messageText: subjectMarker,
    occurredAt: new Date('2026-08-31T08:02:00.000Z'),
  });
  await new PostgresConsentPolicy(pool, syntheticPrivacyKeyring).recordReviewerCommand(
    {
      action: 'grant',
      category: 'security_updates',
      idempotencyKey: 'access-subject-consent',
      identity: subjectMessenger,
      source: 'reviewer_recorded',
      sourceAt: new Date('2026-08-31T08:03:00.000Z'),
      wording: 'Synthetic approved subject consent wording',
      wordingVersion: 'TEST_v1',
    },
    reviewer,
  );
  await insertSyntheticPendingEvent(pool, {
    channel: subjectWhatsApp.channel,
    channelAccountId: subjectWhatsApp.channelAccountId,
    contactId: subjectWhatsApp.externalContactId,
    eventKind: 'unsupported',
    fixtureKey: 'access-third-party-contact-card',
    messageText: thirdPartyMarker,
    occurredAt: new Date('2026-08-31T08:04:00.000Z'),
  });
  await pool.query(
    `insert into privacy_suppressions
       (identity_hmac, channel, category, reason_code,
        effective_at, key_version)
     values ($1, 'whatsapp', 'marketing_opt_out', 'customer_opt_out',
             '2026-08-31T08:04:30Z', 'TEST_v1')`,
    ['a'.repeat(64)],
  );

  const other = await insertSyntheticAppliedCustomerEvent(pool, {
    fixtureKey: 'access-other-contact',
    identity: otherIdentity,
    messageText: otherMarker,
    occurredAt: new Date('2026-08-31T08:05:00.000Z'),
  });
  await new PostgresConsentPolicy(pool, syntheticPrivacyKeyring).recordReviewerCommand(
    {
      action: 'grant',
      category: 'product_offers',
      idempotencyKey: 'access-other-consent',
      identity: otherIdentity,
      source: 'reviewer_recorded',
      sourceAt: new Date('2026-08-31T08:06:00.000Z'),
      wording: 'Synthetic unrelated consent wording',
      wordingVersion: 'TEST_v1',
    },
    reviewer,
  );
  const receipt = await pool.query<{ readonly payload_sha256: string }>(
    `select receipt.payload_sha256
     from webhook_events as event
     join webhook_receipts as receipt on receipt.id = event.receipt_id
     where event.id = $1`,
    [other.eventId],
  );
  const receiptHash = receipt.rows[0]?.payload_sha256;
  if (receiptHash === undefined) throw new Error('Synthetic receipt hash was not found');
  return {
    otherMarker,
    receiptHash,
    requestRef: opened.requestRef,
    subjectMarker,
    thirdPartyMarker,
  };
}

async function relevantTableCounts(): Promise<Record<string, number>> {
  const counts = await pool.query<{ readonly counts: Record<string, number> }>(
    `select jsonb_build_object(
       'webhook_receipts', (select count(*)::int from webhook_receipts),
       'webhook_events', (select count(*)::int from webhook_events),
       'webhook_event_applications', (select count(*)::int from webhook_event_applications),
       'contacts', (select count(*)::int from contacts),
       'channel_identities', (select count(*)::int from channel_identities),
       'conversations', (select count(*)::int from conversations),
       'conversation_retention_states',
         (select count(*)::int from conversation_retention_states),
       'policy_audit_outcomes', (select count(*)::int from policy_audit_outcomes),
       'consent_events', (select count(*)::int from consent_events),
       'privacy_requests', (select count(*)::int from privacy_requests),
       'privacy_request_locations', (select count(*)::int from privacy_request_locations),
       'privacy_request_events', (select count(*)::int from privacy_request_events),
       'privacy_suppressions', (select count(*)::int from privacy_suppressions),
       'privacy_access_runs', (select count(*)::int from privacy_access_runs)
     ) as counts`,
  );
  const result = counts.rows[0]?.counts;
  if (result === undefined) throw new Error('Synthetic access table counts were not returned');
  return result;
}

describe('PostgresAccessExport', () => {
  test('collects only the approved subject through the complete allowlisted registry', async () => {
    const fixture = await prepareApprovedAccessFixture();
    expect(ACCESS_EXPORT_COLLECTOR_NAMES).toEqual(ACCESS_EXPORT_CATEGORIES);
    const before = await relevantTableCounts();
    await pool.query(`
      create function require_repeatable_read_access_run()
      returns trigger language plpgsql as $$
      begin
        if current_setting('transaction_isolation') <> 'repeatable read' then
          raise exception using errcode = '23514', message = 'access export isolation mismatch';
        end if;
        return new;
      end;
      $$;
      create trigger require_repeatable_read_access_run
        before insert on privacy_access_runs
        for each row execute function require_repeatable_read_access_run();
    `);
    const stringifySpy = vi.spyOn(JSON, 'stringify');
    const stdoutSpy = vi.spyOn(process.stdout, 'write');
    try {
      const result = await new PostgresAccessExport(pool).collect(
        {
          collectedAt: new Date('2026-08-31T08:10:00.000Z'),
          requestKey: 'access-subject-collect',
          requestRef: fixture.requestRef,
        },
        reviewer,
      );
      expect(result.status).toBe('collected');
      expect(result.export.manifest).toMatchObject({
        collectedAt: new Date('2026-08-31T08:10:00.000Z'),
        requestRef: fixture.requestRef,
        schemaVersion: 'fcd-support.access.v1',
        sourceCategories: ACCESS_EXPORT_CATEGORIES,
      });
      expect(result.export.records.channel_identities).toHaveLength(2);
      expect(result.export.records.conversations).toHaveLength(2);
      expect(result.export.records.conversation_lifecycle).toHaveLength(2);
      expect(result.export.records.webhook_events).toHaveLength(2);
      expect(result.export.records.consent_history).toHaveLength(1);
      expect(result.export.records.privacy_requests).toHaveLength(1);
      expect(result.export.records.privacy_checklist).toHaveLength(7);
      expect(result.export.manifest.recordCount).toBe(17);

      const serializationInputs: unknown[] = [];
      for (const call of stringifySpy.mock.calls) {
        serializationInputs.push(call[0] as unknown);
      }
      expect(
        serializationInputs.some(
          (value) => value === result.export || value === result.export.records,
        ),
      ).toBe(false);
      expect(stdoutSpy).not.toHaveBeenCalled();
      stringifySpy.mockRestore();
      stdoutSpy.mockRestore();
      const serializedSerializationInputs = JSON.stringify(serializationInputs);
      expect(serializedSerializationInputs).not.toContain(subjectWhatsApp.externalContactId);
      expect(serializedSerializationInputs).not.toContain(subjectMessenger.externalContactId);
      expect(serializedSerializationInputs).not.toContain(fixture.subjectMarker);
      const serialized = JSON.stringify(result.export);
      expect(serialized).toContain(subjectWhatsApp.externalContactId);
      expect(serialized).toContain(subjectMessenger.externalContactId);
      expect(serialized).toContain(fixture.subjectMarker);
      expect(serialized).toContain('Synthetic approved subject consent wording');
      expect(serialized).not.toContain(otherIdentity.externalContactId);
      expect(serialized).not.toContain(fixture.otherMarker);
      expect(serialized).not.toContain(fixture.thirdPartyMarker);
      expect(serialized).not.toContain(fixture.receiptHash);
      expect(serialized).not.toContain(reviewer.reviewerRef);
      expect(serialized).not.toContain('a'.repeat(64));
    } finally {
      stringifySpy.mockRestore();
      stdoutSpy.mockRestore();
      await pool.query(`
        drop trigger require_repeatable_read_access_run on privacy_access_runs;
        drop function require_repeatable_read_access_run();
      `);
    }
    const after = await relevantTableCounts();
    expect(after).toEqual({
      ...before,
      privacy_access_runs: (before.privacy_access_runs ?? 0) + 1,
    });
  });

  test('re-collects fresh in-memory data on exact replay without duplicating evidence', async () => {
    const fixture = await prepareApprovedAccessFixture();
    const service = new PostgresAccessExport(pool);
    const command = {
      collectedAt: new Date('2026-08-31T08:10:00.000Z'),
      requestKey: 'access-subject-replay',
      requestRef: fixture.requestRef,
    } as const;

    await expect(service.collect(command, reviewer)).resolves.toMatchObject({
      status: 'collected',
    });
    await pool.query(
      `update channel_identities
       set last_seen_at = '2026-08-31T08:11:00Z'
       where id = $1`,
      [await identityId(subjectMessenger)],
    );
    const replay = await service.collect(command, reviewer);

    expect(replay.status).toBe('duplicate');
    expect(replay.export.records.channel_identities).toContainEqual(
      expect.objectContaining({
        externalContactId: subjectMessenger.externalContactId,
        lastSeenAt: new Date('2026-08-31T08:11:00.000Z'),
      }),
    );
    await expect(
      pool.query(`select count(*)::int as count from privacy_access_runs`),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(
      service.collect({ ...command, collectedAt: new Date('2026-08-31T08:12:00.000Z') }, reviewer),
    ).rejects.toMatchObject({ name: 'PolicyIdempotencyConflictError' });
  });

  test('requires a support reviewer and an approved access request', async () => {
    const fixture = await prepareApprovedAccessFixture();
    const command = {
      collectedAt: new Date('2026-08-31T08:10:00.000Z'),
      requestKey: 'access-authorization',
      requestRef: fixture.requestRef,
    };
    await expect(
      new PostgresAccessExport(pool).collect(command, {
        reviewerRef: 'REVIEWER_TEST_access_unauthorized',
        roles: ['incident_reader'],
      }),
    ).rejects.toMatchObject({ name: 'PolicyAuthorizationError' });

    const pending = await insertSyntheticAppliedCustomerEvent(pool, {
      fixtureKey: 'access-unapproved-request',
      identity: {
        ...subjectWhatsApp,
        externalContactId: 'CONTACT_TEST_access_unapproved',
      },
      messageText: 'REQUEST MY DATA',
      occurredAt: new Date('2026-08-31T08:20:00.000Z'),
    });
    const opened = await new PostgresPrivacyRightsPolicy(
      pool,
      syntheticPrivacyKeyring,
    ).processAppliedEvent({
      requestKey: 'access-unapproved-open',
      sourceWebhookEventId: pending.eventId,
    });
    if (opened.status !== 'opened') throw new Error('Synthetic unapproved request was not opened');
    await expect(
      new PostgresAccessExport(pool).collect(
        { ...command, requestKey: 'access-unapproved-collect', requestRef: opened.requestRef },
        reviewer,
      ),
    ).rejects.toMatchObject({ name: 'PolicyIdempotencyConflictError' });
  });

  test('rolls back aggregate evidence when its final insert fails', async () => {
    const fixture = await prepareApprovedAccessFixture();
    await pool.query(`
      create function reject_synthetic_access_run()
      returns trigger language plpgsql as $$
      begin
        raise exception using errcode = '23514', message = 'synthetic access run failure';
      end;
      $$;
      create trigger reject_synthetic_access_run
        before insert on privacy_access_runs
        for each row execute function reject_synthetic_access_run();
    `);
    try {
      await expect(
        new PostgresAccessExport(pool).collect(
          {
            collectedAt: new Date('2026-08-31T08:10:00.000Z'),
            requestKey: 'access-run-rollback',
            requestRef: fixture.requestRef,
          },
          reviewer,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        pool.query(`select count(*)::int as count from privacy_access_runs`),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await pool.query(`
        drop trigger reject_synthetic_access_run on privacy_access_runs;
        drop function reject_synthetic_access_run();
      `);
    }
  });

  test('has no filesystem, network, logging, or serialization sink in production source', async () => {
    const source = await readFile(
      new URL('../../src/persistence/postgres-access-export.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/node:fs|node:http|node:https|fetch\s*\(|console\.|JSON\.stringify/);
    expect(source).not.toMatch(/SafeLogger|writeFile|appendFile|createWriteStream/);
  });
});
