# Security Policy — Fast Cyber Defense Support (`fcd-support`)

Fast Cyber Defense treats the security of our customer-support automation, webhook boundaries, and customer privacy records as critical infrastructure.

## Supported Versions

Only the current tracked `main` branch and explicitly attested deployment revisions are supported.

| Version / Branch | Supported | Notes |
| --- | --- | --- |
| `main` (`0.1.x`) | Yes | Active hardened development and Phase 6/7 verification |
| Older unpromoted branches | No | Historical evidence only |

## Security & Trust Boundaries

- Never include secrets or customer data in issues, pull requests, logs, or test fixtures (`docs/SYNTHETIC_FIXTURE_POLICY.md`).
- Only `GET /webhooks/meta` and `POST /webhooks/meta` are intended for public webhook ingress via Cloudflare Tunnel.
- Admin, database, health, Manifest, and n8n interfaces remain strictly private.

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues or pull requests.

- **Email:** `security@fastcyberdefense.com` (or `info@fastcyberdefense.com`)
- **Website:** <https://fastcyberdefense.com>
- **Expected Acknowledgement:** Within 24 hours for critical issues; initial triage within 48 hours.
- **Safe Harbor:** Good-faith security research conducted without privacy violations, service disruption, or social engineering is authorized under our coordinated disclosure policy.
