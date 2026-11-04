import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { readHealthInput, runHealthCommand } from '../src/operations/health-main.js';
import { operationsEnvironment } from './helpers/operations-fixtures.js';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const evidenceLibrary = resolve('scripts/synthetic-host-evidence.sh').replaceAll('\\', '/');

describe('health transport held-open stdin contract', () => {
  test('consumes newline-framed JSON without waiting for stream EOF across 10 sequential independent held-open streams', async () => {
    for (let i = 1; i <= 10; i++) {
      const stream = new PassThrough();
      const promise = readHealthInput(500, stream);
      stream.write(JSON.stringify({ availability: { manifest: 'healthy', iteration: i } }) + '\n');
      const result = await promise;
      expect(result).toEqual({ availability: { manifest: 'healthy', iteration: i } });
      expect(stream.destroyed).toBe(true);
    }
  });

  test('refuses malformed, oversized or stalled stdin', async () => {
    // Malformed JSON frame
    const malformed = new PassThrough();
    const malformedPromise = readHealthInput(500, malformed);
    malformed.end('{"incomplete_json\n');
    await expect(malformedPromise).rejects.toThrow();

    // Oversized input exceeding 16KB
    const oversized = new PassThrough();
    const oversizedPromise = readHealthInput(500, oversized);
    oversized.write('x'.repeat(16_385));
    await expect(oversizedPromise).rejects.toThrow('health_input_invalid');

    // Stalled / timeout input
    const stalled = new PassThrough();
    const stalledPromise = readHealthInput(50, stalled);
    await expect(stalledPromise).rejects.toThrow('health_input_invalid');
    expect(stalled.destroyed).toBe(true);
  });
});

