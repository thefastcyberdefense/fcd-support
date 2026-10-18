import { Buffer } from 'node:buffer';
import { posix } from 'node:path';

import { z } from 'zod';

import type { LearningPolicy } from '../learning/learning-types.js';
import { AdminSecretBytes } from './admin-types.js';

const encodedKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const environmentSchema = z.object({
  ADMIN_ACTION_TTL_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(900_000),
  ADMIN_HOST: z.string().trim().default('127.0.0.1'),
  ADMIN_LISTEN_MODE: z.enum(['local', 'container_private', 'unix']).default('local'),
  ADMIN_SOCKET_PATH: z.string().optional(),
  ADMIN_BROWSER_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  ADMIN_LIST_LIMIT: z.coerce.number().int().min(1).max(500).default(100),
  ADMIN_MFA_ENCRYPTION_KEY: encodedKeySchema,
  ADMIN_MFA_KEY_VERSION: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/)
    .default('local-v1'),
  ADMIN_ORIGIN: z.url().optional(),
  ADMIN_PASSWORD_BLOCK_SIZE: z.coerce.number().int().min(8).max(16).default(8),
  ADMIN_PASSWORD_COST: z.coerce.number().int().min(16_384).max(262_144).default(65_536),
  ADMIN_PASSWORD_KEY_LENGTH: z.coerce.number().int().min(32).max(64).default(32),
  ADMIN_PASSWORD_PARALLELIZATION: z.coerce.number().int().min(1).max(4).default(1),
  ADMIN_PASSWORD_SALT_LENGTH: z.coerce.number().int().min(16).max(64).default(32),
  ADMIN_PORT: z.coerce.number().int().min(1).max(65_535).default(3004),
  ADMIN_PREAUTH_TTL_MS: z.coerce.number().int().min(60_000).max(900_000).default(300_000),
  ADMIN_SECURE_COOKIE: z.enum(['false', 'true']).default('false'),
  ADMIN_SESSION_HMAC_KEY: encodedKeySchema,
  ADMIN_SESSION_TTL_MS: z.coerce.number().int().min(300_000).max(86_400_000).default(28_800_000),
  ADMIN_TOTP_DIGITS: z.coerce.number().int().min(6).max(8).default(6),
  ADMIN_TOTP_PERIOD_SECONDS: z.coerce.number().int().min(15).max(120).default(30),
  ADMIN_TOTP_VERIFICATION_WINDOW: z.coerce.number().int().min(0).max(2).default(1),
  DATABASE_URL: z
    .url()
    .refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol)),
  LEARNING_DIGEST_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(259_200_000)
    .max(31_536_000_000)
    .default(259_200_000),
  LEARNING_MAX_DIGEST_APPEARANCES: z.coerce.number().int().min(1).max(10).default(2),
  LEARNING_MAX_OBSERVATIONS_PER_RUN: z.coerce.number().int().min(2).max(10_000).default(1000),
  LEARNING_MAX_QUESTIONS_PER_DIGEST: z.coerce.number().int().min(1).max(5).default(5),
  LEARNING_MINIMUM_GROUP_COUNT: z.coerce.number().int().min(2).max(1000).default(3),
  LEARNING_QUESTION_COOLDOWN_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(31_536_000_000)
    .default(604_800_000),
});

const settingOrder = [
  'ADMIN_ACTION_TTL_MS',
  'DATABASE_URL',
  'ADMIN_HOST',
  'ADMIN_LISTEN_MODE',
  'ADMIN_SOCKET_PATH',
  'ADMIN_BROWSER_PORT',
  'ADMIN_LIST_LIMIT',
  'ADMIN_PORT',
  'ADMIN_ORIGIN',
  'ADMIN_SECURE_COOKIE',
  'ADMIN_SESSION_HMAC_KEY',
  'ADMIN_MFA_ENCRYPTION_KEY',
  'ADMIN_MFA_KEY_VERSION',
  'ADMIN_PASSWORD_COST',
  'ADMIN_PASSWORD_BLOCK_SIZE',
  'ADMIN_PASSWORD_PARALLELIZATION',
  'ADMIN_PASSWORD_KEY_LENGTH',
  'ADMIN_PASSWORD_SALT_LENGTH',
  'ADMIN_PREAUTH_TTL_MS',
  'ADMIN_SESSION_TTL_MS',
  'ADMIN_TOTP_DIGITS',
  'ADMIN_TOTP_PERIOD_SECONDS',
  'ADMIN_TOTP_VERIFICATION_WINDOW',
  'LEARNING_DIGEST_INTERVAL_MS',
  'LEARNING_QUESTION_COOLDOWN_MS',
  'LEARNING_MAX_QUESTIONS_PER_DIGEST',
  'LEARNING_MAX_DIGEST_APPEARANCES',
  'LEARNING_MINIMUM_GROUP_COUNT',
  'LEARNING_MAX_OBSERVATIONS_PER_RUN',
] as const;

