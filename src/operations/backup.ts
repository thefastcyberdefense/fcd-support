import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, statfs } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { readSecretFile } from './secret-files.js';
const optionalFlags: Partial<typeof constants> = constants;
const noFollow = optionalFlags.O_NOFOLLOW ?? 0;

const reference = z.string().regex(/^backup_[a-f0-9]{32}$/u);
const unsignedManifest = z.strictObject({
  backupRef: reference,
  createdAt: z.iso.datetime({ precision: 3 }),
  class: z.enum(['daily', 'monthly', 'pre_migration']),
  gitRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  schemaRevision: z.string().regex(/^[0-9]{6}$/u),
  ciphertextBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ciphertextSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  state: z.enum(['created', 'verified', 'restore_verified', 'failed', 'pruned']),
});
const manifestSchema = unsignedManifest.extend({ signature: z.string().regex(/^[a-f0-9]{64}$/u) });
export type BackupManifest = Readonly<z.infer<typeof manifestSchema>>;
export type BackupProcessPort = (
  file: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;
interface BackupFiles {
  readonly archiveDirectory: string;
  readonly manifestHmacFile: string;
  readonly timeoutMilliseconds: number;
  readonly processes?: BackupProcessPort;
}
export interface BackupOptions extends BackupFiles {
  readonly connectionString: string;
  readonly recipientFile: string;
  readonly temporaryDirectory: string;
  readonly gitRevision: string;
  readonly schemaRevision: string;
  readonly backupClass: BackupManifest['class'];
  readonly now: Date;
  readonly schemas?: readonly string[];
  readonly publish?: (source: string, destination: string) => Promise<void>;
}
export interface VerifyBackupOptions extends BackupFiles {
  readonly identityFile: string;
  readonly expectedManifest: BackupManifest;
}

export function parseBackupManifest(input: unknown): BackupManifest {
  return Object.freeze(manifestSchema.parse(input));
}
function payload(manifest: Omit<BackupManifest, 'signature'>): string {
  return JSON.stringify(unsignedManifest.parse(manifest));
}
function unsigned(manifest: BackupManifest): Omit<BackupManifest, 'signature'> {
  const { signature: _signature, ...rest } = manifest;
  void _signature;
  return rest;
}
async function sign(manifest: Omit<BackupManifest, 'signature'>, keyFile: string): Promise<string> {
  const key = await readSecretFile(keyFile);
  try {
    if (key.byteLength < 32 || key.byteLength > 4096) throw new Error('invalid');
    return createHmac('sha256', key)
      .update('fcd-support:backup:v1\n')
      .update(payload(manifest))
      .digest('hex');
  } finally {
    key.fill(0);
  }
}
export async function requireBackupDirectory(path: string): Promise<void> {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    path.includes('\0') ||
    path === resolve(path, '..')
  )
    throw new Error('invalid');
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw new Error('invalid');
  if (
    process.platform !== 'win32' &&
    ((info.mode & 0o777) !== 0o700 ||
      info.uid !== process.geteuid?.() ||
      info.gid !== process.getegid?.())
  )
    throw new Error('invalid');
}
async function requireRegular(path: string) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('invalid');
  if (
    process.platform !== 'win32' &&
    ((before.mode & 0o777) !== 0o600 || before.uid !== process.geteuid?.())
  )
    throw new Error('invalid');
  return before;
}
async function cipherDigest(
  path: string,
): Promise<{ ciphertextBytes: number; ciphertextSha256: string }> {
  const before = await requireRegular(path);
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    if (info.dev !== before.dev || info.ino !== before.ino || info.size < 1)
      throw new Error('invalid');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const bytes = chunk as Buffer;
      size += bytes.length;
      hash.update(bytes);
    }
    const after = await handle.stat();
    if (size !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs)
      throw new Error('invalid');
    return { ciphertextBytes: size, ciphertextSha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}
