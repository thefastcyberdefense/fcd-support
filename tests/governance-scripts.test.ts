import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { verifyPrHandoff } from '../scripts/verify-pr-handoff.js';
import { scanSecurityPolicy } from '../scripts/verify-security-policy.js';
import { auditSeoContract } from '../scripts/verify-seo-contract.js';
import { auditUiUxContract } from '../scripts/verify-ui-ux-contract.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function createSyntheticRepo(files: Readonly<Record<string, string>>): Promise<{
  readonly root: string;
  readonly candidateFiles: readonly string[];
}> {
  const root = await makeTempDir('fcd-gov-scan-');

  const defaults: Record<string, string> = {
    'SECURITY.md':
      '# Security Policy\nOnly `GET /webhooks/meta` and `POST /webhooks/meta` are public.\n',
    'AGENTS.md':
      '# Repository Instructions\n- Never commit, print, or paste API keys, access tokens, passwords.\n',
    'docs/SYNTHETIC_FIXTURE_POLICY.md':
      '# Synthetic Fixture And Evidence Policy\nAll fixtures must be synthetic.\n',
  };

  const merged = { ...defaults, ...files };
  for (const [relativePath, content] of Object.entries(merged)) {
    const fullPath = resolve(root, relativePath);
    await mkdir(resolve(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, content, 'utf8');
  }

  return {
    root,
    candidateFiles: Object.keys(merged),
  };
}

describe('verify-security-policy scanner coverage and failure semantics', () => {
  test('scans tracked docs/ and tests/ files and states pattern-scanner limitations on clean control', async () => {
    const { root, candidateFiles } = await createSyntheticRepo({
      'docs/guide.md': '# Guide\nSafe synthetic documentation.\n',
      'tests/sample.test.ts':
        'const key = "SYNTHETIC_API_KEY_DO_NOT_USE_CONTROL_01";\nconst pem = "-----BEGIN PRIVATE KEY-----\\nSYNTHETIC_PRIVATE_KEY_MATERIAL_DO_NOT_USE";\n',
      'src/index.ts': 'export const ok = true;\n',
    });

    const result = await scanSecurityPolicy({ repositoryRoot: root, candidateFiles });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.scannedFiles).toEqual(
      expect.arrayContaining(['docs/guide.md', 'tests/sample.test.ts', 'src/index.ts']),
    );
    expect(result.summary).toContain('does not prove fixture provenance or detect every secret');
  });

  test('passes on the repository root while scanning tracked docs/ and tests/ surfaces', async () => {
    const repoRoot = resolve(import.meta.dirname, '..');
    const result = await scanSecurityPolicy({ repositoryRoot: repoRoot });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.scannedFiles.some((file) => file.startsWith('docs/'))).toBe(true);
    expect(result.scannedFiles.some((file) => file.startsWith('tests/'))).toBe(true);
    expect(result.scannedFiles).toContain('tests/sensitive-data-gate.test.ts');
  });

  test('detects forbidden credential assignment and token prefix in docs/ and tests/ and suppresses matched values', async () => {
    const forbiddenValue = ['UNALLOWLISTED', 'SECRET', 'VALUE', '9876543210ABCDEF'].join('_');
    const forbiddenToken = ['ghp', '1234567890abcdefghijklmnopqrstuv'].join('_');
    const { root, candidateFiles } = await createSyntheticRepo({
      'docs/leaked-doc.md': `api_key = "${forbiddenValue}"\n`,
      'tests/leaked-test.ts': `const access_token = '${forbiddenValue}';\nconst pat = '${forbiddenToken}';\n`,
    });

    const result = await scanSecurityPolicy({ repositoryRoot: root, candidateFiles });

    expect(result.ok).toBe(false);
    expect(result.errors.some((line) => line.includes('docs/leaked-doc.md:1'))).toBe(true);
    expect(result.errors.some((line) => line.includes('tests/leaked-test.ts:1'))).toBe(true);
    expect(result.errors.some((line) => line.includes('tests/leaked-test.ts:2'))).toBe(true);
    for (const errorLine of result.errors) {
      expect(errorLine).not.toContain(forbiddenValue);
      expect(errorLine).not.toContain(forbiddenToken);
    }
    expect(result.summary).not.toContain(forbiddenValue);
    expect(result.summary).not.toContain(forbiddenToken);
  });

  test('detects non-synthetic private key block in tests/ and suppresses key material', async () => {
    const header = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
    const body = 'MIIEowIBAAKCAQEA0123456789abcdefghijklmnopqrstuvwxyz';
    const { root, candidateFiles } = await createSyntheticRepo({
      'tests/bad-key.test.ts': `const pem = "${header}\\n${body}";\n`,
    });

    const result = await scanSecurityPolicy({ repositoryRoot: root, candidateFiles });

    expect(result.ok).toBe(false);
    expect(result.errors.some((line) => line.includes('tests/bad-key.test.ts:1'))).toBe(true);
    for (const errorLine of result.errors) {
      expect(errorLine).not.toContain(body);
      expect(errorLine).not.toContain(header);
    }
  });

  test('fails closed when a tracked candidate file is unreadable or missing on disk', async () => {
    const { root, candidateFiles } = await createSyntheticRepo({
      'src/vanished.ts': 'export const x = 1;\n',
    });
    await rm(resolve(root, 'src/vanished.ts'));

    const result = await scanSecurityPolicy({ repositoryRoot: root, candidateFiles });

    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (line) => line.includes('Unreadable tracked file') && line.includes('src/vanished.ts'),
      ),
    ).toBe(true);
  });

  test('rejects template boilerplate in SECURITY.md and missing policy rules', async () => {
    const { root, candidateFiles } = await createSyntheticRepo({
      'SECURITY.md': 'Use this section to tell people about which versions of your project are\n',
      'AGENTS.md': '# Instructions without the required rule\n',
    });

    const result = await scanSecurityPolicy({ repositoryRoot: root, candidateFiles });

    expect(result.ok).toBe(false);
    expect(
      result.errors.some((line) =>
        line.includes('SECURITY.md still contains unedited GitHub template boilerplate'),
      ),
    ).toBe(true);
    expect(
      result.errors.some((line) =>
        line.includes('AGENTS.md is missing the mandatory credential prohibition'),
      ),
    ).toBe(true);
  });
});

