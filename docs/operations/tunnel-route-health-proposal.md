# Proposal: Decoupled Public-Route Evidence in Health Collector (`tunnel` Component)

## Problem Statement

On `v9` (`4c4b933`), `INCIDENT_c3fb5d6b-e5b4-4f65-890b-6eae89b46b07` remains open for `tunnel` (`degraded / not_verified`, `126+` consecutive failures) even when `fcd-support-cloudflared` is healthy and external routing works.

Root cause in current source:
1. `scripts/operations-health-host.sh` hardcodes `"publicRouteCheck":{"state":"not_verified"}`.
2. `infra/systemd/fcd-support-operation@.service:45` enforces `RestrictAddressFamilies=AF_UNIX`, so `operations-health-host.sh` **cannot** and **must not** open external `AF_INET` / `AF_INET6` sockets.
3. Checking only `/webhooks/meta` reachability is insufficient: public tunnel verification must also confirm private routes (`/health`, `/login`) remain isolated (`404`).

## Decoupled Mechanism (Preserving `AF_UNIX` on `fcd-support-operation@.service`)

1. **Separately Scoped Host Probe (`scripts/probe-public-route.sh` + `infra/systemd/fcd-support-route-probe.{service,timer.in}`):**
   - Runs outside `fcd-support-operation@.service`, with `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`, `User=1000`, `ProtectSystem=strict`, `ReadWritePaths=@STATE_ROOT@`, zero Docker socket access, and zero secrets.
   - Executes three bounded (`redirect: 'error'`) HTTPS `GET` probes against the configured `https://<host>/webhooks/meta` origin:
     - `GET /webhooks/meta` must return HTTP `403` (reachable, rejects missing verify token).
     - `GET /health` must return HTTP `404` (private health route not exposed).
     - `GET /login` must return HTTP `404` (private admin login route not exposed).
   - Atomically (`O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`, `0600`, `fsync`, rename) writes ONLY `$FCD_STATE_ROOT/public-route-check` (`{"state":"passed"|"failed","checkedAt":"<ISO-8601-UTC>"}`).

2. **Non-Network Reader in `scripts/operations-health-host.sh`:**
   - Makes **zero network calls** (`AF_UNIX`-safe).
   - Reads `$FCD_STATE_ROOT/public-route-check` via `O_RDONLY | O_NONBLOCK | O_NOFOLLOW`, verifying regular file, `<= 512` bytes, `0600` ownership on POSIX, strict JSON keys, valid timestamp, and freshness (`0 <= age <= OPS_HEALTH_STALE_MS`).
   - Returns `{"state":"not_verified"}` whenever `FCD_STATE_ROOT` is unset or `public-route-check` is missing, symlinked, wrong mode/owner, malformed, future-skewed, or stale.

3. **Fresh Live Probe Observation (`2026-11-21`):**
   - Live run of `scripts/probe-public-route.sh https://meta.fastcyberdefense.com/webhooks/meta <tmpState> 5000`:
     - `GET /webhooks/meta` -> `403` (`server=cloudflare`)
     - `GET /health` -> `404` (`server=cloudflare`)
     - `GET /login` -> `404` (`server=cloudflare`)
     - Atomic output: `{"state":"passed","checkedAt":"2026-11-21T11:02:20.000Z"}`

## Security & Rollback Boundaries

- `infra/systemd/fcd-support-operation@.service` stays unchanged (`RestrictAddressFamilies=AF_UNIX`).
- `common.env` does not need to change unless an operator chooses to parameterize the unit explicitly.
- Rollback is stopping/disabling `fcd-support-route-probe.timer` and removing `$FCD_STATE_ROOT/public-route-check`, immediately returning `publicRouteCheck` cleanly to `not_verified`.
