import { createHash } from 'node:crypto';

import { describe, expect, test, vi } from 'vitest';

import { MetaMediaFetcher } from '../src/media/media-fetcher.js';
import { PrivateMediaProcessor } from '../src/media/media-processor.js';
import type { ClaimedWebhookAttachment } from '../src/media/media-types.js';
import { extractPdfText } from '../src/media/pdf-extractor.js';
import {
  createPrivateOcrExtractor,
  createPrivateSttExtractor,
} from '../src/media/private-service-client.js';
import { inspectSensitiveText } from '../src/safety/sensitive-data-gate.js';

function buildMinimalPdf(lines: readonly string[]): Uint8Array {
  const escapedLines = lines.map((line) =>
    line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)'),
  );
  const streamOps = escapedLines
    .map((line, index) => `BT /F1 12 Tf 72 ${String(720 - index * 18)} Td (${line}) Tj ET`)
    .join('\n');
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${String(Buffer.byteLength(streamOps, 'utf8'))} >>\nstream\n${streamOps}\nendstream\nendobj\n`,
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, 'utf8'));
    body += obj;
  }
  const xrefOffset = Buffer.byteLength(body, 'utf8');
  let xref = `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;
  return Uint8Array.from(Buffer.from(body + xref, 'utf8'));
}

function attachmentFixture(
  overrides: Partial<ClaimedWebhookAttachment> = {},
): ClaimedWebhookAttachment {
  return {
    id: '101',
    attachmentIndex: 0,
    kind: 'document',
    rawType: 'document',
    mediaId: 'MEDIA_SYNTHETIC_1',
    mediaUrl: null,
    mimeType: 'application/pdf',
    filename: 'support.pdf',
    caption: null,
    sha256: null,
    isVoice: null,
    extractionStatus: 'pending',
    extractedText: null,
    extractionMethod: null,
    detectedLanguage: null,
    reasonCode: null,
    ...overrides,
  };
}

