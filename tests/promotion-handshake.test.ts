import { PassThrough } from 'node:stream';
import { expect, test, vi } from 'vitest';
import { createPromotionHandshake } from '../src/operations/promotion-handshake.js';

const operationRef = `operation_${'a'.repeat(32)}`;
function fixture(reply?: (request: Record<string, unknown>, input: PassThrough) => void) {
  const input = new PassThrough();
  const requests: Record<string, unknown>[] = [];
  let random = 0;
  const handshake = createPromotionHandshake({
    operationRef,
    input,
    timeoutMilliseconds: 100,
    challenge: () => (++random).toString(16).padStart(32, '0'),
    write: (line) => {
      const request = JSON.parse(line) as Record<string, unknown>;
      requests.push(request);
      reply?.(request, input);
    },
  });
  return { input, requests, handshake };
}
const acknowledgement = (request: Record<string, unknown>) =>
  JSON.stringify({ ...request, event: 'promotion_host_verified' }) + '\n';

test('promotion handshake requires two fresh matching canonical challenges and releases listeners', async () => {
  const f = fixture((request, input) => {
    const bytes = Buffer.from(acknowledgement(request));
    input.write(bytes.subarray(0, 13));
    input.write(bytes.subarray(13));
  });
  await expect(f.handshake.assertQuiesced(new AbortController().signal)).resolves.toBeUndefined();
  expect(() => {
    f.handshake.assertComplete();
  }).toThrow('promotion_handshake_failed');
  await expect(f.handshake.assertQuiesced(new AbortController().signal)).resolves.toBeUndefined();
  expect(f.requests).toEqual(
    [1, 2].map((sequence) => ({
      event: 'promotion_host_check',
      operationRef,
      sequence,
      challenge: sequence.toString(16).padStart(32, '0'),
    })),
  );
  expect(() => {
    f.handshake.assertComplete();
  }).not.toThrow();
  await expect(f.handshake.assertQuiesced(new AbortController().signal)).rejects.toThrow(
    'promotion_handshake_failed',
  );
  f.handshake.close();
  expect(f.input.listenerCount('data')).toBe(0);
  expect(f.input.listenerCount('error')).toBe(0);
});

test.each([
  'wrong-operation',
  'wrong-sequence',
  'wrong-challenge',
  'extra-field',
  'whitespace',
  'bom',
  'duplicate-line',
  'oversized',
  'utf8',
] as const)('promotion handshake refuses %s without accepting a host assertion', async (mode) => {
  const f = fixture((request, input) => {
    let line = acknowledgement(request);
    if (mode === 'wrong-operation')
      line = acknowledgement({ ...request, operationRef: `operation_${'b'.repeat(32)}` });
    if (mode === 'wrong-sequence') line = acknowledgement({ ...request, sequence: 2 });
    if (mode === 'wrong-challenge')
      line = acknowledgement({ ...request, challenge: 'f'.repeat(32) });
    if (mode === 'extra-field') line = acknowledgement({ ...request, ready: true });
    if (mode === 'whitespace') line = ` ${line}`;
    if (mode === 'bom') line = `\uFEFF${line}`;
    if (mode === 'duplicate-line') line += line;
    if (mode === 'oversized') line = ' '.repeat(1025);
    input.write(mode === 'utf8' ? Buffer.from([0xff, 0x0a]) : Buffer.from(line));
  });
  await expect(f.handshake.assertQuiesced(new AbortController().signal)).rejects.toThrow(
    'promotion_handshake_failed',
  );
  expect(() => {
    f.handshake.assertComplete();
  }).toThrow('promotion_handshake_failed');
  f.handshake.close();
});

test('promotion handshake refuses unsolicited input and replayed acknowledgements', async () => {
  const unsolicited = fixture();
  unsolicited.input.write(Buffer.from('{}\n'));
  await expect(unsolicited.handshake.assertQuiesced(new AbortController().signal)).rejects.toThrow(
    'promotion_handshake_failed',
  );
  expect(unsolicited.requests).toEqual([]);
  unsolicited.handshake.close();
  let first: string | undefined;
  const replay = fixture((request, input) => {
    first ??= acknowledgement(request);
    input.write(Buffer.from(first));
  });
  await replay.handshake.assertQuiesced(new AbortController().signal);
  await expect(replay.handshake.assertQuiesced(new AbortController().signal)).rejects.toThrow(
    'promotion_handshake_failed',
  );
  replay.handshake.close();
});

test.each(['deadline', 'partial', 'aborted', 'ended', 'write-failed'] as const)(
  'promotion handshake bounds %s and cannot reuse a failed session',
  async (mode) => {
    vi.useFakeTimers();
    try {
      const f = fixture((_request, input) => {
        if (mode === 'partial') input.write(Buffer.from('{'));
        if (mode === 'ended') input.end();
        if (mode === 'write-failed') throw new Error('synthetic_host_write_secret');
      });
      const abort = new AbortController();
      const waiting = expect(f.handshake.assertQuiesced(abort.signal)).rejects.toThrow(
        'promotion_handshake_failed',
      );
      if (mode === 'aborted') abort.abort();
      await vi.runAllTimersAsync();
      await waiting;
      await expect(f.handshake.assertQuiesced(new AbortController().signal)).rejects.toThrow(
        'promotion_handshake_failed',
      );
      f.handshake.close();
    } finally {
      vi.useRealTimers();
    }
  },
);

test('a matching acknowledgement cannot hide a stalled stdout writer', async () => {
  vi.useFakeTimers();
  try {
    const input = new PassThrough();
    const handshake = createPromotionHandshake({
      input,
      operationRef,
      timeoutMilliseconds: 100,
      write: (line) => {
        input.write(Buffer.from(acknowledgement(JSON.parse(line) as Record<string, unknown>)));
        return new Promise<void>(() => {
          /* Synthetic stalled writer. */
        });
      },
    });
    const waiting = expect(handshake.assertQuiesced(new AbortController().signal)).rejects.toThrow(
      'promotion_handshake_failed',
    );
    await vi.runAllTimersAsync();
    await waiting;
    handshake.close();
  } finally {
    vi.useRealTimers();
  }
});

test('aborting before stdout flush does not emit a delayed host request', async () => {
  const f = fixture();
  const abort = new AbortController();
  const waiting = expect(f.handshake.assertQuiesced(abort.signal)).rejects.toThrow(
    'promotion_handshake_failed',
  );
  abort.abort();
  await waiting;
  expect(f.requests).toEqual([]);
  f.handshake.close();
});

test('unsolicited input after both checks invalidates completion', async () => {
  const f = fixture((request, input) => {
    input.write(Buffer.from(acknowledgement(request)));
  });
  await f.handshake.assertQuiesced(new AbortController().signal);
  await f.handshake.assertQuiesced(new AbortController().signal);
  f.input.write(Buffer.from('{}\n'));
  expect(() => {
    f.handshake.assertComplete();
  }).toThrow('promotion_handshake_failed');
  f.handshake.close();
});

test('clean stdin EOF after the second matching acknowledgement completes the exchange', async () => {
  const f = fixture((request, input) => {
    input.write(Buffer.from(acknowledgement(request)));
    if (request.sequence === 2) input.end();
  });
  await f.handshake.assertQuiesced(new AbortController().signal);
  await expect(f.handshake.assertQuiesced(new AbortController().signal)).resolves.toBeUndefined();
  await new Promise<void>((done) => {
    setImmediate(done);
  });
  expect(() => {
    f.handshake.assertComplete();
  }).not.toThrow();
  f.handshake.close();
});
