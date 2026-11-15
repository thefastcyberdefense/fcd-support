import { spawnSync } from 'node:child_process';
import {
  access,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const validatorPath = join(repositoryRoot, 'scripts', 'validate-phase0-gate.ts');
const temporaryRoots: string[] = [];

const phaseZeroIds = new Set([
  ...Array.from({ length: 16 }, (_, index) => `P0-${String(index + 3).padStart(3, '0')}`),
  'P0-GATE',
]);

interface ValidationResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface ValidatorInputs {
  readonly requiredEvidenceFiles: readonly string[];
  readonly citedEvidenceFiles: readonly string[];
  readonly requiredSectionPaths: readonly string[];
}

function extractValidatorBlock(validatorSource: string, constantName: string): string {
  const pattern = new RegExp(
    `const ${constantName}(?:\\s*:[^=]+)?\\s*=\\s*\\[([\\s\\S]*?)\\n\\]`,
    'u',
  );
  const match = pattern.exec(validatorSource);
  if (match?.[1] === undefined) {
    throw new Error(`Could not extract ${constantName} from ${validatorPath}`);
  }
  return match[1];
}

function extractSingleQuotedValues(block: string, fieldName: string): readonly string[] {
  const values = Array.from(block.matchAll(/'([^']+)'/gu), (entry) => entry[1]).filter(
    (value): value is string => value !== undefined,
  );
  if (values.length === 0) {
    throw new Error(`Validator list ${fieldName} in ${validatorPath} is empty`);
  }
  return values;
}

async function readValidatorInputs(): Promise<ValidatorInputs> {
  const validatorSource = await readFile(validatorPath, 'utf8');
  const requiredEvidenceBlock = extractValidatorBlock(validatorSource, 'requiredEvidenceFiles');
  const citedEvidenceBlock = extractValidatorBlock(validatorSource, 'citedEvidenceFiles');
  const requiredSectionsBlock = extractValidatorBlock(validatorSource, 'requiredSections');
  const sectionPaths = Array.from(
    requiredSectionsBlock.matchAll(/\bpath:\s*'([^']+)'/gu),
    (entry) => entry[1],
  ).filter((value): value is string => value !== undefined);
  if (sectionPaths.length === 0) {
    throw new Error(`Validator list requiredSections paths in ${validatorPath} is empty`);
  }
  return {
    requiredEvidenceFiles: extractSingleQuotedValues(
      requiredEvidenceBlock,
      'requiredEvidenceFiles',
    ),
    citedEvidenceFiles: extractSingleQuotedValues(citedEvidenceBlock, 'citedEvidenceFiles'),
    requiredSectionPaths: sectionPaths,
  };
}

function resolveBoundedRelativePath(sourceRoot: string, rawRelativePath: string): string {
  const trimmed = rawRelativePath.trim();
  if (trimmed.length === 0 || isAbsolute(trimmed)) {
    throw new Error(`Invalid validator dependency path: ${rawRelativePath}`);
  }
  const resolvedRoot = resolve(sourceRoot);
  const resolvedTarget = resolve(resolvedRoot, trimmed);
  const relativeTarget = relative(resolvedRoot, resolvedTarget);
  if (
    relativeTarget.length === 0 ||
    relativeTarget.startsWith('..') ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error(`Validator dependency escapes source root: ${rawRelativePath}`);
  }
  return relativeTarget.replace(/\\/gu, '/');
}

/**
 * Derives the exact repository-relative paths read by `scripts/validate-phase0-gate.ts`.
 */
