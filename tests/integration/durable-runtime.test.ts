import { createHash, createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { createRuntime } from '../../src/runtime.js';
import { syntheticPrivacyKeyring } from './policy-fixtures.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let databaseUrl: string;
let disposeDatabase: (() => Promise<void>) | undefined;
let pool: pg.Pool;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  const database: IsolatedTestDatabase = await createIsolatedTestDatabase('durable_runtime');
  databaseUrl = database.connectionString;
  disposeDatabase = database.dispose;
  pool = database.pool;
});

beforeEach(async () => {
  await pool.query('truncate table webhook_events, webhook_receipts restart identity cascade');
});

afterAll(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  await disposeDatabase?.();
});

describe('durable runtime', () => {
  test('acknowledges only after PostgreSQL stores the signed delivery', async () => {
    const appSecret = 'synthetic_app_secret_1234567890';
    const rawBody = JSON.stringify({ object: 'unknown', entry: [] });
    const signature = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
    const runtime = createRuntime({
      environment: {
        DATABASE_URL: databaseUrl,
        META_APP_SECRET: appSecret,
        META_VERIFY_TOKEN: 'synthetic_verify_token_1234567890',
      },
      privacyKeyring: syntheticPrivacyKeyring,
    });
    apps.push(runtime.app);

    const response = await runtime.app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(200);

    const counts = await pool.query(
      `select
         (select count(*)::int from webhook_receipts) as receipts,
         (select count(*)::int from webhook_events) as events`,
    );
    expect(counts.rows).toEqual([{ receipts: 1, events: 1 }]);
  });

  test('fails closed when PostgreSQL is configured without an explicit privacy keyring', async () => {
    const appSecret = 'synthetic_app_secret_1234567890';
    const rawBody = JSON.stringify({ object: 'unknown', entry: [] });
    const signature = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
    const runtime = createRuntime({
      environment: {
        DATABASE_URL: databaseUrl,
        META_APP_SECRET: appSecret,
        META_VERIFY_TOKEN: 'synthetic_verify_token_1234567890',
      },
    });
    apps.push(runtime.app);

    const response = await runtime.app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(503);
    const counts = await pool.query(
      `select
         (select count(*)::int from webhook_receipts) as receipts,
         (select count(*)::int from webhook_events) as events`,
    );
    expect(counts.rows).toEqual([{ receipts: 0, events: 0 }]);
  });

  test('returns unavailable when PostgreSQL cannot accept the receipt', async () => {
    const appSecret = 'synthetic_app_secret_1234567890';
    const rawBody = JSON.stringify({ object: 'unknown', entry: [] });
    const signature = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
    const unavailableDatabaseUrl = new URL(databaseUrl);
    unavailableDatabaseUrl.pathname = '/fcd_support_test_missing';
    const runtime = createRuntime({
      environment: {
        DATABASE_URL: unavailableDatabaseUrl.toString(),
        META_APP_SECRET: appSecret,
        META_VERIFY_TOKEN: 'synthetic_verify_token_1234567890',
      },
      privacyKeyring: syntheticPrivacyKeyring,
    });
    apps.push(runtime.app);

    const response = await runtime.app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(503);

    const counts = await pool.query(
      `select
         (select count(*)::int from webhook_receipts) as receipts,
         (select count(*)::int from webhook_events) as events`,
    );
    expect(counts.rows).toEqual([{ receipts: 0, events: 0 }]);
  });

  test('deduplicates a delivery after the application runtime restarts', async () => {
    const appSecret = 'synthetic_app_secret_1234567890';
    const rawBody = JSON.stringify({ object: 'unknown', entry: [] });
    const signature = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
    const environment = {
      DATABASE_URL: databaseUrl,
      META_APP_SECRET: appSecret,
      META_VERIFY_TOKEN: 'synthetic_verify_token_1234567890',
    } as const;
    const delivery = {
      method: 'POST' as const,
      url: '/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
      },
      payload: rawBody,
    };

    const firstRuntime = createRuntime({ environment, privacyKeyring: syntheticPrivacyKeyring });
    apps.push(firstRuntime.app);
    expect((await firstRuntime.app.inject(delivery)).statusCode).toBe(200);
    await firstRuntime.app.close();

    const restartedRuntime = createRuntime({
      environment,
      privacyKeyring: syntheticPrivacyKeyring,
    });
    apps.push(restartedRuntime.app);
    expect((await restartedRuntime.app.inject(delivery)).statusCode).toBe(200);

    const counts = await pool.query(
      `select
         (select count(*)::int from webhook_receipts) as receipts,
         (select count(*)::int from webhook_events) as events`,
    );
    expect(counts.rows).toEqual([{ receipts: 1, events: 1 }]);
  });

  test('fails within the admission budget when a duplicate key is locked', async () => {
    const appSecret = 'synthetic_app_secret_1234567890';
    const rawBody = JSON.stringify({ object: 'unknown', entry: [] });
    const payloadSha256 = createHash('sha256').update(rawBody).digest('hex');
    const signature = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
    const blocker = await pool.connect();
    await blocker.query('begin');
    await blocker.query(
      `insert into webhook_receipts (payload_sha256, event_count)
       values ($1, 1)`,
      [payloadSha256],
    );

    const runtime = createRuntime({
      environment: {
        DATABASE_URL: databaseUrl,
        META_APP_SECRET: appSecret,
        META_VERIFY_TOKEN: 'synthetic_verify_token_1234567890',
      },
      privacyKeyring: syntheticPrivacyKeyring,
    });
    apps.push(runtime.app);
    let releasePromise: Promise<void> | undefined;
    const releaseBlocker = (): Promise<void> => {
      releasePromise ??= blocker
        .query('rollback')
        .then(() => undefined)
        .finally(() => {
          blocker.release();
        });
      return releasePromise;
    };
    const releaseTimer = setTimeout(() => {
      void releaseBlocker();
    }, 2_000);
    const startedAt = performance.now();

    const response = await runtime.app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
      },
      payload: rawBody,
    });
    const elapsedMilliseconds = performance.now() - startedAt;

    clearTimeout(releaseTimer);
    await releaseBlocker();

    expect(response.statusCode).toBe(503);
    expect(elapsedMilliseconds).toBeLessThan(1_800);
  });

  test('durably stores valid siblings beside malformed batch items', async () => {
    const appSecret = 'synthetic_app_secret_1234567890';
    const eventTimestamp = Date.now();
    const rawBody = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: 'PAGE_TEST_durable_siblings',
          time: eventTimestamp,
          messaging: [
            {
              sender: {},
              recipient: { id: 'PAGE_TEST_durable_siblings' },
              timestamp: eventTimestamp,
              message: { mid: 'm_TEST_malformed_durable', text: 'Synthetic malformed item' },
            },
            {
              sender: { id: 'PSID_TEST_durable_siblings' },
              recipient: { id: 'PAGE_TEST_durable_siblings' },
              timestamp: eventTimestamp,
              message: {
                mid: 'm_TEST_valid_durable_sibling',
                text: 'Synthetic valid sibling',
              },
            },
          ],
        },
      ],
    });
    const signature = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
    const runtime = createRuntime({
      environment: {
        DATABASE_URL: databaseUrl,
        META_APP_SECRET: appSecret,
        META_VERIFY_TOKEN: 'synthetic_verify_token_1234567890',
      },
      privacyKeyring: syntheticPrivacyKeyring,
    });
    apps.push(runtime.app);

    const response = await runtime.app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(200);
    const events = await pool.query(
      `select event_kind, admission_outcome
       from webhook_events
       order by id`,
    );
    expect(events.rows).toEqual([
      { event_kind: 'unsupported', admission_outcome: 'unsupported' },
      { event_kind: 'customer_message', admission_outcome: 'pending' },
    ]);
  });
});
