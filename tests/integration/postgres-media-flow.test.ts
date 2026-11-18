import { createHash } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { noopSafeLogger } from '../../src/logging.js';
import { normalizeWhatsAppWebhook } from '../../src/meta/normalize-whatsapp.js';
import { createReplyRuntime } from '../../src/operations/reply-runtime.js';
import { eraseLockedIdentities } from '../../src/persistence/postgres-deletion-erasure.js';
import { PostgresKnowledgePublication } from '../../src/persistence/postgres-knowledge-publication.js';
import { PostgresKnowledgeRepository } from '../../src/persistence/postgres-knowledge-repository.js';
import { PostgresModelPolicy } from '../../src/persistence/postgres-model-policy.js';
import { PostgresOutboundPolicy } from '../../src/persistence/postgres-outbound-policy.js';
import { PostgresReceiptStore } from '../../src/persistence/postgres-receipt-store.js';
import { safeResponse } from '../../src/safety/safe-responses.js';
import {
  startFakeManifestServer,
  type FakeManifestServer,
} from '../helpers/fake-manifest-server.js';
import { operationsEnvironment } from '../helpers/operations-fixtures.js';
import { syntheticPrivacyKeyring } from './policy-fixtures.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './test-database.js';

let db: IsolatedTestDatabase;
let fakeManifest: FakeManifestServer;
const owner = { reviewerRef: 'ADMIN_TEST_media', roles: ['administrator'] } as const;
const editor = { reviewerRef: 'EDITOR_TEST_media', roles: ['knowledge_editor'] } as const;
const reviewer = { reviewerRef: 'REVIEWER_TEST_media', roles: ['knowledge_reviewer'] } as const;
const baseAt = new Date('2030-06-01T00:00:00.000Z');
const webhookAt = new Date('2030-06-01T00:01:00.000Z');
const replyAt = new Date('2030-06-01T00:02:00.000Z');

const bounds = {
  global1Minute: 120,
  globalUtcDay: 900,
  leaseMs: 25000,
  maximumDefiniteRetries: 2,
  messengerAccount1Minute: 80,
  perContact15Minute: 10,
  perContact24Hour: 50,
  providerTimeoutMs: 8000,
  retryBaseMs: 5000,
  retryMaximumMs: 30000,
  whatsappAccount1Minute: 90,
  workerBatchSize: 10,
};

function buildMinimalPdf(lines: readonly string[]): Uint8Array {
  const escaped = lines.map((line) =>
    line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)'),
  );
  const streamOps = escaped
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

