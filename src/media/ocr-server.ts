import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

const DEFAULT_MAX_BODY_BYTES = 15 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MINIMUM_ALNUM_CHARS = 3;

export interface OcrExecutionResult {
  readonly text: string;
  readonly confidence?: number;
}

export interface OcrHandlerOptions {
  readonly maxBodyBytes?: number;
  readonly maxImageBytes?: number;
  readonly runOcr?: (input: {
    readonly bytes: Buffer;
    readonly mimeType?: string;
    readonly languageHint?: string;
  }) => Promise<OcrExecutionResult>;
}

function detectImageFormat(bytes: Buffer): 'png' | 'jpeg' | 'gif' | 'webp' | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString('ascii').startsWith('GIF8')) {
    return 'gif';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return undefined;
}

export function detectOcrLanguage(text: string, hint?: string): 'en' | 'bn' {
  if (/[\u0980-\u09FF]/u.test(text)) return 'bn';
  if (/[A-Za-z]/u.test(text)) return 'en';
  return hint === 'bn' ? 'bn' : 'en';
}

export function parseTesseractTsv(tsvText: string): {
  readonly text: string;
  readonly confidence: number;
} {
  const words: string[] = [];
  const confidences: number[] = [];
  for (const line of tsvText.split(/\r?\n/u).slice(1)) {
    if (line.trim() === '') continue;
    const cols = line.split('\t');
    if (cols.length < 12) continue;
    const conf = Number(cols[10]);
    const word = (cols[11] ?? '').trim();
    if (word !== '' && Number.isFinite(conf) && conf >= 0) {
      words.push(word);
      confidences.push(Math.min(1, Math.max(0, conf / 100)));
    }
  }
  const text = words.join(' ').normalize('NFKC').replaceAll(/\s+/gu, ' ').trim();
  const confidence =
    confidences.length === 0
      ? 0
      : Number((confidences.reduce((sum, v) => sum + v, 0) / confidences.length).toFixed(4));
  return { text, confidence };
}

export async function runTesseractOcr(input: {
  readonly bytes: Buffer;
  readonly languageHint?: string;
  readonly timeoutMs?: number;
}): Promise<OcrExecutionResult> {
  const langArg = input.languageHint === 'bn' ? 'ben+eng' : 'eng+ben';
  const stdout = await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn('tesseract', ['stdin', 'stdout', '-l', langArg, '--psm', '3', 'tsv'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let outBytes = 0;
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err !== undefined) {
        rejectPromise(err);
      } else {
        resolvePromise(Buffer.concat(chunks).toString('utf8'));
      }
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('ocr_timeout'));
    }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new Error('ocr_output_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    child.on('error', (err) => {
      finish(err);
    });
    child.on('close', (code) => {
      if (code === 0) {
        finish();
      } else {
        finish(new Error(`ocr_exit_${String(code)}`));
      }
    });
    child.stdin.end(input.bytes);
  });
  return parseTesseractTsv(stdout);
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

export function createOcrRequestHandler(
  options: OcrHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const runOcr = options.runOcr ?? runTesseractOcr;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true, service: 'ocr' });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/extract') {
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
        reasonCode: code === 413 ? 'ocr_payload_too_large' : 'ocr_invalid_json',
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
      sendJson(res, 400, { status: 'failed', reasonCode: 'ocr_invalid_request' });
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
    const bytes = Buffer.from(rawBase64, 'base64');
    if (bytes.length === 0 || bytes.length > maxImageBytes) {
      sendJson(res, 200, { status: 'unclear', reasonCode: 'ocr_image_out_of_bounds' });
      return;
    }
    if (detectImageFormat(bytes) === undefined) {
      sendJson(res, 200, {
        status: 'visual_only',
        hasVisualContent: true,
        reasonCode: 'visual_interpretation_deferred',
      });
      return;
    }

    try {
      const extracted = await runOcr({
        bytes,
        ...(mimeType === undefined ? {} : { mimeType }),
        ...(languageHint === undefined ? {} : { languageHint }),
      });
      const text = extracted.text.normalize('NFKC').replaceAll(/\s+/gu, ' ').trim();
      const lettersOrDigits = text.match(/[\p{L}\p{N}]/gu) ?? [];
      if (lettersOrDigits.length < MINIMUM_ALNUM_CHARS) {
        sendJson(res, 200, {
          status: 'visual_only',
          hasVisualContent: true,
          reasonCode: 'visual_interpretation_deferred',
        });
        return;
      }
      if (extracted.confidence !== undefined && extracted.confidence < 0.55) {
        sendJson(res, 200, {
          status: 'unclear',
          reasonCode: 'ocr_low_confidence',
        });
        return;
      }
      sendJson(res, 200, {
        status: 'extracted',
        text,
        language: detectOcrLanguage(text, languageHint),
        confidence: extracted.confidence ?? 0.9,
      });
    } catch {
      sendJson(res, 500, { status: 'failed', reasonCode: 'ocr_execution_failed' });
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.OCR_PORT ?? '8091');
  const server = createServer((req, res) => {
    void createOcrRequestHandler()(req, res);
  });
  server.listen(port, '0.0.0.0');
}
