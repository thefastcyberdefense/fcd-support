# Project Context

Last reviewed: 2026-10-31 (Asia/Dhaka)

Current source: PR #2 merged as `67a4a4bede6d3252dc936a6e410f4b90c1359ac3`;
all four exact merged-source workflows pass. The reviewed application matches
`9c6ffc5` (Windows 1,922 passed/433 skips; both full recovery CI modes pass).
Action records `7afffd5` were committed/pushed before fresh server execution.

Actual server drill: deploy/private verify, three signed archives/replay,
isolated restore and public promote/verify passed. Full preservation audits
matched through immediately before promotion, then refused old start/network
drift. Direct SSH diagnosis proves a host reboot during the drill. Old protected
files/volumes/actor identities/other definitions match; running-actor start and
endpoint metadata/default bridge identity changed. The original baseline remains
unchanged, and the original action stopped before rollback.

Fresh selected restored volume/physical identity and completed promotion record
match, both volumes remain, and no active job exists. API/reply/PostgreSQL are
healthy; admin is restarting with a protected stale socket refusing connections.
Persisted READY does not replace current runtime verification. A separate one-use
public socket-recovery/rollback proposal passes read-only admission and 11 pure/
hermetic methods after reproduced review corrections. Final review and commit/
push are required before execution. No manual unlink, old-job settlement,
baseline overwrite, promotion retry or old-target restart is allowed. See
`docs/reviews/2026-10-31-server-reboot-recovery.md`.

Task 11/P6-004, Task 15 and P6-GATE remain open. AGY's matrix branch is
synchronized at `ac6e7c0`; the next checklist is
`docs/handoffs/2026-10-31-antigravity-phase-6-next.md`. Evidence-map corrections
may proceed, but implementation waits for Codex's Task 11 completion. Codex owns
server actions, trackers and independent whole-phase review. No provider,
tunnel, Meta or production resource change ran.

The following entries retain earlier checkpoints and their evidence.

Historical blocker at the prior checkpoint: the later PostgreSQL stop/remove proof still compares raw
`.Mounts` order. Its controller is unchanged between `6faff8b` and `70f8e70`.
Ten actual-template reads each of the preserved source/target showed two raw
changes each; every complete projection matched after sorting full mount
records, and state hashes were unchanged. This is not the recovered cause of
the missing historic job. The new post-verification metadata-stability spec/plan
is now AGY's priority before broader CI tests. `70f8e70` passed all four merged
workflows but its server proposal was not executed; the four local draft action
copies were withdrawn. No new namespace or server baseline was created.

The passive observer prototype is reviewed and its signal cleanup corrected:
28 tests/one SIGHUP skip passed on Windows and all 29 on Linux, including actual
loop tests through hermetic worker subprocesses. Its read-only clean Docker
transport also passed. No real observer has run; its `70f8e70` pin must be
updated to the next reviewed fixed source before use. Existing uncertain scopes
remain untouched and Phase 6 is incomplete.

Local correction: PR #1 was reviewed, corrected and squash-merged as `70f8e70`.
Its tree matches `ace6bab`, whose four exact-source PR workflows passed. The
corrected local gate passed 1,873 tests/433 platform skips across 125 files;
native checks passed 1,280 tests across 55 files and 139 PostgreSQL tests with
one restore-only skip across 13 files. Owned resources were removed. Require
merged-source CI before the separately recorded fresh action. Codex is preparing
passive, content-free promotion diagnostics and a new preserved-state baseline;
this adds no operation-resolution or readiness authority. No new server
deployment occurred. Task 11 and Phase 6 remain incomplete.

Latest: the `80ea3d2` fresh restore stage completed at source `6faff8b`, but
promotion refused. The new selection/job are uncertain with writes possible;
both PostgreSQL actors are healthy, the original-volume pointer, completed
restore record and override remain, and the recorded job actor is absent. No
rollback ran. The old-scope audit still matches. Do not infer SQL outcome or
retry/clear/repair any scope.

A separate actual-Docker probe demonstrated target mount-order instability:
four adjacent raw changes across ten observations, with identical complete
metadata after sorting mounts. The host collector's raw string recheck can
therefore falsely refuse. This is an independent blocker, not proof of the
removed job's exact failure point. The next local Task 11 fix is defined in
`docs/superpowers/specs/2026-10-29-phase-6-promotion-metadata-stability.md` and
its matching plan. Antigravity's isolated local assignment prioritizes that
test-first fix; no new resolver, readiness bypass or server action is authorized
by that assignment. Phase 6 remains incomplete.

The owner requested multiple Antigravity tasks. The `15a2b55` handoff now assigns
the bounded correction, Task 11 gap coverage, Tasks 12–14 local integration
readiness and review-branch validation/delivery. Codex owns server diagnosis and
active tracker/context/action files. No Antigravity result is yet verified.
A separate exact-actor Docker event query returned zero retained events;
history may be incomplete and supplies no termination/outcome proof. Current
state-file identities/hashes and the before/after full old-scope audit matched.
No retry, rollback, state settlement or server mutation occurred.

Commit `6faff8b` is pushed and all four exact-source GitHub workflows passed.
The fresh synthetic server action committed at `9c2e404` completed. Eight
explicit bridges, pinned builds, private-disabled deploy/verify and private
HTTP/socket checks passed; both final acknowledgements confirmed verification
and preserved prior fingerprints. An independent check found four healthy
private actors, READY/no job, a protected admin socket/login, unchanged prior
state files and an absent fresh restore target. The `cda55ed` backup/replay
action subsequently passed: three signed archives retained identical
authenticated metadata after replay, runtime verification and full preservation
audits passed, and independent checks confirmed private evidence, READY/no job,
removed metadata readers and an absent target. Fresh checkpoint/isolated
restore/promotion/rollback and the remaining failure matrix are next; Phase 6
is still open.

The preservation rules are recorded in
`docs/operations/phase-6-server-deployment.md`. The
original admission snapshot has start-time drift; its actor IDs, recorded
versions/properties and original PostgreSQL volume still match. Current metadata
is stable, but host/Docker clock evidence is inconsistent by about a minute.
Preserve the original snapshot and all uncertain jobs; bind the new action to
a separate verified current baseline. No journal settlement is implied.

Both preserved restore targets are exited with automatic restart disabled;
their image/reference/volume bindings match their original intents. Both source
databases are healthy. The fresh action must preserve the targets' exact stopped
states without restarting them or inspecting their SQL state.

The synthetic server's default Docker address pool is exhausted. An optional
protected restore subnet now checks host routes and interfaces before mutation
and again before network creation, then verifies the actual bridge identity and
IPAM. It preserves the default-pool path when unset and does not settle the
uncertain promotion. Final local validation passed 1,851 tests/433 platform
skips across 125 files, plus 1,258 native tests across 55 files and 139
PostgreSQL tests with one restore-only skip across 13 files. The real Docker
proof and all 41 native subnet cases passed; the isolated project was cleaned
up. The checker also accepted an unused synthetic subnet and rejected an
occupied one on the actual server read-only. A new exact-revision CI pass and
separately committed server action are required for a fresh drill.
All four GitHub workflows passed for the earlier promotion fix `fdf08d4`.

Promotion diagnosis found no currently matching database backends, prepared
transactions or committed promotion-verification binding. Docker's journal
recorded deletion of the exact task without an exit status. These observations
do not settle the job or prove its outcome. The original host guard also
reproducibly rejects the correctly UID-999-owned PostgreSQL password files. Its
checkpoint path also disagrees with the rendered promotion job. Both corrections
passed local validation: 1,801 code tests/423 platform skips, 1,198 native
tests, 139 PostgreSQL tests/one restore-only skip, and a separate 250-test
restore lane plus 47 PostgreSQL tests. Real Docker ownership/negative cases and
the updated read-only server metadata guard passed; synthetic test projects
were cleaned up. All four exact-revision GitHub checks subsequently passed. The removed job's
exact failure point remains unknown, and all uncertain state stays preserved.

The fresh `b0ba255` synthetic restore completed, but promotion refused. The
selection and promotion job are uncertain and the state records writes as
possible; both synthetic PostgreSQL actors remain healthy. The recorded job
container is absent, while its override and the completed restore record remain.
The older uncertain restore and admission baseline are unchanged. No rollback
was attempted. Preserve both databases and all journals; diagnose before any
supported settlement or retry. Phase 6 is not complete.

Before that restore, the fresh `b0ba255` host passed the backup/replay action:
three signed archives verified and retained identical authenticated metadata and
identities after replay. An empty, exact-ID default-pool capacity canary passed
and was removed. Independent checks found the source READY with no active job,
the then-absent restore target, private evidence files, the older uncertain job
and the admission baseline. Promotion and the Phase 6 failure matrix remain open.

Exact source `b0ba255` passed its recorded fresh synthetic deployment on the
local server after all four GitHub workflows passed. Eight precreated bridges,
deployment, runtime verification and private HTTP checks passed. An independent
check confirmed four healthy actors, READY state without an active job, a
protected admin socket/login, and private HTTP responses 403/404/401. The old
uncertain restore state, target fingerprints and admission baseline remained
unchanged. No restore, promotion, rollback, live provider or customer traffic
occurred at that deployment checkpoint. Promotion and the Phase 6 failure matrix
remain open.

