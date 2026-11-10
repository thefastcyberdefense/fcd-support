import {
  promotionHostStabilityDiagnostics,
  PromotionHostValidationError,
} from '../src/operations/promotion-host.js';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const codes = [
  'samples.stability.source_terminal.startedAt',
  'samples.stability.target_terminal.restartCount',
  'samples.stability.before_after.source.postgres.startedAt',
  'samples.stability.before_after.hostBinds',
];
function publish(code: string, active = true) {
  return spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
    [
      '-c',
      'source "$TASK_HOST"; source "$TASK_LIBRARY"; operations_promotion_host_diagnostic "$TASK_CODE" 3>&1; if [[ "$TASK_ACTIVE" == true ]]; then synthetic_host_runtime_diagnostic "$TASK_CODE"; fi',
    ],
    {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_HOST: resolve('scripts/operations-promotion-host.sh').replaceAll('\\', '/'),
        TASK_LIBRARY: resolve('scripts/synthetic-host-evidence.sh').replaceAll('\\', '/'),
        TASK_CODE: 'runtime_host_diagnostic=' + code,
        TASK_ACTIVE: String(active),
        FCD_RUNTIME_HOST_DIAGNOSTICS: active ? 'closed-v1' : '',
      },
    },
  );
}
test.each(codes)('production and CI publish only the fixed stability token %s', (code) => {
  const result = publish(code);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe(('runtime_host_diagnostic=' + code + '\n').repeat(2));
});
test.each([
  'samples.stability.source_terminal.unknown',
  'samples.stability.source_terminal.SYNTHETIC_FORBIDDEN.startedAt',
  'samples.stability.before_after.source.postgres.startedAt.SYNTHETIC_FORBIDDEN',
  'samples.stability.before_after.hostBinds.SYNTHETIC_FORBIDDEN',
  'samples.stability.before_after.jobEnvironment.SYNTHETIC_FORBIDDEN',
])('drops unknown paths without leaking supplied text %s', (code) => {
  const result = publish(code);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
});
test('production stability publication remains disabled without closed-v1', () => {
  const result = publish(codes[0] ?? '', false);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
});

test('all finite producer stability codes round-trip through both shell publication filters', () => {
  expect(promotionHostStabilityDiagnostics.length).toBeGreaterThan(0);
  expect(new Set(promotionHostStabilityDiagnostics).size).toBe(
    promotionHostStabilityDiagnostics.length,
  );
  const lines = promotionHostStabilityDiagnostics.map((code) => {
    expect(new PromotionHostValidationError(code).diagnosticCode).toBe(code);
    expect(('runtime_host_diagnostic=' + code).length).toBeLessThanOrEqual(128);
    return 'runtime_host_diagnostic=' + code;
  });
  const result = spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
    [
      '-c',
      'source "$TASK_HOST"; source "$TASK_LIBRARY"; while IFS= read -r code; do operations_promotion_host_diagnostic "$code" 3>&1; synthetic_host_runtime_diagnostic "$code"; done',
    ],
    {
      encoding: 'utf8',
      input: lines.join('\n') + '\n',
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_HOST: resolve('scripts/operations-promotion-host.sh').replaceAll('\\', '/'),
        TASK_LIBRARY: resolve('scripts/synthetic-host-evidence.sh').replaceAll('\\', '/'),
        FCD_RUNTIME_HOST_DIAGNOSTICS: 'closed-v1',
      },
    },
  );
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe(lines.flatMap((line) => [line, line]).join('\n') + '\n');
});
test('validator never forwards a supplied private map key or unknown path', () => {
  const code = 'samples.stability.before_after.jobEnvironment.SYNTHETIC_PRIVATE_MAP_KEY';
  expect(new PromotionHostValidationError(code).diagnosticCode).toBe('validation');
});
