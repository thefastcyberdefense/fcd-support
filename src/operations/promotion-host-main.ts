import { inspectPromotionHostSamples } from './promotion-host.js';

// This process has no Docker, network, mounted files or database capabilities.
// Only fixed host metadata projections and trusted controller options enter it.
try {
  if (process.argv.length !== 2) throw new Error('invalid');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const input of process.stdin) {
    const chunk: unknown = input;
    if (!Buffer.isBuffer(chunk)) throw new Error('invalid');
    size += chunk.length;
    if (size > 524288) throw new Error('invalid');
    chunks.push(chunk);
  }
  const payload: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
  );
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Object.keys(payload).length !== 2 ||
    !('samples' in payload) ||
    !('options' in payload)
  )
    throw new Error('invalid');
  process.stdout.write(
    JSON.stringify(inspectPromotionHostSamples(payload.samples, payload.options)) + '\n',
  );
} catch {
  process.stderr.write('promotion_host_invalid\n');
  process.exitCode = 1;
}