At `1446888`, both private-runtime CI variants and CodeQL passed. General CI's
Docker projections passed before a stopped-job creation failure about 16.1
seconds later. The fixture's 15-second timeout is a likely, unconfirmed cause;
the synthetic test now allows 60 seconds and distinguishes timeout from other
failures without changing runtime configuration. Four local Docker projections
passed, while stopped-job creation is Linux-only. The original CI rerun passed;
its native run was superseded. All four workflows passed at `b0ba255`, including
both private deployment variants, 1,197 native tests, 139 PostgreSQL tests with
one restore-only skip, 250 restore tests and 47 two-cluster PostgreSQL tests.
The separate complete PostgreSQL job passed 620 tests with 52 skips.

Current synthetic network-capacity work adds a guarded precreated-bridge mode
for an independent server fixture. Real Docker proved Compose adoption and
rejection of occupied, extra and replaced bridges. Existing resource names or
unavailable inventory cause an explicit refusal. Full code passed 1,800 tests
with 423 platform skips over 124 files. Before the final CI-mode and collision
checks, the isolated grants lane passed 1,197 native tests and 139 PostgreSQL
tests/one restore-only skip;
the real Docker network proof was repeated afterwards and its test tag removed.
The server checkout, disk capacity and proposed network block passed read-only
checks. Both previous synthetic databases are healthy, their uncertain restore
record is preserved, and the admission baseline matches. The separately recorded
synthetic-server deployment now passes; Phase 6 is not complete.

GitHub follow-up: the `5cb2ba5` PostgreSQL/native workflow failed in its
restore step because the DNS test referenced a Node base image unavailable in
the runner's image store. The test now uses the harness-built operations image.
A local simulation hiding the Node base passed its DNS proof, 250 native restore
tests and 47 PostgreSQL tests, with the synthetic project removed. All four
GitHub workflows passed at `78ab101`.

Restore DNS correction: runtime PostgreSQL now advertises only the source alias;
Compose validation and live source/target checks reject conflicting aliases.
The real Docker DNS proof and both rendered Compose contracts pass. Full code
passed 1,771 tests/423 platform skips across 123 files; the native grants gate
passed 1,196 tests and 139 PostgreSQL tests/one restore-only skip. The separate
restore gate passed 250 tests and 47 PostgreSQL tests; the final native
controller suite passed 59 tests. Synthetic test resources were removed. The
existing server job and target remain unresolved and preserved; no server retry
or reconciliation has been performed for this correction.

Latest synthetic server result: exact candidate `538d1d0` passed preflight,
image checks and checkpoint export, then created the isolated `r2` target. Its
first restore-stream job became uncertain; source and target PostgreSQL remain
healthy, the source is quiescent, and the job journal, restore intent and
target resources are preserved. The target has zero application tables, but
that count does not prove the job had no effects. The previous abandonment and
admission baseline remain unchanged. No promotion or rollback was attempted.
Diagnosis and supported reconciliation remain open.
Read-only diagnostics found the source advertising the target alias and an
authentication failure after target startup. A separate local Docker test
confirmed that this alias collision can resolve the target name to the source;
the exact DNS result of the removed job remains unknown. The Task 11 correction
and its preservation boundary are recorded in the restore DNS isolation spec.

Current image correction: the operations image now copies its pinned built
filesystem into a metadata-reset release stage and restores its previous
runtime settings without the inherited PostgreSQL volume. Actual Docker checks
passed for zero validator mounts, exactly one explicit job mount, matching image
metadata, non-root toolchain execution and anonymous-fixture cleanup. Full code
passed 1,756 tests/423 platform skips across 122 files. Isolated native gates
passed 1,188 tests and 139 PostgreSQL tests with one restore-only skip; the
separate restore gate passed 246 tests and 47 PostgreSQL tests. Both synthetic
projects cleaned up. A read-only server check confirmed the quiescent source,
unused fresh target, preserved abandoned history and unchanged admission baseline.
All four GitHub Actions workflows passed at `538d1d0`; its separately recorded
restore retry stopped with the uncertain stream job described above.

Latest recovery work: the private empty-target command now requires an existing
labelled volume and rejects absent targets, unresolved jobs and ambiguous host
resources. Its read-only target and source validators use application images
without declared volumes. Local Docker checks demonstrated confinement and the
absence of implicit bind-source creation. Final focused checks passed 33 native
host and 69 state cases; full code passed 1,756 tests/423 platform skips.
Three potentially orphaned anonymous test volumes remain preserved
because their ownership cannot be proved. Exact source `9ffc370` then passed
the synthetic server close-out and an independent read-only check: original
intent, target volume, quiescent source and admission snapshot are preserved.
Four Actions workflows passed on its documentation-only successor. Restore,
promotion and Phase 6 gate evidence remain open.
The inherited-volume issue affecting other validators and promotion jobs is
corrected and passed CI; its exact committed revision still needs server proof.

Earlier recovery checkpoint: `8ccb9a0` private deploy/verify/routes/socket and backup/
replay pass after a separately recorded server restart baseline. Restore reached
quiescent source/empty partial target then refused exhausted network capacity.
Capacity was confirmed and two unused bridges released. The next-target retry
correctly refused the then-unresolved prior intent; that empty intent has since
been closed through the verified abandonment action described above. CI's older
renderer was reproduced
omitting explicit bind safety metadata; the compatible renderer is now pinned
with closed diagnostic evidence. Full code: 1730 passed/368 skips/117 files;
actual private-controller CI passed at `d879895` (Actions run `40533246495`).
Phase 6 closure remains pending. The Task 11 empty-target recovery addendum
records a private, verified abandonment path that preserves the old intent,
volume and target reservation. It cannot clear uncertain SQL jobs or authorize
promotion. Codex selected it under the owner's existing implementation delegation.

Most recent continuation: `5d35777` passed fresh full deployment and backup/replay;
actual source drain and isolated PostgreSQL target creation then passed. Stream
refused a foreign checkpoint directory inherited from shared fixture settings.
Source is quiescent, target remains isolated, and the uncertain job plus both
databases are preserved. Role-specific Compose paths and a stricter rendered
contract are under validation. Disposable controller CI also exposed an unresolved
deployment failure; the next run adds closed code/source-line diagnostics.

Latest host checkpoint: `a6de436` reached private READY at schema `000016` with
all four healthy actors, public verify, private rejection routes, protected Unix
login and an actual SSH forward/authentication gate. Scheduled daily/monthly
backup and replay preserved three signed archives. Restore refused during drain
before any actor stop or target creation; source selection is now uncertain,
with its healthy actors retained. A real Docker probe reproduces the doubled
separator in the drain mount check; correction validation is underway. Earlier
fixtures/jobs/history and the original admission stack remain preserved. Host
restore/promotion, rollback, recovery matrix and Phase 6 closure remain open.

## Confirmed Decisions

- Build a dedicated customer-support application; OpenClaw and Hermes remain private/internal.
- Automate WhatsApp Business and Facebook Messenger. Instagram DM automation is not part of the first release.
- Use English and Bangla, approved FAQ answers first, and AI only when needed.
- Store reviewed, versioned support knowledge in the existing private PostgreSQL database. Website fetches, customer-derived gaps, model drafts, and owner answers remain proposals until an authenticated reviewer publishes them.
- Use a separate authenticated, loopback/private-access `fcd-support-admin` dashboard for knowledge review, owner questions, privacy-safe insights, model-policy administration, and later independently designed CRM modules. It never joins the public webhook ingress network; a private CLI remains for bootstrap and break-glass operations.
- Improve knowledge through a controlled proposal-only learning loop. Every three days the application may prepare at most five useful owner questions in the dashboard, but neither the AI, Manifest, n8n, a crawl, nor customer repetition can publish knowledge.
- Use Manifest Harness `fcd-support` with its dedicated API configuration, provider scope, default model, up to five fallbacks, limits, and observability.
- Use Manifest-managed allowlisted fallback only. Model output uses a validated structured envelope, operational limits are versioned/customizable under protected deployment ceilings, and unsafe or exhausted inference creates a safe response plus PostgreSQL escalation.
- Use a Meta test number before any production WhatsApp change. The current production account stays linked to Meta.
- Staff retain Meta Business Suite access and manually cover periods when the local server is off.
- Human staff replies pause AI for that conversation for 24 hours unless resumed earlier.
- Crawl `https://fastcyberdefense.com/` only on demand; all changes require review before publication to the knowledge base.
- Lifecycle precedence is `active_client > unconverted_lead > casual_chat`. Casual chats expire 60 days after the latest qualifying human-authored event; unconverted leads expire 12 calendar months after the latest qualifying lead interaction. AI replies, statuses, duplicates, retries, consent bookkeeping, and unresponded marketing sends never extend retention.
- Active-client support content is retained during the documented relationship and for 24 calendar months after the later documented relationship end or final paid service completion. The Fast Cyber Defense Managing Director/business-owner role owns the policy and reviews active-client classifications annually.
- Deletion uses same-channel explicit confirmation plus human review, never a password, OTP, payment credential, or secret. Minimal suppression and restore tombstones use a versioned HMAC identity and no raw identifier or message content.
- `REQUEST MY DATA`, `CORRECT MY DATA`, and all-linked-identity `STOP MARKETING` use deterministic P3-007 intake plus human review. Access collection is private, redacting, one-run, and review-expiring; correction has no production handler until a field owner is approved; marketing opt-out covers all four closed categories and re-opt-in changes only named categories at its effective time.
- Manifest message-body recording must be disabled before customer/model traffic; restored backups remain isolated until all unexpired deletion tombstones are reapplied and verified.
- Marketing requires explicit, category-specific opt-in. Blank means no promotional eligibility.

