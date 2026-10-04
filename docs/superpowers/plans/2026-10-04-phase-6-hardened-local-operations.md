# Phase 6 Hardened Local Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> for sequential execution. Use superpowers:subagent-driven-development only
> when the owner explicitly selects that method. Steps use checkbox syntax.

**Goal:** Package and verify a private, recoverable Docker runtime for the
existing local Ubuntu server, with PostgreSQL authority and dashboard
operational visibility.

**Architecture:** Role-specific application processes run from one
revision-labelled image in a runtime Compose file. Separate operations and
restore files provide bounded jobs; host systemd timers invoke them without
container Docker access. Restore imports current deletion authority and
quarantines inherited external-effect work before promotion.

**Tech Stack:** Existing strict TypeScript, Node 24, npm, Fastify, pg,
node-pg-migrate, Zod, Vitest; Docker Compose on Linux, PostgreSQL 18, Bash,
systemd, and age X25519 encryption. Existing dependency and image pins remain
the baseline.

**Spec:** `docs/superpowers/specs/2026-09-21-phase-6-hardened-local-operations-design.md`

Date: 2026-10-04

Status: written specification approved; this implementation plan awaits owner
review. All tasks are unchecked. P6-002 through P6-006 remain blocked until
plan review is recorded. No task in this document has run.

## Global Constraints

- Windows remains the only source-authoring, commit, and push host.
- The server deploys only an exact clean Git revision pulled into
  `/home/redwan/apps/fcd-support`.
- The target host is the existing local Ubuntu server at `192.168.10.40`.
- PostgreSQL has no published port.
- Only exact `GET /webhooks/meta` and `POST /webhooks/meta` are public.
- The admin dashboard binds to `127.0.0.1` on the Ubuntu host.
- No privileged mode, Docker socket, device, host PID, host network, or broad
  host-filesystem mount.
- Production dependencies remain exact in `package-lock.json`; every base
  image is pinned by immutable digest.
- PostgreSQL remains authoritative; models receive no tools; use only
  `fcd-support` and `model: "auto"`.
- Missing operational values fail configuration validation; operational limits
  remain operator-configurable inside validated bounds.
- Validation enforces the approved minimum of 45 daily and 6 monthly archives.
- Plaintext dumps are never written to persistent storage.
- Deployment never runs an automatic down migration.
- Routine backup jobs never acquire the restore identity.
- Restored work must not blindly repeat an external effect.
- No direct Telegram, SMTP, pager, or external uptime adapter is added.
- n8n cannot acknowledge privacy work, change consent, resume AI, enqueue
  outbound messages, resolve delivery, or write authoritative state.
- Local tests use only synthetic data, guarded databases, and local fakes.
- Preserve the existing production WhatsApp account and all production assets.
- Commit and push each completed approved task; preserve unrelated work.
- Server mutation requires the exact committed runbook and immediate
  external-action approval recorded by `docs/PLAN.md`. The owner's requested
  destination is already established; do not ask for that destination again.

## Review Focus

1. A deletion committed after the chosen archive must still erase restored
   content; an old or incomplete checkpoint must refuse promotion (Task 10).
2. Restoring an old pending intent whose message was subsequently sent must
   make no provider call on restart (Tasks 10 and 15).
3. A worker batch crossing a service-window, lease, or retention deadline must
   evaluate each authorization using the current clock (Tasks 5 and 6).
4. File-backed Compose secrets keep host ownership; non-root readers must work
   with mode 0600 without making files world-readable (Tasks 1 and 7).
5. Admin origin/CSRF checks must continue to work through an SSH forward;
   another container's reachability must not grant reviewer authority (Tasks 6
   and 13).

## Execution And Dependency Map

Execute Tasks 1–16 in order. Tasks are one operational release, not independent
product features: recovery, runtime authority, health, and orchestration share
revision and schema contracts. Keep their implementation files small by
responsibility. A completed task produces local software/evidence; only Task
16 prepares an external deployment handoff.

| Tracker item        | Plan tasks      | Completion evidence                                                              |
| ------------------- | --------------- | -------------------------------------------------------------------------------- |
| P6-002              | 1–8             | Runtime commands, pinned images, Compose, hardening                              |
| P6-003              | 7–8             | Role/network/mount matrix and negative probes                                    |
| P6-004              | 9–12, 15        | Encryption, checkpoint, isolated restore, promotion, migration, rollback, timers |
| P6-005              | 2, 6, 12–13, 15 | Health history, private UI, journal fallback, injected failures                  |
| P6-006              | 3, 14–15        | PostgreSQL notification work, signed fake contract, outage isolation             |
| P6-GATE             | 15              | Full local validation and reviewed evidence                                      |
| Later server action | 16              | Exact revision runbook; deployment evidence recorded only after execution        |

## File Responsibilities

- `src/operations/secret-files.ts`: bounded file loading; no process logging.
- `src/operations/operations-types.ts`: shared closed metadata contracts.
- `src/operations/operations-config.ts`: role, resource, schedule and job bounds.
- `src/operations/privacy-keyring.ts`: decode the existing PrivacyHmacKeyring.
- `src/operations/worker-loop.ts`: polling, readiness, abort and drain.
- `src/operations/role-runtime.ts`: lifecycle interface; dependency selection.
- `src/operations/maintenance.ts`: bounded existing-policy job composition.
- `src/operations/backup.ts`: stream encryption, verification and safe pruning.
- `src/operations/deletion-checkpoint.ts`: encrypted signed current tombstones.
- `src/operations/restore.ts`: isolated reconciliation and inherited-work fence.
- `src/operations/health-collector.ts`: content-free checks and journal outcomes.
- `src/notifications/n8n-client.ts`: exact-origin authenticated HTTP contract.
- `src/persistence/postgres-operations-store.ts`: metadata, incidents, catalog.
- `src/persistence/postgres-processing-work.ts`: durable processing stages.
- `src/persistence/postgres-notification-work.ts`: notification claims/attempts.
- `src/persistence/postgres-restore-fence.ts`: atomic quarantine of restored work.
- `src/persistence/postgres-runtime-grants.ts`: explicit role/table privileges.
- `src/worker-main.ts`, `src/operations-main.ts`: thin command entrypoints.
- `infra/compose.runtime.yml`: normal runtime and role-specific mounts/networks.
- `infra/compose.operations.yml`: explicitly selected one-shot jobs.
- `infra/compose.restore.yml`: separate isolated restore project.
- `infra/compose.phase6-test.yml`: synthetic stack, fakes and probes.
- `infra/Dockerfile.operations`: pinned Node/PostgreSQL/age job image.
- `infra/operations-toolchain.json`: selected versions, digests and checksums.
- `scripts/operations-common.sh`: protected config, revision, lock and exit rules.
- `scripts/deploy-runtime.sh`, `scripts/verify-runtime.sh`,
  `scripts/rollback-runtime.sh`: release orchestration.
- `scripts/run-operation.sh`, `scripts/restore-runtime.sh`,
  `scripts/promote-restore.sh`: closed operator commands.
- `infra/systemd/`: templated units; generated validated calendar configuration.
- Existing admission-only Compose/scripts remain supported until the later
  approved server replacement; static tests distinguish both layouts.

## Shared Interfaces

Define these exports in Task 1/2 before consumers use them. Internal decimal
database IDs and UUID references are never external customer identifiers.

```ts
// src/operations/operations-types.ts
export type RuntimeRole =
  | 'webhook'
  | 'admin'
  | 'reply'
  | 'outbound'
  | 'notification'
  | 'maintenance'
  | 'health'
  | 'checkpoint'
  | 'migrate'
  | 'backup'
  | 'verify_backup'
  | 'restore';
export type ComponentCode =
  | 'webhook'
  | 'postgres'
  | 'reply'
  | 'outbound'
  | 'notification'
  | 'manifest'
  | 'n8n'
  | 'tunnel'
  | 'backup'
  | 'migration'
  | 'deletion_checkpoint';
export type HealthState = 'healthy' | 'degraded' | 'unavailable' | 'disabled' | 'unknown';
export interface HealthObservation {
  readonly component: ComponentCode;
  readonly state: HealthState;
  readonly reasonCode:
    | 'ok'
    | 'timeout'
    | 'dependency_unavailable'
    | 'not_verified'
    | 'disabled'
    | 'stale'
    | 'configuration_invalid'
    | 'collection_failed';
  readonly checkedAt: Date;
  readonly durationMilliseconds: number;
}
export interface JobSummary {
  readonly status: 'completed' | 'skipped' | 'failed';
  readonly processed: number;
  readonly reasonCode:
    | 'ok'
    | 'not_due'
    | 'disabled'
    | 'dependency_unavailable'
    | 'verification_failed'
    | 'configuration_invalid';
}
export interface RuntimeLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}
export type MaintenanceJob = 'retention' | 'deletion' | 'lease_recovery' | 'learning';
```

