import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import {
  parsePhase4Evaluation,
  scorePhase4Evaluation,
} from '../src/evaluation/phase4-evaluation.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/phase4-evaluation.json', import.meta.url), 'utf8'),
) as unknown;

describe('Phase 4 bilingual evaluation gate', () => {
  test('passes the reviewed synthetic fixture at every invariant and quality threshold', () => {
    const corpus = parsePhase4Evaluation(fixture);
    const result = scorePhase4Evaluation(corpus);

    expect(result.status).toBe('pass');
    expect(result.totalCases).toBeGreaterThanOrEqual(30);
    expect(result.languages.bn).toBeGreaterThan(0);
    expect(result.languages.en).toBeGreaterThan(0);
    expect(Object.keys(result.acceptanceItems).sort()).toEqual([
      'AC-05',
      'AC-10',
      'AC-21',
      'AC-22',
      'AC-25',
    ]);
    expect(Object.values(result.acceptanceItems).every((count) => count > 0)).toBe(true);
    expect(Object.values(result.invariantRates)).toEqual(
      expect.arrayContaining([1, 1, 1, 1, 1, 1, 1]),
    );
    expect(Object.values(result.invariantRates).every((rate) => rate === 1)).toBe(true);
    expect(result.generative.acceptableRate).toBeGreaterThanOrEqual(0.9);
    expect(result.criticalFailures).toBe(0);
  });

  test('fails below the 90 percent generative threshold', () => {
    const corpus = parsePhase4Evaluation(fixture);
    let changed = 0;
    const cases = corpus.cases.map((item) => {
      if (item.generativeRating !== 'acceptable' || changed >= 2) return item;
      changed += 1;
      return { ...item, generativeRating: 'unacceptable' as const };
    });
    const result = scorePhase4Evaluation({ ...corpus, cases });
    expect(result.status).toBe('fail');
    expect(result.failureReasons).toContain('generative_threshold');
  });

  test('fails any critical outcome even when aggregate quality remains high', () => {
    const corpus = parsePhase4Evaluation(fixture);
    const first = corpus.cases[0];
    if (first === undefined) throw new Error('Synthetic evaluation fixture is empty');
    const result = scorePhase4Evaluation({
      ...corpus,
      cases: [{ ...first, criticalFailure: true }, ...corpus.cases.slice(1)],
    });
    expect(result.status).toBe('fail');
    expect(result.failureReasons).toContain('critical_failure');
  });

  test('fails one missing required invariant without averaging it away', () => {
    const corpus = parsePhase4Evaluation(fixture);
    const target = corpus.cases.find((item) => item.requiredInvariants.length > 0);
    if (target === undefined) throw new Error('Synthetic invariant case missing');
    const failedInvariant = target.requiredInvariants[0];
    if (failedInvariant === undefined) throw new Error('Synthetic invariant missing');
    const cases = corpus.cases.map((item) =>
      item.id === target.id
        ? {
            ...item,
            passedInvariants: item.passedInvariants.filter(
              (invariant) => invariant !== failedInvariant,
            ),
          }
        : item,
    );
    const result = scorePhase4Evaluation({ ...corpus, cases });
    expect(result.status).toBe('fail');
    expect(result.failureReasons).toContain(`invariant:${failedInvariant}`);
  });

  test('rejects copied-live or incomplete fixture provenance', () => {
    expect(() =>
      parsePhase4Evaluation({
        ...(fixture as Record<string, unknown>),
        provenance: 'copied_external_data',
      }),
    ).toThrow('Phase 4 evaluation corpus is invalid');
  });
});
