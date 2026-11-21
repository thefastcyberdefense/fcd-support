import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { PrivateMediaProcessor } from '../src/media/media-processor.js';
import { extractPdfText } from '../src/media/pdf-extractor.js';
import {
  createPrivateOcrExtractor,
  createPrivateSttExtractor,
} from '../src/media/private-service-client.js';
import { assertMediaCompose } from '../src/operations/compose-contract.js';
import { inspectSensitiveText } from '../src/safety/sensitive-data-gate.js';
import { createOcrRequestHandler, parseTesseractTsv } from '../src/media/ocr-server.js';
import { createSttRequestHandler } from '../src/media/stt-server.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose) => {
          server.close(() => {
            resolveClose();
          });
        }),
    ),
  );
});

async function startHttpServer(
  handler: ReturnType<typeof createOcrRequestHandler> | ReturnType<typeof createSttRequestHandler>,
): Promise<string> {
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server_address_unavailable');
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

describe('private OCR and STT service contracts and compose overlay', () => {
  test('parses Tesseract TSV confidence cleanly for English and Bangla words', () => {
    const tsv = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '5\t1\t1\t1\t1\t1\t10\t10\t40\t12\t96\tআপনাদের',
      '5\t1\t1\t1\t1\t2\t60\t10\t30\t12\t92\tসেবা',
      '5\t1\t1\t1\t1\t3\t95\t10\t30\t12\t-1\t',
    ].join('\n');
    expect(parseTesseractTsv(tsv)).toEqual({
      text: 'আপনাদের সেবা',
      confidence: 0.94,
    });
  });

  test('processes synthetic PNG OCR and OGG STT through HTTP handlers, redacts before inference, and escalates visual-only/corrupt inputs', async () => {
    const pngHeader = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const oggHeader = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 1, 2, 3, 4]);

    const ocrBaseUrl = await startHttpServer(
      createOcrRequestHandler({
        runOcr: ({ bytes }) => {
          if (bytes[8] === 9) {
            return Promise.resolve({ text: '  ', confidence: 0 });
          }
          if (bytes[8] === 8) {
            return Promise.resolve({ text: 'garbled low confidence', confidence: 0.41 });
          }
          if (bytes[8] === 7) {
            return Promise.reject(new Error('corrupt_png'));
          }
          return Promise.resolve({
            text: 'How do I update login when OTP: 987654 fails?',
            confidence: 0.95,
          });
        },
      }),
    );

    const sttBaseUrl = await startHttpServer(
      createSttRequestHandler({
        runStt: ({ bytes }) => {
          if (bytes[8] === 9) {
            return Promise.resolve({ text: '', detectedLanguage: 'bn', confidence: 0 });
          }
          if (bytes[8] === 8) {
            return Promise.resolve({
              text: 'اپنا رکی کی تھوڑنے',
              detectedLanguage: 'bn',
              confidence: 0.9,
            });
          }
          return Promise.resolve({
            text: 'আপনাদের সেবাগুলো কী কী?',
            detectedLanguage: 'bn',
            confidence: 0.91,
          });
        },
      }),
    );

    const processor = new PrivateMediaProcessor({
      fetcher: {
        download: (attachment) => {
          if (attachment.mediaId === 'IMG_OTP') {
            return Promise.resolve({
              status: 'downloaded',
              bytes: pngHeader,
              mimeType: 'image/png',
            });
          }
          if (attachment.mediaId === 'IMG_VISUAL') {
            return Promise.resolve({
              status: 'downloaded',
              bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 0, 0, 0]),
              mimeType: 'image/png',
            });
          }
          if (attachment.mediaId === 'IMG_LOW_CONF') {
            return Promise.resolve({
              status: 'downloaded',
              bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 8, 0, 0, 0]),
              mimeType: 'image/png',
            });
          }
          if (attachment.mediaId === 'IMG_ERR') {
            return Promise.resolve({
              status: 'downloaded',
              bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 0, 0, 0]),
              mimeType: 'image/png',
            });
          }
          if (attachment.mediaId === 'AUD_BN') {
            return Promise.resolve({
              status: 'downloaded',
              bytes: oggHeader,
              mimeType: 'audio/ogg',
            });
          }
          if (attachment.mediaId === 'AUD_SCRIPT_MISMATCH') {
            return Promise.resolve({
              status: 'downloaded',
              bytes: Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 8, 2, 3, 4]),
              mimeType: 'audio/ogg',
            });
          }
          return Promise.resolve({
            status: 'downloaded',
            bytes: Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 9, 0, 0, 0]),
            mimeType: 'audio/ogg',
          });
        },
      },
      extractor: {
        extractPdf: extractPdfText,
        extractImageOcr: createPrivateOcrExtractor({
          url: 'http://ocr.internal/extract',
          fetch: (url, init) =>
            globalThis.fetch(url.replace('http://ocr.internal', ocrBaseUrl), init),
        }),
        transcribeAudio: createPrivateSttExtractor({
          url: 'http://stt.internal/transcribe',
          fetch: (url, init) =>
            globalThis.fetch(url.replace('http://stt.internal', sttBaseUrl), init),
        }),
      },
      inspectSensitiveText,
    });

    const attachmentBase = {
      attachmentIndex: 0,
      caption: null,
      detectedLanguage: null,
      extractedText: null,
      extractionMethod: null,
      extractionStatus: 'pending' as const,
      reasonCode: null,
      sha256: null,
    };

    const imgResult = await processor.process({
      attachments: [
        {
          ...attachmentBase,
          id: 'att-img',
          kind: 'image',
          rawType: 'image',
          mediaId: 'IMG_OTP',
          mediaUrl: null,
          mimeType: 'image/png',
          filename: 'otp.png',
          isVoice: null,
        },
      ],
      channel: 'whatsapp',
      evaluatedAt: new Date('2026-11-21T10:00:00.000Z'),
      language: 'en',
      messageText: '',
    });
    expect(imgResult.kind).toBe('extracted');
    if (imgResult.kind === 'extracted') {
      expect(imgResult.combinedText).toContain('[REDACTED_OTP]');
      expect(imgResult.combinedText).not.toContain('987654');
      expect(imgResult.attachmentOutcomes[0]?.extractionMethod).toBe('ocr');
    }

    const audResult = await processor.process({
      attachments: [
        {
          ...attachmentBase,
          id: 'att-aud',
          kind: 'audio',
          rawType: 'audio',
          mediaId: 'AUD_BN',
          mediaUrl: null,
          mimeType: 'audio/ogg',
          filename: null,
          isVoice: true,
        },
      ],
      channel: 'whatsapp',
      evaluatedAt: new Date('2026-11-21T10:00:00.000Z'),
      language: 'en',
      messageText: '',
    });
    expect(audResult.kind).toBe('extracted');
    if (audResult.kind === 'extracted') {
      expect(audResult.effectiveLanguage).toBe('bn');
      expect(audResult.attachmentOutcomes[0]?.extractionMethod).toBe('stt');
      expect(audResult.combinedText).toContain('আপনাদের সেবাগুলো কী কী?');
    }

    const visualResult = await processor.process({
      attachments: [
        {
          ...attachmentBase,
          id: 'att-vis',
          kind: 'image',
          rawType: 'image',
          mediaId: 'IMG_VISUAL',
          mediaUrl: null,
          mimeType: 'image/png',
          filename: 'photo.png',
          isVoice: null,
        },
      ],
      channel: 'messenger',
      evaluatedAt: new Date('2026-11-21T10:00:00.000Z'),
      language: 'en',
      messageText: '',
    });
    expect(visualResult).toMatchObject({
      kind: 'escalate',
      escalationReasonCode: 'visual_media_deferred',
    });

    const badAudioResult = await processor.process({
      attachments: [
        {
          ...attachmentBase,
          id: 'att-bad-aud',
          kind: 'audio',
          rawType: 'audio',
          mediaId: 'AUD_BAD',
          mediaUrl: null,
          mimeType: 'audio/ogg',
          filename: null,
          isVoice: true,
        },
      ],
      channel: 'messenger',
      evaluatedAt: new Date('2026-11-21T10:00:00.000Z'),
      language: 'en',
      messageText: '',
    });
    expect(badAudioResult).toMatchObject({
      kind: 'escalate',
      escalationReasonCode: 'unclear_media',
    });

    const lowConfOcr = await processor.process({
      attachments: [
        {
          ...attachmentBase,
          id: 'att-low-ocr',
          kind: 'image',
          rawType: 'image',
          mediaId: 'IMG_LOW_CONF',
          mediaUrl: null,
          mimeType: 'image/png',
          filename: 'blur.png',
          isVoice: null,
        },
      ],
      channel: 'whatsapp',
      evaluatedAt: new Date('2026-11-21T10:00:00.000Z'),
      language: 'en',
      messageText: '',
    });
    expect(lowConfOcr).toMatchObject({
      kind: 'escalate',
      escalationReasonCode: 'unclear_media',
      attachmentOutcomes: [{ extractionStatus: 'unclear', reasonCode: 'ocr_low_confidence' }],
    });

    const failedOcr = await processor.process({
      attachments: [
        {
          ...attachmentBase,
          id: 'att-err-ocr',
          kind: 'image',
          rawType: 'image',
          mediaId: 'IMG_ERR',
          mediaUrl: null,
          mimeType: 'image/png',
          filename: 'corrupt.png',
          isVoice: null,
        },
      ],
      channel: 'whatsapp',
      evaluatedAt: new Date('2026-11-21T10:00:00.000Z'),
      language: 'en',
      messageText: '',
    });
    expect(failedOcr).toMatchObject({
      kind: 'escalate',
      escalationReasonCode: 'media_extraction_failed',
      attachmentOutcomes: [{ extractionStatus: 'failed', reasonCode: 'ocr_http_500' }],
    });

    const mismatchStt = await processor.process({
      attachments: [
        {
          ...attachmentBase,
          id: 'att-mismatch-stt',
          kind: 'audio',
          rawType: 'audio',
          mediaId: 'AUD_SCRIPT_MISMATCH',
          mediaUrl: null,
          mimeType: 'audio/ogg',
          filename: null,
          isVoice: true,
        },
      ],
      channel: 'whatsapp',
      evaluatedAt: new Date('2026-11-21T10:00:00.000Z'),
      language: 'bn',
      messageText: '',
    });
    expect(mismatchStt).toMatchObject({
      kind: 'escalate',
      escalationReasonCode: 'unclear_media',
      attachmentOutcomes: [{ extractionStatus: 'unclear', reasonCode: 'stt_script_mismatch' }],
    });
  });

  test('validates the pinned infra/compose.media.yml least-privilege overlay contract and Dockerfiles', () => {
    const rev = 'a'.repeat(40);
    const composeText = readFileSync(
      resolve(import.meta.dirname, '../infra/compose.media.yml'),
      'utf8',
    );
    expect(composeText).toContain('PRIVATE_MEDIA_OCR_URL: http://fcd-support-ocr:8091/extract');
    expect(composeText).toContain('PRIVATE_MEDIA_STT_URL: http://fcd-support-stt:8092/transcribe');
    expect(composeText).toContain(
      'META_WHATSAPP_ACCESS_TOKEN_FILE: /run/secrets/reply-meta-whatsapp-token',
    );
    expect(composeText).toContain(
      'META_PAGE_ACCESS_TOKEN_FILE: /run/secrets/reply-meta-page-token',
    );
    expect(composeText).not.toContain('meta-app-secret');
    expect(composeText).not.toContain('meta-verify-token');

    const ocrDockerfile = readFileSync(
      resolve(import.meta.dirname, '../infra/media/Dockerfile.ocr'),
      'utf8',
    );
    const sttDockerfile = readFileSync(
      resolve(import.meta.dirname, '../infra/media/Dockerfile.stt'),
      'utf8',
    );
    expect(ocrDockerfile).toContain('tesseract-ocr-eng');
    expect(ocrDockerfile).toContain('tesseract-ocr-ben');
    expect(ocrDockerfile).toContain('USER node');
    expect(sttDockerfile).toContain('sha256sum --check');
    expect(sttDockerfile).toContain('USER node');

    const baseMediaService = (port: number, tmpMiB: number, cpus: number, mem: string) => ({
      image: `fcd-support-media:${rev}`,
      labels: { 'org.opencontainers.image.revision': rev },
      user: 'node' as const,
      init: true as const,
      read_only: true as const,
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      pids_limit: 64,
      cpus,
      mem_limit: mem,
      stop_grace_period: '5000ms',
      restart: 'unless-stopped' as const,
      profiles: ['media-execution'],
      tmpfs: [`/tmp:rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=${String(tmpMiB)}m`],
      environment: { NODE_ENV: 'production', TMPDIR: '/tmp' },
      healthcheck: {
        test: ['CMD', 'node', '-e', `fetch("http://127.0.0.1:${String(port)}/health")`],
        interval: '2000ms',
        timeout: '1000ms',
        retries: 10,
      },
      networks: ['media_internal'],
    });

    const validOverlay = {
      services: {
        'fcd-support-ocr': baseMediaService(8091, 64, 0.5, '512m'),
        'fcd-support-stt': baseMediaService(8092, 128, 1.5, '1024m'),
        'fcd-support-reply': {
          environment: {
            PRIVATE_MEDIA_OCR_URL: 'http://fcd-support-ocr:8091/extract' as const,
            PRIVATE_MEDIA_STT_URL: 'http://fcd-support-stt:8092/transcribe' as const,
            META_WHATSAPP_ACCESS_TOKEN_FILE: '/run/secrets/reply-meta-whatsapp-token' as const,
            META_PAGE_ACCESS_TOKEN_FILE: '/run/secrets/reply-meta-page-token' as const,
          },
          secrets: ['reply-meta-whatsapp-token', 'reply-meta-page-token'],
          depends_on: {
            'fcd-support-ocr': { condition: 'service_healthy' },
            'fcd-support-stt': { condition: 'service_healthy' },
          },
          networks: { media_internal: {}, provider_egress: {} },
        },
      },
      networks: {
        media_internal: { name: 'fcd-support-test-media-internal', internal: true as const },
      },
    };
    expect(() => {
      assertMediaCompose(validOverlay, rev);
    }).not.toThrow();

    const invalidEgress = structuredClone(validOverlay);
    invalidEgress.services['fcd-support-ocr'].networks.push('provider_egress');
    expect(() => {
      assertMediaCompose(invalidEgress, rev);
    }).toThrow('compose_contract_invalid');
  });
});
