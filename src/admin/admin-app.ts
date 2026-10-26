import { randomBytes } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { noopSafeLogger, type SafeLogger } from '../logging.js';
import { parseModelPolicyValues } from '../model/model-policy-input.js';
import type {
  AdminAuthenticationResult,
  AdminMfaAuthenticationResult,
  AdminRole,
  ResolvedAdminSession,
} from '../persistence/postgres-admin-identity.js';
import {
  type AdminAuditSummary,
  type AdminEscalationCount,
  type AdminInsightSummary,
  type AdminPolicySummary,
  type AdminProposalDetail,
  type AdminProposalSummary,
  type AdminQuestionSummary,
  renderConfirmationPage,
  renderKnowledgePage,
  renderLoginPage,
  renderMfaPage,
  renderModelPolicyPage,
  renderNewProposalPage,
  renderQuestionsPage,
  renderSafeErrorPage,
  renderSimpleModulePage,
} from './admin-html.js';
import { AdminSecretBytes, AdminSecretText } from './admin-types.js';
import { signAdminAction, verifyAdminAction, type AdminAction } from './admin-action.js';
import { registerOperationsRoutes } from './operations-routes.js';
import type { AdminOperationsPort } from './operations-types.js';

const bodyLimitBytes = 32 * 1024;
class AdminFormError extends Error {}
const sessionCookieName = 'fcd_admin_session';
const csrfCookieName = 'fcd_admin_csrf';
const referenceSchema = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const allRoles = [
  'administrator',
  'knowledge_editor',
  'knowledge_reviewer',
  'support_reviewer',
] as const satisfies readonly AdminRole[];

export interface AdminActor {
  readonly accountRef: string;
  readonly roles: readonly AdminRole[];
  readonly sessionToken: AdminSecretText;
}

export interface AdminIdentityPort {
  readonly beginPasswordAuthentication: (input: unknown) => Promise<AdminAuthenticationResult>;
  readonly completeMfaAuthentication: (input: unknown) => Promise<AdminMfaAuthenticationResult>;
  readonly resolveSession: (input: unknown) => Promise<ResolvedAdminSession | undefined>;
  readonly revokeSession: (input: unknown) => Promise<{ readonly status: 'applied' | 'duplicate' }>;
  readonly validateCsrf: (input: unknown) => Promise<boolean>;
}

export interface AdminDashboardPort {
  readonly answerQuestion: (input: unknown, actor: AdminActor) => Promise<void>;
  readonly createProposal: (input: unknown, actor: AdminActor) => Promise<void>;
  readonly getProposal: (versionRef: string, evaluatedAt?: Date) => Promise<AdminProposalDetail>;
  readonly listAudit: () => Promise<readonly AdminAuditSummary[]>;
  readonly listEscalationCounts: () => Promise<readonly AdminEscalationCount[]>;
  readonly listInsights: () => Promise<readonly AdminInsightSummary[]>;
  readonly listProposals: (
    filter?: AdminProposalFilter,
  ) => Promise<readonly AdminProposalSummary[]>;
  readonly listQuestions: () => Promise<readonly AdminQuestionSummary[]>;
  readonly listModelPolicies: () => Promise<readonly AdminPolicySummary[]>;
  readonly createModelPolicy: (input: unknown, actor: AdminActor) => Promise<void>;
  readonly transitionModelPolicy: (input: unknown, actor: AdminActor) => Promise<void>;
  readonly publishVersion: (input: unknown, actor: AdminActor) => Promise<void>;
  readonly retireVersion: (input: unknown, actor: AdminActor) => Promise<void>;
  readonly reviewVersion: (input: unknown, actor: AdminActor) => Promise<void>;
  readonly rollbackVersion: (input: unknown, actor: AdminActor) => Promise<void>;
  readonly submitVersion: (input: unknown, actor: AdminActor) => Promise<void>;
}

export interface AdminProposalFilter {
  readonly search?: string;
  readonly state?: string;
  readonly page?: number;
}

