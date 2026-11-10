#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const pullRequestPayloadSchema = z.object({
  pull_request: z
    .object({
      body: z.string().nullable().optional(),
      draft: z.boolean().optional(),
      title: z.string().optional(),
    })
    .nullable()
    .optional(),
});

export interface PrHandoffOptions {
  readonly eventPath?: string;
}

export interface PrHandoffResult {
  readonly status: 'passed' | 'skipped' | 'failed';
  readonly errors: readonly string[];
  readonly message: string;
}

interface RequiredSectionSpec {
  readonly label: string;
  readonly headingPattern: RegExp;
  readonly requireConcreteCommandOrEvidence?: boolean;
}

const requiredSections: readonly RequiredSectionSpec[] = [
  {
    label: '## Summary',
    headingPattern: /^(?:Summary|Overview)$/iu,
  },
  {
    label: '## Validation',
    headingPattern: /^(?:Validation|Validation Evidence|Key Corrections)$/iu,
    requireConcreteCommandOrEvidence: true,
  },
  {
    label: 'Evidence or Scope section',
    headingPattern:
      /^(?:Evidence|Scope|Scope and Publication Safety|Changes|Authority Boundary)$/iu,
  },
];

const templatePromptPatterns: readonly RegExp[] = [
  /^-\s*What changed and why\?$/iu,
  /^-\s*Which approved story\/plan\/tracker row does this implement\?.*$/iu,
  /^Commands run \(paste exact commands and outcomes\):$/iu,
  /^-\s*\[\s\]\s*.*$/u,
  /^-\s*(?:Phase\/story\/tracker links|Screenshots or Playwright artifact|SEO URL\/header\/JSON-LD output|Runtime or migration evidence|Threat-model\/retention\/consent impact|Canonical\/hreflang\/schema\/sitemap\/robots impact|WCAG 2\.2 AA and keyboard\/touch impact|Rollback plan):\s*$/iu,
  /^(?:TODO|TBD|FIXME|N\/A|none|\.\.\.|-|\*)$/iu,
];

function extractLevelTwoSections(markdown: string): readonly {
  readonly heading: string;
  readonly body: string;
}[] {
  // Mask non-content spans without joining fragments or losing section line boundaries.
  const withoutComments = markdown.replace(/<!--[\s\S]*?(?:-->|$)/gu, (comment) =>
    comment.replace(/[^\r\n]/gu, ' '),
  );
  const lines = withoutComments.split(/\r?\n/u);
  const sections: { heading: string; lines: string[] }[] = [];
  let current: { heading: string; lines: string[] } | undefined;

  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/u.exec(line);
    if (match?.[1] !== undefined) {
      current = { heading: match[1].trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (current !== undefined) {
      current.lines.push(line);
    }
  }

  return sections.map((section) => ({
    heading: section.heading,
    body: section.lines.join('\n'),
  }));
}

function substantiveLines(sectionBody: string): string[] {
  return sectionBody
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => {
      const unquoted = line.replace(/^(?:>\s*)+/u, '').replace(/^\d+[.)]\s+/u, '- ');
      if (templatePromptPatterns.some((pattern) => pattern.test(unquoted))) return false;
      const normalized = unquoted
        .replace(/^[-+*]\s+/u, '')
        .replace(/^[`*_]+|[`*_]+$/gu, '')
        .trim();
      return (
        normalized.length > 0 &&
        !/^(?:`{3,}|~{3,})/u.test(unquoted) &&
        !templatePromptPatterns.some((pattern) => pattern.test(normalized))
      );
    });
}

export async function verifyPrHandoff(options: PrHandoffOptions = {}): Promise<PrHandoffResult> {
  const eventPath = options.eventPath ?? process.env.GITHUB_EVENT_PATH;
  if (eventPath === undefined || eventPath.trim().length === 0) {
    return {
      status: 'skipped',
      errors: [],
      message:
        'SKIP: GITHUB_EVENT_PATH not set; PR handoff structure check skipped (not enforced in non-PR context).',
    };
  }

  let parsed: z.infer<typeof pullRequestPayloadSchema>;
  try {
    const rawEvent = await readFile(eventPath, 'utf8');
    parsed = pullRequestPayloadSchema.parse(JSON.parse(rawEvent) as unknown);
  } catch {
    const message = 'Unable to read or parse PR event payload from GITHUB_EVENT_PATH.';
    return {
      status: 'failed',
      errors: [message],
      message,
    };
  }

  const pullRequest = parsed.pull_request;
  if (pullRequest === undefined || pullRequest === null) {
    return {
      status: 'skipped',
      errors: [],
      message:
        'SKIP: Event payload has no pull_request object; PR handoff structure check skipped.',
    };
  }

  const body = pullRequest.body ?? '';
  const sections = extractLevelTwoSections(body);
  const errors: string[] = [];

  for (const spec of requiredSections) {
    const matching = sections.filter((section) => spec.headingPattern.test(section.heading));
    if (matching.length === 0) {
      errors.push(`Pull request description is missing required section: ${spec.label}`);
      continue;
    }

    const lines = matching.flatMap((section) => substantiveLines(section.body));
    if (lines.length === 0) {
      errors.push(
        `Pull request section has no substantive content beyond template placeholders: ${spec.label}`,
      );
      continue;
    }

    if (
      spec.requireConcreteCommandOrEvidence === true &&
      !lines.some(
        (line) =>
          /`(?:[A-Za-z./][A-Za-z0-9_./-]*[ \t]+[^`\r\n]+|(?:\.{1,2}\/|scripts\/)[A-Za-z0-9_./-]+)`/u.test(
            line,
          ) ||
          /\b(?:npm|npx|node|vitest|git|tsc|bash|python3?|prettier|eslint|pass|passed|fail|failed|exit\s+[0-9]+)\b/iu.test(
            line,
          ),
      )
    ) {
      errors.push(
        `Pull request section must record concrete validation commands or outcomes: ${spec.label}`,
      );
    }
  }

  if (errors.length > 0) {
    return {
      status: 'failed',
      errors,
      message: errors.join('\n'),
    };
  }

  const title = pullRequest.title ?? 'untitled';
  return {
    status: 'passed',
    errors: [],
    message: `PASS: PR handoff structure check passed for "${title}" (verified non-placeholder Summary, Validation, and Evidence/Scope sections; heading check does not verify linked artifacts, story approval, or actual test execution).`,
  };
}

async function main(): Promise<void> {
  const result = await verifyPrHandoff();
  if (result.status === 'failed') {
    process.stderr.write(`${result.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${result.message}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  await main();
}