async function syncFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDWR | noFollow);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function syncDirectory(path: string): Promise<void> {
  // Windows cannot open directory handles through this API; deployment is Linux.
  if (process.platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function writeExclusive(path: string, bytes: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function timeout(value: number): number {
  return z.number().int().min(1).max(300000).parse(value);
}
const childEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  LANG: 'C.UTF-8',
  TZ: 'UTC',
});
async function runPipeline(
  commands: readonly { file: string; args: readonly string[]; env?: NodeJS.ProcessEnv }[],
  options: Pick<BackupFiles, 'timeoutMilliseconds' | 'processes'>,
  input?: NodeJS.ReadableStream,
  output?: NodeJS.WritableStream,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeout(options.timeoutMilliseconds));
  const children: ChildProcessWithoutNullStreams[] = [];
  const jobs: Promise<unknown>[] = [];
  const processes: BackupProcessPort =
    options.processes ?? ((file, args, settings) => spawn(file, args, settings));
  const stop = () => {
    controller.abort();
    for (const child of children) child.kill('SIGKILL');
  };
  controller.signal.addEventListener('abort', stop, { once: true });
  try {
    for (const command of commands) {
      const child = processes(command.file, command.args, {
        env: { ...childEnvironment(), ...command.env },
        shell: false,
        windowsHide: true,
        stdio: 'pipe',
      });
      children.push(child);
      child.stderr.resume(); // Discard without buffering or logging untrusted diagnostics.
      jobs.push(
        new Promise<void>((done, reject) => {
          child.once('error', () => {
            reject(new Error('pipeline_failed'));
          });
          child.once('close', (code, signal) => {
            if (code === 0 && signal === null) done();
            else reject(new Error('pipeline_failed'));
          });
        }),
      );
    }
    const first = children[0];
    const last = children.at(-1);
    if (first === undefined || last === undefined) throw new Error('invalid');
    if (input === undefined) first.stdin.end();
    else jobs.push(pipeline(input, first.stdin, { signal: controller.signal }));
    for (const [index, child] of children.entries()) {
      if (index === 0) continue;
      const previous = children[index - 1];
      if (previous === undefined) throw new Error('invalid');
      jobs.push(pipeline(previous.stdout, child.stdin, { signal: controller.signal }));
    }
    jobs.push(
      pipeline(
        last.stdout,
        output ??
          new Writable({
            write(_chunk, _encoding, done) {
              done();
            },
          }),
        { signal: controller.signal },
      ),
    );
    await Promise.all(jobs);
  } catch {
    stop();
    await Promise.allSettled(jobs);
    throw new Error('pipeline_failed');
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', stop);
  }
}

export {
  cipherDigest as archiveCipherDigest,
  syncFile as syncArchiveFile,
  syncDirectory as syncArchiveDirectory,
  writeExclusive as writeArchiveExclusive,
  runPipeline as runArchivePipeline,
};
function connection(value: string): { env: NodeJS.ProcessEnv; pass: string } {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search !== '' || url.hash !== '')
    throw new Error('invalid');
  const fields = [
    url.hostname,
    url.port || '5432',
    decodeURIComponent(url.pathname.slice(1)),
    decodeURIComponent(url.username),
    decodeURIComponent(url.password),
  ];
  if (
    fields.slice(0, 4).some((field) => field.length === 0) ||
    fields.some((field) => /[\r\n\0]/u.test(field))
  )
    throw new Error('invalid');
  const [host, port, database, user] = fields;
  if (port === undefined || !/^[0-9]+$/u.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error('invalid');
  return {
    env: { PGHOST: host, PGPORT: port, PGDATABASE: database, PGUSER: user, PGSSLMODE: 'disable' },
    pass:
      fields.map((field) => field.replaceAll('\\', '\\\\').replaceAll(':', '\\:')).join(':') + '\n',
  };
}

