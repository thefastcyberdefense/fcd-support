# Phase 4 FAQ-First Resolution Evidence

Date: 2026-09-11 (Asia/Dhaka)

## Scope

This checkpoint completes approved Phase 4 plan Task 11. It adds a pure FAQ
ranking boundary and a read-only PostgreSQL resolver over effective reviewed
knowledge. It does not call a model or provider, create a reply, send a message,
deploy, or mutate external infrastructure.

## Implemented controls

- The PostgreSQL resolver accepts only process-issued, language-tagged prepared
  text derived from a successful sensitive-data inspection, plus a valid
  evaluation time. Structurally forged or blocked inputs are rejected.
- Exact reviewed questions, aliases, examples, and intents precede trigram
  similarity. One effective version is collapsed to one best alias before
  cross-version ranking.
- Multiple exact matches, equal fuzzy scores, and fuzzy scores inside the
  supplied ambiguity margin return closed ambiguity without answer text or
  candidate references. Below-threshold and empty sets return closed misses.
- Minimum similarity, ambiguity margin, and maximum candidates are validated,
  supplied policy values. The query returns a bounded candidate set and uses no
  `OFFSET`, model score, tool, provider, or external service.
- PostgreSQL reads only the latest publication event and approved review event
  effective at the requested time. Retired items and draft, submitted, rejected,
  future-reviewed, future-published, non-FAQ, or incomplete bilingual versions
  cannot answer.
- Similarity uses the existing `pg_trgm` GIN index and a transaction-local
  threshold. A materialized pre-window bound limits candidate alias rows before
  per-version ranking; the query then yields at most one best alias per effective
  version.
- A match returns the exact stored answer, requested language, opaque controlled
  item/version references, and a closed match kind. The resolver never rewrites
  published business content.

## Test-first and validation evidence

- Initial pure run failed because `src/knowledge/faq-resolver.ts` did not exist.
- Pure ranking suite: 13 tests passed after implementation. A zero-margin equal-
  score ambiguity regression was added failing-first during self-review.
- Initial guarded integration run failed because
  `src/persistence/postgres-faq-resolver.ts` did not exist.
- First implemented PostgreSQL run reached all five tests; index and input
  validation passed, while three resolution tests exposed one schema-qualified
  operator syntax error. The focused suite passed after that correction.
- Independent review found three fail-closed gaps: review decisions could become
  visible before their effective time, structurally forged sanitized text could
  reach the PostgreSQL boundary, and alias ranking was bounded only after its
  window step. Tests now cover review-effective visibility and opaque input
  provenance; the query now materializes a repository-derived pre-window bound.
- Focused PostgreSQL FAQ resolver suite: 6 tests passed. The resolver plus shared
  publication-read suites passed 13 tests across 2 files after review fixes.
- `npm run check`: Phase 0 validator, formatting, lint, strict type checking,
  build, and 368 unit tests across 31 files passed.
- Complete guarded PostgreSQL suite: 302 tests across 22 files passed.

All fixtures are conspicuously synthetic and non-operational. No credential,
token, customer data, raw message, external identity, or secret value is present
in this evidence.

## Deliberate non-claims

- No live browser, Manifest, model, provider, Meta, n8n, tunnel, SSH, deployment,
  or production test was run for Task 11.
- FAQ matches are not yet connected to a reply draft or Phase 3 race rechecks;
  Task 12 owns that transactional decision boundary.