describe('Track 2C private media extraction and redaction', () => {
  test('extracts real PDF text in-process with unpdf and rejects corrupt or non-PDF inputs', async () => {
    const validPdf = buildMinimalPdf(['How do I reset my firewall gateway settings?']);
    const extracted = await extractPdfText(validPdf);
    expect(extracted).toEqual({
      status: 'extracted',
      text: 'How do I reset my firewall gateway settings?',
      method: 'pdf_text',
      detectedLanguage: 'en',
    });

    const emptyPdf = buildMinimalPdf(['   ']);
    await expect(extractPdfText(emptyPdf)).resolves.toEqual({
      status: 'unclear',
      reasonCode: 'empty_pdf_text',
    });

    const notPdf = new TextEncoder().encode('PK\u0003\u0004synthetic-docx');
    await expect(extractPdfText(notPdf)).resolves.toEqual({
      status: 'unsupported',
      reasonCode: 'invalid_pdf_header',
    });

    const corruptPdf = new TextEncoder().encode('%PDF-1.4\ncorrupted-stream-bytes');
    await expect(extractPdfText(corruptPdf)).resolves.toEqual({
      status: 'unclear',
      reasonCode: 'invalid_pdf_document',
    });
  });

  test('runs private EN and BN OCR and defers visual-only images cleanly', async () => {
    const ocrEn = createPrivateOcrExtractor({
      url: 'http://ocr.internal:8080/extract',
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              status: 'extracted',
              text: 'How can I renew my SOC plan?',
              language: 'en',
              confidence: 0.94,
            }),
            { status: 200 },
          ),
        ),
    });
    await expect(
      ocrEn({ bytes: Uint8Array.from([1, 2, 3]), languageHint: 'en', mimeType: 'image/png' }),
    ).resolves.toEqual({
      status: 'extracted',
      text: 'How can I renew my SOC plan?',
      method: 'ocr',
      detectedLanguage: 'en',
    });

    const ocrBn = createPrivateOcrExtractor({
      url: 'http://ocr.internal:8080/extract',
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              status: 'extracted',
              text: 'আমার অ্যাকাউন্ট কীভাবে পুনরুদ্ধার করব?',
              confidence: 0.91,
            }),
            { status: 200 },
          ),
        ),
    });
    await expect(
      ocrBn({ bytes: Uint8Array.from([1, 2, 3]), languageHint: 'en', mimeType: 'image/jpeg' }),
    ).resolves.toEqual({
      status: 'extracted',
      text: 'আমার অ্যাকাউন্ট কীভাবে পুনরুদ্ধার করব?',
      method: 'ocr',
      detectedLanguage: 'bn',
    });

    const visualOnly = createPrivateOcrExtractor({
      url: 'http://ocr.internal:8080/extract',
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              status: 'visual_only',
              hasVisualContent: true,
            }),
            { status: 200 },
          ),
        ),
    });
    await expect(
      visualOnly({ bytes: Uint8Array.from([1, 2, 3]), languageHint: 'en' }),
    ).resolves.toEqual({
      status: 'visual_only',
      reasonCode: 'visual_interpretation_deferred',
    });

    const unconfiguredOcr = createPrivateOcrExtractor();
    await expect(
      unconfiguredOcr({ bytes: Uint8Array.from([1, 2, 3]), languageHint: 'en' }),
    ).resolves.toEqual({
      status: 'unclear',
      reasonCode: 'ocr_unconfigured',
    });
  });

  test('runs private EN and BN audio transcription and rejects low-confidence or failing audio', async () => {
    const sttBn = createPrivateSttExtractor({
      url: 'https://stt.internal/transcribe',
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              status: 'extracted',
              text: 'আমাদের সাপোর্ট নম্বরটি কী?',
              language: 'bn',
              confidence: 0.88,
            }),
            { status: 200 },
          ),
        ),
    });
    await expect(
      sttBn({ bytes: Uint8Array.from([9, 8, 7]), languageHint: 'en', voice: true }),
    ).resolves.toEqual({
      status: 'extracted',
      text: 'আমাদের সাপোর্ট নম্বরটি কী?',
      method: 'stt',
      detectedLanguage: 'bn',
    });

    const lowConfidence = createPrivateSttExtractor({
      url: 'https://stt.internal/transcribe',
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              status: 'extracted',
              text: 'inaudible',
              confidence: 0.3,
            }),
            { status: 200 },
          ),
        ),
    });
    await expect(
      lowConfidence({ bytes: Uint8Array.from([9, 8, 7]), languageHint: 'en' }),
    ).resolves.toEqual({
      status: 'unclear',
      reasonCode: 'stt_low_confidence',
    });
  });

  test('downloads Meta media with SSRF guards, SHA-256 verification, and zero page-token leaks', async () => {
    const pdfBytes = buildMinimalPdf(['What are your support hours?']);
    const expectedHash = createHash('sha256').update(pdfBytes).digest('hex');

    const waFetcher = new MetaMediaFetcher({
      graphBaseUrl: 'https://graph.facebook.com/v22.0',
      whatsappAccessToken: 'SYNTHETIC_WA_MEDIA_TOKEN',
      fetch: (url) => {
        if (url.endsWith('/MEDIA_SYNTHETIC_1')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                url: 'https://lookaside.fbsbx.com/whatsapp/media/1',
                mime_type: 'application/pdf',
                sha256: expectedHash,
                file_size: pdfBytes.byteLength,
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(Buffer.from(pdfBytes), {
            status: 200,
            headers: { 'content-type': 'application/pdf' },
          }),
        );
      },
    });
    const downloaded = await waFetcher.download(
      attachmentFixture({ sha256: expectedHash }),
      'whatsapp',
    );
    expect(downloaded.status).toBe('downloaded');
    if (downloaded.status === 'downloaded') {
      expect(downloaded.bytes).toEqual(pdfBytes);
    }

    const mismatchFetcher = new MetaMediaFetcher({
      whatsappAccessToken: 'SYNTHETIC_WA_MEDIA_TOKEN',
      fetch: (url) => {
        if (url.endsWith('/MEDIA_SYNTHETIC_1')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                url: 'https://lookaside.fbsbx.com/whatsapp/media/1',
                sha256: 'b'.repeat(64),
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response(Buffer.from(pdfBytes), { status: 200 }));
      },
    });
    await expect(
      mismatchFetcher.download(attachmentFixture({ sha256: 'c'.repeat(64) }), 'whatsapp'),
    ).resolves.toEqual({
      status: 'failed',
      reasonCode: 'media_sha256_mismatch',
    });

    const ssrfFetcher = new MetaMediaFetcher({
      lookupHost: () => Promise.resolve([{ address: '127.0.0.1' }]),
    });
    await expect(
      ssrfFetcher.download(
        attachmentFixture({ mediaId: null, mediaUrl: 'https://internal.example/secret.pdf' }),
        'messenger',
      ),
    ).resolves.toEqual({
      status: 'failed',
      reasonCode: 'messenger_media_download_failed',
    });

    let seenAuthHeader: string | null = 'unset';
    const messengerFetcher = new MetaMediaFetcher({
      pageAccessToken: 'SYNTHETIC_PAGE_TOKEN',
      fetch: (_url, init) => {
        seenAuthHeader = new Headers(init.headers).get('authorization');
        return Promise.resolve(new Response(Buffer.from(pdfBytes), { status: 200 }));
      },
    });
    const msgResult = await messengerFetcher.download(
      attachmentFixture({ mediaId: null, mediaUrl: 'https://cdn.fbsbx.com/v/t1/doc.pdf' }),
      'messenger',
    );
    expect(msgResult.status).toBe('downloaded');
    expect(seenAuthHeader).toBeNull();
  });

  test('redacts single extracted secret before model inference and blocks always-block sensitive attachments without storing raw secrets', async () => {
    const redactedPdf = buildMinimalPdf(['How do I update login when OTP: 123456 fails?']);
    const sensitivePdf = buildMinimalPdf([
      'Please verify card number 4111 1111 1111 1111 for my invoice?',
    ]);

    const extractor = {
      extractPdf: extractPdfText,
      extractImageOcr: createPrivateOcrExtractor(),
      transcribeAudio: createPrivateSttExtractor(),
    };

    const processorOk = new PrivateMediaProcessor({
      fetcher: {
        download: vi.fn().mockResolvedValue({
          status: 'downloaded',
          bytes: redactedPdf,
          mimeType: 'application/pdf',
        }),
      },
      extractor,
      inspectSensitiveText,
    });
    const okResult = await processorOk.process({
      attachments: [attachmentFixture()],
      channel: 'whatsapp',
      evaluatedAt: new Date('2026-10-01T00:00:00.000Z'),
      language: 'en',
      messageText: '',
    });
    expect(okResult.kind).toBe('extracted');
    if (okResult.kind === 'extracted') {
      expect(okResult.combinedText).toContain('[REDACTED_OTP]');
      expect(okResult.combinedText).not.toContain('123456');
      expect(okResult.attachmentOutcomes[0]?.extractedText).not.toContain('123456');
    }

    const processorBlocked = new PrivateMediaProcessor({
      fetcher: {
        download: vi.fn().mockResolvedValue({
          status: 'downloaded',
          bytes: sensitivePdf,
          mimeType: 'application/pdf',
        }),
      },
      extractor,
      inspectSensitiveText,
    });
    const blockedResult = await processorBlocked.process({
      attachments: [attachmentFixture()],
      channel: 'whatsapp',
      evaluatedAt: new Date('2026-10-01T00:00:00.000Z'),
      language: 'en',
      messageText: '',
    });
    expect(blockedResult).toEqual({
      kind: 'escalate',
      effectiveLanguage: 'en',
      escalationReasonCode: 'sensitive_data_blocked',
      safeResponseReason: 'sensitive_data_blocked',
      attachmentOutcomes: [
        {
          attachmentId: '101',
          extractionStatus: 'sensitive_blocked',
          extractedText: null,
          extractionMethod: 'pdf_text',
          detectedLanguage: 'en',
          reasonCode: 'sensitive_data_detected',
        },
      ],
    });
  });
});
