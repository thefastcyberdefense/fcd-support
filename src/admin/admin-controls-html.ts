import type { ResolvedAdminSession } from '../persistence/postgres-admin-identity.js';
import { MARKETING_CATEGORIES } from '../policy/policy-types.js';
import { OUTBOUND_PURPOSES } from '../outbound/outbound-types.js';
import { escapeHtml, renderAdminPage, type AdminInsightSummary } from './admin-html.js';
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
} from './admin-controls-types.js';

const adminRoles = [
  'knowledge_editor',
  'knowledge_reviewer',
  'support_reviewer',
  'administrator',
] as const;

function td(label: string, contentHtml: string): string {
  return `<td data-label="${escapeHtml(label)}">${contentHtml}</td>`;
}

function hiddenFields(csrfToken: string, actionToken: string): string {
  return `<input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}"><input type="hidden" name="actionToken" value="${escapeHtml(actionToken)}">`;
}

export function renderAccountsPage(input: {
  readonly accounts: readonly AdminAccountSummary[];
  readonly createToken: string;
  readonly roleAssignTokens: Readonly<Record<string, string>>;
  readonly roleRevokeTokens: Readonly<Record<string, string>>;
  readonly revokeSessionTokens: Readonly<Record<string, string>>;
  readonly disableTokens: Readonly<Record<string, string>>;
  readonly createdStaff?: AdminStaffCreateResult;
  readonly csrfToken: string;
  readonly nonce: string;
  readonly session: ResolvedAdminSession;
}): string {
  const banner =
    input.createdStaff === undefined
      ? ''
      : `<div class="notice" role="status"><strong>Account provisioned for ${escapeHtml(input.createdStaff.accountRef)} (${escapeHtml(input.createdStaff.loginName)}).</strong> Save this TOTP seed once; it will not be shown again:<br>Secret: <span class="confirm-ref">${escapeHtml(input.createdStaff.base32Secret)}</span><br>URI: <span class="confirm-ref">${escapeHtml(input.createdStaff.provisioningUri)}</span></div>`;

  const rows = input.accounts
    .map((account) => {
      const roleControls =
        account.state !== 'active'
          ? '<span>Disabled</span>'
          : adminRoles
              .map((role) => {
                const assigned = account.roles.includes(role);
                const token = assigned
                  ? (input.roleRevokeTokens[`${account.accountRef}:${role}`] ?? '')
                  : (input.roleAssignTokens[`${account.accountRef}:${role}`] ?? '');
                const route = assigned ? 'revoke' : 'assign';
                return `<form method="post" action="/accounts/${escapeHtml(account.accountRef)}/roles/${route}" style="display:inline-block;margin:2px">${hiddenFields(input.csrfToken, token)}<input type="hidden" name="role" value="${escapeHtml(role)}"><button class="button${assigned ? '' : ' primary'}" type="submit">${assigned ? `Remove ${escapeHtml(role)}` : `Add ${escapeHtml(role)}`}</button></form>`;
              })
              .join(' ');
      const sessionControls =
        account.state === 'active'
          ? `<form method="post" action="/accounts/${escapeHtml(account.accountRef)}/revoke-sessions" style="display:inline-block">${hiddenFields(input.csrfToken, input.revokeSessionTokens[account.accountRef] ?? '')}<button class="button" type="submit">Revoke sessions (${String(account.activeSessionCount)})</button></form>${account.accountRef === input.session.accountRef ? '' : ` <form method="post" action="/accounts/${escapeHtml(account.accountRef)}/disable" style="display:inline-block">${hiddenFields(input.csrfToken, input.disableTokens[account.accountRef] ?? '')}<button class="button danger" type="submit">Disable</button></form>`}`
          : '';
      return `<tr>${td('Account', `<strong>${escapeHtml(account.accountRef)}</strong><span class="subtle">${escapeHtml(account.loginName)}</span>`)}${td('State', `<span class="state ${account.state === 'active' ? 'submitted' : 'rejected'}">${escapeHtml(account.state.toUpperCase())}</span>`)}${td('Roles', account.roles.map((r) => escapeHtml(r)).join(', ') || 'none')}${td('Role actions', roleControls)}${td('Session actions', sessionControls)}</tr>`;
    })
    .join('');

  const roleCheckboxNames: Readonly<Record<(typeof adminRoles)[number], string>> = {
    knowledge_editor: 'roleKnowledgeEditor',
    knowledge_reviewer: 'roleKnowledgeReviewer',
    support_reviewer: 'roleSupportReviewer',
    administrator: 'roleAdministrator',
  };

  const roleCheckboxes = adminRoles
    .map(
      (role) =>
        `<label style="display:flex;align-items:center;gap:8px;min-height:44px"><input type="checkbox" name="${roleCheckboxNames[role]}" value="1" style="width:auto;min-height:auto"> ${escapeHtml(role)}</label>`,
    )
    .join('');

  return renderAdminPage({
    body: `<div class="heading-row"><div><h1>Staff accounts</h1><p>Individual MFA-protected operator accounts with explicit roles and audit logging.</p></div></div>${banner}<section class="panel"><table class="table"><thead><tr><th>Account</th><th>State</th><th>Roles</th><th>Role actions</th><th>Session actions</th></tr></thead><tbody>${rows}</tbody></table>${rows === '' ? '<div class="empty">No staff accounts found.</div>' : ''}</section><hr class="section-rule"><section class="panel form-panel"><h2>Provision individual staff account</h2><form method="post" action="/accounts">${hiddenFields(input.csrfToken, input.createToken)}<div class="two-column"><div class="field"><label for="accountRef">Account ref</label><input id="accountRef" name="accountRef" maxlength="64" required></div><div class="field"><label for="loginName">Login name</label><input id="loginName" name="loginName" maxlength="64" required></div></div><div class="field"><label for="password">Initial passphrase (min 12 chars)</label><input id="password" name="password" type="password" minlength="12" maxlength="256" required></div><div class="field"><span class="label">Initial roles</span><div>${roleCheckboxes}</div></div><button class="button primary" type="submit">Create staff account</button></form></section>`,
    csrfToken: input.csrfToken,
    currentPath: '/accounts',
    nonce: input.nonce,
    session: input.session,
    title: 'Staff accounts',
  });
}

