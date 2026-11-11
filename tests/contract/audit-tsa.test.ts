// tests/contract/audit-tsa.test.ts
// Task 10 of the Audit Ledger plan: timestamps for the epochs, from DigiCert and Sectigo, from a customer's own authorities,
// or none. The authorities are fake (tests/support/fake-tsa.ts and fake-tsa-server.ts: tokens from a fake PKI, answers that go
// wrong in every way the verifier checks); no request leaves the machine. Time is the harness's fake clock, which the stamping
// sleeps advance, so "15 seconds apart" is read off the clock.
import type { X509Certificate } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import {
  buildTimeStampRequest,
  defaultAnchors,
  genesisHash,
  inclusionPath,
  parseTimeStampResponse,
  sealLeafData,
  statementHash,
  verifyBundle,
  verifyTimeStampToken,
  type AuditBundleV1,
  type BundleSeal,
  type BundleTimestamp,
  type EpochStatementV1,
  type LockedObjectV1,
  type OrgSealV1,
} from "@rovara/audit-verifier";
import { AUDIT_TSA_ENDPOINTS, AUDIT_TSA_SPACING_MS, AUDIT_TSA_TIMEOUT_MS } from "@agentx/cloud-contracts";
import { epochIdAt, leavesObjectKey, lockedPutInput, sealObjectKey, statementObjectKey, tokenObjectKey } from "../../packages/broker/src/audit/anchor.js";
import {
  TsaError,
  customTsaSettings,
  loadTsaDeps,
  publicTsaSettings,
  requestTimestamp,
  type TsaDeps,
  type TsaSettings,
} from "../../packages/broker/src/audit/tsa-client.js";
import { REAL_TIMESTAMP_HASH_HEX, REAL_TIMESTAMP_NONCE, REAL_TIMESTAMP_RESPONSES } from "../support/real-timestamp-responses.js";
import { makePki } from "../support/fake-tsa.js";
import { fakeTsaHost, type FakeTsaHost, type TsaBehavior } from "../support/fake-tsa-server.js";
import { routeFetch } from "../support/developer-fakes.js";
import {
  A, B, BUCKET, E0, E1, E2, at, appendRecords, epochHead, eventsOf, harness, intentOf, iso, metaOf, run, snapshot, storedRecords, crash,
  type Harness,
} from "../support/audit-anchor-harness.js";

const DIGICERT = AUDIT_TSA_ENDPOINTS.digicert;
const SECTIGO = AUDIT_TSA_ENDPOINTS.sectigo;
const HASH = "ab".repeat(32);

const rootOf = (host: FakeTsaHost): X509Certificate => host.pki.root.x509;

interface World {
  h: Harness;
  digicert: FakeTsaHost;
  sectigo: FakeTsaHost;
  fetch: ReturnType<typeof routeFetch>;
  settings: TsaSettings;
}

/** The anchor's bench with the two public authorities faked: each has its own PKI and the anchor trusts that root for that label only. */
function world(options: { timeoutMs?: number; digicert?: TsaBehavior; sectigo?: TsaBehavior; sweepKeysPerRun?: number } = {}): World {
  const h = harness(options.sweepKeysPerRun === undefined ? {} : { sweepKeysPerRun: options.sweepKeysPerRun });
  const digicert = fakeTsaHost({ url: DIGICERT, pki: makePki("DigiCert"), now: () => h.clock.now, behavior: options.digicert ?? "grant" });
  const sectigo = fakeTsaHost({ url: SECTIGO, pki: makePki("Sectigo"), now: () => h.clock.now, behavior: options.sectigo ?? "grant" });
  const fetch = routeFetch(digicert.handler, sectigo.handler);
  const settings: TsaSettings = {
    kind: "public",
    timeoutMs: options.timeoutMs ?? 2000,
    spacingMs: AUDIT_TSA_SPACING_MS,
    targets: [
      { label: "digicert", url: DIGICERT, anchors: [rootOf(digicert)] },
      { label: "sectigo", url: SECTIGO, anchors: [rootOf(sectigo)] },
    ],
  };
  h.deps.tsa = { settings, fetch, sleep: async (ms: number) => { h.clock.now += ms; }, clock: () => h.clock.now };
  return { h, digicert, sectigo, fetch, settings };
}

const tokenKeys = (h: Harness): string[] => [...h.s3.entries.keys()].filter((key) => key.endsWith(".tsr")).sort();
const failures = (h: Harness) => eventsOf(h, "audit.timestamp_failed");
const stampOf = (h: Harness, epochId: string, label: string) => metaOf(h, epochId)?.[`stamp#${label}`] as { object: LockedObjectV1; genTime: string } | undefined;
const statusOf = (h: Harness, epochId: string) => metaOf(h, epochId)?.status;

/** One org with records in epoch E0, sealed by a run at slot 0. */
async function sealFirstEpoch(w: World): Promise<void> {
  appendRecords(w.h, A, 3);
  w.h.clock.now = at(0);
  await run(w.h, at(0));
}

describe("requestTimestamp", () => {
  const digicert = (behavior: TsaBehavior = "grant") => {
    const clock = { now: Date.parse("2026-10-20T12:00:00Z") };
    const host = fakeTsaHost({ url: DIGICERT, pki: makePki("DigiCert"), now: () => clock.now, behavior });
    return { host, fetch: routeFetch(host.handler) };
  };

  it("POSTs an application/timestamp-query for exactly the hash it is given and returns the verified token", async () => {
    const { host, fetch } = digicert();
    const stamped = await requestTimestamp(fetch, "digicert", DIGICERT, HASH, { timeoutMs: 1000, nonce: 0x1234567890abcn, anchors: [rootOf(host)], clock: () => Date.parse("2026-10-20T12:00:00Z") });
    expect(host.requests).toHaveLength(1);
    expect(host.requests[0]).toMatchObject({ method: "POST", contentType: "application/timestamp-query", hashHex: HASH, nonce: 0x1234567890abcn });
    expect(stamped.genTime).toBe("2026-10-20T12:00:00.000Z");
    expect(verifyTimeStampToken(stamped.token, { hashHex: HASH, nonce: 0x1234567890abcn, anchors: [rootOf(host)] })).toMatchObject({ ok: true });
  });

  it.each([
    ["a rejection", "rejection", "rejection"],
    ["a granted answer without a token", "no-token", "malformed"],
    ["a token for another hash", "other-hash", "imprint"],
    ["a token with another nonce", "wrong-nonce", "nonce"],
    ["a token from a root this label does not trust", "wrong-root", "untrusted"],
    ["a signer certificate without the timestamping usage", "no-eku", "eku"],
    ["a signing-certificate attribute naming another certificate", "ess-mismatch", "signature"],
    ["an HTTP 500", "http-500", "http"],
    ["an HTML page", "html", "malformed"],
  ] as const)("throws a TsaError for %s", async (_name, behavior, problem) => {
    const { host, fetch } = digicert(behavior);
    const error = await requestTimestamp(fetch, "digicert", DIGICERT, HASH, { timeoutMs: 1000, nonce: 77n, anchors: [rootOf(host)] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TsaError);
    expect(error).toMatchObject({ label: "digicert", problem });
  });

  it("aborts at the timeout and says so", async () => {
    const { host, fetch } = digicert("hang");
    const started = Date.now();
    const error = await requestTimestamp(fetch, "digicert", DIGICERT, HASH, { timeoutMs: 40, nonce: 1n, anchors: [rootOf(host)] }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ label: "digicert", problem: "timeout" });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("calls a network failure `network`", async () => {
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(requestTimestamp(down, "sectigo", SECTIGO, HASH, { timeoutMs: 1000, nonce: 1n, anchors: [] })).rejects.toMatchObject({ label: "sectigo", problem: "network" });
  });

  it("refuses an answer that is far too large", async () => {
    const big = (async () => new Response(Buffer.alloc(2_000_000, 1), { status: 200 })) as unknown as typeof fetch;
    await expect(requestTimestamp(big, "sectigo", SECTIGO, HASH, { timeoutMs: 1000, nonce: 1n, anchors: [] })).rejects.toMatchObject({ problem: "malformed" });
  });

  it("cuts off a chunked body that has no Content-Length at the cap, after reading about that much and no more (review I3)", async () => {
    let pulled = 0;
    const endless = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 65_536;
        controller.enqueue(new Uint8Array(65_536).fill(7));
      },
    }), { status: 200 })) as unknown as typeof fetch;
    const started = Date.now();
    // The timeout is long: only the byte cap can end this quickly.
    await expect(requestTimestamp(endless, "sectigo", SECTIGO, HASH, { timeoutMs: 30_000, nonce: 1n, anchors: [] })).rejects.toMatchObject({ label: "sectigo", problem: "malformed" });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(pulled).toBeGreaterThan(1_000_000);
    expect(pulled).toBeLessThan(1_000_000 + 4 * 65_536 + 1);
  });

  it("cuts off a body larger than the Content-Length it declared", async () => {
    let pulled = 0;
    const liar = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 100_000;
        controller.enqueue(new Uint8Array(100_000));
      },
    }), { status: 200, headers: { "content-length": "100" } })) as unknown as typeof fetch;
    await expect(requestTimestamp(liar, "sectigo", SECTIGO, HASH, { timeoutMs: 30_000, nonce: 1n, anchors: [] })).rejects.toMatchObject({ problem: "malformed" });
    expect(pulled).toBeLessThan(1_500_000);
  });

  it("still reads a normal answer that arrives in several chunks", async () => {
    const { host, fetch } = digicert();
    const whole = await (await fetch(DIGICERT, { method: "POST", body: buildTimeStampRequest(HASH, 9n) })).arrayBuffer();
    const bytes = new Uint8Array(whole);
    const pieces = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 300) controller.enqueue(bytes.subarray(offset, offset + 300));
        controller.close();
      },
    }), { status: 200 })) as unknown as typeof fetch;
    const stamped = await requestTimestamp(pieces, "digicert", DIGICERT, HASH, { timeoutMs: 1000, nonce: 9n, anchors: [rootOf(host)], clock: () => Date.parse("2026-10-20T12:00:00Z") });
    expect(stamped.genTime).toBe("2026-10-20T12:00:00.000Z");
  });

  it("refuses a token dated more than 5 minutes before the last record it covers, or more than 5 minutes ahead of now, and keeps one inside the skew (review I1)", async () => {
    const { host, fetch } = digicert();
    const base = { timeoutMs: 1000, nonce: 3n, anchors: [rootOf(host)], clock: () => Date.parse("2026-10-20T12:00:00Z") };
    const recorded = (offsetMs: number): string => new Date(Date.parse("2026-10-20T12:00:00Z") + offsetMs).toISOString();
    await expect(requestTimestamp(fetch, "digicert", DIGICERT, HASH, { ...base, lastRecordedAt: recorded(5 * 60_000 + 1000) })).rejects.toMatchObject({ label: "digicert", problem: "gen_time" });
    await expect(requestTimestamp(fetch, "digicert", DIGICERT, HASH, { ...base, lastRecordedAt: recorded(4 * 60_000) })).resolves.toMatchObject({ genTime: "2026-10-20T12:00:00.000Z" });
    await expect(requestTimestamp(fetch, "digicert", DIGICERT, HASH, { ...base, clock: () => Date.parse("2026-10-20T11:50:00Z") })).rejects.toMatchObject({ problem: "gen_time" });
    await expect(requestTimestamp(fetch, "digicert", DIGICERT, HASH, { ...base, clock: () => Date.parse("2026-10-20T11:56:00Z") })).resolves.toMatchObject({ genTime: "2026-10-20T12:00:00.000Z" });
  });

  it("refuses a token dated more than 5 minutes before the request was made, with no record to compare it to (review N1: the sanity floor)", async () => {
    const { host, fetch } = digicert();
    const base = { timeoutMs: 1000, nonce: 3n, anchors: [rootOf(host)] };
    await expect(requestTimestamp(fetch, "digicert", DIGICERT, HASH, { ...base, clock: () => Date.parse("2026-10-20T12:10:00Z") })).rejects.toMatchObject({ label: "digicert", problem: "gen_time" });
    await expect(requestTimestamp(fetch, "digicert", DIGICERT, HASH, { ...base, clock: () => Date.parse("2026-10-20T12:04:00Z") })).resolves.toMatchObject({ genTime: "2026-10-20T12:00:00.000Z" });
  });

  it("verifies the real DigiCert and Sectigo answers under each label's pinned root, and only under its own", async () => {
    const answer = (label: "digicert" | "sectigo") => (async () => new Response(Buffer.from(REAL_TIMESTAMP_RESPONSES[label].base64, "base64"), { status: 200 })) as unknown as typeof fetch;
    const anchors = defaultAnchors();
    for (const label of ["digicert", "sectigo"] as const) {
      const options = { timeoutMs: 1000, nonce: REAL_TIMESTAMP_NONCE, anchors: anchors[label], clock: () => Date.parse(REAL_TIMESTAMP_RESPONSES[label].genTime) };
      const stamped = await requestTimestamp(answer(label), label, AUDIT_TSA_ENDPOINTS[label], REAL_TIMESTAMP_HASH_HEX, options);
      expect(stamped.genTime).toBe(REAL_TIMESTAMP_RESPONSES[label].genTime);
      expect(parseTimeStampResponse(new Uint8Array(Buffer.from(REAL_TIMESTAMP_RESPONSES[label].base64, "base64"))).token).toBeDefined();
      const other = label === "digicert" ? "sectigo" : "digicert";
      await expect(requestTimestamp(answer(label), label, AUDIT_TSA_ENDPOINTS[label], REAL_TIMESTAMP_HASH_HEX, { ...options, anchors: anchors[other] })).rejects.toMatchObject({ problem: "untrusted" });
    }
  });
});

