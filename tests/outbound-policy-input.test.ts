import { describe, expect, test } from 'vitest';

import {
  parseOutboundPolicyInput,
  resolveOutboundBounds,
} from '../src/outbound/outbound-policy-input.js';
import {
  OUTBOUND_ATTEMPT_STATES,
  OUTBOUND_CHANNELS,
  OUTBOUND_INTENT_STATES,
  OUTBOUND_LANGUAGES,
  OUTBOUND_MESSAGE_KINDS,
  OUTBOUND_PROVIDER_RESULT_STATUSES,
  OUTBOUND_PURPOSES,
  type OutboundDeploymentBounds,
  type OutboundPolicyValues,
  type OutboundProviderResult,
} from '../src/outbound/outbound-types.js';

const validPolicy = Object.freeze({
  global1Minute: 150,
  globalUtcDay: 1000,
  leaseMs: 30_000,
  maximumDefiniteRetries: 3,
  messengerAccount1Minute: 100,
  perContact15Minute: 4,
  perContact24Hour: 40,
  providerTimeoutMs: 10_000,
  retryBaseMs: 1000,
  retryMaximumMs: 60_000,
  whatsappAccount1Minute: 100,
  workerBatchSize: 20,
}) satisfies OutboundPolicyValues;

describe('closed outbound contracts', () => {
  test('exports the complete closed channel, language, purpose, state, and result values', () => {
    expect(OUTBOUND_CHANNELS).toEqual(['messenger', 'whatsapp']);
    expect(OUTBOUND_LANGUAGES).toEqual(['bn', 'en']);
    expect(OUTBOUND_PURPOSES).toEqual([
      'customer_support',
      'marketing_education',
      'marketing_events',
      'marketing_news',
      'marketing_offers',
    ]);
    expect(OUTBOUND_MESSAGE_KINDS).toEqual(['fixed_template', 'support_text']);
    expect(OUTBOUND_INTENT_STATES).toEqual([
      'pending',
      'leased',
      'provider_accepted',
      'sent',
      'delivered',
      'read',
      'delivery_unknown',
      'terminal_failed',
      'canceled',
    ]);
    expect(OUTBOUND_ATTEMPT_STATES).toEqual([
      'authorized',
      'dispatch_started',
      'provider_accepted',
      'definitely_rejected',
      'delivery_unknown',
      'abandoned_before_dispatch',
    ]);
    expect(OUTBOUND_PROVIDER_RESULT_STATUSES).toEqual([
      'accepted',
      'definitely_rejected',
      'delivery_unknown',
      'aborted_before_dispatch',
    ]);

    const results: readonly OutboundProviderResult[] = [
      { providerMessageId: 'wamid.TEST.contract', status: 'accepted' },
      {
        reasonCode: 'rate_limited',
        retryAfter: new Date('2026-09-15T00:00:00.000Z'),
        status: 'definitely_rejected',
      },
      { reasonCode: 'redirect', status: 'delivery_unknown' },
      { status: 'aborted_before_dispatch' },
    ];
    expect(results.map(({ status }) => status)).toEqual(OUTBOUND_PROVIDER_RESULT_STATUSES);
  });
});

describe('outbound policy input', () => {
  test('parses and freezes every explicit customizable policy value', () => {
    const parsed = parseOutboundPolicyInput(validPolicy);

    expect(parsed).toEqual(validPolicy);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  test('rejects unknown keys and non-integer numeric material', () => {
    expect(() => parseOutboundPolicyInput({ ...validPolicy, unreviewedLimit: 1 })).toThrow(
      'Invalid outbound policy',
    );
    expect(() => parseOutboundPolicyInput({ ...validPolicy, workerBatchSize: 1.5 })).toThrow(
      'Invalid outbound policy',
    );
    expect(() =>
      parseOutboundPolicyInput({
        ...validPolicy,
        globalUtcDay: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow('Invalid outbound policy');
  });

  test.each([
    ['perContact15Minute', 0],
    ['perContact24Hour', 10_001],
    ['whatsappAccount1Minute', 100_001],
    ['messengerAccount1Minute', 100_001],
    ['global1Minute', 1_000_001],
    ['globalUtcDay', 100_000_001],
    ['workerBatchSize', 1001],
    ['leaseMs', 600_001],
    ['providerTimeoutMs', 300_001],
    ['maximumDefiniteRetries', 11],
    ['retryBaseMs', 86_400_001],
    ['retryMaximumMs', 604_800_001],
  ] as const)('rejects unsafe %s value', (name, value) => {
    expect(() => parseOutboundPolicyInput({ ...validPolicy, [name]: value })).toThrow(
      'Invalid outbound policy',
    );
  });

  test('rejects inconsistent rolling windows, retry delays, and lease safety', () => {
    for (const changed of [
      { perContact15Minute: 41 },
      { global1Minute: 1001 },
      { retryBaseMs: 60_001 },
      { leaseMs: 11_000, providerTimeoutMs: 10_000 },
    ]) {
      expect(() => parseOutboundPolicyInput({ ...validPolicy, ...changed })).toThrow(
        'Invalid outbound policy',
      );
    }
  });

  test('intersects two customizable sources using stricter ceilings and delay floors', () => {
    const deployment = {
      global1Minute: 120,
      globalUtcDay: 900,
      leaseMs: 25_000,
      maximumDefiniteRetries: 2,
      messengerAccount1Minute: 80,
      perContact15Minute: 3,
      perContact24Hour: 30,
      providerTimeoutMs: 8000,
      retryBaseMs: 5000,
      retryMaximumMs: 30_000,
      whatsappAccount1Minute: 90,
      workerBatchSize: 10,
    } satisfies OutboundDeploymentBounds;

    expect(resolveOutboundBounds(validPolicy, deployment)).toEqual({
      global1Minute: 120,
      globalUtcDay: 900,
      leaseMs: 25_000,
      maximumDefiniteRetries: 2,
      messengerAccount1Minute: 80,
      perContact15Minute: 3,
      perContact24Hour: 30,
      providerTimeoutMs: 8000,
      retryBaseMs: 5000,
      retryMaximumMs: 60_000,
      whatsappAccount1Minute: 90,
      workerBatchSize: 10,
    });
  });

  test('raises the effective retry maximum when a stricter base floor requires it', () => {
    const deployment: OutboundDeploymentBounds = {
      ...validPolicy,
      retryBaseMs: 120_000,
      retryMaximumMs: 120_000,
    };

    expect(resolveOutboundBounds(validPolicy, deployment)).toMatchObject({
      retryBaseMs: 120_000,
      retryMaximumMs: 120_000,
    });
  });
});
