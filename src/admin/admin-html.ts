import type { AdminRole, ResolvedAdminSession } from '../persistence/postgres-admin-identity.js';
import type { ModelPolicyValues, ModelPolicyVersionView } from '../model/model-policy-types.js';

export interface AdminProposalSummary {
  readonly itemKey: string;
  readonly scheduledAction?: 'publish' | 'retire' | 'rollback';
  readonly scheduledEffectiveAt?: Date;
  readonly publicationState?: 'unpublished' | 'published' | 'scheduled' | 'retired' | 'superseded';
  readonly effectiveAt?: Date;
  readonly sourceLabel: string;
  readonly state: 'approved' | 'draft' | 'rejected' | 'submitted';
  readonly title: string;
  readonly updatedAt: Date;
  readonly versionRef: string;
}

export interface AdminProposalDetail {
  readonly currentVersionRef?: string;
  readonly scheduledAction?: AdminProposalSummary['scheduledAction'];
  readonly scheduledEffectiveAt?: Date;
  readonly publicationState?: AdminProposalSummary['publicationState'];
  readonly effectiveAt?: Date;
  readonly authorReference?: string;
  readonly sourceRef?: string;
  readonly replacesVersionRef?: string;
  readonly previousAnswers?: { readonly en: string; readonly bn: string };
  readonly answerBn: string;
  readonly answerEn: string;
  readonly itemKey: string;
  readonly kind: string;
  readonly questionBn: string;
  readonly questionEn: string;
  readonly sourceLabel: string;
  readonly state: AdminProposalSummary['state'];
  readonly versionRef: string;
}

export interface AdminQuestionSummary {
  readonly priority: 'high' | 'normal' | 'low';
  readonly questionRef: string;
  readonly questionText: string;
  readonly state: 'answered' | 'open' | 'dismissed';
}

export interface AdminInsightSummary {
  readonly categoryCode: string;
  readonly occurrenceCount: number;
  readonly topicCode: string;
}

export type AdminPolicySummary = ModelPolicyVersionView;

export interface AdminEscalationCount {
  readonly count: number;
  readonly reasonCode: string;
  readonly state: string;
}

export interface AdminAuditSummary {
  readonly action: string;
  readonly effectiveAt: Date;
  readonly objectRef: string | null;
  readonly result: string;
}

interface PageOptions {
  readonly body: string;
  readonly csrfToken: string;
  readonly currentPath: string;
  readonly nonce: string;
  readonly session: ResolvedAdminSession;
  readonly title: string;
}

