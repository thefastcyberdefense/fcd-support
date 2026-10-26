import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { operationApplicationName } from './operation-reference.js';

export interface PromotionHandshakeOptions {
  readonly operationRef: string;
  readonly input: Readable;
  readonly timeoutMilliseconds: number;
  readonly write: (line: string) => void | Promise<void>;
  /** Trusted unit-test entropy only. Production always uses randomBytes. */
  readonly challenge?: () => string;
}

/** A live stdio exchange, never a reusable proof or a readiness token. */
export function createPromotionHandshake(options: PromotionHandshakeOptions) {
  operationApplicationName(options.operationRef);
  const timeout = z.number().int().min(1).max(300000).parse(options.timeoutMilliseconds);
  const state = { failed: false, closed: false, completed: 0 };
  const used = new Set<string>();
  let pending:
    | {
        readonly expected: string;
        readonly resolve: () => void;
        readonly reject: (reason: Error) => void;
        buffer: Buffer;
        received: boolean;
        written: boolean;
      }
    | undefined;
  const failure = () => new Error('promotion_handshake_failed');
  const fail = () => {
    state.failed = true;
    pending?.reject(failure());
  };
  const onEnd = () => {
    // A controller may close its response pipe after the final complete reply.
    if (state.completed === 2 || (state.completed === 1 && pending?.received === true)) return;
    fail();
  };
  const onData = (chunk: unknown) => {
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
      if (!(chunk instanceof Uint8Array)) fail();
      return;
    }
    const awaiting = pending;
    if (
      !awaiting ||
      awaiting.received ||
      state.failed ||
      state.closed ||
      awaiting.buffer.length + chunk.byteLength > 1024
    ) {
      fail();
      return;
    }
    awaiting.buffer = Buffer.concat([awaiting.buffer, chunk]);
    const newline = awaiting.buffer.indexOf(0x0a);
    if (newline === -1) return;
    try {
      const line = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        awaiting.buffer,
      );
      if (newline !== awaiting.buffer.length - 1 || line !== awaiting.expected) throw failure();
      awaiting.received = true;
      if (awaiting.written) awaiting.resolve();
    } catch {
      fail();
    }
  };
  if (options.input.destroyed || options.input.readableEnded || options.input.readableLength !== 0)
    state.failed = true;
  options.input.on('data', onData);
  options.input.on('error', fail);
  options.input.on('end', onEnd);
  options.input.on('close', onEnd);

  return {
    assertQuiesced: async (signal: AbortSignal): Promise<void> => {
      if (state.failed || state.closed || pending || state.completed >= 2 || signal.aborted)
        throw failure();
      const sequence = state.completed + 1;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const challenge = z
          .string()
          .regex(/^[a-f0-9]{32}$/u)
          .parse((options.challenge ?? (() => randomBytes(16).toString('hex')))());
        if (used.has(challenge)) throw failure();
        used.add(challenge);
        const request = {
          event: 'promotion_host_check',
          operationRef: options.operationRef,
          sequence,
          challenge,
        };
        const acknowledgement = Promise.withResolvers<undefined>();
        const exchange = {
          expected: JSON.stringify({ ...request, event: 'promotion_host_verified' }) + '\n',
          resolve: () => {
            acknowledgement.resolve(undefined);
          },
          reject: (reason: Error) => {
            acknowledgement.reject(reason);
          },
          buffer: Buffer.alloc(0),
          received: false,
          written: false,
        };
        pending = exchange;
        const valid = () => !state.failed && !signal.aborted;
        signal.addEventListener('abort', fail, { once: true });
        timer = setTimeout(fail, timeout);
        void Promise.resolve()
          .then(() => {
            if (!valid()) throw failure();
            return options.write(JSON.stringify(request) + '\n');
          })
          .then(() => {
            exchange.written = true;
            if (exchange.received && valid()) exchange.resolve();
          }, fail);
        // Completion requires both a flushed request and its exact live reply.
        await acknowledgement.promise;
        if (!valid()) throw failure();
        state.completed++;
      } catch {
        fail();
        throw failure();
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', fail);
        pending = undefined;
      }
    },
    assertComplete(): void {
      if (
        state.failed ||
        state.closed ||
        state.completed !== 2 ||
        pending ||
        options.input.readableLength !== 0
      )
        throw failure();
    },
    close(): void {
      if (state.closed) return;
      state.closed = true;
      pending?.reject(failure());
      options.input.pause();
      options.input.off('data', onData);
      options.input.off('error', fail);
      options.input.off('end', onEnd);
      options.input.off('close', onEnd);
    },
  };
}
