# Decision 0001: Runtime And Toolchain

Status: accepted for local development and isolated integration testing on 2026-08-11.

## Decision

The reproducible project inputs are:

| Component | Pinned version |
|---|---:|
| Node.js | `24.18.0` |
| npm | `11.16.0` |
| TypeScript | `6.0.3` |
| Fastify | `5.10.0` |
| Zod | `4.4.3` |
| PostgreSQL | `18.4` |
| `pg` | `8.22.0` |
| `node-pg-migrate` | `9.0.0` |
| Vitest / coverage | `4.1.10` |
| ESLint | `10.8.0` |
| `typescript-eslint` | `8.65.0` |
| Prettier | `3.9.6` |

The PostgreSQL integration image is pinned by both tag and immutable digest in
`infra/compose.test.yml`. GitHub Actions are pinned by commit SHA. Production
dependencies use exact versions in `package.json`, and `package-lock.json` is the
authoritative dependency graph.

## Rationale

- Node.js 24 is the selected supported line, with strict ESM TypeScript.
- Fastify provides a narrow HTTP surface and raw-buffer parsing needed for Meta HMAC verification.
- Zod validates untrusted envelopes and startup configuration without logging input values.
- PostgreSQL owns authoritative receipt and application state; `pg` keeps the data path explicit.
- Versioned SQL migrations make schema changes reviewable and testable in both directions.
- Vitest, strict TypeScript, ESLint, and Prettier form one local validation gate.

The developer workstation currently has Node.js `24.19.0` and npm `11.17.0`.
Those versions satisfy the repository's Node 24 engine range, but CI and future
container builds continue to use the recorded reproducible versions.

## Boundaries

The current PostgreSQL Compose file is test-only: it contains synthetic data,
uses an internal Docker network, publishes no host port, and is not a production
credential or deployment design. Production database authentication, application
containers, backups, and network policy belong to Phase 6 and require their own
review before deployment.