const styles = `
:root{color-scheme:light;--bg:#f4f7f6;--surface:#fff;--ink:#12231f;--muted:#5f726c;--border:#d9e3df;--accent:#0d6b5c;--accent-soft:#eaf5f2;--nav:#102d28;--danger:#a23c3c;--warning:#9a5a12;font-family:"Segoe UI","Noto Sans Bengali",Arial,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-size:14px;line-height:1.5}a{color:inherit;text-decoration:none}button,input,select,textarea{font:inherit}button{cursor:pointer}.shell{min-height:100vh;display:grid;grid-template-columns:224px minmax(0,1fr)}.sidebar{background:var(--nav);color:#dce9e6;padding:28px 12px 24px;display:flex;flex-direction:column}.brand{display:flex;align-items:center;gap:12px;padding:0 12px 34px;font-weight:700;font-size:17px}.brand-mark{width:34px;height:34px;border-radius:9px;background:#52c8ad;color:var(--nav);display:grid;place-items:center;font-weight:900}.nav-label{padding:0 12px 10px;color:#87aaa2;font-size:11px;font-weight:700;letter-spacing:.12em}.nav a{display:block;padding:12px 18px;margin:2px 0;border-radius:8px;color:#c6d8d3;font-size:14px}.nav a[aria-current="page"]{background:#1d4a42;color:#fff;border-left:3px solid #52c8ad;padding-left:15px;font-weight:650}.sidebar-foot{margin-top:auto;border-top:1px solid #31554e;padding:22px 12px 0}.sidebar-foot strong{display:block;font-size:12px}.sidebar-foot span{display:block;color:#87aaa2;font-size:11px;margin-top:4px}.main{min-width:0}.topbar{height:68px;background:#fff;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 40px;color:var(--muted);font-size:13px}.topbar form{margin:0}.link-button{border:0;background:none;color:#24453e;font-weight:650;padding:8px}.content{padding:34px 40px 48px;max-width:1320px;margin:0 auto}.heading-row{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:28px}.heading-row h1{font-size:29px;line-height:1.2;margin:0 0 8px}.heading-row p{margin:0;color:var(--muted)}.button{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 20px;border-radius:8px;border:1px solid #b9ccc6;background:#fff;color:#24453e;font-weight:650}.button.primary{background:var(--accent);border-color:var(--accent);color:#fff}.button.danger{border-color:#dbbcbc;color:var(--danger)}.filters{display:flex;gap:12px;margin-bottom:20px}.field{display:grid;gap:7px;margin-bottom:16px}.field label,.label{font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--muted);text-transform:uppercase}.field input,.field select,.field textarea,.input{width:100%;border:1px solid #b9ccc6;border-radius:7px;background:#fff;color:var(--ink);padding:10px 12px;min-height:42px}.field textarea{min-height:96px;resize:vertical}.field input:focus,.field select:focus,.field textarea:focus{outline:3px solid #cde9e2;outline-offset:1px;border-color:var(--accent)}.knowledge-grid{display:grid;grid-template-columns:minmax(0,1fr) 386px;gap:20px}.panel{background:#fff;border:1px solid var(--border);border-radius:10px;overflow:hidden}.table{width:100%;border-collapse:collapse}.table th{text-align:left;background:#edf3f1;color:var(--muted);font-size:11px;letter-spacing:.05em;padding:15px 16px}.table td{padding:18px 16px;border-top:1px solid #e3ebe8;vertical-align:top}.table tr.selected{background:var(--accent-soft);box-shadow:inset 4px 0 var(--accent)}.table strong{font-size:13px}.subtle{display:block;color:var(--muted);font-size:12px;margin-top:4px}.state{font-size:11px;font-weight:750;letter-spacing:.04em}.state.submitted{color:var(--accent)}.state.draft{color:var(--warning)}.state.rejected{color:var(--danger)}.detail{padding:26px}.detail h2{font-size:21px;margin:6px 0}.section-rule{border:0;border-top:1px solid #e3ebe8;margin:22px 0}.copy{white-space:pre-wrap}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}.module-list{display:grid;gap:12px}.list-row{background:#fff;border:1px solid var(--border);border-radius:9px;padding:18px 20px}.list-row h2{font-size:16px;margin:0 0 6px}.list-row p{margin:0;color:var(--muted)}.two-column{display:grid;grid-template-columns:1fr 1fr;gap:20px}.form-panel{max-width:760px;padding:26px}.notice{padding:14px 16px;border-radius:8px;background:#edf3f1;color:#24453e;margin-bottom:18px}.error{background:#f8eaea;color:#762b2b}.login-wrap{min-height:100vh;display:grid;place-items:center;padding:24px;background:#eaf1ef}.login-panel{width:min(440px,100%);background:#fff;border:1px solid var(--border);border-radius:14px;padding:34px;box-shadow:0 20px 50px rgba(16,45,40,.10)}.login-panel h1{font-size:25px;margin:0 0 8px}.login-panel>p{color:var(--muted);margin:0 0 26px}.login-brand{display:flex;align-items:center;gap:10px;margin-bottom:28px;font-weight:700}.login-panel .button{width:100%}.confirm-ref{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:#edf3f1;padding:2px 6px;border-radius:4px}.mobile-head{display:none}.copy,.subtle,.confirm-ref{overflow-wrap:anywhere}.filters .input{min-width:0}.mobile-menu{display:none}.empty{padding:36px;text-align:center;color:var(--muted)}
.table td,.detail h2{overflow-wrap:anywhere}
.operations-table{overflow:auto}.operations-table caption{text-align:left;padding:16px;font-weight:700}.operations-revision{overflow-wrap:anywhere}.operations-sections{margin-top:20px}button:focus-visible,a:focus-visible{outline:3px solid #52c8ad;outline-offset:3px}
.table td:nth-child(4),.table td:nth-child(5){white-space:nowrap}
@media(max-width:900px){.shell{display:block}.sidebar{display:none}.mobile-head{height:64px;background:var(--nav);color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 18px;font-weight:700}.mobile-menu{display:block;background:var(--nav);color:#fff;padding:0 18px 16px}.mobile-menu summary{cursor:pointer;font-weight:650;padding:8px 0}.mobile-menu nav a{display:block;padding:10px 0}.mobile-menu .link-button{color:#fff;padding-left:0}.topbar{display:none}.content{padding:28px 18px}.heading-row{display:block}.heading-row .button{width:100%;margin-top:18px}.filters{display:block}.knowledge-grid,.two-column{grid-template-columns:1fr}.table thead{display:none}.table,.table tbody,.table tr,.table td{display:block}.table tr{margin:12px;border:1px solid var(--border);border-radius:9px;padding:10px}.table td{border:0;padding:6px 10px}.detail{padding:20px}.form-panel{padding:20px}.actions .button{width:100%}}
`;

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function document(title: string, nonce: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · FCD Support</title><style nonce="${escapeHtml(nonce)}">${styles}</style></head><body>${body}</body></html>`;
}

function navigation(currentPath: string, roles: readonly AdminRole[]): string {
  const links = [
    ['/knowledge', 'Knowledge'],
    ['/questions', 'Questions'],
    ['/insights', 'Insights'],
    ['/policy', 'Policy'],
    ...(roles.some((role) => role === 'administrator' || role === 'support_reviewer')
      ? [['/escalations', 'Escalations']]
      : []),
    ...(roles.includes('administrator')
      ? [
          ['/audit', 'Audit'],
          ['/operations', 'Operations'],
        ]
      : []),
  ] as const;
  return links
    .map(([href, label]) => {
      const selected = currentPath.startsWith(href) ? ' aria-current="page"' : '';
      return `<a href="${href}"${selected}>${label}</a>`;
    })
    .join('');
}

export function renderAdminPage(options: PageOptions): string {
  const accountRef = escapeHtml(options.session.accountRef);
  const csrfToken = escapeHtml(options.csrfToken);
  return document(
    options.title,
    options.nonce,
    `<div class="mobile-head"><span>FCD Support</span></div><details class="mobile-menu"><summary>Navigation and account</summary><nav aria-label="Mobile administration">${navigation(options.currentPath, options.session.roles)}</nav><form method="post" action="/logout"><input type="hidden" name="csrfToken" value="${csrfToken}"><button class="link-button" type="submit">Sign out</button></form></details><div class="shell"><aside class="sidebar"><div class="brand"><span class="brand-mark">F</span>FCD Support</div><div class="nav-label">OPERATIONS</div><nav class="nav" aria-label="Private administration">${navigation(options.currentPath, options.session.roles)}</nav><div class="sidebar-foot"><strong>Private administration</strong><span>Loopback access only</span><span>${accountRef}</span></div></aside><main class="main"><header class="topbar"><span>Reviewed facts stay authoritative. Proposals never publish automatically.</span><form method="post" action="/logout"><input type="hidden" name="csrfToken" value="${csrfToken}"><button class="link-button" type="submit">Sign out</button></form></header><div class="content">${options.body}</div></main></div>`,
  );
}

const page = renderAdminPage;

export function renderLoginPage(nonce: string, message?: string): string {
  const notice =
    message === undefined ? '' : `<div class="notice error">${escapeHtml(message)}</div>`;
  return document(
    'Private administration',
    nonce,
    `<main class="login-wrap"><section class="login-panel"><div class="login-brand"><span class="brand-mark">F</span>FCD Support</div><h1>Private administration</h1><p>Sign in with your individual staff account.</p>${notice}<form method="post" action="/login"><div class="field"><label for="loginName">Login</label><input id="loginName" name="loginName" autocomplete="username" maxlength="64" required></div><div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required></div><button class="button primary" type="submit">Continue</button></form></section></main>`,
  );
}

export function renderMfaPage(nonce: string, csrfToken: string, message?: string): string {
  const notice =
    message === undefined ? '' : `<div class="notice error">${escapeHtml(message)}</div>`;
  return document(
    'MFA verification',
    nonce,
    `<main class="login-wrap"><section class="login-panel"><div class="login-brand"><span class="brand-mark">F</span>FCD Support</div><h1>Verification code</h1><p>Enter the current code from the enrolled authenticator.</p>${notice}<form method="post" action="/mfa"><input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}"><div class="field"><label for="code">Authenticator code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,8}" maxlength="8" required></div><button class="button primary" type="submit">Verify</button></form></section></main>`,
  );
}

function scheduledNotice(proposal: {
  readonly scheduledAction?: AdminProposalSummary['scheduledAction'];
  readonly scheduledEffectiveAt?: Date;
}): string {
  return proposal.scheduledAction === undefined || proposal.scheduledEffectiveAt === undefined
    ? ''
    : `<span class="subtle">Scheduled ${escapeHtml(proposal.scheduledAction)}: ${escapeHtml(proposal.scheduledEffectiveAt.toISOString())}</span>`;
}

export function renderKnowledgePage(input: {
  readonly page: number;
  readonly hasNextPage: boolean;
  readonly actionTokens: Readonly<Record<string, string>>;
  readonly search: string;
  readonly state: string;
  readonly csrfToken: string;
  readonly nonce: string;
  readonly proposals: readonly AdminProposalSummary[];
  readonly selected?: AdminProposalDetail | undefined;
  readonly session: ResolvedAdminSession;
}): string {
  const rows = input.proposals
    .map((proposal) => {
      const selected =
        input.selected?.versionRef === proposal.versionRef ? ' class="selected"' : '';
      return `<tr${selected}><td><a href="/knowledge/${escapeHtml(proposal.versionRef)}"><strong>${escapeHtml(proposal.versionRef)}</strong></a></td><td><strong>${escapeHtml(proposal.title)}</strong><span class="subtle">${escapeHtml(proposal.itemKey)}</span></td><td>${escapeHtml(proposal.sourceLabel)}</td><td><span class="state ${escapeHtml(proposal.state)}">${escapeHtml((proposal.publicationState === undefined || proposal.publicationState === 'unpublished' ? proposal.state : proposal.publicationState).toUpperCase())}</span>${scheduledNotice(proposal)}</td><td>${escapeHtml(proposal.updatedAt.toISOString().slice(0, 10))}</td></tr>`;
    })
    .join('');
  const selected = input.selected;
  const pageLink = (pageNumber: number, label: string) =>
    `<a class="button" href="/knowledge?${escapeHtml(new URLSearchParams({ search: input.search, state: input.state, page: String(pageNumber) }).toString())}">${label}</a>`;
  const editor = input.session.roles.some(
    (role) => role === 'administrator' || role === 'knowledge_editor',
  );
  const reviewer = input.session.roles.some(
    (role) => role === 'administrator' || role === 'knowledge_reviewer',
  );
  const reviewForm = (action: 'submit' | 'approve' | 'reject', label: string): string =>
    selected === undefined
      ? ''
      : `<form method="post" action="/knowledge/${escapeHtml(selected.versionRef)}/${action === 'submit' ? 'submit' : 'review'}"><input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}"><input type="hidden" name="actionToken" value="${escapeHtml(input.actionTokens[action] ?? '')}"><input type="hidden" name="action" value="${action}"><button class="button ${action === 'reject' ? 'danger' : 'primary'}" type="submit">${label}</button></form>`;
  const controls =
    selected === undefined
      ? ''
      : (selected.state === 'draft' && editor ? reviewForm('submit', 'Submit for review') : '') +
        (selected.state === 'submitted' && reviewer
          ? reviewForm('approve', 'Approve') + reviewForm('reject', 'Reject')
          : '') +
        (selected.state === 'approved' && reviewer
          ? `<a class="button primary" href="/knowledge/${escapeHtml(selected.versionRef)}/publish">Publish or schedule</a><a class="button" href="/knowledge/${escapeHtml(selected.versionRef)}/retire">Retire</a><a class="button" href="/knowledge/${escapeHtml(selected.versionRef)}/rollback">Rollback</a>`
          : '') +
        (editor
          ? `<a class="button" href="/knowledge/new?replaces=${encodeURIComponent(selected.versionRef)}">Create replacement</a>`
          : '');
  const detail =
    input.selected === undefined
      ? '<aside class="panel detail"><div class="empty">Select an exact version to review its provenance and bilingual content.</div></aside>'
      : `<aside class="panel detail"><span class="label">Selected version</span><h2>${escapeHtml(input.selected.questionEn)}</h2><span class="subtle">${escapeHtml(input.selected.versionRef)} · ${escapeHtml(input.selected.state)} · ${escapeHtml(input.selected.publicationState ?? 'unpublished')}</span>${scheduledNotice(input.selected)}<hr class="section-rule"><span class="label">Provenance</span><p>${escapeHtml(input.selected.sourceLabel)}<span class="subtle">${escapeHtml(input.selected.sourceRef ?? '')} · Author ${escapeHtml(input.selected.authorReference ?? 'pending')}</span></p><p class="subtle">Effective: ${escapeHtml(input.selected.effectiveAt?.toISOString() ?? 'Not published')}</p><span class="label">Bangla question</span><p lang="bn">${escapeHtml(input.selected.questionBn)}</p><span class="label">English answer</span><p class="copy">${escapeHtml(input.selected.answerEn)}</p><span class="label">Bangla answer</span><p class="copy" lang="bn">${escapeHtml(input.selected.answerBn)}</p>${input.selected.previousAnswers === undefined ? '' : `<details><summary>Compare previous version: ${escapeHtml(input.selected.replacesVersionRef ?? '')}</summary><p class="copy">${escapeHtml(input.selected.previousAnswers.en)}</p><p class="copy" lang="bn">${escapeHtml(input.selected.previousAnswers.bn)}</p></details>`}<div class="actions">${controls}</div></aside>`;
  return page({
    body: `<div class="heading-row"><div><h1>Knowledge proposals</h1><p>Review provenance and bilingual answers before publication.</p></div>${editor ? '<a class="button primary" href="/knowledge/new">New proposal</a>' : ''}</div><form class="filters" method="get" action="/knowledge"><input class="input" name="search" aria-label="Search proposals" placeholder="Search proposals" value="${escapeHtml(input.search)}"><select class="input" name="state" aria-label="Proposal state">${['', 'draft', 'submitted', 'approved', 'published', 'scheduled', 'retired', 'rejected', 'superseded'].map((state) => `<option value="${state}"${state === input.state ? ' selected' : ''}>${state || 'All states'}</option>`).join('')}</select><button class="button" type="submit">Filter</button></form><div class="knowledge-grid"><section class="panel"><table class="table"><thead><tr><th>Version</th><th>Topic</th><th>Source</th><th>State</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table>${rows === '' ? '<div class="empty">No proposals are available.</div>' : ''}</section>${detail}</div><nav class="actions" aria-label="Proposal pages">${input.page > 1 ? pageLink(input.page - 1, 'Previous page') : ''}<span>Page ${String(input.page)}</span>${input.hasNextPage && input.page < 10000 ? pageLink(input.page + 1, 'Next page') : ''}</nav>`,
    csrfToken: input.csrfToken,
    currentPath: '/knowledge',
    nonce: input.nonce,
    session: input.session,
    title: 'Knowledge proposals',
  });
}

