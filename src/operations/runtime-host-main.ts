import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  inspectRuntimeHostSamples,
  inspectBootstrapDatabaseSamples,
  runtimeVolumeIdentitySchema,
  RuntimeHostValidationError,
} from './runtime-host.js';

export function parseRuntimeHostCliArguments(rawArgs: readonly string[]) {
  const bootstrap = rawArgs[0] === 'bootstrap';
  const mode = bootstrap
    ? ('private-disabled' as const)
    : (rawArgs.length === 8 || rawArgs.length === 9) && rawArgs[6] === '--mode'
      ? z.enum(['private-disabled', 'private-enabled']).parse(rawArgs[7])
      : rawArgs.length === 6
        ? ('private-disabled' as const)
        : (() => {
            throw new Error('invalid');
          })();
  const mediaEnabled =
    !bootstrap && mode === 'private-enabled' && rawArgs.length === 9
      ? rawArgs[8] === '--media'
        ? true
        : (() => {
            throw new Error('invalid');
          })()
      : rawArgs.length === 9
        ? (() => {
            throw new Error('invalid');
          })()
        : false;
  const args = z
    .tuple([z.string(), z.string(), z.string(), z.string(), z.string(), z.string()])
    .parse(rawArgs.slice(0, 6));
  const [revision, adminSocketRoot, configRoot, secretRoot, workspaceRoot] = z
    .tuple([z.string(), z.string(), z.string(), z.string(), z.string()])
    .parse(bootstrap ? args.slice(1) : args.slice(0, 5));
  return Object.freeze({
    bootstrap,
    mode,
    mediaEnabled,
    revision,
    adminSocketRoot,
    configRoot,
    secretRoot,
    workspaceRoot,
    ingressPeerId: args[5],
  });
}

export async function runRuntimeHostMain(): Promise<void> {
  let stage = 'arguments';
  try {
    const {
      bootstrap,
      mode,
      mediaEnabled,
      revision,
      adminSocketRoot,
      configRoot,
      secretRoot,
      workspaceRoot,
      ingressPeerId,
    } = parseRuntimeHostCliArguments(process.argv.slice(2));
    stage = 'input';
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
      .strictObject({
        compose: z.unknown(),
        samples: z.unknown(),
        volumeIdentity: runtimeVolumeIdentitySchema.optional(),
      })
      .parse(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
        ) as unknown,
      );
    const options = {
      revision,
      paths: { adminSocketRoot, configRoot, secretRoot, workspaceRoot },
      ...(input.volumeIdentity === undefined ? {} : { volumeIdentity: input.volumeIdentity }),
    };
    stage = 'validation';
    const result = bootstrap
      ? inspectBootstrapDatabaseSamples(input.samples, input.compose, options)
      : inspectRuntimeHostSamples(input.samples, input.compose, {
          ...options,
          ingressPeerId,
          mode,
          mediaEnabled,
        });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    // Opt-in evidence uses stdout because the host Docker adapter suppresses
    // stderr. A nonzero exit remains mandatory; this can never signal readiness.
    if (process.env.FCD_RUNTIME_HOST_DIAGNOSTICS === 'closed-v1') {
      const code = error instanceof RuntimeHostValidationError ? error.diagnosticCode : stage;
      process.stdout.write(`runtime_host_diagnostic=${code}\n`);
    }
    process.stderr.write('runtime_host_invalid\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runRuntimeHostMain();
