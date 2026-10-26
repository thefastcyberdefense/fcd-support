import type { FastifyInstance } from 'fastify';
import { afterEach, expect, test } from 'vitest';
import { buildAdminApp, type AdminIdentityPort } from '../src/admin/admin-app.js';
import { buildApp } from '../src/app.js';
import { createSafeLogger } from '../src/logging.js';
import {
  operationsView,
  operationsTestAt,
  emptyAdminDashboard,
  syntheticOperationsIdentity,
} from './helpers/admin-operations-fixtures.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const origin = 'http://127.0.0.1:3004';
const cookie = 'fcd_admin_session=synthetic_session; fcd_admin_csrf=synthetic_csrf';
function fixture(identity: AdminIdentityPort = syntheticOperationsIdentity()) {
  const applied: unknown[] = [];
  const logs: string[] = [];
  const view = operationsView();
  const app = buildAdminApp({
    dashboard: emptyAdminDashboard(),
    identity,
    origin,
    secureCookie: false,
    now: () => operationsTestAt,
    logger: createSafeLogger({
      write: (line) => {
        logs.push(line);
      },
    }),
    operations: {
      read: () => Promise.resolve(view),
      acknowledgeIncident: (input: unknown) => {
        applied.push(input);
        return Promise.resolve();
      },
    },
  });
  apps.push(app);
  return { app, applied, view, logs };
}
test('operations route is private and empty dashboard has accessible mobile and desktop states', async () => {
  const { app } = fixture();
  expect((await app.inject('/operations')).statusCode).toBe(303);
  const response = await app.inject({ url: '/operations', headers: { cookie } });
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).toContain('Operational health');
  expect(response.body).toContain('No health observations');
  expect(response.body).toContain('No incidents');
  expect(response.body).toContain('name="viewport"');
  expect(response.body).toContain('aria-label="Mobile administration"');
  expect(response.body).toContain('disabled');
  expect(response.body).toContain('not_verified');
});
test('acknowledgement uses the existing signed action origin and csrf protections', async () => {
  const f = fixture();
  f.view.incidents = [
    {
      incidentRef: 'INCIDENT_TEST_health',
      component: 'postgres',
      openedAt: new Date('2029-12-31T23:59:00.000Z'),
      lastObservedAt: operationsTestAt,
      acknowledgedAt: null,
      resolvedAt: null,
      consecutiveFailures: 2,
    },
  ];
  const page = await f.app.inject({ url: '/operations', headers: { cookie } });
  const actionToken = /name="actionToken" value="([^"]+)"/u.exec(page.body)?.[1];
  expect(actionToken).toBeDefined();
  const post = (values: Record<string, string>, requestOrigin = origin) =>
    f.app.inject({
      method: 'POST',
      url: '/operations/incidents/INCIDENT_TEST_health/acknowledge',
      headers: {
        cookie,
        origin: requestOrigin,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams(values).toString(),
    });
  const form = { actionToken: actionToken ?? '', csrfToken: 'synthetic_csrf' };
  expect((await post(form, 'https://synthetic.example.invalid')).statusCode).toBe(403);
  expect((await post({ ...form, csrfToken: 'synthetic_wrong' })).statusCode).toBe(403);
  expect((await post({ ...form, actionToken: 'synthetic_wrong' })).statusCode).toBe(400);
  expect(f.applied).toEqual([]);
  expect((await post(form)).statusCode).toBe(303);
  expect(f.applied).toEqual([
    expect.objectContaining({
      incidentRef: 'INCIDENT_TEST_health',
      acknowledgedAt: operationsTestAt,
    }),
  ]);
});
test('expired revoked and wrong-role sessions cannot view or acknowledge operations', async () => {
  for (const session of [
    undefined,
    {
      accountRef: 'ADMIN_TEST_reviewer',
      roles: ['support_reviewer'] as const,
      expiresAt: new Date('2030-01-01T01:00:00.000Z'),
    },
  ]) {
    const identity = syntheticOperationsIdentity();
    const f = fixture({ ...identity, resolveSession: () => Promise.resolve(session) });
    expect((await f.app.inject({ url: '/operations', headers: { cookie } })).statusCode).toBe(
      session === undefined ? 303 : 403,
    );
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/operations/incidents/INCIDENT_TEST_health/acknowledge',
          headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
          payload: 'csrfToken=synthetic_csrf&actionToken=synthetic_wrong',
        })
      ).statusCode,
    ).toBe(session === undefined ? 303 : 403);
    expect(f.applied).toEqual([]);
  }
});
test('malformed external display fields fail closed without appearing in UI or log', async () => {
  const f = fixture();
  Object.assign(f.view, { deploymentState: '<script>synthetic_external_secret</script>' });
  const response = await f.app.inject({ url: '/operations', headers: { cookie } });
  expect(response.statusCode).toBe(500);
  expect(response.body + f.logs.join('')).not.toContain('synthetic_external_secret');
});
test('public app never acquires the private operations route', async () => {
  const app = buildApp({
    metaAppSecret: 'synthetic_app_secret',
    metaVerifyToken: 'synthetic_verify',
    receiptSink: () => Promise.resolve({ status: 'accepted' }),
  });
  apps.push(app);
  expect((await app.inject('/operations')).statusCode).toBe(404);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/operations/incidents/INCIDENT_TEST_health/acknowledge',
      })
    ).statusCode,
  ).toBe(404);
});
