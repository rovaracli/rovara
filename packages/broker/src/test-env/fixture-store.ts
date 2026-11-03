// Test services TS24 (design test-services.md 7.4): where the fakes are kept, reviewed and handed out. A fake is a FixtureSet v2, pinned by the digest of its canonical JSON.
//
// What this module guarantees, all of it fail closed:
//   - Behind `tx`: with the switch off every function answers `disabled` and touches neither port, so nothing is stored, listed, signed or readable. There is no route here: the callers that exist
//     once the switch is on (the setup agent's recorder, the review card, the task plan) call these functions.
//   - Org-scoped: a set lives under `private/<org>/fixtures/<digest>` and has the store id `fxs:<org>:<digest>`. The org comes from the CALLER's session, never from the id: a store id naming another
//     org, a digest only another org holds and a digest nobody holds all answer the same `not_found`, so the store is not a way to learn what another company has recorded. The same digest in two orgs is two objects.
//   - Never public: the object port writes with the install's KMS key and no public access (that is the adapter's contract); this module only ever asks for a 15-minute signed read of ONE key.
//   - Reviewed before it is used: a submitted set is parsed (v2, 2,000 entries, 4 MiB, every entry under its own hash), scanned for personal data, credentials and production names with the org's deny list, and
//     stored `pending`. Only an approval makes it deliverable; a scan finding stops the submission, so a set with a finding is never stored at all.
//   - Delivered by digest: `deliver` mints a 15-minute read URL for an APPROVED set and re-reads the stored bytes first, so a stored object that no longer hashes to its digest is never handed out. The worker
//     checks the digest again after it downloads (`worker/src/fixture-fetch.ts`).
//   - Approving is one decision on one set; a decided set cannot be decided again, and a set cannot be approved by the digest of a different one.
import { createHash } from "node:crypto";
import {
  FIXTURE_SET_MAX_BYTES,
  FixtureSetSchema,
  OrgIdSchema,
  canonicalJson,
  fixtureSetDigest,
  type FixtureSet,
  type TestEnvProdDeny,
} from "@agentx/contracts";
import type { DecisionItem } from "../decisions/project.js";
import { evidenceFindings } from "../rovara-code/evidence-guard.js";
import { plainLine } from "../decisions/text.js";

/** How long a signed read of a fake is good for (design 7.4). */
export const FIXTURE_READ_URL_SECONDS = 15 * 60;
export const FIXTURE_SAMPLE_PAIRS = 3;
const SAMPLE_CHARS = 300;
const DIGEST = /^[a-f0-9]{64}$/u;
const STORE_ID = /^fxs:(org_[0-9a-z]{20}):([a-f0-9]{64})$/u;

/** The id of a stored set: its org and its digest. Two orgs never share an id. */
export const fixtureStoreId = (orgId: string, digest: string): string => `fxs:${orgId}:${digest}`;
export function parseFixtureStoreId(storeId: string): { orgId: string; digest: string } | undefined {
  const found = STORE_ID.exec(storeId);
  return found === null ? undefined : { orgId: found[1]!, digest: found[2]! };
}

/** The object key of a set. `prefix` is `private` on Public Cloud (the Rovara bucket, one prefix per org); the Enterprise install gives its own bucket and key prefix to the adapter instead. */
export const fixtureObjectKey = (orgId: string, digest: string, prefix = "private"): string => `${prefix}/${orgId}/fixtures/${digest}`;

export type FixtureOrigin = FixtureSet["origin"];
/** Where the answers came from: a synthetic run, the company's own test account, or written by hand. A first recording from a test account raises the review card to high. */
export type FixtureRecordedFrom = "synthetic" | "test_account" | "written";

export interface FixtureRecord {
  storeId: string;
  orgId: string;
  digest: string;
  dependencyId: string;
  family: string;
  protocol: FixtureSet["dependency"]["protocol"];
  origin: FixtureOrigin;
  revision: number;
  entries: number;
  faults: number;
  bytes: number;
  recordedFrom: FixtureRecordedFrom;
  /** True when no approved set of this dependency was recorded from a test account before this one. */
  firstFromTestAccount: boolean;
  scanClean: boolean;
  status: "pending" | "approved" | "rejected";
  submittedBy: string;
  submittedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  /** Compare-and-set counter of the row. */
  version: number;
}