describe("the settings", () => {
  it("public: DigiCert and Sectigo at the plan's endpoints, each with only its own pinned root, with the plan's timeout and spacing", () => {
    const settings = publicTsaSettings();
    expect(settings).toMatchObject({ kind: "public", timeoutMs: AUDIT_TSA_TIMEOUT_MS, spacingMs: AUDIT_TSA_SPACING_MS });
    if (settings.kind === "off") throw new Error("unreachable");
    expect(settings.targets.map((target) => [target.label, target.url])).toStrictEqual([["digicert", DIGICERT], ["sectigo", SECTIGO]]);
    const pinned = defaultAnchors();
    expect(settings.targets[0]!.anchors.map((root) => root.fingerprint256)).toStrictEqual(pinned.digicert.map((root) => root.fingerprint256));
    expect(settings.targets[1]!.anchors.map((root) => root.fingerprint256)).toStrictEqual(pinned.sectigo.map((root) => root.fingerprint256));
  });

  const pkiOne = makePki("Customer One");
  const pkiTwo = makePki("Customer Two");
  const pem = (pki: ReturnType<typeof makePki>) => pki.root.x509.toString();

  it("custom: custom-1 and custom-2 in URL order, one PEM bundle per URL, from a JSON list", () => {
    const settings = customTsaSettings(["https://tsa-1.example.test/ts", "https://tsa-2.example.test/ts"], JSON.stringify([pem(pkiOne), pem(pkiTwo)]));
    if (settings.kind === "off") throw new Error("unreachable");
    expect(settings.kind).toBe("custom");
    expect(settings.targets.map((target) => target.label)).toStrictEqual(["custom-1", "custom-2"]);
    expect(settings.targets[0]!.anchors.map((root) => root.fingerprint256)).toStrictEqual([pkiOne.root.x509.fingerprint256]);
    expect(settings.targets[1]!.anchors.map((root) => root.fingerprint256)).toStrictEqual([pkiTwo.root.x509.fingerprint256]);
    expect(settings.timeoutMs).toBe(AUDIT_TSA_TIMEOUT_MS);
  });

  it("custom: one URL may take plain PEM text; two URLs may not", () => {
    const one = customTsaSettings(["https://tsa.example.test/ts"], `${pem(pkiOne)}\n${pem(pkiTwo)}`);
    if (one.kind === "off") throw new Error("unreachable");
    expect(one.targets).toHaveLength(1);
    expect(one.targets[0]!.anchors).toHaveLength(2);
    expect(() => customTsaSettings(["https://a.example.test", "https://b.example.test"], pem(pkiOne))).toThrow(/one PEM bundle per URL/);
  });

  it.each([
    ["a list of the wrong length", JSON.stringify([pem(pkiOne)]), ["https://a.example.test", "https://b.example.test"]],
    ["text with no certificate", "not a certificate", ["https://a.example.test"]],
    ["an empty bundle in the list", JSON.stringify([pem(pkiOne), ""]), ["https://a.example.test", "https://b.example.test"]],
    ["a list entry that is not text", JSON.stringify([pem(pkiOne), 7]), ["https://a.example.test", "https://b.example.test"]],
  ])("custom: refuses %s", (_name, text, urls) => {
    expect(() => customTsaSettings(urls, text)).toThrow();
  });
});

describe("loading the settings from the function's environment", () => {
  const pkiOne = makePki("Customer One");
  const logs: Array<Record<string, unknown>> = [];
  const log = (entry: Record<string, unknown>) => { logs.push(entry); };
  const never = (async () => { throw new Error("no request expected"); }) as unknown as typeof fetch;

  it("public reads no parameter; off reads none and asks for nothing", async () => {
    const read = vi.fn((name: string) => Promise.resolve(name === "" ? "" : "x"));
    const publicDeps = await loadTsaDeps({ AUDIT_TSA_KIND: "public", AUDIT_TSA_TIMEOUT_MS: "10000", AUDIT_TSA_SPACING_MS: "15000" }, { readParameter: read, fetch: never, log });
    expect(publicDeps.settings.kind).toBe("public");
    const off = await loadTsaDeps({ AUDIT_TSA_KIND: "off", AUDIT_TSA_TIMEOUT_MS: "10000", AUDIT_TSA_SPACING_MS: "15000" }, { readParameter: read, fetch: never, log });
    expect(off.settings).toStrictEqual({ kind: "off" });
    expect(read).not.toHaveBeenCalled();
  });

  it("custom reads exactly the configured roots parameter, once", async () => {
    const read = vi.fn((name: string) => Promise.resolve(name === "" ? "" : pkiOne.root.x509.toString()));
    const deps = await loadTsaDeps({
      AUDIT_TSA_KIND: "custom", AUDIT_TSA_URLS: "https://tsa.example.test/ts", AUDIT_TSA_ROOTS_PARAMETER: "/agentx/acme/tsa-roots",
      AUDIT_TSA_TIMEOUT_MS: "10000", AUDIT_TSA_SPACING_MS: "15000",
    }, { readParameter: read, fetch: never, log });
    expect(read.mock.calls).toStrictEqual([["/agentx/acme/tsa-roots"]]);
    expect(deps.settings).toMatchObject({ kind: "custom", targets: [{ label: "custom-1", url: "https://tsa.example.test/ts" }] });
  });

  it("does not stop the function when the roots cannot be read: every label is unavailable, no request is made, and the failure is logged", async () => {
    logs.length = 0;
    const read = vi.fn((name: string): Promise<string> => Promise.reject(Object.assign(new Error(`ParameterNotFound ${name}`), { name: "ParameterNotFound" })));
    const deps = await loadTsaDeps({
      AUDIT_TSA_KIND: "custom", AUDIT_TSA_URLS: "https://a.example.test/ts, https://b.example.test/ts", AUDIT_TSA_ROOTS_PARAMETER: "/r",
      AUDIT_TSA_TIMEOUT_MS: "10000", AUDIT_TSA_SPACING_MS: "15000",
    }, { readParameter: read, fetch: never, log });
    if (deps.settings.kind === "off") throw new Error("unreachable");
    expect(deps.settings.targets.map((target) => [target.label, target.unavailable])).toStrictEqual([["custom-1", "roots_unavailable"], ["custom-2", "roots_unavailable"]]);
    expect(logs).toMatchObject([{ event: "audit.timestamp_failed", level: "error", label: "all", problem: "roots_unavailable" }]);
  });

  it.each([
    ["no kind", {}],
    ["an unknown kind", { AUDIT_TSA_KIND: "freetsa" }],
    ["custom without URLs", { AUDIT_TSA_KIND: "custom", AUDIT_TSA_ROOTS_PARAMETER: "/r" }],
    ["custom without the parameter", { AUDIT_TSA_KIND: "custom", AUDIT_TSA_URLS: "https://a.example.test" }],
    ["three URLs", { AUDIT_TSA_KIND: "custom", AUDIT_TSA_URLS: "https://a.example.test,https://b.example.test,https://c.example.test", AUDIT_TSA_ROOTS_PARAMETER: "/r" }],
    ["a URL that is not http(s)", { AUDIT_TSA_KIND: "custom", AUDIT_TSA_URLS: "ftp://a.example.test", AUDIT_TSA_ROOTS_PARAMETER: "/r" }],
    ["a malformed timeout", { AUDIT_TSA_KIND: "public", AUDIT_TSA_TIMEOUT_MS: "soon" }],
    ["a missing spacing", { AUDIT_TSA_KIND: "public", AUDIT_TSA_SPACING_MS: undefined }],
  ] as const)("does not start with %s", async (_name, environment) => {
    await expect(loadTsaDeps({ AUDIT_TSA_TIMEOUT_MS: "10000", AUDIT_TSA_SPACING_MS: "15000", ...environment }, { readParameter: async () => "", fetch: never, log })).rejects.toThrow(/audit anchor/);
  });
});

