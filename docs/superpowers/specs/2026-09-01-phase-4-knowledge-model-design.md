# Phase 4 Approved Knowledge, Learning, And Model Boundary Design

## Status, Authority, And Scope

This is the P4-001 architecture specification for P4-002 through P4-006. The
project owner approved the major architecture sections in conversation on
2026-09-01 and then delegated the remaining Phase 4 design decisions and local
implementation approvals to Codex. That delegation removes repeated
micro-approval prompts; it does not weaken any external-action, test-asset,
production, privacy, or security boundary.

This design authorizes documentation, local TypeScript implementation,
synthetic fixtures, local HTTP fakes, and guarded synthetic PostgreSQL tests.
It does not authorize:

- Manifest configuration changes or live model/provider requests;
- attaching the application to Manifest's private Docker network;
- disabling or inspecting recording on the live Manifest service;
- n8n, Telegram, Meta Graph, Cloudflare, Ubuntu, or test-asset mutations;
- customer data, live exports, provider deletion, or production actions; or
- changes to the production WhatsApp number or production Facebook Page.

The deployed revision remains the narrow admission-only test service. Phase 4
is implemented and validated locally before any separately approved deployment
or private-service integration.

## Goals

Phase 4 must:

1. make reviewed PostgreSQL knowledge authoritative;
2. answer strong FAQ matches without a model call;
3. prevent unreviewed, fetched, customer-derived, or model-generated content
   from becoming published knowledge automatically;
4. build a controlled learning loop that identifies knowledge gaps, generates
   privacy-safe insights, and asks the owner bounded questions;
5. provide a separate authenticated private dashboard for knowledge review and
   later CRM modules;
6. redact or block sensitive data before inference;
7. call only the dedicated private Manifest harness `fcd-support` with
   `model: "auto"` and no tools;
8. enforce configurable cost, rate, queue, timeout, and output limits;
9. fail safely with durable escalation when inference is unsafe, unavailable,
   invalid, or exhausted; and
10. define and validate a reviewed synthetic English/Bangla evaluation set.

## Non-Goals

Phase 4 does not implement outbound Meta delivery, a complete CRM, public
dashboard access, automated website publication, embeddings, vector search,
model fine-tuning, model memory, live Manifest configuration, n8n delivery, or
production deployment. P5 owns the durable outbound provider path. P6 owns
hardened deployment, private Manifest network attachment, encrypted
backup/restore, and n8n notification delivery. P7 owns approved test-asset and
live private-service validation.

## Approved Architecture Decisions

The following decisions are binding for the initial implementation:

- The continuously running Cloudflare Tunnel and webhook API remain the Meta
  event ingress while the local server is online.
- The existing `fcd_support` PostgreSQL database stores authoritative knowledge,
  review, publication, learning, model-policy, usage, and escalation state.
- A separate continuously running `fcd-support-admin` service provides an
  authenticated private dashboard and never joins the public ingress network.
- The dashboard is the normal knowledge-management surface. A one-shot private
  CLI remains available for bootstrap, maintenance, and break-glass operations.
- Individual PostgreSQL-backed staff accounts use strong password hashing,
  mandatory MFA for privileged roles, revocable sessions, CSRF protection, and
  role-based authorization. The design keeps a future private OIDC adapter open.
- Knowledge improvement is proposal-only. A model, crawl, gap detector, n8n, or
  customer message can never publish or revise an answer automatically.
- FAQ resolution uses reviewed bilingual aliases and bounded PostgreSQL
  similarity. Embeddings are deferred.
- Sensitive content passes through a tiered block/redact gate before FAQ or
  model processing.
- Manifest is the only model gateway. The application makes no direct provider,
  OpenClaw, Hermes, or OmniRoute fallback call.
- Model output is a locally validated structured envelope, not trusted free
  text and not a tool call.
- Operational limits are versioned and customizable. The approved balanced
  values are an initial policy, not source-code constants.
- Provider fallback is allowlisted and Manifest-managed. Application failure is
  a safe response plus PostgreSQL escalation, never an unrelated gateway.

## Considered Approaches

### Knowledge authority

1. **Existing PostgreSQL database plus private dashboard/CLI (selected).** This
   follows the established authority rule, supports transactional publication,
   effective times, audit, and rollback, and reuses the protected data network.
2. **Git-managed Markdown or JSON.** Easy to diff, but publication and rollback
   require application deployment and effective-time behavior is awkward.
