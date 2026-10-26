import pg from 'pg';
import { z } from 'zod';
import {
  assertDatabaseIdentity,
  parseDatabaseIdentity,
  type DatabaseIdentity,
} from './database-identity.js';
import { bindOperationConnectionString, operationApplicationName } from './operation-reference.js';

export interface MaintenancePoolOptions {
  readonly connectionString: string;
  readonly expectedDatabaseIdentity: DatabaseIdentity;
  readonly schema: string;
  readonly rolePrefix: string;
  readonly operationReference: string;
  readonly max: number;
  readonly timeoutMilliseconds: number;
}

export function createMaintenancePool(options: MaintenancePoolOptions): pg.Pool {
  try {
    const expected = parseDatabaseIdentity(options.expectedDatabaseIdentity);
    const schema = z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,62}$/u)
      .refine((value) => !value.startsWith('pg_') && value !== 'information_schema')
      .parse(options.schema);
    const prefix = z
      .string()
      .regex(/^fcd_[a-z0-9_]{1,28}$/u)
      .parse(options.rolePrefix);
    const max = z.number().int().min(1).max(1000).parse(options.max);
    const milliseconds = z.number().int().min(1).max(300000).parse(options.timeoutMilliseconds);
    const applicationName = operationApplicationName(options.operationReference);
    const connectionString = bindOperationConnectionString(
      options.connectionString,
      options.operationReference,
    );
    const roleName = `${prefix}_maintenance`;
    const searchPath = `pg_catalog,"${schema}",pg_temp`;
    // pg-pool's verify callback gates every NEW physical connection, including
    // pool.query and replacement connections. A separate startup probe would
    // leave later maintenance connections unbound.
    return new pg.Pool({
      connectionString,
      application_name: applicationName,
      max,
      connectionTimeoutMillis: milliseconds,
      query_timeout: milliseconds,
      statement_timeout: milliseconds,
      idle_in_transaction_session_timeout: milliseconds,
      verify(client, done) {
        let failed = false;
        const onError = () => {
          failed = true;
        };
        // Keep an error listener until the physical socket closes, including
        // failed admission and checked-out maintenance transactions.
        client.on('error', onError);
        client.once('end', () => client.off('error', onError));
        const verify = async () => {
          await assertDatabaseIdentity(client, expected);
          await client.query("select pg_catalog.set_config('search_path',$1,false)", [searchPath]);
          const actual = (
            await client.query<{
              name: string;
              login: string;
              restricted: boolean;
              scope: string | null;
              owner: string | null;
              schema_access: boolean;
              search_path: string;
              application_name: string;
            }>(
              `select current_user as name,session_user as login,
              r.rolcanlogin and not r.rolsuper and not r.rolcreatedb and not r.rolcreaterole
              and not r.rolreplication and not r.rolbypassrls and not r.rolinherit
              and not exists(select 1 from pg_catalog.pg_auth_members m where m.member=r.oid or m.roleid=r.oid)
              and not pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE')
              and not pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'TEMP') as restricted,
              pg_catalog.shobj_description(r.oid,'pg_authid') as scope,
              pg_catalog.pg_get_userbyid(n.nspowner) as owner,
              pg_catalog.has_schema_privilege(r.oid,n.oid,'USAGE')
              and not pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE') as schema_access,
              pg_catalog.current_setting('search_path') as search_path,
              pg_catalog.current_setting('application_name') as application_name
              from pg_catalog.pg_roles r join pg_catalog.pg_namespace n on n.nspname=$1
              where r.rolname=current_user`,
              [schema],
            )
          ).rows[0];
          if (
            failed ||
            actual?.name !== roleName ||
            actual.login !== roleName ||
            !actual.restricted ||
            actual.scope !==
              `fcd-support:database-role:v1:${expected.databaseName}:${schema}:maintenance` ||
            actual.owner !== `${prefix}_migrator` ||
            !actual.schema_access ||
            actual.search_path !== searchPath ||
            actual.application_name !== applicationName
          )
            throw new Error('invalid');
        };
        void verify().then(
          () => {
            done();
          },
          () => {
            done(new Error('maintenance_pool_invalid'));
          },
        );
      },
    });
  } catch {
    throw new Error('maintenance_pool_invalid');
  }
}