describe("stamping an epoch with both public authorities", () => {
  it("stores one token per authority, create-only, and seals the epoch; the requests carry exactly the statement hash", async () => {
    const w = world();
    await sealFirstEpoch(w);
    expect(tokenKeys(w.h)).toStrictEqual([tokenObjectKey(E0, "digicert"), tokenObjectKey(E0, "sectigo")]);
    expect(tokenObjectKey(E0, "digicert")).toBe("epochs/2026/10/20/e20261020T1200Z.digicert.tsr");
    const statement = JSON.parse(w.h.s3.currentText(statementObjectKey(E0))!) as EpochStatementV1;
    for (const host of [w.digicert, w.sectigo]) {
      expect(host.requests).toHaveLength(1);
      expect(host.requests[0]).toMatchObject({ method: "POST", contentType: "application/timestamp-query", hashHex: statementHash(statement) });
      expect(host.requests[0]!.nonce).toBeGreaterThan(0n);
    }
    expect(w.digicert.requests[0]!.nonce).not.toBe(w.sectigo.requests[0]!.nonce);
    expect(statusOf(w.h, E0)).toBe("sealed");
    expect(epochHead(w.h)).toMatchObject({ epochId: E0 });
    expect(failures(w.h)).toStrictEqual([]);
    // Each token verifies offline under its own label's root, and the object is what the stamp names.
    for (const host of [w.digicert, w.sectigo]) {
      const label = host === w.digicert ? "digicert" : "sectigo";
      const key = tokenObjectKey(E0, label);
      const version = w.h.s3.versionsOf(key);
      expect(version).toHaveLength(1);
      expect(verifyTimeStampToken(new Uint8Array(version[0]!.body), { hashHex: statementHash(statement), anchors: [rootOf(host)] })).toMatchObject({ ok: true });
      expect(stampOf(w.h, E0, label)).toMatchObject({ object: { key, versionId: version[0]!.versionId, lockMode: "COMPLIANCE" }, genTime: expect.stringMatching(/^2026-/) as unknown });
    }
  });

  it("writes each token with the same create-only, checksummed request as every other object", async () => {
    const w = world();
    await sealFirstEpoch(w);
    const puts = w.h.s3.putCalls().filter((call) => call.key?.endsWith(".tsr"));
    expect(puts).toHaveLength(2);
    for (const put of puts) {
      expect(put.input).toMatchObject({ IfNoneMatch: "*", ChecksumAlgorithm: "SHA256" });
      expect(put.input.ObjectLockMode).toBeUndefined();
      expect(put.input.ObjectLockRetainUntilDate).toBeUndefined();
    }
  });

  it("does not stamp an idle run, and never asks twice for an epoch that has its tokens", async () => {
    const w = world();
    await sealFirstEpoch(w);
    w.h.clock.now = at(1);
    const result = await run(w.h, at(1));
    expect(result).toMatchObject({ status: "idle" });
    expect(w.digicert.requests).toHaveLength(1);
    expect(w.sectigo.requests).toHaveLength(1);
  });

  it("makes an export that passes the offline verifier with the stamps, for epochs sealed over several runs", async () => {
    const w = world();
    await sealFirstEpoch(w);
    for (const slot of [1, 2]) {
      w.h.clock.now = at(slot);
      appendRecords(w.h, A, 2);
      await run(w.h, at(slot));
    }
    const bundle = exportBundle(w.h, A, w.settings);
    const report = verifyBundle(bundle, { anchors: anchorsOf(w) });
    expect(report.checks.filter((check) => !check.ok), JSON.stringify(report.checks)).toStrictEqual([]);
    expect(report).toMatchObject({ ok: true, sealedThroughSeq: 7, coveredEpochs: [], epochsWithoutTimestamp: [] });
    expect(report.timestampedThrough).toBeDefined();
    expect(bundle.seals.map((entry) => entry.timestamps.map((stamp) => stamp.tsa))).toStrictEqual([["digicert", "sectigo"], ["digicert", "sectigo"], ["digicert", "sectigo"]]);
  });
});

describe("Review Focus 3: one authority down", () => {
  it("stores the other's token, leaves the epoch stamp_pending and logs one failure; the next run stamps the missing one and seals", async () => {
    const w = world({ timeoutMs: 40, digicert: "hang" });
    appendRecords(w.h, A, 3);
    w.h.clock.now = at(0);
    const first = await run(w.h, at(0));
    expect(first).toMatchObject({ status: "stamp_pending", epochs: [{ epochId: E0, status: "stamp_pending" }] });
    expect(tokenKeys(w.h)).toStrictEqual([tokenObjectKey(E0, "sectigo")]);
    expect(statusOf(w.h, E0)).toBe("stamp_pending");
    expect(stampOf(w.h, E0, "sectigo")).toBeDefined();
    expect(stampOf(w.h, E0, "digicert")).toBeUndefined();
    expect(failures(w.h)).toStrictEqual([{ event: "audit.timestamp_failed", level: "warn", label: "digicert", problem: "timeout", epochId: E0 }]);
    // Sealing was not held back: the org is sealed and the epoch is the head.
    expect(epochHead(w.h)).toMatchObject({ epochId: E0 });
    expect(intentOf(w.h, E0, A)).toMatchObject({ finalized: true });

    w.digicert.behavior = "grant";
    w.h.clock.now = at(1);
    const second = await run(w.h, at(1));
    expect(second.status).toBe("idle");
    expect(statusOf(w.h, E0)).toBe("sealed");
    expect(tokenKeys(w.h)).toStrictEqual([tokenObjectKey(E0, "digicert"), tokenObjectKey(E0, "sectigo")]);
    // Only the missing token was asked for: Sectigo saw its one request, DigiCert two (the timeout and the retry).
    expect(w.sectigo.requests).toHaveLength(1);
    expect(w.digicert.requests).toHaveLength(2);
    expect(failures(w.h)).toHaveLength(1);
  });

  it("the new epoch of a later run is stamped as well as the pending one, and both end sealed", async () => {
    const w = world({ timeoutMs: 40, digicert: "hang" });
    appendRecords(w.h, A, 3);
    w.h.clock.now = at(0);
    await run(w.h, at(0));
    w.digicert.behavior = "grant";
    w.h.clock.now = at(1);
    appendRecords(w.h, A, 2);
    const result = await run(w.h, at(1));
    expect(result).toMatchObject({ status: "sealed", epochs: [{ epochId: E1, status: "sealed" }] });
    expect(statusOf(w.h, E0)).toBe("sealed");
    expect(statusOf(w.h, E1)).toBe("sealed");
    expect(metaOf(w.h, E0)?.covered_by).toBeUndefined();
  });

  it("runs the two authorities in parallel: Sectigo is asked while DigiCert is still being waited for", async () => {
    const w = world({ timeoutMs: 1500, digicert: "hang" });
    appendRecords(w.h, A, 3);
    w.h.clock.now = at(0);
    const running = run(w.h, at(0));
    await vi.waitFor(() => { expect(w.sectigo.requests).toHaveLength(1); }, { timeout: 700, interval: 10 });
    expect(w.digicert.requests).toHaveLength(1);
    await running;
    expect(stampOf(w.h, E0, "sectigo")).toBeDefined();
  });
});

describe("bad answers are rejected and nothing is stored", () => {
  it.each([
    ["a rejection", "rejection", "rejection"],
    ["a token for another hash", "other-hash", "imprint"],
    ["a token with another nonce", "wrong-nonce", "nonce"],
    ["a token from the wrong root for the label", "wrong-root", "untrusted"],
    ["a signer without the timestamping usage", "no-eku", "eku"],
    ["a signing-certificate attribute that names another certificate", "ess-mismatch", "signature"],
    ["a token missing from a granted answer", "no-token", "malformed"],
    ["an HTTP error", "http-500", "http"],
    ["an HTML page", "html", "malformed"],
  ] as const)("%s from DigiCert: no object, no stamp, one failure line, the epoch waits", async (_name, behavior, problem) => {
    const w = world({ digicert: behavior });
    await sealFirstEpoch(w);
    expect(tokenKeys(w.h)).toStrictEqual([tokenObjectKey(E0, "sectigo")]);
    expect(w.h.s3.versionsOf(tokenObjectKey(E0, "digicert"))).toHaveLength(0);
    expect(stampOf(w.h, E0, "digicert")).toBeUndefined();
    expect(statusOf(w.h, E0)).toBe("stamp_pending");
    expect(failures(w.h)).toStrictEqual([{ event: "audit.timestamp_failed", level: "warn", label: "digicert", problem, epochId: E0 }]);
  });

  it("a token Sectigo signed under DigiCert's URL (each label has its own root) is rejected", async () => {
    const w = world();
    // DigiCert's URL answers with a perfectly good token from Sectigo's PKI.
    w.digicert.behavior = "grant";
    const swapped = fakeTsaHost({ url: DIGICERT, pki: w.sectigo.pki, now: () => w.h.clock.now });
    w.h.deps.tsa = { ...(w.h.deps.tsa as TsaDeps), fetch: routeFetch(swapped.handler, w.sectigo.handler) };
    await sealFirstEpoch(w);
    expect(failures(w.h)).toMatchObject([{ label: "digicert", problem: "untrusted" }]);
    expect(tokenKeys(w.h)).toStrictEqual([tokenObjectKey(E0, "sectigo")]);
  });

  it("does not store a token while both authorities fail: the epoch is sealed and waits, with two failure lines", async () => {
    const w = world({ digicert: "rejection", sectigo: "html" });
    await sealFirstEpoch(w);
    expect(tokenKeys(w.h)).toStrictEqual([]);
    expect(statusOf(w.h, E0)).toBe("stamp_pending");
    expect(failures(w.h).map((entry) => [entry.label, entry.problem])).toStrictEqual([["digicert", "rejection"], ["sectigo", "malformed"]]);
    expect(epochHead(w.h)).toMatchObject({ epochId: E0 });
    expect(stateOfA(w.h)).toBe(3);
  });
});