export function renderNewProposalPage(input: {
  readonly actionToken: string;
  readonly replacement?: AdminProposalDetail | undefined;
  readonly csrfToken: string;
  readonly nonce: string;
  readonly session: ResolvedAdminSession;
}): string {
  return page({
    body: `<div class="heading-row"><div><h1>New knowledge proposal</h1><p>Create a draft only. Publication always requires separate review.</p></div></div><section class="panel form-panel"><form method="post" action="/knowledge"><input type="hidden" name="actionToken" value="${escapeHtml(input.actionToken)}"><input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}"><div class="two-column"><div class="field"><label for="itemKey">Item key</label><input id="itemKey" name="itemKey" maxlength="128" value="${escapeHtml(input.replacement?.itemKey ?? '')}" required></div><div class="notice">Version references are assigned automatically. ${input.replacement === undefined ? 'New item' : `Replacing ${escapeHtml(input.replacement.versionRef)}`}</div></div><div class="two-column"><div class="field"><label for="sourceLabel">Business source / provenance</label><input id="sourceLabel" name="sourceLabel" maxlength="200" value="${escapeHtml(input.replacement?.sourceLabel ?? '')}" required></div><div class="field"><label for="kind">Kind</label>${input.replacement === undefined ? '<select id="kind" name="kind"><option value="faq">FAQ</option><option value="business_fact">Business fact</option><option value="safety_response">Safety response</option><option value="escalation_response">Escalation response</option></select>' : `<input id="kind" name="kind" value="${escapeHtml(input.replacement.kind)}" readonly>`}</div></div><div class="field"><label for="questionEn">English question</label><input id="questionEn" name="questionEn" maxlength="1000" value="${escapeHtml(input.replacement?.questionEn ?? '')}" required></div><div class="field"><label for="answerEn">English answer</label><textarea id="answerEn" name="answerEn" maxlength="4000" required>${escapeHtml(input.replacement?.answerEn ?? '')}</textarea></div><div class="field"><label for="questionBn">Bangla question</label><input id="questionBn" name="questionBn" maxlength="1000" value="${escapeHtml(input.replacement?.questionBn ?? '')}" required></div><div class="field"><label for="answerBn">Bangla answer</label><textarea id="answerBn" name="answerBn" maxlength="4000" required>${escapeHtml(input.replacement?.answerBn ?? '')}</textarea></div><button class="button primary" type="submit">Create draft proposal</button></form></section>`,
    csrfToken: input.csrfToken,
    currentPath: '/knowledge',
    nonce: input.nonce,
    session: input.session,
    title: 'New proposal',
  });
}