export interface BuildAdminAppOptions {
  readonly operations?: AdminOperationsPort;
  readonly listLimit?: number;
  readonly actionKey?: AdminSecretBytes;
  readonly actionTtlMilliseconds?: number;
  readonly dashboard: AdminDashboardPort;
  readonly identity: AdminIdentityPort;
  readonly logger?: SafeLogger | undefined;
  readonly nonceSource?: (() => string) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly origin: string;
  readonly referenceSource?: (() => string) | undefined;
  readonly secureCookie: boolean;
}

interface AuthenticatedContext {
  readonly actor: AdminActor;
  readonly csrfToken: string;
  readonly session: ResolvedAdminSession;
  readonly sessionToken: AdminSecretText;
}

function parseCookies(value: string | undefined): Readonly<Record<string, string>> {
  if (value === undefined || value.length > 4096) return {};
  const cookies: Record<string, string> = {};
  for (const part of value.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const rawValue = part.slice(index + 1).trim();
    if (!/^[a-z0-9_]{1,64}$/.test(name) || rawValue.length > 512) continue;
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      continue;
    }
  }
  return cookies;
}

function parseForm(body: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > bodyLimitBytes)
    return undefined;
  const result: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of new URLSearchParams(body)) {
    count += 1;
    if (
      count > 32 ||
      !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ||
      value.length > 5000 ||
      Object.hasOwn(result, name)
    ) {
      return undefined;
    }
    result[name] = value;
  }
  return result;
}

function formValue(
  form: Readonly<Record<string, string>>,
  name: string,
  maximumLength: number,
): string | undefined {
  const value = form[name];
  return value === undefined || value.length === 0 || value.length > maximumLength
    ? undefined
    : value;
}

