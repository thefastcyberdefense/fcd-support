# Phase 6 Synthetic Network Capacity Plan

This is a test-harness extension supporting the approved Task 11 server drill.
Execute inline with test-first development; no server mutation is authorized by
this plan alone.

1. Add failing tests for exact ownership, isolation, participant and identity
   checks on precreated synthetic bridges; retain existing runner-mode tests.
2. Add a private precreated-network mode to the synthetic host runner. Sample
   the exact eight bridges before fixture creation and again before peer attach;
   preserve them on every failure.
3. Verify the guard with fake Docker metadata and actual isolated Docker
   networks. Exercise both network modes on disposable GitHub Actions runners,
   run focused and full code checks, then commit and push.
4. Only after a separate exact server action is recorded and synchronized,
   prepare a fresh synthetic project and test it without touching older scopes.
