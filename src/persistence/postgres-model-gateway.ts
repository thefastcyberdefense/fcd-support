import { Buffer } from 'node:buffer';
import { z } from 'zod';

import type pg from 'pg';

import {
  MAX_BUDGET_MICRO_USD,
  MAX_RATE_MICRO_USD,
  budgetWindowBounds,
} from '../model/gateway-budget.js';
import type { AesGcmGatewaySecretProtector } from '../model/gateway-secret.js';
import type {
  ModelBudgetWindowKind,
  ModelGatewayBudgetSummary,
  ModelGatewayKind,
  ModelGatewayProfileCreateInput,
  ModelGatewayProfileState,
  ModelGatewayProfileView,
  ModelGatewayTestOutcome,
  ModelGatewayTestStatus,
  ResolvedRuntimeGateway,
} from '../model/gateway-types.js';
import { probeGatewayConnection, type ManifestFetch } from '../model/manifest-client.js';
import {
  isAllowedOpenAiCompatibleBaseUrl,
  isPrivateManifestBaseUrl,
  normalizeGatewayBaseUrl,
} from '../model/model-config.js';
import { PolicyAuthorizationError, requireAdministrator } from '../policy/reviewer-principal.js';
import type { ReviewerPrincipal } from '../policy/policy-types.js';
import { SecretBytes, SecretText } from '../safety/secret-bytes.js';
import {
  PolicyIdempotencyConflictError,
  PolicyRecordNotFoundError,
} from './postgres-takeover-policy.js';
import { withBoundedTransaction, type TransactionSource } from './postgres-transaction.js';

export class GatewayConfigurationError extends Error {
  public override readonly name = 'GatewayConfigurationError';
}

export class GatewayEncryptionKeyMissingError extends Error {
  public override readonly name = 'GatewayEncryptionKeyMissingError';
}

export class GatewayStateTransitionError extends Error {
  public override readonly name = 'GatewayStateTransitionError';
}

const referenceSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const reasonCodeSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u);
const modelNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u);
function hasNoControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code === undefined || code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

const displayLabelSchema = z.string().trim().min(1).max(80).refine(hasNoControlChars);
const validDate = z.date().refine((value) => Number.isFinite(value.getTime()));
const nonNegativeInt = (max: number) => z.number().int().min(0).max(max);

const createSchema = z.strictObject({
  apiKey: z.instanceof(SecretText).optional(),
  budgetMicroUsd: nonNegativeInt(MAX_BUDGET_MICRO_USD),
  budgetWindowKind: z.enum(['utc_day', 'utc_month']),
  createdAt: validDate,
  createdByAccountRef: referenceSchema,
  displayLabel: displayLabelSchema,
  endpointBaseUrl: z.string().trim().min(1).max(512).optional(),
  gatewayKind: z.enum(['manifest_default', 'openai_compatible']),
  gatewayRef: referenceSchema,
  inputCostPerMillionMicroUsd: nonNegativeInt(MAX_RATE_MICRO_USD),
  modelName: modelNameSchema,
  outputCostPerMillionMicroUsd: nonNegativeInt(MAX_RATE_MICRO_USD),
  requestKey: z.string().trim().min(1).max(128),
});

const transitionSchema = z.strictObject({
  action: z.enum(['activate', 'retire']),
  effectiveAt: validDate,
  gatewayRef: referenceSchema,
  reasonCode: reasonCodeSchema,
  requestKey: z.string().trim().min(1).max(128),
  reviewerAccountRef: referenceSchema,
});

interface GatewayProfileRow {
  readonly activated_at: Date | null;
  readonly activated_by_account_ref: string | null;
  readonly api_key_sha256: string | null;
  readonly authentication_tag: Buffer | null;
  readonly budget_micro_usd: string;
  readonly budget_window_kind: ModelBudgetWindowKind;
  readonly created_at: Date;
  readonly created_by_account_ref: string;
  readonly display_label: string;
  readonly encrypted_api_key: Buffer | null;
  readonly encryption_nonce: Buffer | null;
  readonly endpoint_base_url: string | null;
  readonly gateway_kind: ModelGatewayKind;
  readonly gateway_ref: string;
  readonly id: string;
  readonly input_cost_per_million_micro_usd: string;
  readonly key_version: string | null;
  readonly last_test_http_status: number | null;
  readonly last_test_reason_code: string | null;
  readonly last_test_status: ModelGatewayTestStatus;
  readonly last_tested_at: Date | null;
  readonly model_name: string;
  readonly output_cost_per_million_micro_usd: string;
  readonly request_key: string;
  readonly retired_at: Date | null;
  readonly state: ModelGatewayProfileState;
  readonly version_number: number;
}