export function renderPausePage(input: {
  readonly states: readonly AdminPauseStateSummary[];
  readonly pauseTokens: Readonly<Record<string, string>>;
  readonly resumeTokens: Readonly<Record<string, string>>;
  readonly csrfToken: string;
  readonly nonce: string;
  readonly session: ResolvedAdminSession;
}): string {
  const rows = input.states
    .map((entry) => {
      const pauseStatus =
        entry.aiPausedUntil === null
          ? 'Active automation'
          : `Paused until ${entry.aiPausedUntil.toISOString()}`;
      const controls = `<div class="actions"><form method="post" action="/pause/${escapeHtml(entry.conversationId)}/pause">${hiddenFields(input.csrfToken, input.pauseTokens[entry.conversationId] ?? '')}<button class="button primary" type="submit">Pause 24h</button></form><form method="post" action="/pause/${escapeHtml(entry.conversationId)}/resume">${hiddenFields(input.csrfToken, input.resumeTokens[entry.conversationId] ?? '')}<button class="button danger" type="submit">Resume AI</button></form></div>`;
      return `<tr>${td('Conversation', `<strong>#${escapeHtml(entry.conversationId)}</strong><span class="subtle">${escapeHtml(entry.channel)} · ${escapeHtml(entry.externalContactId)}</span>`)}${td('AI status', `<strong>${escapeHtml(pauseStatus)}</strong><span class="subtle">${escapeHtml(entry.lastPauseActorKind ?? 'none')}</span>`)}${td('Last activity', escapeHtml(entry.lastActivityAt.toISOString()))}${td('Actions', controls)}</tr>`;
    })
    .join('');

  return renderAdminPage({
    body: `<div class="heading-row"><div><h1>Human takeover pause &amp; resume</h1><p>Metadata-only 24-hour takeover controls. Customer messaging remains inside WhatsApp Business and Meta Business Suite.</p></div></div><section class="panel"><table class="table"><thead><tr><th>Conversation</th><th>AI status</th><th>Last activity</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>${rows === '' ? '<div class="empty">No active conversations tracked.</div>' : ''}</section>`,
    csrfToken: input.csrfToken,
    currentPath: '/pause',
    nonce: input.nonce,
    session: input.session,
    title: 'Pause & resume',
  });
}

