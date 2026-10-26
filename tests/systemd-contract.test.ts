import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const revision = 'a'.repeat(40);
const image = `sha256:${'b'.repeat(64)}`;
const stamp = '2030-04-14T12:07:42.000Z';
const native =
  process.platform === 'linux' &&
  process.env.RUN_ENCRYPTED_BACKUP_TESTS === 'synthetic-operations-toolchain-only';
function shell(body: string, library = 'run-operation.sh', extra: Record<string, string> = {}) {
  return spawnSync(bash, ['--noprofile', '--norc', '-c', `source "$TASK_LIBRARY"\n${body}`], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: native ? 20_000 : 6000,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TASK_LIBRARY: resolve('scripts', library).replaceAll('\\', '/'),
      ...extra,
    },
  });
}
const config = `declare -gA OPS_CONFIG=([FCD_SUPPORT_REVISION]=${revision} [FCD_SCHEMA_REVISION]=000016
  [FCD_MAINTENANCE_SLOT_SECONDS]=300 [FCD_STATE_ROOT]=/synthetic/state
  [FCD_CONFIG_ROOT]=/synthetic/config [FCD_SECRET_ROOT]=/synthetic/secrets [FCD_ADMIN_SOCKET_ROOT]=/synthetic/socket
  [FCD_SUPPORT_IMAGE]=${image} [FCD_OPERATIONS_IMAGE]=${image} [FCD_POSTGRES_IMAGE]=${image}
  [FCD_BACKUP_CALENDAR]='*-*-* 02:00:00 UTC' [FCD_MAINTENANCE_CALENDAR]='*-*-* *:00/5:00 UTC'
  [FCD_HEALTH_CALENDAR]='*-*-* *:*:00 UTC' [FCD_TIMER_TIMEOUT_SECONDS]=900
  [FCD_TIMER_MEMORY_MIB]=256 [FCD_TIMER_TASKS_MAX]=128 [FCD_TIMER_CPUS]=1
  [FCD_TIMER_ACCURACY_SECONDS]=1 [FCD_TIMER_RANDOMIZED_DELAY_SECONDS]=0)
declare -gA OPS_SELECTION=([STATE_PHASE]=ready [STATE_REVISION]=${revision} [STATE_SCHEMA_REVISION]=000016
  [STATE_WRITES_POSSIBLE]=yes [STATE_SYSTEM_IDENTIFIER]=1111111111111111111)
declare -gA OPS_RETAINED=([BUNDLE_SCHEMA_REVISION]=000016 [BUNDLE_APPLICATION_IMAGE]=${image}
  [BUNDLE_OPERATIONS_IMAGE]=${image} [BUNDLE_POSTGRES_IMAGE]=${image})
OPS_REVISION=${revision}`;
const fakes = `
uname() { printf '%s\\n' Linux; }
operations_load_config() { printf '%s\\n' config; }
operations_preflight() { printf '%s\\n' preflight; operations_preflight_selection; }
operations_selection_apply() { :; }
operations_selection_read() { :; }
operations_retained_read() { :; }
operations_docker() { printf '%s\\n' '${image}/${revision}/linux/amd64'; }
date() { if [[ "$*" == '-u +%s' ]]; then command date -u -d '${stamp}' +%s; else command date "$@"; fi; }
operations_execute_job() {
  printf 'job:%s\\n' "$*" >&2
  [[ "\${TASK_FAILURE:-}" != "$1" ]] || return 1
  if [[ "$2" == scheduled-backup ]]; then printf '%s\\n' backup_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;
  else printf '%s\\n' '{"status":"completed","processed":0,"reasonCode":"ok"}'; fi
}`;

test('host units carry protected references, bounded resources and the deliberate operator Docker authority', () => {
  const unit = readFileSync('infra/systemd/fcd-support-operation@.service', 'utf8');
  expect(unit).toContain('run-operation.sh');
  expect(unit).toContain('WorkingDirectory=@ROOT@');
  expect(unit).toContain('EnvironmentFile=@CONFIG@');
  expect(unit).toContain('User=1000');
  expect(unit).toContain('NoNewPrivileges=true');
  expect(unit).toContain('ProtectSystem=strict');
  expect(unit).toContain('ReadWritePaths=@STATE_ROOT@');
  expect(unit).toContain('CPUQuota=@CPU_QUOTA@%');
  expect(unit).toContain('MemoryMax=@MEMORY_MIB@M');
  expect(unit).toContain('TasksMax=@TASKS_MAX@');
  expect(unit).toContain('TimeoutStartSec=@TIMEOUT_SECONDS@s');
  expect(unit).toContain('StandardOutput=journal');
  expect(unit).not.toMatch(/Environment=.*(?:PASSWORD|TOKEN|API_KEY)=/u);
  expect(unit).not.toMatch(
    /docker\.sock:|InaccessiblePaths=.*(?:docker|\/run|\/var\/run)|PrivateUsers=true/u,
  );
  for (const job of ['backup', 'maintenance', 'health']) {
    const timer = readFileSync(`infra/systemd/fcd-support-${job}.timer.in`, 'utf8');
    expect(timer).toContain(`Unit=fcd-support-operation@${job}.service`);
    expect(timer).toContain(`Persistent=${job === 'health' ? 'false' : 'true'}`);
    expect(timer).toContain('OnCalendar=@CALENDAR@');
    expect(timer).not.toMatch(/OnBootSec|OnStartupSec/u);
  }
});

