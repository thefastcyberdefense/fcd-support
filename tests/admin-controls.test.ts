import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  buildAdminApp,
  type AdminDashboardPort,
  type AdminIdentityPort,
} from '../src/admin/admin-app.js';
import { loadAdminConfig } from '../src/admin/admin-config.js';
import type {
  AdminAccountSummary,
  AdminConsentIdentitySummary,
  AdminOutboundPolicySummary,
  AdminOutboundTemplateSummary,
  AdminPauseStateSummary,
  AdminPrivacyAccessBundle,
  AdminPrivacyLocationSummary,
  AdminPrivacyRequestSummary,
  AdminStaffCreateResult,
  AdminWebsiteSnapshotSummary,
} from '../src/admin/admin-controls-types.js';
import type {
  AdminPolicySummary,
  AdminProposalDetail,
  AdminProposalSummary,
  AdminQuestionSummary,
} from '../src/admin/admin-html.js';
import { AdminSecretBytes, AdminSecretText } from '../src/admin/admin-types.js';
import { buildTotpProvisioningUri, encodeBase32 } from '../src/admin/mfa.js';
import type { ModelGatewayProfileView } from '../src/model/gateway-types.js';
import { loadRoleEnvironment } from '../src/operations/secret-files.js';
import { AdminControlConflictError } from '../src/persistence/postgres-admin-controls.js';
import {
  AdminIdentityConflictError,
  type ResolvedAdminSession,
} from '../src/persistence/postgres-admin-identity.js';
import { PolicyRecordNotFoundError } from '../src/persistence/postgres-takeover-policy.js';

