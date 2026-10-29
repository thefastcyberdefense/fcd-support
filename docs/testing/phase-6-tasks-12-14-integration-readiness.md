# Phase 6 Tasks 12–14 Integration Readiness

This document assesses local integration readiness for Phase 6 Tasks 12, 13, and 14
in `fcd-support`. It links each required interface and local integration behavior
to exact test files, test names, evidence types, and verified fail-closed contracts.
It explicitly identifies server-only evidence that remains pending subsequent
server drill execution by Codex.

This is a bounded integration readiness assessment, not the Task 15 whole-phase review
or a gate-completion decision.

---

## 1. Task 12: Revision-Pinned Host Timers & Scheduled Maintenance

### 1.1 Requirements and Local Coverage Matrix

| Interface / Behavior | Requirement & Contract | Existing Test File | Exact Test Name | Evidence Type | Status |
| --- | --- | --- | --- | --- | --- |
| **Revision Pinning** | `run-operation.sh` validates that `FCD_SUPPORT_REVISION` matches active selection `STATE_REVISION`. Mismatched or old revision pointer refuses before running scheduled jobs (`operations_schedule_not_ready`). | `tests/systemd-contract.test.ts` | `a ready pointer for an old revision and a substituted retained image refuse` | Script unit | **Covered** |
| **Lock Non-Overlap** | Scheduler acquires non-blocking deployment lock (`flock --nonblock`). Active lock conflict terminates immediately with `operations_lock_conflict`; prevents overlapping runs and replay loops. | `tests/systemd-contract.test.ts` | `lock conflicts and unavailable dependencies prevent later jobs or a replay loop` | Script unit | **Covered** |
| **Persistent Catch-up** | Host systemd units use `Persistent=true` for `backup` and `maintenance` (permits exactly one catch-up run after downtime without replay loop); `Persistent=false` for `health` (resumes current wall-clock time). | `tests/systemd-contract.test.ts` | `host units carry protected references, bounded resources and the deliberate operator Docker authority` | File static check | **Covered** |
| **Maintenance Dispatch** | `operations_scheduled_dispatch maintenance` executes `retention`, `deletion`, `lease_recovery`, and `learning` in the current slot. Repeated runs in the same slot generate identical deterministic references without interval replay. | `tests/systemd-contract.test.ts` | `scheduled %s uses shared preflight and the journal executor`<br>`repeated current-slot maintenance has the same references without replaying missed intervals` | Script unit | **Covered** |
| **Monthly Selection** | Monthly backup class is selected at most once per UTC calendar month; daily backup runs daily. | `tests/systemd-contract.test.ts`<br>`tests/operations-scheduled-job.test.ts` | `scheduled backup uses shared preflight and the journal executor`<br>`scheduled backup invokes daily and monthly runs` | Script unit | **Covered** |
| **Calendar Validation** | Systemd calendar strings (`FCD_BACKUP_CALENDAR`, `FCD_MAINTENANCE_CALENDAR`, `FCD_HEALTH_CALENDAR`) are verified with `systemd-analyze calendar -- <value>` via bounded argv before unit rendering. | `tests/systemd-contract.test.ts` | `renderer validates each calendar as exactly one bounded argv value` | Script unit | **Covered** |
| **Learning Service** | Proposal-only learning aggregates insights within complete time windows with stable `runRef` and `requestKey`. | `tests/integration/postgres-learning-service.test.ts` | Complete learning integration test suite | PostgreSQL integration | **Covered** |
| **Retention & Deletion** | Retention runs `runExpiredContentBatch`; deletion executes approved requests; lease recovery expires orphaned leases. | `tests/integration/postgres-retention-job.test.ts`<br>`tests/integration/postgres-runtime-maintenance.test.ts` | Complete maintenance integration test suites | PostgreSQL integration | **Covered** |

### 1.2 Pending Server-Level Evidence (Task 12)
- Execution of rendered units under actual host `systemd` daemon on the target Ubuntu server.
- Live verification of systemd timer triggers across actual host reboots.
- Host `journald` log forwarding verification.
- **Status:** Explicitly **PENDING** server drill execution by Codex.

---

## 2. Task 13: Health Collection & Private Operations Dashboard

### 2.1 Requirements and Local Coverage Matrix

