import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const projectRoot = resolve(import.meta.dirname, '..');

function readProjectFile(path: string): string {
  const absolutePath = resolve(projectRoot, path);
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : '';
}

describe('test deployment contract', () => {
  test('builds a pinned non-root, revision-labelled API image on internal port 3003', () => {
    const dockerfile = readProjectFile('Dockerfile');

    expect(dockerfile).toContain(
      'node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d',
    );
    expect(dockerfile).toContain('npm@11.16.0');
    expect(dockerfile).toContain('org.opencontainers.image.revision');
    expect(dockerfile).toMatch(/USER node/u);
    expect(dockerfile).toMatch(/EXPOSE 3003/u);
    expect(dockerfile).toMatch(/CMD \["node", "dist\/main\.js"\]/u);
  });

  test('uses immutable API tags, no host ports, and only the required networks', () => {
    const compose = readProjectFile('infra/compose.deploy.yml');

    expect(compose).toContain(
      'postgres:18.4@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636',
    );
    expect(compose).toContain('${FCD_SUPPORT_IMAGE:?FCD_SUPPORT_IMAGE must be set}');
    expect(compose).toContain('${FCD_SUPPORT_REVISION:?FCD_SUPPORT_REVISION must be set}');
    expect(compose).toContain('fcd-support-api:');
    expect(compose).toContain('read_only: true');
    expect(compose).toContain('fcd-support-ingress');
    expect(compose).toContain('fcd-support-data');
    expect(compose).not.toContain('mnfst_internal');
    expect(compose).toContain('internal: true');
    expect(compose).not.toMatch(/^\s+ports:/mu);
  });

  test('pins the source revision and verifies network and ingress isolation', () => {
    const deploy = readProjectFile('scripts/deploy-test.sh');
    const verify = readProjectFile('scripts/verify-test-deployment.sh');

    expect(deploy).toContain('^[0-9a-f]{40}$');
    expect(deploy).toContain('status --porcelain --untracked-files=all');
    expect(deploy).toContain('fcd-support-api:$APPROVED_REVISION');
    expect(deploy).toContain('docker network inspect');
    expect(deploy).toContain('docker network connect');
    expect(deploy).toContain('config --quiet');
    expect(deploy).toContain('run --rm migrate');
    expect(deploy).toContain('start-cloudflared.sh" --validate-only "$APPROVED_REVISION"');
    expect(deploy).not.toContain('set -x');

    expect(verify).toContain('https://meta.fastcyberdefense.com/webhooks/meta');
    expect(verify).toContain('https://meta.fastcyberdefense.com/health');
    expect(verify).toContain('x-fcd-route-scope');
    expect(verify).toContain('assert_only_networks');
    expect(verify).toContain('assert_network_endpoints');
    expect(verify).toContain('mnfst_internal');
    expect(verify).toContain('Running API image does not match');
    expect(verify).not.toContain('set -x');
  });

  test('provides retained-image rollback and repeatable server migration', () => {
    const rollback = readProjectFile('scripts/rollback-test.sh');
    const tunnel = readProjectFile('scripts/start-cloudflared.sh');
    const tunnelDockerfile = readProjectFile('Dockerfile.cloudflared');
    const stop = readProjectFile('scripts/stop-test-deployment.sh');
    const runbook = readProjectFile('docs/operations/test-deployment.md');

    expect(rollback).toContain('--confirm-schema-compatible');
    expect(rollback).toContain('--no-build');
    expect(rollback).not.toContain('migrate down');
    expect(tunnelDockerfile).toContain('cloudflare/cloudflared:2026.8.2@sha256:');
    expect(tunnelDockerfile).toContain('HEALTHCHECK');
    expect(tunnelDockerfile).toContain('ARG VCS_REF');
    expect(tunnelDockerfile).toContain('org.opencontainers.image.revision');
    expect(tunnelDockerfile).toContain('127.0.0.1:2000", "ready"');
    expect(tunnel).toContain('validate_contract');
    expect(tunnel).toContain('--replace-existing');
    expect(tunnel).toContain('status --porcelain --untracked-files=all');
    expect(tunnel).toContain('fcd-support-cloudflared:$APPROVED_REVISION');
    expect(tunnel).toContain('--build-arg "VCS_REF=$APPROVED_REVISION"');
    expect(tunnel).toContain('--network bridge');
    expect(tunnel).toContain('--cpus 0.25');
    expect(tunnel).toContain('--memory 128m');
    expect(stop).toContain('com.docker.compose.project=fcd-support');
    expect(stop).toContain('if ! container_output="$(docker ps');
    expect(stop).not.toContain('--env-file');
    expect(tunnel).toContain('cloudflared-token');

    expect(runbook).toContain('/home/redwan/.config/fcd-support/runtime.env');
    expect(runbook).toContain('/home/redwan/.config/fcd-support/cloudflared.token');
    expect(runbook).toContain('^/webhooks/meta$');
    expect(runbook).toContain('FULL_40_CHARACTER_APPROVED_COMMIT');
    expect(runbook).toContain('Rollback');
    expect(runbook).toContain('Move to another server');
    expect(runbook).toContain('production WhatsApp');
  });
});
