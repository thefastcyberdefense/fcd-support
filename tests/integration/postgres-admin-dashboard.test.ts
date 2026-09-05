import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AdminSecretBytes, AdminSecretText } from '../../src/admin/admin-types.js';
import { AesGcmAdminSecretProtector, generateTotpCode } from '../../src/admin/mfa.js';
import type { AdminActor } from '../../src/admin/admin-app.js';
import { PostgresAdminDashboard } from '../../src/persistence/postgres-admin-dashboard.js';
import { PostgresAdminIdentity } from '../../src/persistence/postgres-admin-identity.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let database: IsolatedTestDatabase;
let disposeDatabase: (() => Promise<void>) | undefined;
let identity: PostgresAdminIdentity;
let dashboard: PostgresAdminDashboard;
let actor: AdminActor;
let at = new Date('2026-09-05T06:00:00.000Z');
const seed = new AdminSecretBytes(Buffer.alloc(20, 0x53));
const totpPolicy = {
  algorithm: 'sha1',
  digits: 6,
  periodSeconds: 30,
  verificationWindow: 0,
} as const;
const now = () => new Date(at);

beforeAll(async () => {
  database = await createIsolatedTestDatabase('postgres_admin_dashboard');
  disposeDatabase = database.dispose;
  identity = new PostgresAdminIdentity(database.pool, {
    mfaProtector: new AesGcmAdminSecretProtector(
      'test-v1',
      new AdminSecretBytes(Buffer.alloc(32, 0x55)),
    ),
    now,
    passwordPolicy: {
      algorithm: 'scrypt_v1',
      blockSize: 8,
      cost: 16384,
      keyLength: 32,
      parallelization: 1,
      saltLength: 16,
    },
    preauthenticationTtlMilliseconds: 300000,
    sessionHmacKey: new AdminSecretBytes(Buffer.alloc(32, 0x54)),
    sessionTtlMilliseconds: 3600000,
    totpPolicy,
  });
  await identity.createAccount(
    {
      accountRef: 'ADMIN_TEST_dashboard',
      loginName: 'synthetic.dashboard',
      password: new AdminSecretText('Synthetic-dashboard-passphrase'),
      mfaSeed: seed,
      createdAt: now(),
      requestKey: 'REQUEST_TEST_dashboard_bootstrap',
    },
    { kind: 'initial_bootstrap' },
  );
  const preauth = await identity.beginPasswordAuthentication({
    loginName: 'synthetic.dashboard',
    password: new AdminSecretText('Synthetic-dashboard-passphrase'),
  });
  if (preauth.status !== 'mfa_required') throw new Error('Synthetic login failed');
  const active = await identity.completeMfaAuthentication({
    code: generateTotpCode(seed, at, totpPolicy),
    preauthenticationToken: preauth.sessionToken,
  });
  if (active.status !== 'authenticated') throw new Error('Synthetic MFA failed');
  actor = {
    accountRef: 'ADMIN_TEST_dashboard',
    roles: ['administrator'],
    sessionToken: active.sessionToken,
  };
  dashboard = new PostgresAdminDashboard(database.pool, identity, { now });
});
afterAll(async () => {
  await disposeDatabase?.();
});

function proposal(version: number) {
  return {
    answerEn: `Synthetic reviewed answer ${String(version)}.`,
    answerBn: `সিনথেটিক পর্যালোচিত উত্তর ${String(version)}।`,
    questionEn: 'Synthetic office hours?',
    questionBn: 'সিনথেটিক অফিস সময়?',
    kind: 'faq',
    itemKey: 'faq.synthetic.dashboard',
    sourceLabel: 'Synthetic manual business source',
    versionRef: `VERSION_TEST_dashboard_${String(version)}`,
    createdAt: now(),
    requestKey: `REQUEST_TEST_dashboard_create_${String(version)}`,
    ...(version === 1
      ? {}
      : { replacesVersionRef: `VERSION_TEST_dashboard_${String(version - 1)}` }),
  };
}
function command(version: number, action: string) {
  return {
    effectiveAt: now(),
    versionRef: `VERSION_TEST_dashboard_${String(version)}`,
    requestKey: `REQUEST_TEST_dashboard_${action}_${String(version)}`,
  };
}
async function approve(version: number) {
  await dashboard.submitVersion(command(version, 'submit'), actor);
  await dashboard.reviewVersion({ ...command(version, 'approve'), action: 'approve' }, actor);
}

