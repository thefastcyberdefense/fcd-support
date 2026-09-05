import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  buildAdminApp,
  type AdminDashboardPort,
  type AdminIdentityPort,
} from '../src/admin/admin-app.js';
import type {
  AdminProposalDetail,
  AdminProposalSummary,
  AdminQuestionSummary,
} from '../src/admin/admin-html.js';
import { AdminSecretText } from '../src/admin/admin-types.js';
import type { ResolvedAdminSession } from '../src/persistence/postgres-admin-identity.js';

const apps: FastifyInstance[] = [];
const origin = 'http://127.0.0.1:3004';
const preauthenticationToken = new AdminSecretText('synthetic-preauthentication-token');
const activeToken = new AdminSecretText('synthetic-active-session-token');
const preauthenticationCsrf = new AdminSecretText('synthetic-preauthentication-csrf');
const activeCsrf = new AdminSecretText('synthetic-active-csrf');

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function dashboardPort(overrides: Partial<AdminDashboardPort> = {}): AdminDashboardPort {
  return {
    answerQuestion: vi.fn(() => Promise.resolve()),
    createProposal: vi.fn(() => Promise.resolve()),
    getProposal: vi.fn(() =>
      Promise.resolve({
        answerBn: 'পর্যালোচিত সিনথেটিক উত্তর।',
        currentVersionRef: 'VERSION_TEST_hours_2',
        answerEn: 'Reviewed synthetic answer.',
        itemKey: 'faq.synthetic.hours',
        kind: 'faq',
        questionBn: 'সিনথেটিক প্রশ্ন?',
        questionEn: 'Synthetic question?',
        sourceLabel: 'Manual business',
        state: 'submitted',
        versionRef: 'VERSION_TEST_hours_3',
      } satisfies AdminProposalDetail),
    ),
    listAudit: vi.fn(() =>
      Promise.resolve([
        {
          action: 'knowledge_submitted',
          effectiveAt: new Date('2026-09-02T06:00:00.000Z'),
          objectRef: 'VERSION_TEST_hours_3',
          result: 'applied',
        },
      ]),
    ),
    listEscalationCounts: vi.fn(() =>
      Promise.resolve([{ count: 2, reasonCode: 'faq_ambiguous', state: 'open' }]),
    ),
    listInsights: vi.fn(() =>
      Promise.resolve([
        { categoryCode: 'support_gap', occurrenceCount: 4, topicCode: 'office_hours' },
      ]),
    ),
    listProposals: vi.fn(() =>
      Promise.resolve([
        {
          itemKey: 'faq.synthetic.hours',
          sourceLabel: 'Manual business',
          state: 'submitted',
          title: 'Office hours',
          updatedAt: new Date('2026-09-02T06:00:00.000Z'),
          versionRef: 'VERSION_TEST_hours_3',
        },
      ] satisfies readonly AdminProposalSummary[]),
    ),
    listQuestions: vi.fn(() =>
      Promise.resolve([
        {
          priority: 'normal',
          questionRef: 'QUESTION_TEST_hours',
          questionText: 'What are the reviewed synthetic office hours?',
          state: 'open',
        },
      ] satisfies readonly AdminQuestionSummary[]),
    ),
    publishVersion: vi.fn(() => Promise.resolve()),
    resolveActivePolicy: vi.fn(() =>
      Promise.resolve({ policyRef: 'POLICY_TEST_balanced', state: 'active' }),
    ),
    retireVersion: vi.fn(() => Promise.resolve()),
    reviewVersion: vi.fn(() => Promise.resolve()),
    rollbackVersion: vi.fn(() => Promise.resolve()),
    submitVersion: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function resolvedSession(
  roles: ResolvedAdminSession['roles'] = ['administrator'],
): ResolvedAdminSession {
  return {
    accountRef: 'ADMIN_TEST_dashboard_reviewer',
    expiresAt: new Date('2026-09-02T08:00:00.000Z'),
    roles,
  };
}

function createTestApp(
  options: {
    readonly dashboard?: AdminDashboardPort;
    readonly roles?: ResolvedAdminSession['roles'];
    readonly validateCsrf?: boolean;
    readonly now?: () => Date;
  } = {},
) {
  const identity = {
    beginPasswordAuthentication: vi.fn<AdminIdentityPort['beginPasswordAuthentication']>(() =>
      Promise.resolve({
        csrfToken: preauthenticationCsrf,
        expiresAt: new Date('2026-09-02T06:05:00.000Z'),
        sessionToken: preauthenticationToken,
        status: 'mfa_required' as const,
      }),
    ),
    completeMfaAuthentication: vi.fn<AdminIdentityPort['completeMfaAuthentication']>(() =>
      Promise.resolve({
        csrfToken: activeCsrf,
        expiresAt: new Date('2026-09-02T08:00:00.000Z'),
        sessionToken: activeToken,
        status: 'authenticated' as const,
      }),
    ),
    resolveSession: vi.fn<AdminIdentityPort['resolveSession']>(() =>
      Promise.resolve(resolvedSession(options.roles)),
    ),
    revokeSession: vi.fn<AdminIdentityPort['revokeSession']>(() =>
      Promise.resolve({ status: 'applied' as const }),
    ),
    validateCsrf: vi.fn<AdminIdentityPort['validateCsrf']>(() =>
      Promise.resolve(options.validateCsrf ?? true),
    ),
  };
  const dashboard = options.dashboard ?? dashboardPort();
  const app = buildAdminApp({
    dashboard,
    identity,
    now: options.now ?? (() => new Date('2026-09-02T06:00:00.000Z')),
    origin,
    secureCookie: false,
  });
  apps.push(app);
  return { app, dashboard, identity };
}

function activeCookies(csrf = activeCsrf.reveal()): string {
  return `fcd_admin_session=${activeToken.reveal()}; fcd_admin_csrf=${csrf}`;
}

function hiddenValue(body: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(body);
  if (match?.[1] === undefined) throw new Error('Expected form field was absent');
  return match[1];
}

function formHeaders(cookie?: string, requestOrigin = origin) {
  return {
    ...(cookie === undefined ? {} : { cookie }),
    'content-type': 'application/x-www-form-urlencoded',
    origin: requestOrigin,
  };
}

describe('private admin application', () => {
  test('serves login with restrictive browser security headers', async () => {
    const { app } = createTestApp();
    const response = await app.inject({ method: 'GET', url: '/login' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-security-policy']).toMatch(
      /^default-src 'none'; style-src 'nonce-[A-Za-z0-9_-]+';/,
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('same-origin');
    expect(response.body).toContain('Private administration');
  });

  test('performs password then MFA authentication with rotated HttpOnly session cookies', async () => {
    const { app, identity } = createTestApp();
    const password = await app.inject({
      headers: formHeaders(),
      method: 'POST',
      payload: 'loginName=synthetic.reviewer&password=Synthetic-reviewer-passphrase-2026',
      url: '/login',
    });

    expect(password.statusCode).toBe(303);
    expect(password.headers.location).toBe('/mfa');
    const passwordCookies = password.headers['set-cookie'];
    expect(passwordCookies).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          `fcd_admin_session=${preauthenticationToken.reveal()}; Path=/; HttpOnly; SameSite=Strict`,
        ),
        expect.stringContaining(
          `fcd_admin_csrf=${preauthenticationCsrf.reveal()}; Path=/; SameSite=Strict`,
        ),
      ]),
    );
    const passwordInput = identity.beginPasswordAuthentication.mock.calls[0]?.[0];
    if (
      typeof passwordInput !== 'object' ||
      passwordInput === null ||
      !('loginName' in passwordInput) ||
      !('password' in passwordInput)
    ) {
      throw new Error('password input was not captured');
    }
    expect(passwordInput.loginName).toBe('synthetic.reviewer');
    expect(passwordInput.password).toBeInstanceOf(AdminSecretText);

    const mfa = await app.inject({
      headers: formHeaders(
        `fcd_admin_session=${preauthenticationToken.reveal()}; fcd_admin_csrf=${preauthenticationCsrf.reveal()}`,
      ),
      method: 'POST',
      payload: `code=123456&csrfToken=${preauthenticationCsrf.reveal()}`,
      url: '/mfa',
    });
    expect(mfa.statusCode).toBe(303);
    expect(mfa.headers.location).toBe('/knowledge');
    expect(mfa.headers['set-cookie']).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          `fcd_admin_session=${activeToken.reveal()}; Path=/; HttpOnly; SameSite=Strict`,
        ),
        expect.stringContaining(`fcd_admin_csrf=${activeCsrf.reveal()}; Path=/; SameSite=Strict`),
      ]),
    );
    const mfaInput = identity.completeMfaAuthentication.mock.calls[0]?.[0];
    if (
      typeof mfaInput !== 'object' ||
      mfaInput === null ||
      !('code' in mfaInput) ||
      !('preauthenticationToken' in mfaInput)
    ) {
      throw new Error('MFA input was not captured');
    }
    expect(mfaInput.code).toBe('123456');
    expect(mfaInput.preauthenticationToken).toBeInstanceOf(AdminSecretText);
  });

  test('requires exact Origin for login and exact Origin plus valid CSRF for authenticated mutation', async () => {
    const missingOrigin = createTestApp();
    const login = await missingOrigin.app.inject({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
      payload: 'loginName=synthetic.reviewer&password=Synthetic-reviewer-passphrase-2026',
      url: '/login',
    });
    expect(login.statusCode).toBe(403);
    expect(missingOrigin.identity.beginPasswordAuthentication).not.toHaveBeenCalled();

    const invalidCsrf = createTestApp({ validateCsrf: false });
    const mutation = await invalidCsrf.app.inject({
      headers: formHeaders(activeCookies('wrong-csrf')),
      method: 'POST',
      payload: 'csrfToken=wrong-csrf&confirmationVersionRef=VERSION_TEST_hours_3',
      url: '/knowledge/VERSION_TEST_hours_3/publish',
    });
    expect(mutation.statusCode).toBe(403);
    expect(invalidCsrf.dashboard.publishVersion).not.toHaveBeenCalled();
  });

  test('denies role-ineligible mutation even when the route is hidden in navigation', async () => {
    const { app, dashboard } = createTestApp({ roles: ['knowledge_editor'] });
    const response = await app.inject({
      headers: formHeaders(activeCookies()),
      method: 'POST',
      payload: `csrfToken=${activeCsrf.reveal()}&confirmationVersionRef=VERSION_TEST_hours_3`,
      url: '/knowledge/VERSION_TEST_hours_3/publish',
    });

    expect(response.statusCode).toBe(403);
    expect(dashboard.publishVersion).not.toHaveBeenCalled();
  });

  test('requires an exact version reference before a publication mutation', async () => {
    const { app, dashboard } = createTestApp({ roles: ['knowledge_reviewer'] });
    const wrong = await app.inject({
      headers: formHeaders(activeCookies()),
      method: 'POST',
      payload: `csrfToken=${activeCsrf.reveal()}&confirmationVersionRef=VERSION_TEST_other`,
      url: '/knowledge/VERSION_TEST_hours_3/publish',
    });
    expect(wrong.statusCode).toBe(400);
    expect(dashboard.publishVersion).not.toHaveBeenCalled();

    const confirmation = await app.inject({
      method: 'GET',
      url: '/knowledge/VERSION_TEST_hours_3/publish',
      headers: { cookie: activeCookies() },
    });
    const token = hiddenValue(confirmation.body, 'actionToken');
    const exact = await app.inject({
      headers: formHeaders(activeCookies()),
      method: 'POST',
      payload: `csrfToken=${activeCsrf.reveal()}&confirmationVersionRef=VERSION_TEST_hours_3&actionToken=${encodeURIComponent(token)}`,
      url: '/knowledge/VERSION_TEST_hours_3/publish',
    });
    expect(exact.statusCode).toBe(303);
    expect(exact.headers.location).toBe('/knowledge/VERSION_TEST_hours_3');
    expect(dashboard.publishVersion).toHaveBeenCalledWith(
      expect.objectContaining({ versionRef: 'VERSION_TEST_hours_3' }),
      expect.objectContaining({ accountRef: 'ADMIN_TEST_dashboard_reviewer' }),
    );
  });

  test('binds confirmation to session, action, prior version, and stable retry material', async () => {
    let at = new Date('2026-09-02T06:00:00.000Z');
    const { app, dashboard } = createTestApp({ now: () => at });
    const confirmation = await app.inject({
      method: 'GET',
      url: '/knowledge/VERSION_TEST_hours_3/publish',
      headers: { cookie: activeCookies() },
    });
    expect(confirmation.body).toContain('VERSION_TEST_hours_2');
    const token = hiddenValue(confirmation.body, 'actionToken');
    const payload = new URLSearchParams({
      csrfToken: activeCsrf.reveal(),
      confirmationVersionRef: 'VERSION_TEST_hours_3',
      actionToken: token,
    }).toString();
    const first = await app.inject({
      method: 'POST',
      url: '/knowledge/VERSION_TEST_hours_3/publish',
      headers: formHeaders(activeCookies()),
      payload,
    });
    at = new Date('2026-09-02T06:00:02.000Z');
    const retry = await app.inject({
      method: 'POST',
      url: '/knowledge/VERSION_TEST_hours_3/publish',
      headers: formHeaders(activeCookies()),
      payload,
    });
    expect(first.statusCode).toBe(303);
    expect(retry.statusCode).toBe(303);
    const calls = vi.mocked(dashboard.publishVersion).mock.calls;
    expect(calls[0]?.[0]).toEqual(calls[1]?.[0]);
    expect(calls[0]?.[0]).toMatchObject({
      priorVersionRef: 'VERSION_TEST_hours_2',
      effectiveAt: new Date('2026-09-02T06:00:00.000Z'),
    });
    const wrongAction = await app.inject({
      method: 'POST',
      url: '/knowledge/VERSION_TEST_hours_3/retire',
      headers: formHeaders(activeCookies()),
      payload,
    });
    expect(wrongAction.statusCode).toBe(400);
    expect(dashboard.retireVersion).not.toHaveBeenCalled();
  });

  test('renders functional review forms, filtering, and mobile account controls', async () => {
    const { app, dashboard } = createTestApp();
    const page = await app.inject({
      method: 'GET',
      url: '/knowledge/VERSION_TEST_hours_3',
      headers: { cookie: activeCookies() },
    });
    expect(page.body).toContain('action="/knowledge/VERSION_TEST_hours_3/review"');
    expect(page.body).toContain('>Approve</button>');
    expect(page.body).toContain('>Reject</button>');
    expect(page.body).toContain('<details class="mobile-menu">');
    expect(page.body).toContain('aria-label="Mobile administration"');
    vi.mocked(dashboard.listProposals).mockResolvedValueOnce([]);
    const filtered = await app.inject({
      method: 'GET',
      url: '/knowledge?search=nonmatching-synthetic',
      headers: { cookie: activeCookies() },
    });
    expect(filtered.body).toContain('No proposals are available.');
    expect(dashboard.listProposals).toHaveBeenLastCalledWith({
      search: 'nonmatching-synthetic',
      state: '',
      page: 1,
    });
  });

  test('preserves replacement kind and displays scheduled actions separately from active state', async () => {
    const dashboard = dashboardPort();
    const proposal = await dashboard.getProposal('VERSION_TEST_hours_3');
    vi.mocked(dashboard.getProposal).mockResolvedValue({
      ...proposal,
      kind: 'business_fact',
      publicationState: 'published',
      scheduledAction: 'retire',
      scheduledEffectiveAt: new Date('2026-09-02T08:00:00.000Z'),
    });
    const { app } = createTestApp({ dashboard });
    const replacement = await app.inject({
      method: 'GET',
      url: '/knowledge/new?replaces=VERSION_TEST_hours_3',
      headers: { cookie: activeCookies() },
    });
    expect(replacement.statusCode).toBe(200);
    expect(replacement.body).toContain('name="kind" value="business_fact" readonly');
    const detail = await app.inject({
      method: 'GET',
      url: '/knowledge/VERSION_TEST_hours_3',
      headers: { cookie: activeCookies() },
    });
    expect(detail.body).toContain('published');
    expect(detail.body).toContain('Scheduled retire: 2026-09-02T08:00:00.000Z');
  });

  test('binds scheduled confirmation to the publication at the selected effective time', async () => {
    const { app, dashboard } = createTestApp();
    const response = await app.inject({
      method: 'GET',
      url: '/knowledge/VERSION_TEST_hours_3/publish?effectiveAt=2026-09-02T08%3A00',
      headers: { cookie: activeCookies() },
    });
    expect(response.statusCode).toBe(200);
    expect(dashboard.getProposal).toHaveBeenLastCalledWith(
      'VERSION_TEST_hours_3',
      new Date('2026-09-02T08:00:00.000Z'),
    );
    expect(response.body).toContain('Publication at selected time:');
  });

  test('renders pagination that preserves search and state', async () => {
    const { app, dashboard } = createTestApp();
    const response = await app.inject({
      method: 'GET',
      url: '/knowledge?page=2&search=synthetic&state=approved',
      headers: { cookie: activeCookies() },
    });
    expect(response.statusCode).toBe(200);
    expect(dashboard.listProposals).toHaveBeenLastCalledWith({
      search: 'synthetic',
      state: 'approved',
      page: 2,
    });
    expect(response.body).toContain(
      'href="/knowledge?search=synthetic&amp;state=approved&amp;page=1"',
    );
    expect(response.body).toContain('Page 2');
  });

  test('escapes repository content and returns content-free error pages', async () => {
    const marker = '<script>SYNTHETIC_REPOSITORY_MARKER</script>';
    const escaped = createTestApp({
      dashboard: dashboardPort({
        listProposals: vi.fn(() =>
          Promise.resolve([
            {
              itemKey: 'faq.synthetic.escape',
              sourceLabel: 'Synthetic source',
              state: 'draft',
              title: marker,
              updatedAt: new Date('2026-09-02T06:00:00.000Z'),
              versionRef: 'VERSION_TEST_escape_1',
            },
          ] satisfies readonly AdminProposalSummary[]),
        ),
      }),
    });
    const page = await escaped.app.inject({
      headers: { cookie: activeCookies() },
      method: 'GET',
      url: '/knowledge',
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('&lt;script&gt;SYNTHETIC_REPOSITORY_MARKER&lt;/script&gt;');
    expect(page.body).not.toContain(marker);

    const failing = createTestApp({
      dashboard: dashboardPort({
        listProposals: vi.fn(() => Promise.reject(new Error(marker))),
      }),
    });
    const error = await failing.app.inject({
      headers: { cookie: activeCookies() },
      method: 'GET',
      url: '/knowledge',
    });
    expect(error.statusCode).toBe(500);
    expect(error.body).toContain('The private service could not complete this request.');
    expect(error.body).not.toContain('SYNTHETIC_REPOSITORY_MARKER');
  });

  test.each([
    '/knowledge',
    '/knowledge/new',
    '/knowledge/VERSION_TEST_hours_3',
    '/knowledge/VERSION_TEST_hours_3/publish',
    '/knowledge/VERSION_TEST_hours_3/retire',
    '/knowledge/VERSION_TEST_hours_3/rollback',
    '/questions',
    '/insights',
    '/policy',
    '/escalations',
    '/audit',
  ])('serves the authenticated private module route %s', async (url) => {
    const { app } = createTestApp();
    const response = await app.inject({
      headers: { cookie: activeCookies() },
      method: 'GET',
      url,
    });
    expect(response.statusCode).toBe(200);
  });

  test('logs out through a CSRF-protected mutation and clears both cookies', async () => {
    const { app, identity } = createTestApp();
    const response = await app.inject({
      headers: formHeaders(activeCookies()),
      method: 'POST',
      payload: `csrfToken=${activeCsrf.reveal()}`,
      url: '/logout',
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/login');
    const revokeInput = identity.revokeSession.mock.calls[0]?.[0];
    if (
      typeof revokeInput !== 'object' ||
      revokeInput === null ||
      !('sessionToken' in revokeInput)
    ) {
      throw new Error('revoke input was not captured');
    }
    expect(revokeInput.sessionToken).toBeInstanceOf(AdminSecretText);
    expect(response.headers['set-cookie']).toEqual(
      expect.arrayContaining([
        expect.stringContaining('fcd_admin_session=;'),
        expect.stringContaining('fcd_admin_csrf=;'),
      ]),
    );
  });
});