async function seedAuthority(): Promise<void> {
  await db.pool.query(
    `insert into operations_deployments (git_revision,schema_revision,recorded_at,status)
     values ($1,'000019',$2,'started')`,
    ['c'.repeat(40), baseAt],
  );
  const account = await db.pool.query<{ readonly id: string }>(
    `insert into admin_accounts
     (account_ref,login_name,password_algorithm,password_cost,password_block_size,password_parallelization,password_key_length,password_salt,password_hash,state,created_at,updated_at,password_changed_at)
     values ($1,'synthetic.media','scrypt_v1',16384,8,1,32,$2,$3,'active',$4,$4,$4) returning id`,
    [owner.reviewerRef, Buffer.alloc(16, 0x31), Buffer.alloc(32, 0x32), baseAt],
  );
  await db.pool.query(
    `insert into admin_role_assignments (account_id,role,action,actor_account_id,effective_at,request_key)
     values ($1,'administrator','assign',$1,$2,'REQUEST_TEST_media_role')`,
    [account.rows[0]?.id, baseAt],
  );

  const outbound = new PostgresOutboundPolicy(db.pool);
  await outbound.createVersion(
    {
      createdAt: baseAt,
      createdByAccountRef: owner.reviewerRef,
      policyRef: 'POLICY_TEST_media_outbound',
      requestKey: 'REQUEST_TEST_media_outbound',
      values: bounds,
    },
    owner,
  );
  for (const action of ['submitVersion', 'approveVersion', 'activateVersion'] as const) {
    await outbound[action](
      {
        effectiveAt: baseAt,
        policyRef: 'POLICY_TEST_media_outbound',
        reasonCode: 'reviewed_outbound_policy',
        requestKey: `REQUEST_TEST_media_${action}`,
        reviewerAccountRef: owner.reviewerRef,
      },
      owner,
    );
  }

  const policy = new PostgresModelPolicy(db.pool);
  await policy.createPolicy(
    {
      createdAt: baseAt,
      createdByAccountRef: owner.reviewerRef,
      policyRef: 'POLICY_TEST_media_model',
      requestKey: 'REQUEST_TEST_media_model',
      values: {
        concurrentCalls: 2,
        cooldownMs: 0,
        globalUtcDayCalls: 20,
        outputTokens: 77,
        perContact15MinuteCalls: 5,
        perContact24HourCalls: 20,
        queueCapacity: 2,
        totalTimeoutMs: 2000,
        approvedProviderAttempts: 1,
        architectureProviderCeiling: 1,
        faqAmbiguityMargin: 0.05,
        faqMinimumSimilarity: 0.7,
        maximumFaqCandidates: 4,
      },
    },
    owner,
  );
  for (const action of ['submit', 'approve', 'activate'] as const) {
    await policy.transitionPolicy(
      {
        action,
        effectiveAt: baseAt,
        policyRef: 'POLICY_TEST_media_model',
        reasonCode: `${action}_reviewed`,
        requestKey: `REQUEST_TEST_media_model_${action}`,
        reviewerAccountRef: owner.reviewerRef,
      },
      owner,
    );
  }

  const repo = new PostgresKnowledgeRepository(db.pool);
  const pub = new PostgresKnowledgePublication(db.pool);
  await repo.createSource(
    {
      createdAt: baseAt,
      createdByReference: editor.reviewerRef,
      label: 'Synthetic media catalog',
      sourceRef: 'SOURCE_TEST_media',
      sourceType: 'manual_business',
    },
    editor,
  );

  await repo.createProposal(
    {
      aliases: [],
      answers: {
        en: 'Synthetic support hours are Sunday to Thursday.',
        bn: 'আমাদের সাপোর্ট রবিবার থেকে বৃহস্পতিবার খোলা থাকে।',
      },
      authorReference: editor.reviewerRef,
      contentSha256: '1'.repeat(64),
      createdAt: baseAt,
      itemKey: 'synthetic.media.hours',
      kind: 'faq',
      questions: {
        en: 'What are your synthetic support hours?',
        bn: 'আপনার সাপোর্ট সময় কী?',
      },
      requestKey: 'REQ_media_faq_create',
      sourceRef: 'SOURCE_TEST_media',
      sourceSha256: '2'.repeat(64),
      tags: ['hours'],
      versionRef: 'VERSION_TEST_media_faq',
    },
    editor,
  );
  await publicationLifecycle(
    pub,
    'VERSION_TEST_media_faq',
    'synthetic.media.hours',
    'faq_verified',
  );

  await repo.createProposal(
    {
      aliases: [],
      answers: {
        en: 'Contact billing verification to reset login access.',
        bn: 'লগইন পুনরুদ্ধারের জন্য বিলিং যাচাইকরণের সাথে যোগাযোগ করুন।',
      },
      authorReference: editor.reviewerRef,
      contentSha256: '3'.repeat(64),
      createdAt: baseAt,
      itemKey: 'synthetic.media.recovery',
      kind: 'business_fact',
      requestKey: 'REQ_media_fact_create',
      sourceRef: 'SOURCE_TEST_media',
      sourceSha256: '4'.repeat(64),
      tags: ['recovery'],
      versionRef: 'VERSION_TEST_media_fact',
    },
    editor,
  );
  await publicationLifecycle(
    pub,
    'VERSION_TEST_media_fact',
    'synthetic.media.recovery',
    'business_fact_verified',
  );
}

