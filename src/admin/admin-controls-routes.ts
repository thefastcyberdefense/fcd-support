import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AdminActionKind } from './admin-action.js';
import type { ResolvedAdminSession, AdminRole } from '../persistence/postgres-admin-identity.js';
import type { AdminActor, AdminDashboardPort } from './admin-app.js';
import type { AdminSecretText } from './admin-types.js';
import {
  renderAccountsPage,
  renderConsentPage,
  renderPausePage,
  renderPrivacyPage,
  renderWebsiteImportPage,
} from './admin-controls-html.js';
import { renderSafeErrorPage } from './admin-html.js';
import { OUTBOUND_PURPOSES } from '../outbound/outbound-types.js';
import { MARKETING_CATEGORIES } from '../policy/policy-types.js';

export interface SessionContextLike {
  readonly actor: AdminActor;
  readonly csrfToken: string;
  readonly session: ResolvedAdminSession;
  readonly sessionToken: AdminSecretText;
}

export interface MutationContextLike extends SessionContextLike {
  readonly form: Readonly<Record<string, string>>;
}

export interface AdminControlsRoutesDependencies {
  readonly dashboard: AdminDashboardPort;
  readonly now: () => Date;
  readonly requireSession: (
    request: FastifyRequest,
    reply: FastifyReply,
    requiredRoles?: readonly AdminRole[],
  ) => Promise<SessionContextLike | undefined>;
  readonly requireMutation: (
    request: FastifyRequest,
    reply: FastifyReply,
    requiredRoles?: readonly AdminRole[],
  ) => Promise<MutationContextLike | undefined>;
  readonly issueAction: (
    context: SessionContextLike,
    kind: AdminActionKind,
    reference?: string,
    priorVersionRef?: string,
  ) => string;
  readonly readAction: (
    context: MutationContextLike,
    kind: AdminActionKind,
    expectedReference?: string,
  ) => {
    readonly reference: string;
    readonly requestKey: string;
    readonly effectiveAt: string;
  };
  readonly routeReference: (request: FastifyRequest, name?: string) => string | undefined;
  readonly nonce: () => string;
  readonly html: (
    reply: FastifyReply,
    nonce: string,
    body: string,
    statusCode?: number,
  ) => FastifyReply;
  readonly redirect: (reply: FastifyReply, location: string) => FastifyReply;
  readonly invalidForm: () => never;
}

const rolesList: readonly AdminRole[] = [
  'knowledge_editor',
  'knowledge_reviewer',
  'support_reviewer',
  'administrator',
];

function formString(
  form: Readonly<Record<string, string>>,
  name: string,
  maximumLength: number,
): string | undefined {
  const value = form[name];
  return value === undefined || value.trim() === '' || value.length > maximumLength
    ? undefined
    : value;
}

