import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { z } from 'zod';

import { isDisallowedIpAddress } from '../knowledge/website-import.js';
import type { MetaChannel } from '../meta/normalized-event.js';
import type { ManifestFetch } from '../model/manifest-client.js';
import { readBoundedResponseBytes, readBoundedResponseText } from './bounded-response.js';
import type {
  ClaimedWebhookAttachment,
  MediaDownloadResult,
  MediaFetchPort,
} from './media-types.js';

const DEFAULT_GRAPH_BASE_URL = 'https://graph.facebook.com/v22.0';
const DEFAULT_MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_METADATA_BYTES = 64 * 1024;

const graphMetadataSchema = z.object({
  file_size: z.number().int().positive().optional(),
  mime_type: z.string().min(1).optional(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/iu)
    .optional(),
  url: z.url(),
});

export interface MetaMediaFetcherOptions {
  readonly fetch?: ManifestFetch;
  readonly graphBaseUrl?: string;
  readonly lookupHost?: (hostname: string) => Promise<readonly { readonly address: string }[]>;
  readonly maximumBytes?: number;
  readonly pageAccessToken?: string;
  readonly timeoutMs?: number;
  readonly whatsappAccessToken?: string;
}

function cleanHostname(rawHost: string): string {
  const lower = rawHost.trim().toLowerCase();
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

function isMetaOwnedHost(hostname: string): boolean {
  const clean = cleanHostname(hostname);
  return (
    clean === 'graph.facebook.com' ||
    clean === 'graph.instagram.com' ||
    clean.endsWith('.facebook.com') ||
    clean.endsWith('.fbsbx.com') ||
    clean.endsWith('.fbcdn.net') ||
    clean.endsWith('.whatsapp.net')
  );
}

async function validateDownloadUrl(
  rawUrl: string,
  usingInjectedTransport: boolean,
  lookupHost: (hostname: string) => Promise<readonly { readonly address: string }[]>,
): Promise<URL> {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0 || trimmed.length > 4096 || /\s/u.test(trimmed)) {
    throw new Error('media_url_invalid');
  }
  const parsed = new URL(trimmed);
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('media_url_invalid');
  }
  if (usingInjectedTransport) {
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('media_url_invalid');
    }
    return parsed;
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('media_url_invalid');
  }
  const host = cleanHostname(parsed.hostname);
  if (isIP(host) !== 0) {
    if (isDisallowedIpAddress(host)) throw new Error('media_url_rejected');
    return parsed;
  }
  const resolved = await lookupHost(host);
  if (resolved.length === 0 || resolved.some((entry) => isDisallowedIpAddress(entry.address))) {
    throw new Error('media_url_rejected');
  }
  return parsed;
}

function resolveGraphBaseUrl(rawUrl: string | undefined, usingInjectedTransport: boolean): string {
  const value = (rawUrl ?? DEFAULT_GRAPH_BASE_URL).trim().replace(/\/+$/u, '');
  const parsed = new URL(value);
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('media_graph_url_invalid');
  }
  if (!usingInjectedTransport && parsed.protocol !== 'https:') {
    throw new Error('media_graph_url_invalid');
  }
  if (usingInjectedTransport && parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('media_graph_url_invalid');
  }
  return parsed.toString().replace(/\/+$/u, '');
}

export class MetaMediaFetcher implements MediaFetchPort {
  private readonly fetchFn: ManifestFetch;
  private readonly usingInjectedTransport: boolean;
  private readonly lookupHost: (
    hostname: string,
  ) => Promise<readonly { readonly address: string }[]>;
  private readonly maximumBytes: number;
  private readonly timeoutMs: number;
  private readonly graphBaseUrl: string;
  private readonly whatsappAccessToken?: string;
  private readonly pageAccessToken?: string;

  public constructor(options: MetaMediaFetcherOptions = {}) {
    this.usingInjectedTransport = options.fetch !== undefined;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.lookupHost = options.lookupHost ?? ((hostname) => lookup(hostname, { all: true }));
    this.maximumBytes = options.maximumBytes ?? DEFAULT_MAX_MEDIA_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.graphBaseUrl = resolveGraphBaseUrl(options.graphBaseUrl, this.usingInjectedTransport);
    if (options.whatsappAccessToken !== undefined) {
      this.whatsappAccessToken = options.whatsappAccessToken;
    }
    if (options.pageAccessToken !== undefined) {
      this.pageAccessToken = options.pageAccessToken;
    }
  }

  public async download(
    attachment: ClaimedWebhookAttachment,
    channel: MetaChannel,
  ): Promise<MediaDownloadResult> {
    if (channel === 'whatsapp') {
      return this.downloadWhatsAppMedia(attachment);
    }
    return this.downloadMessengerMedia(attachment);
  }

