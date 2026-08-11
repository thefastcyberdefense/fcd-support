import { describe, expect, test } from 'vitest';

import { parseConsentCommand } from '../../src/policy/consent-command.js';

const customerCommand = {
  identity: {
    channel: 'whatsapp',
    channelAccountId: '  synthetic-account  ',
    externalContactId: '  synthetic-contact  ',
  },
  action: 'grant',
  category: 'security_updates',
  wording: 'Synthetic approved consent wording',
  wordingVersion: '2026-08',
  source: 'customer_message',
  sourceAt: new Date('2026-08-11T10:00:00.000Z'),
  idempotencyKey: 'synthetic-consent-event-42',
  sourceWebhookEventId: '42',
} as const;

describe('consent command validation', () => {
  test('parses a customer-message consent command with trimmed identity fields', () => {
    expect(parseConsentCommand(customerCommand)).toEqual({
      ...customerCommand,
      identity: {
        channel: 'whatsapp',
        channelAccountId: 'synthetic-account',
        externalContactId: 'synthetic-contact',
      },
    });
  });

  test('parses a reviewer-recorded consent command without a source event', () => {
    const { sourceWebhookEventId, ...reviewerCommand } = customerCommand;
    void sourceWebhookEventId;

    expect(
      parseConsentCommand({
        ...reviewerCommand,
        action: 'revoke',
        source: 'reviewer_recorded',
      }),
    ).toEqual({
      ...reviewerCommand,
      action: 'revoke',
      source: 'reviewer_recorded',
      identity: {
        channel: 'whatsapp',
        channelAccountId: 'synthetic-account',
        externalContactId: 'synthetic-contact',
      },
    });
  });

  test.each([
    ['blank category', { category: '   ' }],
    ['blank wording', { wording: '   ' }],
    ['blank wording version', { wordingVersion: '   ' }],
    [
      'blank channel account ID',
      { identity: { ...customerCommand.identity, channelAccountId: '   ' } },
    ],
    [
      'blank external contact ID',
      { identity: { ...customerCommand.identity, externalContactId: '   ' } },
    ],
    ['blank idempotency key', { idempotencyKey: '   ' }],
    ['a category with unsupported characters', { category: 'Security Updates' }],
    ['wording over 500 characters', { wording: 'a'.repeat(501) }],
    ['wording version over 64 characters', { wordingVersion: 'a'.repeat(65) }],
    ['idempotency key over 128 characters', { idempotencyKey: 'a'.repeat(129) }],
    ['a non-Date source time', { sourceAt: '2026-08-11T10:00:00.000Z' }],
    ['an invalid Date source time', { sourceAt: new Date('invalid') }],
    ['a customer command without a source event ID', { sourceWebhookEventId: undefined }],
    ['a customer command without a decimal source event ID', { sourceWebhookEventId: '4.2' }],
    [
      'a reviewer command with a source event ID',
      { source: 'reviewer_recorded', sourceWebhookEventId: '42' },
    ],
    ['message text', { messageText: 'Synthetic customer message' }],
    ['an authorization field', { authorization: 'synthetic-value' }],
    ['a raw payload field', { rawPayload: { synthetic: true } }],
  ])('rejects %s', (_reason, override) => {
    const input = {
      ...customerCommand,
      ...override,
    };

    expect(() => parseConsentCommand(input)).toThrow();
  });
});
