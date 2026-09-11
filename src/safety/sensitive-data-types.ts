import type { KnowledgeLanguage } from '../knowledge/knowledge-types.js';

export const sensitiveDataCategories = [
  'password',
  'authentication_secret',
  'otp',
  'recovery_code',
  'api_key',
  'access_token',
  'cookie',
  'session',
  'payment_card',
  'bank_account',
  'private_key',
  'credential_file',
  'sensitive_incident_evidence',
] as const;
export type SensitiveDataCategory = (typeof sensitiveDataCategories)[number];

export const sensitiveDataReasonCodes = [
  'no_sensitive_data',
  'sensitive_value_redacted',
  'sensitive_data_detected',
  'multiple_sensitive_values',
  'redaction_ambiguous',
  'malformed_unicode',
  'excessive_input',
] as const;
export type SensitiveDataReasonCode = (typeof sensitiveDataReasonCodes)[number];

export interface SensitiveDataPolicy {
  readonly maximumInputCodePoints: number;
}

export interface SensitiveRedactionMarker {
  readonly category: SensitiveDataCategory;
  readonly marker: `[REDACTED_${string}]`;
}

interface SensitiveTextResultBase {
  readonly categories: readonly SensitiveDataCategory[];
  readonly language: KnowledgeLanguage;
  readonly markers: readonly SensitiveRedactionMarker[];
}

export interface SafeSensitiveTextResult extends SensitiveTextResultBase {
  readonly status: 'safe';
  readonly reasonCode: 'no_sensitive_data';
  readonly sanitizedText: string;
}

export interface RedactedSensitiveTextResult extends SensitiveTextResultBase {
  readonly status: 'redacted';
  readonly reasonCode: 'sensitive_value_redacted';
  readonly sanitizedText: string;
}

export interface BlockedSensitiveTextResult extends SensitiveTextResultBase {
  readonly status: 'blocked';
  readonly reasonCode:
    | 'excessive_input'
    | 'malformed_unicode'
    | 'multiple_sensitive_values'
    | 'redaction_ambiguous'
    | 'sensitive_data_detected';
}

export type SensitiveTextInspection =
  BlockedSensitiveTextResult | RedactedSensitiveTextResult | SafeSensitiveTextResult;