export function renderConfirmationPage(input: {
  readonly actionToken: string;
  readonly effectiveAt: Date;
  readonly action: 'publish' | 'retire' | 'rollback';
  readonly csrfToken: string;
  readonly nonce: string;
  readonly proposal: AdminProposalDetail;
  readonly session: ResolvedAdminSession;
}): string {
  const title = `${input.action[0]?.toUpperCase() ?? ''}${input.action.slice(1)} exact version`;
  return page({
    body: `<div class="heading-row"><div><h1>${escapeHtml(title)}</h1><p>This appends evidence; it never rewrites publication history.</p></div></div><section class="panel form-panel"><div class="notice">Confirm <span class="confirm-ref">${escapeHtml(input.proposal.versionRef)}</span> exactly.<p>Publication at selected time: ${escapeHtml(input.proposal.currentVersionRef ?? 'None')}</p><p>Effective time (UTC): ${escapeHtml(input.effectiveAt.toISOString())}</p></div><form method="get"><div class="field"><label for="effectiveAt">Schedule time (UTC)</label><input type="datetime-local" id="effectiveAt" name="effectiveAt" required></div><button class="button" type="submit">Review scheduled action</button></form><hr class="section-rule"><form method="post" action="/knowledge/${escapeHtml(input.proposal.versionRef)}/${escapeHtml(input.action)}"><input type="hidden" name="actionToken" value="${escapeHtml(input.actionToken)}"><input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}"><div class="field"><label for="confirmationVersionRef">Exact version reference</label><input id="confirmationVersionRef" name="confirmationVersionRef" autocomplete="off" required></div><button class="button ${input.action === 'retire' ? 'danger' : 'primary'}" type="submit">Confirm ${escapeHtml(input.action)}</button></form></section>`,
    csrfToken: input.csrfToken,
    currentPath: '/knowledge',
    nonce: input.nonce,
    session: input.session,
    title,
  });
}

