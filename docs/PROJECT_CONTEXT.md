# Project Context

Last reviewed: 2026-09-13 (Asia/Dhaka)

## Confirmed Decisions

- Build a dedicated customer-support application; OpenClaw and Hermes remain private/internal.
- Automate WhatsApp Business and Facebook Messenger. Instagram DM automation is not part of the first release.
- Use English and Bangla, approved FAQ answers first, and AI only when needed.
- Store reviewed, versioned support knowledge in the existing private PostgreSQL database. Website fetches, customer-derived gaps, model drafts, and owner answers remain proposals until an authenticated reviewer publishes them.
- Use a separate authenticated, loopback/private-access `fcd-support-admin` dashboard for knowledge review, owner questions, privacy-safe insights, model-policy administration, and later independently designed CRM modules. It never joins the public webhook ingress network; a private CLI remains for bootstrap and break-glass operations.
- Improve knowledge through a controlled proposal-only learning loop. Every three days the application may prepare at most five useful owner questions in the dashboard, but neither the AI, Manifest, n8n, a crawl, nor customer repetition can publish knowledge.
- Use Manifest Harness `fcd-support` with its dedicated API configuration, provider scope, default model, up to five fallbacks, limits, and observability.
- Use Manifest-managed allowlisted fallback only. Model output uses a validated structured envelope, operational limits are versioned/customizable under protected deployment ceilings, and unsafe or exhausted inference creates a safe response plus PostgreSQL escalation.
- Use a Meta test number before any production WhatsApp change. The current production account stays linked to Meta.
- Staff retain Meta Business Suite access and manually cover periods when the local server is off.
- Human staff replies pause AI for that conversation for 24 hours unless resumed earlier.
- Crawl `https://fastcyberdefense.com/` only on demand; all changes require review before publication to the knowledge base.
- Lifecycle precedence is `active_client > unconverted_lead > casual_chat`. Casual chats expire 60 days after the latest qualifying human-authored event; unconverted leads expire 12 calendar months after the latest qualifying lead interaction. AI replies, statuses, duplicates, retries, consent bookkeeping, and unresponded marketing sends never extend retention.
- Active-client support content is retained during the documented relationship and for 24 calendar months after the later documented relationship end or final paid service completion. The Fast Cyber Defense Managing Director/business-owner role owns the policy and reviews active-client classifications annually.
- Deletion uses same-channel explicit confirmation plus human review, never a password, OTP, payment credential, or secret. Minimal suppression and restore tombstones use a versioned HMAC identity and no raw identifier or message content.
- `REQUEST MY DATA`, `CORRECT MY DATA`, and all-linked-identity `STOP MARKETING` use deterministic P3-007 intake plus human review. Access collection is private, redacting, one-run, and review-expiring; correction has no production handler until a field owner is approved; marketing opt-out covers all four closed categories and re-opt-in changes only named categories at its effective time.
- Manifest message-body recording must be disabled before customer/model traffic; restored backups remain isolated until all unexpired deletion tombstones are reapplied and verified.
- Marketing requires explicit, category-specific opt-in. Blank means no promotional eligibility.

## Existing Local Infrastructure

- Server: Ubuntu at `192.168.10.40`; normally online about 12 hours per day.
- Capacity observed during planning: 4 CPU cores, about 15 GiB RAM with about 13 GiB available, and about 69 GiB free disk. No GPU is present or required.
- Docker and Docker Compose are already in use.
- Manifest `6.11.0`: local OpenAI-compatible gateway on port `2099`; Docker networks include `mnfst_frontend` and `mnfst_internal`. The `fcd-support`/`auto` host check passes, but recording is enabled, explicit fallback/limit rules were not found, and the admission API lacks private Manifest-network attachment.
- OmniRoute: local gateway on port `20128`; use only if required by the approved Manifest fallback policy.
- n8n `2.35.3`: LAN-bound on port `5678`, with external runners. The audit found zero static `fcd-support` public-API dependencies, but two API keys have historical use; keep the API enabled and LAN-only until their owners are identified.
- OpenClaw and Hermes are already configured but are explicitly outside this application's public execution path.
- UFW and Docker ingress rules are intended to allow LAN access only. Do not add a public router port forward.
- `fastcyberdefense.com` uses Cloudflare nameservers. A dedicated project tunnel container now exposes only the exact Meta webhook path to the internal admission-only API; health, database, n8n, Manifest, OmniRoute, and other paths remain private.

