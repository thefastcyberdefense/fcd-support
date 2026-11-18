import { isIP } from 'node:net';

import { z } from 'zod';

import type { KnowledgeLanguage } from '../knowledge/knowledge-types.js';
import type { ManifestFetch } from '../model/manifest-client.js';
import { readBoundedResponseText } from './bounded-response.js';
import type { MediaExtractionOutcome } from './media-types.js';
import { detectExtractedLanguage } from './pdf-extractor.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024;
const MINIMUM_CONFIDENCE = 0.55;

const serviceResponseSchema = z.object({
  confidence: z.number().min(0).max(1).optional(),
  hasVisualContent: z.boolean().optional(),
  language: z.enum(['bn', 'en']).optional(),
  reasonCode: z.string().min(1).max(64).optional(),
  status: z.enum(['extracted', 'failed', 'unclear', 'visual_only']),
  text: z.string().optional(),
});

export interface PrivateMediaServiceOptions {
  readonly fetch?: ManifestFetch;
  readonly maximumResponseBytes?: number;
  readonly timeoutMs?: number;
  readonly url?: string;
}

export function validatePrivateMediaServiceUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0 || trimmed.length > 2048 || /\s/u.test(trimmed)) {
    throw new Error('private_media_service_url_invalid');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('private_media_service_url_invalid');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new Error('private_media_service_url_invalid');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (isIP(hostname) === 4 && (hostname.startsWith('169.254.') || hostname === '0.0.0.0')) {
    throw new Error('private_media_service_url_invalid');
  }
  if (hostname === '::' || hostname.startsWith('fe80:')) {
    throw new Error('private_media_service_url_invalid');
  }
  return parsed.toString();
}

async function callPrivateService(
  service: 'ocr' | 'stt',
  options: PrivateMediaServiceOptions,
  payload: {
    readonly bytes: Uint8Array;
    readonly languageHint: KnowledgeLanguage;
    readonly mimeType?: string;
    readonly voice?: boolean;
  },
): Promise<MediaExtractionOutcome> {
  if (options.url === undefined) {
    return {
      status: 'unclear',
      reasonCode: service === 'ocr' ? 'ocr_unconfigured' : 'stt_unconfigured',
    };
  }
  let endpoint: string;
  try {
    endpoint = validatePrivateMediaServiceUrl(options.url);
  } catch {
    return {
      status: 'failed',
      reasonCode: service === 'ocr' ? 'ocr_configuration_invalid' : 'stt_configuration_invalid',
    };
  }

  const transport: ManifestFetch = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maximumResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await transport(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        languages: payload.languageHint === 'bn' ? ['bn', 'en'] : ['en', 'bn'],
        mediaBase64: Buffer.from(payload.bytes).toString('base64'),
        ...(payload.mimeType === undefined ? {} : { mimeType: payload.mimeType }),
        ...(payload.voice === undefined ? {} : { voice: payload.voice }),
      }),
      redirect: 'error',
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return {
      status: 'failed',
      reasonCode: controller.signal.aborted ? `${service}_timeout` : `${service}_network_failure`,
    };
  }

  let bodyText: string;
  try {
    if (!response.ok) {
      return { status: 'failed', reasonCode: `${service}_http_${String(response.status)}` };
    }
    const read = await readBoundedResponseText(response, maxBytes, () => {
      controller.abort();
    });
    if (read === undefined) {
      return { status: 'failed', reasonCode: `${service}_oversized_response` };
    }
    bodyText = read;
  } finally {
    clearTimeout(timer);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(bodyText);
  } catch {
    return { status: 'failed', reasonCode: `${service}_invalid_json` };
  }

  const parsed = serviceResponseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return { status: 'failed', reasonCode: `${service}_invalid_response` };
  }
  const data = parsed.data;
  if (data.status === 'visual_only' || (service === 'ocr' && data.hasVisualContent === true)) {
    return {
      status: 'visual_only',
      reasonCode: data.reasonCode ?? 'visual_interpretation_deferred',
    };
  }
  if (data.status === 'failed') {
    return { status: 'failed', reasonCode: data.reasonCode ?? `${service}_failed` };
  }
  if (data.status === 'unclear') {
    return { status: 'unclear', reasonCode: data.reasonCode ?? `${service}_unclear` };
  }
  if (data.confidence !== undefined && data.confidence < MINIMUM_CONFIDENCE) {
    return { status: 'unclear', reasonCode: `${service}_low_confidence` };
  }

  const normalized = (data.text ?? '').normalize('NFKC').replaceAll(/\s+/gu, ' ').trim();
  const lettersOrDigits = normalized.match(/[\p{L}\p{N}]/gu) ?? [];
  if (lettersOrDigits.length < 3) {
    return {
      status: service === 'ocr' ? 'visual_only' : 'unclear',
      reasonCode: service === 'ocr' ? 'visual_interpretation_deferred' : `${service}_empty_text`,
    };
  }

  return {
    status: 'extracted',
    text: normalized,
    method: service,
    detectedLanguage: data.language ?? detectExtractedLanguage(normalized, payload.languageHint),
  };
}

export function createPrivateOcrExtractor(options: PrivateMediaServiceOptions = {}) {
  return (input: {
    readonly bytes: Uint8Array;
    readonly languageHint: KnowledgeLanguage;
    readonly mimeType?: string;
  }) => callPrivateService('ocr', options, input);
}

export function createPrivateSttExtractor(options: PrivateMediaServiceOptions = {}) {
  return (input: {
    readonly bytes: Uint8Array;
    readonly languageHint: KnowledgeLanguage;
    readonly mimeType?: string;
    readonly voice?: boolean;
  }) => callPrivateService('stt', options, input);
}