Use existing `PrivacyHmacKeyring`, `OutboundDeploymentBounds`,
`ModelDeploymentCeilings`, `LearningPolicy`, and existing result types;
do not invent alternate representations of their policy authority.

For persistence classes, follow the existing `TransactionSource` and
`withBoundedTransaction` patterns. No database transaction spans HTTP,
encryption, Docker execution, or a long wait.

### Task 1: Mounted secrets and validated role configuration

**Files:** Create `src/operations/secret-files.ts`,
`src/operations/operations-config.ts`, `src/operations/operations-types.ts`,
`src/operations/privacy-keyring.ts`,
`tests/secret-files.test.ts`, `tests/operations-config.test.ts`,
`tests/privacy-keyring.test.ts`. Modify `.env.example`.

**Consumes:** Existing config loaders and `PrivacyHmacKeyring`.
**Produces:**
`loadRoleEnvironment(role: RuntimeRole, environment: Readonly<Record<string, string | undefined>>, readSecret: (path: string) => Promise<Uint8Array>): Promise<Readonly<Record<string, string | undefined>>>`;
`loadOperationsConfig(role: RuntimeRole, environment: Readonly<Record<string, string | undefined>>): OperationsConfig`;
`loadPrivacyKeyring(bytes: Uint8Array): PrivacyHmacKeyring`.
Export `OperationsConfig` from operations-config with role, pollMilliseconds,
batchSize, leaseMilliseconds, shutdownGraceMilliseconds, healthStaleMilliseconds,
dailyRetention, monthlyRetention, backupCalendar, maintenanceCalendar and
resourceLimits (per-role cpus, memoryMiB, pids and tmpfsMiB). Validate positive
finite CPU <= observed host capacity, integer memory/PIDs/tmpfs and supplied
minimum/maximum deployment bounds; no absent bound gets an enabling default.

- [ ] **Step 1: Add RED assertions** using only authored sentinels.

```ts
test('rejects conflicting secret sources without echoing either value', async () => {
  await expect(
    loadRoleEnvironment(
      'webhook',
      {
        META_APP_SECRET: 'synthetic_conflicting_secret',
        META_APP_SECRET_FILE: '/run/secrets/meta_app_secret',
      },
      async () => new TextEncoder().encode('synthetic_file_secret'),
    ),
  ).rejects.toThrow('secret_source_conflict');
});
test('enforces approved backup minimums', () => {
  expect(() =>
    loadOperationsConfig('backup', {
      BACKUP_DAILY_RETENTION: '44',
      BACKUP_MONTHLY_RETENTION: '6',
    }),
  ).toThrow('configuration_invalid');
});
```

Also test absent/empty/>65536-byte/malformed UTF-8/symlink secret; remove only
one terminal LF or CRLF, reject embedded newline for scalar secrets. Keyring
JSON is strict `{activeVersion, keys:[{version,keyBase64url}]}`; require unique
versions, 32-byte keys, active version present. Serialize/inspect only redacted
wrappers. Linux permission checks reject 0644 and inaccessible 0600 files.
A correctly owned 0600 file must work under the actual service UID.

- [ ] **Step 2:** Run `npx vitest run tests/secret-files.test.ts tests/operations-config.test.ts tests/privacy-keyring.test.ts`.
      Expect missing modules/exports or failed new assertions.
- [ ] **Step 3:** Implement the interfaces and role allowlists. Production
      requires *_FILE for every secret; adapt values in memory into existing loaders.
      Do not assign revealed values to process.env. Webhook needs DB, app secret,
      verify token and privacy keys; admin needs DB/session/MFA; outbound adds channel
      tokens; reply adds Manifest only when enabled; notification adds n8n only when
      enabled. Reject irrelevant mounted credentials and conflicting sources.
- [ ] **Step 4:** Require explicit execution settings:
      `MODEL_EXECUTION_ENABLED`, `OUTBOUND_EXECUTION_ENABLED`,
      `N8N_EXECUTION_ENABLED` are closed true/false values; examples are false.
      Require poll/batch/lease/grace/health/resource/calendar values and reuse existing
      policy bounds. Backup counts: daily 45–3650, monthly 6–120. Generic poll 100–60000
      ms, job batch 1–1000, grace 0–300000 ms; configured grace/stop period must exceed
      the role's bounded call lifetime. Calendar expressions are validated with
      systemd-analyze in Task 12; never shell-evaluate configuration.
- [ ] **Step 5:** Run focused tests, `npm run typecheck` and `npm run lint`.
      Expect all pass and errors contain only closed setting names/reasons.
- [ ] **Step 6:** Stage only listed files; commit
      `feat: add role scoped mounted secret configuration`; push `origin main`.

### Task 2: Content-free operations persistence and incident transitions

**Files:** Create `migrations/000013_create_operations_state.ts`,
`src/persistence/postgres-operations-store.ts`,
`tests/integration/postgres-operations-store.test.ts`,
`tests/integration/phase6-operations-fixtures.ts`.
Modify `tests/integration/migrations.test.ts`.

**Consumes:** HealthObservation, bounded transactions.
**Produces:** `PostgresOperationsStore(pool: TransactionSource)` with
`recordHealth(observation: HealthObservation): Promise<void>`,
`listHealth(evaluatedAt: Date, staleMilliseconds: number): Promise<readonly HealthObservation[]>`,
`acknowledgeIncident(input: {incidentRef:string; requestKey:string; acknowledgedAt:Date}, actor: AdminActor): Promise<void>`,
`recordBackup(input: BackupCatalogInput): Promise<void>`,
`recordDeployment(input: DeploymentEvidenceInput): Promise<void>`.
Define BackupCatalogInput with backupRef, class (daily/monthly/pre_migration),
createdAt, gitRevision, schemaRevision, ciphertextBytes, ciphertextSha256,
state (created/verified/restore_verified/pruned/failed); deployment input has
revision, schema, time and closed status only. Define `Phase6OperationsFixture`
helper with an isolated database, synthetic administrator/session, an operations
store, and `dispose()`; create through existing createIsolatedTestDatabase.

- [ ] **Step 1: Add RED schema and transition tests.**

```ts
test('opens one incident, preserves acknowledgement, resolves on recovery', async () => {
  await store.recordHealth({
    component: 'postgres',
    state: 'unavailable',
    reasonCode: 'dependency_unavailable',
    checkedAt: at,
    durationMilliseconds: 10,
  });
  await store.recordHealth({
    component: 'postgres',
    state: 'unavailable',
    reasonCode: 'dependency_unavailable',
    checkedAt: new Date(at.getTime() + 1000),
    durationMilliseconds: 12,
  });
  expect(
    await db.pool.query(
      'select count(*)::int as n from operations_incidents where resolved_at is null',
    ),
  ).toMatchObject({ rows: [{ n: 1 }] });
});
```

Tests define store/db from Phase6OperationsFixture and fixed synthetic `at`.
Cover concurrent repeated checks, out-of-order checks, stale healthy result
projected unknown, unauthenticated/wrong-role acknowledgement, exact/conflicting
replay, no raw-text/URL/identity columns, append-only audit, populated downgrade
refusal and rollback.

- [ ] **Step 2:** Run `npm run test:integration -- tests/integration/postgres-operations-store.test.ts tests/integration/migrations.test.ts`
      inside the guarded synthetic test database. Expect RED.
- [ ] **Step 3:** Create closed operations_health_checks,
      operations_incidents, operations_incident_events, operations_backups,
      operations_backup_events, operations_deployments, operations_restore_runs.
      Use unique open component incident, immutable evidence plus current projections.
      Backup catalog has no dump/key columns. Limit result pages by supplied list
      limit; timestamp ordering cannot clear a newer failure. Authorize AdminActor
      in the same transaction as acknowledgement.
- [ ] **Step 4:** Test up/down/reapply, concurrency, trigger and atomic rollback;
      run focused integration and strict typecheck. Expect PASS.
- [ ] **Step 5:** Commit `feat: persist private operational health and recovery evidence`; push.

### Task 3: Durable processing stages and notification leases

