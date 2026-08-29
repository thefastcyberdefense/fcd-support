# Fast Cyber Defense Support

Self-hosted WhatsApp and Messenger customer-support automation for Fast Cyber Defense. The application will run on the existing local Docker server, use a dedicated Manifest Harness for model routing, and keep customer records in local PostgreSQL.

## Current Status

The narrow admission-only test service is deployed on the Ubuntu Docker server at approved revision `207a5e6357c1e1a7c75918793262d835574d898d`. Its restricted public callback, negative-path checks, Meta callback verification, WhatsApp test-number subscription, and Messenger test-Page subscription pass. A signed v26 phone-unavailable identity smoke test and its exact retry passed after the 2026-08-26 redeployment. This is not a production deployment, and production Meta assets remain untouched.

- [Delivery plan](docs/PLAN.md)
- [Task and decision tracker](docs/TODO.md)
- [Sequencing design](docs/superpowers/specs/2026-08-11-project-sequencing-design.md)
- [Runtime and toolchain decision](docs/decisions/0001-runtime-and-toolchain.md)
- [Webhook admission contract](docs/architecture/webhook-admission.md)
- [Threat model](docs/security/threat-model.md)
- [Acceptance matrix](docs/testing/acceptance-matrix.md)
- [Phase 0 gate review](docs/reviews/phase-0-gate.md)
- [Phase 0 gate validation](docs/reviews/phase-0-gate-validation.md)
- [Project context and confirmed infrastructure](docs/PROJECT_CONTEXT.md)
- [Approved test webhook deployment runbook](docs/operations/test-deployment.md)
- [Repository instructions](AGENTS.md)
- [Synthetic fixture and evidence policy](docs/SYNTHETIC_FIXTURE_POLICY.md)
- [New-chat handover prompt](docs/HANDOVER_PROMPT.md)

## Intended Runtime

- Public ingress: Meta webhooks through an outbound-only Cloudflare Tunnel.
- Application: TypeScript webhook, conversation, knowledge, consent, and human-handoff service.
- Data: local PostgreSQL with encrypted local backups.
- Model gateway: dedicated Manifest Harness `fcd-support`, using model `auto` and its approved routing/fallback policy.
- Automation: private n8n workflows for Telegram escalation and later CRM actions.
- Availability: automation runs while the local server is powered on; Meta Business Suite remains the manual support channel when it is off.

## Safety Commitments

- The production WhatsApp account remains unchanged until a Meta test number validates coexistence and manual reply mirroring.
- Blank consent never authorizes marketing.
- The assistant does not request credentials, OTPs, payment data, or sensitive incident evidence.
- Secrets and customer data never belong in Git.
- Passing a phase never authorizes public DNS, Meta asset changes, server deployment, or production-number work unless the tracker names and records that approval.

## Local Development

Use Node.js `24.18.0` and npm `11.16.0`, then run:

```text
npm ci
npm run check
npm run test:integration
npm run build
npm start
```

Copy `.env.example` to an ignored `.env` and supply local synthetic credentials before starting. The runtime binds to `127.0.0.1` by default. `DATABASE_URL` must point to a migrated PostgreSQL database for signed POST webhooks to be accepted; without durable storage they intentionally return `503`.

Integration tests require `TEST_DATABASE_URL` to name the exact `fcd_support_test` database and `ALLOW_DESTRUCTIVE_DATABASE_TESTS=fcd-support-test-only`. The guard rejects any other database before connecting, and every suite creates and removes only its own randomized schema. Tests use synthetic data.

Run the approved isolated test stack with:

```text
docker compose -f infra/compose.test.yml run --rm runner
```

Append an npm test path to target a suite, for example:

```text
docker compose -f infra/compose.test.yml run --rm runner npm run test:integration -- tests/integration/migrations.test.ts
```

The PostgreSQL service and pinned test runner share an internal-only network and publish no host ports. The runner is read-only apart from `/tmp`, mounts the current source, tests, and migrations read-only, and contains locked development dependencies. Do not reuse the test database's trust-authentication configuration for production.