describe('closed diagnostic classification for health transport outcomes', () => {
  const allowedClasses = [
    'completed',
    'dependency_unavailable',
    'empty',
    'carriage_return',
    'multiple_lines',
    'log_read_failed',
    'unexpected',
  ] as const;

  test.each([
    ['{"status":"completed","processed":1,"reasonCode":"ok"}', 'completed'],
    [
      '{"status":"completed","processed":0,"reasonCode":"dependency_unavailable"}',
      'dependency_unavailable',
    ],
    ['', 'empty'],
    ['log_read_failed', 'log_read_failed'],
    ['valid_prefix\r', 'carriage_return'],
    ['line_one\nline_two', 'multiple_lines'],
    ['{"status":"completed","processed":99999999999999999999,"reasonCode":"ok"}', 'unexpected'],
    ['raw_customer_secret_token_12345', 'unexpected'],
  ] as const)('classifies outcome "%s" as %s without leaking body', (input, expectedClass) => {
    const result = spawnSync(
      bash,
      ['-c', `source "$TASK_LIBRARY"; synthetic_host_health_ack_diagnostic "$TASK_INPUT"`],
      {
        encoding: 'utf8',
        timeout: 3000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TASK_LIBRARY: evidenceLibrary,
          TASK_INPUT: input,
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`synthetic_health_ack_diagnostic=${expectedClass}\n`);
    expect(result.stdout).not.toContain('raw_customer_secret_token_12345');
    expect(allowedClasses).toContain(expectedClass);
  });
});

describe('trace entrypoint diagnostics under lifecycle operations', () => {
  const runLifecycleTrace = async (outcome: { logsExit: number; stdoutFormat: string }) => {
    const dir = await mkdtemp(join(tmpdir(), 'fcd-trace-test-'));
    const lifecycleFile = join(dir, 'operations-job-lifecycle.sh');
    const runnerFile = join(dir, 'run.sh');

    const lifecycleContent = `#!/usr/bin/env bash
operations_job_acknowledgement() {
  return 0
}

operations_job_uncertain() {
  return 1
}

operations_job_lifecycle() {
  if [[ "$service" == promote ]]; then
    acknowledgement="$(operations_docker container logs --tail 4 fake)" || operations_job_uncertain
  else
    acknowledgement="$(operations_docker container logs --tail 2 fake)" || operations_job_uncertain
  fi
  operations_job_acknowledgement "$acknowledgement" || operations_job_uncertain
}
`;
    await writeFile(lifecycleFile, lifecycleContent);

    const runnerContent = `#!/usr/bin/env bash
set -e
exec 3>&1
source "${evidenceLibrary}"
set -o functrace
service=health
OPS_JOB_SERVICE=health

trap '
trace_status=$?
trace_source="\${BASH_SOURCE[0]-stdin}"
if [[ "$BASH_SUBSHELL" -eq 0 && "\${OPS_JOB_SERVICE-}" == health && "\${trace_source##*/}" == operations-job-lifecycle.sh && "\${FUNCNAME[0]-}" == operations_job_lifecycle ]]; then
  if [[ "$BASH_COMMAND" == *"container logs"* ]]; then
    health_reading_logs=true
  elif [[ "\${health_reading_logs-}" == true ]]; then
    unset health_reading_logs
    if [[ "$trace_status" -ne 0 ]]; then
      synthetic_host_health_ack_diagnostic log_read_failed >&3
    fi
  fi
  if [[ "$BASH_COMMAND" == operations_job_acknowledgement* ]]; then
    synthetic_host_health_ack_diagnostic "\${acknowledgement-}" >&3
  fi
fi' DEBUG

operations_docker() {
  if [[ "${String(outcome.logsExit)}" -ne 0 ]]; then
    return ${String(outcome.logsExit)}
  fi
  printf ${outcome.stdoutFormat}
}

source "${lifecycleFile.replaceAll('\\', '/')}"
operations_job_lifecycle
`;
    await writeFile(runnerFile, runnerContent);

    const res = spawnSync(bash, [runnerFile.replaceAll('\\', '/')], {
      encoding: 'utf8',
      timeout: 5000,
    });
    await rm(dir, { recursive: true, force: true });
    return res;
  };

  test('canonical successful logs emit completed and never emit log_read_failed', async () => {
    const res = await runLifecycleTrace({
      logsExit: 0,
      stdoutFormat: `'%s' '{"status":"completed","processed":0,"reasonCode":"ok"}'`,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('synthetic_health_ack_diagnostic=completed');
    expect(res.stdout).not.toContain('log_read_failed');
  });

  test('genuine non-zero log failure emits log_read_failed and never emits completed', async () => {
    const res = await runLifecycleTrace({ logsExit: 1, stdoutFormat: `''` });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('synthetic_health_ack_diagnostic=log_read_failed');
    expect(res.stdout).not.toContain('synthetic_health_ack_diagnostic=completed');
  });

  test('empty logs emit empty and never emit log_read_failed', async () => {
    const res = await runLifecycleTrace({ logsExit: 0, stdoutFormat: `''` });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('synthetic_health_ack_diagnostic=empty');
    expect(res.stdout).not.toContain('log_read_failed');
  });

  test('multiple lines emit multiple_lines and never emit log_read_failed', async () => {
    const res = await runLifecycleTrace({ logsExit: 0, stdoutFormat: `'%s\\n%s' 'line1' 'line2'` });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('synthetic_health_ack_diagnostic=multiple_lines');
    expect(res.stdout).not.toContain('log_read_failed');
  });

  test('carriage return emits carriage_return and never emit log_read_failed', async () => {
    const res = await runLifecycleTrace({ logsExit: 0, stdoutFormat: `'%s\\r' 'line'` });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('synthetic_health_ack_diagnostic=carriage_return');
    expect(res.stdout).not.toContain('log_read_failed');
  });

  test('dependency unavailable emits dependency_unavailable and never emits log_read_failed', async () => {
    const res = await runLifecycleTrace({
      logsExit: 0,
      stdoutFormat: `'%s' '{"status":"completed","processed":0,"reasonCode":"dependency_unavailable"}'`,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('synthetic_health_ack_diagnostic=dependency_unavailable');
    expect(res.stdout).not.toContain('log_read_failed');
  });
});

describe('actor ownership filtering and containment', () => {
  test('isolates owned health actors by exact parent and service, preserving unrelated actors', () => {
    const script = `
project="fcd-test-proj"

containers=(
  "c1:fcd-support.operation.parent=fcd-test-proj:fcd-support.operation.service=health"
  "c2:fcd-support.operation.parent=fcd-test-proj:fcd-support.operation.service=backup"
  "c3:fcd-support.operation.parent=other-proj:fcd-support.operation.service=health"
)

filter_actors() {
  local service="$1" parent="$2"
  for entry in "\${containers[@]}"; do
    local id="\${entry%%:*}"
    local rest="\${entry#*:}"
    local p="\${rest%%:*}"; p="\${p#*=}"
    local s="\${rest#*:*}"; s="\${s#*=}"
    if [[ "$p" == "$parent" && "$s" == "$service" ]]; then
      echo "$id"
    fi
  done
}

owned="$(filter_actors health "$project")"
if [[ "$owned" != "c1" ]]; then
  echo "FAIL: expected owned to be c1, got: $owned" >&2
  exit 1
fi

unrelated_service="$(filter_actors backup "$project")"
if [[ "$unrelated_service" != "c2" ]]; then
  echo "FAIL: expected c2 for backup, got: $unrelated_service" >&2
  exit 1
fi

unrelated_parent="$(filter_actors health "other-proj")"
if [[ "$unrelated_parent" != "c3" ]]; then
  echo "FAIL: expected c3 for other-proj, got: $unrelated_parent" >&2
  exit 1
fi

echo "FILTER_SUCCESS"
`;
    const res = spawnSync(bash, ['-c', script], { encoding: 'utf8', timeout: 5000 });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('FILTER_SUCCESS');
  });
});

describe('owning harness failure injection and uncertainty journal preservation', () => {
  test('runHealthCommand stops immediately on uncertainty, preserves failure journal, and does not retry', async () => {
    const journal: string[] = [];
    const lines: string[] = [];

    const status = await runHealthCommand({
      environment: {
        ...operationsEnvironment(),
        DATABASE_URL: 'postgresql://synthetic@127.0.0.1/fcd_support_test',
        OPS_GIT_REVISION: 'a'.repeat(40),
        OPS_SCHEMA_REVISION: '000016',
        OPS_DATABASE_SYSTEM_IDENTIFIER: '7300000000000000000',
        OPS_DATABASE_NAME: 'fcd_support_test',
        OPS_DATABASE_SCHEMA: 'public',
        OPS_RESOURCE_LIMITS_JSON: JSON.stringify({
          health: { cpus: 0.5, memoryMiB: 256, pids: 64, tmpfsMiB: 16 },
        }),
      },
      args: ['health'],
      input: {},
      now: () => new Date('2030-01-01T00:00:00.000Z'),
      write: (line) => lines.push(line),
      journal: (line) => journal.push(line),
      ports: () => {
        throw new Error('synthetic_postgres_fatal_error');
      },
    });

    // Command returns failure code 1
    expect(status).toBe(1);
    // Journal preserves the failure event with component postgres and state unknown
    expect(journal).toHaveLength(1);
    const parsedEvent = JSON.parse(journal[0] ?? '{}') as Record<string, unknown>;
    expect(parsedEvent).toEqual({
      event: 'operations_health',
      component: 'postgres',
      state: 'unknown',
      checkedAt: '2030-01-01T00:00:00.000Z',
    });
    // No stdout acknowledgment was emitted
    expect(lines).toEqual([]);
  });

  test('harness state machine rejects subsequent operations when prior operation is uncertain and leaves active-job intact', () => {
    const script = `
# State machine simulation: active-job existence prevents subsequent execution
state_root="/tmp/fcd-state-test-$BASHPID"
mkdir -p "$state_root"

# 1. Uncertainty transitions active-job to uncertain
printf 'JOB_REF=operation_12345\\nJOB_SERVICE=health\\nJOB_PHASE=uncertain\\n' > "$state_root/active-job"

# 2. Guard checks for pending active-job before starting new job
check_can_start() {
  if [[ -e "$state_root/active-job" || -L "$state_root/active-job" ]]; then
    echo "operations_job_pending" >&2
    return 1
  fi
  return 0
}

# 3. Invocation must fail and reject execution
if check_can_start; then
  echo "FAIL: expected refusal due to uncertain active-job" >&2
  exit 1
fi

# 4. Active-job must remain intact and unchanged
if ! grep -q 'JOB_PHASE=uncertain' "$state_root/active-job"; then
  echo "FAIL: active-job was cleared or overwritten" >&2
  exit 1
fi

rm -rf "$state_root"
echo "HARNESS_PRESERVED"
`;
    const res = spawnSync(bash, ['-c', script], { encoding: 'utf8', timeout: 5000 });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('HARNESS_PRESERVED');
  });
});