3. **Separate knowledge database or external CRM.** Adds credentials, backup,
   reconciliation, and split-authority failure modes without a current need.

### Learning behavior

1. **Human-reviewed proposal loop (selected).** The application records bounded
   gaps, creates insights and owner questions, and requires review before
   publication.
2. **Automatic low-risk publication.** Faster, but permits prompt injection,
   customer error, or poisoned repetition to alter future answers.
3. **Entirely manual discovery.** Safe but fails to surface repeated misses and
   customer needs consistently.

### Administrative surface

1. **Separate private admin service (selected).** Keeps dashboard changes and
   administrative routes out of the public webhook process.
2. **`/admin` routes on the webhook API.** Smaller deployment, but a route or
   tunnel error could expose privileged controls.
3. **n8n or an external CRM as authority.** Conflicts with PostgreSQL authority
   and broadens customer-data disclosure.

## Deployment And Trust Boundaries

The existing public path remains:

```text
Meta
  -> Cloudflare Tunnel
  -> fcd-support-ingress
  -> fcd-support-api:3003
  -> fcd-support-data
  -> PostgreSQL
```

The future private paths are:

```text
Authorized operator
  -> private SSH tunnel or approved LAN-private TLS path
  -> fcd-support-admin
  -> fcd-support-data
  -> PostgreSQL

Reply worker
  -> published FAQ resolver
  -> redaction and policy boundary
  -> private Manifest network
  -> Manifest fcd-support / auto
```

`fcd-support-admin` must not join `fcd-support-ingress`, receive Cloudflare or
Meta credentials, or expose a route through the Meta tunnel. The initial secure
access pattern is loopback-only service exposure reached through an operator SSH
tunnel. A later LAN TLS or private OIDC design may replace that access adapter
without changing dashboard domain services.

The application remains disconnected from Manifest in the currently approved
test deployment. P6/P7 must prove the exact private network attachment and
recording-off state before customer/model traffic.

## Component Boundaries

### Knowledge repository

The knowledge repository creates proposals, records immutable content versions,
resolves review state, publishes effective versions, retires versions, and
resolves the one authoritative version at a supplied UTC time. It depends only
on PostgreSQL and closed domain inputs.

### Knowledge reviewer service

The reviewer service accepts authenticated reviewer commands from the dashboard
or break-glass CLI. It validates role, exact version, source provenance,
bilingual completeness, idempotency key, and bounded reason code. It never
accepts a generic JSON patch or arbitrary SQL field path.

### FAQ resolver

The resolver accepts only sanitized text and a UTC evaluation time. It performs
normalization, exact alias matching, reviewer-authored example matching, and
bounded similarity. It returns either one published answer and version
reference, an ambiguous result, or a miss. It never calls a model.

### Sensitive-data gate

The gate classifies prohibited patterns, produces typed redaction markers,
returns a bounded safety decision, and never exposes matched values. Hard-block
categories bypass the model and create escalation. Safely redacted ordinary
questions may continue.

### Manifest client

The client implements one non-streaming OpenAI-compatible chat-completions
request through the configured private `MANIFEST_BASE_URL`. It sends
`model: "auto"`, a bounded message array, an output-token limit, and no tool,
function, plugin, or provider override field. It validates a structured answer
envelope and maps all external errors to closed local outcomes.

### Model-policy service

The policy service resolves the active PostgreSQL model-policy version,
intersects it with protected deployment ceilings, applies per-contact and global
counters, leases bounded queue capacity, and records content-free outcomes. It
never stores prompts, responses, sensitive matches, credentials, or raw
external identities as policy evidence.

### Learning and insight service

The learning service records bounded observations linked to authoritative local
events, aggregates repeated gaps, prepares privacy-safe dashboard summaries, and
opens owner questions. It cannot publish knowledge. Customer-derived artifacts
remain linked to retention/deletion enforcement until converted into an
independently reviewed business fact.

### Private admin service

The admin service owns login, MFA, sessions, CSRF, authorization, and HTML/JSON
presentation. Domain mutations go through typed services. The initial dashboard
contains knowledge, owner-question, insight, policy, and audit modules only. CRM
conversation, lifecycle, consent, deletion, takeover, and outbound modules are
later independently reviewed extensions.

## Authoritative PostgreSQL Model

The implementation uses closed columns and relational tables rather than
unrestricted JSON workflow payloads. Exact names may be adjusted in the
implementation plan, but the following authorities and invariants are required.

### Knowledge sources and snapshots

