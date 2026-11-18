import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { buildApp } from '../../src/app.js';
import {
  runMetaWebhookProbe,
  signMetaWebhookPayload,
  type WebhookProbeResult,
} from '../../src/meta/webhook-probe.js';
import { runWebhookProbeCli } from '../../src/meta/webhook-probe-main.js';

const syntheticSecret = 'synthetic_meta_probe_app_secret_0123456789abcdef';
const syntheticVerifyToken = 'synthetic_meta_probe_verify_token_0123456789';

const servers: ReturnType<typeof createServer>[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

async function startTestAppServer() {
  const received: { kind: string; id: string }[] = [];
  const app = buildApp({
    metaAppSecret: syntheticSecret,
    metaVerifyToken: syntheticVerifyToken,
    now: () => new Date('2026-11-18T10:00:00.000Z'),
    receiptSink: (receipt) => {
      for (const event of receipt.events) {
        received.push({
          kind: event.kind,
          id: event.kind === 'unsupported' ? event.reasonCode : event.idempotencyKey,
        });
      }
      return Promise.resolve();
    },
  });
  await app.ready();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    app.server.emit('request', req, res);
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    received,
    close: async () => {
      await app.close();
    },
  };
}

describe('Meta signed synthetic webhook probe (Gap G-1)', () => {
  test('computes HMAC-SHA256 signature over exact raw UTF-8 payload bytes', () => {
    const raw = Buffer.from('{"object":"whatsapp_business_account","entry":[]}\n', 'utf8');
    const sig = signMetaWebhookPayload(raw, syntheticSecret);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/u);
    expect(sig).not.toBe(
      signMetaWebhookPayload(
        Buffer.from('{"object":"whatsapp_business_account","entry":[]} \n', 'utf8'),
        syntheticSecret,
      ),
    );
  });

  test('verifies GET challenge accept/reject, POST valid/invalid/unsigned/oversized, and closed routes without leaking secrets', async () => {
    const appServer = await startTestAppServer();
    try {
      const validGet: WebhookProbeResult = await runMetaWebhookProbe({
        mode: 'verify',
        baseUrl: appServer.baseUrl,
        verifyToken: syntheticVerifyToken,
        challenge: 'synthetic_challenge_abc123',
      });
      expect(validGet).toEqual({
        ok: true,
        mode: 'verify',
        targetOrigin: appServer.baseUrl,
        path: '/webhooks/meta',
        signatureMode: 'none',
        payloadBytes: 0,
        statusCode: 200,
        expectedStatus: 200,
      });

      const invalidGet = await runMetaWebhookProbe({
        mode: 'verify',
        baseUrl: appServer.baseUrl,
        invalidToken: true,
        challenge: 'synthetic_challenge_abc123',
      });
      expect(invalidGet.ok).toBe(true);
      expect(invalidGet.statusCode).toBe(403);
      expect(invalidGet.expectedStatus).toBe(403);

      const samplePayload = Buffer.from(
        JSON.stringify({
          object: 'page',
          entry: [
            {
              id: 'synthetic_page_1',
              time: 1795003190000,
              messaging: [
                {
                  sender: { id: 'synthetic_user_1' },
                  recipient: { id: 'synthetic_page_1' },
                  timestamp: 1795003190000,
                  message: { mid: 'synthetic_mid_probe_1', text: 'SYNTHETIC_SECRET_DO_NOT_LOG' },
                },
              ],
            },
          ],
        }),
        'utf8',
      );

      const validPost = await runMetaWebhookProbe({
        mode: 'post',
        baseUrl: appServer.baseUrl,
        appSecret: syntheticSecret,
        rawBody: samplePayload,
        signatureMode: 'valid',
      });
      expect(validPost).toEqual({
        ok: true,
        mode: 'post',
        targetOrigin: appServer.baseUrl,
        path: '/webhooks/meta',
        signatureMode: 'valid',
        payloadBytes: samplePayload.length,
        statusCode: 200,
        expectedStatus: 200,
      });
      expect(appServer.received).toHaveLength(1);

      const invalidPost = await runMetaWebhookProbe({
        mode: 'post',
        baseUrl: appServer.baseUrl,
        appSecret: syntheticSecret,
        rawBody: samplePayload,
        signatureMode: 'invalid',
      });
      expect(invalidPost.ok).toBe(true);
      expect(invalidPost.statusCode).toBe(401);

      const unsignedPost = await runMetaWebhookProbe({
        mode: 'post',
        baseUrl: appServer.baseUrl,
        rawBody: samplePayload,
        signatureMode: 'unsigned',
      });
      expect(unsignedPost.ok).toBe(true);
      expect(unsignedPost.statusCode).toBe(401);
      expect(appServer.received).toHaveLength(1);

      const oversizedPayload = Buffer.alloc(263 * 1024, 'a');
      await expect(
        runMetaWebhookProbe({
          mode: 'post',
          baseUrl: appServer.baseUrl,
          appSecret: syntheticSecret,
          rawBody: oversizedPayload,
          signatureMode: 'valid',
        }),
      ).rejects.toThrow('webhook_probe_payload_too_large');

      const allowedOversized = await runMetaWebhookProbe({
        mode: 'post',
        baseUrl: appServer.baseUrl,
        appSecret: syntheticSecret,
        rawBody: oversizedPayload,
        signatureMode: 'valid',
        allowOversized: true,
        expectedStatus: 413,
      });
      expect(allowedOversized.ok).toBe(true);
      expect(allowedOversized.statusCode).toBe(413);

      const closedHealth = await runMetaWebhookProbe({
        mode: 'closed-route',
        baseUrl: appServer.baseUrl,
        path: '/health',
      });
      expect(closedHealth).toEqual({
        ok: true,
        mode: 'closed-route',
        targetOrigin: appServer.baseUrl,
        path: '/health',
        signatureMode: 'none',
        payloadBytes: 0,
        statusCode: 404,
        expectedStatus: 404,
      });
    } finally {
      await appServer.close();
    }
  });

  test('CLI reads secret files without printing secrets or raw payload text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fcd-webhook-probe-cli-'));
    tempDirs.push(dir);
    const secretFile = join(dir, 'meta-app-secret');
    const verifyFile = join(dir, 'meta-verify-token');
    const payloadFile = join(dir, 'payload.json');
    await writeFile(secretFile, `${syntheticSecret}\n`, { mode: 0o600 });
    await writeFile(verifyFile, `${syntheticVerifyToken}\n`, { mode: 0o600 });
    await writeFile(
      payloadFile,
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'synthetic_waba_1',
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: 'synthetic_phone_1' },
                  messages: [
                    {
                      from: 'synthetic_sender_1',
                      id: 'synthetic_wamid_1',
                      timestamp: '1795003190',
                      type: 'text',
                      text: { body: 'SENSITIVE_SYNTHETIC_MESSAGE_BODY' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
      { mode: 0o600 },
    );

    const appServer = await startTestAppServer();
    try {
      const outputs: string[] = [];
      const errors: string[] = [];
      const exitCode = await runWebhookProbeCli({
        args: [
          '--base-url',
          appServer.baseUrl,
          '--mode',
          'post',
          '--payload-file',
          payloadFile,
          '--signature-mode',
          'valid',
        ],
        environment: {
          META_APP_SECRET_FILE: secretFile,
          META_VERIFY_TOKEN_FILE: verifyFile,
        },
        writeOut: (line) => outputs.push(line),
        writeErr: (line) => errors.push(line),
      });
      expect(exitCode).toBe(0);
      expect(errors).toEqual([]);
      expect(outputs).toHaveLength(1);
      const parsed = JSON.parse(outputs[0] ?? '') as WebhookProbeResult;
      expect(parsed.ok).toBe(true);
      expect(parsed.statusCode).toBe(200);
      const joined = outputs.join('\n');
      expect(joined).not.toContain(syntheticSecret);
      expect(joined).not.toContain(syntheticVerifyToken);
      expect(joined).not.toContain('SENSITIVE_SYNTHETIC_MESSAGE_BODY');
      expect(joined).not.toContain('sha256=');
    } finally {
      await appServer.close();
    }
  });
});
