import { describe, expect, test, vi } from 'vitest';

import { readPreparedFaqResolutionText } from '../src/knowledge/faq-resolver.js';
import {
  ReplyDecisionService,
  type ReplyDecisionServiceOptions,
} from '../src/replies/reply-decision-service.js';
import type {
  PersistReplyDecisionInput,
  ReplyDecisionClaim,
  ReplyDecisionStore,
} from '../src/replies/reply-types.js';
import { inspectSensitiveText } from '../src/safety/sensitive-data-gate.js';
import { safeResponse } from '../src/safety/safe-responses.js';

const input = Object.freeze({
  evaluatedAt: new Date('2026-09-11T10:05:00.000Z'),
  language: 'en' as const,
  requestKey: 'REQUEST_TEST_reply_decision',
  webhookEventId: '41',
});

const claimed = Object.freeze({
  status: 'claimed' as const,
  source: Object.freeze({
    conversationId: '17',
    messageText: 'What synthetic support plans are available?',
    occurredAt: new Date('2026-09-11T10:00:00.000Z'),
    webhookEventId: input.webhookEventId,
  }),
});

function harness(overrides: Partial<ReplyDecisionServiceOptions> = {}) {
  const persisted: PersistReplyDecisionInput[] = [];
  const order: string[] = [];
  const store: ReplyDecisionStore = {
    claimDecision(): Promise<ReplyDecisionClaim> {
      order.push('claim');
      return Promise.resolve(claimed);
    },
    persistDecision(value) {
      order.push('persist');
      persisted.push(value);
      if (value.kind === 'model_required') {
        return Promise.resolve({
          status: 'created',
          decisionType: value.kind,
          nextAction: 'model_required',
          observationRef: 'GAP_TEST_reply_decision',
        });
      }
      return Promise.resolve({
        status: 'created',
        decisionType: value.kind,
        draftRef: 'DRAFT_TEST_reply_decision',
        nextAction: 'none',
      });
    },
  };
  const inspect = vi.fn((text: string, language: 'bn' | 'en') => {
    order.push('inspect');
    return inspectSensitiveText(text, language, { maximumInputCodePoints: 500 });
  });
  const resolve = vi.fn(
    (resolverInput: Parameters<ReplyDecisionServiceOptions['faqResolver']['resolve']>[0]) => {
      void resolverInput;
      order.push('faq');
      return Promise.resolve({
        status: 'match' as const,
        answer: 'Synthetic reviewed support answer.',
        itemReference: 'faq.synthetic.reply',
        language: 'en' as const,
        matchKind: 'exact_question' as const,
        versionReference: 'VERSION_TEST_reply',
      });
    },
  );
  const options: ReplyDecisionServiceOptions = {
    faqResolver: { resolve },
    inspectSensitiveText: inspect,
    store,
    ...overrides,
  };
  return {
    inspect,
    order,
    persisted,
    resolve,
    service: new ReplyDecisionService(options),
  };
}

