import { describe, expect, test } from 'vitest';

import { requireIsolatedTestDatabaseUrl } from './integration/test-database.js';

const expectedOptIn = 'fcd-support-test-only';
const isolatedUrl = 'postgresql://synthetic@127.0.0.1:5432/fcd_support_test';

describe('integration database safety guard', () => {
  test('requires both the exact test database name and destructive-test opt-in', () => {
    expect(() => requireIsolatedTestDatabaseUrl({ TEST_DATABASE_URL: isolatedUrl })).toThrow(
      'Integration database safety guard rejected the environment',
    );

    expect(() =>
      requireIsolatedTestDatabaseUrl({
        ALLOW_DESTRUCTIVE_DATABASE_TESTS: expectedOptIn,
        TEST_DATABASE_URL: 'postgresql://synthetic@127.0.0.1:5432/fcd_support',
      }),
    ).toThrow('Integration database safety guard rejected the environment');

    expect(
      requireIsolatedTestDatabaseUrl({
        ALLOW_DESTRUCTIVE_DATABASE_TESTS: expectedOptIn,
        TEST_DATABASE_URL: isolatedUrl,
      }),
    ).toBe(isolatedUrl);
  });

  test('never includes a rejected database URL in its error', () => {
    const rejectedUrl = 'postgresql://synthetic_secret@example.invalid/customer_database';

    let error: unknown;
    try {
      requireIsolatedTestDatabaseUrl({
        ALLOW_DESTRUCTIVE_DATABASE_TESTS: expectedOptIn,
        TEST_DATABASE_URL: rejectedUrl,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(rejectedUrl);
  });
});
