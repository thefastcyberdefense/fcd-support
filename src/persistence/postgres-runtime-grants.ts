import { z } from 'zod';
import type pg from 'pg';
import { readSecretFile } from '../operations/secret-files.js';

export const runtimeDatabaseRoles = [
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
] as const;
export type RuntimeDatabaseRole = (typeof runtimeDatabaseRoles)[number];
export interface RuntimeGrantOptions {
  readonly schema: string;
  readonly database: string;
  readonly rolePrefix: string;
  readonly passwordFiles: Readonly<Record<string, string>>;
}
const groups = {
  identity: ['contacts', 'channel_identities', 'conversations'],
  events: [
    'webhook_receipts',
    'webhook_events',
    'webhook_event_applications',
    'human_pause_events',
    'consent_events',
    'policy_audit_outcomes',
  ],
  retention: ['conversation_retention_states', 'retention_events', 'retention_job_runs'],
  privacy: [
    'privacy_requests',
    'privacy_request_locations',
    'privacy_suppressions',
    'privacy_request_events',
    'privacy_notification_intents',
    'privacy_deletion_runs',
    'restore_deletion_gates',
    'privacy_marketing_reopt_in_runs',
    'privacy_access_runs',
    'privacy_correction_runs',
    'privacy_marketing_opt_out_runs',
  ],
  knowledge: [
    'knowledge_sources',
    'knowledge_source_snapshots',
    'knowledge_items',
    'knowledge_versions',
    'knowledge_aliases',
    'knowledge_tags',
    'knowledge_review_events',
    'knowledge_publication_events',
  ],
  admin: [
    'admin_accounts',
    'admin_role_assignments',
    'admin_mfa_credentials',
    'admin_sessions',
    'admin_audit_events',
  ],
  learning: [
    'knowledge_gap_observations',
    'knowledge_gap_candidates',
    'customer_insight_runs',
    'customer_insight_entries',
    'owner_questions',
    'owner_question_insights',
    'owner_question_answers',
    'owner_question_digests',
    'owner_question_digest_entries',
  ],
  reply: ['support_reply_drafts', 'support_reply_draft_knowledge', 'support_escalation_outcomes'],
  model: [
    'model_policy_versions',
    'model_policy_review_events',
    'model_usage_windows',
    'model_call_leases',
  ],
  outbound: [
    'outbound_policy_versions',
    'outbound_policy_review_events',
    'outbound_template_versions',
    'outbound_template_review_events',
    'outbound_intents',
    'outbound_attempts',
    'outbound_rate_windows',
    'outbound_status_events',
    'outbound_echo_correlation_holds',
    'outbound_escalation_outcomes',
  ],
  runtime: [
    'runtime_processing_work',
    'notification_delivery_work',
    'notification_delivery_attempts',
  ],
  operations: [
    'operations_health_checks',
    'operations_incidents',
    'operations_incident_events',
    'operations_backups',
    'operations_backup_events',
    'operations_deployments',
    'operations_restore_runs',
  ],
  recovery: [
    'deletion_checkpoint_clock',
    'deletion_checkpoints',
    'restore_checkpoint_imports',
    'runtime_recovery_holds',
    'runtime_recovery_reviews',
    'runtime_restore_quarantine',
  ],
} as const;
const knownTables = new Set<string>(['pgmigrations', ...Object.values(groups).flat()]);
const knownViews = new Set(['notification_delivery_sources']);
const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
const quote = (value: string) => `"${identifier.parse(value)}"`;

