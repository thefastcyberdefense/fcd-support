# Knowledge And Model Runtime Boundary

## Authority

PostgreSQL is authoritative for source provenance, immutable knowledge
versions, review/publication events, FAQ gaps, active model policy, allowance
leases, reply drafts, and escalations. Manifest, n8n, OpenClaw, Hermes, crawled
pages, customer repetition, and model text cannot publish knowledge or replace
that state.

Only an approved bilingual version selected by the latest effective
publication or rollback event is eligible. A later retirement, replacement,
privacy hold, deletion, retention boundary, or human takeover wins before
draft persistence.

## Reply flow

Applied customer event
→ Phase 3 guard lock
→ sensitive-data inspection
→ effective FAQ resolution
→ exact FAQ draft, or minimized gap
→ reviewed policy plus effective facts
→ one PostgreSQL allowance lease
→ one private Manifest auto request with no tools
→ structured-output and factual validation
→ completion-time guard and publication recheck
→ model draft with exact fact links, deterministic safe draft plus escalation,
or no draft when Phase 3 policy blocks.

Phase 4 creates drafts only. Phase 5 owns an outbox and must independently
recheck eligibility immediately before enqueue and send.

## Privacy and model isolation

- The current request and every supplied fact pass the deterministic sensitive
  gate. Blocked text never reaches request construction.
- Recent conversation history is currently empty at this boundary. No
  unrestricted transcript is sent.
- The request builder accepts only process-issued prepared text, uses model
  auto, is non-streaming, and emits no tools, functions, plugins, provider
  override, routing, or fallback fields.
- OpenClaw/Hermes keys and interfaces are outside the support path.
- Manifest response/error bodies are neither logged nor persisted. Only an
  accepted answer, closed outcomes, internal references, and timestamps enter
  PostgreSQL.

## Limits, concurrency, and replay

All operational values are explicit and customizable. The effective policy is
the stricter intersection of reviewed PostgreSQL policy, protected deployment
ceilings, and verified Manifest limits; cooldown uses the longest value.

One deterministic logical key is derived from the internal event ID. An
advisory-lock transaction enforces rolling contact windows, the global UTC-day
window, cooldown, active/queued capacity, and exact lease replay. A duplicate
active lease does not issue another request. Queued work can be activated only
once capacity is available. Lost work expires and becomes a safe failure
instead of an unbounded retry.

FAQ and sensitive-data decisions create no model lease. Model drafts keep exact
model-fact links. The original gap remains available to the proposal-only
learning loop without storing raw evidence in insight or owner-question rows.

## Failure rule

Database failure before lease acquisition produces no request. A failure after
acquisition remains bounded by the lease. Timeout, transport/non-2xx failure,
provider exhaustion, malformed/invalid output, unsupported claims, wrong
language, limit denial, and stale publication produce a reviewed bilingual
safe response and one content-free escalation when Phase 3 policy still
permits a draft. If takeover, privacy, deletion, or retention blocks at
completion, no automated draft is created.
