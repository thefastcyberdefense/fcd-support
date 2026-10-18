import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { readRuntimeHeartbeat, writeRuntimeHeartbeat } from '../src/operations/role-runtime.js';

import {
  checkRuntimeReadiness,
  isRuntimeHeartbeatFresh,
  type RuntimeReadinessPorts,
} from '../src/operations/runtime-readiness.js';
import type { RuntimeRole } from '../src/operations/operations-types.js';

const at = new Date('2030-03-01T00:00:00.000Z');
const revision = 'c'.repeat(40);
const input = () => ({
  role: 'reply' as RuntimeRole,
  revision,
  expectedSchemaRevision: '000014',
  externalExecutionEnabled: true,
  timeoutMilliseconds: 1000,
});
function ports(): RuntimeReadinessPorts {
  return {
    now: () => at,
    readSchemaRevision: vi.fn(() => Promise.resolve('000014')),
    readDeployedRevision: vi.fn(() => Promise.resolve(revision)),
    hasRequiredPolicy: vi.fn(() => Promise.resolve(true)),
    checkPrivateDependency: vi.fn(() => Promise.resolve('healthy' as const)),
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('private runtime readiness', () => {
  test('tmpfs heartbeat contract stores only closed state/time and rejects malformed evidence', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fcd-heartbeat-test-'));
    const file = path.join(directory, 'heartbeat.json');
    try {
      expect(readRuntimeHeartbeat(file, at, 500)).toBe(false);
      writeRuntimeHeartbeat(file, { state: 'healthy', checkedAt: at.toISOString() });
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        state: 'healthy',
        checkedAt: at.toISOString(),
      });
      expect(readRuntimeHeartbeat(file, at, 500)).toBe(true);
      expect(readRuntimeHeartbeat(file, new Date(at.getTime() + 500), 500)).toBe(false);
      expect(() => {
        writeRuntimeHeartbeat(file, {
          state: 'unknown',
          checkedAt: at.toISOString(),
          body: 'synthetic_extra',
        });
      }).toThrow('runtime_heartbeat_invalid');
      writeFileSync(file, 'x'.repeat(1025));
      expect(readRuntimeHeartbeat(file, at, 500)).toBe(false);
      writeFileSync(file, '{}');
      expect(readRuntimeHeartbeat(file, at, 500)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  test('requires matching schema, revision, current policy and private dependency', async () => {
    const dependencies = ports();
    expect(await checkRuntimeReadiness(input(), dependencies)).toEqual({
      component: 'reply',
      state: 'healthy',
      reasonCode: 'ok',
      checkedAt: at,
      durationMilliseconds: 0,
    });
    expect(dependencies.hasRequiredPolicy).toHaveBeenCalledWith('reply', at);
  });

  test.each(['schema', 'revision', 'policy', 'pool'] as const)(
    '%s failure closes readiness with content-free reason',
    async (kind) => {
      const dependencies = ports();
      if (kind === 'schema') dependencies.readSchemaRevision = () => Promise.resolve('000013');
      if (kind === 'revision')
        dependencies.readDeployedRevision = () => Promise.resolve('d'.repeat(40));
      if (kind === 'policy') dependencies.hasRequiredPolicy = () => Promise.resolve(false);
      if (kind === 'pool')
        dependencies.readSchemaRevision = () =>
          Promise.reject(new Error('synthetic_sensitive_database_details'));
      const observed = await checkRuntimeReadiness(input(), dependencies);
      expect(observed.state).toBe('unavailable');
      expect(JSON.stringify(observed)).not.toContain('synthetic_sensitive');
      expect(dependencies.checkPrivateDependency).not.toHaveBeenCalled();
    },
  );

  test.each(['outbound', 'notification'] as const)(
    'disabled %s remains idle without a dependency or active policy',
    async (role) => {
      const dependencies = ports();
      expect(
        await checkRuntimeReadiness(
          { ...input(), role, externalExecutionEnabled: false },
          dependencies,
        ),
      ).toMatchObject({ component: role, state: 'disabled', reasonCode: 'disabled' });
      expect(dependencies.checkPrivateDependency).not.toHaveBeenCalled();
      expect(dependencies.hasRequiredPolicy).not.toHaveBeenCalled();
    },
  );

  test('model-disabled reply keeps core FAQ readiness without probing Manifest', async () => {
    const dependencies = ports();
    expect(
      await checkRuntimeReadiness({ ...input(), externalExecutionEnabled: false }, dependencies),
    ).toMatchObject({ state: 'healthy' });
    expect(dependencies.checkPrivateDependency).not.toHaveBeenCalled();
  });

  test.each(['degraded', 'unavailable', 'unknown', 'disabled'] as const)(
    'dependency %s is never advertised healthy',
    async (state) => {
      const dependencies = ports();
      dependencies.checkPrivateDependency = () => Promise.resolve(state);
      expect(await checkRuntimeReadiness(input(), dependencies)).toMatchObject({
        state: state === 'degraded' ? 'degraded' : 'unavailable',
      });
    },
  );

  test('a never-settling dependency times out under the supplied bound', async () => {
    const dependencies = ports();
    dependencies.readSchemaRevision = async () => new Promise<string>(() => undefined);
    const pending = checkRuntimeReadiness(input(), dependencies);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ state: 'unavailable', reasonCode: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(['latest', '', 'C'.repeat(40)])(
    'invalid revision %s fails before probing',
    async (badRevision) => {
      const dependencies = ports();
      expect(
        await checkRuntimeReadiness({ ...input(), revision: badRevision }, dependencies),
      ).toMatchObject({ state: 'unavailable', reasonCode: 'configuration_invalid' });
      expect(dependencies.readSchemaRevision).not.toHaveBeenCalled();
    },
  );

  test('heartbeats reject stale, future, malformed or extra-field evidence', () => {
    const heartbeat = { state: 'healthy', checkedAt: at.toISOString() };
    expect(isRuntimeHeartbeatFresh(heartbeat, at, 500)).toBe(true);
    expect(isRuntimeHeartbeatFresh(heartbeat, new Date(at.getTime() + 500), 500)).toBe(false);
    expect(isRuntimeHeartbeatFresh(heartbeat, new Date(at.getTime() - 1), 500)).toBe(false);
    expect(
      isRuntimeHeartbeatFresh({ ...heartbeat, body: 'synthetic_unapproved_content' }, at, 500),
    ).toBe(false);
    expect(
      isRuntimeHeartbeatFresh({ state: 'unknown', checkedAt: at.toISOString() }, at, 500),
    ).toBe(false);
    expect(isRuntimeHeartbeatFresh({ state: 'healthy', checkedAt: 'invalid' }, at, 500)).toBe(
      false,
    );
  });
});