export interface AdminConfig {
  readonly listener:
    | {
        readonly kind: 'tcp';
        readonly host: '127.0.0.1' | '::1' | '0.0.0.0';
        readonly port: number;
      }
    | { readonly kind: 'unix'; readonly path: string };
  readonly listLimit: number;
  readonly learningPolicy: LearningPolicy;
  readonly actionTtlMilliseconds: number;
  readonly databaseUrl: string;
  readonly host: '127.0.0.1' | '::1' | '0.0.0.0';
  readonly mfaEncryptionKey: AdminSecretBytes;
  readonly mfaKeyVersion: string;
  readonly origin: string;
  readonly passwordPolicy: {
    readonly algorithm: 'scrypt_v1';
    readonly blockSize: number;
    readonly cost: number;
    readonly keyLength: number;
    readonly parallelization: number;
    readonly saltLength: number;
  };
  readonly port: number;
  readonly preauthenticationTtlMilliseconds: number;
  readonly secureCookie: boolean;
  readonly sessionHmacKey: AdminSecretBytes;
  readonly sessionTtlMilliseconds: number;
  readonly totpPolicy: {
    readonly algorithm: 'sha1';
    readonly digits: number;
    readonly periodSeconds: number;
    readonly verificationWindow: number;
  };
}

function fail(settings: readonly (typeof settingOrder)[number][]): never {
  const selected = new Set(settings);
  const names = settingOrder.filter((name) => selected.has(name));
  throw new Error(`Invalid admin configuration: ${names.join(', ')}`);
}

function decodeKey(value: string, setting: 'ADMIN_MFA_ENCRYPTION_KEY' | 'ADMIN_SESSION_HMAC_KEY') {
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 32) {
    bytes.fill(0);
    fail([setting]);
  }
  const result = new AdminSecretBytes(bytes);
  bytes.fill(0);
  return result;
}

