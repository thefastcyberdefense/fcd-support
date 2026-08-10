import { describe, expect, test } from 'vitest';

import { normalizeWhatsAppWebhook } from '../../src/meta/normalize-whatsapp.js';

describe('normalizeWhatsAppWebhook', () => {
  test('flattens text messages and statuses into independent events', () => {
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
                metadata: {
                  display_phone_number: '15550000999',
                  phone_number_id: 'PHONE_TEST',
                },
                messages: [
                  {
                    from: '15550000001',
                    id: 'wamid.TEST_inbound',
                    timestamp: '1786400000',
                    type: 'text',
                    text: { body: 'Synthetic support question wa' },
                  },
                ],
                statuses: [
                  {
                    id: 'wamid.TEST_outbound',
                    recipient_id: '15550000001',
                    status: 'delivered',
                    timestamp: '1786400001',
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(events).toEqual([
      {
        kind: 'customer_message',
        channel: 'whatsapp',
        channelAccountId: 'PHONE_TEST',
        contactId: '15550000001',
        externalMessageId: 'wamid.TEST_inbound',
        idempotencyKey: 'whatsapp:message:wamid.TEST_inbound',
        occurredAt: new Date('2026-08-10T22:13:20.000Z'),
        text: 'Synthetic support question wa',
      },
      {
        kind: 'message_status',
        channel: 'whatsapp',
        channelAccountId: 'PHONE_TEST',
        contactId: '15550000001',
        externalMessageId: 'wamid.TEST_outbound',
        idempotencyKey: 'whatsapp:status:wamid.TEST_outbound:delivered:1786400001',
        occurredAt: new Date('2026-08-10T22:13:21.000Z'),
        status: 'delivered',
      },
    ]);
  });

  test('keeps valid siblings when another message type is unsupported', () => {
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
                metadata: { phone_number_id: 'PHONE_TEST' },
                messages: [
                  {
                    from: '15550000001',
                    id: 'wamid.TEST_image',
                    timestamp: '1786400000',
                    type: 'image',
                    image: { id: 'MEDIA_TEST' },
                  },
                  {
                    from: '15550000001',
                    id: 'wamid.TEST_text',
                    timestamp: '1786400001',
                    type: 'text',
                    text: { body: 'Synthetic support question sibling' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(events).toEqual([
      {
        kind: 'unsupported',
        channel: 'whatsapp',
        reasonCode: 'unsupported_message_type:image',
      },
      {
        kind: 'customer_message',
        channel: 'whatsapp',
        channelAccountId: 'PHONE_TEST',
        contactId: '15550000001',
        externalMessageId: 'wamid.TEST_text',
        idempotencyKey: 'whatsapp:message:wamid.TEST_text',
        occurredAt: new Date('2026-08-10T22:13:21.000Z'),
        text: 'Synthetic support question sibling',
      },
    ]);
  });
});