function formNumber(form: Readonly<Record<string, string>>, name: string): number | undefined {
  const value = formValue(form, name, 32);
  if (value === undefined || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function policyValues(form: Readonly<Record<string, string>>) {
  try {
    return parseModelPolicyValues({
      approvedProviderAttempts: formNumber(form, 'approvedProviderAttempts'),
      architectureProviderCeiling: formNumber(form, 'architectureProviderCeiling'),
      concurrentCalls: formNumber(form, 'concurrentCalls'),
      cooldownMs: formNumber(form, 'cooldownMs'),
      faqAmbiguityMargin: formNumber(form, 'faqAmbiguityMargin'),
      faqMinimumSimilarity: formNumber(form, 'faqMinimumSimilarity'),
      globalUtcDayCalls: formNumber(form, 'globalUtcDayCalls'),
      maximumFaqCandidates: formNumber(form, 'maximumFaqCandidates'),
      outputTokens: formNumber(form, 'outputTokens'),
      perContact15MinuteCalls: formNumber(form, 'perContact15MinuteCalls'),
      perContact24HourCalls: formNumber(form, 'perContact24HourCalls'),
      queueCapacity: formNumber(form, 'queueCapacity'),
      totalTimeoutMs: formNumber(form, 'totalTimeoutMs'),
    });
  } catch {
    return undefined;
  }
}

function cookie(name: string, value: string, secure: boolean, httpOnly: boolean): string {
  return `${name}=${encodeURIComponent(value)}; Path=/${httpOnly ? '; HttpOnly' : ''}; SameSite=Strict${secure ? '; Secure' : ''}`;
}

function clearCookie(name: string, secure: boolean, httpOnly: boolean): string {
  return `${name}=; Path=/${httpOnly ? '; HttpOnly' : ''}; SameSite=Strict${secure ? '; Secure' : ''}; Max-Age=0`;
}

function securityHeaders(reply: FastifyReply, nonce?: string): FastifyReply {
  const styleSource = nonce === undefined ? "style-src 'none'" : `style-src 'nonce-${nonce}'`;
  reply.header('cache-control', 'no-store');
  if (nonce !== undefined || !reply.hasHeader('content-security-policy')) {
    reply.header(
      'content-security-policy',
      `default-src 'none'; ${styleSource}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    );
  }

  return reply
    .header('cross-origin-resource-policy', 'same-origin')
    .header('referrer-policy', 'same-origin')
    .header('x-content-type-options', 'nosniff')
    .header('x-frame-options', 'DENY');
}

function html(reply: FastifyReply, nonce: string, body: string, statusCode = 200) {
  return securityHeaders(reply, nonce).code(statusCode).type('text/html; charset=utf-8').send(body);
}

function redirect(reply: FastifyReply, location: string) {
  return securityHeaders(reply).code(303).header('location', location).send();
}

function hasRole(session: ResolvedAdminSession, required: readonly AdminRole[]): boolean {
  return (
    required.length === 0 ||
    session.roles.includes('administrator') ||
    required.some((role) => session.roles.includes(role))
  );
}

function routeReference(request: FastifyRequest, name = 'versionRef'): string | undefined {
  const params = request.params as Readonly<Record<string, unknown>>;
  const value = params[name];
  return typeof value === 'string' && referenceSchema.test(value) ? value : undefined;
}

function exactOrigin(request: FastifyRequest, origin: string): boolean {
  return request.headers.origin === origin;
}

export function buildAdminApp(options: BuildAdminAppOptions): FastifyInstance {
  const logger = options.logger ?? noopSafeLogger;
  const now = options.now ?? (() => new Date());
  const nonceSource = options.nonceSource ?? (() => randomBytes(18).toString('base64url'));
  const referenceSource =
    options.referenceSource ?? (() => `REQUEST_admin_${randomBytes(18).toString('hex')}`);
  const app = Fastify({ bodyLimit: bodyLimitBytes, exposeHeadRoutes: false, logger: false });
  const actionKey = options.actionKey ?? new AdminSecretBytes(randomBytes(32));
  const actionTtl = options.actionTtlMilliseconds ?? 900_000;
  if (!Number.isSafeInteger(actionTtl) || actionTtl < 60_000 || actionTtl > 3_600_000)
    throw new TypeError('Admin action lifetime is invalid');
  function issueAction(
    context: AuthenticatedContext,
    action: AdminAction['action'],
    reference: string,
    priorVersionRef?: string,
    effectiveAt = now(),
  ): string {
    return signAdminAction(
      {
        action,
        reference,
        ...(priorVersionRef === undefined ? {} : { priorVersionRef }),
        requestKey: referenceSource(),
        effectiveAt: effectiveAt.toISOString(),
        expiresAt: now().getTime() + actionTtl,
      },
      context.sessionToken,
      actionKey,
    );
  }
  function readAction(
    context: AuthenticatedContext & { readonly form: Readonly<Record<string, string>> },
    action: AdminAction['action'],
    reference?: string,
  ): AdminAction {
    const token = formValue(context.form, 'actionToken', 4096);
    const parsed =
      token === undefined
        ? undefined
        : verifyAdminAction(token, context.sessionToken, actionKey, now());
    if (parsed?.action !== action || (reference !== undefined && parsed.reference !== reference))
      throw new AdminFormError();
    return parsed;
  }

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { bodyLimit: bodyLimitBytes, parseAs: 'string' },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.addHook('onSend', async (_request, reply, payload) => {
    securityHeaders(reply);
    return payload;
  });

  app.setNotFoundHandler(async (_request, reply) => {
    const nonce = nonceSource();
    return html(reply, nonce, renderSafeErrorPage(nonce, 404), 404);
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof AdminFormError) {
      const nonce = nonceSource();
      return html(reply, nonce, renderSafeErrorPage(nonce, 400), 400);
    }
    logger.error('admin_request_failed', { requestId: request.id, statusCode: 500 });
    const nonce = nonceSource();
    return html(reply, nonce, renderSafeErrorPage(nonce, 500), 500);
  });

  async function requireSession(
    request: FastifyRequest,
    reply: FastifyReply,
    requiredRoles: readonly AdminRole[] = allRoles,
  ): Promise<AuthenticatedContext | undefined> {
    const cookies = parseCookies(request.headers.cookie);
    const tokenValue = cookies[sessionCookieName];
    const csrfToken = cookies[csrfCookieName];
    if (tokenValue === undefined || csrfToken === undefined) {
      redirect(reply, '/login');
      return undefined;
    }
    let session: ResolvedAdminSession | undefined;
    try {
      session = await options.identity.resolveSession({
        sessionToken: new AdminSecretText(tokenValue),
      });
    } catch {
      session = undefined;
    }
    if (session === undefined) {
      reply.header('set-cookie', [
        clearCookie(sessionCookieName, options.secureCookie, true),
        clearCookie(csrfCookieName, options.secureCookie, false),
      ]);
      redirect(reply, '/login');
      return undefined;
    }
    if (!hasRole(session, requiredRoles)) {
      const nonce = nonceSource();
      html(reply, nonce, renderSafeErrorPage(nonce, 403), 403);
      return undefined;
    }
    return {
      actor: {
        accountRef: session.accountRef,
        roles: session.roles,
        sessionToken: new AdminSecretText(tokenValue),
      },
      csrfToken,
      session,
      sessionToken: new AdminSecretText(tokenValue),
    };
  }

  async function requireMutation(
    request: FastifyRequest,
    reply: FastifyReply,
    requiredRoles: readonly AdminRole[],
  ): Promise<
    (AuthenticatedContext & { readonly form: Readonly<Record<string, string>> }) | undefined
  > {
    if (!exactOrigin(request, options.origin)) {
      logger.warn('admin_request_rejected', {
        reason: 'invalid_origin',
        requestId: request.id,
        statusCode: 403,
      });
      const nonce = nonceSource();
      html(reply, nonce, renderSafeErrorPage(nonce, 403), 403);
      return undefined;
    }
    const form = parseForm(request.body);
    if (form === undefined) {
      const nonce = nonceSource();
      html(reply, nonce, renderSafeErrorPage(nonce, 400), 400);
      return undefined;
    }
    const context = await requireSession(request, reply, requiredRoles);
    if (context === undefined) return undefined;
    const providedCsrf = formValue(form, 'csrfToken', 512);
    if (providedCsrf === undefined || providedCsrf !== context.csrfToken) {
      const nonce = nonceSource();
      html(reply, nonce, renderSafeErrorPage(nonce, 403), 403);
      return undefined;
    }
    let valid: boolean;
    try {
      valid = await options.identity.validateCsrf({
        csrfToken: new AdminSecretText(providedCsrf),
        expectedOrigin: options.origin,
        requestOrigin: request.headers.origin,
        sessionToken: context.sessionToken,
      });
    } catch {
      valid = false;
    }
    if (!valid) {
      logger.warn('admin_request_rejected', {
        reason: 'csrf_denied',
        requestId: request.id,
        statusCode: 403,
      });
      const nonce = nonceSource();
      html(reply, nonce, renderSafeErrorPage(nonce, 403), 403);
      return undefined;
    }
    return { ...context, form };
  }

  app.get('/', async (_request, reply) => redirect(reply, '/knowledge'));

  app.get('/login', async (_request, reply) => {
    const nonce = nonceSource();
    return html(reply, nonce, renderLoginPage(nonce));
  });

  app.post('/login', async (request, reply) => {
    if (!exactOrigin(request, options.origin)) {
      const nonce = nonceSource();
      return html(reply, nonce, renderSafeErrorPage(nonce, 403), 403);
    }
    const form = parseForm(request.body);
    const loginName = form === undefined ? undefined : formValue(form, 'loginName', 256);
    const password = form === undefined ? undefined : formValue(form, 'password', 256);
    if (loginName === undefined || password === undefined) {
      const nonce = nonceSource();
      return html(reply, nonce, renderLoginPage(nonce, 'Authentication failed.'), 401);
    }
    let result: AdminAuthenticationResult;
    try {
      result = await options.identity.beginPasswordAuthentication({
        loginName,
        password: new AdminSecretText(password),
      });
    } catch {
      result = { status: 'denied' };
    }
    if (result.status !== 'mfa_required') {
      const nonce = nonceSource();
      return html(reply, nonce, renderLoginPage(nonce, 'Authentication failed.'), 401);
    }
    reply.header('set-cookie', [
      cookie(sessionCookieName, result.sessionToken.reveal(), options.secureCookie, true),
      cookie(csrfCookieName, result.csrfToken.reveal(), options.secureCookie, false),
    ]);
    return redirect(reply, '/mfa');
  });

  app.get('/mfa', async (request, reply) => {
    const cookies = parseCookies(request.headers.cookie);
    const csrfToken = cookies[csrfCookieName];
    if (cookies[sessionCookieName] === undefined || csrfToken === undefined) {
      return redirect(reply, '/login');
    }
    const nonce = nonceSource();
    return html(reply, nonce, renderMfaPage(nonce, csrfToken));
  });

  app.post('/mfa', async (request, reply) => {
    if (!exactOrigin(request, options.origin)) {
      const nonce = nonceSource();
      return html(reply, nonce, renderSafeErrorPage(nonce, 403), 403);
    }
    const form = parseForm(request.body);
    const cookies = parseCookies(request.headers.cookie);
    const code = form === undefined ? undefined : formValue(form, 'code', 8);
    const providedCsrf = form === undefined ? undefined : formValue(form, 'csrfToken', 512);
    const cookieCsrf = cookies[csrfCookieName];
    const sessionTokenValue = cookies[sessionCookieName];
    if (
      code === undefined ||
      providedCsrf === undefined ||
      providedCsrf !== cookieCsrf ||
      sessionTokenValue === undefined
    ) {
      const nonce = nonceSource();
      return html(
        reply,
        nonce,
        renderMfaPage(nonce, cookieCsrf ?? '', 'Authentication failed.'),
        401,
      );
    }
    const preauthenticationToken = new AdminSecretText(sessionTokenValue);
    const csrfValid = await options.identity.validateCsrf({
      csrfToken: new AdminSecretText(providedCsrf),
      expectedOrigin: options.origin,
      requestOrigin: request.headers.origin,
      sessionToken: preauthenticationToken,
    });
    if (!csrfValid) {
      const nonce = nonceSource();
      return html(reply, nonce, renderSafeErrorPage(nonce, 403), 403);
    }
    let result: AdminMfaAuthenticationResult;
    try {
      result = await options.identity.completeMfaAuthentication({
        code,
        preauthenticationToken,
      });
    } catch {
      result = { status: 'denied' };
    }
    if (result.status !== 'authenticated') {
      const nonce = nonceSource();
      return html(reply, nonce, renderMfaPage(nonce, cookieCsrf, 'Authentication failed.'), 401);
    }
    reply.header('set-cookie', [
      cookie(sessionCookieName, result.sessionToken.reveal(), options.secureCookie, true),
      cookie(csrfCookieName, result.csrfToken.reveal(), options.secureCookie, false),
    ]);
    return redirect(reply, '/knowledge');
  });

  app.post('/logout', async (request, reply) => {
    const context = await requireMutation(request, reply, []);
    if (context === undefined) return;
    await options.identity.revokeSession({ sessionToken: context.sessionToken });
    reply.header('set-cookie', [
      clearCookie(sessionCookieName, options.secureCookie, true),
      clearCookie(csrfCookieName, options.secureCookie, false),
    ]);
    return redirect(reply, '/login');
  });

  async function knowledgePage(
    request: FastifyRequest,
    reply: FastifyReply,
    selectedVersionRef?: string,
  ) {
    const context = await requireSession(request, reply);
    if (context === undefined) return;
    const query = request.query as Readonly<Record<string, unknown>>;
    const search = typeof query.search === 'string' ? query.search.slice(0, 200) : '';
    const state = typeof query.state === 'string' ? query.state : '';
    const page = query.page === undefined ? 1 : Number(query.page);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new AdminFormError();
    const proposals = await options.dashboard.listProposals({ search, state, page });
    const selected =
      selectedVersionRef === undefined
        ? undefined
        : await options.dashboard.getProposal(selectedVersionRef);
    const nonce = nonceSource();
    return html(
      reply,
      nonce,
      renderKnowledgePage({
        csrfToken: context.csrfToken,
        nonce,
        proposals,
        page,
        hasNextPage: proposals.length === (options.listLimit ?? 100),
        search,
        state,
        actionTokens:
          selected === undefined
            ? {}
            : Object.fromEntries(
                (['submit', 'approve', 'reject'] as const).map((action) => [
                  action,
                  issueAction(context, action, selected.versionRef),
                ]),
              ),
        selected,
        session: context.session,
      }),
    );
  }

  app.get('/knowledge', async (request, reply) => knowledgePage(request, reply));
  app.get('/knowledge/new', async (request, reply) => {
    const context = await requireSession(request, reply, ['knowledge_editor']);
    if (context === undefined) return;
    const query = request.query as Readonly<Record<string, unknown>>;
    const replacementRef =
      typeof query.replaces === 'string' && referenceSchema.test(query.replaces)
        ? query.replaces
        : undefined;
    const replacement =
      replacementRef === undefined
        ? undefined
        : await options.dashboard.getProposal(replacementRef);
    const nonce = nonceSource();
    return html(
      reply,
      nonce,
      renderNewProposalPage({
        actionToken: issueAction(
          context,
          'create',
          `VERSION_admin_${randomBytes(18).toString('hex')}`,
          replacementRef,
        ),
        replacement,
        csrfToken: context.csrfToken,
        nonce,
        session: context.session,
      }),
    );
  });
  app.get('/knowledge/:versionRef', async (request, reply) => {
    const versionRef = routeReference(request);
    if (versionRef === undefined) {
      const nonce = nonceSource();
      return html(reply, nonce, renderSafeErrorPage(nonce, 400), 400);
    }
    return knowledgePage(request, reply, versionRef);
  });

  app.post('/knowledge', async (request, reply) => {
    const context = await requireMutation(request, reply, ['knowledge_editor']);
    if (context === undefined) return;
    const action = readAction(context, 'create');
    await options.dashboard.createProposal(
      {
        answerBn: formValue(context.form, 'answerBn', 4000),
        answerEn: formValue(context.form, 'answerEn', 4000),
        createdAt: new Date(action.effectiveAt),
        itemKey: formValue(context.form, 'itemKey', 128),
        kind: formValue(context.form, 'kind', 32),
        questionBn: formValue(context.form, 'questionBn', 1000),
        questionEn: formValue(context.form, 'questionEn', 1000),
        requestKey: action.requestKey,
        sourceLabel: formValue(context.form, 'sourceLabel', 200),
        versionRef: action.reference,
        ...(action.priorVersionRef === undefined
          ? {}
          : { replacesVersionRef: action.priorVersionRef }),
      },
      context.actor,
    );
    return redirect(reply, '/knowledge');
  });

  async function knowledgeMutation(
    request: FastifyRequest,
    reply: FastifyReply,
    action: 'publish' | 'retire' | 'rollback',
  ) {
    const versionRef = routeReference(request);
    const context = await requireMutation(request, reply, ['knowledge_reviewer']);
    if (context === undefined) return;
    if (
      versionRef === undefined ||
      formValue(context.form, 'confirmationVersionRef', 128) !== versionRef
    ) {
      const nonce = nonceSource();
      return html(reply, nonce, renderSafeErrorPage(nonce, 400), 400);
    }
    const confirmed = readAction(context, action, versionRef);
    const input = {
      effectiveAt: new Date(confirmed.effectiveAt),
      requestKey: confirmed.requestKey,
      versionRef,
      ...(confirmed.priorVersionRef === undefined
        ? {}
        : { priorVersionRef: confirmed.priorVersionRef }),
    };
    if (action === 'publish') await options.dashboard.publishVersion(input, context.actor);
    else if (action === 'retire') await options.dashboard.retireVersion(input, context.actor);
    else await options.dashboard.rollbackVersion(input, context.actor);
    return redirect(reply, `/knowledge/${versionRef}`);
  }

  for (const action of ['publish', 'retire', 'rollback'] as const) {
    app.get(`/knowledge/:versionRef/${action}`, async (request, reply) => {
      const versionRef = routeReference(request);
      const context = await requireSession(request, reply, ['knowledge_reviewer']);
      if (context === undefined) return;
      if (versionRef === undefined) {
        const nonce = nonceSource();
        return html(reply, nonce, renderSafeErrorPage(nonce, 400), 400);
      }
      const query = request.query as Readonly<Record<string, unknown>>;
      let effectiveAt = now();
      if (query.effectiveAt !== undefined) {
        if (
          typeof query.effectiveAt !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(query.effectiveAt)
        )
          throw new AdminFormError();
        effectiveAt = new Date(`${query.effectiveAt}:00.000Z`);
        if (!Number.isFinite(effectiveAt.getTime()) || effectiveAt < now())
          throw new AdminFormError();
      }
      const proposal = await options.dashboard.getProposal(versionRef, effectiveAt);
      const nonce = nonceSource();
      return html(
        reply,
        nonce,
        renderConfirmationPage({
          action,
          actionToken: issueAction(
            context,
            action,
            versionRef,
            proposal.currentVersionRef,
            effectiveAt,
          ),
          effectiveAt,
          csrfToken: context.csrfToken,
          nonce,
          proposal,
          session: context.session,
        }),
      );
    });
    app.post(`/knowledge/:versionRef/${action}`, async (request, reply) =>
      knowledgeMutation(request, reply, action),
    );
  }

  app.post('/knowledge/:versionRef/submit', async (request, reply) => {
    const versionRef = routeReference(request);
    const context = await requireMutation(request, reply, ['knowledge_editor']);
    if (context === undefined) return;
    if (versionRef === undefined) {
      const nonce = nonceSource();
      return html(reply, nonce, renderSafeErrorPage(nonce, 400), 400);
    }
    const action = readAction(context, 'submit', versionRef);
    await options.dashboard.submitVersion(
      { effectiveAt: new Date(action.effectiveAt), requestKey: action.requestKey, versionRef },
      context.actor,
    );
    return redirect(reply, `/knowledge/${versionRef}`);
  });

  app.post('/knowledge/:versionRef/review', async (request, reply) => {
    const versionRef = routeReference(request);
    const context = await requireMutation(request, reply, ['knowledge_reviewer']);
    if (context === undefined) return;
    const action = formValue(context.form, 'action', 16);
    if (versionRef === undefined || (action !== 'approve' && action !== 'reject')) {
      const nonce = nonceSource();
      return html(reply, nonce, renderSafeErrorPage(nonce, 400), 400);
    }
    const confirmed = readAction(context, action, versionRef);
    await options.dashboard.reviewVersion(
      {
        action,
        effectiveAt: new Date(confirmed.effectiveAt),
        requestKey: confirmed.requestKey,
        versionRef,
      },
      context.actor,
    );
    return redirect(reply, `/knowledge/${versionRef}`);
  });

  app.get('/questions', async (request, reply) => {
    const context = await requireSession(request, reply);
    if (context === undefined) return;
    const questions = await options.dashboard.listQuestions();
    const nonce = nonceSource();
    return html(
      reply,
      nonce,
      renderQuestionsPage({
        actionTokens: Object.fromEntries(
          questions.map((question) => [
            question.questionRef,
            issueAction(context, 'answer', question.questionRef),
          ]),
        ),
        csrfToken: context.csrfToken,
        nonce,
        questions,
        session: context.session,
      }),
    );
  });

  app.post('/questions/:questionRef/answers', async (request, reply) => {
    const questionRef = routeReference(request, 'questionRef');
    const context = await requireMutation(request, reply, ['knowledge_editor']);
    if (context === undefined) return;
    const answerText = formValue(context.form, 'answerText', 4000);
    const answerBn = formValue(context.form, 'answerBn', 4000);
    if (questionRef === undefined || answerText === undefined || answerBn === undefined) {
      const nonce = nonceSource();
      return html(reply, nonce, renderSafeErrorPage(nonce, 400), 400);
    }
    const action = readAction(context, 'answer', questionRef);
    await options.dashboard.answerQuestion(
      {
        answerText,
        answerBn,
        answeredAt: new Date(action.effectiveAt),
        questionRef,
        requestKey: action.requestKey,
      },
      context.actor,
    );
    return redirect(reply, '/questions');
  });

  app.get('/insights', async (request, reply) => {
    const context = await requireSession(request, reply);
    if (context === undefined) return;
    const insights = await options.dashboard.listInsights();
    const nonce = nonceSource();
    return html(
      reply,
      nonce,
      renderSimpleModulePage({
        csrfToken: context.csrfToken,
        currentPath: '/insights',
        description: 'Aggregate-only signals derived from privacy-safe support gaps.',
        nonce,
        rows: insights.map((entry) => ({
          label: entry.topicCode,
          meta: `${entry.categoryCode} · ${String(entry.occurrenceCount)} occurrences`,
        })),
        session: context.session,
        title: 'Customer insights',
      }),
    );
  });

  app.get('/policy', async (request, reply) => {
    const context = await requireSession(request, reply, ['administrator']);
    if (context === undefined) return;
    const policies = await options.dashboard.listModelPolicies();
    const createPolicyRef = `POLICY_admin_${randomBytes(18).toString('hex')}`;
    const nonce = nonceSource();
    return html(
      reply,
      nonce,
      renderModelPolicyPage({
        actionTokens: Object.fromEntries(
          policies.map((policy) => [
            policy.policyRef,
            Object.fromEntries(
              (['submit', 'approve', 'activate', 'retire'] as const).map((action) => [
                action,
                issueAction(context, `policy_${action}`, policy.policyRef),
              ]),
            ),
          ]),
        ),
        createActionToken: issueAction(context, 'policy_create', createPolicyRef),
        createPolicyRef,
        csrfToken: context.csrfToken,
        evaluatedAt: now(),
        nonce,
        policies,
        session: context.session,
      }),
    );
  });

  app.post('/policy', async (request, reply) => {
    const context = await requireMutation(request, reply, ['administrator']);
    if (context === undefined) return;
    const values = policyValues(context.form);
    if (values === undefined) {
      const nonce = nonceSource();
      return html(reply, nonce, renderSafeErrorPage(nonce, 400), 400);
    }
    const action = readAction(context, 'policy_create');
    await options.dashboard.createModelPolicy(
      {
        createdAt: new Date(action.effectiveAt),
        createdByAccountRef: context.actor.accountRef,
        policyRef: action.reference,
        requestKey: action.requestKey,
        values,
      },
      context.actor,
    );
    return redirect(reply, '/policy');
  });

  app.post('/policy/:policyRef/:policyAction', async (request, reply) => {
    const context = await requireMutation(request, reply, ['administrator']);
    if (context === undefined) return;
    const policyRef = routeReference(request, 'policyRef');
    const policyAction = routeReference(request, 'policyAction');
    if (
      policyRef === undefined ||
      (policyAction !== 'submit' &&
        policyAction !== 'approve' &&
        policyAction !== 'activate' &&
        policyAction !== 'retire')
    ) {
      const nonce = nonceSource();
      return html(reply, nonce, renderSafeErrorPage(nonce, 400), 400);
    }
    const action = readAction(context, `policy_${policyAction}`, policyRef);
    await options.dashboard.transitionModelPolicy(
      {
        action: policyAction,
        effectiveAt: new Date(action.effectiveAt),
        policyRef,
        reasonCode: `${policyAction}_reviewed`,
        requestKey: action.requestKey,
        reviewerAccountRef: context.actor.accountRef,
      },
      context.actor,
    );
    return redirect(reply, '/policy');
  });

  app.get('/escalations', async (request, reply) => {
    const context = await requireSession(request, reply, ['support_reviewer']);
    if (context === undefined) return;
    const counts = await options.dashboard.listEscalationCounts();
    const nonce = nonceSource();
    return html(
      reply,
      nonce,
      renderSimpleModulePage({
        csrfToken: context.csrfToken,
        currentPath: '/escalations',
        description: 'Content-free durable escalation counts by reason and state.',
        nonce,
        rows: counts.map((entry) => ({
          label: entry.reasonCode,
          meta: `${entry.state} · ${String(entry.count)}`,
        })),
        session: context.session,
        title: 'Escalations',
      }),
    );
  });

  app.get('/audit', async (request, reply) => {
    const context = await requireSession(request, reply, ['administrator']);
    if (context === undefined) return;
    const events = await options.dashboard.listAudit();
    const nonce = nonceSource();
    return html(
      reply,
      nonce,
      renderSimpleModulePage({
        csrfToken: context.csrfToken,
        currentPath: '/audit',
        description: 'Append-only bounded action and result history.',
        nonce,
        rows: events.map((event) => ({
          label: event.action,
          meta: `${event.result} · ${event.objectRef ?? 'none'} · ${event.effectiveAt.toISOString()}`,
        })),
        session: context.session,
        title: 'Audit history',
      }),
    );
  });

  if (options.operations !== undefined)
    registerOperationsRoutes(app, {
      operations: options.operations,
      requireSession,
      requireMutation,
      issueAction,
      readAction,
      nonce: nonceSource,
      html,
      redirect,
      invalidForm: () => {
        throw new AdminFormError();
      },
    });
  return app;
}
