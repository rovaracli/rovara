// Operator-only local sources for catalog-repack. No credentials, registry reads or signing here.
// A private snapshot closes the verify/copy gap: skopeo never reads the caller's mutable layout.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { SourceRefSchema } from "./catalog-build.js";

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const Path = z.string().min(1).max(1024).refine((p) => !p.startsWith("/") && !/[\\:\p{Cc}]/u.test(p) && p.split("/").every((part) => part !== ".." && part !== "." && part !== ""), "local OCI path must be relative, without traversal");
const Platforms = z.object({ "linux/arm64": Digest.optional(), "linux/amd64": Digest.optional() }).strict().refine((p) => Object.keys(p).length > 0);
const Identity = z.object({ runId: z.string().regex(/^[1-9][0-9]{0,19}$/u), snapshotCommit: z.string().regex(/^[a-f0-9]{40}$/u), workflow: z.string().regex(/^[a-zA-Z0-9_./-]{1,200}$/u), builder: Digest }).strict();
export const LocalOciSourceSchema = z.object({
  kind: z.literal("local-oci"), layout: Path, sourceReference: SourceRefSchema, indexDigest: Digest,
  platforms: Platforms, provenanceFile: Path, provenance: Identity,
}).strict();
export type LocalOciSource = z.infer<typeof LocalOciSourceSchema>;
const Provenance = Identity.extend({ schemaVersion: z.literal(1), id: z.string(), indexDigest: Digest, platforms: Platforms }).strict();

// Cloud owns this classification; caller-supplied provenance cannot turn a third-party image into a Rovara build.
// The signed, vendored catalog schema has no producer field. Adding an id requires an explicit code review.
export const LOCAL_OCI_ENTRY_KINDS = new Map<string, "rovara-built">([
  ["function-agent@r1", "rovara-built"], ["model-stand-in@r1", "rovara-built"],
]);
const META_MAX = 4 * 1024 * 1024;
const BLOB_MAX = 64 * 1024 * 1024;
const TOTAL_MAX = 512 * 1024 * 1024;
const FILES_MAX = 4096;
const INDEX = "application/vnd.oci.image.index.v1+json";
const INDEX_TYPES = [INDEX, "application/vnd.docker.distribution.manifest.list.v2+json"];
const MANIFEST_TYPES = ["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"];
const Descriptor = z.object({ digest: Digest, size: z.number().int().min(0).max(BLOB_MAX), mediaType: z.string().max(200), urls: z.never().optional(), data: z.never().optional() }).passthrough();
type Descriptor = z.infer<typeof Descriptor>;
const Index = z.object({ schemaVersion: z.literal(2), subject: z.never().optional(), manifests: z.array(Descriptor).min(1).max(256) }).passthrough();
const Manifest = z.object({ schemaVersion: z.literal(2), subject: z.never().optional(), config: Descriptor, layers: z.array(Descriptor).max(1024) }).passthrough();
const hash = (data: Uint8Array): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;
const samePlatforms = (a: LocalOciSource["platforms"], b: LocalOciSource["platforms"]): boolean => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

export interface VerifiedLocalOci { index: Buffer; layoutPath: string; cleanup(): Promise<void> }
export interface LocalOciPort { read(source: LocalOciSource, id: string): Promise<VerifiedLocalOci> }

