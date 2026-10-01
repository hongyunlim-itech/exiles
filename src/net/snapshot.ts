/**
 * Snapshot packing for late joiners / resyncs (net-core): the save JSON, gzip-compressed with CompressionStream when
 * available (z = 1), base64-encoded and cut into chunks that fit a room event.
 */
import { fromBase64, toBase64 } from '../sim/world/codec';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function pipe(bytes: Uint8Array, stream: GenerateTransform): Promise<Uint8Array> {
  const body = new Blob([bytes as BlobPart]).stream().pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

type GenerateTransform = { readable: ReadableStream; writable: WritableStream };

export function compressionAvailable(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined' &&
    typeof Blob !== 'undefined' && typeof Response !== 'undefined';
}

/** Save JSON → { z, base64 data }. */
export async function packSnapshot(save: string): Promise<{ z: 0 | 1; data: string; rawBytes: number; packedBytes: number }> {
  const raw = encoder.encode(save);
  if (compressionAvailable()) {
    try {
      const gz = await pipe(raw, new CompressionStream('gzip'));
      return { z: 1, data: toBase64(gz), rawBytes: raw.length, packedBytes: gz.length };
    } catch (err) {
      console.warn('[net] gzip failed, sending the snapshot uncompressed', err);
    }
  }
  return { z: 0, data: toBase64(raw), rawBytes: raw.length, packedBytes: raw.length };
}

/** Inverse of {@link packSnapshot}. Throws on corrupt data. */
export async function unpackSnapshot(data: string, z: number): Promise<string> {
  const bytes = fromBase64(data);
  if (z === 1) return decoder.decode(await pipe(bytes, new DecompressionStream('gzip')));
  return decoder.decode(bytes);
}

export function chunkString(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  if (out.length === 0) out.push('');
  return out;
}
