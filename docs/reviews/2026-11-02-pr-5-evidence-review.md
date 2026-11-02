# PR #5 Phase 6 evidence-pack review

Date: 2026-11-02 (Asia/Dhaka).
PR: <https://github.com/thefastcyberdefense/fcd-support/pull/5>.
Base: `bd3a09a1f5ade5bdfa17a3df1e0fab6498f1538a`.
Reviewed head: `d821b246bad61ae3a23f923f7a491bbc8fd1964b`.

Decision: **Changes required; keep PR #5 draft and unmerged.** No Critical
finding was identified. Important operator-instruction and evidence defects
prevent acceptance of this candidate. Task 15 documentation/review,
P6-004/P6-005/P6-006, P6-GATE and Task 16 remain open. Task 11's bounded
historical closeout stands.

## Independently verified validation

All ten changed paths are documentation. No implementation change is present.
All four workflows on the exact submitted head completed successfully:
[CI](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41427372360),
[CodeQL](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41427372517),
[PostgreSQL/native](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41427372424),
[private runtime](https://github.com/thefastcyberdefense/fcd-support/actions/runs/41427372437).
These results do not validate the prose or supply an aggregate gate decision.

Independent `npm run validate:phase0` and the submitted-range `git diff --check`
pass. Forced Prettier with `--ignore-path .gitignore` fails for the candidate
pack, acceptance matrix and operations evidence index. The normal format command
does not establish formatting of ignored Markdown. A path audit inspected 204
references and five full commit references; all five commits exist, but several
newly cited paths do not. One additional missing retention-test citation
predates this PR and is not attributed to this submission.

Separate read-only reviewers inspected the ten changed documents and the
original aggregate requirements. Both identified blocking evidence gaps. No
reviewer performed SSH or infrastructure mutations.

## Required corrections

Line references below refer to submitted `d821b24`, before corrections.

1. **A documented public drain command does not drain.**
   `docs/operations/hardened-runtime.md:39` advertises
   `bash scripts/operations-drain.sh FULL_REVISION CONFIG_PATH`. That file only
   defines internal functions for owning controllers. Remove the standalone
   invocation and describe the existing controlled drain under the actual
   deploy/rollback/promotion entrypoints. Do not create a new CLI or suggest
   manually sourcing internals to repair documentation.
2. **Retention configuration names are invented.**
   `docs/operations/backup-and-restore.md:20` and the candidate checklist use
   `FCD_BACKUP_RETAIN_DAYS` / `FCD_BACKUP_RETAIN_MONTHS`. Actual inputs are
   `BACKUP_DAILY_RETENTION` / `BACKUP_MONTHLY_RETENTION`, validated in
   `src/operations/operations-config.ts:46`. They select retained daily/monthly
   slots; describe the real configuration scope and bounds without changing
   policy or implementing aliases.
3. **The checklist replaces Task 12 with different work.**
   `docs/handoffs/2026-11-01-phase-6-gate-candidate.md:48` calls Task 12 the
   admin dashboard/socket. Original Task 12 is revision-pinned host timers and
   scheduled maintenance. Map the original tasks and P6 rows accurately,
   including timer generation, real local systemd validation, current-slot
   catch-up, owning flock and PostgreSQL deduplication. Task 15 includes review
   and the gate record; its completion cannot precede those decisions.
4. **Citations and exact-source provenance need repair.**
   Candidate lines 44–50 cite nonexistent Dockerfile/Compose names,
   `tests/operations-backup.test.ts`, `tests/operations-health.test.ts`,
   `src/operations/n8n-client.ts` and
   `tests/integration/two-cluster-restore.test.ts`. The last path also occurs
   in AC-09; the evidence index cites nonexistent `tests/sensitive-data.test.ts`.
   Locate the actual owners and assertions rather than replacing names by
   resemblance. At evidence-index line 84, the workflow IDs belong to an older
   PR #3 head, not `7801314`. The final-source runs are 41320435620 (CI),
   41320435609 (CodeQL), 41320435615 (PostgreSQL/native) and 41320435605
   (private runtime), independently verified through the commit workflow API.
   Keep the earlier runs as historical where relevant. Attribute AGY's reported
   Windows duration separately from Codex's independent 261.62-second run.
5. **Document the implemented topology and ownership.**
   `docs/operations/outbound-worker.md:26` claims one `fcd-support-private`
   attachment. Runtime outbound uses `outbound_data` plus `provider_egress`
   (`infra/compose.runtime.yml:248`). Use actual logical networks, distinguish
   runtime from the model/test overlays, and verify network counts rather than
   hardcoding a guessed total. App/operations UID 1000 and PostgreSQL UID 999
   have different roles. Correct the private-admin guide's obsolete TCP/private
   management-network instructions; packaged admin is Unix-only. The SSH
   destination is the configured host `${FCD_ADMIN_SOCKET_ROOT}/admin.sock`,
   which need not equal its container mount path.
6. **Preserve execution and phase boundaries.**
   Candidate line 24 incorrectly calls the clean dependency audit a result for
   the deployed tree. The accepted runtime source is not yet deployed; last
   recorded application is `67a4a4b`. Alert #42 was observed fixed/runtime and
   #43 open/development. AC-09 must distinguish successful historical promotion,
   Task 16's final-source deployment and later full-host restart evidence.
   Remove nonexistent P7-006 and new promises that optional live n8n enablement
   or external uptime adapters must ship in Phase 7. Preserve the approved
   later-authorization/deferred scope. Full-host/live-provider deferrals do not
   excuse a missing local requirement.
7. **Finish the current operator/evidence closeout.**
   Mark superseded implementation checkpoints in runtime-deployment-safety
   (including lines 1181, 1240, 1274 and 1303) historical, preserving original
   failures and subsequent passing evidence. Replace machine-specific
   `file:///` links with repository-relative links. Force-format every changed
   Markdown file and report that command's actual result.

## Aggregate gate assessment and ownership

The approved Task 15 requires the full `scripts/test-phase6-local.sh` matrix,
including the multihomed ordinary-egress ingress probe. Current green
private-disabled runtime workflows are different evidence. The candidate's
nine-allowed/twenty-denied claim needs the owning harness and an executed
revision, not a citation to a socket unit test. Codex owns the additional local
execution and its separate evidence record; AGY must not invent a passing run
or expand its documentation-only assignment into infrastructure mutation.
That additional execution now passes on exact `bd3a09a`: **9 allowed / 20
denied**, exit 0 in **157.32 seconds**, with zero scoped Docker leftovers.
The ordinary-egress multihomed probe is included. Evidence:
`docs/testing/2026-11-02-phase-6-local-topology.md`. This execution gap is closed;
the documentation corrections and independent gate assessment remain open.

Task 12's local gate does not require installing host timers. Task 16 owns that
installation. Native tests already exercise actual systemd validation; database
integration exercises loopback-to-Unix authentication/CSRF/revocation controls.
Historical real SSH evidence and later Unix/ingress repair must retain their
different scopes.

The actor-loss incident remains **OPEN and contained**. Missing stopped actors
do not prove SQL settlement or preserved database content. Retained state,
volumes, baselines and uncertain scopes remain protected. The original Task 11
proof and separate current-readiness repair are bounded historical evidence.
Attribution is not a prerequisite to unrelated local validation. Any later
Task 16 action needs fresh admission and an exact committed scope; old one-use
actions cannot deploy the updated dependency tree. No resolver, reconstruction,
journal clearing, baseline replacement, VM/Docker restart or other-project
change is authorized by this disposition.

Next assignment:
`docs/handoffs/2026-11-02-antigravity-pr-5-review-fixes.md`.
No server, tunnel, Meta, live provider, production or old-state action ran as
part of this review.
