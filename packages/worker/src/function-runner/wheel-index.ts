// Slice 4 X2: where the aarch64 wheels come from. The interface the swap planner uses, a fake for tests, and a client for a PEP 691 JSON index (pypi.org).
//
// What exists in the codebase: there is no package mirror for workers. A hosted install's agent machines resolve a fixed list of names through the install's DNS firewall
// (DEFAULT_AGENT_ALLOW_DOMAINS in vendor Code, narrowed by packages/cloud-contracts/src/hosted-allow-domains.ts), and `pypi.org` and `files.pythonhosted.org` are on it. The only
// per-project registry mechanism (registry-config.ts, N9) is for a customer's own CodeArtifact index with a short-lived token, written as a pip.conf for setup commands. So the
// default client here talks to those two hosts directly (the allow-list is the egress policy), checks every URL against an explicit host list again, follows redirects only to
// that list, and bounds every response. A CodeArtifact (PEP 503 HTML) client is a later `WheelIndex` implementation; the planner does not change.
import { createHash } from "node:crypto";
import { isProjectName, normalizeProjectName } from "./wheel-meta.js";

export type WheelIndexErrorCode = "unavailable" | "blocked-host" | "bad-response" | "too-large";

/** Index failures carry a fixed code; the planner maps them to a report line and never shows free text. */
export class WheelIndexError extends Error {
  constructor(readonly code: WheelIndexErrorCode) {
    super(code);
    this.name = "WheelIndexError";
  }
}

export interface IndexFile {
  readonly filename: string;
  readonly url: string;
  /** Lower-case hex SHA-256 of the file, as the index lists it. A file without one is never fetched. */
  readonly sha256: string | undefined;
  /** Yanked releases stay installable by an exact pin (the function already has this version); the report says so. */
  readonly yanked: boolean;
  readonly size: number | undefined;
}

export interface WheelIndex {
  /** Every file the index lists for a project (wheels and source archives); [] when the project does not exist. Throws WheelIndexError. */
  listFiles(project: string): Promise<readonly IndexFile[]>;
  /** The bytes of one file, at most `maxBytes` of them. Throws WheelIndexError. The caller verifies the hash. */
  download(file: IndexFile, maxBytes: number): Promise<Uint8Array>;
}

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** An index held in memory: tests, and anything that already has the files. Counts calls so a test can prove what was (not) fetched. */
export class FakeWheelIndex implements WheelIndex {
  readonly listCalls: string[] = [];
  readonly downloads: string[] = [];
  private readonly projects = new Map<string, { file: IndexFile; bytes: Uint8Array | undefined }[]>();
  failList = new Set<string>();

  /** Adds a file. The hash is computed from the bytes unless `sha256` is given (a test of a wrong or missing hash). */
  add(project: string, filename: string, bytes: Uint8Array, extra: { sha256?: string | null; yanked?: boolean } = {}): void {
    const key = normalizeProjectName(project);
    const sha256 = extra.sha256 === null ? undefined : (extra.sha256 ?? sha256Hex(bytes));
    const list = this.projects.get(key) ?? [];
    list.push({ file: { filename, url: `https://files.example.test/${filename}`, sha256, yanked: extra.yanked ?? false, size: bytes.length }, bytes });
    this.projects.set(key, list);
  }

  /** Lists a file with no content behind it (a source archive). */
  addListing(project: string, filename: string): void {
    const key = normalizeProjectName(project);
    const list = this.projects.get(key) ?? [];
    list.push({ file: { filename, url: `https://files.example.test/${filename}`, sha256: "0".repeat(64), yanked: false, size: undefined }, bytes: undefined });
    this.projects.set(key, list);
  }

  listFiles(project: string): Promise<readonly IndexFile[]> {
    const key = normalizeProjectName(project);
    this.listCalls.push(key);
    if (this.failList.has(key)) return Promise.reject(new WheelIndexError("unavailable"));
    return Promise.resolve((this.projects.get(key) ?? []).map((entry) => entry.file));
  }

  download(file: IndexFile, maxBytes: number): Promise<Uint8Array> {
    this.downloads.push(file.filename);
    for (const list of this.projects.values()) for (const entry of list) {
      if (entry.file.url !== file.url) continue;
      if (entry.bytes === undefined) return Promise.reject(new WheelIndexError("bad-response"));
      if (entry.bytes.length > maxBytes) return Promise.reject(new WheelIndexError("too-large"));
      return Promise.resolve(entry.bytes);
    }
    return Promise.reject(new WheelIndexError("bad-response"));
  }
}

