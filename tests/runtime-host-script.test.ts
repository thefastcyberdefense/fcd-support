import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

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
