# Private version-one deployment and unfinished work — 2026-11-16

## Current result

The first private preview is deployed and accessible. Application source is
`c2d8225d2a096e2d4f406c35f8ab170a6dad2f80` (package version `0.1.0`). Public
lifecycle deploy and verify passed. API, administrator, reply and PostgreSQL are
healthy; one bounded ingress peer completes the private topology. All 23
unrelated containers were preserved. No application/admin host ports or public
tunnel were created. Model, outbound and notification execution flags are false.

Browser access on the operator computer:
[private administration](http://127.0.0.1:13004/login).
The loopback listener and an established HTTP connection were bound to the SSH
process created by this task; the login response was `200`. This is HTTP access
proof, not a rendered browser/viewport/accessibility audit.

First administrator creation, password/MFA authentication, Origin/CSRF rejection,
all seven existing authenticated pages, logout and revoked-session rejection
passed over the private Unix socket. Credentials and TOTP seed were generated
only in server memory and retained in an owner-only `0600` file under a `0700`
action directory. No secret, OTP, cookie, page body or raw database record was
printed or committed.

The operator can read the protected credentials in their own SSH terminal at
`/home/redwan/fcd-support-v1-admin-20261116/initial-admin.json`; fields are `login`,
`password` and `seed` (TOTP enrollment). Do not paste that file into chat/Git/logs.
The seeded account is a private-preview account; production account/role
provisioning remains separate.

The background SSH forward is local to the current operator computer/session.
After a reboot/disconnect, reconnect with an unoccupied local port using:

```bash
ssh -N -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=yes -L 127.0.0.1:13004:/home/redwan/fcd-support-host-test-v1-c2d8225/socket/admin.sock redwan@192.168.10.40
```

## Owner-authorized retirement

The owner's explicit November 16 decision superseded earlier preservation of all
FCD test deployments, their PostgreSQL/backup/recovery data and FCD timers.
Production WhatsApp registration/assets and unrelated projects stayed protected.
Uncertain old jobs were retired, not declared successfully resolved.

- The operator disabled/stopped all three FCD timers and operation instances;
  Codex independently verified the states before destructive work.
- Retired all 8 old FCD containers, 38 database/backup/restore volumes, 70 networks,
  53 remaining FCD images and 25 historical fixture/action directories. A prior
  narrow cleanup had removed 3 additional unused image tags.
- Post-retirement checks found zero old FCD containers, volumes, networks or image
  tags; unrelated container count remained 23. No global prune, daemon restart,
  unknown-process kill or production-number action occurred.
- Docker free space rose from 11,011 to 21,294 MiB during full retirement,
  approximately 10.0 GiB reclaimed. After fresh builds/deployment it was
  19,147 MiB (about 18.7 GiB free), above the unchanged 12 GiB admission floor.
- Shared non-FCD images/caches, repository source and unrelated resources were
  preserved. Old systemd timer files remain installed but disabled; they are not
  silently retargeted or re-enabled for the new preview.

## Execution provenance and retained failures

1. Initial retirement executor `edc404a` removed five private containers, then
   the legacy API's graceful stop remained unacknowledged after 80 seconds.
   No volumes/networks/images/fixture roots had been removed. The uncertain
   checkpoint remains unchanged.
2. Independently reviewed completion `ccdbd11` bound the exact three remaining
   legacy identities and the five recorded removals. A new one-use action used
   a 30-second Docker stop timeout for those three IDs only, then completed
   retirement. No `rm --force` or old action replay.
3. First deployment prepared the exact clean source, then refused before fixture
   or service creation because restricted PATH omitted the existing Node binary.
   Its uncertain checkpoint remains unchanged.
4. Reviewed R2 `6046d92` preflighted the exact absolute host Node 24.16.0 binary
   for the existing fixture generator only, reused the verified clean source,
   and used a new action root. Application build/runtime remain on the unchanged
   pinned Node 24.18.0 container definitions. Disk/memory, path, namespace and
   image-tag absence checks passed before fresh resources were created.
5. First-admin executor `49f0afb` used the accepted exported bootstrap API with
   stdin-only server-generated credentials, then verified authentication and
   seven existing pages. No historical Python action or old credential was used.

Exact live commands:

```text
python3 -B /home/redwan/fcd-support-v1-executors-20261116/2026-11-16-retire-tests.py --inspect
python3 -B /home/redwan/fcd-support-v1-executors-20261116/2026-11-16-retire-tests.py --retire-all-test-data
python3 -B /home/redwan/fcd-support-v1-completion-executors-20261116/2026-11-16-finish-retirement.py --inspect
python3 -B /home/redwan/fcd-support-v1-completion-executors-20261116/2026-11-16-finish-retirement.py --finish-approved-legacy-retirement
python3 -B /home/redwan/fcd-support-v1-r2-executors-20261116/2026-11-16-private-v1.py --inspect-prepared-source
python3 -B /home/redwan/fcd-support-v1-r2-executors-20261116/2026-11-16-private-v1.py --deploy-prepared-source
python3 -B /home/redwan/fcd-support-v1-r2-executors-20261116/2026-11-16-private-v1-admin.py --create-first-private-admin
python3 -B /home/redwan/fcd-support-v1-r2-executors-20261116/2026-11-16-private-v1.py --verify-prepared-source
```

Do not replay destructive or first-admin commands. Their owner-only intent and
completion records survive on the server. `--verify-prepared-source` is the
read-only public-verifier path after deployment.

## Validation scope

- 33 authored local controls passed: retirement 15, completion 4, deployment 9,
  first administrator 5. Relevant suites also passed on Linux before execution.
- Observed RED controls preceded implementation and the fixes for recreated
  volumes, foreign bind-backed data, line termination, image namespace collision
  and Node preflight. Fresh-context source reviews verified the corrections.
- Phase 0, formatting/forced Markdown formatting, lint, strict typecheck, build,
  runtime dependency audit and heuristic security-policy checks passed during
  preparation. No fresh full four-worker Windows PASS is claimed.
- Live proof covers scoped retirement, fresh private lifecycle verification,
  healthy services, authentication/HTTP routes and owned SSH access. It closes
  neither the full Phase 7 acceptance matrix nor production readiness.

## Still unfinished

1. PR24 ancestor-link and directory-dependency corrections; unresolved solo
   four-worker Windows integration failures; final review/integration of draft
   PR22/23/24. They remain unmerged and are not this deployment's source.
2. Formal P1 gate review record.
3. A separately approved current test tunnel/webhook route and Meta test-asset
   binding. The old connected stack is retired; the new preview has no public
   callback. Current P7-003/P7-004 are BLOCKED despite historical old-stack proof.
4. Signed synthetic probes and content-free database proof tooling; private
   reviewer/resume/privacy/consent/template controls; approved production
   correction handlers; separate role-account provisioning.
5. Reviewed enabled-worker lifecycle and all current T-01–T-11 acceptance:
   independent bilingual scoring, device delivery, signatures/replay/stale
   events, provider fallback, human takeover, consent/privacy, outage/restart
   and encrypted backup/deletion/restore drills.
6. Bind and verify fresh scheduled backup/maintenance/health operations. The old
   timers remain disabled. This preview does not claim fresh backup/restore or
   unattended operations acceptance.
7. Meta permissions/token ownership/coexistence/manual-echo decisions,
   customer-facing disclosures, backup/alert/manual-coverage ownership and a
   separately approved production rollout.
8. Operator inbox/staff lifecycle UI, public Support/Trust Center and direct
   external notifications remain unapproved proposals.

P7-005, P7-GATE and production readiness remain BLOCKED. No live automatic
WhatsApp/Facebook support reply, Manifest call or provider failover is claimed.

## Rollback

Retired test databases/backups cannot be restored from the deleted resources;
that destruction was explicitly owner-authorized. Never reconstruct old outcomes
from missing actors or clear uncertain markers. The new private preview can be
retired only by its exact current identities under a new reviewed action. Do not
replay old constructors or turn providers on as a rollback shortcut. Preserve
production assets and unrelated projects throughout.
