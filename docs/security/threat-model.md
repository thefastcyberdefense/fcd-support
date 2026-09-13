# Fast Cyber Defense Support Threat Model

Status: reviewed Phase 0 architecture threat model (`P0-017`)

Reviewed: 2026-09-01 (Asia/Dhaka)

Scope: the public Meta webhook boundary, the current admission, retention,
verified-deletion, and privacy-rights policy core, and the planned private model, automation,
outbound, backup, and operational paths. This is an architecture threat model, not a
claim that every planned control is implemented and not a vulnerability audit.

## 1. Overview

### Security summary

The service accepts attacker-controlled Internet traffic only on the exact Meta
verification and event callback. Signed events cross into the application as
unmodified bytes, are verified before parsing, and are acknowledged only after
minimal PostgreSQL persistence. PostgreSQL is the authority for conversation,
takeover, consent, lifecycle, deletion, and future outbound state. Manifest and
n8n are private downstream services and must never become authorities for that
state. The production WhatsApp number is outside the present test scope.

The repository implements narrow webhook admission, the Phase 3 conversation
policy core, retention jobs, verified local deletion, deterministic privacy
request intake, in-memory access collection, typed correction, global marketing
suppression, pre-storage resurrection blocking, and an isolated-database restore
reconciliation/promotion primitive.
Actual encrypted backup/restore procedures, provider/offline deletion, model
calls, outbound providers, and n8n integration remain planned controls. The
acceptance matrix records their evidence state rather than assuming them.

### Components and source evidence

| Component | Security role | Source evidence |
|---|---|---|
| Cloudflare Tunnel | Exposes only the Meta callback; all other routes stop at ingress | `AGENTS.md:14`; `scripts/verify-test-deployment.sh:254`; `scripts/verify-test-deployment.sh:262` |
| Fastify admission API | Applies a 256 KiB limit, keeps JSON as raw bytes, verifies signatures, parses only afterward, and returns `503` if durable receipt fails | `src/app.ts:30`; `src/app.ts:36`; `src/app.ts:83`; `src/app.ts:99`; `src/app.ts:113` |
| Signature verifier | Requires the `sha256=` format and compares the raw-body HMAC in constant time | `src/meta/verify-signature.ts:9`; `src/meta/verify-signature.ts:27`; `src/meta/verify-signature.ts:30` |
| PostgreSQL receipt/event store | Persists minimal normalized events and enforces receipt and event uniqueness | `migrations/000001_create_webhook_receipts.ts:5`; `migrations/000001_create_webhook_receipts.ts:14`; `migrations/000001_create_webhook_receipts.ts:33` |
| Phase 3 policy core | Applies events once, serializes workers, records takeover and consent, enforces retention, and performs verified local deletion | `src/persistence/postgres-conversation-event-processor.ts`; `src/persistence/postgres-consent-policy.ts`; `src/persistence/postgres-retention-policy.ts`; `src/persistence/postgres-deletion-policy.ts` |
| Privacy-rights services | Prove exact applied-message intents, hold access/correction for review, collect access data in memory, permit only typed correction handlers, and enforce all-linked marketing suppression | `src/policy/privacy-intent.ts`; `src/persistence/postgres-privacy-rights-policy.ts`; `src/persistence/postgres-access-export.ts`; `src/persistence/postgres-correction-policy.ts`; `src/persistence/postgres-marketing-opt-out-policy.ts` |
| Reviewer boundary | Requires an authenticated principal with `support_reviewer` before private resume or reviewer-recorded consent | `src/policy/reviewer-principal.ts:17`; `src/policy/reviewer-principal.ts:20`; `docs/architecture/channel-behavior.md:83` |
| Manifest `fcd-support` | Local fail-closed configuration, sanitized tool-free request, strict output, and single-attempt private HTTP client contracts exist; live connection remains absent, and recording must be off before traffic | `src/model/model-config.ts`; `src/model/manifest-request.ts`; `src/model/manifest-output.ts`; `src/model/manifest-client.ts`; `docs/testing/phase-4-manifest-client.md` |
| n8n | Planned private notification/CRM adapter; never owns authoritative support state | `AGENTS.md:21`; `docs/operations/preflight-inventory.md:121` |
| Deletion tombstones and restore gate | Versioned identity HMACs block later raw storage; isolated restore reconciliation refuses a pass on missing keys, failures, remaining matches, or incomplete scans | `src/persistence/postgres-receipt-store.ts`; `src/persistence/postgres-restore-deletion-gate.ts`; `tests/integration/postgres-restore-deletion-gate.test.ts` |
| Windows/GitHub/Ubuntu release path | Windows authors and pushes; Ubuntu deploys an exact approved revision | `docs/PROJECT_CONTEXT.md:39`; `scripts/verify-test-deployment.sh:14`; `scripts/verify-test-deployment.sh:167` |