**Files:** Create `migrations/000014_create_runtime_work.ts`,
`src/persistence/postgres-processing-work.ts`,
`src/persistence/postgres-notification-work.ts`,
`src/notifications/notification-types.ts`,
`tests/integration/postgres-processing-work.test.ts`,
`tests/integration/postgres-notification-work.test.ts`.
Modify `tests/integration/migrations.test.ts`.

**Consumes:** Existing receipts, event applications, drafts, privacy notification
intents, support/outbound escalations.
**Produces:** `PostgresProcessingWork(pool: TransactionSource)`:
`reconcile(limit:number, evaluatedAt:Date): Promise<{created:number}>`,
`claim(input:{workerRef:string; evaluatedAt:Date; limit:number; leaseMilliseconds:number}): Promise<readonly ProcessingClaim[]>`,
`finish(input:{workRef:string; leaseRef:string; evaluatedAt:Date; outcome:'completed'|'blocked'|'failed'}): Promise<void>`.
ProcessingClaim has workRef, webhookEventId, leaseRef and stage
(apply/decide/model/enqueue). Stage transitions use
`advance(input:{workRef:string; leaseRef:string; stage:ProcessingClaim['stage']; evaluatedAt:Date}): Promise<void>`.
Notification store exports
`claim(input:{workerRef:string; evaluatedAt:Date; limit:number; leaseMilliseconds:number}): Promise<readonly NotificationClaim[]>`,
`finish(input:{workRef:string; leaseRef:string; evaluatedAt:Date; result:N8nResult}): Promise<void>`,
`expire(input:{evaluatedAt:Date; limit:number}): Promise<{expired:number}>`.
NotificationClaim contains workRef, leaseRef, attemptNumber and the strict
NotificationEnvelope specified in Task 14; define that envelope and N8nResult
in notification-types during this task so later consumers import them.
N8nResult contains status accepted/retryable/terminal_failed and reasonCode
ok/timeout/transport_failure/invalid_response/authentication_failed/
destination_rejected/retry_exhausted. No customer content enters either work table.

- [ ] **Step 1: Add RED tests** for unique source reconciliation, concurrent
      SKIP LOCKED claims, expiry/wrong-owner refusal, incomplete stage retry after
      restart, exact/conflicting replay, and foreign-source rejection.

```ts
test('reconciliation repairs a crash after event application', async () => {
  await processor.processEvent(eventId);
  expect(await work.reconcile(10, at)).toEqual({ created: 1 });
  expect(await work.reconcile(10, at)).toEqual({ created: 0 });
  expect(
    await work.claim({
      workerRef: 'synthetic_worker',
      evaluatedAt: at,
      limit: 10,
      leaseMilliseconds: 1000,
    }),
  ).toHaveLength(1);
});
```

Use existing policy-fixtures to create a fully synthetic admitted event;
instantiate processor/work on the isolated test pool. Cover notification
sources opened during n8n outage, unique source keys and expiry.

- [ ] **Step 2:** Run the two new integration files and migration tests; expect RED.
- [ ] **Step 3:** Implement closed runtime_processing_work and
      notification_delivery_work/notification_delivery_attempts. Reconcile source
      rows transactionally with unique parent/source IDs. Existing
      privacy_notification_intents retain their business authority; new delivery
      rows reference them and existing escalation parents without copying content.
      Claims use current time, bounded leases and SKIP LOCKED. Stage advance commits
      separately from domain service operations; replay repairs any crash gap.
- [ ] **Step 4:** Apply inherited-work recovery-fence compatibility:
      a quarantined source is excluded from reconciliation and claims. Do not delete
      evidence to resurrect a task. Run focused tests/typecheck; expect PASS.
- [ ] **Step 5:** Commit `feat: add durable runtime and notification work leases`; push.

### Task 4: Shared worker lifecycle and runtime readiness

**Files:** Create `src/operations/worker-loop.ts`,
`src/operations/role-runtime.ts`,
`src/operations/runtime-readiness.ts`,
`tests/worker-loop.test.ts`, `tests/runtime-readiness.test.ts`.

**Consumes:** RuntimeLifecycle, OperationsConfig.
**Produces:**

```ts
export function createWorkerLoop(options: {
  readonly runBatch: (signal: AbortSignal) => Promise<void>;
  readonly isReady: () => Promise<boolean>;
  readonly pollMilliseconds: number;
  readonly shutdownGraceMilliseconds: number;
  readonly now: () => Date;
}): RuntimeLifecycle;
export function checkRuntimeReadiness(
  input: {
    readonly role: RuntimeRole;
    readonly revision: string;
    readonly expectedSchemaRevision: string;
    readonly externalExecutionEnabled: boolean;
  },
  dependencies: RuntimeReadinessPorts,
): Promise<HealthObservation>;
```

Define RuntimeReadinessPorts in runtime-readiness with
`readSchemaRevision(): Promise<string>`,
`readDeployedRevision(): Promise<string>`,
`hasRequiredPolicy(role: RuntimeRole, evaluatedAt: Date): Promise<boolean>` and
`checkPrivateDependency(role: RuntimeRole): Promise<HealthState>`.
No probe sends a model/provider request.

- [ ] **Step 1: Add RED assertions** with fake timers and injected stubs.

```ts
test('stop prevents new batches and aborts after supplied grace', async () => {
  let calls = 0;
  const loop = createWorkerLoop({
    runBatch: async (signal) => {
      calls++;
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
    isReady: async () => true,
    pollMilliseconds: 100,
    shutdownGraceMilliseconds: 500,
    now: () => new Date(0),
  });
  await loop.start();
  const stopped = loop.stop();
  await vi.advanceTimersByTimeAsync(500);
  await stopped;
  expect(calls).toBe(1);
});
```

Cover repeated start/stop, failed readiness, pool outage, no overlapping batch,
never-settling callback deadline, stale heartbeat and schema mismatch.

- [ ] **Step 2:** Run focused unit files; expect RED.
- [ ] **Step 3:** Implement bounded lifecycle, single batch at a time, immediate
      claim stop, bounded drain then abort. Heartbeat is aggregate metadata in tmpfs;
      Docker health reads only fixed state/time. Model-disabled reply runtime may
      continue FAQ and safe escalation; outbound/n8n execution remains idle when
      disabled. Missing core schema or DB closes readiness. Required active policy
      is checked at use time as well as startup.
- [ ] **Step 4:** Run unit tests, lint/typecheck; expect PASS.
- [ ] **Step 5:** Commit `feat: add bounded worker lifecycle and readiness`; push.

### Task 5: Reply pipeline daemon and restart repair

**Files:** Create `src/operations/reply-runtime.ts`,
`src/operations/reply-pipeline.ts`, `src/worker-main.ts`,
`tests/reply-runtime.test.ts`,
`tests/integration/postgres-runtime-reply-flow.test.ts`.
Modify `src/logging.ts` only for enumerated lifecycle events.

**Consumes:** Tasks 1–4; existing PostgresConversationEventProcessor,
ReplyDecisionService, ModelReplyService, PostgresReplyDraftStore,
PostgresFaqResolver, PostgresModelPolicy, PostgresModelAllowance and
PostgresOutboundIntentStore.
**Produces:**
`createReplyRuntime(options: RoleRuntimeOptions): Promise<RuntimeLifecycle>`.
Define RoleRuntimeOptions in role-runtime: role, environment, logger, now,
optional poolFactory and injected test-only HTTP transports.
`runReplyStage(claim: ProcessingClaim, dependencies: ReplyPipelinePorts): Promise<'advanced'|'completed'|'blocked'>`;
Define ReplyPipelinePorts with processor
`Pick<PostgresConversationEventProcessor, 'processEvent'>`, decision
`ReplyDecisionService`, model `ModelReplyService | undefined`, intent
`Pick<PostgresOutboundIntentStore, 'createSupportIntent'>`, work
`PostgresProcessingWork` and now `() => Date`.

- [ ] **Step 1: Add RED crash and policy assertions.**

```ts
test('repairs a crash after creating a draft without another model call', async () => {
  await fixture.runThrough('draft_persisted');
  await fixture.restart();
  expect(await fixture.count('outbound_intents')).toBe(1);
  expect(fixture.manifestCalls()).toBe(1);
});
test('model disabled keeps approved FAQ resolution available', async () => {
  await fixture.disableModel();
  await fixture.applySyntheticFaqQuestion('bn');
  expect(fixture.manifestCalls()).toBe(0);
  expect(await fixture.readyDraftLanguages()).toEqual(['bn']);
});
```

