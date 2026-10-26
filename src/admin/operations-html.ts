import type { ResolvedAdminSession } from '../persistence/postgres-admin-identity.js';
import { escapeHtml as escape, renderAdminPage } from './admin-html.js';
import { parseOperationsView, type OperationsView } from './operations-types.js';

function time(value: Date | null): string {
  return value === null ? 'not_verified' : escape(value.toISOString());
}
function table(caption: string, headings: readonly string[], rows: readonly string[]): string {
  return `<section class="panel operations-table"><table class="table"><caption>${escape(caption)}</caption><thead><tr>${headings.map((heading) => `<th scope="col">${escape(heading)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></section>`;
}
function cell(label: string, value: string): string {
  return `<td><span class="subtle">${escape(label)}</span>${value}</td>`;
}
export function renderOperationsPage(input: {
  readonly view: OperationsView;
  readonly nonce: string;
  readonly csrfToken: string;
  readonly session: ResolvedAdminSession;
  readonly actionTokens: Readonly<Record<string, string>>;
}): string {
  const view = parseOperationsView(input.view);
  const healthRows = view.health.map(
    (value) =>
      `<tr>${cell('Component', escape(value.component))}${cell('State', `<strong>${escape(value.state)}</strong>`)}${cell('Reason', escape(value.reasonCode))}${cell('Checked', time(value.checkedAt))}</tr>`,
  );
  const queueRows = view.queues.map(
    (value) =>
      `<tr>${cell('Worker', escape(value.component))}${cell('Pending', String(value.pending))}${cell('Leased', String(value.leased))}${cell('Failed', String(value.failed))}${cell('Completed / delivered', String(value.completed))}${cell('Oldest pending', escape(value.oldestAgeBucket))}</tr>`,
  );
  const incidents = view.incidents.map((incident) => {
    const token = input.actionTokens[incident.incidentRef];
    const acknowledgement =
      incident.acknowledgedAt !== null
        ? `Acknowledged ${time(incident.acknowledgedAt)}`
        : incident.resolvedAt !== null
          ? 'Resolved'
          : token === undefined
            ? 'Unavailable'
            : `<form method="post" action="/operations/incidents/${escape(incident.incidentRef)}/acknowledge"><input type="hidden" name="csrfToken" value="${escape(input.csrfToken)}"><input type="hidden" name="actionToken" value="${escape(token)}"><button class="button" type="submit" aria-label="Acknowledge ${escape(incident.component)} incident ${escape(incident.incidentRef)}">Acknowledge</button></form>`;
    return `<tr>${cell('Component', `<strong>${escape(incident.component)}</strong><span class="subtle">${escape(incident.incidentRef)}</span>`)}${cell('Opened', time(incident.openedAt))}${cell('Last observed', `${time(incident.lastObservedAt)}<span class="subtle">Failures: ${String(incident.consecutiveFailures)}</span>`)}${cell('Resolved', time(incident.resolvedAt))}${cell('Acknowledgement', acknowledgement)}</tr>`;
  });
  const manifest = view.modelEnabled
    ? (view.host?.manifestAttestation ?? 'not_verified')
    : 'disabled';
  const publicCheck = view.host?.publicRouteCheck;
  const body = `<div class="heading-row"><div><h1>Operational health</h1><p>Content-free status as of ${time(view.evaluatedAt)}.</p></div></div>
  <div class="two-column"><section class="panel detail"><h2>Deployment and recovery</h2><dl><dt>Schema revision</dt><dd>${escape(view.schemaRevision ?? 'not_verified')}</dd><dt>Deployed revision</dt><dd class="operations-revision">${escape(view.deployedRevision ?? 'not_verified')}</dd><dt>Deployment</dt><dd>${escape(view.deploymentState ?? 'not_verified')}</dd><dt>Backup</dt><dd>${escape(view.backup.state)} · ${time(view.backup.createdAt)}</dd><dt>Last backup verification</dt><dd>${time(view.backup.verifiedAt)}</dd><dt>Restore</dt><dd>${escape(view.restore.state)} · ${time(view.restore.recordedAt)}</dd></dl></section>
  <section class="panel detail"><h2>Private dependency verification</h2><dl><dt>Admin socket health</dt><dd>${escape(view.host?.adminSocket ?? 'not_verified')}</dd><dt>Host checked</dt><dd>${escape(view.host?.checkedAt ?? 'not_verified')}</dd><dt>Manifest recording-disabled attestation</dt><dd>${escape(manifest)}</dd><dt>Outbound execution</dt><dd>${view.outboundEnabled ? 'enabled' : 'disabled'}</dd><dt>Notification execution</dt><dd>${view.notificationsEnabled ? 'enabled' : 'disabled'}</dd><dt>Exact public route verification</dt><dd>${escape(publicCheck?.state ?? 'not_verified')} · ${escape(publicCheck?.checkedAt ?? 'not_verified')}</dd></dl></section></div>
  <div class="module-list operations-sections">${healthRows.length === 0 ? '<p class="notice" role="status">No health observations. Status is not_verified.</p>' : table('Current component status', ['Component', 'State', 'Reason', 'Checked'], healthRows)}
  ${queueRows.length === 0 ? '<p class="notice" role="status">No worker aggregates.</p>' : table('Worker queues', ['Worker', 'Pending', 'Leased', 'Failed', 'Completed / delivered', 'Oldest pending'], queueRows)}
  <h2>Incident review</h2><p>Acknowledgement records review; component health continues to reflect collection results.</p>${incidents.length === 0 ? '<p class="notice" role="status">No incidents.</p>' : table('Recent incidents', ['Component', 'Opened', 'Last observed', 'Resolved', 'Acknowledgement'], incidents)}</div>`;
  return renderAdminPage({
    body,
    csrfToken: input.csrfToken,
    currentPath: '/operations',
    nonce: input.nonce,
    session: input.session,
    title: 'Operational health',
  });
}