### Effective resource and exposure table

| Resource | Exposure | Data or capability | Current disposition |
|---|---|---|---|
| `GET /webhooks/meta` | Public through exact tunnel path | Verification challenge; protected verify token comparison | Implemented and test-deployed |
| `POST /webhooks/meta` | Public through exact tunnel path | Signed Meta event bytes | Implemented and test-deployed |
| All other application routes | Private / ingress `404` | No public administrative capability | Enforced by deployment verifier |
| PostgreSQL | Private data network, no host port | Receipts, normalized events, policy, retention, privacy-rights evidence, deletion, and restore-gate state | Implemented locally through P3-007 |
| Manifest | Private network only | Redacted prompts and model output | Not connected to current admission runtime |
| n8n | LAN/private only | Notifications and later CRM requests | No `fcd-support` integration yet |
| Meta Graph outbound | External provider call | Customer replies and delivery state | Not implemented |
| Backup repository | Private operator path | Encrypted database backups and tombstones | Not implemented |
| Reviewer/admin operations | Private authenticated path | Resume, consent review, privacy-request decisions, correction execution, deletion approval | Policy functions enforce reviewer authority; no public admin route |
| Production WhatsApp/Page assets | Explicitly out of scope | Live customer communication | No action authorized |

```mermaid
flowchart LR
  Internet[Internet / Meta] -->|exact GET or signed POST| CF[Cloudflare Tunnel]
  CF --> API[Admission API]
  API -->|commit before 200| PG[(PostgreSQL)]
  PG --> Worker[Policy / future reply workers]
  Worker -. redacted, no tools .-> Manifest[Manifest fcd-support]
  Worker -. outbound intent .-> Meta[Meta Graph]
  Worker -. private notification .-> N8N[n8n]
  PG -. encrypted backup .-> Backup[(Backup store)]
  Reviewer[Authenticated reviewer] -. private control .-> Worker
```

## 2. Threat Model, Trust Boundaries, And Assumptions

### Assets

- Meta app secret, verification token, channel access tokens, tunnel token,
  Manifest key, database credentials, suppression HMAC keys, and backup keys.
- Customer channel identities, message content, consent history, deletion
  requests, takeover state, lifecycle classification, and audit history.
- PostgreSQL integrity, event idempotency, outbound-intent uniqueness, and
  restored-deletion enforcement.
- Approved FAQ/business facts, model prompts/responses, and Manifest recordings.
- Git history, dependency and image integrity, approved revisions, operational
  logs, and availability of manual coverage.
- The unchanged production WhatsApp number and production Facebook Page.

### Trust boundaries

1. **Internet to Cloudflare:** arbitrary clients can reach only the configured
   hostname/path. Cloudflare routing is not an authenticity control for events.
2. **Cloudflare to admission API:** `GET` verifies a shared token; `POST`
   authenticates unmodified bytes with the Meta app secret before parsing.
3. **Admission API to PostgreSQL:** a `200` means the minimal receipt transaction
   committed; database unavailability must fail closed with `503`. This contract
   is explicit in `docs/architecture/webhook-admission.md:23` and
   `docs/architecture/webhook-admission.md:28`.
4. **Receipt store to asynchronous policy:** only pending, normalized, unique
   events may change policy state. Stale messages and excessive future skew
   cannot cause automation (`docs/architecture/webhook-admission.md:89`).