const apps: FastifyInstance[] = [];
const origin = 'http://127.0.0.1:3004';
const activeToken = new AdminSecretText('synthetic-controls-session-token');
const activeCsrf = new AdminSecretText('synthetic-controls-csrf-token');
const key = Buffer.alloc(32, 0x41).toString('base64url');
const syntheticKeyring = JSON.stringify({
  activeVersion: 'TEST_v1',
  keys: [{ version: 'TEST_v1', keyBase64url: Buffer.alloc(32, 0x51).toString('base64url') }],
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function formHeaders(cookie?: string, requestOrigin = origin) {
  return {
    ...(cookie === undefined ? {} : { cookie }),
    'content-type': 'application/x-www-form-urlencoded',
    origin: requestOrigin,
  };
}

function activeCookies(): string {
  return `fcd_admin_session=${activeToken.reveal()}; fcd_admin_csrf=${activeCsrf.reveal()}`;
}

function hiddenValue(body: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(body);
  if (match?.[1] === undefined) throw new Error(`Expected form field ${name} was absent`);
  return match[1];
}

function formHiddenValue(
  body: string,
  action: string,
  name: string,
  extraContains?: string,
): string {
  const escapedAction = action.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`<form[^>]+action="${escapedAction}"[^>]*>([\\s\\S]*?)</form>`, 'gu');
  for (const match of body.matchAll(pattern)) {
    const form = match[1];
    if (form !== undefined && (extraContains === undefined || form.includes(extraContains))) {
      return hiddenValue(form, name);
    }
  }
  throw new Error(`Expected action form ${action} was absent`);
}

function dashboardPort(overrides: Partial<AdminDashboardPort> = {}): AdminDashboardPort {
  const accounts: readonly AdminAccountSummary[] = [
    {
      accountRef: 'ADMIN_TEST_lead',
      loginName: 'synthetic.lead',
      state: 'active',
      roles: ['administrator'],
      activeSessionCount: 1,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    },
    {
      accountRef: 'ADMIN_TEST_staff',
      loginName: 'synthetic.staff',
      state: 'active',
      roles: ['support_reviewer'],
      activeSessionCount: 2,
      createdAt: new Date('2026-09-01T01:00:00.000Z'),
    },
  ];
  const pauseStates: readonly AdminPauseStateSummary[] = [
    {
      conversationId: '42',
      contactId: '7',
      channel: 'whatsapp',
      externalContactId: '15550000101',
      aiPausedUntil: null,
      lastAuthorizedResumeAt: null,
      lastActivityAt: new Date('2026-09-02T05:30:00.000Z'),
      lastPauseAction: null,
      lastPauseActorKind: null,
      lastPauseEffectiveAt: null,
    },
  ];
  const privacyRequests: readonly AdminPrivacyRequestSummary[] = [
    {
      requestRef: 'PRIVACY_TEST_del',
      requestType: 'deletion',
      state: 'awaiting_confirmation',
      contactId: '7',
      receivedAt: new Date('2026-09-02T04:00:00.000Z'),
      decisionAt: null,
      completedAt: null,
      decisionCode: null,
      reasonCode: null,
      pendingLocations: 1,
      totalLocations: 1,
      deletionStatus: null,
      tombstonesCreated: null,
      accessStatus: null,
      accessRecordCount: null,
      accessBundleSha256: null,
      correctionResultCode: null,
      correctionFieldKey: null,
    },
    {
      requestRef: 'PRIVACY_TEST_acc',
      requestType: 'access',
      state: 'in_progress',
      contactId: '7',
      receivedAt: new Date('2026-09-02T04:05:00.000Z'),
      decisionAt: null,
      completedAt: null,
      decisionCode: null,
      reasonCode: null,
      pendingLocations: 1,
      totalLocations: 1,
      deletionStatus: null,
      tombstonesCreated: null,
      accessStatus: null,
      accessRecordCount: null,
      accessBundleSha256: null,
      correctionResultCode: null,
      correctionFieldKey: null,
    },
    {
      requestRef: 'PRIVACY_TEST_cor',
      requestType: 'correction',
      state: 'in_progress',
      contactId: '7',
      receivedAt: new Date('2026-09-02T04:10:00.000Z'),
      decisionAt: null,
      completedAt: null,
      decisionCode: null,
      reasonCode: null,
      pendingLocations: 0,
      totalLocations: 0,
      deletionStatus: null,
      tombstonesCreated: null,
      accessStatus: null,
      accessRecordCount: null,
      accessBundleSha256: null,
      correctionResultCode: null,
      correctionFieldKey: null,
    },
  ];
  const privacyLocations: readonly AdminPrivacyLocationSummary[] = [
    {
      requestRef: 'PRIVACY_TEST_acc',
      locationCode: 'primary_postgres',
      required: true,
      state: 'pending',
      outcomeCode: null,
      reviewerReference: null,
      checkedAt: null,
    },
  ];
  const consentIdentities: readonly AdminConsentIdentitySummary[] = [
    {
      channelIdentityId: '11',
      contactId: '7',
      channel: 'whatsapp',
      channelAccountId: 'PHONE_TEST_1',
      externalContactId: '15550000101',
      preferredLanguage: 'en',
      categoryStates: {
        product_offers: {
          action: 'revoke',
          sourceAt: new Date('2026-09-02T03:00:00.000Z'),
        },
      },
    },
  ];
  const outboundPolicies: readonly AdminOutboundPolicySummary[] = [
    {
      policyRef: 'OUTBOUND_TEST_pol_1',
      versionNumber: 1,
      state: 'draft',
      perContact15Minute: 5,
      perContact24Hour: 20,
      global1Minute: 60,
      globalUtcDay: 1000,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  ];
  const outboundTemplates: readonly AdminOutboundTemplateSummary[] = [
    {
      templateRef: 'TEMPLATE_TEST_1',
      versionNumber: 1,
      channelAccountId: 'PHONE_TEST_1',
      templateName: 'service_update_v1',
      locale: 'en_US',
      category: 'customer_support',
      state: 'draft',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  ];
  const snapshots: readonly AdminWebsiteSnapshotSummary[] = [
    {
      snapshotRef: 'SNAP_TEST_1',
      sourceRef: 'SOURCE_web_test1',
      approvedUrl: 'https://example.org/faq',
      label: 'Official FAQ',
      fetchedAt: new Date('2026-09-02T05:00:00.000Z'),
      sourceSha256: 'a'.repeat(64),
      contentSha256: 'b'.repeat(64),
      excerpt: 'Reviewed official FAQ text.',
    },
  ];

  return {
    answerQuestion: vi.fn(() => Promise.resolve()),
    assignStaffRole: vi.fn(() => Promise.resolve()),
    attestPrivacyLocation: vi.fn(() => Promise.resolve()),
    collectPrivacyAccessExport: vi.fn(() =>
      Promise.resolve({
        requestRef: 'PRIVACY_TEST_acc',
        contactId: '7',
        preferredLanguage: 'en',
        recordCount: 2,
        bundleSha256: 'f'.repeat(64),
        status: 'applied',
        entries: [],
      } satisfies AdminPrivacyAccessBundle),
    ),
    createGatewayProfile: vi.fn(() => Promise.resolve()),
    createModelPolicy: vi.fn(() => Promise.resolve()),
    createOutboundPolicy: vi.fn(() => Promise.resolve()),
    createOutboundTemplate: vi.fn(() => Promise.resolve()),
    createProposal: vi.fn(() => Promise.resolve()),
    createStaffAccount: vi.fn(() =>
      Promise.resolve({
        accountRef: 'ADMIN_TEST_created',
        loginName: 'synthetic.created',
        roles: ['knowledge_editor', 'support_reviewer'],
        base32Secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
        provisioningUri: 'otpauth://totp/FCD%20Support%20Admin:synthetic.created?secret=GEZD',
        status: 'applied',
      } satisfies AdminStaffCreateResult),
    ),
    disableStaffAccount: vi.fn(() => Promise.resolve()),
    dismissQuestion: vi.fn(() => Promise.resolve()),
    executeDeletionRequest: vi.fn(() => Promise.resolve()),
    executePrivacyCorrection: vi.fn(() => Promise.resolve()),
    getProposal: vi.fn(() =>
      Promise.resolve({
        answerBn: 'উত্তর',
        answerEn: 'Answer',
        currentVersionRef: 'VERSION_1',
        itemKey: 'faq.test',
        kind: 'faq',
        questionBn: 'প্রশ্ন',
        questionEn: 'Question',
        sourceLabel: 'Manual',
        state: 'submitted',
        versionRef: 'VERSION_2',
      } satisfies AdminProposalDetail),
    ),
    importWebsiteSource: vi.fn(() =>
      Promise.resolve({ sourceRef: 'SOURCE_web_test1', snapshotRef: 'SNAP_TEST_new' }),
    ),
    listAccounts: vi.fn(() => Promise.resolve(accounts)),
    listAudit: vi.fn(() => Promise.resolve([])),
    listConsentIdentities: vi.fn(() => Promise.resolve(consentIdentities)),
    listEscalationCounts: vi.fn(() => Promise.resolve([])),
    listGatewayProfiles: vi.fn(() =>
      Promise.resolve([] satisfies readonly ModelGatewayProfileView[]),
    ),
    listInsights: vi.fn(() =>
      Promise.resolve([{ categoryCode: 'faq_miss', occurrenceCount: 3, topicCode: 'hours' }]),
    ),
    listModelPolicies: vi.fn(() => Promise.resolve([] satisfies readonly AdminPolicySummary[])),
    listOutboundPolicies: vi.fn(() => Promise.resolve(outboundPolicies)),
    listOutboundTemplates: vi.fn(() => Promise.resolve(outboundTemplates)),
    listPauseStates: vi.fn(() => Promise.resolve(pauseStates)),
    listPrivacyLocations: vi.fn(() => Promise.resolve(privacyLocations)),
    listPrivacyRequests: vi.fn(() => Promise.resolve(privacyRequests)),
    listProposals: vi.fn(() => Promise.resolve([] satisfies readonly AdminProposalSummary[])),
    listQuestions: vi.fn(() =>
      Promise.resolve([
        {
          priority: 'normal',
          questionRef: 'QUESTION_TEST_1',
          questionText: 'Synthetic question?',
          state: 'open',
        },
      ] satisfies readonly AdminQuestionSummary[]),
    ),
    listWebsiteSnapshots: vi.fn(() => Promise.resolve(snapshots)),
    pauseConversation: vi.fn(() => Promise.resolve()),
    publishVersion: vi.fn(() => Promise.resolve()),
    readActiveGatewayBudgetSummary: vi.fn(() => Promise.resolve(undefined)),
    recordMarketingReoptIn: vi.fn(() => Promise.resolve()),
    recordReviewerConsent: vi.fn(() => Promise.resolve()),
    resumeConversation: vi.fn(() => Promise.resolve()),
    retireVersion: vi.fn(() => Promise.resolve()),
    reviewDeletionRequest: vi.fn(() => Promise.resolve()),
    reviewPrivacyRequest: vi.fn(() => Promise.resolve()),
    reviewVersion: vi.fn(() => Promise.resolve()),
    revokeStaffRole: vi.fn(() => Promise.resolve()),
    revokeStaffSessions: vi.fn(() => Promise.resolve()),
    rollbackVersion: vi.fn(() => Promise.resolve()),
    submitVersion: vi.fn(() => Promise.resolve()),
    testGatewayProfile: vi.fn(() => Promise.resolve()),
    transitionGatewayProfile: vi.fn(() => Promise.resolve()),
    transitionModelPolicy: vi.fn(() => Promise.resolve()),
    transitionOutboundPolicy: vi.fn(() => Promise.resolve()),
    transitionOutboundTemplate: vi.fn(() => Promise.resolve()),
    triggerInsightAggregation: vi.fn(() =>
      Promise.resolve({ entryCount: 1, runRef: 'RUN_1', status: 'created' as const }),
    ),
    triggerQuestionDigest: vi.fn(() => Promise.resolve({ status: 'created' as const })),
    ...overrides,
  };
}

function createControlsTestApp(
  roles: ResolvedAdminSession['roles'] = ['administrator'],
  dashboardOverrides: Partial<AdminDashboardPort> = {},
) {
  const identity: AdminIdentityPort = {
    beginPasswordAuthentication: vi.fn(() => Promise.resolve({ status: 'denied' as const })),
    completeMfaAuthentication: vi.fn(() => Promise.resolve({ status: 'denied' as const })),
    resolveSession: vi.fn(() =>
      Promise.resolve({
        accountRef: 'ADMIN_TEST_lead',
        expiresAt: new Date('2026-09-02T09:00:00.000Z'),
        roles,
      }),
    ),
    revokeSession: vi.fn(() => Promise.resolve({ status: 'applied' as const })),
    validateCsrf: vi.fn(() => Promise.resolve(true)),
  };
  const dashboard = dashboardPort(dashboardOverrides);
  const app = buildAdminApp({
    dashboard,
    identity,
    now: () => new Date('2026-09-02T06:00:00.000Z'),
    origin,
    secureCookie: false,
  });
  apps.push(app);
  return { app, dashboard };
}

describe('MFA provisioning URI and base32 helpers', () => {
  test('encodes RFC 4648 base32 secrets and otpauth URIs cleanly', () => {
    const seed = new AdminSecretBytes(Buffer.from('12345678901234567890', 'ascii'));
    expect(encodeBase32(seed)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    const uri = buildTotpProvisioningUri({
      issuer: 'FCD Support Admin',
      loginName: 'staff.user',
      seed,
      policy: { algorithm: 'sha1', digits: 6, periodSeconds: 30, verificationWindow: 1 },
    });
    expect(uri).toBe(
      'otpauth://totp/FCD%20Support%20Admin:staff.user?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=FCD%20Support%20Admin&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('Admin PRIVACY_HMAC_KEYRING configuration and role secret loading', () => {
  test('loadAdminConfig accepts optional valid PRIVACY_HMAC_KEYRING and rejects malformed keyring', () => {
    const base = {
      ADMIN_MFA_ENCRYPTION_KEY: key,
      ADMIN_SESSION_HMAC_KEY: key,
      DATABASE_URL: 'postgresql://synthetic@127.0.0.1:5432/fcd_support_test',
    };
    const withoutKeyring = loadAdminConfig(base);
    expect(withoutKeyring.privacyKeyring).toBeUndefined();

    const withKeyring = loadAdminConfig({ ...base, PRIVACY_HMAC_KEYRING: syntheticKeyring });
    expect(withKeyring.privacyKeyring?.activeVersion).toBe('TEST_v1');

    expect(() => loadAdminConfig({ ...base, PRIVACY_HMAC_KEYRING: 'not-valid-json' })).toThrow(
      'Invalid admin configuration: PRIVACY_HMAC_KEYRING',
    );
  });

  test('loadRoleEnvironment accepts optional PRIVACY_HMAC_KEYRING_FILE on admin role only and hides secrets', async () => {
    const gatewayKey = Buffer.alloc(32, 0x71).toString('base64url');
    const files: Readonly<Record<string, string>> = {
      '/run/secrets/db': 'postgresql://synthetic@127.0.0.1:5432/fcd_support_test',
      '/run/secrets/session': key,
      '/run/secrets/mfa': key,
      '/run/secrets/gw': gatewayKey,
      '/run/secrets/keyring': syntheticKeyring,
    };
    const env = await loadRoleEnvironment(
      'admin',
      {
        NODE_ENV: 'production',
        DATABASE_URL_FILE: '/run/secrets/db',
        ADMIN_SESSION_HMAC_KEY_FILE: '/run/secrets/session',
        ADMIN_MFA_ENCRYPTION_KEY_FILE: '/run/secrets/mfa',
        MODEL_GATEWAY_ENCRYPTION_KEY_FILE: '/run/secrets/gw',
        PRIVACY_HMAC_KEYRING_FILE: '/run/secrets/keyring',
      },
      (path) => Promise.resolve(Buffer.from(files[path] ?? '', 'utf8')),
    );
    expect(env.PRIVACY_HMAC_KEYRING).toBe(syntheticKeyring);
    expect(JSON.stringify(env)).not.toContain(gatewayKey);
    expect(JSON.stringify(env)).not.toContain(syntheticKeyring);
  });
});

describe('Track 2B admin control routes and role enforcement', () => {
  test('provisions multi-role staff accounts via distinct checkboxes and manages roles/sessions/disable', async () => {
    const { app, dashboard } = createControlsTestApp(['administrator']);
    const page = await app.inject({
      method: 'GET',
      url: '/accounts',
      headers: { cookie: activeCookies() },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Staff accounts');

    const createToken = formHiddenValue(page.body, '/accounts', 'actionToken');
    const created = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: formHeaders(activeCookies()),
      payload: new URLSearchParams({
        csrfToken: activeCsrf.reveal(),
        actionToken: createToken,
        accountRef: 'ADMIN_TEST_created',
        loginName: 'synthetic.created',
        password: 'Synthetic-staff-passphrase-2026',
        roleKnowledgeEditor: '1',
        roleSupportReviewer: '1',
      }).toString(),
    });
    expect(created.statusCode).toBe(200);
    expect(created.body).toContain('Save this TOTP seed once');
    expect(created.body).toContain('otpauth://totp/');
    expect(dashboard.createStaffAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        accountRef: 'ADMIN_TEST_created',
        loginName: 'synthetic.created',
        roles: ['knowledge_editor', 'support_reviewer'],
      }),
      expect.objectContaining({ accountRef: 'ADMIN_TEST_lead' }),
    );

    const assignToken = formHiddenValue(
      page.body,
      '/accounts/ADMIN_TEST_staff/roles/assign',
      'actionToken',
      'value="knowledge_editor"',
    );
    const assignResp = await app.inject({
      method: 'POST',
      url: '/accounts/ADMIN_TEST_staff/roles/assign',
      headers: formHeaders(activeCookies()),
      payload: new URLSearchParams({
        csrfToken: activeCsrf.reveal(),
        actionToken: assignToken,
        role: 'knowledge_editor',
      }).toString(),
    });
    expect(assignResp.statusCode).toBe(303);
    expect(dashboard.assignStaffRole).toHaveBeenCalledTimes(1);

    const revokeRoleToken = formHiddenValue(
      page.body,
      '/accounts/ADMIN_TEST_staff/roles/revoke',
      'actionToken',
      'value="support_reviewer"',
    );
    const revokeRoleResp = await app.inject({
      method: 'POST',
      url: '/accounts/ADMIN_TEST_staff/roles/revoke',
      headers: formHeaders(activeCookies()),
      payload: new URLSearchParams({
        csrfToken: activeCsrf.reveal(),
        actionToken: revokeRoleToken,
        role: 'support_reviewer',
      }).toString(),
    });
    expect(revokeRoleResp.statusCode).toBe(303);
    expect(dashboard.revokeStaffRole).toHaveBeenCalledTimes(1);

    const revokeSessionsToken = formHiddenValue(
      page.body,
      '/accounts/ADMIN_TEST_staff/revoke-sessions',
      'actionToken',
    );
    const revokeSessionsResp = await app.inject({
      method: 'POST',
      url: '/accounts/ADMIN_TEST_staff/revoke-sessions',
      headers: formHeaders(activeCookies()),
      payload: new URLSearchParams({
        csrfToken: activeCsrf.reveal(),
        actionToken: revokeSessionsToken,
      }).toString(),
    });
    expect(revokeSessionsResp.statusCode).toBe(303);
    expect(dashboard.revokeStaffSessions).toHaveBeenCalledWith(
      { targetAccountRef: 'ADMIN_TEST_staff' },
      expect.anything(),
    );

    const disableToken = formHiddenValue(
      page.body,
      '/accounts/ADMIN_TEST_staff/disable',
      'actionToken',
    );
    const disableResp = await app.inject({
      method: 'POST',
      url: '/accounts/ADMIN_TEST_staff/disable',
      headers: formHeaders(activeCookies()),
      payload: new URLSearchParams({
        csrfToken: activeCsrf.reveal(),
        actionToken: disableToken,
      }).toString(),
    });
    expect(disableResp.statusCode).toBe(303);
    expect(dashboard.disableStaffAccount).toHaveBeenCalledWith(
      expect.objectContaining({ targetAccountRef: 'ADMIN_TEST_staff' }),
      expect.anything(),
    );
  });

  test('executes pause/resume workflows and returns 400 on domain conflicts', async () => {
    const { app, dashboard } = createControlsTestApp(['support_reviewer']);
    const page = await app.inject({
      method: 'GET',
      url: '/pause',
      headers: { cookie: activeCookies() },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Human takeover pause');

    const pauseToken = formHiddenValue(page.body, '/pause/42/pause', 'actionToken');
    const paused = await app.inject({
      method: 'POST',
      url: '/pause/42/pause',
      headers: formHeaders(activeCookies()),
      payload: new URLSearchParams({
        csrfToken: activeCsrf.reveal(),
        actionToken: pauseToken,
      }).toString(),
    });
    expect(paused.statusCode).toBe(303);
    expect(dashboard.pauseConversation).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: '42' }),
      expect.anything(),
    );

    const resumeToken = formHiddenValue(page.body, '/pause/42/resume', 'actionToken');
    const resumed = await app.inject({
      method: 'POST',
      url: '/pause/42/resume',
      headers: formHeaders(activeCookies()),
      payload: new URLSearchParams({
        csrfToken: activeCsrf.reveal(),
        actionToken: resumeToken,
      }).toString(),
    });
    expect(resumed.statusCode).toBe(303);
    expect(dashboard.resumeConversation).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: '42' }),
      expect.anything(),
    );

    const missingApp = createControlsTestApp(['support_reviewer'], {
      pauseConversation: vi.fn(() => Promise.reject(new PolicyRecordNotFoundError('missing'))),
    });
    const page2 = await missingApp.app.inject({
      method: 'GET',
      url: '/pause',
      headers: { cookie: activeCookies() },
    });
    const token2 = formHiddenValue(page2.body, '/pause/42/pause', 'actionToken');
    const failed = await missingApp.app.inject({
      method: 'POST',
      url: '/pause/42/pause',
      headers: formHeaders(activeCookies()),
      payload: new URLSearchParams({
        csrfToken: activeCsrf.reveal(),
        actionToken: token2,
      }).toString(),
    });
    expect(failed.statusCode).toBe(400);
  });

  test('executes privacy review, deletion, redacted access export, correction, and location attestation', async () => {
    const { app, dashboard } = createControlsTestApp(['support_reviewer']);
    const page = await app.inject({
      method: 'GET',
      url: '/privacy',
      headers: { cookie: activeCookies() },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('PRIVACY_TEST_del');

    const delReviewToken = formHiddenValue(
      page.body,
      '/privacy/PRIVACY_TEST_del/deletion/review',
      'actionToken',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/privacy/PRIVACY_TEST_del/deletion/review',
          headers: formHeaders(activeCookies()),
          payload: new URLSearchParams({
            csrfToken: activeCsrf.reveal(),
            actionToken: delReviewToken,
            decision: 'approve',
            reasonCode: 'customer_confirmed',
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);
    expect(dashboard.reviewDeletionRequest).toHaveBeenCalledTimes(1);

    const collectToken = formHiddenValue(
      page.body,
      '/privacy/PRIVACY_TEST_acc/access/collect',
      'actionToken',
    );
    const exportResp = await app.inject({
      method: 'POST',
      url: '/privacy/PRIVACY_TEST_acc/access/collect',
      headers: formHeaders(activeCookies()),
      payload: new URLSearchParams({
        csrfToken: activeCsrf.reveal(),
        actionToken: collectToken,
      }).toString(),
    });
    expect(exportResp.statusCode).toBe(200);
    expect(exportResp.body).toContain('Redacted Access Export (PRIVACY_TEST_acc)');
    expect(exportResp.body).toContain('f'.repeat(64));

    const correctToken = formHiddenValue(
      page.body,
      '/privacy/PRIVACY_TEST_cor/correction/execute',
      'actionToken',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/privacy/PRIVACY_TEST_cor/correction/execute',
          headers: formHeaders(activeCookies()),
          payload: new URLSearchParams({
            csrfToken: activeCsrf.reveal(),
            actionToken: correctToken,
            fieldKey: 'preferred_language',
            newValue: 'bn',
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);
    expect(dashboard.executePrivacyCorrection).toHaveBeenCalledWith(
      expect.objectContaining({
        requestRef: 'PRIVACY_TEST_cor',
        fieldKey: 'preferred_language',
        newValue: 'bn',
      }),
      expect.anything(),
    );

    const attestToken = formHiddenValue(
      page.body,
      '/privacy/PRIVACY_TEST_acc/locations/primary_postgres/attest',
      'actionToken',
      'value="completed"',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/privacy/PRIVACY_TEST_acc/locations/primary_postgres/attest',
          headers: formHeaders(activeCookies()),
          payload: new URLSearchParams({
            csrfToken: activeCsrf.reveal(),
            actionToken: attestToken,
            state: 'completed',
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);
    expect(dashboard.attestPrivacyLocation).toHaveBeenCalledTimes(1);
  });

  test('executes consent controls (reviewer) and outbound policy/template controls (admin-only)', async () => {
    const reviewer = createControlsTestApp(['support_reviewer']);
    const reviewerPage = await reviewer.app.inject({
      method: 'GET',
      url: '/consent',
      headers: { cookie: activeCookies() },
    });
    expect(reviewerPage.statusCode).toBe(200);

    const consentToken = formHiddenValue(reviewerPage.body, '/consent/record', 'actionToken');
    expect(
      (
        await reviewer.app.inject({
          method: 'POST',
          url: '/consent/record',
          headers: formHeaders(activeCookies()),
          payload: new URLSearchParams({
            csrfToken: activeCsrf.reveal(),
            actionToken: consentToken,
            channelIdentityId: '11',
            category: 'product_offers',
            action: 'grant',
            wording: 'Reviewed opt-in',
            wordingVersion: '2026-11',
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);
    expect(reviewer.dashboard.recordReviewerConsent).toHaveBeenCalledTimes(1);

    const reoptToken = formHiddenValue(reviewerPage.body, '/consent/reopt-in', 'actionToken');
    expect(
      (
        await reviewer.app.inject({
          method: 'POST',
          url: '/consent/reopt-in',
          headers: formHeaders(activeCookies()),
          payload: new URLSearchParams({
            csrfToken: activeCsrf.reveal(),
            actionToken: reoptToken,
            channelIdentityId: '11',
            category: 'product_offers',
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);
    expect(reviewer.dashboard.recordMarketingReoptIn).toHaveBeenCalledTimes(1);

    // Non-administrator cannot mutate outbound policy or templates
    expect(
      (
        await reviewer.app.inject({
          method: 'POST',
          url: '/consent/outbound-policy',
          headers: formHeaders(activeCookies()),
          payload: new URLSearchParams({
            csrfToken: activeCsrf.reveal(),
            actionToken: 'unused',
            perContact15Minute: '5',
            perContact24Hour: '20',
            global1Minute: '60',
            globalUtcDay: '1000',
          }).toString(),
        })
      ).statusCode,
    ).toBe(403);

    const admin = createControlsTestApp(['administrator']);
    const adminPage = await admin.app.inject({
      method: 'GET',
      url: '/consent',
      headers: { cookie: activeCookies() },
    });
    const policyToken = formHiddenValue(adminPage.body, '/consent/outbound-policy', 'actionToken');
    expect(
      (
        await admin.app.inject({
          method: 'POST',
          url: '/consent/outbound-policy',
          headers: formHeaders(activeCookies()),
          payload: new URLSearchParams({
            csrfToken: activeCsrf.reveal(),
            actionToken: policyToken,
            perContact15Minute: '5',
            perContact24Hour: '20',
            global1Minute: '60',
            globalUtcDay: '1000',
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);
    expect(admin.dashboard.createOutboundPolicy).toHaveBeenCalledTimes(1);

    const templateToken = formHiddenValue(
      adminPage.body,
      '/consent/outbound-template',
      'actionToken',
    );
    expect(
      (
        await admin.app.inject({
          method: 'POST',
          url: '/consent/outbound-template',
          headers: formHeaders(activeCookies()),
          payload: new URLSearchParams({
            csrfToken: activeCsrf.reveal(),
            actionToken: templateToken,
            channelAccountId: 'PHONE_TEST_1',
            providerTemplateId: 'META_TPL_1',
            templateName: 'service_update_v1',
            locale: 'en_US',
            category: 'customer_support',
            templateText: 'Your support ticket update is ready.',
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);
    expect(admin.dashboard.createOutboundTemplate).toHaveBeenCalledTimes(1);
  });

  test('executes official website draft import, question dismissal, insights actions, and denies unauthorized roles', async () => {
    const editor = createControlsTestApp(['knowledge_editor']);
    const importPage = await editor.app.inject({
      method: 'GET',
      url: '/knowledge/import',
      headers: { cookie: activeCookies() },
    });
    expect(importPage.statusCode).toBe(200);
    expect(importPage.body).toContain('Official website import');

    const importToken = formHiddenValue(importPage.body, '/knowledge/import', 'actionToken');
    expect(
      (
        await editor.app.inject({
          method: 'POST',
          url: '/knowledge/import',
          headers: formHeaders(activeCookies()),
          payload: new URLSearchParams({
            csrfToken: activeCsrf.reveal(),
            actionToken: importToken,
            url: 'https://example.org/faq',
            label: 'Official FAQ',
            pastedHtmlOrText: '<h1>Official FAQ</h1><p>Open daily.</p>',
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);
    expect(editor.dashboard.importWebsiteSource).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.org/faq', label: 'Official FAQ' }),
      expect.anything(),
    );

    // Partial bilingual draft rejects with 400
    expect(
      (
        await editor.app.inject({
          method: 'POST',
          url: '/knowledge/import',
          headers: formHeaders(activeCookies()),
          payload: new URLSearchParams({
            csrfToken: activeCsrf.reveal(),
            actionToken: importToken,
            url: 'https://example.org/faq',
            itemKey: 'faq.incomplete',
          }).toString(),
        })
      ).statusCode,
    ).toBe(400);

    const questionsPage = await editor.app.inject({
      method: 'GET',
      url: '/questions',
      headers: { cookie: activeCookies() },
    });
    expect(questionsPage.statusCode).toBe(200);
    const dismissToken = formHiddenValue(
      questionsPage.body,
      '/questions/QUESTION_TEST_1/dismiss',
      'actionToken',
    );
    expect(
      (
        await editor.app.inject({
          method: 'POST',
          url: '/questions/QUESTION_TEST_1/dismiss',
          headers: formHeaders(activeCookies()),
          payload: new URLSearchParams({
            csrfToken: activeCsrf.reveal(),
            actionToken: dismissToken,
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);
    expect(editor.dashboard.dismissQuestion).toHaveBeenCalledTimes(1);

    const insightsPage = await editor.app.inject({
      method: 'GET',
      url: '/insights',
      headers: { cookie: activeCookies() },
    });
    expect(insightsPage.statusCode).toBe(200);
    const aggToken = formHiddenValue(insightsPage.body, '/insights/aggregate', 'actionToken');
    const digestToken = formHiddenValue(insightsPage.body, '/insights/digest', 'actionToken');
    expect(
      (
        await editor.app.inject({
          method: 'POST',
          url: '/insights/aggregate',
          headers: formHeaders(activeCookies()),
          payload: new URLSearchParams({
            csrfToken: activeCsrf.reveal(),
            actionToken: aggToken,
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);
    expect(
      (
        await editor.app.inject({
          method: 'POST',
          url: '/insights/digest',
          headers: formHeaders(activeCookies()),
          payload: new URLSearchParams({
            csrfToken: activeCsrf.reveal(),
            actionToken: digestToken,
          }).toString(),
        })
      ).statusCode,
    ).toBe(303);

    // Role boundaries across routes + domain conflict mapping to 400
    const reviewer = createControlsTestApp(['support_reviewer']);
    expect(
      (
        await reviewer.app.inject({
          method: 'GET',
          url: '/accounts',
          headers: { cookie: activeCookies() },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await reviewer.app.inject({
          method: 'GET',
          url: '/knowledge/import',
          headers: { cookie: activeCookies() },
        })
      ).statusCode,
    ).toBe(403);

    const conflictAdmin = createControlsTestApp(['administrator'], {
      disableStaffAccount: vi.fn(() =>
        Promise.reject(new AdminIdentityConflictError('final admin')),
      ),
      recordReviewerConsent: vi.fn(() => Promise.reject(new AdminControlConflictError('bad'))),
    });
    const accPage = await conflictAdmin.app.inject({
      method: 'GET',
      url: '/accounts',
      headers: { cookie: activeCookies() },
    });
    const disableToken = formHiddenValue(
      accPage.body,
      '/accounts/ADMIN_TEST_staff/disable',
      'actionToken',
    );
    expect(
      (
        await conflictAdmin.app.inject({
          method: 'POST',
          url: '/accounts/ADMIN_TEST_staff/disable',
          headers: formHeaders(activeCookies()),
          payload: new URLSearchParams({
            csrfToken: activeCsrf.reveal(),
            actionToken: disableToken,
          }).toString(),
        })
      ).statusCode,
    ).toBe(400);
  });
});
