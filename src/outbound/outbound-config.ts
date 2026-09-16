import { inspect } from 'node:util';

import { z } from 'zod';

import { parseOutboundPolicyInput } from './outbound-policy-input.js';
import {
  OutboundCredential,
  type OutboundConfigSnapshot,
  type OutboundDeploymentBounds,
  type OutboundProviderConfig,
} from './outbound-types.js';

export const META_GRAPH_API_VERSION = 'v25.0' as const;

const requiredSettings = [
  'META_GRAPH_API_VERSION',
  'META_MESSENGER_PAGE_ID',
  'META_PAGE_ACCESS_TOKEN',
  'META_WHATSAPP_ACCESS_TOKEN',
  'META_WHATSAPP_PHONE_NUMBER_ID',
  'OUTBOUND_ALLOW_LOOPBACK_FAKE',
  'OUTBOUND_MAX_DEFINITE_RETRIES',
  'OUTBOUND_MAX_GLOBAL_1_MINUTE',
  'OUTBOUND_MAX_GLOBAL_UTC_DAY',
  'OUTBOUND_MAX_LEASE_MS',
  'OUTBOUND_MAX_MESSENGER_ACCOUNT_1_MINUTE',
  'OUTBOUND_MAX_PER_CONTACT_15_MINUTE',
  'OUTBOUND_MAX_PER_CONTACT_24_HOUR',
  'OUTBOUND_MAX_PROVIDER_TIMEOUT_MS',
  'OUTBOUND_MAX_RESPONSE_BYTES',
  'OUTBOUND_MAX_WHATSAPP_ACCOUNT_1_MINUTE',
  'OUTBOUND_MAX_WORKER_BATCH_SIZE',
  'OUTBOUND_META_BASE_URL',
  'OUTBOUND_MIN_RETRY_BASE_MS',
  'OUTBOUND_MIN_RETRY_MAXIMUM_MS',
] as const;

const integer = (minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum);
const accountReference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u);
const credential = z.string().regex(/^\S{16,4096}$/u);

const outboundConfigSchema = z
  .object({
    META_GRAPH_API_VERSION: z.literal(META_GRAPH_API_VERSION),
    META_MESSENGER_PAGE_ID: accountReference,
    META_PAGE_ACCESS_TOKEN: credential,
    META_WHATSAPP_ACCESS_TOKEN: credential,
    META_WHATSAPP_PHONE_NUMBER_ID: accountReference,
    OUTBOUND_ALLOW_LOOPBACK_FAKE: z.enum(['false', 'true']),
    OUTBOUND_MAX_DEFINITE_RETRIES: integer(0, 10),
    OUTBOUND_MAX_GLOBAL_1_MINUTE: integer(1, 1_000_000),
    OUTBOUND_MAX_GLOBAL_UTC_DAY: integer(1, 100_000_000),
    OUTBOUND_MAX_LEASE_MS: integer(1000, 600_000),
    OUTBOUND_MAX_MESSENGER_ACCOUNT_1_MINUTE: integer(1, 100_000),
    OUTBOUND_MAX_PER_CONTACT_15_MINUTE: integer(1, 1000),
    OUTBOUND_MAX_PER_CONTACT_24_HOUR: integer(1, 10_000),
    OUTBOUND_MAX_PROVIDER_TIMEOUT_MS: integer(100, 300_000),
    OUTBOUND_MAX_RESPONSE_BYTES: integer(1024, 1_048_576),
    OUTBOUND_MAX_WHATSAPP_ACCOUNT_1_MINUTE: integer(1, 100_000),
    OUTBOUND_MAX_WORKER_BATCH_SIZE: integer(1, 1000),
    OUTBOUND_META_BASE_URL: z.string().min(1).max(2048),
    OUTBOUND_MIN_RETRY_BASE_MS: integer(100, 86_400_000),
    OUTBOUND_MIN_RETRY_MAXIMUM_MS: integer(100, 604_800_000),
  })
  .strict();

function settingInput(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<(typeof requiredSettings)[number], string | undefined>> {
  return Object.fromEntries(requiredSettings.map((name) => [name, environment[name]])) as Readonly<
    Record<(typeof requiredSettings)[number], string | undefined>
  >;
}

function isLoopbackHostname(hostnameValue: string): boolean {
  const hostname = hostnameValue.toLowerCase();
  if (hostname === '[::1]' || hostname === '::1') return true;
  const parts = hostname.split('.').map(Number);
  return (
    parts.length === 4 &&
    parts[0] === 127 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  );
}

function validatedBaseUrl(value: string, allowLoopbackFake: boolean): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return undefined;
    }
    if (allowLoopbackFake) {
      return url.protocol === 'http:' && isLoopbackHostname(url.hostname) ? url.origin : undefined;
    }
    return url.protocol === 'https:' && url.hostname === 'graph.facebook.com' && url.port === ''
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function invalidConfiguration(names: readonly string[]): Error {
  return new Error(`Invalid outbound configuration: ${names.join(', ')}`);
}