async function collectValidatorDependencies(sourceRoot: string): Promise<readonly string[]> {
  const inputs = await readValidatorInputs();
  const dependencies = new Set<string>();
  const addDependency = (rawPath: string): string => {
    const normalized = resolveBoundedRelativePath(sourceRoot, rawPath);
    dependencies.add(normalized);
    return normalized;
  };

  addDependency('AGENTS.md');
  const trackerRelativePath = addDependency('docs/TODO.md');
  for (const requiredPath of [...inputs.requiredEvidenceFiles, ...inputs.requiredSectionPaths]) {
    addDependency(requiredPath);
  }

  const citedRelativePaths = inputs.citedEvidenceFiles.map((filePath) => addDependency(filePath));
  const tracker = await readFile(resolve(sourceRoot, trackerRelativePath), 'utf8');
  for (const line of tracker.split(/\r?\n/u)) {
    const rowMatch = /^\|\s*(P0-(?:\d{3}|GATE))\s*\|/u.exec(line);
    const id = rowMatch?.[1];
    if (id === undefined || !phaseZeroIds.has(id)) continue;
    for (const evidenceMatch of line.matchAll(/`(docs\/[^`]+)`/gu)) {
      if (evidenceMatch[1] !== undefined) {
        addDependency(evidenceMatch[1]);
      }
    }
  }

  for (const citedPath of citedRelativePaths) {
    const evidence = await readFile(resolve(sourceRoot, citedPath), 'utf8');
    for (const citationMatch of evidence.matchAll(/`([^`\n]+\.(?:md|ts|sh)):(\d+)`/gu)) {
      if (citationMatch[1] !== undefined) {
        addDependency(citationMatch[1]);
      }
    }
  }

  return [...dependencies].sort();
}

async function copyBoundedDependency(
  sourceRoot: string,
  fixtureRoot: string,
  relativePath: string,
): Promise<void> {
  const sourcePath = resolve(sourceRoot, relativePath);
  const destinationPath = join(fixtureRoot, relativePath);
  const entryStat = await lstat(sourcePath);
  if (entryStat.isSymbolicLink()) {
    throw new Error(`Refusing symlink validator dependency: ${relativePath}`);
  }
  await mkdir(dirname(destinationPath), { recursive: true });
  if (entryStat.isDirectory()) {
    await cp(sourcePath, destinationPath, { recursive: true });
    return;
  }
  await copyFile(sourcePath, destinationPath);
}

async function createFixture(sourceRoot: string = repositoryRoot): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fcd-phase0-gate-'));
  temporaryRoots.push(root);
  const dependencies = await collectValidatorDependencies(sourceRoot);
  await Promise.all(
    dependencies.map(async (relativePath) => copyBoundedDependency(sourceRoot, root, relativePath)),
  );
  return root;
}

async function listRelativeFiles(root: string, prefix = ''): Promise<string[]> {
  const directory = prefix.length === 0 ? root : join(root, prefix);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativeEntry = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listRelativeFiles(root, relativeEntry)));
    } else {
      files.push(relativeEntry);
    }
  }
  return files.sort();
}

