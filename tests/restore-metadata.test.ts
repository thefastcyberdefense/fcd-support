import { expect, test } from 'vitest';
import { transformRestoreMetadata } from '../src/operations/restore-metadata-main.js';
import { parseRestoreCommand } from '../src/operations/restore-command.js';

const host = {
  projectName: 'fcd-support-restore-synthetic',
  volumeName: 'fcd-support-restore-synthetic-data',
  volumeCreatedAt: '2030-01-01T00:00:00.000Z',
  networkId: 'a'.repeat(64),
  postgresImageId: `sha256:${'b'.repeat(64)}`,
  runtimeImageId: `sha256:${'c'.repeat(64)}`,
};
const metadata = {
  ...host,
  systemIdentifier: '7300000000000000001',
  databaseName: 'fcd_support_test',
  schema: 'public',
  gitRevision: 'd'.repeat(40),
  schemaRevision: '000016',
};
const encoded = Buffer.from(JSON.stringify(metadata)).toString('base64');
const args = [
  'encode',
  '7300000000000000001',
  'fcd_support_test',
  'public',
  'd'.repeat(40),
  '000016',
];

test('canonical restore metadata preserves an explicit Docker timezone offset', () => {
  const offsetHost = { ...host, volumeCreatedAt: '2030-01-01T06:00:00+06:00' };
  expect(
    transformRestoreMetadata(['decode-host', transformRestoreMetadata(args, offsetHost)]),
  ).toBe(JSON.stringify(offsetHost));
});

test('encodes strict host identity into the existing canonical restore command metadata', () => {
  const actual = transformRestoreMetadata(args, { ...host });
  expect(actual).toBe(encoded);
  expect(
    parseRestoreCommand([
      'restore',
      `restore_${'a'.repeat(32)}`,
      `backup_${'b'.repeat(32)}`,
      `checkpoint_${'c'.repeat(32)}`,
      actual,
    ]),
  ).toMatchObject({
    target: {
      ...host,
      systemIdentifier: '7300000000000000001',
      databaseName: 'fcd_support_test',
      schema: 'public',
    },
    gitRevision: 'd'.repeat(40),
    schemaRevision: '000016',
  });
});

test('decodes only closed literal fields and canonical host JSON', () => {
  expect(transformRestoreMetadata(['decode-host', encoded])).toBe(JSON.stringify(host));
  expect(transformRestoreMetadata(['decode-fields', encoded])).toBe(
    [
      'TARGET_PROJECT=fcd-support-restore-synthetic',
      'TARGET_VOLUME=fcd-support-restore-synthetic-data',
      'TARGET_SYSTEM_IDENTIFIER=7300000000000000001',
      'TARGET_DATABASE_NAME=fcd_support_test',
      'TARGET_SCHEMA=public',
      `TARGET_APP_IMAGE=sha256:${'c'.repeat(64)}`,
      `TARGET_PG_IMAGE=sha256:${'b'.repeat(64)}`,
      `TARGET_REVISION=${'d'.repeat(40)}`,
      'TARGET_SCHEMA_REVISION=000016',
    ].join('\n'),
  );
});

test.each([
  { args: [...args.slice(0, 1), '18446744073709551616', ...args.slice(2)], input: host },
  { args, input: { ...host, unexpected: 'synthetic_private' } },
  { args, input: { ...host, volumeName: 'fcd-support-synthetic-wrong' } },
  { args: ['decode-fields', encoded + '\n'] },
  {
    args: [
      'decode-fields',
      Buffer.from(
        JSON.stringify(
          Object.fromEntries([['schemaRevision', '000016'], ...Object.entries(metadata)]),
        ),
      ).toString('base64'),
    ],
  },
  { args: ['decode-host', Buffer.from([0xff]).toString('base64')] },
  { args: ['decode-host', Buffer.from(' '.repeat(4097)).toString('base64')] },
  { args: ['decode-host', encoded, 'synthetic_extra'] },
])('rejects invalid metadata with only a fixed error', (fixture) => {
  expect(() => transformRestoreMetadata(fixture.args, fixture.input)).toThrow(
    /^restore_metadata_invalid$/u,
  );
});
