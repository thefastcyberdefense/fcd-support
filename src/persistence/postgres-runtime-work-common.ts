import type pg from 'pg';
import { z } from 'zod';

export const workReference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
export const workDate = z.date().refine((value) => Number.isFinite(value.getTime()));
export const workClaimSchema = z.strictObject({
  workerRef: workReference,
  evaluatedAt: workDate,
  limit: z.number().int().min(1).max(1000),
  leaseMilliseconds: z.number().int().min(1000).max(600000),
});
export function parseWork<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new TypeError('runtime_work_invalid');
  return parsed.data;
}
export function workConflict(): never {
  throw new Error('runtime_work_conflict');
}
export async function quarantinePresent(client: pg.PoolClient): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `select to_regclass('runtime_restore_quarantine') is not null as present`,
  );
  return result.rows[0]?.present === true;
}
