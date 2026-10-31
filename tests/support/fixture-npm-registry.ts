// A small npm registry for tests, served over https on 127.0.0.1 with a certificate made for the run. It serves packuments and tarballs for the packages a test describes, and
// records every request, so a test can say "nothing was fetched for that package". Nothing here reaches the network beyond this machine's own loopback.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { TAR_BLOCK, encodeHeader, paddingFor } from "../../packages/gateway/src/mcp-runner/tar.js";

export type FixtureFile = string | { content: string; mode: number };

export type ShrinkwrapFor = (registryUrl: string, integrityOf: (name: string, version: string) => string) => object;

export interface FixturePackage {
  name: string;
  version: string;
  files?: Record<string, FixtureFile>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
  /** What the packument says (the registry's abbreviated metadata). */
  hasInstallScript?: boolean;
  /** Written as `npm-shrinkwrap.json` in the tarball. A function gets the registry's address so that it can name tarballs. */
  shrinkwrap?: object | ShrinkwrapFor;
  /** Replaces fields of the package.json inside the tarball (not of the packument). */
  manifest?: Record<string, unknown>;
  /** The name and version the tarball's own package.json carries when they should differ from the packument. */
  tarballIdentity?: { name: string; version: string };
}

export interface FixtureRegistry {
  /** `https://127.0.0.1:<port>/` */
  url: string;
  caFile: string;
  requests: string[];
  integrityOf(name: string, version: string): string;
  close(): Promise<void>;
}

const run = (file: string, args: string[]): Promise<void> => new Promise((resolve, reject) => {
  execFile(file, args, (error) => (error ? reject(new Error(`${file} failed`)) : resolve()));
});

/** A self-signed certificate for 127.0.0.1, made with the openssl on this machine. */
async function makeCertificate(directory: string): Promise<{ key: string; cert: string; certFile: string }> {
  await mkdir(directory, { recursive: true });
  const config = join(directory, "openssl.cnf");
  await writeFile(config, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:TRUE\n");
  const keyFile = join(directory, "key.pem");
  const certFile = join(directory, "cert.pem");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "2", "-config", config]);
  return { key: await readFile(keyFile, "utf8"), cert: await readFile(certFile, "utf8"), certFile };
}

/** A gzip tar of a package, one `package/` folder, plain ustar entries. */
export function packTarball(pkg: FixturePackage, shrinkwrap: object | undefined): Buffer {
  const manifest = {
    name: pkg.tarballIdentity?.name ?? pkg.name, version: pkg.tarballIdentity?.version ?? pkg.version,
    ...(pkg.dependencies === undefined ? {} : { dependencies: pkg.dependencies }), ...(pkg.optionalDependencies === undefined ? {} : { optionalDependencies: pkg.optionalDependencies }),
    ...(pkg.devDependencies === undefined ? {} : { devDependencies: pkg.devDependencies }), ...(pkg.bin === undefined ? {} : { bin: pkg.bin }), ...(pkg.scripts === undefined ? {} : { scripts: pkg.scripts }),
    ...pkg.manifest,
  };
  const files: Record<string, FixtureFile> = { "package.json": JSON.stringify(manifest), ...pkg.files, ...(shrinkwrap === undefined ? {} : { "npm-shrinkwrap.json": JSON.stringify(shrinkwrap) }) };
  const parts: Buffer[] = [];
  for (const path of Object.keys(files).sort()) {
    const spec = files[path]!;
    const { content, mode } = typeof spec === "string" ? { content: spec, mode: 0o644 } : spec;
    const data = Buffer.from(content);
    parts.push(encodeHeader({ name: `package/${path}`, mode, size: data.length, type: "0" }), data, Buffer.alloc(paddingFor(data.length)));
  }
  parts.push(Buffer.alloc(2 * TAR_BLOCK));
  return gzipSync(Buffer.concat(parts));
}

const unscoped = (name: string): string => name.split("/").at(-1)!;

export async function startFixtureRegistry(directory: string, packages: FixturePackage[]): Promise<FixtureRegistry> {
  const { key, cert, certFile } = await makeCertificate(directory);
  const requests: string[] = [];
  const tarballs = new Map<string, Buffer>();
  const integrity = new Map<string, string>();
  const packuments = new Map<string, Record<string, unknown>>();
  const integrityOf = (name: string, version: string): string => {
    const value = integrity.get(`${name}@${version}`);
    if (value === undefined) throw new Error("not built yet");
    return value;
  };
  const server: Server = createServer({ key, cert }, (req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    requests.push(path);
    const tarball = tarballs.get(path);
    if (tarball !== undefined) { res.writeHead(200, { "content-type": "application/octet-stream", "content-length": tarball.length }); res.end(tarball); return; }
    const packument = packuments.get(path.slice(1));
    if (packument !== undefined) { const body = JSON.stringify(packument); res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }); res.end(body); return; }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  // Tarballs of packages that name no shrinkwrap first, so that a shrinkwrap can name their integrity.
  const order = [...packages].sort((a, b) => Number(typeof a.shrinkwrap === "function") - Number(typeof b.shrinkwrap === "function"));
  for (const pkg of order) {
    const shrinkwrap = typeof pkg.shrinkwrap === "function" ? (pkg.shrinkwrap as ShrinkwrapFor)(base, integrityOf) : pkg.shrinkwrap;
    const bytes = packTarball(pkg, shrinkwrap);
    const path = `/${pkg.name}/-/${unscoped(pkg.name)}-${pkg.version}.tgz`;
    tarballs.set(path, bytes);
    const sha512 = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    integrity.set(`${pkg.name}@${pkg.version}`, sha512);
    const existing = (packuments.get(pkg.name) ?? { name: pkg.name, "dist-tags": { latest: pkg.version }, versions: {} }) as { versions: Record<string, unknown> };
    existing.versions[pkg.version] = {
      name: pkg.name, version: pkg.version, ...(pkg.dependencies === undefined ? {} : { dependencies: pkg.dependencies }), ...(pkg.optionalDependencies === undefined ? {} : { optionalDependencies: pkg.optionalDependencies }),
      ...(pkg.bin === undefined ? {} : { bin: pkg.bin }), ...(pkg.hasInstallScript === true ? { hasInstallScript: true } : {}), ...(shrinkwrap === undefined ? {} : { _hasShrinkwrap: true }),
      dist: { tarball: `${base.slice(0, -1)}${path}`, integrity: sha512, shasum: createHash("sha1").update(bytes).digest("hex") },
    };
    packuments.set(pkg.name, existing);
  }
  return {
    url: base, caFile: certFile, requests, integrityOf,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
