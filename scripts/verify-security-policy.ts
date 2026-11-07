#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface SecurityScanOptions {
  readonly repositoryRoot?: string;
}

export interface SecurityScanResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly scannedFiles: readonly string[];
  readonly summary: string;
}

const skippedBinaryExtensions = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.woff',
  '.woff2',
  '.pdf',
] as const;

const regexDefinitionAllowlist = new Set([
  'src/safety/sensitive-data-gate.ts',
  'src/persistence/postgres-access-export.ts',
  'scripts/verify-security-policy.ts',
]);

const privateKeyHeaderPattern =
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/gu;
const credentialAssignmentPattern =
  /(?:api[_-]?key|access[_-]?token|client[_-]?secret|app[_-]?secret|verify[_-]?token|tunnel[_-]?token|password)\s*[:=]\s*(['"])([A-Za-z0-9_\-/.+=!@#$%^&*]{16,})\1/giu;
const providerTokenPattern =
  /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/gu;
const syntheticMarkerPattern = /(?:synthetic|test|fixture|example|do_not_use|redacted)/iu;

function listTrackedCandidateFiles(repositoryRoot: string): string[] {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  return output
    .split('\0')
    .filter((entry) => entry.length > 0)
    .filter(
      (entry) =>
        entry !== 'package-lock.json' &&
        !entry.endsWith('/package-lock.json') &&
        !skippedBinaryExtensions.some((ext) => entry.toLowerCase().endsWith(ext)),
    );
}

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function isAllowedPrivateKeyMatch(
  relativePath: string,
  content: string,
  matchIndex: number,
  matchLength: number,
): boolean {
  const lineStart = content.lastIndexOf('\n', matchIndex - 1) + 1;
  const lineEndIndex = content.indexOf('\n', matchIndex);
  const lineEnd = lineEndIndex === -1 ? content.length : lineEndIndex;
  const currentLine = content.slice(lineStart, lineEnd);

  if (regexDefinitionAllowlist.has(relativePath) && currentLine.includes('/-----BEGIN')) {
    return true;
  }

  if (relativePath.startsWith('tests/')) {
    const windowAfter = content.slice(matchIndex + matchLength, matchIndex + matchLength + 96);
    if (/^(?:\\\\n|\\n|\r?\n)\s*(?:SYNTHETIC|TEST)_[A-Z0-9_]+/u.test(windowAfter)) {
      return true;
    }
  }

  return false;
}

function scanFileContent(relativePath: string, content: string): string[] {
  const findings: string[] = [];

  for (const match of content.matchAll(privateKeyHeaderPattern)) {
    const index = match.index;
    if (!isAllowedPrivateKeyMatch(relativePath, content, index, match[0].length)) {
      const line = lineNumberAt(content, index);
      findings.push(
        `Potential secret pattern [PRIVATE_KEY_HEADER] in ${relativePath}:${String(line)} (matched value suppressed)`,
      );
    }
  }

  for (const match of content.matchAll(credentialAssignmentPattern)) {
    const candidateValue = match[2] ?? '';
    if (!syntheticMarkerPattern.test(candidateValue)) {
      const line = lineNumberAt(content, match.index);
      findings.push(
        `Potential secret pattern [CREDENTIAL_ASSIGNMENT] in ${relativePath}:${String(line)} (matched value suppressed)`,
      );
    }
  }

  for (const match of content.matchAll(providerTokenPattern)) {
    const token = match[0];
    if (!syntheticMarkerPattern.test(token)) {
      const line = lineNumberAt(content, match.index);
      findings.push(
        `Potential secret pattern [PROVIDER_TOKEN_PREFIX] in ${relativePath}:${String(line)} (matched value suppressed)`,
      );
    }
  }

  return findings;
}

export async function scanSecurityPolicy(
  options: SecurityScanOptions = {},
): Promise<SecurityScanResult> {
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const errors: string[] = [];
  let trackedFiles: string[];

  try {
    trackedFiles = listTrackedCandidateFiles(repositoryRoot);
  } catch {
    return {
      ok: false,
      errors: ['Failed to enumerate tracked files with git ls-files.'],
      scannedFiles: [],
      summary: 'Security and fixture pattern scan failed (unable to list tracked files).',
    };
  }

  const scannedFiles: string[] = [];
  for (const relativePath of trackedFiles) {
    let content: string;
    try {
      content = await readFile(resolve(repositoryRoot, relativePath), 'utf8');
    } catch {
      errors.push(`Unreadable tracked file: ${relativePath}`);
      continue;
    }
    scannedFiles.push(relativePath);
    errors.push(...scanFileContent(relativePath, content));
  }

  try {
    const securityPolicy = await readFile(resolve(repositoryRoot, 'SECURITY.md'), 'utf8');
    if (securityPolicy.includes('Use this section to tell people about which versions')) {
      errors.push('SECURITY.md still contains unedited GitHub template boilerplate.');
    }
  } catch {
    errors.push('Missing or unreadable required policy file: SECURITY.md');
  }

  try {
    const agentsPolicy = await readFile(resolve(repositoryRoot, 'AGENTS.md'), 'utf8');
    if (!agentsPolicy.includes('Never commit, print, or paste API keys')) {
      errors.push('AGENTS.md is missing the mandatory credential prohibition.');
    }
  } catch {
    errors.push('Missing or unreadable required policy file: AGENTS.md');
  }

  try {
    const fixturePolicy = await readFile(
      resolve(repositoryRoot, 'docs', 'SYNTHETIC_FIXTURE_POLICY.md'),
      'utf8',
    );
    if (!fixturePolicy.toLowerCase().includes('synthetic')) {
      errors.push('docs/SYNTHETIC_FIXTURE_POLICY.md must enforce synthetic fixture rules.');
    }
  } catch {
    errors.push('Missing or unreadable required policy file: docs/SYNTHETIC_FIXTURE_POLICY.md');
  }

  const count = String(scannedFiles.length);
  const ok = errors.length === 0;
  const summary = ok
    ? `Security and fixture pattern scan passed (${count} tracked files inspected across source, docs, and tests; heuristic pattern scan only — does not prove fixture provenance or detect every secret).`
    : `Security and fixture pattern scan failed with ${String(errors.length)} error(s) across ${count} inspected file(s).`;

  return {
    ok,
    errors,
    scannedFiles,
    summary,
  };
}

async function main(): Promise<void> {
  const result = await scanSecurityPolicy();
  if (!result.ok) {
    process.stderr.write(`${result.errors.join('\n')}\n${result.summary}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${result.summary}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  await main();
}
