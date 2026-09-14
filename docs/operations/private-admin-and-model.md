# Private Admin And Model Operations

## Network shape

Meta requires the webhook to remain continuously reachable while automatic
support is expected. The Cloudflare Tunnel therefore continues to expose only
the exact Meta verification and event webhook paths to the public API. It must
not route admin, health, database, Manifest, n8n, metrics, or general
application paths.

The intended self-hosted layout is:

- public edge to the exact webhook ingress network only;
- API and tunnel on the dedicated ingress network;
- API/worker and PostgreSQL on the private data network;
- model worker and Manifest on a separate private model network;
- fcd-support-admin bound to loopback or an explicitly approved private
  management network only; and
- no PostgreSQL or Manifest host port and no public admin route.

The continuously exposed webhook does not make the dashboard or model gateway
public. When the local server or tunnel is unavailable, Meta cannot deliver
live events; staff use the documented manual Meta Business Suite coverage
until service returns and retries are processed.

## Fail-closed startup

Inference stays disabled unless all of these are true:

- the dedicated Manifest base URL resolves through a private route;
- the harness/API configuration is fcd-support and the requested model is auto;
- message-body recording is disabled;
- deletion/retention behavior and the provider allowlist are approved;
- Manifest limits are verified within deployment ceilings;
- one reviewed PostgreSQL model-policy version is event-time active; and
- a dedicated application credential is injected at runtime.

Configuration contains no enabling defaults. Rate, cost, concurrency, queue,
timeout, token, input, response, context, cooldown, and provider-attempt values
remain customizable through reviewed policy and protected deployment
configuration. Never record secret values in commands, screenshots, logs, or
evidence.

## Private dashboard

Use the dashboard for knowledge proposals, review/publication, provenance,
owner questions, aggregate insights, model policy, and escalation counts.
Privileged actions require an active account/session, MFA, exact role,
same-origin CSRF validation, and a session-bound signed action. Keep the CLI for
bootstrap and break-glass work; it must use the same database authorization and
publication rules.

No proposal, owner answer, website fetch, insight, or model result publishes
automatically. Reviewers compare English/Bangla content and provenance before a
separate effective publication event.

## Pre-traffic verification

The later approved private deployment must verify, without retaining bodies or
provider details:

1. Manifest recording is off and deletion/retention behavior is understood.
2. Provider connections and fallback order match the approved aggregate
   policy; no OpenClaw/Hermes key is reused.
3. The application reaches only the private Manifest service and requests auto
   with no tools.
4. Effective application limits are no looser than policy, deployment, or
   Manifest.
5. Timeout, exhaustion, malformed output, restart, lost lease, and queue-full
   probes create one safe draft/escalation and no duplicate request.
6. English/Bangla test-asset cases pass with sanitized aggregate evidence.
7. Tunnel negatives confirm every non-webhook public path is unreachable.

If any check fails, keep the model path disabled. Do not substitute another
gateway, expose a private service, weaken limits, or send customer traffic.

## Current status

The repository proves the contracts locally with synthetic fakes and isolated
PostgreSQL tests. It has not disabled live Manifest recording, attached the
application to Manifest's network, deployed this Phase 4 worker/admin build, or
made a live model/provider call.
