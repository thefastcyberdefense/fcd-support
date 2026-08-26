# Test Webhook Deployment Runbook

This runbook deploys only the signed Meta webhook admission service on the Ubuntu Docker host. It is a narrow, explicitly approved test exception; it does not complete the Phase 6 or Phase 7 gates.

The test container cannot send WhatsApp or Messenger messages, call n8n, or call Manifest. Those credentials are deliberately not injected, and the API is not attached to the Manifest network. The production WhatsApp number and production Facebook Page must remain untouched.

## Public and private boundaries

```text
Meta
  -> https://meta.fastcyberdefense.com/webhooks/meta
  -> Cloudflare Tunnel
  -> fcd-support-ingress (internal Docker network)
  -> fcd-support-api:3003
  -> fcd-support-data (internal Docker network)
  -> PostgreSQL
```

No API or database port is published on the Ubuntu host. The Cloudflare route must use:

- Hostname: `meta.fastcyberdefense.com`
- Path matcher: `^/webhooks/meta$`
- Service: `http://fcd-support-api:3003`

The matcher is a route rule, not part of the callback URL. Never give Meta a URL containing `^`, `$`, or `%5E`.

## Protected server state

The following files are server state and must never be committed or copied into the repository:

- Runtime configuration: `/home/redwan/.config/fcd-support/runtime.env`
- Tunnel token: `/home/redwan/.config/fcd-support/cloudflared.token`

Both files must be owned by the deployment account and mode `600`. The repository contains names and examples only, never values.

Before deployment, confirm these settings are nonblank in `runtime.env` without displaying their values:

- `DATABASE_URL`
- `POSTGRES_PASSWORD`
- `META_APP_SECRET`
- `META_VERIFY_TOKEN`

The test deployment does not require `META_PAGE_ACCESS_TOKEN`, a WhatsApp access token, a Manifest key, or an n8n secret.

## Deploy or update an exact revision

On Windows, run the full local gate, commit, merge, push `main`, and record the full approved commit:

```powershell
npm ci
npm run check
git rev-parse HEAD
```

On Ubuntu, replace the placeholder with that exact 40-character commit. Do not derive the approval value from whatever `main` happens to contain later.

```bash
cd /home/redwan/apps/fcd-support
FCD_APPROVED_REVISION='<FULL_40_CHARACTER_APPROVED_COMMIT>'
git fetch origin main
git cat-file -e "${FCD_APPROVED_REVISION}^{commit}"
git checkout --detach "$FCD_APPROVED_REVISION"
./scripts/configure-test-runtime.sh
./scripts/start-cloudflared.sh --replace-existing "$FCD_APPROVED_REVISION"
./scripts/deploy-test.sh "$FCD_APPROVED_REVISION"
```

`deploy-test.sh` refuses a short SHA, a mismatched `HEAD`, or a dirty/untracked source tree. It builds and retains `fcd-support-api:<full-git-sha>` and verifies the same immutable revision label before starting it.
The tunnel command builds a pinned project image with a real `/ready` health check. If a legacy same-purpose container does not meet the non-root, read-only, token-file, capability, restart, resource-limit, health, mount, command, and port contract, `--replace-existing` retains it as a stopped rollback container and restores it automatically if the hardened replacement fails.


The script is idempotent for one approved revision. It:

1. validates the protected runtime file and exact Git state;
2. creates the private attachable `fcd-support-ingress` network if absent;
3. attaches the running `fcd-support-cloudflared` without recreating it;
4. validates the Compose model without printing interpolated secrets;
5. pulls pinned base images and builds the SHA-tagged API image;
6. starts PostgreSQL and applies forward migrations;
7. starts the API on container port `3003` with no host port;
8. runs image, topology, public-path, and signature-rejection verification.

Run the checks again at any time, supplying the deployed revision:

```bash
cd /home/redwan/apps/fcd-support
./scripts/verify-test-deployment.sh "$FCD_APPROVED_REVISION"
```

The verifier proves:

- the running image tag and embedded revision match the approved commit;
- the API and database are healthy and neither publishes a host port;
- both dedicated networks are internal, their endpoint sets are exact, and unrelated containers are rejected;
- the tunnel cannot share the data or Manifest networks;
- the public callback returns an exact challenge for the protected token;
- `https://meta.fastcyberdefense.com/health` returns an ingress-level `404`, not the application-marked `404` that would reveal an overbroad route;
- an unsigned public webhook event returns `401`.

The script never prints the verification token.

## Configure Meta

Only after `verify-test-deployment.sh` passes, enter these values in both the WhatsApp and Messenger webhook setup screens:

- Callback URL: `https://meta.fastcyberdefense.com/webhooks/meta`
- Verify token: the exact `META_VERIFY_TOKEN` value already stored in `/home/redwan/.config/fcd-support/runtime.env`
- Client certificate: off

Open the protected environment file locally in a private editor to copy the token. Do not use `cat`, `echo`, shell history, screenshots, chat, or Git to transfer it.

Select **Verify and save**. Then retry subscriptions for the dedicated WhatsApp test number and Messenger test Page only. Start Messenger with `messages`, `message_deliveries`, `message_reads`, `message_echoes`, `message_reactions`, `message_edits`, and `messaging_postbacks`; add other reviewed fields only when the application implements and tests their behavior.

