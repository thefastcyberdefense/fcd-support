import { createServer } from 'node:net';

// Host preflight only. No public bind, provider request or retained listener.
export async function assertLoopbackPortAvailable(port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('management_port_unavailable');
  try {
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => socket.destroy());
      server.once('error', () => {
        reject(new Error('unavailable'));
      });
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(new Error('unavailable'));
        });
      });
    });
  } catch {
    throw new Error('management_port_unavailable');
  }
}
