import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function createMockDocker() {
  return `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TASK_TRACE"
case "$1" in
  build)
    exit 0 ;;
  image)
    if [[ "$*" == *Config.Volumes* ]]; then
      printf 'no\\n'
      exit 0
    fi
    if [[ "$*" == *revision* ]]; then
      printf 'a%.0s' {1..40}
      printf '\\n'
      exit 0
    fi
    exit 0 ;;
  create)
    if [[ "$*" == *validator* ]]; then
      printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'
      exit 0
    fi
    if [[ "$*" == *job* ]]; then
      printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n'
      exit 0
    fi
    printf 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\\n'
    exit 0 ;;
  inspect)
    if [[ "$*" == *ro-initializer* ]]; then
      if [[ "\${SIMULATE_INITIALIZER_COLLISION:-0}" == 1 ]]; then
        exit 0
      fi
      exit 1
    fi
    if [[ "$*" == *len\\ .Mounts* ]]; then
      if [[ "$*" == *bbbbbbbb* ]]; then printf '1\\n'; else printf '0\\n'; fi
      exit 0
    fi
    if [[ "$*" == *range\\ .Mounts* ]]; then
      last_vol="$(grep -E '^volume create .* fcd-support-operations-mount-proof' "$TASK_TRACE" | tail -n 1 | awk '{print $NF}')"
      printf 'volume/%s/false\\n' "$last_vol"
      exit 0
    fi
    if [[ "$*" == *fcd-support.operations-mount-proof* ]]; then
      printf 'fcd-support-operations-mount-proof\\n'
      exit 0
    fi
    if [[ "$*" == *Config.Labels* ]]; then
      exit 0
    fi
    exit 0 ;;
  volume)
    case "$2" in
      ls)
        if [[ "\${SIMULATE_COLLISION:-0}" == 1 && "$*" == *ro-backups* ]]; then
          printf 'collision-ro-volume\\n'
          exit 0
        fi
        exit 0 ;;
      inspect)
        if [[ "\${SIMULATE_COLLISION:-0}" == 1 && "$*" == *ro-backups* ]]; then
          printf 'existing\\n'
          exit 0
        fi
        if [[ "$*" == *Name*Driver*Scope* ]]; then
          if [[ "\${SIMULATE_BAD_METADATA:-0}" == 1 && "$*" == *ro-backups* ]]; then
            printf 'wrong-scope/driver/none/none\\n'
            exit 0
          fi
          eval "vol=\\$$#"
          scope="\${vol%-ro-backups}"
          scope="\${scope%-backups}"
          scope="\${scope%-postgres}"
          printf '%s/local/local/%s\\n' "$vol" "$scope"
          exit 0
        fi
        exit 1 ;;
      create)
        eval "last=\\$$#"
        printf '%s\\n' "$last"
        exit 0 ;;
      rm)
        exit 0 ;;
    esac ;;
  ps)
    if [[ "\${SIMULATE_CONSUMER:-0}" == 1 && "$*" == *ro-backups* ]]; then
      printf 'foreign-container-123\\n'
      exit 0
    fi
    if [[ "\${SIMULATE_CLEANUP_FAILURE:-0}" == 1 && "$*" == *volume=* ]]; then
      printf 'active-leaked-consumer-999\\n'
      exit 0
    fi
    exit 0 ;;
  run)
    if [[ "$*" == *ro-backups* ]]; then
      printf 'INITIALIZER_RUN:%s\\n' "$*" >> "$TASK_TRACE"
      exit 0
    fi
    exit 0 ;;
  rm)
    exit 0 ;;
  *)
    exit 0 ;;
esac
`;
}

