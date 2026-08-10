import { describe, expect, test } from 'vitest';

import { loadConfig } from '../src/config.js';

const validEnvironment = {
  META_APP_SECRET: 'synthetic_app_secret_1234567890',
  META_VERIFY_TOKEN: 'synthetic_verify_token_1234567890',
} as const;

describe('startup configuration', () => {
  test('loads required secrets and private-by-default network settings', () => {
    expect(loadConfig(validEnvironment)).toEqual({
      host: '127.0.0.1',
      metaAppSecret: validEnvironment.META_APP_SECRET,
      metaVerifyToken: validEnvironment.META_VERIFY_TOKEN,
      port: 3000,
    });
  });

  test('accepts an explicit valid host and port', () => {
    expect(
      loadConfig({
        ...validEnvironment,
        HOST: '0.0.0.0',
        PORT: '8080',
      }),
    ).toMatchObject({ host: '0.0.0.0', port: 8080 });
  });

  test('accepts only PostgreSQL database URLs', () => {
    expect(
      loadConfig({
        ...validEnvironment,
        DATABASE_URL: 'postgresql://synthetic_user@127.0.0.1:5432/synthetic_database',
      }),
    ).toMatchObject({
      databaseUrl: 'postgresql://synthetic_user@127.0.0.1:5432/synthetic_database',
    });

    expect(() =>
      loadConfig({
        ...validEnvironment,
        DATABASE_URL: 'https://example.invalid/not-a-database',
      }),
    ).toThrow('Invalid configuration: DATABASE_URL');
  });

  test('reports missing setting names without environment values', () => {
    expect(() => loadConfig({})).toThrow(
      'Invalid configuration: META_APP_SECRET, META_VERIFY_TOKEN',
    );
  });

  test('rejects invalid settings without leaking their values', () => {
    const invalidSecret = 'short-secret';
    const invalidPort = '70000';

    let error: unknown;
    try {
      loadConfig({
        ...validEnvironment,
        META_APP_SECRET: invalidSecret,
        PORT: invalidPort,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('META_APP_SECRET');
    expect(String(error)).toContain('PORT');
    expect(String(error)).not.toContain(invalidSecret);
    expect(String(error)).not.toContain(invalidPort);
  });
});
