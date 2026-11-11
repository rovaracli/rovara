// Rovara Code (Plan 6 Task 15): reading the end of a GitHub Actions job's log through the App's provider with a fake HTTP layer. The token asks for `actions: read` alone, scoped to the one
// repository; the redirect GitHub answers with is followed only on a host that serves logs, with no credentials; the body is read as a stream that keeps its end, so a log of any size
// costs bounded memory.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CI_LOG_BYTES_MAX, CI_LOG_TAIL_LINES } from "@rovara-code/contracts";
import { GitHubAppCredentialProvider, GithubMergeRateLimitError } from "../../packages/broker/src/github-app.js";
import { LOG_DOWNLOAD_BYTES_MAX, isAllowedLogAddress, logTail, readLogEnd } from "../../packages/broker/src/github-job-log.js";

const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const REPO = "https://github.com/acme/payments.git";
const SCOPE = { system: "install" } as const;
const LOG_ADDRESS = "https://productionresultssa7.blob.core.windows.net/actions-results/abc?sig=xyz";

interface Fixture {
  /** What the logs endpoint answers: a redirect to this address, or this status. */
  location?: string;
  status?: number;
  tokenStatus?: number;
  /** Headers on the logs endpoint's answer, and on the log host's. */
  headers?: Record<string, string>;
  logHeaders?: Record<string, string>;
  /** The log host's answer: a body, or a status. */
  body?: string | (() => ReadableStream<Uint8Array>);
  logStatus?: number;
}

function harness(fixture: Fixture = {}) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const requests: Array<{ url: string; headers: Record<string, string>; redirect?: string | undefined }> = [];
  const tokenRequests: unknown[] = [];
  const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, headers: { ...(init?.headers as Record<string, string> | undefined) }, redirect: init?.redirect });
    if (url.endsWith("/installation")) return Response.json({ id: 163046162, account: { login: "acme" } });
    if (url.endsWith("/access_tokens")) {
      tokenRequests.push(typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined);
      return fixture.tokenStatus === undefined ? Response.json({ token: "log-token" }, { status: 201 }) : new Response("{}", { status: fixture.tokenStatus });
    }
    if (/\/actions\/jobs\/\d+\/logs$/.test(url)) {
      if (fixture.status !== undefined) return new Response(null, { status: fixture.status, headers: fixture.headers ?? {} });
      return new Response(null, { status: 302, headers: { location: fixture.location ?? LOG_ADDRESS } });
    }
    if (url === (fixture.location ?? LOG_ADDRESS) || url.startsWith("https://")) {
      if (fixture.logStatus !== undefined) return new Response(null, { status: fixture.logStatus, headers: fixture.logHeaders ?? {} });
      const body = typeof fixture.body === "function" ? fixture.body() : fixture.body ?? "";
      return new Response(body, { status: 200 });
    }
    return new Response("{}", { status: 404 });
  });
  const provider = new GitHubAppCredentialProvider({
    credentialRef: "github", appId: "5002502", getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(), fetchImplementation, now: () => NOW,
  });
  return { provider, requests, tokenRequests, fetchImplementation };
}

const lines = (count: number, width = 60) => Array.from({ length: count }, (_, index) => `line ${String(index).padStart(6, "0")} ${"x".repeat(width)}`).join("\n");

