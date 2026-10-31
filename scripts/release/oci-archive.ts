// Enterprise foundations, N2 (review I7): what an image archive says it holds. An OCI archive is a tar whose `index.json` lists the manifests it carries; the
// builder refuses an archive whose index does not name the digest the bundle's manifest promises, before the archive is hashed and signed.
import { open } from "node:fs/promises";

const BLOCK = 512;
/** An archive larger than this is not read past: index.json sits first in the archives skopeo writes, and a header chain this long is not an archive we made. */
const MAX_ENTRIES = 200_000;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;

function octal(field: Buffer): number {
  const text = field.toString("ascii").replace(/\0.*$/s, "").trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

/** The manifest digests listed in the archive's top-level index.json (`sha256:<hex>`). Throws when there is no readable index. */
export async function ociArchiveDigests(path: string): Promise<string[]> {
  const handle = await open(path, "r");
  try {
    let position = 0;
    const header = Buffer.alloc(BLOCK);
    for (let entry = 0; entry < MAX_ENTRIES; entry += 1) {
      const { bytesRead } = await handle.read(header, 0, BLOCK, position);
      if (bytesRead < BLOCK || header.every((byte) => byte === 0)) break;
      const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
      const size = octal(header.subarray(124, 136));
      const type = String.fromCharCode(header[156] ?? 0);
      position += BLOCK;
      if ((type === "0" || type === "\0") && (name === "index.json" || name === "./index.json")) {
        if (size > MAX_INDEX_BYTES) throw new Error("the archive's index.json is too large");
        const body = Buffer.alloc(size);
        await handle.read(body, 0, size, position);
        const index = JSON.parse(body.toString("utf8")) as { manifests?: Array<{ digest?: unknown }> };
        return (index.manifests ?? []).flatMap((manifest) => (typeof manifest.digest === "string" ? [manifest.digest] : []));
      }
      position += Math.ceil(size / BLOCK) * BLOCK;
    }
  } finally {
    await handle.close();
  }
  throw new Error("the archive has no index.json");
}
