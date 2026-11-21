import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const DEFAULT_MAX_BODY_BYTES = 15 * 1024 * 1024;
const DEFAULT_MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const MINIMUM_ALNUM_CHARS = 3;

export interface SttExecutionResult {
  readonly text: string;
  readonly detectedLanguage?: string;
  readonly confidence?: number;
}

export interface SttHandlerOptions {
  readonly maxBodyBytes?: number;
  readonly maxAudioBytes?: number;
  readonly runStt?: (input: {
    readonly bytes: Buffer;
    readonly mimeType?: string;
    readonly languageHint?: string;
    readonly voice?: boolean;
  }) => Promise<SttExecutionResult>;
}

function isSupportedAudioHeader(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  const ascii4 = bytes.subarray(0, 4).toString('ascii');
  if (ascii4 === 'OggS' || ascii4 === 'fLaC' || ascii4 === 'RIFF') return true;
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3') return true;
  if ((bytes[0] ?? 0) === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return true;
  if (bytes.length >= 8 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') return true;
  return false;
}

export function detectSttLanguage(
  text: string,
  detectedByWhisper?: string,
  hint?: string,
): 'en' | 'bn' {
  if (/[\u0980-\u09FF]/u.test(text)) return 'bn';
  if (detectedByWhisper === 'bn') return 'bn';
  if (detectedByWhisper === 'en' || /[A-Za-z]/u.test(text)) return 'en';
  return hint === 'bn' ? 'bn' : 'en';
}

export async function runWhisperStt(input: {
  readonly bytes: Buffer;
  readonly timeoutMs?: number;
}): Promise<SttExecutionResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const modelPath = process.env.WHISPER_MODEL_PATH ?? '/opt/whisper/ggml-base.bin';
  const workDir = await mkdtemp(join(tmpdir(), 'fcd-stt-'));
  const inputPath = join(workDir, 'input.bin');
  const wavPath = join(workDir, 'audio.wav');
  const outPrefix = join(workDir, 'transcript');

  try {
    await writeFile(inputPath, input.bytes);
    await execFile(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-i',
        inputPath,
        '-ar',
        '16000',
        '-ac',
        '1',
        '-f',
        'wav',
        wavPath,
      ],
      { timeout: timeoutMs },
    );
    await execFile(
      'whisper-cli',
      ['-m', modelPath, '-f', wavPath, '-l', 'auto', '-oj', '-of', outPrefix, '--no-prints'],
      { timeout: timeoutMs },
    );
    const parsed = JSON.parse(await readFile(`${outPrefix}.json`, 'utf8')) as {
      readonly transcription?: readonly { readonly text?: unknown }[];
      readonly result?: { readonly language?: unknown };
    };
    const rawTranscription = parsed.transcription;
    const segments: readonly { readonly text?: unknown }[] = Array.isArray(rawTranscription)
      ? rawTranscription
      : [];
    const text = segments
      .map((item) => (typeof item.text === 'string' ? item.text : ''))
      .join(' ')
      .normalize('NFKC')
      .replaceAll(/\s+/gu, ' ')
      .trim();
    const detectedLanguage =
      typeof parsed.result?.language === 'string' ? parsed.result.language : undefined;
    return {
      text,
      confidence: 0.9,
      ...(detectedLanguage === undefined ? {} : { detectedLanguage }),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error('payload_too_large');
    }
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
  });
  res.end(body);
}

export function createSttRequestHandler(
  options: SttHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxAudioBytes = options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
  const runStt = options.runStt ?? runWhisperStt;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true, service: 'stt' });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/transcribe') {
      sendJson(res, 404, { status: 'failed', reasonCode: 'not_found' });
      return;
    }

    let rawBody: unknown;
    try {
      rawBody = await readJsonBody(req, maxBodyBytes);
    } catch (error) {
      const code = error instanceof Error && error.message === 'payload_too_large' ? 413 : 400;
      sendJson(res, code, {
        status: 'failed',
        reasonCode: code === 413 ? 'stt_payload_too_large' : 'stt_invalid_json',
      });
      return;
    }

    const body =
      rawBody !== null && typeof rawBody === 'object'
        ? (rawBody as Record<string, unknown>)
        : undefined;
    const rawBase64 =
      typeof body?.mediaBase64 === 'string'
        ? body.mediaBase64
        : typeof body?.bytesBase64 === 'string'
          ? body.bytesBase64
          : undefined;
    if (rawBase64 === undefined || rawBase64.trim() === '') {
      sendJson(res, 400, { status: 'failed', reasonCode: 'stt_invalid_request' });
      return;
    }

    const languages = Array.isArray(body?.languages) ? body.languages : [];
    const languageHint =
      typeof languages[0] === 'string'
        ? languages[0]
        : typeof body?.languageHint === 'string'
          ? body.languageHint
          : undefined;
    const mimeType = typeof body?.mimeType === 'string' ? body.mimeType : undefined;
    const voice = typeof body?.voice === 'boolean' ? body.voice : undefined;
    const bytes = Buffer.from(rawBase64, 'base64');
    if (bytes.length === 0 || bytes.length > maxAudioBytes) {
      sendJson(res, 200, { status: 'unclear', reasonCode: 'stt_audio_out_of_bounds' });
      return;
    }
    if (!isSupportedAudioHeader(bytes)) {
      sendJson(res, 200, { status: 'unclear', reasonCode: 'stt_unsupported_audio_format' });
      return;
    }

    try {
      const transcribed = await runStt({
        bytes,
        ...(mimeType === undefined ? {} : { mimeType }),
        ...(languageHint === undefined ? {} : { languageHint }),
        ...(voice === undefined ? {} : { voice }),
      });
      const text = transcribed.text.normalize('NFKC').replaceAll(/\s+/gu, ' ').trim();
      const lettersOrDigits = text.match(/[\p{L}\p{N}]/gu) ?? [];
      if (lettersOrDigits.length < MINIMUM_ALNUM_CHARS) {
        sendJson(res, 200, { status: 'unclear', reasonCode: 'stt_empty_text' });
        return;
      }
      sendJson(res, 200, {
        status: 'extracted',
        text,
        language: detectSttLanguage(text, transcribed.detectedLanguage, languageHint),
        confidence: transcribed.confidence ?? 0.9,
      });
    } catch {
      sendJson(res, 500, { status: 'failed', reasonCode: 'stt_execution_failed' });
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.STT_PORT ?? '8092');
  const server = createServer((req, res) => {
    void createSttRequestHandler()(req, res);
  });
  server.listen(port, '0.0.0.0');
}