export async function configureRuntimeGrants(
  pool: pg.Pool,
  input: RuntimeGrantOptions,
): Promise<void> {
  const secrets = new Map<string, string>();
  let client: pg.PoolClient | undefined;
  let destroy = false;
  try {
    const schema = identifier.parse(input.schema);
    const database = identifier.parse(input.database);
    if (!/^fcd_support(?:_[a-z0-9_]+)?$/u.test(database)) throw new Error('invalid');
    const prefix = z
      .string()
      .regex(/^fcd_[a-z0-9_]{1,28}$/u)
      .parse(input.rolePrefix);
    const principals = [...runtimeDatabaseRoles, 'migrator'] as const;
    if (
      Object.keys(input.passwordFiles).length !== principals.length ||
      Object.keys(input.passwordFiles).some((name) => !principals.some((role) => role === name))
    )
      throw new Error('invalid');
    for (const role of principals) {
      const file = input.passwordFiles[role];
      if (file === undefined) throw new Error('invalid');
      const bytes = await readSecretFile(file);
      try {
        const password = new TextDecoder('utf-8', { fatal: true })
          .decode(bytes)
          .replace(/\r?\n$/u, '');
        z.string()
          .regex(/^[A-Za-z0-9_-]{32,256}$/u)
          .parse(password);
        secrets.set(role, password);
      } finally {
        bytes.fill(0);
      }
    }
    if (new Set(secrets.values()).size !== secrets.size) throw new Error('invalid');
    client = await pool.connect();
    const connection = client;
    await client.query('begin');
    // The explicit bootstrap owner can suppress statement/parameter logging before
    // any password-bearing DDL. Failure here sends no password-bearing query.
    await client.query(
      "set local log_statement='none'; set local log_min_error_statement='panic'; set local log_min_duration_statement=-1; set local log_min_duration_sample=-1; set local log_statement_sample_rate=0; set local log_transaction_sample_rate=0; set local log_parameter_max_length=0; set local log_parameter_max_length_on_error=0; set local password_encryption='scram-sha-256'",
    );
    const context = (
      await client.query<{ name: string; privileged: boolean }>(`select current_database() as name,
      (select rolsuper from pg_roles where rolname=current_user) as privileged`)
    ).rows[0];
    if (context?.name !== database || !context.privileged) throw new Error('invalid');
    const lock = await client.query<{ acquired: boolean }>(
      'select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired',
      [`fcd-support:runtime-grants:${database}:${schema}`],
    );
    if (lock.rows[0]?.acquired !== true) throw new Error('invalid');
    const relations = await client.query<{ relname: string; relkind: string }>(
      `select relname,relkind from pg_class
      where relnamespace=$1::regnamespace and relkind in ('r','p','v','S') order by relname`,
      [schema],
    );
    const tables = relations.rows
      .filter((row) => ['r', 'p'].includes(row.relkind))
      .map((row) => row.relname);
    const views = relations.rows.filter((row) => row.relkind === 'v').map((row) => row.relname);
    if (
      tables.some((name) => !knownTables.has(name)) ||
      views.some((name) => !knownViews.has(name)) ||
      !tables.includes('pgmigrations')
    )
      throw new Error('invalid');
    const owner = `${prefix}_migrator`;
    const ownerSql = quote(owner);
    const schemaSql = quote(schema);
    for (const role of principals) {
      const name = `${prefix}_${role}`;
      const nameSql = quote(name);
      const tag = `fcd-support:database-role:v1:${database}:${schema}:${role}`;
      const existing = (
        await client.query<{ marker: string | null }>(
          `select shobj_description(oid,'pg_authid') as marker from pg_roles where rolname=$1`,
          [name],
        )
      ).rows[0];
      if (existing !== undefined && existing.marker !== tag) throw new Error('invalid');
      const password = secrets.get(role);
      if (password === undefined) throw new Error('invalid');
      const verb = existing === undefined ? 'create' : 'alter';
      await client.query(
        `${verb} role ${nameSql} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password '${password}'`,
      );
      // The marker is validated ASCII metadata, never a credential.
      await client.query(`comment on role ${nameSql} is '${tag}'`);
      // Existing managed principals must not retain a stale namespace, preload
      // or logging override. Only the migrator can create in this owned schema.
      await client.query(`alter role ${nameSql} reset all;
        alter role ${nameSql} in database ${quote(database)} reset all;
        alter role ${nameSql} in database ${quote(database)} set search_path=${schemaSql},pg_catalog,pg_temp`);
      const memberships = await client.query<{ role_name: string }>(
        `select parent.rolname as role_name from pg_auth_members membership
        join pg_roles member on member.oid=membership.member join pg_roles parent on parent.oid=membership.roleid
        where member.rolname=$1 or parent.rolname=$1`,
        [name],
      );
      if (memberships.rows.length > 0) throw new Error('invalid');
    }
    const runtimeSql = runtimeDatabaseRoles.map((role) => quote(`${prefix}_${role}`)).join(',');
    await client.query(`revoke create on schema public from public; revoke all on schema ${schemaSql} from public,${runtimeSql};
      revoke create,temporary on database ${quote(database)} from public; revoke all on database ${quote(database)} from ${runtimeSql};
      grant connect,create,temporary on database ${quote(database)} to ${ownerSql};
      alter schema ${schemaSql} owner to ${ownerSql}`);
    for (const row of relations.rows.filter((row) => row.relkind !== 'S')) {
      const kind = row.relkind === 'v' ? 'view' : 'table';
      const tableSql = `${schemaSql}.${quote(row.relname)}`;
      await client.query(
        `alter ${kind} ${tableSql} owner to ${ownerSql}; revoke all on ${tableSql} from public,${runtimeSql}`,
      );
      const columns = (
        await client.query<{ attname: string }>(
          `select attname from pg_attribute where attrelid=$1::regclass and attnum>0 and not attisdropped`,
          [tableSql],
        )
      ).rows;
      if (columns.length > 0)
        await client.query(
          `revoke all(${columns.map((column) => quote(column.attname)).join(',')}) on ${tableSql} from public,${runtimeSql}`,
        );
    }
    // Table ownership moves owned identity sequences as well; explicitly align
    // remaining standalone sequences and remove PUBLIC privileges.
    for (const row of relations.rows.filter((row) => row.relkind === 'S')) {
      await client.query(
        `revoke all on sequence ${schemaSql}.${quote(row.relname)} from public,${runtimeSql}`,
      );
      // pg_dump must read sequence positions, but cannot advance business IDs.
      await client.query(
        `grant select on sequence ${schemaSql}.${quote(row.relname)} to ${quote(`${prefix}_backup`)}`,
      );
    }
    // Only this fixed body runs with the schema owner's rights. It grants a
    // transaction-scoped SHARE lock, never a customer-data write capability.
    await client.query(`create or replace function ${schemaSql}.lock_deletion_checkpoint_source() returns void
      language plpgsql security definer set search_path=pg_catalog,${schemaSql},pg_temp as $$
      begin lock table ${schemaSql}.privacy_suppressions in share mode; end $$`);
    const functions = await client.query<{ signature: string; proname: string }>(
      `select oid::regprocedure::text as signature,proname from pg_proc
      where pronamespace=$1::regnamespace and prokind='f'`,
      [schema],
    );
    for (const fn of functions.rows) {
      // regprocedure text is server-produced, not caller-controlled; all app
      // routine names are still closed identifiers and the schema is trusted.
      identifier.parse(fn.proname);
      await client.query(
        `alter function ${fn.signature} owner to ${ownerSql}; revoke execute on function ${fn.signature} from public,${runtimeSql}`,
      );
      if (
        [
          'advance_deletion_checkpoint_clock',
          'runtime_recovery_held',
          'guard_runtime_recovery_hold',
          'guard_runtime_recovery_review',
        ].includes(fn.proname)
      ) {
        await client.query(
          `alter function ${fn.signature} security definer; alter function ${fn.signature} set search_path=pg_catalog,${schemaSql},pg_temp`,
        );
      }
    }
    await client.query(
      `alter default privileges for role ${ownerSql} in schema ${schemaSql} revoke execute on functions from public`,
    );
    for (const kind of ['tables', 'sequences', 'functions'])
      await client.query(
        `alter default privileges for role ${ownerSql} in schema ${schemaSql} revoke all on ${kind} from public,${runtimeSql}`,
      );
    const grant = async (
      role: RuntimeDatabaseRole,
      privilege: string,
      names: readonly string[],
    ) => {
      const present = [...new Set(names)].filter(
        (name) => tables.includes(name) || views.includes(name),
      );
      if (present.length === 0) return;
      await connection.query(
        `grant ${privilege} on ${present.map((name) => `${schemaSql}.${quote(name)}`).join(',')} to ${quote(`${prefix}_${role}`)}`,
      );
    };
    const sequenceGrants = new Map<RuntimeDatabaseRole, Set<string>>();
    const write = async (
      role: RuntimeDatabaseRole,
      names: readonly string[],
      privileges = 'select,insert,update',
    ) => {
      await grant(role, privileges, names);
      if (privileges.includes('insert')) {
        const selected = sequenceGrants.get(role) ?? new Set<string>();
        for (const name of names) selected.add(name);
        sequenceGrants.set(role, selected);
      }
    };
    const health = async (role: RuntimeDatabaseRole) => {
      await grant(role, 'select', [
        'operations_health_checks',
        'operations_incidents',
        'operations_incident_events',
      ]);
      await write(role, ['operations_health_checks'], 'insert');
      await write(
        role,
        ['operations_incidents'],
        'insert(incident_ref,component,opened_at,last_observed_at,consecutive_failures)',
      );
      await grant(role, 'update(last_observed_at,consecutive_failures,resolved_at)', [
        'operations_incidents',
      ]);
      await write(
        role,
        ['operations_incident_events'],
        'insert(incident_id,action,health_check_id,effective_at)',
      );
    };
    for (const role of runtimeDatabaseRoles) {
      await client.query(
        `grant usage on schema ${schemaSql} to ${quote(`${prefix}_${role}`)}; grant connect on database ${quote(database)} to ${quote(`${prefix}_${role}`)}`,
      );
      await grant(role, 'select', ['pgmigrations', 'operations_deployments']);
    }
    await grant('webhook', 'select', ['privacy_suppressions']);
    await write('webhook', ['webhook_receipts', 'webhook_events'], 'select,insert');
    await grant('reply', 'select', [
      ...groups.identity,
      ...groups.events,
      ...groups.retention,
      ...groups.privacy,
      ...groups.knowledge,
      ...groups.learning,
      ...groups.reply,
      ...groups.model,
      ...groups.outbound,
      'runtime_restore_quarantine',
    ]);
    await grant('reply', 'select(source_kind,source_id)', ['runtime_restore_quarantine']);
    await write('reply', [
      ...groups.identity,
      ...groups.events,
      'conversation_retention_states',
      'retention_events',
      'privacy_requests',
      'privacy_request_locations',
      'privacy_request_events',
      'privacy_notification_intents',
      'privacy_suppressions',
      'privacy_marketing_reopt_in_runs',
      'privacy_access_runs',
      'privacy_correction_runs',
      'privacy_marketing_opt_out_runs',
      ...groups.reply,
      'knowledge_gap_observations',
      'model_call_leases',
      'model_usage_windows',
      'runtime_processing_work',
      'outbound_intents',
      'outbound_escalation_outcomes',
    ]);
    await grant('admin', 'select', [
      ...groups.knowledge,
      ...groups.admin,
      ...groups.learning,
      ...groups.model,
      ...groups.outbound,
      ...groups.runtime,
      ...groups.operations,
      ...groups.recovery,
      'conversation_retention_states',
    ]);
    await write('admin', [
      ...groups.knowledge,
      ...groups.admin,
      ...groups.learning,
      'model_policy_versions',
      'model_policy_review_events',
      'outbound_policy_versions',
      'outbound_policy_review_events',
      'outbound_template_versions',
      'outbound_template_review_events',
    ]);
    await grant('admin', 'update(acknowledged_at,acknowledged_by_account_id)', [
      'operations_incidents',
    ]);
    await write('admin', ['operations_incident_events'], 'insert');
    await grant('outbound', 'select', [
      ...groups.identity,
      ...groups.events,
      ...groups.retention,
      ...groups.privacy,
      ...groups.knowledge,
      ...groups.reply,
      ...groups.outbound,
    ]);
    await write('outbound', [
      'outbound_intents',
      'outbound_attempts',
      'outbound_rate_windows',
      'outbound_status_events',
      'outbound_echo_correlation_holds',
      'outbound_escalation_outcomes',
      'conversations',
      'human_pause_events',
      'webhook_event_applications',
      'policy_audit_outcomes',
    ]);
    await grant('notification', 'select', [
      'notification_delivery_sources',
      'notification_delivery_work',
      'notification_delivery_attempts',
      'privacy_notification_intents',
    ]);
    await write('notification', ['notification_delivery_work', 'notification_delivery_attempts']);
    await grant('notification', 'update(state,attempt_count,updated_at)', [
      'privacy_notification_intents',
    ]);
    await grant('notification', 'select(source_kind,source_id)', ['runtime_restore_quarantine']);
    const adminTables = new Set<string>(groups.admin);
    await grant(
      'maintenance',
      'select',
      tables.filter((name) => !adminTables.has(name)),
    );
    await write('maintenance', [
      ...groups.identity,
      ...groups.events,
      ...groups.retention,
      ...groups.privacy,
      ...groups.learning,
      ...groups.reply,
      'model_call_leases',
      'model_usage_windows',
      'outbound_intents',
      'outbound_attempts',
      'outbound_escalation_outcomes',
      'outbound_echo_correlation_holds',
    ]);
    await grant('maintenance', 'delete', [
      ...groups.identity,
      'knowledge_gap_observations',
      'knowledge_gap_candidates',
      'customer_insight_entries',
      'owner_question_insights',
      'owner_question_digest_entries',
      'support_reply_draft_knowledge',
      'webhook_events',
      'webhook_receipts',
    ]);
    await health('health');
    await grant('health', 'select(id,state,created_at,updated_at)', [
      'runtime_processing_work',
      'notification_delivery_work',
      'model_call_leases',
    ]);
    await grant('health', 'select', [
      'operations_backups',
      'operations_backup_events',
      'operations_restore_runs',
      'deletion_checkpoints',
      'restore_checkpoint_imports',
      'runtime_recovery_holds',
      'runtime_recovery_reviews',
    ]);
    await grant('backup', 'select', [...tables, ...views]);
    await write('backup', ['operations_backups', 'operations_backup_events'], 'select,insert');
    await grant('backup', 'update(state)', ['operations_backups']);
    await grant('verify_backup', 'select', ['operations_backups', 'operations_backup_events']);
    await write(
      'verify_backup',
      ['operations_backups', 'operations_backup_events'],
      'select,insert',
    );
    await grant('verify_backup', 'update(state)', ['operations_backups']);
    await grant('checkpoint', 'select', [
      'privacy_suppressions',
      'deletion_checkpoint_clock',
      'deletion_checkpoints',
    ]);
    await write('checkpoint', ['deletion_checkpoints'], 'insert');
    await health('checkpoint');
    await client.query(
      `grant execute on function ${schemaSql}.lock_deletion_checkpoint_source() to ${quote(`${prefix}_checkpoint`)}`,
    );
    for (const role of ['reply', 'outbound', 'notification', 'health', 'admin'] as const) {
      await client.query(
        `grant execute on function ${schemaSql}.runtime_recovery_held() to ${quote(`${prefix}_${role}`)}`,
      );
    }
    const sequences = await client.query<{
      table_name: string;
      sequence_schema: string;
      sequence_name: string;
    }>(
      `select tab.relname as table_name,
      ns.nspname as sequence_schema,seq.relname as sequence_name from pg_class seq join pg_namespace ns on ns.oid=seq.relnamespace
      join pg_depend dep on dep.objid=seq.oid and dep.deptype in ('a','i') join pg_class tab on tab.oid=dep.refobjid
      where seq.relkind='S' and tab.relnamespace=$1::regnamespace`,
      [schema],
    );
    for (const [role, names] of sequenceGrants)
      for (const sequence of sequences.rows) {
        if (names.has(sequence.table_name))
          await client.query(
            `grant usage,select on sequence ${quote(sequence.sequence_schema)}.${quote(sequence.sequence_name)} to ${quote(`${prefix}_${role}`)}`,
          );
      }
    await client.query('commit');
  } catch {
    if (client !== undefined) {
      try {
        await client.query('rollback');
      } catch {
        destroy = true;
      }
    }
    throw new Error('runtime_grants_invalid');
  } finally {
    secrets.clear();
    client?.release(destroy);
  }
}
