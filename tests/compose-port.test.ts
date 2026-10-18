import { createServer } from 'node:net';

import { expect, test } from 'vitest';

import { assertLoopbackPortAvailable } from '../src/operations/compose-port.js';

test('refuses a conflicting loopback bind and releases its availability probe', async () => {
  const listener = createServer();
  await new Promise<void>((resolve) =>
    listener.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve),
  );
  const address = listener.address();
  if (address === null || typeof address === 'string')
    throw new Error('synthetic_listener_invalid');
  try {
    await expect(assertLoopbackPortAvailable(address.port)).rejects.toThrow(
      /^management_port_unavailable$/u,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      listener.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }
  await expect(assertLoopbackPortAvailable(address.port)).resolves.toBeUndefined();
  await expect(assertLoopbackPortAvailable(address.port)).resolves.toBeUndefined();
});