describe('test-encrypted-backup harness containment', () => {
  it('refuses before root writes when ro volume name already exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-backup-harness-'));
    roots.push(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    const trace = join(root, 'trace');

    await writeFile(join(bin, 'docker'), createMockDocker(), { mode: 0o700 });

    const scriptPath = resolve('scripts/test-encrypted-backup.sh').replaceAll('\\', '/');
    const result = spawnSync(
      bash,
      ['--noprofile', '--norc', scriptPath, 'unit'],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          PATH: bin + delimiter + (process.env.PATH ?? ''),
          SystemRoot: process.env.SystemRoot,
          TASK_TRACE: trace.replaceAll('\\', '/'),
          SIMULATE_COLLISION: '1',
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ro_backup_volume_collision');
  });

  it('refuses before root writes when ro volume has a foreign consumer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-backup-harness-'));
    roots.push(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    const trace = join(root, 'trace');

    await writeFile(join(bin, 'docker'), createMockDocker(), { mode: 0o700 });

    const scriptPath = resolve('scripts/test-encrypted-backup.sh').replaceAll('\\', '/');
    const result = spawnSync(
      bash,
      ['--noprofile', '--norc', scriptPath, 'unit'],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          PATH: bin + delimiter + (process.env.PATH ?? ''),
          SystemRoot: process.env.SystemRoot,
          TASK_TRACE: trace.replaceAll('\\', '/'),
          SIMULATE_CONSUMER: '1',
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ro_backup_volume_foreign_consumer');
  });

  it('refuses before root writes when ro initializer container name collision occurs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-backup-harness-'));
    roots.push(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    const trace = join(root, 'trace');

    await writeFile(join(bin, 'docker'), createMockDocker(), { mode: 0o700 });

    const scriptPath = resolve('scripts/test-encrypted-backup.sh').replaceAll('\\', '/');
    const result = spawnSync(
      bash,
      ['--noprofile', '--norc', scriptPath, 'unit'],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          PATH: bin + delimiter + (process.env.PATH ?? ''),
          SystemRoot: process.env.SystemRoot,
          TASK_TRACE: trace.replaceAll('\\', '/'),
          SIMULATE_INITIALIZER_COLLISION: '1',
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ro_initializer_collision');
  });

  it('refuses before root writes when volume has invalid metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-backup-harness-'));
    roots.push(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    const trace = join(root, 'trace');

    await writeFile(join(bin, 'docker'), createMockDocker(), { mode: 0o700 });

    const scriptPath = resolve('scripts/test-encrypted-backup.sh').replaceAll('\\', '/');
    const result = spawnSync(
      bash,
      ['--noprofile', '--norc', scriptPath, 'unit'],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          PATH: bin + delimiter + (process.env.PATH ?? ''),
          SystemRoot: process.env.SystemRoot,
          TASK_TRACE: trace.replaceAll('\\', '/'),
          SIMULATE_BAD_METADATA: '1',
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ro_backup_volume_metadata_invalid');
  });

  it('verifies that the ro initializer container uses strict containment flags', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-backup-harness-'));
    roots.push(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    const trace = join(root, 'trace');

    await writeFile(join(bin, 'docker'), createMockDocker(), { mode: 0o700 });

    const scriptPath = resolve('scripts/test-encrypted-backup.sh').replaceAll('\\', '/');
    spawnSync(
      bash,
      ['--noprofile', '--norc', scriptPath, 'unit'],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          PATH: bin + delimiter + (process.env.PATH ?? ''),
          SystemRoot: process.env.SystemRoot,
          TASK_TRACE: trace.replaceAll('\\', '/'),
        },
      },
    );

    const log = await readFile(trace, 'utf8');
    const initializerLine = log.split('\n').find((l) => l.startsWith('INITIALIZER_RUN:'));
    expect(initializerLine).toBeDefined();
    expect(initializerLine).toContain('--network none');
    expect(initializerLine).toContain('--read-only');
    expect(initializerLine).toContain('--cap-drop ALL');
    expect(initializerLine).toContain('--cap-add CHOWN');
    expect(initializerLine).toContain('--cap-add FOWNER');
    expect(initializerLine).toContain('--cap-add DAC_OVERRIDE');
    expect(initializerLine).toContain('--security-opt no-new-privileges');
    expect(initializerLine).toContain('--cpus 0.25');
    expect(initializerLine).toContain('--memory 128m');
    expect(initializerLine).toContain('--pids-limit 32');
    expect(initializerLine).toMatch(/--name \S+-ro-initializer/);
  });

  it('propagates cleanup failure to gate exit when leftover consumers prevent volume deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fcd-backup-harness-'));
    roots.push(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    const trace = join(root, 'trace');

    await writeFile(join(bin, 'docker'), createMockDocker(), { mode: 0o700 });

    const scriptPath = resolve('scripts/test-encrypted-backup.sh').replaceAll('\\', '/');
    const result = spawnSync(
      bash,
      ['--noprofile', '--norc', scriptPath, 'unit'],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          PATH: bin + delimiter + (process.env.PATH ?? ''),
          SystemRoot: process.env.SystemRoot,
          TASK_TRACE: trace.replaceAll('\\', '/'),
          SIMULATE_CLEANUP_FAILURE: '1',
        },
      },
    );

    // Gate must exit non-zero when cleanup fails due to leftover consumers
    expect(result.status).toBe(1);
  });
});
