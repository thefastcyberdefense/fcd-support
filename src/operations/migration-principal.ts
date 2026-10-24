import type pg from 'pg';
import { z } from 'zod';

/** Checks the principal on the connection which will own the operation. The
 * owner URI belongs only to bootstrap, even when it targets the correct DB. */
export async function assertMigrationPrincipal(
  client: pg.PoolClient,
  input: { readonly schema: string; readonly databaseName: string; readonly roleName: string },
): Promise<void> {
  try {
    const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
    const expected = z
      .strictObject({ schema: identifier, databaseName: identifier, roleName: identifier })
      .parse(input);
    const actual = (
      await client.query<{
        name: string;
        login: string;
        restricted: boolean;
        scope: string | null;
        schema: string | null;
        owner: string | null;
      }>(
        `select current_user as name,session_user as login,pg_catalog.current_schema() as schema,
      r.rolcanlogin and not r.rolsuper and not r.rolcreatedb and not r.rolcreaterole
      and not r.rolreplication and not r.rolbypassrls and not r.rolinherit
      and not exists(select 1 from pg_catalog.pg_auth_members m where m.member=r.oid or m.roleid=r.oid) as restricted,
      pg_catalog.shobj_description(r.oid,'pg_authid') as scope,
      (select pg_catalog.pg_get_userbyid(n.nspowner) from pg_catalog.pg_namespace n where n.nspname=$1) as owner
      from pg_catalog.pg_roles r where r.rolname=current_user`,
        [expected.schema],
      )
    ).rows[0];
    if (
      actual?.name !== expected.roleName ||
      actual.login !== expected.roleName ||
      !actual.restricted ||
      actual.schema !== expected.schema ||
      actual.owner !== expected.roleName ||
      actual.scope !==
        `fcd-support:database-role:v1:${expected.databaseName}:${expected.schema}:migrator`
    )
      throw new Error('invalid');
  } catch {
    throw new Error('migration_principal_invalid');
  }
}
