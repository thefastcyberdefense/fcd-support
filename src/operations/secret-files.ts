import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { inspect } from 'node:util';

import { runtimeRoles, type RuntimeRole } from './operations-types.js';

const maximumSecretBytes = 65_536;
const redacted = '[REDACTED]';
const secretNames = [
  'DATABASE_URL',
  'META_APP_SECRET',
  'META_VERIFY_TOKEN',
  'PRIVACY_HMAC_KEYRING',
  'ADMIN_SESSION_HMAC_KEY',
  'ADMIN_MFA_ENCRYPTION_KEY',
  'META_PAGE_ACCESS_TOKEN',
  'META_WHATSAPP_ACCESS_TOKEN',
  'META_MESSENGER_PAGE_ID',
  'META_WHATSAPP_PHONE_NUMBER_ID',
  'META_WHATSAPP_BUSINESS_ACCOUNT_ID',
  'MANIFEST_API_KEY',
  'N8N_ESCALATION_WEBHOOK_SECRET',
  'RECOVERY_MANIFEST_HMAC',
  'BACKUP_ENCRYPTION_RECIPIENT',
  'BACKUP_AGE_IDENTITY',
  'POSTGRES_PASSWORD',
  'CLOUDFLARE_TUNNEL_TOKEN',
  'BACKUP_ENCRYPTION_PASSWORD',
] as const;
type SecretName = (typeof secretNames)[number];
const structuredSecrets = new Set<SecretName>(['PRIVACY_HMAC_KEYRING', 'BACKUP_AGE_IDENTITY']);
const credentialName =
  /(?:^|_)(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|DATABASE_URL|SESSION_KEY|HMAC_KEY)(?:_|$)/u;

function invalidFile(): never {
  throw new Error('secret_file_invalid');
}

export async function readSecretFile(path: string): Promise<Uint8Array> {
  try {
    if (!isAbsolute(path) || path.includes('\0')) invalidFile();
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) invalidFile();
    const platformFlags: Partial<typeof constants> = constants;
    const handle = await open(
      path,
      constants.O_RDONLY | (platformFlags.O_NOFOLLOW ?? 0) | (platformFlags.O_NONBLOCK ?? 0),
    );
    try {
      const current = await handle.stat();
      if (
        !current.isFile() ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.size === 0 ||
        current.size > maximumSecretBytes
      )
        invalidFile();
      if (
        process.platform !== 'win32' &&
        ((current.mode & 0o077) !== 0 ||
          (current.mode & 0o400) === 0 ||
          current.uid !== process.geteuid?.())
      )
        invalidFile();
      const buffer = Buffer.alloc(maximumSecretBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length === 0 || length > maximumSecretBytes) {
        buffer.fill(0);
        invalidFile();
      }
      const result = Uint8Array.from(buffer.subarray(0, length));
      buffer.fill(0);
      return result;
    } finally {
      await handle.close();
    }
  } catch {
    return invalidFile();
  }
}

function decodeSecret(bytes: Uint8Array, structured: boolean): string {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumSecretBytes
  )
    invalidFile();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return invalidFile();
  }
  if (text.endsWith('\r\n')) text = text.slice(0, -2);
  else if (text.endsWith('\n')) text = text.slice(0, -1);
  if (
    text.trim() === '' ||
    text.includes('\0') ||
    text.startsWith('\uFEFF') ||
    (!structured && /[\r\n]/u.test(text))
  )
    invalidFile();
  return text;
}

function executionEnabled(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): boolean {
  if (environment[name] !== 'true' && environment[name] !== 'false') {
    throw new Error('configuration_invalid');
  }
  return environment[name] === 'true';
}

