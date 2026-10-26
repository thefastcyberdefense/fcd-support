import { z } from 'zod';
import { parseRestoreCommand } from './restore-command.js';

export function parsePromotionCommand(args: readonly string[]) {
  try {
    const [, restoreRef, verificationRef, backupRef, checkpointRef, metadata] = z
      .tuple([
        z.literal('promote'),
        z.string(),
        z.string().regex(/^restore_[a-f0-9]{32}$/u),
        z.string(),
        z.string(),
        z.string(),
      ])
      .parse(args);
    if (restoreRef === verificationRef) throw new Error('invalid');
    const restore = parseRestoreCommand([
      'restore',
      restoreRef,
      backupRef,
      checkpointRef,
      metadata,
    ]);
    return { ...restore, job: 'promote' as const, verificationRef };
  } catch {
    throw new Error('promotion_command_invalid');
  }
}

export type PromotionCommand = ReturnType<typeof parsePromotionCommand>;
