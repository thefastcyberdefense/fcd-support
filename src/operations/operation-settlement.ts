import type pg from 'pg';
import { z } from 'zod';
import { assertDatabaseIdentity, parseDatabaseIdentity } from './database-identity.js';
import { operationApplicationName } from './operation-reference.js';

export interface OperationSettlementOptions {
  readonly reference: string;
  readonly probeReference: string;
  readonly systemIdentifier: string;
  readonly databaseName: string;
  readonly schema: string;
  readonly timeoutMilliseconds: number;
}

/** Requires independently verified job termination and reference-capable images.
 * This proves backend settlement only, never job success or application readiness. */
export async function inspectOperationSettlement(
  pool: Pick<pg.Pool, 'connect'>,
  options: OperationSettlementOptions,
): Promise<{ readonly status: 'settled' }> {
  let client: pg.PoolClient | undefined;
  let failed = false;
  const onError = () => {
    failed = true;
  };
  try {
    const name = operationApplicationName(options.reference);
    const probeName = operationApplicationName(options.probeReference);
    if (name === probeName) throw new Error('invalid');
    const expected = parseDatabaseIdentity({
      systemIdentifier: options.systemIdentifier,
      databaseName: options.databaseName,
    });
    const schema = z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,62}$/u)
      .parse(options.schema);
    const milliseconds = z.number().int().min(1).max(300000).parse(options.timeoutMilliseconds);
    client = await pool.connect();
    const connection = client;
    connection.on('error', onError);
    connection.once('end', () => {
      connection.off('error', onError);
    });
    await client.query('begin read only');
    await client.query(
      "select pg_catalog.set_config('statement_timeout',$1,true),pg_catalog.set_config('transaction_timeout',$1,true),pg_catalog.set_config('idle_in_transaction_session_timeout',$1,true)",
      [`${String(milliseconds)}ms`],
    );
    await assertDatabaseIdentity(client, expected);
    const context = (
      await client.query<{ privileged: boolean; application_name: string }>(
        "select rolsuper as privileged,pg_catalog.current_setting('application_name') as application_name from pg_catalog.pg_roles where rolname=current_user",
      )
    ).rows[0];
    // Full cluster visibility is required: a dump can connect to a different DB.
    if (context?.privileged !== true || context.application_name !== probeName)
      throw new Error('invalid');
    for (const key of [
      `fcd-support:runtime-grants:${expected.databaseName}:${schema}`,
      `fcd-support:deployment:${schema}`,
    ]) {
      const lock = (
        await client.query<{ acquired: boolean }>(
          'select pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended($1,0)) as acquired',
          [key],
        )
      ).rows[0];
      if (lock?.acquired !== true) throw new Error('invalid');
    }
    await client.query('select pg_catalog.pg_stat_clear_snapshot()');
    const activity = (
      await client.query<{ backends: string; prepared: string }>(
        'select count(*)::text as backends,(select count(*)::text from pg_catalog.pg_prepared_xacts) as prepared from pg_catalog.pg_stat_activity where application_name=$1',
        [name],
      )
    ).rows[0];
    if (activity?.backends !== '0' || activity.prepared !== '0') throw new Error('invalid');
  } catch {
    failed = true;
  } finally {
    if (client !== undefined) {
      try {
        await client.query('rollback');
      } catch {
        failed = true;
      }
      try {
        client.release(true);
      } catch {
        failed = true;
      }
    }
  }
  if (failed) throw new Error('operations_job_unsettled');
  return { status: 'settled' };
}
