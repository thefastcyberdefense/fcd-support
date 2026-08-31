import type pg from 'pg';

import { parseExecuteCorrectionInput } from '../policy/privacy-rights-command.js';
import type { CorrectionExecutionResult, CorrectionResultCode } from '../policy/policy-types.js';
import { requireSupportReviewer } from '../policy/reviewer-principal.js';
import {
  PolicyIdempotencyConflictError,
  PolicyRecordNotFoundError,
} from './postgres-takeover-policy.js';
import { withBoundedTransaction } from './postgres-transaction.js';

export interface CorrectionContext {
  readonly client: pg.PoolClient;
  readonly contactId: string;
  readonly requestRef: string;
}

export interface CorrectionOutcome {
  readonly resultCode: CorrectionResultCode;
}

export interface CorrectionHandler<TKey extends string, TCommand> {
  readonly fieldKey: TKey;
  parse(input: unknown): TCommand;
  apply(context: CorrectionContext, command: TCommand): Promise<CorrectionOutcome>;
}

interface LockedCorrectionRequestRow {
  readonly contact_id: string;
  readonly id: string;
  readonly request_ref: string;
  readonly state: 'completed' | 'in_progress' | 'partially_completed';
}

interface ExistingCorrectionRunRow {
  readonly material_matches: boolean;
  readonly result_code: CorrectionResultCode;
}

interface IdentifierRow {
  readonly id: string;
}

const correctionResultCodes = new Set<CorrectionResultCode>([
  'applied',
  'manual_required',
  'partially_completed',
  'rejected',
]);

const immutableFields = new Set([
  'created_at',
  'id',
  'open_request_key',
  'request_ref',
  'source_webhook_event_id',
]);

const securitySensitiveSegments = new Set([
  'access',
  'api',
  'credential',
  'key',
  'otp',
  'password',
  'payment',
  'secret',
  'security',
  'token',
]);

const providerOwnedSegments = new Set([
  'channel',
  'external',
  'messenger',
  'meta',
  'provider',
  'whatsapp',
]);

export const PRODUCTION_CORRECTION_HANDLERS = Object.freeze(
  [] as readonly CorrectionHandler<string, unknown>[],
);

export class CorrectionHandlerExecutionError extends Error {
  public override readonly name = 'CorrectionHandlerExecutionError';

  public constructor() {
    super('Correction handler failed');
  }
}

function closedResult(fieldKey: string): CorrectionResultCode {
  if (immutableFields.has(fieldKey)) return 'rejected';

  const segments = fieldKey.split(/[._-]/u);
  if (segments.some((segment) => securitySensitiveSegments.has(segment))) return 'rejected';
  if (segments.some((segment) => providerOwnedSegments.has(segment))) return 'manual_required';
  return 'manual_required';
}

function isCorrectionResultCode(value: unknown): value is CorrectionResultCode {
  return typeof value === 'string' && correctionResultCodes.has(value as CorrectionResultCode);
}

export class PostgresCorrectionPolicy {
  private readonly handlers: ReadonlyMap<string, CorrectionHandler<string, unknown>>;

  public constructor(
    private readonly pool: pg.Pool,
    handlers: readonly CorrectionHandler<string, unknown>[] = PRODUCTION_CORRECTION_HANDLERS,
  ) {
    const registry = new Map<string, CorrectionHandler<string, unknown>>();
    for (const handler of handlers) {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(handler.fieldKey)) {
        throw new TypeError('Invalid correction handler field key');
      }
      if (registry.has(handler.fieldKey)) {
        throw new TypeError('Duplicate correction handler field key');
      }
      registry.set(handler.fieldKey, handler);
    }
    this.handlers = registry;
  }

  public async execute(
    input: unknown,
    handlerInput: unknown,
    principal: unknown,
  ): Promise<CorrectionExecutionResult> {
    const command = parseExecuteCorrectionInput(input);
    requireSupportReviewer(principal);

    return withBoundedTransaction(this.pool, async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        command.requestKey,
      ]);
      const selected = await client.query<LockedCorrectionRequestRow>(
        `select request.id,
                request.request_ref,
                request.contact_id,
                request.state
         from privacy_requests as request
         join contacts as contact on contact.id = request.contact_id
         where request.request_ref = $1
           and request.request_type = 'correction'
           and request.state in ('in_progress', 'partially_completed', 'completed')
           and request.decision_code in ('same_channel_context', 'known_name')
         for update of request, contact`,
        [command.requestRef],
      );
      const request = selected.rows[0];
      if (request === undefined) {
        throw new PolicyIdempotencyConflictError('Approved correction request is not available');
      }

      const existing = await client.query<ExistingCorrectionRunRow>(
        `select result_code,
                request_id = $2::bigint
                  and executed_at = $3::timestamptz
                  and field_key = $4
                  as material_matches
         from privacy_correction_runs
         where request_key = $1`,
        [command.requestKey, request.id, command.executedAt, command.fieldKey],
      );
      const replay = existing.rows[0];
      if (replay !== undefined) {
        if (!replay.material_matches) {
          throw new PolicyIdempotencyConflictError('Correction execution key material conflicts');
        }
        return {
          fieldKey: command.fieldKey,
          requestRef: request.request_ref,
          resultCode: replay.result_code,
          status: 'duplicate',
        };
      }
      if (request.state !== 'in_progress') {
        throw new PolicyIdempotencyConflictError('Correction request is not in progress');
      }

      const handler = this.handlers.get(command.fieldKey);
      let resultCode: CorrectionResultCode;
      if (handler === undefined) {
        resultCode = closedResult(command.fieldKey);
      } else {
        try {
          const parsedCommand = handler.parse(handlerInput);
          const outcome = await handler.apply(
            {
              client,
              contactId: request.contact_id,
              requestRef: request.request_ref,
            },
            parsedCommand,
          );
          if (!isCorrectionResultCode(outcome.resultCode)) {
            throw new TypeError('Invalid correction result');
          }
          resultCode = outcome.resultCode;
        } catch {
          throw new CorrectionHandlerExecutionError();
        }
      }

      if (resultCode === 'applied') {
        const updated = await client.query<IdentifierRow>(
          `update privacy_request_locations
           set state = 'completed',
               outcome_code = 'location_complete',
               reviewer_reference = null,
               checked_at = $2
           where request_id = $1
             and location_code = 'primary_postgres'
           returning request_id as id`,
          [request.id, command.executedAt],
        );
        if (updated.rows[0] === undefined) {
          throw new PolicyRecordNotFoundError('Primary correction location was not found');
        }
      }

      const inserted = await client.query<IdentifierRow>(
        `insert into privacy_correction_runs
           (request_id, request_key, executed_at, field_key, result_code)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [request.id, command.requestKey, command.executedAt, command.fieldKey, resultCode],
      );
      if (inserted.rows[0] === undefined) {
        throw new PolicyRecordNotFoundError('Correction execution evidence was not created');
      }

      return {
        fieldKey: command.fieldKey,
        requestRef: request.request_ref,
        resultCode,
        status: 'applied',
      };
    });
  }
}