export function renderPrivacyPage(input: {
  readonly requests: readonly AdminPrivacyRequestSummary[];
  readonly locations: readonly AdminPrivacyLocationSummary[];
  readonly actionTokens: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly attestTokens: Readonly<Record<string, string>>;
  readonly accessBundle?: AdminPrivacyAccessBundle;
  readonly csrfToken: string;
  readonly nonce: string;
  readonly session: ResolvedAdminSession;
}): string {
  const bundleNotice =
    input.accessBundle === undefined
      ? ''
      : `<div class="notice" role="status"><strong>Redacted Access Export (${escapeHtml(input.accessBundle.requestRef)})</strong> · SHA-256: <span class="confirm-ref">${escapeHtml(input.accessBundle.bundleSha256)}</span> · Language: ${escapeHtml(input.accessBundle.preferredLanguage ?? 'unset')} · Records: ${String(input.accessBundle.recordCount)}</div>`;

  const locationMap = new Map<string, AdminPrivacyLocationSummary[]>();
  for (const loc of input.locations) {
    const list = locationMap.get(loc.requestRef) ?? [];
    list.push(loc);
    locationMap.set(loc.requestRef, list);
  }

  const rows = input.requests
    .map((req) => {
      const tokens = input.actionTokens[req.requestRef] ?? {};
      const controls: string[] = [];
      if (req.requestType === 'deletion' && req.state === 'awaiting_confirmation') {
        controls.push(
          `<form method="post" action="/privacy/${escapeHtml(req.requestRef)}/deletion/review">${hiddenFields(input.csrfToken, tokens.review ?? '')}<select class="input" name="decision" aria-label="Deletion review decision"><option value="approve">Approve</option><option value="reject">Reject</option></select><select class="input" name="reasonCode" aria-label="Reason"><option value="customer_confirmed">customer_confirmed</option><option value="identity_ambiguous">identity_ambiguous</option><option value="request_withdrawn">request_withdrawn</option></select><button class="button primary" type="submit">Submit review</button></form>`,
        );
      } else if (req.requestType === 'deletion' && req.state === 'human_review') {
        controls.push(
          `<form method="post" action="/privacy/${escapeHtml(req.requestRef)}/deletion/execute">${hiddenFields(input.csrfToken, tokens.execute ?? '')}<button class="button danger" type="submit">Execute erasure &amp; tombstone</button></form>`,
        );
      } else if (req.requestType !== 'deletion' && req.state === 'human_review') {
        controls.push(
          `<form method="post" action="/privacy/${escapeHtml(req.requestRef)}/review">${hiddenFields(input.csrfToken, tokens.review ?? '')}<select class="input" name="decision" aria-label="Privacy review decision"><option value="approve">Approve</option><option value="reject">Reject</option></select><select class="input" name="reasonCode" aria-label="Reason"><option value="identity_verified">identity_verified</option><option value="identity_ambiguous">identity_ambiguous</option><option value="request_withdrawn">request_withdrawn</option></select><button class="button primary" type="submit">Submit review</button></form>`,
        );
      } else if (
        req.requestType === 'access' &&
        (req.state === 'in_progress' || req.state === 'partially_completed')
      ) {
        controls.push(
          `<form method="post" action="/privacy/${escapeHtml(req.requestRef)}/access/collect">${hiddenFields(input.csrfToken, tokens.collect ?? '')}<button class="button primary" type="submit">Collect redacted export</button></form>`,
        );
      } else if (
        req.requestType === 'correction' &&
        (req.state === 'in_progress' || req.state === 'partially_completed')
      ) {
        controls.push(
          `<form method="post" action="/privacy/${escapeHtml(req.requestRef)}/correction/execute">${hiddenFields(input.csrfToken, tokens.correct ?? '')}<div class="field"><label for="fk-${escapeHtml(req.requestRef)}">Field</label><input id="fk-${escapeHtml(req.requestRef)}" name="fieldKey" value="preferred_language" required></div><div class="field"><label for="fv-${escapeHtml(req.requestRef)}">Value</label><input id="fv-${escapeHtml(req.requestRef)}" name="newValue" value="bn" required></div><button class="button primary" type="submit">Apply correction</button></form>`,
        );
      }

      const locs = (locationMap.get(req.requestRef) ?? [])
        .map((loc) => {
          const btn =
            loc.state === 'pending' &&
            (req.state === 'in_progress' || req.state === 'partially_completed')
              ? ` <form method="post" action="/privacy/${escapeHtml(req.requestRef)}/locations/${escapeHtml(loc.locationCode)}/attest" style="display:inline-block">${hiddenFields(input.csrfToken, input.attestTokens[`${req.requestRef}:${loc.locationCode}`] ?? '')}<input type="hidden" name="state" value="completed"><button class="button" type="submit">Mark completed</button></form> <form method="post" action="/privacy/${escapeHtml(req.requestRef)}/locations/${escapeHtml(loc.locationCode)}/attest" style="display:inline-block">${hiddenFields(input.csrfToken, input.attestTokens[`${req.requestRef}:${loc.locationCode}`] ?? '')}<input type="hidden" name="state" value="not_applicable"><button class="button" type="submit">N/A</button></form>`
              : '';
          return `<div><strong>${escapeHtml(loc.locationCode)}</strong>: ${escapeHtml(loc.state)}${btn}</div>`;
        })
        .join('');

      const digestInfo =
        req.accessBundleSha256 !== null
          ? `<span class="subtle">Export SHA-256: ${escapeHtml(req.accessBundleSha256.slice(0, 16))}… (${String(req.accessRecordCount ?? 0)} rows)</span>`
          : req.correctionResultCode !== null
            ? `<span class="subtle">Correction: ${escapeHtml(req.correctionFieldKey ?? '')} -> ${escapeHtml(req.correctionResultCode)}</span>`
            : req.deletionStatus !== null
              ? `<span class="subtle">Tombstones: ${String(req.tombstonesCreated ?? 0)}</span>`
              : '';

      return `<tr>${td('Request', `<strong>${escapeHtml(req.requestRef)}</strong><span class="subtle">${escapeHtml(req.requestType.toUpperCase())}</span>`)}${td('State', `<span class="state">${escapeHtml(req.state.toUpperCase())}</span>${digestInfo}`)}${td('Locations', locs || 'none')}${td('Actions', controls.join('') || '<span>No action pending</span>')}</tr>`;
    })
    .join('');

  return renderAdminPage({
    body: `<div class="heading-row"><div><h1>Privacy rights review</h1><p>Bounded review and execution for deletion, redacted access exports, corrections, and external location attestations.</p></div></div>${bundleNotice}<section class="panel"><table class="table"><thead><tr><th>Request</th><th>State</th><th>Locations</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>${rows === '' ? '<div class="empty">No privacy requests recorded.</div>' : ''}</section>`,
    csrfToken: input.csrfToken,
    currentPath: '/privacy',
    nonce: input.nonce,
    session: input.session,
    title: 'Privacy rights',
  });
}