## Current Phase 6 Checkpoint

The `91eb8f3` drill published quiescent initialization, then startup became
uncertain at its first bootstrap job: unsupported `compose create --no-deps`
left a pending job with no actor. Never replay or clear that record manually.
The correction uses supported stopped-create flags and rejects implicit
one-shot dependencies/links; target PostgreSQL creation remains a separate
verified host step. Fifteen dependency regressions pass, the independent real
Linux stopped-create canary passes without starting an actor or changing old
state, full code passes 1,704/368 skips/116 files and native operations passes
1,119 units +139 PostgreSQL/one separate restore-only skip. Another fresh exact
source/namespace is required; application startup and P6/P7 remain unproven.

Real-host diagnostics also exposed default Docker subnet exhaustion from retained
failed test bridges. Explicit bounded disposition released four verified test
actors and 17 owned networks, preserving all volumes/intents and the original
admission stack. The diagnostic scope then started healthy PostgreSQL and reached
history publication, where its general record parser rejected the timestamp's
`+`. Native regression was 1 RED/30 passing, then all 31 passing after the parser
correction; per-field validation remains strict. A history record exists without
a published selection, so that scope must remain preserved and cannot be
implicitly resumed. New fixture restore names now meet the production identity
schema. Final combined checks and another exact-source fresh drill are next.

Final projection correction is locally verified: code 1,689 passed/367 platform
skips/116 files; native operations 1,103 units +139 PostgreSQL cases/one separate
restore-only skip; two real Docker projections pass with zero remaining fixture
containers. Fresh committed server drill and remaining phase closure follow.

The follow-up controller at `eed4695` passed timezone/volume checks and started
a healthy fresh PostgreSQL actor, then refused during bootstrap snapshot
collection. Read-only diagnosis found Docker omits optional bind-mount `Name`
and no-health-check `State.Health` keys. Safe optional-map projections now pass
two real Docker probes plus 132 focused cases/30 native-only skips, without
changing runtime health/mount/identity requirements. Full final checks and a
fresh committed-namespace drill follow. Prior intents and the old admission
stack remain unchanged; no applications started in the failed new namespace.

The first complete controller drill at `e0565d0` failed safely before runtime
PostgreSQL/application startup: actual Docker volume metadata uses `+06:00`,
while prior validators admitted only `Z`. Its protected intent and fresh resources
remain preserved. Bounded Docker-volume timestamp offset support now passes
1,689 code tests/367 skips/116 files, native restore 172 units +47 PostgreSQL
cases and 28 binding cases. Exact text remains identity-bound; equivalent-time
replacement is refused. The old admission snapshots still match. A new exact
revision and fresh namespace are required for the next host drill; no implicit
interrupted-intent reuse, full host pass or P6/P7 completion is claimed.

Stage A real-server synthetic validation is complete: unit 1,714 passed/324
native-only skips; native operations 1,100 units +139 PostgreSQL/one restore-only
skip; restore 171 units +47 PostgreSQL; corrected ordinary PostgreSQL 619
passed/52 native-only skips. Both isolated projects cleaned up at zero temporary
schemas, fixture roles, advisory locks and project Docker resources. Retained
admission container IDs/start-times/running states matched. All three Actions
workflows passed at `99c9306`. The source checkout is clean at `3f8783f`, while
the retained application still executes `207a5e6`. Full private runtime/controller
deployment and the remaining failure matrix/review are next; no P6/P7 gate or
live-provider validation is claimed.

Real server validation has begun with fresh synthetic resources at source
`83978fc`. Its unit lane passed 1,714 tests/324 native-only skips. Ordinary
PostgreSQL exposed a real Unix ownership mismatch: capability-dropped root
could not read UID-1000 `0600` checkout files. The corrected integration image
runs as node and owns its copied package metadata; it does not widen host file
permissions. Local regression is 12/12; full corrected code is 1,672 passed/367
skips/113 files and ordinary PostgreSQL is 619 passed/52 native-only skips/56
files. Unit, CodeQL and PostgreSQL/native Actions passed at `4a6de6a` before that
server-specific correction. Exact server progress and preserved-stack boundaries
are recorded in `docs/operations/phase-6-server-deployment.md`.

Fresh-runner CI exposed test-environment assumptions at `ae13cec`: CodeQL and
ordinary PostgreSQL passed, while the unit/native jobs failed on UID/tmpfs and
an unbuilt dependency image. The revised harness uses the pinned UID/toolchain,
memory-backed scratch, explicit image builds and a networkless unit lane. A
dedicated synthetic project suffix permits early server validation without
touching the old admission database. Pinned dependency maintenance leaves both
complete and runtime-only npm audits at zero advisories. Latest local code:
1,671 passed/367 platform skips/113 files; Linux units: 1,714 passed/324 native-only
skips/113 files. These results do not replace deployed-host validation or the
whole-phase review.

Tasks 1–10 are complete. Task 11 remains in progress. Deploy, verify,
exact-schema rollback, socket recovery, isolated restore and promotion operator
entry points now load their host controllers. Restore runs separate narrow
stream, target-only grant preparation/migration/convergence and current deletion
reconciliation jobs. The real two-cluster synthetic flow covers those drivers,
quarantine, recovery hold, fresh promotion and pool shutdown. Complete deployed
host/failure-matrix evidence and whole-phase review remain required; available
commands and component passes do not establish a completed P6/P7 gate.

The subsequent internal promotion driver requires two fresh, bounded,
replay-resistant host stdio exchanges while the existing reconciliation library
retains its source freeze. It checks source/target physical identities and the
prior restore binding, applies current deletion evidence and closes both pools
before acknowledging. Networkless metadata conversion and protected immutable
restore intent/completion records are descriptive only; no target selection or
application attachment follows from them. Managed READY deployments may retain
their protected live Unix socket until the separately verified controlled drain;
the exception requires the held deployment lock, current protected selection and
stable socket identity, and performs no Docker or socket mutation.

Automatic approval review rejected the proposed combined Compose change that
gave source-network access and all bootstrap passwords to a restore job. The
patch was not applied. `docs/reviews/phase-6-restore-capability-boundary.md`
recommends separate target-only bootstrap/migration jobs and narrow source/target
reconciliation jobs. The owner explicitly approved that split-job design on
2026-10-26 and directed completion through Phase 7, including testing and fixes
on the existing local test server using test Pages/accounts. Prepare the concrete
revision/commands/rollback before mutation and verify test-only data scope and
Manifest privacy before traffic. Routine implementation decisions remain
delegated; production assets remain protected. The combined-authority approach
remains rejected, and its drafts are not an approved implementation.

Latest prerequisite verification: `VITEST_MAX_WORKERS=4 npm run check` passed
1,668 tests with 367 platform skips across 112 files. The complete native
operations gate passed 1,100 units and 139 PostgreSQL cases, with one separate
restore-only skip. The final split restore gate passed 171 units and 47
PostgreSQL cases, including its inherited image-metadata extension.
Native Linux checks exposed and verified a line-ending correction in the new
host port. The pinned image's benign PostgreSQL version metadata is accepted;
connection/credential overrides remain rejected. New Actions jobs add PostgreSQL
and native operations/restore checks. No remote result is implied before those
jobs run. This does not replace deployed-host verification or whole-phase review.

Tasks 12–14 now have scheduler, health/dashboard and signed private notification
components under aggregate validation. Operational limits are customizable;
closed protocol bounds and authorization invariants remain enforced. Deletion
cancels delivery inside its transaction, preserves delivery evidence and prevents
later notification reconciliation from recreating deleted-subject work. n8n
still owns no business state. Host health input integration and the remaining
deployment/recovery/failure matrix are not a completed P6 gate.

No full Phase 6 runtime deployment or live Meta, Manifest, provider, n8n or
Cloudflare action has occurred. The existing admission stack still executes
`207a5e6357c1e1a7c75918793262d835574d898d`; only the source checkout and fresh
synthetic validation stack have advanced. The current checkpoint above supersedes
the implementation availability described in older notes below; those notes
retain their historical evidence and do not establish current readiness.

## Existing Local Infrastructure

