import { z } from 'zod';
import type { HealthObservation } from './operations-types.js';

const timestamp = z.iso.datetime();
const revision = z.string().regex(/^[a-f0-9]{40}$/u);
const health = z.enum(['healthy', 'degraded', 'unavailable', 'disabled', 'unknown']);
const hostSchema = z.strictObject({
  checkedAt: timestamp,
  services: z
    .array(
      z.strictObject({
        component: z.enum(['webhook', 'reply', 'outbound', 'notification', 'tunnel']),
        running: z.boolean(),
        health: health,
        gitRevision: revision,
        heartbeat: z.strictObject({ checkedAt: timestamp, state: health }).optional(),
      }),
    )
    .max(5)
    .refine((rows) => new Set(rows.map((row) => row.component)).size === rows.length),
  adminSocket: health,
  manifestAttestation: z.enum(['verified', 'not_verified']),
  publicRouteCheck: z
    .strictObject({
      state: z.enum(['passed', 'failed', 'not_verified']),
      checkedAt: timestamp.optional(),
    })
    .refine((value) => value.state === 'not_verified' || value.checkedAt !== undefined),
});
export type HostHealthSnapshot = z.infer<typeof hostSchema>;
export function parseHostHealthSnapshot(value: unknown): HostHealthSnapshot | undefined {
  const parsed = hostSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
export interface HealthQueueAggregate {
  readonly component: 'reply' | 'outbound' | 'notification';
  readonly pending: number;
  readonly leased: number;
  readonly failed: number;
  readonly completed: number;
  readonly oldestAgeBucket: 'empty' | 'under_minute' | 'under_hour' | 'under_day' | 'over_day';
}
export interface HealthDatabaseSnapshot {
  readonly lastCollectedAt?: Date | null;
  readonly schemaRevision: string;
  readonly gitRevision: string | null;
  readonly backupCreatedAt: Date | null;
  readonly backupVerified: boolean;
  readonly deletionCheckpointAt: Date | null;
  readonly queues: readonly HealthQueueAggregate[];
}
export interface HealthJournalEvent {
  readonly event: 'operations_health';
  readonly component: HealthObservation['component'];
  readonly state: HealthObservation['state'];
  readonly checkedAt: string;
}
export interface HealthOutageGap {
  readonly startedAt: string;
  readonly lastObservedAt: string;
}
export interface HealthOutagePort {
  readonly read: () => Promise<HealthOutageGap | undefined>;
  readonly write: (gap: HealthOutageGap) => Promise<void>;
  readonly clear: () => Promise<void>;
}
export interface HealthCollectorOptions {
  readonly database: { readonly read: () => Promise<HealthDatabaseSnapshot> };
  readonly store: { readonly recordHealth: (value: HealthObservation) => Promise<void> };
  readonly now: () => Date;
  readonly timeoutMilliseconds: number;
  readonly staleMilliseconds: number;
  readonly maximumOutageGapMilliseconds: number;
  readonly expectedSchemaRevision: string;
  readonly expectedGitRevision: string;
  readonly modelEnabled: boolean;
  readonly notificationsEnabled: boolean;
  readonly outboundEnabled?: boolean;
  readonly backupStaleMilliseconds?: number;
  readonly hostSnapshot?: unknown;
  /** Availability only. Ports must obey AbortSignal and never perform provider actions. */
  readonly manifestProbe?: (signal: AbortSignal) => Promise<'healthy' | 'unavailable'>;
  readonly n8nProbe?: (signal: AbortSignal) => Promise<'healthy' | 'unavailable'>;
  readonly journal: (value: HealthJournalEvent) => void;
  readonly outage: HealthOutagePort;
}
class HealthTimeout extends Error {}
export async function boundedHealthCall<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new HealthTimeout());
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
function fresh(at: Date | string, evaluatedAt: Date, maximumAge: number): boolean {
  const age = evaluatedAt.getTime() - new Date(at).getTime();
  return Number.isFinite(age) && age >= 0 && age <= maximumAge;
}
const gapSchema = z
  .strictObject({ startedAt: timestamp, lastObservedAt: timestamp })
  .refine((gap) => gap.startedAt <= gap.lastObservedAt);
