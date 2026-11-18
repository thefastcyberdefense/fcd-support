import type { ModelBudgetWindowKind } from './gateway-types.js';

const MILLION = 1_000_000n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
export const MAX_BUDGET_MICRO_USD = 1_000_000_000_000;
export const MAX_RATE_MICRO_USD = 100_000_000_000;

function ceilDivideMillions(numerator: bigint): number {
  if (numerator < 0n) throw new RangeError('Cost numerator cannot be negative');
  if (numerator === 0n) return 0;
  const quotient = (numerator + (MILLION - 1n)) / MILLION;
  if (quotient > MAX_SAFE) throw new RangeError('Micro-USD amount exceeds safe integer range');
  return Number(quotient);
}

export function computeMaxEstimatedCostMicroUsd(input: {
  readonly inputCodePoints: number;
  readonly inputCostPerMillionMicroUsd: number;
  readonly maxOutputTokens: number;
  readonly outputCostPerMillionMicroUsd: number;
}): number {
  if (
    !Number.isSafeInteger(input.inputCodePoints) ||
    input.inputCodePoints < 0 ||
    !Number.isSafeInteger(input.maxOutputTokens) ||
    input.maxOutputTokens < 1 ||
    !Number.isSafeInteger(input.inputCostPerMillionMicroUsd) ||
    input.inputCostPerMillionMicroUsd < 0 ||
    input.inputCostPerMillionMicroUsd > MAX_RATE_MICRO_USD ||
    !Number.isSafeInteger(input.outputCostPerMillionMicroUsd) ||
    input.outputCostPerMillionMicroUsd < 0 ||
    input.outputCostPerMillionMicroUsd > MAX_RATE_MICRO_USD
  ) {
    throw new TypeError('Budget estimation input is invalid');
  }
  // Multi-token scripts (including Bangla) can expand above 1 token per code point; 2x bounds request tokens safely.
  const estimatedMaxInputTokens = BigInt(input.inputCodePoints) * 2n;
  const numerator =
    estimatedMaxInputTokens * BigInt(input.inputCostPerMillionMicroUsd) +
    BigInt(input.maxOutputTokens) * BigInt(input.outputCostPerMillionMicroUsd);
  return ceilDivideMillions(numerator);
}

export function computeActualCallCostMicroUsd(input: {
  readonly completionTokens: number;
  readonly inputCostPerMillionMicroUsd: number;
  readonly outputCostPerMillionMicroUsd: number;
  readonly promptTokens: number;
}): number {
  if (
    !Number.isSafeInteger(input.promptTokens) ||
    input.promptTokens < 0 ||
    !Number.isSafeInteger(input.completionTokens) ||
    input.completionTokens < 0 ||
    !Number.isSafeInteger(input.inputCostPerMillionMicroUsd) ||
    input.inputCostPerMillionMicroUsd < 0 ||
    input.inputCostPerMillionMicroUsd > MAX_RATE_MICRO_USD ||
    !Number.isSafeInteger(input.outputCostPerMillionMicroUsd) ||
    input.outputCostPerMillionMicroUsd < 0 ||
    input.outputCostPerMillionMicroUsd > MAX_RATE_MICRO_USD
  ) {
    throw new TypeError('Actual cost calculation input is invalid');
  }
  const numerator =
    BigInt(input.promptTokens) * BigInt(input.inputCostPerMillionMicroUsd) +
    BigInt(input.completionTokens) * BigInt(input.outputCostPerMillionMicroUsd);
  return ceilDivideMillions(numerator);
}

export function budgetWindowBounds(
  kind: ModelBudgetWindowKind,
  evaluatedAt: Date,
): { readonly windowEndedAt: Date; readonly windowStartedAt: Date } {
  if (!Number.isFinite(evaluatedAt.getTime())) {
    throw new TypeError('Budget evaluation timestamp is invalid');
  }
  const year = evaluatedAt.getUTCFullYear();
  const month = evaluatedAt.getUTCMonth();
  const day = evaluatedAt.getUTCDate();
  if (kind === 'utc_day') {
    const windowStartedAt = new Date(Date.UTC(year, month, day));
    const windowEndedAt = new Date(Date.UTC(year, month, day + 1));
    return { windowStartedAt, windowEndedAt };
  }
  const windowStartedAt = new Date(Date.UTC(year, month, 1));
  const windowEndedAt = new Date(Date.UTC(year, month + 1, 1));
  return { windowStartedAt, windowEndedAt };
}

export function parseUsdToMicroUsd(raw: string, maximumMicroUsd = MAX_BUDGET_MICRO_USD): number {
  const trimmed = raw.trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/u.test(trimmed)) {
    throw new TypeError('USD amount must be a non-negative decimal with at most 6 decimal places');
  }
  const [wholePart = '0', fractionalPart = ''] = trimmed.split('.');
  const micro = BigInt(wholePart) * MILLION + BigInt(fractionalPart.padEnd(6, '0'));
  if (micro < 0n || micro > BigInt(maximumMicroUsd)) {
    throw new TypeError('USD amount exceeds allowed range');
  }
  return Number(micro);
}

export function formatMicroUsd(microUsd: number): string {
  if (!Number.isSafeInteger(microUsd) || microUsd < 0) {
    throw new TypeError('Micro-USD amount is invalid');
  }
  const whole = Math.floor(microUsd / 1_000_000);
  const fraction = String(microUsd % 1_000_000).padStart(6, '0');
  return `${String(whole)}.${fraction}`;
}