Phase 6 Task 11 now includes an internal controlled-drain helper and durable
draining state, including a non-ready first-admission adoption primitive. The
helper verifies owned source actors/images, selected physical storage, private
database networks and socket ownership before stopping applications; it preserves
PostgreSQL, images, volumes and any stale socket owner. Refusal leaves uncertainty
and never restarts an application. Actual legacy PostgreSQL image metadata omits
both revision labels and the default image user, so admission handling requires
an independently pinned image ID and an explicitly non-root actual container.
The internal first-admission adopter now checks protected history and a single
legacy PostgreSQL actor against matching volume, mount, image and physical-ID
samples. It records possible writes and a provisional schema in draining state;
it never starts/stops actors or creates ready/retained evidence. The verified
drain is the next separate step. Internal PostgreSQL container convergence now
persists a database-changing phase, replaces only a verified drained source actor
and requires fresh target host/physical proof before quiescent. It preserves the
selected volume and does not bootstrap, migrate or start applications. Public
preflight must check existing data-directory owners/modes before any outage: a
local fresh upstream seed has mode 1777, whereas the hardened image requires 700.
Actual server modes remain uninspected; no permission repair is automatic or
authorized by this local proof.
Private Compose now supports immutable image IDs with full revision labels and
actual container/image-ID binding. The sanitized launcher supplies all execution
flags as false, including required outbound/notification interpolation, and
overrides ambient or dictionary attempts to enable them. Actual local runtime
rendering and stopped operation creation pass without job/application startup
or database connections. Internal startup now composes verified database upgrade,
journalled candidate/success metadata, durable write exposure, private API/admin/
reply startup, full runtime proofs and exact image retention. Its SQL probes use
the durable executor. Failure retains uncertain state and attempts to stop only
verified target applications. Containment preserves PostgreSQL, storage, stopped
socket owners, unknown/changed actors and pending job records; it cannot authorize
another operation or claim readiness. Invalid startup arguments and ready-state
entry are preserved without mutation. Pending-job/state-replacement reconciliation
and public wiring remain open.
Managed one-shot jobs now carry a journal-matching PostgreSQL application name,
including snapshot exporters and external dumps. Actual local PostgreSQL tests
observe the matching backends and their closure; actual stopped creation checks
the reference without running the job. This is correlation, not journal
settlement or runtime authority. Legacy untracked jobs and unfinished isolated
restore target tracking require separate handling before recovery is enabled.
Internal recovery now has separate recorded-job containment and a read-only owner
probe for PostgreSQL backend settlement. Containment verifies exact ownership,
image, command, target metadata and frozen state before stop/removal, preserving
uncertain journals. The SQL probe requires a distinct tracked reference, actual
physical database identity, both mutation barriers, zero old backends across all
databases and no prepared transactions. Neither primitive clears a journal or
authorizes replay/readiness. Durable probe orchestration, operation-specific
postconditions and pending-ID/state-replacement resolution remain unfinished.
First boot also has an immutable, typed intent binding the intended volume,
namespace, role prefix, revision and image IDs before any future initialization.
It invents no physical identity or readiness and blocks ordinary initialization/
adoption/missing-pointer bypass. The first-boot controller now verifies absent
actors/volume, records intent, creates a uniquely labelled volume, starts only
PostgreSQL and publishes a quiescent selection after fresh host/physical proofs.
Interrupted intent refuses implicit replay. Deploy, verify, exact-schema retained
rollback and explicit socket recovery command entry points now compose the
verified primitives; source storage modes are checked before application shutdown.
Restore/promotion command wiring, interrupted-job/state reconciliation and actual
deployment validation remain unfinished. Task 11
stays IN PROGRESS; P6 is not deployed. See
`docs/operations/runtime-deployment-safety.md` for scope and validation.

- Server: Ubuntu at `192.168.10.40`; normally online about 12 hours per day.
- Capacity observed during planning: 4 CPU cores, about 15 GiB RAM with about 13 GiB available, and about 69 GiB free disk. No GPU is present or required.
- Docker and Docker Compose are already in use.
- Manifest `6.11.0`: local OpenAI-compatible gateway on port `2099`; Docker networks include `mnfst_frontend` and `mnfst_internal`. The `fcd-support`/`auto` host check passes, but recording is enabled, explicit fallback/limit rules were not found, and the admission API lacks private Manifest-network attachment.
- OmniRoute: local gateway on port `20128`; use only if required by the approved Manifest fallback policy.
- n8n `2.35.3`: LAN-bound on port `5678`, with external runners. The audit found zero static `fcd-support` public-API dependencies, but two API keys have historical use; keep the API enabled and LAN-only until their owners are identified.
- OpenClaw and Hermes are already configured but are explicitly outside this application's public execution path.
- UFW and Docker ingress rules are intended to allow LAN access only. Do not add a public router port forward.
- `fastcyberdefense.com` uses Cloudflare nameservers. A dedicated project tunnel container now exposes only the exact Meta webhook path to the internal admission-only API; health, database, n8n, Manifest, OmniRoute, and other paths remain private.

## Planned Deployment

- Local repository: `J:\DevDrive\fcd-support`
- Remote repository: `https://github.com/thefastcyberdefense/fcd-support`
- Proposed server directory: `/home/redwan/apps/fcd-support`
- Public hostname: a dedicated subdomain of `fastcyberdefense.com`, exposing only Meta webhook verification and delivery paths.
- Windows is the only source-authoring, commit, and push host. During an approved test-deployment gate, Ubuntu pulls the exact committed revision from GitHub; do not copy or edit application source directly on the server.

## External Prerequisites

- Cloudflare account access for the Fast Cyber Defense zone and a dedicated tunnel token.
- Meta developer app, Page permissions, WhatsApp test number, webhook verification token, app secret, and channel access tokens.
- Manifest Harness `fcd-support` plus its dedicated endpoint/key and approved routing configuration.
- Telegram destination and authenticated private n8n webhook for escalations.

All secret values are intentionally absent from this repository. Create them during implementation and store them only in protected runtime secret files.

## Test-Asset Status

- The Meta development app, WhatsApp test number, and Messenger test Page are connected to the verified callback; production assets remain untouched.
- Messenger role-scoped customer delivery, a manual Page-reply echo, and WhatsApp v26.0 synthetic incoming/status delivery have reached durable ingestion. The admission-only runtime does not yet apply the echo to policy state.
- The app remains unpublished. A real device-originated WhatsApp message sent during the 2026-08-26 post-redeployment check did not reach the callback, so real delivery and production permissions remain unproven.
- The deployed admission-only normalizer accepts phone-unavailable v26 text messages through a namespaced user identity and deliberately leaves contact-card content unsupported. A signed public-callback smoke test and exact retry passed at revision `207a5e6357c1e1a7c75918793262d835574d898d`.

## Current Local Policy Evidence

- P3-005 retention, P3-006 verified deletion, and P3-007 privacy rights are locally complete. The current gate passes 213 local tests and 244 guarded synthetic PostgreSQL tests across 16 files, with zero leaked temporary schemas or advisory locks.
- P3-006 verifies same-channel requests through authorized human review, atomically tombstones and pseudonymizes linked identities, clears implemented raw event/customer content, retains aggregate evidence, and blocks later raw storage for deleted identities.
- The restore primitive reapplies all covered active tombstone key versions in bounded batches and refuses a pass on missing keys, failed/nonzero evidence, remaining matches, changed revision material, or an incomplete concurrent scan.
- P3-007 exact intake, reviewer holds, redacting one-run access collection, typed correction boundaries, category-scoped opt-out/re-opt-in, and evidence-preserving rollback pass locally. Security scan `1f4a68bb-5290-480f-89f4-6297d840ec87` reviewed 15 production surfaces; its five medium findings in the original range all have guarded remediation tests.
- No Meta/Manifest/provider deletion, access delivery, export/offline/archive cleanup, notification delivery, actual backup creation/restore/promotion, Ubuntu redeployment, or production action occurred. Those locations remain pending or belong to P6-004 and later test gates.

## Current Phase 5 Checkpoint

