export function operationsEnvironment() {
  return {
    NODE_ENV: 'test',
    MODEL_EXECUTION_ENABLED: 'false',
    OUTBOUND_EXECUTION_ENABLED: 'false',
    N8N_EXECUTION_ENABLED: 'false',
    OPS_POLL_MS: '1000',
    OPS_BATCH_SIZE: '10',
    OPS_LEASE_MS: '60000',
    OPS_MAX_CALL_MS: '20000',
    OPS_SHUTDOWN_GRACE_MS: '5000',
    OPS_STOP_GRACE_MS: '30000',
    OPS_HEALTH_STALE_MS: '60000',
    OPS_HOST_CPUS: '4',
    OPS_HOST_MEMORY_MIB: '8192',
    OPS_RESOURCE_LIMITS_JSON: JSON.stringify({
      webhook: { cpus: 0.5, memoryMiB: 256, pids: 64, tmpfsMiB: 16 },
      backup: { cpus: 1, memoryMiB: 512, pids: 64, tmpfsMiB: 32 },
      reply: { cpus: 0.5, memoryMiB: 256, pids: 64, tmpfsMiB: 16 },
    }),
    OPS_RESOURCE_BOUNDS_JSON: JSON.stringify({
      minimum: { cpus: 0.05, memoryMiB: 32, pids: 16, tmpfsMiB: 1 },
      maximum: { cpus: 2, memoryMiB: 2048, pids: 512, tmpfsMiB: 128 },
    }),
    BACKUP_DAILY_RETENTION: '45',
    BACKUP_MONTHLY_RETENTION: '6',
    BACKUP_CALENDAR: '*-*-* 02:00:00 UTC',
    MAINTENANCE_CALENDAR: '*-*-* *:00/5:00 UTC',
  } as const;
}

export const syntheticWebhookFiles = {
  DATABASE_URL_FILE: '/run/secrets/synthetic_database_url',
  META_APP_SECRET_FILE: '/run/secrets/synthetic_app_secret',
  META_VERIFY_TOKEN_FILE: '/run/secrets/synthetic_verify_token',
  PRIVACY_HMAC_KEYRING_FILE: '/run/secrets/synthetic_privacy_keyring',
} as const;

export const syntheticWebhookSecretText: Readonly<Record<string, string>> = {
  '/run/secrets/synthetic_database_url': 'postgresql://synthetic_user@127.0.0.1/fcd_support_test',
  '/run/secrets/synthetic_app_secret': 'synthetic_app_secret_for_operations',
  '/run/secrets/synthetic_verify_token': 'synthetic_verify_token_for_operations',
  '/run/secrets/synthetic_privacy_keyring': JSON.stringify({
    activeVersion: 'synthetic-v1',
    keys: [{ version: 'synthetic-v1', keyBase64url: Buffer.alloc(32, 3).toString('base64url') }],
  }),
};

export function readSyntheticWebhookSecret(path: string): Promise<Uint8Array> {
  const value = syntheticWebhookSecretText[path];
  if (value === undefined) throw new Error('synthetic_unexpected_secret');
  return Promise.resolve(new TextEncoder().encode(value));
}
