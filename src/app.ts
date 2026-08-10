import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import Fastify, { type FastifyInstance } from 'fastify';

import { noopSafeLogger, type SafeLogger } from './logging.js';
import { normalizeMetaWebhook } from './meta/normalize-webhook.js';
import { verifyMetaSignature } from './meta/verify-signature.js';
import { verifyMetaSubscription } from './meta/verify-subscription.js';
import type { WebhookReceiptSink } from './receipts/webhook-receipt.js';

const META_WEBHOOK_BODY_LIMIT_BYTES = 256 * 1024;
const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

export interface BuildAppOptions {
  readonly logger?: SafeLogger;
  readonly metaAppSecret: string;
  readonly metaVerifyToken: string;
  readonly now?: () => Date;
  readonly receiptSink: WebhookReceiptSink;
}

function readSignatureHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const now = options.now ?? (() => new Date());
  const safeLogger = options.logger ?? noopSafeLogger;
  const app = Fastify({
    bodyLimit: META_WEBHOOK_BODY_LIMIT_BYTES,
    exposeHeadRoutes: false,
    logger: false,
  });

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { bodyLimit: META_WEBHOOK_BODY_LIMIT_BYTES, parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.get('/webhooks/meta', async (request, reply) => {
    const query = request.query as Readonly<Record<string, unknown>>;
    const result = verifyMetaSubscription(query, options.metaVerifyToken);

    if (!result.ok) {
      safeLogger.warn('meta_verification_rejected', {
        reason: 'invalid_verification',
        requestId: request.id,
        statusCode: result.statusCode,
      });
      return reply.code(result.statusCode).type('text/plain').send('Forbidden');
    }

    safeLogger.info('meta_verification_accepted', {
      requestId: request.id,
      statusCode: 200,
    });
    return reply.code(200).type('text/plain').send(result.challenge);
  });

  app.post('/webhooks/meta', async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) {
      safeLogger.warn('meta_webhook_rejected', {
        reason: 'invalid_body',
        requestId: request.id,
        statusCode: 400,
      });
      return reply.code(400).type('text/plain').send('Invalid body');
    }

    const signatureHeader = readSignatureHeader(request.headers['x-hub-signature-256']);
    const signatureIsValid = verifyMetaSignature({
      appSecret: options.metaAppSecret,
      rawBody: request.body,
      signatureHeader,
    });

    if (!signatureIsValid) {
      safeLogger.warn('meta_webhook_rejected', {
        reason: 'invalid_signature',
        requestId: request.id,
        statusCode: 401,
      });
      return reply.code(401).type('text/plain').send('Invalid signature');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(strictUtf8Decoder.decode(request.body)) as unknown;
    } catch {
      safeLogger.warn('meta_webhook_rejected', {
        reason: 'invalid_json',
        requestId: request.id,
        statusCode: 400,
      });
      return reply.code(400).type('text/plain').send('Invalid JSON');
    }

    const events = normalizeMetaWebhook(payload);

    try {
      await options.receiptSink({
        events,
        payloadSha256: createHash('sha256').update(request.body).digest('hex'),
        receivedAt: now(),
      });
    } catch {
      safeLogger.error('meta_webhook_rejected', {
        reason: 'receipt_unavailable',
        requestId: request.id,
        statusCode: 503,
      });
      return reply.code(503).type('text/plain').send('Receipt unavailable');
    }

    safeLogger.info('meta_webhook_accepted', {
      eventCount: events.length,
      requestId: request.id,
      statusCode: 200,
    });
    return reply.code(200).type('text/plain').send('EVENT_RECEIVED');
  });

  return app;
}
