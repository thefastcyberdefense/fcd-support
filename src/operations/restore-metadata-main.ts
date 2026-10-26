import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { restoreTargetIdentitySchema } from '../persistence/postgres-restore-evidence.js';
import { parseRestoreCommand } from './restore-command.js';
import { restoreHostIdentitySchema } from './restore-host.js';

const parseEncoded = (encoded: string) =>
  parseRestoreCommand([
    'restore',
    `restore_${'0'.repeat(32)}`,
    `backup_${'0'.repeat(32)}`,
    `checkpoint_${'0'.repeat(32)}`,
    encoded,
  ]);

/** Descriptive, strict metadata only. No state, network or database capability. */
export function transformRestoreMetadata(args: readonly string[], input?: unknown): string {
  try {
    if (args[0] === 'encode') {
      const [, systemIdentifier, databaseName, schema, gitRevision, schemaRevision] = z
        .tuple([
          z.literal('encode'),
          z.string(),
          z.string(),
          z.string(),
          z.string().regex(/^[a-f0-9]{40}$/u),
          z.string().regex(/^[0-9]{6}$/u),
        ])
        .parse(args);
      const host = restoreHostIdentitySchema.parse(input);
      const target = restoreTargetIdentitySchema.parse({
        ...host,
        systemIdentifier,
        databaseName,
        schema,
      });
      const encoded = Buffer.from(
        JSON.stringify({ ...target, gitRevision, schemaRevision }),
      ).toString('base64');
      parseEncoded(encoded);
      return encoded;
    }
    const [mode, encoded] = z
      .tuple([z.enum(['decode-fields', 'decode-host']), z.string()])
      .parse(args);
    const command = parseEncoded(encoded);
    if (mode === 'decode-host') {
      const {
        projectName,
        volumeName,
        volumeCreatedAt,
        networkId,
        postgresImageId,
        runtimeImageId,
      } = command.target;
      return JSON.stringify(
        restoreHostIdentitySchema.parse({
          projectName,
          volumeName,
          volumeCreatedAt,
          networkId,
          postgresImageId,
          runtimeImageId,
        }),
      );
    }
    return [
      ['TARGET_PROJECT', command.target.projectName],
      ['TARGET_VOLUME', command.target.volumeName],
      ['TARGET_SYSTEM_IDENTIFIER', command.target.systemIdentifier],
      ['TARGET_DATABASE_NAME', command.target.databaseName],
      ['TARGET_SCHEMA', command.target.schema],
      ['TARGET_APP_IMAGE', command.target.runtimeImageId],
      ['TARGET_PG_IMAGE', command.target.postgresImageId],
      ['TARGET_REVISION', command.gitRevision],
      ['TARGET_SCHEMA_REVISION', command.schemaRevision],
    ]
      .map((field) => field.join('='))
      .join('\n');
  } catch {
    throw new Error('restore_metadata_invalid');
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    let input: unknown;
    if (args[0] === 'encode') {
      if (args.length !== 6) throw new Error('invalid');
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of process.stdin) {
        const value: unknown = chunk;
        if (!Buffer.isBuffer(value)) throw new Error('invalid');
        length += value.byteLength;
        if (length > 4096) throw new Error('invalid');
        chunks.push(value);
      }
      input = JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)),
      ) as unknown;
    }
    process.stdout.write(transformRestoreMetadata(args, input) + '\n');
  } catch {
    process.stderr.write('restore_metadata_invalid\n');
    process.exitCode = 1;
  }
}