App development mode may deliver only test events and events from people with an app role. Publishing and production permissions are separate later gates.

## Sanitized Meta Test Evidence

The following non-secret evidence was recorded on 2026-08-26 in `Asia/Dhaka`
(UTC+06:00):

- WhatsApp and Messenger accepted the shared callback verification, with client
  certificates disabled.
- The WhatsApp test number and Messenger test Page were subscribed. No production
  number or production Page was connected.
- The WhatsApp webhook field inventory contains `messages`. The Messenger test-Page
  inventory contains 22 fields: `business_integrity`, `inbox_labels`,
  `marketing_message_delivery_failed`, `message_deliveries`, `message_echoes`,
  `message_edits`, `message_reactions`, `message_reads`,
  `message_template_status_update`, `messages`, `messaging_customer_information`,
  `messaging_feedback`, `messaging_handovers`,
  `messaging_in_thread_lead_form_submit`, `messaging_integrity`, `messaging_optins`,
  `messaging_optouts`, `messaging_policy_enforcement`, `messaging_postbacks`,
  `messaging_referrals`, `response_feedback`, and `standby`. This deliberately broad
  subscription is test-only and does not pre-authorize the same production fields.
- Access remains development-mode and role-scoped. `pages_messaging` live access
  and app review are not complete. Exact token permission scopes and access levels
  still require a separate read-only inspection; token values are never recorded.
- A Messenger role-scoped test message reached durable ingestion.
- WhatsApp webhook-field v26.0 synthetic delivery succeeded for a baseline
  phone-based incoming text at 09:40:12; `sent`, `delivered`, and `read` statuses at
  09:51:15, 09:51:32, and 09:51:47; an exact `sent` retry at 09:53:22; a
  phone-plus-user identity at 09:54:56; a phone-unavailable user identity at
  09:55:50; and a contact-card message at 09:57:00.
- The exact retry did not increase durable receipt or normalized-event counts.
  The phone-unavailable and contact-card samples exposed unsupported outcomes in
  the deployed admission revision; local normalizer coverage now accepts the
  phone-unavailable text identity while deliberately retaining the contact-card
  boundary.
- After this sequence, sanitized durable counts were eight receipts, one pending
  Messenger customer message, one stale WhatsApp customer message, three pending
  WhatsApp status events, and two unsupported WhatsApp events. Meta's fixed sample
  timestamp caused the stale classification; it was not a delivery failure.

A real device-originated WhatsApp reply did not reach the callback while the app
remained unpublished. Synthetic delivery proves callback admission, not live app
permissions or production readiness. Do not publish the app solely to bypass this
development-mode limitation.

## Rollback

The always-safe rollback is an outage: stop the test API and database while preserving the PostgreSQL volume, SHA-tagged images, and independently managed tunnel.

```bash
cd /home/redwan/apps/fcd-support
./scripts/stop-test-deployment.sh
```

Application rollback is available only when the exact earlier SHA-tagged image was retained and its schema compatibility has been reviewed. Run this from the current reviewed operations checkout; do not check out an older commit just to find an older script.

```bash
FCD_ROLLBACK_REVISION='<FULL_RETAINED_COMPATIBLE_COMMIT>'
./scripts/rollback-test.sh "$FCD_ROLLBACK_REVISION" --confirm-schema-compatible
```

The rollback script never rebuilds an old revision, never runs a down migration, and refuses an image whose embedded revision does not match. If compatibility is uncertain or no earlier image exists, use the safe stop procedure.

Do not delete `fcd-support-postgres-data` as a rollback step. Database down migrations require a separate migration-specific review.

## Move to another server

1. Install Docker Engine, the Compose plugin, and Git on the new Ubuntu host.
2. Clone the GitHub repository to `/home/redwan/apps/fcd-support`, fetch the full approved commit, and check it out detached as shown above.
3. Create `/home/redwan/.config/fcd-support` as the deployment user with mode `700`.
4. Transfer `runtime.env` and `cloudflared.token` through a separate encrypted operator-controlled channel; set each file to mode `600`. Never put either file in Git.
5. Run `./scripts/start-cloudflared.sh "$FCD_APPROVED_REVISION"` to create and health-check the SHA-tagged hardened tunnel container. On a known legacy container, review it first and use `--replace-existing "$FCD_APPROVED_REVISION"` to retain a stopped rollback copy rather than deleting it.
6. Run `./scripts/configure-test-runtime.sh` and `./scripts/deploy-test.sh "$FCD_APPROVED_REVISION"`.
7. Run `./scripts/verify-test-deployment.sh "$FCD_APPROVED_REVISION"` before changing any Meta callback or subscription.

This webhook-only stack does not require `mnfst_internal`. Manifest networking belongs to a later reviewed integration profile when tool-free model calls are implemented and tested.

Moving an existing database is intentionally not automated by this test runbook. Encrypted backup, isolated restore, and deletion-ledger reapplication remain blocked Phase 6 work. Until those gates pass, use an empty test database on a replacement host or obtain separate approval for a reviewed data-migration procedure.

If the public hostname or tunnel changes, update Cloudflare first, re-run the public-path and negative-path tests, and only then update Meta. This never authorizes a production WhatsApp number migration, unlink, registration, or coexistence change.