5. **Private reviewer to policy state:** identity and role authentication occur
   outside the public callback; the policy layer rechecks the reviewer role.
6. **Application to Manifest:** all customer/model content becomes data disclosed
   to an external inference provider. Inputs require redaction, FAQ precedence,
   bounded limits, no tools, and recording-off verification.
7. **Application to Meta Graph:** provider tokens authorize external messaging.
   A durable outbox and last-moment policy checks must precede every send.
8. **Application to n8n:** n8n receives authenticated, idempotent notifications
   only; it cannot own conversation, consent, deletion, or delivery state.
9. **PostgreSQL to backup/restore:** an immutable backup may contain later-deleted
   data. Restore remains isolated until tombstones are reapplied and verified.
10. **Windows/GitHub to Ubuntu:** source and deployment artifacts cross a release
    boundary. An approved commit and image revision must be reproducibly matched.
11. **Test assets to production assets:** development-mode evidence cannot prove
    coexistence, live permissions, or safe production-number onboarding.

### Attacker capabilities

- An unauthenticated Internet attacker can send, replay, reorder, delay, truncate,
  oversize, or flood callback requests and choose every unsigned payload byte.
- A customer can control message text and supported attachment metadata that Meta
  later signs. Signed customer content is authenticated delivery, not trusted
  instructions.
- A compromised staff, Meta, Cloudflare, GitHub, Ubuntu, database, Manifest, n8n,
  or provider credential can exercise the permissions granted to that component.
- A malicious prompt can attempt instruction injection, sensitive-data recovery,
  or provider-cost amplification, but must not gain tools or internal credentials.
- An operator can make mistakes in DNS, subscriptions, token files, backups,
  migrations, and production-number onboarding.
- The model does not assume an attacker can forge Meta HMAC-SHA256 without the app
  secret, break standard cryptography, or bypass correctly enforced host access.

### Security objectives

- Reject forged events before parsing, storage, logging, or side effects.
- Make accepted retries, concurrency, restarts, stale messages, and out-of-order
  delivery safe and idempotent.
- Prevent automated replies while human takeover, missing consent, deletion,
  retention expiry, or provider-policy restrictions apply.
- Keep secrets and customer content out of Git, logs, fixtures, evidence, and
  unauthorized model/provider paths.
- Preserve deletion across live storage, derived records, recordings, and restore.
- Maintain least-privilege network and token boundaries and a verifiable release.
- Fail safe while the local server or a dependency is unavailable, with manual
  Business Suite coverage rather than unsafe automatic recovery.
- Prevent any Phase 0 or test result from authorizing a production Meta mutation.

### Assumptions and explicit unknowns

- Meta signs legitimate callback bytes with the configured app secret and its
  platform behavior matches the supported Graph version.
- Cloudflare, Ubuntu, GitHub, Meta Business, Manifest, n8n, and database operator
  accounts are separately protected; credential-management quality was not
  assessed by this repository review.
- The current deployment is admission-only. It cannot call Manifest, n8n, or Meta
  Graph, which limits current blast radius (`docs/operations/test-deployment.md:5`).
- The service is available only while the local server runs; manual support covers
  downtime. Availability is therefore an accepted operational constraint, not a
  claim of high availability.
- Manifest recording is currently enabled and explicit fallback/limit rules were
  not found (`docs/operations/preflight-inventory.md:35`). Model traffic remains
  blocked until that state is corrected and contract-tested.
- Real WhatsApp device delivery, coexistence/manual-app echoes, app review, and
  production permissions remain unproven (`docs/architecture/channel-behavior.md:180`).
- Access/correction/global opt-out policy behavior passes locally. The P3-007
  security diff scan reported five medium findings in the original implementation;
  guarded fixes now cover export redaction, fresh one-run authorization,
  effective-time consent, category isolation, and evidence-preserving rollback.
  No access package or notification was externally delivered and no
  provider/offline checklist operation ran. Actual backup/restore automation,
  outbound, model, and n8n controls remain requirements until their tracker rows
  and acceptance evidence pass.

## 3. Attack Surface, Mitigations, And Attacker Stories