## Planned Deployment

- Local repository: `J:\DevDrive\fcd-support`
- Remote repository: `https://github.com/thefastcyberdefense/fcd-support`
- Proposed server directory: `/home/redwan/apps/fcd-support`
- Public hostname: a dedicated subdomain of `fastcyberdefense.com`, exposing only Meta webhook verification and delivery paths.
- Windows is the only source-authoring, commit, and push host. During an approved test-deployment gate, Ubuntu pulls the exact committed revision from GitHub; do not copy or edit application source directly on the server.

## External Prerequisites

- Cloudflare account access for the Fast Cyber Defense zone and a dedicated tunnel token.
- Meta developer app, Page permissions, WhatsApp test number, webhook verification token, app secret, and channel access tokens.
- Manifest Harness `fcd-support` plus its dedicated endpoint/key and approved routing configuration.
- Telegram destination and authenticated private n8n webhook for escalations.

All secret values are intentionally absent from this repository. Create them during implementation and store them only in protected runtime secret files.

## Test-Asset Status

- The Meta development app, WhatsApp test number, and Messenger test Page are connected to the verified callback; production assets remain untouched.
- Messenger role-scoped customer delivery, a manual Page-reply echo, and WhatsApp v26.0 synthetic incoming/status delivery have reached durable ingestion. The admission-only runtime does not yet apply the echo to policy state.
- The app remains unpublished. A real device-originated WhatsApp message sent during the 2026-08-26 post-redeployment check did not reach the callback, so real delivery and production permissions remain unproven.
- The deployed admission-only normalizer accepts phone-unavailable v26 text messages through a namespaced user identity and deliberately leaves contact-card content unsupported. A signed public-callback smoke test and exact retry passed at revision `207a5e6357c1e1a7c75918793262d835574d898d`.

## Current Local Policy Evidence

- P3-005 retention, P3-006 verified deletion, and P3-007 privacy rights are locally complete. The current gate passes 213 local tests and 244 guarded synthetic PostgreSQL tests across 16 files, with zero leaked temporary schemas or advisory locks.
- P3-006 verifies same-channel requests through authorized human review, atomically tombstones and pseudonymizes linked identities, clears implemented raw event/customer content, retains aggregate evidence, and blocks later raw storage for deleted identities.
- The restore primitive reapplies all covered active tombstone key versions in bounded batches and refuses a pass on missing keys, failed/nonzero evidence, remaining matches, changed revision material, or an incomplete concurrent scan.
- P3-007 exact intake, reviewer holds, redacting one-run access collection, typed correction boundaries, category-scoped opt-out/re-opt-in, and evidence-preserving rollback pass locally. Security scan `1f4a68bb-5290-480f-89f4-6297d840ec87` reviewed 15 production surfaces; its five medium findings in the original range all have guarded remediation tests.
- No Meta/Manifest/provider deletion, access delivery, export/offline/archive cleanup, notification delivery, actual backup creation/restore/promotion, Ubuntu redeployment, or production action occurred. Those locations remain pending or belong to P6-004 and later test gates.

## Current Phase 5 Checkpoint

