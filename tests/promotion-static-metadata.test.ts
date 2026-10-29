import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';

const header =
  '1111111111111111111111111111111111111111111111111111111111111111/sha256:2222222222222222222222222222222222222222222222222222222222222222/["postgres"]/[]["default"]/true/false/0/false/[]/[]/[]/0/0/0/"default"/"default"/default/3333333333333333333333333333333333333333333333333333333333333333;';

const mountA = JSON.stringify({
  Destination: '/var/lib/postgresql',
  Driver: 'local',
  Mode: 'rw',
  Name: 'fcd-support-data',
  Propagation: '',
  RW: true,
  Source: '/var/lib/docker/volumes/fcd-support-data/_data',
  Type: 'volume',
});

const mountB = JSON.stringify({
  Destination: '/run/secrets/pg-password',
  Driver: 'local',
  Mode: 'ro',
  Name: '',
  Propagation: 'rprivate',
  RW: false,
  Source: '/run/fcd-secrets/pg-password',
  Type: 'bind',
});

const mountC = JSON.stringify({
  Destination: '/etc/postgresql/custom.conf',
  Driver: 'local',
  Mode: 'ro',
  Name: '',
  Propagation: '',
  RW: false,
  Source: '/run/fcd-config/custom.conf',
  Type: 'bind',
});

function canonicalize(input: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    bash,
    [
      '--noprofile',
      '--norc',
      '-c',
      `
source "$TASK_COMMON"
source "$TASK_CONTROLLER"
operations_promotion_static_canonical "$TASK_INPUT"
`,
    ],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_COMMON: resolve('scripts/operations-common.sh').replaceAll('\\', '/'),
        TASK_CONTROLLER: resolve('scripts/operations-promotion-controller.sh').replaceAll(
          '\\',
          '/',
        ),
        TASK_INPUT: input,
      },
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('operations_promotion_static_canonical', { timeout: 30_000 }, () => {
  test('normalizes reordered mount records into identical canonical output', () => {
    const s1 = `${header}\n${mountA}\n${mountB}\n`;
    const s2 = `${header}\n${mountB}\n${mountA}\n`;
    const r1 = canonicalize(s1);
    const r2 = canonicalize(s2);
    expect(r1.status).toBe(0);
    expect(r2.status).toBe(0);
    expect(r1.stdout).toBe(r2.stdout);
    const lines = r1.stdout.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(header);
  });

  test('canonicalizes all permutations of 3 mounts identically', () => {
    const perms = [
      [mountA, mountB, mountC],
      [mountA, mountC, mountB],
      [mountB, mountA, mountC],
      [mountB, mountC, mountA],
      [mountC, mountA, mountB],
      [mountC, mountB, mountA],
    ];
    const canonicals = perms.map((p) => {
      const res = canonicalize(`${header}\n${p.join('\n')}\n`);
      expect(res.status).toBe(0);
      return res.stdout;
    });
    for (let i = 1; i < canonicals.length; i++) {
      expect(canonicals[i]).toBe(canonicals[0]);
    }
  });

  test('preserves complete raw mount fields and distinguishes mutations', () => {
    const base = `${header}\n${mountA}\n${mountB}\n`;
    const canonicalBase = canonicalize(base).stdout;

    const mutations: Record<string, string> = {
      Destination: JSON.stringify({ ...JSON.parse(mountA), Destination: '/other' }),
      Driver: JSON.stringify({ ...JSON.parse(mountA), Driver: 'custom' }),
      Mode: JSON.stringify({ ...JSON.parse(mountA), Mode: 'ro' }),
      Name: JSON.stringify({ ...JSON.parse(mountA), Name: 'fcd-other-data' }),
      Propagation: JSON.stringify({ ...JSON.parse(mountA), Propagation: 'rshared' }),
      RW: JSON.stringify({ ...JSON.parse(mountA), RW: false }),
      Source: JSON.stringify({ ...JSON.parse(mountA), Source: '/var/lib/docker/other/_data' }),
      Type: JSON.stringify({ ...JSON.parse(mountA), Type: 'bind' }),
      UnknownField: JSON.stringify({ ...JSON.parse(mountA), ExtraField: 'synthetic_unknown' }),
    };

    for (const [field, mutatedMount] of Object.entries(mutations)) {
      const mutatedInput = `${header}\n${mutatedMount}\n${mountB}\n`;
      const res = canonicalize(mutatedInput);
      expect(res.status).toBe(0);
      expect(res.stdout, `Mutation of ${field} should alter canonical static fact`).not.toBe(
        canonicalBase,
      );
    }
  });

  test('preserves duplicate mount multiplicity without sort -u deduplication', () => {
    const single = `${header}\n${mountA}\n`;
    const duplicate = `${header}\n${mountA}\n${mountA}\n`;
    const rSingle = canonicalize(single);
    const rDuplicate = canonicalize(duplicate);
    expect(rSingle.status).toBe(0);
    expect(rDuplicate.status).toBe(0);
    expect(rDuplicate.stdout).not.toBe(rSingle.stdout);
    const lines = rDuplicate.stdout.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(mountA);
    expect(lines[2]).toBe(mountA);
  });

  test('detects extra or missing mount entries', () => {
    const two = `${header}\n${mountA}\n${mountB}\n`;
    const three = `${header}\n${mountA}\n${mountB}\n${mountC}\n`;
    const one = `${header}\n${mountA}\n`;
    const rTwo = canonicalize(two);
    const rThree = canonicalize(three);
    const rOne = canonicalize(one);
    expect(rTwo.status).toBe(0);
    expect(rThree.status).toBe(0);
    expect(rOne.status).toBe(0);
    expect(rThree.stdout).not.toBe(rTwo.stdout);
    expect(rOne.stdout).not.toBe(rTwo.stdout);
  });

  test('preserves exact header field order and distinguishes reordered commands', () => {
    const base = `${header}\n${mountA}\n${mountB}\n`;
    const canonicalBase = canonicalize(base).stdout;

    const reorderedCmdHeader = header.replace('["postgres"]', '["arg","postgres"]');
    const invertedCmdHeader = header.replace('["postgres"]', '["postgres","arg"]');

    const res1 = canonicalize(`${reorderedCmdHeader}\n${mountA}\n${mountB}\n`);
    const res2 = canonicalize(`${invertedCmdHeader}\n${mountA}\n${mountB}\n`);
    expect(res1.status).toBe(0);
    expect(res2.status).toBe(0);
    expect(res1.stdout).not.toBe(canonicalBase);
    expect(res2.stdout).not.toBe(res1.stdout);
  });

  test.each([
    ['empty input', ''],
    [
      'malformed mount framing - missing closing brace',
      `${header}\n{"Destination":"/var/lib"}\n{"Destination":"/bad"\n`,
    ],
    ['malformed mount framing - not JSON', `${header}\nnot_a_json_object\n`],
    ['empty line between mounts', `${header}\n${mountA}\n\n${mountB}\n`],
  ])('refuses %s', (_, badInput) => {
    const res = canonicalize(badInput);
    expect(res.status).toBe(1);
  });
});
