import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildAdminApp } from '../../src/admin/admin-app.js';
import { AdminSecretBytes, AdminSecretText } from '../../src/admin/admin-types.js';
import { generateTotpCode } from '../../src/admin/mfa.js';
import { startAdminSocket } from '../../src/admin/admin-socket.js';
import {
  PostgresAdminOperations,
  postgresHealthDatabase,
} from '../../src/persistence/postgres-admin-operations.js';
import { emptyAdminDashboard } from '../helpers/admin-operations-fixtures.js';
import {
  createPhase6Fixture,
  operationsAt,
  type Phase6OperationsFixture,
} from './phase6-operations-fixtures.js';

let fixture: Phase6OperationsFixture;
beforeEach(async () => {
  fixture = await createPhase6Fixture();
});
afterEach(async () => {
  await fixture.dispose();
});
async function openIncident() {
  await fixture.store.recordHealth({
    component: 'postgres',
    state: 'unavailable',
    reasonCode: 'dependency_unavailable',
    checkedAt: operationsAt,
    durationMilliseconds: 1,
  });
  return (
    (
      await fixture.db.pool.query<{ incident_ref: string }>(
        'select incident_ref from operations_incidents',
      )
    ).rows[0]?.incident_ref ?? ''
  );
}
describe('PostgreSQL private operations dashboard', () => {
  test('reads aggregate queues and metadata without selecting customer content', async () => {
    const dashboard = new PostgresAdminOperations(fixture.db.pool, fixture.identity, {
      now: () => operationsAt,
    });
    const view = await dashboard.read(fixture.actor);
    expect(view.schemaRevision).toBe('000016');
    expect(view.queues).toEqual([
      {
        component: 'notification',
        pending: 0,
        leased: 0,
        failed: 0,
        completed: 0,
        oldestAgeBucket: 'empty',
      },
      {
        component: 'outbound',
        pending: 0,
        leased: 0,
        failed: 0,
        completed: 0,
        oldestAgeBucket: 'empty',
      },
      {
        component: 'reply',
        pending: 0,
        leased: 0,
        failed: 0,
        completed: 0,
        oldestAgeBucket: 'empty',
      },
    ]);
    expect(view.backup.state).toBe('not_verified');
    expect(view.host).toBeNull();
    const health = await postgresHealthDatabase(fixture.db.pool, () => operationsAt).read();
    expect(health.schemaRevision).toBe('000016');
    expect(health.queues).toEqual(view.queues);
  });
  test('stale backups and observations are explicit and disabled paths take precedence', async () => {
    const backup = {
      backupRef: 'BACKUP_TEST_health',
      class: 'daily' as const,
      createdAt: new Date('2029-01-01T00:00:00.000Z'),
      gitRevision: 'a'.repeat(40),
      schemaRevision: '000016',
      ciphertextBytes: 10,
      ciphertextSha256: '0'.repeat(64),
    };
    await fixture.store.recordBackup({ ...backup, state: 'created' });
    await fixture.store.recordBackup({ ...backup, state: 'verified' });
    await fixture.store.recordHealth({
      component: 'manifest',
      state: 'healthy',
      reasonCode: 'ok',
      checkedAt: new Date('2029-12-31T00:00:00.000Z'),
      durationMilliseconds: 1,
    });
    await fixture.store.recordHealth({
      component: 'webhook',
      state: 'healthy',
      reasonCode: 'ok',
      checkedAt: new Date('2029-12-31T00:00:00.000Z'),
      durationMilliseconds: 1,
    });
    const view = await new PostgresAdminOperations(fixture.db.pool, fixture.identity, {
      now: () => operationsAt,
      modelEnabled: false,
    }).read(fixture.actor);
    expect(view.backup.state).toBe('stale');
    expect(view.health.find((value) => value.component === 'webhook')).toMatchObject({
      state: 'unknown',
      reasonCode: 'stale',
    });
    expect(view.health.find((value) => value.component === 'manifest')).toMatchObject({
      state: 'disabled',
      reasonCode: 'disabled',
    });
  });
  test('acknowledges idempotently and reauthorizes expired revoked forged and wrong-role actors inside transaction', async () => {
    const incidentRef = await openIncident();
    const dashboard = new PostgresAdminOperations(fixture.db.pool, fixture.identity, {
      now: () => operationsAt,
    });
    const command = {
      incidentRef,
      requestKey: 'REQUEST_TEST_operations_ack',
      acknowledgedAt: operationsAt,
    };
    await Promise.all([
      dashboard.acknowledgeIncident(command, fixture.actor),
      dashboard.acknowledgeIncident(command, fixture.actor),
    ]);
    expect(
      (
        await fixture.db.pool.query(
          "select count(*)::int as n from operations_incident_events where action='acknowledged'",
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
    await expect(
      dashboard.acknowledgeIncident(
        { ...command, requestKey: 'REQUEST_TEST_forged' },
        { ...fixture.actor, accountRef: 'ADMIN_TEST_forged' },
      ),
    ).rejects.toThrow();
    fixture.setNow(new Date('2030-01-01T02:00:00.000Z'));
    await expect(
      dashboard.acknowledgeIncident(
        { ...command, requestKey: 'REQUEST_TEST_expired' },
        fixture.actor,
      ),
    ).rejects.toThrow('operations_unauthorized');
    fixture.setNow(operationsAt);
    await fixture.db.pool.query(
      `insert into admin_role_assignments(account_id,role,action,actor_account_id,effective_at,request_key)
      select id,'administrator','revoke',id,$1,'REQUEST_TEST_health_revoke_role' from admin_accounts`,
      [operationsAt],
    );
    await expect(
      dashboard.acknowledgeIncident({ ...command, requestKey: 'REQUEST_TEST_role' }, fixture.actor),
    ).rejects.toThrow('operations_unauthorized');
    await fixture.identity.revokeSession({ sessionToken: fixture.actor.sessionToken });
    await expect(
      dashboard.acknowledgeIncident(
        { ...command, requestKey: 'REQUEST_TEST_revoked' },
        fixture.actor,
      ),
    ).rejects.toThrow('operations_unauthorized');
  });
  test('loopback-to-socket operations retain real password MFA signed-action CSRF origin and revocation guards', async () => {
    const incidentRef = await openIncident();
    const at = new Date('2030-01-01T00:00:30.000Z');
    fixture.setNow(at);
    const root = await mkdtemp(join(tmpdir(), 'fcd-health-socket-'));
    await chmod(root, 0o700);
    const path = join(root, 'admin.sock');
    const connections = new Set<Socket>();
    const forward = createServer((client) => {
      const upstream = createConnection({ path });
      for (const socket of [client, upstream]) {
        connections.add(socket);
        socket.once('close', () => connections.delete(socket));
        socket.once('error', () => {
          client.destroy();
          upstream.destroy();
        });
      }
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve) => forward.listen(0, '127.0.0.1', resolve));
    const address = forward.address();
    if (address === null || typeof address === 'string')
      throw new Error('synthetic_forward_invalid');
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const operations = new PostgresAdminOperations(fixture.db.pool, fixture.identity, {
      now: () => at,
    });
    const app = buildAdminApp({
      identity: fixture.identity,
      dashboard: emptyAdminDashboard(),
      operations,
      now: () => at,
      origin,
      secureCookie: false,
    });
    let handle: Awaited<ReturnType<typeof startAdminSocket>> | undefined;
    let cookies = '';
    const save = (response: Response) => {
      cookies = response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
    };
    const csrf = () =>
      cookies
        .split('; ')
        .find((part) => part.startsWith('fcd_admin_csrf='))
        ?.split('=')[1] ?? '';
    const post = (url: string, body: Record<string, string>, requestOrigin = origin) =>
      fetch(origin + url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          origin: requestOrigin,
          cookie: cookies,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(body),
      });
    try {
      handle = await startAdminSocket(app, path);
      expect((await fetch(origin + '/operations', { redirect: 'manual' })).status).toBe(303);
      const password = await post('/login', {
        loginName: 'synthetic.operations',
        password: 'synthetic_operations_passphrase',
      });
      expect(password.status).toBe(303);
      save(password);
      expect((await post('/mfa', { code: 'synthetic_wrong', csrfToken: csrf() })).status).toBe(401);
      const mfa = await post('/mfa', {
        code: generateTotpCode(new AdminSecretBytes(Buffer.alloc(20, 9)), at, {
          algorithm: 'sha1',
          digits: 6,
          periodSeconds: 30,
          verificationWindow: 0,
        }),
        csrfToken: csrf(),
      });
      expect(mfa.status).toBe(303);
      save(mfa);
      const page = await fetch(origin + '/operations', { headers: { cookie: cookies } });
      expect(page.status).toBe(200);
      const token = /name="actionToken" value="([^"]+)"/u.exec(await page.text())?.[1] ?? '';
      const url = `/operations/incidents/${incidentRef}/acknowledge`;
      const form = { csrfToken: csrf(), actionToken: token };
      expect((await post(url, form, 'https://synthetic.example.invalid')).status).toBe(403);
      expect((await post(url, { ...form, csrfToken: 'synthetic_wrong' })).status).toBe(403);
      expect((await post(url, { ...form, actionToken: 'synthetic_wrong' })).status).toBe(400);
      expect((await post(url, form)).status).toBe(303);
      expect((await post(url, form)).status).toBe(303);
      await fixture.identity.revokeSession({
        sessionToken: new AdminSecretText(
          cookies
            .split('; ')
            .find((part) => part.startsWith('fcd_admin_session='))
            ?.split('=')[1] ?? '',
        ),
      });
      expect((await post(url, form)).status).toBe(303);
      expect(
        (
          await fixture.db.pool.query(
            "select count(*)::int as n from operations_incident_events where action='acknowledged'",
          )
        ).rows,
      ).toEqual([{ n: 1 }]);
    } finally {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) =>
        forward.close(() => {
          resolve();
        }),
      );
      if (handle !== undefined) await handle.close();
      else await app.close();
      if (root.startsWith(join(tmpdir(), 'fcd-health-socket-')))
        await rm(root, { recursive: true, force: true });
    }
  });
});
