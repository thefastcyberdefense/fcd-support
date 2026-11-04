#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const forbiddenPatterns: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*['"][A-Za-z0-9_\-/.+=]{24,}['"]/iu,
];

function listTrackedFiles(repositoryRoot: string): string[] {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  return output
    .split('\0')
    .filter((entry) => entry.length > 0)
    .filter(
      (entry) =>
        !entry.endsWith('package-lock.json') &&
        !entry.endsWith('.png') &&
        !entry.endsWith('.jpg') &&
        !entry.startsWith('docs/') &&
        !entry.startsWith('tests/'),
    );
}

async function main(): Promise<void> {
  const repositoryRoot = process.cwd();
  const trackedFiles = listTrackedFiles(repositoryRoot);
  const errors: string[] = [];

  for (const relativePath of trackedFiles) {
    let content = '';
    try {
      content = await readFile(resolve(repositoryRoot, relativePath), 'utf8');
    } catch {
      continue;
    }
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(content)) {
        errors.push(`Potential secret pattern in ${relativePath}: ${String(pattern)}`);
      }
    }
  }

  const securityPolicy = await readFile(resolve(repositoryRoot, 'SECURITY.md'), 'utf8');
  if (securityPolicy.includes('Use this section to tell people about which versions')) {
    errors.push('SECURITY.md still contains unedited GitHub template boilerplate.');
  }

  const agentsPolicy = await readFile(resolve(repositoryRoot, 'AGENTS.md'), 'utf8');
  if (!agentsPolicy.includes('Never commit, print, or paste API keys')) {
    errors.push('AGENTS.md is missing the mandatory credential prohibition.');
  }

  const fixturePolicy = await readFile(
    resolve(repositoryRoot, 'docs', 'SYNTHETIC_FIXTURE_POLICY.md'),
    'utf8',
  );
  if (!fixturePolicy.toLowerCase().includes('synthetic')) {
    errors.push('docs/SYNTHETIC_FIXTURE_POLICY.md must enforce synthetic fixture rules.');
  }

  if (errors.length > 0) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  const count = String(trackedFiles.length);
  process.stdout.write(`Security and fixture policy scan passed (${count} files inspected).\n`);
}

await main();
