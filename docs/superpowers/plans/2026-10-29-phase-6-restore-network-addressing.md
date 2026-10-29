# Phase 6 restore network addressing plan

Implement the approved Phase 6 restore isolation requirement with an optional
operator-selected subnet, following the adjacent design record.

1. Add failing tests for the protected setting, bounded host route/interface
   inspection and controller ordering, create arguments, IPAM identity and
   refusal behavior. Observe the failures before implementation.
2. Implement strict shell configuration validation and a dependency-free,
   bounded host inventory checker. Invoke the checker before mutation and again
   immediately before network creation; bind the actual IPAM subnet to every
   target-network proof. Preserve the original path when unset.
3. Add a scoped real-Docker test of explicit internal bridge allocation and
   conflicting-subnet refusal. Verify exact labels, empty membership and ID
   before removing only the test-owned bridge.
4. Run focused tests, shell syntax and formatting checks, then the appropriate
   complete local and native gates. Record exact outcomes and limitations in
   the tracker and server evidence. Commit and push under `redwan-cse`.
5. After exact-revision GitHub checks pass, prepare and push a separate concrete
   synthetic server action before any server mutation. Preserve all uncertain
   work and stop on any refusal or changed evidence. Continue the Phase 6
   failure matrix; do not claim its gate from the subnet change alone.

Local execution: Steps 1–3 are complete. Step 4's final code gate passed 1,851
tests/433 platform skips across 125 files; native validation passed 1,258 tests
across 55 files and 139 PostgreSQL tests/one restore-only skip across 13 files.
All 41 subnet cases and real Docker checks passed; synthetic project cleanup
reported zero remaining resources. The first native fixture-bootstrap failure
was corrected before those final results. Step 4 completed at pushed commit
`6faff8b`; all four exact-source GitHub workflows passed. Step 5's fresh server
action is recorded separately, including preservation of the old admission
snapshot and a separately verified current baseline after start-time drift.
The `9c2e404` action completed the fresh synthetic deployment at source
`6faff8b`, with both final success acknowledgements and an independent readiness,
privacy and prior-state preservation check. The `cda55ed` backup/replay action
also passed with three signed archives and identical authenticated replay
metadata, followed by an independent private-evidence/readiness check.
Fresh checkpoint/restore/promotion/rollback and the remaining failure matrix
remain pending; no Phase 6 gate is claimed.