function formPositiveInt(form: Readonly<Record<string, string>>, name: string): number | undefined {
  const value = form[name];
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

const roleCheckboxFields: readonly (readonly [string, AdminRole])[] = [
  ['roleKnowledgeEditor', 'knowledge_editor'],
  ['roleKnowledgeReviewer', 'knowledge_reviewer'],
  ['roleSupportReviewer', 'support_reviewer'],
  ['roleAdministrator', 'administrator'],
];

function parseRolesArray(form: Readonly<Record<string, string>>): AdminRole[] {
  const selected = new Set<AdminRole>();
  for (const [fieldName, role] of roleCheckboxFields) {
    const val = form[fieldName]?.trim().toLowerCase();
    if (val === '1' || val === 'true' || val === 'on' || val === 'yes') {
      selected.add(role);
    }
  }
  const combined = form.roles;
  if (typeof combined === 'string') {
    for (const part of combined.split(/[\s,]+/u)) {
      if (rolesList.includes(part as AdminRole)) {
        selected.add(part as AdminRole);
      }
    }
  }
  return [...selected];
}

export function registerAdminControlsRoutes(
  app: FastifyInstance,
  deps: AdminControlsRoutesDependencies,
): void {
  const renderUnavailable = (reply: FastifyReply, statusCode: number) => {
    const nonce = deps.nonce();
    return deps.html(reply, nonce, renderSafeErrorPage(nonce, statusCode), statusCode);
  };

  app.get('/accounts', async (request, reply) => {
    const context = await deps.requireSession(request, reply, ['administrator']);
    if (context === undefined) return;
    if (deps.dashboard.listAccounts === undefined) return renderUnavailable(reply, 404);
    const accounts = await deps.dashboard.listAccounts();
    const roleAssignTokens: Record<string, string> = {};
    const roleRevokeTokens: Record<string, string> = {};
    const revokeSessionTokens: Record<string, string> = {};
    const disableTokens: Record<string, string> = {};
    for (const acc of accounts) {
      revokeSessionTokens[acc.accountRef] = deps.issueAction(
        context,
        'staff_revoke_sessions',
        acc.accountRef,
      );
      disableTokens[acc.accountRef] = deps.issueAction(context, 'staff_disable', acc.accountRef);
      for (const role of rolesList) {
        const key = `${acc.accountRef}:${role}`;
        roleAssignTokens[key] = deps.issueAction(context, 'staff_role_assign', acc.accountRef);
        roleRevokeTokens[key] = deps.issueAction(context, 'staff_role_revoke', acc.accountRef);
      }
    }
    const nonce = deps.nonce();
    return deps.html(
      reply,
      nonce,
      renderAccountsPage({
        accounts,
        createToken: deps.issueAction(context, 'staff_create'),
        roleAssignTokens,
        roleRevokeTokens,
        revokeSessionTokens,
        disableTokens,
        csrfToken: context.csrfToken,
        nonce,
        session: context.session,
      }),
    );
  });

  app.post('/accounts', async (request, reply) => {
    const context = await deps.requireMutation(request, reply, ['administrator']);
    if (context === undefined) return;
    if (
      deps.dashboard.createStaffAccount === undefined ||
      deps.dashboard.listAccounts === undefined
    ) {
      return renderUnavailable(reply, 404);
    }
    const accountRef = formString(context.form, 'accountRef', 128);
    const loginName = formString(context.form, 'loginName', 64);
    const password = formString(context.form, 'password', 256);
    const roles = parseRolesArray(context.form);
    if (
      accountRef === undefined ||
      loginName === undefined ||
      password === undefined ||
      roles.length === 0
    ) {
      return deps.invalidForm();
    }
    const action = deps.readAction(context, 'staff_create');
    const createdStaff = await deps.dashboard.createStaffAccount(
      {
        accountRef,
        loginName,
        password,
        roles,
        requestKey: action.requestKey,
        createdAt: new Date(action.effectiveAt),
      },
      context.actor,
    );
    const accounts = await deps.dashboard.listAccounts();
    const roleAssignTokens: Record<string, string> = {};
    const roleRevokeTokens: Record<string, string> = {};
    const revokeSessionTokens: Record<string, string> = {};
    const disableTokens: Record<string, string> = {};
    for (const acc of accounts) {
      revokeSessionTokens[acc.accountRef] = deps.issueAction(
        context,
        'staff_revoke_sessions',
        acc.accountRef,
      );
      disableTokens[acc.accountRef] = deps.issueAction(context, 'staff_disable', acc.accountRef);
      for (const role of rolesList) {
        const key = `${acc.accountRef}:${role}`;
        roleAssignTokens[key] = deps.issueAction(context, 'staff_role_assign', acc.accountRef);
        roleRevokeTokens[key] = deps.issueAction(context, 'staff_role_revoke', acc.accountRef);
      }
    }
    const nonce = deps.nonce();
    return deps.html(
      reply,
      nonce,
      renderAccountsPage({
        accounts,
        createdStaff,
        createToken: deps.issueAction(context, 'staff_create'),
        roleAssignTokens,
        roleRevokeTokens,
        revokeSessionTokens,
        disableTokens,
        csrfToken: context.csrfToken,
        nonce,
        session: context.session,
      }),
    );
  });

  app.post('/accounts/:accountRef/roles/:roleAction', async (request, reply) => {
    const context = await deps.requireMutation(request, reply, ['administrator']);
    if (context === undefined) return;
    const targetAccountRef = deps.routeReference(request, 'accountRef');
    const roleAction = deps.routeReference(request, 'roleAction');
    const role = formString(context.form, 'role', 64);
    if (
      targetAccountRef === undefined ||
      (roleAction !== 'assign' && roleAction !== 'revoke') ||
      role === undefined ||
      !rolesList.includes(role as AdminRole)
    ) {
      return renderUnavailable(reply, 400);
    }
    const actionKind = roleAction === 'assign' ? 'staff_role_assign' : 'staff_role_revoke';
    const action = deps.readAction(context, actionKind, targetAccountRef);
    const cmd = {
      targetAccountRef,
      role: role as AdminRole,
      effectiveAt: new Date(action.effectiveAt),
      requestKey: action.requestKey,
    };
    if (roleAction === 'assign') {
      await deps.dashboard.assignStaffRole?.(cmd, context.actor);
    } else {
      await deps.dashboard.revokeStaffRole?.(cmd, context.actor);
    }
    return deps.redirect(reply, '/accounts');
  });

  app.post('/accounts/:accountRef/revoke-sessions', async (request, reply) => {
    const context = await deps.requireMutation(request, reply, ['administrator']);
    if (context === undefined) return;
    const targetAccountRef = deps.routeReference(request, 'accountRef');
    if (targetAccountRef === undefined) return renderUnavailable(reply, 400);
    deps.readAction(context, 'staff_revoke_sessions', targetAccountRef);
    await deps.dashboard.revokeStaffSessions?.({ targetAccountRef }, context.actor);
    return deps.redirect(reply, '/accounts');
  });

  app.post('/accounts/:accountRef/disable', async (request, reply) => {
    const context = await deps.requireMutation(request, reply, ['administrator']);
    if (context === undefined) return;
    const targetAccountRef = deps.routeReference(request, 'accountRef');
    if (targetAccountRef === undefined) return renderUnavailable(reply, 400);
    const action = deps.readAction(context, 'staff_disable', targetAccountRef);
    await deps.dashboard.disableStaffAccount?.(
      { targetAccountRef, requestKey: action.requestKey },
      context.actor,
    );
    return deps.redirect(reply, '/accounts');
  });

  app.get('/pause', async (request, reply) => {
    const context = await deps.requireSession(request, reply, ['support_reviewer']);
    if (context === undefined) return;
    const states = (await deps.dashboard.listPauseStates?.()) ?? [];
    const pauseTokens: Record<string, string> = {};
    const resumeTokens: Record<string, string> = {};
    for (const s of states) {
      pauseTokens[s.conversationId] = deps.issueAction(context, 'pause_apply', s.conversationId);
      resumeTokens[s.conversationId] = deps.issueAction(context, 'pause_resume', s.conversationId);
    }
    const nonce = deps.nonce();
    return deps.html(
      reply,
      nonce,
      renderPausePage({
        states,
        pauseTokens,
        resumeTokens,
        csrfToken: context.csrfToken,
        nonce,
        session: context.session,
      }),
    );
  });

  app.post('/pause/:conversationId/:pauseAction', async (request, reply) => {
    const context = await deps.requireMutation(request, reply, ['support_reviewer']);
    if (context === undefined) return;
    const conversationId = deps.routeReference(request, 'conversationId');
    const pauseAction = deps.routeReference(request, 'pauseAction');
    if (
      conversationId === undefined ||
      !/^[1-9][0-9]{0,18}$/u.test(conversationId) ||
      (pauseAction !== 'pause' && pauseAction !== 'resume')
    ) {
      return renderUnavailable(reply, 400);
    }
    const actionKind = pauseAction === 'pause' ? 'pause_apply' : 'pause_resume';
    const action = deps.readAction(context, actionKind, conversationId);
    const payload = {
      conversationId,
      effectiveAt: new Date(action.effectiveAt),
      requestKey: action.requestKey,
    };
    if (pauseAction === 'pause') {
      await deps.dashboard.pauseConversation?.(payload, context.actor);
    } else {
      await deps.dashboard.resumeConversation?.(payload, context.actor);
    }
    return deps.redirect(reply, '/pause');
  });

  app.get('/privacy', async (request, reply) => {
    const context = await deps.requireSession(request, reply, ['support_reviewer']);
    if (context === undefined) return;
    const [requests, locations] = await Promise.all([
      deps.dashboard.listPrivacyRequests?.() ?? [],
      deps.dashboard.listPrivacyLocations?.() ?? [],
    ]);
    const actionTokens: Record<string, Record<string, string>> = {};
    for (const r of requests) {
      actionTokens[r.requestRef] = {
        review: deps.issueAction(
          context,
          r.requestType === 'deletion' ? 'deletion_review' : 'privacy_review',
          r.requestRef,
        ),
        execute: deps.issueAction(context, 'deletion_execute', r.requestRef),
        collect: deps.issueAction(context, 'privacy_collect', r.requestRef),
        correct: deps.issueAction(context, 'privacy_correct', r.requestRef),
      };
    }
    const attestTokens: Record<string, string> = {};
    for (const l of locations) {
      attestTokens[`${l.requestRef}:${l.locationCode}`] = deps.issueAction(
        context,
        'privacy_attest',
        l.requestRef,
      );
    }
    const nonce = deps.nonce();
    return deps.html(
      reply,
      nonce,
      renderPrivacyPage({
        requests,
        locations,
        actionTokens,
        attestTokens,
        csrfToken: context.csrfToken,
        nonce,
        session: context.session,
      }),
    );
  });

  app.post('/privacy/:requestRef/deletion/review', async (request, reply) => {
    const context = await deps.requireMutation(request, reply, ['support_reviewer']);
    if (context === undefined) return;
    const requestRef = deps.routeReference(request, 'requestRef');
    const decision = formString(context.form, 'decision', 16);
    const reasonCode = formString(context.form, 'reasonCode', 64);
    if (
      requestRef === undefined ||
      (decision !== 'approve' && decision !== 'reject') ||
      (reasonCode !== 'customer_confirmed' &&
        reasonCode !== 'identity_ambiguous' &&
        reasonCode !== 'request_withdrawn')
    ) {
      return renderUnavailable(reply, 400);
    }
    const action = deps.readAction(context, 'deletion_review', requestRef);
    await deps.dashboard.reviewDeletionRequest?.(
      {
        requestRef,
        decision,
        reasonCode,
        decidedAt: new Date(action.effectiveAt),
        requestKey: action.requestKey,
        verificationMethod: 'known_name',
      },
      context.actor,
    );
    return deps.redirect(reply, '/privacy');
  });

  app.post('/privacy/:requestRef/deletion/execute', async (request, reply) => {
    const context = await deps.requireMutation(request, reply, ['support_reviewer']);
    if (context === undefined) return;
    const requestRef = deps.routeReference(request, 'requestRef');
    if (requestRef === undefined) return renderUnavailable(reply, 400);
    const action = deps.readAction(context, 'deletion_execute', requestRef);
    await deps.dashboard.executeDeletionRequest?.(
      { requestRef, executedAt: new Date(action.effectiveAt), requestKey: action.requestKey },
      context.actor,
    );
    return deps.redirect(reply, '/privacy');
  });

  app.post('/privacy/:requestRef/review', async (request, reply) => {
    const context = await deps.requireMutation(request, reply, ['support_reviewer']);
    if (context === undefined) return;
    const requestRef = deps.routeReference(request, 'requestRef');
    const decision = formString(context.form, 'decision', 16);
    const reasonCode = formString(context.form, 'reasonCode', 64);
    if (
      requestRef === undefined ||
      (decision !== 'approve' && decision !== 'reject') ||
      (reasonCode !== 'identity_verified' &&
        reasonCode !== 'identity_ambiguous' &&
        reasonCode !== 'request_withdrawn')
    ) {
      return renderUnavailable(reply, 400);
    }
    const action = deps.readAction(context, 'privacy_review', requestRef);
    await deps.dashboard.reviewPrivacyRequest?.(
      {
        requestRef,
        decision,
        reasonCode,
        decidedAt: new Date(action.effectiveAt),
        requestKey: action.requestKey,
      },
      context.actor,
    );
    return deps.redirect(reply, '/privacy');
  });

  app.post('/privacy/:requestRef/access/collect', async (request, reply) => {
    const context = await deps.requireMutation(request, reply, ['support_reviewer']);
    if (context === undefined) return;
    const requestRef = deps.routeReference(request, 'requestRef');
    if (requestRef === undefined || deps.dashboard.collectPrivacyAccessExport === undefined) {
      return renderUnavailable(reply, 400);
    }
    const action = deps.readAction(context, 'privacy_collect', requestRef);
    const accessBundle = await deps.dashboard.collectPrivacyAccessExport(
      { requestRef, collectedAt: new Date(action.effectiveAt), requestKey: action.requestKey },
      context.actor,
    );
    const [requests, locations] = await Promise.all([
      deps.dashboard.listPrivacyRequests?.() ?? [],
      deps.dashboard.listPrivacyLocations?.() ?? [],
    ]);
    const actionTokens: Record<string, Record<string, string>> = {};
    for (const r of requests) {
      actionTokens[r.requestRef] = {
        review: deps.issueAction(
          context,
          r.requestType === 'deletion' ? 'deletion_review' : 'privacy_review',
          r.requestRef,
        ),
        execute: deps.issueAction(context, 'deletion_execute', r.requestRef),
        collect: deps.issueAction(context, 'privacy_collect', r.requestRef),
        correct: deps.issueAction(context, 'privacy_correct', r.requestRef),
      };
    }
    const attestTokens: Record<string, string> = {};
    for (const l of locations) {
      attestTokens[`${l.requestRef}:${l.locationCode}`] = deps.issueAction(
        context,
        'privacy_attest',
        l.requestRef,
      );
    }
    const nonce = deps.nonce();
    return deps.html(
      reply,
      nonce,
      renderPrivacyPage({
        requests,
        locations,
        actionTokens,
        attestTokens,
        accessBundle,
        csrfToken: context.csrfToken,
        nonce,
        session: context.session,
      }),
    );
  });

  app.post('/privacy/:requestRef/correction/execute', async (request, reply) => {
    const context = await deps.requireMutation(request, reply, ['support_reviewer']);
    if (context === undefined) return;
    const requestRef = deps.routeReference(request, 'requestRef');
    const fieldKey = formString(context.form, 'fieldKey', 64);
    const newValue = formString(context.form, 'newValue', 200);
    if (requestRef === undefined || fieldKey === undefined || newValue === undefined) {
      return deps.invalidForm();
    }
    const action = deps.readAction(context, 'privacy_correct', requestRef);
    await deps.dashboard.executePrivacyCorrection?.(
      {
        requestRef,
        fieldKey,
        newValue,
        executedAt: new Date(action.effectiveAt),
        requestKey: action.requestKey,
      },
      context.actor,
    );
    return deps.redirect(reply, '/privacy');
  });

  app.post('/privacy/:requestRef/locations/:locationCode/attest', async (request, reply) => {
    const context = await deps.requireMutation(request, reply, ['support_reviewer']);
    if (context === undefined) return;
    const requestRef = deps.routeReference(request, 'requestRef');
    const locationCode = deps.routeReference(request, 'locationCode');
    const state = formString(context.form, 'state', 32);
    if (
      requestRef === undefined ||
      locationCode === undefined ||
      (state !== 'completed' && state !== 'failed' && state !== 'not_applicable')
    ) {
      return renderUnavailable(reply, 400);
    }
    const outcomeCode =
      state === 'completed'
        ? 'location_complete'
        : state === 'failed'
          ? 'location_failed'
          : 'location_not_applicable';
    const action = deps.readAction(context, 'privacy_attest', requestRef);
    await deps.dashboard.attestPrivacyLocation?.(
      {
        requestRef,
        locationCode,
        state,
        outcomeCode,
        checkedAt: new Date(action.effectiveAt),
        requestKey: action.requestKey,
      },
      context.actor,
    );
    return deps.redirect(reply, '/privacy');
  });

  app.get('/consent', async (request, reply) => {
    const context = await deps.requireSession(request, reply, ['support_reviewer']);
    if (context === undefined) return;
    const [identities, outboundPolicies, outboundTemplates] = await Promise.all([
      deps.dashboard.listConsentIdentities?.() ?? [],
      deps.dashboard.listOutboundPolicies?.() ?? [],
      deps.dashboard.listOutboundTemplates?.() ?? [],
    ]);
    const consentTokens: Record<string, string> = {};
    const reoptInTokens: Record<string, string> = {};
    for (const id of identities) {
      consentTokens[id.channelIdentityId] = deps.issueAction(
        context,
        'consent_record',
        id.channelIdentityId,
      );
      reoptInTokens[id.channelIdentityId] = deps.issueAction(
        context,
        'marketing_reopt_in',
        id.channelIdentityId,
      );
    }
    const policyActionTokens: Record<string, string> = {};
    for (const pol of outboundPolicies) {
      for (const act of ['submit', 'approve', 'activate', 'retire'] as const) {
        policyActionTokens[`${pol.policyRef}:${act}`] = deps.issueAction(
          context,
          `outbound_policy_${act}`,
          pol.policyRef,
        );
      }
    }
    const templateActionTokens: Record<string, string> = {};
    for (const tpl of outboundTemplates) {
      for (const act of ['submit', 'approve', 'activate', 'retire'] as const) {
        templateActionTokens[`${tpl.templateRef}:${String(tpl.versionNumber)}:${act}`] =
          deps.issueAction(context, `outbound_template_${act}`, tpl.templateRef);
      }
    }
    const nonce = deps.nonce();
    return deps.html(
      reply,
      nonce,
      renderConsentPage({
        identities,
        outboundPolicies,
        outboundTemplates,
        consentTokens,
        reoptInTokens,
        createPolicyToken: deps.issueAction(context, 'outbound_policy_create'),
        policyActionTokens,
        createTemplateToken: deps.issueAction(context, 'outbound_template_create'),
        templateActionTokens,
        csrfToken: context.csrfToken,
        nonce,
        session: context.session,
      }),
    );
  });

  app.post('/consent/record', async (request, reply) => {
    const context = await deps.requireMutation(request, reply, ['support_reviewer']);
    if (context === undefined) return;
    const channelIdentityId = formString(context.form, 'channelIdentityId', 32);
    const category = formString(context.form, 'category', 64);
    const consentAction = formString(context.form, 'action', 16);
    const wording = formString(context.form, 'wording', 500);
    const wordingVersion = formString(context.form, 'wordingVersion', 64);
    if (
      channelIdentityId === undefined ||
      category === undefined ||
      !MARKETING_CATEGORIES.includes(category as (typeof MARKETING_CATEGORIES)[number]) ||
      (consentAction !== 'grant' && consentAction !== 'revoke') ||
      wording === undefined ||
      wordingVersion === undefined
    ) {
      return deps.invalidForm();
    }
    const action = deps.readAction(context, 'consent_record', channelIdentityId);
    await deps.dashboard.recordReviewerConsent?.(
      {
        channelIdentityId,
        category,
        action: consentAction,
        wording,
        wordingVersion,
        sourceAt: new Date(action.effectiveAt),
        requestKey: action.requestKey,
      },
      context.actor,
    );
    return deps.redirect(reply, '/consent');
  });

  app.post('/consent/reopt-in', async (request, reply) => {
    const context = await deps.requireMutation(request, reply, ['support_reviewer']);
    if (context === undefined) return;
    const channelIdentityId = formString(context.form, 'channelIdentityId', 32);
    const category = formString(context.form, 'category', 64);
    if (
      channelIdentityId === undefined ||
      category === undefined ||
      !MARKETING_CATEGORIES.includes(category as (typeof MARKETING_CATEGORIES)[number])
    ) {
      return deps.invalidForm();
    }
    const action = deps.readAction(context, 'marketing_reopt_in', channelIdentityId);
    await deps.dashboard.recordMarketingReoptIn?.(
      {
        channelIdentityId,
        categories: [category],
        wording: 'Explicit reviewer-verified marketing re-opt-in',
        wordingVersion: '2026-11',
        verificationMethod: 'known_name',
        effectiveAt: new Date(action.effectiveAt),
        requestKey: action.requestKey,
      },
      context.actor,
    );
    return deps.redirect(reply, '/consent');
  });

  app.post('/consent/outbound-policy', async (request, reply) => {
    const context = await deps.requireMutation(request, reply, ['administrator']);
    if (context === undefined) return;
    const perContact15Minute = formPositiveInt(context.form, 'perContact15Minute');
    const perContact24Hour = formPositiveInt(context.form, 'perContact24Hour');
    const global1Minute = formPositiveInt(context.form, 'global1Minute');
    const globalUtcDay = formPositiveInt(context.form, 'globalUtcDay');
    if (
      perContact15Minute === undefined ||
      perContact24Hour === undefined ||
      global1Minute === undefined ||
      globalUtcDay === undefined
    ) {
      return deps.invalidForm();
    }
    const action = deps.readAction(context, 'outbound_policy_create');
    await deps.dashboard.createOutboundPolicy?.(
      {
        policyRef: action.reference,
        requestKey: action.requestKey,
        createdAt: new Date(action.effectiveAt),
        values: {
          perContact15Minute,
          perContact24Hour,
          whatsappAccount1Minute: global1Minute,
          messengerAccount1Minute: global1Minute,
          global1Minute,
          globalUtcDay,
          workerBatchSize: 20,
          leaseMs: 10_000,
          providerTimeoutMs: 5_000,
          maximumDefiniteRetries: 2,
          retryBaseMs: 1_000,
          retryMaximumMs: 10_000,
        },
      },
      context.actor,
    );
    return deps.redirect(reply, '/consent');
  });

  app.post('/consent/outbound-policy/:policyRef/:policyAction', async (request, reply) => {
    const context = await deps.requireMutation(request, reply, ['administrator']);
    if (context === undefined) return;
    const policyRef = deps.routeReference(request, 'policyRef');
    const policyAction = deps.routeReference(request, 'policyAction');
    if (
      policyRef === undefined ||
      (policyAction !== 'submit' &&
        policyAction !== 'approve' &&
        policyAction !== 'activate' &&
        policyAction !== 'retire')
    ) {
      return renderUnavailable(reply, 400);
    }
    const action = deps.readAction(context, `outbound_policy_${policyAction}`, policyRef);
    await deps.dashboard.transitionOutboundPolicy?.(
      {
        action: policyAction,
        policyRef,
        requestKey: action.requestKey,
        effectiveAt: new Date(action.effectiveAt),
      },
      context.actor,
    );
    return deps.redirect(reply, '/consent');
  });

  app.post('/consent/outbound-template', async (request, reply) => {
    const context = await deps.requireMutation(request, reply, ['administrator']);
    if (context === undefined) return;
    const channelAccountId = formString(context.form, 'channelAccountId', 254);
    const providerTemplateId = formString(context.form, 'providerTemplateId', 254);
    const templateName = formString(context.form, 'templateName', 512);
    const locale = formString(context.form, 'locale', 16);
    const category = formString(context.form, 'category', 64);
    const templateText = formString(context.form, 'templateText', 4000);
    if (
      channelAccountId === undefined ||
      providerTemplateId === undefined ||
      templateName === undefined ||
      (locale !== 'en_US' && locale !== 'bn_BD') ||
      category === undefined ||
      !OUTBOUND_PURPOSES.includes(category as (typeof OUTBOUND_PURPOSES)[number]) ||
      templateText === undefined
    ) {
      return deps.invalidForm();
    }
    const action = deps.readAction(context, 'outbound_template_create');
    await deps.dashboard.createOutboundTemplate?.(
      {
        templateRef: action.reference,
        channelAccountId,
        providerTemplateId,
        templateName,
        locale,
        category: category as (typeof OUTBOUND_PURPOSES)[number],
        templateText,
        requestKey: action.requestKey,
        createdAt: new Date(action.effectiveAt),
      },
      context.actor,
    );
    return deps.redirect(reply, '/consent');
  });

  app.post(
    '/consent/outbound-template/:templateRef/:versionNumber/:templateAction',
    async (request, reply) => {
      const context = await deps.requireMutation(request, reply, ['administrator']);
      if (context === undefined) return;
      const templateRef = deps.routeReference(request, 'templateRef');
      const rawVersion = deps.routeReference(request, 'versionNumber');
      const templateAction = deps.routeReference(request, 'templateAction');
      const versionNumber = rawVersion !== undefined ? Number(rawVersion) : NaN;
      if (
        templateRef === undefined ||
        !Number.isSafeInteger(versionNumber) ||
        versionNumber < 1 ||
        (templateAction !== 'submit' &&
          templateAction !== 'approve' &&
          templateAction !== 'activate' &&
          templateAction !== 'retire')
      ) {
        return renderUnavailable(reply, 400);
      }
      const action = deps.readAction(context, `outbound_template_${templateAction}`, templateRef);
      await deps.dashboard.transitionOutboundTemplate?.(
        {
          action: templateAction,
          templateRef,
          versionNumber,
          requestKey: action.requestKey,
          effectiveAt: new Date(action.effectiveAt),
        },
        context.actor,
      );
      return deps.redirect(reply, '/consent');
    },
  );

  app.get('/knowledge/import', async (request, reply) => {
    const context = await deps.requireSession(request, reply, ['knowledge_editor']);
    if (context === undefined) return;
    const snapshots = (await deps.dashboard.listWebsiteSnapshots?.()) ?? [];
    const nonce = deps.nonce();
    return deps.html(
      reply,
      nonce,
      renderWebsiteImportPage({
        snapshots,
        importToken: deps.issueAction(context, 'knowledge_import'),
        csrfToken: context.csrfToken,
        nonce,
        session: context.session,
      }),
    );
  });

  app.post('/knowledge/import', async (request, reply) => {
    const context = await deps.requireMutation(request, reply, ['knowledge_editor']);
    if (context === undefined) return;
    const action = deps.readAction(context, 'knowledge_import');
    const url = formString(context.form, 'url', 2048);
    if (url === undefined) return deps.invalidForm();
    const label = formString(context.form, 'label', 200);
    const pastedHtmlOrText = formString(context.form, 'pastedHtmlOrText', 5000);
    const itemKey = formString(context.form, 'itemKey', 128);
    const kind = formString(context.form, 'kind', 32);
    const questionEn = formString(context.form, 'questionEn', 1000);
    const answerEn = formString(context.form, 'answerEn', 4000);
    const questionBn = formString(context.form, 'questionBn', 1000);
    const answerBn = formString(context.form, 'answerBn', 4000);

    const anyDraftField =
      itemKey !== undefined ||
      questionEn !== undefined ||
      answerEn !== undefined ||
      questionBn !== undefined ||
      answerBn !== undefined;
    let optionalDraft:
      | {
          readonly versionRef: string;
          readonly itemKey: string;
          readonly kind: 'business_fact' | 'faq';
          readonly questionEn: string;
          readonly questionBn: string;
          readonly answerEn: string;
          readonly answerBn: string;
        }
      | undefined;
    if (anyDraftField) {
      if (
        itemKey === undefined ||
        (kind !== 'faq' && kind !== 'business_fact') ||
        questionEn === undefined ||
        answerEn === undefined ||
        questionBn === undefined ||
        answerBn === undefined
      ) {
        return deps.invalidForm();
      }
      optionalDraft = {
        versionRef: action.reference,
        itemKey,
        kind,
        questionEn,
        questionBn,
        answerEn,
        answerBn,
      };
    }

    await deps.dashboard.importWebsiteSource?.(
      {
        url,
        ...(label === undefined ? {} : { label }),
        ...(pastedHtmlOrText === undefined ? {} : { pastedHtmlOrText }),
        fetchedAt: new Date(action.effectiveAt),
        requestKey: action.requestKey,
        ...(optionalDraft === undefined ? {} : { optionalDraft }),
      },
      context.actor,
    );
    return deps.redirect(reply, '/knowledge/import');
  });

  app.post('/questions/:questionRef/dismiss', async (request, reply) => {
    const context = await deps.requireMutation(request, reply, ['knowledge_editor']);
    if (context === undefined) return;
    const questionRef = deps.routeReference(request, 'questionRef');
    if (questionRef === undefined) return renderUnavailable(reply, 400);
    const action = deps.readAction(context, 'question_dismiss', questionRef);
    await deps.dashboard.dismissQuestion?.(
      {
        questionRef,
        dismissedAt: new Date(action.effectiveAt),
        reasonCode: 'dismissed_by_editor',
        requestKey: action.requestKey,
      },
      context.actor,
    );
    return deps.redirect(reply, '/questions');
  });

  app.post('/insights/aggregate', async (request, reply) => {
    const context = await deps.requireMutation(request, reply, [
      'knowledge_editor',
      'support_reviewer',
    ]);
    if (context === undefined) return;
    const action = deps.readAction(context, 'insights_aggregate');
    const endedAt = new Date(action.effectiveAt);
    const startedAt = new Date(endedAt.getTime() - 7 * 24 * 60 * 60 * 1000);
    await deps.dashboard.triggerInsightAggregation?.(
      {
        runRef: action.reference,
        requestKey: action.requestKey,
        windowStartedAt: startedAt,
        windowEndedAt: endedAt,
      },
      context.actor,
    );
    return deps.redirect(reply, '/insights');
  });

  app.post('/insights/digest', async (request, reply) => {
    const context = await deps.requireMutation(request, reply, [
      'knowledge_editor',
      'support_reviewer',
    ]);
    if (context === undefined) return;
    const action = deps.readAction(context, 'insights_digest');
    await deps.dashboard.triggerQuestionDigest?.(
      {
        digestRef: action.reference,
        requestKey: action.requestKey,
        effectiveAt: new Date(action.effectiveAt),
      },
      context.actor,
    );
    return deps.redirect(reply, '/insights');
  });
}
