import type { SecretBytes, SecretText } from '../safety/secret-bytes.js';

export type ModelGatewayKind = 'manifest_default' | 'openai_compatible';
export type ModelGatewayProfileState = 'draft' | 'active' | 'retired';
export type ModelGatewayTestStatus = 'untested' | 'passed' | 'failed';
export type ModelBudgetWindowKind = 'utc_day' | 'utc_month';

export interface ProtectedGatewayApiKey {
  readonly apiKeySha256: string;
  readonly authenticationTag: SecretBytes;
  readonly encryptedMaterial: SecretBytes;
  readonly encryptionNonce: SecretBytes;
  readonly keyVersion: string;
}

export interface ModelGatewayProfileCreateInput {
  readonly apiKey?: SecretText | undefined;
  readonly budgetMicroUsd: number;
  readonly budgetWindowKind: ModelBudgetWindowKind;
  readonly createdAt: Date;
  readonly createdByAccountRef: string;
  readonly displayLabel: string;
  readonly endpointBaseUrl?: string | undefined;
  readonly gatewayKind: ModelGatewayKind;
  readonly gatewayRef: string;
  readonly inputCostPerMillionMicroUsd: number;
  readonly modelName: string;
  readonly outputCostPerMillionMicroUsd: number;
  readonly requestKey: string;
}

export interface ModelGatewayProfileView {
  readonly activatedAt?: Date;
  readonly activatedByAccountRef?: string;
  readonly apiKeySha256?: string;
  readonly budgetMicroUsd: number;
  readonly budgetWindowKind: ModelBudgetWindowKind;
  readonly createdAt: Date;
  readonly createdByAccountRef: string;
  readonly displayLabel: string;
  readonly endpointBaseUrl?: string;
  readonly gatewayKind: ModelGatewayKind;
  readonly gatewayRef: string;
  readonly inputCostPerMillionMicroUsd: number;
  readonly keyVersion?: string;
  readonly lastTestHttpStatus?: number;
  readonly lastTestReasonCode?: string;
  readonly lastTestStatus: ModelGatewayTestStatus;
  readonly lastTestedAt?: Date;
  readonly modelName: string;
  readonly outputCostPerMillionMicroUsd: number;
  readonly requestKey: string;
  readonly retiredAt?: Date;
  readonly state: ModelGatewayProfileState;
  readonly versionNumber: number;
}

export interface ModelGatewayBudgetSummary {
  readonly budgetMicroUsd: number;
  readonly budgetWindowKind: ModelBudgetWindowKind;
  readonly reservedMicroUsd: number;
  readonly spentMicroUsd: number;
  readonly windowEndedAt: Date;
  readonly windowStartedAt: Date;
}

export interface ModelGatewayTestOutcome {
  readonly httpStatus?: number;
  readonly latencyMs: number;
  readonly reasonCode: string;
  readonly result: 'failed' | 'passed';
  readonly testedAt: Date;
}

export type ResolvedRuntimeGateway =
  | {
      readonly budgetMicroUsd: 0;
      readonly budgetWindowKind: 'utc_month';
      readonly gatewayKind: 'manifest_default';
      readonly gatewayProfileId: undefined;
      readonly gatewayRef: undefined;
      readonly inputCostPerMillionMicroUsd: 0;
      readonly modelName: 'auto';
      readonly outputCostPerMillionMicroUsd: 0;
    }
  | {
      readonly budgetMicroUsd: number;
      readonly budgetWindowKind: ModelBudgetWindowKind;
      readonly gatewayKind: 'manifest_default';
      readonly gatewayProfileId: string;
      readonly gatewayRef: string;
      readonly inputCostPerMillionMicroUsd: number;
      readonly modelName: 'auto';
      readonly outputCostPerMillionMicroUsd: number;
    }
  | {
      readonly apiKey: SecretText;
      readonly budgetMicroUsd: number;
      readonly budgetWindowKind: ModelBudgetWindowKind;
      readonly endpointBaseUrl: string;
      readonly gatewayKind: 'openai_compatible';
      readonly gatewayProfileId: string;
      readonly gatewayRef: string;
      readonly inputCostPerMillionMicroUsd: number;
      readonly modelName: string;
      readonly outputCostPerMillionMicroUsd: number;
    };
