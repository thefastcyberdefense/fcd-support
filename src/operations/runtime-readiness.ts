import { z } from 'zod';

import {
  runtimeRoles,
  type ComponentCode,
  type HealthObservation,
  type HealthState,
  type RuntimeRole,
} from './operations-types.js';

export interface RuntimeReadinessPorts {
  readonly now: () => Date;
  readSchemaRevision: () => Promise<string>;
  readDeployedRevision: () => Promise<string>;
  hasRequiredPolicy: (role: RuntimeRole, evaluatedAt: Date) => Promise<boolean>;
  checkPrivateDependency: (role: RuntimeRole) => Promise<HealthState>;
}
export interface RuntimeHeartbeat {
  readonly state: HealthState;
  readonly checkedAt: string;
}
const heartbeatSchema = z.strictObject({
  state: z.enum(['healthy', 'degraded', 'unavailable', 'disabled', 'unknown']),
  checkedAt: z.iso.datetime(),
});
const inputSchema = z.strictObject({
  role: z.enum(runtimeRoles),
  revision: z.string().regex(/^[a-f0-9]{40}$/u),
  expectedSchemaRevision: z.string().regex(/^\d{6}$/u),
  externalExecutionEnabled: z.boolean(),
  timeoutMilliseconds: z.number().int().min(1).max(300000),
});
export function parseRuntimeHeartbeat(value: unknown): RuntimeHeartbeat | undefined {
  const parsed = heartbeatSchema.safeParse(value);
  return parsed.success ? Object.freeze(parsed.data) : undefined;
}
const components: Readonly<Record<RuntimeRole, ComponentCode>> = {
  webhook: 'webhook',
  admin: 'postgres',
  reply: 'reply',
  outbound: 'outbound',
  notification: 'notification',
  maintenance: 'postgres',
  health: 'postgres',
  checkpoint: 'deletion_checkpoint',
  migrate: 'migration',
  backup: 'backup',
  verify_backup: 'backup',
  restore: 'backup',
};

export function isRuntimeHeartbeatFresh(
  value: unknown,
  evaluatedAt: Date,
  staleMilliseconds: number,
): boolean {
  const parsed = heartbeatSchema.safeParse(value);
  if (
    !parsed.success ||
    !Number.isSafeInteger(staleMilliseconds) ||
    staleMilliseconds <= 0 ||
    !Number.isFinite(evaluatedAt.getTime())
  )
    return false;
  const age = evaluatedAt.getTime() - Date.parse(parsed.data.checkedAt);
  return (
    age >= 0 &&
    age < staleMilliseconds &&
    (parsed.data.state === 'healthy' || parsed.data.state === 'disabled')
  );
}

export async function checkRuntimeReadiness(
  input: z.infer<typeof inputSchema>,
  dependencies: RuntimeReadinessPorts,
): Promise<HealthObservation> {
  const startedAt = dependencies.now();
  const parsed = inputSchema.safeParse(input);
  const component = parsed.success ? components[parsed.data.role] : 'postgres';
  function observation(
    state: HealthState,
    reasonCode: HealthObservation['reasonCode'],
  ): HealthObservation {
    const checkedAt = dependencies.now();
    return Object.freeze({
      component,
      state,
      reasonCode,
      checkedAt,
      durationMilliseconds: Math.max(0, checkedAt.getTime() - startedAt.getTime()),
    });
  }
  if (!parsed.success) return observation('unavailable', 'configuration_invalid');
  const command = parsed.data;
  const finished = new AbortController();
  const isFinished = (): boolean => finished.signal.aborted;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function probe(): Promise<HealthObservation> {
    if ((await dependencies.readSchemaRevision()) !== command.expectedSchemaRevision)
      return observation('unavailable', 'configuration_invalid');
    if (isFinished()) return observation('unavailable', 'timeout');
    if ((await dependencies.readDeployedRevision()) !== command.revision)
      return observation('unavailable', 'configuration_invalid');
    if (isFinished()) return observation('unavailable', 'timeout');
    if (
      !command.externalExecutionEnabled &&
      (command.role === 'outbound' || command.role === 'notification')
    )
      return observation('disabled', 'disabled');
    if (!(await dependencies.hasRequiredPolicy(command.role, dependencies.now())))
      return observation('unavailable', 'configuration_invalid');
    if (isFinished()) return observation('unavailable', 'timeout');
    if (command.role === 'reply' && !command.externalExecutionEnabled)
      return observation('healthy', 'ok');
    const state = await dependencies.checkPrivateDependency(command.role);
    if (isFinished()) return observation('unavailable', 'timeout');
    return state === 'healthy'
      ? observation('healthy', 'ok')
      : observation(state === 'degraded' ? 'degraded' : 'unavailable', 'dependency_unavailable');
  }
  try {
    return await Promise.race([
      probe().catch(() => observation('unavailable', 'dependency_unavailable')),
      new Promise<HealthObservation>((resolve) => {
        timer = setTimeout(() => {
          resolve(observation('unavailable', 'timeout'));
        }, command.timeoutMilliseconds);
      }),
    ]);
  } finally {
    finished.abort();
    clearTimeout(timer);
  }
}