describe('reply decision service', () => {
  test('inspects sensitive data before FAQ and persists the exact reviewed answer', async () => {
    const { order, persisted, resolve, service } = harness();

    await expect(service.decide(input)).resolves.toEqual({
      status: 'created',
      decisionType: 'faq',
      draftRef: 'DRAFT_TEST_reply_decision',
      nextAction: 'none',
    });
    expect(order).toEqual(['claim', 'inspect', 'faq', 'persist']);
    const faqInput = resolve.mock.calls[0]?.[0];
    if (faqInput === undefined) throw new Error('FAQ resolver input was not captured');
    expect(readPreparedFaqResolutionText(faqInput.sanitizedText)).toEqual({
      language: 'en',
      normalizedText: 'what synthetic support plans are available',
    });
    expect(persisted).toEqual([
      {
        ...input,
        kind: 'faq',
        answerText: 'Synthetic reviewed support answer.',
        itemReference: 'faq.synthetic.reply',
        versionReference: 'VERSION_TEST_reply',
      },
    ]);
  });

  test('creates a deterministic safe draft and escalation without consulting FAQ', async () => {
    const persisted: PersistReplyDecisionInput[] = [];
    const { resolve, service } = harness({
      store: {
        claimDecision() {
          return Promise.resolve({
            ...claimed,
            source: {
              ...claimed.source,
              messageText: 'Card number is 4111 1111 1111 1111',
            },
          });
        },
        persistDecision(value) {
          persisted.push(value);
          return Promise.resolve({
            status: 'created',
            decisionType: 'safe_failure',
            draftRef: 'DRAFT_TEST_sensitive',
            nextAction: 'none',
          });
        },
      },
    });

    await expect(service.decide(input)).resolves.toMatchObject({
      decisionType: 'safe_failure',
      nextAction: 'none',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(persisted).toEqual([
      {
        ...input,
        kind: 'safe_failure',
        answerText: safeResponse('en', 'sensitive_data_blocked'),
        escalationReasonCode: 'sensitive_data_blocked',
      },
    ]);
  });

  test('uses unsafe_redaction for ambiguous single-value redaction blocks', async () => {
    const persisted: PersistReplyDecisionInput[] = [];
    const { service } = harness({
      store: {
        claimDecision() {
          return Promise.resolve({
            ...claimed,
            source: { ...claimed.source, messageText: 'Password: SYNTHETIC_VALUE' },
          });
        },
        persistDecision(value) {
          persisted.push(value);
          return Promise.resolve({
            status: 'created',
            decisionType: 'safe_failure',
            draftRef: 'DRAFT_TEST_redaction',
            nextAction: 'none',
          });
        },
      },
    });

    await service.decide(input);
    expect(persisted[0]).toMatchObject({
      kind: 'safe_failure',
      escalationReasonCode: 'unsafe_redaction',
    });
  });

  test.each([
    ['ambiguous', 'faq_ambiguous'],
    ['miss', 'faq_miss'],
  ] as const)(
    'records %s as a gap and requests the later model boundary',
    async (status, gapKind) => {
      const { persisted, service } = harness({
        faqResolver: {
          resolve() {
            return Promise.resolve(
              status === 'ambiguous'
                ? { status, reasonCode: 'similarity_margin' as const }
                : { status, reasonCode: 'no_candidates' as const },
            );
          },
        },
      });

      await expect(service.decide(input)).resolves.toEqual({
        status: 'created',
        decisionType: 'model_required',
        nextAction: 'model_required',
        observationRef: 'GAP_TEST_reply_decision',
      });
      expect(persisted).toEqual([{ ...input, kind: 'model_required', gapKind }]);
    },
  );

  test.each([
    { status: 'not_processable' as const },
    { status: 'policy_blocked' as const, reasonCode: 'pause_active' as const },
    {
      status: 'duplicate' as const,
      decisionType: 'faq' as const,
      draftRef: 'DRAFT_TEST_existing',
      nextAction: 'none' as const,
    },
  ])('returns a terminal claim outcome without inspection or persistence', async (claim) => {
    const inspect = vi.fn(inspectSensitiveText);
    const persistDecision = vi.fn();
    const service = new ReplyDecisionService({
      faqResolver: { resolve: vi.fn() },
      inspectSensitiveText: inspect,
      store: { claimDecision: vi.fn().mockResolvedValue(claim), persistDecision },
    });

    await expect(service.decide(input)).resolves.toEqual(claim);
    expect(inspect).not.toHaveBeenCalled();
    expect(persistDecision).not.toHaveBeenCalled();
  });

  test('lets a guard activated during resolution win before a draft is created', async () => {
    const { service } = harness({
      store: {
        claimDecision() {
          return Promise.resolve(claimed);
        },
        persistDecision() {
          return Promise.resolve({
            status: 'policy_blocked',
            reasonCode: 'privacy_request_open',
          });
        },
      },
    });

    await expect(service.decide(input)).resolves.toEqual({
      status: 'policy_blocked',
      reasonCode: 'privacy_request_open',
    });
  });

  test('rejects malformed commands before reading customer content', async () => {
    const { inspect, service } = harness();

    await expect(service.decide({ ...input, webhookEventId: 'not-decimal' })).rejects.toThrow(
      'Reply decision input is invalid',
    );
    expect(inspect).not.toHaveBeenCalled();
  });
});