Create `RuntimeReplyFixture` in the integration file, using existing policy
fixtures, authored FAQ catalog and injected fake-manifest-server; methods above
operate on internal rows/counts and never expose payloads. Cover restart after
receipt, application, FAQ decision, model completion and intent insertion;
parallel workers; echo/status events never produce replies; missing model policy
produces safe escalation; late deletion/pause and quarantine prevent dispatch.

- [ ] **Step 2:** Run reply-runtime unit and runtime-reply integration files;
      expect RED.
- [ ] **Step 3:** Implement daemon stages using stable per-event request keys,
      current clock per transition and existing issued-text/model provenance.
      Select language deterministically: Bangla script present selects bn, otherwise
      en; use existing reviewed corpus to test both. Load source text only in memory
      under the existing source guards. Repair incomplete work by inspecting durable
      domain outcomes; never repeat a completed model call.
- [ ] **Step 4:** At apply stage route exact deterministic privacy/consent
      commands through existing Phase 3 intake before ordinary reply creation.
      Add stable gap observations only for authoritative FAQ miss/ambiguity, using
      existing closed gap summaries and source retention deadline. No generated
      customer summary is persisted. Model/FAQ completion may produce one ready
      draft; enqueue through createSupportIntent with exact draftRef and stable key.
      Never assume processing-event completion means reply completion.
- [ ] **Step 5:** Extend worker-main to choose only a closed role and install
      SIGTERM/SIGINT handlers. Close pools after bounded drain. Run focused
      unit/integration/typecheck; expect PASS.
- [ ] **Step 6:** Commit `feat: run recoverable faq first reply processing`; push.

### Task 6: Outbound, admission, admin and maintenance runtime commands

**Files:** Create `src/operations/outbound-runtime.ts`,
`src/operations/maintenance.ts`, `src/operations-main.ts`,
`tests/outbound-runtime.test.ts`, `tests/maintenance.test.ts`,
`tests/integration/postgres-runtime-maintenance.test.ts`.
Modify `src/main.ts`, `src/runtime.ts`, `src/admin-main.ts`,
`src/admin/admin-config.ts`, `src/admin/admin-runtime.ts`,
`src/outbound/outbound-worker.ts`, `tests/outbound-worker.test.ts`,
`tests/admin-config.test.ts`, `tests/admin-runtime.test.ts`, `package.json`.

**Consumes:** Existing OutboundWorker/MetaOutboundClient/WorkStore,
RetentionJob, ModelAllowance and LearningService.
**Produces:** `createOutboundRuntime(options: RoleRuntimeOptions): Promise<RuntimeLifecycle>`;
`runMaintenance(job: MaintenanceJob, options: MaintenanceOptions): Promise<JobSummary>`.
MaintenanceOptions has pool, keyring, supplied learning/outbound bounds, now,
limit and stable runRef. All scheduled jobs use this interface.

- [ ] **Step 1: Add RED runtime assertions.**

```ts
test('samples time again before the second authorization in a slow batch', async () => {
  const result = await clockFixture.runAcrossServiceWindow();
  expect(result.accepted).toBe(1);
  expect(clockFixture.providerCalls()).toBe(1);
  expect(clockFixture.deniedReasons()).toContain('window_closed');
});
test('container admin mode preserves the operator browser origin', () => {
  const config = loadAdminConfig(containerAdminEnvironment);
  expect(config.host).toBe('0.0.0.0');
  expect(config.origin).toBe('http://127.0.0.1:3004');
});
```

Define the clock fixture from existing outbound worker fakes with advancing
now; containerAdminEnvironment uses synthetic keys and explicit
ADMIN_LISTEN_MODE=container_private. Default/local mode still rejects
0.0.0.0; container mode only accepts a loopback HTTP browser origin/approved
port and cannot change CSRF rules. Test equivalent origin through SSH forward,
host-origin mismatch, private authentication, disabled outbound (zero claims),
SIGTERM during call, missing keyring and malformed job names.

- [ ] **Step 2:** Run targeted runtime/admin/outbound tests plus maintenance
      integration; expect RED.
- [ ] **Step 3:** Add optional injected `now: () => Date` to OutboundWorkerOptions
      and sample it immediately before authorization, dispatch-start and result
      persistence. Keep old deterministic tests compatible by explicitly injecting
      their fixed clock. Instantiate the existing request builders/client; no
      alternate sender or retry loop.
- [ ] **Step 4:** Wire file loading/keyring into webhook runtime so receipt
      persistence no longer depends on an absent injected keyring. Add graceful API
      shutdown. Add explicit container-private admin listening mode with
      127.0.0.1 host publication enforced in Task 8. Commands:
      `start:reply`, `start:outbound`, `start:notification`, `ops` use built
      entrypoints with closed argument parsing.
- [ ] **Step 5:** Implement maintenance: bounded retention; execute only already
      reviewed verified-deletion requests using the existing deletion service; lease
      expiry through existing model/outbound repositories; learning aggregation and
      digest under existing cadence/group bounds. The service principal may execute
      an approved request but cannot approve, bypass review or mark external privacy
      locations complete. Use stable time-slot run keys; repeat is idempotent.
- [ ] **Step 6:** Run focused regression/integration and `npm run check`;
      expect PASS; commit `feat: package private runtime and maintenance commands`;
      push.

### Task 7: Pinned hardened images and mounted-secret ownership

**Files:** Modify `Dockerfile`, `Dockerfile.cloudflared`, `.dockerignore`.
Create `infra/Dockerfile.operations`, `infra/Dockerfile.postgres`,
`infra/operations-toolchain.json`, `tests/phase6-image-contract.test.ts`,
`scripts/verify-image-contract.sh`.

**Consumes:** Runtime and operations commands from Tasks 1–6.
**Produces:** revision-labelled app, PostgreSQL and operations images;
operations image contains Node, PostgreSQL 18 client tools and age 1.3.2.
Toolchain manifest lists platform, source URL, release SHA256 and image
digest selected from official publisher artifacts.

- [ ] **Step 1: Add RED structural checks.**

```ts
test('separates restore identity from the backup image contract', () => {
  const image = readFileSync('infra/Dockerfile.operations', 'utf8');
  expect(image).toContain('USER node');
  expect(image).not.toContain('COPY secrets');
  expect(image).not.toContain('ARG BACKUP_ENCRYPTION_PASSWORD');
  expect(image).toContain('org.opencontainers.image.revision');
});
```

Test exact digest grammar, lockfile-only dependency installation, no source
secrets/build args, image-owned writable paths, base variant compatibility,
cloudflared immutable digest and no floating-tag substitution.

- [ ] **Step 2:** Run `npx vitest run tests/phase6-image-contract.test.ts`;
      expect RED.
- [ ] **Step 3:** Keep existing Node and PostgreSQL digest pins unless a publisher
      artifact/platform test proves a needed change; any change updates the toolchain
      decision and existing contract assertions. Obtain official age 1.3.2 Linux
      artifact/checksum during this implementation task, record the checksum and
      verify it before extraction. Never resolve latest during a deployment.
      Use multistage builds; verify copied Node binary shared libraries in the
      PostgreSQL-based operations stage. No apt installation occurs at startup.
- [ ] **Step 4:** In image build layers, initialize PostgreSQL data directories
      owned by postgres and archive/tmpfs seed directories owned by node. New named
      volumes inherit those owners; runtime never needs root chown. Fail if a
      pre-existing volume has incompatible ownership. Non-root UID can read only its
      specifically mounted 0600 secrets; file-backed Compose UID remapping is not
      assumed. Host provisioning creates separate service-owned secret files.
- [ ] **Step 5:** Build only isolated local test tags; inspect selected fields
      (user, labels, filesystem, capabilities) and smoke-test every entrypoint,
      pg_dump/pg_restore/age version and 0600 mount. Output booleans/versions only.
      Run tests/typecheck/build; expect PASS.
- [ ] **Step 6:** Commit `build: pin hardened application and operations images`; push.

### Task 8: Layered Compose and measured network boundaries

**Files:** Create `infra/compose.runtime.yml`,
`infra/compose.operations.yml`, `infra/compose.restore.yml`,
`infra/compose.phase6-test.yml`, `tests/phase6-compose-contract.test.ts`,
`scripts/verify-network-contract.sh`, `scripts/test-phase6-local.sh`.
Modify `tests/deployment-contract.test.ts` to preserve the legacy contract.

**Consumes:** Role commands/images, secret paths and runtime settings.
**Produces:** runtime, explicitly invoked operations, isolated restore and
synthetic Compose projects; content-free probe report.

- [ ] **Step 1: Add RED configuration checks.**

