import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import { readSecretFile } from '../operations/secret-files.js';
import {
  runMetaWebhookProbe,
  type WebhookProbeMode,
  type WebhookProbeSignatureMode,
} from './webhook-probe.js';

const MAX_PAYLOAD_READ_BYTES = 512 * 1024;

export interface WebhookProbeCliOptions {
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly readStdinBytes?: () => Promise<Buffer>;
  readonly fetch?: typeof fetch | undefined;
  readonly writeOut: (line: string) => void;
  readonly writeErr: (line: string) => void;
}

interface ParsedCliArgs {
  readonly baseUrl: string;
  readonly mode: WebhookProbeMode;
  readonly path?: string | undefined;
  readonly signatureMode?: WebhookProbeSignatureMode | undefined;
  readonly payloadFile?: string | undefined;
  readonly payloadStdin: boolean;
  readonly allowOversized: boolean;
  readonly invalidToken: boolean;
  readonly challenge?: string | undefined;
  readonly contentType?: string | undefined;
  readonly timeoutMilliseconds?: number | undefined;
  readonly expectedStatus?: number | undefined;
}

function parseCliArgs(args: readonly string[]): ParsedCliArgs {
  let baseUrl: string | undefined;
  let mode: WebhookProbeMode | undefined;
  let path: string | undefined;
  let signatureMode: WebhookProbeSignatureMode | undefined;
  let payloadFile: string | undefined;
  let payloadStdin = false;
  let allowOversized = false;
  let invalidToken = false;
  let challenge: string | undefined;
  let contentType: string | undefined;
  let timeoutMilliseconds: number | undefined;
  let expectedStatus: number | undefined;

  const valueAt = (index: number): string => {
    const value = args[index];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('webhook_probe_arguments_invalid');
    }
    return value;
  };

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    switch (flag) {
      case '--base-url':
        baseUrl = valueAt(++i);
        break;
      case '--mode':
        mode = z.enum(['verify', 'post', 'closed-route']).parse(valueAt(++i));
        break;
      case '--path':
        path = valueAt(++i);
        break;
      case '--signature-mode':
        signatureMode = z.enum(['valid', 'invalid', 'unsigned']).parse(valueAt(++i));
        break;
      case '--payload-file':
        payloadFile = valueAt(++i);
        break;
      case '--payload-stdin':
        payloadStdin = true;
        break;
      case '--allow-oversized':
        allowOversized = true;
        break;
      case '--invalid-token':
        invalidToken = true;
        break;
      case '--challenge':
        challenge = valueAt(++i);
        break;
      case '--content-type':
        contentType = valueAt(++i);
        break;
      case '--timeout-ms':
        timeoutMilliseconds = Number(valueAt(++i));
        break;
      case '--expected-status':
        expectedStatus = Number(valueAt(++i));
        break;
      default:
        throw new Error('webhook_probe_arguments_invalid');
    }
  }

  if (baseUrl === undefined || mode === undefined) {
    throw new Error('webhook_probe_arguments_invalid');
  }
  if (payloadFile !== undefined && payloadStdin) {
    throw new Error('webhook_probe_arguments_invalid');
  }

  return {
    baseUrl,
    mode,
    path,
    signatureMode,
    payloadFile,
    payloadStdin,
    allowOversized,
    invalidToken,
    challenge,
    contentType,
    timeoutMilliseconds,
    expectedStatus,
  };
}

async function resolveOptionalSecret(
  environment: Readonly<Record<string, string | undefined>>,
  directKey: string,
  fileKey: string,
): Promise<string | undefined> {
  const filePath = environment[fileKey];
  if (filePath !== undefined && filePath.length > 0) {
    const raw = await readSecretFile(filePath);
    try {
      return Buffer.from(raw)
        .toString('utf8')
        .replace(/\r?\n$/u, '');
    } finally {
      raw.fill(0);
    }
  }
  const direct = environment[directKey];
  return direct !== undefined && direct.length > 0 ? direct : undefined;
}

async function readStdinBounded(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    total += buf.length;
    if (total > MAX_PAYLOAD_READ_BYTES) {
      throw new Error('webhook_probe_payload_exceeds_hard_cap');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Executes the signed synthetic Meta webhook probe CLI without logging secrets or payload bodies.
 */
export async function runWebhookProbeCli(options: WebhookProbeCliOptions): Promise<number> {
  try {
    const parsed = parseCliArgs(options.args);
    if (parsed.mode === 'verify') {
      const verifyToken = parsed.invalidToken
        ? undefined
        : await resolveOptionalSecret(
            options.environment,
            'META_VERIFY_TOKEN',
            'META_VERIFY_TOKEN_FILE',
          );
      const result = await runMetaWebhookProbe({
        mode: 'verify',
        baseUrl: parsed.baseUrl,
        path: parsed.path,
        verifyToken,
        invalidToken: parsed.invalidToken,
        challenge: parsed.challenge,
        timeoutMilliseconds: parsed.timeoutMilliseconds,
        expectedStatus: parsed.expectedStatus,
        fetch: options.fetch,
      });
      options.writeOut(JSON.stringify(result));
      return result.ok ? 0 : 1;
    }

    if (parsed.mode === 'closed-route') {
      if (parsed.path === undefined) {
        throw new Error('webhook_probe_path_required');
      }
      const result = await runMetaWebhookProbe({
        mode: 'closed-route',
        baseUrl: parsed.baseUrl,
        path: parsed.path,
        timeoutMilliseconds: parsed.timeoutMilliseconds,
        expectedStatus: parsed.expectedStatus,
        fetch: options.fetch,
      });
      options.writeOut(JSON.stringify(result));
      return result.ok ? 0 : 1;
    }

    if (parsed.payloadFile === undefined && !parsed.payloadStdin) {
      throw new Error('webhook_probe_payload_required');
    }
    const rawBody =
      parsed.payloadFile !== undefined
        ? await readFile(parsed.payloadFile)
        : await (options.readStdinBytes ?? readStdinBounded)();
    const appSecret =
      (parsed.signatureMode ?? 'valid') === 'unsigned'
        ? undefined
        : await resolveOptionalSecret(
            options.environment,
            'META_APP_SECRET',
            'META_APP_SECRET_FILE',
          );

    const result = await runMetaWebhookProbe({
      mode: 'post',
      baseUrl: parsed.baseUrl,
      path: parsed.path,
      rawBody,
      appSecret,
      signatureMode: parsed.signatureMode,
      allowOversized: parsed.allowOversized,
      contentType: parsed.contentType,
      timeoutMilliseconds: parsed.timeoutMilliseconds,
      expectedStatus: parsed.expectedStatus,
      fetch: options.fetch,
    });
    options.writeOut(JSON.stringify(result));
    return result.ok ? 0 : 1;
  } catch (error) {
    const code = error instanceof Error ? error.message : 'webhook_probe_failed';
    const safeCode = /^[a-z0-9_]+$/u.test(code) ? code : 'webhook_probe_failed';
    options.writeErr(safeCode);
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runWebhookProbeCli({
    args: process.argv.slice(2),
    environment: process.env,
    writeOut: (line) => {
      process.stdout.write(`${line}\n`);
    },
    writeErr: (line) => {
      process.stderr.write(`${line}\n`);
    },
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
