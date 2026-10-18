import type { OutboundDeploymentBounds } from '../../src/outbound/outbound-types.js';
import { operationsEnvironment } from './operations-fixtures.js';

export function syntheticOutboundRuntimeEnvironment(
  databaseUrl: string,
  bounds: OutboundDeploymentBounds,
) {
  const resources = JSON.parse(operationsEnvironment().OPS_RESOURCE_LIMITS_JSON) as Record<
    string,
    unknown
  >;
  return {
    ...operationsEnvironment(),
    OPS_RESOURCE_LIMITS_JSON: JSON.stringify({ ...resources, outbound: resources.reply }),
    OUTBOUND_EXECUTION_ENABLED: 'true',
    DATABASE_URL: databaseUrl,
    PRIVACY_HMAC_KEYRING: JSON.stringify({
      activeVersion: 'TEST_v1',
      keys: [{ version: 'TEST_v1', keyBase64url: Buffer.alloc(32, 0x51).toString('base64url') }],
    }),
    OPS_GIT_REVISION: 'c'.repeat(40),
    OPS_SCHEMA_REVISION: '000015',
    META_GRAPH_API_VERSION: 'v25.0',
    META_MESSENGER_PAGE_ID: 'PAGE_TEST_outbound_flow',
    META_WHATSAPP_PHONE_NUMBER_ID: 'PHONE_TEST_outbound_flow',
    META_PAGE_ACCESS_TOKEN: 'SYNTHETIC_PAGE_TOKEN_NOT_OPERATIONAL',
    META_WHATSAPP_ACCESS_TOKEN: 'SYNTHETIC_WHATSAPP_TOKEN_NOT_OPERATIONAL',
    OUTBOUND_META_BASE_URL: 'http://127.0.0.1:1',
    OUTBOUND_ALLOW_LOOPBACK_FAKE: 'true',
    OUTBOUND_MAX_RESPONSE_BYTES: '8192',
    OUTBOUND_MAX_DEFINITE_RETRIES: String(bounds.maximumDefiniteRetries),
    OUTBOUND_MAX_GLOBAL_1_MINUTE: String(bounds.global1Minute),
    OUTBOUND_MAX_GLOBAL_UTC_DAY: String(bounds.globalUtcDay),
    OUTBOUND_MAX_LEASE_MS: String(bounds.leaseMs),
    OUTBOUND_MAX_PROVIDER_TIMEOUT_MS: String(bounds.providerTimeoutMs),
    OUTBOUND_MAX_MESSENGER_ACCOUNT_1_MINUTE: String(bounds.messengerAccount1Minute),
    OUTBOUND_MAX_WHATSAPP_ACCOUNT_1_MINUTE: String(bounds.whatsappAccount1Minute),
    OUTBOUND_MAX_PER_CONTACT_15_MINUTE: String(bounds.perContact15Minute),
    OUTBOUND_MAX_PER_CONTACT_24_HOUR: String(bounds.perContact24Hour),
    OUTBOUND_MAX_WORKER_BATCH_SIZE: String(bounds.workerBatchSize),
    OUTBOUND_MIN_RETRY_BASE_MS: String(bounds.retryBaseMs),
    OUTBOUND_MIN_RETRY_MAXIMUM_MS: String(bounds.retryMaximumMs),
  };
}