async function publicationLifecycle(
  pub: PostgresKnowledgePublication,
  versionRef: string,
  itemKey: string,
  reasonCode: string,
): Promise<void> {
  await pub.submitVersion(
    {
      action: 'submit',
      effectiveAt: baseAt,
      reasonCode: 'ready_for_review',
      requestKey: `REQ_${versionRef}_submit`,
      reviewerReference: editor.reviewerRef,
      versionRef,
    },
    editor,
  );
  await pub.reviewVersion(
    {
      action: 'approve',
      effectiveAt: baseAt,
      reasonCode,
      requestKey: `REQ_${versionRef}_approve`,
      reviewerReference: reviewer.reviewerRef,
      versionRef,
    },
    reviewer,
  );
  await pub.publishVersion(
    {
      action: 'publish',
      effectiveAt: baseAt,
      itemKey,
      reasonCode: 'initial_publication',
      requestKey: `REQ_${versionRef}_publish`,
      reviewerReference: reviewer.reviewerRef,
      versionRef,
    },
    reviewer,
  );
}

beforeAll(async () => {
  db = await createIsolatedTestDatabase('media_flow');
  fakeManifest = await startFakeManifestServer();
});

afterAll(async () => {
  await fakeManifest.close();
  await db.dispose();
});

beforeEach(async () => {
  await db.pool.query(
    'truncate contacts,webhook_receipts,knowledge_sources,knowledge_items,model_policy_versions,outbound_policy_versions,admin_accounts,privacy_suppressions,operations_deployments restart identity cascade',
  );
  fakeManifest.reset();
  await seedAuthority();
});

