import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';
import { z } from 'zod';

const root = resolve(import.meta.dirname, '..');
function read(path: string): string {
  const target = resolve(root, path);
  return existsSync(target) ? readFileSync(target, 'utf8') : '';
}

const imageReference = z.string().regex(/^[a-z0-9/.-]+:[a-z0-9.-]+@sha256:[0-9a-f]{64}$/u);
const toolchainSchema = z.strictObject({
  platform: z.literal('linux/amd64'),
  images: z.strictObject({
    node: imageReference,
    postgres: imageReference,
    cloudflared: imageReference,
  }),
  age: z.strictObject({
    version: z.literal('1.3.2'),
    sourceUrl: z.literal(
      'https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-amd64.tar.gz',
    ),
    releaseSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    checksumSource: z.literal('https://api.github.com/repos/FiloSottile/age/releases/tags/v1.3.2'),
  }),
  compatibility: z.strictObject({
    nodeDistribution: z.literal('bookworm'),
    operationsDistribution: z.literal('trixie'),
    verification: z.literal('ldd and executable smoke tests at build time'),
  }),
});

describe('Phase 6 image contract', () => {
  test('ordinary integration runner can read private UID-1000 source without root capabilities', () => {
    const image = read('infra/Dockerfile.integration');
    expect(image.includes('COPY --chown=node:node package.json package-lock.json ./')).toBe(true);
    expect(image.includes('USER node')).toBe(true);
  });

  test('records official immutable artifacts for the explicitly supported platform', () => {
    const result = toolchainSchema.safeParse(
      JSON.parse(read('infra/operations-toolchain.json') || '{}'),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const { images } = result.data;
    expect(images.node).toBe(
      'node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d',
    );
    expect(images.postgres).toBe(
      'postgres:18.4@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636',
    );
    for (const file of [
      'Dockerfile',
      'infra/Dockerfile.operations',
      'infra/Dockerfile.postgres',
      'Dockerfile.cloudflared',
    ]) {
      const bases = [...read(file).matchAll(/^FROM (\S+)/gmu)].map((match) => match[1]);
      expect(bases.length).toBeGreaterThan(0);
      for (const base of bases) expect(Object.values(images)).toContain(base);
    }
  });

  test.each(['Dockerfile', 'infra/Dockerfile.operations'])(
    '%s installs only locked application dependencies and supplies every runtime command',
    (file) => {
      const image = read(file);
      expect(image).toContain('COPY package.json package-lock.json ./');
      expect(image).toContain('RUN npm ci');
      expect(image).toContain('npm prune --omit=dev');
      expect(image).toContain('npm@11.16.0');
      expect(image).toContain('/app/dist ./dist');
      expect(image).toContain('migrations ./migrations');
      expect(image).toContain('USER node');
      expect(image).toContain('/run/fcd-support');
      expect(image).toContain('container-entrypoint.sh');
    },
  );

  test.each([
    'Dockerfile',
    'Dockerfile.cloudflared',
    'infra/Dockerfile.operations',
    'infra/Dockerfile.postgres',
  ])(
    '%s has a revision label and never bakes credentials or an unpinned base into a layer',
    (file) => {
      const image = read(file);
      expect(image).toContain('org.opencontainers.image.revision="$VCS_REF"');
      expect(image).toContain('ARG VCS_REF');
      expect(image).not.toMatch(/^(?:ARG|ENV) .*?(?:PASSWORD|TOKEN|API_KEY|DATABASE_URL)/mu);
      expect(image).not.toMatch(/^COPY .*?(?:secrets|\.env|\.pem|\.key|\*|\. \/)/mu);
      expect(image).not.toMatch(/FROM .*\$|FROM [^\n]+:latest(?:\s|$)/mu);
    },
  );

  test('separates restore identity from the backup image contract and checks age before extraction', () => {
    const image = read('infra/Dockerfile.operations');
    expect(image).toContain('USER node');
    expect(image).not.toContain('COPY secrets');
    expect(image).not.toContain('ARG BACKUP_ENCRYPTION_PASSWORD');
    expect(image).toContain('infra/operations-toolchain.json');
    expect(image).toContain('sha256sum --check --status');
    expect(image.indexOf('sha256sum --check --status')).toBeLessThan(image.indexOf('tar -xzf'));
    expect(image).toContain('process.arch');
    expect(image).toContain('ldd /usr/local/bin/node');
    expect(image).toContain('pg_dump --version');
    expect(image).toContain('pg_restore --version');
    expect(image).toContain('age --version');
    expect(image).toContain('/var/lib/fcd-support/backups');
    expect(image).not.toMatch(/apt(?:-get)? /u);
  });

  test('seeds PostgreSQL volumes as postgres, with no runtime root ownership repair', () => {
    const image = read('infra/Dockerfile.postgres');
    expect(image).toContain('install -d -m 0700 -o postgres -g postgres /var/lib/postgresql');
    expect(image).toContain('/var/lib/postgresql/18/docker');
    expect(image).toContain('USER postgres');
    expect(image).toContain('postgres-entrypoint.sh');
    for (const path of ['scripts/container-entrypoint.sh', 'scripts/postgres-entrypoint.sh']) {
      const guard = read(path);
      expect(guard).toContain('stat -c');
      expect(guard).toContain('id -u');
      expect(guard).not.toMatch(/\b(?:chown|gosu|su|sudo)\b/u);
      expect(guard).toContain('exec ');
    }
  });

  test('excludes private and generated files from the build context', () => {
    expect(read('.dockerignore').startsWith('**\n')).toBe(true);
    const excluded = new Set(read('.dockerignore').split(/\r?\n/u));
    for (const path of [
      '.git',
      '.env',
      '.env.*',
      'secrets',
      '.superpowers',
      '.agents',
      '.codex',
      '.aws',
      '*.pem',
      '*.key',
      '*.dump',
      'backups',
      'recordings',
      'exports',
    ]) {
      expect(excluded.has(path), path).toBe(true);
    }
  });

  test('provides isolated fail-closed executable image and secret-ownership checks', () => {
    const verify = read('scripts/verify-image-contract.sh');
    expect(verify).toContain('--network none');
    expect(verify).toContain('--read-only');
    expect(verify).toContain('--cap-drop ALL');
    expect(verify).toContain('--security-opt no-new-privileges');
    expect(verify).toContain('0600');
    expect(verify).toContain('phase6-image-test');
    expect(verify).toContain('secret_ownership=true');
    expect(verify).toContain('wrong_volume_owner_rejected=true');
    expect(verify).not.toContain('set -x');
    expect(verify).not.toMatch(/docker (?:system|volume) prune|compose (?:up|down)|ssh /u);
  });
});