```ts
test('publishes only admin loopback and excludes provider credentials from ingress', () => {
  const compose = readFileSync('infra/compose.runtime.yml', 'utf8');
  expect(compose).toContain('127.0.0.1:');
  expect(compose).not.toContain('/var/run/docker.sock');
  expect(compose).not.toContain('network_mode: host');
  expect(compose).not.toMatch(/META_WHATSAPP_ACCESS_TOKEN:\s*\$\{/u);
});
```

Static checks supplement a structured `docker compose config --format json`
inspection; exact mounts/network sets/port bindings are evaluated as data.
Cover missing secret, externally named network absent, unexpected participant,
conflicting bind, wrong label, resource omission and profile auto-start.

- [ ] **Step 2:** Run compose-contract tests; expect RED.
- [ ] **Step 3:** Compose service names remain
      fcd-support-api, fcd-support-admin, fcd-support-reply,
      fcd-support-outbound, fcd-support-notification and postgres. Preserve the
      fcd-support-api alias on ingress so existing tunnel target does not change.
      Use profile-gated external execution and required explicit booleans.
      Set user, read_only, cap_drop ALL, no-new-privileges, init, PID limits,
      cpus/mem_limit, healthcheck and stop_grace_period. No secret appears as an
      environment value or command argument. No unrelated bind mounts.
- [ ] **Step 4:** Add operations profiles for migrate, backup, verify-backup,
      checkpoint, health, maintenance. Restore is a separate project/network with
      an explicit fresh volume name, never merged with runtime data-network
      attachments. Admin TCP binds inside its container only in explicit private
      mode and host publication is exactly 127.0.0.1.
- [ ] **Step 5:** Network tests must prove:
      API→PostgreSQL allowed; API→Manifest/Meta/n8n denied; reply→PostgreSQL/Manifest
      allowed; outbound→PostgreSQL/exact Meta fake allowed; notification→PostgreSQL/
      n8n fake allowed; every worker→ingress denied; restore→runtime denied; admin
      unreachable from ingress; all unintended host ports absent.
      Docker shared-network membership permits communication to other members:
      inspect existing external model/notification networks read-only at the later
      server preflight and refuse an over-broad network; do not claim Compose names
      alone enforce per-destination firewall rules. Live network changes require
      their explicit later action scope.
- [ ] **Step 6:** Run isolated local Compose rendering/up/probes/down. Harness
      uses only `fcd-support-phase6-test-<generated>` labels/networks/volumes and
      guarded fcd_support_test DB. Verify every cleanup target belongs to that exact
      project; preserve failed stacks unless cleanup targets have been checked.
      Run focused tests; commit `build: isolate runtime and recovery compose networks`;
      push.

### Task 9: Encrypted backup, verification and retention

**Files:** Create `src/operations/backup.ts`,
`src/operations/backup-retention.ts`,
`tests/backup.test.ts`, `tests/backup-retention.test.ts`,
`tests/integration/postgres-encrypted-backup.test.ts`.
Modify `src/operations-main.ts`, `.gitignore`.

**Consumes:** OperationsConfig, catalog store, pinned operations image.
**Produces:** `createEncryptedBackup(options: BackupOptions): Promise<BackupManifest>`;
`verifyEncryptedBackup(options: VerifyBackupOptions): Promise<{status:'verified'}>`;
`selectBackupPruneCandidates(manifests: readonly BackupManifest[], policy: {daily:number;monthly:number}, evaluatedAt:Date): readonly string[]`.
Define BackupOptions: pg connection loaded from file, recipientFile,
archiveDirectory, gitRevision, schemaRevision, backupClass, now, child-process
port. VerifyBackupOptions adds identityFile and expectedManifest.
BackupManifest: opaque backupRef, createdAt, class, git/schema revision,
ciphertextBytes, ciphertextSha256, verification state and manifest signature.

- [ ] **Step 1: Add RED integrity and retention tests.**

```ts
test('cannot prune below approved independent archive classes', () => {
  const manifests = authoredBackupManifests({ daily: 46, monthly: 7 });
  const prune = selectBackupPruneCandidates(manifests, { daily: 45, monthly: 6 }, at);
  expect(prune).toHaveLength(2);
  expect(prune).not.toContain(manifests.find((m) => m.state === 'restore_verified')!.backupRef);
});
test('backup job requires no decrypt identity', async () => {
  const report = await backupFixture.createWithoutIdentity();
  expect(report.status).toBe('created');
  expect(backupFixture.identityMounts()).toBe(0);
  expect(backupFixture.persistentPlaintextFiles()).toBe(0);
});
```

Define authoredBackupManifests locally from synthetic dates/refs; fixture uses
Task 8 synthetic volume and real operations binaries. Cover 44/5 rejection,
month boundaries (calendar month UTC), missing/failed latest archive, partial
pipeline failure, ENOSPC, readonly path, path traversal/symlink, corruption,
wrong key, changed signed manifest and interrupted rename.

- [ ] **Step 2:** Run unit files and encrypted-backup integration in isolated
      Docker; expect RED.
- [ ] **Step 3:** Implement spawn with argument arrays and pipelines:
      pg_dump --format=custom --no-owner --no-acl → age --encrypt --recipients-file.
      Use PGPASSFILE mounted or generated only in protected tmpfs; secret URLs never
      appear in child args. Pipeline status checks every child, bounded stderr is
      discarded, ciphertext staged with exclusive creation and fsync/atomic rename.
      Manifest signature uses mounted RECOVERY_MANIFEST_HMAC_FILE; no plaintext,
      SQL listing or content hash is emitted to evidence.
- [ ] **Step 4:** Verification is a separate identity-mounted one-shot profile:
      age --decrypt --identity → pg_restore --list with its listing sent to a sink.
      Successful decrypt/list is structural verification, not a full restore claim.
      Only isolated full restore adds restore_verified. Routine backup stores
      created/integrity-checked metadata and never mounts the identity.
      Support bootstrap before operations tables exist: signed archive manifest is
      created first; register it in PostgreSQL after migration. Missing P6 tables
      never excuse a missing pre-migration archive.
- [ ] **Step 5:** Prune only a closed validated archive reference list inside
      the resolved dedicated archive directory. Preserve separate daily/monthly
      minimums and the last full-restore-verified archive; pre_migration archives
      cannot silently count toward both quotas. Back up on schedule only; no
      per-startup archive. Suppress duplicate scheduled slot by PostgreSQL and
      host flock. Add ignored encrypted archive, age identity and checkpoint patterns.
- [ ] **Step 6:** Run focused tests/typecheck plus actual encrypt/decrypt/list
      of synthetic DB; expect PASS; commit `feat: encrypt verify and retain database backups`;
      push.

### Task 10: Current deletion checkpoints and inherited-work fence

**Files:** Create `src/operations/deletion-checkpoint.ts`,
`src/persistence/postgres-restore-fence.ts`,
`migrations/000015_create_restore_safety.ts`,
`tests/deletion-checkpoint.test.ts`,
`tests/integration/postgres-restore-fence.test.ts`.
Modify `src/operations/operations-types.ts`,
`src/outbound/outbound-types.ts`, `src/outbound/outbound-eligibility.ts`,
`src/persistence/postgres-outbound-privacy.ts`, and migration-cycle tests.
Extend old closed constraints only through migration 000015; never rewrite
previous released migration content.

**Consumes:** Current source privacy_suppressions with category=deletion_tombstone,
key versions,
backup encryption/signature ports, work/outbound/model history.
**Produces:** `exportDeletionCheckpoint(options: CheckpointExportOptions): Promise<CheckpointManifest>`;
`importDeletionCheckpoint(options: CheckpointImportOptions): Promise<{imported:number}>`;
`PostgresRestoreFence(pool: TransactionSource).quarantine(input:{restoreRef:string; evaluatedAt:Date}): Promise<{quarantined:number}>`.
CheckpointExportOptions contains sourcePool, recipientFile, signingKey,
archiveDirectory, sourceRevision, schemaRevision and now;
CheckpointImportOptions contains targetPool, archiveFile, identityFile,
signingKey and expectedManifest. Signing keys use an existing secret-byte
wrapper, never a printable string.
CheckpointManifest has opaque checkpointRef, source revision, schema,
snapshot time, watermark, rowCount, requiredKeyVersions, ciphertext digest and
signature; tombstone payload is encrypted and never logged. Export/import
options hold the source/target pools, encryption files, archive directory and
expected current completeness watermark. Exclude restored pending work from new
reconciliation by the migration 000015 quarantine table; Task 3 adds only a
conditional compatibility check until that table exists.

