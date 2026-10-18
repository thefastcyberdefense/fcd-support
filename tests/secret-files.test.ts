import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';

import { describe, expect, test } from 'vitest';

import { loadConfig } from '../src/config.js';
import { loadRoleEnvironment, readSecretFile } from '../src/operations/secret-files.js';
import {
  readSyntheticWebhookSecret,
  syntheticWebhookFiles,
  syntheticWebhookSecretText,
} from './helpers/operations-fixtures.js';

describe('role scoped secret files', () => {
  test('rejects conflicting sources before reading either value', async () => {
    await expect(
      loadRoleEnvironment(
        'webhook',
        {
          META_APP_SECRET: 'synthetic_conflicting_secret',
          META_APP_SECRET_FILE: '/run/secrets/synthetic_app_secret',
        },
        readSyntheticWebhookSecret,
      ),
    ).rejects.toThrow('secret_source_conflict');
  });

  test('feeds existing loaders while hiding secrets from inspection and enumeration', async () => {
    const environment = await loadRoleEnvironment(
      'webhook',
      {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        ...syntheticWebhookFiles,
      },
      readSyntheticWebhookSecret,
    );
    expect(loadConfig(environment)).toMatchObject({
      metaAppSecret: 'synthetic_app_secret_for_operations',
      metaVerifyToken: 'synthetic_verify_token_for_operations',
    });
    for (const display of [
      JSON.stringify(environment),
      inspect(environment),
      JSON.stringify(Object.entries(environment)),
      JSON.stringify({ ...environment }),
    ]) {
      expect(display).not.toContain('synthetic_app_secret_for_operations');
      expect(display).not.toContain('synthetic_user@');
      expect(display).not.toContain('synthetic_verify_token_for_operations');
    }
    expect(Object.isFrozen(environment)).toBe(true);
    expect(environment.HOST).toBe('127.0.0.1');
  });

  test('does not mutate the supplied environment or global environment', async () => {
    const before = process.env.META_APP_SECRET;
    const input = { NODE_ENV: 'production', ...syntheticWebhookFiles };
    await loadRoleEnvironment('webhook', input, readSyntheticWebhookSecret);
    expect(input).not.toHaveProperty('META_APP_SECRET');
    expect(process.env.META_APP_SECRET).toBe(before);
  });

  test('production rejects direct credentials even without a file source', async () => {
    await expect(
      loadRoleEnvironment(
        'webhook',
        {
          NODE_ENV: 'production',
          ...syntheticWebhookFiles,
          META_APP_SECRET_FILE: undefined,
          META_APP_SECRET: 'synthetic_direct_secret',
        },
        readSyntheticWebhookSecret,
      ),
    ).rejects.toThrow('secret_file_required');
  });

  test('explicit test mode may feed synthetic values directly to existing loaders', async () => {
    const environment = await loadRoleEnvironment(
      'webhook',
      {
        NODE_ENV: 'test',
        DATABASE_URL: syntheticWebhookSecretText[syntheticWebhookFiles.DATABASE_URL_FILE],
        META_APP_SECRET: 'synthetic_direct_app_secret',
        META_VERIFY_TOKEN: 'synthetic_direct_verify_token',
        PRIVACY_HMAC_KEYRING:
          syntheticWebhookSecretText[syntheticWebhookFiles.PRIVACY_HMAC_KEYRING_FILE],
      },
      readSyntheticWebhookSecret,
    );
    expect(loadConfig(environment).metaAppSecret).toBe('synthetic_direct_app_secret');
  });

  test.each([
    '',
    ' ',
    '\n',
    'synthetic_first\nsecond',
    'synthetic_first\rsecond',
    'synthetic_double_newline\n\n',
  ])('rejects empty or multiline scalar secret %#', async (value) => {
    await expect(
      loadRoleEnvironment('webhook', syntheticWebhookFiles, async (name) =>
        name === syntheticWebhookFiles.META_APP_SECRET_FILE
          ? new TextEncoder().encode(value)
          : readSyntheticWebhookSecret(name),
      ),
    ).rejects.toThrow('secret_file_invalid');
  });

  test.each(['\n', '\r\n'])('removes exactly one terminal newline %#', async (ending) => {
    const environment = await loadRoleEnvironment('webhook', syntheticWebhookFiles, async (name) =>
      name === syntheticWebhookFiles.META_APP_SECRET_FILE
        ? new TextEncoder().encode('synthetic_exact_secret' + ending)
        : readSyntheticWebhookSecret(name),
    );
    expect(environment.META_APP_SECRET).toBe('synthetic_exact_secret');
  });

  test('preserves nonempty scalar whitespace rather than altering a credential', async () => {
    const environment = await loadRoleEnvironment('webhook', syntheticWebhookFiles, async (name) =>
      name === syntheticWebhookFiles.META_APP_SECRET_FILE
        ? new TextEncoder().encode(' synthetic_preserved_secret ')
        : readSyntheticWebhookSecret(name),
    );
    expect(environment.META_APP_SECRET).toBe(' synthetic_preserved_secret ');
  });

  test.each([new Uint8Array([0xff, 0xfe]), new Uint8Array(65537)])(
    'bounds bytes and rejects malformed UTF-8 %#',
    async (bytes) => {
      await expect(
        loadRoleEnvironment('webhook', syntheticWebhookFiles, async (name) =>
          name === syntheticWebhookFiles.META_APP_SECRET_FILE
            ? bytes
            : readSyntheticWebhookSecret(name),
        ),
      ).rejects.toThrow('secret_file_invalid');
    },
  );

  test('structured keyring data may contain formatting newlines', async () => {
    const environment = await loadRoleEnvironment('webhook', syntheticWebhookFiles, async (name) =>
      name === syntheticWebhookFiles.PRIVACY_HMAC_KEYRING_FILE
        ? new TextEncoder().encode('{\n"synthetic": true\n}')
        : readSyntheticWebhookSecret(name),
    );
    expect(environment.PRIVACY_HMAC_KEYRING).toBe('{\n"synthetic": true\n}');
  });

  test.each([
    'MANIFEST_API_KEY_FILE',
    'META_PAGE_ACCESS_TOKEN_FILE',
    'OPENCLAW_API_KEY_FILE',
    'HERMES_API_KEY_FILE',
    'GITHUB_TOKEN',
  ])('rejects unrelated credentials for the webhook role: %s', async (name) => {
    await expect(
      loadRoleEnvironment(
        'webhook',
        {
          ...syntheticWebhookFiles,
          [name]: '/run/secrets/synthetic_unrelated',
        },
        readSyntheticWebhookSecret,
      ),
    ).rejects.toThrow('secret_not_allowed');
  });

  test('disabled model use needs no Manifest key and rejects an accidental mount', async () => {
    const input = {
      NODE_ENV: 'production',
      MODEL_EXECUTION_ENABLED: 'false',
      DATABASE_URL_FILE: syntheticWebhookFiles.DATABASE_URL_FILE,
      PRIVACY_HMAC_KEYRING_FILE: syntheticWebhookFiles.PRIVACY_HMAC_KEYRING_FILE,
    };
    const environment = await loadRoleEnvironment('reply', input, readSyntheticWebhookSecret);
    expect(environment).not.toHaveProperty('MANIFEST_API_KEY');
    await expect(
      loadRoleEnvironment(
        'reply',
        { ...input, MANIFEST_API_KEY_FILE: '/run/secrets/synthetic_unused_key' },
        readSyntheticWebhookSecret,
      ),
    ).rejects.toThrow('secret_not_allowed');
    await expect(
      loadRoleEnvironment(
        'reply',
        { ...input, MODEL_EXECUTION_ENABLED: 'true' },
        readSyntheticWebhookSecret,
      ),
    ).rejects.toThrow('secret_file_required');
  });

  test('disabled outbound and notification roles do not receive channel or n8n credentials', async () => {
    const database = { DATABASE_URL_FILE: syntheticWebhookFiles.DATABASE_URL_FILE };
    expect(
      await loadRoleEnvironment(
        'notification',
        { ...database, N8N_EXECUTION_ENABLED: 'false' },
        readSyntheticWebhookSecret,
      ),
    ).not.toHaveProperty('N8N_ESCALATION_WEBHOOK_SECRET');
    const outbound = {
      ...database,
      OUTBOUND_EXECUTION_ENABLED: 'false',
      PRIVACY_HMAC_KEYRING_FILE: syntheticWebhookFiles.PRIVACY_HMAC_KEYRING_FILE,
    };
    expect(
      await loadRoleEnvironment('outbound', outbound, readSyntheticWebhookSecret),
    ).not.toHaveProperty('META_PAGE_ACCESS_TOKEN');
    await expect(
      loadRoleEnvironment(
        'notification',
        { ...database, N8N_EXECUTION_ENABLED: 'yes' },
        readSyntheticWebhookSecret,
      ),
    ).rejects.toThrow('configuration_invalid');
  });

  test('backup accepts recipient/signing files without a decrypt identity', async () => {
    const environment = await loadRoleEnvironment(
      'backup',
      {
        DATABASE_URL_FILE: syntheticWebhookFiles.DATABASE_URL_FILE,
        BACKUP_ENCRYPTION_RECIPIENT_FILE: '/run/secrets/synthetic_recipient',
        RECOVERY_MANIFEST_HMAC_FILE: '/run/secrets/synthetic_signing',
      },
      async (name) =>
        name === syntheticWebhookFiles.DATABASE_URL_FILE
          ? readSyntheticWebhookSecret(name)
          : new TextEncoder().encode('synthetic_operations_value'),
    );
    expect(environment.BACKUP_ENCRYPTION_RECIPIENT).toBe('synthetic_operations_value');
    expect(environment).not.toHaveProperty('BACKUP_AGE_IDENTITY');
  });

  test('replaces external read errors with closed value-free failures', async () => {
    await expect(
      loadRoleEnvironment('webhook', syntheticWebhookFiles, () =>
        Promise.reject(new Error('synthetic_do_not_leak_path_or_contents')),
      ),
    ).rejects.toThrow(/^secret_file_invalid$/u);
  });

  test('rejects missing and non-absolute file settings', async () => {
    await expect(loadRoleEnvironment('webhook', {}, readSyntheticWebhookSecret)).rejects.toThrow(
      'secret_file_required',
    );
    await expect(
      loadRoleEnvironment(
        'webhook',
        { ...syntheticWebhookFiles, META_APP_SECRET_FILE: '../synthetic_relative' },
        readSyntheticWebhookSecret,
      ),
    ).rejects.toThrow('secret_file_invalid');
  });
});