const stateOfA = (h: Harness): unknown => h.db.get(`SEALED#${A}`, "STATE")?.sealedSeq;

describe("I11: no request storm after an outage", () => {
  const OUTAGE_EPOCHS = 300;

  /** 300 epochs sealed while both authorities refuse: org A has one record in each. Returns the most requests any run made to one label. */
  async function outage(w: World): Promise<number> {
    w.digicert.behavior = "rejection";
    w.sectigo.behavior = "rejection";
    let most = 0;
    for (let slot = 0; slot < OUTAGE_EPOCHS; slot += 1) {
      w.h.clock.now = at(slot);
      appendRecords(w.h, A, 1);
      const before = [w.digicert.requests.length, w.sectigo.requests.length];
      await run(w.h, at(slot));
      most = Math.max(most, w.digicert.requests.length - before[0]!, w.sectigo.requests.length - before[1]!);
    }
    return most;
  }

  const epochOf = (slot: number): string => epochIdAt(at(slot));
  const NEWEST = epochOf(OUTAGE_EPOCHS - 1);

  it("an outage of 300 epochs asks each authority at most twice per run, never twice within 15 seconds, and no epoch is sealed without a timestamp or cover", async () => {
    const w = world({ sweepKeysPerRun: 1 });
    const most = await outage(w);
    expect(most).toBeLessThanOrEqual(2);
    expect(Array.from({ length: OUTAGE_EPOCHS }, (_, slot) => statusOf(w.h, epochOf(slot)))).toStrictEqual(Array(OUTAGE_EPOCHS).fill("stamp_pending"));
    for (const host of [w.digicert, w.sectigo]) {
      const times = host.requests.map((request) => request.at);
      // Within one run the two requests are 15 s apart on the fake clock; between runs the slots are 15 minutes apart.
      for (let index = 1; index < times.length; index += 1) expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(AUDIT_TSA_SPACING_MS);
    }
    expect(tokenKeys(w.h)).toStrictEqual([]);
  }, 120_000);

  it("a quiet run after the outage stamps the newest pending epoch only, and the 299 older ones are covered by it and sealed; Task 3's verifier reports them covered", async () => {
    const w = world({ sweepKeysPerRun: 1 });
    await outage(w);
    w.digicert.behavior = "grant";
    w.sectigo.behavior = "grant";
    const before = [w.digicert.requests.length, w.sectigo.requests.length];
    w.h.clock.now = at(OUTAGE_EPOCHS);
    const result = await run(w.h, at(OUTAGE_EPOCHS));
    expect(result.status).toBe("idle");
    expect(w.digicert.requests.length - before[0]!).toBe(1);
    expect(w.sectigo.requests.length - before[1]!).toBe(1);
    expect(statusOf(w.h, NEWEST)).toBe("sealed");
    expect(metaOf(w.h, NEWEST)?.covered_by).toBeUndefined();
    expect(tokenKeys(w.h)).toStrictEqual([tokenObjectKey(NEWEST, "digicert"), tokenObjectKey(NEWEST, "sectigo")]);
    for (let slot = 0; slot < OUTAGE_EPOCHS - 1; slot += 1) {
      const meta = metaOf(w.h, epochOf(slot));
      expect({ slot, status: meta?.status, covered_by: meta?.covered_by }).toStrictEqual({ slot, status: "sealed", covered_by: NEWEST });
    }
    // The export: one seal per epoch for org A; the 299 older seals have no token and chain, by statements, to the newest.
    const bundle = exportBundle(w.h, A, w.settings);
    const report = verifyBundle(bundle, { anchors: anchorsOf(w) });
    expect(report.checks.filter((check) => !check.ok), JSON.stringify(report.checks.filter((check) => !check.ok))).toStrictEqual([]);
    expect(report.ok).toBe(true);
    expect(report.coveredEpochs).toHaveLength(OUTAGE_EPOCHS - 1);
    expect(report.epochsWithoutTimestamp).toStrictEqual([]);
    expect(report.sealedThroughSeq).toBe(OUTAGE_EPOCHS);
  }, 180_000);

  it("a run with new records after the outage stamps the newest pending epoch and the new one: two requests per authority, 15 seconds apart, and everything is covered or sealed", async () => {
    const w = world({ sweepKeysPerRun: 1 });
    await outage(w);
    w.digicert.behavior = "grant";
    w.sectigo.behavior = "grant";
    const before = [w.digicert.requests.length, w.sectigo.requests.length];
    w.h.clock.now = at(OUTAGE_EPOCHS);
    appendRecords(w.h, A, 1);
    const result = await run(w.h, at(OUTAGE_EPOCHS));
    expect(result).toMatchObject({ status: "sealed", epochs: [{ epochId: epochOf(OUTAGE_EPOCHS), status: "sealed" }] });
    for (const [host, count] of [[w.digicert, before[0]!], [w.sectigo, before[1]!]] as const) {
      const made = host.requests.slice(count);
      expect(made).toHaveLength(2);
      expect(made[1]!.at - made[0]!.at).toBeGreaterThanOrEqual(AUDIT_TSA_SPACING_MS);
      // The pending epoch first, then the new one.
      expect(made[0]!.hashHex).toBe(metaOf(w.h, NEWEST)?.statementHash);
      expect(made[1]!.hashHex).toBe(metaOf(w.h, epochOf(OUTAGE_EPOCHS))?.statementHash);
    }
    expect(statusOf(w.h, NEWEST)).toBe("sealed");
    expect(statusOf(w.h, epochOf(OUTAGE_EPOCHS))).toBe("sealed");
    for (let slot = 0; slot < OUTAGE_EPOCHS - 1; slot += 1) expect(metaOf(w.h, epochOf(slot))).toMatchObject({ status: "sealed", covered_by: NEWEST });
    const report = verifyBundle(exportBundle(w.h, A, w.settings), { anchors: anchorsOf(w) });
    expect(report.ok, JSON.stringify(report.checks.filter((check) => !check.ok))).toBe(true);
    expect(report.coveredEpochs).toHaveLength(OUTAGE_EPOCHS - 1);
  }, 180_000);

  it("finishes covering after a crash in the middle of it: no epoch is left waiting, however the writes were interrupted", async () => {
    const w = world({ sweepKeysPerRun: 1 });
    const epochs = 130;
    w.digicert.behavior = "rejection";
    w.sectigo.behavior = "rejection";
    for (let slot = 0; slot < epochs; slot += 1) {
      w.h.clock.now = at(slot);
      appendRecords(w.h, A, 1);
      await run(w.h, at(slot));
    }
    w.digicert.behavior = "grant";
    w.sectigo.behavior = "grant";
    let covering = 0;
    w.h.hooks.before = (command) => {
      if (command.constructor.name === "UpdateCommand" && JSON.stringify(command.input).includes("covered_by")) {
        covering += 1;
        if (covering === 61) throw crash();
      }
    };
    w.h.clock.now = at(epochs);
    await expect(run(w.h, at(epochs))).rejects.toMatchObject({ name: "ProcessDied" });
    const newest = epochIdAt(at(epochs - 1));
    // The newest pending epoch has its tokens but is not sealed until everything it covers is.
    expect(statusOf(w.h, newest)).toBe("stamp_pending");
    expect(Array.from({ length: epochs - 1 }, (_, slot) => statusOf(w.h, epochIdAt(at(slot)))).filter((status) => status === "stamp_pending").length).toBeGreaterThan(0);
    w.h.hooks.before = undefined;
    const requests = w.digicert.requests.length;
    w.h.clock.now = at(epochs + 1);
    await run(w.h, at(epochs + 1));
    expect(w.digicert.requests.length).toBe(requests);
    expect(statusOf(w.h, newest)).toBe("sealed");
    for (let slot = 0; slot < epochs - 1; slot += 1) expect(metaOf(w.h, epochIdAt(at(slot))), `slot ${String(slot)}`).toMatchObject({ status: "sealed", covered_by: newest });
  }, 120_000);

  it("keeps a pending epoch that has one token pending, and a later epoch with both tokens covers it", async () => {
    const w = world({ timeoutMs: 40, digicert: "hang" });
    appendRecords(w.h, A, 2);
    w.h.clock.now = at(0);
    await run(w.h, at(0));
    expect(statusOf(w.h, E0)).toBe("stamp_pending");
    // DigiCert is still down for the next epoch too: both end up pending, each with Sectigo's token.
    w.h.clock.now = at(1);
    appendRecords(w.h, A, 2);
    await run(w.h, at(1));
    expect(statusOf(w.h, E1)).toBe("stamp_pending");
    expect(tokenKeys(w.h)).toStrictEqual([tokenObjectKey(E0, "sectigo"), tokenObjectKey(E1, "sectigo")]);
    w.digicert.behavior = "grant";
    w.h.clock.now = at(2);
    appendRecords(w.h, A, 2);
    await run(w.h, at(2));
    // E1 (the newest pending) and E2 got both tokens; E0 is older than E1 and is covered by it.
    expect(statusOf(w.h, E1)).toBe("sealed");
    expect(statusOf(w.h, E2)).toBe("sealed");
    expect(metaOf(w.h, E0)).toMatchObject({ status: "sealed", covered_by: E1 });
    expect(metaOf(w.h, E1)?.covered_by).toBeUndefined();
    const report = verifyBundle(exportBundle(w.h, A, w.settings), { anchors: anchorsOf(w) });
    expect(report.ok, JSON.stringify(report.checks.filter((check) => !check.ok))).toBe(true);
    expect(report.coveredEpochs).toStrictEqual([]);
  });

  it("covers every older pending epoch by the new epoch when the newest pending one still lacks a token", async () => {
    const w = world({ timeoutMs: 40, digicert: "hang", sectigo: "rejection" });
    for (const slot of [0, 1, 2]) {
      w.h.clock.now = at(slot);
      appendRecords(w.h, A, 1);
      await run(w.h, at(slot));
    }
    expect([E0, E1, E2].map((id) => statusOf(w.h, id))).toStrictEqual(["stamp_pending", "stamp_pending", "stamp_pending"]);
    w.digicert.behavior = "hang";
    // Sectigo is back, DigiCert is not: the newest pending epoch (E2) gets only one token, so does the new one. Nothing covers.
    w.sectigo.behavior = "grant";
    w.h.clock.now = at(3);
    appendRecords(w.h, A, 1);
    await run(w.h, at(3));
    expect([E0, E1, E2].map((id) => statusOf(w.h, id))).toStrictEqual(["stamp_pending", "stamp_pending", "stamp_pending"]);
    // Both are back for the next run: E3 is the newest pending epoch and the new epoch E4 follows; E3 covers the older three.
    w.digicert.behavior = "grant";
    w.h.clock.now = at(4);
    appendRecords(w.h, A, 1);
    await run(w.h, at(4));
    const E3 = epochIdAt(at(3));
    for (const id of [E0, E1, E2]) expect(metaOf(w.h, id)).toMatchObject({ status: "sealed", covered_by: E3 });
    expect(statusOf(w.h, E3)).toBe("sealed");
  });
});