async function runReplyOnce(options: {
  readonly expectedDraftCount: number;
  readonly modelEnabled: boolean;
  readonly mediaFiles?: Readonly<
    Record<string, { readonly bytes: Uint8Array; readonly mimeType: string }>
  >;
  readonly ocrResponse?: Readonly<Record<string, unknown>>;
  readonly sttResponse?: Readonly<Record<string, unknown>>;
}) {
  const mediaFiles = options.mediaFiles ?? {};
  const runtime = await createReplyRuntime({
    role: 'reply',
    logger: noopSafeLogger,
    now: () => replyAt,
    environment: {
      ...operationsEnvironment(),
      MODEL_EXECUTION_ENABLED: options.modelEnabled ? 'true' : 'false',
      ...(options.modelEnabled
        ? {
            MANIFEST_BASE_URL: fakeManifest.baseUrl,
            MANIFEST_API_KEY: 'SYNTHETIC_MANIFEST_KEY_NOT_OPERATIONAL',
            MANIFEST_MODEL: 'auto',
            MANIFEST_RECORDING_DISABLED: 'true',
            MANIFEST_DELETION_RETENTION_APPROVED: 'true',
            MANIFEST_PROVIDER_ALLOWLIST_APPROVED: 'true',
            MANIFEST_LIMITS_WITHIN_DEPLOYMENT_CEILINGS: 'true',
            MANIFEST_PRIVATE_ROUTE_VERIFIED: 'true',
            MODEL_MAX_CALLS_PER_CONTACT_15_MINUTES: '5',
            MODEL_MAX_CALLS_PER_CONTACT_24_HOURS: '20',
            MODEL_MAX_CALLS_PER_UTC_DAY: '20',
            MODEL_MAX_CONCURRENT_CALLS: '2',
            MODEL_MAX_QUEUE_DEPTH: '2',
            MODEL_TOTAL_TIMEOUT_MS: '2000',
            MODEL_MAX_OUTPUT_TOKENS: '77',
            MODEL_COOLDOWN_MS: '0',
            MODEL_APPROVED_PROVIDER_ATTEMPTS: '1',
            MODEL_ARCHITECTURE_PROVIDER_CEILING: '1',
            MODEL_MAX_RESPONSE_BYTES: '4096',
            MODEL_MAX_CONTEXT_ITEMS: '4',
            MODEL_MAX_INPUT_CODE_POINTS: '2000',
            REPLY_MANIFEST_ATTESTATION_JSON: JSON.stringify({
              verified: true,
              operationalLimits: {
                concurrentCalls: 2,
                cooldownMs: 0,
                globalUtcDayCalls: 20,
                outputTokens: 77,
                perContact15MinuteCalls: 5,
                perContact24HourCalls: 20,
                providerAttempts: 1,
                queueCapacity: 2,
                totalTimeoutMs: 2000,
              },
            }),
          }
        : {}),
      DATABASE_URL: db.connectionString,
      PRIVACY_HMAC_KEYRING: JSON.stringify({
        activeVersion: 'TEST_v1',
        keys: [{ version: 'TEST_v1', keyBase64url: Buffer.alloc(32, 0x51).toString('base64url') }],
      }),
      OPS_GIT_REVISION: 'c'.repeat(40),
      OPS_SCHEMA_REVISION: '000019',
      META_WHATSAPP_ACCESS_TOKEN: 'SYNTHETIC_WA_MEDIA_TOKEN',
      META_GRAPH_API_BASE_URL: 'https://graph.facebook.com/v22.0',
      PRIVATE_MEDIA_OCR_URL: 'http://ocr.internal/extract',
      PRIVATE_MEDIA_STT_URL: 'http://stt.internal/transcribe',
      REPLY_FAQ_POLICY_JSON: JSON.stringify({
        ambiguityMargin: 0.05,
        minimumSimilarity: 0.7,
        maximumCandidates: 4,
      }),
      REPLY_OUTBOUND_BOUNDS_JSON: JSON.stringify(bounds),
    },
    poolFactory: (cfg) => new pg.Pool(cfg),
    testTransports: {
      meta: (url) => {
        const downloadId = Object.keys(mediaFiles).find((id) =>
          url.startsWith(`https://lookaside.fbsbx.com/download/${id}`),
        );
        if (downloadId !== undefined) {
          const item = mediaFiles[downloadId];
          if (item === undefined) {
            return Promise.resolve(new Response('not found', { status: 404 }));
          }
          return Promise.resolve(
            new Response(Buffer.from(item.bytes), {
              status: 200,
              headers: { 'content-type': item.mimeType },
            }),
          );
        }
        const mediaId = Object.keys(mediaFiles).find((id) => url.endsWith(`/${id}`));
        if (mediaId !== undefined) {
          const item = mediaFiles[mediaId];
          if (item === undefined) {
            return Promise.resolve(new Response('not found', { status: 404 }));
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({
                url: `https://lookaside.fbsbx.com/download/${mediaId}`,
                mime_type: item.mimeType,
                file_size: item.bytes.byteLength,
                sha256: createHash('sha256').update(item.bytes).digest('hex'),
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response('not found', { status: 404 }));
      },
      ocr: () =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              options.ocrResponse ?? {
                status: 'visual_only',
                hasVisualContent: true,
              },
            ),
            { status: 200 },
          ),
        ),
      stt: () =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              options.sttResponse ?? {
                status: 'unclear',
                reasonCode: 'audio_inaudible',
              },
            ),
            { status: 200 },
          ),
        ),
    },
  });

  try {
    await runtime.start();
    for (let attempt = 0; attempt < 100; attempt++) {
      const done = await db.pool.query<{ readonly count: number }>(
        `select count(*)::int as count from support_reply_drafts`,
      );
      const intents = await db.pool.query<{ readonly count: number }>(
        `select count(*)::int as count from outbound_intents`,
      );
      if (
        (done.rows[0]?.count ?? 0) >= options.expectedDraftCount &&
        (intents.rows[0]?.count ?? 0) >= options.expectedDraftCount
      ) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    await runtime.stop();
  }
}

async function ingestWhatsAppMessage(message: Record<string, unknown>): Promise<void> {
  const receiptStore = new PostgresReceiptStore(db.pool, syntheticPrivacyKeyring);
  const events = normalizeWhatsAppWebhook({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_TEST',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'PHONE_MEDIA' },
              messages: [message],
            },
          },
        ],
      },
    ],
  });
  const payloadHash = createHash('sha256').update(JSON.stringify(message)).digest('hex');
  await receiptStore.store({ payloadSha256: payloadHash, receivedAt: webhookAt, events });
}

