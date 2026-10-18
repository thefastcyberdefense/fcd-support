import { expect, test } from 'vitest';
import { createHmac } from 'node:crypto';
import { validateCheckpointManifest } from '../src/operations/deletion-checkpoint.js';
import { AdminSecretBytes } from '../src/admin/admin-types.js';

const now = new Date('2030-02-01T00:00:00.000Z');
const watermark = { sourceEpoch: '00000000-0000-4000-8000-000000000000', sequence: '1' };
const signingKey = new AdminSecretBytes(Buffer.from('synthetic_checkpoint_signing_key_'.repeat(2)));
const material = {
  checkpointRef: `checkpoint_${'a'.repeat(32)}`,
  sourceRevision: 'a'.repeat(40),
  schemaRevision: '000015',
  snapshotAt: now.toISOString(),
  validUntil: null as string | null,
  watermark,
  rowCount: 1,
  requiredKeyVersions: ['synthetic-v1'],
  ciphertextBytes: 100,
  ciphertextSha256: 'b'.repeat(64),
};
function signed(input: typeof material) {
  const signature = createHmac('sha256', signingKey.copy())
    .update('fcd-support:deletion-checkpoint:v1\n')
    .update(JSON.stringify(input))
    .digest('hex');
  return { ...input, signature };
}
test('accepts a signed manifest only when its trusted current watermark and age match', () => {
  const result = validateCheckpointManifest(signed(material), {
    signingKey,
    expectedWatermark: watermark,
    evaluatedAt: now,
    maximumAgeMilliseconds: 60000,
  });
  expect(result.rowCount).toBe(1);
  expect(result.requiredKeyVersions).toEqual(['synthetic-v1']);
});
test('the next tombstone time boundary invalidates an otherwise unchanged source watermark', () => {
  const manifest = signed({ ...material, validUntil: '2030-02-01T00:00:01.000Z' });
  expect(() =>
    validateCheckpointManifest(manifest, {
      signingKey,
      expectedWatermark: watermark,
      evaluatedAt: new Date('2030-02-01T00:00:01.000Z'),
      maximumAgeMilliseconds: 60000,
    }),
  ).toThrow('checkpoint_invalid');
});
test.each([
  'missing',
  'stale',
  'future',
  'watermark',
  'signature',
  'count',
  'key_versions',
  'traversal',
])('rejects unproven checkpoint completeness: %s', (kind) => {
  const altered = {
    ...material,
    ...(kind === 'stale' ? { snapshotAt: '2030-01-01T00:00:00.000Z' } : {}),
    ...(kind === 'future' ? { snapshotAt: '2031-01-01T00:00:00.000Z' } : {}),
    ...(kind === 'watermark' ? { watermark: { ...watermark, sequence: '0' } } : {}),
    ...(kind === 'count' ? { rowCount: -1 } : {}),
    ...(kind === 'key_versions' ? { requiredKeyVersions: ['synthetic-v1', 'synthetic-v1'] } : {}),
    ...(kind === 'traversal' ? { checkpointRef: '../synthetic' } : {}),
  };
  const manifest = {
    ...signed(altered),
    ...(kind === 'signature' ? { signature: 'd'.repeat(64) } : {}),
  };
  expect(() =>
    validateCheckpointManifest(kind === 'missing' ? undefined : manifest, {
      signingKey,
      expectedWatermark: watermark,
      evaluatedAt: now,
      maximumAgeMilliseconds: 60000,
    }),
  ).toThrow('checkpoint_invalid');
});