describe("a job log's end", () => {
  it("asks for actions: read alone, scoped to the one repository, and returns the log's last lines", async () => {
    const h = harness({ body: lines(5000) });
    const tail = await h.provider.getJobLogTail(REPO, "4242", SCOPE);
    expect(h.tokenRequests).toEqual([{ repositories: ["payments"], permissions: { actions: "read" } }]);
    const kept = tail!.split("\n");
    expect(kept).toHaveLength(CI_LOG_TAIL_LINES);
    expect(kept.at(-1)).toContain("line 004999");
    expect(Buffer.byteLength(tail!, "utf8")).toBeLessThanOrEqual(CI_LOG_BYTES_MAX);
  });

  it("asks GitHub's logs endpoint with the token and no redirect following, and the log host with no credentials", async () => {
    const h = harness({ body: "Error: boom\n" });
    await h.provider.getJobLogTail(REPO, "4242", SCOPE);
    const asked = h.requests.find((request) => /\/actions\/jobs\/4242\/logs$/.test(request.url))!;
    expect(asked.url).toBe("https://api.github.com/repos/acme/payments/actions/jobs/4242/logs");
    expect(asked.headers.authorization).toBe("Bearer log-token");
    expect(asked.redirect).toBe("manual");
    const download = h.requests.find((request) => request.url === LOG_ADDRESS)!;
    expect(Object.keys(download.headers).map((name) => name.toLowerCase())).not.toContain("authorization");
    expect(download.redirect).toBe("error");
  });

  it("refuses a redirect to example.com, to http, to a port, with credentials in it, or to a lookalike host, and asks none of them", async () => {
    for (const location of [
      "https://example.com/log", "http://productionresultssa7.blob.core.windows.net/x", "https://productionresultssa7.blob.core.windows.net:8443/x", "https://user:pw@productionresultssa7.blob.core.windows.net/x",
      "https://evilblob.core.windows.net/x", "https://actions.githubusercontent.com.evil.test/x", "https://productionresultssa7.blob.core.windows.net.evil.test/x", "not a url", "",
    ]) {
      const h = harness({ location, body: "secret" });
      await expect(h.provider.getJobLogTail(REPO, "4242", SCOPE)).rejects.toThrow(/won't read|will not read/u);
      expect(h.requests.filter((request) => request.url === location && location !== "")).toEqual([]);
    }
  });

  it("follows a redirect to GitHub's own Actions hosts", async () => {
    for (const location of ["https://pipelines.actions.githubusercontent.com/abc/log", "https://actions.githubusercontent.com/log", "https://productionresultssa13.blob.core.windows.net/a"]) {
      const h = harness({ location, body: "ok line\n" });
      await expect(h.provider.getJobLogTail(REPO, "4242", SCOPE)).resolves.toBe("ok line");
    }
  });

  it("has no log when GitHub has none (404, 410, 403) or the host says the log is gone, and no log when the installation has not accepted the permission", async () => {
    for (const status of [404, 410, 403]) expect(await harness({ status }).provider.getJobLogTail(REPO, "4242", SCOPE)).toBeUndefined();
    for (const logStatus of [404, 410, 403]) expect(await harness({ logStatus }).provider.getJobLogTail(REPO, "4242", SCOPE)).toBeUndefined();
    expect(await harness({ tokenStatus: 403 }).provider.getJobLogTail(REPO, "4242", SCOPE)).toBeUndefined();
  });

  it("tells a rate limit from a permission: a 403 or 429 that says to wait is the sweep's to back off from, a plain 403 is no log", async () => {
    const soon = String(Math.floor((NOW + 120_000) / 1000));
    for (const headers of [{ "retry-after": "120" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": soon }]) {
      await expect(harness({ status: 403, headers }).provider.getJobLogTail(REPO, "4242", SCOPE)).rejects.toBeInstanceOf(GithubMergeRateLimitError);
      await expect(harness({ logStatus: 403, logHeaders: headers }).provider.getJobLogTail(REPO, "4242", SCOPE)).rejects.toBeInstanceOf(GithubMergeRateLimitError);
    }
    await expect(harness({ status: 429 }).provider.getJobLogTail(REPO, "4242", SCOPE)).rejects.toBeInstanceOf(GithubMergeRateLimitError);
    expect(await harness({ status: 403 }).provider.getJobLogTail(REPO, "4242", SCOPE)).toBeUndefined();
    expect(await harness({ logStatus: 403 }).provider.getJobLogTail(REPO, "4242", SCOPE)).toBeUndefined();
  });

  it("throws when GitHub is failing, and for a job id that is not a number", async () => {
    await expect(harness({ status: 502 }).provider.getJobLogTail(REPO, "4242", SCOPE)).rejects.toThrow(/HTTP 502/u);
    await expect(harness({ logStatus: 500 }).provider.getJobLogTail(REPO, "4242", SCOPE)).rejects.toThrow(/HTTP 500/u);
    for (const jobId of ["", "abc", "12 34", "1/../2", "1234567890123456789012"]) {
      const h = harness();
      await expect(h.provider.getJobLogTail(REPO, jobId, SCOPE)).rejects.toThrow(/job id/u);
      expect(h.requests).toEqual([]);
    }
  });

  it("reads a huge log as a stream that keeps its end, and stops reading it", async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode(`${lines(2000, 100)}\n`);
    const total = 40;
    const h = harness({ body: () => new ReadableStream<Uint8Array>({ pull(controller) { pulled += 1; if (pulled > total) controller.close(); else controller.enqueue(chunk); } }) });
    const tail = await h.provider.getJobLogTail(REPO, "4242", SCOPE);
    // 40 chunks of about 214 KB is 8.6 MB: reading stops at the limit, short of the end of the stream.
    expect(pulled).toBeLessThan(total);
    expect(pulled * chunk.length).toBeGreaterThanOrEqual(LOG_DOWNLOAD_BYTES_MAX);
    expect(tail!.split("\n").length).toBeLessThanOrEqual(CI_LOG_TAIL_LINES);
    expect(tail).toContain("line 001999");
  });

  it("counts the logs endpoint and the token against a pass's allowance, and the download not", async () => {
    const h = harness({ body: "x\n" });
    let counted = 0;
    const budget = { signal: new AbortController().signal, beforeRequest: () => { counted += 1; } };
    await h.provider.getJobLogTail(REPO, "4242", SCOPE, budget);
    // The installation lookup, the token and the logs endpoint; the log host's address is not GitHub's API.
    expect(counted).toBe(3);
    expect(h.requests.some((request) => request.url === LOG_ADDRESS)).toBe(true);
  });
});

describe("the end of a log", () => {
  it("is the last lines, whole, within the byte limit", () => {
    expect(logTail("a\nb\nc\nd\n", { lines: 2 })).toBe("c\nd");
    expect(logTail("a\r\nb\r\nc", { lines: 5 })).toBe("a\nb\nc");
    const tail = logTail(lines(1000, 100), { lines: 1000, bytes: 1000 });
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(1000);
    expect(tail.endsWith("line 000999 " + "x".repeat(100))).toBe(true);
    expect(tail.startsWith("line ")).toBe(true);
  });

  it("shows the end of one line that is longer than the limit, never half a character", () => {
    const tail = logTail(`start-${"é".repeat(5000)}-END`, { bytes: 100 });
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(100);
    expect(tail.endsWith("-END")).toBe(true);
    expect(tail).not.toContain("�");
    expect(logTail("", {})).toBe("");
  });

  it("keeps only the end of what it reads: the memory held is bounded however long the log", async () => {
    const chunk = new TextEncoder().encode(`${lines(500, 100)}\n`);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulled += 1; if (pulled > 20) controller.close(); else controller.enqueue(chunk); } });
    const end = await readLogEnd(new Response(stream));
    expect(Buffer.byteLength(end, "utf8")).toBeLessThanOrEqual(CI_LOG_BYTES_MAX * 2);
    expect(end.trimEnd().endsWith("x".repeat(100))).toBe(true);
  });

  it("allows GitHub's log hosts and nothing else", () => {
    expect(isAllowedLogAddress(LOG_ADDRESS)).toBe(true);
    expect(isAllowedLogAddress("https://results-receiver.actions.githubusercontent.com/x")).toBe(true);
    expect(isAllowedLogAddress("https://github.com/x")).toBe(false);
    expect(isAllowedLogAddress("https://blob.core.windows.net/x")).toBe(false);
    expect(isAllowedLogAddress("https://productionresultssa.blob.core.windows.net/x")).toBe(false);
    // Only the numbered accounts GitHub's results service uses (0 to 19).
    for (const number of ["0", "9", "10", "19"]) expect(isAllowedLogAddress(`https://productionresultssa${number}.blob.core.windows.net/x`), number).toBe(true);
    for (const number of ["20", "99", "123", "01"]) expect(isAllowedLogAddress(`https://productionresultssa${number}.blob.core.windows.net/x`), number).toBe(false);
  });
});