| Interface / Behavior | Requirement & Contract | Existing Test File | Exact Test Name | Evidence Type | Status |
| --- | --- | --- | --- | --- | --- |
| **Database Outage Journaling** | When PostgreSQL is unreachable, `collectHealth` writes fixed content-free journal event (`event: 'operations_health'`, `state: 'unavailable'`, `component: 'postgres'`), updates outage gap, and redacts all secrets/URLs/queries. | `tests/health-collector.test.ts` | `database outage still writes only a fixed journal event` | TypeScript unit + mock sink | **Covered** |
| **Disabled-Service Status** | When external services (Manifest, n8n) are disabled, health reports `state: 'disabled'`, `reasonCode: 'disabled'`. Unverified components report `unknown` / `not_verified`. They never report `healthy`. | `tests/health-collector.test.ts` | `absence of host verification and disabled external paths never report healthy` | TypeScript unit | **Covered** |
| **Route Isolation** | Public webhook application (`src/app.ts`) never registers the `/operations` route; GET and POST `/operations` return 404. | `tests/admin-operations.test.ts` | `public app never acquires the private operations route` | Fastify in-memory HTTP | **Covered** |
| **Admin Route Authorization** | Private admin `/operations` requires active admin session (`fcd_admin_session`), valid CSRF cookie/header, and signed action token. Missing session redirects (303); invalid origin, CSRF, or action token returns 403/400. | `tests/admin-operations.test.ts`<br>`tests/integration/postgres-admin-operations.test.ts` | `operations route is private and empty dashboard has accessible mobile and desktop states`<br>`acknowledgement uses the existing signed action origin and csrf protections`<br>`expired revoked and wrong-role sessions cannot view or acknowledge operations` | Fastify in-memory HTTP;<br>PostgreSQL integration | **Covered** |
| **Incident Review & Acknowledge** | Dashboard renders component status, migration revision, backup status, and unacknowledged incidents. Incident acknowledgement updates `acknowledged_at` in the same database transaction. | `tests/admin-operations.test.ts`<br>`tests/integration/postgres-admin-operations.test.ts`<br>`tests/integration/postgres-admin-dashboard.test.ts` | `acknowledgement uses the existing signed action origin and csrf protections`<br>Complete admin operations integration suites | Fastify HTTP;<br>PostgreSQL integration | **Covered** |
| **Closed Diagnostics & No Leakage** | Malformed external display fields fail closed without appearing in UI or logs. Credentials, OTPs, customer text, and raw database errors never reach the dashboard. | `tests/admin-operations.test.ts` | `malformed external display fields fail closed without appearing in UI or log` | TypeScript unit | **Covered** |
| **Socket Preflight & Isolation** | Health collection role has no admin credentials or socket mount; admin socket resides in isolated 0700 directory. | `tests/integration/postgres-health-role.test.ts`<br>`tests/operations-live-socket-preflight.test.ts` | Complete health role grants suite;<br>Socket preflight suites | PostgreSQL integration;<br>Native script | **Covered** |

### 2.2 Pending Server-Level Evidence (Task 13)
- Live loopback SSH port-forwarding to the private Unix domain socket on the deployment host.
- Browser-based manual review of the `/operations` dashboard over SSH loopback forward.
- Live Cloudflare tunnel health container integration.
- **Status:** Explicitly **PENDING** server drill execution by Codex.

---

## 3. Task 14: Authenticated Idempotent Private n8n Notification Client

### 3.1 Requirements and Local Coverage Matrix

| Interface / Behavior | Requirement & Contract | Existing Test File | Exact Test Name | Evidence Type | Status |
| --- | --- | --- | --- | --- | --- |
| **Signed Notification Delivery** | Canonical 5-key JSON envelope (`schemaVersion: 1`, `type`, `reference`, `occurredAt`, `idempotencyKey`). HMAC-SHA256 signature calculated over `${timestamp}.${body}` in header `x-fcd-signature`. Timestamp in `x-fcd-timestamp`, idempotency key in `idempotency-key`. | `tests/n8n-client.test.ts` | `canonical UTF-8 envelope has only five keys and signs timestamp dot body` | TypeScript unit + mock fetch | **Covered** |
| **Idempotent Retry & Deduplication** | Lost acknowledgement or transport failure retries with the exact same idempotency key and payload; receiver deduplicates. Accepted notifications never receive a new idempotency key. | `tests/n8n-client.test.ts`<br>`tests/integration/postgres-notification-flow.test.ts` | `default socket transport delivers once across an acknowledgement loss`<br>`lost acknowledgement retries the same key without duplicate notification` | TypeScript unit + FakeN8nServer;<br>PostgreSQL integration | **Covered** |
| **Private Peer Isolation** | Rejects non-private origins, public IPs, loopback without synthetic mode, credentials in URLs, query strings, and HTTP redirects (`redirect: 'error'`). Response bounded before parse. | `tests/n8n-client.test.ts` | `test.each([ ... ]) rejects non-private or malformed origins`<br>`bounded response byte limit rejects oversized payload` | TypeScript unit | **Covered** |
| **Secret Redaction** | Signing secret wrapper prevents secret material from leaking in logs, stringification, or error inspect dumps. | `tests/n8n-client.test.ts` | `signing secret wrapper stays redacted when serialized or inspected` | TypeScript unit | **Covered** |
| **PostgreSQL Authority Preservation** | n8n outages cannot mutate consent, conversation, or privacy state. PostgreSQL is the authoritative state store. n8n possesses no database credentials and cannot issue state callbacks. | `tests/integration/postgres-notification-flow.test.ts` | `n8n outage cannot mutate consent or conversation authority` | PostgreSQL integration | **Covered** |
| **Erasure Before Delivery** | If an approved customer deletion or retention erasure request occurs before notification delivery, undelivered notification work is cancelled/erased. | `tests/integration/postgres-notification-flow.test.ts`<br>`tests/integration/postgres-notification-privacy-grants.test.ts` | `cancellation removes undelivered notification work upon approved deletion`<br>Complete notification privacy grants suites | PostgreSQL integration | **Covered** |

### 3.2 Pending Server-Level Evidence (Task 14)
- Live communication with production/staging n8n workflow (live n8n remains disabled during Phase 6 local validation; local tests utilize `FakeN8nServer`).
- Consumer runbook verification by the external n8n operator.
- **Status:** Explicitly **PENDING** external operator onboarding and Phase 7 execution.

---

## 4. Integration Readiness Conclusion

- **Local Integration State:** Tasks 12, 13, and 14 components are fully implemented, rigorously tested locally with hermetic fakes and real PostgreSQL test databases, and satisfy all security and architectural boundaries.
- **Boundary Adherence:**
  - PostgreSQL remains the authoritative state store.
  - Manifest and n8n receive no database credentials, no tools, and no public ingress.
  - Disabled services report `disabled` or `not_verified`, never `healthy`.
  - All fixtures are synthetically authored without customer data or live credentials.
- **Next Required Step:** Server-level drill and whole-phase review (Task 15 / P6-GATE) to be conducted by Codex on the dedicated test server.
