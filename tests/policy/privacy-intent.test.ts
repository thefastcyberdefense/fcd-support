import { describe, expect, test } from 'vitest';

import { parsePrivacyIntent } from '../../src/policy/privacy-intent.js';

describe('privacy intent parser', () => {
  test.each([
    ['DELETE MY DATA', 'deletion'],
    ['request my data', 'access'],
    ['  CoRrEcT\tMY\nDATA?  ', 'correction'],
    ['STOP\u00a0MARKETING!', 'marketing_opt_out'],
    ['ＲＥＱＵＥＳＴ ＭＹ ＤＡＴＡ。', null],
    ['ＲＥＱＵＥＳＴ ＭＹ ＤＡＴＡ.', 'access'],
  ] as const)('normalizes exact command %j', (input, expected) => {
    expect(parsePrivacyIntent(input)).toBe(expected);
  });

  test.each([
    'Please REQUEST MY DATA',
    'REQUEST MY DATA now',
    'We discussed DELETE MY DATA yesterday',
    'STOP MARKETING!!',
    'CORRECT MY DATA...',
    'আমার তথ্য মুছুন',
    'REQUEST MY PASSWORD',
    'DELETE MY DATA access_token',
    '',
  ])('rejects non-exact or unapproved text %j', (input) => {
    expect(parsePrivacyIntent(input)).toBeNull();
  });

  test.each([undefined, null, 123, {}, [], new Date()])(
    'rejects non-string input without coercion',
    (input) => {
      expect(parsePrivacyIntent(input)).toBeNull();
    },
  );
});
