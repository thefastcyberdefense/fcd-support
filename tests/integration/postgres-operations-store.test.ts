import { AdminSecretText } from '../../src/admin/admin-types.js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { PostgresOperationsStore } from '../../src/persistence/postgres-operations-store.js';
import type { HealthObservation } from '../../src/operations/operations-types.js';
import { createIsolatedTestDatabase, rollbackThroughMigration } from './test-database.js';
import {
  createPhase6Fixture,
  operationsAt,
  type Phase6OperationsFixture,
} from './phase6-operations-fixtures.js';

let fixture: Phase6OperationsFixture;
beforeEach(async () => {
  fixture = await createPhase6Fixture();
});
afterEach(async () => {
  await fixture.dispose();
});

const unhealthy = (milliseconds = 0): HealthObservation => ({
  component: 'postgres',
  state: 'unavailable',
  reasonCode: 'dependency_unavailable',
  checkedAt: new Date(operationsAt.getTime() + milliseconds),
  durationMilliseconds: 10,
});
async function incidentReference(): Promise<string> {
  const result = await fixture.db.pool.query<{ incident_ref: string }>(
    'select incident_ref from operations_incidents where resolved_at is null',
  );
  const reference = result.rows[0]?.incident_ref;
  if (reference === undefined) throw new Error('Synthetic incident missing');
  return reference;
}
function backup(
  state: 'created' | 'verified' | 'restore_verified' | 'pruned' | 'failed' = 'created',
) {
  return {
    backupRef: 'BACKUP_TEST_operations',
    class: 'daily' as const,
    createdAt: operationsAt,
    gitRevision: 'a'.repeat(40),
    schemaRevision: '000013',
    ciphertextBytes: 100,
    ciphertextSha256: '0'.repeat(64),
    state,
  };
}

