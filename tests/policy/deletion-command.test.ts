import { describe, expect, test } from 'vitest';

import {
  parseExecuteDeletionInput,
  parseOpenDeletionRequestInput,
  parseReviewDeletionRequestInput,
} from '../../src/policy/deletion-command.js';

const requestedAt = new Date('2026-08-29T12:00:00.000Z');
const validOpen = {
  identity: {
    channel: 'whatsapp',
    channelAccountId: 'synthetic-account-a',
    externalContactId: 'synthetic-contact-a',
  },
  requestedAt,
  requestKey: 'privacy-open-synthetic-a',
  sourceWebhookEventId: '101',
} as const;

const validReview = {
  confirmationWebhookEventId: '102',
  decidedAt: new Date('2026-08-29T12:01:00.000Z'),
  decision: 'approve',
  reasonCode: 'customer_confirmed',
  requestKey: 'privacy-review-synthetic-a',
  requestRef: 'privacy-request-synthetic-a',
  verificationMethod: 'explicit_confirmation',
} as const;

describe('open deletion request input', () => {
  test('normalizes bounded identity and request strings', () => {
    expect(
      parseOpenDeletionRequestInput({
        ...validOpen,
        identity: {
          ...validOpen.identity,
          channelAccountId: '  synthetic-account-a  ',
        },
        requestKey: '  privacy-open-synthetic-a  ',
      }),
    ).toEqual(validOpen);
  });

  test.each([
    { ...validOpen, sourceWebhookEventId: 'not-numeric' },
    { ...validOpen, requestedAt: new Date(Number.NaN) },
    { ...validOpen, requestKey: '   ' },
    { ...validOpen, requestKey: 'x'.repeat(129) },
    { ...validOpen, unexpected: true },
  ])('rejects invalid or unbounded open-request material', (candidate) => {
    expect(() => parseOpenDeletionRequestInput(candidate)).toThrow();
  });
});

describe('review deletion request input', () => {
  test.each([
    ['explicit_confirmation', 'customer_confirmed'],
    ['known_name', 'customer_confirmed'],
  ] as const)('accepts the approved same-channel method %s', (verificationMethod, reasonCode) => {
    expect(
      parseReviewDeletionRequestInput({ ...validReview, verificationMethod, reasonCode }),
    ).toMatchObject({ decision: 'approve', reasonCode, verificationMethod });
  });

  test.each(['password', 'otp', 'access_token', 'payment_credential'])(
    'rejects prohibited %s verification',
    (verificationMethod) => {
      expect(() =>
        parseReviewDeletionRequestInput({ ...validReview, verificationMethod }),
      ).toThrow();
    },
  );

  test.each([
    { ...validReview, decision: 'approve', reasonCode: 'identity_ambiguous' },
    { ...validReview, decision: 'reject', reasonCode: 'customer_confirmed' },
    { ...validReview, confirmationWebhookEventId: '-1' },
    { ...validReview, decidedAt: new Date(Number.NaN) },
    { ...validReview, unexpected: true },
  ])('rejects conflicting or malformed reviewer material', (candidate) => {
    expect(() => parseReviewDeletionRequestInput(candidate)).toThrow();
  });

  test.each(['identity_ambiguous', 'request_withdrawn'] as const)(
    'accepts bounded rejection reason %s',
    (reasonCode) => {
      expect(
        parseReviewDeletionRequestInput({ ...validReview, decision: 'reject', reasonCode }),
      ).toMatchObject({ decision: 'reject', reasonCode });
    },
  );
});

describe('execute deletion input', () => {
  test('accepts a valid bounded execution command', () => {
    const input = {
      executedAt: new Date('2026-08-29T12:02:00.000Z'),
      requestKey: 'privacy-execute-synthetic-a',
      requestRef: 'privacy-request-synthetic-a',
    };

    expect(parseExecuteDeletionInput(input)).toEqual(input);
  });

  test.each([
    {
      executedAt: new Date(Number.NaN),
      requestKey: 'privacy-execute-synthetic-a',
      requestRef: 'privacy-request-synthetic-a',
    },
    {
      executedAt: new Date('2026-08-29T12:02:00.000Z'),
      requestKey: '',
      requestRef: 'privacy-request-synthetic-a',
    },
    {
      executedAt: new Date('2026-08-29T12:02:00.000Z'),
      requestKey: 'privacy-execute-synthetic-a',
      requestRef: 'x'.repeat(129),
    },
  ])('rejects invalid execution material', (candidate) => {
    expect(() => parseExecuteDeletionInput(candidate)).toThrow();
  });
});