/** The object store. The adapter writes with the install's KMS key, versioned, and never public. */
export interface FixtureObjectPort {
  /** Writes the object unless one is there already (same key, same bytes by construction). */
  putIfAbsent(key: string, bytes: Uint8Array, contentType: string): Promise<"created" | "exists">;
  get(key: string, maxBytes: number): Promise<Uint8Array | undefined>;
  /** A signed GET for exactly this key, good for the seconds given. */
  presignGet(key: string, expiresInSeconds: number): Promise<string>;
}
/** The index of stored sets, one row per (org, digest). */
export interface FixtureIndexPort {
  get(orgId: string, digest: string): Promise<FixtureRecord | undefined>;
  /** False when the row exists. */
  putIfAbsent(record: FixtureRecord): Promise<boolean>;
  /** Replaces the row when its `version` is the expected one; false otherwise. */
  replace(record: FixtureRecord, expectedVersion: number): Promise<boolean>;
  listByDependency(orgId: string, dependencyId: string): Promise<FixtureRecord[]>;
}

export interface FixtureStoreDependencies {
  /** The `tx` switch, read on every call. */
  enabled(): boolean;
  objects: FixtureObjectPort;
  index: FixtureIndexPort;
  /** The org's production deny list (hosts, account ids, ARN prefixes). Fail closed: a list that cannot be read is an error, not an empty list. */
  denyFor(orgId: string): Promise<TestEnvProdDeny>;
  now?: () => Date;
  prefix?: string;
}

export type StoreRefusal = "disabled" | "bad_org" | "bad_digest" | "not_found";
export type SubmitRefusal = StoreRefusal | "invalid" | "too_large" | "data_guard";
export type DecideRefusal = StoreRefusal | "already_decided" | "digest_mismatch";
export type DeliverRefusal = StoreRefusal | "not_approved" | "digest_mismatch";

