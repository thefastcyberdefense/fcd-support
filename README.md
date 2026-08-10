# Fast Cyber Defense Support

Self-hosted WhatsApp and Messenger customer-support automation for Fast Cyber Defense. The application will run on the existing local Docker server, use a dedicated Manifest Harness for model routing, and keep customer records in local PostgreSQL.

## Current Status

The planning audit is complete and the Phase 0 decision tracker is active. Implementation has not started.

- [Delivery plan](docs/PLAN.md)
- [Task and decision tracker](docs/TODO.md)
- [Sequencing design](docs/superpowers/specs/2026-08-11-project-sequencing-design.md)
- [Project context and confirmed infrastructure](docs/PROJECT_CONTEXT.md)
- [Repository instructions](AGENTS.md)
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
