// Synthetic network-only fixture. Never loads a real environment or credential.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [directory, project, revision] = process.argv.slice(2);
if (
  directory === undefined ||
  project === undefined ||
  revision === undefined ||
  !/^fcd-support-phase6-test-[a-z0-9-]+$/u.test(project) ||
  !/^[a-f0-9]{40}$/u.test(revision)
)
  throw new Error('synthetic_fixture_invalid');
const root = resolve(directory);
if (
  !root
    .replaceAll('\\', '/')
    .includes('/.superpowers/sdd/2026-10-04-phase-6-hardened-local-operations/')
)
  throw new Error('synthetic_fixture_invalid');
mkdirSync(root, { recursive: true, mode: 0o700 });
const config = join(root, 'config').replaceAll('\\', '/');
const secrets = join(root, 'secrets').replaceAll('\\', '/');
mkdirSync(config, { mode: 0o700 });
const roles = [
  'webhook',
  'admin',
  'reply',
  'outbound',
  'notification',
  'migrate',
  'backup',
  'verify-backup',
  'checkpoint',
  'health',
  'maintenance',
  'restore',
  'model',
];
const policyRoles = [
  'webhook',
  'admin',
  'reply',
  'outbound',
  'notification',
  'migrate',
  'backup',
  'verify_backup',
  'checkpoint',
  'health',
  'maintenance',
  'restore',
];
const common: Record<string, string> = {
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
  OPS_RESOURCE_LIMITS_JSON: JSON.stringify(
    Object.fromEntries(
      policyRoles.map((role) => [role, { cpus: 0.5, memoryMiB: 256, pids: 64, tmpfsMiB: 16 }]),
    ),
  ),
  OPS_RESOURCE_BOUNDS_JSON: JSON.stringify({
    minimum: { cpus: 0.05, memoryMiB: 32, pids: 16, tmpfsMiB: 1 },
    maximum: { cpus: 2, memoryMiB: 2048, pids: 512, tmpfsMiB: 128 },
  }),
  BACKUP_DAILY_RETENTION: '45',
  BACKUP_MONTHLY_RETENTION: '6',
  BACKUP_CALENDAR: '*-*-* 02:00:00 UTC',
  MAINTENANCE_CALENDAR: '*-*-* *:00/5:00 UTC',
};
writeFileSync(
  join(config, 'common.env'),
  Object.entries(common)
    .map(([key, value]) => `${key}=${value}\n`)
    .join(''),
  { mode: 0o600 },
);
for (const role of roles)
  writeFileSync(join(config, `${role}.env`), '# Synthetic network-only configuration\n', {
    mode: 0o600,
  });
const paths = [
  'postgres/postgres-password',
  'webhook/webhook-database',
  'webhook/meta-app-secret',
  'webhook/meta-verify-token',
  'webhook/webhook-keyring',
  'admin/admin-database',
  'admin/admin-session',
  'admin/admin-mfa',
  'reply/reply-database',
  'reply/reply-keyring',
  'reply/manifest-key',
  'outbound/outbound-database',
  'outbound/outbound-keyring',
  'outbound/meta-page-token',
  'outbound/meta-whatsapp-token',
  'outbound/meta-page-id',
  'outbound/meta-phone-id',
  'notification/notification-database',
  'notification/n8n-secret',
  'migrate/migrate-database',
  'backup/backup-database',
  'backup/backup-recipient',
  'backup/recovery-hmac',
  'verify-backup/verify-database',
  'verify-backup/restore-identity',
  'checkpoint/checkpoint-database',
  'health/health-database',
  'maintenance/maintenance-database',
  'maintenance/maintenance-keyring',
  'restore/restore-postgres-password',
  'restore/restore-database',
  'restore/restore-keyring',
];
for (const path of paths) {
  const target = join(secrets, path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, 'synthetic_network_fixture_only\n', { mode: 0o600 });
}
const values: Record<string, string> = {
  FCD_RUNTIME_PROJECT: project,
  FCD_RESTORE_PROJECT: `${project}-restore`,
  FCD_RESTORE_VOLUME: `fcd-support-restore-${project}`,
  FCD_SUPPORT_REVISION: revision,
  FCD_SUPPORT_IMAGE: `fcd-support-api:${revision}`,
  FCD_POSTGRES_IMAGE: `fcd-support-postgres:${revision}`,
  FCD_OPERATIONS_IMAGE: `fcd-support-operations:${revision}`,
  FCD_CONFIG_ROOT: config,
  FCD_SECRET_ROOT: secrets,
  FCD_POSTGRES_DB: 'fcd_support_test',
  FCD_POSTGRES_VOLUME: `${project}-postgres-data`,
  FCD_BACKUP_VOLUME: `${project}-backups`,
  FCD_INGRESS_NETWORK: `${project}-ingress`,
  FCD_MODEL_NETWORK: `${project}-model`,
  FCD_NOTIFICATION_NETWORK: `${project}-notification`,
  FCD_ADMIN_ORIGIN: 'http://127.0.0.1:3004',
  FCD_ADMIN_SOCKET_ROOT: `/run/${project}-admin-socket`,
  FCD_SOCKET_TEST_IMAGE: `${project}-application:${revision}`,
  FCD_ADMIN_BROWSER_PORT: '3004',
  FCD_STOP_GRACE_MS: '30000',
  FCD_TMPFS_MIB: '16',
  FCD_HEALTH_INTERVAL_MS: '1000',
  FCD_HEALTH_TIMEOUT_MS: '1000',
  FCD_HEALTH_RETRIES: '20',
  FCD_HEALTH_START_MS: '1000',
  MODEL_EXECUTION_ENABLED: 'false',
  OUTBOUND_EXECUTION_ENABLED: 'false',
  N8N_EXECUTION_ENABLED: 'false',
};
for (const role of [...roles.filter((r) => r !== 'model'), 'postgres']) {
  const prefix = `FCD_${role.toUpperCase().replaceAll('-', '_')}`;
  values[`${prefix}_CPUS`] = '0.5';
  values[`${prefix}_MEMORY_MIB`] = '256';
  values[`${prefix}_PIDS`] = '64';
  values[`${prefix}_TMPFS_MIB`] = '16';
}
writeFileSync(
  join(root, 'fixture.env'),
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join(''),
  { mode: 0o600 },
);
