import { expect, test } from 'vitest';
import type pg from 'pg';

import { PostgresModelGateway } from '../src/persistence/postgres-model-gateway.js';
import { PostgresModelPolicy } from '../src/persistence/postgres-model-policy.js';
import { PostgresOutboundPolicy } from '../src/persistence/postgres-outbound-policy.js';
import { PostgresOutboundTemplate } from '../src/persistence/postgres-outbound-template.js';

function leastPrivilegePool() {
  const executedSql: string[] = [];
  const client = {
    query: (sql: string) => {
      executedSql.push(sql);
      if (/\badmin_accounts\b/iu.test(sql)) {
        return Promise.reject(
          Object.assign(new Error('permission denied for table admin_accounts'), {
            code: '42501',
          }),
        );
      }
      return Promise.resolve({ rows: [] });
    },
    release: () => undefined,
  };
  const pool = {
    connect: () => Promise.resolve(client),
  } as unknown as pg.Pool;
  return { pool, executedSql };
}

test('worker-side policy, gateway, and template resolvers never query admin_accounts', async () => {
  const { pool, executedSql } = leastPrivilegePool();
  const at = new Date('2030-03-01T00:00:00.000Z');

  const outboundPolicy = await new PostgresOutboundPolicy(pool).resolveEffectivePolicy(at, {
    global1Minute: 10,
    globalUtcDay: 100,
    leaseMs: 30_000,
    maximumDefiniteRetries: 1,
    messengerAccount1Minute: 10,
    perContact15Minute: 2,
    perContact24Hour: 5,
    providerTimeoutMs: 1_000,
    retryBaseMs: 100,
    retryMaximumMs: 1_000,
    whatsappAccount1Minute: 10,
    workerBatchSize: 5,
  });
  expect(outboundPolicy.status).toBe('disabled');

  const modelPolicy = await new PostgresModelPolicy(pool).resolveEffectivePolicy(
    at,
    {
      architectureProviderConnections: 1,
      concurrentCalls: 2,
      contextItems: 6,
      cooldownMs: 0,
      globalUtcDayCalls: 50,
      inputCodePoints: 4000,
      outputTokens: 512,
      perContact15MinuteCalls: 5,
      perContact24HourCalls: 20,
      providerAttempts: 1,
      queueCapacity: 4,
      responseBytes: 65536,
      totalTimeoutMs: 15000,
    },
    {
      verified: true,
      operationalLimits: {
        concurrentCalls: 2,
        cooldownMs: 0,
        globalUtcDayCalls: 50,
        outputTokens: 512,
        perContact15MinuteCalls: 5,
        perContact24HourCalls: 20,
        providerAttempts: 1,
        queueCapacity: 4,
        totalTimeoutMs: 15000,
      },
    },
  );
  expect(modelPolicy.status).toBe('disabled');

  const gateway = await new PostgresModelGateway(pool).resolveRuntimeGateway();
  expect(gateway.gatewayKind).toBe('manifest_default');

  const template = await new PostgresOutboundTemplate(pool).resolveEffectiveTemplate({
    category: 'marketing_education',
    channel: 'whatsapp',
    channelAccountId: 'SYNTHETIC_WA_PHONE_01',
    evaluatedAt: at,
    locale: 'en_US',
    templateRef: 'TEMPLATE_SYNTHETIC_01',
  });
  expect(template.status).toBe('disabled');

  expect(executedSql.some((sql) => /\badmin_accounts\b/iu.test(sql))).toBe(false);
});