const profileSelect = `
  select profile.id::text as id,
         profile.gateway_ref,
         profile.version_number,
         profile.request_key,
         profile.gateway_kind,
         profile.display_label,
         profile.endpoint_base_url,
         profile.model_name,
         profile.key_version,
         profile.api_key_sha256,
         profile.encrypted_api_key,
         profile.encryption_nonce,
         profile.authentication_tag,
         profile.budget_micro_usd::text as budget_micro_usd,
         profile.budget_window_kind,
         profile.input_cost_per_million_micro_usd::text as input_cost_per_million_micro_usd,
         profile.output_cost_per_million_micro_usd::text as output_cost_per_million_micro_usd,
         profile.state,
         profile.last_test_status,
         profile.last_tested_at,
         profile.last_test_reason_code,
         profile.last_test_http_status,
         creator.account_ref as created_by_account_ref,
         activator.account_ref as activated_by_account_ref,
         profile.created_at,
         profile.activated_at,
         profile.retired_at
  from model_gateway_profiles as profile
  join admin_accounts as creator on creator.id = profile.created_by_account_id
  left join admin_accounts as activator on activator.id = profile.activated_by_account_id
`;

function viewFromRow(row: GatewayProfileRow): ModelGatewayProfileView {
  return Object.freeze({
    ...(row.activated_at === null ? {} : { activatedAt: row.activated_at }),
    ...(row.activated_by_account_ref === null
      ? {}
      : { activatedByAccountRef: row.activated_by_account_ref }),
    ...(row.api_key_sha256 === null ? {} : { apiKeySha256: row.api_key_sha256 }),
    budgetMicroUsd: Number(row.budget_micro_usd),
    budgetWindowKind: row.budget_window_kind,
    createdAt: row.created_at,
    createdByAccountRef: row.created_by_account_ref,
    displayLabel: row.display_label,
    ...(row.endpoint_base_url === null ? {} : { endpointBaseUrl: row.endpoint_base_url }),
    gatewayKind: row.gateway_kind,
    gatewayRef: row.gateway_ref,
    inputCostPerMillionMicroUsd: Number(row.input_cost_per_million_micro_usd),
    ...(row.key_version === null ? {} : { keyVersion: row.key_version }),
    ...(row.last_test_http_status === null
      ? {}
      : { lastTestHttpStatus: row.last_test_http_status }),
    ...(row.last_test_reason_code === null
      ? {}
      : { lastTestReasonCode: row.last_test_reason_code }),
    lastTestStatus: row.last_test_status,
    ...(row.last_tested_at === null ? {} : { lastTestedAt: row.last_tested_at }),
    modelName: row.model_name,
    outputCostPerMillionMicroUsd: Number(row.output_cost_per_million_micro_usd),
    requestKey: row.request_key,
    ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }),
    state: row.state,
    versionNumber: row.version_number,
  });
}

