import { z } from 'zod';

import { loadModelConfig } from '../model/model-config.js';
import type { ModelDeploymentCeilings } from '../model/model-types.js';
import { loadOutboundConfig } from '../outbound/outbound-config.js';
import type { OutboundDeploymentBounds } from '../outbound/outbound-types.js';
import { runtimeRoles, type RuntimeRole } from './operations-types.js';

const integer = (minimum: number, maximum: number) =>
  z
    .string()
    .regex(/^(?:0|[1-9][0-9]*)$/u)
    .transform(Number)
    .pipe(z.number().int().min(minimum).max(maximum));
const numberText = z
  .string()
  .regex(/^[0-9]+(?:\.[0-9]+)?$/u)
  .transform(Number)
  .pipe(z.number().positive());
const calendar = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9*,:/ ._+-]+$/u);
const resources = z.strictObject({
  cpus: z.number().positive(),
  memoryMiB: z.number().int().positive(),
  pids: z.number().int().positive(),
  tmpfsMiB: z.number().int().positive(),
});
const schema = z.object({
  MODEL_EXECUTION_ENABLED: z.enum(['true', 'false']),
  OUTBOUND_EXECUTION_ENABLED: z.enum(['true', 'false']),
  N8N_EXECUTION_ENABLED: z.enum(['true', 'false']),
  OPS_POLL_MS: integer(100, 60000),
  OPS_BATCH_SIZE: integer(1, 1000),
  OPS_LEASE_MS: integer(1000, 600000),
  OPS_MAX_CALL_MS: integer(100, 300000),
  OPS_SHUTDOWN_GRACE_MS: integer(0, 300000),
  OPS_STOP_GRACE_MS: integer(100, 900000),
  OPS_HEALTH_STALE_MS: integer(500, 86400000),
  OPS_HOST_CPUS: numberText,
  OPS_HOST_MEMORY_MIB: integer(1, 16777216),
  OPS_RESOURCE_LIMITS_JSON: z.string().max(16384),
  OPS_RESOURCE_BOUNDS_JSON: z.string().max(4096),
  BACKUP_DAILY_RETENTION: integer(45, 3650),
  BACKUP_MONTHLY_RETENTION: integer(6, 120),
  BACKUP_CALENDAR: calendar,
  MAINTENANCE_CALENDAR: calendar,
});
export type ResourceLimits = Readonly<z.infer<typeof resources>>;
export interface OperationsConfig {
  readonly role: RuntimeRole;
  readonly pollMilliseconds: number;
  readonly batchSize: number;
  readonly leaseMilliseconds: number;
  readonly maximumCallMilliseconds: number;
  readonly shutdownGraceMilliseconds: number;
  readonly stopGraceMilliseconds: number;
  readonly healthStaleMilliseconds: number;
  readonly dailyRetention: number;
  readonly monthlyRetention: number;
  readonly backupCalendar: string;
  readonly maintenanceCalendar: string;
  readonly modelExecutionEnabled: boolean;
  readonly outboundExecutionEnabled: boolean;
  readonly n8nExecutionEnabled: boolean;
  readonly resourceLimits: Readonly<Partial<Record<RuntimeRole, ResourceLimits>>>;
  readonly modelDeployment?: ModelDeploymentCeilings;
  readonly outboundDeployment?: OutboundDeploymentBounds;
}

export function loadOperationsConfig(
  role: RuntimeRole,
  environment: Readonly<Record<string, string | undefined>>,
): OperationsConfig {
  try {
    if (!runtimeRoles.includes(role)) throw new TypeError('invalid');
    const input = schema.parse(environment);
    if (
      input.OPS_STOP_GRACE_MS <= input.OPS_MAX_CALL_MS + input.OPS_SHUTDOWN_GRACE_MS ||
      input.OPS_LEASE_MS <= input.OPS_MAX_CALL_MS + input.OPS_SHUTDOWN_GRACE_MS ||
      input.OPS_HEALTH_STALE_MS <= input.OPS_POLL_MS
    )
      throw new TypeError('invalid');
    const limits = z
      .partialRecord(z.enum(runtimeRoles), resources)
      .parse(JSON.parse(input.OPS_RESOURCE_LIMITS_JSON));
    const bounds = z
      .strictObject({ minimum: resources, maximum: resources })
      .parse(JSON.parse(input.OPS_RESOURCE_BOUNDS_JSON));
    if (limits[role] === undefined) throw new TypeError('invalid');
    for (const field of ['cpus', 'memoryMiB', 'pids', 'tmpfsMiB'] as const) {
      if (bounds.minimum[field] > bounds.maximum[field]) throw new TypeError('invalid');
      for (const limit of Object.values(limits)) {
        if (limit[field] < bounds.minimum[field] || limit[field] > bounds.maximum[field]) {
          throw new TypeError('invalid');
        }
      }
    }
    for (const limit of Object.values(limits)) {
      if (
        limit.cpus > input.OPS_HOST_CPUS ||
        limit.memoryMiB > input.OPS_HOST_MEMORY_MIB ||
        limit.tmpfsMiB >= limit.memoryMiB
      )
        throw new TypeError('invalid');
      Object.freeze(limit);
    }
    let modelDeployment: ModelDeploymentCeilings | undefined;
    let outboundDeployment: OutboundDeploymentBounds | undefined;
    if (role === 'reply' && input.MODEL_EXECUTION_ENABLED === 'true') {
      modelDeployment = loadModelConfig(environment).deploymentCeilings;
      if (modelDeployment.totalTimeoutMs > input.OPS_MAX_CALL_MS) throw new TypeError('invalid');
    }
    if (role === 'outbound' && input.OUTBOUND_EXECUTION_ENABLED === 'true') {
      outboundDeployment = loadOutboundConfig(environment).deploymentBounds;
      if (outboundDeployment.providerTimeoutMs > input.OPS_MAX_CALL_MS)
        throw new TypeError('invalid');
    }
    if (role === 'notification' && input.N8N_EXECUTION_ENABLED === 'true') {
      const timeout = integer(100, 300000).parse(environment.N8N_PROVIDER_TIMEOUT_MS);
      if (timeout > input.OPS_MAX_CALL_MS) throw new TypeError('invalid');
    }
    return Object.freeze({
      role,
      pollMilliseconds: input.OPS_POLL_MS,
      batchSize: input.OPS_BATCH_SIZE,
      leaseMilliseconds: input.OPS_LEASE_MS,
      maximumCallMilliseconds: input.OPS_MAX_CALL_MS,
      shutdownGraceMilliseconds: input.OPS_SHUTDOWN_GRACE_MS,
      stopGraceMilliseconds: input.OPS_STOP_GRACE_MS,
      healthStaleMilliseconds: input.OPS_HEALTH_STALE_MS,
      dailyRetention: input.BACKUP_DAILY_RETENTION,
      monthlyRetention: input.BACKUP_MONTHLY_RETENTION,
      backupCalendar: input.BACKUP_CALENDAR,
      maintenanceCalendar: input.MAINTENANCE_CALENDAR,
      modelExecutionEnabled: input.MODEL_EXECUTION_ENABLED === 'true',
      outboundExecutionEnabled: input.OUTBOUND_EXECUTION_ENABLED === 'true',
      n8nExecutionEnabled: input.N8N_EXECUTION_ENABLED === 'true',
      resourceLimits: Object.freeze(limits),
      ...(modelDeployment === undefined ? {} : { modelDeployment }),
      ...(outboundDeployment === undefined ? {} : { outboundDeployment }),
    });
  } catch {
    throw new TypeError('configuration_invalid');
  }
}