- Approved plan Tasks 1 through 17 and P4-GATE are locally complete: knowledge schema/repository/publication, admin and learning schema, password/MFA/session primitives, PostgreSQL identity, the loopback-only dashboard foundation, proposal-only learning with owner questions, the fail-closed sensitive-data gate, FAQ-first resolution, guarded reply/model decisions, local fail-closed Manifest contracts/client, authoritative customizable model-policy enforcement, and the reviewed synthetic evaluation gate.
- The private service supports reviewed bilingual proposals, provenance, replacements, submit/approve/reject, exact-version publication/scheduling/retirement/rollback, stable retry material, and transactional session/role checks. Public webhook routes remain unchanged.
- Proposal-only learning accepts only applied internal customer events, stores closed content-minimized gap evidence, suppresses groups below the configured distinct-person threshold, inherits the earliest retention deadline, and reuses stable open questions across repeated aggregate runs while allowing a new generation after a terminal answer or dismissal. Aggregation rechecks current privacy holds, deletion state, and purging. Digest cadence, maximum questions, cooldown, repeat ceiling, group threshold, and observation bound are environment-configurable inside approved safety bounds.
- Authenticated knowledge editors answer English/Bangla owner questions through the private dashboard. Each answer creates an append-only answer record and a `support_gap` draft proposal; no review or publication event is created.
- Sensitive inspection is bounded by a supplied policy value and returns only closed safe/redacted/blocked outcomes. Password/authentication, OTP/recovery, API/token/cookie/session, payment/bank, private-key/credential-file, sensitive-incident, ambiguous-redaction, malformed-Unicode, and excessive-input cases fail closed. A single deterministic removal may continue only when an ordinary question remains, using typed value-free markers. Reviewed English/Bangla safe responses are deterministic and model-free.
- FAQ resolution accepts only process-issued prepared text from a successful sensitive-data inspection. Exact reviewed questions, aliases, examples, and intents outrank similarity; equal or close candidates fail closed as ambiguous. PostgreSQL selects at most one strongest alias per currently effective approved bilingual FAQ version through the existing GIN trigram index and a materialized pre-window bound. Review and publication decisions must both be effective at the evaluation time. Minimum similarity, ambiguity margin, and maximum candidates are validated supplied policy values.
- Reply decisions accept only applied customer events, inspect sensitive content before FAQ, and persist exactly one FAQ draft, deterministic safe draft plus escalation, or content-minimized gap. Human pause, open privacy workflow, deletion, content erasure, and retention are rechecked under PostgreSQL locks before persistence. Deletion, restore, and retention erase new content; access export v2 adds allowlisted subject-scoped Phase 4 records. Open active clients use their required annual review boundary while the current conversation lifecycle remains authoritative for erasure.
- Manifest configuration has no operational defaults in source: contact/global rates, concurrency, queue, timeout, tokens, cooldown, provider attempts, response bytes, context, and input are environment-supplied protected ceilings. Effective operational limits take the stricter maximum and longer cooldown across policy, deployment, and verified Manifest sources. The checked-in example keeps every unverified live-state attestation false.
- Manifest request construction accepts only process-issued sanitized text, preserves injection as user data, fixes `model: "auto"`, bounds all content, and emits no tool/provider/fallback fields. Structured output is byte-bounded and strict, with closed rejections for schema, reference, factual grounding, language, secret, URL, and action claims in English/Bangla.
- The Manifest HTTP client accepts only builder-issued requests and snapshots validated settings. It makes exactly one non-streaming POST to the configured private `/v1/chat/completions` endpoint, rejects redirects and tool-call responses, bounds bytes before JSON parsing, never reads/logs error bodies, races transport/body reads against caller abort and total timeout, and returns only closed local outcomes. The loopback fake records structure and booleans only and rejects non-synthetic authorization values.
- Migration eleven stores immutable model-policy versions and append-only submit/approve/activate/retire evidence. Operational and FAQ limits have no database defaults; active policy is unique, provider attempts cannot exceed the architecture ceiling, usage windows are closed and pseudonymous, and leases contain only internal references, closed lifecycle/outcome values, and timestamps. Populated downgrade fails closed.
- Effective policy requires exactly one event-time-active PostgreSQL version plus verified Manifest limits, then intersects policy, protected deployment, and Manifest values field by field. Allowance transactions derive a pseudonymous scope from the authoritative internal contact, serialize rolling 15-minute/24-hour and global UTC-day counts, cooldown, concurrency, queueing, exact replay, and expiry. Eleven model-failure categories persist content-free source-bound escalation evidence.
- The loopback/private policy page is administrator-only and uses live-session authorization, CSRF/origin checks, session-bound signed actions, explicit inputs for every customizable value, and content-free audit. Existing escalation views remain aggregate-only.
- The model stage is reachable only from an authoritative FAQ gap for the same applied event. It re-inspects content, loads bounded effective reviewed facts, acquires one lease, issues at most one tool-free auto request, validates output twice, and rechecks takeover, privacy, deletion, retention, and current publication before storing a fact-linked model draft. Every exhausted, invalid, stale, or failed path creates a reviewed safe draft plus one content-free escalation when policy permits; exact/crash replay cannot issue an unbounded second request.
- The newly authored evaluation corpus contains 35 synthetic cases (18 English, 17 Bangla), covers AC-05/10/21/22/25 and every approved sensitive class, scores all seven declared local-fake invariants at 100%, records 12/12 acceptable self-reviewed scripted outcomes, and has zero critical failures. Negative controls prove the scorer rejects invariant, rating, critical, and provenance failures. This does not claim independent human or real-provider quality.
- Validation on 2026-09-14: `npm run check` passed 473 tests across 39 files plus formatting, lint, strict type checking, build, and the Phase 0 validator; all 345 guarded PostgreSQL tests across 27 files passed. No browser run, deployment, Manifest call, provider call, external mutation, or production action was performed. Detailed evidence: `docs/testing/phase-4-evaluation-review.md` and `docs/reviews/phase-4-gate.md`.
- P5-001 is complete under the owner's delegated local approval. The committed architecture and implementation plan select one PostgreSQL intent per source, last-moment policy rechecks, customizable reviewed rate/retry limits, an at-most-once bias for ambiguous dispatch, Graph API `v25.0`, loopback-only adapter evidence, monotonic status handling, and a bounded Messenger echo-correlation hold. No live provider call or deployment was made.
- P5-002 is in progress. Implementation-plan Task 1 adds migration 000012 with ten closed PostgreSQL tables for reviewed outbound policy/templates, content-free intents, controlled attempts, rate windows, signed status evidence, Messenger echo holds, and escalation outcomes. Policy values have no database defaults; populated downgrade fails closed; intent sources/account scope, terminal evidence, provider-message correlation, and required `pending_outbound` deletion evidence are guarded.
- Validation on 2026-09-16: the RED migration run failed with migration count 11 and no Phase 5 tables; after implementation, `npm run check` passed 473 tests across 39 files plus formatting, lint, strict type checking, build, and the Phase 0 validator, and all 349 guarded PostgreSQL tests across 27 files passed. No live provider call, deployment, external mutation, customer data, or production action occurred.
- Implementation-plan Task 2 defines closed outbound channel/language/purpose/state/result contracts; strict numeric policy and deployment-bound parsing; stricter two-source limit intersection; exact Graph `v25.0`; production-only `https://graph.facebook.com`; opt-in loopback HTTP fake mode; and redacted, non-serializing credential wrappers. Every bound and account credential is explicit, and the checked-in environment example contains blank keys only.
- Task 2 validation on 2026-09-16: the required RED run failed only on missing outbound modules; after implementation, `npm run check` passed 530 tests across 41 files plus formatting, lint, strict type checking, build, and gate validation. No provider, network, deployment, or external call occurred.
- Implementation-plan Task 3 adds administrator-authorized, request-key-idempotent PostgreSQL repositories for reviewed outbound policy and fixed zero-variable WhatsApp templates. Separate submit, approve, activate, retire, and event-time resolution paths preserve append-only evidence, enforce exact account/category/locale/template scope, intersect policy with protected deployment bounds, serialize concurrent activation, reject conflicting replay and invalid transitions, and roll failed transactions back fully.
- Task 3 validation on 2026-09-16: the required RED runs failed only on missing outbound modules; after implementation, `npm run check` passed 552 tests across 42 files plus formatting, lint, strict type checking, build, and gate validation, and all 360 guarded PostgreSQL tests across 29 files passed. No provider, network, deployment, external mutation, customer data, or production action occurred.
- Implementation-plan Task 4 adds a pure fail-closed eligibility contract and a transactional PostgreSQL intent store. It derives conversation, identity, channel/account, policy, and template authority server-side; locks and rechecks source, pause, echo hold, privacy, deletion, suppression, exact consent, Meta's fixed 24-hour response window, retention, and active-client review state; creates one content-free intent under exact replay and concurrency; and records content-free terminal enqueue escalations. Marketing purposes map to the existing closed Phase 3 consent categories, while marketing opt-outs do not suppress customer-support replies.
- Task 4 validation on 2026-09-16: the required RED runs failed only on missing eligibility/store modules; after implementation and concurrency review, `npm run check` passed 576 tests across 43 files plus formatting, lint, strict type checking, build, and gate validation, and all 369 guarded PostgreSQL tests across 30 files passed. No provider, network, deployment, external mutation, customer data, or production action occurred.
- Next is implementation-plan Task 5: implement leases, rate reservations, definite retry, ambiguous-result handling, and expiry test-first. P5-003 through P5-005 remain dependency-gated.

