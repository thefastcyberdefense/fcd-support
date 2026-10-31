"""Passive synthetic-only observer. Never recovery or readiness authority."""
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import time

REVISION = '67a4a4bede6d3252dc936a6e410f4b90c1359ac3'
PROJECT = 'fcd-support-host-test-p6-67a4a4b'
ROOT = Path('/home/redwan') / PROJECT
OUTPUT = Path('/home/redwan/fcd-support-p6-action-67a4a4b/restore-drill/promotion-observer.jsonl')
STAGES = frozenset([
    'observer_ready', 'observer_finished', 'observer_timeout', 'observer_interrupted', 'reader_ended',
    'container_start', 'container_die', 'container_destroy', 'container_kill',
    'container_stop', 'challenge_1', 'challenge_2', 'command_completed',
    'command_refused', 'protocol_invalid', 'unexpected_output', 'guard_refused',
    'output_limit', 'record_limit',
])
JOB_FIELDS = frozenset([
    'JOB_VERSION', 'JOB_REF', 'JOB_PARENT', 'JOB_SERVICE', 'JOB_REVISION',
    'JOB_IMAGE', 'JOB_COMMAND_SHA256', 'JOB_CONTAINER', 'JOB_PHASE',
])


class StopSignals:
    def __init__(self):
        self.interrupted = False
        self.previous = {}

    def request_stop(self, number, frame):
        # A flag avoids raising between Popen and registering an owned reader.
        self.interrupted = True

    def install(self):
        for number in (signal.SIGTERM, getattr(signal, 'SIGHUP', None)):
            if number is not None:
                self.previous[number] = signal.getsignal(number)
                signal.signal(number, self.request_stop)

    def restore(self):
        for number, previous in self.previous.items():
            signal.signal(number, previous)


def strict_json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('observer_json_invalid')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=unique)


def protocol_stage(line, reference, sequence=1, previous=None):
    if line == b'promotion_command_failed':
        return 'command_refused', sequence, previous
    try:
        frame = strict_json(line.decode('utf-8'))
    except (ValueError, UnicodeError):
        return 'unexpected_output', sequence, previous
    if not isinstance(frame, dict):
        return 'unexpected_output', sequence, previous
    if frame == {'status': 'completed', 'processed': 1, 'reasonCode': 'ok'}:
        stage = 'command_completed' if sequence == 3 and type(frame['processed']) is int else 'protocol_invalid'
        return stage, sequence, previous
    keys = {'event', 'operationRef', 'sequence', 'challenge'}
    if (set(frame) != keys or frame['event'] != 'promotion_host_check'
            or frame['operationRef'] != reference or type(frame['sequence']) is not int
            or frame['sequence'] != sequence or sequence not in (1, 2)
            or not isinstance(frame['challenge'], str)
            or not re.fullmatch('[a-f0-9]{32}', frame['challenge'])
            or frame['challenge'] == previous):
        return 'protocol_invalid', sequence, previous
    return 'challenge_' + str(sequence), sequence + 1, frame['challenge']


def event_identity(frame, project, revision):
    if not isinstance(frame, dict) or frame.get('Type') != 'container':
        return None
    actor = frame.get('Actor')
    if not isinstance(actor, dict) or not isinstance(actor.get('ID'), str):
        return None
    attributes = actor.get('Attributes')
    if not isinstance(attributes, dict) or not re.fullmatch('[a-f0-9]{64}', actor['ID']):
        return None
    expected = {'fcd-support.operation.parent': project,
                'fcd-support.operation.service': 'promote',
                'org.opencontainers.image.revision': revision}
    if any(attributes.get(key) != value for key, value in expected.items()):
        return None
    reference = attributes.get('fcd-support.operation.ref')
    command = attributes.get('fcd-support.operation.command')
    if (not isinstance(reference, str) or not re.fullmatch('operation_[a-f0-9]{32}', reference)
            or not isinstance(command, str) or not re.fullmatch('[a-f0-9]{64}', command)):
        return None
    return actor['ID'], reference, command


def split_frames(buffer, chunk, maximum):
    if len(chunk) > 65536:
        raise ValueError('observer_output_limit')
    frames = (buffer + chunk).split(b'\n')
    if any(len(frame) > maximum for frame in frames):
        raise ValueError('observer_output_limit')
    return [frame.removesuffix(b'\r') for frame in frames[:-1]], frames[-1]