`knowledge_sources` identifies an approved source type: `manual_business`,
`website`, `policy`, or `support_gap`. Website sources store the approved URL but
no credentials. `knowledge_source_snapshots` stores fetch time, source/content
hashes, bounded fetch outcome, and proposed public website content. Crawling is
manual and disabled by default. A snapshot can create a proposal but never a
publication.

### Knowledge items and versions

`knowledge_items` provides a stable opaque key and closed kind such as `faq`,
`business_fact`, `safety_response`, or `escalation_response`.

`knowledge_versions` stores immutable reviewed content and includes:

- item and monotonically increasing version number;
- English and Bangla question/answer content where the kind is customer-facing;
- reviewed English/Bangla aliases and intent phrases;
- bounded tags and applicability metadata;
- source and snapshot references;
- source/content hashes;
- author reference and creation time; and
- replacement/rollback lineage.

Content becomes immutable when submitted for review. A correction creates a new
version.

`knowledge_review_events` is append-only and records submission, approval,
rejection, and bounded reason codes with authenticated reviewer references.
Author and approving reviewer must be independently identifiable; production
policy may require them to be different accounts without changing the schema.

`knowledge_publication_events` is append-only and records `publish`, `retire`,
and `rollback` actions with effective UTC time, reviewer, request key, and prior
version relationship. The effective event history is authoritative. A
materialized current pointer may accelerate reads but cannot replace history.
One item has at most one effective published version at a time.

Rollback publishes a previously approved version through a new event. It never
deletes or rewrites history.

### Learning observations, insights, and questions

`knowledge_gap_observations` records the internal applied-event reference,
language, bounded gap kind, candidate knowledge references, sanitized derived
summary when allowed, and retention deadline. It contains no credential,
sensitive match, raw external identity, or unrestricted provider response.

`customer_insight_runs` and `customer_insight_entries` record aggregate counts,
closed topic/category codes, reporting window, and sanitized summaries. Default
dashboard views are aggregate-only. Any customer-derived summary inherits the
strictest contributing retention deadline and is erased or recomputed after
verified deletion.

`owner_questions` records a bounded question, source insight references,
priority, state, next eligible digest time, and idempotency key. A scheduled job
opens a digest every three days only when unresolved useful questions exist and
selects at most five. The dashboard is the authoritative answer surface.

`owner_question_answers` records the authenticated answer, reviewer, time, and
proposal reference. An answer creates or updates a proposal; it is not a
publication. A later private n8n adapter may deliver a content-minimized
`digest_ready` notification, but PostgreSQL owns every state.

### Admin identity and audit

Admin tables store individual opaque account references, normalized login name,
strong salted password hash, role assignments, encrypted-at-rest MFA seed
material or an approved secret-store reference, revocation state, and timestamps.
No password, recovery code, session token, or MFA seed is logged or committed.

Session tokens are high-entropy random values; only a keyed or cryptographic hash
is stored. Sessions expire, rotate after authentication, and are revocable.
Privileged roles require MFA. State-changing browser requests require SameSite
cookies, origin checking, and CSRF tokens.

Initial roles are `knowledge_editor`, `knowledge_reviewer`, `support_reviewer`,
and `administrator`. Authorization is rechecked in the domain service, not only
hidden in the UI. Append-only admin audit stores bounded action and result codes,
internal object references, timestamps, and actor references without secrets or
customer content.

### Model policies, counters, and escalation

`model_policy_versions` stores the customizable operational values and approval
history. It includes per-contact rolling limits, global daily limit, concurrency,
queue capacity, total timeout, output-token limit, cooldown, provider-attempt
attestation, activation time, reviewer, and version.

The initial balanced recommendation is:

- 3 logical model calls per contact per 15 minutes;
- 20 per contact per rolling 24 hours;
- 300 logical calls globally per UTC day;
- 4 concurrent calls;
- 25 queued jobs;
- 20-second total timeout;
- 600 maximum output tokens;
- 3 approved provider attempts initially; and
- an architectural ceiling of 5 approved provider connections.

These values are policy data, not source-code constants. The model path remains
disabled when no valid active policy exists.

Protected runtime configuration supplies independent safety ceilings. The
effective value is always the stricter of the active policy, deployment ceiling,
and verified Manifest limit. Ordinary policy changes use the dashboard and do
not require deployment. Raising a deployment ceiling is an explicit operator
configuration action. The AI, Manifest, and n8n cannot change policy.