## Launch Blockers

- The admission-only test deployment is approved and running under a narrow exception. Outbound messaging, models, n8n actions, live customer data, and production deployment remain unauthorized.
- P3-GATE passed on 2026-09-01 at validated revision `bb95803`. The project owner approved the major P4-001 architecture decisions and delegated the remaining local Phase 4 design/implementation approvals on 2026-09-01. P4-002 through P4-006 and the local P4-GATE now pass. Live recording-off, private-network, provider, test-asset, outbound, and production evidence remains governed by later gates.
- Phase 0 is evidence-complete: the threat model, acceptance matrix, and planning-only gate review are recorded in `docs/security/threat-model.md`, `docs/testing/acceptance-matrix.md`, and `docs/reviews/phase-0-gate.md`. This closes architectural planning only; every `PARTIAL`, `PLANNED`, or `BLOCKED` acceptance row remains a launch blocker. The project owner authorized reversible local development through Phase 5; exceptions and current contracts are tracked in `docs/TODO.md`.
- Meta test callback and subscription flows are validated only for development-mode test assets. App review, live permissions, and production assets remain unvalidated.
- WhatsApp coexistence for the production number has not been confirmed.
- The dedicated Manifest host harness/key and `auto` model are verified privately, but the application-network route, recording-off state, and explicit provider fallback/limit behavior remain untested.
- The WhatsApp test token was expired at inventory time; the app remains development/role-scoped, and runtime Graph `v25.0` versus webhook-sample `v26.0` requires an approved version/support decision.
- n8n's audit found no `fcd-support` public-API dependency, but owners of historically used API keys must be identified before revocation or disablement.
- Website privacy and support wording must disclose AI assistance, external inference, retention, deletion, and marketing consent before production launch.
- Actual encrypted backup/restore procedures and deployed human-takeover behavior must still pass their acceptance tests; the local restore-gate primitive alone does not satisfy P6-004.

The current tracker action is P5-002 PostgreSQL outbox development. All live
Meta, Manifest, network, deployment, test-asset, and production
actions remain separately gated. P1-GATE remains a separate explicit review
record.

## First Session Checklist

1. Read `docs/PLAN.md`, `AGENTS.md`, and this file.
2. Inspect Git status and preserve unrelated changes.
3. Read `docs/TODO.md` and select the first unblocked task whose dependencies are complete.
4. Use `docs/operations/preflight-inventory.md` for current Manifest, Meta, n8n, and Cloudflare readiness; repeat external inspection only when the tracker requires it, without exposing secrets or modifying production assets.
5. Implement lifecycle behavior only from `docs/architecture/data-lifecycle.md` and do not treat evidence-complete inventories as implementation or production readiness.
6. Deploy to the test-number environment only after all local phase gates pass and the exact external actions receive approval.
