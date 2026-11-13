# Recurring scheduled-health uncertainty after closeout

Date observed: 2026-11-03 (Asia/Dhaka).
Status: **OPEN / held. Do not clear, retry or infer SQL outcome.**

During the owner's subsequent container-cleanup inventory, the latest private
scope fcd-support-host-test-p6-b1e183d retained an uncertain health job at source
`24e5667`; its saved physical operation actor was absent. The core four runtime
containers were healthy. Dashboard login was verified HTTP 200 and protected
knowledge redirected HTTP 303 to login. These HTTP checks do not resolve the
health operation.

The bounded recent systemd journal sample contained six operations_job_pending
refusals. Existing host preflight therefore blocks further scheduled operations,
including backup/maintenance. No journal was cleared and no container absence
was interpreted as successful completion or rollback. The Phase 6 closeout
remains a bounded record of its earlier actual successful commands, not proof
of indefinitely reliable recurring execution.

The owner-authorized retirement affects only older test containers and excludes
the latest scope, its data and operation record. The record's fingerprint is
protected by the retirement before/after checks. Its diagnosis/disposition is
separate from old-container retirement.

AGY's existing synthetic health-transport stress assignment should investigate
this recurring boundary without SSH/shared-server commands, new resolvers,
forced retries or relaxed acknowledgement rules. Codex retains live read-only
diagnosis, corrective review and operational disposition. Keep external
execution flags false and preserve all current/old evidence.

## Read-only follow-up, 2026-11-04

The same saved health job remains uncertain and its physical actor is absent.
The record's device/inode/mtime and bytes matched before/after inspection.
A bounded last-250-entry health-service journal sample since November 3 contains
48 operations_job_pending refusals, with no memory-kill or timeout messages in
that sample. These are sampled observations, not a determination of the cause.

Docker's retained event history contains no create/start/die/destroy/kill events
for that actor within the bounded time window around the saved record. This
does not prove that the actor never ran or establish any SQL result; historical
events may no longer be retained. No job was retried, cleared or resolved, and
no service, container, permission, network or server file was changed.

Source corrections and synthetic stress verification in PRs #9–#11 are separate
from this current-server disposition. The additional promotion diagnosis in
PR #12 identifies an observability gap but does not establish the historical
promotion root cause. See `../../reviews/2026-11-04-pr-12-promotion-diagnosis-review.md`.

## Read-only follow-up, 2026-11-11

The protected latest-scope journal remains health/uncertain with its recorded
actor absent. Device/inode/mtime/size/content fingerprint is unchanged across
the read-only inspection. No settlement, clear, retry or outcome is inferred.
Webhooks, reply and PostgreSQL are running/healthy. The private admin container
is restarting/unhealthy; its last-60-line log sample contains 60 startup-failure
markers. Its socket exists with expected 1000:1000 ownership and mode 0600 but
refuses connections. No internal failure cause is inferred from that symptom.
No server resource, permission, file, timer, socket, network or other project
was changed. Current review: `../../reviews/2026-11-11-corrected-harness-review.md`.