export function renderQuestionsPage(input: {
  readonly actionTokens: Readonly<Record<string, string>>;
  readonly csrfToken: string;
  readonly nonce: string;
  readonly questions: readonly AdminQuestionSummary[];
  readonly session: ResolvedAdminSession;
}): string {
  const rows = input.questions
    .map(
      (question) =>
        `<article class="list-row"><span class="state ${question.state === 'open' ? 'submitted' : ''}">${escapeHtml(question.state.toUpperCase())}</span><h2>${escapeHtml(question.questionText)}</h2><p>${escapeHtml(question.questionRef)} · ${escapeHtml(question.priority)} priority</p>${question.state === 'open' ? `<form method="post" action="/questions/${escapeHtml(question.questionRef)}/answers"><input type="hidden" name="actionToken" value="${escapeHtml(input.actionTokens[question.questionRef] ?? '')}"><input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}"><div class="field"><label for="answer-${escapeHtml(question.questionRef)}">Reviewed answer</label><textarea id="answer-${escapeHtml(question.questionRef)}" name="answerText" maxlength="4000" required></textarea></div><div class="field"><label for="answer-bn-${escapeHtml(question.questionRef)}">Bangla answer</label><textarea id="answer-bn-${escapeHtml(question.questionRef)}" name="answerBn" maxlength="4000" required></textarea></div><button class="button primary" type="submit">Create draft proposal</button></form>` : ''}</article>`,
    )
    .join('');
  return page({
    body: `<div class="heading-row"><div><h1>Owner questions</h1><p>Answers create proposals only; they never publish automatically.</p></div></div><section class="module-list">${rows || '<div class="panel empty">No owner questions are open.</div>'}</section>`,
    csrfToken: input.csrfToken,
    currentPath: '/questions',
    nonce: input.nonce,
    session: input.session,
    title: 'Owner questions',
  });
}

