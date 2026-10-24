#!/usr/bin/env bash
# Render-only proof; never starts a service or reads a real environment/secret.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
[[ "$#" == 0 ]] || { echo bootstrap_profile_arguments_invalid >&2; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
REVISION="$(git rev-parse HEAD)"
[[ "$REVISION" =~ ^[a-f0-9]{40}$ ]] || exit 1
PROJECT="fcd-support-phase6-test-bootstrap-$$-$RANDOM"
FIXTURE="$ROOT/.superpowers/sdd/2026-10-04-phase-6-hardened-local-operations/$PROJECT"
[[ ! -e "$FIXTURE" && ! -L "$FIXTURE" ]] || exit 1
cleanup() {
  [[ -d "$FIXTURE" ]] || return 0
  [[ "$PROJECT" =~ ^fcd-support-phase6-test-bootstrap-[0-9]+-[0-9]+$ && ! -L "$FIXTURE" && "$(realpath -- "$FIXTURE")" == "$FIXTURE" && "$FIXTURE" == "$ROOT/.superpowers/sdd/2026-10-04-phase-6-hardened-local-operations/$PROJECT" ]] || return 1
  rm -r -- "$FIXTURE"
}
trap cleanup EXIT
NATIVE_ROOT="$ROOT"; NATIVE_FIXTURE="$FIXTURE"
if command -v cygpath >/dev/null 2>&1; then NATIVE_ROOT="$(cygpath -m "$ROOT")"; NATIVE_FIXTURE="$(cygpath -m "$FIXTURE")"; fi
node "$NATIVE_ROOT/tests/helpers/phase6-network-fixture.ts" "$NATIVE_FIXTURE" "$PROJECT" "$REVISION"
cd "$ROOT"
docker compose --env-file "$NATIVE_FIXTURE/fixture.env" --file infra/compose.operations.yml --profile '*' config --format json 2>/dev/null | \
  node --input-type=module -e '
    import {assertOperationsCompose} from "./dist/operations/compose-contract.js";
    let raw=""; for await(const chunk of process.stdin) { raw+=chunk; if(raw.length>1048576)process.exit(1); }
    try {
      const model=JSON.parse(raw); assertOperationsCompose(model,process.argv[1]);
      const b=model.services.bootstrap;
      if(!b || b.user!=="node" || b.read_only!==true || b.restart!=="no" || (b.ports??[]).length || (b.volumes??[]).length)throw 0;
      if(JSON.stringify(b.command)!==JSON.stringify(["node","dist/operations/bootstrap-main.js"]) || JSON.stringify(b.profiles)!==JSON.stringify(["operations-bootstrap"]))throw 0;
      if(Object.keys(b.networks).join()!=="operations_data" || b.environment.DATABASE_URL_FILE!=="/run/secrets/bootstrap-database")throw 0;
      for(const flag of ["MODEL_EXECUTION_ENABLED","OUTBOUND_EXECUTION_ENABLED","N8N_EXECUTION_ENABLED"])if(b.environment[flag]!=="false")throw 0;
      if(b.environment.OPS_DATABASE_NAME!=="fcd_support_test" || b.environment.OPS_DATABASE_SCHEMA!=="public" || b.environment.OPS_DATABASE_ROLE_PREFIX!=="fcd_support")throw 0;
      const expected=["bootstrap-database",...[
        "webhook","admin","reply","outbound","notification","maintenance","health","backup","verify-backup","checkpoint","migrator"
      ].map(role=>"bootstrap-"+role+"-password")].sort();
      if(JSON.stringify(b.secrets.map(s=>s.source).sort())!==JSON.stringify(expected))throw 0;
      for(const service of Object.entries(model.services))if(service[0]!=="bootstrap" && service[1].secrets.some(s=>expected.includes(s.source)))throw 0;
      for (const mutate of [
        m=>m.services.bootstrap.command.push("prepare"),
        m=>m.services.bootstrap.profiles=[],
        m=>m.services.bootstrap.environment.MODEL_EXECUTION_ENABLED="true",
        m=>m.services.bootstrap.secrets.push({source:"restore-identity"}),
        m=>m.services.migrate.secrets.push({source:"bootstrap-database"}),
        m=>m.services.backup.secrets.push({source:"bootstrap-backup-password"}),
        m=>m.services.bootstrap.networks.ingress={},
      ]) {
        const changed=structuredClone(model); mutate(changed); let refused=false;
        try { assertOperationsCompose(changed,process.argv[1]); } catch { refused=true; }
        if(!refused)throw 0;
      }
      process.stdout.write("bootstrap_profile_local=true\n");
    }catch {process.stderr.write("bootstrap_profile_invalid\n");process.exitCode=1;}
  ' "$REVISION"
