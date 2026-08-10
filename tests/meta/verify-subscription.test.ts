import { describe, expect, test } from 'vitest';

import { verifyMetaSubscription } from '../../src/meta/verify-subscription.js';

describe('verifyMetaSubscription', () => {
  test('returns the challenge only for a matching subscribe request', () => {
    const result = verifyMetaSubscription(
      {
        'hub.challenge': '123456789',
        'hub.mode': 'subscribe',
        'hub.verify_token': 'test_verify_token',
      },
      'test_verify_token',
    );

    expect(result).toEqual({ ok: true, challenge: '123456789' });
  });

  test.each([
    {
      name: 'wrong token',
      query: {
        'hub.challenge': '123456789',
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong_token',
      },
    },
    {
      name: 'wrong mode',
      query: {
        'hub.challenge': '123456789',
        'hub.mode': 'unsubscribe',
        'hub.verify_token': 'test_verify_token',
      },
    },
    {
      name: 'missing challenge',
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'test_verify_token',
      },
    },
  ])('rejects $name', ({ query }) => {
    const result = verifyMetaSubscription(query, 'test_verify_token');

    expect(result).toEqual({ ok: false, statusCode: 403 });
  });
});