/** What the review card shows (design 7.4): counts, the schema, three redacted sample pairs, the scan result, the ignored paths and the faults. Plain text and numbers, cut; nothing the page may follow. */
export interface FixtureReview {
  storeId: string;
  digest: string;
  dependency: FixtureSet["dependency"];
  origin: FixtureOrigin;
  revision: number;
  recordedFrom: FixtureRecordedFrom;
  counts: { entries: number; faults: number; bytes: number };
  schema: { request: string[] | null; response: string[] | null };
  samples: Array<{ method: string; path: string; query: string; requestBody: string; status: number; responseBody: string }>;
  scan: { clean: boolean };
  ignorePaths: string[];
  faults: Array<{ name: string; kind: string; status: number | null; delayMs: number }>;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const cut = (text: string): string => plainLine(text, SAMPLE_CHARS);

/** The words of a schema's top level: its type and the names it lists, for the card. Never values. */
function schemaOutline(schema: FixtureSet["requestSchema"]): string[] | null {
  if (schema === undefined) return null;
  const names = Object.keys(schema.properties ?? {}).slice(0, 12).map((name) => plainLine(name, 40));
  return [`type ${schema.type}`, ...(names.length === 0 ? [] : [`fields ${names.join(", ")}`])];
}

/** The review of a set: built only from a set that parsed and is stored, so every sample pair is already scanned clean. */
export function fixtureReviewOf(record: FixtureRecord, set: FixtureSet): FixtureReview {
  return {
    storeId: record.storeId, digest: record.digest, dependency: set.dependency, origin: set.origin, revision: set.revision, recordedFrom: record.recordedFrom,
    counts: { entries: set.entries.length, faults: set.faults.length, bytes: record.bytes },
    schema: { request: schemaOutline(set.requestSchema), response: schemaOutline(set.responseSchema) },
    samples: set.entries.slice(0, FIXTURE_SAMPLE_PAIRS).map((entry) => ({
      method: entry.request.method, path: cut(entry.request.path), query: cut((entry.request.query ?? []).map((pair) => `${pair.name}=${pair.value}`).join("&")),
      requestBody: cut(entry.request.body), status: entry.response.status, responseBody: cut(entry.response.body),
    })),
    scan: { clean: record.scanClean },
    ignorePaths: set.match.ignorePaths.map((path) => plainLine(path, 200)),
    faults: set.faults.map((fault) => ({ name: fault.name, kind: fault.kind, status: fault.status ?? null, delayMs: fault.delayMs })),
  };
}

/** The decision card's item for a review (kind `approve_fixture_set`). `schemaSynth` is a property of how the environment uses the fake (its backing says `schema_synth`), so the caller says it. */
export function fixtureSetCardItem(input: {
  record: FixtureRecord;
  review: FixtureReview;
  project: string;
  /** The page that shows the whole review (a path under `/app/` or `/v1/app/`). */
  openPath: string;
  confirmPath?: string;
  taskId?: string;
  schemaSynth: boolean;
}): Extract<DecisionItem, { kind: "approve_fixture_set" }> {
  const { record, review } = input;
  const sample = (index: number, pair: FixtureReview["samples"][number]): string[] => [
    `Sample ${String(index + 1)}: ${pair.method} ${pair.path}${pair.query === "" ? "" : `?${pair.query}`}`,
    `  asks: ${pair.requestBody === "" ? "(no body)" : pair.requestBody}`,
    `  gets: ${String(pair.status)} ${pair.responseBody === "" ? "(no body)" : pair.responseBody}`,
  ];
  const details = [
    { title: "Sample answers (cut, from the recording)", lines: review.samples.flatMap((pair, index) => sample(index, pair)) },
    { title: "Schema", lines: [`Request: ${review.schema.request?.join("; ") ?? "none"}`, `Answer: ${review.schema.response?.join("; ") ?? "none"}`] },
    { title: "Ignored when matching a request", lines: review.ignorePaths.length === 0 ? ["Nothing is ignored."] : review.ignorePaths },
    { title: "Named faults", lines: review.faults.length === 0 ? ["None."] : review.faults.map((fault) => `${fault.name}: ${fault.kind}${fault.status === null ? "" : ` ${String(fault.status)}`}, after ${String(fault.delayMs)} ms`) },
    { title: "Where it came from", lines: [record.recordedFrom === "test_account" ? "Recorded with the company's test account." : record.recordedFrom === "written" ? "Written by hand." : "Recorded from synthetic inputs.", `Revision ${String(review.revision)}.`] },
  ];
  return {
    kind: "approve_fixture_set", subjectId: record.digest.slice(0, 40), ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    project: input.project, title: `Answers for ${review.dependency.id}`, createdAt: record.submittedAt, openPath: input.openPath, ...(input.confirmPath === undefined ? {} : { confirmPath: input.confirmPath }),
    // The card is bound to the digest: a different set is a different card, and an earlier "evidence opened" is worth nothing for it.
    contentVersion: record.digest, details,
    dependency: review.dependency.id, origin: review.origin, entries: review.counts.entries, faults: review.counts.faults, scanClean: review.scan.clean,
    schemaSynth: input.schemaSynth, firstFromTestAccount: record.firstFromTestAccount,
    ...(record.status === "approved" ? { outcome: "approved" as const } : record.status === "rejected" ? { outcome: "rejected" as const } : {}),
  };
}

export interface FixtureStore {
  submit(orgId: string, raw: unknown, input: { actor: string; recordedFrom: FixtureRecordedFrom }): Promise<{ ok: true; record: FixtureRecord; created: boolean } | { ok: false; reason: SubmitRefusal }>;
  record(orgId: string, digest: string): Promise<{ ok: true; record: FixtureRecord } | { ok: false; reason: StoreRefusal }>;
  review(orgId: string, digest: string): Promise<{ ok: true; review: FixtureReview; record: FixtureRecord } | { ok: false; reason: StoreRefusal | "digest_mismatch" }>;
  approve(orgId: string, digest: string, actor: string): Promise<{ ok: true; record: FixtureRecord } | { ok: false; reason: DecideRefusal }>;
  reject(orgId: string, digest: string, actor: string): Promise<{ ok: true; record: FixtureRecord } | { ok: false; reason: DecideRefusal }>;
  /** The 15-minute read URL for an approved set of THIS org. */
  deliver(orgId: string, digest: string): Promise<{ ok: true; url: string; digest: string; storeId: string; expiresAt: string; bytes: number } | { ok: false; reason: DeliverRefusal }>;
  /** The same, from a store id (the task plan names one): the id's org must be the caller's. */
  deliverById(callerOrgId: string, storeId: string): ReturnType<FixtureStore["deliver"]>;
  /** The approved set itself, with the stored bytes checked against the digest. */
  readApproved(orgId: string, digest: string): Promise<{ ok: true; set: FixtureSet } | { ok: false; reason: DeliverRefusal }>;
}

export function createFixtureStore(deps: FixtureStoreDependencies): FixtureStore {
  const now = deps.now ?? (() => new Date());
  const prefix = deps.prefix ?? "private";
  const keyOf = (orgId: string, digest: string): string => fixtureObjectKey(orgId, digest, prefix);
  const gate = (orgId: string, digest?: string): StoreRefusal | undefined => {
    if (!deps.enabled()) return "disabled";
    if (!OrgIdSchema.safeParse(orgId).success) return "bad_org";
    if (digest !== undefined && !DIGEST.test(digest)) return "bad_digest";
    return undefined;
  };
  /** The row of THIS org; a row that says another org (a corrupt index) is not found either. */
  const rowOf = async (orgId: string, digest: string): Promise<FixtureRecord | undefined> => {
    const row = await deps.index.get(orgId, digest);
    return row !== undefined && row.orgId === orgId && row.digest === digest && row.storeId === fixtureStoreId(orgId, digest) ? row : undefined;
  };
  /** The stored bytes of a row, parsed, and held against the digest. Undefined: nothing stored; "mismatch": the object is not the set the digest names. */
  const load = async (orgId: string, digest: string): Promise<{ set: FixtureSet; bytes: number } | "mismatch" | undefined> => {
    const bytes = await deps.objects.get(keyOf(orgId, digest), FIXTURE_SET_MAX_BYTES + 1);
    if (bytes === undefined) return undefined;
    if (bytes.length > FIXTURE_SET_MAX_BYTES || sha256(bytes) !== digest) return "mismatch";
    let parsed: FixtureSet;
    try { parsed = FixtureSetSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); } catch { return "mismatch"; }
    return fixtureSetDigest(parsed) === digest ? { set: parsed, bytes: bytes.length } : "mismatch";
  };
  const decide = async (orgId: string, digest: string, actor: string, status: "approved" | "rejected"): Promise<{ ok: true; record: FixtureRecord } | { ok: false; reason: DecideRefusal }> => {
    const refused = gate(orgId, digest);
    if (refused !== undefined) return { ok: false, reason: refused };
    const row = await rowOf(orgId, digest);
    if (row === undefined) return { ok: false, reason: "not_found" };
    if (row.status !== "pending") return { ok: false, reason: "already_decided" };
    if (status === "approved") {
      // A set that was stored but no longer hashes to its digest, or that is gone, is never approved.
      const loaded = await load(orgId, digest);
      if (loaded === undefined || !row.scanClean) return { ok: false, reason: "not_found" };
      if (loaded === "mismatch") return { ok: false, reason: "digest_mismatch" };
    }
    const next: FixtureRecord = { ...row, status, decidedBy: plainLine(actor, 120), decidedAt: now().toISOString(), version: row.version + 1 };
    return (await deps.index.replace(next, row.version)) ? { ok: true, record: next } : { ok: false, reason: "already_decided" };
  };