describe("coverage by the new epoch while the newest pending epoch is incomplete (review minor 5)", () => {
  it("covers every older pending epoch, including the incomplete newest one, by the new epoch; the export passes the offline verifier", async () => {
    const w = world();
    w.digicert.behavior = "rejection";
    w.sectigo.behavior = "rejection";
    for (const slot of [0, 1]) {
      w.h.clock.now = at(slot);
      appendRecords(w.h, A, 1);
      await run(w.h, at(slot));
    }
    expect([E0, E1].map((id) => statusOf(w.h, id))).toStrictEqual(["stamp_pending", "stamp_pending"]);
    // Sectigo is back; DigiCert fails its first request of the run (for E1, the newest pending epoch) and answers its second (for E2).
    w.sectigo.behavior = "grant";
    w.h.deps.tsa = { ...(w.h.deps.tsa as TsaDeps), sleep: async (ms: number) => { w.digicert.behavior = "grant"; w.h.clock.now += ms; } };
    w.h.clock.now = at(2);
    appendRecords(w.h, A, 1);
    await run(w.h, at(2));
    expect(stampOf(w.h, E1, "sectigo")).toBeDefined();
    expect(stampOf(w.h, E1, "digicert")).toBeUndefined();
    expect(stampOf(w.h, E2, "digicert")).toBeDefined();
    expect(stampOf(w.h, E2, "sectigo")).toBeDefined();
    expect(statusOf(w.h, E2)).toBe("sealed");
    expect(metaOf(w.h, E0)).toMatchObject({ status: "sealed", covered_by: E2 });
    expect(metaOf(w.h, E1)).toMatchObject({ status: "sealed", covered_by: E2 });
    const report = verifyBundle(exportBundle(w.h, A, w.settings), { anchors: anchorsOf(w) });
    expect(report.ok, JSON.stringify(report.checks.filter((check) => !check.ok))).toBe(true);
  });
});

describe("a crash, or a stop, in the middle of stamping", () => {
  it("a crash between a token object and the record of it: the next run adopts the stored token without asking the authority again", async () => {
    const w = world();
    appendRecords(w.h, A, 3);
    w.h.clock.now = at(0);
    let armed = true;
    w.h.hooks.before = (command) => {
      const input = command.input as { Key?: { pk?: string }; ExpressionAttributeNames?: Record<string, string> };
      if (armed && command.constructor.name === "UpdateCommand" && Object.values(input.ExpressionAttributeNames ?? {}).includes("stamp#digicert")) {
        armed = false;
        throw crash();
      }
    };
    await expect(run(w.h, at(0))).rejects.toMatchObject({ name: "ProcessDied" });
    expect(tokenKeys(w.h)).toContain(tokenObjectKey(E0, "digicert"));
    expect(stampOf(w.h, E0, "digicert")).toBeUndefined();
    const bytes = snapshot(w.h);
    w.h.clock.now = at(1);
    const result = await run(w.h, at(1));
    expect(result).toMatchObject({ status: "sealed", epochs: [{ epochId: E0, resumed: true, status: "sealed" }] });
    expect(w.digicert.requests).toHaveLength(1);
    expect(w.sectigo.requests).toHaveLength(1);
    expect(stampOf(w.h, E0, "digicert")).toMatchObject({ object: { key: tokenObjectKey(E0, "digicert") } });
    // Nothing was rewritten: every key still has its one version.
    for (const key of tokenKeys(w.h)) expect(snapshot(w.h)[key]).toStrictEqual(bytes[key]);
    expect(failures(w.h)).toStrictEqual([]);
  });

  it("a stored token that does not verify is never adopted: the authority is not asked, the failure is logged, and the epoch waits", async () => {
    const w = world();
    appendRecords(w.h, A, 3);
    w.h.clock.now = at(0);
    await w.h.s3.client.send(new PutObjectCommand(lockedPutInput(BUCKET, tokenObjectKey(E0, "digicert"), "planted, not a token", "application/timestamp-reply")));
    await run(w.h, at(0));
    expect(w.digicert.requests).toHaveLength(0);
    expect(stampOf(w.h, E0, "digicert")).toBeUndefined();
    expect(statusOf(w.h, E0)).toBe("stamp_pending");
    expect(failures(w.h)).toMatchObject([{ label: "digicert", problem: "stored_token_invalid", epochId: E0 }]);
    expect(w.h.s3.versionsOf(tokenObjectKey(E0, "digicert"))).toHaveLength(1);
  });

  it("a delete marker on a token key is version drift: logged, nothing written, the epoch waits", async () => {
    const w = world();
    appendRecords(w.h, A, 3);
    w.h.clock.now = at(0);
    w.h.s3.addDeleteMarker(tokenObjectKey(E0, "sectigo"));
    await run(w.h, at(0));
    expect(w.sectigo.requests).toHaveLength(0);
    expect(eventsOf(w.h, "audit.version_drift")).toMatchObject([{ epochId: E0, key: tokenObjectKey(E0, "sectigo") }]);
    expect(failures(w.h)).toMatchObject([{ label: "sectigo", problem: "version_drift" }]);
    expect(statusOf(w.h, E0)).toBe("stamp_pending");
    expect(stampOf(w.h, E0, "digicert")).toBeDefined();
  });

  it("two runs to one slot cannot store two different tokens: the second finds the first's", async () => {
    const w = world();
    appendRecords(w.h, A, 3);
    w.h.clock.now = at(0);
    // A rival run wrote DigiCert's token between this run's check and its write.
    const rival = fakeTsaHost({ url: DIGICERT, pki: w.digicert.pki, now: () => w.h.clock.now });
    let raced = false;
    const racing = routeFetch(async (url, init) => {
      if (url.href === new URL(DIGICERT).href && !raced) {
        raced = true;
        const answered = await rival.handler(url, init);
        const stamped = parseTimeStampResponse(new Uint8Array(await answered!.clone().arrayBuffer())).token!;
        await w.h.s3.client.send(new PutObjectCommand(lockedPutInput(BUCKET, tokenObjectKey(E0, "digicert"), stamped, "application/timestamp-reply")));
      }
      return undefined;
    }, w.digicert.handler, w.sectigo.handler);
    w.h.deps.tsa = { ...(w.h.deps.tsa as TsaDeps), fetch: racing };
    await run(w.h, at(0));
    expect(w.h.s3.versionsOf(tokenObjectKey(E0, "digicert"))).toHaveLength(1);
    expect(stampOf(w.h, E0, "digicert")).toBeDefined();
    expect(statusOf(w.h, E0)).toBe("sealed");
    expect(failures(w.h)).toStrictEqual([]);
  });

  it("asks each authority at most twice in one run, even when the run finishes one epoch and opens another", async () => {
    const w = world({ timeoutMs: 40, digicert: "hang", sectigo: "hang" });
    for (const slot of [0]) {
      appendRecords(w.h, A, 1);
      w.h.clock.now = at(slot);
      await run(w.h, at(slot));
    }
    // E1 opens and is stopped before it is completed (a crash at the finalize), the authorities still down.
    appendRecords(w.h, A, 1);
    w.h.clock.now = at(1);
    let armed = true;
    w.h.hooks.before = (command) => {
      if (armed && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("SEALED#")) { armed = false; throw crash(); }
    };
    await expect(run(w.h, at(1))).rejects.toMatchObject({ name: "ProcessDied" });
    expect(statusOf(w.h, E1)).toBe("frozen");
    // The authorities are back. The run resumes E1 (E0 pending: two requests per authority), then opens E2, which must wait.
    w.digicert.behavior = "grant";
    w.sectigo.behavior = "grant";
    const before = [w.digicert.requests.length, w.sectigo.requests.length];
    w.h.clock.now = at(2);
    appendRecords(w.h, A, 1);
    const result = await run(w.h, at(2));
    expect(w.digicert.requests.length - before[0]!).toBe(2);
    expect(w.sectigo.requests.length - before[1]!).toBe(2);
    expect(result.epochs.map((epoch) => [epoch.epochId, epoch.status])).toStrictEqual([[E1, "sealed"], [E2, "stamp_pending"]]);
    // The next run stamps E2.
    w.h.clock.now = at(3);
    await run(w.h, at(3));
    expect(statusOf(w.h, E2)).toBe("sealed");
  });

  it("stops the run, says the lock is wrong and finalizes nothing, when a token comes back with no retention at all", async () => {
    const w = world();
    appendRecords(w.h, A, 3);
    w.h.clock.now = at(0);
    w.h.s3.after = (call) => {
      if (call.command === "PutObject" && call.key === tokenObjectKey(E0, "digicert")) (w.h.s3.versionsOf(call.key)[0] as { lockMode: unknown }).lockMode = undefined;
    };
    const result = await run(w.h, at(0));
    expect(result).toMatchObject({ status: "stopped", reason: "lock_config_mismatch" });
    expect(eventsOf(w.h, "audit.lock_config_mismatch")).toStrictEqual([expect.objectContaining({ key: tokenObjectKey(E0, "digicert"), epochId: E0 })]);
    expect(intentOf(w.h, E0, A)).toMatchObject({ finalized: false });
    expect(failures(w.h)).toStrictEqual([]);
  });

  it("stops the run, as for any object, when a token's lock is weaker than the floor, and finalizes nothing", async () => {
    const w = world();
    appendRecords(w.h, A, 3);
    w.h.clock.now = at(0);
    w.h.s3.after = (call) => {
      if (call.command === "PutObject" && call.key?.endsWith(".tsr")) w.h.s3.setObjectLock(call.key, w.h.s3.versionsOf(call.key).at(-1)!.versionId, { mode: "GOVERNANCE", retainUntil: at(0) + 86_400_000 });
    };
    const result = await run(w.h, at(0));
    expect(result).toMatchObject({ status: "stopped", reason: "lock_config_mismatch" });
    const mismatches = eventsOf(w.h, "audit.lock_config_mismatch");
    expect(mismatches).toHaveLength(2);
    for (const entry of mismatches) expect(entry).toMatchObject({ check: "object", epochId: E0, key: expect.stringMatching(/\.tsr$/) as unknown });
    expect(intentOf(w.h, E0, A)).toMatchObject({ finalized: false });
    expect(statusOf(w.h, E0)).toBe("frozen");
  });
});

