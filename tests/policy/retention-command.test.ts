import { describe, expect, test } from 'vitest';

import {
  parseActiveRelationshipCloseInput,
  parseActiveRelationshipReviewInput,
  parseActiveRelationshipStartInput,
  parseQualifyingRetentionEventInput,
  parseRetentionReclassificationInput,
} from '../../src/policy/retention-command.js';

const effectiveAt = new Date('2026-08-27T03:00:00.000Z');

describe('retention command validation', () => {
  test('parses trimmed closed retention commands', () => {
    expect(
      parseQualifyingRetentionEventInput({
        conversationId: ' 42 ',
        requestKey: ' qualifying-42 ',
        sourceWebhookEventId: ' 84 ',
        targetClass: 'unconverted_lead',
      }),
    ).toEqual({
      conversationId: '42',
      requestKey: 'qualifying-42',
      sourceWebhookEventId: '84',
      targetClass: 'unconverted_lead',
    });

    expect(
      parseActiveRelationshipStartInput({
        conversationId: '42',
        effectiveAt,
        relationshipStartedAt: new Date('2026-08-01T00:00:00.000Z'),
        requestKey: 'active-start-42',
      }),
    ).toEqual({
      conversationId: '42',
      effectiveAt,
      relationshipStartedAt: new Date('2026-08-01T00:00:00.000Z'),
      requestKey: 'active-start-42',
    });

    expect(
      parseActiveRelationshipReviewInput({
        conversationId: '42',
        requestKey: 'active-review-42',
        reviewedAt: effectiveAt,
      }),
    ).toEqual({
      conversationId: '42',
      requestKey: 'active-review-42',
      reviewedAt: effectiveAt,
    });

    expect(
      parseRetentionReclassificationInput({
        conversationId: '42',
        effectiveAt,
        requestKey: 'reclassify-42',
        targetClass: 'casual_chat',
      }),
    ).toEqual({
      conversationId: '42',
      effectiveAt,
      requestKey: 'reclassify-42',
      targetClass: 'casual_chat',
    });
  });

  test('accepts either or both active-client close anchors', () => {
    expect(
      parseActiveRelationshipCloseInput({
        conversationId: '42',
        effectiveAt,
        relationshipEndedAt: new Date('2026-08-20T00:00:00.000Z'),
        requestKey: 'active-close-42',
      }),
    ).toMatchObject({ conversationId: '42', requestKey: 'active-close-42' });

    expect(
      parseActiveRelationshipCloseInput({
        conversationId: '42',
        effectiveAt,
        finalPaidServiceCompletedAt: new Date('2026-08-21T00:00:00.000Z'),
        relationshipEndedAt: new Date('2026-08-20T00:00:00.000Z'),
        requestKey: 'active-close-both-42',
      }),
    ).toMatchObject({ conversationId: '42', requestKey: 'active-close-both-42' });
  });

  test.each([
    [
      'nondecimal conversation ID',
      () =>
        parseActiveRelationshipReviewInput({
          conversationId: 'abc',
          requestKey: 'review',
          reviewedAt: effectiveAt,
        }),
    ],
    [
      'nondecimal source event ID',
      () =>
        parseQualifyingRetentionEventInput({
          conversationId: '42',
          requestKey: 'qualifying',
          sourceWebhookEventId: 'event-1',
          targetClass: 'casual_chat',
        }),
    ],
    [
      'blank request key',
      () =>
        parseActiveRelationshipReviewInput({
          conversationId: '42',
          requestKey: ' ',
          reviewedAt: effectiveAt,
        }),
    ],
    [
      'overlong request key',
      () =>
        parseActiveRelationshipReviewInput({
          conversationId: '42',
          requestKey: 'x'.repeat(129),
          reviewedAt: effectiveAt,
        }),
    ],
    [
      'invalid date',
      () =>
        parseActiveRelationshipReviewInput({
          conversationId: '42',
          requestKey: 'review',
          reviewedAt: new Date(Number.NaN),
        }),
    ],
    [
      'unsupported target class',
      () =>
        parseRetentionReclassificationInput({
          conversationId: '42',
          effectiveAt,
          requestKey: 'reclassify',
          targetClass: 'active_client',
        }),
    ],
    [
      'missing close anchor',
      () =>
        parseActiveRelationshipCloseInput({
          conversationId: '42',
          effectiveAt,
          requestKey: 'close',
        }),
    ],
    [
      'unknown field',
      () =>
        parseActiveRelationshipReviewInput({
          authorization: 'synthetic_rejected',
          conversationId: '42',
          requestKey: 'review',
          reviewedAt: effectiveAt,
        }),
    ],
  ])('rejects %s', (_caseName, parse) => {
    expect(parse).toThrow();
  });
});