test.each(['backup', 'maintenance', 'health'])(
  'scheduled %s uses shared preflight and the journal executor',
  (job) => {
    const result = shell(
      `${config}\n${fakes}\noperations_scheduled_main ${job} ${revision} /synthetic/host.conf`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['config', 'preflight']);
    const jobs = result.stderr.trim().split('\n');
    if (job === 'backup') {
      expect(jobs).toEqual([
        `job:backup scheduled-backup daily ${stamp}`,
        'job:verify-backup verify-backup backup_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        `job:backup scheduled-backup monthly ${stamp}`,
        'job:verify-backup verify-backup backup_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        `job:backup prune-backups ${stamp}`,
      ]);
    } else if (job === 'maintenance') {
      expect(jobs).toHaveLength(4);
      for (const maintenance of ['retention', 'deletion', 'lease_recovery', 'learning']) {
        expect(jobs).toContainEqual(
          expect.stringMatching(
            new RegExp(
              `^job:maintenance ${maintenance} scheduled:${maintenance}:[0-9]+ 2030-04-14T12:05:00.000Z$`,
              'u',
            ),
          ),
        );
      }
    } else expect(jobs).toEqual(['job:health health']);
  },
);

test('repeated current-slot maintenance has the same references without replaying missed intervals', () => {
  const result = shell(
    `${config}\n${fakes}\noperations_scheduled_dispatch maintenance\noperations_scheduled_dispatch maintenance`,
  );
  expect(result.status, result.stderr).toBe(0);
  const jobs = result.stderr.trim().split('\n');
  expect(jobs).toHaveLength(8);
  expect(jobs.slice(0, 4)).toEqual(jobs.slice(4));
});

