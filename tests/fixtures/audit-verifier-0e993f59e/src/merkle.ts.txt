import { createHash } from "node:crypto";

/**
 * RFC 9162 section 2.1 Merkle trees over SHA-256. Leaf and node hashes are bytes;
 * roots and path elements cross the API as lowercase hex, the form the seals and
 * bundles store them in.
 */
const LEAF_PREFIX = Uint8Array.of(0x00);
const NODE_PREFIX = Uint8Array.of(0x01);
const HASH_HEX = /^[0-9a-f]{64}$/;

/** HASH(0x00 || leafData). */
export function leafHash(leafData: Uint8Array): Uint8Array {
  return createHash("sha256").update(LEAF_PREFIX).update(leafData).digest();
}

/** HASH(0x01 || left || right). */
export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return createHash("sha256").update(NODE_PREFIX).update(left).update(right).digest();
}

/** The largest power of two strictly less than n, for n >= 2. */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** MTH over hashed leaves [start, end). */
function subtreeHash(hashes: readonly Uint8Array[], start: number, end: number): Uint8Array {
  if (end - start === 1) return hashes[start]!;
  const k = splitPoint(end - start);
  return nodeHash(subtreeHash(hashes, start, start + k), subtreeHash(hashes, start + k, end));
}

/** MTH(D[n]) as hex. The empty tree's root is the hash of the empty string (RFC 9162 2.1.1). */
export function merkleRoot(leafData: readonly Uint8Array[]): string {
  if (leafData.length === 0) return createHash("sha256").digest("hex");
  const hashes = leafData.map((data) => leafHash(data));
  return Buffer.from(subtreeHash(hashes, 0, hashes.length)).toString("hex");
}

/** PATH(index, D[n]) as hex (RFC 9162 2.1.3.1), leaf side first. */
export function inclusionPath(leafData: readonly Uint8Array[], index: number): string[] {
  if (!Number.isSafeInteger(index) || index < 0 || index >= leafData.length) {
    throw new RangeError("audit merkle: index outside the tree");
  }
  const hashes = leafData.map((data) => leafHash(data));
  const path: Uint8Array[] = [];
  const collect = (m: number, start: number, end: number): void => {
    if (end - start === 1) return;
    const k = splitPoint(end - start);
    if (m < k) {
      collect(m, start, start + k);
      path.push(subtreeHash(hashes, start + k, end));
    } else {
      collect(m - k, start + k, end);
      path.push(subtreeHash(hashes, start, start + k));
    }
  };
  collect(index, 0, hashes.length);
  return path.map((hash) => Buffer.from(hash).toString("hex"));
}

/** RFC 9162 2.1.3.2: does `path` prove `leafData` is leaf `index` of the size-`size` tree with `root`? */
export function verifyInclusion(input: {
  leafData: Uint8Array;
  index: number;
  size: number;
  path: readonly string[];
  root: string;
}): boolean {
  const { leafData, index, size, path, root } = input;
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size) || index < 0 || size < 1 || index >= size) {
    return false;
  }
  if (!HASH_HEX.test(root) || !path.every((element) => HASH_HEX.test(element))) return false;
  // Plain numbers, not 32-bit bit operations: size may exceed 2^31.
  let fn = index;
  let sn = size - 1;
  let r = leafHash(leafData);
  for (const element of path) {
    if (sn === 0) return false;
    const sibling = Buffer.from(element, "hex");
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(sibling, r);
      while (fn % 2 === 0 && fn !== 0) {
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
      }
    } else {
      r = nodeHash(r, sibling);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && Buffer.from(r).toString("hex") === root;
}
