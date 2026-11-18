import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  collectDbCounts,
  dbCountsOutputSchema,
  dbCountsReportSchema,
} from '../src/operations/db-counts.js';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';

describe('content-free db-counts contract (Gap G-3)', () => {
  test('accepts strictly integer and closed snake_case enum aggregates', () => {
    const sample = {
      status: 'completed',
      dbCounts: {
        webhookReceipts: { total: 2 },
        webhookEvents: { total: 2, byAdmissionOutcome: { pending: 1, stale: 1 } },
        webhookEventAttachments: {
          total: 1,
          byStatus: { extracted: 1 },
          byKind: { pdf_text: 0, document: 1 },
        },
        webhookEventApplications: { total: 1, byOutcome: { customer_message_applied: 1 } },
        runtimeProcessingWork: { total: 1, byState: { completed: 1 }, byStage: { decide: 1 } },
        supportReplyDrafts: {
          total: 1,
          byDecisionType: { faq: 1 },
          byLanguage: { en: 1 },
          byState: { ready: 1 },
        },
        supportEscalationOutcomes: { total: 0, byState: {}, byReasonCode: {} },
        knowledgeGapObservations: { total: 0 },
        modelCallLeases: { total: 0, byState: {} },
        outboundIntents: { total: 1, byState: { sent: 1 } },
        outboundAttempts: { total: 1, byState: { provider_accepted: 1 } },
        privacyRequests: { total: 0, byType: {}, byState: {} },
        privacySuppressions: { total: 0, byCategory: {} },
        humanPauseEvents: { total: 0, byAction: {}, byActorKind: {} },
        knowledgeVersions: { total: 1, byState: { approved: 1 } },
        knowledgePublicationEvents: { total: 1, byAction: { publish: 1 } },
        modelPolicyVersions: { total: 1, byState: { active: 1 } },
        outboundPolicyVersions: { total: 1, byState: { active: 1 } },
        operationsDeployments: { total: 1, byStatus: { succeeded: 1 } },
      },
    };
    expect(dbCountsOutputSchema.parse(sample)).toEqual(sample);
  });

  test('rejects customer text, non-integer values, or unexpected fields', () => {
    const invalid = {
      webhookReceipts: { total: '2' },
    };
    expect(() => dbCountsReportSchema.parse(invalid)).toThrow();
    expect(() =>
      dbCountsOutputSchema.parse({
        status: 'completed',
        dbCounts: {},
        extraField: 'customer_secret',
      }),
    ).toThrow();
  });

  test('collectDbCounts uses a READ ONLY transaction and rejects non-snake_case group labels', async () => {
    const queries: string[] = [];
    const fakeClient = {
      query: (sql: string) => {
        queries.push(sql);
        if (sql === 'begin read only' || sql === 'commit' || sql === 'rollback') {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [{ k1: 'UNSAFE CLIENT TEXT!', c: 1 }] });
      },
      release: () => undefined,
    };
    const fakePool = {
      connect: () => Promise.resolve(fakeClient),
    };
    await expect(
      collectDbCounts(fakePool as never, { maximumCallMilliseconds: 1000 }),
    ).rejects.toThrow();
    expect(queries[0]).toBe('begin read only');
    expect(queries.at(-1)).toBe('rollback');
  });

  test('run-db-counts.sh validates arguments and bounded job acknowledgement contract', () => {
    const badArgs = spawnSync(
      bash,
      ['scripts/run-db-counts.sh', 'bad-rev', '/synthetic/ops.conf'],
      {
        encoding: 'utf8',
        timeout: 4000,
      },
    );
    expect(badArgs.status).toBe(1);
    expect(badArgs.stderr.trim()).toBe('operations_arguments_invalid');

    const ackCheck = spawnSync(
      bash,
      [
        '--noprofile',
        '--norc',
        '-c',
        `
source "$TASK_LIFECYCLE"
OPS_JOB_SERVICE=maintenance
operations_job_command maintenance db-counts
operations_job_acknowledgement '{"status":"completed","dbCounts":{"webhookReceipts":{"total":1}}}'
! operations_job_acknowledgement '{"status":"completed","dbCounts":{"note":"SYNTHETIC PEEK!"}}'
`,
      ],
      {
        encoding: 'utf8',
        timeout: 4000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TASK_LIFECYCLE: resolve('scripts/operations-job-lifecycle.sh').replaceAll('\\', '/'),
        },
      },
    );
    expect(ackCheck.status, ackCheck.stderr).toBe(0);
  });
});
