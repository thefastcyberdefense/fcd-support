#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface SeoContractFinding {
  readonly code: string;
  readonly message: string;
}

export interface SeoContractAuditOptions {
  readonly repositoryRoot?: string;
  readonly strictMode?: boolean;
}

export interface SeoContractAuditResult {
  readonly ok: boolean;
  readonly strictMode: boolean;
  readonly findings: readonly SeoContractFinding[];
  readonly summary: string;
}

export async function auditSeoContract(
  options: SeoContractAuditOptions = {},
): Promise<SeoContractAuditResult> {
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const strictMode = options.strictMode ?? process.env.AGY_STRICT_SEO_GATE === 'true';
  const appSource = await readFile(resolve(repositoryRoot, 'src', 'app.ts'), 'utf8');
  const adminAppSource = await readFile(
    resolve(repositoryRoot, 'src', 'admin', 'admin-app.ts'),
    'utf8',
  );

  const findings: SeoContractFinding[] = [];

  if (!appSource.toLowerCase().includes('x-robots-tag')) {
    findings.push({
      code: 'SEO-ROBOTS-001',
      message: 'src/app.ts must set X-Robots-Tag: noindex, nofollow, noarchive on webhooks.',
    });
  }

  if (!adminAppSource.toLowerCase().includes('x-robots-tag')) {
    findings.push({
      code: 'SEO-ROBOTS-002',
      message: 'src/admin/admin-app.ts must set X-Robots-Tag: noindex, nofollow on admin routes.',
    });
  }

  const count = String(findings.length);
  const ok = !strictMode || findings.length === 0;
  const summary = ok
    ? `SEO/crawler source-text contract scaffold completed (${count} open item(s); strict=${String(strictMode)}; source-text header check only — does not verify rendered metadata, structured data, or live route isolation; public exposure remains webhook-only).`
    : `SEO/crawler source-text contract scaffold failed with ${count} finding(s) in strict mode (source-text header check only — does not verify rendered SEO).`;

  return {
    ok,
    strictMode,
    findings,
    summary,
  };
}

async function main(): Promise<void> {
  const result = await auditSeoContract();
  for (const finding of result.findings) {
    process.stdout.write(`[${finding.code}] ${finding.message}\n`);
  }
  if (!result.ok) {
    process.stderr.write(`${result.summary}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${result.summary}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  await main();
}