- [ ] **Step 1: Add RED post-archive deletion and resend assertions.**

```ts
test('imports a deletion newer than the selected archive', async () => {
  await fixture.archiveBeforeDeletion();
  await fixture.deleteSubjectOnSource();
  await fixture.restoreOldArchive();
  await fixture.importCurrentCheckpoint();
  await fixture.reapplyDeletion();
  expect(await fixture.restoredSubjectContentCount()).toBe(0);
});
test('inherited pending provider work cannot run after restore', async () => {
  await fixture.archivePendingIntent();
  await fixture.acceptOnSource();
  await fixture.restoreOldArchive();
  await fixture.quarantine();
  await fixture.restartWorkers();
  expect(fixture.providerCallsAfterRestore()).toBe(0);
});
```

RestoreFenceFixture owns distinct source/target guarded test databases, fixed
synthetic subjects and provider fake; archive state is produced from blank
synthetic fixtures. Test stale/missing/forged checkpoint, row count mismatch,
key-version mismatch, source changes after checkpoint, replay, notification
ambiguity, pending model work, and newly admitted events blocked until recovery
review completes.

- [ ] **Step 2:** Run checkpoint unit and restore-fence integration; expect RED.
- [ ] **Step 3:** Export exact unexpired tombstones from current authoritative
      PostgreSQL under a consistent snapshot and source-write freeze during promotion.
      Never trust the archive's tombstones as the complete deletion set. Encrypt
      minimal tombstone records plus signed manifest; use durable snapshot sequence
      and required key set as completeness material. Routine maintenance exports
      new checkpoints; failures create a dashboard incident. Signed/encrypted
      checkpoint archives are ignored runtime data, not fixtures or evidence.
- [ ] **Step 4:** Import checkpoint transactionally into isolated target,
      validate every field/version/count and bind restore evidence to its manifest.
      If source is down and latest complete independently preserved checkpoint
      cannot be proven, refuse promotion. A recently dated file alone is not proof.
      Do not drop tombstones merely because a previously used key rotated.
- [ ] **Step 5:** Add runtime_restore_quarantine with internal source IDs,
      restoreRef and reason only. Atomically fence inherited admitted events,
      processing/model work, drafts, outbound work and notification deliveries.
      P5 inherited pending/leased/authorized work becomes terminal canceled
      restore_quarantined; inherited dispatch-start evidence becomes
      delivery_unknown without retry. Extend closed reasons in their owning migration
      and types if needed; retain append-only attempt/status evidence.
      New events stay behind a recovery hold until approved current consent,
      suppression, pause, privacy-workflow and channel-policy reconciliation is
      recorded. This hold is distinct from tombstone deletion proof.
- [ ] **Step 6:** Run source/target race and expiry tests, existing privacy/
      outbound regressions; expect PASS; commit
      `feat: preserve deletion authority and fence restored external work`; push.

### Task 11: Isolated restore, promotion and exact-revision deployment

**Files:** Create `src/operations/restore.ts`,
`src/persistence/postgres-runtime-grants.ts`,
`scripts/operations-common.sh`, `scripts/deploy-runtime.sh`,
`scripts/verify-runtime.sh`, `scripts/rollback-runtime.sh`,
`scripts/restore-runtime.sh`, `scripts/promote-restore.sh`,
`tests/operations-scripts.test.ts`,
`tests/integration/postgres-isolated-restore.test.ts`,
`tests/integration/postgres-runtime-grants.test.ts`.
Modify operations Compose and operations-main.

**Consumes:** Verified encrypted archive, current checkpoint, restore fence and
existing PostgresRestoreDeletionGate.
**Produces:** `restoreAndReconcile(options: RestoreOptions): Promise<RestoreEvidence>`;
`verifyPromotion(options: PromotionOptions): Promise<{status:'ready'}>`.
RestoreOptions binds restoreRef, backupRef, checkpointRef, target revision,
isolated database pool, keyring, batch bound and clock. Evidence contains only
internal refs, revision/schema, verification states/counts, quarantine/recovery
hold and target volume identity. PromotionOptions binds the same evidence,
fresh checkpoint watermark, actual target volume/network and actual revision.
Shell public interfaces:

```bash
./scripts/deploy-runtime.sh FULL_REVISION --mode private-disabled CONFIG_PATH
./scripts/verify-runtime.sh FULL_REVISION CONFIG_PATH
./scripts/rollback-runtime.sh FULL_RETAINED_REVISION --confirm-schema-compatible CONFIG_PATH
./scripts/restore-runtime.sh BACKUP_REF CHECKPOINT_REF FULL_REVISION CONFIG_PATH
./scripts/promote-restore.sh RESTORE_REF FULL_REVISION CONFIG_PATH
```

All uppercase argument names are descriptive interface parameters, not example
credentials or executable approval substitutes.

- [ ] **Step 1: Add RED orchestration assertions.**

```ts
test('failed pre-migration verification never invokes migration', async () => {
  const report = await scriptsFixture.deployWith({ backupVerification: 'failed' });
  expect(report.commands).not.toContain('migrate');
  expect(report.result).toBe('verification_failed');
});
test('promotion refuses a complete archive with an incomplete current checkpoint', async () => {
  const result = await restoreFixture.promoteWith({ checkpoint: 'incomplete' });
  expect(result.status).toBe('refused');
  expect(restoreFixture.applicationAttachments()).toBe(0);
});
```

ScriptsFixture is a test-owned PATH fake for docker/git/stat/flock commands,
capturing only operation names. Actual restore fixture uses guarded volumes.
Cover clean-revision mismatch, symlink config, missing archive/identity, schema
incompatibility, lock conflict, fresh empty DB bootstrap, old admission schema
upgrade, missing rotated key, final pass replay, target substituted after pass,
promotion failure between stop/switch/start, and writes prohibiting switch-back.

- [ ] **Step 2:** Run script tests and isolated restore/grants integration; expect RED.
- [ ] **Step 3:** Implement exact revision/image checks, restricted protected
      config parser, no eval/source of arbitrary environment content, single
      deployment flock and PG advisory lock, drain/stop, separate verified
      pre-migration backup, node-pg-migrate forward invocation and revision/schema
      readiness. Use controlled outage for migrations whose compatibility is
      unproven. After success register the pre-schema archive manifest.
      Never print full inspect/env/Compose interpolation or raw migration errors.
- [ ] **Step 4:** Bootstrap dedicated nonsuperuser DB login roles for API,
      admin, reply, outbound, notification, maintenance, health and read-only backup.
      Separate schema-owner/migrator credential from runtime roles. Revoke PUBLIC
      create privileges and enumerate grants per implemented repository/table/sequence.
      Test actual operations under each role and rejected DDL/unrelated writes.
      Initial bootstrap may use the PostgreSQL owner credential only in the explicit
      operations job; runtime containers never receive it.
- [ ] **Step 5:** Restore into new project/network/volume; reject any live-volume
      name or mount. Stream decrypt/pg_restore --exit-on-error without --clean against
      existing authoritative DB. Forward-migrate, import current checkpoint,
      quarantine, run bounded reapplyBatch until zero and finalizeGate with bound
      revision/requiredKeyVersions. Close all application access while refreshing
      the source checkpoint/final gate. Promote only fresh matching evidence.
      Keep external execution disabled after switch until recovery-policy review.
- [ ] **Step 6:** Retained-image rollback checks schema manifest/compatibility
      and never rebuilds/down-migrates. Failure preserves both volumes and reports
      closed phase code; no automatic old-volume switch after writes.
      Run actual synthetic restore and interrupted promotion; expect PASS.
- [ ] **Step 7:** Commit `feat: gate migrations restores and runtime promotion`; push.

### Task 12: Revision-pinned host timers and scheduled maintenance

**Files:** Create `scripts/run-operation.sh`,
`scripts/render-systemd-units.sh`,
`infra/systemd/fcd-support-operation@.service`,
`infra/systemd/fcd-support-backup.timer.in`,
`infra/systemd/fcd-support-maintenance.timer.in`,
`infra/systemd/fcd-support-health.timer.in`,
`tests/systemd-contract.test.ts`.
Modify operations config/examples and operations-main.

**Consumes:** Exact deployed revision record, shared script preflight,
maintenance/backup/health command interfaces.
**Produces:** `run-operation.sh JOB FULL_REVISION CONFIG_PATH` for a closed job
enum; renderer creates validated units in an explicitly supplied protected
operator directory outside Git during approved installation.

