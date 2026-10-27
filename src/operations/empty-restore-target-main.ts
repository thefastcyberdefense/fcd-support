import { pathToFileURL } from 'node:url';
import { proveEmptyRestoreTarget } from './empty-restore-target.js';

export async function runEmptyRestoreTargetMain(): Promise<void> {
  try {
    if (
      process.argv.length !== 2 ||
      process.platform !== 'linux' ||
      process.geteuid?.() !== 1000 ||
      process.getegid?.() !== 1000
    )
      throw new Error('invalid');
    process.stdout.write(`${await proveEmptyRestoreTarget('/target')}\n`);
  } catch {
    process.stderr.write('empty_restore_target_invalid\n');
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runEmptyRestoreTargetMain();