export function loadAdminConfig(
  environment: Readonly<Record<string, string | undefined>>,
): AdminConfig {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    const invalid = new Set(
      result.error.issues
        .map((issue) => issue.path[0])
        .filter((path): path is (typeof settingOrder)[number] =>
          settingOrder.includes(path as (typeof settingOrder)[number]),
        ),
    );
    fail([...invalid]);
  }

  const host = result.data.ADMIN_HOST;
  const unix = result.data.ADMIN_LISTEN_MODE === 'unix';
  const container = result.data.ADMIN_LISTEN_MODE === 'container_private';
  const socketPath = result.data.ADMIN_SOCKET_PATH;
  if (unix) {
    if (environment.ADMIN_HOST !== undefined) fail(['ADMIN_HOST']);
    if (environment.ADMIN_PORT !== undefined) fail(['ADMIN_PORT']);
    if (
      socketPath === undefined ||
      !socketPath.isWellFormed() ||
      !posix.isAbsolute(socketPath) ||
      posix.normalize(socketPath) !== socketPath ||
      posix.basename(socketPath) !== 'admin.sock' ||
      Buffer.from(socketPath, 'utf8').some((byte) => byte < 32 || byte === 127) ||
      Buffer.byteLength(socketPath, 'utf8') > 107
    )
      fail(['ADMIN_SOCKET_PATH']);
    if (result.data.ADMIN_BROWSER_PORT === undefined) fail(['ADMIN_BROWSER_PORT']);
    if (result.data.ADMIN_ORIGIN === undefined) fail(['ADMIN_ORIGIN']);
  } else if (socketPath !== undefined) fail(['ADMIN_SOCKET_PATH']);
  if (container ? host !== '0.0.0.0' : host !== '127.0.0.1' && host !== '::1') fail(['ADMIN_HOST']);
  if (host !== '127.0.0.1' && host !== '::1' && host !== '0.0.0.0') fail(['ADMIN_HOST']);
  if (container && result.data.ADMIN_ORIGIN === undefined) fail(['ADMIN_ORIGIN']);
  const defaultOrigin =
    host === '::1'
      ? `http://[::1]:${String(result.data.ADMIN_PORT)}`
      : `http://${host}:${String(result.data.ADMIN_PORT)}`;
  const origin = result.data.ADMIN_ORIGIN ?? defaultOrigin;
  const parsedOrigin = new URL(origin);
  const expectedHostname = host === '::1' ? '[::1]' : host;
  const secureCookie = result.data.ADMIN_SECURE_COOKIE === 'true';
  if (
    parsedOrigin.origin !== origin ||
    (container || unix
      ? !['127.0.0.1', '[::1]'].includes(parsedOrigin.hostname)
      : parsedOrigin.hostname !== expectedHostname) ||
    Number(parsedOrigin.port || 80) !==
      (container || unix
        ? (result.data.ADMIN_BROWSER_PORT ?? result.data.ADMIN_PORT)
        : result.data.ADMIN_PORT) ||
    parsedOrigin.protocol !== 'http:' ||
    secureCookie
  ) {
    fail(['ADMIN_ORIGIN']);
  }
  if ((result.data.ADMIN_PASSWORD_COST & (result.data.ADMIN_PASSWORD_COST - 1)) !== 0) {
    fail(['ADMIN_PASSWORD_COST']);
  }
  if (result.data.ADMIN_PREAUTH_TTL_MS >= result.data.ADMIN_SESSION_TTL_MS) {
    fail(['ADMIN_PREAUTH_TTL_MS', 'ADMIN_SESSION_TTL_MS']);
  }
  if (result.data.LEARNING_QUESTION_COOLDOWN_MS < result.data.LEARNING_DIGEST_INTERVAL_MS) {
    fail(['LEARNING_DIGEST_INTERVAL_MS', 'LEARNING_QUESTION_COOLDOWN_MS']);
  }
  if (result.data.LEARNING_MAX_OBSERVATIONS_PER_RUN < result.data.LEARNING_MINIMUM_GROUP_COUNT) {
    fail(['LEARNING_MINIMUM_GROUP_COUNT', 'LEARNING_MAX_OBSERVATIONS_PER_RUN']);
  }

  return {
    listener:
      unix && socketPath !== undefined
        ? { kind: 'unix', path: socketPath }
        : { kind: 'tcp', host, port: result.data.ADMIN_PORT },
    listLimit: result.data.ADMIN_LIST_LIMIT,
    learningPolicy: {
      minimumGroupCount: result.data.LEARNING_MINIMUM_GROUP_COUNT,
      digestIntervalMilliseconds: result.data.LEARNING_DIGEST_INTERVAL_MS,
      maximumQuestionsPerDigest: result.data.LEARNING_MAX_QUESTIONS_PER_DIGEST,
      questionCooldownMilliseconds: result.data.LEARNING_QUESTION_COOLDOWN_MS,
      maximumDigestAppearances: result.data.LEARNING_MAX_DIGEST_APPEARANCES,
      maximumObservationsPerRun: result.data.LEARNING_MAX_OBSERVATIONS_PER_RUN,
    },
    actionTtlMilliseconds: result.data.ADMIN_ACTION_TTL_MS,
    databaseUrl: result.data.DATABASE_URL,
    host,
    mfaEncryptionKey: decodeKey(result.data.ADMIN_MFA_ENCRYPTION_KEY, 'ADMIN_MFA_ENCRYPTION_KEY'),
    mfaKeyVersion: result.data.ADMIN_MFA_KEY_VERSION,
    origin,
    passwordPolicy: {
      algorithm: 'scrypt_v1',
      blockSize: result.data.ADMIN_PASSWORD_BLOCK_SIZE,
      cost: result.data.ADMIN_PASSWORD_COST,
      keyLength: result.data.ADMIN_PASSWORD_KEY_LENGTH,
      parallelization: result.data.ADMIN_PASSWORD_PARALLELIZATION,
      saltLength: result.data.ADMIN_PASSWORD_SALT_LENGTH,
    },
    port: result.data.ADMIN_PORT,
    preauthenticationTtlMilliseconds: result.data.ADMIN_PREAUTH_TTL_MS,
    secureCookie,
    sessionHmacKey: decodeKey(result.data.ADMIN_SESSION_HMAC_KEY, 'ADMIN_SESSION_HMAC_KEY'),
    sessionTtlMilliseconds: result.data.ADMIN_SESSION_TTL_MS,
    totpPolicy: {
      algorithm: 'sha1',
      digits: result.data.ADMIN_TOTP_DIGITS,
      periodSeconds: result.data.ADMIN_TOTP_PERIOD_SECONDS,
      verificationWindow: result.data.ADMIN_TOTP_VERIFICATION_WINDOW,
    },
  };
}