async function createSyntheticSourceRoot(options?: {
  readonly extraCitation?: string;
}): Promise<string> {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'fcd-phase0-source-'));
  temporaryRoots.push(sourceRoot);
  const writeRepoFile = async (relativePath: string, content: string): Promise<void> => {
    const targetPath = join(sourceRoot, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, 'utf8');
  };

  await writeRepoFile(
    'AGENTS.md',
    '# Synthetic Policy\n\nNo production launch until the smoke-gate tests pass.\n',
  );
  const phaseZeroRows = [...phaseZeroIds].map((id) => {
    if (id === 'P0-003') {
      return `| ${id} | Dynamic tracker target | None | Codex | COMPLETE | \`docs/decisions/dynamic-tracker-target.md\` | None |`;
    }
    if (id === 'P0-017') {
      return `| ${id} | Threat model | P0-003 | Codex | COMPLETE | \`docs/security/threat-model.md\` | None |`;
    }
    if (id === 'P0-018') {
      return `| ${id} | Acceptance matrix | P0-017 | Codex | COMPLETE | \`docs/testing/acceptance-matrix.md\` | None |`;
    }
    if (id === 'P0-GATE') {
      return `| ${id} | Phase 0 review | P0-018 | Owner | COMPLETE | \`docs/reviews/phase-0-gate.md\` \`docs/reviews/phase-0-gate-validation.md\` | Explicit |`;
    }
    return `| ${id} | Synthetic step | None | Codex | COMPLETE | Recorded | None |`;
  });
  await writeRepoFile(
    'docs/TODO.md',
    [
      '# Tracker',
      '| ID | Task | Depends On | Owner | Status | Evidence | Boundary |',
      '|---|---|---|---|---|---|---|',
      ...phaseZeroRows,
    ].join('\n'),
  );
  await writeRepoFile('docs/decisions/dynamic-tracker-target.md', '# Dynamic Tracker Target\n');
  await writeRepoFile(
    'src/dynamic-citation-target.ts',
    'export const line1 = 1;\nexport const line2 = 2;\n',
  );
  await writeRepoFile('tests/unrelated-synthetic.test.ts', '// should not be copied\n');
  await writeRepoFile(
    'docs/security/threat-model.md',
    [
      '# Threat Model',
      '## 1. Overview',
      '## 2. Threat Model, Trust Boundaries, And Assumptions',
      '## 3. Attack Surface, Mitigations, And Attacker Stories',
      '## 4. Severity Calibration',
      'Reference `AGENTS.md:3`.',
    ].join('\n\n'),
  );
  await writeRepoFile(
    'docs/testing/acceptance-matrix.md',
    [
      '# Acceptance Matrix',
      '## AGENTS.md Launch-Gate Matrix',
      '| ID | Gate |',
      '|---|---|',
      '| AC-01 | Smoke gate |',
      '## Security, Policy, And Operational Matrix',
    ].join('\n\n'),
  );
  await writeRepoFile(
    'docs/reviews/phase-0-gate.md',
    [
      '# Phase 0 Gate',
      'Authority scope: planning_only',
      'Production action authorization: false',
      '## Evidence Review',
      '## Exit-Gate Findings',
      '## Deferred Risks And Their Binding Gates',
      '## Gate Decision',
    ].join('\n\n'),
  );
  const citationLine = options?.extraCitation ?? '`src/dynamic-citation-target.ts:2`';
  await writeRepoFile(
    'docs/reviews/phase-0-gate-validation.md',
    `# Phase 0 Gate Validation\n\nCited target: ${citationLine}\n`,
  );
  return sourceRoot;
}