export function renderSimpleModulePage(input: {
  readonly csrfToken: string;
  readonly currentPath: string;
  readonly description: string;
  readonly nonce: string;
  readonly rows: readonly { readonly label: string; readonly meta: string }[];
  readonly session: ResolvedAdminSession;
  readonly title: string;
}): string {
  const rows = input.rows
    .map(
      (row) =>
        `<article class="list-row"><h2>${escapeHtml(row.label)}</h2><p>${escapeHtml(row.meta)}</p></article>`,
    )
    .join('');
  return page({
    body: `<div class="heading-row"><div><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.description)}</p></div></div><section class="module-list">${rows || '<div class="panel empty">No records are available.</div>'}</section>`,
    csrfToken: input.csrfToken,
    currentPath: input.currentPath,
    nonce: input.nonce,
    session: input.session,
    title: input.title,
  });
}

const policyFields = [
  ['perContact15MinuteCalls', 'Per-contact calls / 15 minutes', '1'],
  ['perContact24HourCalls', 'Per-contact calls / rolling 24 hours', '1'],
  ['globalUtcDayCalls', 'Global calls / UTC day', '1'],
  ['concurrentCalls', 'Concurrent calls', '1'],
  ['queueCapacity', 'Queue capacity', '1'],
  ['totalTimeoutMs', 'Total timeout (ms)', '1'],
  ['outputTokens', 'Output token ceiling', '1'],
  ['cooldownMs', 'Per-contact cooldown (ms)', '1'],
  ['faqMinimumSimilarity', 'FAQ minimum similarity', '0.00001'],
  ['faqAmbiguityMargin', 'FAQ ambiguity margin', '0.00001'],
  ['maximumFaqCandidates', 'Maximum FAQ candidates', '1'],
  ['approvedProviderAttempts', 'Approved provider attempts', '1'],
  ['architectureProviderCeiling', 'Architecture provider ceiling', '1'],
] as const satisfies readonly (readonly [keyof ModelPolicyValues, string, string])[];