- Approved plan Tasks 1 through 17 and P4-GATE are locally complete: knowledge schema/repository/publication, admin and learning schema, password/MFA/session primitives, PostgreSQL identity, the loopback-only dashboard foundation, proposal-only learning with owner questions, the fail-closed sensitive-data gate, FAQ-first resolution, guarded reply/model decisions, local fail-closed Manifest contracts/client, authoritative customizable model-policy enforcement, and the reviewed synthetic evaluation gate.
- The private service supports reviewed bilingual proposals, provenance, replacements, submit/approve/reject, exact-version publication/scheduling/retirement/rollback, stable retry material, and transactional session/role checks. Public webhook routes remain unchanged.
- Proposal-only learning accepts only applied internal customer events, stores closed content-minimized gap evidence, suppresses groups below the configured distinct-person threshold, inherits the earliest retention deadline, and reuses stable open questions across repeated aggregate runs while allowing a new generation after a terminal answer or dismissal. Aggregation rechecks current privacy holds, deletion state, and purging. Digest cadence, maximum questions, cooldown, repeat ceiling, group threshold, and observation bound are environment-configurable inside approved safety bounds.
- Authenticated knowledge editors answer English/Bangla owner questions through the private dashboard. Each answer creates an append-only answer record and a `support_gap` draft proposal; no review or publication event is created.
- Sensitive inspection is bounded by a supplied policy value and returns only closed safe/redacted/blocked outcomes. Password/authentication, OTP/recovery, API/token/cookie/session, payment/bank, private-key/credential-file, sensitive-incident, ambiguous-redaction, malformed-Unicode, and excessive-input cases fail closed. A single deterministic removal may continue only when an ordinary question remains, using typed value-free markers. Reviewed English/Bangla safe responses are deterministic and model-free.
- FAQ resolution accepts only process-issued prepared text from a successful sensitive-data inspection. Exact reviewed questions, aliases, examples, and intents outrank similarity; equal or close candidates fail closed as ambiguous. PostgreSQL selects at most one strongest alias per currently effective approved bilingual FAQ version through the existing GIN trigram index and a materialized pre-window bound. Review and publication decisions must both be effective at the evaluation time. Minimum similarity, ambiguity margin, and maximum candidates are validated supplied policy values.
- Reply decisions accept only applied customer events, inspect sensitive content before FAQ, and persist exactly one FAQ draft, deterministic safe draft plus escalation, or content-minimized gap. Human pause, open privacy workflow, deletion, content erasure, and retention are rechecked under PostgreSQL locks before persistence. Deletion, restore, and retention erase new content; access export v2 adds allowlisted subject-scoped Phase 4 records. Open active clients use their required annual review boundary while the current conversation lifecycle remains authoritative for erasure.
- Manifest configuration has no operational defaults in source: contact/global rates, concurrency, queue, timeout, tokens, cooldown, provider attempts, response bytes, context, and input are environment-supplied protected ceilings. Effective operational limits take the stricter maximum and longer cooldown across policy, deployment, and verified Manifest sources. The checked-in example keeps every unverified live-state attestation false.
- Manifest request construction accepts only process-issued sanitized text, preserves injection as user data, fixes `model: "auto"`, bounds all content, and emits no tool/provider/fallback fields. Structured output is byte-bounded and strict, with closed rejections for schema, reference, factual grounding, language, secret, URL, and action claims in English/Bangla.
- The Manifest HTTP client accepts only builder-issued requests and snapshots validated settings. It makes exactly one non-streaming POST to the configured private `/v1/chat/completions` endpoint, rejects redirects and tool-call responses, bounds bytes before JSON parsing, never reads/logs error bodies, races transport/body reads against caller abort and total timeout, and returns only closed local outcomes. The loopback fake records structure and booleans only and rejects non-synthetic authorization values.
- Migration eleven stores immutable model-policy versions and append-only submit/approve/activate/retire evidence. Operational and FAQ limits have no database defaults; active policy is unique, provider attempts cannot exceed the architecture ceiling, usage windows are closed and pseudonymous, and leases contain only internal references, closed lifecycle/outcome values, and timestamps. Populated downgrade fails closed.
- Effective policy requires exactly one event-time-active PostgreSQL version plus verified Manifest limits, then intersects policy, protected deployment, and Manifest values field by field. Allowance transactions derive a pseudonymous scope from the authoritative internal contact, serialize rolling 15-minute/24-hour and global UTC-day counts, cooldown, concurrency, queueing, exact replay, and expiry. Eleven model-failure categories persist content-free source-bound escalation evidence.
- The loopback/private policy page is administrator-only and uses live-session authorization, CSRF/origin checks, session-bound signed actions, explicit inputs for every customizable value, and content-free audit. Existing escalation views remain aggregate-only.
- The model stage is reachable only from an authoritative FAQ gap for the same applied event. It re-inspects content, loads bounded effective reviewed facts, acquires one lease, issues at most one tool-free auto request, validates output twice, and rechecks takeover, privacy, deletion, retention, and current publication before storing a fact-linked model draft. Every exhausted, invalid, stale, or failed path creates a reviewed safe draft plus one content-free escalation when policy permits; exact/crash replay cannot issue an unbounded second request.
- The newly authored evaluation corpus contains 35 synthetic cases (18 English, 17 Bangla), covers AC-05/10/21/22/25 and every approved sensitive class, scores all seven declared local-fake invariants at 100%, records 12/12 acceptable self-reviewed scripted outcomes, and has zero critical failures. Negative controls prove the scorer rejects invariant, rating, critical, and provenance failures. This does not claim independent human or real-provider quality.
- Validation on 2026-09-14: `npm run check` passed 473 tests across 39 files plus formatting, lint, strict type checking, build, and the Phase 0 validator; all 345 guarded PostgreSQL tests across 27 files passed. No browser run, deployment, Manifest call, provider call, external mutation, or production action was performed. Detailed evidence: `docs/testing/phase-4-evaluation-review.md` and `docs/reviews/phase-4-gate.md`.
- P5-001 is complete under the owner's delegated local approval. The committed architecture and implementation plan select one PostgreSQL intent per source, last-moment policy rechecks, customizable reviewed rate/retry limits, an at-most-once bias for ambiguous dispatch, Graph API `v25.0`, loopback-only adapter evidence, monotonic status handling, and a bounded Messenger echo-correlation hold. No live provider call or deployment was made.
- P5-002 is complete. Implementation-plan Task 1 adds migration 000012 with ten closed PostgreSQL tables for reviewed outbound policy/templates, content-free intents, controlled attempts, rate windows, signed status evidence, Messenger echo holds, and escalation outcomes. Policy values have no database defaults; populated downgrade fails closed; intent sources/account scope, terminal evidence, provider-message correlation, and required `pending_outbound` deletion evidence are guarded.
- Validation on 2026-09-16: the RED migration run failed with migration count 11 and no Phase 5 tables; after implementation, `npm run check` passed 473 tests across 39 files plus formatting, lint, strict type checking, build, and the Phase 0 validator, and all 349 guarded PostgreSQL tests across 27 files passed. No live provider call, deployment, external mutation, customer data, or production action occurred.
- Implementation-plan Task 2 defines closed outbound channel/language/purpose/state/result contracts; strict numeric policy and deployment-bound parsing; stricter two-source limit intersection; exact Graph `v25.0`; production-only `https://graph.facebook.com`; opt-in loopback HTTP fake mode; and redacted, non-serializing credential wrappers. Every bound and account credential is explicit, and the checked-in environment example contains blank keys only.
- Task 2 validation on 2026-09-16: the required RED run failed only on missing outbound modules; after implementation, `npm run check` passed 530 tests across 41 files plus formatting, lint, strict type checking, build, and gate validation. No provider, network, deployment, or external call occurred.
- Implementation-plan Task 3 adds administrator-authorized, request-key-idempotent PostgreSQL repositories for reviewed outbound policy and fixed zero-variable WhatsApp templates. Separate submit, approve, activate, retire, and event-time resolution paths preserve append-only evidence, enforce exact account/category/locale/template scope, intersect policy with protected deployment bounds, serialize concurrent activation, reject conflicting replay and invalid transitions, and roll failed transactions back fully.
- Task 3 validation on 2026-09-16: the required RED runs failed only on missing outbound modules; after implementation, `npm run check` passed 552 tests across 42 files plus formatting, lint, strict type checking, build, and gate validation, and all 360 guarded PostgreSQL tests across 29 files passed. No provider, network, deployment, external mutation, customer data, or production action occurred.
- Implementation-plan Task 4 adds a pure fail-closed eligibility contract and a transactional PostgreSQL intent store. It derives conversation, identity, channel/account, policy, and template authority server-side; locks and rechecks source, pause, echo hold, privacy, deletion, suppression, exact consent, Meta's fixed 24-hour response window, retention, and active-client review state; creates one content-free intent under exact replay and concurrency; and records content-free terminal enqueue escalations. Marketing purposes map to the existing closed Phase 3 consent categories, while marketing opt-outs do not suppress customer-support replies.
- Task 4 validation on 2026-09-16: the required RED runs failed only on missing eligibility/store modules; after implementation and concurrency review, `npm run check` passed 576 tests across 43 files plus formatting, lint, strict type checking, build, and gate validation, and all 369 guarded PostgreSQL tests across 30 files passed. No provider, network, deployment, external mutation, customer data, or production action occurred.
- Implementation-plan Task 5 adds bounded SKIP LOCKED claims; process-issued leases; final locked eligibility checks; atomic reservations for linked-contact 15-minute/24-hour, channel-account minute, global-minute, and global-UTC-day limits; exact attempt/result replay; bounded definite-rejection retry; terminal exhaustion; and safe pre/post-dispatch expiry. Self-review corrected dispatch replay ownership, in-flight authorization replay, provider Retry-After evidence, and cross-channel contact scope before checkpoint.
- Task 5 validation on 2026-09-16: the required RED run failed on the missing work-store module; added RED regressions exposed wrong-owner replay and channel-identity-scoped contact limits before fixes. The final focused PostgreSQL file passed 14/14 tests; `npm run check` passed 576 tests across 43 files plus formatting, lint, strict type checking, build, and gate validation; all 383 guarded PostgreSQL tests across 31 files passed. No provider, network, deployment, external mutation, customer data, or production action occurred.
- Implementation-plan Task 6 adds strict WhatsApp text/fixed-template and Messenger text builders. Requests have exact Graph `v25.0` account paths, closed frozen JSON bodies, bounded Unicode text, no caller URL/credential/metadata fields, content-free inspection/serialization, and process-local WeakMap/WeakSet provenance that copied or forged objects cannot reproduce.
- Task 6 validation on 2026-09-16: the required RED run failed only on the missing request-builder module; the focused suite passed 24/24 tests. The full repository gate passed 600 tests across 44 files plus formatting, lint, strict type checking, build, and gate validation. No HTTP request, provider call, network access, deployment, external mutation, customer data, or production action occurred.
- Implementation-plan Task 7 adds a one-attempt Meta client with exact issued-request provenance and account binding, redirect rejection, total timeout and caller cancellation, bounded streaming success reads, strict per-channel response schemas, reviewed 400/429 definite classifications, delivery-unknown closure for uncertain outcomes, and closed logging. Its test-only HTTP server binds only to loopback, accepts only an obvious synthetic credential sentinel, and records shape/outcome metadata rather than content or authorization values.
- Task 7 validation on 2026-09-17: the required RED run failed on the missing client module; the focused suite passed 23/23 tests. `npm run check` passed 623 tests across 45 files plus formatting, lint, strict type checking, build, and gate validation. HTTP tests used only the loopback synthetic fake. No live Meta/provider call, external network access, deployment, external mutation, customer data, or production action occurred.
- Implementation-plan Task 8 adds the bounded worker composition and an in-transaction dispatch-material bridge from authoritative identity/draft/template state. The worker claims, authorizes, builds only closed requests, commits dispatch-start before I/O, makes at most one adapter call, persists closed outcomes, performs no claim for a pre-canceled batch, and never compensates after uncertain post-dispatch failure. Send-time authorization now rejects channel-incompatible support length before creating an attempt.
- Task 8 validation on 2026-09-17: the required unit RED run failed on the missing worker module; a later send-time length regression failed before its guard was added. The focused unit suite passed 9/9 tests and the focused worker/work-store PostgreSQL suites passed 28/28 tests. `npm run check` passed 632 tests across 46 files plus formatting, lint, strict type checking, build, and gate validation; all 397 guarded PostgreSQL tests across 32 files passed. Tests used only synthetic data and injected providers. No live Meta/provider call, external network access, deployment, external mutation, customer data, or production action occurred.
- Implementation-plan Task 9 adds canonical stable-ID Messenger delivery normalization and PostgreSQL-authoritative status correlation. Exact channel/account/provider-message scope prevents cross-account and cross-channel collisions; admitted events append immutable status evidence; success advances `provider_accepted < sent < delivered < read`; failure cannot downgrade delivered/read and may be corrected by later delivered/read evidence. Applied and uncorrelated statuses remain outside conversation and retention activity.
- Task 9 validation on 2026-09-17: required RED runs failed on unsupported Messenger delivery items and the missing status repository. The focused Messenger suite passed 5/5 tests; the focused processor/status PostgreSQL suites passed 36/36 tests, including every permutation of sent/delivered/read/failed, exact/logical replay, unknown/collision cases, correction, and retention immutability. `npm run check` passed 634 tests across 46 files plus formatting, lint, strict type checking, build, and gate validation; all 403 guarded PostgreSQL tests across 33 files passed. Only synthetic fixtures and the local PostgreSQL test container were used. No live Meta/provider call, external network access, deployment, external mutation, customer data, or production action occurred.
- Implementation-plan Task 10 adds a bounded Messenger echo-correlation hold at locked dispatch start, with its lifetime derived from the effective customizable provider timeout. Exact channel/account/provider-message matches become `service_echo_correlated`; echo-before-response remains unapplied until provider evidence arrives; unknown, expired, text-only, or mismatched echoes use the existing provider-time human pause. Conversation-first dispatch locking permits only one in-flight hold and refuses dispatch if a real staff echo wins the start race; open holds block later enqueue/send, and provider-result correlation runs after its state commit to avoid reversed event/attempt lock order.
- Task 10 validation on 2026-09-17: required RED runs first produced a false `business_echo_paused` result for echo-before-response and exposed the missing correlation service; focused debugging also caught SQL type inference and PostgreSQL microsecond-boundary regressions before correction. The final echo matrix passed 11/11 tests, the focused migration/processor/work-store/correlation gate passed 89/89, `npm run check` passed 634 tests across 46 files plus formatting, lint, strict type checking, build, and gate validation, and all 414 guarded PostgreSQL tests across 34 files passed. Only synthetic fixtures and the local PostgreSQL test container were used. No live Meta/provider call, external network access, deployment, external mutation, customer data, or production action occurred.
- Implementation-plan Task 11 adds one transaction-local outbound privacy reconciler shared by deletion, all-linked marketing opt-out, and retention. It locks eligible intents and active attempts in ascending internal-ID order, cancels pending/leased/authorized-before-dispatch work with closed reasons, abandons authorized attempts before dispatch, converts `dispatch_started` to `delivery_unknown` without retry, preserves delivered content-free attempt/status evidence, erases dependent drafts, and completes deletion's `pending_outbound` location only after reconciliation. Re-opt-in cannot revive terminal canceled intents, retention preserves lifecycle anchors, older isolated restore schemas receive the only table-existence guard, and access export retains its existing fixed allowlist without outbound provider/request evidence.
- Task 11 validation on 2026-09-20: the required RED runs exposed uncanceled deletion, marketing, and retention intents. The final five-file privacy/lifecycle gate passed 50/50 guarded PostgreSQL tests; `npm run check` passed 634 tests across 46 files plus formatting, lint, strict type checking, build, and gate validation; and all 417 guarded PostgreSQL tests across 35 files passed. Only synthetic fixtures and the local PostgreSQL test container were used. No live Meta/provider call, external network access, deployment, external mutation, customer data, or production action occurred.
- Task 12 consolidates the Phase 5 architecture, local/loopback test evidence, private operations contract, acceptance/threat updates, and gate decision. Focused evidence is 164/164 unit tests across 8 files and 68/68 PostgreSQL tests across 8 files; complete evidence is 634/634 local tests across 46 files and 417/417 guarded PostgreSQL tests across 35 files, with zero leftover test schemas or advisory locks.
- P5-002 through P5-005 and P5-GATE are locally complete under delegated approval. The gate is local-only and unblocks P6-001 design/planning; no worker is packaged or deployed, and no live Meta/provider/test-asset action is authorized.