export function localOciPort(input: { baseDir: string; workDir: string }): LocalOciPort {
  return { async read(source, id) {
    let snapshot: string | undefined;
    try {
      const base = await realpath(input.baseDir);
      // Check every component and retain its inode across open. O_NOFOLLOW protects the final component.
      const checked = async (path: string) => {
        const rel = relative(base, path);
        if (rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith(sep)) throw new Error("local OCI path escape");
        let cursor = base;
        for (const part of rel.split(sep)) {
          cursor = join(cursor, part);
          if ((await lstat(cursor)).isSymbolicLink()) throw new Error("local OCI symlink refused");
        }
        if (await realpath(path) !== path) throw new Error("local OCI path escape");
        return lstat(path);
      };
      const read = async (path: string, cap: number, target?: string): Promise<{ size: number; digest: string; bytes: Buffer }> => {
        const before = await checked(path);
        if (!before.isFile() || before.nlink !== 1) throw new Error("local OCI file must be regular and not hard-linked");
        if (before.size > cap) throw new Error("local OCI size limit exceeded");
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = await file.stat();
          if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("local OCI file changed during read");
          await checked(path);
          const output = target === undefined ? undefined : await open(target, "wx", 0o600);
          const chunks: Buffer[] = [];
          const hasher = createHash("sha256"); let size = 0;
          try {
            for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
              const data = Buffer.from(chunk as Uint8Array); size += data.length;
              if (size > cap) throw new Error("local OCI size limit exceeded");
              hasher.update(data);
              if (output) await output.writeFile(data); else chunks.push(data);
            }
          } finally { await output?.close(); }
          if (size !== opened.size) throw new Error("local OCI file changed during read");
          return { size, digest: `sha256:${hasher.digest("hex")}`, bytes: Buffer.concat(chunks) };
        } finally { await file.close(); }
      };
      const layout = resolve(base, source.layout);
      const provenanceBytes = (await read(resolve(base, source.provenanceFile), META_MAX)).bytes;
      const parsed = Provenance.safeParse(JSON.parse(provenanceBytes.toString("utf8")) as unknown);
      if (!parsed.success) throw new Error("local OCI provenance is invalid");
      const p = parsed.data;
      if (p.id !== id || p.indexDigest !== source.indexDigest || !samePlatforms(p.platforms, source.platforms) || Object.keys(source.provenance).some((key) => p[key as keyof typeof source.provenance] !== source.provenance[key as keyof typeof source.provenance])) throw new Error("local OCI provenance mismatch");
      if (!source.sourceReference.endsWith(`@${source.indexDigest}`)) throw new Error("local OCI index digest differs from source reference");
      // Walk the entire input, including unused files, before copying. No hidden links or devices are accepted.
      const paths: string[] = [];
      const walk = async (path: string): Promise<void> => {
        const info = await checked(path);
        if (info.isDirectory()) {
          if (!["", "blobs", "blobs/sha256"].includes(relative(layout, path).split(sep).join("/"))) throw new Error("local OCI unexpected directory");
          const names = await readdir(path);
          if (names.length > FILES_MAX) throw new Error("local OCI file count limit exceeded");
          for (const name of names) await walk(join(path, name));
        } else {
          if (!info.isFile() || info.nlink !== 1) throw new Error("local OCI file must be regular and not hard-linked");
          paths.push(relative(layout, path));
          if (paths.length > FILES_MAX) throw new Error("local OCI file count limit exceeded");
        }
      };
      await walk(layout);
      const marker = JSON.parse((await read(join(layout, "oci-layout"), META_MAX)).bytes.toString("utf8")) as unknown;
      if (!z.object({ imageLayoutVersion: z.literal("1.0.0") }).strict().safeParse(marker).success) throw new Error("local OCI layout marker invalid");
      const topBytes = (await read(join(layout, "index.json"), META_MAX)).bytes;
      const top = Index.parse(JSON.parse(topBytes.toString("utf8")) as unknown);
      if (top.manifests.length !== 1 || top.manifests[0]?.digest !== source.indexDigest || !INDEX_TYPES.includes(top.manifests[0].mediaType)) throw new Error("local OCI index digest mismatch or not a single index");
      snapshot = await mkdtemp(join(await realpath(input.workDir), "local-oci-"));
      const layoutPath = snapshot;
      await mkdir(join(layoutPath, "blobs", "sha256"), { recursive: true, mode: 0o700 });
      const sizes = new Map<string, number>(); let total = 0;
      for (const path of paths) {
        if (path === "oci-layout" || path === "index.json") continue;
        if (!/^blobs\/sha256\/[a-f0-9]{64}$/u.test(path.split(sep).join("/"))) throw new Error("local OCI unexpected blob path");
        const item = await read(join(layout, path), BLOB_MAX, join(layoutPath, path));
        if (item.digest !== `sha256:${path.split(sep).at(-1) ?? ""}`) throw new Error("local OCI blob digest mismatch");
        total += item.size;
        if (total > TOTAL_MAX) throw new Error("local OCI total size limit exceeded");
        sizes.set(item.digest, item.size);
      }
      // Every reachable descriptor, including dropped attestations, must name a present, hashed blob of the stated size.
      const visit = async (descriptor: Descriptor, depth: number): Promise<Buffer | undefined> => {
        const size = sizes.get(descriptor.digest);
        if (size === undefined) throw new Error("local OCI missing blob");
        if (size !== descriptor.size) throw new Error("local OCI descriptor size mismatch");
        if (!INDEX_TYPES.includes(descriptor.mediaType) && !MANIFEST_TYPES.includes(descriptor.mediaType)) return undefined;
        if (depth > 1 || (depth > 0 && INDEX_TYPES.includes(descriptor.mediaType))) throw new Error("local OCI nested image metadata refused");
        if (size > META_MAX) throw new Error("local OCI metadata size limit exceeded");
        const path = join(layoutPath, "blobs", "sha256", descriptor.digest.slice(7));
        const handle = await open(path, "r"); let data: Buffer;
        try { data = await handle.readFile(); } finally { await handle.close(); }
        if (hash(data) !== descriptor.digest) throw new Error("local OCI blob digest mismatch on read");
        const doc = JSON.parse(data.toString("utf8")) as unknown;
        if (INDEX_TYPES.includes(descriptor.mediaType)) for (const child of Index.parse(doc).manifests) await visit(child, depth + 1);
        else { const manifest = Manifest.safeParse(doc); if (!manifest.success) throw new Error("local OCI manifest descriptor invalid"); await visit(manifest.data.config, depth + 1); for (const layer of manifest.data.layers) await visit(layer, depth + 1); }
        return data;
      };
      const index = await visit(top.manifests[0], 0);
      if (!index || hash(index) !== source.indexDigest) throw new Error("local OCI index digest mismatch");
      const doc = Index.parse(JSON.parse(index.toString("utf8")) as unknown);
      const pinned = new Map<string, string>();
      for (const desc of doc.manifests) {
        const platform = z.object({ os: z.string(), architecture: z.string() }).safeParse(desc["platform"]);
        if (!platform.success || platform.data.os === "unknown" || platform.data.architecture === "unknown" || (desc["annotations"] as Record<string, string> | undefined)?.["vnd.docker.reference.type"] !== undefined) continue;
        const name = `${platform.data.os}/${platform.data.architecture}`;
        if (pinned.has(name)) throw new Error("local OCI duplicate platform");
        pinned.set(name, desc.digest);
      }
      if (pinned.size !== Object.keys(source.platforms).length) throw new Error("local OCI platform pins do not cover the index");
      for (const [name, digest] of Object.entries(source.platforms)) if (pinned.get(name) !== digest) throw new Error("local OCI platform digest mismatch");
      await writeFile(join(layoutPath, "index.json"), topBytes, { mode: 0o600 });
      await writeFile(join(layoutPath, "oci-layout"), JSON.stringify(marker), { mode: 0o600 });
      return { index, layoutPath, cleanup: () => rm(layoutPath, { recursive: true, force: true }) };
    } catch (error) {
      if (snapshot !== undefined) await rm(snapshot, { recursive: true, force: true });
      if (error instanceof Error && error.message.startsWith("local OCI")) throw error;
      throw new Error("local OCI input could not be read or parsed", { cause: error });
    }
  } };
}