  const deliver: FixtureStore["deliver"] = async (orgId, digest) => {
    const refused = gate(orgId, digest);
    if (refused !== undefined) return { ok: false, reason: refused };
    const row = await rowOf(orgId, digest);
    if (row === undefined) return { ok: false, reason: "not_found" };
    if (row.status !== "approved") return { ok: false, reason: "not_approved" };
    const loaded = await load(orgId, digest);
    if (loaded === undefined) return { ok: false, reason: "not_found" };
    if (loaded === "mismatch") return { ok: false, reason: "digest_mismatch" };
    const url = await deps.objects.presignGet(keyOf(orgId, digest), FIXTURE_READ_URL_SECONDS);
    return { ok: true, url, digest, storeId: row.storeId, expiresAt: new Date(now().getTime() + FIXTURE_READ_URL_SECONDS * 1000).toISOString(), bytes: loaded.bytes };
  };

  return {
    async submit(orgId, raw, input) {
      const refused = gate(orgId);
      if (refused !== undefined) return { ok: false, reason: refused };
      const parsed = FixtureSetSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, reason: "invalid" };
      const set = parsed.data;
      const canonical = canonicalJson(set);
      const bytes = new TextEncoder().encode(canonical);
      if (bytes.length > FIXTURE_SET_MAX_BYTES) return { ok: false, reason: "too_large" };
      // The scan covers every string the set holds (paths, queries, bodies, header values), with the org's own deny list; a finding stops the submission and nothing is stored.
      const findings = evidenceFindings(set, await deps.denyFor(orgId));
      if (findings.length > 0) return { ok: false, reason: "data_guard" };
      const digest = sha256(bytes);
      if (digest !== fixtureSetDigest(set)) return { ok: false, reason: "invalid" };
      const existing = await rowOf(orgId, digest);
      if (existing !== undefined) return { ok: true, record: existing, created: false };
      const earlier = input.recordedFrom === "test_account" ? await deps.index.listByDependency(orgId, set.dependency.id) : [];
      await deps.objects.putIfAbsent(keyOf(orgId, digest), bytes, "application/json");
      const record: FixtureRecord = {
        storeId: fixtureStoreId(orgId, digest), orgId, digest, dependencyId: set.dependency.id, family: set.dependency.family, protocol: set.dependency.protocol, origin: set.origin, revision: set.revision,
        entries: set.entries.length, faults: set.faults.length, bytes: bytes.length, recordedFrom: input.recordedFrom,
        firstFromTestAccount: input.recordedFrom === "test_account" && !earlier.some((other) => other.recordedFrom === "test_account" && other.status === "approved"),
        scanClean: true, status: "pending", submittedBy: plainLine(input.actor, 120), submittedAt: now().toISOString(), version: 1,
      };
      if (!(await deps.index.putIfAbsent(record))) {
        const winner = await rowOf(orgId, digest);
        return winner === undefined ? { ok: false, reason: "not_found" } : { ok: true, record: winner, created: false };
      }
      return { ok: true, record, created: true };
    },
    async record(orgId, digest) {
      const refused = gate(orgId, digest);
      if (refused !== undefined) return { ok: false, reason: refused };
      const row = await rowOf(orgId, digest);
      return row === undefined ? { ok: false, reason: "not_found" } : { ok: true, record: row };
    },
    async review(orgId, digest) {
      const refused = gate(orgId, digest);
      if (refused !== undefined) return { ok: false, reason: refused };
      const row = await rowOf(orgId, digest);
      if (row === undefined) return { ok: false, reason: "not_found" };
      const loaded = await load(orgId, digest);
      if (loaded === undefined) return { ok: false, reason: "not_found" };
      if (loaded === "mismatch") return { ok: false, reason: "digest_mismatch" };
      return { ok: true, review: fixtureReviewOf(row, loaded.set), record: row };
    },
    approve: (orgId, digest, actor) => decide(orgId, digest, actor, "approved"),
    reject: (orgId, digest, actor) => decide(orgId, digest, actor, "rejected"),
    deliver,
    async deliverById(callerOrgId, storeId) {
      const refused = gate(callerOrgId);
      if (refused !== undefined) return { ok: false, reason: refused };
      const parsed = parseFixtureStoreId(storeId);
      // An id that names another org is answered exactly as an id nobody holds.
      if (parsed === undefined || parsed.orgId !== callerOrgId) return { ok: false, reason: "not_found" };
      return deliver(callerOrgId, parsed.digest);
    },
    async readApproved(orgId, digest) {
      const refused = gate(orgId, digest);
      if (refused !== undefined) return { ok: false, reason: refused };
      const row = await rowOf(orgId, digest);
      if (row === undefined) return { ok: false, reason: "not_found" };
      if (row.status !== "approved") return { ok: false, reason: "not_approved" };
      const loaded = await load(orgId, digest);
      if (loaded === undefined) return { ok: false, reason: "not_found" };
      return loaded === "mismatch" ? { ok: false, reason: "digest_mismatch" } : { ok: true, set: loaded.set };
    },
  };
}