All rows are architecture hypotheses to test or control; they are not findings
that exploitation has occurred.

| Priority | Scenario and capability gained | Prerequisites | Impact | Existing controls | Required mitigation / next gate | Evidence |
|---|---|---|---|---|---|---|
| High | Forge or mutate a callback to create trusted work | App-secret theft or signature/parser inconsistency | False state, replies, consent, or takeover | Raw-buffer HMAC before parse; constant-time comparison; unsigned deployed check | Rotate compromised secret; keep raw-byte and malformed-body tests in every release | `src/app.ts:83`; `src/meta/verify-signature.ts:27`; `tests/app.test.ts:126` |
| High | Replay or race a valid signed event to duplicate a side effect | Capture a valid delivery or exploit retries/concurrency | Duplicate pauses, consent, or future sends | Receipt digest and event-key uniqueness; transactional `SKIP LOCKED`; append-only policy history | Extend the same uniqueness/outbox rule to every outbound and lifecycle worker | `migrations/000001_create_webhook_receipts.ts:14`; `src/persistence/postgres-conversation-event-processor.ts:95`; `docs/architecture/channel-behavior.md:92` |
| High | A stale, future, or out-of-order event reverses current policy | Valid delayed signed event | Reopened automation, extended retention, incorrect status | Five-minute message staleness, 60-second future quarantine, provider-time ordering | Retention and outbox jobs must use the same monotonic/event-time rules | `docs/architecture/webhook-admission.md:89`; `docs/architecture/data-lifecycle.md:112` |
| High | Broaden the tunnel to reach health, admin, database, Manifest, or n8n | DNS/tunnel/operator misconfiguration | Internal discovery or privileged access | Exact-path route; negative path must stop at ingress; private internal networks | Re-run topology and negative-path checks after every tunnel or host change | `AGENTS.md:14`; `scripts/verify-test-deployment.sh:178`; `scripts/verify-test-deployment.sh:254` |
| Medium | Flood callback bodies or provider work to exhaust CPU, DB, or spend | Public reachability or many valid customer events | Availability loss or unexpected provider cost | 256 KiB body cap, bounded DB timeouts, minimal synchronous work; immutable customizable model policy plus fixed usage-window and lease schema | Implement and test atomic allowance/lease enforcement and alerts before outbound | `src/app.ts:12`; `src/runtime.ts:33`; `migrations/000011_create_model_policy.ts`; `docs/testing/phase-4-model-policy-schema.md` |
| High | Log or evidence pipeline exposes secrets/customer content | Error paths, debugging, fixture mistake | Credential compromise or privacy breach | Closed safe logger fields; prohibited repository/evidence data; sanitized fixtures | Keep privacy scans and human review; never attach raw provider captures | `src/logging.ts:38`; `AGENTS.md:12`; `docs/SYNTHETIC_FIXTURE_POLICY.md:7` |
| High | Database failure is acknowledged as success | Sink outage, lock, transaction error | Irrecoverable event loss | Receipt must commit before `200`; errors return `503`; bounded transaction rollback | Monitor sanitized failure counts and validate restart/outage recovery | `src/app.ts:113`; `src/app.ts:119`; `src/persistence/postgres-transaction.ts:18` |
| High | Service self-echo is mistaken for staff activity, or staff echo is missed | Missing outbound correlation or race | Reply loops or AI replying over a human | Business echoes never generate replies; unmatched echoes fail safe by pausing | Phase 5 must correlate durable outbound/provider IDs before Messenger sends; test both race orders | `docs/architecture/channel-behavior.md:61`; `docs/architecture/channel-behavior.md:88`; `docs/architecture/channel-behavior.md:99` |
| High | Unauthorized reviewer resumes AI or records consent | Public/admin exposure or weak caller authentication | Replies during takeover or unlawful marketing | No public reviewer route; policy requires `support_reviewer`; exact identity/category scope | Implement authenticated private admin adapter and authorization audit before exposure | `docs/architecture/channel-behavior.md:83`; `src/policy/reviewer-principal.ts:20`; `src/persistence/postgres-consent-policy.ts:120` |
| High | Missing, blank, cross-channel, or stale consent is treated as opt-in | Bad defaults or identity collision | Unauthorized marketing | Eligibility is true only for latest exact grant; blank/invalid is denied | Recheck consent immediately before each marketing send and after restore | `src/persistence/postgres-consent-policy.ts:129`; `AGENTS.md:29`; `docs/architecture/data-lifecycle.md:34` |
| High | Deletion authenticates with a secret or targets the wrong identity | Social engineering or identity confusion | Data loss or privacy breach | Same-channel confirmation, authorized human review, prohibited-secret validation, idempotent execution, rollback, and exact identity tests pass locally | Keep reviewer controls private and complete provider, export, offline, and backup checklist locations manually | `src/persistence/postgres-deletion-policy.ts`; `tests/integration/postgres-deletion-policy.test.ts` |
| High | Access export discloses another subject, deleted pseudonyms, or secrets | Wrong request/contact binding, broad collector, stale review, replay, or unsafe output sink | Wrongful disclosure or credential exposure | Approved in-progress request locks its contact; review expires after 24 hours; one run per request; exact replay returns no export; seven subject-filtered collectors redact secret-shaped whole messages; deleted identities fail closed; export remains caller-memory-only; evidence stores counts only | Keep export delivery manual/private until a separately approved transport proves identity, redaction, and no persistence/logging | `src/persistence/postgres-access-export.ts`; `tests/integration/postgres-access-export.test.ts`; `tests/integration/postgres-privacy-rights-interactions.test.ts` |
| High | Correction mutates the wrong subject or an arbitrary/security-sensitive field | Request confusion, dynamic SQL/path, or over-broad handler registry | Data integrity loss, credential handling, or cross-customer change | Reviewer-only approved request/contact lock; strict field key; typed handler-owned parser; empty production registry; closed manual/rejected fallbacks; same-transaction rollback | Add a production handler only with an authoritative field owner and separate field-specific tests; keep reviewer adapter private | `src/persistence/postgres-correction-policy.ts`; `tests/integration/postgres-correction-policy.test.ts` |
| High | Identity-link or category confusion scopes opt-out or re-opt-in incorrectly | Incorrect contact linkage, cross-channel selector, or clearing a global row for one category | Unlawful marketing or suppression of another customer | Authoritative applied source selects the contact; opt-out locks every linked identity and creates four closed category suppressions; suppression HMAC includes channel; re-opt-in expires only named categories for the selected scope at its effective time | Recheck linkage and suppression immediately before every future send; never infer a link or category from message text | `src/persistence/postgres-marketing-opt-out-policy.ts`; `tests/integration/postgres-marketing-opt-out-policy.test.ts` |
| High | Stale, restored, or future-dated consent overrides an active opt-out | Ordering bug, HMAC key rotation gap, future-effective grant, or restored database drift | Unauthorized marketing | Legacy global and exact scoped suppressions precede grants across supported key versions; consent evaluation excludes future rows; only later explicit reviewed re-opt-in expires selected suppression at its effective time | P6 restore procedure must load every active key version; Phase 5 must perform the same last-moment suppression check | `src/persistence/postgres-consent-policy.ts`; `src/persistence/postgres-marketing-opt-out-policy.ts`; `tests/integration/postgres-marketing-opt-out-policy.test.ts` |
| Medium | Populated privacy-rights rollback fails after partial schema mutation or loses evidence | Operator downgrade after P3-007 evidence exists | Availability loss, inconsistent schema, or privacy audit loss | Migration eight refuses before mutation with SQLSTATE `55000` when any P3-007 run, notification, audit, checklist, or scoped suppression exists; it never deletes evidence | Preserve and explicitly resolve governed evidence before any approved downgrade; keep populated and empty down/up tests in the migration gate | `migrations/000008_scope_marketing_suppressions.ts`; `tests/integration/migrations.test.ts` |
| High | Offline/provider search is incomplete but a privacy request is marked complete | Manual omission or treating local completion as global completion | Incomplete access/correction/deletion response | Closed checklist registry; database completion trigger rejects unresolved required locations; local services update only owned locations | Named operators must attest provider/Manifest/export/offline/backup locations; do not automate completion without an approved adapter | `migrations/000004_create_deletion_safety.ts`; `src/persistence/postgres-privacy-rights-policy.ts` |
| Medium | Notification payload or failure leaks the phrase, identity, correction value, or export | Over-rich intent/workflow payload or raw error forwarding | Privacy metadata/content disclosure | Durable notification intent contains only type, parent ID, state, and idempotency key; no n8n delivery exists; correction errors are generic | Future P6 adapter must authenticate, minimize, and test retries without copying customer content | `migrations/000005_create_privacy_rights_workflows.ts`; `src/persistence/postgres-correction-policy.ts`; `tests/integration/postgres-privacy-rights-policy.test.ts` |
| High | A later event or restore resurrects deleted customer content | Provider retry or immutable pre-deletion backup | Deleted data is served again | Receipt storage checks versioned tombstones before raw persistence; restore batches reapply shared erasure; finalization performs a complete lock-safe scan | P6-004 must build encrypted backup/isolation/rollback/attachment procedures that require the persisted pass record | `src/persistence/postgres-receipt-store.ts`; `src/persistence/postgres-restore-deletion-gate.ts`; `tests/integration/postgres-restore-deletion-gate.test.ts` |
| High | Prompt injection gains tools, secrets, or unapproved business claims | Adversarial signed customer text | Data exfiltration or harmful actions | Sensitive inspection precedes FAQ/model preparation; request policy is fixed and tool-free; injection stays quoted data; builder provenance binds output validation to the exact supplied facts; structured output rejects unsupported claims, secrets, unapproved URLs, actions, and tool calls | Complete the active model-policy path and bilingual injection evaluation before any private test traffic | `src/model/manifest-request.ts`; `src/model/manifest-output.ts`; `src/model/manifest-client.ts`; `docs/testing/phase-4-manifest-client.md` |
| High | Manifest records customer bodies or falls back through unapproved providers | Recording/fallback misconfiguration | Third-party retention or secret-scope expansion | No current application connection; dedicated harness/key inventory; local configuration fails closed unless recording, provider allowlist, limits, deletion/retention, and private routing are explicitly attested | Disable and verify recording; approve explicit providers/fallbacks/limits; test `fcd-support` + `auto` through the later private gate | `src/model/model-config.ts`; `docs/testing/phase-4-manifest-contracts.md`; `docs/operations/preflight-inventory.md:37`; `docs/operations/preflight-inventory.md:47` |
| Medium | n8n becomes a state authority or gains a public control path | Over-broad workflow/API design | Divergent consent/delivery state or unauthorized action | LAN-only service; zero discovered `fcd-support` public-API dependency; PostgreSQL authority rule | Use an authenticated idempotent private notification adapter only; resolve legacy key ownership | `AGENTS.md:21`; `docs/operations/preflight-inventory.md:101`; `docs/operations/preflight-inventory.md:117` |
| High | Crash/race around provider send causes duplicate or policy-ineligible output | Outbound implementation without durable intent/lease | Duplicate messages, takeover breach, policy violation | Outbound not implemented, so current runtime cannot send | PostgreSQL outbox, leases, idempotency, last-moment pause/consent/deletion/window checks, local HTTP fakes | `docs/TODO.md:103`; `docs/architecture/channel-behavior.md:96` |
| High | Compromised or drifted release runs code other than the approved commit | Registry/tag drift, server edit, dependency substitution | Arbitrary application behavior | Immutable revision tag/label checks; Windows-only authoring rule; pinned images/dependencies | Keep protected branch/CI, exact pull/build, SBOM/dependency review, rollback evidence | `scripts/verify-test-deployment.sh:162`; `scripts/verify-test-deployment.sh:167`; `docs/PROJECT_CONTEXT.md:39` |
| High | Test evidence accidentally uses live data or production assets | Operator error or copied provider capture | Privacy exposure or production disruption | Synthetic fixture policy; production number stop rule; test assets separated | Keep evidence manifests sanitized and require immediate approval for every external action | `AGENTS.md:12`; `AGENTS.md:29`; `docs/architecture/channel-behavior.md:190` |
| High | Production-number onboarding breaks the current account or loses coexistence | Treating test-number success as production proof | Support outage or irreversible migration | Production number untouched; test-number evidence explicitly non-transferable | Perform read-only coexistence eligibility later; stop and request separate decision if unavailable | `docs/architecture/channel-behavior.md:145`; `docs/architecture/channel-behavior.md:190` |
| Medium | Local server or tunnel outage causes delayed support | Host, power, network, or tunnel failure | Automation unavailable; retries/delays | Manual Meta Business Suite coverage; durable retry semantics | Exercise outage/restart tests and document operator alert/coverage ownership before test gate | `README.md:30`; `docs/TODO.md:129` |

