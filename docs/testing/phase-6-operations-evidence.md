# Phase 6 Operations Evidence

This is a working Task 15 evidence index, not a P6 gate pass. Tasks 1–10 are
complete; the complete Task 11 host contract, final Tasks 12–14 integration,
interruption matrix, whole-phase review and server handoff still need closure.
Keep component, deployed-host and live-service results separate.

## Executed real-server checkpoint

At exact deployed source `a6de436`, the full private controller reached READY
on schema `000016` with healthy PostgreSQL/API/admin/reply actors. Public verify,
HTTP 403/404/401, Unix `/login` 200 and socket `1000:1000:600` passed. A real SSH
client-loopback-to-server-Unix forward passed login 200 and unauthenticated
operations redirect 303; the owned forward then closed. Daily/monthly scheduled
backup plus replay kept exactly three signed archives. A current checkpoint
export completed. Restore refused during source drain, before actor stop or
target creation; healthy source actors and uncertain selection remain preserved.
Actual Docker projection regression reproduces a doubled mount separator.
Full restore/switch and the remaining interruption/recovery matrix are still open.

The controller smoke harness now has a separate `--ephemeral-ci` mode for
disposable GitHub runners. It requires the Actions context, a fixed protected
UID/GID-1000 checkout/root and an initially empty daemon. The server mode retains
its existing exact server path and admission-preservation checks. The workflow
uses a pinned Node toolchain, copies credential-free source into that protected
root, and exercises real deploy/verify/HTTP/socket behavior with only generated
fixtures and disabled providers. No protected host logs or generated secrets are
uploaded. Mode-context refusal failed first; eleven focused tests, formatting,
lint and strict typecheck pass. A workflow definition alone is not execution
evidence: record its actual result after push. The intentionally retained test
stack exists only until the disposable runner is destroyed.

The exact action records, revisions, failures and scoped cleanup are in
`../operations/phase-6-server-deployment.md`. On the approved Ubuntu server,
authored synthetic fixtures passed:

- 1,714 unit cases with 324 native-only skips across 113 files;
- 1,100 native operations units across 49 files;
- 139 native PostgreSQL cases with one separately covered restore-only skip;
- 171 restore units and 47 real two-cluster PostgreSQL cases; and
- 619 ordinary PostgreSQL cases with 52 complementary native-only skips.

Unit/native source was `83978fc`; the ordinary runner ownership fix was verified
at `3f8783f`. Both temporary projects reached zero schemas, generated roles,
advisory locks and project Docker resources. Retained admission container IDs,
start-times and running states matched. No raw business data, provider call,
production asset, existing volume or tunnel change was part of these tests.

All unit, PostgreSQL/native and CodeQL workflows passed at `99c9306`. This
corroborates reproducibility on fresh GitHub runners; it does not substitute
for actual installed-runtime or live test-asset evidence.

## Failure and authority coverage

| Boundary | Executable evidence | Current limit |
| --- | --- | --- |
| PostgreSQL authority/readiness and worker stop | `runtime-readiness`, `role-runtime`, reply/outbound/notification runtime tests and PostgreSQL stores | Component checks pass; installed-host outage/restart matrix remains open |
| Manifest timeout, unsafe output, limits and tool isolation | Manifest/model/sensitive-data/FAQ test suites in the full code gate | No live Manifest call or recording-off attestation in this checkpoint |
| Meta ambiguous outcome and replay | Outbound attempt/work-store/integration suites, provider fakes | No real test-device send or live manual-echo acceptance in this checkpoint |
| Private n8n outage, signed retry and deletion cancellation | `n8n-client`, notification runtime/work/flow/privacy-grants suites | Fake peer plus real PostgreSQL pass; live n8n remains disabled |
| Health unavailable/stale and authenticated incident actions | Health collector/main and admin operations unit/PostgreSQL suites | Host observations exist; installed health timer and complete outage matrix remain open |
| Encrypted stream, full tmpfs, corruption and incomplete publication | Backup/retention unit suites and real encrypted-backup integration | Native component checks pass; complete installed-host storage-failure matrix remains open |
| Current tombstones, source freeze, quarantine and recovery hold | Deletion-checkpoint and isolated-restore suites | Real two-cluster SQL/crypto passes; installed controller restore/switch remains open |
| Narrow split restore capabilities | Split command/Compose tests, archive-reader and bootstrap grants, real split jobs | No combined source-network/password job is authorized |
| Fresh promotion challenges and changed host/job identity | Promotion handshake/transport/host/controller tests | Native host fakes plus real SQL freeze pass; full deployed switch/interruption matrix remains open |
| Deployment lock, immutable intent, journal uncertainty and exact retained rollback | Operations job/state/first-boot/controller/drain/converge/startup tests | Native filesystem and fake-Docker sequencing pass; actual complete host lifecycle remains open |
| Admin crash, stale/substituted socket and explicit recovery | Admin socket/recovery/native script tests | Real Unix socket and compiled CLI pass; actual SSH forward and deployed recovery remain open |
| Revoked session, signed action, CSRF and origin | Real PostgreSQL admin operations/socket suites | Synthetic in-process/Unix transport passes; deployed browser acceptance remains open |
| Revision-pinned schedules, catch-up and slot replay | Systemd contract and scheduled-job/maintenance tests | Offline/native and SQL checks pass; host timer installation/execution remains open |
| Runtime mounts, images, UID and network boundary | Phase 6 Compose/image contracts and earlier topology/negative probes | Re-run complete topology on final source; no server Docker host port is authorized |

## Acceptance mapping and remaining gate work

- AC-09: real archive/checkpoint/restore components pass. Complete host restore,
  promotion, switching and failure recovery still need evidence.
- AC-18/20: strict code/image/Compose checks and the earlier measured topology
  exist. Final topology, installed private runtime and actual SSH access remain.
- AC-21/25: automated tool/privacy/limit checks pass. Live Manifest recording,
  dedicated harness/provider policy and timeout/fallback behavior remain P7 work.
- AC-26: signed private notifications and PostgreSQL authority pass automated
  checks. Live private n8n consumer testing remains P7 work.

Before a P6 pass, execute the remaining actual controller and interruption
matrix, final complete gates and topology, finish runbooks, obtain one fresh
whole-phase review and record all findings/dispositions. Host power outage,
real Meta sends/echo, live provider quality and production checks remain in
their respective P7/P8 gates. Do not convert a component pass into those claims.
