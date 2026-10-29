/** Canonicalize only the unordered, strictly validated mount collection. */
export interface PromotionMountObservation {
  readonly destination: string;
  readonly name: string;
  readonly propagation: string;
  readonly readWrite: boolean;
  readonly source: string;
  readonly type: string;
}
function canonicalMount(m: PromotionMountObservation): string {
  return JSON.stringify({
    destination: m.destination,
    name: m.name,
    propagation: m.propagation,
    readWrite: m.readWrite,
    source: m.source,
    type: m.type,
  });
}
export function canonicalPromotionMounts<T extends PromotionMountObservation>(
  mounts: readonly T[],
): T[] {
  const keys = mounts.map(canonicalMount);
  if (new Set(keys).size !== keys.length) throw new Error('promotion_host_invalid');
  return [...mounts].sort((a, b) => canonicalMount(a).localeCompare(canonicalMount(b)));
}
