# Phase 6 Promotion Host Contract Plan

1. Reproduce the original guard's refusal using the preserved synthetic host's
   metadata and a fresh Docker volume with the real role-specific UIDs.
2. Reproduce the checkpoint-path mismatch using the preserved job's rendered
   Compose configuration and a failing validator regression.
3. Correct the role-to-owner mapping and checkpoint root while retaining the
   existing path, mode, link and protected-ancestor checks.
4. Run real Docker positive and negative cases, the native operations and
   restore gates, the full code gate and exact-revision GitHub workflows.
5. Commit and push the validated correction. Keep the uncertain promotion and
   both databases preserved; any settlement or server retry requires a
   separately recorded procedure and its own evidence.
