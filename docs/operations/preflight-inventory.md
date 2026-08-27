# Sanitized Phase 0 Service Inventory

## Scope And Evidence Rules

This document closes the read-only inventory evidence for P0-013 through P0-016.
The evidence was collected on 2026-08-26 and reviewed on 2026-08-27 in
`Asia/Dhaka` time. Collection did not change a service, token, permission, Docker
network, workflow, tunnel, DNS record, or Meta asset.

Inventory completion does not mean production readiness. Each section records
the remaining readiness gates explicitly.

This record intentionally omits endpoint keys, access tokens, app and account
identifiers, phone and Page identifiers, tunnel credentials, provider connection
identifiers, environment values, workflow names and bodies, request bodies,
customer content, and raw diagnostic output. Counts and permission names below
are sanitized operational metadata permitted by
`docs/SYNTHETIC_FIXTURE_POLICY.md`.

## P0-013: Manifest Harness

### Sanitized inventory

- Private Manifest service version: `6.11.0`.
- Dedicated active harness: `fcd-support`.
- Harness category and platform: `app` and `openai-sdk`.
- Application request model: `auto`.
- The dedicated harness key was accepted by the private host endpoint; its value
  is not recorded.
- One active, unexpired harness key exists.
- Eighteen active provider connections are available: six named and twelve
  custom connections. Seventeen use API-key authentication and one uses a
  subscription mechanism.
- Complexity routing is disabled.
- No explicit fallback routes, tenant overrides, notification rules, or limit
  rules were found.
- Message-body recording is enabled.
- No request rows were found for this harness at inventory time.
- The current admission-only API is not attached to Manifest's private Docker
  network. The verified future reachability target is the private Manifest
  service alias, never its LAN-published interface.

### Disposition

P0-013 inventory is complete. The model path is not production-ready until:

1. message-body recording is disabled and deletion behavior is verified;
2. an explicit provider/fallback/limit policy is approved and tested; and
3. the application receives least-privilege private-network connectivity and
   passes a tool-free `fcd-support`/`auto` contract test.

The inventory did not change recording, routing, limits, connections, keys, or
Docker networks.

## P0-014: Meta Test Assets And Permissions

### Sanitized inventory

- The Meta business is verified.
- The development app has a Meta-provided WhatsApp test number and a dedicated
  Messenger test Page.
- The production WhatsApp number and production Facebook Page remain untouched.
- Webhook verification and signed synthetic WhatsApp `messages` samples passed
  for incoming messages, sent, delivered, read, contact, and supported
  identity-shape cases.
- Messenger testing is role-scoped while the app remains in development mode.
- Advanced live `pages_messaging` access is not approved.
- The Page token inspection reported Page use with these permission names:
  `pages_messaging`, `whatsapp_business_management`,
  `whatsapp_business_messaging`, and `public_profile`. The token value and
  account-specific granularity are not recorded.
- The configured Page token has a finite data-access expiry.
- The WhatsApp test access token was expired at inventory time and must be
  replaced before another real-device WhatsApp test.
- Runtime configuration currently pins Meta Graph API `v25.0`; the successful
  webhook tester samples used `v26.0`.
- The app is unpublished. Role-scoped test evidence does not prove general live
  Page delivery or production WhatsApp permission.

### Disposition

P0-014 inventory is complete. Test/live readiness remains gated by:

1. safe WhatsApp test-token replacement outside Git;
2. a successful real-device test-number delivery;
3. an approved and tested single Graph API version/support window;
4. required Meta app review and live permission approval; and
5. separate non-mutating production-number coexistence verification in Phase 8.

No permission, token, app mode, Page, phone number, subscription, or production
asset was changed during this inventory.

## P0-015: n8n Public API Dependency Audit

### Sanitized inventory

- Private/LAN-only n8n service version: `2.35.3`.
- The service is backed by its existing local SQLite store.
- Four workflows exist; two are active.
- Two workflows contain HTTP Request nodes.
- Static aggregate inspection found zero workflows referencing n8n's public
  `/api/v1` interface, its LAN port, or an n8n API-key environment name.
- A sanitized scan of named application configuration directories found zero
  static n8n public-API dependencies for `fcd-support`.
- Three n8n API keys exist; two have historical usage.
- Available request logs did not show public-API activity in the inspected
  window, but absence of request logging is not proof that legacy keys are
  unused.
- No workflow name, workflow body, credential value, payload, API-key value, or
  database row was exported.

### Disposition

P0-015 dependency audit is complete with zero discovered `fcd-support` n8n
public-API dependencies.

Keep the n8n public API enabled but LAN-only until the owners of the two
historically used keys are identified. A later approved operations change may
revoke unused keys or disable the public API after ownership and monitoring are
confirmed. The `fcd-support` service may call only an authenticated, idempotent,
private notification endpoint in Phase 6; n8n must not own conversation,
consent, lifecycle, deletion, or delivery state.

The audit did not change a workflow, credential, API setting, service, or
network.

## P0-016: Cloudflare Access And Route Isolation

### Sanitized inventory

- Access to the Fast Cyber Defense Cloudflare zone was confirmed before the
  separately approved test tunnel was created.
- A dedicated project tunnel is healthy.
- Only exact `GET /webhooks/meta` verification and `POST /webhooks/meta` event
  delivery are intended to reach the admission API.
- Non-webhook ingress is denied by a final catch-all response.
- Application health, administration, PostgreSQL, n8n, Manifest, OmniRoute, and
  other API routes remain private.

### Disposition

P0-016 remains complete. This inventory update creates no route, tunnel, DNS
record, public hostname, certificate, or server change. Any later public-ingress
mutation requires the exact approval boundary recorded in `docs/TODO.md`.

## Consolidated Readiness Result

| System | Inventory | Production readiness | Next authorized scope |
|---|---|---|---|
| Manifest | Complete | Not ready | Local contract implementation and later private-network/recording gate |
| Meta test assets | Complete | Not ready | Test-token rotation and approved test-asset validation only |
| n8n | Complete | Private but legacy ownership unresolved | Identify historical API-key owners before disablement |
| Cloudflare | Complete | Exact test ingress already constrained | No change without separate approval |

These inventories satisfy the Phase 0 decision evidence requirement. They do
not close P0-017, P0-018, P0-GATE, any phase exit gate, the remaining Phase 7
acceptance matrix, or production readiness.
