# Health command limits

The private health command uses the validated `OPS_MAX_CALL_MS` value for stdin,
database connection acquisition, idle pool lifetime, SQL queries, locks,
statements, transactions, idle transactions and collector calls. Its supported
range remains 100–300,000 milliseconds and the existing operations configuration
relationships with lease and stop grace periods still apply. Configuration is
validated before stdin or a database connection is acquired.

Two optional health-only environment settings refine collection policy:

| Setting                        | Default (milliseconds) | Inclusive range (milliseconds) | Behavior                                                                  |
| ------------------------------ | ---------------------: | -----------------------------: | ------------------------------------------------------------------------- |
| `OPS_HEALTH_BACKUP_STALE_MS`   |            129,600,000 |                  1–604,800,000 | Maximum age for a verified backup to be reported healthy.                 |
| `OPS_HEALTH_MAX_OUTAGE_GAP_MS` |             86,400,000 |                   1–86,400,000 | Maximum historical interval recorded when replaying a bounded outage gap. |

Values must be canonical positive decimal integers. Invalid settings fail before
stdin or database access. Existing defaults preserve the previous 36-hour backup
freshness threshold and 24-hour outage replay bound. These settings change health
reporting only; they do not change retention, backup scheduling or promotion
authority. The stdin JSON protocol remains capped at 16 KiB.

An initial database connection refusal remains a handled availability outcome:
exit zero with a completed, zero-count `dependency_unavailable` acknowledgment.
An error after a client has been acquired, including an ambiguous commit or
physical socket closure, prevents a completed acknowledgment. Connection error
listeners remain installed until the physical connection ends.
