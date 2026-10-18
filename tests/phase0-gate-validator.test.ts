import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const validatorPath = join(repositoryRoot, 'scripts', 'validate-phase0-gate.ts');
const temporaryRoots: string[] = [];

interface ValidationResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fcd-phase0-gate-'));
  temporaryRoots.push(root);
  await cp(join(repositoryRoot, 'docs'), join(root, 'docs'), { recursive: true });
  await cp(join(repositoryRoot, 'AGENTS.md'), join(root, 'AGENTS.md'));
  await cp(join(repositoryRoot, 'README.md'), join(root, 'README.md'));
  for (const directory of ['migrations', 'scripts', 'src', 'tests']) {
    await cp(join(repositoryRoot, directory), join(root, directory), { recursive: true });
  }
  return root;
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
});