## Current Phase 6 Planning Checkpoint

- The project owner approved the written Phase 6 specification on 2026-10-04: `docs/superpowers/specs/2026-09-21-phase-6-hardened-local-operations-design.md`.
- The implementation plan `docs/superpowers/plans/2026-10-04-phase-6-hardened-local-operations.md` was approved for sequential implementation on 2026-10-18. Its 16 tasks package role-specific runtimes, mounted secrets, hardened layered Compose, private networks, encrypted backup/restore, current deletion checkpoints, inherited-work quarantine, host timers, dashboard/journal health, private n8n contracts, local failure evidence, and a concrete server deployment handoff.
- First-version operational incidents use the authenticated private dashboard and sanitized host journal independently of n8n. Direct Telegram, SMTP, and external uptime notifications are deferred by owner; an offline host cannot notify while offline.
- Backup creation uses only a public encryption recipient; a separate verification/restore job holds the private identity. Restore must import a complete current deletion checkpoint, including post-archive deletions, and fence inherited external-effect work before application attachment.
- Deployment destination remains the existing Ubuntu server at `192.168.10.40`, with exact committed revisions pulled into `/home/redwan/apps/fcd-support`. The exact revision/action/rollback handoff still precedes server mutation; external execution starts disabled.
- P6-001 is complete; the first implementation checkpoint follows below. No server access, provider call, or deployment occurred during planning.

## Phase 6 Implementation Progress

- The project owner approved the 16-task plan for sequential local implementation on 2026-10-18 (Asia/Dhaka). P6-001/P6-002/P6-003 are locally complete; P6-004 is in progress.
- Task 1 adds per-role mounted-secret loading, bounded regular-file reads, Linux ownership/permissions and symlink checks, redacted secret-bearing environments/keyrings, strict rotated privacy key decoding, and explicit configurable operation/resource bounds. External execution flags remain false in examples. The normal backup role cannot receive a decryption identity.
- Validation: the required first RED run failed on the three absent modules. The focused Linux suite passes 99/99 as the unprivileged Node user, including permission/symlink tests. The full Windows `npm run check` passes formatting, lint, strict type checking, 731 tests across 49 files (two Linux-only skips), build and authority validation. No live provider call, server access, deployment, or production action occurred.
- Task 2 adds migration 000013 and bounded operations persistence: closed health/incident history, same-transaction real-session administrator acknowledgement, exact replay/concurrency handling, backup catalogue state and immutable material, deployment evidence, append-only audits, and populated downgrade refusal. Historical downgrade tests now target migration versions explicitly so newer migrations do not change the guard they exercise.
- Task 2 validation: focused PostgreSQL gate 50/50 across two files; complete PostgreSQL gate 433/433 across 36 files; complete local gate 731 passed across 49 files with the same two Windows/Linux-only skips. Cleanup reports zero test schemas and advisory locks. Backup rows are synthetic metadata only; no encrypted archive, restore, live service integration, or deployment occurred.

