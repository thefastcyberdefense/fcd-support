"""Fresh private-disabled version one after owner-authorized test retirement."""
import datetime
import http.client
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import socket
import subprocess
import sys

REVISION = 'c2d8225d2a096e2d4f406c35f8ab170a6dad2f80'
HOME = Path('/home/redwan')
SOURCE = HOME / 'fcd-support-v1-source-c2d8225'
BUNDLE = HOME / 'fcd-support-v1-source.bundle'
PROJECT = 'fcd-support-host-test-v1-c2d8225'
FIXTURE = HOME / PROJECT
ACTION = HOME / 'fcd-support-v1-action-20261116'
RETIREMENT = HOME / 'fcd-support-retirement-completion-20261116/retirement.json'
ENDPOINT = 'unix:///var/run/docker.sock'
FLAGS = {'MODEL_EXECUTION_ENABLED': 'false', 'OUTBOUND_EXECUTION_ENABLED': 'false', 'N8N_EXECUTION_ENABLED': 'false'}


class Refusal(Exception):
    pass


def require(value):
    if not value:
        raise Refusal('private_deployment_refused')


def admit(value):
    require(value['retirement_complete'] and not value['old_fcd_resources'])
    require(value['namespace_absent'] and value['paths_absent'] and value['paths_disjoint'])
    require(value['disk_mib'] >= 12288 and value['memory_mib'] >= 2048)
    try:
        existing = [ipaddress.ip_network(item, strict=False) for item in value['network_blocks']]
    except ValueError:
        raise Refusal('network_observation_invalid') from None
    for start in range(0, 256, 16):
        candidate = ipaddress.ip_network('198.19.' + str(start) + '.0/20')
        if not any(item.version == 4 and item.prefixlen != 0 and candidate.overlaps(item) for item in existing):
            return str(candidate)
    raise Refusal('network_block_unavailable')


def namespace_absent(state):
    for kind in ['actors', 'volumes', 'networks']:
        for row in state[kind]:
            name = row.get('name', '').lstrip('/')
            if name == PROJECT or name.startswith(PROJECT + '-') or row.get('project') == PROJECT or row.get('synthetic') == PROJECT:
                return False
    return not any(tag.rsplit(':', 1)[0].startswith(PROJECT + '-')
                   for image in state['images'] for tag in (image.get('tags') or []))


def lifecycle_commands():
    config = str(FIXTURE / 'config/operations.env')
    return [['bash', str(SOURCE / 'scripts/deploy-runtime.sh'), REVISION, '--mode', 'private-disabled', config],
            ['bash', str(SOURCE / 'scripts/verify-runtime.sh'), REVISION, config]]


class Reader:
    def run(self, args, timeout=30, cwd=None):
        process = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout, cwd=cwd,
                                 env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(HOME), 'LC_ALL': 'C', 'GIT_TERMINAL_PROMPT': '0'})
        require(process.returncode == 0 and len(process.stdout) <= 4194304 and len(process.stderr) <= 1048576)
        return process.stdout.strip()

    def docker(self, *args):
        return self.run(['docker', '--host', ENDPOINT, *args], timeout=900 if args[0] == 'build' else 180)

    def resources(self):
        spec = importlib.util.spec_from_file_location('retirement_reader', Path(__file__).with_name('2026-11-16-retire-tests.py'))
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        return module.Reader().snapshot(), module

    def admission(self):
        state, retirement = self.resources()
        paths = [SOURCE, FIXTURE, ACTION]
        foreign_mounts = [m['Source'] for a in state['actors'] for m in a['mounts'] if m['Type'] == 'bind']
        blocks = []
        for ident in self.docker('network', 'ls', '--quiet').split():
            configuration = json.loads(self.docker('network', 'inspect', '--format', '{{json .IPAM.Config}}', ident)) or []
            blocks.extend(row['Subnet'] for row in configuration if row.get('Subnet'))
        for row in json.loads(self.run(['ip', '-j', 'route', 'show'])):
            if row.get('dst') and row['dst'] != 'default': blocks.append(row['dst'])
        mem = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
        retired = False
        if RETIREMENT.is_file() and not RETIREMENT.is_symlink():
            retired = json.loads(RETIREMENT.read_text()).get('phase') == 'complete'
        observation = {
            'retirement_complete': retired,
            'old_fcd_resources': any(retirement.is_fcd(a['name']) for a in state['actors']) or
                                 any(retirement.is_fcd(v['name']) for v in state['volumes']) or
                                 any(retirement.is_fcd(n['name']) for n in state['networks']),
            'namespace_absent': namespace_absent(state),
            'paths_absent': all(not p.exists() and not p.is_symlink() for p in paths),
            'paths_disjoint': all(not retirement.overlaps(str(p), mount) for p in paths for mount in foreign_mounts),
            'disk_mib': int(self.run(['df', '-Pk', '/var/lib/docker']).splitlines()[-1].split()[3]) // 1024,
            'memory_mib': int(mem['MemAvailable'].split()[0]) // 1024,
            'network_blocks': blocks,
        }
        return observation, state


