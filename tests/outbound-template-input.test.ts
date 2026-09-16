import { describe, expect, test } from 'vitest';

import { parseFixedTemplateVersionInput } from '../src/outbound/outbound-template-input.js';

const validInput = Object.freeze({
  category: 'customer_support',
  channel: 'whatsapp',
  channelAccountId: 'PHONE_TEST_template_input',
  contentSha256: 'a'.repeat(64),
  createdAt: new Date('2026-09-15T02:00:00.000Z'),
  locale: 'en_US',
  providerTemplateId: 'META_TEMPLATE_TEST_support_v1',
  requestKey: 'REQUEST_TEST_template_input',
  templateName: 'synthetic_support_v1',
  templateRef: 'TEMPLATE_TEST_support',
} as const);

describe('fixed outbound template input', () => {
  test('accepts and freezes a fixed zero-variable WhatsApp template', () => {
    const parsed = parseFixedTemplateVersionInput(validInput);
    expect(parsed).toEqual(validInput);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  test.each(['bn_BD', 'en_US'] as const)('accepts reviewed locale %s', (locale) => {
    expect(parseFixedTemplateVersionInput({ ...validInput, locale }).locale).toBe(locale);
  });

  test.each([
    'customer_support',
    'marketing_education',
    'marketing_events',
    'marketing_news',
    'marketing_offers',
  ] as const)('accepts closed category %s', (category) => {
    expect(parseFixedTemplateVersionInput({ ...validInput, category }).category).toBe(category);
  });

  test.each([
    { body: 'Synthetic body must not be stored.' },
    { components: [] },
    { parameters: [] },
    { recipient: 'WA_TEST_not_allowed' },
    { variables: [] },
    { variableCount: 0 },
  ])('rejects unreviewed content or customer-value fields %#', (extra) => {
    expect(() => parseFixedTemplateVersionInput({ ...validInput, ...extra })).toThrow(
      'Invalid fixed outbound template',
    );
  });

  test('rejects Messenger templates', () => {
    expect(() => parseFixedTemplateVersionInput({ ...validInput, channel: 'messenger' })).toThrow(
      'Invalid fixed outbound template',
    );
  });

  test.each([
    { contentSha256: 'not-a-digest' },
    { createdAt: new Date(Number.NaN) },
    { locale: 'en_GB' },
    { providerTemplateId: '' },
    { requestKey: '' },
    { templateName: 'Synthetic Invalid Name' },
    { templateRef: '../invalid' },
  ])('rejects malformed reviewed metadata %#', (changed) => {
    expect(() => parseFixedTemplateVersionInput({ ...validInput, ...changed })).toThrow(
      'Invalid fixed outbound template',
    );
  });
});
