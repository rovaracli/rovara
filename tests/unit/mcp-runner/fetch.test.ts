// Stdio MCP host redesign, task T4: the fetch step. The bundle is downloaded from a local controller, its sha256 is checked BEFORE anything is read from it, and only then is it
// unpacked; any failure leaves nothing behind.
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeBundle } from "../../../packages/gateway/src/mcp-runner/bundle.js";
import { FetchError, fetchBundle } from "../../../packages/gateway/src/mcp-runner/fetch.js";
import { TAR_BLOCK, encodeHeader, paddingFor } from "../../../packages/gateway/src/mcp-runner/tar.js";

const TOKEN = "t".repeat(40);
let work: string;
let bundleBytes: Buffer;
let bundleHash: string;
let served: { status: number; body: Buffer; headers: Record<string, string>; requests: Array<{ url?: string | undefined; auth?: string | undefined }> };
const controller = createServer((req, res) => {
  served.requests.push({ url: req.url, auth: req.headers.authorization });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); res.end(); return; }
  res.writeHead(served.status, { "content-length": served.body.length, ...served.headers });
  res.end(served.body);
});
let url = "";
beforeAll(async () => { await new Promise<void>((resolve) => controller.listen(0, "127.0.0.1", resolve)); url = `http://127.0.0.1:${(controller.address() as AddressInfo).port}/`; });
afterAll(() => { controller.close(); controller.closeAllConnections(); });
beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "fetch-test-"));
  const tree = join(work, "src");
  await mkdir(join(tree, "bin"), { recursive: true });
  await mkdir(join(tree, "node_modules", "dep", "bin"), { recursive: true });
  await writeFile(join(tree, "package.json"), '{"name":"x"}');
  await writeFile(join(tree, "bin", "run.js"), "#!/usr/bin/env node\n");
  await chmod(join(tree, "bin", "run.js"), 0o755);
  await writeFile(join(tree, "node_modules", "dep", "index.js"), "module.exports = 1\n");
  await symlink("../dep/index.js", join(tree, "node_modules", "dep", "bin", "link"));
  const file = join(work, "bundle.tar");
  const info = await writeBundle(tree, file);
  bundleBytes = await readFile(file);
  bundleHash = info.bundleHash;
  served = { status: 200, body: bundleBytes, headers: {}, requests: [] };
});
afterEach(async () => { await rm(work, { recursive: true, force: true }); });

async function destination(): Promise<string> {
  const dir = join(work, "volume");
  await mkdir(dir, { recursive: true });
  return dir;
}
const options = async (over: Partial<Parameters<typeof fetchBundle>[0]> = {}) => ({ controllerUrl: url, token: TOKEN, bundleHash, destination: await destination(), getuid: () => 10_002, ...over });
const failure = async (promise: Promise<unknown>): Promise<string> => promise.then(() => "no error", (error: unknown) => (error instanceof FetchError ? error.code : `other:${String(error)}`));

describe("T4 fetch: the approved bundle", () => {
  it("downloads it with the task's token, unpacks it under tree/, and writes verified.json last", async () => {
    const opts = await options();
    await fetchBundle(opts);
    expect(served.requests).toEqual([{ url: `/bundles/${bundleHash}`, auth: `Bearer ${TOKEN}` }]);
    expect((await readdir(opts.destination)).sort()).toEqual(["tree", "verified.json"]);
    expect(JSON.parse(await readFile(join(opts.destination, "verified.json"), "utf8"))).toEqual({ bundleHash });
    expect(await readFile(join(opts.destination, "tree", "node_modules", "dep", "index.js"), "utf8")).toBe("module.exports = 1\n");
    expect(await readlink(join(opts.destination, "tree", "node_modules", "dep", "bin", "link"))).toBe("../dep/index.js");
  });
  it("makes folders 0755 and files 0644 or 0755, readable by another user, and the download is gone", async () => {
    const opts = await options();
    await fetchBundle(opts);
    const mode = async (path: string) => (await stat(join(opts.destination, ...path.split("/")))).mode & 0o7777;
    expect(await mode("tree")).toBe(0o755);
    expect(await mode("tree/bin")).toBe(0o755);
    expect(await mode("tree/bin/run.js")).toBe(0o755);
    expect(await mode("tree/package.json")).toBe(0o644);
    expect(await mode("verified.json")).toBe(0o644);
    await expect(lstat(join(opts.destination, "download.tar"))).rejects.toThrow();
  });
});