describe('PostgreSQL operations metadata', () => {
  test('opens one incident, preserves acknowledgement, resolves on recovery', async () => {
    await fixture.store.recordHealth(unhealthy());
    fixture.setNow(new Date(operationsAt.getTime() + 1000));
    const incidentRef = await incidentReference();
    await fixture.store.acknowledgeIncident(
      {
        incidentRef,
        requestKey: 'REQUEST_TEST_ack',
        acknowledgedAt: new Date(operationsAt.getTime() + 1000),
      },
      fixture.actor,
    );
    await fixture.store.recordHealth(unhealthy(2000));
    expect(
      await fixture.db.pool.query(
        'select consecutive_failures, acknowledged_at is not null as acknowledged from operations_incidents',
      ),
    ).toMatchObject({ rows: [{ consecutive_failures: 2, acknowledged: true }] });
    await fixture.store.recordHealth({ ...unhealthy(3000), state: 'healthy', reasonCode: 'ok' });
    expect(
      await fixture.db.pool.query(
        'select count(*)::int as n from operations_incidents where resolved_at is null',
      ),
    ).toMatchObject({ rows: [{ n: 0 }] });
  });

  test('concurrent exact retries append one check and one incident', async () => {
    await Promise.all(Array.from({ length: 5 }, () => fixture.store.recordHealth(unhealthy())));
    expect(
      await fixture.db.pool.query('select count(*)::int as n from operations_health_checks'),
    ).toMatchObject({ rows: [{ n: 1 }] });
    expect(
      await fixture.db.pool.query('select count(*)::int as n from operations_incidents'),
    ).toMatchObject({ rows: [{ n: 1 }] });
    await expect(
      fixture.store.recordHealth({ ...unhealthy(), state: 'healthy', reasonCode: 'ok' }),
    ).rejects.toThrow('operations_conflict');
  });

  test('late healthy evidence cannot clear a newer failure', async () => {
    await fixture.store.recordHealth(unhealthy(2000));
    await fixture.store.recordHealth({ ...unhealthy(1000), state: 'healthy', reasonCode: 'ok' });
    const current = await fixture.store.listHealth(new Date(operationsAt.getTime() + 3000), 10000);
    expect(current[0]?.state).toBe('unavailable');
    expect(
      await fixture.db.pool.query(
        'select count(*)::int as n from operations_incidents where resolved_at is null',
      ),
    ).toMatchObject({ rows: [{ n: 1 }] });
  });

  test('stale and future checks display unknown instead of current healthy', async () => {
    await fixture.store.recordHealth({ ...unhealthy(), state: 'healthy', reasonCode: 'ok' });
    expect(
      await fixture.store.listHealth(new Date(operationsAt.getTime() + 1001), 1000),
    ).toMatchObject([{ state: 'unknown', reasonCode: 'stale' }]);
    expect(
      await fixture.store.listHealth(new Date(operationsAt.getTime() - 1), 1000),
    ).toMatchObject([{ state: 'unknown', reasonCode: 'stale' }]);
  });

  test('missing and revoked sessions cannot acknowledge incidents', async () => {
    await fixture.store.recordHealth(unhealthy());
    const input = {
      incidentRef: await incidentReference(),
      requestKey: 'REQUEST_TEST_denied',
      acknowledgedAt: operationsAt,
    };
    await expect(
      fixture.store.acknowledgeIncident(input, {
        ...fixture.actor,
        sessionToken: new AdminSecretText('synthetic_invalid_session'),
      }),
    ).rejects.toThrow('operations_unauthorized');
    await fixture.identity.revokeSession({ sessionToken: fixture.actor.sessionToken });
    await expect(fixture.store.acknowledgeIncident(input, fixture.actor)).rejects.toThrow(
      'operations_unauthorized',
    );
    expect(
      await fixture.db.pool.query(
        "select count(*)::int as n from operations_incident_events where action = 'acknowledged'",
      ),
    ).toMatchObject({ rows: [{ n: 0 }] });
  });

  test('actor-supplied roles cannot override the authoritative role assignment', async () => {
    await fixture.store.recordHealth(unhealthy());
    await fixture.db.pool.query(
      `insert into admin_role_assignments
      (account_id, role, action, actor_account_id, effective_at, request_key)
      select id, 'administrator', 'revoke', id, $1, 'REQUEST_TEST_revoke_operations'
      from admin_accounts where account_ref = 'ADMIN_TEST_operations'`,
      [new Date(operationsAt.getTime() + 1000)],
    );
    fixture.setNow(new Date(operationsAt.getTime() + 2000));
    await expect(
      fixture.store.acknowledgeIncident(
        {
          incidentRef: await incidentReference(),
          requestKey: 'REQUEST_TEST_wrong_role',
          acknowledgedAt: new Date(operationsAt.getTime() + 2000),
        },
        fixture.actor,
      ),
    ).rejects.toThrow('operations_unauthorized');
  });

  test('acknowledgement is exact-replay safe and does not clear health', async () => {
    await fixture.store.recordHealth(unhealthy());
    const input = {
      incidentRef: await incidentReference(),
      requestKey: 'REQUEST_TEST_ack_replay',
      acknowledgedAt: operationsAt,
    };
    await fixture.store.acknowledgeIncident(input, fixture.actor);
    await fixture.store.acknowledgeIncident(input, fixture.actor);
    await expect(
      fixture.store.acknowledgeIncident(
        { ...input, acknowledgedAt: new Date(operationsAt.getTime() + 1) },
        fixture.actor,
      ),
    ).rejects.toThrow('operations_conflict');
    expect(await fixture.store.listHealth(operationsAt, 1000)).toMatchObject([
      { state: 'unavailable' },
    ]);
  });

  test('unconfigured authorization and forged actor reference fail closed', async () => {
    await fixture.store.recordHealth(unhealthy());
    const input = {
      incidentRef: await incidentReference(),
      requestKey: 'REQUEST_TEST_actor',
      acknowledgedAt: operationsAt,
    };
    await expect(
      new PostgresOperationsStore(fixture.db.pool).acknowledgeIncident(input, fixture.actor),
    ).rejects.toThrow('operations_unauthorized');
    await expect(
      fixture.store.acknowledgeIncident(input, {
        ...fixture.actor,
        accountRef: 'ADMIN_TEST_other',
      }),
    ).rejects.toThrow('operations_unauthorized');
  });

  test('audit insertion failure rolls back the entire health observation', async () => {
    await fixture.db.pool
      .query(`create function synthetic_reject_operations_event() returns trigger language plpgsql as $$
      begin raise exception 'synthetic_audit_failure'; end $$;
      create trigger synthetic_operations_audit_failure before insert on operations_incident_events
      for each row execute function synthetic_reject_operations_event()`);
    await expect(fixture.store.recordHealth(unhealthy())).rejects.toThrow(
      'synthetic_audit_failure',
    );
    expect(
      await fixture.db.pool.query('select count(*)::int as n from operations_health_checks'),
    ).toMatchObject({ rows: [{ n: 0 }] });
    expect(
      await fixture.db.pool.query('select count(*)::int as n from operations_incidents'),
    ).toMatchObject({ rows: [{ n: 0 }] });
  });

  test('health and acknowledgement evidence cannot be updated or deleted', async () => {
    await fixture.store.recordHealth(unhealthy());
    await expect(
      fixture.db.pool.query("update operations_health_checks set state = 'healthy'"),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      fixture.db.pool.query('delete from operations_incident_events'),
    ).rejects.toMatchObject({ code: '55000' });
  });

  test('metadata tables exclude content, payload, secret and URL columns', async () => {
    const columns = await fixture.db.pool.query<{ column_name: string }>(
      `select column_name
      from information_schema.columns where table_schema = $1 and table_name like 'operations_%'`,
      [fixture.db.schema],
    );
    expect(columns.rows.length).toBeGreaterThan(20);
    expect(
      columns.rows.filter((row) =>
        /(?:message|payload|prompt|password|secret|token|url|external_identity)/u.test(
          row.column_name,
        ),
      ),
    ).toEqual([]);
    await expect(
      fixture.store.recordHealth({
        ...unhealthy(),
        payload: 'synthetic_unapproved_payload',
      } as HealthObservation),
    ).rejects.toThrow('operations_input_invalid');
  });

  test('catalogue verification advances without changing immutable archive material', async () => {
    await fixture.store.recordBackup(backup());
    await fixture.store.recordBackup(backup('verified'));
    await fixture.store.recordBackup(backup('verified'));
    await fixture.store.recordBackup(backup('restore_verified'));
    expect(await fixture.db.pool.query('select state from operations_backups')).toMatchObject({
      rows: [{ state: 'restore_verified' }],
    });
    expect(
      await fixture.db.pool.query('select count(*)::int as n from operations_backup_events'),
    ).toMatchObject({ rows: [{ n: 3 }] });
    await expect(
      fixture.store.recordBackup({ ...backup('pruned'), ciphertextBytes: 101 }),
    ).rejects.toThrow('operations_conflict');
    await expect(fixture.store.recordBackup(backup('created'))).rejects.toThrow(
      'operations_conflict',
    );
  });

  test('a missing archive cannot be labelled verified and pruned history stays terminal', async () => {
    await expect(fixture.store.recordBackup(backup('verified'))).rejects.toThrow(
      'operations_conflict',
    );
    await fixture.store.recordBackup(backup());
    await fixture.store.recordBackup(backup('verified'));
    await fixture.store.recordBackup(backup('pruned'));
    await expect(fixture.store.recordBackup(backup('restore_verified'))).rejects.toThrow(
      'operations_conflict',
    );
  });

  test('deployment evidence is immutable and rejects extra request material', async () => {
    const input = {
      gitRevision: 'b'.repeat(40),
      schemaRevision: '000013',
      recordedAt: operationsAt,
      status: 'started' as const,
    };
    await fixture.store.recordDeployment(input);
    await fixture.store.recordDeployment(input);
    expect(
      await fixture.db.pool.query('select count(*)::int as n from operations_deployments'),
    ).toMatchObject({ rows: [{ n: 1 }] });
    await expect(fixture.store.recordDeployment({ ...input, status: 'failed' })).rejects.toThrow(
      'operations_conflict',
    );
    await expect(
      fixture.store.recordDeployment({ ...input, gitRevision: 'synthetic_not_a_revision' }),
    ).rejects.toThrow('operations_input_invalid');
    await expect(fixture.db.pool.query('delete from operations_deployments')).rejects.toMatchObject(
      { code: '55000' },
    );
  });

  test('migration thirteen refuses populated downgrade without losing evidence', async () => {
    await fixture.store.recordHealth(unhealthy());
    await expect(rollbackThroughMigration(fixture.db, 13)).rejects.toMatchObject({ code: '55000' });
    expect(
      await fixture.db.pool.query('select count(*)::int as n from operations_health_checks'),
    ).toMatchObject({ rows: [{ n: 1 }] });
  });

  test('migration thirteen applies to the prior schema, rolls down empty and reapplies', async () => {
    const db = await createIsolatedTestDatabase('phase6_operations_cycle');
    try {
      await rollbackThroughMigration(db, 13);
      expect(
        await db.pool.query("select to_regclass('operations_health_checks') as relation"),
      ).toMatchObject({ rows: [{ relation: null }] });
      await db.runMigrations('up');
      expect(
        await db.pool.query(
          "select to_regclass('operations_health_checks') is not null as present",
        ),
      ).toMatchObject({ rows: [{ present: true }] });
    } finally {
      await db.dispose();
    }
  });
});
