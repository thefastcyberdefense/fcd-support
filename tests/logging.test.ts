import { describe, expect, test } from 'vitest';

import { createSafeLogger, type SafeLogContext } from '../src/logging.js';

describe('privacy-safe structured logging', () => {
  test('emits only allowlisted fields', () => {
    const lines: string[] = [];
    const logger = createSafeLogger({
      now: () => new Date('2026-08-11T00:00:00.000Z'),
      write: (line) => lines.push(line),
    });
    const context = {
      eventCount: 2,
      requestId: 'req-1',
      statusCode: 200,
      rawBody: 'SYNTHETIC_CUSTOMER_CONTENT_MUST_NOT_APPEAR',
      token: 'SYNTHETIC_TOKEN_MUST_NOT_APPEAR',
    } as SafeLogContext;

    logger.info('meta_webhook_accepted', context);

    expect(lines).toEqual([
      JSON.stringify({
        timestamp: '2026-08-11T00:00:00.000Z',
        level: 'info',
        event: 'meta_webhook_accepted',
        requestId: 'req-1',
        statusCode: 200,
        eventCount: 2,
      }),
    ]);
    expect(lines[0]).not.toContain('SYNTHETIC_CUSTOMER_CONTENT_MUST_NOT_APPEAR');
    expect(lines[0]).not.toContain('SYNTHETIC_TOKEN_MUST_NOT_APPEAR');
  });

  test('does not serialize arbitrary reasons', () => {
    const lines: string[] = [];
    const logger = createSafeLogger({ write: (line) => lines.push(line) });

    logger.warn('meta_webhook_rejected', {
      reason: 'SYNTHETIC_CUSTOMER_CONTENT_MUST_NOT_APPEAR',
    } as unknown as SafeLogContext);

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('SYNTHETIC_CUSTOMER_CONTENT_MUST_NOT_APPEAR');
  });
});