describe('verify-pr-handoff event fixture validation', () => {
  test('reports explicit SKIP when GITHUB_EVENT_PATH is unset or empty', async () => {
    const result = await verifyPrHandoff({ eventPath: '' });

    expect(result.status).toBe('skipped');
    expect(result.message).toMatch(/^SKIP:/u);
  });

  test('reports explicit SKIP when event payload has no pull_request object', async () => {
    const dir = await makeTempDir('fcd-pr-handoff-');
    const eventFile = join(dir, 'push-event.json');
    await writeFile(eventFile, JSON.stringify({ ref: 'refs/heads/main' }), 'utf8');

    const result = await verifyPrHandoff({ eventPath: eventFile });

    expect(result.status).toBe('skipped');
    expect(result.message).toMatch(/^SKIP:/u);
  });

  test('rejects missing, blank, and placeholder-only required sections', async () => {
    const dir = await makeTempDir('fcd-pr-handoff-');

    const missingFile = join(dir, 'missing.json');
    await writeFile(
      missingFile,
      JSON.stringify({
        pull_request: {
          title: 'test: missing sections',
          body: '## Summary\nImplemented bounded governance fix.\n',
        },
      }),
      'utf8',
    );
    const missingResult = await verifyPrHandoff({ eventPath: missingFile });
    expect(missingResult.status).toBe('failed');
    expect(missingResult.errors.some((e) => e.includes('Validation'))).toBe(true);
    expect(missingResult.errors.some((e) => e.includes('Evidence or Scope'))).toBe(true);

    const blankFile = join(dir, 'blank.json');
    await writeFile(
      blankFile,
      JSON.stringify({
        pull_request: {
          title: 'test: blank sections',
          body: '## Summary\n\n## Validation\n   \n## Evidence\n\n',
        },
      }),
      'utf8',
    );
    const blankResult = await verifyPrHandoff({ eventPath: blankFile });
    expect(blankResult.status).toBe('failed');
    expect(blankResult.errors.length).toBe(3);

    const placeholderFile = join(dir, 'placeholder.json');
    await writeFile(
      placeholderFile,
      JSON.stringify({
        pull_request: {
          title: 'test: template placeholders only',
          body: [
            '## Summary',
            '- What changed and why?',
            '- Which approved story/plan/tracker row does this implement? (Ralph/GSD reference)',
            'TODO',
            '',
            '## Validation',
            'Commands run (paste exact commands and outcomes):',
            '- [ ] `npm run validate:phase0`',
            '- [ ] `npm test`',
            '',
            '## Evidence',
            '- Phase/story/tracker links:',
            '- Screenshots or Playwright artifact:',
            '- Runtime or migration evidence:',
            'TBD',
          ].join('\n'),
        },
      }),
      'utf8',
    );
    const placeholderResult = await verifyPrHandoff({ eventPath: placeholderFile });
    expect(placeholderResult.status).toBe('failed');
    expect(placeholderResult.errors.some((e) => e.includes('Summary'))).toBe(true);
    expect(placeholderResult.errors.some((e) => e.includes('Validation'))).toBe(true);
    expect(placeholderResult.errors.some((e) => e.includes('Evidence or Scope'))).toBe(true);
  });

  test('fails closed when GITHUB_EVENT_PATH is unreadable or malformed JSON', async () => {
    const dir = await makeTempDir('fcd-pr-handoff-');
    const missingPath = join(dir, 'does-not-exist.json');

    const result = await verifyPrHandoff({ eventPath: missingPath });
    expect(result.status).toBe('failed');
    expect(result.errors.some((e) => e.includes('Unable to read or parse PR event payload'))).toBe(
      true,
    );
  });

  test('passes on valid minimal control and states heading-checker limitations', async () => {
    const dir = await makeTempDir('fcd-pr-handoff-');
    const validFile = join(dir, 'valid.json');
    await writeFile(
      validFile,
      JSON.stringify({
        pull_request: {
          title: 'ci(governance): repair scanner coverage and PR handoff checks',
          body: [
            '## Summary',
            '- Repaired security scanner coverage and PR handoff fixture checks per 2026-11-07 handoff.',
            '',
            '## Validation',
            '- [x] `npx vitest run tests/governance-scripts.test.ts` (exit 0)',
            '',
            '## Evidence',
            '- Handoff: `docs/handoffs/2026-11-07-antigravity-governance-corrections.md`',
          ].join('\n'),
        },
      }),
      'utf8',
    );

    const result = await verifyPrHandoff({ eventPath: validFile });

    expect(result.status).toBe('passed');
    expect(result.errors).toEqual([]);
    expect(result.message).toContain(
      'does not verify linked artifacts, story approval, or actual test execution',
    );
  });
});

describe('UI/UX and SEO contract scaffolds state source-text audit scope', () => {
  test('UI/UX and SEO contract helpers report source-text scaffold scope without claiming rendered verification', async () => {
    const repoRoot = resolve(import.meta.dirname, '..');
    const uiResult = await auditUiUxContract({ repositoryRoot: repoRoot, strictMode: false });
    const seoResult = await auditSeoContract({ repositoryRoot: repoRoot, strictMode: false });

    expect(uiResult.summary).toContain('source-text');
    expect(uiResult.summary).toContain('does not verify rendered');
    expect(seoResult.summary).toContain('source-text');
    expect(seoResult.summary).toContain('does not verify rendered');
  });
});
