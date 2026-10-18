#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type TrackerStatus = 'BLOCKED' | 'COMPLETE' | 'DEFERRED' | 'IN PROGRESS' | 'PENDING';

interface RequiredSectionArtifact {
  readonly label: string;
  readonly path: string;
  readonly sections: readonly string[];
}

const requiredEvidenceFiles = [
  'docs/security/threat-model.md',
  'docs/testing/acceptance-matrix.md',
  'docs/reviews/phase-0-gate.md',
] as const;

const citedEvidenceFiles = [
  'docs/security/threat-model.md',
  'docs/testing/acceptance-matrix.md',
  'docs/reviews/phase-0-gate-validation.md',
] as const;

const requiredSections: readonly RequiredSectionArtifact[] = [
  {
    label: 'Threat model',
    path: 'docs/security/threat-model.md',
    sections: [
      '## 1. Overview',
      '## 2. Threat Model, Trust Boundaries, And Assumptions',
      '## 3. Attack Surface, Mitigations, And Attacker Stories',
      '## 4. Severity Calibration',
    ],
  },
  {
    label: 'Acceptance matrix',
    path: 'docs/testing/acceptance-matrix.md',
    sections: ['## AGENTS.md Launch-Gate Matrix', '## Security, Policy, And Operational Matrix'],
  },
  {
    label: 'Gate review',
    path: 'docs/reviews/phase-0-gate.md',
    sections: [
      '## Evidence Review',
      '## Exit-Gate Findings',
      '## Deferred Risks And Their Binding Gates',
      '## Gate Decision',
    ],
  },
];

const phaseZeroIds = [
  ...Array.from({ length: 16 }, (_, index) => `P0-${String(index + 3).padStart(3, '0')}`),
  'P0-GATE',
];

function requiredCapture(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) {
    throw new Error(`Regular expression capture ${String(index)} is missing`);
  }
  return value;
}

function readRepositoryRoot(argv: readonly string[]): string {
  const optionIndex = argv.indexOf('--repo-root');
  const configuredRoot = argv[optionIndex + 1];
  if (optionIndex === -1 || configuredRoot === undefined) {
    return process.cwd();
  }
  return resolve(configuredRoot);
}

function trackerRows(markdown: string): Map<string, TrackerStatus> {
  const rows = new Map<string, TrackerStatus>();
  for (const line of markdown.split(/\r?\n/u)) {
    const cells = line.split('|').map((cell) => cell.trim());
    const id = cells[1];
    const status = cells[5];
    if (
      id !== undefined &&
      /^P0-(?:\d{3}|GATE)$/u.test(id) &&
      status !== undefined &&
      /^(?:COMPLETE|IN PROGRESS|PENDING|BLOCKED|DEFERRED)$/u.test(status)
    ) {
      rows.set(id, status as TrackerStatus);
    }
  }
  return rows;
}

function trackerRowLines(markdown: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of markdown.split(/\r?\n/u)) {
    const match = /^\|\s*(P0-(?:\d{3}|GATE))\s*\|/u.exec(line);
    if (match !== null) {
      rows.set(requiredCapture(match, 1), line);
    }
  }
  return rows;
}

function normalizeGateName(value: string): string {
  return value.toLowerCase().replaceAll('-', ' ').replaceAll('/', ' ').replace(/\s+/gu, ' ').trim();
}

function requiredLaunchGates(policy: string): string[] {
  const match = /No production launch until the (.+?) tests pass\./u.exec(policy);
  if (match === null) {
    throw new Error('AGENTS.md launch-gate sentence is missing or malformed');
  }
  return requiredCapture(match, 1)
    .replace(', and ', ', ')
    .split(',')
    .map((gate) => normalizeGateName(gate));
}