async function cleanBackupAttempt(
  workDirectory: string | undefined,
  directory: string | undefined,
  committed: boolean,
): Promise<void> {
  let failed = false;
  if (workDirectory !== undefined) {
    try {
      await rm(workDirectory, { recursive: true, force: true });
    } catch {
      failed = true;
    }
  }
  if (!committed && directory !== undefined) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error('backup_failed');
}
export async function createEncryptedBackup(options: BackupOptions): Promise<BackupManifest> {
  let directory: string | undefined;
  let workDirectory: string | undefined;
  let committed = false;
  try {
    timeout(options.timeoutMilliseconds);
    const input = unsignedManifest
      .pick({ gitRevision: true, schemaRevision: true, class: true, createdAt: true })
      .parse({
        gitRevision: options.gitRevision,
        schemaRevision: options.schemaRevision,
        class: options.backupClass,
        createdAt: options.now.toISOString(),
      });
    const database = connection(options.connectionString);
    const schemas = z
      .array(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u))
      .max(100)
      .optional()
      .parse(options.schemas);
    await requireBackupDirectory(options.archiveDirectory);
    await requireBackupDirectory(options.temporaryDirectory);
    if (
      options.archiveDirectory === options.temporaryDirectory ||
      options.temporaryDirectory.startsWith(options.archiveDirectory + '/') ||
      options.archiveDirectory.startsWith(options.temporaryDirectory + '/')
    )
      throw new Error('invalid');
    if (
      process.platform === 'linux' &&
      (await statfs(options.temporaryDirectory)).type !== 0x01021994
    )
      throw new Error('invalid');
    const recipient = await readSecretFile(options.recipientFile);
    try {
      const text = new TextDecoder('utf-8', { fatal: true })
        .decode(recipient)
        .replace(/\r?\n$/u, '');
      if (!/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/u.test(text)) throw new Error('invalid');
    } finally {
      recipient.fill(0);
    }
    const backupRef = `backup_${randomUUID().replaceAll('-', '')}`;
    const archiveCandidate = join(options.archiveDirectory, backupRef);
    await mkdir(archiveCandidate, { mode: 0o700 });
    directory = archiveCandidate;
    const workCandidate = join(options.temporaryDirectory, `pgpass_${randomUUID()}`);
    await mkdir(workCandidate, { mode: 0o700 });
    workDirectory = workCandidate;
    const passFile = join(workDirectory, 'pgpass');
    await writeExclusive(passFile, database.pass);
    const stage = join(directory, 'archive.partial');
    await runPipeline(
      [
        {
          file: 'pg_dump',
          args: [
            '--format=custom',
            '--no-owner',
            '--no-acl',
            '--no-password',
            ...(schemas ?? []).flatMap((schema) => ['--schema', schema]),
          ],
          env: { ...database.env, PGPASSFILE: passFile },
        },
        { file: 'age', args: ['--encrypt', '--recipients-file', options.recipientFile] },
      ],
      options,
      undefined,
      createWriteStream(stage, { flags: 'wx', mode: 0o600 }),
    );
    await syncFile(stage);
    const digest = await cipherDigest(stage);
    const material = { backupRef, ...input, ...digest, state: 'created' as const };
    const manifest = parseBackupManifest({
      ...material,
      signature: await sign(material, options.manifestHmacFile),
    });
    await writeExclusive(join(directory, 'manifest.partial'), JSON.stringify(manifest) + '\n');
    const publish = options.publish ?? rename;
    await publish(stage, join(directory, 'archive.age'));
    await syncDirectory(directory);
    // The signed manifest is the final commit marker. An orphan ciphertext is never eligible.
    await publish(join(directory, 'manifest.partial'), join(directory, 'manifest.json'));
    await syncDirectory(directory);
    await syncDirectory(options.archiveDirectory);
    committed = true;
    return manifest;
  } catch {
    throw new Error('backup_failed');
  } finally {
    await cleanBackupAttempt(workDirectory, directory, committed);
  }
}

export async function readBackupManifest(
  archiveDirectory: string,
  backupRef: string,
  keyFile: string,
): Promise<BackupManifest> {
  try {
    reference.parse(backupRef);
    await requireBackupDirectory(archiveDirectory);
    const directory = join(archiveDirectory, backupRef);
    await requireBackupDirectory(directory);
    const bytes = await readSecretFile(join(directory, 'manifest.json'));
    const manifest = parseBackupManifest(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    if (manifest.backupRef !== backupRef) throw new Error('invalid');
    const signature = await sign(unsigned(manifest), keyFile);
    if (!timingSafeEqual(Buffer.from(manifest.signature, 'hex'), Buffer.from(signature, 'hex')))
      throw new Error('invalid');
    const digest = await cipherDigest(join(directory, 'archive.age'));
    if (
      digest.ciphertextBytes !== manifest.ciphertextBytes ||
      digest.ciphertextSha256 !== manifest.ciphertextSha256
    )
      throw new Error('invalid');
    return manifest;
  } catch {
    throw new Error('backup_manifest_invalid');
  }
}
export async function verifyEncryptedBackup(
  options: VerifyBackupOptions,
): Promise<{ status: 'verified' }> {
  try {
    timeout(options.timeoutMilliseconds);
    const expected = parseBackupManifest(options.expectedManifest);
    const actual = await readBackupManifest(
      options.archiveDirectory,
      expected.backupRef,
      options.manifestHmacFile,
    );
    if (
      payload(unsigned(actual)) !== payload(unsigned(expected)) ||
      actual.signature !== expected.signature ||
      actual.state !== 'created'
    )
      throw new Error('invalid');
    const identity = await readSecretFile(options.identityFile);
    try {
      const lines = new TextDecoder('utf-8', { fatal: true })
        .decode(identity)
        .split(/\r?\n/u)
        .filter((line) => line !== '' && !line.startsWith('#'));
      const line = lines[0];
      if (
        lines.length !== 1 ||
        line === undefined ||
        !/^AGE-SECRET-KEY-1[023456789ACDEFGHJKLMNPQRSTUVWXYZ]{58}$/u.test(line)
      )
        throw new Error('invalid');
    } finally {
      identity.fill(0);
    }
    await runPipeline(
      [
        { file: 'age', args: ['--decrypt', '--identity', options.identityFile] },
        { file: 'pg_restore', args: ['--list'] },
      ],
      options,
      createReadStream(join(options.archiveDirectory, expected.backupRef, 'archive.age')),
    );
    return { status: 'verified' };
  } catch {
    throw new Error('backup_verification_failed');
  }
}
