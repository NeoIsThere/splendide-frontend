// Leave room below the API/proxy's 1 MiB limit for order IDs and the envelope.
// Count UTF-8 bytes, rather than JS characters, for non-ASCII task content.
export function syncBatches<T>(items: T[], maxBytes = 256 * 1024): T[][] {
  const encoder = new TextEncoder();
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = 2;
  for (const item of items) {
    const itemBytes = encoder.encode(JSON.stringify(item)).byteLength + 1;
    if (itemBytes + 2 > maxBytes) throw new Error('Task exceeds sync request limit');
    if (bytes + itemBytes > maxBytes) {
      batches.push(batch);
      batch = [];
      bytes = 2;
    }
    batch.push(item);
    bytes += itemBytes;
  }
  if (batch.length > 0 || batches.length === 0) batches.push(batch);
  return batches;
}
