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
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_THREADS = 2;
const MINIMUM_ALNUM_CHARS = 3;
const MINIMUM_CONFIDENCE = 0.55;

function parseBoundedEnvInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || !/^[1-9][0-9]*$/u.test(raw)) return fallback;
  const parsed = Number(raw);
  return Math.min(max, Math.max(min, parsed));
}

const STT_NON_SPEECH_MARKERS = new Set([
  'applause',
  'beep',
  'bell',
  'blank audio',
  'buzz',
  'cheering',
  'chuckle',
  'click',
  'cough',
  'crying',
  'gasp',
  'groan',
  'hum',
  'inaudible',
  'laughter',
  'music',
  'noise',
  'panting',
  'pause',
  'quiet',
  'rain',
  'ringing',
  'sigh',
  'silence',
  'singing',
  'snore',
  'static',
  'throat clearing',
  'thunder',
  'unintelligible',
  'wind',
  'yawn',
]);

const STT_TAG_PATTERN = /\[[^[\]\r\n]{1,64}\]|\([^()\r\n]{1,64}\)/gu;

function isNonSpeechTag(tag: string): boolean {
  const inner = tag
    .slice(1, -1)
    .toLowerCase()
    .replaceAll(/[_\s-]+/gu, ' ')
    .trim();
  if (inner === '') return true;
  if (tag.startsWith('[') && tag.endsWith(']') && tag.slice(1, -1).trim().startsWith('_')) {
    return true;
  }
  if (inner.startsWith('speaking ')) return true;
  return STT_NON_SPEECH_MARKERS.has(inner);
}

export function stripSttEngineMarkers(rawText: string): string {
  const withoutKnownMarkers = rawText
    .normalize('NFKC')
    .replaceAll(/[♪♫♬]+/gu, ' ')
    .replaceAll(STT_TAG_PATTERN, (match) => (isNonSpeechTag(match) ? ' ' : match))
    .replaceAll(/\s+/gu, ' ')
    .trim();
  const withoutBracketedTags = withoutKnownMarkers.replaceAll(STT_TAG_PATTERN, ' ');
  if (!/[\p{L}\p{N}]/u.test(withoutBracketedTags)) {
    return '';
  }
  return withoutKnownMarkers;
}

export interface SttExecutionResult {
  readonly text: string;
  readonly detectedLanguage?: string;
  readonly confidence?: number;
}