function sameDate(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function validateCreateConfiguration(input: ModelGatewayProfileCreateInput): {
  readonly normalizedEndpoint: string | undefined;
} {
  if (
    input.budgetMicroUsd > 0 &&
    input.inputCostPerMillionMicroUsd === 0 &&
    input.outputCostPerMillionMicroUsd === 0
  ) {
    throw new GatewayConfigurationError(
      'Positive budgets require non-zero input or output token pricing',
    );
  }
  if (input.gatewayKind === 'manifest_default') {
    if (
      input.endpointBaseUrl !== undefined ||
      input.modelName !== 'auto' ||
      input.apiKey !== undefined
    ) {
      throw new GatewayConfigurationError(
        'Manifest default profiles must use model auto with no custom URL or API key',
      );
    }
    return { normalizedEndpoint: undefined };
  }
  if (
    input.endpointBaseUrl === undefined ||
    !isAllowedOpenAiCompatibleBaseUrl(input.endpointBaseUrl)
  ) {
    throw new GatewayConfigurationError('Gateway endpoint URL is invalid');
  }
  if (input.apiKey === undefined || !/^\S{8,4096}$/u.test(input.apiKey.reveal().trim())) {
    throw new GatewayConfigurationError('Gateway API key is invalid');
  }
  return { normalizedEndpoint: normalizeGatewayBaseUrl(input.endpointBaseUrl) };
}

export class PostgresModelGateway {
  public constructor(
    private readonly pool: TransactionSource,
    private readonly protector?: AesGcmGatewaySecretProtector,
  ) {}

  public async createProfile(
    inputValue: unknown,
    principal: ReviewerPrincipal,
  ): Promise<{ readonly gatewayRef: string; readonly status: 'applied' | 'duplicate' }> {
    const parsed = createSchema.safeParse(inputValue);
    if (!parsed.success) throw new GatewayConfigurationError('Gateway profile input is invalid');
    const input: ModelGatewayProfileCreateInput = parsed.data;
    requireAdministrator(principal, input.createdByAccountRef, 'Gateway policy');
    const { normalizedEndpoint } = validateCreateConfiguration(input);

    return withBoundedTransaction(this.pool, async (client) => {
      const accountId = await this.requireDatabaseAdministrator(
        client,
        input.createdByAccountRef,
        input.createdAt,
      );
      await client.query(`select pg_advisory_xact_lock(7100417)`);
      const existing = await client.query<GatewayProfileRow>(
        `${profileSelect} where profile.request_key = $1`,
        [input.requestKey],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        const expectedSha =
          input.apiKey === undefined
            ? null
            : this.requireProtector().encrypt(input.apiKey, input.gatewayRef).apiKeySha256;
        if (
          prior.gateway_ref !== input.gatewayRef ||
          prior.gateway_kind !== input.gatewayKind ||
          prior.display_label !== input.displayLabel ||
          prior.endpoint_base_url !== (normalizedEndpoint ?? null) ||
          prior.model_name !== input.modelName ||
          prior.api_key_sha256 !== expectedSha ||
          Number(prior.budget_micro_usd) !== input.budgetMicroUsd ||
          prior.budget_window_kind !== input.budgetWindowKind ||
          Number(prior.input_cost_per_million_micro_usd) !== input.inputCostPerMillionMicroUsd ||
          Number(prior.output_cost_per_million_micro_usd) !== input.outputCostPerMillionMicroUsd ||
          prior.created_by_account_ref !== input.createdByAccountRef ||
          !sameDate(prior.created_at, input.createdAt)
        ) {
          throw new PolicyIdempotencyConflictError();
        }
        return { gatewayRef: prior.gateway_ref, status: 'duplicate' };
      }

      const sealed =
        input.gatewayKind === 'openai_compatible' && input.apiKey !== undefined
          ? this.requireProtector().encrypt(input.apiKey, input.gatewayRef)
          : undefined;
      const version = await client.query<{ readonly value: number }>(
        `select coalesce(max(version_number), 0)::int + 1 as value from model_gateway_profiles`,
      );
      const versionNumber = version.rows[0]?.value;
      if (versionNumber === undefined) throw new Error('Gateway profile version was not resolved');

      const encrypted = sealed?.encryptedMaterial.copy();
      const nonce = sealed?.encryptionNonce.copy();
      const tag = sealed?.authenticationTag.copy();
      try {
        await client.query(
          `insert into model_gateway_profiles
             (gateway_ref, version_number, request_key, gateway_kind, display_label,
              endpoint_base_url, model_name, key_version, encrypted_api_key,
              encryption_nonce, authentication_tag, api_key_sha256,
              budget_micro_usd, budget_window_kind,
              input_cost_per_million_micro_usd, output_cost_per_million_micro_usd,
              state, created_by_account_id, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'draft',$17,$18)`,
          [
            input.gatewayRef,
            versionNumber,
            input.requestKey,
            input.gatewayKind,
            input.displayLabel,
            normalizedEndpoint ?? null,
            input.modelName,
            sealed?.keyVersion ?? null,
            encrypted ?? null,
            nonce ?? null,
            tag ?? null,
            sealed?.apiKeySha256 ?? null,
            input.budgetMicroUsd,
            input.budgetWindowKind,
            input.inputCostPerMillionMicroUsd,
            input.outputCostPerMillionMicroUsd,
            accountId,
            input.createdAt,
          ],
        );
      } finally {
        encrypted?.fill(0);
        nonce?.fill(0);
        tag?.fill(0);
      }
      return { gatewayRef: input.gatewayRef, status: 'applied' };
    });
  }

  public async recordTestOutcome(
    inputValue: {
      readonly gatewayRef: string;
      readonly outcome: ModelGatewayTestOutcome;
      readonly requestKey: string;
      readonly testerAccountRef: string;
    },
    principal: ReviewerPrincipal,
  ): Promise<{
    readonly gatewayRef: string;
    readonly result: 'failed' | 'passed';
    readonly status: 'applied' | 'duplicate';
  }> {
    const gatewayRef = referenceSchema.parse(inputValue.gatewayRef);
    const requestKey = z.string().trim().min(1).max(128).parse(inputValue.requestKey);
    const testerAccountRef = referenceSchema.parse(inputValue.testerAccountRef);
    const reasonCode = reasonCodeSchema.parse(inputValue.outcome.reasonCode);
    const result = z.enum(['passed', 'failed']).parse(inputValue.outcome.result);
    const testedAt = validDate.parse(inputValue.outcome.testedAt);
    const latencyMs = nonNegativeInt(120_000).parse(inputValue.outcome.latencyMs);
    const httpStatus =
      inputValue.outcome.httpStatus === undefined
        ? null
        : z.number().int().min(100).max(599).parse(inputValue.outcome.httpStatus);
    requireAdministrator(principal, testerAccountRef, 'Gateway policy');

    return withBoundedTransaction(this.pool, async (client) => {
      const accountId = await this.requireDatabaseAdministrator(client, testerAccountRef, testedAt);
      await client.query(`select pg_advisory_xact_lock(7100417)`);
      const existing = await client.query<{
        readonly gateway_ref: string;
        readonly http_status: number | null;
        readonly reason_code: string;
        readonly result: 'failed' | 'passed';
        readonly tested_at: Date;
        readonly tester_account_ref: string;
      }>(
        `select profile.gateway_ref, event.http_status, event.reason_code,
                event.result, event.tested_at, tester.account_ref as tester_account_ref
         from model_gateway_test_events as event
         join model_gateway_profiles as profile on profile.id = event.gateway_profile_id
         join admin_accounts as tester on tester.id = event.tester_account_id
         where event.request_key = $1`,
        [requestKey],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        if (
          prior.gateway_ref !== gatewayRef ||
          prior.result !== result ||
          prior.reason_code !== reasonCode ||
          prior.http_status !== httpStatus ||
          prior.tester_account_ref !== testerAccountRef ||
          !sameDate(prior.tested_at, testedAt)
        ) {
          throw new PolicyIdempotencyConflictError();
        }
        return { gatewayRef: prior.gateway_ref, result: prior.result, status: 'duplicate' };
      }

      const profile = await client.query<{ readonly id: string }>(
        `select id::text as id from model_gateway_profiles where gateway_ref = $1`,
        [gatewayRef],
      );
      const profileId = profile.rows[0]?.id;
      if (profileId === undefined) throw new PolicyRecordNotFoundError();

      await client.query(
        `insert into model_gateway_test_events
           (gateway_profile_id, tester_account_id, request_key, result,
            reason_code, http_status, latency_ms, tested_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [profileId, accountId, requestKey, result, reasonCode, httpStatus, latencyMs, testedAt],
      );
      return { gatewayRef, result, status: 'applied' };
    });
  }

  public async testProfileConnection(
    input: {
      readonly fetch?: ManifestFetch;
      readonly gatewayRef: string;
      readonly manifestRuntime?: { readonly apiKey?: string; readonly baseUrl: string };
      readonly now?: () => Date;
      readonly requestKey: string;
      readonly testerAccountRef: string;
    },
    principal: ReviewerPrincipal,
  ): Promise<{
    readonly gatewayRef: string;
    readonly outcome: ModelGatewayTestOutcome;
    readonly status: 'applied' | 'duplicate';
  }> {
    const gatewayRef = referenceSchema.parse(input.gatewayRef);
    const testerAccountRef = referenceSchema.parse(input.testerAccountRef);
    const requestKey = z.string().trim().min(1).max(128).parse(input.requestKey);
    requireAdministrator(principal, testerAccountRef, 'Gateway policy');
    const now = input.now ?? (() => new Date());

    const prepared = await withBoundedTransaction(this.pool, async (client) => {
      await this.requireDatabaseAdministrator(client, testerAccountRef, now());
      const duplicate = await client.query<{
        readonly http_status: number | null;
        readonly latency_ms: number;
        readonly reason_code: string;
        readonly result: 'failed' | 'passed';
        readonly tested_at: Date;
      }>(
        `select http_status, latency_ms, reason_code, result, tested_at
         from model_gateway_test_events where request_key = $1`,
        [requestKey],
      );
      const prior = duplicate.rows[0];
      if (prior !== undefined) {
        return {
          duplicateOutcome: Object.freeze({
            ...(prior.http_status === null ? {} : { httpStatus: prior.http_status }),
            latencyMs: prior.latency_ms,
            reasonCode: prior.reason_code,
            result: prior.result,
            testedAt: prior.tested_at,
          }),
        };
      }
      const selected = await client.query<GatewayProfileRow>(
        `${profileSelect} where profile.gateway_ref = $1`,
        [gatewayRef],
      );
      const row = selected.rows[0];
      if (row === undefined) throw new PolicyRecordNotFoundError();
      return { row };
    });

    if (prepared.duplicateOutcome !== undefined) {
      return { gatewayRef, outcome: prepared.duplicateOutcome, status: 'duplicate' };
    }

    const row = prepared.row;
    let outcome: ModelGatewayTestOutcome;
    if (row.gateway_kind === 'manifest_default') {
      const apiKey = input.manifestRuntime?.apiKey;
      const baseUrl = input.manifestRuntime?.baseUrl;
      if (apiKey === undefined || baseUrl === undefined || !isPrivateManifestBaseUrl(baseUrl)) {
        outcome = Object.freeze({
          latencyMs: 0,
          reasonCode: 'manifest_runtime_unconfigured',
          result: 'failed',
          testedAt: now(),
        });
      } else {
        outcome = await probeGatewayConnection({
          apiKey,
          baseUrl,
          gatewayKind: 'manifest_default',
          modelName: 'auto',
          now,
          ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
        });
      }
    } else {
      const apiKey = this.decryptRowSecret(row);
      outcome = await probeGatewayConnection({
        apiKey: apiKey.reveal(),
        baseUrl: row.endpoint_base_url ?? '',
        gatewayKind: 'openai_compatible',
        modelName: row.model_name,
        now,
        ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      });
    }

    const persisted = await this.recordTestOutcome(
      { gatewayRef, outcome, requestKey, testerAccountRef },
      principal,
    );
    return { gatewayRef, outcome, status: persisted.status };
  }

  public async transitionProfile(
    inputValue: unknown,
    principal: ReviewerPrincipal,
  ): Promise<{ readonly gatewayRef: string; readonly status: 'applied' | 'duplicate' }> {
    const parsed = transitionSchema.safeParse(inputValue);
    if (!parsed.success) throw new GatewayConfigurationError('Gateway transition input is invalid');
    const input = parsed.data;
    requireAdministrator(principal, input.reviewerAccountRef, 'Gateway policy');

    return withBoundedTransaction(this.pool, async (client) => {
      const reviewerId = await this.requireDatabaseAdministrator(
        client,
        input.reviewerAccountRef,
        input.effectiveAt,
      );
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        input.requestKey,
      ]);
      const existing = await client.query<{
        readonly action: 'activate' | 'retire';
        readonly effective_at: Date;
        readonly gateway_ref: string;
        readonly reason_code: string;
        readonly reviewer_account_ref: string;
      }>(
        `select event.action, event.effective_at, profile.gateway_ref,
                event.reason_code, reviewer.account_ref as reviewer_account_ref
         from model_gateway_review_events as event
         join model_gateway_profiles as profile on profile.id = event.gateway_profile_id
         join admin_accounts as reviewer on reviewer.id = event.reviewer_account_id
         where event.request_key = $1`,
        [input.requestKey],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        if (
          prior.action !== input.action ||
          prior.gateway_ref !== input.gatewayRef ||
          prior.reason_code !== input.reasonCode ||
          prior.reviewer_account_ref !== input.reviewerAccountRef ||
          !sameDate(prior.effective_at, input.effectiveAt)
        ) {
          throw new PolicyIdempotencyConflictError();
        }
        return { gatewayRef: prior.gateway_ref, status: 'duplicate' };
      }

      const target = await client.query<{
        readonly gateway_kind: ModelGatewayKind;
        readonly id: string;
        readonly last_test_status: ModelGatewayTestStatus;
        readonly state: ModelGatewayProfileState;
      }>(
        `select id::text as id, gateway_kind, last_test_status, state
         from model_gateway_profiles where gateway_ref = $1 for update`,
        [input.gatewayRef],
      );
      const profile = target.rows[0];
      if (profile === undefined) throw new PolicyRecordNotFoundError();
      if (input.action === 'activate') {
        if (profile.state !== 'draft') {
          throw new GatewayStateTransitionError('Only draft gateway profiles can be activated');
        }
        if (profile.gateway_kind === 'openai_compatible' && profile.last_test_status !== 'passed') {
          throw new GatewayStateTransitionError(
            'OpenAI-compatible gateway activation requires a passed connection test',
          );
        }
      } else if (profile.state !== 'active') {
        throw new GatewayStateTransitionError('Only active gateway profiles can be retired');
      }

      try {
        await client.query(
          `insert into model_gateway_review_events
             (gateway_profile_id, action, reviewer_account_id, reason_code,
              request_key, effective_at)
           values ($1,$2,$3,$4,$5,$6)`,
          [
            profile.id,
            input.action,
            reviewerId,
            input.reasonCode,
            input.requestKey,
            input.effectiveAt,
          ],
        );
      } catch (error: unknown) {
        if ((error as { code?: string }).code === '23514') {
          throw new GatewayStateTransitionError('Invalid gateway profile transition');
        }
        throw error;
      }
      return { gatewayRef: input.gatewayRef, status: 'applied' };
    });
  }

  public async listProfiles(limit = 100): Promise<readonly ModelGatewayProfileView[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new TypeError('Gateway profile list limit is invalid');
    }
    return withBoundedTransaction(this.pool, async (client) => {
      const selected = await client.query<GatewayProfileRow>(
        `${profileSelect} order by profile.version_number desc limit $1`,
        [limit],
      );
      return selected.rows.map(viewFromRow);
    });
  }

  public async getProfile(gatewayRef: string): Promise<ModelGatewayProfileView> {
    if (!referenceSchema.safeParse(gatewayRef).success) {
      throw new TypeError('Gateway profile reference is invalid');
    }
    return withBoundedTransaction(this.pool, async (client) => {
      const selected = await client.query<GatewayProfileRow>(
        `${profileSelect} where profile.gateway_ref = $1`,
        [gatewayRef],
      );
      const row = selected.rows[0];
      if (row === undefined) throw new PolicyRecordNotFoundError();
      return viewFromRow(row);
    });
  }

  public async readActiveBudgetSummary(
    evaluatedAt: Date,
  ): Promise<ModelGatewayBudgetSummary | undefined> {
    validDate.parse(evaluatedAt);
    return withBoundedTransaction(this.pool, async (client) => {
      const active = await client.query<{
        readonly budget_micro_usd: string;
        readonly budget_window_kind: ModelBudgetWindowKind;
        readonly id: string;
      }>(
        `select id::text as id, budget_micro_usd::text as budget_micro_usd, budget_window_kind
         from model_gateway_profiles where state = 'active'`,
      );
      const row = active.rows[0];
      if (row === undefined) return undefined;
      const bounds = budgetWindowBounds(row.budget_window_kind, evaluatedAt);
      const usage = await client.query<{
        readonly reserved_micro_usd: string;
        readonly spent_micro_usd: string;
      }>(
        `select reserved_micro_usd::text as reserved_micro_usd,
                spent_micro_usd::text as spent_micro_usd
         from model_budget_windows
         where gateway_profile_id = $1 and window_kind = $2 and window_started_at = $3`,
        [row.id, row.budget_window_kind, bounds.windowStartedAt],
      );
      const current = usage.rows[0];
      return Object.freeze({
        budgetMicroUsd: Number(row.budget_micro_usd),
        budgetWindowKind: row.budget_window_kind,
        reservedMicroUsd: current === undefined ? 0 : Number(current.reserved_micro_usd),
        spentMicroUsd: current === undefined ? 0 : Number(current.spent_micro_usd),
        windowEndedAt: bounds.windowEndedAt,
        windowStartedAt: bounds.windowStartedAt,
      });
    });
  }

  public async resolveRuntimeGateway(): Promise<ResolvedRuntimeGateway> {
    return withBoundedTransaction(this.pool, async (client) => {
      const selected = await client.query<GatewayProfileRow>(
        `${profileSelect} where profile.state = 'active'`,
      );
      if (selected.rows.length > 1) {
        throw new Error('Multiple active gateway profiles exist');
      }
      const row = selected.rows[0];
      if (row === undefined) {
        return Object.freeze({
          budgetMicroUsd: 0 as const,
          budgetWindowKind: 'utc_month' as const,
          gatewayKind: 'manifest_default' as const,
          gatewayProfileId: undefined,
          gatewayRef: undefined,
          inputCostPerMillionMicroUsd: 0 as const,
          modelName: 'auto' as const,
          outputCostPerMillionMicroUsd: 0 as const,
        });
      }
      if (row.gateway_kind === 'manifest_default') {
        return Object.freeze({
          budgetMicroUsd: Number(row.budget_micro_usd),
          budgetWindowKind: row.budget_window_kind,
          gatewayKind: 'manifest_default' as const,
          gatewayProfileId: row.id,
          gatewayRef: row.gateway_ref,
          inputCostPerMillionMicroUsd: Number(row.input_cost_per_million_micro_usd),
          modelName: 'auto' as const,
          outputCostPerMillionMicroUsd: Number(row.output_cost_per_million_micro_usd),
        });
      }
      const apiKey = this.decryptRowSecret(row);
      return Object.freeze({
        apiKey,
        budgetMicroUsd: Number(row.budget_micro_usd),
        budgetWindowKind: row.budget_window_kind,
        endpointBaseUrl: row.endpoint_base_url ?? '',
        gatewayKind: 'openai_compatible' as const,
        gatewayProfileId: row.id,
        gatewayRef: row.gateway_ref,
        inputCostPerMillionMicroUsd: Number(row.input_cost_per_million_micro_usd),
        modelName: row.model_name,
        outputCostPerMillionMicroUsd: Number(row.output_cost_per_million_micro_usd),
      });
    });
  }

  private requireProtector(): AesGcmGatewaySecretProtector {
    if (this.protector === undefined) {
      throw new GatewayEncryptionKeyMissingError(
        'MODEL_GATEWAY_ENCRYPTION_KEY must be configured for OpenAI-compatible gateway secrets',
      );
    }
    return this.protector;
  }

  private decryptRowSecret(row: GatewayProfileRow): SecretText {
    const protector = this.requireProtector();
    if (
      row.key_version === null ||
      row.encrypted_api_key === null ||
      row.encryption_nonce === null ||
      row.authentication_tag === null ||
      row.api_key_sha256 === null
    ) {
      throw new TypeError('Protected gateway secret is missing');
    }
    return protector.decrypt(
      {
        apiKeySha256: row.api_key_sha256,
        authenticationTag: new SecretBytes(row.authentication_tag),
        encryptedMaterial: new SecretBytes(row.encrypted_api_key),
        encryptionNonce: new SecretBytes(row.encryption_nonce),
        keyVersion: row.key_version,
      },
      row.gateway_ref,
    );
  }

  private async requireDatabaseAdministrator(
    client: pg.PoolClient,
    accountRef: string,
    evaluatedAt: Date,
  ): Promise<string> {
    const selected = await client.query<{ readonly id: string }>(
      `select account.id
       from admin_accounts as account
       where account.account_ref = $1 and account.state = 'active'
         and exists (
           select 1 from lateral (
             select assignment.action
             from admin_role_assignments as assignment
             where assignment.account_id = account.id
               and assignment.role = 'administrator'
               and assignment.effective_at <= $2
             order by assignment.effective_at desc, assignment.id desc
             limit 1
           ) as current where current.action = 'assign'
         )
       for update of account`,
      [accountRef, evaluatedAt],
    );
    const id = selected.rows[0]?.id;
    if (id === undefined) {
      throw new PolicyAuthorizationError('Gateway policy administrator identity is not authorized');
    }
    return id;
  }
}
