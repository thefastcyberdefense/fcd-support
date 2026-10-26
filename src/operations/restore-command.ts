import { z } from 'zod';
import { restoreTargetIdentitySchema } from '../persistence/postgres-restore-evidence.js';

const revision = z.string().regex(/^[a-f0-9]{40}$/u);
const schemaRevision = z.string().regex(/^[0-9]{6}$/u);
const targetMetadataSchema = restoreTargetIdentitySchema.extend({
  gitRevision: revision,
  schemaRevision,
});

/** Host-controlled canonical metadata is descriptive; it never authorizes promotion. */
export function parseRestoreCommand(args: readonly string[]) {
  try {
    const [job, restoreRef, backupRef, checkpointRef, encoded] = z
      .tuple([
        z.literal('restore'),
        z.string().regex(/^restore_[a-f0-9]{32}$/u),
        z.string().regex(/^backup_[a-f0-9]{32}$/u),
        z.string().regex(/^checkpoint_[a-f0-9]{32}$/u),
        z
          .string()
          .min(4)
          .max(5464)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/u),
      ])
      .parse(args);
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.byteLength > 4096 || bytes.toString('base64') !== encoded) throw new Error('invalid');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const metadata = targetMetadataSchema.parse(JSON.parse(text));
    if (JSON.stringify(metadata) !== text) throw new Error('invalid');
    const { gitRevision, schemaRevision: targetSchemaRevision, ...target } = metadata;
    return {
      job,
      restoreRef,
      backupRef,
      checkpointRef,
      target,
      gitRevision,
      schemaRevision: targetSchemaRevision,
    };
  } catch {
    throw new Error('restore_command_invalid');
  }
}

export type RestoreCommand = ReturnType<typeof parseRestoreCommand>;
