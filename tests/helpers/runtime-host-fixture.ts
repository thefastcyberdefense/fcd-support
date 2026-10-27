// Authored, fresh-cluster fixtures only. Never reads an existing environment.
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const roles = [
  'webhook',
  'admin',
  'reply',
  'outbound',
  'notification',
  'maintenance',
  'health',
  'backup',
  'verify_backup',
  'checkpoint',
  'archive_reader',
  'migrator',
] as const;
const resourceRoles = [
  'webhook',
  'admin',
  'reply',
  'outbound',
  'notification',
  'maintenance',
  'health',
  'backup',
  'verify_backup',
  'checkpoint',
  'migrate',
  'restore',
] as const;
const secret = () => `synthetic_${randomBytes(24).toString('hex')}`;
function serialize(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
}

export async function writeRuntimeHostFixture(
  root: string,
  project: string,
  revision: string,
): Promise<void> {
  try {
    if (
      !isAbsolute(root) ||
      resolve(root) !== root ||
      basename(root) !== project ||
      !/^fcd-support-host-test-[a-z0-9-]{1,32}$/u.test(project) ||
      !/^[a-f0-9]{40}$/u.test(revision)
    )
      throw new Error('invalid');
    const parent = dirname(root);
    if ((await realpath(parent)) !== parent || !(await lstat(parent)).isDirectory())
      throw new Error('invalid');
    await mkdir(root, { mode: 0o700 });
    const put = async (path: string, value: string) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, value, { mode: 0o600, flag: 'wx' });
    };
    for (const directory of ['config', 'secrets', 'state', 'socket', 'logs'])
      await mkdir(join(root, directory), { mode: 0o700 });
    const resources = Object.fromEntries(
      resourceRoles.map((role) => [role, { cpus: 0.5, memoryMiB: 512, pids: 128, tmpfsMiB: 64 }]),
    );
    const common = {
      MODEL_EXECUTION_ENABLED: 'false',
      OUTBOUND_EXECUTION_ENABLED: 'false',
      N8N_EXECUTION_ENABLED: 'false',
      OPS_POLL_MS: '1000',
      OPS_BATCH_SIZE: '5',
      OPS_LEASE_MS: '60000',
      OPS_MAX_CALL_MS: '20000',
      OPS_SHUTDOWN_GRACE_MS: '5000',
      OPS_STOP_GRACE_MS: '30000',
      OPS_HEALTH_STALE_MS: '60000',
      OPS_HOST_CPUS: '4',
      OPS_HOST_MEMORY_MIB: '8192',
      OPS_RESOURCE_LIMITS_JSON: JSON.stringify(resources),
      OPS_RESOURCE_BOUNDS_JSON: JSON.stringify({
        minimum: { cpus: 0.05, memoryMiB: 32, pids: 16, tmpfsMiB: 1 },
        maximum: { cpus: 2, memoryMiB: 2048, pids: 512, tmpfsMiB: 128 },
      }),
      BACKUP_DAILY_RETENTION: '45',
      BACKUP_MONTHLY_RETENTION: '6',
      BACKUP_CALENDAR: '*-*-* 02:00:00 UTC',
      MAINTENANCE_CALENDAR: '*-*-* *:00/5:00 UTC',
      OPS_SCHEMA_REVISION: '000016',
    };
    await put('config/common.env', serialize(common));
    for (const role of resourceRoles.filter((role) => role !== 'migrate'))
      await put(`config/${role.replaceAll('_', '-')}.env`, '# Authored synthetic host fixture\n');
    await put('config/migrate.env', '# Authored synthetic host fixture\n');
    // Replace the initially empty reply role file without creating arbitrary paths.
    await writeFile(
      join(root, 'config/reply.env'),
      serialize({
        REPLY_FAQ_POLICY_JSON: JSON.stringify({
          ambiguityMargin: 0.1,
          minimumSimilarity: 0.8,
          maximumCandidates: 10,
        }),
        REPLY_OUTBOUND_BOUNDS_JSON: JSON.stringify({
          global1Minute: 10,
          globalUtcDay: 100,
          leaseMs: 30000,
          maximumDefiniteRetries: 1,
          messengerAccount1Minute: 10,
          perContact15Minute: 2,
          perContact24Hour: 5,
          providerTimeoutMs: 1000,
          retryBaseMs: 100,
          retryMaximumMs: 1000,
          whatsappAccount1Minute: 10,
          workerBatchSize: 5,
        }),
      }),
      { mode: 0o600 },
    );
    const passwords = Object.fromEntries(roles.map((role) => [role, secret()])) as Record<
      (typeof roles)[number],
      string
    >;
    const owner = secret(),
      restoredOwner = secret();
    const uri = (user: string, password: string, host = 'postgres') =>
      `postgresql://${user}:${password}@${host}:5432/fcd_support_test`;
    const roleUri = (role: (typeof roles)[number], host = 'postgres') =>
      uri(`fcd_synthetic_${role}`, passwords[role], host);
    const keyring = JSON.stringify({
      activeVersion: 'synthetic_v1',
      keys: [{ version: 'synthetic_v1', keyBase64url: randomBytes(32).toString('base64url') }],
    });
    const files: Record<string, string> = {
      'postgres/postgres-password': owner,
      'bootstrap/bootstrap-database': uri('postgres', owner),
      'webhook/webhook-database': roleUri('webhook'),
      'webhook/meta-app-secret': secret(),
      'webhook/meta-verify-token': secret(),
      'webhook/webhook-keyring': keyring,
      'admin/admin-database': roleUri('admin'),
      'admin/admin-session': randomBytes(32).toString('base64url'),
      'admin/admin-mfa': randomBytes(32).toString('base64url'),
      'reply/reply-database': roleUri('reply'),
      'reply/reply-keyring': keyring,
      'outbound/outbound-database': roleUri('outbound'),
      'outbound/outbound-keyring': keyring,
      'notification/notification-database': roleUri('notification'),
      'maintenance/maintenance-database': roleUri('maintenance'),
      'maintenance/maintenance-keyring': keyring,
      'health/health-database': roleUri('health'),
      'backup/backup-database': roleUri('backup'),
      'backup/recovery-hmac': secret(),
      'verify-backup/verify-database': roleUri('verify_backup'),
      'checkpoint/checkpoint-database': roleUri('checkpoint'),
      'migrate/migrate-database': roleUri('migrator'),
      'restore/restore-postgres-password': restoredOwner,
      'restore/restore-database': uri('postgres', restoredOwner, 'fcd-support-restore-postgres'),
      'restore/restore-archive-database': roleUri('archive_reader', 'fcd-support-source-postgres'),
      'restore/restore-checkpoint-database': roleUri('checkpoint', 'fcd-support-source-postgres'),
      'restore/restore-migrator-database': roleUri('migrator', 'fcd-support-restore-postgres'),
      'restore/restore-keyring': keyring,
    };
    for (const role of roles)
      files[`bootstrap/passwords/bootstrap-${role.replaceAll('_', '-')}-password`] =
        passwords[role];
    for (const [path, value] of Object.entries(files)) await put(`secrets/${path}`, value);
    // Real age keys are generated later by the pinned offline operations image.
    await mkdir(join(root, 'secrets/verify-backup'), { recursive: true, mode: 0o700 });
    await put('state/deployment.lock', '');
    const restoreProject = project.replace(
      'fcd-support-host-test-',
      'fcd-support-restore-host-test-',
    );
    const settings: Record<string, string> = {
      FCD_SUPPORT_REVISION: revision,
      FCD_SCHEMA_REVISION: '000016',
      FCD_RUNTIME_PROJECT: project,
      FCD_RESTORE_PROJECT: restoreProject,
      FCD_POSTGRES_VOLUME: `${project}-postgres`,
      FCD_RESTORE_VOLUME: `${restoreProject}-data`,
      FCD_BACKUP_VOLUME: `${project}-backups`,
      FCD_SUPPORT_IMAGE: `${project}-application:${revision}`,
      FCD_OPERATIONS_IMAGE: `${project}-operations:${revision}`,
      FCD_POSTGRES_IMAGE: `${project}-postgres:${revision}`,
      FCD_CONFIG_ROOT: join(root, 'config'),
      FCD_SECRET_ROOT: join(root, 'secrets'),
      FCD_STATE_ROOT: join(root, 'state'),
      FCD_ADMIN_SOCKET_ROOT: join(root, 'socket'),
      FCD_POSTGRES_DB: 'fcd_support_test',
      FCD_DATABASE_SCHEMA: 'public',
      FCD_DATABASE_ROLE_PREFIX: 'fcd_synthetic',
      FCD_INGRESS_NETWORK: `${project}-ingress`,
      FCD_NOTIFICATION_NETWORK: `${project}-notification`,
      FCD_ADMIN_BROWSER_PORT: '13004',
      FCD_ADMIN_ORIGIN: 'http://127.0.0.1:13004',
      FCD_COMMAND_TIMEOUT_SECONDS: '180',
      FCD_READY_TIMEOUT_SECONDS: '120',
      FCD_STOP_GRACE_MS: '30000',
      FCD_HEALTH_INTERVAL_MS: '2000',
      FCD_HEALTH_TIMEOUT_MS: '1000',
      FCD_HEALTH_RETRIES: '30',
      FCD_HEALTH_START_MS: '5000',
    };
    for (const role of [...resourceRoles, 'postgres']) {
      const prefix = `FCD_${role.toUpperCase()}`;
      settings[`${prefix}_CPUS`] = '0.5';
      settings[`${prefix}_MEMORY_MIB`] = '512';
      settings[`${prefix}_PIDS`] = '128';
      settings[`${prefix}_TMPFS_MIB`] = '64';
    }
    await put('config/operations.env', serialize(settings));
  } catch {
    throw new Error('synthetic_host_fixture_invalid');
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [root, project, revision] = process.argv.slice(2);
  if (
    process.argv.length !== 5 ||
    root === undefined ||
    project === undefined ||
    revision === undefined
  )
    throw new Error('synthetic_host_fixture_invalid');
  await writeRuntimeHostFixture(root, project, revision);
}
