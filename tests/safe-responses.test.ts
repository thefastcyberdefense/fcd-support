import { describe, expect, test } from 'vitest';

import {
  safeResponse,
  safeResponseReasons,
  type SafeResponseReason,
} from '../src/safety/safe-responses.js';

describe('deterministic safe responses', () => {
  test.each<SafeResponseReason>([...safeResponseReasons])(
    'provide reviewed English and Bangla text for %s',
    (reason) => {
      const english = safeResponse('en', reason);
      const bangla = safeResponse('bn', reason);

      expect(english.length).toBeGreaterThan(20);
      expect(bangla.length).toBeGreaterThan(20);
      expect(english).not.toBe(bangla);
      expect(safeResponse('en', reason)).toBe(english);
      expect(safeResponse('bn', reason)).toBe(bangla);
    },
  );

  test('select the sensitive-data response in the requested language', () => {
    expect(safeResponse('en', 'sensitive_data_blocked')).toBe(
      'For your safety, sensitive information in this message was not processed automatically. Please do not send secret values again. A support specialist will review your request.',
    );
    expect(safeResponse('bn', 'sensitive_data_blocked')).toBe(
      'আপনার নিরাপত্তার জন্য এই বার্তার সংবেদনশীল তথ্য স্বয়ংক্রিয়ভাবে প্রক্রিয়া করা হয়নি। অনুগ্রহ করে গোপন তথ্য আবার পাঠাবেন না। একজন সহায়তা প্রতিনিধি আপনার অনুরোধটি দেখবেন।',
    );
  });

  test('cover every closed operational reason exactly once', () => {
    expect(safeResponseReasons).toEqual([
      'sensitive_data_blocked',
      'limit_exhausted',
      'provider_unavailable',
      'validation_failed',
      'human_escalation',
    ]);
    expect(new Set(safeResponseReasons).size).toBe(safeResponseReasons.length);
  });
});
