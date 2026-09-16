import { inspect } from 'node:util';

import { describe, expect, test } from 'vitest';

import {
  buildMessengerTextRequest,
  buildWhatsAppFixedTemplateRequest,
  buildWhatsAppTextRequest,
  MESSENGER_TEXT_MAX_CODE_POINTS,
  readPreparedOutboundRequest,
  WHATSAPP_TEXT_MAX_CODE_POINTS,
} from '../src/outbound/outbound-request.js';

const common = Object.freeze({
  attemptRef: 'ATTEMPT_TEST_outbound_request',
  channelAccountId: 'PHONE_TEST_outbound_request',
  intentRef: 'INTENT_TEST_outbound_request',
  maximumResponseBytes: 65_536,
  providerTimeoutMs: 10_000,
  recipient: 'RECIPIENT_TEST_outbound_request',
});

describe('process-issued outbound requests', () => {
  test('builds the exact closed WhatsApp text request', () => {
    const request = buildWhatsAppTextRequest({
      ...common,
      text: 'Synthetic reviewed WhatsApp reply.',
    });

    expect(readPreparedOutboundRequest(request)).toEqual({
      attemptRef: common.attemptRef,
      body: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        text: {
          body: 'Synthetic reviewed WhatsApp reply.',
          preview_url: false,
        },
        to: common.recipient,
        type: 'text',
      },
      channel: 'whatsapp',
      channelAccountId: common.channelAccountId,
      endpointPath: '/v25.0/PHONE_TEST_outbound_request/messages',
      intentRef: common.intentRef,
      maximumResponseBytes: 65_536,
      messageKind: 'support_text',
      method: 'POST',
      providerTimeoutMs: 10_000,
    });
  });

  test('builds the exact closed Messenger response request', () => {
    const request = buildMessengerTextRequest({
      ...common,
      channelAccountId: 'PAGE_TEST_outbound_request',
      text: 'Synthetic reviewed Messenger reply.',
    });

    expect(readPreparedOutboundRequest(request)).toEqual({
      attemptRef: common.attemptRef,
      body: {
        message: { text: 'Synthetic reviewed Messenger reply.' },
        messaging_type: 'RESPONSE',
        recipient: { id: common.recipient },
      },
      channel: 'messenger',
      channelAccountId: 'PAGE_TEST_outbound_request',
      endpointPath: '/v25.0/PAGE_TEST_outbound_request/messages',
      intentRef: common.intentRef,
      maximumResponseBytes: 65_536,
      messageKind: 'support_text',
      method: 'POST',
      providerTimeoutMs: 10_000,
    });
  });

  test('builds a fixed WhatsApp template without components or variables', () => {
    const request = buildWhatsAppFixedTemplateRequest({
      ...common,
      locale: 'bn_BD',
      templateName: 'synthetic_reviewed_notice',
    });
    const context = readPreparedOutboundRequest(request);

    expect(context).toEqual({
      attemptRef: common.attemptRef,
      body: {
        messaging_product: 'whatsapp',
        template: {
          language: { code: 'bn_BD' },
          name: 'synthetic_reviewed_notice',
        },
        to: common.recipient,
        type: 'template',
      },
      channel: 'whatsapp',
      channelAccountId: common.channelAccountId,
      endpointPath: '/v25.0/PHONE_TEST_outbound_request/messages',
      intentRef: common.intentRef,
      maximumResponseBytes: 65_536,
      messageKind: 'fixed_template',
      method: 'POST',
      providerTimeoutMs: 10_000,
    });
    expect(context?.body).not.toHaveProperty('components');
  });

  test('deep-freezes the opaque request and adapter-only context', () => {
    const request = buildWhatsAppTextRequest({ ...common, text: 'Synthetic immutable reply.' });
    const context = readPreparedOutboundRequest(request);

    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context?.body)).toBe(true);
    if (context?.channel === 'whatsapp' && context.messageKind === 'support_text') {
      expect(Object.isFrozen(context.body.text)).toBe(true);
    }
  });

  test('requires process provenance and rejects shape-compatible copies', () => {
    const request = buildMessengerTextRequest({ ...common, text: 'Synthetic provenance reply.' });
    const context = readPreparedOutboundRequest(request);

    expect(context).toBeDefined();
    expect(readPreparedOutboundRequest({ ...request })).toBeUndefined();
    expect(readPreparedOutboundRequest(JSON.parse(JSON.stringify(request)))).toBeUndefined();
    expect(readPreparedOutboundRequest(context)).toBeUndefined();
    expect(readPreparedOutboundRequest(null)).toBeUndefined();
  });

  test('keeps recipient, content, account, endpoint, and references out of inspection and JSON', () => {
    const text = 'SYNTHETIC_PRIVATE_REPLY_NOT_CUSTOMER_DATA';
    const request = buildWhatsAppTextRequest({ ...common, text });
    const visible = `${inspect(request)} ${JSON.stringify(request)}`;

    for (const hidden of [
      text,
      common.recipient,
      common.channelAccountId,
      common.attemptRef,
      common.intentRef,
      '/v25.0/',
    ]) {
      expect(visible).not.toContain(hidden);
    }
    expect(visible).toContain('whatsapp');
    expect(visible).toContain('support_text');
  });

  test.each([
    { extra: { url: 'https://example.invalid' }, name: 'url' },
    { extra: { credential: 'SYNTHETIC_CREDENTIAL_NOT_OPERATIONAL' }, name: 'credential' },
    { extra: { accessToken: 'SYNTHETIC_TOKEN_NOT_OPERATIONAL' }, name: 'access token' },
    { extra: { body: {} }, name: 'caller body' },
    { extra: { metadata: {} }, name: 'metadata' },
    { extra: { components: [] }, name: 'components' },
  ])('rejects unknown $name input instead of forwarding it', ({ extra }) => {
    expect(() =>
      buildWhatsAppTextRequest({ ...common, text: 'Synthetic closed request.', ...extra }),
    ).toThrow('Invalid WhatsApp text request');
  });

  test('enforces per-channel Unicode code-point text bounds', () => {
    expect(
      readPreparedOutboundRequest(
        buildWhatsAppTextRequest({ ...common, text: 'অ'.repeat(WHATSAPP_TEXT_MAX_CODE_POINTS) }),
      ),
    ).toBeDefined();
    expect(() =>
      buildWhatsAppTextRequest({
        ...common,
        text: 'অ'.repeat(WHATSAPP_TEXT_MAX_CODE_POINTS + 1),
      }),
    ).toThrow('Invalid WhatsApp text request');
    expect(
      readPreparedOutboundRequest(
        buildMessengerTextRequest({ ...common, text: '🙂'.repeat(MESSENGER_TEXT_MAX_CODE_POINTS) }),
      ),
    ).toBeDefined();
    expect(() =>
      buildMessengerTextRequest({
        ...common,
        text: '🙂'.repeat(MESSENGER_TEXT_MAX_CODE_POINTS + 1),
      }),
    ).toThrow('Invalid Messenger text request');
    expect(() => buildWhatsAppTextRequest({ ...common, text: '   ' })).toThrow(
      'Invalid WhatsApp text request',
    );
  });

  test.each([
    { channelAccountId: '../PHONE_TEST' },
    { maximumResponseBytes: 1023 },
    { providerTimeoutMs: 99 },
    { recipient: 'recipient with spaces' },
    { intentRef: '' },
    { attemptRef: '' },
  ])('rejects malformed authoritative dispatch material %#', (changed) => {
    expect(() =>
      buildMessengerTextRequest({ ...common, text: 'Synthetic validated reply.', ...changed }),
    ).toThrow('Invalid Messenger text request');
  });

  test.each([
    { locale: 'en_GB' },
    { templateName: 'Synthetic Invalid Name' },
    { templateName: '' },
    { components: [] },
    { text: 'Synthetic free-form value is forbidden.' },
  ])('rejects malformed or variable template material %#', (changed) => {
    expect(() =>
      buildWhatsAppFixedTemplateRequest({
        ...common,
        locale: 'en_US',
        templateName: 'synthetic_reviewed_notice',
        ...changed,
      }),
    ).toThrow('Invalid WhatsApp fixed-template request');
  });
});