function runValidator(root: string): ValidationResult {
  const result = spawnSync(process.execPath, [validatorPath, '--repo-root', root], {
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('Phase 0 gate validator', () => {
  test('accepts padded Markdown table cells without changing gate authority', async () => {
    const root = await createFixture();
    const path = join(root, 'docs', 'TODO.md');
    const tracker = await readFile(path, 'utf8');
    await writeFile(path, tracker.replace(/\|/gu, '|   '));
    expect(runValidator(root)).toMatchObject({ status: 0, stderr: '' });
  });
  test('accepts the complete repository gate and all normalized launch-gate labels', () => {
    const result = runValidator(repositoryRoot);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('rejects an incomplete Phase 0 prerequisite', async () => {
    const root = await createFixture();
    const trackerPath = join(root, 'docs', 'TODO.md');
    const tracker = await readFile(trackerPath, 'utf8');
    await writeFile(
      trackerPath,
      tracker.replace(/^(\|\s*P0-018\s*\|(?:[^|]*\|){3}\s*)COMPLETE(\s*\|.*)$/m, '$1PENDING$2'),
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('P0-018 must be COMPLETE');
  });

  test('rejects a missing Phase 0 evidence artifact', async () => {
    const root = await createFixture();
    await rm(join(root, 'docs', 'security', 'threat-model.md'));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Tracker evidence file is missing: docs/security/threat-model.md (P0-017)',
    );
  });

  test('rejects a missing evidence path referenced by a Phase 0 tracker row', async () => {
    const root = await createFixture();
    const trackerPath = join(root, 'docs', 'TODO.md');
    const tracker = await readFile(trackerPath, 'utf8');
    await writeFile(
      trackerPath,
      tracker.replace(
        '`docs/decisions/0001-runtime-and-toolchain.md`',
        '`docs/decisions/missing.md`',
      ),
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Tracker evidence file is missing: docs/decisions/missing.md (P0-003)',
    );
  });

  test('rejects a threat model missing a required review section', async () => {
    const root = await createFixture();
    const threatPath = join(root, 'docs', 'security', 'threat-model.md');
    const threatModel = await readFile(threatPath, 'utf8');
    await writeFile(
      threatPath,
      threatModel.replace(
        '## 3. Attack Surface, Mitigations, And Attacker Stories',
        '## Attack Notes',
      ),
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Threat model is missing section: ## 3. Attack Surface, Mitigations, And Attacker Stories',
    );
  });

  test('rejects an acceptance matrix that omits an AGENTS launch gate', async () => {
    const root = await createFixture();
    const matrixPath = join(root, 'docs', 'testing', 'acceptance-matrix.md');
    const matrix = await readFile(matrixPath, 'utf8');
    const omittedGate = matrix.replace(
      /^(\|\s*AC-10\s*\|)\s*Model fallback\s*\|/mu,
      '$1 Provider routing |',
    );
    expect(omittedGate).not.toBe(matrix);
    await writeFile(matrixPath, omittedGate);

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Acceptance matrix does not map AGENTS.md gate: model fallback',
    );
  });

  test('rejects production-action authority at the Phase 0 planning gate', async () => {
    const root = await createFixture();
    const reviewPath = join(root, 'docs', 'reviews', 'phase-0-gate.md');
    const review = await readFile(reviewPath, 'utf8');
    const unsafeReview = review.includes('Production action authorization: false')
      ? review.replace(
          'Production action authorization: false',
          'Production action authorization: true',
        )
      : `${review}\nProduction action authorization: true\n`;
    await writeFile(reviewPath, unsafeReview);

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Production action authorization must be false');
  });

  test('rejects a source citation whose line is outside the referenced file', async () => {
    const root = await createFixture();
    const threatPath = join(root, 'docs', 'security', 'threat-model.md');
    const threatModel = await readFile(threatPath, 'utf8');
    await writeFile(threatPath, threatModel.replace('`AGENTS.md:14`', '`AGENTS.md:9999`'));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Citation out of range: AGENTS.md:9999');
  });

  test('copies only validator-required inputs and citations instead of unrelated repository trees', async () => {
    const expectedDependencies = await collectValidatorDependencies(repositoryRoot);
    const root = await createFixture();
    const copiedFiles = await listRelativeFiles(root);

    expect(runValidator(root)).toMatchObject({ status: 0, stderr: '' });
    expect(copiedFiles).toEqual(expectedDependencies);
    expect(copiedFiles.length).toBeLessThan(60);

    for (const requiredPath of [
      'AGENTS.md',
      'README.md',
      'docs/TODO.md',
      'docs/decisions/0001-runtime-and-toolchain.md',
      'docs/reviews/phase-0-gate-validation.md',
      'scripts/validate-phase0-gate.ts',
      'tests/phase0-gate-validator.test.ts',
    ]) {
      expect(copiedFiles).toContain(requiredPath);
    }

    for (const unrelatedPath of [
      'docs/PLAN.md',
      'src/main.ts',
      'tests/admin-app.test.ts',
      'tests/operations-scripts.test.ts',
    ]) {
      await expect(access(join(root, unrelatedPath))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  test('dynamically includes tracker and citation targets and fails when a required target is missing', async () => {
    const sourceRoot = await createSyntheticSourceRoot();
    const boundedRoot = await createFixture(sourceRoot);
    const copiedFiles = await listRelativeFiles(boundedRoot);

    expect(runValidator(boundedRoot)).toMatchObject({ status: 0, stderr: '' });
    expect(copiedFiles).toContain('docs/decisions/dynamic-tracker-target.md');
    expect(copiedFiles).toContain('src/dynamic-citation-target.ts');
    await expect(
      access(join(boundedRoot, 'tests/unrelated-synthetic.test.ts')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await rm(join(sourceRoot, 'src/dynamic-citation-target.ts'));
    await expect(createFixture(sourceRoot)).rejects.toMatchObject({ code: 'ENOENT' });

    await writeFile(
      join(sourceRoot, 'src/dynamic-citation-target.ts'),
      'export const line1 = 1;\nexport const line2 = 2;\n',
      'utf8',
    );
    await rm(join(sourceRoot, 'docs/decisions/dynamic-tracker-target.md'));
    await expect(createFixture(sourceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('rejects citation targets that escape the source repository root', async () => {
    const escapingSource = await createSyntheticSourceRoot({
      extraCitation: '`../outside-repo.ts:1`',
    });

    await expect(createFixture(escapingSource)).rejects.toThrow(/escapes source root/u);
  });
});