describe("T4 fetch: bytes that are not the approved ones", () => {
  it("refuses a bundle whose hash is not the approved one, reads nothing from it, and leaves the volume empty", async () => {
    const tampered = Buffer.from(bundleBytes);
    tampered[tampered.length - 2000] = tampered[tampered.length - 2000]! ^ 1;
    served.body = tampered;
    const opts = await options();
    expect(await failure(fetchBundle(opts))).toBe("hash_mismatch");
    expect(await readdir(opts.destination)).toEqual([]);
  });
  it("refuses a different bundle served under the approved hash (a registry or controller that swaps bytes)", async () => {
    const other = await mkdtemp(join(work, "other-"));
    await writeFile(join(other, "evil.js"), "evil");
    const file = join(work, "other.tar");
    await writeBundle(other, file);
    served.body = await readFile(file);
    const opts = await options();
    expect(await failure(fetchBundle(opts))).toBe("hash_mismatch");
    expect(await readdir(opts.destination)).toEqual([]);
  });
  it("refuses an archive that is hostile even though its hash is the approved one (the hash only says it is the approved bytes)", async () => {
    // A path that climbs out, with the right hash for these bytes: the approval cannot make an unsafe archive safe.
    const evil = Buffer.concat([encodeHeader({ name: "../escaped.txt", mode: 0o644, size: 1, type: "0" }), Buffer.from("x"), Buffer.alloc(paddingFor(1)), Buffer.alloc(2 * TAR_BLOCK)]);
    served.body = evil;
    const opts = await options({ bundleHash: createHash("sha256").update(evil).digest("hex") });
    expect(await failure(fetchBundle(opts))).toBe("bad_archive");
    expect(await readdir(opts.destination)).toEqual([]);
    await expect(lstat(join(work, "escaped.txt"))).rejects.toThrow();
  });
  it("refuses an archive with a setuid file or a link that leaves the tree, with the matching hash", async () => {
    for (const evil of [
      Buffer.concat([encodeHeader({ name: "su", mode: 0o4755, size: 1, type: "0" }), Buffer.from("x"), Buffer.alloc(paddingFor(1)), Buffer.alloc(2 * TAR_BLOCK)]),
      Buffer.concat([encodeHeader({ name: "l", mode: 0o777, size: 0, type: "2", linkname: "/etc/passwd" }), Buffer.alloc(2 * TAR_BLOCK)]),
    ]) {
      served.body = evil;
      const opts = await options({ bundleHash: createHash("sha256").update(evil).digest("hex"), destination: join(await destination(), "..", `v-${Math.random().toString(36).slice(2)}`) });
      await mkdir(opts.destination);
      expect(await failure(fetchBundle(opts))).toBe("bad_archive");
      expect(await readdir(opts.destination)).toEqual([]);
    }
  });
  it("stops downloading at the size limit (a declared length, and a body that runs past it)", async () => {
    const opts = await options({ limits: { maxEntries: 2, maxUnpackedBytes: 1_000 } });
    expect(await failure(fetchBundle(opts))).toBe("too_large");
    expect(await readdir(opts.destination)).toEqual([]);
    // no declared length: chunked
    served.headers = { "transfer-encoding": "chunked" };
    const chunked = createServer((_req, res) => { res.writeHead(200); res.write(Buffer.alloc(10_000, 1)); res.end(Buffer.alloc(10_000, 1)); });
    await new Promise<void>((resolve) => chunked.listen(0, "127.0.0.1", resolve));
    try {
      const again = await options({ controllerUrl: `http://127.0.0.1:${(chunked.address() as AddressInfo).port}/`, limits: { maxEntries: 2, maxUnpackedBytes: 1_000 }, destination: join(work, "volume2") });
      await mkdir(again.destination);
      expect(await failure(fetchBundle(again))).toBe("too_large");
      expect(await readdir(again.destination)).toEqual([]);
    } finally { chunked.close(); chunked.closeAllConnections(); }
  });
});

describe("T4 fetch: the controller", () => {
  it("refuses a wrong token, an error status, a redirect and an unreachable controller, with nothing left behind", async () => {
    for (const [over, expected] of [[{ token: "w".repeat(40) }, "refused"], [{ controllerUrl: "http://127.0.0.1:1/" }, "unavailable"]] as const) {
      const opts = await options(over);
      expect(await failure(fetchBundle(opts)), JSON.stringify(over)).toBe(expected);
      expect(await readdir(opts.destination)).toEqual([]);
    }
    for (const status of [404, 500, 301, 302, 204]) {
      served.status = status;
      served.headers = status === 301 || status === 302 ? { location: "http://127.0.0.1:1/elsewhere" } : {};
      const opts = await options({ destination: join(work, `volume-${status}`) });
      await mkdir(opts.destination);
      expect(await failure(fetchBundle(opts)), String(status)).toBe("refused");
      expect(await readdir(opts.destination)).toEqual([]);
    }
  });
  it("sends the token only over https, or to this machine's loopback, and takes no address with a login", async () => {
    for (const controllerUrl of ["http://controller.internal:8080/", "ftp://127.0.0.1/", "not a url", "https://user:pw@controller.internal/", "http://user:pw@127.0.0.1:1/"]) {
      expect(await failure(fetchBundle(await options({ controllerUrl }))), controllerUrl).toBe("bad_request");
    }
    expect(served.requests).toEqual([]);
  });
});

describe("T4 fetch: refusing wrongly", () => {
  it("refuses to run as uid 0, and before it sends the token anywhere", async () => {
    expect(await failure(fetchBundle(await options({ getuid: () => 0 })))).toBe("root");
    expect(served.requests).toEqual([]);
  });
  it("refuses a bundle hash that is not a sha256 and a token that is too short", async () => {
    for (const over of [{ bundleHash: "A".repeat(64) }, { bundleHash: "a".repeat(63) }, { bundleHash: "../etc" }, { token: "short" }]) {
      expect(await failure(fetchBundle(await options(over))), JSON.stringify(over)).toBe("bad_request");
    }
    expect(served.requests).toEqual([]);
  });
  it("refuses a volume that is not empty or not there, and never overwrites", async () => {
    const full = await options();
    await writeFile(join(full.destination, "leftover"), "x");
    expect(await failure(fetchBundle(full))).toBe("destination");
    expect(await readFile(join(full.destination, "leftover"), "utf8")).toBe("x");
    expect(await failure(fetchBundle(await options({ destination: join(work, "nowhere") })))).toBe("destination");
    expect(served.requests).toEqual([]);
  });
});
