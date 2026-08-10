import { describe, expect, test } from 'vitest';

import { normalizeMessengerWebhook } from '../../src/meta/normalize-messenger.js';

describe('normalizeMessengerWebhook', () => {
  test('distinguishes customer messages from business echoes', () => {
    const events = normalizeMessengerWebhook({
      object: 'page',
      entry: [
        {
          id: 'PAGE_TEST',
          time: 1786400000000,
          messaging: [
            {
              sender: { id: 'PSID_TEST_customer' },
              recipient: { id: 'PAGE_TEST' },
              timestamp: 1786400000000,
              message: {
                mid: 'm_TEST_inbound',
                text: 'Synthetic support question messenger',
              },
            },
            {
              sender: { id: 'PAGE_TEST' },
              recipient: { id: 'PSID_TEST_customer' },
              timestamp: 1786400001000,
              message: {
                is_echo: true,
                mid: 'm_TEST_echo',
                text: 'Synthetic business reply',
              },
            },
          ],
        },
      ],
    });

    expect(events).toEqual([
      {
        kind: 'customer_message',
        channel: 'messenger',
        channelAccountId: 'PAGE_TEST',
        contactId: 'PSID_TEST_customer',
        externalMessageId: 'm_TEST_inbound',
        idempotencyKey: 'messenger:message:PAGE_TEST:m_TEST_inbound',
        occurredAt: new Date('2026-08-10T22:13:20.000Z'),
        text: 'Synthetic support question messenger',
      },
      {
        kind: 'business_message_echo',
        channel: 'messenger',
        channelAccountId: 'PAGE_TEST',
        contactId: 'PSID_TEST_customer',
        externalMessageId: 'm_TEST_echo',
        idempotencyKey: 'messenger:message:PAGE_TEST:m_TEST_echo',
        occurredAt: new Date('2026-08-10T22:13:21.000Z'),
        text: 'Synthetic business reply',
      },
    ]);
  });

  test('reports unsupported Messenger events without discarding valid siblings', () => {
    const events = normalizeMessengerWebhook({
      object: 'page',
      entry: [
        {
          id: 'PAGE_TEST',
          time: 1786400000000,
          messaging: [
            {
              sender: { id: 'PSID_TEST_customer' },
              recipient: { id: 'PAGE_TEST' },
              timestamp: 1786400000000,
              reaction: { action: 'react', emoji: '👍', mid: 'm_TEST_old' },
            },
            {
              sender: { id: 'PSID_TEST_customer' },
              recipient: { id: 'PAGE_TEST' },
              timestamp: 1786400001000,
              message: {
                mid: 'm_TEST_text',
                text: 'Synthetic support question sibling',
              },
            },
          ],
        },
      ],
    });

    expect(events).toEqual([
      {
        kind: 'unsupported',
        channel: 'messenger',
        reasonCode: 'unsupported_messaging_event',
      },
      {
        kind: 'customer_message',
        channel: 'messenger',
        channelAccountId: 'PAGE_TEST',
        contactId: 'PSID_TEST_customer',
        externalMessageId: 'm_TEST_text',
        idempotencyKey: 'messenger:message:PAGE_TEST:m_TEST_text',
        occurredAt: new Date('2026-08-10T22:13:21.000Z'),
        text: 'Synthetic support question sibling',
      },
    ]);
  });

  test('preserves a valid Messenger sibling when another item is malformed', () => {
    const events = normalizeMessengerWebhook({
      object: 'page',
      entry: [
        {
          id: 'PAGE_TEST',
          time: 1786400000000,
          messaging: [
            {
              sender: {},
              recipient: { id: 'PAGE_TEST' },
              timestamp: 1786400000000,
              message: { mid: 'm_TEST_malformed', text: 'Synthetic malformed item' },
            },
            {
              sender: { id: 'PSID_TEST_customer' },
              recipient: { id: 'PAGE_TEST' },
              timestamp: 1786400001000,
              message: {
                mid: 'm_TEST_valid_after_malformed',
                text: 'Synthetic valid sibling',
              },
            },
          ],
        },
      ],
    });

    expect(events).toEqual([
      {
        kind: 'unsupported',
        channel: 'messenger',
        reasonCode: 'invalid_messaging_event',
      },
      {
        kind: 'customer_message',
        channel: 'messenger',
        channelAccountId: 'PAGE_TEST',
        contactId: 'PSID_TEST_customer',
        externalMessageId: 'm_TEST_valid_after_malformed',
        idempotencyKey: 'messenger:message:PAGE_TEST:m_TEST_valid_after_malformed',
        occurredAt: new Date('2026-08-10T22:13:21.000Z'),
        text: 'Synthetic valid sibling',
      },
    ]);
  });
});
