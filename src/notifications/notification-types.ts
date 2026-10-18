export type NotificationType =
  | 'operator_privacy_request'
  | 'operator_marketing_opt_out'
  | 'operator_support_escalation'
  | 'operator_outbound_escalation';
export interface NotificationEnvelope {
  readonly schemaVersion: 1;
  readonly type: NotificationType;
  readonly reference: string;
  readonly occurredAt: Date;
  readonly idempotencyKey: string;
}
export type N8nReason =
  | 'ok'
  | 'timeout'
  | 'transport_failure'
  | 'invalid_response'
  | 'authentication_failed'
  | 'destination_rejected'
  | 'retry_exhausted';
export type N8nResult =
  | { readonly status: 'accepted'; readonly reasonCode: 'ok' }
  | {
      readonly status: 'retryable' | 'terminal_failed';
      readonly reasonCode: Exclude<N8nReason, 'ok'>;
    };
export interface NotificationClaim {
  readonly workRef: string;
  readonly leaseRef: string;
  readonly attemptNumber: number;
  readonly notification: NotificationEnvelope;
}
export interface NotificationRetryPolicy {
  readonly maximumAttempts: number;
  readonly retryBaseMilliseconds: number;
  readonly retryMaximumMilliseconds: number;
}