function deploymentBounds(value: z.infer<typeof outboundConfigSchema>): OutboundDeploymentBounds {
  try {
    return parseOutboundPolicyInput({
      global1Minute: value.OUTBOUND_MAX_GLOBAL_1_MINUTE,
      globalUtcDay: value.OUTBOUND_MAX_GLOBAL_UTC_DAY,
      leaseMs: value.OUTBOUND_MAX_LEASE_MS,
      maximumDefiniteRetries: value.OUTBOUND_MAX_DEFINITE_RETRIES,
      messengerAccount1Minute: value.OUTBOUND_MAX_MESSENGER_ACCOUNT_1_MINUTE,
      perContact15Minute: value.OUTBOUND_MAX_PER_CONTACT_15_MINUTE,
      perContact24Hour: value.OUTBOUND_MAX_PER_CONTACT_24_HOUR,
      providerTimeoutMs: value.OUTBOUND_MAX_PROVIDER_TIMEOUT_MS,
      retryBaseMs: value.OUTBOUND_MIN_RETRY_BASE_MS,
      retryMaximumMs: value.OUTBOUND_MIN_RETRY_MAXIMUM_MS,
      whatsappAccount1Minute: value.OUTBOUND_MAX_WHATSAPP_ACCOUNT_1_MINUTE,
      workerBatchSize: value.OUTBOUND_MAX_WORKER_BATCH_SIZE,
    });
  } catch {
    throw invalidConfiguration(
      requiredSettings.filter(
        (name) => name.startsWith('OUTBOUND_MAX_') || name.startsWith('OUTBOUND_MIN_'),
      ),
    );
  }
}

export function createOutboundConfigSnapshot(
  config: OutboundProviderConfig,
): OutboundConfigSnapshot {
  return Object.freeze({
    allowLoopbackFake: config.allowLoopbackFake,
    deploymentBounds: Object.freeze({ ...config.deploymentBounds }),
    maximumResponseBytes: config.maximumResponseBytes,
    messengerConfigured: true,
    whatsappConfigured: true,
  });
}

export function loadOutboundConfig(
  environment: Readonly<Record<string, string | undefined>>,
): OutboundProviderConfig {
  const parsed = outboundConfigSchema.safeParse(settingInput(environment));
  if (!parsed.success) {
    const invalid = new Set(
      parsed.error.issues
        .map((issue) => issue.path[0])
        .filter((value): value is string => typeof value === 'string'),
    );
    throw invalidConfiguration(requiredSettings.filter((name) => invalid.has(name)));
  }
  const value = parsed.data;
  const allowLoopbackFake = value.OUTBOUND_ALLOW_LOOPBACK_FAKE === 'true';
  const baseUrl = validatedBaseUrl(value.OUTBOUND_META_BASE_URL, allowLoopbackFake);
  if (baseUrl === undefined) {
    throw invalidConfiguration(['OUTBOUND_META_BASE_URL']);
  }

  const bounds = deploymentBounds(value);
  const messenger = Object.freeze({
    accountId: value.META_MESSENGER_PAGE_ID,
    credential: new OutboundCredential(value.META_PAGE_ACCESS_TOKEN),
  });
  const whatsapp = Object.freeze({
    accountId: value.META_WHATSAPP_PHONE_NUMBER_ID,
    credential: new OutboundCredential(value.META_WHATSAPP_ACCESS_TOKEN),
  });
  const snapshot = (): OutboundConfigSnapshot =>
    Object.freeze({
      allowLoopbackFake,
      deploymentBounds: Object.freeze({ ...bounds }),
      maximumResponseBytes: value.OUTBOUND_MAX_RESPONSE_BYTES,
      messengerConfigured: true,
      whatsappConfigured: true,
    });
  const config: OutboundProviderConfig = Object.freeze({
    [inspect.custom]: snapshot,
    allowLoopbackFake,
    baseUrl,
    deploymentBounds: bounds,
    graphApiVersion: META_GRAPH_API_VERSION,
    maximumResponseBytes: value.OUTBOUND_MAX_RESPONSE_BYTES,
    messenger,
    redirectPolicy: 'error',
    toJSON: snapshot,
    whatsapp,
  });
  return config;
}
