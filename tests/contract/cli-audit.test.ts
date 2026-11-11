// tests/contract/cli-audit.test.ts
// Task 14 of the Audit Ledger plan: `agentx audit log | export | verify | open`, `agentx admin audit log | export`, and the MCP
// tool `agentx_audit_status`. The control plane is a scripted fetch (no AWS, no network); the downloaded exports are the
// verifier's own fixture bundles, so `verify` really runs `verifyBundle` and `verifyExtends`.
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIT_ERROR_MESSAGES, AUDIT_LIMITS_COPY } from "@agentx/cloud-contracts";
import { tokenStoreKey } from "../../packages/cli/src/auth.js";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { downloadExport, parseExportBytes, terminalSafe } from "../../packages/cli/src/developer/audit.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { createAgentXMcpServer, httpControlPlaneClient, type ToolContext } from "../../packages/mcp/src/index.js";
import { AUDIT_ORG_FORBIDDEN } from "../../packages/broker/src/audit/routes.js";
import { TSA_LABEL, buildAuditFixture, cloneBundle } from "../support/audit-bundle-fixture.js";
import { toolError } from "../support/mcp-tool-error.js";

const URL_ = "https://abc123.execute-api.us-east-1.amazonaws.com";
const ISSUER = `${URL_}/v1/auth`;
const entry = { url: URL_, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` };
const ADMIN_PLANE = "http://127.0.0.1:8787";
const ADMIN_DEPLOYMENT = { controlPlaneUrl: ADMIN_PLANE, auth: { issuer: "https://identity.example.test", clientId: "agentx-client", audience: "agentx-api" } };
const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
const EXPORT_ID = `aex_${"0123456789abcdef".repeat(2)}`;
const SIGNED = "https://signed.test/exports-bucket/org/aex.rovara-audit.json.gz?sig=abc";
const FORBIDDEN_BODY = { error: { code: "FORBIDDEN", message: AUDIT_ORG_FORBIDDEN } };
// Characters a terminal or a reader could be fooled by, built here so the source holds none of them.
const RLO = String.fromCodePoint(0x202e);
const LRO = String.fromCodePoint(0x202d);
const ZWSP = String.fromCodePoint(0x200b);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ---- the scripted control plane ---------------------------------------------------------------------------------------

interface Call { method: string; url: URL; headers: Headers; body: unknown }

type Scripted = object | Response;

interface PlaneOptions {
  /** Answers to GET .../records, in order (the last one repeats). */
  records?: Scripted[];
  /** The answer to POST .../exports. */
  start?: Scripted;
  /** Answers to GET .../exports/{id}, in order (the last one repeats). */
  polls?: Scripted[];
  /** What the signed link serves. */
  download?: Buffer | Response;
}

const reply = (value: Scripted, status = 200): Response => (value instanceof Response ? value.clone() : Response.json(value, { status }));
const nextOf = (list: Scripted[], taken: number): Scripted => list[Math.min(taken, list.length - 1)] ?? {};

function entryOf(seq: number, record: Record<string, unknown> = {}, details: unknown[] = [{ subject: "dev_1", salt: "00", fields: { name: "Alice Example" } }]) {
  return {
    record: {
      v: 1, orgId: ORG, seq, eventId: `aev_${seq.toString(16).padStart(40, "0")}`, action: "member.invited",
      actor: { kind: "member", id: "dev_1" }, target: { kind: "member", id: `n_${String(seq)}` },
      occurredAt: "2026-10-20T12:07:08.000Z", recordedAt: "2026-10-20T12:07:09.000Z", related: [], facts: { role: "admin" },
      details: [{ subject: "dev_1", commit: "c".repeat(64) }], prevHash: "a".repeat(64), hash: "b".repeat(64), ...record,
    },
    details,
  };
}

const recordsBody = (records: unknown[] = [entryOf(7)], extra: Record<string, unknown> = {}) => ({
  headSeq: 12, sealedThroughSeq: 10, latestTimestamp: "2026-10-20T12:01:30.000Z", epochsWithoutTimestamp: [], lockMode: "COMPLIANCE", records, ...extra,
});

const SUMMARY = {
  fromSeq: 1, toSeq: 40, records: 40, sealedThroughSeq: 35, unsealedCount: 5, timestampedThrough: "2026-10-20T12:46:30.000Z",
  epochsWithoutTimestamp: [], coveredEpochs: [], unverifiedAuthorities: [], lockModes: ["COMPLIANCE"], bytes: -1,
};
const viewOf = (status: string, extra: Record<string, unknown> = {}) => ({
  exportId: EXPORT_ID, status, requestedBy: { kind: "member", id: "dev_1" }, range: { fromSeq: 1, toSeq: 40 }, withDetails: false, createdAt: "2026-10-20T14:00:00.000Z", ...extra,
});
const running = () => viewOf("running");
const ready = (extra: Record<string, unknown> = {}) => viewOf("ready", {
  completedAt: "2026-10-20T14:01:00.000Z", expiresAt: "2026-10-26T14:01:00.000Z", summary: SUMMARY, download: { url: SIGNED, expiresInSeconds: 900 }, ...extra,
});
const startedBody = { exportId: EXPORT_ID, status: "running" };

/** `summary.bytes: -1` means "the size of the file this plane serves", so a ready view tells the truth unless a test says otherwise. */
function withTrueSize(value: Scripted, download: PlaneOptions["download"]): Scripted {
  const view = value as { summary?: { bytes?: number } };
  if (value instanceof Response || !(download instanceof Buffer) || view.summary?.bytes !== -1) return value;
  return { ...view, summary: { ...view.summary, bytes: download.length } };
}

const gz = (value: unknown): Buffer => gzipSync(Buffer.from(JSON.stringify(value)));

function plane(options: PlaneOptions = {}) {
  const calls: Call[] = [];
  const taken = { records: 0, polls: 0 };
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, headers: new Headers(init?.headers), body });
    if (url.href === SIGNED) {
      if (options.download instanceof Response) return options.download.clone();
      return new Response(options.download === undefined ? new Uint8Array() : new Uint8Array(options.download), { headers: { "content-type": "application/gzip" } });
    }
    if (method === "GET" && url.pathname.endsWith("/records")) return reply(nextOf(options.records ?? [recordsBody()], taken.records++));
    if (method === "GET" && url.pathname.endsWith("/status")) return reply(recordsBody([]));
    if (method === "POST" && url.pathname.endsWith("/exports")) return reply(options.start ?? startedBody, 202);
    if (method === "GET" && url.pathname.includes("/exports/")) return reply(withTrueSize(nextOf(options.polls ?? [ready()], taken.polls++), options.download));
    throw new Error(`unexpected ${method} ${url.href}`);
  });
  return { fetchImplementation, calls };
}

// ---- running the CLI --------------------------------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const base64 = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
/** A developer token whose (unverified) payload names the person's organization, as the control plane's tokens do. */
const tokenFor = (org: string): string => `${base64({ alg: "RS256" })}.${base64({ org })}.signature`;

async function harness(options: PlaneOptions = {}, ids: string[] = [], tokenOrg?: string) {
  const home = await mkdtemp(join(tmpdir(), "rovara-audit-cli-"));
  dirs.push(home);
  await saveDeveloperEnvironment(home, "staging", entry);
  const tokenStore = new InMemoryTokenStore();
  await tokenStore.set(developerTokenKey(ISSUER), { accessToken: tokenOrg === undefined ? "access" : tokenFor(tokenOrg), refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
  await tokenStore.set(tokenStoreKey(ADMIN_DEPLOYMENT.auth), { accessToken: "admin-access", expiresAt: Date.now() + 3_600_000 });
  const deploymentFile = join(home, "deployment.yaml");
  await writeFile(deploymentFile, JSON.stringify(ADMIN_DEPLOYMENT), "utf8");
  const { fetchImplementation, calls } = plane(options);
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  const opened: string[] = [];
  const run = (args: string[]) => executeCli(["--config-dir", home, "--deployment-file", deploymentFile, "--allow-loopback", ...args], {
    fetchImplementation, tokenStore, environments: { home },
    stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) },
    audit: {
      sleep: async (ms: number) => { sleeps.push(ms); },
      newRequestId: () => ids.shift() ?? randomUUID(),
      openBrowser: async (url: string) => { opened.push(url); },
    },
  });
  return { home, out, err, sleeps, opened, calls, fetchImplementation, run, text: () => out.join(""), errors: () => err.join("") };
}

type Harness = Awaited<ReturnType<typeof harness>>;
const exportRequests = (h: Harness) => h.calls.filter((call) => call.method === "POST");
const polls = (h: Harness) => h.calls.filter((call) => call.method === "GET" && call.url.pathname.includes("/exports/"));
const downloads = (h: Harness) => h.calls.filter((call) => call.url.href === SIGNED);
const mode = async (path: string) => (await stat(path)).mode & 0o777;
/** Whether text holds a control or format character (a terminal could act on it); the line breaks between lines are fine. */
const unsafe = (text: string): boolean => /[\p{Cc}\p{Cf}]/u.test(text.replace(/\n/g, ""));

// ---- agentx audit log -------------------------------------------------------------------------------------------------

describe("agentx audit log", () => {
  it("prints how far the log is sealed and each record with the person's name, using the signed-in session", async () => {
    const h = await harness();
    expect(await h.run(["audit", "log"])).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url.href).toBe(`${URL_}/v1/dev/org/audit/records`);
    expect(h.calls[0]?.headers.get("authorization")).toBe("Bearer access");
    const text = h.text();
    expect(text).toContain("Sealed through record 10 of 12. 2 newer records are not sealed yet.");
    expect(text).toContain("Latest independent time: 2026-10-20 12:01:30 UTC.");
    expect(text).toContain("Sealed copies are locked in COMPLIANCE mode.");
    expect(text).toContain("Alice Example");
    expect(text).toContain("member.invited");
    expect(text).toContain("member n_7");
    expect(text).toContain("2026-10-20 12:07:09 UTC");
    expect(text).toContain("role=admin");
    expect(h.errors()).toBe("");
  });

  it("says when nothing is independently timed yet, and shows an erased person as erased", async () => {
    const body = recordsBody([entryOf(3, {}, [{ subject: "dev_1", erased: true }])]);
    delete (body as { latestTimestamp?: string }).latestTimestamp;
    const h = await harness({ records: [body] });
    expect(await h.run(["audit", "log"])).toBe(0);
    expect(h.text()).toContain("No independent time yet");
    expect(h.text()).toContain("erased");
  });

  it("sends the filters: a time is a time, a bare number is a record number", async () => {
    const times = await harness();
    expect(await times.run(["audit", "log", "--from", "2026-10-20T00:00:00Z", "--to", "2026-10-21T00:00:00Z", "--action", "member.invited", "--limit", "5"])).toBe(0);
    const params = times.calls[0]?.url.searchParams;
    expect(Object.fromEntries(params ?? [])).toEqual({ from: "2026-10-20T00:00:00Z", to: "2026-10-21T00:00:00Z", action: "member.invited", limit: "5" });
    const numbers = await harness();
    expect(await numbers.run(["audit", "log", "--from", "3", "--to", "9", "--cursor", "abc_-1"])).toBe(0);
    expect(Object.fromEntries(numbers.calls[0]?.url.searchParams ?? [])).toEqual({ fromSeq: "3", toSeq: "9", cursor: "abc_-1" });
  });

  it("tells the person how to see the next records", async () => {
    const h = await harness({ records: [recordsBody([entryOf(7)], { nextCursor: "cursor-1" })] });
    expect(await h.run(["audit", "log", "--action", "member.invited"])).toBe(0);
    expect(h.text()).toContain("More records follow: run the same command again with --cursor cursor-1");
  });

  it("refuses a bad --limit, --from or --to without calling the control plane", async () => {
    for (const args of [["--limit", "0"], ["--limit", "201"], ["--limit", "x"], ["--from", "last tuesday"], ["--to", "2026-"], ["--from", "2026-13-45"]]) {
      const h = await harness();
      expect(await h.run(["audit", "log", ...args]), args.join(" ")).toBe(2);
      expect(h.calls).toHaveLength(0);
      expect(h.errors()).toContain("CONFIG_INVALID");
    }
    for (const args of [["--from", "9", "--to", "3"], ["--from", "0"], ["--from", "2026-10-21T00:00:00Z", "--to", "2026-10-20T00:00:00Z"]]) {
      const h = await harness();
      expect(await h.run(["audit", "log", ...args]), args.join(" ")).toBe(7);
      expect(h.calls).toHaveLength(0);
      expect(h.errors()).toContain(AUDIT_ERROR_MESSAGES.AUDIT_RANGE_INVALID);
    }
  });

  it("shows a contributor the refusal text and exits 4", async () => {
    const h = await harness({ records: [reply(FORBIDDEN_BODY, 403)] });
    expect(await h.run(["audit", "log"])).toBe(4);
    expect(h.errors()).toContain(AUDIT_ORG_FORBIDDEN);
    expect(h.text()).toBe("");
  });

  it("writes the data as JSON with --json", async () => {
    const h = await harness();
    expect(await h.run(["audit", "log", "--json"])).toBe(0);
    const parsed = JSON.parse(h.text()) as { ok: boolean; data: { env: string; headSeq: number; records: Array<{ record: { seq: number } }> } };
    expect(parsed).toMatchObject({ ok: true, data: { env: "staging", headSeq: 12 } });
    expect(parsed.data.records[0]?.record.seq).toBe(7);
  });

  describe("values from the ledger are untrusted", () => {
    // Every field a person or a stored value controls: the terminal must not see the escape, the C1 introducer or the override.
    const hostile = {
      action: "x\u001b[2Jevil",
      actorId: `dev${RLO}_1`,
      targetId: "n\u009b31m_7",
      name: `Mallory\u001b]0;pwned\u0007${RLO}`,
      factKey: "k\u001b[1m",
      factValue: `v${LRO}`,
      detailValue: "line one\nFAKE 99  2026-10-20  member admin.granted",
      related: "rel\u001b[0m",
      latest: "2026\u001b[31m",
    };
    const body = recordsBody([entryOf(7, {
      action: hostile.action, actor: { kind: "member", id: hostile.actorId }, target: { kind: "member", id: hostile.targetId },
      facts: { [hostile.factKey]: hostile.factValue }, related: [hostile.related], proof: { kind: "button", via: "sl\u001backs" },
    }, [{ subject: "dev_1", salt: "00", fields: { name: hostile.name, note: hostile.detailValue } }])], { latestTimestamp: hostile.latest, lockMode: "COMPLIANCE\u001b[0m" });

    it("shows control, format and bidi characters as [U+XXXX] markers in the text output", async () => {
      const h = await harness({ records: [body] });
      expect(await h.run(["audit", "log"])).toBe(0);
      const text = h.text();
      expect(unsafe(text)).toBe(false);
      for (const marker of ["[U+001B]", "[U+202E]", "[U+009B]", "[U+202D]", "[U+0007]"]) expect(text, marker).toContain(marker);
      // A newline inside a value cannot start a line that looks like a record.
      expect(text.split("\n").some((line) => line.startsWith("FAKE"))).toBe(false);
      expect(text).toContain("line one FAKE 99");
    });

    it("does the same in --json output, which is also read in a terminal", async () => {
      const h = await harness({ records: [body] });
      expect(await h.run(["audit", "log", "--json"])).toBe(0);
      expect(unsafe(h.text())).toBe(false);
      const parsed = JSON.parse(h.text()) as { data: { records: Array<{ record: { action: string; actor: { id: string }; facts: Record<string, string> }; details: Array<{ fields: Record<string, string> }> }> } };
      const first = parsed.data.records[0]!;
      expect(first.record.action).toBe("x[U+001B][2Jevil");
      expect(first.record.actor.id).toBe("dev[U+202E]_1");
      expect(Object.keys(first.record.facts)).toEqual(["k[U+001B][1m"]);
      expect(first.details[0]?.fields.name).toBe("Mallory[U+001B]]0;pwned[U+0007][U+202E]");
    });

    it("marks the cursor and the error text a server sends", async () => {
      const h = await harness({ records: [recordsBody([entryOf(7)], { nextCursor: "cur\u001b[31m" })] });
      expect(await h.run(["audit", "log"])).toBe(0);
      expect(unsafe(h.text())).toBe(false);
      const refused = await harness({ records: [reply({ error: { code: "AUDIT_RANGE_INVALID", message: "bad \u001b[31mrange" } }, 400)] });
      expect(await refused.run(["audit", "log"])).not.toBe(0);
      expect(unsafe(refused.errors())).toBe(false);
    });
  });
});

// ---- agentx audit export ----------------------------------------------------------------------------------------------

describe("agentx audit export", () => {
  const fixture = buildAuditFixture();
  const file = gz(fixture.bundle);

  it("starts the export, polls every 3 seconds, downloads without the sign-in token, and saves a private file", async () => {
    const h = await harness({ polls: [running(), running(), ready()], download: file }, ["11111111-1111-4111-8111-111111111111"]);
    const out = join(h.home, "audit.json.gz");
    expect(await h.run(["audit", "export", "--from", "1", "--to", "40", "--out", out])).toBe(0);
    expect(exportRequests(h)).toHaveLength(1);
    expect(exportRequests(h)[0]?.url.href).toBe(`${URL_}/v1/dev/org/audit/exports`);
    expect(exportRequests(h)[0]?.body).toEqual({ requestId: "11111111-1111-4111-8111-111111111111", fromSeq: 1, toSeq: 40 });
    expect(exportRequests(h)[0]?.headers.get("authorization")).toBe("Bearer access");
    expect(polls(h).map((call) => call.url.pathname)).toEqual(Array(3).fill(`/v1/dev/org/audit/exports/${EXPORT_ID}`));
    expect(h.sleeps).toEqual([3000, 3000, 3000]);
    // The signed link is fetched as it is: the sign-in token goes to the control plane only.
    expect(downloads(h)).toHaveLength(1);
    expect(downloads(h)[0]?.headers.get("authorization")).toBeNull();
    expect(Buffer.compare(await readFile(out), file)).toBe(0);
    expect(await mode(out)).toBe(0o600);
    expect(h.text()).toContain(`Saved the export to ${out}`);
    expect(h.text()).toContain("Records 1 to 40 (40 records).");
    expect(h.text()).toContain("Sealed through record 35. 5 newer records are not sealed yet.");
    expect(h.text()).toContain("Independent time: no later than 2026-10-20 12:46:30 UTC.");
    expect(h.text()).toContain("Sealed copies are locked in compliance mode.");
    expect(h.text()).toContain("rovara-audit-verify");
    expect(h.text().endsWith(`${AUDIT_LIMITS_COPY}\n`)).toBe(true);
  });

  it("polls straight away when the control plane already has the export, and sends --with-details", async () => {
    const h = await harness({ start: { exportId: EXPORT_ID, status: "ready" }, polls: [ready()], download: file });
    const out = join(h.home, "again.json.gz");
    expect(await h.run(["audit", "export", "--from", "1", "--to", "40", "--with-details", "--out", out])).toBe(0);
    expect((exportRequests(h)[0]?.body as { withDetails?: boolean }).withDetails).toBe(true);
    expect(h.sleeps).toEqual([]);
  });

  it("makes a fresh request ID for each run", async () => {
    const first = await harness({ download: file });
    const second = await harness({ download: file });
    await first.run(["audit", "export", "--from", "1", "--to", "40", "--out", join(first.home, "a.gz")]);
    await second.run(["audit", "export", "--from", "1", "--to", "40", "--out", join(second.home, "a.gz")]);
    const ids = [first, second].map((h) => (exportRequests(h)[0]?.body as { requestId: string }).requestId);
    expect(ids[0]).toMatch(UUID_V4);
    expect(ids[1]).toMatch(UUID_V4);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("keeps waiting through a short outage and stops after repeated ones", async () => {
    const outage = () => new Response("", { status: 503 });
    const recovers = await harness({ polls: [outage(), running(), outage(), ready()], download: file });
    expect(await recovers.run(["audit", "export", "--from", "1", "--to", "40", "--out", join(recovers.home, "a.gz")])).toBe(0);
    const down = await harness({ polls: [outage()], download: file });
    const code = await down.run(["audit", "export", "--from", "1", "--to", "40", "--out", join(down.home, "a.gz")]);
    expect(code).toBe(6);
    expect(polls(down).length).toBeLessThan(10);
    expect(downloads(down)).toHaveLength(0);
  });

  it("stops on a failed export with the reason, and writes no file", async () => {
    const h = await harness({ polls: [running(), viewOf("failed", { failure: { code: "CHECKS_FAILED", failedChecks: ["chain", "x\u001b[31m"] } })], download: file });
    const out = join(h.home, "audit.json.gz");
    expect(await h.run(["audit", "export", "--from", "1", "--to", "40", "--out", out])).toBe(6);
    expect(h.errors()).toContain("CHECKS_FAILED");
    expect(h.errors()).toContain("chain");
    expect(h.errors()).not.toContain("\u001b");
    expect(polls(h)).toHaveLength(2);
    expect(downloads(h)).toHaveLength(0);
    await expect(stat(out)).rejects.toThrow();
  });

  it("stops on an expired export", async () => {
    const h = await harness({ polls: [viewOf("expired")] });
    expect(await h.run(["audit", "export", "--from", "1", "--to", "40", "--out", join(h.home, "audit.json.gz")])).toBe(4);
    expect(h.errors()).toContain("expired");
    expect(polls(h)).toHaveLength(1);
  });

  it("writes nothing when the signed link does not work", async () => {
    const h = await harness({ download: new Response("denied", { status: 403 }) });
    const out = join(h.home, "audit.json.gz");
    expect(await h.run(["audit", "export", "--from", "1", "--to", "40", "--out", out])).toBe(6);
    await expect(stat(out)).rejects.toThrow();
  });

  it("checks the range before calling the control plane", async () => {
    for (const range of [["5", "3"], ["0", "9"], ["1", "200001"], ["a", "9"], ["1.5", "9"]]) {
      const h = await harness();
      const code = await h.run(["audit", "export", "--from", range[0]!, "--to", range[1]!, "--out", join(h.home, "x.gz")]);
      expect(code, range.join("-")).toBe(7);
      expect(h.errors()).toContain(AUDIT_ERROR_MESSAGES.AUDIT_RANGE_INVALID);
      expect(h.calls).toHaveLength(0);
    }
  });

  it("needs --out in a folder that exists, and says so before calling anything", async () => {
    const missingFolder = await harness({ download: file });
    expect(await missingFolder.run(["audit", "export", "--from", "1", "--to", "40", "--out", join(missingFolder.home, "no-such-folder", "a.gz")])).toBe(2);
    expect(missingFolder.calls).toHaveLength(0);
    const noOut = await harness({ download: file });
    expect(await noOut.run(["audit", "export", "--from", "1", "--to", "40"])).toBe(2);
    expect(noOut.calls).toHaveLength(0);
  });

  it("writes the summary as JSON with --json", async () => {
    const h = await harness({ download: file });
    const out = join(h.home, "a.gz");
    expect(await h.run(["audit", "export", "--from", "1", "--to", "40", "--out", out, "--json"])).toBe(0);
    expect(JSON.parse(h.text())).toMatchObject({ ok: true, data: { file: out, exportId: EXPORT_ID, summary: { records: 40 }, limits: AUDIT_LIMITS_COPY } });
  });

  it("will not overwrite a file you already have", async () => {
    const h = await harness({ download: file });
    const out = join(h.home, "kept.json.gz");
    await writeFile(out, "my earlier export");
    expect(await h.run(["audit", "export", "--from", "1", "--to", "40", "--out", out])).toBe(2);
    expect(await readFile(out, "utf8")).toBe("my earlier export");
    expect(h.calls).toHaveLength(0);
  });

  it("shows summary text from the control plane as marked text", async () => {
    const summary = { ...SUMMARY, epochsWithoutTimestamp: ["e\u001b[31m2026"], unverifiedAuthorities: [`ac${RLO}me`], lockModes: ["GOVERNANCE\u0007"] };
    const h = await harness({ polls: [ready({ summary })], download: file });
    expect(await h.run(["audit", "export", "--from", "1", "--to", "40", "--out", join(h.home, "a.gz")])).toBe(0);
    expect(unsafe(h.text())).toBe(false);
    expect(h.text()).toContain("e[U+001B][31m2026");
  });
});

// ---- agentx audit verify ----------------------------------------------------------------------------------------------

describe("agentx audit verify", () => {
  const good = buildAuditFixture();
  const trustFile = async (h: Harness) => {
    const path = join(h.home, "root.pem");
    await writeFile(path, good.pki.root.x509.toString());
    return ["--trust", `${TSA_LABEL}=${path}`];
  };
  const SENTENCE = "For a check that doesn't trust this CLI, run rovara-audit-verify on the exported file.";

  it("exits 0 on the fixture ledger, exports without details, and ends with the built-in limits copy", async () => {
    const h = await harness({ download: gz(good.bundle) });
    expect(await h.run(["audit", "verify", "--from", "1", "--to", "40", ...(await trustFile(h))])).toBe(0);
    expect((exportRequests(h)[0]?.body as { withDetails?: boolean }).withDetails).not.toBe(true);
    expect(h.text()).toMatch(/^ok {3}chain: /m);
    expect(h.text()).toContain("Sealed and checked through record 35.");
    expect(h.text()).toContain("5 newer records are not sealed yet.");
    expect(h.text()).toContain("Independent time: no later than");
    expect(h.text()).toContain(SENTENCE);
    expect(h.text().endsWith(`${AUDIT_LIMITS_COPY}\n`)).toBe(true);
    expect(h.text()).not.toContain("FAIL");
  });

  it("exits 1 after a sealed record is tampered with, naming the check, and never says it is sealed", async () => {
    const bad = cloneBundle(good.bundle);
    (bad.records[2] as { facts: Record<string, unknown> }).facts.role = "owner";
    const h = await harness({ download: gz(bad) });
    expect(await h.run(["audit", "verify", "--from", "1", "--to", "40", ...(await trustFile(h))])).toBe(1);
    expect(h.text()).toContain("FAIL chain:");
    expect(h.text()).toContain("This export did not pass: chain.");
    expect(h.text()).not.toContain("Sealed and checked");
    expect(h.text()).toContain(SENTENCE);
    expect(h.text().endsWith(`${AUDIT_LIMITS_COPY}\n`)).toBe(true);
  });

  it("does not trust a timestamp authority it has no root for", async () => {
    const h = await harness({ download: gz(good.bundle) });
    expect(await h.run(["audit", "verify", "--from", "1", "--to", "40"])).toBe(1);
    expect(h.text()).toContain("FAIL timestamps:");
  });

  describe("--extends", () => {
    const older = buildAuditFixture({ recordsA: 22, sealsA: [{ epoch: 1, toSeq: 12 }, { epoch: 2, toSeq: 20 }] });

    it("passes with an older export of the same history", async () => {
      const h = await harness({ download: gz(good.bundle) });
      const olderFile = join(h.home, "older.json.gz");
      await writeFile(olderFile, gz(older.bundle));
      expect(await h.run(["audit", "verify", "--from", "1", "--to", "40", "--extends", olderFile, ...(await trustFile(h))])).toBe(0);
      expect(h.text()).toMatch(/^ok {3}extends: /m);
      expect(h.text()).toMatch(/^ok {3}olderExport: /m);
      expect(h.text().endsWith(`${AUDIT_LIMITS_COPY}\n`)).toBe(true);
    });

    it("fails, naming seq 20, after the history was rewritten and re-sealed", async () => {
      const resealed = buildAuditFixture({ rewrite: { from: 10, to: 20 } });
      // On its own the rewritten export is consistent: only the older export shows the change.
      const alone = await harness({ download: gz(resealed.bundle) });
      expect(await alone.run(["audit", "verify", "--from", "1", "--to", "40", ...(await trustFile(alone))])).toBe(0);
      const h = await harness({ download: gz(resealed.bundle) });
      const olderFile = join(h.home, "older.json");
      await writeFile(olderFile, JSON.stringify(older.bundle));
      expect(await h.run(["audit", "verify", "--from", "1", "--to", "40", "--extends", olderFile, ...(await trustFile(h))])).toBe(1);
      expect(h.text()).toMatch(/^FAIL extends: .*seq 20/m);
      expect(h.text().endsWith(`${AUDIT_LIMITS_COPY}\n`)).toBe(true);
    });

    it("is read, with --trust, before anything is exported", async () => {
      for (const extra of [["--extends", "/nonexistent/older.json"], ["--trust", "nolabel"], ["--trust", "x=/nonexistent/root.pem"]]) {
        const h = await harness({ download: gz(good.bundle) });
        expect(await h.run(["audit", "verify", "--from", "1", "--to", "40", ...extra]), extra.join(" ")).toBe(2);
        expect(h.calls).toHaveLength(0);
      }
      const h = await harness({ download: gz(good.bundle) });
      const notABundle = join(h.home, "other.json");
      await writeFile(notABundle, JSON.stringify({ format: "something else" }));
      expect(await h.run(["audit", "verify", "--from", "1", "--to", "40", "--extends", notABundle])).toBe(2);
      expect(h.calls).toHaveLength(0);
    });
  });

  it("keeps the export it checked when --out is given, and says how to keep it otherwise", async () => {
    const bytes = gz(good.bundle);
    const h = await harness({ download: bytes });
    const out = join(h.home, "checked.json.gz");
    expect(await h.run(["audit", "verify", "--from", "1", "--to", "40", "--out", out, ...(await trustFile(h))])).toBe(0);
    expect(Buffer.compare(await readFile(out), bytes)).toBe(0);
    expect(await mode(out)).toBe(0o600);
    expect(h.text()).toContain(`Saved the export to ${out}`);
    const without = await harness({ download: bytes });
    expect(await without.run(["audit", "verify", "--from", "1", "--to", "40", ...(await trustFile(without))])).toBe(0);
    expect(without.text()).toContain("--out");
  });

  it("exits 1 when the download is not an audit export", async () => {
    const h = await harness({ download: gzipSync(Buffer.from("{ not json")) });
    expect(await h.run(["audit", "verify", "--from", "1", "--to", "40"])).toBe(1);
    expect(h.errors()).toContain("not a readable audit export");
  });

  it("writes the report as JSON with --json and still exits 1 on a failure", async () => {
    const h = await harness({ download: gz(good.bundle) });
    expect(await h.run(["audit", "verify", "--from", "1", "--to", "40", "--json", ...(await trustFile(h))])).toBe(0);
    expect(JSON.parse(h.text())).toMatchObject({ ok: true, data: { ok: true, sealedThroughSeq: 35, limits: AUDIT_LIMITS_COPY } });
    const bad = cloneBundle(good.bundle);
    (bad.records[2] as { facts: Record<string, unknown> }).facts.role = "owner";
    const failing = await harness({ download: gz(bad) });
    expect(await failing.run(["audit", "verify", "--from", "1", "--to", "40", "--json", ...(await trustFile(failing))])).toBe(1);
    expect(JSON.parse(failing.text())).toMatchObject({ ok: false, data: { ok: false } });
  });
});

// ---- agentx audit open ------------------------------------------------------------------------------------------------

describe("agentx audit open", () => {
  it("opens the audit page of the signed-in cell in the browser", async () => {
    const h = await harness();
    expect(await h.run(["audit", "open"])).toBe(0);
    expect(h.opened).toEqual([`${URL_}/v1/app/audit/view`]);
    expect(h.text()).toContain(`${URL_}/v1/app/audit/view`);
    expect(h.calls).toHaveLength(0);
  });

  it("prints the link and opens nothing with --no-browser", async () => {
    const h = await harness();
    expect(await h.run(["audit", "open", "--no-browser"])).toBe(0);
    expect(h.opened).toEqual([]);
    expect(h.text()).toContain(`${URL_}/v1/app/audit/view`);
  });
});

// ---- agentx admin audit -----------------------------------------------------------------------------------------------

describe("agentx admin audit log", () => {
  it("reads one org's records with the reason and ticket, as the administrator", async () => {
    const h = await harness();
    expect(await h.run(["admin", "audit", "log", ORG, "--reason", "Customer asked", "--ticket", "SUP-42", "--limit", "5"])).toBe(0);
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.url.origin + call.url.pathname).toBe(`${ADMIN_PLANE}/v1/admin/audit/${ORG}/records`);
    expect(Object.fromEntries(call.url.searchParams)).toEqual({ reason: "Customer asked", ticket: "SUP-42", limit: "5" });
    expect(call.headers.get("authorization")).toBe("Bearer admin-access");
    expect(h.text()).toContain("Alice Example");
  });

  it("leaves the ticket out when none is given", async () => {
    const h = await harness();
    expect(await h.run(["admin", "audit", "log", ORG, "--reason", "Customer asked"])).toBe(0);
    expect(h.calls[0]?.url.searchParams.has("ticket")).toBe(false);
  });

  it("checks the reason and ticket locally, with the control plane's rules and words", async () => {
    const reasonRequired = AUDIT_ERROR_MESSAGES.AUDIT_REASON_REQUIRED;
    const notPlain = "The reason holds a character that is not allowed: use plain text.";
    const badTicket = "The ticket is 1 to 64 printable ASCII characters without spaces, or leave it out.";
    const cases: Array<[string[], number, string]> = [
      [[], 7, reasonRequired],
      [["--reason", ""], 7, reasonRequired],
      [["--reason", "   "], 7, reasonRequired],
      [["--reason", "x".repeat(301)], 7, reasonRequired],
      [["--reason", "bad \u001b[31mreason"], 2, notPlain],
      [["--reason", `bad${RLO}reason`], 2, notPlain],
      [["--reason", `zero${ZWSP}width`], 2, notPlain],
      [["--reason", "two\nlines"], 2, notPlain],
      [["--reason", "ok", "--ticket", "has space"], 2, badTicket],
      [["--reason", "ok", "--ticket", "x".repeat(65)], 2, badTicket],
      [["--reason", "ok", "--ticket", "ticketé"], 2, badTicket],
      [["--reason", "ok", "--ticket", ""], 2, badTicket],
    ];
    for (const [args, code, message] of cases) {
      const h = await harness();
      expect(await h.run(["admin", "audit", "log", ORG, ...args]), JSON.stringify(args)).toBe(code);
      expect(h.errors()).toContain(message);
      expect(h.calls).toHaveLength(0);
    }
    // 300 characters and accented letters are fine.
    const fine = await harness();
    expect(await fine.run(["admin", "audit", "log", ORG, "--reason", `${"é".repeat(299)}x`])).toBe(0);
  });

  it("refuses something that is not an organization ID before calling anything", async () => {
    for (const org of ["acme", "org_short", "../admin"]) {
      const h = await harness();
      expect(await h.run(["admin", "audit", "log", org, "--reason", "ok"]), org).toBe(2);
      expect(h.calls).toHaveLength(0);
    }
  });

  it("shows the control plane's refusal and a fail-closed 503 as they are", async () => {
    const refused = await harness({ records: [reply({ error: { code: "FORBIDDEN", message: "administrator claim is required" } }, 403)] });
    expect(await refused.run(["admin", "audit", "log", ORG, "--reason", "ok"])).toBe(4);
    expect(refused.errors()).toContain("administrator claim is required");
    const unavailable = await harness({ records: [reply({ error: { code: "AUDIT_UNAVAILABLE", message: AUDIT_ERROR_MESSAGES.AUDIT_UNAVAILABLE } }, 503)] });
    expect(await unavailable.run(["admin", "audit", "log", ORG, "--reason", "ok"])).toBe(7);
    expect(unavailable.errors()).toContain("didn't read anything");
    expect(unavailable.text()).toBe("");
  });

  it("marks hostile ledger values here too", async () => {
    const h = await harness({ records: [recordsBody([entryOf(7, { action: "x\u001b[2J" })])] });
    expect(await h.run(["admin", "audit", "log", ORG, "--reason", "ok"])).toBe(0);
    expect(h.text()).not.toContain("\u001b");
    expect(h.text()).toContain("[U+001B]");
  });
});

describe("agentx admin audit export", () => {
  const file = gz(buildAuditFixture().bundle);
  const args = (h: Harness, ...more: string[]) => ["admin", "audit", "export", ORG, "--from", "1", "--to", "40", "--reason", "Legal hold", "--ticket", "LEGAL-9", "--out", join(h.home, "staff.json.gz"), ...more];

  it("starts the export with the reason and ticket, polls the staff path at least 10 seconds apart, each time with the reason", async () => {
    const h = await harness({ polls: [running(), running(), ready()], download: file }, ["22222222-2222-4222-8222-222222222222"]);
    expect(await h.run(args(h))).toBe(0);
    const start = exportRequests(h)[0]!;
    expect(start.url.origin + start.url.pathname).toBe(`${ADMIN_PLANE}/v1/admin/audit/${ORG}/exports`);
    expect(start.body).toEqual({ requestId: "22222222-2222-4222-8222-222222222222", fromSeq: 1, toSeq: 40, reason: "Legal hold", ticket: "LEGAL-9" });
    expect(start.headers.get("authorization")).toBe("Bearer admin-access");
    expect(polls(h)).toHaveLength(3);
    for (const poll of polls(h)) {
      expect(poll.url.pathname).toBe(`/v1/admin/audit/${ORG}/exports/${EXPORT_ID}`);
      expect(Object.fromEntries(poll.url.searchParams)).toEqual({ reason: "Legal hold", ticket: "LEGAL-9" });
      expect(poll.headers.get("authorization")).toBe("Bearer admin-access");
    }
    expect(h.sleeps).toEqual([10_000, 10_000, 10_000]);
    expect(downloads(h)[0]?.headers.get("authorization")).toBeNull();
    expect(Buffer.compare(await readFile(join(h.home, "staff.json.gz")), file)).toBe(0);
    expect(h.text().endsWith(`${AUDIT_LIMITS_COPY}\n`)).toBe(true);
  });

  it("stops polling the moment the export is ready, failed or expired", async () => {
    for (const final of [viewOf("failed", { failure: { code: "TIMED_OUT" } }), viewOf("expired")]) {
      const h = await harness({ polls: [running(), final, running(), ready()], download: file });
      expect(await h.run(args(h))).not.toBe(0);
      expect(polls(h)).toHaveLength(2);
    }
    const done = await harness({ polls: [ready(), running()], download: file });
    expect(await done.run(args(done))).toBe(0);
    expect(polls(done)).toHaveLength(1);
  });

  it("checks the reason, ticket and range locally before starting anything", async () => {
    const noReason = await harness();
    expect(await noReason.run(["admin", "audit", "export", ORG, "--from", "1", "--to", "40", "--out", join(noReason.home, "x.gz")])).toBe(7);
    expect(noReason.calls).toHaveLength(0);
    const badTicket = await harness();
    expect(await badTicket.run(args(badTicket).map((word) => (word === "LEGAL-9" ? "has space" : word)))).toBe(2);
    expect(badTicket.calls).toHaveLength(0);
    const badRange = await harness();
    expect(await badRange.run(args(badRange).map((word) => (word === "40" ? "0" : word)))).toBe(7);
    expect(badRange.calls).toHaveLength(0);
  });

  it("does not poll a 503 from the fail-closed path as success: it tries again shortly, then stops", async () => {
    const unavailable = () => reply({ error: { code: "AUDIT_UNAVAILABLE", message: AUDIT_ERROR_MESSAGES.AUDIT_UNAVAILABLE } }, 503);
    const h = await harness({ polls: [unavailable(), ready()], download: file });
    expect(await h.run(args(h))).toBe(0);
    expect(polls(h)).toHaveLength(2);
    expect(h.sleeps.every((ms) => ms >= 10_000)).toBe(true);
  });
});

// ---- fix round 1 ------------------------------------------------------------------------------------------------------

describe("error messages from the control plane are untrusted too", () => {
  const hostile = `bad\u009b31m range${RLO} \u001b[2J${ZWSP}end`;
  const refusal = (code: string, status: number) => reply({ error: { code, message: hostile } }, status);

  it("marks C1, bidi, zero-width and ANSI characters in a member's error, in text and --json", async () => {
    const text = await harness({ records: [refusal("AUDIT_RANGE_INVALID", 400)] });
    expect(await text.run(["audit", "log"])).not.toBe(0);
    expect(unsafe(text.errors())).toBe(false);
    for (const marker of ["[U+009B]", "[U+202E]", "[U+200B]"]) expect(text.errors(), marker).toContain(marker);
    const json = await harness({ records: [refusal("AUDIT_RANGE_INVALID", 400)] });
    expect(await json.run(["audit", "log", "--json"])).not.toBe(0);
    expect(unsafe(json.errors())).toBe(false);
    expect((JSON.parse(json.errors()) as { error: { message: string } }).error.message).toContain("[U+009B]");
  });

  it("marks them in a staff error (log, and an export start), in text and --json", async () => {
    const log = await harness({ records: [refusal("FORBIDDEN", 403)] });
    expect(await log.run(["admin", "audit", "log", ORG, "--reason", "ok"])).toBe(4);
    expect(unsafe(log.errors())).toBe(false);
    expect(log.errors()).toContain("[U+009B]");
    expect(log.errors()).toContain("[U+202E]");
    const start = await harness({ start: refusal("AUDIT_UNAVAILABLE", 503) });
    expect(await start.run(["admin", "audit", "export", ORG, "--from", "1", "--to", "40", "--reason", "ok", "--out", join(start.home, "x.gz"), "--json"])).not.toBe(0);
    expect(unsafe(start.errors())).toBe(false);
    expect((JSON.parse(start.errors()) as { error: { message: string } }).error.message).toContain("[U+009B]");
  });
});

describe("terminalSafe", () => {
  it("cuts a very long value and says so, and marks invisible fillers and private-use characters", () => {
    const long = terminalSafe("a".repeat(5000));
    expect(long.length).toBeLessThan(600);
    expect(long).toContain("[truncated]");
    expect(terminalSafe("a".repeat(500))).toBe("a".repeat(500));
    const marked = terminalSafe(`x⠀yㅤzw͏`);
    expect(marked).toBe("x[U+2800]y[U+3164]z[U+E000]w[U+034F]");
  });
});

describe("a downloaded export is checked before it is called saved", () => {
  const good = buildAuditFixture();
  const file = gz(good.bundle);
  const exportArgs = (h: Harness, ...more: string[]) => ["audit", "export", "--from", "1", "--to", "40", "--out", join(h.home, "audit.json.gz"), ...more];
  const noFile = async (h: Harness) => expect(stat(join(h.home, "audit.json.gz"))).rejects.toThrow();

  it("refuses a body that is not the size the control plane reported", async () => {
    const html = Buffer.from("<html>proxy error</html>");
    const h = await harness({ download: html, polls: [ready({ summary: { ...SUMMARY, bytes: file.length } })] });
    expect(await h.run(exportArgs(h))).toBe(6);
    expect(h.errors()).toContain(`${html.length} bytes`);
    expect(h.text()).toBe("");
    await noFile(h);
  });

  it("refuses a body of the right size that is not an audit export", async () => {
    const html = Buffer.from("<html>proxy error</html>");
    const h = await harness({ download: html, polls: [ready({ summary: { ...SUMMARY, bytes: html.length } })] });
    expect(await h.run(exportArgs(h))).toBe(6);
    expect(h.errors()).toContain("not a readable audit export");
    expect(h.text()).not.toContain("Saved");
    await noFile(h);
  });

  it("gives a retryable error, not an internal one, when the body is cut off mid-transfer", async () => {
    const cut = new Response(new ReadableStream({ start(controller) { controller.enqueue(file.subarray(0, 10)); controller.error(new TypeError("terminated")); } }));
    const h = await harness({ download: cut });
    expect(await h.run(exportArgs(h))).toBe(6);
    expect(h.errors()).toContain("cut off");
    expect(h.errors()).not.toContain("INTERNAL_ERROR");
    await noFile(h);
  });

  it("refuses a download that redirects, naming why, and asks for it with no redirects followed", async () => {
    const h = await harness({ download: new Response(null, { status: 302, headers: { location: "http://internal.test/export" } }) });
    expect(await h.run(exportArgs(h))).toBe(6);
    expect(h.errors()).toContain("redirect");
    expect(h.fetchImplementation.mock.calls.filter(([input]) => input === SIGNED).every(([, init]) => init?.redirect === "manual")).toBe(true);
    await noFile(h);
  });

  it("refuses a body announced as larger than an export can be, and stops reading one that grows past the limit", async () => {
    const huge = await harness({ download: new Response("x", { headers: { "content-length": String(10 ** 10) } }) });
    expect(await huge.run(exportArgs(huge))).toBe(6);
    expect(huge.errors()).toContain("larger than an export can be");
    await noFile(huge);
    const runtime = { fetch: (async () => new Response(new Uint8Array(100))) as typeof fetch, sleep: async () => undefined, newRequestId: () => "x" };
    await expect(downloadExport(runtime, SIGNED, 50)).rejects.toThrow(/RUNTIME_UNAVAILABLE: .*larger than an export can be/);
    await expect(downloadExport(runtime, SIGNED, 100)).resolves.toHaveLength(100);
  });

  it("says why an oversize or damaged gzip cannot be read", () => {
    const problemOf = (bytes: Buffer, limit?: number): string => {
      const result = parseExportBytes(bytes, limit);
      return "problem" in result ? result.problem : "";
    };
    expect(problemOf(gzipSync(Buffer.alloc(10_000)), 1000)).toContain("larger than an export can be");
    expect(problemOf(Buffer.from("<html>"))).toContain("not JSON");
    expect(problemOf(gzipSync(Buffer.from(JSON.stringify({ format: "other" }))))).toContain("version 1 audit export");
    expect(parseExportBytes(file)).toHaveProperty("bundle");
  });

  it("refuses a poll that answers for another export than the one started", async () => {
    const h = await harness({ download: file, polls: [{ ...ready(), exportId: `aex_${"f".repeat(32)}` }] });
    expect(await h.run(exportArgs(h))).toBe(6);
    expect(downloads(h)).toHaveLength(0);
  });

  it("saves a staff export for its owner only", async () => {
    const h = await harness({ download: file });
    const out = join(h.home, "staff.json.gz");
    expect(await h.run(["admin", "audit", "export", ORG, "--from", "1", "--to", "40", "--reason", "ok", "--out", out])).toBe(0);
    expect(await mode(out)).toBe(0o600);
  });

  it("refuses a symlink at --out, dangling or not, before calling anything", async () => {
    const h = await harness({ download: file });
    const dangling = join(h.home, "dangling.gz");
    await symlink(join(h.home, "nowhere"), dangling);
    expect(await h.run(["audit", "export", "--from", "1", "--to", "40", "--out", dangling])).toBe(2);
    expect(h.calls).toHaveLength(0);
    await expect(stat(join(h.home, "nowhere"))).rejects.toThrow();
  });

  it("refuses a --trust file whose certificate cannot be read, before exporting", async () => {
    const h = await harness({ download: file });
    const pem = join(h.home, "broken.pem");
    await writeFile(pem, "-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n");
    expect(await h.run(["audit", "verify", "--from", "1", "--to", "40", "--trust", `${TSA_LABEL}=${pem}`])).toBe(2);
    expect(h.errors()).toContain("cannot be read");
    expect(h.calls).toHaveLength(0);
  });
});

describe("agentx audit verify checks what was asked for", () => {
  const good = buildAuditFixture();
  const pem = async (h: Harness) => {
    const path = join(h.home, "root.pem");
    await writeFile(path, good.pki.root.x509.toString());
    return ["--trust", `${TSA_LABEL}=${path}`];
  };
  const verify = async (bundle: unknown, from: string, to: string, tokenOrg?: string, extra: string[] = []) => {
    const h = await harness({ download: gz(bundle) }, [], tokenOrg);
    const code = await h.run(["audit", "verify", "--from", from, "--to", to, ...(await pem(h)), ...extra]);
    return { h, code };
  };

  it("passes when the export covers the range, or more (an export is cut at seal boundaries)", async () => {
    const exact = await verify(good.bundle, "1", "40");
    expect(exact.code).toBe(0);
    expect(exact.h.text()).toMatch(/^ok {3}range: /m);
    expect((await verify(good.bundle, "15", "30")).code).toBe(0);
  });

  it("fails when the export starts after the first requested record", async () => {
    const later = buildAuditFixture({ exportFrom: 21 });
    const { h, code } = await verify(later.bundle, "1", "40");
    expect(code).toBe(1);
    expect(h.text()).toMatch(/^FAIL range: .*21.*1/m);
    expect(h.text()).not.toContain("Sealed and checked");
    expect((await verify(later.bundle, "21", "40")).code).toBe(0);
  });

  it("fails when the export stops before the last requested record", async () => {
    const { h, code } = await verify(good.bundle, "1", "60");
    expect(code).toBe(1);
    expect(h.text()).toMatch(/^FAIL range: .*40.*60/m);
  });

  it("fails on an export with no records", async () => {
    const empty = buildAuditFixture({ recordsA: 0, sealsA: [] });
    const { h, code } = await verify(empty.bundle, "1", "5");
    expect(code).toBe(1);
    expect(h.text()).toMatch(/^FAIL range: .*no records/m);
  });

  it("fails on another organization's export when the sign-in names the person's organization", async () => {
    const other = await verify(good.bundle, "1", "40", "org-z");
    expect(other.code).toBe(1);
    expect(other.h.text()).toMatch(/^FAIL organization: /m);
    const same = await verify(good.bundle, "1", "40", "org-a");
    expect(same.code).toBe(0);
    expect(same.h.text()).toMatch(/^ok {3}organization: /m);
  });

  it("fails when a --trust label matches no timestamp in the export", async () => {
    const relabelled = cloneBundle(good.bundle);
    for (const entry of relabelled.seals) for (const stamp of entry.timestamps) stamp.tsa = "acme";
    const { h, code } = await verify(relabelled, "1", "40");
    expect(code).toBe(1);
    expect(h.text()).toMatch(/^FAIL trust: .*digicert/m);
  });
});

describe("a staff export polls less often the longer it waits", () => {
  it("is every 10 seconds for the first 2 minutes, then every 30", async () => {
    const waiting = Array.from({ length: 16 }, running);
    const h = await harness({ polls: [...waiting, ready()], download: gz(buildAuditFixture().bundle) });
    expect(await h.run(["admin", "audit", "export", ORG, "--from", "1", "--to", "40", "--reason", "ok", "--out", join(h.home, "s.gz")])).toBe(0);
    expect(h.sleeps.slice(0, 12)).toEqual(Array(12).fill(10_000));
    expect(h.sleeps.slice(12)).toEqual(Array(5).fill(30_000));
  });

  it("stays at 3 seconds for a member", async () => {
    const h = await harness({ polls: [...Array.from({ length: 50 }, running), ready()], download: gz(buildAuditFixture().bundle) });
    expect(await h.run(["audit", "export", "--from", "1", "--to", "40", "--out", join(h.home, "m.gz")])).toBe(0);
    expect(new Set(h.sleeps)).toEqual(new Set([3000]));
  });
});

// ---- the MCP tool -----------------------------------------------------------------------------------------------------

describe("agentx_audit_status", () => {
  const STATUS = { headSeq: 12, sealedThroughSeq: 10, latestTimestamp: "2026-10-20T12:01:30.000Z", lockMode: "COMPLIANCE", epochsWithoutTimestamp: ["e20261020T1215Z"], limits: AUDIT_LIMITS_COPY };

  async function connect(status: number, body: unknown) {
    const requests: Array<{ method: string; url: string; authorization: string | null }> = [];
    const client = httpControlPlaneClient({
      session: async () => ({ baseUrl: URL_, accessToken: "mcp-access", signInCommand: "npx rovara login" }),
      fetch: vi.fn<typeof fetch>(async (input, init) => {
        requests.push({ method: init?.method ?? "GET", url: input instanceof URL ? input.href : typeof input === "string" ? input : input.url, authorization: new Headers(init?.headers).get("authorization") });
        return Response.json(body, { status });
      }),
      sleep: async () => undefined,
      tries: 1,
    });
    const context = (name: string | undefined): ToolContext => ({
      client, clientName: name, serverVersion: "0.4.0", adminSignedIn: async () => false,
      compatibility: async () => ({ env: "staging", apiVersion: "1.2" }),
      now: () => 0, sleep: async () => undefined, newRequestId: () => "33333333-3333-4333-8333-333333333333",
    });
    const server = createAgentXMcpServer({ version: "0.4.0", context });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const mcp = new Client({ name: "claude-code", version: "1.0.0" });
    await mcp.connect(clientSide);
    await mcp.listTools();
    return { mcp, requests };
  }

  it("is a developer tool that takes no input", async () => {
    const { mcp } = await connect(200, STATUS);
    const { tools } = await mcp.listTools();
    const tool = tools.find((candidate) => candidate.name === "agentx_audit_status");
    expect(tool).toBeDefined();
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([]);
    expect(tool?.description).toMatch(/owner|admin/i);
  });

  it("returns what the status route says, for an owner or admin", async () => {
    const { mcp, requests } = await connect(200, STATUS);
    const result = CallToolResultSchema.parse(await mcp.callTool({ name: "agentx_audit_status", arguments: {} }));
    expect(requests).toEqual([{ method: "GET", url: `${URL_}/v1/dev/org/audit/status`, authorization: "Bearer mcp-access" }]);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      head_seq: 12, sealed_through_seq: 10, unsealed_count: 2, latest_timestamp: "2026-10-20T12:01:30.000Z", lock_mode: "COMPLIANCE",
      epochs_without_timestamp: ["e20261020T1215Z"], limits: AUDIT_LIMITS_COPY,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Sealed through record 10 of 12");
    expect(text).toContain(AUDIT_LIMITS_COPY);
  });

  it("returns the FORBIDDEN text to a contributor", async () => {
    const { mcp } = await connect(403, FORBIDDEN_BODY);
    const result = CallToolResultSchema.parse(await mcp.callTool({ name: "agentx_audit_status", arguments: {} }));
    expect(result.isError).toBe(true);
    // The server drops a message's closing full stop and puts "Next step" after it.
    expect(toolError(result).message).toBe(AUDIT_ORG_FORBIDDEN.replace(/\.$/, ""));
  });
});
