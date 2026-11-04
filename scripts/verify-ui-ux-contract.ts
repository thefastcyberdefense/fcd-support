#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

interface UiContractFinding {
  readonly code: string;
  readonly message: string;
}

async function main(): Promise<void> {
  const repositoryRoot = process.cwd();
  const strictMode = process.env.AGY_STRICT_UI_GATE === 'true';
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

  for (const finding of findings) {
    process.stdout.write(`[${finding.code}] ${finding.message}\n`);
  }

  const count = String(findings.length);
  if (strictMode && findings.length > 0) {
    process.stderr.write(`UI/UX contract failed with ${count} finding(s) in strict mode.\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `UI/UX contract audit completed (${count} open item(s); strict=${String(strictMode)}).\n`,
  );
}

await main();