export interface SttHandlerOptions {
  readonly allowBanglaStt?: boolean;
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

export function isSilentPcmWav(wavBytes: Buffer, minimumNormalizedPeak = 0.002): boolean {
  if (
    wavBytes.length < 44 ||
    wavBytes.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    wavBytes.subarray(8, 12).toString('ascii') !== 'WAVE'
  ) {
    return false;
  }
  let offset = 12;
  let dataStart = -1;
  let dataEnd = -1;
  while (offset + 8 <= wavBytes.length) {
    const chunkId = wavBytes.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = wavBytes.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = Math.min(wavBytes.length, bodyStart + chunkSize);
    if (chunkId === 'data') {
      dataStart = bodyStart;
      dataEnd = bodyEnd;
      break;
    }
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }
  if (dataStart < 0 || dataEnd - dataStart < 2) {
    return true;
  }
  let peak = 0;
  for (let i = dataStart; i + 1 < dataEnd; i += 2) {
    const abs = Math.abs(wavBytes.readInt16LE(i));
    if (abs > peak) peak = abs;
  }
  return peak / 32768 < minimumNormalizedPeak;
}

export async function runWhisperStt(input: {
  readonly bytes: Buffer;
  readonly languageHint?: string;
  readonly timeoutMs?: number;
}): Promise<SttExecutionResult> {
  const timeoutMs =
    input.timeoutMs ??
    parseBoundedEnvInt(process.env.STT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 120_000);
  const threads = parseBoundedEnvInt(process.env.STT_THREADS, DEFAULT_THREADS, 1, 4);
  const baseModelPath = process.env.WHISPER_MODEL_PATH ?? '/opt/whisper/ggml-base.bin';
  const banglaModelRaw = process.env.WHISPER_BANGLA_MODEL_PATH?.trim();
  const banglaModelPath =
    banglaModelRaw !== undefined && banglaModelRaw !== '' ? banglaModelRaw : undefined;
  const whisperLang =
    input.languageHint === 'bn' ? 'bn' : input.languageHint === 'en' ? 'en' : 'auto';
  const workDir = await mkdtemp(join(tmpdir(), 'fcd-stt-'));
  const inputPath = join(workDir, 'input.bin');
  const wavPath = join(workDir, 'audio.wav');
  const deadline = Date.now() + timeoutMs;

  const remainingMs = (): number => Math.max(1_000, deadline - Date.now());

  const executeWhisperModel = async (
    modelPath: string,
    lang: 'en' | 'bn' | 'auto',
    prefixName: string,
  ): Promise<SttExecutionResult> => {
    const outPrefix = join(workDir, prefixName);
    await execFile(
      'whisper-cli',
      [
        '-m',
        modelPath,
        '-f',
        wavPath,
        '-l',
        lang,
        '-t',
        String(threads),
        '-ojf',
        '-of',
        outPrefix,
        '--no-prints',
      ],
      { timeout: remainingMs() },
    );
    const parsed = JSON.parse(await readFile(`${outPrefix}.json`, 'utf8')) as {
      readonly transcription?: readonly {
        readonly text?: unknown;
        readonly tokens?: readonly { readonly text?: unknown; readonly p?: unknown }[];
      }[];
      readonly result?: { readonly language?: unknown };
    };
    const rawTranscription = parsed.transcription;
    const segments: readonly {
      readonly text?: unknown;
      readonly tokens?: readonly { readonly text?: unknown; readonly p?: unknown }[];
    }[] = Array.isArray(rawTranscription) ? rawTranscription : [];
    const rawJoined = segments
      .map((item) => (typeof item.text === 'string' ? item.text : ''))
      .join(' ');
    const text = stripSttEngineMarkers(rawJoined);
    const tokenProbs: number[] = [];
    for (const segment of segments) {
      const rawTokens: readonly { readonly text?: unknown; readonly p?: unknown }[] = Array.isArray(
        segment.tokens,
      )
        ? segment.tokens
        : [];
      for (const tok of rawTokens) {
        const tokText = typeof tok.text === 'string' ? tok.text.trim() : '';
        if (
          tokText === '' ||
          tokText.startsWith('[_') ||
          stripSttEngineMarkers(tokText) === '' ||
          !/[\p{L}\p{N}]/u.test(tokText)
        ) {
          continue;
        }
        if (typeof tok.p === 'number' && Number.isFinite(tok.p) && tok.p >= 0 && tok.p <= 1) {
          tokenProbs.push(tok.p);
        }
      }
    }
    const measuredConfidence =
      text.length > 0 && tokenProbs.length > 0
        ? Number((tokenProbs.reduce((sum, p) => sum + p, 0) / tokenProbs.length).toFixed(4))
        : undefined;
    const detectedLanguage =
      typeof parsed.result?.language === 'string' ? parsed.result.language : undefined;
    return {
      text,
      ...(measuredConfidence === undefined ? {} : { confidence: measuredConfidence }),
      ...(detectedLanguage === undefined ? {} : { detectedLanguage }),
    };
  };

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
      { timeout: remainingMs() },
    );
    const wavBytes = await readFile(wavPath);
    if (isSilentPcmWav(wavBytes)) {
      return {
        text: '',
        ...(whisperLang === 'auto' ? {} : { detectedLanguage: whisperLang }),
      };
    }
    if (whisperLang === 'bn' && banglaModelPath !== undefined) {
      return await executeWhisperModel(banglaModelPath, 'bn', 'transcript-bn');
    }
    const primary = await executeWhisperModel(baseModelPath, whisperLang, 'transcript');
    const shouldRetryBangla =
      whisperLang === 'auto' &&
      banglaModelPath !== undefined &&
      banglaModelPath !== baseModelPath &&
      deadline - Date.now() > 5_000 &&
      (primary.detectedLanguage !== 'en' ||
        /\p{Script=Arabic}|\p{Script=Devanagari}/u.test(primary.text) ||
        primary.text.length === 0 ||
        (primary.confidence !== undefined && primary.confidence < MINIMUM_CONFIDENCE));
    if (shouldRetryBangla) {
      const bangla = await executeWhisperModel(banglaModelPath, 'bn', 'transcript-bn');
      if (/\p{Script=Bengali}/u.test(bangla.text)) {
        return bangla;
      }
    }
    return primary;
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
  const allowBanglaStt = options.allowBanglaStt ?? process.env.STT_ENABLE_BANGLA === 'true';
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
      const text = stripSttEngineMarkers(transcribed.text);
      const lettersOrDigits = text.match(/[\p{L}\p{N}]/gu) ?? [];
      if (lettersOrDigits.length < MINIMUM_ALNUM_CHARS) {
        sendJson(res, 200, { status: 'unclear', reasonCode: 'stt_empty_text' });
        return;
      }
      const hasBengali = /\p{Script=Bengali}/u.test(text);
      const hasLatin = /[A-Za-z]/u.test(text);
      const hasUnsupportedScript = /\p{Script=Arabic}|\p{Script=Devanagari}/u.test(text);
      if (
        (hasUnsupportedScript && !hasBengali && !hasLatin) ||
        ((transcribed.detectedLanguage === 'bn' || languageHint === 'bn') && !hasBengali)
      ) {
        sendJson(res, 200, { status: 'unclear', reasonCode: 'stt_script_mismatch' });
        return;
      }
      const resolvedLanguage = detectSttLanguage(text, transcribed.detectedLanguage, languageHint);
      if (!allowBanglaStt && (resolvedLanguage === 'bn' || languageHint === 'bn' || hasBengali)) {
        sendJson(res, 200, { status: 'unclear', reasonCode: 'stt_bangla_held' });
        return;
      }
      const measuredConfidence =
        typeof transcribed.confidence === 'number' &&
        Number.isFinite(transcribed.confidence) &&
        transcribed.confidence >= 0 &&
        transcribed.confidence <= 1
          ? transcribed.confidence
          : undefined;
      if (measuredConfidence !== undefined && measuredConfidence < MINIMUM_CONFIDENCE) {
        sendJson(res, 200, { status: 'unclear', reasonCode: 'stt_low_confidence' });
        return;
      }
      sendJson(res, 200, {
        status: 'extracted',
        text,
        language: resolvedLanguage,
        ...(measuredConfidence === undefined
          ? {}
          : { confidence: Number(measuredConfidence.toFixed(4)) }),
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
