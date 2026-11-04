#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

interface SeoContractFinding {
  readonly code: string;
  readonly message: string;
}

async function main(): Promise<void> {
  const repositoryRoot = process.cwd();
  const strictMode = process.env.AGY_STRICT_SEO_GATE === 'true';
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

  for (const finding of findings) {
    process.stdout.write(`[${finding.code}] ${finding.message}\n`);
  }

  const count = String(findings.length);
  if (strictMode && findings.length > 0) {
    process.stderr.write(`SEO contract failed with ${count} finding(s) in strict mode.\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `SEO contract audit completed (${count} open item(s); strict=${String(strictMode)}).\n`,
  );
}

await main();
