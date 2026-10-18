import process from 'node:process';
import { Buffer } from 'node:buffer';
import { chmod, lstat, writeFile } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root] = process.argv.slice(2);
if (!root || process.argv.length !== 3 || !basename(root).startsWith('fcd-admin-socket-test-')) {
  throw new Error('synthetic_socket_scope_invalid');
}
const metadata = await lstat(root);
if (
  !metadata.isDirectory() ||
  metadata.isSymbolicLink() ||
  (metadata.mode & 0o777) !== 0o700 ||
  metadata.uid !== process.geteuid()
) {
  throw new Error('synthetic_socket_scope_invalid');
}
const files = [
  ['database', 'postgresql://synthetic@127.0.0.1:5432/fcd_support_test'],
  ['session', Buffer.alloc(32, 0x51).toString('base64url')],
  ['mfa', Buffer.alloc(32, 0x52).toString('base64url')],
];
for (const [name, value] of files) {
  const file = join(root, name);
  await writeFile(file, value, { mode: 0o600, flag: 'wx' });
  await chmod(file, 0o600);
}
Object.assign(process.env, {
  ADMIN_LISTEN_MODE: 'unix',
  ADMIN_SOCKET_PATH: join(root, 'admin.sock'),
  ADMIN_BROWSER_PORT: '4004',
  ADMIN_ORIGIN: 'http://127.0.0.1:4004',
  DATABASE_URL_FILE: join(root, 'database'),
  ADMIN_SESSION_HMAC_KEY_FILE: join(root, 'session'),
  ADMIN_MFA_ENCRYPTION_KEY_FILE: join(root, 'mfa'),
});
await import(pathToFileURL(resolve('dist/admin-main.js')).href);
