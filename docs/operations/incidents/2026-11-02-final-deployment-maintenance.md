# Final synthetic deployment: maintenance configuration and preservation refusal

Date: 2026-11-02 (Asia/Dhaka).
Status: **OPEN. Task 16 remains incomplete; the one-use action is stopped.**
Selected source: `6d0210ddee6c333b6ce803370392a0818f5f3d29`.
Committed executor checkpoint: `14ff26a`.
Scope: `fcd-support-host-test-p6-6d0210d` only.

## Executed outcome

The committed action passed fresh read-only admission and ran once. Source
checkout, private pinned Node extraction, eight fresh bridge creation and the
existing synthetic-precreated harness completed. The fresh API, admin, reply
worker and PostgreSQL are healthy. The harness passed its private HTTP/Unix
checks before scheduling. Model/outbound/n8n execution remains disabled and no
live provider credentials or Meta/tunnel changes were introduced.

Both public scheduled-backup invocations exited 0, including the current-slot
replay. The subsequent first maintenance subcommand, **retention**, produced
`operations_job_uncertain`. The action exited 1 at `scheduled_operations`.
Selection remains `ready`; the durable maintenance journal is `uncertain` and
its actor is absent. No final deployment-completed marker, timer rendering,
health scheduling, actual SSH-forward/login proof or timer installation is
claimed. Do not replay the deployment or clear the journal.

## Concrete provisioning defect

Read-only inspection confirms the generated common/maintenance configuration
omits `OPS_LEARNING_POLICY_JSON`, `OPS_LEARNING_WINDOW_MS` and
`REPLY_OUTBOUND_BOUNDS_JSON`. The source helper initially leaves maintenance.env
comment-only. The real maintenance CLI requires all three before creating its
pool, including for retention. The prior compiled integration control manually
supplied them and did not exercise generated role configuration.

Codex reproduced the omission locally: the new producer/consumer regression
failed on undefined JSON, then passed after explicit authored maintenance
settings were added. Shared outbound bounds remain identical to the reply
fixture; application defaults, production policies and lifecycle cadence are
unchanged. The compiled CLI control now consumes generated common/maintenance
files. Disposable CI is being extended to run the actual owning maintenance
scheduler across its four subcommands, rather than only fake dispatch.

This explanation does **not** settle the server job's SQL outcome. Source
reasoning, an absent actor and configuration inspection are not a supported
resolver. Its journal, override, selected database and evidence stay preserved.
Verification of the correction must use fresh disposable fixtures or a new
separately reviewed server scope.

## Post-attempt preservation observation

The full original baseline comparison refuses: **one unrelated previously
running actor is now absent**, with its network membership removed. It was not
an admission actor, an older fcd-support actor or the new Node helper. There is
no boot/daemon pin change. Retained Docker events did not supply a matching
bounded outcome; no removal cause or actor is attributed.

A separate comparison excluding only that explicit missing set finds all
surviving actor/network metadata, volume inventory, old state-file fingerprints
and boot/daemon pins matching. This is a qualified surviving-inventory check,
not restored original preservation. The original baseline is not overwritten.
No command in the scoped executor targeted another project; the observation
does not establish why that actor disappeared or prove absence of indirect
effects. Do not recreate it or change another project to repair the audit.

Local test execution was independently confirmed to use Docker Desktop's
`desktop-linux` named-pipe endpoint with no Docker host/context override. The
local native/PostgreSQL tests are distinct from the shared-server attempt.

## Next work

- Finish lint/type/full local and real compiled-CLI/PostgreSQL validation of
  the fixture correction; preserve failed checks and actual passing reruns.
- Commit/push the correction and verify its actual source in CI, including
  real scheduled maintenance and existing recovery paths.
- Keep this source's uncertain maintenance scope and all older uncertain
  scopes untouched. A fresh action needs a new source/project, reviewed
  current admission and explicit quarantine of the newly observed missing set.
- Preserve the current local-gate record as a bounded checkpoint. Task 16 is
  held for this follow-up, fresh deployment/SSH evidence and privileged timer
  installation. Passwordless sudo remains unavailable; no hardening or sudo
  policy is weakened to bypass that step.