Usage tables use internal/contact references or approved pseudonymous scoped
keys, fixed windows, counts, bounded status, and expiry. They do not store
prompts or responses. Exact event replay and FAQ-only answers consume no model
allowance.

`support_escalation_outcomes` records content-free failure reason, conversation
reference, state, timestamps, and idempotency key. PostgreSQL remains authority;
n8n or another notifier may later deliver the outcome but cannot create or close
it independently.

## Knowledge State And Publication Workflow

The required state flow is:

```text
draft proposal
  -> submitted for review
  -> approved or rejected
  -> scheduled/published
  -> retired or superseded
  -> optional audited rollback to a previously approved version
```

Only an approved version with an effective publication event and no effective
retirement/supersession is customer-visible. Missing, rejected, proposed,
future-effective, retired, or conflicting knowledge is ineligible.

Website fetches, model drafts, owner answers, customer insight, and staff
corrections all enter the same proposal boundary. None receives a privileged
short path. Publication is transactional and serialized per item. Reusing a
request key with different material is an idempotency conflict.

## Customer Reply Data Flow

After durable webhook admission and Phase 3 policy application, the future reply
worker follows this order:

1. Lock/claim the authoritative event once.
2. Recheck deletion, suppression, privacy holds, and human takeover.
3. Pass customer content through the sensitive-data gate.
4. On a hard block, return the approved deterministic safety response and create
   escalation without a model request.
5. Run FAQ resolution on sanitized text.
6. On one strong match, return the exact published answer and version reference
   without consuming model allowance.
7. On ambiguity, record a gap and either use the safe model path with bounded
   published facts or escalate according to policy.
8. On a miss, acquire model-policy allowance and build a bounded prompt.
9. Call only Manifest `fcd-support`/`auto`, validate the structured envelope, and
   create a reply draft or escalation outcome.
10. P5 later rechecks all send-time policy and delivers through a PostgreSQL
    outbox. Phase 4 does not send to Meta.

The sequence is intentionally numbered once from 1 through 10; this editorial
correction does not change the approved control order.

## Sensitive-Data Gate

The hard-block classes are passwords, authentication secrets, OTP/recovery
codes, API keys/tokens/cookies/session material, payment-card/bank data, private
keys/credential files, sensitive incident evidence, and content whose safe
redaction is uncertain. They bypass Manifest and create a deterministic safety
reply plus human escalation.

When removing a matched value leaves an unambiguous ordinary support question,
the gate may replace it with a typed marker such as `[REDACTED_OTP]` and continue.
Matched values never appear in a result, log, evidence row, model prompt,
knowledge proposal, learning observation, insight, or notification.

Redaction runs before FAQ matching so secret-bearing aliases cannot become
knowledge signals. The gate uses bounded deterministic recognizers and fails
closed on malformed or excessive input. A model is never used to decide whether
it is safe to send a secret to that same model.

## FAQ-First Resolution

The resolver performs:

1. Unicode NFKC normalization;
2. trimming and bounded whitespace/punctuation normalization;
3. language-aware case handling;
4. exact reviewed question and alias matching;
5. reviewer-authored English/Bangla example and intent matching; and
6. bounded PostgreSQL trigram similarity above an approved policy threshold.

One strong effective match returns the stored answer verbatim or through an
approved deterministic channel-format wrapper. Multiple close matches,
conflicting versions, missing bilingual content, or a score below threshold
cannot produce an FAQ answer. Similarity thresholds are versioned policy, not
silently changed by the model.

Embeddings are deferred until measured miss evidence demonstrates a need and a
separate design addresses embedding provider disclosure, derived-data deletion,
cost, poisoning, and restore behavior.

## Manifest Request And Output Contract

The request contains only:

- a fixed application-owned system policy;
- the redacted current customer request;
- bounded recent conversation context after the same redaction rules;
- bounded effective published knowledge records with opaque references;
- required response language;
- `model: "auto"`; and
- the active output-token limit.

It contains no tools, tool choice, functions, plugins, provider override,
OpenClaw/Hermes material, customer credential, or unrestricted historical
transcript. Non-streaming output simplifies timeout and validation behavior.

The model returns JSON text validated into:

- `decision`: `answer` or `escalate`;
- `language`: `en` or `bn`;
- bounded `answer`;
- `knowledgeReferences` drawn only from supplied records;
- closed `reasonCode`; and
- `needsHumanReview`.

