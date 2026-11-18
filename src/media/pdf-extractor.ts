import type { KnowledgeLanguage } from '../knowledge/knowledge-types.js';
import type { MediaExtractionOutcome } from './media-types.js';

const DEFAULT_MAXIMUM_PDF_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAXIMUM_PDF_PAGES = 20;
const PDF_HEADER = '%PDF-';
const UNPDF_MODULE_ID = 'unpdf';

interface PdfProxyLike {
  readonly cleanup?: () => Promise<void>;
  readonly destroy?: () => Promise<void>;
  readonly numPages: number;
}

interface UnpdfTextRuntime {
  readonly extractText: (
    data: PdfProxyLike | Uint8Array,
    options: { readonly mergePages: true },
  ) => Promise<{ readonly text: string; readonly totalPages: number }>;
  readonly getDocumentProxy: (data: Uint8Array) => Promise<PdfProxyLike>;
}

let cachedRuntime: Promise<UnpdfTextRuntime> | undefined;

async function loadUnpdfRuntime(): Promise<UnpdfTextRuntime> {
  cachedRuntime ??= (import(UNPDF_MODULE_ID) as Promise<unknown>).then((loaded) => {
    if (typeof loaded !== 'object' || loaded === null) {
      throw new TypeError('unpdf runtime is invalid');
    }
    const record = loaded as {
      readonly extractText?: unknown;
      readonly getDocumentProxy?: unknown;
    };
    if (typeof record.extractText !== 'function' || typeof record.getDocumentProxy !== 'function') {
      throw new TypeError('unpdf runtime exports are missing');
    }
    return {
      extractText: record.extractText as UnpdfTextRuntime['extractText'],
      getDocumentProxy: record.getDocumentProxy as UnpdfTextRuntime['getDocumentProxy'],
    };
  });
  return cachedRuntime;
}

export interface PdfExtractorOptions {
  readonly maximumBytes?: number;
  readonly maximumPages?: number;
}

export function detectExtractedLanguage(
  text: string,
  fallback: KnowledgeLanguage = 'en',
): KnowledgeLanguage {
  return /[\u0980-\u09FF]/u.test(text) ? 'bn' : fallback;
}

export function hasPdfMagicHeader(bytes: Uint8Array): boolean {
  const probe = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return probe.includes(PDF_HEADER);
}

export async function extractPdfText(
  bytes: Uint8Array,
  options: PdfExtractorOptions = {},
): Promise<MediaExtractionOutcome> {
  const maxBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_PDF_BYTES;
  const maxPages = options.maximumPages ?? DEFAULT_MAXIMUM_PDF_PAGES;

  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    return { status: 'unclear', reasonCode: 'pdf_size_out_of_bounds' };
  }
  if (!hasPdfMagicHeader(bytes)) {
    return { status: 'unsupported', reasonCode: 'invalid_pdf_header' };
  }

  let documentProxy: PdfProxyLike | undefined;
  try {
    const runtime = await loadUnpdfRuntime();
    documentProxy = await runtime.getDocumentProxy(Uint8Array.from(bytes));
    if (documentProxy.numPages < 1 || documentProxy.numPages > maxPages) {
      return { status: 'unclear', reasonCode: 'pdf_page_count_out_of_bounds' };
    }
    const { text } = await runtime.extractText(documentProxy, { mergePages: true });
    const normalized = text.normalize('NFKC').replaceAll(/\s+/gu, ' ').trim();
    const meaningfulChars = normalized.match(/[\p{L}\p{N}]/gu) ?? [];
    if (meaningfulChars.length < 3) {
      return { status: 'unclear', reasonCode: 'empty_pdf_text' };
    }
    return {
      status: 'extracted',
      text: normalized,
      method: 'pdf_text',
      detectedLanguage: detectExtractedLanguage(normalized, 'en'),
    };
  } catch {
    return { status: 'unclear', reasonCode: 'invalid_pdf_document' };
  } finally {
    if (documentProxy?.destroy !== undefined) {
      await documentProxy.destroy().catch(() => undefined);
    } else if (documentProxy?.cleanup !== undefined) {
      await documentProxy.cleanup().catch(() => undefined);
    }
  }
}
