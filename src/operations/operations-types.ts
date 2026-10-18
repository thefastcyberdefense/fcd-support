export const runtimeRoles = [
  'webhook',
  'admin',
  'reply',
  'outbound',
  'notification',
  'maintenance',
  'health',
  'checkpoint',
  'migrate',
  'backup',
  'verify_backup',
  'restore',
] as const;
export type RuntimeRole = (typeof runtimeRoles)[number];
export type ComponentCode =
  | 'webhook'
  | 'postgres'
  | 'reply'
  | 'outbound'
  | 'notification'
  | 'manifest'
  | 'n8n'
  | 'tunnel'
  | 'backup'
  | 'migration'
  | 'deletion_checkpoint';
export type HealthState = 'healthy' | 'degraded' | 'unavailable' | 'disabled' | 'unknown';
export interface HealthObservation {
  readonly component: ComponentCode;
  readonly state: HealthState;
  readonly reasonCode:
    | 'ok'
    | 'timeout'
    | 'dependency_unavailable'
    | 'not_verified'
    | 'disabled'
    | 'stale'
    | 'configuration_invalid'
    | 'collection_failed';
  readonly checkedAt: Date;
  readonly durationMilliseconds: number;
}
export interface JobSummary {
  readonly status: 'completed' | 'skipped' | 'failed';
  readonly processed: number;
  readonly reasonCode:
    | 'ok'
    | 'not_due'
    | 'disabled'
    | 'dependency_unavailable'
    | 'verification_failed'
    | 'configuration_invalid';
}
export interface RuntimeLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}
export type MaintenanceJob = 'retention' | 'deletion' | 'lease_recovery' | 'learning';