- [ ] **Step 1: Add RED timer checks.**

```ts
test('host timers carry references only and permit one idempotent catch-up', () => {
  const timer = readFileSync('infra/systemd/fcd-support-backup.timer.in', 'utf8');
  const unit = readFileSync('infra/systemd/fcd-support-operation@.service', 'utf8');
  expect(timer).toContain('Persistent=true');
  expect(unit).toContain('run-operation.sh');
  expect(unit).not.toMatch(/Environment=.*(PASSWORD|TOKEN|API_KEY)=/u);
  expect(unit).not.toContain('docker.sock:');
});
```

Cover malicious calendar/argument, missed daily/monthly run, simultaneous
deploy/job, backup already completed for slot, unavailable DB and old checkout.

- [ ] **Step 2:** Run systemd contract tests and shell syntax checks; expect RED.
- [ ] **Step 3:** Render calendars from required config after
      `systemd-analyze calendar` validation. Use host-managed units with fixed
      working directory, protected non-secret EnvironmentFile, timeout, journal,
      non-overlap locks and exact revision. Health may run during a DB outage and
      emit only fixed host event/state/time. Maintenance cannot race restore/migration.
      Use Persistent catch-up only for idempotent backup/maintenance; health checks
      resume current time. Monthly class is selected once per UTC calendar month.
- [ ] **Step 4:** Learning job runs bounded aggregateInsights/openQuestionDigest
      with stable runRef/requestKey and complete time windows. Retention invokes
      runExpiredContentBatch; deletion uses executeApprovedRequest; recovery invokes
      expireLeases. Do not alter existing cadence or lifecycle defaults.
- [ ] **Step 5:** Validate generated units with `systemd-analyze verify` in the
      Linux test environment. Exercise scheduler commands locally through fakes;
      do not install systemd units on the Ubuntu deployment host during P6 local
      validation. Commit `feat: schedule revision pinned private operations jobs`; push.

### Task 13: Health collection and private operations dashboard

**Files:** Create `src/operations/health-collector.ts`,
`src/admin/operations-html.ts`, `src/admin/operations-routes.ts`,
`src/persistence/postgres-admin-operations.ts`,
`tests/health-collector.test.ts`, `tests/admin-operations.test.ts`,
`tests/integration/postgres-admin-operations.test.ts`.
Modify admin-app/runtime/html/types/action, logging and
`scripts/verify-runtime.sh`.

**Consumes:** OperationsStore, existing active admin identity/session,
host-selected health snapshot and aggregate DB queries.
**Produces:** `collectHealth(options: HealthCollectorOptions): Promise<readonly HealthObservation[]>`;
`registerOperationsRoutes(app: FastifyInstance, dependencies: AdminOperationsDependencies): void`.
HealthCollectorOptions has pool/store, clock, timeouts/staleness and injected
closed probe ports. AdminOperationsDependencies supplies existing identity,
actor/action validation, operations reader and acknowledgement methods.
UI route is `GET /operations`; acknowledgement POST is
`/operations/incidents/:incidentRef/acknowledge` on admin process only.

- [ ] **Step 1: Add RED failure and authorization assertions.**

```ts
test('database outage still writes only a fixed journal event', async () => {
  const report = await healthFixture.runWithDatabaseDown();
  expect(report.journal).toEqual([
    {
      event: 'operations_health',
      state: 'unavailable',
      component: 'postgres',
      checkedAt: '2030-01-01T00:00:00.000Z',
    },
  ]);
});
test('public app never acquires the private operations route', async () => {
  const response = await publicApp.inject({ method: 'GET', url: '/operations' });
  expect(response.statusCode).toBe(404);
});
```

Define HealthFixture in health-collector.test using a failing DB port and
fixed clock/journal sink. Admin tests use existing session/CSRF/signed-action
fixture conventions. Cover session expiry/revocation during acknowledgement,
wrong MFA/role/origin, duplicate action, escaped closed display fields, empty
state, stale health/backups, keyboard/readable table states, failed count query,
recovery after host downtime and deliberately malformed external error.

- [ ] **Step 2:** Run health/admin unit tests and admin-operations integration;
      expect RED.
- [ ] **Step 3:** Collector queries schema, DB readiness, aggregate work depth/
      age buckets, backup age and current worker heartbeats. Host verifier supplies
      only formatted Docker health/running/revision fields; never full container
      inspect. Manifest/n8n probes are bounded TCP/health availability probes, not
      inference, notification or provider calls. Disabled model/notification paths
      display disabled/not_verified, not healthy. Collect tunnel Docker health plus
      last approved exact public check metadata without changing ingress.
- [ ] **Step 4:** Persist content-free incident transitions; journal fixed
      codes/time when DB fails, replay bounded outage gap after recovery. Dashboard
      renders current status, migration/deploy revision, backup/restore status,
      worker counts/age, Manifest attestation, tunnel health and incidents.
      Existing account authorization controls acknowledgement in the same DB
      transaction. No customer content, provider ID, key version value material,
      dump listing, URL, SQL parameter or free-form exception reaches UI/logs.
- [ ] **Step 5:** Reuse the existing server-rendered admin design; no frontend
      framework/dependency replacement. Test desktop/mobile HTML and accessible
      states locally with synthetic data. Run focused tests and regression gate;
      commit `feat: expose private operational health and incident review`; push.

### Task 14: Authenticated idempotent private n8n notification client

**Files:** Create `src/notifications/n8n-client.ts`,
`src/notifications/notification-worker.ts`,
`src/operations/notification-runtime.ts`,
`tests/n8n-client.test.ts`, `tests/notification-worker.test.ts`,
`tests/helpers/fake-n8n-server.ts`,
`tests/integration/postgres-notification-flow.test.ts`.
Modify worker-main, notification-types and private operations documentation.

**Consumes:** Task 3 notification work, mounted signing secret, private
configured origin, worker lifecycle.
**Produces:**
`createN8nClient(options: N8nClientOptions): N8nClient`,
`N8nClient.send(input: {notification: NotificationEnvelope; signal?:AbortSignal}): Promise<N8nResult>`;
`createNotificationRuntime(options: RoleRuntimeOptions): Promise<RuntimeLifecycle>`.
NotificationEnvelope is strict schemaVersion=1, type
operator_privacy_request/operator_marketing_opt_out/operator_support_escalation/
operator_outbound_escalation, opaque reference, occurredAt and idempotencyKey.
N8nResult is accepted/retryable/terminal_failed with closed reason; no body/error
detail. Define options with origin/path, secret wrapper, timeout, response-byte
bound and injected fetch/clock.

- [ ] **Step 1: Add RED consumer/authentication assertions.**

```ts
test('lost acknowledgement retries the same key without duplicate notification', async () => {
  await fixture.fake.acceptThenDisconnect();
  await fixture.runBatch();
  await fixture.advanceRetryClock();
  await fixture.runBatch();
  expect(fixture.fake.acceptedNotificationCount()).toBe(1);
  expect(await fixture.deliveredWorkCount()).toBe(1);
});
test('n8n outage cannot mutate consent or conversation authority', async () => {
  const before = await fixture.authorityProjection();
  await fixture.fake.stop();
  await fixture.runBatch();
  expect(await fixture.authorityProjection()).toEqual(before);
});
```

Define NotificationFlowFixture on Task 3 repositories plus synthetic fake.
Fake binds loopback, accepts only synthetic signing secret and stores only key/
shape/count/outcome metadata. Test bad signature, expired/future signature time,
replay/body mutation, strict extra-field rejection, redirect/public URL,
DNS/address mismatch, timeout, oversized/malformed response, exact retry and
retention/deletion erasure before delivery.

- [ ] **Step 2:** Run client/worker unit files and notification-flow integration;
      expect RED.
- [ ] **Step 3:** Canonical UTF-8 JSON key order:
      schemaVersion, type, reference, occurredAt, idempotencyKey.
      HMAC SHA256 signs `timestamp + "." + bodyBytes`; headers
      X-FCD-Timestamp, X-FCD-Signature, Idempotency-Key. Receiver/fake validates body,
      timing with configured maximum skew, constant-time MAC and durable unique key.
      Success schema is exactly accepted plus matching idempotencyKey.
- [ ] **Step 4:** Require private service alias and exact configured origin/
      path; revalidate DNS/socket destination for each connection, reject all public
      addresses and redirects. Dedicated notification network must have no route to
      public Internet in production. Local fake permits loopback only with explicit
      synthetic mode. No credentials in URL. Read no error bodies; bound success
      bytes before parse. Retry transient/ambiguous results with the same key and
      supplied bounded backoff/attempt cap; accepted source never gets a new key.
