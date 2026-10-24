import { posix } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { loadRoleEnvironment } from './secret-files.js';
import { loadOperationsConfig } from './operations-config.js';
import {
  configureRuntimeGrants,
  runtimeDatabaseRoles,
} from '../persistence/postgres-runtime-grants.js';

export function parseBootstrapCommand(args: readonly string[]) {
  try {
    const [phase, systemIdentifier, passwordDirectory] = z
      .tuple([
        z.enum(['prepare', 'converge']),
        z
          .string()
          .regex(/^[1-9][0-9]{0,19}$/u)
          .refine((value) => BigInt(value) <= 18446744073709551615n),
        z
          .string()
          .min(2)
          .max(4096)
          .regex(/^\/[A-Za-z0-9._/-]+$/u)
          .refine((value) => !value.endsWith('/') && posix.normalize(value) === value),
      ])
      .parse(args);
    return { phase, systemIdentifier, passwordDirectory };
  } catch {
    throw new Error('runtime_bootstrap_invalid');
  }
}

export async function runBootstrapMain(): Promise<void> {
  let pool: pg.Pool | undefined;
  let failed = false;
  try {
    const command = parseBootstrapCommand(process.argv.slice(2));
    if (
      process.platform !== 'linux' ||
      process.geteuid?.() !== 1000 ||
      process.getegid?.() !== 1000
    )
      throw new Error('invalid');
    const database = z
      .string()
      .regex(/^fcd_support(?:_[a-z0-9_]+)?$/u)
      .parse(process.env.OPS_DATABASE_NAME);
    const schema = z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,62}$/u)
      .parse(process.env.OPS_DATABASE_SCHEMA ?? 'public');
    const rolePrefix = z
      .string()
      .regex(/^fcd_[a-z0-9_]{1,28}$/u)
      .parse(process.env.OPS_DATABASE_ROLE_PREFIX);
    const directory = await lstat(command.passwordDirectory);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      ![0, 1000].includes(directory.uid) ||
      (directory.mode & 0o022) !== 0 ||
      (await realpath(command.passwordDirectory)) !== command.passwordDirectory
    )
      throw new Error('invalid');
    // This dedicated, explicit bootstrap process alone receives the owner URI
    // and role password files. No runtime or ordinary backup gains them.
    const environment = await loadRoleEnvironment('migrate', process.env);
    const config = loadOperationsConfig('migrate', environment);
    if (
      config.modelExecutionEnabled ||
      config.outboundExecutionEnabled ||
      config.n8nExecutionEnabled
    )
      throw new Error('invalid');
    pool = new pg.Pool({
      connectionString: environment.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: config.maximumCallMilliseconds,
      query_timeout: config.maximumCallMilliseconds,
      statement_timeout: config.maximumCallMilliseconds,
      application_name: 'fcd-support-bootstrap',
    });
    pool.on('error', () => {
      failed = true;
    });
    const actual = (
      await pool.query<{ id: string; database: string }>(
        'select system_identifier::text as id,current_database() as database from pg_control_system()',
      )
    ).rows[0];
    if (actual?.id !== command.systemIdentifier || actual.database !== database)
      throw new Error('invalid');
    const passwordFiles = Object.fromEntries(
      [...runtimeDatabaseRoles, 'migrator'].map((role) => [
        role,
        posix.join(command.passwordDirectory, `bootstrap-${role.replaceAll('_', '-')}-password`),
      ]),
    );
    await configureRuntimeGrants(pool, {
      database,
      schema,
      rolePrefix,
      passwordFiles,
      phase: command.phase,
      timeoutMilliseconds: config.maximumCallMilliseconds,
    });
  } catch {
    failed = true;
  } finally {
    try {
      await pool?.end();
    } catch {
      failed = true;
    }
  }
  // An ambiguous close must not leave a successful stdout acknowledgement.
  if (failed) {
    process.stderr.write('runtime_bootstrap_failed\n');
    process.exitCode = 1;
  } else process.stdout.write('{"status":"completed","processed":1,"reasonCode":"ok"}\n');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runBootstrapMain();
