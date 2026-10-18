import pg from 'pg';
import { describe, expect, test, vi } from 'vitest';

import { noopSafeLogger } from '../src/logging.js';
import { runReplyStage, type ReplyPipelinePorts } from '../src/operations/reply-pipeline.js';
import { createReplyRuntime } from '../src/operations/reply-runtime.js';
import type { ProcessingClaim } from '../src/persistence/postgres-processing-work.js';
import { operationsEnvironment } from './helpers/operations-fixtures.js';

const at = new Date('2030-03-01T00:00:00.000Z');
const claim = (stage: ProcessingClaim['stage']): ProcessingClaim => ({
  workRef: 'WORK_TEST_reply',
  webhookEventId: '17',
  leaseRef: 'LEASE_TEST_reply',
  stage,
});
function ports() {
  return {
    processor: {
      processEvent: vi
        .fn()
        .mockResolvedValue({ status: 'applied', outcome: 'customer_message_applied' }),
    },
    decision: {
      decide: vi.fn().mockResolvedValue({
        status: 'created',
        decisionType: 'faq',
        nextAction: 'none',
        draftRef: 'DRAFT_TEST_reply',
      }),
    },
    model: {
      decide: vi.fn().mockResolvedValue({
        status: 'created',
        decisionType: 'model',
        nextAction: 'none',
        draftRef: 'DRAFT_TEST_reply',
      }),
    },
    drafts: {
      persistModelDecision: vi.fn().mockResolvedValue({
        status: 'created',
        decisionType: 'safe_failure',
        nextAction: 'none',
        draftRef: 'DRAFT_TEST_reply',
      }),
    },
    intent: {
      createSupportIntent: vi
        .fn()
        .mockResolvedValue({ status: 'created', intentRef: 'INTENT_TEST_reply' }),
    },
    work: {
      advance: vi.fn().mockResolvedValue(undefined),
      finish: vi.fn().mockResolvedValue(undefined),
    },
    state: {
      loadLanguage: vi.fn().mockResolvedValue('bn'),
      applyIntake: vi.fn().mockResolvedValue('ordinary'),
      hasIntent: vi.fn().mockResolvedValue(false),
    },
    now: () => at,
  } satisfies ReplyPipelinePorts;
}

describe('recoverable reply stages', () => {
  test('pending echo correlation remains recoverable without a false completion', async () => {
    const dependencies = ports();
    dependencies.processor.processEvent.mockResolvedValue({
      status: 'correlation_pending',
      eventId: '17',
    });
    await expect(runReplyStage(claim('apply'), dependencies)).rejects.toThrow('reply_stage_retry');
    expect(dependencies.work.finish).not.toHaveBeenCalled();
  });
  test('applies a customer event without confusing event application with reply completion', async () => {
    const dependencies = ports();
    expect(await runReplyStage(claim('apply'), dependencies)).toBe('advanced');
    expect(dependencies.work.advance).toHaveBeenCalledWith({
      workRef: 'WORK_TEST_reply',
      leaseRef: 'LEASE_TEST_reply',
      stage: 'decide',
      evaluatedAt: at,
    });
  });
  test.each(['business_echo_applied', 'message_status_applied'])(
    'noncustomer outcome %s never reaches decisions',
    async (outcome) => {
      const dependencies = ports();
      dependencies.processor.processEvent.mockResolvedValue({ status: 'already_applied', outcome });
      expect(await runReplyStage(claim('apply'), dependencies)).toBe('completed');
      expect(dependencies.decision.decide).not.toHaveBeenCalled();
    },
  );
  test('routes privacy and opt-out intake before ordinary decisions, including restart after application', async () => {
    const dependencies = ports();
    dependencies.state.applyIntake.mockResolvedValue('handled');
    expect(await runReplyStage(claim('decide'), dependencies)).toBe('blocked');
    expect(dependencies.decision.decide).not.toHaveBeenCalled();
    expect(dependencies.model.decide).not.toHaveBeenCalled();
  });
  test('uses one stable event key and detected language for FAQ, model and enqueue replay', async () => {
    const dependencies = ports();
    await runReplyStage(claim('decide'), dependencies);
    await runReplyStage(claim('model'), dependencies);
    await runReplyStage(claim('enqueue'), dependencies);
    const first = dependencies.decision.decide.mock.calls[0]?.[0] as {
      requestKey: string;
      language: string;
    };
    expect(first.language).toBe('bn');
    expect(dependencies.model.decide).toHaveBeenCalledWith(
      expect.objectContaining({ requestKey: first.requestKey, language: 'bn' }),
    );
    expect(dependencies.intent.createSupportIntent).toHaveBeenCalledWith(
      expect.objectContaining({ draftRef: 'DRAFT_TEST_reply' }),
    );
  });
  test('disabled model persists deterministic safe escalation after an authoritative gap', async () => {
    const dependencies = ports();
    expect(await runReplyStage(claim('model'), { ...dependencies, model: undefined })).toBe(
      'advanced',
    );
    expect(dependencies.drafts.persistModelDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'safe_failure',
        escalationReasonCode: 'model_disabled',
        responseReason: 'provider_unavailable',
      }),
    );
    expect(dependencies.model.decide).not.toHaveBeenCalled();
  });
  test('existing intent repairs a crash without replaying a timestamp-sensitive creation command', async () => {
    const dependencies = ports();
    dependencies.state.hasIntent.mockResolvedValue(true);
    expect(await runReplyStage(claim('enqueue'), dependencies)).toBe('completed');
    expect(dependencies.intent.createSupportIntent).not.toHaveBeenCalled();
  });
  test('late policy denial blocks enqueue and uses a fresh transition clock', async () => {
    const dependencies = ports();
    const later = new Date(at.getTime() + 500);
    dependencies.intent.createSupportIntent.mockImplementation(() => {
      dependencies.now = () => later;
      return Promise.resolve({ status: 'denied', reason: 'pause_active' });
    });
    expect(await runReplyStage(claim('enqueue'), dependencies)).toBe('blocked');
    expect(dependencies.work.finish).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'blocked', evaluatedAt: later }),
    );
  });
  test('an aborted stage makes no domain call or new transition', async () => {
    const dependencies = ports();
    const controller = new AbortController();
    controller.abort();
    await expect(
      runReplyStage(claim('model'), { ...dependencies, signal: controller.signal }),
    ).rejects.toThrow('reply_stage_aborted');
    expect(dependencies.model.decide).not.toHaveBeenCalled();
    expect(dependencies.work.finish).not.toHaveBeenCalled();
  });
  test('an in-progress model call remains recoverable instead of being marked completed', async () => {
    const dependencies = ports();
    dependencies.model.decide.mockResolvedValue({ status: 'in_progress' });
    await expect(runReplyStage(claim('model'), dependencies)).rejects.toThrow('reply_stage_retry');
    expect(dependencies.work.finish).not.toHaveBeenCalled();
  });
});

