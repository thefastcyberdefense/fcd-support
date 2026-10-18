import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createAdminRuntime } from '../../src/admin/admin-runtime.js';
import { loadAdminConfig } from '../../src/admin/admin-config.js';
import { AdminSecretBytes, AdminSecretText } from '../../src/admin/admin-types.js';
import { AesGcmAdminSecretProtector, generateTotpCode } from '../../src/admin/mfa.js';
import { PostgresAdminIdentity } from '../../src/persistence/postgres-admin-identity.js';
import { createIsolatedTestDatabase } from './test-database.js';

test('synthetic socket forward retains real password MFA CSRF action and revocation guards', async () => {
  const database = await createIsolatedTestDatabase('admin_socket');
  const root = await mkdtemp(join(tmpdir(), 'fcd-admin-socket-test-'));
  await chmod(root, 0o700);
  const path = join(root, 'admin.sock');
  const sockets = new Set<Socket>();
  const forward = createServer((client) => {
    const upstream = createConnection({ path });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.once('error', () => {
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((done) => forward.listen(0, '127.0.0.1', done));
  const address = forward.address();
  if (address === null || typeof address === 'string') throw new Error('synthetic_forward_invalid');
  const origin = `http://127.0.0.1:${String(address.port)}`;
  const at = new Date('2030-01-01T00:00:00.000Z');
  const environment = {
    ADMIN_LISTEN_MODE: 'unix',
    ADMIN_SOCKET_PATH: path,
    ADMIN_BROWSER_PORT: String(address.port),
    ADMIN_ORIGIN: origin,
    ADMIN_PASSWORD_COST: '16384',
    ADMIN_SESSION_HMAC_KEY: Buffer.alloc(32, 0x51).toString('base64url'),
    ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 0x52).toString('base64url'),
    DATABASE_URL: database.connectionString,
  };
  const config = loadAdminConfig(environment);
  const seed = new AdminSecretBytes(Buffer.alloc(20, 0x53));
  const identity = new PostgresAdminIdentity(database.pool, {
    mfaProtector: new AesGcmAdminSecretProtector(config.mfaKeyVersion, config.mfaEncryptionKey),
    now: () => at,
    passwordPolicy: config.passwordPolicy,
    preauthenticationTtlMilliseconds: config.preauthenticationTtlMilliseconds,
    sessionHmacKey: config.sessionHmacKey,
    sessionTtlMilliseconds: config.sessionTtlMilliseconds,
    totpPolicy: config.totpPolicy,
  });
  const runtime = createAdminRuntime({ environment, now: () => at });
  let cookies = '';
  const cookieValue = (name: string) =>
    cookies
      .split('; ')
      .find((part) => part.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? '';
  async function get(url: string) {
    return fetch(origin + url, { headers: { cookie: cookies }, redirect: 'manual' });
  }
  async function post(url: string, values: Record<string, string>, requestOrigin = origin) {
    return fetch(origin + url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        origin: requestOrigin,
        cookie: cookies,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(values),
    });
  }
  function saveCookies(response: Response) {
    cookies = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
  }
  try {
    await identity.createAccount(
      {
        accountRef: 'ADMIN_TEST_socket',
        loginName: 'synthetic.socket',
        password: new AdminSecretText('Synthetic-socket-passphrase'),
        mfaSeed: seed,
        createdAt: at,
        requestKey: 'REQUEST_TEST_socket_bootstrap',
      },
      { kind: 'initial_bootstrap' },
    );
    await runtime.start();
    expect(runtime.app.server.address()).toBe(path);
    expect((await get('/knowledge')).status).toBe(303);
    expect(
      (await post('/login', { loginName: 'synthetic.socket', password: 'synthetic_wrong' })).status,
    ).toBe(401);
    expect(
      (
        await post(
          '/login',
          { loginName: 'synthetic.socket', password: 'Synthetic-socket-passphrase' },
          'http://0.0.0.0:4004',
        )
      ).status,
    ).toBe(403);
    const password = await post('/login', {
      loginName: 'synthetic.socket',
      password: 'Synthetic-socket-passphrase',
    });
    expect(password.status).toBe(303);
    saveCookies(password);
    const preauthCsrf = cookieValue('fcd_admin_csrf');
    expect((await post('/mfa', { code: 'invalid', csrfToken: preauthCsrf })).status).toBe(401);
    const mfa = await post('/mfa', {
      code: generateTotpCode(seed, at, config.totpPolicy),
      csrfToken: preauthCsrf,
    });
    expect(mfa.status).toBe(303);
    saveCookies(mfa);
    expect((await get('/knowledge')).status).toBe(200);
    const newProposal = await get('/knowledge/new');
    const html = await newProposal.text();
    const token = /name="actionToken" value="([^"]+)"/u.exec(html)?.[1];
    if (token === undefined) throw new Error('synthetic_action_missing');
    const form = {
      csrfToken: cookieValue('fcd_admin_csrf'),
      actionToken: token,
      itemKey: 'faq.synthetic.socket',
      kind: 'faq',
      sourceLabel: 'Synthetic manual source',
      questionEn: 'Synthetic socket question?',
      questionBn: 'সিনথেটিক প্রশ্ন?',
      answerEn: 'Synthetic reviewed answer.',
      answerBn: 'সিনথেটিক উত্তর।',
    };
    expect((await post('/knowledge', { ...form, csrfToken: 'synthetic_wrong' })).status).toBe(403);
    expect((await post('/knowledge', { ...form, actionToken: 'synthetic_invalid' })).status).toBe(
      400,
    );
    expect((await post('/knowledge', form, 'http://0.0.0.0:4004')).status).toBe(403);
    expect((await post('/knowledge', form)).status).toBe(303);
    const count = await database.pool.query<{ count: string }>(
      'select count(*)::text as count from knowledge_items',
    );
    expect(count.rows[0]?.count).toBe('1');
    expect((await post('/logout', { csrfToken: form.csrfToken })).status).toBe(303);
    expect((await get('/knowledge')).status).toBe(303);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) =>
      forward.close(() => {
        done();
      }),
    );
    try {
      if (typeof runtime.stop === 'function') await runtime.stop();
      else await runtime.app.close();
    } finally {
      await database.dispose();
    }
    if (root.startsWith(join(tmpdir(), 'fcd-admin-socket-test-')))
      await rm(root, { recursive: true, force: true });
  }
});