describe("customer-run authorities", () => {
  const URL_ONE = "https://tsa-one.example.test/ts";
  const URL_TWO = "http://tsa-two.example.test/ts";

  function customWorld() {
    const h = harness();
    const one = fakeTsaHost({ url: URL_ONE, pki: makePki("Customer One"), now: () => h.clock.now });
    const two = fakeTsaHost({ url: URL_TWO, pki: makePki("Customer Two"), now: () => h.clock.now });
    const fetch = routeFetch(one.handler, two.handler);
    const settings = customTsaSettings([URL_ONE, URL_TWO], JSON.stringify([one.pki.root.x509.toString(), two.pki.root.x509.toString()]));
    h.deps.tsa = { settings, fetch, sleep: async (ms: number) => { h.clock.now += ms; }, clock: () => h.clock.now };
    return { h, one, two, fetch, settings };
  }

  it("stamps as custom-1 and custom-2, each with its own roots, and the export verifies with --trust style anchors", async () => {
    const w = customWorld();
    appendRecords(w.h, A, 3);
    w.h.clock.now = at(0);
    const result = await run(w.h, at(0));
    expect(result.status).toBe("sealed");
    expect(tokenKeys(w.h)).toStrictEqual([tokenObjectKey(E0, "custom-1"), tokenObjectKey(E0, "custom-2")]);
    expect(w.one.requests).toHaveLength(1);
    expect(w.two.requests).toHaveLength(1);
    const bundle = exportBundle(w.h, A, w.settings);
    const report = verifyBundle(bundle, { anchors: { "custom-1": [w.one.pki.root.x509], "custom-2": [w.two.pki.root.x509] } });
    expect(report.checks.filter((check) => !check.ok), JSON.stringify(report.checks)).toStrictEqual([]);
    expect(report.ok).toBe(true);
    // The verifier's own pinned roots do not know these authorities: their tokens are reported as unverifiable, not trusted.
    const unknown = verifyBundle(bundle, { anchors: defaultAnchors() });
    expect(unknown.unverifiedAuthorities).toStrictEqual(["custom-1", "custom-2"]);
    expect(unknown.timestampedThrough).toBeUndefined();
  });

  it("a custom token checked against the other URL's roots is rejected", async () => {
    const w = customWorld();
    const statement = statementHash({ v: 1, epochId: E0, closedAt: iso(at(0)), prevEpochId: null, prevStatementHash: null, sealsRoot: "00".repeat(32), sealCount: 0 });
    const okNow = await requestTimestamp(w.fetch, "custom-1", URL_ONE, statement, { timeoutMs: 1000, nonce: 5n, anchors: [w.one.pki.root.x509], clock: () => w.h.clock.now });
    expect(okNow.token.length).toBeGreaterThan(0);
    await expect(requestTimestamp(w.fetch, "custom-1", URL_ONE, statement, { timeoutMs: 1000, nonce: 5n, anchors: [w.two.pki.root.x509] })).rejects.toMatchObject({ label: "custom-1", problem: "untrusted" });
    await expect(requestTimestamp(w.fetch, "custom-2", URL_TWO, statement, { timeoutMs: 1000, nonce: 5n, anchors: [w.one.pki.root.x509] })).rejects.toMatchObject({ label: "custom-2", problem: "untrusted" });
  });

  it("one custom authority alone is label custom-1 and seals the epoch with a single token", async () => {
    const h = harness();
    const only = fakeTsaHost({ url: URL_ONE, pki: makePki("Only One"), now: () => h.clock.now });
    const settings = customTsaSettings([URL_ONE], only.pki.root.x509.toString());
    h.deps.tsa = { settings, fetch: routeFetch(only.handler), sleep: async () => undefined, clock: () => h.clock.now };
    appendRecords(h, A, 3);
    h.clock.now = at(0);
    await run(h, at(0));
    expect(tokenKeys(h)).toStrictEqual([tokenObjectKey(E0, "custom-1")]);
    expect(statusOf(h, E0)).toBe("sealed");
  });

  it("never calls a public authority", async () => {
    const w = customWorld();
    appendRecords(w.h, A, 3);
    w.h.clock.now = at(0);
    await run(w.h, at(0));
    expect(w.fetch.calls.filter((call) => /digicert|sectigo/.test(call))).toStrictEqual([]);
  });

  it("an unavailable roots parameter leaves every epoch pending with a failure line each run, and still seals", async () => {
    const h = harness();
    const logs: Array<Record<string, unknown>> = [];
    const never = (async () => { throw new Error("no request expected"); }) as unknown as typeof fetch;
    h.deps.tsa = await loadTsaDeps({
      AUDIT_TSA_KIND: "custom", AUDIT_TSA_URLS: URL_ONE, AUDIT_TSA_ROOTS_PARAMETER: "/r", AUDIT_TSA_TIMEOUT_MS: "10000", AUDIT_TSA_SPACING_MS: "15000",
    }, { readParameter: async () => { throw new Error("denied"); }, fetch: never, log: (entry) => { logs.push(entry); } });
    appendRecords(h, A, 3);
    h.clock.now = at(0);
    const result = await run(h, at(0));
    expect(result).toMatchObject({ status: "stamp_pending" });
    expect(statusOf(h, E0)).toBe("stamp_pending");
    expect(stateOfA(h)).toBe(3);
    expect(failures(h)).toMatchObject([{ label: "custom-1", problem: "roots_unavailable" }]);
  });
});

describe("off", () => {
  it("makes no HTTP call; every epoch is sealed without a token", async () => {
    const w = world();
    w.h.deps.tsa = { ...(w.h.deps.tsa as TsaDeps), settings: { kind: "off" } };
    await sealFirstEpoch(w);
    w.h.clock.now = at(1);
    appendRecords(w.h, A, 2);
    await run(w.h, at(1));
    expect(w.fetch.calls).toStrictEqual([]);
    expect(tokenKeys(w.h)).toStrictEqual([]);
    expect([E0, E1].map((id) => statusOf(w.h, id))).toStrictEqual(["sealed", "sealed"]);
    expect(failures(w.h)).toStrictEqual([]);
    const bundle = exportBundle(w.h, A, { kind: "off" });
    const report = verifyBundle(bundle, { anchors: {} });
    expect(report.ok).toBe(true);
    expect(report.epochsWithoutTimestamp).toStrictEqual([E0, E1]);
    expect(report.timestampedThrough).toBeUndefined();
  });

  it("is also what an anchor given no timestamp settings does (the Task 8 behaviour)", async () => {
    const h = harness();
    appendRecords(h, A, 3);
    h.clock.now = at(0);
    expect(await run(h, at(0))).toMatchObject({ status: "sealed" });
    expect(statusOf(h, E0)).toBe("sealed");
  });
});

describe("what is stored in the table about a stamp, and what it logs", () => {
  it("keeps the object, the version and the time of each token on the epoch's item, and logs only ids and the problem", async () => {
    const w = world({ digicert: "rejection" });
    await sealFirstEpoch(w);
    const stamp = stampOf(w.h, E0, "sectigo")!;
    expect(Object.keys(stamp).sort()).toStrictEqual(["genTime", "object"]);
    const serialized = JSON.stringify(failures(w.h));
    expect(serialized).not.toMatch(/token|BEGIN|[A-Za-z0-9+/]{80,}/);
    expect(storedRecords(w.h, B)).toStrictEqual([]);
  });
});

describe("review I1: a token's time is checked before it is stored", () => {
  const MINUTE = 60_000;

  it("an authority whose clock runs 10 minutes behind gets no token stored: the epoch waits, the failure is logged and the other authority's token is kept; a later run with a right clock seals, and the export passes", async () => {
    const w = world();
    w.digicert.skewMs = -10 * MINUTE;
    await sealFirstEpoch(w);
    expect(tokenKeys(w.h)).toStrictEqual([tokenObjectKey(E0, "sectigo")]);
    expect(stampOf(w.h, E0, "digicert")).toBeUndefined();
    expect(statusOf(w.h, E0)).toBe("stamp_pending");
    expect(failures(w.h)).toMatchObject([{ label: "digicert", problem: "gen_time", epochId: E0 }]);
    w.digicert.skewMs = 0;
    w.h.clock.now = at(1);
    await run(w.h, at(1));
    expect(statusOf(w.h, E0)).toBe("sealed");
    expect(tokenKeys(w.h)).toStrictEqual([tokenObjectKey(E0, "digicert"), tokenObjectKey(E0, "sectigo")]);
    const report = verifyBundle(exportBundle(w.h, A, w.settings), { anchors: anchorsOf(w) });
    expect(report.ok, JSON.stringify(report.checks.filter((check) => !check.ok))).toBe(true);
  });

  it("a clock that is only 4 minutes behind is inside the skew: stored, and the export passes", async () => {
    const w = world();
    w.digicert.skewMs = -4 * MINUTE;
    await sealFirstEpoch(w);
    expect(statusOf(w.h, E0)).toBe("sealed");
    expect(failures(w.h)).toStrictEqual([]);
    const report = verifyBundle(exportBundle(w.h, A, w.settings), { anchors: anchorsOf(w) });
    expect(report.ok, JSON.stringify(report.checks.filter((check) => !check.ok))).toBe(true);
  });

  it("a token dated 10 minutes in the future is refused too", async () => {
    const w = world();
    w.sectigo.skewMs = 10 * MINUTE;
    await sealFirstEpoch(w);
    expect(stampOf(w.h, E0, "sectigo")).toBeUndefined();
    expect(failures(w.h)).toMatchObject([{ label: "sectigo", problem: "gen_time" }]);
  });

  it("while an authority keeps the wrong time the epoch waits and a later epoch with good tokens covers it", async () => {
    const w = world();
    w.digicert.skewMs = -10 * MINUTE;
    await sealFirstEpoch(w);
    expect(statusOf(w.h, E0)).toBe("stamp_pending");
    w.digicert.skewMs = 0;
    w.h.clock.now = at(1);
    appendRecords(w.h, A, 2);
    // DigiCert is right for the new epoch's request, which is its second of the run (the first one, for E0, is the retry): both pass.
    await run(w.h, at(1));
    expect(statusOf(w.h, E1)).toBe("sealed");
    expect(statusOf(w.h, E0)).toBe("sealed");
    const report = verifyBundle(exportBundle(w.h, A, w.settings), { anchors: anchorsOf(w) });
    expect(report.ok, JSON.stringify(report.checks.filter((check) => !check.ok))).toBe(true);
  });

  it("a token an earlier build stored with a time that is too early is not adopted: no request is made, the failure is logged and the epoch waits", async () => {
    const w = world({ digicert: "rejection" });
    await sealFirstEpoch(w);
    expect(statusOf(w.h, E0)).toBe("stamp_pending");
    const hash = String(metaOf(w.h, E0)?.statementHash);
    w.digicert.behavior = "grant";
    w.digicert.skewMs = -10 * MINUTE;
    const answered = await w.digicert.handler(new URL(DIGICERT), { method: "POST", body: buildTimeStampRequest(hash, 5n), headers: {} });
    const planted = parseTimeStampResponse(new Uint8Array(await answered!.arrayBuffer())).token!;
    await w.h.s3.client.send(new PutObjectCommand(lockedPutInput(BUCKET, tokenObjectKey(E0, "digicert"), planted, "application/octet-stream")));
    w.digicert.skewMs = 0;
    const before = w.digicert.requests.length;
    w.h.clock.now = at(1);
    await run(w.h, at(1));
    expect(w.digicert.requests.length).toBe(before);
    expect(stampOf(w.h, E0, "digicert")).toBeUndefined();
    expect(statusOf(w.h, E0)).toBe("stamp_pending");
    expect(failures(w.h).filter((entry) => entry.problem === "gen_time")).toMatchObject([{ label: "digicert", epochId: E0 }]);
  });

  it("the token object is stored as application/octet-stream: it is a TimeStampToken, not a full response (review minor)", async () => {
    const w = world();
    await sealFirstEpoch(w);
    const puts = w.h.s3.putCalls().filter((call) => call.key?.endsWith(".tsr"));
    expect(puts.map((put) => put.input.ContentType)).toStrictEqual(["application/octet-stream", "application/octet-stream"]);
  });
});