- Task 3 adds migration 000014 and durable PostgreSQL processing stages, lease-owned transitions, restart reconciliation, minimized notification delivery work/attempts, configurable retry bounds and source/delivery quarantine compatibility. All four notification types retain their existing privacy, consent and escalation authority. Retention proof is required, and each work item keeps its original deadline even if source retention later extends.
- Task 3 validation: the complete PostgreSQL suite passes 459/459 across 38 files; the local gate passes 731 tests across 49 files (two Linux-only skips). Added regression tests were observed failing before correction; populated downgrade refuses and empty rollback/reapply passes. No live n8n/provider traffic, server access or deployment occurred.

- Task 4 adds single-batch polling, claim-stop and bounded drain/abort (even for non-cooperative callbacks), fresh schema/revision/policy/dependency readiness with a required timeout and clock, disabled outbound/notification handling, model-disabled FAQ readiness, and atomic content-free heartbeat files for the runtime tmpfs. A stopped lifecycle cannot restart in-process; a fresh process and durable leases handle recovery.
- Task 4 validation: 32/32 focused lifecycle/readiness tests pass on Windows and as node in isolated Linux; the complete local gate passes 763 tests across 51 files with the same two Linux-only skips. Formatting, lint, strict typing, build and authority validation pass. The last complete PostgreSQL checkpoint remains Task 3's 459/459; Task 4 changes no database schema. No live server, provider or deployment action occurred.

- Task 5 adds the recoverable reply daemon and closed worker entrypoint: stable per-event stages, current transition clocks, exact privacy/STOP MARKETING intake before ordinary decisions even after application restart, deterministic language selection, existing guarded FAQ/model services, safe disabled-model escalation, prior-intent recovery and bounded pool shutdown. Reply composition receives no Meta credentials and never sends outbound messages itself.
- Fuzzy FAQ thresholds remain active reviewed PostgreSQL policy intersected with protected configurable floors/caps. Without policy, only exact reviewed FAQ can answer; a gap still produces safe escalation. Separate non-secret reply outbound ceilings avoid loading provider credentials, and explicit Manifest limit attestation is required only when model execution is enabled. External flags remain false in examples.
- Task 5 validation: `npm run check` passes 778 tests across 52 files (two Linux-only skips), formatting, lint, strict typing, build and authority validation; PostgreSQL passes 476/476 across 39 files; focused Linux/non-root tests pass 146/146 across six files without skips. Cleanup finds zero test schemas/advisory locks. The composed daemon and local fake Manifest crash-repair tests pass; invalid worker role exits 1 with a closed log only. No live provider, SSH/server, deployment or production action occurred.

- Task 6 adds file-backed webhook/admin entry wrappers, automatic receipt keyring loading, graceful API signal handlers, explicit private-container admin mode with separately approved loopback browser/SSH-forward port, an outbound daemon and closed maintenance CLI. Existing synchronous constructors remain available to private/test callers. The notification command remains fail-closed until Task 14 implements its factory.
- Outbound processing samples fresh time before authorization, dispatch start and result persistence; dispatch start also rechecks current policy, retention, privacy, consent and service-window eligibility. Maintenance invokes existing retention, reviewed verified-deletion, bounded model/outbound lease recovery and aggregate/question-digest services. Explicit stable cutoff/windows and supplied policies avoid enabling defaults; external privacy locations cannot be marked complete by these jobs.
- Task 6 validation: complete local gate 792 tests across 54 files (two Linux-only skips); PostgreSQL 483/483 across 40 files; Linux/non-root focused gate 190/190 across 12 files without skips. Tests cover mounted composition, browser-origin isolation, simulated signal drain, service-window crossing, bounded expiry, maintenance replay and the enabled outbound daemon with one injected synthetic transport call. Invalid operations CLI exits 1 with a fixed event only. No live provider call, server access, host signal/restart experiment, deployment or production action occurred.

- Task 7 adds revision-labelled application, operations, PostgreSQL and tunnel image contracts. Existing Node/PostgreSQL digests remain unchanged; the Cloudflare digest is unchanged and its descriptive tag now matches verified version 2026.8.2. Operations pins the official linux/amd64 age 1.3.2 archive/checksum and checks it before extraction; copied Node shared libraries and all tool versions are executed during build. Build context is default-deny. Non-root entrypoints enforce image-seeded volume ownership/modes without repair or elevation. See `docs/operations/image-contract.md`.
- Task 7 validation: fresh `npm run check` passes 803 tests across 55 files with the same two Linux-only skips; focused image/deployment assertions pass 15/15. Four isolated candidate images build and their version/negative entrypoint checks pass. Disconnected read-only PostgreSQL initializes as UID 999; incompatible owners/modes are refused; kernel 0600 checks separate UIDs 1000/999/65532. Fixtures are removed. These are local candidate-parent-labelled builds, not proof of a deployed clean revision. The latest full PostgreSQL regression suite remains Task 6's 483/483. No SSH, live tunnel/provider, deployment or production action occurred.

## Launch Blockers

- Task 11 now has protected selection, immutable used-volume history and retained image bundles. Its private adapter sets Compose volume interpolation, and the host collector binds physical identity and original volume labels/creation time to the record before/after probes. Stale configuration, missing pointers, changed records and unsafe runtime phase/revision/write exposure refuse. These metadata records do not authorize attachment. Controlled outage/startup, locked promotion/switching, retained-image compatibility, uncertainty/socket recovery and public wiring still remain; no server change occurred.

- Task 11 now binds compiled backup/checkpoint jobs to independently supplied cluster/database identity. A verified exported snapshot binds `pg_dump` to the source; the exporter closes before manifest publication, and checkpoint identity is checked on its export-owning transaction. The internal database stage helper orders prepare/verified backup/migrate/converge/register and checks physical identity plus container/start identity around every job. Controlled outage/startup wiring, persistent volume selection, restore switching, retained rollback, uncertainty reconciliation and public wiring still remain; no server deployment or live-service action occurred.

- Task 11 now has a protected persistent job journal and a stopped-create/verify/record/start lifecycle. Lost acknowledgements, failed cleanup and a killed controller preserve the record; preflight blocks pending jobs before Docker access. Exact owned-container cancellation cannot silently authorize replay. Operation archives must be pre-provisioned external volumes. Native validation passes 347 units/68 integrations, including 40 new journal/lifecycle cases; code gate passes 1,045 tests with 146 platform skips. The new controller is internal: operation-specific uncertainty reconciliation, bootstrap orchestration, selected-volume switching, retained rollback and public wiring remain. No server deployment or live-service action occurred. See `docs/operations/runtime-deployment-safety.md`.

- Task 11 now has a separate PostgreSQL-only metadata proof for the stopped-application bootstrap stage, plus bounded physical system-identifier reading with before/after container/image identity checks. Runtime verification passes the sampled identifier into the database- and principal-bound SQL job. Native shell cases use a fake Docker transport; the fixed control parser also matches actual local test SQL identity. Bootstrap ordering, durable job cancellation/state, safe restore switching, retained rollback and public wiring remain unfinished. Public commands stay disabled; no server deployment occurred. See `docs/operations/runtime-deployment-safety.md`.

- Task 11 now independently collects narrowed runtime Docker metadata around SQL, local HTTP, admin Unix-socket/TCP-absence and heartbeat probes. A networkless compiled validator checks exact private Compose/resource/mount/network expectations, configured ingress peer, socket identity and foreign/stopped container binds. The native orchestration cases use a fake Docker transport with real compiled validation and Unix filesystem fixtures; actual local Docker projection shapes also pass. The public command integration remains disabled pending bootstrap ordering, locked restore switching, retained rollback and ambiguous-job cleanup. Task 11 and Tasks 12–16 are not complete; no server deployment occurred. See `docs/operations/runtime-deployment-safety.md`.

- Task 11 has an explicit owner-only bootstrap profile and compiled prepare/converge command. Native empty/admission fixtures prove backup encryption and separate verification before nonsuperuser migration, then runtime grant convergence; the old receipt survives. The actual connection must match the independently supplied cluster identifier. Runtime roles cannot access business tables during preparation, and ordinary jobs receive no bootstrap owner URI or role-password files. Public bootstrap orchestration, full runtime inspection, locked restore/promotion switching, retained rollback and completed socket recovery still remain before Task 11 closes. Tasks 12–16 and P6-GATE are outstanding; no server deployment occurred. See `docs/operations/runtime-deployment-safety.md`.

- Internal `verifyPromotion` now generates fresh checkpoint/gate/binding evidence rather than reusing the historical pass. It binds the current source epoch/monotonic sequence and actual SQL target to that pass, retains source freezing through final evidence, requires bounded host-quiescence assertions and leaves recovery holds unreleased. Explicit stale-socket recovery has separately tested filesystem and internal host-control legs; no public handler is enabled. Host quiescence/inspection/switch wiring, ambiguous-job cancellation, full runtime verification, bootstrap and retained rollback remain Task 11. Tasks 12–16 and P6-GATE are still outstanding; no server deployment or live-provider action occurred.

