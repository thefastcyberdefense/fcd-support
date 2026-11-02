# Health input framing correction

Date: 2026-11-03 (Asia/Dhaka); investigation began 2026-11-02.
Base: `26ba72af8589aeeda3e8dcbb85a1de80fd464d70`.
Branch: `codex/p6-health-input`.
Exact correction head and hosted-CI outcomes belong to its pull request.

## Trigger and resulting behavior

Fresh Task 16 source `7af70cc` passed deployment, backup/replay and all four
maintenance jobs, then health became uncertain. Preserve that scope and the
earlier maintenance-uncertain `6d0210d` scope. See
`../operations/incidents/2026-11-02-final-deployment-health.md`.

Compose stdin_open=true uses StdinOnce=false and can leave the collector's stdin
open after the attached writer finishes. The old health reader waited for EOF;
the host did not send a frame terminator. The host now appends a newline and the
reader closes its iterator after a complete, nonblank JSON value at newline.
Direct EOF input, split/pretty JSON, byte cap and configured timeout are retained.
A leading blank chunk cannot complete an empty frame.

Disposable private-runtime CI now runs real scheduled health after backup and
before checkpoint/restore/promotion/rollback/cleanup. The failure diagnostic has
a closed health stage, and a failed health proof prevents all later recovery.
No public exposure, lifecycle policy, authority, privilege or provider behavior
changes. The existing 16,384-byte cap includes the frame delimiter.

## Independent review and retained failures

Read-only review found one parser defect: a leading blank chunk returned empty
input before later JSON arrived. Codex reproduced the destroyed-stream failure,
then required successful parsing of nonblank text before early completion.
The reviewer set aside actual execution/CI, SQL settlement and the separate
unexecuted SSH draft; these remain executor-owned conditions, not inferred proof.
No deferred minor finding was reported.

The initial reader extraction had a shadowed variable and failed for that reason.
After correcting it, the intended open-stdin test failed with health_input_invalid;
the framing change passed. The closed health-stage test also failed before the
allowlist change and passed afterward.

An intermediate full gate failed the existing trusted-transport diagnostic's
5,000 ms timeout: 1,959 passed / 438 skipped, 285.96 s. The diagnostic loop spawned
a validator for every general trace and accepted duplicate. Bounded prefix and
accepted-duplicate checks now avoid those subprocesses while preserving the
closed validator, trusted-frame priority, output caps and rejection assertions.
No test deadline was increased.

## Executed final validation

- Focused reader/diagnostic/recovery: **40 passed**, three files, **4.43 s**.
- Full Windows `VITEST_MAX_WORKERS=4 npm run check`: exit **0**, **1,961 passed /
  438 platform skips**, 131 files, **283.78 s**. Phase 0, format, lint, strict
  type checking and build passed.
- The actual compiled reader was imported into a fresh, non-root, network-none,
  read-only local Compose container with StdinOnce=false. A newline-framed
  authored JSON value completed before the 1,500 ms reader bound; container
  exited 0 and its closed success marker was verified. The exact labelled actor
  was removed and zero test-owned containers/networks/volumes remained.
- Separate actual SSH read-only transport: login 200, unauthenticated dashboard
  303, wrong-Origin login 403, established connection ownership matched the
  newly created SSH PID, and that forward was reaped. No identity, credential,
  authenticated session or database mutation was created by these requests.
- Forced changed-document formatting, Phase 0, diff checks and targeted secret
  patterns passed. Local Docker was independently pinned to desktop-linux with
  no endpoint overrides; it is separate from shared-server execution.

These overlapping checks are not summed. Corrected-source hosted CI, including
real health and full recovery in both runtime lanes, remains required before
merge. A new reviewed server scope is still needed afterward. No successful
server health collection, uncertain SQL resolution, root timer installation,
password/MFA login or final Task 16 completion is claimed.