  private async downloadWhatsAppMedia(
    attachment: ClaimedWebhookAttachment,
  ): Promise<MediaDownloadResult> {
    if (attachment.mediaId === null || attachment.mediaId.trim() === '') {
      return { status: 'failed', reasonCode: 'missing_media_id' };
    }
    if (this.whatsappAccessToken === undefined || this.whatsappAccessToken.trim() === '') {
      return { status: 'failed', reasonCode: 'whatsapp_media_token_missing' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const metadataUrl = await validateDownloadUrl(
        `${this.graphBaseUrl}/${encodeURIComponent(attachment.mediaId)}`,
        this.usingInjectedTransport,
        this.lookupHost,
      );
      const metadataResponse = await this.fetchFn(metadataUrl.toString(), {
        method: 'GET',
        headers: { authorization: `Bearer ${this.whatsappAccessToken}` },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!metadataResponse.ok) {
        return {
          status: 'failed',
          reasonCode: `whatsapp_metadata_http_${String(metadataResponse.status)}`,
        };
      }
      const metadataBody = await readBoundedResponseText(
        metadataResponse,
        MAX_METADATA_BYTES,
        () => {
          controller.abort();
        },
      );
      if (metadataBody === undefined) {
        return { status: 'failed', reasonCode: 'whatsapp_metadata_oversized' };
      }
      const metadataParsed = graphMetadataSchema.safeParse(JSON.parse(metadataBody) as unknown);
      if (!metadataParsed.success) {
        return { status: 'failed', reasonCode: 'whatsapp_metadata_invalid' };
      }
      const meta = metadataParsed.data;
      if (meta.file_size !== undefined && meta.file_size > this.maximumBytes) {
        return { status: 'failed', reasonCode: 'media_exceeds_max_bytes' };
      }

      const binaryUrl = await validateDownloadUrl(
        meta.url,
        this.usingInjectedTransport,
        this.lookupHost,
      );
      const binaryResponse = await this.fetchFn(binaryUrl.toString(), {
        method: 'GET',
        headers:
          this.usingInjectedTransport || isMetaOwnedHost(binaryUrl.hostname)
            ? { authorization: `Bearer ${this.whatsappAccessToken}` }
            : {},
        redirect: 'error',
        signal: controller.signal,
      });
      if (!binaryResponse.ok) {
        return {
          status: 'failed',
          reasonCode: `whatsapp_media_http_${String(binaryResponse.status)}`,
        };
      }
      const bytes = await readBoundedResponseBytes(binaryResponse, this.maximumBytes, () => {
        controller.abort();
      });
      if (bytes === undefined) {
        return { status: 'failed', reasonCode: 'media_exceeds_max_bytes' };
      }
      const expectedSha256 = attachment.sha256 ?? meta.sha256;
      if (expectedSha256 !== undefined) {
        const actualSha256 = createHash('sha256').update(bytes).digest('hex');
        if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
          return { status: 'failed', reasonCode: 'media_sha256_mismatch' };
        }
      }
      const mimeType =
        meta.mime_type ??
        attachment.mimeType ??
        binaryResponse.headers.get('content-type')?.split(';')[0]?.trim();
      return {
        status: 'downloaded',
        bytes,
        ...(mimeType === undefined ? {} : { mimeType }),
      };
    } catch {
      return { status: 'failed', reasonCode: 'whatsapp_media_download_failed' };
    } finally {
      clearTimeout(timer);
    }
  }

  private async downloadMessengerMedia(
    attachment: ClaimedWebhookAttachment,
  ): Promise<MediaDownloadResult> {
    if (attachment.mediaUrl === null || attachment.mediaUrl.trim() === '') {
      return { status: 'failed', reasonCode: 'missing_media_url' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const targetUrl = await validateDownloadUrl(
        attachment.mediaUrl,
        this.usingInjectedTransport,
        this.lookupHost,
      );
      const headers: Record<string, string> = {};
      if (
        this.pageAccessToken !== undefined &&
        this.pageAccessToken !== '' &&
        isMetaOwnedHost(targetUrl.hostname) &&
        targetUrl.hostname === 'graph.facebook.com'
      ) {
        headers.authorization = `Bearer ${this.pageAccessToken}`;
      }
      const response = await this.fetchFn(targetUrl.toString(), {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          status: 'failed',
          reasonCode: `messenger_media_http_${String(response.status)}`,
        };
      }
      const bytes = await readBoundedResponseBytes(response, this.maximumBytes, () => {
        controller.abort();
      });
      if (bytes === undefined) {
        return { status: 'failed', reasonCode: 'media_exceeds_max_bytes' };
      }
      const mimeType =
        attachment.mimeType ?? response.headers.get('content-type')?.split(';')[0]?.trim();
      return {
        status: 'downloaded',
        bytes,
        ...(mimeType === undefined ? {} : { mimeType }),
      };
    } catch {
      return { status: 'failed', reasonCode: 'messenger_media_download_failed' };
    } finally {
      clearTimeout(timer);
    }
  }
}
