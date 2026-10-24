import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { inspectRuntimeHostSamples } from './runtime-host.js';

export async function runRuntimeHostMain(): Promise<void> {
  try {
    const [revision, adminSocketRoot, configRoot, secretRoot, workspaceRoot, ingressPeerId] = z
      .tuple([z.string(), z.string(), z.string(), z.string(), z.string(), z.string()])
      .parse(process.argv.slice(2));
    const chunks: Buffer[] = [];
    let count = 0;
    for await (const value of process.stdin) {
      const chunk: unknown = value;
      if (!Buffer.isBuffer(chunk)) throw new Error('invalid');
      count += chunk.length;
      if (count > 1048576) throw new Error('invalid');
      chunks.push(chunk);
    }
    const input = z
      .strictObject({ compose: z.unknown(), samples: z.unknown() })
      .parse(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
        ) as unknown,
      );
    const result = inspectRuntimeHostSamples(input.samples, input.compose, {
      revision,
      paths: { adminSocketRoot, configRoot, secretRoot, workspaceRoot },
      ingressPeerId,
    });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    process.stderr.write('runtime_host_invalid\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runRuntimeHostMain();
