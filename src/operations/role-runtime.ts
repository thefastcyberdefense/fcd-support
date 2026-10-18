import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type pg from 'pg';

import type { SafeLogger } from '../logging.js';
import type { RuntimeRole } from './operations-types.js';
import {
  isRuntimeHeartbeatFresh,
  parseRuntimeHeartbeat,
  type RuntimeHeartbeat,
} from './runtime-readiness.js';

export type RuntimeHttpTransport = (url: string, init: RequestInit) => Promise<Response>;
export interface RoleRuntimeOptions {
  readonly role: RuntimeRole;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly logger: SafeLogger;
  readonly now: () => Date;
  readonly poolFactory?: (configuration: pg.PoolConfig) => pg.Pool;
  readonly onHeartbeat?: (heartbeat: RuntimeHeartbeat) => void;
  readonly testTransports?: Readonly<{
    manifest?: RuntimeHttpTransport;
    meta?: RuntimeHttpTransport;
    n8n?: RuntimeHttpTransport;
  }>;
}

/** The runtime mounts this path's directory as tmpfs; no heartbeat contains domain data. */
export function writeRuntimeHeartbeat(file: string, value: unknown): void {
  const heartbeat = parseRuntimeHeartbeat(value);
  if (heartbeat === undefined) throw new TypeError('runtime_heartbeat_invalid');
  const temporary = `${file}.${randomUUID()}.tmp`;
  let created = false;
  try {
    writeFileSync(temporary, JSON.stringify(heartbeat), { flag: 'wx', mode: 0o600 });
    created = true;
    renameSync(temporary, file);
  } catch {
    throw new Error('runtime_heartbeat_unavailable');
  } finally {
    if (created) rmSync(temporary, { force: true });
  }
}

export function readRuntimeHeartbeat(
  file: string,
  evaluatedAt: Date,
  staleMilliseconds: number,
): boolean {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(file);
    if (!before.isFile() || before.size > 1024) return false;
    const platformConstants: Partial<typeof constants> = constants;
    descriptor = openSync(
      file,
      constants.O_RDONLY |
        (platformConstants.O_NOFOLLOW ?? 0) |
        (platformConstants.O_NONBLOCK ?? 0),
    );
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size > 1024 ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev
    )
      return false;
    const bytes = Buffer.alloc(1025);
    const count = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count > 1024) return false;
    return isRuntimeHeartbeatFresh(
      JSON.parse(bytes.subarray(0, count).toString('utf8')),
      evaluatedAt,
      staleMilliseconds,
    );
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
