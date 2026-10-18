import { expect, test } from 'vitest';
import { selectBackupPruneCandidates } from '../src/operations/backup-retention.js';
import type { BackupManifest } from '../src/operations/backup.js';

const at = new Date('2030-08-01T00:00:00.000Z');
function entry(input: readonly BackupManifest[], index: number): BackupManifest {
  const value = input[index];
  if (value === undefined) throw new Error('synthetic_manifest_missing');
  return value;
}
function manifest(index: number, backupClass: BackupManifest['class'], date: Date): BackupManifest {
  return {
    backupRef: `backup_${index.toString(16).padStart(32, '0')}`,
    createdAt: date.toISOString(),
    class: backupClass,
    gitRevision: 'a'.repeat(40),
    schemaRevision: '000014',
    ciphertextBytes: 100,
    ciphertextSha256: 'b'.repeat(64),
    state: 'verified',
    signature: 'c'.repeat(64),
  };
}
function archives(): BackupManifest[] {
  return [
    ...Array.from({ length: 46 }, (_, i) =>
      manifest(i, 'daily', new Date(Date.UTC(2030, 6, 31 - i))),
    ),
    ...Array.from({ length: 7 }, (_, i) =>
      manifest(100 + i, 'monthly', new Date(Date.UTC(2030, 6 - i, 1))),
    ),
  ];
}
test('keeps independent daily/monthly minimums and the last full restore proof', () => {
  const input = archives();
  input[44] = { ...entry(input, 44), state: 'restore_verified' };
  expect(selectBackupPruneCandidates(input, { daily: 45, monthly: 6 }, at)).toEqual([
    entry(input, 45).backupRef,
    entry(input, 52).backupRef,
  ]);
});
test.each([
  { daily: 44, monthly: 6 },
  { daily: 45, monthly: 5 },
])('rejects a retention policy below either approved minimum: %j', (policy) => {
  expect(() => selectBackupPruneCandidates(archives(), policy, at)).toThrow(
    'backup_retention_invalid',
  );
});
test('preserves an old sole restore-verified archive even outside both windows', () => {
  const input = archives();
  input[45] = { ...entry(input, 45), state: 'restore_verified' };
  expect(selectBackupPruneCandidates(input, { daily: 45, monthly: 6 }, at)).toEqual([
    entry(input, 52).backupRef,
  ]);
});
test.each(['created', 'failed'] as const)(
  'does not prune when the latest archive is %s',
  (state) => {
    const input = archives();
    input[0] = { ...entry(input, 0), state };
    expect(selectBackupPruneCandidates(input, { daily: 45, monthly: 6 }, at)).toEqual([]);
  },
);
test('duplicate daily archives cannot replace a missing UTC day', () => {
  const input = archives();
  input[45] = { ...entry(input, 45), createdAt: entry(input, 44).createdAt };
  expect(selectBackupPruneCandidates(input, { daily: 46, monthly: 6 }, at)).toEqual([]);
});
test('monthly retention counts UTC calendar months, not elapsed thirty-day periods', () => {
  const input = archives();
  input[52] = { ...entry(input, 52), createdAt: '2030-02-28T23:59:59.999Z' };
  expect(selectBackupPruneCandidates(input, { daily: 45, monthly: 7 }, at)).toEqual([]);
});
test('pre-migration copies never satisfy scheduled quotas or get auto-pruned', () => {
  const input = archives().map((entry) => ({ ...entry, class: 'pre_migration' as const }));
  expect(selectBackupPruneCandidates(input, { daily: 45, monthly: 6 }, at)).toEqual([]);
});
test.each(['duplicate', 'future', 'traversal', 'invalid_date'])(
  'rejects unsafe catalog input: %s',
  (kind) => {
    const input = archives();
    if (kind === 'duplicate') input.push(entry(input, 0));
    if (kind === 'future') input[0] = { ...entry(input, 0), createdAt: '2031-01-01T00:00:00.000Z' };
    if (kind === 'traversal') input[0] = { ...entry(input, 0), backupRef: '../synthetic' };
    if (kind === 'invalid_date') input[0] = { ...entry(input, 0), createdAt: 'invalid' };
    expect(() => selectBackupPruneCandidates(input, { daily: 45, monthly: 6 }, at)).toThrow(
      'backup_retention_invalid',
    );
  },
);
