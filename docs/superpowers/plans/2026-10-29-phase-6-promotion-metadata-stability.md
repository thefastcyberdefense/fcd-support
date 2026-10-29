# Phase 6 promotion metadata stability plan

1. Read the adjacent specification and existing host collector, strict promotion
   validator and native fixture helpers. Keep the missing-actor scopes untouched.
2. Add a deterministic RED regression for equivalent reordered mounts in the
   collector/recheck path. Add negative cases for actual mount changes, extras,
   omissions and duplicates. Retain all fresh observations.
3. Implement the smallest semantic comparison through the compiled TypeScript
   boundary. Keep strict schemas, bounded payloads and every existing identity,
   capability, membership and challenge check. Do not normalize ordered arrays
   or silently accept absent terminal observations.
4. Exercise actual Docker projections in a fresh labelled local fixture and
   the native host/validator composition. Test permutations deterministically;
   actual Docker ordering need not vary for the test to pass.
5. Run affected tests and static checks, the four-worker full local gate and
   relevant sequential native/PostgreSQL lanes. Record exact counts/skips and
   cleanup. Commit/push on an isolated review branch and require exact-source
   CI. Do not merge, deploy, retry or resolve the current server scopes from the
   Antigravity assignment.

This local correction is the next Task 11 work item. Runtime promotion,
compatible rollback, interruption recovery and P6-GATE remain incomplete.
