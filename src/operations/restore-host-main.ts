import { inspectRestoreHostSamples, restoreHostIdentitySchema } from './restore-host.js';

// Host-collected metadata only. No mounted secrets, Docker socket, database
// connection, application environment or network capability is needed here.
try {
  const [projectName, volumeName, liveVolumeName, gitRevision, prior, ...extra] =
    process.argv.slice(2);
  if (
    [projectName, volumeName, liveVolumeName, gitRevision].some((value) => value === undefined) ||
    extra.length !== 0
  )
    throw new Error('invalid');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const input of process.stdin) {
    const chunk: unknown = input;
    if (!Buffer.isBuffer(chunk)) throw new Error('invalid');
    bytes += chunk.length;
    if (bytes > 65536) throw new Error('invalid');
    chunks.push(chunk);
  }
  const snapshot: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
  );
  const result = inspectRestoreHostSamples(snapshot, {
    projectName: projectName ?? '',
    volumeName: volumeName ?? '',
    liveVolumeName: liveVolumeName ?? '',
    gitRevision: gitRevision ?? '',
    ...(prior === undefined
      ? {}
      : { expectedHost: restoreHostIdentitySchema.parse(JSON.parse(prior) as unknown) }),
  });
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  process.stderr.write('restore_host_invalid\n');
  process.exitCode = 1;
}