/** In-memory ports for tests and the local run. The real adapters (S3 with KMS, and a DynamoDB index) implement the same two interfaces. */
export function createMemoryFixturePorts(options: { signUrl?: (key: string, seconds: number) => string } = {}): { objects: FixtureObjectPort & { dump(): Map<string, Uint8Array> }; index: FixtureIndexPort } {
  const blobs = new Map<string, Uint8Array>();
  const rows = new Map<string, FixtureRecord>();
  const rowKey = (orgId: string, digest: string): string => `${orgId}/${digest}`;
  return {
    objects: {
      putIfAbsent: (key, bytes) => { if (blobs.has(key)) return Promise.resolve("exists"); blobs.set(key, bytes); return Promise.resolve("created"); },
      get: (key, maxBytes) => { const found = blobs.get(key); return Promise.resolve(found === undefined ? undefined : found.length > maxBytes ? found.slice(0, maxBytes) : found); },
      presignGet: (key, seconds) => Promise.resolve(options.signUrl?.(key, seconds) ?? `https://fixtures.invalid/${key}?expires=${String(seconds)}`),
      dump: () => blobs,
    },
    index: {
      get: (orgId, digest) => Promise.resolve(rows.get(rowKey(orgId, digest))),
      putIfAbsent: (record) => { const key = rowKey(record.orgId, record.digest); if (rows.has(key)) return Promise.resolve(false); rows.set(key, record); return Promise.resolve(true); },
      replace: (record, expectedVersion) => { const key = rowKey(record.orgId, record.digest); if (rows.get(key)?.version !== expectedVersion) return Promise.resolve(false); rows.set(key, record); return Promise.resolve(true); },
      listByDependency: (orgId, dependencyId) => Promise.resolve([...rows.values()].filter((row) => row.orgId === orgId && row.dependencyId === dependencyId)),
    },
  };
}
