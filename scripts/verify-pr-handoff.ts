#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

interface PullRequestPayload {
  readonly pull_request?: {
    readonly body?: string | null;
    readonly draft?: boolean;
    readonly title?: string;
  };
}

const requiredSections: readonly (readonly [string, RegExp])[] = [
  ['## Summary', /##\s+(?:Summary|Overview)/iu],
  ['## Validation', /##\s+(?:Validation|Validation Evidence|Key Corrections)/iu],
  ['Evidence or Scope section', /##\s+(?:Evidence|Scope|Changes|Authority Boundary)/iu],
];

async function main(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath === undefined || eventPath.length === 0) {
    process.stdout.write('GITHUB_EVENT_PATH not set; skipping PR handoff check.\n');
    return;
  }

  const rawEvent = await readFile(eventPath, 'utf8');
  const parsed = JSON.parse(rawEvent) as PullRequestPayload;
  const pullRequest = parsed.pull_request;
  if (pullRequest === undefined) {
    process.stdout.write('Not a pull_request event; skipping PR handoff check.\n');
    return;
  }

  const body = pullRequest.body ?? '';
  const errors: string[] = [];

  for (const [label, pattern] of requiredSections) {
    if (!pattern.test(body)) {
      errors.push(`Pull request description is missing required section: ${label}`);
    }
  }

  if (errors.length > 0) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `PR handoff verification passed for: ${pullRequest.title ?? 'untitled'}\n`,
  );
}

await main();