export function renderModelPolicyPage(input: {
  readonly actionTokens: Readonly<
    Record<string, Partial<Record<'activate' | 'approve' | 'retire' | 'submit', string>>>
  >;
  readonly createActionToken: string;
  readonly createPolicyRef: string;
  readonly csrfToken: string;
  readonly evaluatedAt: Date;
  readonly nonce: string;
  readonly policies: readonly AdminPolicySummary[];
  readonly session: ResolvedAdminSession;
}): string {
  const policyRows = input.policies
    .map((policy) => {
      const displayState =
        policy.state === 'active' &&
        policy.activatedAt !== undefined &&
        policy.activatedAt > input.evaluatedAt
          ? `scheduled activation ${policy.activatedAt.toISOString()}`
          : policy.state === 'retired' &&
              policy.retiredAt !== undefined &&
              policy.retiredAt > input.evaluatedAt
            ? `active; retirement scheduled ${policy.retiredAt.toISOString()}`
            : policy.state;
      const nextAction =
        policy.state === 'draft'
          ? 'submit'
          : policy.state === 'submitted'
            ? 'approve'
            : policy.state === 'approved'
              ? 'activate'
              : policy.state === 'active'
                ? 'retire'
                : undefined;
      const actionForm =
        nextAction === undefined
          ? ''
          : `<form method="post" action="/policy/${escapeHtml(policy.policyRef)}/${nextAction}"><input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}"><input type="hidden" name="actionToken" value="${escapeHtml(input.actionTokens[policy.policyRef]?.[nextAction] ?? '')}"><button class="button ${nextAction === 'retire' ? 'danger' : 'primary'}" type="submit">${escapeHtml(nextAction)}</button></form>`;
      const values = policyFields
        .map(([field, label]) => `${label}: ${escapeHtml(String(policy.values[field]))}`)
        .join(' · ');
      return `<article class="list-row"><h2>${escapeHtml(policy.policyRef)}</h2><p>${escapeHtml(displayState)} · version ${String(policy.versionNumber)}</p><p class="subtle">${values}</p><div class="actions">${actionForm}</div></article>`;
    })
    .join('');
  const inputs = policyFields
    .map(
      ([field, label, step]) =>
        `<div class="field"><label for="${field}">${escapeHtml(label)}</label><input id="${field}" name="${field}" type="number" step="${step}" required></div>`,
    )
    .join('');
  return page({
    body: `<div class="heading-row"><div><h1>Model policy</h1><p>Administrator-reviewed limits and FAQ thresholds. No value is hardcoded by this form.</p></div></div><section class="module-list">${policyRows || '<div class="panel empty">No model policy exists.</div>'}</section><hr class="section-rule"><section class="panel form-panel"><h2>Create policy draft</h2><div class="notice">Assigned reference: <span class="confirm-ref">${escapeHtml(input.createPolicyRef)}</span>. Creation never activates a policy.</div><form method="post" action="/policy"><input type="hidden" name="actionToken" value="${escapeHtml(input.createActionToken)}"><input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}">${inputs}<button class="button primary" type="submit">Create policy draft</button></form></section>`,
    csrfToken: input.csrfToken,
    currentPath: '/policy',
    nonce: input.nonce,
    session: input.session,
    title: 'Model policy',
  });
}

export function renderSafeErrorPage(nonce: string, statusCode: number): string {
  return document(
    'Request unavailable',
    nonce,
    `<main class="login-wrap"><section class="login-panel"><h1>Request unavailable</h1><p>The private service could not complete this request.</p><p class="subtle">Status ${escapeHtml(statusCode)}</p><a class="button" href="/knowledge">Return to knowledge</a></section></main>`,
  );
}