The application rejects invalid JSON/schema, unsupported knowledge references,
business claims without published support, contradiction of supplied facts,
wrong language, empty/oversized content, secret-shaped output, URLs not present
in approved knowledge, tool/action claims, or claims that an external action was
performed. Confidence text from a model is never authority.

## Recording, Provider, And Network Gates

Manifest advertises body logging, fallback, cost tracking, and limits. The
inventory confirms message-body recording is currently enabled and no explicit
fallback/limit policy exists. Therefore the model path defaults closed.

Local runtime configuration requires explicit non-secret attestations that:

- message-body recording is disabled;
- deletion/retention behavior is approved;
- the provider/fallback allowlist is approved;
- Manifest limits do not exceed deployment ceilings; and
- private-network routing has been verified.

Attestations cannot replace the later private integration test. P6/P7 verify the
actual service state without retaining request bodies, provider identifiers,
keys, or raw diagnostic output.

Manifest may attempt only the approved fallback connections. The application
does not retry a failed logical model request through another gateway. Provider
names/order remain protected operational configuration; repository evidence
records only bounded policy outcomes and counts.

## Failure And Concurrency Rules

- PostgreSQL transaction/advisory locks serialize publication keys, question
  answers, model-policy updates, usage windows, and escalation idempotency.
- A database failure fails closed; it cannot produce an untracked model request.
- Queue full, rate exhausted, global budget exhausted, timeout, network failure,
  non-2xx response, invalid body, invalid envelope, unsupported claim, or
  provider exhaustion maps to a closed reason code.
- Safe failure returns an approved bilingual response where possible, creates
  one escalation, applies the configured cooldown, and never fabricates an
  answer.
- Manifest error bodies and provider responses are not logged or persisted.
- A crash after allowance acquisition must not create unbounded retries; leases
  expire and exact event idempotency prevents duplicate logical calls.
- Human takeover, privacy hold, verified deletion, or suppression that becomes
  effective before draft creation wins and prevents automated output.
- P5 repeats the policy check before enqueue and send.

## Controlled Learning And Customer Insights

The learning loop improves published knowledge, not model weights or hidden
memory. It records reasons such as FAQ miss, ambiguous match, unsupported model
claim, human correction, escalation, repeated topic, or bilingual coverage gap.

Customer insight outputs are operational summaries such as recurring support
topics, frequently missed FAQs, requested services, language distribution, and
common escalation categories. Default views use aggregates and suppress
low-count sensitive groupings. The dashboard does not expose raw customer
messages as insight evidence in Phase 4.

Every three days, the scheduler may create one digest containing at most five
unresolved high-value questions. It creates nothing when there is no useful gap.
Questions have cooldowns and cannot repeat unchanged indefinitely. The owner
answers in the dashboard. Answers create proposals, after which the normal
review/publication workflow applies.

A future P6 n8n adapter may notify the owner that a digest is ready using only a
digest reference, count, and bounded priority. It must not transmit customer
content or become the question/answer authority.

## Private Dashboard Scope

The Phase 4 dashboard provides:

- sign-in, MFA, session management, and logout;
- proposal and review queues;
- version comparison and provenance;
- publish, schedule, retire, and rollback commands;
- unresolved owner questions and answer entry;
- privacy-safe insight summaries and FAQ-miss trends;
- English/Bangla completeness and evaluation status;
- active model-policy display and reviewed changes;
- escalation and safe-failure counts; and
- content-free audit history.

The interface must clearly distinguish proposal, approved, published,
future-effective, retired, and rejected states. Destructive or publication
actions require an explicit confirmation page bound to the exact version and
idempotency key.

The break-glass CLI uses the same domain services and authorization semantics
where applicable. It does not bypass review or publication invariants.

## English/Bangla Evaluation

P4-006 creates only newly authored synthetic prompts and expected behavior under
`docs/SYNTHETIC_FIXTURE_POLICY.md`. The set covers:

- exact and paraphrased FAQ hits in English and Bangla;
- FAQ precedence over conflicting model output;
- language matching and explicit language-switch requests;
- unknown business facts and unsupported claims;
- credentials, OTPs, payment data, private keys, and incident evidence;
- prompt injection and requests for tools/actions;
- ambiguous FAQ matches;
- model timeout, invalid JSON, provider exhaustion, and limit exhaustion;
- safe escalation wording; and
- learning-gap/owner-question creation without raw customer evidence.

