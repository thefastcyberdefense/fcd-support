import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { expect, test } from 'vitest';
import { buildApp } from '../src/app.js';

test.each(
  [[], ['invalid', '--synthetic-only'], ['a'.repeat(40), '--production']].map((args) => ({ args })),
)(
  'synthetic host runner refuses invalid arguments before host or Docker access: %j',
  ({ args }) => {
    const result = spawnSync(
      process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
      ['scripts/test-synthetic-runtime-deployment.sh', ...args],
      { encoding: 'utf8', timeout: 5000 },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('synthetic_host_arguments_invalid\n');
  },
);

test.each(['--ephemeral-ci', '--ephemeral-ci-precreated'])(
  'ephemeral host mode %s refuses outside an explicit GitHub Actions context',
  (mode) => {
    const result = spawnSync(
      process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
      ['scripts/test-synthetic-runtime-deployment.sh', 'a'.repeat(40), mode],
      { encoding: 'utf8', timeout: 5000, env: { ...process.env, GITHUB_ACTIONS: 'false' } },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('synthetic_host_ci_context_invalid\n');
  },
);

test('actual host HTTP probe exercises JSON signature rejection without admitting work', async () => {
  const source = await readFile('scripts/test-synthetic-runtime-deployment.sh', 'utf8');
  const probe = /docker exec "\$peer" node --input-type=module -e '([^']+)'/u.exec(source)?.[1];
  if (probe === undefined) throw new Error('synthetic_probe_missing');
  let received = 0;
  const statuses: number[] = [];
  const app = buildApp({
    metaAppSecret: 'synthetic_host_probe_secret',
    metaVerifyToken: 'synthetic_host_probe_verifier',
    receiptSink: () => {
      received++;
      return Promise.resolve();
    },
  });
  try {
    const result: unknown = runInNewContext(`(async () => {${probe}})()`, {
      AbortSignal,
      fetch: async (url: string, init?: RequestInit) => {
        const response = await app.inject({
          method: init?.method === 'POST' ? 'POST' : 'GET',
          url: new URL(url).pathname,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          ...(typeof init?.body !== 'string' ? {} : { payload: init.body }),
        });
        statuses.push(response.statusCode);
        return { status: response.statusCode };
      },
      process: {
        exit: () => {
          throw new Error('synthetic_probe_failed');
        },
      },
    });
    await expect(result).resolves.toBeUndefined();
    expect(statuses).toEqual([403, 404, 401]);
    expect(received).toBe(0);
  } finally {
    await app.close();
  }
});
