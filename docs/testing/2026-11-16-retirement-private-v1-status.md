# Test retirement and private version-one status — 2026-11-16

## Owner decision

The owner explicitly selected retirement of every FCD test stack, including connected legacy test containers, retained test PostgreSQL/backup volumes, uncertain test-recovery data and the three FCD timers, followed by a fresh private deployment and an unfinished-work record. This supersedes earlier preservation instructions for those test resources. Production WhatsApp registration/assets and unrelated projects remain protected. Old uncertain operations will be retired, not represented as resolved or successful.

## Actual server observations and completed work

- SSH works after the server restart.
- Legacy connected test API/PostgreSQL/cloudflared were healthy on application revision `207a5e6`.
- Private API/reply/PostgreSQL were healthy on `24e5667`; admin was unhealthy/restarting and its Unix socket refused connection.
- Eight FCD containers and 23 unrelated containers were present; 38 FCD volumes and multiple historical test networks remain.
- Previous narrow cleanup removed three unused/unreferenced test image tags and preserved all existing containers and the held journal. Docker filesystem free space increased from 10,505 to 11,011 MiB (approximately 506 MiB reclaimed). No volumes were deleted.
- Noninteractive sudo is unavailable. The three FCD timers remain active/enabled at the latest read-only check. Operation instances were failed/inactive.
- Full retirement has NOT executed. Fresh version-one deployment has NOT executed.

## Prepared and verified implementation

- Isolated branch: `codex/retire-tests-private-v1`; primary checkout/main and PR22/23/24 are unchanged.
- `2026-11-16-retire-tests.py`: one-use full test-retirement executor, binds the observed eight actor names and 38 volume names, checks scheduler inactivity, foreign consumers, shared images, root aliases and foreign volume bind-backed data; uses exact non-force Docker actions and private intent/checkpoint records. The current Docker identities are captured and rechecked immediately before mutation.
- `2026-11-16-private-v1.py`: fresh private-disabled deployment of accepted application `c2d8225d2a096e2d4f406c35f8ab170a6dad2f80`, using a new immutable source checkout, fresh fixture/secrets, pinned build definitions, disjoint network allocation and public lifecycle deploy/verify entrypoints. Requires completed retirement, unchanged 12 GiB disk / 2 GiB memory floors, absent target paths/resources/image tags, false model/outbound/notification flags and no published admin/application ports.
- Fresh authored tests: 15 retirement + 8 deployment controls PASS. Initial missing-implementation RED controls, recreated-volume RED, byte-level line-writing RED, real namespace-collector RED and foreign bind-backed volume RED were observed before correction.
- Fresh-context review found and verified correction of foreign bind-backed root overlap, incorrect line termination and missing image-tag namespace admission. No remaining must-fix source findings were reported. This is not live execution proof.
- Never substitute historical one-use executors, remove state markers to retry, invoke broad prune, alter daemon settings or enable providers to make this deployment appear ready.

## Required operator prerequisite

Run in the server's own terminal and enter sudo credentials there, never in chat/tools:

```bash
sudo systemctl disable --now fcd-support-backup.timer fcd-support-maintenance.timer fcd-support-health.timer
sudo systemctl stop fcd-support-operation@backup.service fcd-support-operation@maintenance.service fcd-support-operation@health.service
```

Codex must independently recheck inactive/disabled timer state and inactive operation instances before the destructive executor. Then commit/push the exact reviewed code, upload it into a fresh protected execution directory, run read-only admission and execute the exact one-use retirement. Recheck preservation and capacity before source construction or deployment. No new user approval for the already authorized retirement/deployment is required.

## Still unfinished

1. Operator scheduler stop; full resource retirement; measured reclaimed capacity.
2. Fresh immutable source/fixture construction, pinned image builds and actual deploy/verify.
3. First administrator provisioning and real login/MFA/dashboard/logout proof; owned SSH loopback access. The prepared deployment currently verifies the unauthenticated Unix login route and deliberately reports administrator bootstrap pending.
4. PR24 ancestor-link and directory-dependency corrections, plus unresolved solo four-worker Windows integration failures. Draft PR22/23/24 remain unmerged and are not the deployment source.
5. Formal P1 gate review record.
6. Signed synthetic probes, content-free DB proof tooling, private reviewer/resume/privacy/consent/template controls and approved production correction handlers, separate role provisioning.
7. Reviewed enabled-worker lifecycle and actual T-01–T-11 acceptance, including independent bilingual scoring, test-device delivery, provider fallback, takeover, consent/privacy, outages and restore drills.
8. Meta permission/token ownership/coexistence/manual-echo decisions, customer-facing disclosures, backup/alert/manual-coverage ownership and separately approved production rollout.
9. Operator inbox/staff lifecycle UI, public Support/Trust Center and direct external notifications remain unapproved proposals.

P7-005, P7-GATE and production readiness remain BLOCKED. A working private login page is not proof of live automatic support replies.
