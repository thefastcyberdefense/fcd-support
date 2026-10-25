import { expect, test } from 'vitest';
import {
  bindOperationConnectionString,
  operationApplicationName,
} from '../src/operations/operation-reference.js';
import { loadRoleEnvironment } from '../src/operations/secret-files.js';

const reference = `operation_${'a'.repeat(32)}`;
const uri = 'postgresql://fcd_support_test@database.invalid/fcd_support_test';

test('operation connection reference overrides URI spoofing without changing database or other parameters', () => {
  const source = new URL(
    uri + '?application_name=synthetic_untracked&application_name=duplicate&connect_timeout=3',
  );
  const target = new URL(bindOperationConnectionString(source.toString(), reference));
  expect(target.searchParams.getAll('application_name')).toEqual([
    operationApplicationName(reference),
  ]);
  expect(target.searchParams.get('connect_timeout')).toBe('3');
  expect(target.pathname).toBe(source.pathname);
  expect(target.username).toBe(source.username);
  expect(target.hostname).toBe(source.hostname);
  expect(Buffer.byteLength(operationApplicationName(reference), 'utf8')).toBeLessThanOrEqual(63);
});

test('legacy direct invocation preserves its connection string when no operation reference exists', () => {
  expect(
    bindOperationConnectionString(uri + '?application_name=synthetic_existing', undefined),
  ).toBe(uri + '?application_name=synthetic_existing');
});

test('operation connection fixes startup options after existing namespace and spoofed name options', () => {
  const source = new URL(uri);
  source.searchParams.set(
    'options',
    '-c search_path=synthetic_scope -c application_name=synthetic_spoofed',
  );
  const target = new URL(bindOperationConnectionString(source.toString(), reference));
  expect(target.searchParams.get('options')).toBe(
    `-c search_path=synthetic_scope -c application_name=synthetic_spoofed -c application_name=${operationApplicationName(reference)}`,
  );
  expect(bindOperationConnectionString(target.toString(), reference)).toBe(target.toString());
});

test.each([
  '',
  `operation_${'A'.repeat(32)}`,
  `operation_${'a'.repeat(31)}`,
  `operation_${'a'.repeat(33)}`,
  'operation_synthetic\n',
])('operation reference rejects malformed %j with a closed error', (invalid) => {
  expect(() => {
    bindOperationConnectionString(uri, invalid);
  }).toThrow(/^operation_reference_invalid$/u);
});

test.each([
  'https://database.invalid/fcd_support_test',
  uri + '#synthetic_fragment',
  'synthetic_invalid_uri',
])('tracked connection rejects invalid URI without exposing it', (invalid) => {
  expect(() => {
    bindOperationConnectionString(invalid, reference);
  }).toThrow(/^operation_reference_invalid$/u);
});

test('operation secret loading labels the non-enumerable database URI', async () => {
  const result = await loadRoleEnvironment('migrate', {
    NODE_ENV: 'test',
    DATABASE_URL: uri,
    OPS_OPERATION_REFERENCE: reference,
  });
  expect(new URL(result.DATABASE_URL ?? '').searchParams.get('application_name')).toBe(
    operationApplicationName(reference),
  );
  expect(Object.keys(result)).not.toContain('DATABASE_URL');
  expect(JSON.stringify(result)).not.toContain('database.invalid');
});

test('runtime actors refuse an operation reference before reading credentials', async () => {
  let reads = 0;
  await expect(
    loadRoleEnvironment('webhook', { OPS_OPERATION_REFERENCE: reference }, () => {
      reads += 1;
      return Promise.reject(new Error('synthetic_unexpected_read'));
    }),
  ).rejects.toThrow(/^operation_reference_invalid$/u);
  expect(reads).toBe(0);
});