export function renderConsentPage(input: {
  readonly identities: readonly AdminConsentIdentitySummary[];
  readonly outboundPolicies: readonly AdminOutboundPolicySummary[];
  readonly outboundTemplates: readonly AdminOutboundTemplateSummary[];
  readonly consentTokens: Readonly<Record<string, string>>;
  readonly reoptInTokens: Readonly<Record<string, string>>;
  readonly createPolicyToken: string;
  readonly policyActionTokens: Readonly<Record<string, string>>;
  readonly createTemplateToken: string;
  readonly templateActionTokens: Readonly<Record<string, string>>;
  readonly csrfToken: string;
  readonly nonce: string;
  readonly session: ResolvedAdminSession;
}): string {
  const isAdmin = input.session.roles.includes('administrator');
  const categoryOptions = MARKETING_CATEGORIES.map(
    (category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`,
  ).join('');

  const identityRows = input.identities
    .map((id) => {
      const states = Object.entries(id.categoryStates)
        .map(([cat, entry]) => `${cat}: ${entry.action}`)
        .join(', ');
      const forms = `<div class="actions"><form method="post" action="/consent/record">${hiddenFields(input.csrfToken, input.consentTokens[id.channelIdentityId] ?? '')}<input type="hidden" name="channelIdentityId" value="${escapeHtml(id.channelIdentityId)}"><select class="input" name="category" aria-label="Category">${categoryOptions}</select><select class="input" name="action" aria-label="Consent action"><option value="grant">Grant</option><option value="revoke">Revoke</option></select><input class="input" name="wordingVersion" value="2026-11" required aria-label="Wording version"><input class="input" name="wording" value="Operator recorded customer consent" required aria-label="Wording"><button class="button primary" type="submit">Record consent</button></form><form method="post" action="/consent/reopt-in">${hiddenFields(input.csrfToken, input.reoptInTokens[id.channelIdentityId] ?? '')}<input type="hidden" name="channelIdentityId" value="${escapeHtml(id.channelIdentityId)}"><select class="input" name="category" aria-label="Re-opt-in category">${categoryOptions}</select><button class="button" type="submit">Explicit re-opt-in</button></form></div>`;
      return `<tr>${td('Identity', `<strong>${escapeHtml(id.channel)} · ${escapeHtml(id.externalContactId)}</strong><span class="subtle">ID #${escapeHtml(id.channelIdentityId)} · Lang: ${escapeHtml(id.preferredLanguage ?? 'unset')}</span>`)}${td('Consent state', escapeHtml(states || 'none recorded'))}${td('Controls', forms)}</tr>`;
    })
    .join('');

  const policyRows = input.outboundPolicies
    .map((pol) => {
      const next =
        pol.state === 'draft'
          ? 'submit'
          : pol.state === 'submitted'
            ? 'approve'
            : pol.state === 'approved'
              ? 'activate'
              : pol.state === 'active'
                ? 'retire'
                : '';
      const btn =
        isAdmin && next !== ''
          ? `<form method="post" action="/consent/outbound-policy/${escapeHtml(pol.policyRef)}/${next}">${hiddenFields(input.csrfToken, input.policyActionTokens[`${pol.policyRef}:${next}`] ?? '')}<button class="button ${next === 'retire' ? 'danger' : 'primary'}" type="submit">${escapeHtml(next)}</button></form>`
          : '';
      return `<tr>${td('Policy ref', escapeHtml(pol.policyRef))}${td('State', `<span class="state">${escapeHtml(pol.state.toUpperCase())}</span>`)}${td('Limits', `15m=${String(pol.perContact15Minute)}, 24h=${String(pol.perContact24Hour)}, 1m=${String(pol.global1Minute)}`)}${td('Action', btn)}</tr>`;
    })
    .join('');

  const templateRows = input.outboundTemplates
    .map((tpl) => {
      const next =
        tpl.state === 'draft'
          ? 'submit'
          : tpl.state === 'submitted'
            ? 'approve'
            : tpl.state === 'approved'
              ? 'activate'
              : tpl.state === 'active'
                ? 'retire'
                : '';
      const key = `${tpl.templateRef}:${String(tpl.versionNumber)}`;
      const btn =
        isAdmin && next !== ''
          ? `<form method="post" action="/consent/outbound-template/${escapeHtml(tpl.templateRef)}/${String(tpl.versionNumber)}/${next}">${hiddenFields(input.csrfToken, input.templateActionTokens[`${key}:${next}`] ?? '')}<button class="button ${next === 'retire' ? 'danger' : 'primary'}" type="submit">${escapeHtml(next)}</button></form>`
          : '';
      return `<tr>${td('Template', `${escapeHtml(tpl.templateRef)} v${String(tpl.versionNumber)} (${escapeHtml(tpl.templateName)})`)}${td('Locale / Purpose', `${escapeHtml(tpl.locale)} · ${escapeHtml(tpl.category)}`)}${td('State', `<span class="state">${escapeHtml(tpl.state.toUpperCase())}</span>`)}${td('Action', btn)}</tr>`;
    })
    .join('');

  const purposeOptions = OUTBOUND_PURPOSES.map(
    (p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`,
  ).join('');

  const adminForms = !isAdmin
    ? ''
    : `<hr class="section-rule"><div class="two-column"><section class="panel form-panel"><h2>Outbound policy draft</h2><form method="post" action="/consent/outbound-policy">${hiddenFields(input.csrfToken, input.createPolicyToken)}<div class="field"><label for="op15">Per-contact 15m</label><input id="op15" name="perContact15Minute" type="number" value="5" required></div><div class="field"><label for="op24">Per-contact 24h</label><input id="op24" name="perContact24Hour" type="number" value="20" required></div><div class="field"><label for="opg">Global 1m / day</label><input id="opg" name="global1Minute" type="number" value="60" required></div><div class="field"><label for="opgd">Global UTC day</label><input id="opgd" name="globalUtcDay" type="number" value="1000" required></div><button class="button primary" type="submit">Create outbound policy</button></form></section><section class="panel form-panel"><h2>Fixed WhatsApp template draft</h2><form method="post" action="/consent/outbound-template">${hiddenFields(input.csrfToken, input.createTemplateToken)}<div class="field"><label for="tplAccount">WhatsApp Phone ID</label><input id="tplAccount" name="channelAccountId" maxlength="128" required></div><div class="field"><label for="tplProviderId">Meta Template ID</label><input id="tplProviderId" name="providerTemplateId" maxlength="128" required></div><div class="field"><label for="tplName">Template Name (a-z0-9_)</label><input id="tplName" name="templateName" maxlength="128" required></div><div class="field"><label for="tplLocale">Locale</label><select id="tplLocale" name="locale"><option value="en_US">en_US</option><option value="bn_BD">bn_BD</option></select></div><div class="field"><label for="tplCategory">Category</label><select id="tplCategory" name="category">${purposeOptions}</select></div><div class="field"><label for="tplText">Approved template body</label><textarea id="tplText" name="templateText" maxlength="2000" required></textarea></div><button class="button primary" type="submit">Create template draft</button></form></section></div>`;

  return renderAdminPage({
    body: `<div class="heading-row"><div><h1>Consent &amp; outbound controls</h1><p>Reviewed consent categories, selective re-opt-in, outbound rate policy, and fixed WhatsApp template approvals.</p></div></div><section class="panel"><table class="table"><thead><tr><th>Identity</th><th>Consent state</th><th>Controls</th></tr></thead><tbody>${identityRows}</tbody></table>${identityRows === '' ? '<div class="empty">No channel identities recorded.</div>' : ''}</section><hr class="section-rule"><section class="panel"><table class="table"><thead><tr><th>Policy ref</th><th>State</th><th>Limits</th><th>Action</th></tr></thead><tbody>${policyRows}</tbody></table></section><hr class="section-rule"><section class="panel"><table class="table"><thead><tr><th>Template</th><th>Locale / Purpose</th><th>State</th><th>Action</th></tr></thead><tbody>${templateRows}</tbody></table></section>${adminForms}`,
    csrfToken: input.csrfToken,
    currentPath: '/consent',
    nonce: input.nonce,
    session: input.session,
    title: 'Consent & outbound',
  });
}

export function renderWebsiteImportPage(input: {
  readonly snapshots: readonly AdminWebsiteSnapshotSummary[];
  readonly importToken: string;
  readonly csrfToken: string;
  readonly nonce: string;
  readonly session: ResolvedAdminSession;
}): string {
  const rows = input.snapshots
    .map(
      (snap) =>
        `<tr>${td('Source URL', `<strong>${escapeHtml(snap.label)}</strong><span class="subtle">${escapeHtml(snap.approvedUrl)}</span>`)}${td('Snapshot', `<span class="confirm-ref">${escapeHtml(snap.snapshotRef)}</span><span class="subtle">${escapeHtml(snap.fetchedAt.toISOString())}</span>`)}${td('Captured excerpt', `<div class="copy">${escapeHtml((snap.excerpt ?? '').slice(0, 400))}</div>`)}</tr>`,
    )
    .join('');

  return renderAdminPage({
    body: `<div class="heading-row"><div><h1>Official website import (drafts only)</h1><p>Capture official website content into verified snapshots. Bilingual facts and FAQs enter drafts only and require owner review before publishing.</p></div><a class="button" href="/knowledge">Back to knowledge</a></div><section class="panel form-panel"><form method="post" action="/knowledge/import">${hiddenFields(input.csrfToken, input.importToken)}<div class="field"><label for="url">Official HTTPS URL</label><input id="url" name="url" type="url" placeholder="https://example.org/faq" maxlength="2048" required></div><div class="field"><label for="label">Source label</label><input id="label" name="label" maxlength="200"></div><div class="field"><label for="pastedHtmlOrText">Optional pasted official HTML/text (if offline or verifying manually, max 5000 chars)</label><textarea id="pastedHtmlOrText" name="pastedHtmlOrText" maxlength="5000"></textarea></div><h3>Optional bilingual draft proposal from captured page</h3><div class="two-column"><div class="field"><label for="itemKey">Item key (optional)</label><input id="itemKey" name="itemKey" maxlength="128" placeholder="faq.website.topic"></div><div class="field"><label for="kind">Kind</label><select id="kind" name="kind"><option value="faq">FAQ</option><option value="business_fact">Business fact</option></select></div></div><div class="field"><label for="questionEn">English question</label><input id="questionEn" name="questionEn" maxlength="1000"></div><div class="field"><label for="answerEn">English answer</label><textarea id="answerEn" name="answerEn" maxlength="4000"></textarea></div><div class="field"><label for="questionBn">Bangla question</label><input id="questionBn" name="questionBn" maxlength="1000"></div><div class="field"><label for="answerBn">Bangla answer</label><textarea id="answerBn" name="answerBn" maxlength="4000"></textarea></div><button class="button primary" type="submit">Import official snapshot</button></form></section><hr class="section-rule"><section class="panel"><table class="table"><thead><tr><th>Source URL</th><th>Snapshot</th><th>Captured excerpt</th></tr></thead><tbody>${rows}</tbody></table>${rows === '' ? '<div class="empty">No website snapshots imported yet.</div>' : ''}</section>`,
    csrfToken: input.csrfToken,
    currentPath: '/knowledge',
    nonce: input.nonce,
    session: input.session,
    title: 'Import website drafts',
  });
}

export function renderInsightsPage(input: {
  readonly insights: readonly AdminInsightSummary[];
  readonly aggregateToken?: string;
  readonly digestToken?: string;
  readonly csrfToken: string;
  readonly nonce: string;
  readonly session: ResolvedAdminSession;
}): string {
  const canTrigger =
    input.session.roles.includes('administrator') ||
    input.session.roles.includes('knowledge_editor') ||
    input.session.roles.includes('support_reviewer');
  const actions =
    canTrigger && input.aggregateToken !== undefined && input.digestToken !== undefined
      ? `<div class="actions"><form method="post" action="/insights/aggregate">${hiddenFields(input.csrfToken, input.aggregateToken)}<button class="button primary" type="submit">Run eligible insight aggregation</button></form><form method="post" action="/insights/digest">${hiddenFields(input.csrfToken, input.digestToken)}<button class="button" type="submit">Generate question digest</button></form></div>`
      : '';
  const rows = input.insights
    .map(
      (entry) =>
        `<article class="list-row"><h2>${escapeHtml(entry.topicCode)}</h2><p>${escapeHtml(entry.categoryCode)} · ${String(entry.occurrenceCount)} occurrences</p></article>`,
    )
    .join('');
  return renderAdminPage({
    body: `<div class="heading-row"><div><h1>Customer insights</h1><p>Aggregate-only signals derived from privacy-safe support gaps.</p></div>${actions}</div><section class="module-list">${rows || '<div class="panel empty">No items are currently visible.</div>'}</section>`,
    csrfToken: input.csrfToken,
    currentPath: '/insights',
    nonce: input.nonce,
    session: input.session,
    title: 'Customer insights',
  });
}
