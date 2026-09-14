import { describe, expect, test, vi } from 'vitest';

import type { ManifestCompleteInput } from '../src/model/manifest-client.js';
import { ModelReplyService } from '../src/replies/model-reply-service.js';
import { safeResponse } from '../src/safety/safe-responses.js';

const evaluatedAt = new Date('2026-09-13T08:00:00.000Z');
const completedAt = new Date('2026-09-13T08:00:01.000Z');
const command = {
  evaluatedAt,
  language: 'en' as const,
  requestKey: 'REQUEST_TEST_model_reply',
  webhookEventId: '17',
};
const limits = {
  concurrentCalls: 2,
  cooldownMs: 0,
  globalUtcDayCalls: 10,
  outputTokens: 120,
  perContact15MinuteCalls: 2,
  perContact24HourCalls: 5,
  providerAttempts: 1,
  queueCapacity: 1,
  totalTimeoutMs: 1000,
};
const deployment = {
  ...limits,
  architectureProviderConnections: 1,
  contextItems: 3,
  inputCodePoints: 1000,
  responseBytes: 4096,
};
const published = {
  approvedUrls: [],
  fact: 'Synthetic reviewed support is available online.',
  reference: 'VERSION_TEST_model_reply',
};

function fixture() {
  const store = {
    claimModelDecision: vi.fn().mockResolvedValue({
      source: {
        conversationId: '5',
        messageText: 'Where is synthetic reviewed support available?',
        occurredAt: new Date('2026-09-13T07:59:00.000Z'),
        webhookEventId: '17',
      },
      status: 'claimed',
    }),
    loadPublishedKnowledge: vi.fn().mockResolvedValue([published]),
    persistModelDecision: vi.fn().mockImplementation((value: { kind: string }) =>
      Promise.resolve({
        decisionType: value.kind,
        draftRef: 'DRAFT_TEST_model_reply',
        nextAction: 'none',
        status: 'created',
      }),
    ),
  };
  const allowance = {
    acquireModelAllowance: vi.fn().mockResolvedValue({ status: 'acquired', leaseState: 'active' }),
    activateLease: vi.fn().mockResolvedValue({ status: 'activated' }),
    completeLease: vi.fn().mockResolvedValue({ status: 'applied' }),
  };
  const policy = {
    resolveEffectivePolicy: vi.fn().mockResolvedValue({
      faq: { ambiguityMargin: 0.05, maximumCandidates: 3, minimumSimilarity: 0.7 },
      limits,
      policyRef: 'POLICY_TEST_model_reply',
      policyVersionId: '8',
      status: 'enabled',
    }),
  };
  const manifest = {
    complete: vi.fn().mockResolvedValue({
      status: 'completed',
      value: {
        answer: published.fact,
        decision: 'answer',
        knowledgeReferences: [published.reference],
        language: 'en',
        needsHumanReview: false,
        reasonCode: 'published_knowledge_answer',
      },
    }),
  };
  const service = new ModelReplyService({
    allowance,
    deployment,
    manifest,
    manifestAttestation: { operationalLimits: limits, verified: true },
    now: () => completedAt,
    policy,
    store,
  });
  return { allowance, manifest, policy, service, store };
}