def write_private(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w', newline='\n') as stream:
        stream.write(value); stream.flush(); os.fsync(stream.fileno())


def write_protocol_line(path, value, append=False):
    line = value + '\n'
    if append:
        with path.open('a', newline='\n') as stream: stream.write(line)
    else:
        write_private(path, line)


def validate_flags():
    fields = dict(line.split('=', 1) for line in (FIXTURE / 'config/common.env').read_text().splitlines() if '=' in line)
    require(all(fields.get(key) == expected for key, expected in FLAGS.items()))


def private_login_status():
    class UnixConnection(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(5)
            self.sock.connect(str(FIXTURE / 'socket/admin.sock'))
    connection = UnixConnection('127.0.0.1:13004', timeout=5)
    try:
        connection.request('GET', '/login')
        response = connection.getresponse(); response.read(1048577)
        require(response.status == 200)
    finally:
        connection.close()


def execute(reader):
    require(sys.platform == 'linux' and os.getuid() == os.getgid() == 1000 and HOME.resolve() == HOME)
    observation, before = reader.admission(); block = ipaddress.ip_network(admit(observation))
    require(BUNDLE.is_file() and not BUNDLE.is_symlink() and BUNDLE.stat().st_uid == 1000 and BUNDLE.stat().st_nlink == 1)
    ACTION.mkdir(mode=0o700)
    record = {'phase': 'intent', 'stage': 'source', 'revision': REVISION,
              'started': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    def save():
        temporary = ACTION / 'deployment.next'
        write_private(temporary, json.dumps(record)); os.replace(temporary, ACTION / 'deployment.json')
    save()
    try:
        reader.run(['git', '-c', 'core.hooksPath=/dev/null', 'clone', '--no-hardlinks', '--single-branch', '--branch', 'main', str(BUNDLE), str(SOURCE)], timeout=180)
        require(reader.run(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD']) == REVISION)
        reader.run(['git', '-C', str(SOURCE), 'checkout', '--detach', REVISION])
        require(not reader.run(['git', '-C', str(SOURCE), 'status', '--porcelain']))
        SOURCE.chmod(0o700)
        record['stage'] = 'fixture'; save()
        reader.run(['node', str(SOURCE / 'tests/helpers/runtime-host-fixture.ts'), str(FIXTURE), PROJECT, REVISION], timeout=30)
        validate_flags()
        record['stage'] = 'images'; save()
        for role, dockerfile in [('application', 'Dockerfile'), ('operations', 'infra/Dockerfile.operations'), ('postgres', 'infra/Dockerfile.postgres')]:
            reader.docker('build', '--platform', 'linux/amd64', '--build-arg', 'VCS_REF=' + REVISION,
                          '--label', 'fcd-support.synthetic-host-test=' + PROJECT, '--file', str(SOURCE / dockerfile),
                          '--tag', PROJECT + '-' + role + ':' + REVISION, str(SOURCE))
        record['stage'] = 'keys'; save()
        safe = ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--cpus', '0.25', '--memory', '128m', '--pids-limit', '32', '--label', 'fcd-support.synthetic-host-test=' + PROJECT]
        ops_image = PROJECT + '-operations:' + REVISION
        app_image = PROJECT + '-application:' + REVISION
        reader.docker(*safe, '--user', 'node', '--mount', 'type=bind,src=' + str(FIXTURE / 'secrets/verify-backup') + ',dst=/keys',
                      '--entrypoint', 'age-keygen', ops_image, '-o', '/keys/restore-identity')
        recipient = reader.docker(*safe, '--user', 'node', '--mount', 'type=bind,src=' + str(FIXTURE / 'secrets/verify-backup/restore-identity') + ',dst=/identity,readonly',
                                  '--entrypoint', 'age-keygen', ops_image, '-y', '/identity')
        write_protocol_line(FIXTURE / 'secrets/backup/backup-recipient', recipient)
        for relative in ['postgres/postgres-password', 'restore/restore-postgres-password']:
            path = FIXTURE / 'secrets' / relative
            require(path.is_file() and not path.is_symlink() and path.stat().st_uid == 1000)
            reader.docker(*safe, '--user', '0:0', '--cap-add', 'CHOWN', '--mount', 'type=bind,src=' + str(path) + ',dst=/synthetic-postgres-password',
                          '--entrypoint', 'chown', app_image, '999:999', '/synthetic-postgres-password')
            require(path.stat().st_uid == 999)
        record['stage'] = 'resources'; save()
        ranges = list(block.subnets(new_prefix=24))
        reader.docker('volume', 'create', '--label', 'fcd-support.synthetic-host-test=' + PROJECT, PROJECT + '-backups')
        reader.docker('network', 'create', '--internal', '--driver', 'bridge', '--subnet', str(ranges[0]),
                      '--label', 'fcd-support.synthetic-host-test=' + PROJECT, PROJECT + '-ingress')
        reader.docker('network', 'create', '--driver', 'bridge', '--subnet', str(ranges[1]),
                      '--label', 'fcd-support.synthetic-host-test=' + PROJECT, PROJECT + '-egress')
        peer = reader.docker('run', '--detach', '--name', PROJECT + '-ingress-peer', '--label', 'fcd-support.synthetic-host-test=' + PROJECT,
                             '--network', PROJECT + '-ingress', '--user', 'node', '--init', '--read-only', '--cap-drop', 'ALL',
                             '--security-opt', 'no-new-privileges', '--cpus', '0.25', '--memory', '128m', '--pids-limit', '32',
                             '--entrypoint', 'node', app_image, '-e', 'setInterval(()=>{},1000)')
        require(len(peer) == 64 and all(c in 'abcdef0123456789' for c in peer))
        reader.docker('network', 'connect', PROJECT + '-egress', peer)
        write_protocol_line(FIXTURE / 'config/operations.env', 'FCD_INGRESS_PEER_ID=' + peer, append=True)
        record['stage'] = 'deploy'; save()
        for command in lifecycle_commands():
            reader.run(command, timeout=900, cwd=str(SOURCE))
        record['stage'] = 'verify'; save()
        validate_flags(); private_login_status()
        after, _ = reader.resources()
        original = {a['id']: a for a in before['actors']}
        require({a['id']: a for a in after['actors'] if a['id'] in original} == original)
        own = [a for a in after['actors'] if a['project'] == PROJECT]
        require(len(own) == 4)
        for actor in own:
            ports = reader.docker('container', 'inspect', '--format', '{{json .HostConfig.PortBindings}}', actor['id'])
            require(ports in ['null', '{}'])
            require(reader.docker('container', 'inspect', '--format', '{{.State.Health.Status}}', actor['id']) == 'healthy')
        record['phase'] = 'complete'; save()
        print('private_v1_deployed=true')
        print('private_services_healthy=4')
        print('private_unix_login_status=200')
        print('external_execution_enabled=false')
        print('public_tunnel_created=false')
        print('administrator_bootstrap_pending=true')
    except Exception:
        record['phase'] = 'uncertain'; save()
        raise


def main(args):
    try:
        reader = Reader()
        if args == ['--inspect']:
            observation, _ = reader.admission(); admit(observation)
            print('private_v1_admission_passed=true')
        elif args == ['--deploy']:
            execute(reader)
        elif args == ['--verify']:
            require(json.loads((ACTION / 'deployment.json').read_text())['phase'] == 'complete')
            reader.run(lifecycle_commands()[1], timeout=900, cwd=str(SOURCE)); validate_flags(); private_login_status()
            print('private_v1_verification_passed=true')
        else:
            raise Refusal('arguments')
        return 0
    except Exception:
        print('private_v1_refused=true')
        return 1


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
