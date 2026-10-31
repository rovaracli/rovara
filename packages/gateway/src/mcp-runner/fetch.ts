// Stdio MCP host redesign (T4), design sections 3 and 4: the fetch step. It runs first, in its own container of a runner task (uid 10002, never root), and is the only thing that
// puts files where the server will read them:
//
//   1. Download the bundle from the controller (`GET /bundles/{hash}`, the task's bearer token) into the bundle volume, with a size limit and no redirects.
//   2. Check the sha256 of the bytes against the hash the approval names. A mismatch deletes the download and stops here: nothing is parsed, unpacked or started.
//   3. Read the archive's index (bundle.ts accepts only exactly what the writer writes, with safe paths) and unpack it under `tree/`, folders 0755 and files 0644 or 0755.
//   4. Write `verified.json` last. The server container (a different uid, the volume mounted read-only) starts only if that file names the approved hash.
// On any failure everything this step made is removed, and it exits non-zero, so the task's server container (which depends on this one succeeding) never starts.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUNDLE_LIMITS, BundleError, assertBundleHash, extractBundle, readBundleIndex, type BundleLimits } from "./bundle.js";

export type FetchFailure = "root" | "bad_request" | "unavailable" | "refused" | "too_large" | "hash_mismatch" | "bad_archive" | "destination";

/** The fetch step failed. The message is a fixed code, never text from the controller or the archive. */
export class FetchError extends Error {
  constructor(readonly code: FetchFailure) {
    super(code);
    this.name = "FetchError";
  }
}

export interface FetchOptions {
  /** The controller's address: https, or http on this machine's loopback. */
  controllerUrl: string;
  /** The task's bearer token. It is sent only to the controller. */
  token: string;
  /** The sha256 the approval names. */
  bundleHash: string;
  /** The (empty) bundle volume. */
  destination: string;
  limits?: Partial<BundleLimits> & { downloadMs?: number };
  /** A certificate authority for a controller with a private one. */
  ca?: string | undefined;
  getuid?: () => number | undefined;
}

function secureUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new FetchError("bad_request"); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username !== "" || url.password !== "") throw new FetchError("bad_request");
  return url;
}

/** Downloads `url` to the new file `destination`. Only a plain 200 is accepted; a redirect is not followed; more than `maxBytes` stops it. */
async function download(url: URL, token: string, destination: string, maxBytes: number, timeoutMs: number, ca: string | undefined): Promise<void> {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  await new Promise<void>((resolve, reject) => {
    const req = send(url, { method: "GET", timeout: timeoutMs, headers: { authorization: `Bearer ${token}`, accept: "application/x-tar" }, ...(ca === undefined ? {} : { ca }) }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(new FetchError("refused")); return; }
      const declared = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(declared) && declared > maxBytes) { reject(new FetchError("too_large")); response.destroy(); return; }
      let received = 0;
      const out = createWriteStream(destination, { flags: "wx", mode: 0o600 });
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxBytes) { reject(new FetchError("too_large")); response.destroy(); out.destroy(); }
      });
      response.on("error", () => { out.destroy(); reject(new FetchError("unavailable")); });
      response.on("aborted", () => { out.destroy(); reject(new FetchError("unavailable")); });
      out.on("error", () => reject(new FetchError("destination")));
      out.on("finish", () => resolve());
      response.pipe(out);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => reject(new FetchError("unavailable")));
    req.end();
  });
}

/** Fetches, verifies and unpacks the approved bundle into `destination/tree`, and writes `destination/verified.json` last. */
export async function fetchBundle(options: FetchOptions): Promise<void> {
  if ((options.getuid ?? (() => process.getuid?.()))() === 0) throw new FetchError("root");
  if (!/^[0-9a-f]{64}$/u.test(options.bundleHash) || options.token.length < 24) throw new FetchError("bad_request");
  const base = secureUrl(options.controllerUrl);
  const limits: BundleLimits = { maxEntries: options.limits?.maxEntries ?? BUNDLE_LIMITS.maxEntries, maxUnpackedBytes: options.limits?.maxUnpackedBytes ?? BUNDLE_LIMITS.maxUnpackedBytes };
  // The tar is the content plus one header block and padding per entry, and the end blocks.
  const maxTarBytes = limits.maxUnpackedBytes + limits.maxEntries * 4 * 512 + 1_024;
  const target = new URL(`${base.href.replace(/\/$/u, "")}/bundles/${options.bundleHash}`);
  const folder = options.destination;
  try {
    if (!(await stat(folder)).isDirectory() || (await readdir(folder)).length > 0) throw new FetchError("destination");
  } catch (error) {
    throw error instanceof FetchError ? error : new FetchError("destination");
  }
  const archive = join(folder, "download.tar");
  const tree = join(folder, "tree");
  const marker = join(folder, "verified.json");
  try {
    await download(target, options.token, archive, maxTarBytes, options.limits?.downloadMs ?? 300_000, options.ca);
    // Nothing is read from the archive until its hash is the approved one.
    await assertBundleHash(archive, options.bundleHash);
    const entries = await readBundleIndex(archive, limits);
    await mkdir(tree, { mode: 0o755 });
    await extractBundle(archive, tree, entries);
    await writeFile(`${marker}.partial`, JSON.stringify({ bundleHash: options.bundleHash }), { mode: 0o644, flag: "wx" });
    await rename(`${marker}.partial`, marker);
    await rm(archive, { force: true });
  } catch (error) {
    await Promise.all([archive, tree, marker, `${marker}.partial`].map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined)));
    if (error instanceof FetchError) throw error;
    if (error instanceof BundleError) throw new FetchError(error.code === "hash_mismatch" ? "hash_mismatch" : error.code === "too_large" || error.code === "too_many_files" ? "too_large" : "bad_archive");
    throw new FetchError("destination");
  }
}
