// How a package reaches the store (slice 4, lane W2). The design sends code from the front to the worker over a `docker exec -i` pipe to the front's unix socket (length-prefixed JSON frames, 1 MiB per frame plus streamed code chunks).
// That transport is a later lane. This file is the seam it plugs into: the pipe reader turns the code frames of one package into an `AsyncIterable<Uint8Array>` and calls `PackageReceiver.receive` with what the front announced.
// The store never trusts the announcement: it counts the bytes as they arrive, refuses more than announced, then checks the exact size and SHA-256 and judges the zip before anything is kept.

export type PackageKind = "function" | "layer";

/** What the front says it is about to send. All three are checked against the bytes. */
export interface PackageAnnouncement {
  kind: PackageKind;
  /** Lower-case hex SHA-256 of the whole zip. */
  sha256: string;
  sizeBytes: number;
}

/** What the store kept (the zip passed the judge). `deduped` is true when this run already held the same bytes, in which case the stream was not read. */
export interface StoredPackage {
  kind: PackageKind;
  sha256: string;
  sizeBytes: number;
  entries: number;
  expandedBytes: number;
  deduped: boolean;
}

export type PackageBytes = AsyncIterable<Uint8Array>;

export interface ReceiveOptions {
  signal?: AbortSignal;
  /** The wall-clock limit for the whole stream (a stalled pipe must not hold a slot). */
  timeoutMs?: number;
}

/** One run's door for packages. The pipe transport holds one of these per run and never touches the disk itself. */
export interface PackageReceiver {
  /** True when this run already holds a package with this digest, so the front need not stream it again. */
  has(sha256: string): boolean;
  receive(announcement: PackageAnnouncement, bytes: PackageBytes, options?: ReceiveOptions): Promise<StoredPackage>;
}

/** A buffer as a stream of chunks (tests, and the front's own small packages). */
export async function* chunksOf(buffer: Uint8Array, chunkBytes = 64 * 1024): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < buffer.length; at += chunkBytes) yield buffer.subarray(at, Math.min(buffer.length, at + chunkBytes));
}
