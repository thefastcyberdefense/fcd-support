import { inspect } from 'node:util';

import { describe, expect, test } from 'vitest';

import {
  createOutboundConfigSnapshot,
  loadOutboundConfig,
  META_GRAPH_API_VERSION,
} from '../src/outbound/outbound-config.js';

const validEnvironment = Object.freeze({
  META_GRAPH_API_VERSION: 'v25.0',
  META_MESSENGER_PAGE_ID: 'PAGE_TEST_outbound_config',
  META_PAGE_ACCESS_TOKEN: 'SYNTHETIC_PAGE_TOKEN_NOT_OPERATIONAL',
  META_WHATSAPP_ACCESS_TOKEN: 'SYNTHETIC_WHATSAPP_TOKEN_NOT_OPERATIONAL',
  META_WHATSAPP_PHONE_NUMBER_ID: 'PHONE_TEST_outbound_config',
  OUTBOUND_ALLOW_LOOPBACK_FAKE: 'false',
  OUTBOUND_MAX_DEFINITE_RETRIES: '3',
  OUTBOUND_MAX_GLOBAL_1_MINUTE: '150',
  OUTBOUND_MAX_GLOBAL_UTC_DAY: '1000',
  OUTBOUND_MAX_LEASE_MS: '30000',
  OUTBOUND_MAX_MESSENGER_ACCOUNT_1_MINUTE: '100',
  OUTBOUND_MAX_PER_CONTACT_15_MINUTE: '4',
  OUTBOUND_MAX_PER_CONTACT_24_HOUR: '40',
  OUTBOUND_MAX_PROVIDER_TIMEOUT_MS: '10000',
  OUTBOUND_MAX_RESPONSE_BYTES: '65536',
  OUTBOUND_MAX_WHATSAPP_ACCOUNT_1_MINUTE: '100',
  OUTBOUND_MAX_WORKER_BATCH_SIZE: '20',
  OUTBOUND_META_BASE_URL: 'https://graph.facebook.com',
  OUTBOUND_MIN_RETRY_BASE_MS: '1000',
  OUTBOUND_MIN_RETRY_MAXIMUM_MS: '60000',
});

const requiredSettings = Object.keys(validEnvironment);

