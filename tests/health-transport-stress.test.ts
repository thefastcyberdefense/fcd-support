import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { readHealthInput } from '../src/operations/health-main.js';

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
      expect(stream.destroyed).toBe(false);
      stream.destroy();
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

describe('actual scheduled lifecycle, attached health transport and extracted CI trace', () => {
  async function runTrace(
    logs: string,
    logsExit: number,
    envOverrides: Record<string, string> = {},
  ) {
    const source = await readFile('scripts/test-synthetic-runtime-deployment.sh', 'utf8');
    const entry = /<<'TRACE'\r?\n([\s\S]*?)\r?\nTRACE/u.exec(source)?.[1];
    if (entry === undefined) throw new Error('synthetic_trace_entry_missing');
    const trace = entry.replaceAll('\r', '').split('\n').slice(1).join('\n');
    const script = `set -Eeuo pipefail
source "$TASK_LIFECYCLE"
operations_config_field() { return 0; }
operations_job_state_root() { OPS_JOB_STATE_FILE=/synthetic-review-absent; }
operations_job_state_begin() { return 0; }
operations_job_state_sync() { return 0; }
operations_job_state_transition() {
  case "$2" in created|started|uncertain|completed) printf 'synthetic_state=%s\\n' "$2" >&4 ;; *) exit 1 ;; esac
}
operations_job_state_read() { declare -gA OPS_JOB_STATE=([JOB_CONTAINER]="$OPS_JOB_CONTAINER"); }
operations_fail() { exit 1; }
operations_job_override() { return 0; }
operations_job_create_stopped() { return 0; }
operations_job_discover() { [[ "\${review_actor_removed-}" != true ]] || return 0; printf '%064d\\n' 1; }
operations_job_assert_container() { return 0; }

# Keep the real acknowledgement validator, and exit before any file cleanup.
validator="$(declare -f operations_job_acknowledgement)"
eval "\${validator/operations_job_acknowledgement/review_validate_ack}"
operations_job_acknowledgement() { review_validate_ack "$@" || return; exit 0; }
timeout() { return 0; }
od() { printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'; }
operations_docker() {
 case "$1/$2" in
  image/inspect) printf 'sha256:%064d/%040d/linux/amd64\\n' 1 1 ;;
  container/start)
    cat >/dev/null
    printf 'synthetic_transport=attached_start\\n' >&4
    printf '%s' "\${TASK_ATTACHED_OUTPUT-}"
    [[ "\${TASK_ATTACH_NUL-}" != true ]] || printf '\\0'
    return "\${TASK_ATTACHED_EXIT:-0}" ;;
  container/wait) printf '0\\n' ;;
  container/inspect) printf '%s\\n' "\${TASK_EXIT_STATE:-exited/0}" ;;
  container/stop) printf 'synthetic_containment=stop\\n' >&4 ;;
  container/rm) review_actor_removed=true; printf 'synthetic_containment=remove\\n' >&4 ;;
  container/logs) printf 'synthetic_transport=daemon_logs\\n' >&4; printf '%s' "$TASK_LOGS"; return "$TASK_LOGS_EXIT" ;;
  *) return 19 ;;
 esac
}
declare -A OPS_CONFIG=([FCD_SUPPORT_REVISION]=$(printf '%040d' 1) [FCD_RUNTIME_PROJECT]=synthetic [FCD_STATE_ROOT]=/synthetic-review-absent [FCD_OPERATIONS_IMAGE]=synthetic [FCD_COMMAND_TIMEOUT_SECONDS]=5 [FCD_STOP_GRACE_MS]=2000 [FCD_POSTGRES_DB]=synthetic [FCD_DATABASE_SCHEMA]=public [FCD_DATABASE_ROLE_PREFIX]=synthetic [FCD_SCHEMA_REVISION]=000016)
OPS_DATABASE_SYSTEM_IDENTIFIER=7300000000000000000
OPS_HEALTH_INPUT_JSON='{}'
exec 3>&1 4>&1
${trace}
# Same command-substitution boundary used by the public scheduler.
acknowledgement="$(operations_execute_job health health)" || exit $?
printf 'synthetic_schedule=successor\\n' >&4
`;
    return spawnSync(bash, ['--noprofile', '--norc', '-c', script], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TASK_LIFECYCLE: resolve('scripts/operations-job-lifecycle.sh').replaceAll('\\', '/'),
        FCD_SYNTHETIC_EVIDENCE_LIBRARY: evidenceLibrary,
        FCD_RUNTIME_HOST_DIAGNOSTICS: 'closed-v1',
        TASK_LOGS: logs,
        TASK_LOGS_EXIT: String(logsExit),
        TASK_ATTACHED_OUTPUT: logs,
        TASK_ATTACHED_EXIT: String(logsExit),
        ...envOverrides,
      },
    });
  }
  test.each([
    ['{"status":"completed","processed":1,"reasonCode":"ok"}', 0, 'completed', 0],
    [
      '{"status":"completed","processed":0,"reasonCode":"dependency_unavailable"}',
      0,
      'dependency_unavailable',
      0,
    ],
    ['', 19, 'attach_nonzero:19', 1],
    ['', 0, 'empty', 1],
    ['synthetic_invalid', 0, 'unexpected', 1],
    ['line1\nline2', 0, 'multiple_lines', 1],
    ['line\r', 0, 'carriage_return', 1],
  ] as const)(
    'classifies actual lifecycle logs as %s / %s / %s',
    async (logs, logsExit, diagnostic, status) => {
      const result = await runTrace(logs, logsExit);
      expect(result.status).toBe(status);
      if (logsExit === 0)
        expect(result.stdout).toContain(`synthetic_health_ack_diagnostic=${diagnostic}\n`);
      else
        expect(result.stdout).toContain(
          `synthetic_health_attach_diagnostic=nonzero:${String(logsExit)}\n`,
        );
      if (logs === '' && logsExit === 0) {
        expect(result.stdout.match(/synthetic_transport=daemon_logs/gu)).toHaveLength(1);
        expect(result.stdout).toContain('synthetic_health_daemon_diagnostic=empty');
      } else expect(result.stdout).not.toContain('synthetic_transport=daemon_logs');
      if (logsExit === 0)
        expect(result.stdout).not.toContain('synthetic_health_ack_diagnostic=log_read_failed');
      if (logsExit !== 0)
        expect(result.stdout).not.toContain('synthetic_health_ack_diagnostic=completed');
      expect(result.stderr).toBe('');
      if (status === 1) {
        expect(result.stdout).toContain('synthetic_state=uncertain\n');
        expect(result.stdout).toContain('synthetic_containment=stop\n');
        expect(result.stdout).toContain('synthetic_containment=remove\n');
        expect(result.stdout).not.toContain('synthetic_schedule=successor');
        expect(result.stdout).not.toContain('synthetic_state=completed');
      } else {
        expect(result.stdout).toContain('synthetic_schedule=successor\n');
        expect(result.stdout).not.toContain('synthetic_state=uncertain');
      }
    },
  );

  test('observes producer daemon output after empty attachment without authorizing a fallback', async () => {
    const ack = '{"status":"completed","processed":1,"reasonCode":"ok"}';
    const result = await runTrace(ack, 0, { TASK_ATTACHED_OUTPUT: '' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('synthetic_health_daemon_diagnostic=completed\n');
    expect(result.stdout.match(/synthetic_transport=daemon_logs/gu)).toHaveLength(1);
    expect(result.stdout).toContain('synthetic_state=uncertain\n');
    expect(result.stdout).not.toContain('synthetic_schedule=successor');
    expect(result.stdout).not.toContain('synthetic_state=completed');
    expect(result.stdout.match(/synthetic_transport=attached_start/gu)).toHaveLength(1);
  });

  test.each([
    ['SYNTHETIC_PRIVATE_STDOUT', '0', 'unexpected'],
    ['SYNTHETIC_PRIVATE_STDOUT', '19', 'unobserved'],
    ['SYNTHETIC_' + 'X'.repeat(6000), '0', 'unobserved'],
  ])('bounds and suppresses daemon probe bodies %#', async (body, code, category) => {
    const result = await runTrace(body, 0, { TASK_ATTACHED_OUTPUT: '', TASK_LOGS_EXIT: code });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('synthetic_health_daemon_diagnostic=' + category);
    expect(result.stdout).not.toContain('SYNTHETIC_PRIVATE_STDOUT');
    expect(result.stdout).not.toContain('XXXX');
    expect(result.stdout).not.toContain('synthetic_schedule=successor');
  });
  test('inactive diagnostics perform no daemon observation after an empty attachment', async () => {
    const result = await runTrace('SYNTHETIC_PRIVATE_STDOUT', 0, {
      TASK_ATTACHED_OUTPUT: '',
      FCD_RUNTIME_HOST_DIAGNOSTICS: '',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('synthetic_transport=daemon_logs');
    expect(result.stdout).not.toContain('synthetic_health_daemon_diagnostic');
    expect(result.stdout).not.toContain('synthetic_schedule=successor');
  });

  test('suppresses health diagnostics when FCD_RUNTIME_HOST_DIAGNOSTICS is inactive', async () => {
    const result = await runTrace('{"status":"completed","processed":1,"reasonCode":"ok"}', 0, {
      FCD_RUNTIME_HOST_DIAGNOSTICS: '',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('synthetic_health_ack_diagnostic');
  });
  test('does not accept a captured acknowledgement before the final exit guard passes', async () => {
    const ack = '{"status":"completed","processed":1,"reasonCode":"ok"}';
    const result = await runTrace(ack, 0, {
      TASK_ATTACHED_OUTPUT: ack,
      TASK_EXIT_STATE: 'exited/19',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('synthetic_state=uncertain\n');
    expect(result.stdout).not.toContain('synthetic_schedule=successor');
    expect(result.stdout).not.toContain('synthetic_health_ack_diagnostic=completed');
    expect(result.stdout).not.toContain('synthetic_transport=daemon_logs');
  });
  test('rejects NUL in the attached wire frame before shell string normalization', async () => {
    const ack = '{"status":"completed","processed":1,"reasonCode":"ok"}';
    const result = await runTrace(ack, 0, { TASK_ATTACHED_OUTPUT: ack, TASK_ATTACH_NUL: 'true' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('synthetic_state=uncertain\n');
    expect(result.stdout).not.toContain('synthetic_schedule=successor');
    expect(result.stdout).not.toContain('synthetic_transport=daemon_logs');
  });
  test('retains the attached acknowledgement when later daemon logs are unavailable', async () => {
    const ack = '{"status":"completed","processed":1,"reasonCode":"ok"}';
    const result = await runTrace('', 19, {
      TASK_ATTACHED_OUTPUT: ack + '\n',
      TASK_ATTACHED_EXIT: '0',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('synthetic_schedule=successor\n');
    expect(result.stdout).not.toContain('synthetic_transport=daemon_logs');
    expect(result.stdout.match(/synthetic_transport=attached_start/gu)).toHaveLength(1);
  });
  test.each([
    '',
    'SYNTHETIC_INVALID_FRAME',
    'SYNTHETIC_' + 'A'.repeat(6000),
    '{"status":"completed","processed":1,"reasonCode":"ok"}' + '\n'.repeat(6000),
  ])(
    'never falls back to a daemon acknowledgement after invalid attached output %#',
    async (output) => {
      const ack = '{"status":"completed","processed":1,"reasonCode":"ok"}';
      const result = await runTrace(ack, 0, { TASK_ATTACHED_OUTPUT: output });
      expect(result.status).toBe(1);
      if (output === '') {
        expect(result.stdout.match(/synthetic_transport=daemon_logs/gu)).toHaveLength(1);
        expect(result.stdout).toContain('synthetic_health_daemon_diagnostic=completed');
      } else expect(result.stdout).not.toContain('synthetic_transport=daemon_logs');
      expect(result.stdout).not.toContain('synthetic_schedule=successor');
      expect(result.stdout).toContain('synthetic_state=uncertain\n');
      expect(result.stdout.match(/synthetic_transport=attached_start/gu)).toHaveLength(1);
    },
  );
});

test.each(['1', '19', '255', '0', '00', '-1', '256', '18446744073709551616', 'SYNTHETIC_INVALID'])(
  'attached capture diagnostics publish only bounded nonzero observed statuses %s',
  (status) => {
    const line = 'synthetic_health_attach_diagnostic=nonzero:' + status;
    const result = spawnSync(
      bash,
      ['-c', 'source "$TASK_LIBRARY"; synthetic_host_runtime_diagnostic "$TASK_LINE"'],
      {
        encoding: 'utf8',
        timeout: 3000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TASK_LIBRARY: evidenceLibrary,
          TASK_LINE: line,
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(['1', '19', '255'].includes(status) ? line + '\n' : '');
  },
);