describe('model reply composition', () => {
  test('one allowance, one tool-free request, grounded model draft', async () => {
    const { allowance, manifest, service, store } = fixture();
    await expect(service.decide(command)).resolves.toMatchObject({
      decisionType: 'model',
      status: 'created',
    });
    expect(allowance.acquireModelAllowance).toHaveBeenCalledTimes(1);
    expect(manifest.complete).toHaveBeenCalledTimes(1);
    const calls = manifest.complete.mock.calls as unknown as readonly [ManifestCompleteInput][];
    const request = calls[0]?.[0].request;
    expect(request).toMatchObject({ model: 'auto', stream: false, max_tokens: 120 });
    expect(JSON.stringify(request)).not.toMatch(/"(?:tools|tool_choice|provider|fallback)"/u);
    expect(store.persistModelDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        answerText: published.fact,
        kind: 'model',
        knowledgeReferences: [published.reference],
      }),
    );
    expect(allowance.completeLease).toHaveBeenCalledWith(
      expect.objectContaining({ outcomeCode: 'completed' }),
    );
  });

  test('FAQ draft bypasses allowance and Manifest', async () => {
    const { allowance, manifest, service, store } = fixture();
    store.claimModelDecision.mockResolvedValueOnce({
      decisionType: 'faq',
      draftRef: 'DRAFT_TEST_faq',
      nextAction: 'none',
      status: 'duplicate',
    });
    await expect(service.decide(command)).resolves.toMatchObject({ decisionType: 'faq' });
    expect(allowance.acquireModelAllowance).not.toHaveBeenCalled();
    expect(manifest.complete).not.toHaveBeenCalled();
  });

  test('disabled and exhausted paths store deterministic safe drafts', async () => {
    const disabled = fixture();
    disabled.policy.resolveEffectivePolicy.mockResolvedValueOnce({
      reasonCode: 'no_active_policy',
      status: 'disabled',
    });
    await disabled.service.decide(command);
    expect(disabled.manifest.complete).not.toHaveBeenCalled();
    expect(disabled.store.persistModelDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        answerText: safeResponse('en', 'provider_unavailable'),
        escalationReasonCode: 'model_disabled',
        kind: 'safe_failure',
      }),
    );
    const exhausted = fixture();
    exhausted.allowance.acquireModelAllowance.mockResolvedValueOnce({
      reasonCode: 'rate_limited',
      status: 'denied',
    });
    await exhausted.service.decide(command);
    expect(exhausted.manifest.complete).not.toHaveBeenCalled();
    expect(exhausted.store.persistModelDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        answerText: safeResponse('en', 'limit_exhausted'),
        escalationReasonCode: 'rate_limited',
        kind: 'safe_failure',
      }),
    );
  });

  test('timeout and unsupported claim fail closed', async () => {
    const timeout = fixture();
    timeout.manifest.complete.mockResolvedValueOnce({ status: 'failed', reasonCode: 'timeout' });
    await timeout.service.decide(command);
    expect(timeout.store.persistModelDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'safe_failure',
        escalationReasonCode: 'timeout',
      }),
    );
    expect(timeout.allowance.completeLease).toHaveBeenCalledWith(
      expect.objectContaining({ outcomeCode: 'timeout' }),
    );
    const unsupported = fixture();
    unsupported.manifest.complete.mockResolvedValueOnce({
      status: 'completed',
      value: {
        answer: 'Synthetic reviewed support costs 999 BDT.',
        decision: 'answer',
        knowledgeReferences: [published.reference],
        language: 'en',
        needsHumanReview: false,
        reasonCode: 'published_knowledge_answer',
      },
    });
    await unsupported.service.decide(command);
    expect(unsupported.store.persistModelDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'safe_failure',
        escalationReasonCode: 'unsupported_claim',
      }),
    );
    expect(unsupported.allowance.completeLease).toHaveBeenCalledWith(
      expect.objectContaining({ outcomeCode: 'invalid_envelope' }),
    );
  });

  test('duplicate active lease cannot make a second request', async () => {
    const { allowance, manifest, service, store } = fixture();
    allowance.acquireModelAllowance.mockResolvedValueOnce({
      leaseState: 'active',
      status: 'duplicate',
    });
    await expect(service.decide(command)).resolves.toEqual({ status: 'in_progress' });
    expect(manifest.complete).not.toHaveBeenCalled();
    expect(store.persistModelDecision).not.toHaveBeenCalled();
  });

  test('final takeover guard wins after model completion', async () => {
    const { allowance, service, store } = fixture();
    store.persistModelDecision.mockResolvedValueOnce({
      reasonCode: 'pause_active',
      status: 'policy_blocked',
    });
    await expect(service.decide(command)).resolves.toEqual({
      reasonCode: 'pause_active',
      status: 'policy_blocked',
    });
    expect(allowance.completeLease).toHaveBeenCalledWith(
      expect.objectContaining({ outcomeCode: 'guard_blocked' }),
    );
  });
});