export interface PypiIndexOptions {
  /** `fetch`, injected so tests (and a worker with its own agent or proxy) control the transport. */
  readonly fetch: typeof fetch;
  /** The simple-index root. Default https://pypi.org/simple/. */
  readonly baseUrl?: string;
  /** Hosts a request or a redirect may go to. Default pypi.org and files.pythonhosted.org: the names the hosted DNS firewall serves. */
  readonly allowedHosts?: readonly string[];
  /** Largest listing accepted. Default 32 MiB (numpy's has about 3,000 files). */
  readonly maxListingBytes?: number;
  /** Per-request time limit. Default 60 s. */
  readonly timeoutMs?: number;
}

const DEFAULT_HOSTS = ["pypi.org", "files.pythonhosted.org"];
const MAX_REDIRECTS = 3;

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) { await response.body?.cancel().catch(() => undefined); throw new WheelIndexError("too-large"); }
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (done || value === undefined) break;
    total += value.length;
    if (total > maxBytes) { await reader.cancel().catch(() => undefined); throw new WheelIndexError("too-large"); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/** The files of one project from a PEP 691 JSON simple index. */
export function createPypiJsonIndex(options: PypiIndexOptions): WheelIndex {
  const base = options.baseUrl ?? "https://pypi.org/simple/";
  const hosts = new Set((options.allowedHosts ?? DEFAULT_HOSTS).map((host) => host.toLowerCase()));
  const maxListing = options.maxListingBytes ?? 32 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 60_000;

  const checkUrl = (text: string, relativeTo?: string): URL => {
    let url: URL;
    try { url = new URL(text, relativeTo); } catch { throw new WheelIndexError("bad-response"); }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" || !hosts.has(url.hostname.toLowerCase())) throw new WheelIndexError("blocked-host");
    return url;
  };

  const get = async (start: URL, accept: string, maxBytes: number): Promise<{ status: number; body: Uint8Array }> => {
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let response: Response;
      try {
        response = await options.fetch(url.href, { method: "GET", redirect: "manual", headers: { accept }, signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        throw new WheelIndexError("unavailable");
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (location === null) throw new WheelIndexError("bad-response");
        url = checkUrl(location, url.href);
        continue;
      }
      if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return { status: 404, body: new Uint8Array(0) }; }
      if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); throw new WheelIndexError("unavailable"); }
      return { status: 200, body: await readCapped(response, maxBytes) };
    }
    throw new WheelIndexError("bad-response");
  };

  return {
    async listFiles(project: string): Promise<readonly IndexFile[]> {
      if (!isProjectName(project)) throw new WheelIndexError("bad-response");
      const root = checkUrl(base);
      const listing = new URL(`${encodeURIComponent(normalizeProjectName(project))}/`, root.href.endsWith("/") ? root.href : `${root.href}/`);
      const { status, body } = await get(checkUrl(listing.href), "application/vnd.pypi.simple.v1+json", maxListing);
      if (status === 404) return [];
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch { throw new WheelIndexError("bad-response"); }
      const rawFiles = (parsed as { files?: unknown } | null)?.files;
      if (!Array.isArray(rawFiles)) throw new WheelIndexError("bad-response");
      const out: IndexFile[] = [];
      for (const raw of rawFiles as unknown[]) {
        if (typeof raw !== "object" || raw === null) continue;
        const entry = raw as { filename?: unknown; url?: unknown; hashes?: unknown; yanked?: unknown; size?: unknown };
        if (typeof entry.filename !== "string" || typeof entry.url !== "string" || /[/\\\0]/u.test(entry.filename)) continue;
        const sha = (entry.hashes as { sha256?: unknown } | undefined)?.sha256;
        // A file whose URL leaves the allowed hosts is not offered (the index is not trusted to point anywhere).
        let absolute: string;
        try { absolute = checkUrl(entry.url, listing.href).href; } catch { continue; }
        out.push({
          filename: entry.filename,
          url: absolute,
          sha256: typeof sha === "string" && /^[0-9a-f]{64}$/u.test(sha) ? sha : undefined,
          yanked: entry.yanked === true || typeof entry.yanked === "string",
          size: typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : undefined,
        });
      }
      return out;
    },
    async download(file: IndexFile, maxBytes: number): Promise<Uint8Array> {
      const { status, body } = await get(checkUrl(file.url), "application/octet-stream", maxBytes);
      if (status !== 200) throw new WheelIndexError("bad-response");
      return body;
    },
  };
}
