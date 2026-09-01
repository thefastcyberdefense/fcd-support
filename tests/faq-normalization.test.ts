import { describe, expect, test } from 'vitest';

import { normalizeFaqText } from '../src/knowledge/faq-normalization.js';

describe('FAQ text normalization', () => {
  test('normalize compatibility characters, case, punctuation, and whitespace', () => {
    expect(normalizeFaqText('  ＦＣＤ—Support…\tHELP!  ')).toBe('fcd support help');
  });

  test('preserve Bangla letters, marks, and digits while folding punctuation', () => {
    expect(normalizeFaqText('  পাসওয়ার্ড—রিসেট। ১২৩  ')).toBe('পাসওয়ার্ড রিসেট ১২৩');
  });

  test('produce the same value for composed and decomposed Unicode input', () => {
    expect(normalizeFaqText('Cafe\u0301 support')).toBe(normalizeFaqText('Café support'));
  });

  test('reject empty, malformed surrogate, and excessive input', () => {
    expect(() => normalizeFaqText(' — … ')).toThrow('FAQ text is invalid');
    expect(() => normalizeFaqText('\ud800 synthetic')).toThrow('FAQ text is invalid');
    expect(() => normalizeFaqText('a'.repeat(4001))).toThrow('FAQ text is invalid');
  });
});
