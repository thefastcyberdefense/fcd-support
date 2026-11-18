import type { ReadableStream } from 'node:stream/web';

export async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
  onOversized?: () => void,
): Promise<Uint8Array | undefined> {
  const headerLength = response.headers.get('content-length');
  if (headerLength !== null) {
    const declaredLength = Number(headerLength);
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      onOversized?.();
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
  }
  if (response.body === null) {
    return new Uint8Array(0);
  }
  const stream = response.body as unknown as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > maximumBytes) {
        onOversized?.();
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
  onOversized?: () => void,
): Promise<string | undefined> {
  const bytes = await readBoundedResponseBytes(response, maximumBytes, onOversized);
  if (bytes === undefined) return undefined;
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