async function validateCitations(repositoryRoot: string): Promise<string[]> {
  const errors: string[] = [];
  const citationPattern = /`([^`\n]+\.(?:md|ts|sh)):(\d+)`/gu;
  for (const evidenceFile of citedEvidenceFiles) {
    const evidence = await readFile(resolve(repositoryRoot, evidenceFile), 'utf8');
    for (const match of evidence.matchAll(citationPattern)) {
      const relativePath = requiredCapture(match, 1);
      const requestedLine = Number.parseInt(requiredCapture(match, 2), 10);
      let referenced: string;
      try {
        referenced = await readFile(resolve(repositoryRoot, relativePath), 'utf8');
      } catch {
        errors.push(`Citation target is missing: ${relativePath}`);
        continue;
      }
      const availableLines = referenced.split(/\r?\n/u).length;
      if (requestedLine < 1 || requestedLine > availableLines) {
        errors.push(`Citation out of range: ${relativePath}:${String(requestedLine)}`);
      }
    }
  }
  return errors;
}

async function main(): Promise<void> {
  const repositoryRoot = readRepositoryRoot(process.argv.slice(2));
  const tracker = await readFile(resolve(repositoryRoot, 'docs', 'TODO.md'), 'utf8');
  const rows = trackerRows(tracker);
  const rowLines = trackerRowLines(tracker);
  const errors = phaseZeroIds.flatMap((id) => {
    const status = rows.get(id);
    return status === 'COMPLETE' ? [] : [`${id} must be COMPLETE (found ${status ?? 'missing'})`];
  });

  if (errors.length > 0) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  const trackerEvidenceErrors: string[] = [];
  for (const id of phaseZeroIds) {
    const row = rowLines.get(id) ?? '';
    for (const match of row.matchAll(/`(docs\/[^`]+)`/gu)) {
      const relativePath = requiredCapture(match, 1);
      try {
        await access(resolve(repositoryRoot, relativePath));
      } catch {
        trackerEvidenceErrors.push(`Tracker evidence file is missing: ${relativePath} (${id})`);
      }
    }
  }
  if (trackerEvidenceErrors.length > 0) {
    process.stderr.write(`${trackerEvidenceErrors.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  const missingEvidence: string[] = [];
  for (const relativePath of requiredEvidenceFiles) {
    try {
      await access(resolve(repositoryRoot, relativePath));
    } catch {
      missingEvidence.push(`Missing evidence file: ${relativePath}`);
    }
  }
  if (missingEvidence.length > 0) {
    process.stderr.write(`${missingEvidence.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  const sectionErrors: string[] = [];
  for (const artifact of requiredSections) {
    const content = await readFile(resolve(repositoryRoot, artifact.path), 'utf8');
    for (const section of artifact.sections) {
      if (!content.includes(section)) {
        sectionErrors.push(`${artifact.label} is missing section: ${section}`);
      }
    }
  }
  if (sectionErrors.length > 0) {
    process.stderr.write(`${sectionErrors.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  const policy = await readFile(resolve(repositoryRoot, 'AGENTS.md'), 'utf8');
  const matrix = await readFile(
    resolve(repositoryRoot, 'docs', 'testing', 'acceptance-matrix.md'),
    'utf8',
  );
  const normalizedMatrix = normalizeGateName(matrix);
  const missingGateMappings = requiredLaunchGates(policy).flatMap((gate) =>
    normalizedMatrix.includes(gate)
      ? []
      : [`Acceptance matrix does not map AGENTS.md gate: ${gate}`],
  );
  if (missingGateMappings.length > 0) {
    process.stderr.write(`${missingGateMappings.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  const review = await readFile(
    resolve(repositoryRoot, 'docs', 'reviews', 'phase-0-gate.md'),
    'utf8',
  );
  const authorityErrors: string[] = [];
  if (!/^Authority scope: planning_only$/mu.test(review)) {
    authorityErrors.push('Authority scope must be planning_only');
  }
  if (!/^Production action authorization: false$/mu.test(review)) {
    authorityErrors.push('Production action authorization must be false');
  }
  if (authorityErrors.length > 0) {
    process.stderr.write(`${authorityErrors.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  const citationErrors = await validateCitations(repositoryRoot);
  if (citationErrors.length > 0) {
    process.stderr.write(`${citationErrors.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    'Phase 0 tracker, evidence, citations, launch-gate mappings, and authority boundary are valid.\n',
  );
}

await main();