describe('fail-closed outbound configuration', () => {
  test('loads exact Graph v25.0 production configuration with explicit protected bounds', () => {
    const config = loadOutboundConfig(validEnvironment);

    expect(META_GRAPH_API_VERSION).toBe('v25.0');
    expect(config).toMatchObject({
      allowLoopbackFake: false,
      baseUrl: 'https://graph.facebook.com',
      deploymentBounds: {
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
      },
      graphApiVersion: 'v25.0',
      maximumResponseBytes: 65_536,
      messenger: { accountId: 'PAGE_TEST_outbound_config' },
      redirectPolicy: 'error',
      whatsapp: { accountId: 'PHONE_TEST_outbound_config' },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.deploymentBounds)).toBe(true);
  });

  test.each(['v24.0', 'v26.0', '25.0', ' v25.0 '])(
    'rejects changed or malformed Graph API version %s',
    (version) => {
      expect(() =>
        loadOutboundConfig({ ...validEnvironment, META_GRAPH_API_VERSION: version }),
      ).toThrow('META_GRAPH_API_VERSION');
    },
  );

  test.each(requiredSettings)('requires explicit setting %s and supplies no default', (name) => {
    const missing = Object.fromEntries(
      Object.entries(validEnvironment).filter(([setting]) => setting !== name),
    );
    expect(() => loadOutboundConfig(missing)).toThrow(name);
  });

  test('rejects an entirely empty environment with setting names but no values', () => {
    const message = (() => {
      try {
        loadOutboundConfig({});
      } catch (error: unknown) {
        return String(error);
      }
      throw new Error('Expected empty outbound configuration to fail');
    })();
    expect(message).toContain('META_GRAPH_API_VERSION');
    expect(message).toContain('OUTBOUND_META_BASE_URL');
    expect(message).not.toContain('undefined');
  });

  test.each([
    'http://graph.facebook.com',
    'https://example.invalid',
    'https://169.254.169.254',
    'https://synthetic:credential@graph.facebook.com',
    'https://graph.facebook.com/v25.0',
    'https://graph.facebook.com?mode=synthetic',
    'https://graph.facebook.com#synthetic',
    'https://graph.facebook.com:444',
    'http://127.0.0.1:4100',
  ])('rejects unsafe production base URL %s', (baseUrl) => {
    expect(() =>
      loadOutboundConfig({ ...validEnvironment, OUTBOUND_META_BASE_URL: baseUrl }),
    ).toThrow('OUTBOUND_META_BASE_URL');
  });

  test('allows only an explicitly enabled loopback HTTP fake', () => {
    const fake = loadOutboundConfig({
      ...validEnvironment,
      OUTBOUND_ALLOW_LOOPBACK_FAKE: 'true',
      OUTBOUND_META_BASE_URL: 'http://127.0.0.1:4100',
    });
    expect(fake).toMatchObject({
      allowLoopbackFake: true,
      baseUrl: 'http://127.0.0.1:4100',
      redirectPolicy: 'error',
    });

    for (const baseUrl of [
      'https://graph.facebook.com',
      'https://127.0.0.1:4100',
      'http://localhost:4100',
      'http://0.0.0.0:4100',
      'http://192.168.10.40:4100',
      'http://[::]:4100',
    ]) {
      expect(() =>
        loadOutboundConfig({
          ...validEnvironment,
          OUTBOUND_ALLOW_LOOPBACK_FAKE: 'true',
          OUTBOUND_META_BASE_URL: baseUrl,
        }),
      ).toThrow('OUTBOUND_META_BASE_URL');
    }
  });

  test('wraps credentials so stringification, JSON, inspection, and snapshots are redacted', () => {
    const config = loadOutboundConfig(validEnvironment);
    const serialized = [
      String(config.whatsapp.credential),
      String(config.messenger.credential),
      JSON.stringify(config),
      inspect(config),
      JSON.stringify(createOutboundConfigSnapshot(config)),
    ].join(' ');

    expect(config.whatsapp.credential.reveal()).toHaveLength(
      validEnvironment.META_WHATSAPP_ACCESS_TOKEN.length,
    );
    expect(config.messenger.credential.reveal()).toHaveLength(
      validEnvironment.META_PAGE_ACCESS_TOKEN.length,
    );
    expect(serialized).not.toContain(validEnvironment.META_WHATSAPP_ACCESS_TOKEN);
    expect(serialized).not.toContain(validEnvironment.META_PAGE_ACCESS_TOKEN);
    expect(serialized).not.toContain(validEnvironment.META_WHATSAPP_PHONE_NUMBER_ID);
    expect(serialized).not.toContain(validEnvironment.META_MESSENGER_PAGE_ID);
    expect(serialized).not.toContain('graph.facebook.com');
  });

  test('creates a safe snapshot containing only booleans and numeric limits', () => {
    expect(createOutboundConfigSnapshot(loadOutboundConfig(validEnvironment))).toEqual({
      allowLoopbackFake: false,
      deploymentBounds: {
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
      },
      maximumResponseBytes: 65_536,
      messengerConfigured: true,
      whatsappConfigured: true,
    });
  });

  test('reports setting names without leaking rejected values or credentials', () => {
    const rejectedValue = 'SYNTHETIC_REJECTED_CONFIGURATION_VALUE_NOT_OPERATIONAL';
    let error: unknown;
    try {
      loadOutboundConfig({
        ...validEnvironment,
        META_WHATSAPP_ACCESS_TOKEN: rejectedValue,
        OUTBOUND_MAX_PROVIDER_TIMEOUT_MS: rejectedValue,
      });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain('OUTBOUND_MAX_PROVIDER_TIMEOUT_MS');
    expect(String(error)).not.toContain(rejectedValue);
  });
});
