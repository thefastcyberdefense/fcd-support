import { pathToFileURL } from 'node:url';

import {
  assertExternalNetworkParticipants,
  assertOperationsCompose,
  assertRestoreCompose,
  assertRuntimeCompose,
} from './compose-contract.js';

export async function runComposeContract(): Promise<void> {
  try {
    let length = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      length += bytes.length;
      if (length > 1048576) throw new Error('invalid');
      chunks.push(bytes);
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const [mode, revision, volume] = process.argv.slice(2);
    switch (mode) {
      case 'runtime':
      case 'model':
        if (revision === undefined || volume !== undefined) throw new Error('invalid');
        assertRuntimeCompose(input, revision, mode === 'model');
        break;
      case 'operations':
        if (revision === undefined || volume !== undefined) throw new Error('invalid');
        assertOperationsCompose(input, revision);
        break;
      case 'restore':
        if (revision === undefined || volume === undefined || process.argv.length !== 5)
          throw new Error('invalid');
        assertRestoreCompose(input, revision, volume);
        break;
      case 'network':
        if (revision === undefined || volume !== undefined) throw new Error('invalid');
        assertExternalNetworkParticipants(input, revision.split(','));
        break;
      default:
        throw new Error('invalid');
    }
    process.stdout.write('compose_contract=true\n');
  } catch {
    process.stderr.write('compose_contract_invalid\n');
    process.exitCode = 1;
  }
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runComposeContract();