- Task 11 now has a read-only host collector that samples actual Docker resources twice and checks isolated network membership, stopped/live volume users, image IDs/revisions and PostgreSQL hardening. Its bounded validator runs by immutable image ID without a network, mounts, Docker socket or secrets. Real local Docker fixtures cover substitution and attachment refusals. This supplies host facts only: it is not wired into a locked promotion command, does not prove source quiescence and never authorizes attachment. Fresh `verifyPromotion` and safe switching, full runtime/socket checks, bootstrap wiring, retained rollback and socket recovery remain unfinished. See `docs/operations/runtime-deployment-safety.md`; no server/SSH or live-provider action occurred.

- Task 11 composes full encrypted restore, actual connection-bound forward migration, frozen-source current checkpoint import, inherited-work quarantine/hold, all-active-key bounded erasure and immutable restore evidence (migration 000016). Missing rotated keys, stale checkpoints, target-only time boundaries and batch exhaustion refuse without a partial target pass. A real native RED caught a substituted migration pool creating objects on the synthetic source; identity validation now belongs on the DDL-owning connection before migration. This remains internal historical database evidence, not a host promotion or `ready` token. Volume/network/image fields remain controller inputs to that library; the later Docker inspector above still needs locked wiring. Fresh `verifyPromotion` and safe switch, bootstrap wiring, full runtime verification, retained rollback and socket recovery remain Task 11. No server or external-service action occurred. See `docs/operations/runtime-deployment-safety.md`.

- The earlier Task 11 SQL/stream checkpoint (2026-10-23 Asia/Dhaka) proved real full-archive restoration and old-admission forward migration against an isolated local Docker PostgreSQL cluster. Its current checkpoint/deletion composition gap is addressed by the later checkpoint above; independently inspected host binding, fresh promotion and the other host controls remain unfinished. Public commands stay disabled. Historical validation is retained in `docs/operations/runtime-deployment-safety.md`; no server or external-service action occurred.

- Task 11 remains in progress after its guarded prerequisite checkpoint on 2026-10-19 (Asia/Dhaka). The new role bootstrap converges table/column/sequence/function permissions and rejects foreign scopes, memberships and credential reuse; real logins exercise the private repositories and real pg_dump/age/checkpoint operations. Protected literal host configuration, exact revision/image/local-daemon checks, socket/volume separation, flock, controlled-outage ordering and a packaged-schema-bound forward migrator are tested locally. A real mid-migration conflict proves earlier DDL/registry entries roll back atomically. Compiled CLI cases cover migration, revision evidence and opaque backup references without loading an identity into backup. Code gate: 916 passed/52 platform skips; native gate: 87 units and 48 integrations passed. This is not a full deployment/restore pass: public commands fail closed while required runtime-verification and recovery handlers are absent. Complete restore/target binding/promotion, bootstrap-profile wiring, actual container/socket verification, retained rollback and explicit stale-socket recovery remain next within Task 11. See `docs/operations/runtime-deployment-safety.md`.

- Task 10 is locally complete at `1962a1cf0f7056d68f64df0737501c82f1653aea`, with its clean-source combined gate passing. Migration 000015 adds durable deletion clocks, signed checkpoint/import evidence, immutable source quarantine and separate recovery holds/reviews. Actual age transfer re-applies a current deletion onto an independent older-state fixture and rejects source changes, stale/time-bound evidence, corrupt/missing ciphertext and signed payload count/key mismatches. Old active key versions survive import. Held source transactions prevent promotion-time deletion writes; new work stays blocked until current administrator reconciliation is recorded. Inherited dispatch becomes unknown rather than retried, and existing notification attempts survive quarantine. Full code: 909 passed/22 platform skips; ordinary PostgreSQL: 494 passed/11 native-only skips across 44 files; native: 50/50 units plus 11/11 real crypto/CLI cases; clean-source focused policy/fence gate: 62/62. Zero test schemas/locks and labelled backup resources remain. This is not a full database restore or deployment. Task 11 must bind current proof, least-privilege roles, isolation, human approval and final promotion checks. See `docs/operations/restore-safety.md`.
- Task 9 is locally complete at `a627a844545a467d0ce4013c9f9fa08f102e5e89`, with a passing clean-source task-done gate. Public-recipient custom-format backups stream through pinned age without persistent plaintext or an identity read. Signed atomic publication, ciphertext integrity, separate decrypt/list verification, bootstrap before operations tables, PostgreSQL catalog registration, concurrent/replayed scheduled slots and conservative independent UTC retention pass. A self-review collision-cleanup defect was reproduced RED and fixed so only exclusively created directories are removed. Complete code gate: 898 passed/22 platform-specific skips across 60 files; native/Linux backup gate: 40/40 plus 1/1 real synthetic PostgreSQL/compiled CLI test on a dedicated archive volume; ordinary PostgreSQL regression: 484 passed/1 separately covered native-toolchain skip across 42 files. No full isolated restore or restore_verified promotion is claimed. Host flock/timers remain Tasks 11/12; Task 10 current deletion checkpoints and inherited-work quarantine is next. See `docs/operations/encrypted-backups.md`.
- Task 8 is locally complete at clean committed source `c9a904bab4d11e926dd4285c7ccad6f2220375c9`: strict Unix admin lifecycle/configuration/health, 0600 owner-only socket, no admin TCP publication/management bridge, narrow protected bind policy and realistic network boundaries pass. Complete code gate: 861 passed/19 Linux-only skips across 58 files; separate node/Linux gate: 47/47 including every skipped case; PostgreSQL: 484/484 across 41 files. Four renders, nine allowed/20 denied probes, kernel UID separation and negative controls pass; task-done records completion from original base 6df0111. Zero test schemas/advisory locks or generated topology resources remain. The earlier measured TCP failure and its masking-fixture correction remain documented. P6-002/P6-003 close locally; Task 9 is next. No actual Ubuntu bind/SSH, provider, deployment or production evidence is claimed.
- Task 7 evidence correction: its full code gate ran before final documentation formatting. Prettier's padded tracker cells then exposed a single-space assumption in the Phase 0 validator. Task 8 adds whitespace-insensitive fixed-status-column parsing, with 8/9 RED then 9/9 GREEN including all existing authority/evidence negative controls. The fresh Task 8 complete code gate is the current passing evidence; no planning or production authority requirement changed.

- The admission-only test deployment is approved and running under a narrow exception. Outbound messaging, models, n8n actions, live customer data, and production deployment remain unauthorized.
- P3-GATE passed on 2026-09-01 at validated revision `bb95803`. The project owner approved the major P4-001 architecture decisions and delegated the remaining local Phase 4 design/implementation approvals on 2026-09-01. P4-002 through P4-006 and the local P4-GATE now pass. Live recording-off, private-network, provider, test-asset, outbound, and production evidence remains governed by later gates.
- Phase 0 is evidence-complete: the threat model, acceptance matrix, and planning-only gate review are recorded in `docs/security/threat-model.md`, `docs/testing/acceptance-matrix.md`, and `docs/reviews/phase-0-gate.md`. This closes architectural planning only; every `PARTIAL`, `PLANNED`, or `BLOCKED` acceptance row remains a launch blocker. The project owner authorized reversible local development through Phase 5; exceptions and current contracts are tracked in `docs/TODO.md`.
- Meta test callback and subscription flows are validated only for development-mode test assets. App review, live permissions, and production assets remain unvalidated.
- WhatsApp coexistence for the production number has not been confirmed.
- The dedicated Manifest host harness/key and `auto` model are verified privately, but the application-network route, recording-off state, and explicit provider fallback/limit behavior remain untested.
- The WhatsApp test token was expired at inventory time; the app remains development/role-scoped, and runtime Graph `v25.0` versus webhook-sample `v26.0` requires an approved version/support decision.
- n8n's audit found no `fcd-support` public-API dependency, but owners of historically used API keys must be identified before revocation or disablement.
- Website privacy and support wording must disclose AI assistance, external inference, retention, deletion, and marketing consent before production launch.
- Actual encrypted backup/restore procedures and deployed human-takeover behavior must still pass their acceptance tests; the local restore-gate primitive alone does not satisfy P6-004.

The current tracker action is P6-004, following the approved implementation
plan within Task 11 after its role/preflight/migration, isolated SQL/stream and
composed database-reconciliation checkpoints. Complete independent host target
inspection/quiescence wiring and safe promotion/switching; internal `restored` or
`deletion_verified` evidence and the internal fresh verifier's result are not
transferable attachment authorization.
The owner-approved socket/SSH specification and plan are implemented locally;
actual Ubuntu/SSH and all live
Meta, Manifest, network, deployment, test-asset, and production
actions remain separately gated. P1-GATE remains a separate explicit review
record.

## First Session Checklist

1. Read `docs/PLAN.md`, `AGENTS.md`, and this file.
2. Inspect Git status and preserve unrelated changes.
3. Read `docs/TODO.md` and select the first unblocked task whose dependencies are complete.
4. Use `docs/operations/preflight-inventory.md` for current Manifest, Meta, n8n, and Cloudflare readiness; repeat external inspection only when the tracker requires it, without exposing secrets or modifying production assets.
5. Implement lifecycle behavior only from `docs/architecture/data-lifecycle.md` and do not treat evidence-complete inventories as implementation or production readiness.
6. Deploy to the test-number environment only after all local phase gates pass and the exact external actions receive approval.