function environment() {
  return {
    ...operationsEnvironment(),
    DATABASE_URL: 'postgresql://synthetic@127.0.0.1/fcd_support_test',
    PRIVACY_HMAC_KEYRING: JSON.stringify({
      activeVersion: 'TEST_v1',
      keys: [{ version: 'TEST_v1', keyBase64url: Buffer.alloc(32, 0x51).toString('base64url') }],
    }),
    OPS_GIT_REVISION: 'c'.repeat(40),
    OPS_SCHEMA_REVISION: '000014',
    REPLY_FAQ_POLICY_JSON: JSON.stringify({
      ambiguityMargin: 0.05,
      minimumSimilarity: 0.7,
      maximumCandidates: 4,
    }),
    REPLY_OUTBOUND_BOUNDS_JSON: JSON.stringify({
      global1Minute: 120,
      globalUtcDay: 900,
      leaseMs: 25000,
      maximumDefiniteRetries: 2,
      messengerAccount1Minute: 80,
      perContact15Minute: 3,
      perContact24Hour: 30,
      providerTimeoutMs: 8000,
      retryBaseMs: 5000,
      retryMaximumMs: 30000,
      whatsappAccount1Minute: 90,
      workerBatchSize: 10,
    }),
  };
}
describe('reply runtime composition', () => {
  test('pool shutdown is bounded and repeated stop shares the same cleanup', async () => {
    vi.useFakeTimers();
    try {
      const pool = new pg.Pool();
      const end = vi.fn(() => new Promise<void>(() => undefined));
      pool.end = end;
      const runtime = await createReplyRuntime({
        role: 'reply',
        environment: environment(),
        logger: noopSafeLogger,
        now: () => at,
        poolFactory: () => pool,
      });
      const stopped = runtime.stop();
      const rejected = expect(stopped).rejects.toThrow('runtime_shutdown_timeout');
      expect(runtime.stop()).toBe(stopped);
      await vi.advanceTimersByTimeAsync(30000);
      await rejected;
      expect(end).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  test('model-disabled composition needs no Manifest or Meta credential and closes its pool', async () => {
    const pool = new pg.Pool();
    const end = vi.spyOn(pool, 'end').mockResolvedValue(undefined);
    const factory = vi.fn(() => pool);
    const runtime = await createReplyRuntime({
      role: 'reply',
      environment: environment(),
      logger: noopSafeLogger,
      now: () => at,
      poolFactory: factory,
    });
    await runtime.stop();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });
  test('role mismatch and absent explicit settings fail before constructing a pool', async () => {
    const factory = vi.fn(() => new pg.Pool());
    await expect(
      createReplyRuntime({
        role: 'outbound',
        environment: environment(),
        logger: noopSafeLogger,
        now: () => at,
        poolFactory: factory,
      }),
    ).rejects.toThrow('reply_configuration_invalid');
    await expect(
      createReplyRuntime({
        role: 'reply',
        environment: { ...environment(), REPLY_FAQ_POLICY_JSON: '' },
        logger: noopSafeLogger,
        now: () => at,
        poolFactory: factory,
      }),
    ).rejects.toThrow('reply_configuration_invalid');
    expect(factory).not.toHaveBeenCalled();
  });
});
