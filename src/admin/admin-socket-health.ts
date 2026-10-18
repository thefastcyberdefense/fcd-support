import { request } from 'node:http';
import { pathToFileURL } from 'node:url';

export async function probeAdminSocket(
  path: string,
  timeoutMilliseconds: number,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1 ||
    timeoutMilliseconds > 300_000 ||
    !path.startsWith('/') ||
    path.includes('\0')
  )
    return false;
  return new Promise<boolean>((resolve) => {
    const probe = request({
      socketPath: path,
      path: '/login',
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
    probe.once('error', () => {
      resolve(false);
    });
    probe.once('response', (response) => {
      const healthy = response.statusCode === 200;
      response.destroy();
      probe.destroy();
      resolve(healthy);
    });
    probe.end();
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [path, timeout] = process.argv.slice(2);
  process.exitCode =
    process.argv.length === 4 &&
    path !== undefined &&
    timeout !== undefined &&
    /^[1-9][0-9]*$/u.test(timeout) &&
    (await probeAdminSocket(path, Number(timeout)))
      ? 0
      : 1;
}