- [ ] **Step 5:** Add consumer runbook for the existing n8n operator to implement
      signature verification/durable deduplication before enablement; no live workflow
      is edited. n8n gets no DB credentials or state-mutating callback route.
      Run focused tests/check; commit `feat: deliver minimized signed n8n notifications`;
      push.

### Task 15: Complete local failure matrix and P6 gate evidence

**Files:** Create `docs/operations/hardened-runtime.md`,
`docs/operations/backup-and-restore.md`,
`docs/testing/phase-6-operations-evidence.md`,
`docs/reviews/phase-6-gate.md`,
`tests/integration/phase6-failure-recovery.test.ts`.
Modify `docs/TODO.md`, `docs/PROJECT_CONTEXT.md`,
`docs/PLAN.md`, `docs/security/threat-model.md`,
`docs/testing/acceptance-matrix.md`,
`docs/operations/outbound-worker.md`,
`docs/operations/private-admin-and-model.md`.

**Consumes:** Tasks 1–14 passing locally.
**Produces:** reviewed P6-GATE local outcome and executable recovery runbooks.

- [ ] **Step 1: Add remaining RED failure cases.**

```ts
test.each(['postgres', 'manifest', 'meta', 'n8n', 'tunnel', 'health'] as const)(
  '%s outage produces closed evidence and preserves PostgreSQL authority',
  async (component) => {
    const result = await failureFixture.inject(component);
    expect(result.leakedSensitiveFields).toBe(0);
    expect(result.unapprovedNetworkPaths).toBe(0);
    expect(result.blindResends).toBe(0);
  },
);
```

Define FailureFixture from the isolated Task 8 stack and authored source/
target fixtures. Cover crash at every deployment/promotion boundary, host
timer catch-up, stale events after downtime, backup destination full/readonly,
malformed ciphertext, checkpoint drift, outbox restored after acceptance,
revoked admin session, health stale and simultaneous operations lock.

- [ ] **Step 2:** Run failure matrix; fix each demonstrated defect in its owning
      module with a regression, then rerun only affected focused checks.
- [ ] **Step 3:** Run `npm run check`; full guarded sequential PostgreSQL suite;
      `./scripts/test-phase6-local.sh`; image/container inspections, every Compose
      profile, network probes, encrypted backup/isolated restore/tombstone/fence,
      compatible rollback and failure injection. Record exact test counts/files,
      revision, durations and outcomes; cleanup audit reports zero orphan test
      schemas/locks and only intended retained synthetic evidence.
- [ ] **Step 4:** Document operator command inputs, secret file ownership,
      settings, safe stop, worker drain, dashboard access through SSH, job scheduling,
      backup verification/private-key isolation, quarterly restore, current checkpoint,
      promotion refusal, recovery hold, rollback limits and manual coverage.
      Update PLAN's Phase 6 exit text to explicitly permit the approved admin
      loopback-only binding; its previous blanket no-host-port text must not conflict
      with this owner-approved design. Describe dashboard/journal incident delivery
      and deferred external uptime alerts without claiming offline notification.
- [ ] **Step 5:** Map AC-09/18/20/21/25/26 to actual local evidence. Keep live
      Manifest recording/provider, private live n8n, Meta asset sends, full host
      restart and production checks pending P7/P8. No count from the P5 baseline
      is presented as newly executed P6 evidence.
- [ ] **Step 6:** Self-review scope/privacy/spec coverage and staged files;
      complete task review under authorized method. Record P6-002 through P6-006
      complete only when their evidence passes; use delegated gate review only if
      still applicable, otherwise prepare gate decision for owner. Commit
      `docs: record phase 6 local operations validation`; push.

### Task 16: Concrete local-server deployment handoff

**Files:** Create `docs/operations/phase-6-server-deployment.md`.
Modify `docs/operations/test-deployment.md`, TODO and PROJECT_CONTEXT.

**Consumes:** P6-GATE local pass, exact synchronized Git revision, the approved
local-server target, current admission-only deployment runbook.
**Produces:** one exact action list and rollback scope for
redwan@192.168.10.40; subsequent sanitized server evidence only after execution.

- [ ] **Step 1:** Prepare read-only preflight commands that disclose only service
      readiness/version/count/network membership, disk capacity, file permissions,
      image revision, migration revision and configuration presence. Recheck current
      state instead of assuming the August inventory is still current. Never print
      runtime.env, secret contents, full inspect output or raw DB rows.
- [ ] **Step 2:** Write exact pull/checkout, image build, secret-file provisioning,
      network verification, drain, encrypted backup/verification, forward migration,
      private-disabled runtime startup, health/timer installation and route verification
      commands from Tasks 7–12. Choose the actual full approved revision at execution
      time from synchronized HEAD, store it in the handoff record, and refuse any
      mismatch. No source editing/copying on Ubuntu. Explain affected service/volume
      names and preserved legacy rollback images.
- [ ] **Step 3:** Account explicitly for the old admission-only runtime and
      already connected Meta test webhook: do not process historical non-synthetic
      pending messages or enable an automatic send merely by replacing the image.
      Keep MODEL_EXECUTION_ENABLED, OUTBOUND_EXECUTION_ENABLED and
      N8N_EXECUTION_ENABLED false; no live credentials for those roles are mounted.
      Before any existing database becomes attached to new workers, establish its
      approved non-customer data scope or keep those workers disabled.
- [ ] **Step 4:** List stop conditions: unavailable protected secret provision,
      no verification identity, insufficient disk, incomplete checkpoint, incompatible
      schema/volume ownership, broad external network, unhealthy runtime, changed
      callback target or lost ingress catch-all. Preserve old stack/volumes/images;
      do not weaken boundaries to finish deployment.
- [ ] **Step 5:** Commit/push the concrete handoff before server mutation.
      Present the exact revision, affected services, commands and rollback at the
      repository's immediate external-action gate. The owner has already chosen this
      server; approval here concerns the concrete action list required by PLAN,
      not another server-selection question.
- [ ] **Step 6:** After that required boundary is satisfied, execute the approved
      commands and record only sanitized pass/fail/version/count evidence. If this
      turn's authorization ends at planning, leave this execution step unchecked.
      P7-005 continues to own live test assets, recording-off attestation, real
      provider quality/sends and host outage/restart evidence.

## Self-Review And Coverage Record

Plan self-review completed on 2026-10-04. Coverage, task ordering, interfaces,
source-storage names, and approval boundaries were checked against the written
specification and existing code.

- [x] Purpose/success/runtime roles → Tasks 1–8.
- [x] Images/mounts/secrets/resources → Tasks 1, 7–8, 11.
- [x] Network/public isolation → Tasks 8, 13, 15–16.
- [x] Runtime coordination and restart → Tasks 3–6, 10, 15.
- [x] Host scheduling → Task 12.
- [x] Health/dashboard/journal/deferred alerts → Tasks 2, 13, 15.
- [x] Encrypted backup/minimums/quarterly restore → Tasks 9–12, 15.
- [x] Current tombstones/quarantine/recovery hold → Tasks 10–11, 15.
- [x] Migration/drain/rollback/failure state → Tasks 6, 9, 11, 15.
- [x] Signed private n8n/authority → Tasks 3, 14–15.
- [x] Synthetic evidence/gates/server scope → Tasks 15–16.
- [x] Names/signatures agree with Shared Interfaces and task producers.
- [x] No undecided placeholders, secret values, live/customer fixtures or
      unapproved external action is embedded.

The plan's self-review checklist is separate from implementation steps.
Checking this section does not mean any implementation task ran.

## Primary Technical References

- [Docker Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/):
  files granted per service; secret values are kept out of declared environment.
- [Compose service reference](https://docs.docker.com/reference/compose-file/services/):
  file-backed secret UID/GID remapping is not supported; inspect actual host
  ownership. Runtime limits, network and health fields require actual container
  checks, not just YAML presence.
- [PostgreSQL 18 pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html)
  and [pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html):
  custom-format archive and restore tools; listing is structural verification.
- [age project](https://github.com/FiloSottile/age) and
  [age 1.3.2 release](https://github.com/FiloSottile/age/releases/tag/v1.3.2):
  public recipient encryption and separately held decryption identity.

## Handoff

Recommended execution: sequential native development with the executing-plans
workflow, focused review per independently testable task and final gate review
under the owner's authorized method. Additional subagents are optional only
after explicit authorization. The plan review is the next gate; this document
contains no implementation or server-execution claim.
