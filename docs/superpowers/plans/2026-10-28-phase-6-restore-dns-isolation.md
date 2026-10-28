# Phase 6 Restore DNS Isolation Plan

This is a Task 11 defect correction within the approved Phase 6 design.
Execute inline with systematic debugging and test-first development.

- [x] Reproduce the source/target DNS collision in fresh local Docker networks
      and add failing rendered-Compose and host-alias regressions.
- [x] Remove the target alias from runtime PostgreSQL. Require distinct source
      and target aliases in the Compose contracts and actual host checks; allow
      safe convergence of an older quiescent source before target jobs run.
- [x] Verify actual Docker DNS against the rendered configuration, focused host
      and Compose tests, the isolated restore/PostgreSQL gates and the full code
      gate. Full code passed 1,771 tests/423 platform skips across 123 files;
      native grants passed 1,196 tests and 139 PostgreSQL tests/one restore-only
      skip. The restore gate passed 250 tests and 47 PostgreSQL tests; the final
      native controller suite passed 59 tests.
- [ ] Record exact evidence, commit and push. Preserve all interrupted server
      state; design any reconciliation or separate server action independently.