describe("review I2: a crash after a stamped epoch is completed must not strand older pending epochs", () => {
  /** Two epochs wait (E0, E1) while both authorities refuse; they come back and the run for E2 crashes at its first covering write. */
  async function crashedBeforeCovering(): Promise<World> {
    const w = world();
    w.digicert.behavior = "rejection";
    w.sectigo.behavior = "rejection";
    for (const slot of [0, 1]) {
      w.h.clock.now = at(slot);
      appendRecords(w.h, A, 1);
      await run(w.h, at(slot));
    }
    expect([E0, E1].map((id) => statusOf(w.h, id))).toStrictEqual(["stamp_pending", "stamp_pending"]);
    w.digicert.behavior = "grant";
    w.sectigo.behavior = "grant";
    w.h.hooks.before = (command) => {
      if (command.constructor.name === "UpdateCommand" && JSON.stringify(command.input).includes("covered_by")) throw crash();
    };
    w.h.clock.now = at(2);
    appendRecords(w.h, A, 1);
    await expect(run(w.h, at(2))).rejects.toMatchObject({ name: "ProcessDied" });
    w.h.hooks.before = undefined;
    // The new epoch is complete and the head, and it is not sealed while older epochs wait behind it.
    expect(statusOf(w.h, E2)).toBe("stamp_pending");
    expect(epochHead(w.h)).toMatchObject({ epochId: E2 });
    expect(statusOf(w.h, E0)).toBe("stamp_pending");
    return w;
  }

  it("the next run, before it opens an epoch of its own, covers and seals the epochs the crash left, whatever it finds to seal", async () => {
    const w = await crashedBeforeCovering();
    const requests = w.digicert.requests.length;
    w.h.clock.now = at(3);
    await run(w.h, at(3));
    expect(w.digicert.requests.length).toBe(requests);
    for (const id of [E0, E1]) expect(statusOf(w.h, id), id).toBe("sealed");
    expect(metaOf(w.h, E0)?.covered_by).toBeDefined();
    expect(failures(w.h).filter((entry) => entry.problem === "pending_too_long")).toStrictEqual([]);
    const report = verifyBundle(exportBundle(w.h, A, w.settings), { anchors: anchorsOf(w) });
    expect(report.ok, JSON.stringify(report.checks.filter((check) => !check.ok))).toBe(true);
    expect(report.epochsWithoutTimestamp).toStrictEqual([]);
  });

  it("it also heals when the next run has new records of its own, and settling again changes nothing", async () => {
    const w = await crashedBeforeCovering();
    w.h.clock.now = at(3);
    appendRecords(w.h, A, 2);
    await run(w.h, at(3));
    for (const id of [E0, E1, E2, epochIdAt(at(3))]) expect(statusOf(w.h, id), id).toBe("sealed");
    const settled = JSON.stringify([E0, E1, E2].map((id) => metaOf(w.h, id)));
    w.h.clock.now = at(4);
    await run(w.h, at(4));
    expect(JSON.stringify([E0, E1, E2].map((id) => metaOf(w.h, id)))).toBe(settled);
    const report = verifyBundle(exportBundle(w.h, A, w.settings), { anchors: anchorsOf(w) });
    expect(report.ok, JSON.stringify(report.checks.filter((check) => !check.ok))).toBe(true);
  });

  it("a crash in the middle of the healing run is healed by the one after", async () => {
    const w = await crashedBeforeCovering();
    let first = true;
    w.h.hooks.before = (command) => {
      if (first && command.constructor.name === "UpdateCommand" && JSON.stringify(command.input).includes("covered_by")) {
        first = false;
        throw crash();
      }
    };
    w.h.clock.now = at(3);
    await expect(run(w.h, at(3))).rejects.toMatchObject({ name: "ProcessDied" });
    w.h.hooks.before = undefined;
    w.h.clock.now = at(4);
    await run(w.h, at(4));
    for (const id of [E0, E1]) expect(statusOf(w.h, id), id).toBe("sealed");
  });

  it("alarms, as a timestamp failure, for a pending epoch that has waited longer than 3 hours, and not before", async () => {
    const w = world({ digicert: "rejection", sectigo: "rejection" });
    appendRecords(w.h, A, 1);
    w.h.clock.now = at(0);
    await run(w.h, at(0));
    const tooLong = (): unknown[] => failures(w.h).filter((entry) => entry.problem === "pending_too_long");
    // The check is made at the start of a run, on the epoch closed by the earlier one: 11 slots later it is 2 h 45 min old.
    w.h.clock.now = at(11);
    await run(w.h, at(11));
    expect(tooLong()).toStrictEqual([]);
    w.h.clock.now = at(13);
    await run(w.h, at(13));
    expect(tooLong()).toMatchObject([{ epochId: E0, level: "error", label: "all" }]);
    expect(statusOf(w.h, E0)).toBe("stamp_pending");
  });
});

describe("review N1: a covering token must cover every epoch it settles", () => {
  const MINUTE = 60_000;
  const E3 = epochIdAt(at(3));

  it("a token from clocks 25 minutes behind is refused for a later epoch with old records too (the sanity floor), so it cannot cover an older pending epoch (the re-checker's probe A)", async () => {
    const w = world();
    w.digicert.skewMs = -25 * MINUTE;
    w.sectigo.skewMs = -25 * MINUTE;
    await sealFirstEpoch(w);
    expect(statusOf(w.h, E0)).toBe("stamp_pending");
    // An org whose records were made an hour earlier (the hourly backstop) is sealed alone in E1: its records alone would accept the token.
    w.h.clock.now = at(1) - 60 * MINUTE;
    appendRecords(w.h, B, 2);
    w.h.clock.now = at(1);
    await run(w.h, at(1));
    expect(tokenKeys(w.h)).toStrictEqual([]);
    expect([E0, E1].map((id) => statusOf(w.h, id))).toStrictEqual(["stamp_pending", "stamp_pending"]);
    expect(metaOf(w.h, E0)?.covered_by).toBeUndefined();
    expect(failures(w.h).filter((entry) => entry.epochId === E1)).toMatchObject([{ problem: "gen_time" }, { problem: "gen_time" }]);
  });

  /** E0's only org recorded its records 40 minutes ahead of the anchor's clock, so no token of the run can stamp E0 itself. */
  async function pendingBehindALaterRecord(): Promise<World> {
    const w = world();
    w.h.clock.now = at(0) + 40 * MINUTE;
    appendRecords(w.h, A, 3);
    w.h.clock.now = at(0);
    await run(w.h, at(0));
    expect(statusOf(w.h, E0)).toBe("stamp_pending");
    expect(tokenKeys(w.h)).toStrictEqual([]);
    return w;
  }

  it("refuses to cover an epoch whose records are later than the covering token allows: nothing is covered and nothing is sealed behind it, and the refusal is logged", async () => {
    const w = await pendingBehindALaterRecord();
    w.h.clock.now = at(1) - 60 * MINUTE;
    appendRecords(w.h, B, 2);
    w.h.clock.now = at(1);
    await run(w.h, at(1));
    // E1 holds both of its own tokens (its records are old), but its token cannot vouch for E0's records.
    expect(stampOf(w.h, E1, "digicert")).toBeDefined();
    expect(stampOf(w.h, E1, "sectigo")).toBeDefined();
    expect(metaOf(w.h, E0)).toMatchObject({ status: "stamp_pending" });
    expect(metaOf(w.h, E0)?.covered_by).toBeUndefined();
    expect(statusOf(w.h, E1)).toBe("stamp_pending");
    expect(failures(w.h).filter((entry) => entry.label === "all")).toMatchObject([{ problem: "gen_time", epochId: E0, coveredBy: E1 }]);
  });

  it("a later epoch whose tokens do cover it settles everything, and the export passes the offline verifier", async () => {
    const w = await pendingBehindALaterRecord();
    w.h.clock.now = at(1) - 60 * MINUTE;
    appendRecords(w.h, B, 2);
    w.h.clock.now = at(1);
    await run(w.h, at(1));
    w.h.clock.now = at(3);
    appendRecords(w.h, A, 1);
    await run(w.h, at(3));
    expect([E0, E1, E3].map((id) => statusOf(w.h, id))).toStrictEqual(["sealed", "sealed", "sealed"]);
    expect(metaOf(w.h, E0)?.covered_by).toBe(E3);
    const report = verifyBundle(exportBundle(w.h, A, w.settings), { anchors: anchorsOf(w) });
    expect(report.ok, JSON.stringify(report.checks.filter((check) => !check.ok))).toBe(true);
    expect(report.epochsWithoutTimestamp).toStrictEqual([]);
  });

  it("an idle run after a refused covering keeps the head pending, so no sealed epoch ever stands in front of a waiting one", async () => {
    const w = await pendingBehindALaterRecord();
    w.h.clock.now = at(1) - 60 * MINUTE;
    appendRecords(w.h, B, 2);
    w.h.clock.now = at(1);
    await run(w.h, at(1));
    w.h.clock.now = at(2);
    await run(w.h, at(2));
    expect([E0, E1].map((id) => statusOf(w.h, id))).toStrictEqual(["stamp_pending", "stamp_pending"]);
    expect(epochHead(w.h)).toMatchObject({ epochId: E1 });
  });
});

