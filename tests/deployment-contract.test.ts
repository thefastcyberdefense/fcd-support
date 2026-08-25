import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const projectRoot = resolve(import.meta.dirname, '..');

function readProjectFile(path: string): string {
  const absolutePath = resolve(projectRoot, path);
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : '';
}

describe('test deployment contract', () => {
  test('builds a pinned non-root API image on internal port 3003', () => {
    const dockerfile = readProjectFile('Dockerfile');

    expect(dockerfile).toContain(
      'node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d',
    );
    expect(dockerfile).toContain('npm@11.16.0');
    expect(dockerfile).toMatch(/USER node/u);
    expect(dockerfile).toMatch(/EXPOSE 3003/u);
    expect(dockerfile).toMatch(/CMD \["node", "dist\/main\.js"\]/u);
  });

  test('keeps the API and PostgreSQL off host ports and separates networks', () => {
    const compose = readProjectFile('infra/compose.deploy.yml');

    expect(compose).toContain(
      'postgres:18.4@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636',
    );
    expect(compose).toContain('fcd-support-api:');
    expect(compose).toContain('read_only: true');
    expect(compose).toContain('fcd-support-ingress');
    expect(compose).toContain('mnfst_internal');
    expect(compose).toContain('internal: true');
    expect(compose).not.toMatch(/^\s+ports:/mu);
  });

  test('provides idempotent deployment and privacy-safe verification scripts', () => {
    const deploy = readProjectFile('scripts/deploy-test.sh');
    const verify = readProjectFile('scripts/verify-test-deployment.sh');

    expect(deploy).toContain('docker network inspect');
    expect(deploy).toContain('docker network connect');
    expect(deploy).toContain('config --quiet');
    expect(deploy).toContain('run --rm migrate');
    expect(deploy).not.toContain('set -x');

    expect(verify).toContain('https://meta.fastcyberdefense.com/webhooks/meta');
    expect(verify).toContain('https://meta.fastcyberdefense.com/health');
    expect(verify).toContain('fcd-support-api');
    expect(verify).not.toContain('set -x');
  });

  test('documents repeatable deployment, rollback, and server migration', () => {
    const runbook = readProjectFile('docs/operations/test-deployment.md');

    expect(runbook).toContain('/home/redwan/.config/fcd-support/runtime.env');
    expect(runbook).toContain('/home/redwan/.config/fcd-support/cloudflared.token');
    expect(runbook).toContain('^/webhooks/meta$');
    expect(runbook).toContain('Rollback');
    expect(runbook).toContain('Move to another server');
    expect(runbook).toContain('production WhatsApp');
  });
});
