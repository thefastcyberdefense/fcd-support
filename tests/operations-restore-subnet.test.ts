import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import {
  inventoryAllowsRestoreSubnet,
  isValidRestoreSubnet,
} from '../scripts/operations-restore-subnet.js';

const routes = [{ dst: 'default' }, { dst: '192.0.2.0/24', table: 'main' }];
const interfaces = [{ addr_info: [{ family: 'inet', local: '192.0.2.40', prefixlen: 24 }] }];

test.each([
  ['10.0.0.0/8', true],
  ['172.16.0.0/12', true],
  ['192.168.4.0/29', true],
  ['198.18.224.0/24', true],
  ['198.18.224.1/24', false],
  ['198.018.224.0/24', false],
  ['198.18.224.0/30', false],
  ['198.18.224.0/024', false],
  ['198.20.0.0/16', false],
  ['172.15.0.0/16', false],
  ['172.32.0.0/16', false],
  ['203.0.113.0/24', false],
  ['0.0.0.0/0', false],
  ['10.0.0.0/7', false],
  ['10.256.0.0/16', false],
  ['::1/128', false],
] as const)('restore CIDR %s validity is %s', (cidr, valid) => {
  expect(isValidRestoreSubnet(cidr)).toBe(valid);
});

test('an unused private network is allowed while the default route is ignored', () => {
  expect(inventoryAllowsRestoreSubnet('198.18.224.0/24', routes, interfaces)).toBe(true);
  expect(inventoryAllowsRestoreSubnet('198.18.224.0/24', [{ dst: '0.0.0.0/0' }], interfaces)).toBe(
    true,
  );
});

test.each([
  [{ dst: '198.18.224.128/25', table: 42 }],
  [{ dst: '198.18.0.0/16', type: 'unreachable' }],
  [{ dst: '198.18.224.1', table: 'local' }],
])('a more specific, covering or host route in any table refuses', (extra) => {
  expect(inventoryAllowsRestoreSubnet('198.18.224.0/24', [...routes, extra], interfaces)).toBe(
    false,
  );
});

test('an overlapping interface network refuses even without a matching route', () => {
  const conflicting = [{ addr_info: [{ family: 'inet', local: '198.18.224.3', prefixlen: 26 }] }];
  expect(inventoryAllowsRestoreSubnet('198.18.224.0/24', routes, conflicting)).toBe(false);
});

test.each([
  [null, interfaces],
  [[], interfaces],
  [[null], interfaces],
  [[{}], interfaces],
  [[{ dst: 'not-an-ip' }], interfaces],
  [routes, null],
  [routes, []],
  [routes, [{ addr_info: [] }]],
  [routes, [{ addr_info: [{ family: 'inet', local: '198.18.224.1', prefixlen: 99 }] }]],
  [routes, [{ addr_info: [{ family: 'inet', local: 'not-an-ip', prefixlen: 24 }] }]],
])('missing or malformed host inventory refuses', (routeInventory, interfaceInventory) => {
  expect(inventoryAllowsRestoreSubnet('198.18.224.0/24', routeInventory, interfaceInventory)).toBe(
    false,
  );
});

test.runIf(process.platform === 'linux').each([
  ['valid', 0],
  ['route-conflict', 1],
  ['interface-conflict', 1],
  ['malformed', 1],
  ['failed', 1],
  ['missing', 1],
  ['oversized', 1],
  ['timeout', 1],
] as const)(
  'host CLI handles %s inventory with closed output',
  async (scenario, status) => {
    const base =
      process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only'
        ? '/var/lib/fcd-support/backups'
        : tmpdir();
    const root = await mkdtemp(join(base, 'fcd-subnet-inventory-'));
    try {
      if (scenario !== 'missing')
        await writeFile(
          join(root, 'ip'),
          `#!/bin/sh
case '${scenario}' in
  failed) exit 1 ;;
  malformed) printf '%s' malformed; exit 0 ;;
  oversized) printf '%01048577d' 0; exit 0 ;;
  timeout) exec sleep 10 ;;
esac
case "$3" in
  route)
    if [ '${scenario}' = route-conflict ]; then printf '%s' '[{"dst":"198.18.224.0/24"}]'; else printf '%s' '[{"dst":"default"}]'; fi ;;
  address)
    if [ '${scenario}' = interface-conflict ]; then printf '%s' '[{"addr_info":[{"family":"inet","local":"198.18.224.1","prefixlen":24}]}]'; else printf '%s' '[{"addr_info":[{"family":"inet","local":"192.0.2.1","prefixlen":24}]}]'; fi ;;
  *) exit 1 ;;
esac
`,
          { mode: 0o700 },
        );
      const result = spawnSync(
        process.execPath,
        [resolve('scripts/operations-restore-subnet.ts'), '198.18.224.0/24'],
        {
          encoding: 'utf8',
          env: {
            PATH: scenario === 'missing' ? root : `${root}${delimiter}${process.env.PATH ?? ''}`,
          },
          timeout: 12_000,
        },
      );
      expect(result.status, result.error?.message).toBe(status);
      expect(result.stdout).toBe(status === 0 ? 'restore_subnet_safe\n' : '');
      expect(result.stderr).toBe(status === 0 ? '' : 'restore_subnet_refused\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);

test.runIf(process.platform === 'linux').each([
  ['safe', 0],
  ['overlap', 1],
] as const)(
  'restore controller invokes the actual subnet preflight for %s routes',
  async (kind, status) => {
    const base =
      process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only'
        ? '/var/lib/fcd-support/backups'
        : tmpdir();
    const root = await mkdtemp(join(base, 'fcd-subnet-controller-'));
    try {
      await writeFile(
        join(root, 'ip'),
        `#!/bin/sh
case "$3" in
  route) printf '%s' '${kind === 'safe' ? '[{"dst":"default"}]' : '[{"dst":"198.18.224.0/24"}]'}' ;;
  address) printf '%s' '[{"addr_info":[{"family":"inet","local":"192.0.2.1","prefixlen":24}]}]' ;;
  *) exit 1 ;;
esac
`,
        { mode: 0o700 },
      );
      const result = spawnSync(
        '/bin/bash',
        [
          '--noprofile',
          '--norc',
          '-c',
          'source "$TASK_COMMON"; source "$TASK_LIBRARY"; declare -A OPS_CONFIG=([FCD_RESTORE_SUBNET]=198.18.224.0/24 [FCD_COMMAND_TIMEOUT_SECONDS]=10 [FCD_STOP_GRACE_MS]=1000); OPS_ROOT="$TASK_ROOT"; operations_restore_subnet_preflight',
        ],
        {
          encoding: 'utf8',
          env: {
            PATH: `${root}${delimiter}${process.env.PATH ?? ''}`,
            TASK_COMMON: resolve('scripts/operations-common.sh'),
            TASK_LIBRARY: resolve('scripts/operations-restore-controller.sh'),
            TASK_ROOT: resolve('.'),
          },
          timeout: 15_000,
        },
      );
      expect(result.status, result.error?.message).toBe(status);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);
