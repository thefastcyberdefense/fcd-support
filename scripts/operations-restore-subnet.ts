import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Ipv4Range {
  first: number;
  last: number;
  prefix: number;
}

function ipv4Range(value: string, canonicalNetwork: boolean): Ipv4Range | undefined {
  const match =
    /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})(?:\/(0|[1-9]\d?))?$/.exec(
      value,
    );
  if (!match) return undefined;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((part) => part > 255)) return undefined;
  const prefix = match[5] === undefined ? 32 : Number(match[5]);
  if (prefix > 32) return undefined;
  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
  const address = a * 2 ** 24 + b * 2 ** 16 + c * 2 ** 8 + d;
  const size = 2 ** (32 - prefix);
  const first = Math.floor(address / size) * size;
  if (canonicalNetwork && first !== address) return undefined;
  return { first, last: first + size - 1, prefix };
}

function overlaps(left: Ipv4Range, right: Ipv4Range): boolean {
  return left.first <= right.last && right.first <= left.last;
}

export function isValidRestoreSubnet(value: string): boolean {
  if (!value.includes('/')) return false;
  const subnet = ipv4Range(value, true);
  if (!subnet || subnet.prefix < 8 || subnet.prefix > 29) return false;
  return ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '198.18.0.0/15'].some((block) => {
    const allowed = ipv4Range(block, true);
    return allowed !== undefined && subnet.first >= allowed.first && subnet.last <= allowed.last;
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function inventoryAllowsRestoreSubnet(
  value: string,
  routes: unknown,
  interfaces: unknown,
): boolean {
  if (!isValidRestoreSubnet(value)) return false;
  const subnet = ipv4Range(value, true);
  if (!subnet || !Array.isArray(routes) || routes.length === 0 || routes.length > 8192)
    return false;
  if (!Array.isArray(interfaces) || interfaces.length === 0 || interfaces.length > 4096)
    return false;
  for (const entry of routes as unknown[]) {
    const route = record(entry);
    if (!route) return false;
    const destination = route.dst;
    if (destination === 'default' || destination === '0.0.0.0/0') continue;
    if (typeof destination !== 'string') return false;
    const range = ipv4Range(destination, false);
    if (!range || overlaps(subnet, range)) return false;
  }
  let addresses = 0;
  for (const entry of interfaces as unknown[]) {
    const device = record(entry);
    if (!device || !Array.isArray(device.addr_info) || device.addr_info.length > 4096) return false;
    for (const entry of device.addr_info as unknown[]) {
      const address = record(entry);
      if (
        address?.family !== 'inet' ||
        typeof address.local !== 'string' ||
        typeof address.prefixlen !== 'number' ||
        !Number.isInteger(address.prefixlen)
      )
        return false;
      const range = ipv4Range(`${address.local}/${String(address.prefixlen)}`, false);
      if (!range || overlaps(subnet, range)) return false;
      addresses += 1;
    }
  }
  return addresses > 0;
}

function readIpJson(args: string[]): unknown {
  const result = spawnSync('ip', args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, LC_ALL: 'C' },
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') throw new Error();
  return JSON.parse(result.stdout) as unknown;
}

function main(): void {
  try {
    const value = process.argv[2];
    if (process.argv.length !== 3 || value === undefined || !isValidRestoreSubnet(value))
      throw new Error();
    const routes = readIpJson(['-j', '-4', 'route', 'show', 'table', 'all']);
    const interfaces = readIpJson(['-j', '-4', 'address', 'show']);
    if (!inventoryAllowsRestoreSubnet(value, routes, interfaces)) throw new Error();
    process.stdout.write('restore_subnet_safe\n');
  } catch {
    process.stderr.write('restore_subnet_refused\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
