import { z } from 'zod';
import { open, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseBackupManifest,
  readBackupManifest,
  requireBackupDirectory,
  type BackupManifest,
} from './backup.js';

export function selectBackupPruneCandidates(
  manifests: readonly BackupManifest[],
  policy: { daily: number; monthly: number },
  evaluatedAt: Date,
): readonly string[] {
  try {
    z.strictObject({
      daily: z.number().int().min(45).max(3650),
      monthly: z.number().int().min(6).max(120),
    }).parse(policy);
    z.date().parse(evaluatedAt);
    const entries = manifests.map(parseBackupManifest);
    if (
      new Set(entries.map((entry) => entry.backupRef)).size !== entries.length ||
      entries.some((entry) => new Date(entry.createdAt) > evaluatedAt)
    )
      throw new Error('invalid');
    const active = entries
      .filter((entry) => entry.state !== 'pruned')
      .sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || a.backupRef.localeCompare(b.backupRef),
      );
    const restored = active.find((entry) => entry.state === 'restore_verified')?.backupRef;
    const candidates: string[] = [];
    for (const backupClass of ['daily', 'monthly'] as const) {
      const group = active.filter((entry) => entry.class === backupClass);
      const latest = group[0];
      if (latest === undefined || !['verified', 'restore_verified'].includes(latest.state))
        return [];
      const slots = new Set<string>();
      const keep = new Set<string>();
      for (const entry of group) {
        if (!['verified', 'restore_verified'].includes(entry.state)) continue;
        const slot = entry.createdAt.slice(0, backupClass === 'daily' ? 10 : 7);
        if (slots.size < policy[backupClass] && !slots.has(slot)) {
          slots.add(slot);
          keep.add(entry.backupRef);
        }
      }
      if (slots.size < policy[backupClass]) return [];
      for (const entry of group) {
        if (
          ['verified', 'restore_verified'].includes(entry.state) &&
          !keep.has(entry.backupRef) &&
          entry.backupRef !== restored
        )
          candidates.push(entry.backupRef);
      }
    }
    return Object.freeze(candidates);
  } catch {
    throw new Error('backup_retention_invalid');
  }
}

export async function pruneEncryptedBackups(options: {
  archiveDirectory: string;
  manifestHmacFile: string;
  manifests: readonly BackupManifest[];
  policy: { daily: number; monthly: number };
  evaluatedAt: Date;
}): Promise<readonly string[]> {
  try {
    const candidates = selectBackupPruneCandidates(
      options.manifests,
      options.policy,
      options.evaluatedAt,
    );
    // Verify all surviving evidence, not only deletion targets. A missing/corrupt
    // replacement must never authorize deleting the older good copy.
    for (const entry of options.manifests.filter((entry) => entry.state !== 'pruned')) {
      const actual = await readBackupManifest(
        options.archiveDirectory,
        entry.backupRef,
        options.manifestHmacFile,
      );
      if (
        JSON.stringify(parseBackupManifest({ ...entry, state: 'created' })) !==
        JSON.stringify(actual)
      )
        throw new Error('invalid');
    }
    for (const ref of candidates) {
      const directory = join(options.archiveDirectory, ref);
      await requireBackupDirectory(directory);
      await unlink(join(directory, 'manifest.json'));
      await unlink(join(directory, 'archive.age'));
      await rmdir(directory);
    }
    if (candidates.length > 0 && process.platform !== 'win32') {
      const handle = await open(options.archiveDirectory, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    return candidates;
  } catch {
    throw new Error('backup_prune_invalid');
  }
}
