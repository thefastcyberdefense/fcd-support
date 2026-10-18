import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createAdminRuntime, createAdminRoleRuntime } from '../src/admin/admin-runtime.js';
import { createSafeLogger } from '../src/logging.js';

const apps: FastifyInstance[] = [];
const environment = {
  ADMIN_SESSION_HMAC_KEY: Buffer.alloc(32, 0x51).toString('base64url'),
  ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 0x52).toString('base64url'),
  ADMIN_PASSWORD_COST: '16384',
  DATABASE_URL: 'postgresql://synthetic@127.0.0.1:5432/fcd_support_test',
};
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('private admin runtime', () => {
  test('file-backed private container mode keeps authentication routes and browser origin private', async () => {
    const pool = new pg.Pool();
    const runtime = await createAdminRoleRuntime({
      environment: {
        NODE_ENV: 'test',
        ADMIN_LISTEN_MODE: 'container_private',
        ADMIN_HOST: '0.0.0.0',
        ADMIN_ORIGIN: 'http://127.0.0.1:3004',
        DATABASE_URL_FILE: '/run/secrets/synthetic_db',
        ADMIN_SESSION_HMAC_KEY_FILE: '/run/secrets/synthetic_session',
        ADMIN_MFA_ENCRYPTION_KEY_FILE: '/run/secrets/synthetic_mfa',
      },
      readSecret: (file) =>
        Promise.resolve(
          new TextEncoder().encode(
            file.endsWith('synthetic_db')
              ? environment.DATABASE_URL
              : Buffer.alloc(32, 0x51).toString('base64url'),
          ),
        ),
      poolFactory: () => pool,
    });
    apps.push(runtime.app);
    expect((await runtime.app.inject({ method: 'GET', url: '/login' })).statusCode).toBe(200);
    expect((await runtime.app.inject({ method: 'GET', url: '/knowledge' })).statusCode).not.toBe(
      200,
    );
    expect(
      (
        await runtime.app.inject({
          method: 'POST',
          url: '/login',
          headers: { origin: 'http://admin:3004' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });
  test('fails invalid configuration before creating a pool', () => {
    const factory = vi.fn(() => new pg.Pool());
    expect(() => createAdminRuntime({ environment: {}, poolFactory: factory })).toThrow(
      'Invalid admin configuration',
    );
    expect(factory).not.toHaveBeenCalled();
  });
  test('serves private login without Meta credentials, closes its pool, and hides database errors', async () => {
    const pool = new pg.Pool({ max: 1 });
    const close = vi.spyOn(pool, 'end');
    const lines: string[] = [];
    const runtime = createAdminRuntime({
      environment,
      poolFactory: () => pool,
      logger: createSafeLogger({
        write: (line) => {
          lines.push(line);
        },
      }),
    });
    apps.push(runtime.app);
    const login = await runtime.app.inject({ method: 'GET', url: '/login' });
    expect(login.statusCode).toBe(200);
    const publicRoute = await runtime.app.inject({ method: 'GET', url: '/webhooks/meta' });
    expect(publicRoute.statusCode).toBe(404);
    pool.emit('error', new Error('SYNTHETIC_POOL_DETAIL_MUST_NOT_APPEAR'));
    expect(lines.join('')).toContain('database_pool_error');
    expect(lines.join('')).not.toContain('SYNTHETIC_POOL_DETAIL_MUST_NOT_APPEAR');
    await runtime.app.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
