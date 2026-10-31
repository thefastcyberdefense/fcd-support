import { inspectPromotionHostSamples, PromotionHostValidationError } from './promotion-host.js';

// This process has no Docker, network, mounted files or database capabilities.
// Only fixed host metadata projections and trusted controller options enter it.
let stage = 'arguments';
try {
  if (process.argv.length !== 2) throw new Error('arguments');
  stage = 'input';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const input of process.stdin) {
    const chunk: unknown = input;
    if (!Buffer.isBuffer(chunk)) throw new Error('input');
    size += chunk.length;
    if (size > 524288) throw new Error('input');
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
    throw new Error('input');
  stage = 'validation';
  process.stdout.write(
    JSON.stringify(inspectPromotionHostSamples(payload.samples, payload.options)) + '\n',
  );
} catch (error) {
  if (process.env.FCD_RUNTIME_HOST_DIAGNOSTICS === 'closed-v1') {
    const code = error instanceof PromotionHostValidationError ? error.diagnosticCode : stage;
    process.stdout.write(`runtime_host_diagnostic=${code}\n`);
  }
  process.stderr.write('promotion_host_invalid\n');
  process.exitCode = 1;
}
