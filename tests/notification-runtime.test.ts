import pg from 'pg';
import { describe, expect, test, vi } from 'vitest';

import { noopSafeLogger } from '../src/logging.js';
import { createNotificationRuntime } from '../src/operations/notification-runtime.js';
import { operationsEnvironment } from './helpers/operations-fixtures.js';
import { syntheticN8nSecret } from './helpers/fake-n8n-server.js';

function environment() {
  const shared = operationsEnvironment();
  const resources = JSON.parse(shared.OPS_RESOURCE_LIMITS_JSON) as Record<string, unknown>;
  return {
    ...shared,
    OPS_RESOURCE_LIMITS_JSON: JSON.stringify({ ...resources, notification: resources.reply }),
    DATABASE_URL: 'postgresql://synthetic@127.0.0.1/fcd_support_test',
    OPS_GIT_REVISION: 'c'.repeat(40),
    OPS_SCHEMA_REVISION: '000016',
  };
}
const enabled = () => ({
  ...environment(),
  N8N_EXECUTION_ENABLED: 'true',
  N8N_ORIGIN: 'http://n8n:5678',
  N8N_PATH: '/webhook/fcd-notification',
  N8N_ESCALATION_WEBHOOK_SECRET: syntheticN8nSecret,
  N8N_PROVIDER_TIMEOUT_MS: '1000',
  N8N_MAX_RESPONSE_BYTES: '1024',
  N8N_MAX_ATTEMPTS: '3',
  N8N_RETRY_BASE_MS: '1000',
  N8N_RETRY_MAXIMUM_MS: '8000',
  N8N_ALLOW_LOOPBACK_FAKE: 'false',
});
describe('private notification runtime', () => {
  test('enabled configuration constructs the bounded runtime without contacting n8n at startup', async () => {
    const pool = new pg.Pool();
    const query = vi.spyOn(pool, 'query');
    const end = vi.spyOn(pool, 'end').mockResolvedValue(undefined);
    const poolFactory = vi.fn(() => pool);
    const runtime = await createNotificationRuntime({
      role: 'notification',
      environment: enabled(),
      now: () => new Date(),
      logger: noopSafeLogger,
      poolFactory,
    });
    expect(poolFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        max: 10,
        query_timeout: 20000,
        statement_timeout: 20000,
        idle_in_transaction_session_timeout: 20000,
      }),
    );
    expect(query).not.toHaveBeenCalled();
    await runtime.stop();
    expect(end).toHaveBeenCalledOnce();
  });
  test('disabled execution needs no signing credential and makes no claims or network calls', async () => {
    const pool = new pg.Pool();
    const query = vi.spyOn(pool, 'query');
    const end = vi.spyOn(pool, 'end').mockResolvedValue(undefined);
    const heartbeat = vi.fn();
    const transport = vi.fn();
    const runtime = await createNotificationRuntime({
      role: 'notification',
      environment: environment(),
      now: () => new Date('2030-04-01T00:00:00.000Z'),
      logger: noopSafeLogger,
      poolFactory: () => pool,
      onHeartbeat: heartbeat,
      testTransports: { n8n: transport },
    });
    await runtime.start();
    await runtime.stop();
    await runtime.stop();
    expect(query).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledOnce();
    expect(heartbeat).toHaveBeenCalledWith(expect.objectContaining({ state: 'disabled' }));
  });
  test.each([
    'N8N_ORIGIN',
    'N8N_PATH',
    'N8N_ESCALATION_WEBHOOK_SECRET',
    'N8N_PROVIDER_TIMEOUT_MS',
    'N8N_MAX_RESPONSE_BYTES',
    'N8N_MAX_ATTEMPTS',
    'N8N_RETRY_BASE_MS',
    'N8N_RETRY_MAXIMUM_MS',
    'N8N_ALLOW_LOOPBACK_FAKE',
  ])('missing enabled %s fails before constructing a pool', async (key) => {
    const poolFactory = vi.fn(() => new pg.Pool());
    await expect(
      createNotificationRuntime({
        role: 'notification',
        environment: { ...enabled(), [key]: undefined },
        now: () => new Date(),
        logger: noopSafeLogger,
        poolFactory,
      }),
    ).rejects.toThrow();
    expect(poolFactory).not.toHaveBeenCalled();
  });
  test.each([
    { N8N_ORIGIN: 'http://example.invalid' },
    { N8N_ORIGIN: 'http://127.0.0.1:5678' },
    { N8N_MAX_ATTEMPTS: '101' },
    { N8N_RETRY_BASE_MS: '9000' },
    { N8N_MAX_RESPONSE_BYTES: '0' },
    { N8N_PROVIDER_TIMEOUT_MS: '20001' },
    { N8N_ALLOW_LOOPBACK_FAKE: 'yes' },
  ])('invalid enabled configuration fails before pool %#', async (change) => {
    const poolFactory = vi.fn(() => new pg.Pool());
    await expect(
      createNotificationRuntime({
        role: 'notification',
        environment: { ...enabled(), ...change },
        now: () => new Date(),
        logger: noopSafeLogger,
        poolFactory,
      }),
    ).rejects.toThrow();
    expect(poolFactory).not.toHaveBeenCalled();
  });
  test('production refuses test transport injection before any secret or database access', async () => {
    const poolFactory = vi.fn(() => new pg.Pool());
    await expect(
      createNotificationRuntime({
        role: 'notification',
        environment: { NODE_ENV: 'production' },
        now: () => new Date(),
        logger: noopSafeLogger,
        poolFactory,
        testTransports: { n8n: vi.fn() },
      }),
    ).rejects.toThrow('notification_runtime_configuration_invalid');
    expect(poolFactory).not.toHaveBeenCalled();
  });
  test('production refuses synthetic mode before database construction', async () => {
    const poolFactory = vi.fn(() => new pg.Pool());
    await expect(
      createNotificationRuntime({
        role: 'notification',
        environment: { ...enabled(), NODE_ENV: 'production', N8N_ALLOW_LOOPBACK_FAKE: 'true' },
        now: () => new Date(),
        logger: noopSafeLogger,
        poolFactory,
      }),
    ).rejects.toThrow();
    expect(poolFactory).not.toHaveBeenCalled();
  });
});
