import { expect, test } from 'vitest';
import { parseBootstrapCommand } from '../src/operations/bootstrap-main.js';

test('bootstrap settlement inspection accepts only an operation reference and physical cluster identity', () => {
  expect(
    parseBootstrapCommand([
      'inspect-settlement',
      `operation_${'a'.repeat(32)}`,
      '1234567890123456789',
    ]),
  ).toEqual({
    phase: 'inspect-settlement',
    reference: `operation_${'a'.repeat(32)}`,
    systemIdentifier: '1234567890123456789',
  });
});

test.each(
  [
    ['inspect-settlement'],
    ['inspect-settlement', `operation_${'a'.repeat(32)}`, '0'],
    ['inspect-settlement', 'synthetic_invalid', '123'],
    ['inspect-settlement', `operation_${'a'.repeat(32)}`, '123', 'extra'],
  ].map((args) => ({ args })),
)('settlement command refuses ambiguous arguments %#', ({ args }) => {
  expect(() => parseBootstrapCommand(args)).toThrow(/^runtime_bootstrap_invalid$/u);
});

test.each(['prepare', 'converge'] as const)(
  'bootstrap %s requires an explicit cluster and protected directory reference',
  (phase) => {
    expect(parseBootstrapCommand([phase, '1234567890123456789', '/run/secrets'])).toEqual({
      phase,
      systemIdentifier: '1234567890123456789',
      passwordDirectory: '/run/secrets',
    });
  },
);
test.each(
  [
    [],
    ['prepare'],
    ['prepare', '123', '/run/secrets', 'unexpected'],
    ['automatic', '123', '/run/secrets'],
    ['prepare', '0', '/run/secrets'],
    ['prepare', '18446744073709551616', '/run/secrets'],
    ['prepare', '123', 'relative'],
    ['prepare', '123', '/run/../secrets'],
    ['prepare', '123', '/'],
    ['prepare', '123', '/run/secrets/'],
    ['prepare', '123', '/run/secrets\0ignored'],
  ].map((args) => ({ args })),
)('bootstrap refuses ambiguous command %# before any secret or database access', ({ args }) => {
  expect(() => parseBootstrapCommand(args)).toThrow(/^runtime_bootstrap_invalid$/u);
});
