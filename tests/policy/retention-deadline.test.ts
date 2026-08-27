import { describe, expect, test } from 'vitest';

import {
  addUtcCalendarMonths,
  calculateCasualChatExpiry,
  calculateClosedActiveClientDeadline,
} from '../../src/policy/retention-deadline.js';

describe('retention deadline arithmetic', () => {
  test('uses exactly 60 times 24 hours for casual chat', () => {
    expect(calculateCasualChatExpiry(new Date('2026-01-01T12:34:56.789Z'))).toEqual(
      new Date('2026-03-02T12:34:56.789Z'),
    );
  });

  test.each([
    ['clamps leap day after 12 months', '2024-02-29T23:45:00.123Z', 12, '2025-02-28T23:45:00.123Z'],
    ['preserves a valid month-end day', '2026-01-31T08:00:00.000Z', 12, '2027-01-31T08:00:00.000Z'],
    [
      'preserves UTC time after 24 months',
      '2026-08-31T08:09:10.011Z',
      24,
      '2028-08-31T08:09:10.011Z',
    ],
  ] as const)('%s', (_caseName, anchor, months, expected) => {
    expect(addUtcCalendarMonths(new Date(anchor), months)).toEqual(new Date(expected));
  });

  test('uses the later active-client close anchor and applies 24 calendar months', () => {
    expect(
      calculateClosedActiveClientDeadline({
        relationshipEndedAt: new Date('2024-02-28T10:00:00.000Z'),
        finalPaidServiceCompletedAt: new Date('2024-02-29T12:30:00.000Z'),
      }),
    ).toEqual({
      anchorAt: new Date('2024-02-29T12:30:00.000Z'),
      expiresAt: new Date('2026-02-28T12:30:00.000Z'),
    });
  });

  test('accepts either documented active-client close anchor by itself', () => {
    expect(
      calculateClosedActiveClientDeadline({
        relationshipEndedAt: new Date('2026-08-27T03:00:00.000Z'),
      }),
    ).toEqual({
      anchorAt: new Date('2026-08-27T03:00:00.000Z'),
      expiresAt: new Date('2028-08-27T03:00:00.000Z'),
    });
  });

  test('rejects invalid dates and missing active-client close anchors', () => {
    expect(() => calculateCasualChatExpiry(new Date(Number.NaN))).toThrow(
      'anchor must be a valid Date',
    );
    expect(() => addUtcCalendarMonths(new Date(Number.NaN), 12)).toThrow(
      'anchor must be a valid Date',
    );
    expect(() => calculateClosedActiveClientDeadline({})).toThrow(
      'An active-client close requires at least one documented anchor',
    );
  });
});
