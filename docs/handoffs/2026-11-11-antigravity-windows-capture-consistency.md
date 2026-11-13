# AGY: Windows capture-consistency follow-up

Date: 2026-11-11 (Asia/Dhaka). Bounded development-harness work only.
Start a fresh isolated `codex/agy-windows-capture-consistency` branch from
fresh synchronized main containing 5ede82c, both accepted merges f6ca679 /
2e24997, and the latest Codex review. Preserve all other worktrees.

## Recorded problem and scope

Independent full four-worker Windows execution at 5ede82c records **2,250
passes / 461 skips / 2 failures**: failed initialization/interrupted-barrier
cleanup in backup-harness-containment and closed-stdio MSYS descendant cleanup
in process-lifecycle. Both fail closed with test_child_reap_unconfirmed.
An earlier combined run's three fast-exit health failures are corrected by the
same-actor IPC startup gate; do not remove that gate or relax tree confirmation.
Historical focused/passing four-worker results remain distinct, not proof of
universal reliability. No OS-load or snapshot-race cause is established yet.

## Checklist and acceptance criteria

- [ ] Record exact source and reproduce/profile with the ordinary four-worker
      command. Map execution/capture/reap/confirmation phases to bounded closed
      classifications and timings; do not publish raw process IDs, command
      lines, arguments, snapshots, credentials or host-derived fixtures.
- [ ] Determine the first lost proof: root observation, MSYS/WMI snapshot join,
      fork/exec identity transition, child birth, group anchoring or final exit
      confirmation. A suspected non-atomic snapshot or load delay is a hypothesis
      until a deterministic authored RED control or actual bounded evidence
      supports it. Report non-reproduction honestly.
- [ ] If evidence supports a correction, add deterministic RED controls before
      changing tests/helpers. Retain a coherent capture of real owned identities
      while the root is alive. Never promote group number/uid/later birth alone
      into ownership after captured actors disappear. Preserve PID CreationDate,
      live group anchors, unrelated canaries and fail-closed unknown ownership.
- [ ] Keep the unchanged 5,000 ms test deadline and shared execution/cleanup
      budget. Include any consistency re-observation within that same budget.
      No extra timeout, skipped case, retry, ignored rejection, unconditional
      closed-root success, weaker assertion or disabled tree reaping.
- [ ] Preserve real owning-harness and MSYS fork/exec/closed-stdio cases. Do not
      replace the difficult actor with a fake that cannot reproduce the original
      mechanism merely to obtain green. Reap every owned root/child on failed
      assertions before scratch removal; propagate unconfirmed cleanup.
- [ ] Keep scope to necessary tests/helpers and dated evidence. No production
      scripts/src/infra/migrations, dependencies, Vitest config, provider logic,
      recovery authority, service behavior or process-global killing. If a new
      native job-object/FFI/dependency mechanism is necessary, return a concrete
      design for review rather than introducing it under this task.
- [ ] Verify focused and complete four-worker Windows runs and existing Linux
      CI on the exact final head. Keep two-worker and Linux outcomes separately
      labeled; they do not certify the four-worker Windows contract. Retain all
      earlier failing outcomes and avoid unproved causal claims.
- [ ] Run applicable static/governance/fixture/whitespace checks, force-format
      Markdown and submit a draft PR with exact source, RED/GREEN evidence,
      immutable workflow links, remaining limitations and rollback. Do not merge.

No Docker daemon, SSH, shared-server/systemd, tunnel/DNS, Meta, Manifest, n8n,
ClickUp, external message, credential, account or alert action is delegated.
Codex retains server disposition and the current-runtime Phase 7 rollout.
