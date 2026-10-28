# Phase 6 Restore DNS Isolation Plan

This is a Task 11 defect correction within the approved Phase 6 design.
Execute inline with systematic debugging and test-first development.

1. Reproduce the source/target DNS collision in fresh local Docker networks and
   add failing rendered-Compose and host-alias regressions.
2. Remove the target alias from runtime PostgreSQL. Require distinct source and
   target aliases in the Compose contracts and actual host checks; allow safe
   convergence of an older quiescent source before target jobs run.
3. Verify actual Docker DNS against the rendered configuration, focused host and
   Compose tests, the isolated restore/PostgreSQL gates and the full code gate.
4. Record exact evidence, commit and push. Preserve all interrupted server
   state; design any reconciliation or separate server action independently.