### Failure-mode disposition

| Failure mode | Safe response | Evidence state |
|---|---|---|
| Invalid verification token | `403`, no storage or side effect | Automated and deployed verification evidence |
| Invalid/missing event signature | `401` before parse/storage | Automated and deployed evidence |
| Malformed, non-UTF-8, or oversize body | Bounded `400`/framework rejection, no receipt | Automated local evidence |
| PostgreSQL unavailable or locked beyond budget | `503`; Meta may retry | Automated local/guarded database evidence |
| Exact/logical duplicate | `200`; no duplicate event or policy effect | Automated, guarded database, and deployed synthetic evidence |
| Stale/future customer event | Minimal stale/unsupported record; no policy/model/send | Automated/guarded database evidence |
| Model unavailable or unsafe | Approved FAQ or safe escalation; no unapproved provider | Local client returns closed timeout/abort/network/non-2xx/exhaustion/invalid-output reasons; durable escalation remains planned P4 evidence |
| Provider unavailable or ambiguous send result | Durable outbox retry/terminal state; no blind resend | Planned P5 evidence |
| n8n unavailable | Core state remains in PostgreSQL; notification retries/fails safely | Planned P6 evidence |
| Access subject was deleted after approval | Reject collection; persist no access-run evidence | Guarded cross-feature PostgreSQL evidence |
| Correction handler rejects or fails | Roll back mutation/evidence; return bounded manual/rejected or generic error | Guarded typed-handler PostgreSQL evidence |
| Privacy notification insert times out | Roll back request and notification; exact retry opens one complete workflow | Guarded cross-feature PostgreSQL evidence |
| Backup restore | Isolated restore; tombstones reapplied; promotion blocked on failure | Local reconciliation/promotion primitive passes; actual backup/restore automation remains planned P6 evidence |
| Tunnel/server outage | No unsafe alternative public path; manual staff coverage | Partial operational evidence; P7 outage test pending |

