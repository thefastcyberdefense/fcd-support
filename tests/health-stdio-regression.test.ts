import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { operationsEnvironment } from './helpers/operations-fixtures.js';
import {
  reapChildProcess,
  reapChildProcesses,
  waitForBarrier,
  waitForExit,
} from './helpers/process-lifecycle.js';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const healthEntry = existsSync('/app/dist/operations/health-main.js')
  ? '/app/dist/operations/health-main.js'
  : resolve('dist/operations/health-main.js');
const commonLibrary = resolve('scripts/operations-common.sh').replaceAll('\\', '/');
const evidenceLibrary = resolve('scripts/synthetic-host-evidence.sh').replaceAll('\\', '/');
const lifecycleLibrary = resolve('scripts/operations-job-lifecycle.sh').replaceAll('\\', '/');
const revision = 'a'.repeat(40);
const sentinelSecret = 'synthetic_health_sentinel_do_not_leak';
const hostSecretMarker = 'synthetic_host_input_marker_do_not_echo';

const roots: string[] = [];
const children: ChildProcess[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  await reapChildProcesses(children.splice(0), {
    termTimeoutMs: 500,
    killTimeoutMs: 500,
    processGroup: true,
  });
  for (const server of servers.splice(0)) {
    await new Promise<void>((done) => {
      server.close(() => {
        done();
      });
    });
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function runBoundedBash(
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs = 3500,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(bash, args, {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  const onStdout = (chunk: Buffer | string) => {
    stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  };
  const onStderr = (chunk: Buffer | string) => {
    stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  };
  child.stdout.on('data', onStdout);
  child.stderr.on('data', onStderr);
  try {
    const exit = await waitForExit(child, { timeoutMs });
    if (![child.stdout, child.stderr].every((s) => s.closed || s.readableEnded)) {
      await new Promise<void>((done) => {
        let timer: NodeJS.Timeout | null = null;
        const finish = () => {
          if (timer !== null) clearTimeout(timer);
          child.off('close', finish);
          done();
        };
        timer = setTimeout(finish, 500);
        child.once('close', finish);
      });
    }
    return { status: exit.code, stdout, stderr };
  } finally {
    try {
      await reapChildProcess(child, {
        termTimeoutMs: 500,
        killTimeoutMs: 500,
        processGroup: true,
      });
    } finally {
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
    }
  }
}

async function startResetServer(): Promise<number> {
  const server = net.createServer((socket) => {
    socket.destroy();
  });
  servers.push(server);
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('synthetic_loopback_address_invalid');
  }
  return address.port;
}

function healthRoleEnvironment(
  databaseFile: string,
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    ...operationsEnvironment(),
    NODE_ENV: 'production',
    OPS_GIT_REVISION: revision,
    OPS_SCHEMA_REVISION: '000016',
    OPS_DATABASE_SYSTEM_IDENTIFIER: '7300000000000000000',
    OPS_DATABASE_NAME: 'fcd_support_test',
    OPS_DATABASE_SCHEMA: 'public',
    DATABASE_URL_FILE: databaseFile,
    OPS_RESOURCE_LIMITS_JSON: JSON.stringify({
      health: { cpus: 0.5, memoryMiB: 256, pids: 64, tmpfsMiB: 16 },
    }),
    ...overrides,
  };
}

function validHostInputFrame(): string {
  return (
    JSON.stringify({
      hostSnapshot: {
        checkedAt: new Date().toISOString(),
        services: [
          {
            component: 'webhook',
            running: true,
            health: 'healthy',
            gitRevision: revision,
          },
        ],
        adminSocket: 'healthy',
        manifestAttestation: 'not_verified',
        publicRouteCheck: { state: 'not_verified' },
      },
      availability: { manifest: 'healthy', n8n: 'unavailable' },
    }) + '\n'
  );
}

describe('built dist/operations/health-main.js stdio and fault contract', () => {
  test('consumes authored newline-framed input while writer remains open until natural exit 0', async () => {
    expect(existsSync(healthEntry)).toBe(true);
    const root = await mkdtemp(join(tmpdir(), 'fcd-health-built-open-'));
    roots.push(root);
    await chmod(root, 0o700);
    const port = await startResetServer();
    const dbFile = join(root, 'health-database');
    await writeFile(
      dbFile,
      `postgresql://synthetic_role:${sentinelSecret}@127.0.0.1:${String(port)}/fcd_support_test`,
      { mode: 0o600 },
    );

    const child = spawn(process.execPath, [healthEntry, 'health'], {
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: healthRoleEnvironment(dbFile),
    });
    children.push(child);

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const ackBarrier = waitForBarrier(
      child,
      '{"status":"completed","processed":0,"reasonCode":"dependency_unavailable"}\n',
      { timeoutMs: 3500 },
    );
    child.stdin.write(validHostInputFrame());
    await ackBarrier;
    // Writer must remain open through stdout acknowledgement and natural exit.
    expect(child.stdin.writableEnded).toBe(false);
    const exit = await waitForExit(child, { timeoutMs: 1500 });
    expect(exit).toEqual({ code: 0, signal: null });
    expect(child.stdin.writableEnded).toBe(false);
    expect(stdout).toBe(
      '{"status":"completed","processed":0,"reasonCode":"dependency_unavailable"}\n',
    );
    expect(JSON.parse(stderr.trim()) as unknown).toMatchObject({
      event: 'operations_health',
      component: 'postgres',
      state: 'unavailable',
    });
    expect(stdout + stderr).not.toContain(sentinelSecret);
    expect(stdout + stderr).not.toContain('hostSnapshot');

    await reapChildProcess(child, {
      termTimeoutMs: 500,
      killTimeoutMs: 500,
      processGroup: true,
    });
    await expect(rm(root, { recursive: true })).resolves.toBeUndefined();
  });

  test.each([
    ['malformed-json-eof', `{"hostSnapshot":"${hostSecretMarker}"\n`, true, {}],
    [
      'malformed-json-open-timeout',
      `{"hostSnapshot":"${hostSecretMarker}"\n`,
      false,
      { OPS_MAX_CALL_MS: '200' },
    ],
    ['oversized-frame', `${hostSecretMarker}_${'x'.repeat(16_385)}\n`, false, {}],
    ['stalled-silent-stdin', null, false, { OPS_MAX_CALL_MS: '200' }],
    ['invalid-schema-revision', validHostInputFrame(), false, { OPS_SCHEMA_REVISION: 'bad_rev' }],
  ] as const)(
    'real built health-main.js rejects %s with nonzero exit and zero success acknowledgement',
    async (_mode, payload, closeStdin, extraEnv) => {
      expect(existsSync(healthEntry)).toBe(true);
      const root = await mkdtemp(join(tmpdir(), 'fcd-health-built-fault-'));
      roots.push(root);
      await chmod(root, 0o700);
      const port = await startResetServer();
      const dbFile = join(root, 'health-database');
      await writeFile(
        dbFile,
        `postgresql://synthetic_role:${sentinelSecret}@127.0.0.1:${String(port)}/fcd_support_test`,
        { mode: 0o600 },
      );

      const child = spawn(process.execPath, [healthEntry, 'health'], {
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: healthRoleEnvironment(dbFile, extraEnv),
      });
      children.push(child);

      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      if (payload !== null) {
        if (closeStdin) child.stdin.end(payload);
        else child.stdin.write(payload);
      }
      const exit = await waitForExit(child, { timeoutMs: 3500 });
      expect(exit.code).toBe(1);
      expect(stdout).toBe('');
      expect(JSON.parse(stderr.trim()) as unknown).toMatchObject({
        event: 'operations_health',
        component: 'postgres',
        state: 'unknown',
      });
      expect(stdout + stderr).not.toContain(sentinelSecret);
      expect(stdout + stderr).not.toContain(hostSecretMarker);

      await reapChildProcess(child, {
        termTimeoutMs: 500,
        killTimeoutMs: 500,
        processGroup: true,
      });
      await expect(rm(root, { recursive: true })).resolves.toBeUndefined();
    },
  );
});

describe('owning lifecycle with real dist/operations/health-main.js and CI trace', () => {
  async function runLifecycleWithBuiltHealth(options: {
    logsUnavailable?: boolean;
    dropAttachedOutput?: boolean;
    traceActive?: boolean;
    extraEnv?: Record<string, string>;
    healthInputJson?: string;
    holdOpenInput?: boolean;
    omitTrailingNewline?: boolean;
    secondAttempt?: boolean;
  }) {
    expect(existsSync(healthEntry)).toBe(true);
    const root = await mkdtemp(join(tmpdir(), 'fcd-health-lifecycle-built-'));
    roots.push(root);
    await chmod(root, 0o700);
    const bin = join(root, 'bin');
    await mkdir(bin, { mode: 0o700 });
    const port = await startResetServer();
    const dbFile = join(root, 'health-database');
    await writeFile(
      dbFile,
      `postgresql://synthetic_role:${sentinelSecret}@127.0.0.1:${String(port)}/fcd_support_test`,
      { mode: 0o600 },
    );

    const traceSource = await readFile('scripts/test-synthetic-runtime-deployment.sh', 'utf8');
    const traceMatch = /<<'TRACE'\r?\n([\s\S]*?)\r?\nTRACE/u.exec(traceSource);
    if (traceMatch?.[1] === undefined) throw new Error('synthetic_trace_entry_missing');
    const traceTrap = traceMatch[1].replaceAll('\r', '').split('\n').slice(1).join('\n');

    const cid = 'c'.repeat(64);
    const imageId = `sha256:${'d'.repeat(64)}`;
    const mockDockerJsPath = join(root, 'mock-docker.mjs').replaceAll('\\', '/');
    const mockDockerScript = `import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.env.TASK_ROOT;
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'docker-config.json'), 'utf8'));
const args = process.argv.slice(2);
const trace = (line) => fs.appendFileSync(path.join(root, 'docker.trace'), line + '\\n');
const key = args.slice(0, 2).join('/');

if (args[0] === 'compose') {
  trace('compose/create');
  const fileIdx = args.lastIndexOf('--file');
  const override = JSON.parse(fs.readFileSync(args[fileIdx + 1], 'utf8'));
  const svc = override.services.health;
  const l = svc.labels;
  const ref = l['fcd-support.operation.ref'];
  fs.writeFileSync(
    path.join(root, 'c.pre'),
    [
      '${cid}',
      svc.image,
      l['org.opencontainers.image.revision'],
      ref,
      l['fcd-support.operation.parent'],
      l['fcd-support.operation.service'],
      l['fcd-support.operation.command'],
    ].join('/') + '\\n',
  );
  fs.writeFileSync(
    path.join(root, 'c.suf'),
    ['false', 'false', 'false', 'fcd-support-operation-' + ref.slice('operation_'.length), 'health'].join('/') + '\\n',
  );
  fs.writeFileSync(path.join(root, 'c.cmd'), JSON.stringify(svc.command) + '\\n');
  fs.writeFileSync(path.join(root, 'c.phase'), 'created\\n');
  fs.writeFileSync(path.join(root, 'c.exit'), '0\\n');
  fs.writeFileSync(path.join(root, 'c.exists'), '1\\n');
  process.exit(0);
}
if (key === 'container/start') {
  trace('container/start');
  fs.writeFileSync(path.join(root, 'c.phase'), 'running\\n');
  const child = spawn(
    process.execPath,
    [cfg.healthEntry, 'health'],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cfg.containerEnv,
    },
  );
  let childStdout = '';
  let childStderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    childStdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    childStderr += chunk;
  });
  child.stdin.on('error', () => {});
  process.stdin.on('error', () => {});
  process.stdin.pipe(child.stdin);
  const killer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {}
  }, 3000);
  child.on('close', (code) => {
    clearTimeout(killer);
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
    process.stdin.destroy();
    fs.writeFileSync(path.join(root, 'health-stderr.log'), childStderr);
    fs.writeFileSync(path.join(root, 'c.phase'), 'exited\\n');
    fs.writeFileSync(path.join(root, 'c.exit'), String(code ?? 1) + '\\n');
    if (cfg.dropAttachedOutput) {
      process.exit(code ?? 0);
    }
    process.stdout.write(childStdout, () => {
      process.exit(code ?? 1);
    });
  });
} else {
  process.exit(19);
}
`;
    await writeFile(mockDockerJsPath, mockDockerScript, { mode: 0o600 });
    await writeFile(
      join(root, 'docker-config.json'),
      JSON.stringify({
        healthEntry,
        logsUnavailable: options.logsUnavailable === true,
        dropAttachedOutput: options.dropAttachedOutput === true,
        containerEnv: healthRoleEnvironment(dbFile, options.extraEnv),
      }),
      { mode: 0o600 },
    );
    if (options.logsUnavailable === true) {
      await writeFile(join(root, 'logs.unavailable'), '1\n', { mode: 0o600 });
    }
    const dockerShim = join(bin, 'docker');
    const nodeExePosix = process.execPath.replaceAll('\\', '/');
    const rootPosix = root.replaceAll('\\', '/');
    const sysRootPosix = (process.env.SystemRoot ?? 'C:\\Windows').replaceAll('\\', '/');
    await writeFile(
      dockerShim,
      `#!/bin/bash
export TASK_ROOT='${rootPosix}' SystemRoot='${sysRootPosix}'
case "\${1:-}/\${2:-}" in
  image/inspect)
    printf 'image/inspect\\n' >> "$TASK_ROOT/docker.trace"
    printf '%s\\n' '${imageId}/${revision}/linux/amd64'
    exit 0
    ;;
  ps/*)
    printf 'ps\\n' >> "$TASK_ROOT/docker.trace"
    if [[ -f "$TASK_ROOT/c.exists" && ! -f "$TASK_ROOT/c.removed" ]]; then
      printf '%s\\n' '${cid}'
    fi
    exit 0
    ;;
  container/inspect)
    [[ -f "$TASK_ROOT/c.exists" && ! -f "$TASK_ROOT/c.removed" ]] || exit 19
    if [[ "$*" == *".Config.Cmd"* ]]; then
      printf 'inspect/cmd\\n' >> "$TASK_ROOT/docker.trace"
      IFS= read -r v < "$TASK_ROOT/c.cmd"
      printf '%s\\n' "$v"
    elif [[ "$*" == *".State.ExitCode"* ]]; then
      printf 'inspect/exit\\n' >> "$TASK_ROOT/docker.trace"
      IFS= read -r p < "$TASK_ROOT/c.phase"
      IFS= read -r e < "$TASK_ROOT/c.exit"
      printf '%s/%s\\n' "$p" "$e"
    else
      printf 'inspect/identity\\n' >> "$TASK_ROOT/docker.trace"
      IFS= read -r pre < "$TASK_ROOT/c.pre"
      IFS= read -r p < "$TASK_ROOT/c.phase"
      IFS= read -r suf < "$TASK_ROOT/c.suf"
      printf '%s/%s/%s\\n' "$pre" "$p" "$suf"
    fi
    exit 0
    ;;
  container/wait)
    printf 'container/wait\\n' >> "$TASK_ROOT/docker.trace"
    IFS= read -r e < "$TASK_ROOT/c.exit"
    printf '%s\\n' "$e"
    exit 0
    ;;
  container/logs)
    printf 'container/logs\\n' >> "$TASK_ROOT/docker.trace"
    if [[ -f "$TASK_ROOT/logs.unavailable" ]]; then
      printf 'Error response from daemon: configured logging driver does not support reading\\n' >&2
      exit 1
    fi
    printf '{"status":"completed","processed":1,"reasonCode":"ok"}\\n'
    exit 0
    ;;
  container/stop)
    printf 'container/stop\\n' >> "$TASK_ROOT/docker.trace"
    printf 'exited\\n' > "$TASK_ROOT/c.phase"
    exit 0
    ;;
  container/rm)
    printf 'container/rm\\n' >> "$TASK_ROOT/docker.trace"
    printf '1\\n' > "$TASK_ROOT/c.removed"
    exit 0
    ;;
esac
exec '${nodeExePosix}' '${mockDockerJsPath}' "$@"
`,
      { mode: 0o700 },
    );

    const opsRoot = join(root, 'ops-root');
    await mkdir(join(opsRoot, 'infra'), { recursive: true, mode: 0o700 });
    await writeFile(join(opsRoot, 'infra', 'compose.operations.yml'), '# synthetic\n', {
      mode: 0o600,
    });

    const inputOverride =
      options.holdOpenInput === true
        ? `operations_job_health_exchange() {
  local health_read='' health_write='' health_pid health_status=0
  coproc OPS_HEALTH_PIPE { operations_docker container start --attach --interactive "$OPS_JOB_CONTAINER"; }
  health_pid="\${OPS_HEALTH_PIPE_PID:-}"
  exec {health_read}<&"\${OPS_HEALTH_PIPE[0]}" {health_write}>&"\${OPS_HEALTH_PIPE[1]}"
  exec {OPS_HEALTH_PIPE[0]}<&- {OPS_HEALTH_PIPE[1]}>&-
  ${options.omitTrailingNewline === true ? 'printf "%s" "$OPS_HEALTH_INPUT_JSON"' : 'printf "%s\\n" "$OPS_HEALTH_INPUT_JSON"'} >&"$health_write"
  cat <&"$health_read" || health_status=1
  exec {health_write}>&- {health_read}<&-
  wait "$health_pid" || health_status=$?
  return "$health_status"
}`
        : '';

    const runScript = join(root, 'run-lifecycle.sh');
    await writeFile(
      runScript,
      `set -Eeuo pipefail
source "$TASK_COMMON"
source "$TASK_LIFECYCLE"
operations_config_field() { return 0; }
operations_job_state_root() { OPS_JOB_STATE_FILE="$TASK_ROOT/active-job"; }
operations_job_state_begin() { printf 'JOB_REF=%s\nJOB_SERVICE=%s\nJOB_PHASE=intent\nJOB_CONTAINER=pending\n' "$1" "$2" > "$TASK_ROOT/active-job"; }
operations_job_state_sync() { return 0; }
operations_job_state_transition() {
  printf 'JOB_REF=%s\nJOB_PHASE=%s\nJOB_CONTAINER=%s\n' "$1" "$2" "$3" > "$TASK_ROOT/active-job"
}
operations_job_state_read() { declare -gA OPS_JOB_STATE=([JOB_CONTAINER]="$OPS_JOB_CONTAINER"); }
operations_job_state_clear() { rm -f "$TASK_ROOT/active-job"; }
operations_job_override() {
  printf '{"services":{"health":{"image":"%s","command":%s,"labels":{' "$OPS_JOB_IMAGE" "$OPS_JOB_COMMAND_JSON"
  printf '"org.opencontainers.image.revision":"%s",' "\${OPS_CONFIG[FCD_SUPPORT_REVISION]}"
  printf '"fcd-support.operation.ref":"%s","fcd-support.operation.parent":"%s",' "$OPS_JOB_REFERENCE" "\${OPS_CONFIG[FCD_RUNTIME_PROJECT]}"
  printf '"fcd-support.operation.service":"%s","fcd-support.operation.command":"%s"},"stdin_open":true}}}\n' "$OPS_JOB_SERVICE" "$OPS_JOB_COMMAND_HASH"
}
dd() {
  local target=''
  for arg in "$@"; do [[ "$arg" == of=* ]] && target="\${arg#of=}"; done
  cat > "$target"
}
stat() {
  if [[ "$*" == *"1000"* || "$1" == -c ]]; then printf '1000:1000:600:1\n'; else command stat "$@"; fi
}
timeout() {
  while [[ "$#" -gt 0 && "$1" == -* ]]; do shift; done
  if [[ "$#" -gt 0 ]]; then shift; fi
  "$@"
}
OPS_ROOT="$TASK_OPS_ROOT"
declare -A OPS_CONFIG=(
  [FCD_SUPPORT_REVISION]=${revision}
  [FCD_RUNTIME_PROJECT]=fcd-support-synthetic
  [FCD_STATE_ROOT]="$TASK_ROOT"
  [FCD_SECRET_ROOT]="$TASK_ROOT"
  [FCD_OPERATIONS_IMAGE]=${imageId}
  [FCD_COMMAND_TIMEOUT_SECONDS]=5
  [FCD_STOP_GRACE_MS]=1000
  [FCD_POSTGRES_DB]=fcd_support_test
  [FCD_DATABASE_SCHEMA]=public
  [FCD_DATABASE_ROLE_PREFIX]=fcd_synthetic
  [FCD_SCHEMA_REVISION]=000016
)
OPS_DATABASE_SYSTEM_IDENTIFIER=7300000000000000000
export OPS_HEALTH_INPUT_JSON
exec 3>"$TASK_ROOT/trace3" 4>"$TASK_ROOT/out4"
${inputOverride}
${traceTrap}
if acknowledgement="$(operations_execute_job health health)"; then
  printf '%s\\n' "$acknowledgement" > "$TASK_ROOT/ack"
  printf 'synthetic_schedule=successor\\n' >&4
  exit 0
else
  rc=$?
  ${
    options.secondAttempt === true
      ? 'if ( operations_execute_job health health ) 2>"$TASK_ROOT/retry_stderr"; then\n    retry_rc=0\n  else\n    retry_rc=$?\n  fi\n  printf "%s\\n" "$retry_rc" > "$TASK_ROOT/retry_exit"'
      : ''
  }
  exit "$rc"
fi
`,
      { mode: 0o700 },
    );

    const env = {
      ...healthRoleEnvironment(dbFile, options.extraEnv),
      PATH: bin + delimiter + (process.env.PATH ?? ''),
      SystemRoot: process.env.SystemRoot,
      TASK_ROOT: rootPosix,
      TASK_COMMON: commonLibrary,
      TASK_LIFECYCLE: lifecycleLibrary,
      TASK_OPS_ROOT: opsRoot.replaceAll('\\', '/'),
      TASK_HEALTH_ENTRY: healthEntry.replaceAll('\\', '/'),
      FCD_SYNTHETIC_EVIDENCE_LIBRARY: evidenceLibrary,
      FCD_RUNTIME_HOST_DIAGNOSTICS: options.traceActive === false ? '' : 'closed-v1',
      OPS_HEALTH_INPUT_JSON: options.healthInputJson ?? '{}',
      TASK_LOGS_UNAVAILABLE: options.logsUnavailable === true ? '1' : '0',
      TASK_DROP_ATTACHED: options.dropAttachedOutput === true ? '1' : '0',
    };

    const result = await runBoundedBash(['--noprofile', '--norc', runScript], env, 4000);
    const readOptional = async (name: string) => readFile(join(root, name), 'utf8').catch(() => '');

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      ack: await readOptional('ack'),
      out4: await readOptional('out4'),
      trace3: await readOptional('trace3'),
      dockerTrace: (await readOptional('docker.trace')).trim().split('\n').filter(Boolean),
      activeJob: await readOptional('active-job'),
      retryExit: (await readOptional('retry_exit')).trim(),
      retryStderr: await readOptional('retry_stderr'),
      healthStderr: await readOptional('health-stderr.log'),
    };
  }

  test('pairs normal daemon logging vs unavailable logs using real dist/operations/health-main.js with identical outcome and zero log fallback', async () => {
    const [withLogs, withoutLogs] = await Promise.all([
      runLifecycleWithBuiltHealth({
        logsUnavailable: false,
        traceActive: true,
        healthInputJson: validHostInputFrame().trimEnd(),
      }),
      runLifecycleWithBuiltHealth({
        logsUnavailable: true,
        traceActive: true,
        healthInputJson: validHostInputFrame().trimEnd(),
      }),
    ]);

    for (const run of [withLogs, withoutLogs]) {
      expect(run.status, run.stderr).toBe(0);
      expect(run.ack).toBe(
        '{"status":"completed","processed":0,"reasonCode":"dependency_unavailable"}\n',
      );
      expect(run.out4).toBe('synthetic_schedule=successor\n');
      expect(run.activeJob).toBe('');
      expect(run.dockerTrace).not.toContain('container/logs');
      expect(run.dockerTrace.filter((entry) => entry === 'container/start')).toHaveLength(1);
      expect(run.dockerTrace).toContain('container/rm');
      expect(run.trace3).toContain('synthetic_health_ack_diagnostic=dependency_unavailable\n');
      expect(run.trace3 + run.stdout + run.stderr + run.ack).not.toContain(sentinelSecret);
    }
  });

  test('CI TRACE active vs inactive preserves exit status/acknowledgement and suppresses secret sentinels', async () => {
    const [active, inactive] = await Promise.all([
      runLifecycleWithBuiltHealth({
        traceActive: true,
        logsUnavailable: true,
        healthInputJson: '{"availability":{"manifest":"healthy"}}',
      }),
      runLifecycleWithBuiltHealth({
        traceActive: false,
        logsUnavailable: true,
        healthInputJson: '{"availability":{"manifest":"healthy"}}',
      }),
    ]);

    expect(active.status).toBe(0);
    expect(active.status).toBe(inactive.status);
    expect(active.ack).toBe(inactive.ack);
    expect(active.out4).toBe(inactive.out4);
    expect(active.trace3).toContain('synthetic_health_ack_diagnostic=dependency_unavailable\n');
    expect(inactive.trace3).not.toContain('synthetic_health_ack_diagnostic');
    expect(inactive.trace3).not.toContain('synthetic_health_daemon_diagnostic');
    expect(active.trace3 + inactive.trace3 + active.stderr + inactive.stderr).not.toContain(
      sentinelSecret,
    );
  });

  test('narrow test-port sensitivity fault dropping attached stdout refuses without daemon log fallback and blocks replay', async () => {
    const dropped = await runLifecycleWithBuiltHealth({
      dropAttachedOutput: true,
      logsUnavailable: false,
      traceActive: true,
      secondAttempt: true,
    });

    expect(dropped.status).toBe(1);
    expect(dropped.ack).toBe('');
    expect(dropped.out4).toBe('');
    expect(dropped.activeJob).toContain('JOB_PHASE=uncertain\n');
    expect(dropped.trace3).toContain('synthetic_health_ack_diagnostic=empty\n');
    expect(dropped.trace3).toContain('synthetic_health_daemon_diagnostic=completed\n');
    expect(dropped.dockerTrace.filter((entry) => entry === 'container/start')).toHaveLength(1);
    expect(dropped.retryExit).toBe('1');
    expect(dropped.retryStderr).toContain('operations_job_pending');
  });

  test.each([
    [
      'malformed',
      {
        healthInputJson: `{"hostSnapshot":"${hostSecretMarker}"`,
        extraEnv: { OPS_MAX_CALL_MS: '200' },
      },
    ],
    [
      'oversized',
      // 16,384-byte JSON passes command argument framing; trailing newline produces a 16,385-byte frame on stdin.
      { healthInputJson: `{"x":"${'y'.repeat(16_376)}"}` },
    ],
    [
      'stalled',
      {
        healthInputJson: '{}',
        holdOpenInput: true,
        omitTrailingNewline: true,
        extraEnv: { OPS_MAX_CALL_MS: '200' },
      },
    ],
    [
      'nonzero-config',
      {
        healthInputJson: '{}',
        extraEnv: { OPS_SCHEMA_REVISION: 'bad_rev' },
      },
    ],
  ] as const)(
    'owning lifecycle preserves uncertainty and refuses replay on %s fault against real built health-main.js',
    async (_label, faultOptions) => {
      const result = await runLifecycleWithBuiltHealth({
        ...faultOptions,
        traceActive: true,
        logsUnavailable: true,
        secondAttempt: true,
      });

      expect(result.status).toBe(1);
      expect(result.ack).toBe('');
      expect(result.out4).toBe('');
      expect(result.activeJob).toContain('JOB_PHASE=uncertain\n');
      expect(result.dockerTrace.filter((entry) => entry === 'container/start')).toHaveLength(1);
      expect(result.retryExit).toBe('1');
      expect(result.retryStderr).toContain('operations_job_pending');
      expect(result.healthStderr).toContain('"state":"unknown"');
      expect(result.trace3 + result.stderr + result.stdout).not.toContain(sentinelSecret);
      expect(result.trace3 + result.stderr + result.stdout).not.toContain(hostSecretMarker);
    },
  );
});