describe('native secret file reader', () => {
  test('reads an authored file and rejects directories without content-bearing errors', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fcd-synthetic-secret-'));
    try {
      const file = path.join(directory, 'synthetic_secret');
      await writeFile(file, 'synthetic_native_secret', { mode: 0o600 });
      expect(new TextDecoder().decode(await readSecretFile(file))).toBe('synthetic_native_secret');
      await expect(readSecretFile(directory)).rejects.toThrow(/^secret_file_invalid$/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')(
    'rejects world-readable and unreadable Linux files',
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'fcd-synthetic-permissions-'));
      try {
        const file = path.join(directory, 'synthetic_secret');
        await writeFile(file, 'synthetic_native_secret', { mode: 0o600 });
        await chmod(file, 0o644);
        await expect(readSecretFile(file)).rejects.toThrow(/^secret_file_invalid$/u);
        await chmod(file, 0o000);
        await expect(readSecretFile(file)).rejects.toThrow(/^secret_file_invalid$/u);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'rejects a symlink even if its target has mode 0600',
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'fcd-synthetic-symlink-'));
      try {
        const file = path.join(directory, 'synthetic_secret');
        const link = path.join(directory, 'synthetic_link');
        await writeFile(file, 'synthetic_native_secret', { mode: 0o600 });
        await symlink(file, link);
        await expect(readSecretFile(link)).rejects.toThrow(/^secret_file_invalid$/u);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
