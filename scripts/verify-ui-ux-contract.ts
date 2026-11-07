#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface UiContractFinding {
  readonly code: string;
  readonly message: string;
}

export interface UiContractAuditOptions {
  readonly repositoryRoot?: string;
  readonly strictMode?: boolean;
}

export interface UiContractAuditResult {
  readonly ok: boolean;
  readonly strictMode: boolean;
  readonly findings: readonly UiContractFinding[];
  readonly summary: string;
}

export async function auditUiUxContract(
  options: UiContractAuditOptions = {},
): Promise<UiContractAuditResult> {
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const strictMode = options.strictMode ?? process.env.AGY_STRICT_UI_GATE === 'true';
  const adminHtml = await readFile(
    resolve(repositoryRoot, 'src', 'admin', 'admin-html.ts'),
    'utf8',
  );
  const operationsHtml = await readFile(
    resolve(repositoryRoot, 'src', 'admin', 'operations-html.ts'),
    'utf8',
  );

  const findings: UiContractFinding[] = [];

  if (!adminHtml.includes('skip-link') || !adminHtml.includes('#main-content')) {
    findings.push({
      code: 'UI-A11Y-001',
      message: 'src/admin/admin-html.ts is missing a skip-link targeting #main-content.',
    });
  }

  if (adminHtml.includes('min-height:42px')) {
    findings.push({
      code: 'UI-TOUCH-002',
      message: 'src/admin/admin-html.ts uses 42px controls instead of >= 44px touch targets.',
    });
  }

  const hasDarkScheme =
    adminHtml.includes('prefers-color-scheme:dark') ||
    adminHtml.includes('prefers-color-scheme: dark');
  if (!hasDarkScheme) {
    findings.push({
      code: 'UI-THEME-003',
      message: 'src/admin/admin-html.ts is missing prefers-color-scheme: dark SOC theme support.',
    });
  }

  if (!adminHtml.includes('data-label=') || !operationsHtml.includes('data-label=')) {
    findings.push({
      code: 'UI-RESP-004',
      message: 'Admin and operations tables must include data-label attributes for mobile cards.',
    });
  }

  if (!adminHtml.includes('role="alert"')) {
    findings.push({
      code: 'UI-A11Y-005',
      message: 'src/admin/admin-html.ts login/MFA error notices must include role="alert".',
    });
  }

  const count = String(findings.length);
  const ok = !strictMode || findings.length === 0;
  const summary = ok
    ? `UI/UX source-text contract scaffold completed (${count} open item(s); strict=${String(strictMode)}; source-text check only — does not verify rendered WCAG, viewport overflow, or browser axe compliance).`
    : `UI/UX source-text contract scaffold failed with ${count} finding(s) in strict mode (source-text check only — does not verify rendered WCAG or viewports).`;

  return {
    ok,
    strictMode,
    findings,
    summary,
  };
}

async function main(): Promise<void> {
  const result = await auditUiUxContract();
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