describe('Postgres private admin dashboard', () => {
  test('creates manual provenance and drafts transactionally, then submits, reviews, and publishes exactly once', async () => {
    const input = proposal(1);
    await dashboard.createProposal(input, actor);
    await dashboard.createProposal(input, actor);
    expect((await dashboard.getProposal(input.versionRef)).state).toBe('draft');
    expect((await dashboard.getProposal(input.versionRef)).publicationState).toBe('unpublished');
    await approve(1);
    const publish = command(1, 'publish');
    await dashboard.publishVersion(publish, actor);
    await dashboard.publishVersion(publish, actor);
    expect((await dashboard.getProposal(input.versionRef)).publicationState).toBe('published');
    const counts = await database.pool.query<{ count: number }>(
      `select count(*)::int as count from knowledge_publication_events`,
    );
    expect(counts.rows[0]?.count).toBe(1);
    expect(
      (await dashboard.listAudit()).some((entry) => entry.action === 'knowledge_published'),
    ).toBe(true);
  });
  test('preserves prior-version confirmation, schedules replacement, compares versions, and rolls back with history', async () => {
    at = new Date('2026-09-05T06:01:00.000Z');
    await dashboard.createProposal(proposal(2), actor);
    await approve(2);
    const publish = {
      ...command(2, 'publish'),
      effectiveAt: new Date('2026-09-05T06:02:00.000Z'),
      priorVersionRef: 'VERSION_TEST_dashboard_1',
    };
    await expect(
      dashboard.publishVersion({ ...publish, priorVersionRef: 'VERSION_TEST_missing' }, actor),
    ).rejects.toThrow();
    await dashboard.publishVersion(publish, actor);
    expect((await dashboard.getProposal('VERSION_TEST_dashboard_2')).publicationState).toBe(
      'scheduled',
    );
    expect((await dashboard.getProposal('VERSION_TEST_dashboard_2')).previousAnswers?.en).toBe(
      proposal(1).answerEn,
    );
    expect(
      (
        await dashboard.getProposal(
          'VERSION_TEST_dashboard_1',
          new Date('2026-09-05T06:03:00.000Z'),
        )
      ).currentVersionRef,
    ).toBe('VERSION_TEST_dashboard_2');
    at = new Date('2026-09-05T06:03:00.000Z');
    expect((await dashboard.getProposal('VERSION_TEST_dashboard_2')).publicationState).toBe(
      'published',
    );
    await expect(dashboard.retireVersion(command(1, 'stale_retire'), actor)).rejects.toThrow();
    const rollback = { ...command(1, 'rollback'), priorVersionRef: 'VERSION_TEST_dashboard_2' };
    await dashboard.rollbackVersion(rollback, actor);
    await dashboard.rollbackVersion(rollback, actor);
    expect((await dashboard.getProposal('VERSION_TEST_dashboard_1')).publicationState).toBe(
      'published',
    );
    await dashboard.retireVersion(
      { ...command(1, 'retire'), effectiveAt: new Date('2026-09-05T06:04:00.000Z') },
      actor,
    );
    expect(await dashboard.getProposal('VERSION_TEST_dashboard_1')).toMatchObject({
      publicationState: 'published',
      scheduledAction: 'retire',
      scheduledEffectiveAt: new Date('2026-09-05T06:04:00.000Z'),
    });
    expect(
      (await dashboard.listProposals({ state: 'scheduled' })).map((entry) => entry.versionRef),
    ).toContain('VERSION_TEST_dashboard_1');
    at = new Date('2026-09-05T06:05:00.000Z');
    expect((await dashboard.getProposal('VERSION_TEST_dashboard_1')).publicationState).toBe(
      'retired',
    );
  });
  test('filters before limiting and paginates older versions deterministically', async () => {
    const paginated = new PostgresAdminDashboard(database.pool, identity, { now, listLimit: 1 });
    expect((await paginated.listProposals()).map((entry) => entry.versionRef)).toEqual([
      'VERSION_TEST_dashboard_2',
    ]);
    expect(
      (await paginated.listProposals({ search: 'VERSION_TEST_dashboard_1' })).map(
        (entry) => entry.versionRef,
      ),
    ).toEqual(['VERSION_TEST_dashboard_1']);
    expect((await paginated.listProposals({ page: 2 })).map((entry) => entry.versionRef)).toEqual([
      'VERSION_TEST_dashboard_1',
    ]);
    expect(
      (await paginated.listProposals({ state: 'retired' })).map((entry) => entry.versionRef),
    ).toEqual(['VERSION_TEST_dashboard_1']);
  });
  test('lists every pending version when one item has multiple scheduled publications', async () => {
    const versionRef = (version: number) => 'VERSION_TEST_queue_' + String(version);
    for (const version of [1, 2, 3]) {
      const input = {
        ...proposal(1),
        itemKey: 'faq.synthetic.queue',
        versionRef: versionRef(version),
        requestKey: 'REQUEST_TEST_queue_create_' + String(version),
        ...(version === 1 ? {} : { replacesVersionRef: versionRef(version - 1) }),
      };
      await dashboard.createProposal(input, actor);
      const submit = {
        versionRef: versionRef(version),
        effectiveAt: now(),
        requestKey: 'REQUEST_TEST_queue_submit_' + String(version),
      };
      await dashboard.submitVersion(submit, actor);
      await dashboard.reviewVersion(
        {
          ...submit,
          action: 'approve',
          requestKey: 'REQUEST_TEST_queue_review_' + String(version),
        },
        actor,
      );
      await dashboard.publishVersion(
        {
          ...submit,
          requestKey: 'REQUEST_TEST_queue_publish_' + String(version),
          effectiveAt: new Date(at.getTime() + (version - 1) * 60000),
          ...(version === 1 ? {} : { priorVersionRef: versionRef(version - 1) }),
        },
        actor,
      );
    }
    expect((await dashboard.getProposal(versionRef(3))).publicationState).toBe('scheduled');
    expect(
      (await dashboard.listProposals({ search: 'VERSION_TEST_queue_', state: 'scheduled' })).map(
        (entry) => entry.versionRef,
      ),
    ).toEqual([versionRef(3), versionRef(2)]);
  });
  test('rejects forged actors and revoked sessions inside the mutation transaction', async () => {
    await expect(
      dashboard.createProposal(proposal(3), { ...actor, accountRef: 'ADMIN_TEST_forged' }),
    ).rejects.toThrow();
    await identity.revokeSession({ sessionToken: actor.sessionToken });
    await expect(dashboard.createProposal(proposal(3), actor)).rejects.toThrow();
    const counts = await database.pool.query<{ count: number }>(
      `select count(*)::int as count from knowledge_versions`,
    );
    expect(counts.rows[0]?.count).toBe(5);
  });
});