describe("review N2: resumed stamps pass the lock checks", () => {
  it("a head whose tokens carry a lock below the floor stops every run, and is not sealed by the run after the one that found it", async () => {
    const w = world({ digicert: "rejection" });
    await sealFirstEpoch(w);
    expect(statusOf(w.h, E0)).toBe("stamp_pending");
    w.digicert.behavior = "grant";
    w.h.s3.after = (call) => {
      if (call.command === "PutObject" && call.key?.endsWith(".tsr")) w.h.s3.setObjectLock(call.key, w.h.s3.versionsOf(call.key).at(-1)!.versionId, { mode: "GOVERNANCE", retainUntil: at(1) + 86_400_000 });
    };
    w.h.clock.now = at(1);
    expect(await run(w.h, at(1))).toMatchObject({ status: "stopped", reason: "lock_config_mismatch" });
    expect(statusOf(w.h, E0)).toBe("stamp_pending");
    w.h.s3.after = undefined;
    const mismatches = eventsOf(w.h, "audit.lock_config_mismatch").length;
    w.h.clock.now = at(2);
    expect(await run(w.h, at(2))).toMatchObject({ status: "stopped", reason: "lock_config_mismatch" });
    expect(statusOf(w.h, E0)).toBe("stamp_pending");
    expect(eventsOf(w.h, "audit.lock_config_mismatch").length).toBeGreaterThan(mismatches);
  });
});

describe("review N3: a run with nothing to settle does no settling work", () => {
  it("after the head has covered the older epochs, idle runs write nothing to the epochs, read only the head's META, and do not log the covering again", async () => {
    const w = world();
    w.digicert.behavior = "rejection";
    w.sectigo.behavior = "rejection";
    for (let slot = 0; slot < 6; slot += 1) {
      w.h.clock.now = at(slot);
      appendRecords(w.h, A, 1);
      await run(w.h, at(slot));
    }
    w.digicert.behavior = "grant";
    w.sectigo.behavior = "grant";
    w.h.clock.now = at(6);
    await run(w.h, at(6));
    expect(eventsOf(w.h, "audit.timestamps_covered")).toHaveLength(1);
    for (const slot of [7, 8]) {
      const before = w.h.operations.length;
      w.h.clock.now = at(slot);
      expect(await run(w.h, at(slot))).toMatchObject({ status: "idle" });
      const made = w.h.operations.slice(before).filter((operation) => operation.pk.startsWith("EPOCH#"));
      expect(made.filter((operation) => operation.action !== "GetItem")).toStrictEqual([]);
      expect(made.length).toBeLessThanOrEqual(2);
    }
    expect(eventsOf(w.h, "audit.timestamps_covered")).toHaveLength(1);
  });
});

describe("review N4: an older pending epoch is never stranded behind epochs a later epoch covered", () => {
  /** E0 to E3 wait (both authorities refuse), then they come back. */
  async function fourWaiting(): Promise<World> {
    const w = world();
    w.digicert.behavior = "rejection";
    w.sectigo.behavior = "rejection";
    for (const slot of [0, 1, 2, 3]) {
      w.h.clock.now = at(slot);
      appendRecords(w.h, A, 1);
      await run(w.h, at(slot));
    }
    w.digicert.behavior = "grant";
    w.sectigo.behavior = "grant";
    return w;
  }
  const E4 = epochIdAt(at(4));
  const E3 = epochIdAt(at(3));

  it("a page of covering writes that fails half way, after a newer epoch completed, is finished by the next run: the epoch left waiting is covered too (the re-checker's probe H)", async () => {
    const w = await fourWaiting();
    let coverings = 0;
    // E4 is completed and is the head; E3 then covers E0, E1 and E2 in one page. The second write of the page fails, the others land.
    w.h.hooks.before = (command) => {
      if (command.constructor.name === "UpdateCommand" && JSON.stringify(command.input).includes("covered_by")) {
        coverings += 1;
        if (coverings === 2) throw crash();
      }
    };
    w.h.clock.now = at(4);
    appendRecords(w.h, A, 1);
    await expect(run(w.h, at(4))).rejects.toMatchObject({ name: "ProcessDied" });
    w.h.hooks.before = undefined;
    expect(epochHead(w.h)).toMatchObject({ epochId: E4 });
    expect([E0, E1, E2].map((id) => (metaOf(w.h, id)?.covered_by === undefined ? "waiting" : "covered"))).toStrictEqual(["covered", "waiting", "covered"]);
    expect(statusOf(w.h, E1)).toBe("stamp_pending");
    const requests = w.digicert.requests.length;
    w.h.clock.now = at(5);
    await run(w.h, at(5));
    expect(w.digicert.requests.length).toBe(requests);
    for (const id of [E0, E1, E2, E3, E4]) expect(statusOf(w.h, id), id).toBe("sealed");
    expect(metaOf(w.h, E1)?.covered_by).toBeDefined();
    const report = verifyBundle(exportBundle(w.h, A, w.settings), { anchors: anchorsOf(w) });
    expect(report.ok, JSON.stringify(report.checks.filter((check) => !check.ok))).toBe(true);
    expect(report.epochsWithoutTimestamp).toStrictEqual([]);
  });

  it("an epoch waiting behind covered ones that is older than 3 hours is reported, wherever it sits (nothing was logged for it before)", async () => {
    const w = world({ digicert: "rejection", sectigo: "rejection" });
    for (const slot of [0, 1, 2, 3]) {
      w.h.clock.now = at(slot);
      appendRecords(w.h, A, 1);
      await run(w.h, at(slot));
    }
    // E1 and E2 were covered by E3; E0, the oldest, was left waiting by an interrupted run. E3, the head, still lacks its tokens.
    for (const id of [E1, E2]) w.h.db.set({ ...metaOf(w.h, id)!, status: "sealed", covered_by: E3 });
    expect(failures(w.h).filter((entry) => entry.problem === "pending_too_long")).toStrictEqual([]);
    w.h.clock.now = at(14);
    await run(w.h, at(14));
    expect(failures(w.h).filter((entry) => entry.problem === "pending_too_long")).toMatchObject([{ epochId: E0, level: "error", label: "all" }]);
  });
});

// ---- a small stand-in for the export builder (Task 11), with the stamps ----

function anchorsOf(w: World): Record<string, X509Certificate[]> {
  return { digicert: [rootOf(w.digicert)], sectigo: [rootOf(w.sectigo)] };
}

function exportBundle(h: Harness, orgId: string, settings: TsaSettings): AuditBundleV1 {
  const labels = settings.kind === "off" ? [] : settings.targets.map((target) => target.label);
  const all = storedRecords(h, orgId);
  const indexItems = h.db.find((item) => item.pk === `SEALS#${orgId}`).sort((left, right) => String(left.sk).localeCompare(String(right.sk)));
  // The epoch that follows each epoch in the chain.
  const successor = new Map(h.db.find((item) => item.sk === "META" && typeof item.prevEpochId === "string").map((item) => [String(item.prevEpochId), String(item.pk).slice("EPOCH#".length)]));
  const statementCache = new Map<string, EpochStatementV1>();
  const statementOf = (epochId: string): EpochStatementV1 => {
    let found = statementCache.get(epochId);
    if (found === undefined) {
      found = JSON.parse(h.s3.currentText(statementObjectKey(epochId))!) as EpochStatementV1;
      statementCache.set(epochId, found);
    }
    return found;
  };
  const stampsOf = (epochId: string): BundleTimestamp[] =>
    labels.flatMap((label) => {
      const stamp = stampOf(h, epochId, label);
      if (stamp === undefined) return [];
      const body = h.s3.versionsOf(stamp.object.key)[0]!.body;
      return [{ tsa: label, token: Buffer.from(body).toString("base64"), object: stamp.object }];
    });
  const objectOf = (key: string): LockedObjectV1 => {
    const version = h.s3.versionsOf(key)[0]!;
    return { key, versionId: version.versionId, lastModified: iso(version.lastModified), lockMode: version.lockMode, retainUntil: iso(version.retainUntil) };
  };
  const seals: BundleSeal[] = indexItems.map((item) => {
    const fromSeq = Number(item.sk);
    const epochId = String(item.epochId);
    const seal = JSON.parse(h.s3.currentText(sealObjectKey(orgId, fromSeq))!) as OrgSealV1;
    const leaves = (JSON.parse(h.s3.currentText(leavesObjectKey(epochId))!) as { seals: OrgSealV1[] }).seals;
    const index = leaves.findIndex((leaf) => leaf.orgId === orgId);
    const objects = item.objects as { records: LockedObjectV1; seal: LockedObjectV1 };
    const own = stampsOf(epochId);
    const entry: BundleSeal = {
      seal, sealObject: objects.seal, recordsObject: objects.records,
      inclusion: { index, size: leaves.length, path: inclusionPath(leaves.map(sealLeafData), index) },
      epoch: statementOf(epochId), epochObject: objectOf(statementObjectKey(epochId)), timestamps: own,
    };
    const coveringId = metaOf(h, epochId)?.covered_by;
    if (own.length === 0 && typeof coveringId === "string") {
      const chain: EpochStatementV1[] = [];
      for (let id = successor.get(epochId); id !== undefined; id = id === coveringId ? undefined : successor.get(id)) {
        chain.push(statementOf(id));
        if (id === coveringId) break;
      }
      entry.coveredBy = { epochs: chain, timestamps: stampsOf(coveringId) };
    }
    return entry;
  });
  const through = seals.at(-1)?.seal.toSeq ?? 0;
  return {
    format: "rovara-audit-bundle", v: 1, orgId, exportedAt: iso(h.clock.now), previous: { seq: 0, hash: genesisHash(orgId) }, previousSeal: null,
    records: all.filter((record) => record.seq <= through), seals, unsealed: all.filter((record) => record.seq > through),
  };
}
