import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { restoreTargetIdentitySchema } from '../src/persistence/postgres-restore-evidence.js';

test.each([
  { value: '2030-04-01T06:00:00+06:00', valid: true },
  { value: '2030-04-01T00:00:00Z', valid: true },
  { value: '2030-03-31T20:30:00.123456789-03:30', valid: true },
  { value: '2030-04-01T00:00:00+24:00', valid: false },
  { value: '2030-04-01T00:00:00+00:60', valid: false },
  { value: '2030-04-01T00:00:00.1234567890Z', valid: false },
  { value: '2030-04-01T00:00:00', valid: false },
  { value: '2030-04-01T00:00Z', valid: false },
])('Docker volume timestamp keeps bounded RFC3339 text: $value', ({ value, valid }) => {
  const parsed = restoreTargetIdentitySchema.shape.volumeCreatedAt.safeParse(value);
  expect(parsed.success).toBe(valid);
  if (parsed.success) expect(parsed.data).toBe(value);
  const result = spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      'source "$TASK_LIBRARY"; operations_deployment_field STATE_VOLUME_CREATED_AT "$TASK_VALUE"',
    ],
    {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_LIBRARY: resolve('scripts/operations-deployment-state.sh').replaceAll('\\', '/'),
        TASK_VALUE: value,
      },
    },
  );
  expect(result.status).toBe(valid ? 0 : 1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
});