describe('Track 2C PostgreSQL media extraction & privacy integration', () => {
  test('extracts real PDF via unpdf, redacts single secret before Manifest inference, and deletes attachments cleanly', async () => {
    const rawSecret = '987654';
    const pdfBytes = buildMinimalPdf([`How do I unlock my login with OTP: ${rawSecret}?`]);

    fakeManifest.enqueueResponse({
      statusCode: 200,
      body: JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                answer: 'Contact billing verification to reset login access.',
                decision: 'answer',
                knowledgeReferences: ['VERSION_TEST_media_fact'],
                language: 'en',
                needsHumanReview: false,
                reasonCode: 'published_knowledge_answer',
              }),
            },
          },
        ],
      }),
    });

    await ingestWhatsAppMessage({
      from: '15550009001',
      id: 'wamid.MEDIA_PDF_OTP',
      timestamp: String(Math.floor(webhookAt.getTime() / 1000)),
      type: 'document',
      document: {
        id: 'MEDIA_PDF_OTP',
        filename: 'unlock-otp.pdf',
        mime_type: 'application/pdf',
        sha256: createHash('sha256').update(pdfBytes).digest('hex'),
      },
    });

    await runReplyOnce({
      expectedDraftCount: 1,
      modelEnabled: true,
      mediaFiles: { MEDIA_PDF_OTP: { bytes: pdfBytes, mimeType: 'application/pdf' } },
    });

    const attachments = await db.pool.query<{
      readonly extraction_status: string;
      readonly extracted_text: string | null;
      readonly extraction_method: string | null;
    }>(
      `select extraction_status, extracted_text, extraction_method from webhook_event_attachments`,
    );
    expect(attachments.rows).toEqual([
      {
        extraction_status: 'extracted',
        extracted_text: 'How do I unlock my login with [REDACTED_OTP]?',
        extraction_method: 'pdf_text',
      },
    ]);
    expect(attachments.rows[0]?.extracted_text).not.toContain(rawSecret);

    const draftDebug = await db.pool.query(
      `select d.decision_type, d.answer_text, e.reason_code
       from support_reply_drafts d
       left join support_escalation_outcomes e on e.reply_draft_id = d.id`,
    );
    expect(draftDebug.rows).toEqual([
      {
        decision_type: 'model',
        answer_text: 'Contact billing verification to reset login access.',
        reason_code: null,
      },
    ]);
    expect(fakeManifest.requests.length).toBe(1);
    expect(fakeManifest.requests[0]?.redactionMarkerPresent).toBe(true);
    expect(fakeManifest.requests[0]?.sensitiveShapePresent).toBe(false);

    // Verify customer deletion erases webhook_event_attachments via deletion trigger.
    const client = await db.pool.connect();
    try {
      await client.query('begin');
      const identities = await client.query<{
        readonly id: string;
        readonly channel: 'messenger' | 'whatsapp';
        readonly channel_account_id: string;
        readonly external_contact_id: string;
      }>(`select id, channel, channel_account_id, external_contact_id from channel_identities`);
      await eraseLockedIdentities(client, syntheticPrivacyKeyring, identities.rows, replyAt);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const erasedRow = await db.pool.query<{
      readonly extraction_status: string;
      readonly media_id: string | null;
      readonly filename: string | null;
      readonly extracted_text: string | null;
    }>(
      `select extraction_status, media_id, filename, extracted_text from webhook_event_attachments`,
    );
    expect(erasedRow.rows).toEqual([
      {
        extraction_status: 'erased',
        media_id: null,
        filename: null,
        extracted_text: null,
      },
    ]);
  });

  test('routes visual-only image, Bangla STT FAQ, and sensitive card PDF without invoking model on deferred/blocked media', async () => {
    const visualImageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await ingestWhatsAppMessage({
      from: '15550009002',
      id: 'wamid.MEDIA_VISUAL_1',
      timestamp: String(Math.floor(webhookAt.getTime() / 1000)),
      type: 'image',
      image: {
        id: 'MEDIA_VISUAL_1',
        mime_type: 'image/png',
        sha256: createHash('sha256').update(visualImageBytes).digest('hex'),
      },
    });
    await runReplyOnce({
      expectedDraftCount: 1,
      modelEnabled: true,
      mediaFiles: { MEDIA_VISUAL_1: { bytes: visualImageBytes, mimeType: 'image/png' } },
      ocrResponse: { status: 'visual_only', hasVisualContent: true },
    });

    const escalations = await db.pool.query<{
      readonly reason_code: string;
      readonly decision_type: string;
      readonly answer_text: string;
    }>(
      `select e.reason_code, d.decision_type, d.answer_text
       from support_escalation_outcomes e
       join support_reply_drafts d on d.id = e.reply_draft_id`,
    );
    expect(escalations.rows).toEqual([
      {
        reason_code: 'visual_media_deferred',
        decision_type: 'safe_failure',
        answer_text: safeResponse('en', 'human_escalation'),
      },
    ]);
    const leases = await db.pool.query<{ readonly count: number }>(
      `select count(*)::int as count from model_call_leases`,
    );
    expect(leases.rows).toEqual([{ count: 0 }]);
    expect(fakeManifest.requests.length).toBe(0);

    // Bangla audio voice note matching published Bangla FAQ
    const audioBytes = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 1, 2]);
    await ingestWhatsAppMessage({
      from: '15550009003',
      id: 'wamid.MEDIA_BN_AUDIO',
      timestamp: String(Math.floor(webhookAt.getTime() / 1000) + 1),
      type: 'audio',
      audio: {
        id: 'MEDIA_BN_AUDIO',
        mime_type: 'audio/ogg',
        voice: true,
        sha256: createHash('sha256').update(audioBytes).digest('hex'),
      },
    });
    await runReplyOnce({
      expectedDraftCount: 2,
      modelEnabled: true,
      mediaFiles: { MEDIA_BN_AUDIO: { bytes: audioBytes, mimeType: 'audio/ogg' } },
      sttResponse: {
        status: 'extracted',
        text: 'আপনার সাপোর্ট সময় কী?',
        language: 'bn',
        confidence: 0.93,
      },
    });
    const bnFaqDraft = await db.pool.query<{
      readonly decision_type: string;
      readonly language: string;
      readonly answer_text: string;
    }>(
      `select decision_type, language, answer_text
       from support_reply_drafts
       where decision_type = 'faq'`,
    );
    expect(bnFaqDraft.rows).toEqual([
      {
        decision_type: 'faq',
        language: 'bn',
        answer_text: 'আমাদের সাপোর্ট রবিবার থেকে বৃহস্পতিবার খোলা থাকে।',
      },
    ]);

    // Sensitive card PDF -> blocked before model invocation and never stores raw extracted text
    const cardPdfBytes = buildMinimalPdf([
      'Can you verify card number 4111 1111 1111 1111 for payment?',
    ]);
    await ingestWhatsAppMessage({
      from: '15550009004',
      id: 'wamid.MEDIA_CARD_PDF',
      timestamp: String(Math.floor(webhookAt.getTime() / 1000) + 2),
      type: 'document',
      document: {
        id: 'MEDIA_CARD_PDF',
        filename: 'card.pdf',
        mime_type: 'application/pdf',
        sha256: createHash('sha256').update(cardPdfBytes).digest('hex'),
      },
    });
    await runReplyOnce({
      expectedDraftCount: 3,
      modelEnabled: true,
      mediaFiles: { MEDIA_CARD_PDF: { bytes: cardPdfBytes, mimeType: 'application/pdf' } },
    });

    const cardAttachment = await db.pool.query<{
      readonly extraction_status: string;
      readonly extracted_text: string | null;
    }>(
      `select extraction_status, extracted_text
       from webhook_event_attachments
       where media_id = 'MEDIA_CARD_PDF'`,
    );
    expect(cardAttachment.rows).toEqual([
      { extraction_status: 'sensitive_blocked', extracted_text: null },
    ]);

    const finalLeases = await db.pool.query<{ readonly count: number }>(
      `select count(*)::int as count from model_call_leases`,
    );
    expect(finalLeases.rows).toEqual([{ count: 0 }]);
    expect(fakeManifest.requests.length).toBe(0);
  });
});
