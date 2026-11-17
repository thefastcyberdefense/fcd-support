import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ReadableStream } from 'node:stream/web';

import type { ManifestFetch } from '../model/manifest-client.js';

const MAXIMUM_HTML_BYTES = 512 * 1024;
const MAXIMUM_SNAPSHOT_CHARS = 11_900;
const WEBSITE_FETCH_TIMEOUT_MS = 10_000;

export interface WebsiteCandidate {
  readonly languageHint: 'bn' | 'en';
  readonly heading: string;
  readonly body: string;
}

export interface ExtractedWebsiteContent {
  readonly normalizedUrl: string;
  readonly title: string;
  readonly plainText: string;
  readonly sourceSha256: string;
  readonly contentSha256: string;
  readonly candidates: readonly WebsiteCandidate[];
}

export interface FetchWebsiteOptions {
  readonly fetch?: ManifestFetch;
  readonly lookupHost?: (hostname: string) => Promise<readonly { readonly address: string }[]>;
}

function isDisallowedIpv4(ip: string): boolean {
  const octets = ip.split('.').map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isDisallowedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('::ffff:')) {
    const embedded = lower.slice('::ffff:'.length);
    return isIP(embedded) === 4 ? isDisallowedIpv4(embedded) : true;
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb')
  ) {
    return true;
  }
  return false;
}

export function isDisallowedIpAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isDisallowedIpv4(ip);
  if (family === 6) return isDisallowedIpv6(ip);
  return true;
}

function cleanHostname(rawHost: string): string {
  const trimmed = rawHost.trim().toLowerCase();
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
}

export function normalizeWebsiteImportUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0 || trimmed.length > 2048 || /\s/u.test(trimmed)) {
    throw new Error('website_url_rejected');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('website_url_rejected');
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    throw new Error('website_url_rejected');
  }
  const host = cleanHostname(parsed.hostname);
  if (
    host === '' ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('website_url_rejected');
  }
  const family = isIP(host);
  if (family !== 0) {
    if (isDisallowedIpAddress(host)) {
      throw new Error('website_url_rejected');
    }
  } else if (!host.includes('.')) {
    throw new Error('website_url_rejected');
  }
  parsed.hash = '';
  return parsed.toString();
}

export function isAllowedWebsiteImportUrl(rawUrl: string): boolean {
  try {
    normalizeWebsiteImportUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function stripTags(htmlFragment: string): string {
  return decodeHtmlEntities(htmlFragment.replace(/<[^>]+>/gu, ' '))
    .replace(/\s+/gu, ' ')
    .trim();
}

function hasBengaliScript(text: string): boolean {
  return /[\u0980-\u09FF]/u.test(text);
}

export function extractWebsiteSnapshotCandidates(
  rawHtmlOrText: string,
  normalizedUrl: string,
): ExtractedWebsiteContent {
  const url = normalizeWebsiteImportUrl(normalizedUrl);
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(rawHtmlOrText);
  const title =
    titleMatch?.[1] !== undefined && stripTags(titleMatch[1]) !== ''
      ? stripTags(titleMatch[1]).slice(0, 200)
      : new URL(url).hostname;

  const cleaned = rawHtmlOrText
    .replace(/<script[\s\S]*?<\/script>/giu, '\n')
    .replace(/<style[\s\S]*?<\/style>/giu, '\n')
    .replace(/<noscript[\s\S]*?<\/noscript>/giu, '\n')
    .replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section|\/article|\/dt|\/dd)[^>]*>/giu, '\n');

  const lines = cleaned
    .split(/\r?\n/u)
    .map((line) => stripTags(line))
    .filter((line) => line.length >= 2);

  const uniqueLines: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    uniqueLines.push(line);
  }

  const plainText = uniqueLines.join('\n').slice(0, MAXIMUM_SNAPSHOT_CHARS).trim();
  if (plainText === '') {
    throw new Error('website_content_empty');
  }

  const candidates: WebsiteCandidate[] = [];
  let currentHeading = title;
  for (const line of uniqueLines) {
    if (line.length <= 100 && !line.endsWith('.')) {
      currentHeading = line;
      continue;
    }
    if (line.length >= 12) {
      candidates.push({
        languageHint: hasBengaliScript(line) || hasBengaliScript(currentHeading) ? 'bn' : 'en',
        heading: currentHeading.slice(0, 200),
        body: line.slice(0, 2000),
      });
    }
    if (candidates.length >= 20) break;
  }

  return {
    normalizedUrl: url,
    title,
    plainText,
    sourceSha256: createHash('sha256').update(rawHtmlOrText, 'utf8').digest('hex'),
    contentSha256: createHash('sha256').update(plainText, 'utf8').digest('hex'),
    candidates,
  };
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > MAXIMUM_HTML_BYTES) {
    throw new Error('website_response_too_large');
  }
  if (response.body === null) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAXIMUM_HTML_BYTES) {
      throw new Error('website_response_too_large');
    }
    return text;
  }
  const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let next = await reader.read();
  while (!next.done) {
    total += next.value.byteLength;
    if (total > MAXIMUM_HTML_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('website_response_too_large');
    }
    chunks.push(next.value);
    next = await reader.read();
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}

export async function fetchOfficialWebsiteSnapshot(
  rawUrl: string,
  options: FetchWebsiteOptions = {},
): Promise<ExtractedWebsiteContent> {
  const normalizedUrl = normalizeWebsiteImportUrl(rawUrl);
  const parsed = new URL(normalizedUrl);
  const hostname = cleanHostname(parsed.hostname);

  if (isIP(hostname) === 0 && options.fetch === undefined) {
    const resolveHost =
      options.lookupHost ??
      (async (target: string) => lookup(target, { all: true, verbatim: true }));
    let addresses: readonly { readonly address: string }[];
    try {
      addresses = await resolveHost(hostname);
    } catch {
      throw new Error('website_fetch_failed');
    }
    if (addresses.length === 0 || addresses.some((entry) => isDisallowedIpAddress(entry.address))) {
      throw new Error('website_url_rejected');
    }
  } else if (isIP(hostname) === 0 && options.lookupHost !== undefined) {
    const addresses = await options.lookupHost(hostname);
    if (addresses.length === 0 || addresses.some((entry) => isDisallowedIpAddress(entry.address))) {
      throw new Error('website_url_rejected');
    }
  }

  const fetchImpl = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(normalizedUrl, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(WEBSITE_FETCH_TIMEOUT_MS),
      headers: {
        accept: 'text/html, text/plain;q=0.9',
        'user-agent': 'fcd-support-knowledge-importer/1.0',
      },
    });
  } catch {
    throw new Error('website_fetch_failed');
  }

  if (!response.ok) {
    throw new Error('website_fetch_failed');
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (
    contentType !== '' &&
    !contentType.includes('text/html') &&
    !contentType.includes('text/plain') &&
    !contentType.includes('application/xhtml+xml')
  ) {
    throw new Error('website_fetch_failed');
  }

  const rawBody = await readBoundedResponseText(response);
  return extractWebsiteSnapshotCandidates(rawBody, normalizedUrl);
}