def closed_record(stage, elapsed_ms, exit_code=None):
    if (stage not in STAGES or type(elapsed_ms) is not int or not 0 <= elapsed_ms <= 300000
            or (exit_code is not None and (stage != 'container_die'
                or type(exit_code) is not int or not 0 <= exit_code <= 255))):
        raise ValueError('observer_record_invalid')
    result = {'stage': stage, 'elapsedMs': elapsed_ms}
    if exit_code is not None:
        result['exitCode'] = exit_code
    return result


def bind_job(identity, job, actual, project, revision):
    if not isinstance(job, dict) or set(job) != JOB_FIELDS:
        return False
    actor, reference, command = identity
    image = job.get('JOB_IMAGE')
    return (job['JOB_VERSION'] == '1' and job['JOB_PARENT'] == project
            and job['JOB_SERVICE'] == 'promote' and job['JOB_REVISION'] == revision
            and job['JOB_PHASE'] in ('started', 'uncertain')
            and job['JOB_REF'] == reference and job['JOB_CONTAINER'] == actor
            and job['JOB_COMMAND_SHA256'] == command and isinstance(image, str)
            and re.fullmatch('sha256:[a-f0-9]{64}', image) is not None
            and actual == [actor, image, reference, project, 'promote', command, revision])


def attach_logs(identity, project, revision, read_job, inspect, launch):
    before = read_job()
    if (not isinstance(before, tuple) or len(before) != 2
            or not isinstance(before[1], tuple) or len(before[1]) != 5
            or any(type(value) is not int or value < 0 for value in before[1])):
        raise ValueError('observer_guard_refused')
    actual = inspect(identity[0])
    after = read_job()
    if before != after or not bind_job(identity, after[0], actual, project, revision):
        raise ValueError('observer_guard_refused')
    return launch(identity[0])


def docker_arguments(arguments):
    if not arguments or not (arguments[0] == 'events' or
            (len(arguments) >= 2 and arguments[:2] in (['container', 'inspect'], ['container', 'logs']))):
        raise ValueError('observer_command_refused')
    return ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', *arguments]


def protected_directory(path):
    if path.resolve(strict=True) != path:
        raise ValueError('observer_guard_refused')
    for parent in [path, *path.parents]:
        info = parent.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, 1000)
                or info.st_mode & 0o022):
            raise ValueError('observer_guard_refused')
    info = path.lstat()
    if (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (1000, 1000, 0o700):
        raise ValueError('observer_guard_refused')


def read_job():
    protected_directory(ROOT / 'state')
    path = ROOT / 'state/active-job'
    before = path.lstat()
    if (not stat.S_ISREG(before.st_mode) or before.st_size > 16384
            or (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode), before.st_nlink)
            != (1000, 1000, 0o600, 1)):
        raise ValueError('observer_guard_refused')
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as handle:
        opened = os.fstat(handle.fileno())
        raw = handle.read(16385)
        after = os.fstat(handle.fileno())
    stamp = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    if stamp(before) != stamp(opened) or stamp(opened) != stamp(after) or len(raw) != before.st_size:
        raise ValueError('observer_guard_refused')
    pairs = [line.split('=', 1) for line in raw.decode('ascii').splitlines()]
    if any(len(pair) != 2 for pair in pairs) or len(pairs) != len(dict(pairs)):
        raise ValueError('observer_guard_refused')
    result = dict(pairs)
    if set(result) != JOB_FIELDS:
        raise ValueError('observer_guard_refused')
    return result, stamp(after)