function requiredSecrets(
  role: RuntimeRole,
  environment: Readonly<Record<string, string | undefined>>,
): readonly SecretName[] {
  const database: SecretName[] = ['DATABASE_URL'];
  switch (role) {
    case 'webhook':
      return [...database, 'META_APP_SECRET', 'META_VERIFY_TOKEN', 'PRIVACY_HMAC_KEYRING'];
    case 'admin':
      return [...database, 'ADMIN_SESSION_HMAC_KEY', 'ADMIN_MFA_ENCRYPTION_KEY'];
    case 'reply':
      return [
        ...database,
        'PRIVACY_HMAC_KEYRING',
        ...(executionEnabled(environment, 'MODEL_EXECUTION_ENABLED')
          ? (['MANIFEST_API_KEY'] as const)
          : []),
      ];
    case 'outbound':
      return [
        ...database,
        'PRIVACY_HMAC_KEYRING',
        ...(executionEnabled(environment, 'OUTBOUND_EXECUTION_ENABLED')
          ? ([
              'META_PAGE_ACCESS_TOKEN',
              'META_WHATSAPP_ACCESS_TOKEN',
              'META_MESSENGER_PAGE_ID',
              'META_WHATSAPP_PHONE_NUMBER_ID',
            ] as const)
          : []),
      ];
    case 'notification':
      return [
        ...database,
        ...(executionEnabled(environment, 'N8N_EXECUTION_ENABLED')
          ? (['N8N_ESCALATION_WEBHOOK_SECRET'] as const)
          : []),
      ];
    case 'maintenance':
      return [...database, 'PRIVACY_HMAC_KEYRING'];
    case 'checkpoint':
    case 'backup':
      return [...database, 'BACKUP_ENCRYPTION_RECIPIENT', 'RECOVERY_MANIFEST_HMAC'];
    case 'verify_backup':
      return [...database, 'BACKUP_AGE_IDENTITY', 'RECOVERY_MANIFEST_HMAC'];
    case 'restore':
      return [...database, 'BACKUP_AGE_IDENTITY', 'RECOVERY_MANIFEST_HMAC', 'PRIVACY_HMAC_KEYRING'];
    case 'health':
    case 'migrate':
      return database;
  }
}

export async function loadRoleEnvironment(
  role: RuntimeRole,
  environment: Readonly<Record<string, string | undefined>>,
  readSecret: (path: string) => Promise<Uint8Array> = readSecretFile,
): Promise<Readonly<Record<string, string | undefined>>> {
  if (!runtimeRoles.includes(role)) throw new Error('configuration_invalid');
  const source = { ...environment };
  if (
    source.NODE_ENV !== undefined &&
    !['production', 'development', 'test'].includes(source.NODE_ENV)
  ) {
    throw new Error('configuration_invalid');
  }
  for (const name of secretNames) {
    if (
      source[name] !== undefined &&
      source[name] !== '' &&
      source[`${name}_FILE`] !== undefined &&
      source[`${name}_FILE`] !== ''
    ) {
      throw new Error('secret_source_conflict');
    }
  }
  const required = new Set(requiredSecrets(role, source));
  const known = new Set<string>(secretNames.flatMap((name) => [name, `${name}_FILE`]));
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || value === '') continue;
    const secret = secretNames.find(
      (candidate) => name === candidate || name === `${candidate}_FILE`,
    );
    if (
      (secret !== undefined && !required.has(secret)) ||
      (secret === undefined && credentialName.test(name))
    )
      throw new Error('secret_not_allowed');
  }
  const result: Record<string | symbol, unknown> = Object.fromEntries(
    Object.entries(source).filter(([name]) => !known.has(name)),
  );
  const fileOnly = source.NODE_ENV !== 'test' && source.NODE_ENV !== 'development';
  for (const name of required) {
    const file = source[`${name}_FILE`];
    const direct = source[name];
    let bytes: Uint8Array;
    if (file !== undefined && file !== '') {
      if (!isAbsolute(file) || file.includes('\0')) invalidFile();
      try {
        bytes = await readSecret(file);
      } catch {
        return invalidFile();
      }
    } else {
      if (fileOnly || direct === undefined || direct === '')
        throw new Error('secret_file_required');
      bytes = new TextEncoder().encode(direct);
    }
    const value = decodeSecret(bytes, structuredSecrets.has(name));
    Object.defineProperty(result, name, { value, enumerable: false });
  }
  Object.defineProperties(result, {
    toJSON: { value: () => redacted },
    toString: { value: () => redacted },
    [inspect.custom]: { value: () => redacted },
  });
  return Object.freeze(result) as Readonly<Record<string, string | undefined>>;
}
