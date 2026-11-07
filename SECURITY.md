# Security Policy — Fast Cyber Defense Support (`fcd-support`)

Fast Cyber Defense treats the security of our customer-support automation, webhook boundaries, and customer privacy records as critical infrastructure.

## Supported Versions

Only the current tracked `main` branch and explicitly attested deployment revisions are supported.

| Version / Branch          | Supported | Notes                                                  |
| ------------------------- | --------- | ------------------------------------------------------ |
| `main` (`0.1.x`)          | Yes       | Active hardened development and Phase 6/7 verification |
| Older unpromoted branches | No        | Historical evidence only; not deployed or patched      |

## Security & Trust Boundaries

- Never include secrets or customer data in issues, pull requests, logs, or test fixtures (`docs/SYNTHETIC_FIXTURE_POLICY.md`).
- Only `GET /webhooks/meta` and `POST /webhooks/meta` are intended for public webhook ingress via Cloudflare Tunnel.
- Admin, database, health, Manifest, and n8n interfaces remain strictly private.

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.

- **Current Reporting Channel:** Use GitHub Private Vulnerability Reporting on `thefastcyberdefense/fcd-support` or contact the repository owner (`@redwan-cse`) directly through a private channel.
- **Proposed Disclosure Mailbox, SLAs & Safe Harbor (Pending Owner/Legal Approval):** Dedicated mailbox addresses (such as `security@fastcyberdefense.com` or `info@fastcyberdefense.com`), fixed acknowledgement/triage response-time targets (such as 24-hour acknowledgement / 48-hour triage), and formal safe-harbor legal language are **proposals pending business-owner and legal provenance approval** in Phase 8 and are not published as active binding commitments until approved.