export async function collectHealth(
  options: HealthCollectorOptions,
): Promise<readonly HealthObservation[]> {
  for (const value of [
    options.timeoutMilliseconds,
    options.staleMilliseconds,
    options.maximumOutageGapMilliseconds,
  ])
    if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000)
      throw new TypeError('health_configuration_invalid');
  if (
    options.timeoutMilliseconds > 300_000 ||
    !/^\d{6}$/u.test(options.expectedSchemaRevision) ||
    !revision.safeParse(options.expectedGitRevision).success
  )
    throw new TypeError('health_configuration_invalid');
  const checkedAt = options.now();
  if (!Number.isFinite(checkedAt.getTime())) throw new TypeError('health_configuration_invalid');
  const result: HealthObservation[] = [];
  const observation = (
    component: HealthObservation['component'],
    state: HealthObservation['state'],
    reasonCode: HealthObservation['reasonCode'],
  ): HealthObservation => ({
    component,
    state,
    reasonCode,
    checkedAt,
    durationMilliseconds: Math.min(
      300_000,
      Math.max(0, options.now().getTime() - checkedAt.getTime()),
    ),
  });
  const journal = (value: HealthObservation) => {
    try {
      options.journal({
        event: 'operations_health',
        component: value.component,
        state: value.state,
        checkedAt: value.checkedAt.toISOString(),
      });
    } catch {
      /* Journal failure carries no external details. */
    }
  };
  const call = <T>(operation: () => Promise<T>) =>
    boundedHealthCall(operation, options.timeoutMilliseconds);
  async function recordOutage(): Promise<readonly HealthObservation[]> {
    const unavailable = observation('postgres', 'unavailable', 'dependency_unavailable');
    journal(unavailable);
    try {
      const prior = gapSchema.safeParse(await call(options.outage.read));
      await call(() =>
        options.outage.write({
          startedAt:
            prior.success && prior.data.startedAt <= checkedAt.toISOString()
              ? prior.data.startedAt
              : checkedAt.toISOString(),
          lastObservedAt: checkedAt.toISOString(),
        }),
      );
    } catch {
      /* Fixed journal event remains authoritative while persistence is unavailable. */
    }
    return [unavailable];
  }
  let database: HealthDatabaseSnapshot;
  try {
    database = await call(options.database.read);
  } catch {
    return recordOutage();
  }
  result.push(observation('postgres', 'healthy', 'ok'));
  result.push(
    observation(
      'migration',
      database.schemaRevision === options.expectedSchemaRevision &&
        database.gitRevision === options.expectedGitRevision
        ? 'healthy'
        : 'unavailable',
      database.schemaRevision === options.expectedSchemaRevision &&
        database.gitRevision === options.expectedGitRevision
        ? 'ok'
        : 'configuration_invalid',
    ),
  );
  const backupFresh =
    database.backupCreatedAt !== null &&
    fresh(database.backupCreatedAt, checkedAt, options.backupStaleMilliseconds ?? 129_600_000);
  result.push(
    observation(
      'backup',
      backupFresh && database.backupVerified ? 'healthy' : 'degraded',
      database.backupCreatedAt === null
        ? 'not_verified'
        : !backupFresh
          ? 'stale'
          : database.backupVerified
            ? 'ok'
            : 'not_verified',
    ),
  );
  result.push(
    observation(
      'deletion_checkpoint',
      database.deletionCheckpointAt !== null &&
        fresh(database.deletionCheckpointAt, checkedAt, options.staleMilliseconds)
        ? 'healthy'
        : 'degraded',
      database.deletionCheckpointAt === null
        ? 'not_verified'
        : fresh(database.deletionCheckpointAt, checkedAt, options.staleMilliseconds)
          ? 'ok'
          : 'stale',
    ),
  );
  const parsedHost = parseHostHealthSnapshot(options.hostSnapshot);
  const host =
    parsedHost !== undefined && fresh(parsedHost.checkedAt, checkedAt, options.staleMilliseconds)
      ? parsedHost
      : undefined;
  for (const component of ['webhook', 'reply', 'outbound', 'notification', 'tunnel'] as const) {
    if (
      (component === 'outbound' && options.outboundEnabled === false) ||
      (component === 'notification' && !options.notificationsEnabled)
    ) {
      result.push(observation(component, 'disabled', 'disabled'));
      continue;
    }
    const service = host?.services.find((value) => value.component === component);
    if (service === undefined) {
      result.push(
        observation(component, 'unknown', parsedHost === undefined ? 'not_verified' : 'stale'),
      );
      continue;
    }
    if (!service.running || service.health === 'unavailable') {
      result.push(observation(component, 'unavailable', 'dependency_unavailable'));
      continue;
    }
    if (service.gitRevision !== options.expectedGitRevision && component !== 'tunnel') {
      result.push(observation(component, 'unavailable', 'configuration_invalid'));
      continue;
    }
    const worker =
      component === 'reply' || component === 'outbound' || component === 'notification';
    const heartbeatFresh =
      service.heartbeat !== undefined &&
      fresh(service.heartbeat.checkedAt, checkedAt, options.staleMilliseconds);
    if (worker && (!heartbeatFresh || service.heartbeat?.state !== 'healthy')) {
      result.push(
        observation(
          component,
          'degraded',
          service.heartbeat === undefined ? 'not_verified' : 'stale',
        ),
      );
      continue;
    }
    const publicCheck = host?.publicRouteCheck;
    if (
      component === 'tunnel' &&
      (publicCheck?.state !== 'passed' ||
        publicCheck.checkedAt === undefined ||
        !fresh(publicCheck.checkedAt, checkedAt, options.staleMilliseconds))
    ) {
      result.push(
        observation(
          component,
          'degraded',
          publicCheck?.state === 'failed' ? 'dependency_unavailable' : 'not_verified',
        ),
      );
      continue;
    }
    const queue = database.queues.find((value) => value.component === component);
    if (queue?.oldestAgeBucket === 'over_day' || (queue?.failed ?? 0) > 0) {
      result.push(observation(component, 'degraded', 'stale'));
      continue;
    }
    result.push(
      observation(component, service.health, service.health === 'healthy' ? 'ok' : 'not_verified'),
    );
  }
  for (const [component, enabled, probe] of [
    ['manifest', options.modelEnabled, options.manifestProbe],
    ['n8n', options.notificationsEnabled, options.n8nProbe],
  ] as const) {
    if (!enabled) {
      result.push(observation(component, 'disabled', 'disabled'));
      continue;
    }
    if (probe === undefined) {
      result.push(observation(component, 'unknown', 'not_verified'));
      continue;
    }
    try {
      const available = await boundedHealthCall(probe, options.timeoutMilliseconds);
      const attested = component !== 'manifest' || host?.manifestAttestation === 'verified';
      result.push(
        observation(
          component,
          available === 'healthy' && attested
            ? 'healthy'
            : available === 'healthy'
              ? 'degraded'
              : 'unavailable',
          available === 'healthy' ? (attested ? 'ok' : 'not_verified') : 'dependency_unavailable',
        ),
      );
    } catch (error) {
      result.push(
        observation(
          component,
          'unavailable',
          error instanceof HealthTimeout ? 'timeout' : 'dependency_unavailable',
        ),
      );
    }
  }
  try {
    const parsedGap = gapSchema.safeParse(await call(options.outage.read));
    if (parsedGap.success && Date.parse(parsedGap.data.startedAt) < checkedAt.getTime()) {
      const startedAt = new Date(
        Math.max(
          Date.parse(parsedGap.data.startedAt),
          checkedAt.getTime() - options.maximumOutageGapMilliseconds,
        ),
      );
      await call(() =>
        options.store.recordHealth({
          ...observation('postgres', 'unavailable', 'dependency_unavailable'),
          checkedAt: startedAt,
          durationMilliseconds: 0,
        }),
      );
    } else if (
      database.lastCollectedAt != null &&
      checkedAt.getTime() - database.lastCollectedAt.getTime() > options.staleMilliseconds
    ) {
      const startedAt = new Date(
        Math.max(
          database.lastCollectedAt.getTime() + options.staleMilliseconds,
          checkedAt.getTime() - options.maximumOutageGapMilliseconds,
        ),
      );
      await call(() =>
        options.store.recordHealth({
          ...observation('postgres', 'degraded', 'collection_failed'),
          checkedAt: startedAt,
          durationMilliseconds: 0,
        }),
      );
    }
    for (const value of result) await call(() => options.store.recordHealth(value));
    await call(options.outage.clear);
  } catch {
    return recordOutage();
  }
  for (const value of result) journal(value);
  return result;
}
