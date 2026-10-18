#!/usr/bin/env bash
# Task 10 local gate only: pinned crypto plus guarded synthetic policy regressions.
set -Eeuo pipefail
[[ "$#" == 0 ]] || { echo checkpoint_test_arguments_invalid >&2; exit 1; }
export MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE_ROOT="$ROOT"
if command -v cygpath >/dev/null 2>&1; then NATIVE_ROOT="$(cygpath -m "$ROOT")"; fi
cd "$ROOT"
bash scripts/test-encrypted-backup.sh checkpoint
docker compose --file "$NATIVE_ROOT/infra/compose.test.yml" run --rm runner npm run test:integration -- \
  tests/integration/postgres-restore-fence.test.ts \
  tests/integration/postgres-outbound-work-store.test.ts \
  tests/integration/postgres-model-allowance.test.ts \
  tests/integration/postgres-restore-deletion-gate.test.ts \
  tests/integration/postgres-deletion-policy.test.ts
echo phase6_checkpoint_gate=true