Required local invariant thresholds are 100% for FAQ precedence, sensitive-data
non-disclosure, no-tools requests, safe failure, unsupported-claim rejection,
language selection, and deterministic escalation. Human-scored generative
quality requires at least 90% acceptable answers with zero critical safety or
factual failures before test-asset promotion.

Because live model/provider calls are not authorized in Phase 4 local work, the
repository implements the evaluation cases, scorer, fixture review, and local
fake/recorded synthetic contract outcomes. It does not claim real-provider
quality. Approved private Manifest and test-asset execution remains P7-005 and
must record sanitized aggregate results only.

## Test Strategy

### Pure/local tests

Unit tests cover knowledge state parsing, Unicode normalization, alias and
similarity boundaries, sensitive recognizers/redaction, prompt construction,
output-envelope validation, configuration ceilings, bilingual safe responses,
and synthetic evaluation scoring.

Fastify injection tests cover admin authentication, MFA, sessions, CSRF, role
authorization, exact private route behavior, safe error presentation, and the
absence of admin routes from the webhook application.

Local HTTP fake contract tests cover exact Manifest path/auth shape without
printing credentials, `model: "auto"`, no tool/provider fields, redacted input,
bounded history/tokens, timeout/abort, malformed/oversized/error responses,
invalid structured output, and no direct fallback.

### Guarded PostgreSQL tests

Randomized-schema integration tests cover:

- migration apply, rollback/refusal as appropriate, and reapply;
- immutable versions and append-only review/publication/audit events;
- one effective publication, future activation, retirement, and rollback;
- concurrent review/publication and idempotency conflicts;
- proposal-only website, model, insight, and owner-answer paths;
- FAQ exact/alias/similarity boundaries and ambiguous matches;
- gap observation retention/deletion interaction and aggregate insights;
- three-day/max-five question digests, cooldown, replay, and answers;
- individual accounts, role changes, session revocation, and audit;
- active policy versioning, deployment-ceiling intersection, rolling counters,
  concurrency, queue leases, cooldown, expiry, and rollback;
- duplicate event/model-call prevention across crash/retry;
- safe escalation idempotency; and
- Phase 3 takeover, privacy hold, deletion, suppression, and retention
  interactions.

Fixtures and evidence remain synthetic and content-minimized. Tests make no
Meta, Manifest, n8n, Cloudflare, public Internet, live provider, or production
call.

## Implementation Sequence

1. **P4-002:** migrations and services for knowledge sources, immutable versions,
   review/publication, admin identity, private dashboard foundation, learning
   observations, owner questions, and manual publication.
2. **P4-003:** sensitive-data gate, bilingual FAQ resolver, gap/insight creation,
   and Phase 3 policy interaction.
3. **P4-004:** fail-closed configuration, prompt builder, tool-free Manifest
   client, structured output validator, and local HTTP fake contract.
4. **P4-005:** versioned customizable model policy, deployment ceilings, usage
   leases/counters, timeout, safe response, escalation, and failure dashboard.
5. **P4-006:** synthetic bilingual evaluation corpus, scorer, reviewer evidence,
   and Phase 4 gate validation.

Every behavioral slice follows test-first development and is committed only
after focused tests, `npm run check`, guarded PostgreSQL tests, formatting,
privacy/secret scans, `git diff --check`, and staged-file review pass.

## Documentation And Evidence Updates

Implementation updates the live tracker and context plus:

- `docs/testing/acceptance-matrix.md` for AC-05, AC-10, AC-21, AC-22, and AC-25;
- `docs/security/threat-model.md` for knowledge poisoning, admin compromise,
  prompt injection, recording, provider, insight privacy, and cost attacks;
- an approved knowledge/model architecture contract under `docs/architecture/`;
- private dashboard and model operations guidance; and
- a Phase 4 gate review that distinguishes local contract evidence from later
  live private-service and test-asset evidence.

No tracker row claims external recording, provider, network, deployment, or
real-model success unless that action actually occurs under its later approval.

## Approval Boundaries Preserved

Local completion of P4-002 through P4-006 does not authorize server deployment,
Manifest recording/routing/limit mutation, private-network attachment, n8n or
Telegram delivery, Meta outbound messaging, test-asset execution, live customer
data, or production action. Those remain governed by P5 through P8 and the
separate production plan.

If Manifest recording cannot be disabled, bounded, and erased for verified
deletion, the model path remains a production no-go. If a provider/fallback
allowlist or deployment ceiling is absent, the model path remains disabled. If
customer-data or production scope is uncertain, implementation stops and the
existing restrictive boundary wins.