test.each(['backup', 'maintenance', 'health', 'retention;synthetic', '--help'])(
  'invalid arity or arguments refuse before config/daemon for %s',
  (job) => {
    const result = shell(
      `${config}\n${fakes}\noperations_scheduled_main "$TASK_JOB" bad-revision /synthetic/host.conf`,
      'run-operation.sh',
      { TASK_JOB: job },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('operations_arguments_invalid');
  },
);

test.each(['quiescent', 'draining', 'switching', 'starting', 'uncertain'])(
  'a %s selection refuses before scheduled jobs',
  (phase) => {
    const result = shell(
      `${config}\n${fakes}\nOPS_SELECTION[STATE_PHASE]=$TASK_PHASE\noperations_scheduled_main maintenance ${revision} /synthetic/host.conf`,
      'run-operation.sh',
      { TASK_PHASE: phase },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('operations_schedule_not_ready\n');
  },
);

test('a ready pointer for an old revision and a substituted retained image refuse', () => {
  for (const mutation of [
    `OPS_SELECTION[STATE_REVISION]=${'c'.repeat(40)}`,
    `OPS_RETAINED[BUNDLE_OPERATIONS_IMAGE]=sha256:${'c'.repeat(64)}`,
  ]) {
    const result = shell(
      `${config}\n${fakes}\n${mutation}\noperations_scheduled_main backup ${revision} /synthetic/host.conf`,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('operations_schedule_not_ready\n');
  }
});

test('lock conflicts and unavailable dependencies prevent later jobs or a replay loop', () => {
  const locked = shell(
    `${config}\n${fakes}\noperations_preflight() { operations_fail operations_lock_conflict; }\noperations_scheduled_main maintenance ${revision} /synthetic/host.conf`,
  );
  expect(locked.status).toBe(1);
  expect(locked.stderr).toBe('operations_lock_conflict\n');
  const failed = shell(
    `${config}\n${fakes}\noperations_scheduled_main maintenance ${revision} /synthetic/host.conf`,
    'run-operation.sh',
    { TASK_FAILURE: 'maintenance' },
  );
  expect(failed.status).toBe(1);
  expect(failed.stderr.trim().split('\n')).toHaveLength(2);
  expect(failed.stderr).toContain('operations_schedule_failed');
});

test('renderer validates each calendar as exactly one bounded argv value', () => {
  const result = shell(
    `${config}\n systemd-analyze() { printf 'arg:<%s>\\n' "$@" >&2; }\noperations_timers_validate`,
    'render-systemd-units.sh',
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr.trim().split('\n')).toEqual([
    'arg:<calendar>',
    'arg:<-->',
    'arg:<*-*-* 02:00:00 UTC>',
    'arg:<calendar>',
    'arg:<-->',
    'arg:<*-*-* *:00/5:00 UTC>',
    'arg:<calendar>',
    'arg:<-->',
    'arg:<*-*-* *:*:00 UTC>',
  ]);
});

test.each([
  ['FCD_BACKUP_CALENDAR', '*-*-* 02:00:00 UTC', true],
  ['FCD_MAINTENANCE_CALENDAR', '*-*-* *:00/5:00 UTC', true],
  ['FCD_HEALTH_CALENDAR', '*-*-* *:*:00 UTC', true],
  ['FCD_BACKUP_CALENDAR', 'a'.repeat(128), true],
  ['FCD_BACKUP_CALENDAR', 'a'.repeat(129), false],
  ['FCD_BACKUP_CALENDAR', '--help', false],
  ['FCD_BACKUP_CALENDAR', '%n', false],
  ['FCD_BACKUP_CALENDAR', 'daily\nsynthetic', false],
  ['FCD_BACKUP_CALENDAR', 'daily\tsynthetic', false],
  ['FCD_BACKUP_CALENDAR', 'daily\rsynthetic', false],
  ['FCD_BACKUP_CALENDAR', 'daily;synthetic', false],
  ['FCD_MAINTENANCE_SLOT_SECONDS', '1', true],
  ['FCD_MAINTENANCE_SLOT_SECONDS', '86400', true],
  ['FCD_MAINTENANCE_SLOT_SECONDS', '86401', false],
  ['FCD_TIMER_TIMEOUT_SECONDS', '86400', true],
  ['FCD_TIMER_TIMEOUT_SECONDS', '0', false],
  ['FCD_TIMER_TIMEOUT_SECONDS', '01', false],
  ['FCD_TIMER_MEMORY_MIB', '32', true],
  ['FCD_TIMER_MEMORY_MIB', '16777216', true],
  ['FCD_TIMER_MEMORY_MIB', '31', false],
  ['FCD_TIMER_TASKS_MAX', '16', true],
  ['FCD_TIMER_TASKS_MAX', '16777217', false],
  ['FCD_TIMER_CPUS', '0.125', true],
  ['FCD_TIMER_CPUS', '999.999', true],
  ['FCD_TIMER_CPUS', '0.000', false],
  ['FCD_TIMER_CPUS', '1e2', false],
  ['FCD_TIMER_ACCURACY_SECONDS', '3600', true],
  ['FCD_TIMER_ACCURACY_SECONDS', '0', false],
  ['FCD_TIMER_RANDOMIZED_DELAY_SECONDS', '0', true],
  ['FCD_TIMER_RANDOMIZED_DELAY_SECONDS', '3600', true],
  ['FCD_TIMER_RANDOMIZED_DELAY_SECONDS', '3601', false],
] as const)(
  'literal timer field %s rejects values outside its closed contract',
  (key, value, valid) => {
    const result = shell(
      'operations_config_field "$TASK_KEY" "$TASK_VALUE"',
      'operations-common.sh',
      { TASK_KEY: key, TASK_VALUE: value },
    );
    expect(result.status, result.stderr).toBe(valid ? 0 : 1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  },
);

test.each([
  '*-*-* 02:00 UTC\n[Service]\nExecStart=/synthetic/evil',
  '$(synthetic)',
  '@daily',
  '--help',
  '%n',
  'daily;synthetic',
  'daily\\synthetic',
  'a'.repeat(129),
])('renderer rejects malicious calendar %j before analysis', (calendar) => {
  const result = shell(
    `${config}\nOPS_CONFIG[FCD_BACKUP_CALENDAR]=$TASK_CALENDAR\nsystemd-analyze() { printf unsafe >&2; }\noperations_timers_validate`,
    'render-systemd-units.sh',
    { TASK_CALENDAR: calendar },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toBe('operations_timer_config_invalid\n');
});

test('calendar analyzer failure and resource bounds refuse before rendering', () => {
  const analyzer = shell(
    `${config}\nsystemd-analyze() { return 1; }\noperations_timers_validate`,
    'render-systemd-units.sh',
  );
  expect(analyzer.status).toBe(1);
  expect(analyzer.stderr).toBe('operations_timer_calendar_invalid\n');
  for (const bad of [
    'FCD_TIMER_TIMEOUT_SECONDS]=0',
    'FCD_TIMER_MEMORY_MIB]=31',
    'FCD_TIMER_TASKS_MAX]=0',
    'FCD_MAINTENANCE_SLOT_SECONDS]=86401',
  ]) {
    const result = shell(
      `${config}\nOPS_CONFIG[${bad}\nsystemd-analyze() { :; }\noperations_timers_validate`,
      'render-systemd-units.sh',
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('operations_timer_config_invalid\n');
  }
});

test('scripts contain no installation, unjournalled jobs or shell evaluation', () => {
  for (const file of ['run-operation.sh', 'render-systemd-units.sh']) {
    const script = readFileSync(`scripts/${file}`, 'utf8');
    expect(script).not.toMatch(/\bsystemctl\b|run --rm|\beval\b|source.*common\.env/u);
    const syntax = spawnSync(bash, ['-n', resolve('scripts', file).replaceAll('\\', '/')], {
      encoding: 'utf8',
    });
    expect(syntax.status, syntax.stderr).toBe(0);
  }
});

test.each([true, false])(
  'scheduled health merges trusted host facts with the outage gap: %s',
  (available) => {
    const snapshot = {
      checkedAt: '2030-04-14T12:15:00.000Z',
      services: [],
      adminSocket: 'unknown',
      manifestAttestation: 'not_verified',
      publicRouteCheck: { state: 'not_verified' },
    };
    const result = shell(
      `${config}
OPS_SCHEDULED_AT=2030-04-14T12:15:00.000Z
operations_health_gap_read() { OPS_HEALTH_GAP_STARTED=2030-04-14T12:00:00.000Z; OPS_HEALTH_GAP_LAST=2030-04-14T12:05:00.000Z; }
operations_collect_health_host() { ${available ? 'printf \'%s\' "$TASK_HOST"' : 'return 1'}; }
operations_execute_job() { [[ "$*" == 'health health' ]] || return 1; printf '%s' "$OPS_HEALTH_INPUT_JSON" >&2; printf '%s' '{"status":"completed","processed":11,"reasonCode":"ok"}'; }
rm() { :; }; sync() { :; }
operations_scheduled_health`,
      'run-operation.sh',
      { TASK_HOST: JSON.stringify(snapshot) },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      ...(available ? { hostSnapshot: snapshot } : {}),
      outageGap: {
        startedAt: '2030-04-14T12:00:00.000Z',
        lastObservedAt: '2030-04-14T12:05:00.000Z',
      },
    });
  },
);

test.runIf(native)(
  'native render verifies and atomically publishes one protected generation without overwriting it',
  async () => {
    const root = await mkdtemp('/var/lib/fcd-support/backups/systemd-render-test-');
    await chmod(root, 0o700);
    try {
      const dependencies = join(root, 'dependencies');
      await mkdir(dependencies, { mode: 0o700 });
      await writeFile(
        join(dependencies, 'docker.service'),
        '[Unit]\nDescription=Synthetic Docker dependency for offline verification\n[Service]\nType=oneshot\nExecStart=/usr/bin/true\n',
        { mode: 0o600 },
      );
      await writeFile(join(root, 'host.conf'), '# Synthetic protected configuration reference\n', {
        mode: 0o600,
      });
      const body = `${config}\nOPS_ROOT=$TASK_WORKSPACE; OPS_CONFIG_FILE=$TASK_ROOT/host.conf\nexport SYSTEMD_UNIT_PATH=$TASK_DEPENDENCIES:\nsystemd-analyze() { command systemd-analyze "$@" 2>> "$TASK_ROOT/analyzer-stderr"; }\noperations_timers_render "$TASK_ROOT/units"`;
      const extra = {
        TASK_ROOT: root,
        TASK_DEPENDENCIES: dependencies,
        TASK_WORKSPACE: process.cwd(),
      };
      const result = shell(body, 'render-systemd-units.sh', extra);
      const diagnostics = await readFile(join(root, 'analyzer-stderr'), 'utf8');
      expect(
        { status: result.status, stdout: result.stdout, stderr: result.stderr },
        diagnostics,
      ).toEqual({
        status: 0,
        stdout: '',
        stderr: '',
      });
      expect((await readdir(join(root, 'units'))).sort()).toEqual([
        'fcd-support-backup.timer',
        'fcd-support-health.timer',
        'fcd-support-maintenance.timer',
        'fcd-support-operation@.service',
      ]);
      const unit = await readFile(join(root, 'units', 'fcd-support-operation@.service'), 'utf8');
      expect(unit).toContain(
        `ExecStart=/usr/bin/bash ${process.cwd()}/scripts/run-operation.sh %i ${revision} ${root}/host.conf`,
      );
      expect(unit).toContain('CPUQuota=100.000%');
      expect(unit).not.toMatch(/@[A-Z_]+@/u);
      const repeated = shell(body, 'render-systemd-units.sh', extra);
      expect(repeated.status).toBe(1);
      expect(repeated.stderr).toBe('operations_timer_destination_invalid\n');
      expect(await readFile(join(root, 'units', 'fcd-support-operation@.service'), 'utf8')).toBe(
        unit,
      );
      const rejected = shell(
        `${config}\nOPS_ROOT=$TASK_WORKSPACE; OPS_CONFIG_FILE=$TASK_ROOT/host.conf\nsystemd-analyze() { [[ "$1" == calendar ]]; }\noperations_timers_render "$TASK_ROOT/rejected"`,
        'render-systemd-units.sh',
        extra,
      );
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toBe('operations_timer_verification_failed\n');
      expect((await readdir(root)).sort()).toEqual([
        'analyzer-stderr',
        'dependencies',
        'host.conf',
        'units',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test.runIf(native)(
  'durable health outage keeps the earliest failure across activations until confirmed recovery',
  async () => {
    const root = await mkdtemp('/var/lib/fcd-support/backups/health-gap-test-');
    await chmod(root, 0o700);
    try {
      const run = (at: string, acknowledgement: string, failed = false) =>
        shell(
          `${config}\nOPS_CONFIG[FCD_STATE_ROOT]=$TASK_ROOT; OPS_SCHEDULED_AT=$TASK_AT\noperations_execute_job() { printf '%s' "$OPS_HEALTH_INPUT_JSON" > "$TASK_ROOT/input"; ${failed ? 'return 1' : 'printf \'%s\\n\' "$TASK_ACK"'}; }\noperations_scheduled_health`,
          'run-operation.sh',
          { TASK_ROOT: root, TASK_AT: at, TASK_ACK: acknowledgement },
        );
      const unavailable =
        '{"status":"completed","processed":0,"reasonCode":"dependency_unavailable"}';
      const firstAt = '2030-04-14T12:00:00.000Z';
      const nextAt = '2030-04-14T12:05:00.000Z';
      for (const at of [firstAt, nextAt]) {
        const result = run(at, unavailable);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe('');
        expect(JSON.parse(result.stderr)).toEqual({
          event: 'operations_health',
          component: 'postgres',
          state: 'unavailable',
          checkedAt: at,
        });
        expect(await readFile(join(root, 'health-outage'), 'utf8')).toBe(
          `OUTAGE_VERSION=1\nOUTAGE_STARTED_AT=${firstAt}\nOUTAGE_LAST_OBSERVED_AT=${at}\n`,
        );
      }
      const marker = await readFile(join(root, 'health-outage'), 'utf8');
      const failed = run('2030-04-14T12:10:00.000Z', '', true);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toBe('operations_schedule_failed\n');
      expect(await readFile(join(root, 'health-outage'), 'utf8')).toBe(marker);
      const recovered = run(
        '2030-04-14T12:15:00.000Z',
        '{"status":"completed","processed":8,"reasonCode":"ok"}',
      );
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(JSON.parse(await readFile(join(root, 'input'), 'utf8'))).toEqual({
        outageGap: { startedAt: firstAt, lastObservedAt: nextAt },
      });
      expect(await readdir(root)).not.toContain('health-outage');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.runIf(native).each(['interrupted', 'malformed'])(
  'health refuses an %s outage marker before job execution',
  async (kind) => {
    const root = await mkdtemp('/var/lib/fcd-support/backups/health-gap-invalid-test-');
    await chmod(root, 0o700);
    try {
      await writeFile(
        join(root, kind === 'interrupted' ? 'health-outage.next' : 'health-outage'),
        'synthetic_invalid_gap\n',
        { mode: 0o600 },
      );
      const result = shell(
        `${config}\nOPS_CONFIG[FCD_STATE_ROOT]=$TASK_ROOT; OPS_SCHEDULED_AT='${stamp}'\noperations_execute_job() { printf unsafe; }\noperations_scheduled_health`,
        'run-operation.sh',
        { TASK_ROOT: root },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('operations_health_gap_invalid\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