def observe(maximum_seconds):
    if sys.platform != 'linux' or (os.getuid(), os.getgid()) != (1000, 1000):
        raise ValueError('observer_guard_refused')
    protected_directory(ROOT)
    protected_directory(OUTPUT.parent)
    if (ROOT / 'state/active-job').exists() or (ROOT / 'state/active-job').is_symlink():
        raise ValueError('observer_guard_refused')
    started = time.monotonic()
    selector = selectors.DefaultSelector()
    processes = []
    buffers = {}
    identity = None
    sequence, previous, destroyed_at, logs_ended = 1, None, None, False
    count = 0
    signals = StopSignals()
    environment = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'HOME': '/nonexistent'}
    with os.fdopen(os.open(OUTPUT, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600),
                   'w', encoding='ascii') as output:
        def emit(stage, exit_code=None):
            nonlocal count
            if count >= 64:
                raise ValueError('observer_record_limit')
            record = closed_record(stage, min(300000, int((time.monotonic() - started) * 1000)), exit_code)
            output.write(json.dumps(record, separators=(',', ':')) + '\n')
            output.flush()
            os.fsync(output.fileno())
            count += 1

        def launch(arguments, kind):
            until = str(int(time.time()) + maximum_seconds + 5)
            prefix = 1 if kind == 'events' else 2
            arguments = [*arguments[:prefix], '--until', until, *arguments[prefix:]]
            process = subprocess.Popen(docker_arguments(arguments), stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT if kind == 'logs' else subprocess.DEVNULL,
                env=environment)
            processes.append(process)
            os.set_blocking(process.stdout.fileno(), False)
            selector.register(process.stdout, selectors.EVENT_READ, kind)
            buffers[kind] = b''
            return process

        def inspect(actor):
            template = ('[{{json .Id}},{{json .Image}},'
                '{{json (index .Config.Labels "fcd-support.operation.ref")}},'
                '{{json (index .Config.Labels "fcd-support.operation.parent")}},'
                '{{json (index .Config.Labels "fcd-support.operation.service")}},'
                '{{json (index .Config.Labels "fcd-support.operation.command")}},'
                '{{json (index .Config.Labels "org.opencontainers.image.revision")}}]')
            result = subprocess.run(docker_arguments(['container', 'inspect', '--format', template, actor]),
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                env=environment, timeout=5)
            if result.returncode or len(result.stdout) > 4096:
                raise ValueError('observer_guard_refused')
            return strict_json(result.stdout)

        try:
            signals.install()
            events = launch(['events', '--since', str(int(time.time()) - 5),
                '--filter', 'type=container', '--filter', 'label=fcd-support.operation.parent=' + PROJECT,
                '--filter', 'label=fcd-support.operation.service=promote', '--format', '{{json .}}'], 'events')
            if events.poll() is not None:
                raise ValueError('observer_guard_refused')
            emit('observer_ready')
            print('promotion_observer_ready=true', flush=True)
            while not signals.interrupted and time.monotonic() - started < maximum_seconds:
                if destroyed_at is not None and logs_ended and time.monotonic() - destroyed_at >= 1:
                    emit('observer_finished')
                    print('promotion_observer_finished=true', flush=True)
                    return 0
                for key, _ in selector.select(timeout=0.2):
                    kind = key.data
                    chunk = os.read(key.fileobj.fileno(), 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        if buffers[kind]:
                            emit('unexpected_output')
                        if kind == 'events':
                            emit('reader_ended')
                            return 2
                        logs_ended = True
                        continue
                    frames, buffers[kind] = split_frames(buffers[kind], chunk, 16384 if kind == 'events' else 2048)
                    for frame in frames:
                        if kind == 'logs':
                            stage, sequence, previous = protocol_stage(frame, identity[1], sequence, previous)
                            emit(stage)
                            continue
                        value = strict_json(frame)
                        current = event_identity(value, PROJECT, REVISION)
                        if current is None:
                            continue
                        action = value.get('Action')
                        if identity is None and action == 'start':
                            identity = current
                            attach_logs(identity, PROJECT, REVISION, read_job, inspect,
                                lambda actor: launch(['container', 'logs', '--follow', '--tail', '8', actor], 'logs'))
                        if current != identity:
                            continue
                        if action in ('start', 'kill', 'stop', 'die', 'destroy'):
                            exit_code = None
                            if action == 'die':
                                raw_exit = value['Actor']['Attributes'].get('exitCode')
                                if not isinstance(raw_exit, str) or not re.fullmatch('[0-9]{1,3}', raw_exit) or int(raw_exit) > 255:
                                    raise ValueError('observer_guard_refused')
                                exit_code = int(raw_exit)
                            emit('container_' + action, exit_code)
                            if action == 'destroy':
                                destroyed_at = time.monotonic()
            emit('observer_interrupted' if signals.interrupted else 'observer_timeout')
            print('promotion_observer_partial=true', flush=True)
            return 2
        except Exception:
            # Never serialize exception text or arbitrary event/log content.
            if count < 64:
                emit('guard_refused')
            print('promotion_observer_refused=true', flush=True)
            return 1
        finally:
            try:
                selector.close()
                for process in processes:
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=2)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=2)
                    process.stdout.close()
            finally:
                signals.restore()


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3 or sys.argv[1] != '--observe' or not re.fullmatch('[0-9]{1,3}', sys.argv[2]):
            raise ValueError('observer_arguments_invalid')
        seconds = int(sys.argv[2])
        if not 10 <= seconds <= 300:
            raise ValueError('observer_arguments_invalid')
        result = observe(seconds)
    except Exception:
        print('promotion_observer_refused=true', flush=True)
        result = 1
    raise SystemExit(result)