## 4. Severity Calibration

Severity combines customer-data exposure, unauthorized messaging/policy change,
scope, recoverability, and prerequisites.

| Severity | Project-specific meaning | Examples |
|---|---|---|
| Critical | Broad compromise of production communications, secrets, host execution, or authoritative database/backup with difficult recovery | Host remote-code execution; theft of production Meta credentials enabling broad read/send; compromise of live database plus backup/tombstone controls |
| High | Unauthorized durable state or customer-facing action, significant privacy breach, deletion failure, or production-number disruption | Signature bypass; unauthorized marketing; restored deleted data; tool/provider escape; duplicate outbound sends; coexistence-breaking migration |
| Medium | Bounded availability, cost, integrity, or metadata impact without broad secret/customer-content compromise | Rate exhaustion; sanitized operational metadata leak; recoverable test-service outage; bounded takeover race caught before send |
| Low | Self-limited diagnostic or usability issue with no sensitive data, privileged action, or durable customer effect | Sanitized error-count discrepancy; rejected unsigned probe; non-sensitive documentation drift |

### Review record

The model was checked against repository policy, source, migrations, tests,
deployment contracts, lifecycle rules, and sanitized infrastructure inventory.
Because no independent reviewer was available for this pass, the second
architecture pass was sequential rather than independent. P0-GATE records this
as an acceptable documentation limitation; major implementation and production
gates still require their own review and evidence.
