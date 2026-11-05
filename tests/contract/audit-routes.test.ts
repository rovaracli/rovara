// tests/contract/audit-routes.test.ts
// Task 12 of the Audit Ledger plan: the org audit routes (owners and admins of one org) and the staff path, which is
// fail-closed (I7): the `audit.staff_read` record is made durable BEFORE anything is read, and a record that cannot be made
// durable is a 503 with nothing read. The bench is Task 11's (FakeDynamoDb for every table, the real appender so that
// details are really sealed, a fake KMS, a fake intake queue); the routes are called directly, and a last group goes
// through the broker's handler to show the wiring. The fakes do not enforce IAM: the broker's grants are pinned in
// audit-ledger-infrastructure.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIT_LIMITS_COPY,
  AuditEventInputSchema,
  agentXError,
  auditOperatorId,
  type AuditEventInput,
  type OrgId,
  type OrgRole,
} from "@agentx/contracts";
import { appendEvent } from "../../packages/broker/src/audit/appender.js";
import { auditExportId, exportObjectKey } from "../../packages/broker/src/audit/export.js";
import { readAuditRecords } from "../../packages/broker/src/audit/reader.js";
import { routeAuditRequest, type AuditOrgCaller } from "../../packages/broker/src/audit/routes.js";
import { routeAuditAdminRequest, type AuditAdminCaller } from "../../packages/broker/src/audit/admin-routes.js";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { adminCall, adminIssuer, createAdminBroker } from "../support/admin-broker.js";
import { localSigner } from "../support/developer-fakes.js";
import { seedMembership } from "../support/developer-task-broker.js";
import { A, B, LEDGER, SEALS, at, iso } from "../support/audit-anchor-harness.js";
import { C, EXPORTS_BUCKET, KEYS, STATE, bench, orgStore, world, type Bench } from "../support/audit-routes-bench.js";

const FORBIDDEN_COPY = "FORBIDDEN: Only your organization's owners and admins can see its audit log.";
const REASON_COPY = "AUDIT_REASON_REQUIRED: Say why you are reading this company's audit log (1 to 300 characters).";
const UNAVAILABLE_COPY = "AUDIT_UNAVAILABLE: Rovara couldn't record this read, so it didn't read anything. Try again in a minute.";

// ---- calling the routes -----------------------------------------------------------------------------------------------

let requests = 0;
const nextRequestId = (): string => `req-${String(++requests)}`;
const url = (path: string): URL => new URL(path, "https://rovara.test");

const member = (orgId: string, orgRole: OrgRole, developerId = "dev_1"): AuditOrgCaller => ({ developerId, orgId, orgRole });
const adminOf = (orgId: string): AuditOrgCaller => member(orgId, "admin");

function orgCall(b: Bench, caller: AuditOrgCaller, method: string, path: string, body?: unknown) {
  return routeAuditRequest(b.deps, caller, { method, body: body ?? {}, requestId: nextRequestId() }, url(path));
}

const ISSUER = "https://staff-idp.example.test";
const staff: AuditAdminCaller = { issuer: ISSUER, subject: "staff-1", isAdministrator: true };
const operatorId = auditOperatorId(ISSUER, "staff-1");

function staffCall(b: Bench, method: string, path: string, body?: unknown, caller: AuditAdminCaller = staff, orgExists?: (orgId: OrgId) => Promise<boolean>) {
  const orgs = orgStore(b);
  return routeAuditAdminRequest(
    { ledger: b.deps, orgExists: orgExists ?? (async (orgId) => (await orgs.getOrg(orgId)) !== undefined) },
    caller,
    { method, body: body ?? {}, requestId: nextRequestId() },
    url(path),
  );
}

const STAFF_QUERY = "reason=Customer%20ticket%20asked%20for%20it&ticket=SUP-42";

/** Tables the ledger lives in: a read of any of them is "a read of the ledger". */
const LEDGER_TABLES = new Set([LEDGER, SEALS, KEYS]);
const ledgerOperations = (b: Bench, since = 0) => b.h.operations.slice(since).filter((operation) => LEDGER_TABLES.has(operation.table));
const pendingItems = (b: Bench) => b.h.db.find((item) => String(item.pk).startsWith("AUDIT_PENDING#")).map((item) => item.event as AuditEventInput);
/** Every event the intake queue holds. */
const queued = (b: Bench): AuditEventInput[] => b.sqs.queue.map((message) => JSON.parse(message.body) as AuditEventInput);
const exportMetaKey = (orgId: string, exportId: string) => ({ pk: `ORG#${orgId}#AUDIT_EXPORT#${exportId}`, sk: "META" });
const exportItems = (b: Bench) => b.h.db.find((item) => String(item.pk).includes("#AUDIT_EXPORT#"));

/** What the appender would do with everything the queue holds: the org's chain then carries it. */
async function deliver(b: Bench): Promise<void> {
  for (const message of b.sqs.queue.splice(0)) await appendEvent(b.appender, AuditEventInputSchema.parse(JSON.parse(message.body)));
}

/** Makes the export `exportId` of `orgId` a finished one, as the export function does, naming its file. */
function finishExport(b: Bench, orgId: string, exportId: string, patch: Record<string, unknown> = {}): string {
  const key = exportMetaKey(orgId, exportId);
  const item = b.h.db.get(key)!;
  const objectKey = exportObjectKey(orgId, exportId, "0123456789abcdef");
  b.h.db.set({ ...item, status: "ready", completedAt: iso(b.h.clock.now), expiresAt: iso(b.h.clock.now + 6 * 86_400_000), objectKey, summary: { fromSeq: 1, toSeq: 12, records: 12 }, ...patch });
  return objectKey;
}

const rejection = (promise: Promise<unknown>) => expect(promise).rejects;

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- the org routes -------------------------------------------------------------------------------------------------

describe("org routes: who may call", () => {
  it("answers a member (a contributor) FORBIDDEN with the exact text, on all four routes, and reads nothing", async () => {
    const b = await world();
    const before = b.h.operations.length;
    const contributor = member(A, "member");
    for (const [method, path] of [["GET", "/v1/app/org/audit/records"], ["GET", "/v1/app/org/audit/status"], ["POST", "/v1/app/org/audit/exports"], ["GET", `/v1/app/org/audit/exports/${auditExportId(A, "r")}`]] as const) {
      await rejection(orgCall(b, contributor, method, path, { requestId: "r", fromSeq: 1, toSeq: 2 })).toMatchObject({ code: "FORBIDDEN", statusCode: 403, message: FORBIDDEN_COPY });
    }
    expect(b.h.operations.length).toBe(before);
    expect(b.sqs.offered()).toBe(0);
    expect(b.invocations).toStrictEqual([]);
  });

  it("lets an owner and an admin through", async () => {
    const b = await world();
    for (const role of ["owner", "admin"] as const) {
      const reply = await orgCall(b, member(A, role), "GET", "/v1/app/org/audit/status");
      expect(reply.status).toBe(200);
    }
  });

  it("is also reachable under /v1/dev, the prefix the CLI and the MCP server use", async () => {
    const b = await world();
    expect((await orgCall(b, adminOf(A), "GET", "/v1/dev/org/audit/status")).status).toBe(200);
  });

  it("answers an unknown path or method NOT_FOUND, after the role check", async () => {
    const b = await world();
    await rejection(orgCall(b, adminOf(A), "GET", "/v1/app/org/audit/nothing")).toMatchObject({ code: "NOT_FOUND" });
    await rejection(orgCall(b, adminOf(A), "DELETE", "/v1/app/org/audit/records")).toMatchObject({ code: "NOT_FOUND" });
    await rejection(orgCall(b, adminOf(A), "POST", "/v1/app/org/audit/records")).toMatchObject({ code: "NOT_FOUND" });
    await rejection(orgCall(b, member(A, "member"), "GET", "/v1/app/org/audit/nothing")).toMatchObject({ code: "FORBIDDEN" });
  });

  it("answers NOT_FOUND where the install has no ledger (a legacy install), after the role check", async () => {
    const reply = (caller: AuditOrgCaller) => routeAuditRequest(undefined, caller, { method: "GET", body: {}, requestId: nextRequestId() }, url("/v1/app/org/audit/status"));
    await expect(reply(adminOf(A))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(reply(member(A, "member"))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("GET /v1/app/org/audit/records", () => {
  it("returns the org's records with their details opened, and the ledger's state", async () => {
    const b = await world();
    const reply = await orgCall(b, adminOf(A), "GET", "/v1/app/org/audit/records?limit=3");
    expect(reply.status).toBe(200);
    const body = reply.body as { records: Array<{ record: { seq: number; orgId: string }; details: Array<{ subject: string; fields?: Record<string, string> }> }>; nextCursor?: string; headSeq: number; sealedThroughSeq: number; epochsWithoutTimestamp: string[]; lockMode?: string };
    expect(body.records.map((entry) => entry.record.seq)).toStrictEqual([1, 2, 3]);
    for (const entry of body.records) expect(entry.record.orgId).toBe(A);
    expect(body.records[0]!.details[0]).toMatchObject({ subject: "dev_1", fields: { name: `Person of ${A}` } });
    expect(body).toMatchObject({ headSeq: 12, sealedThroughSeq: 10, lockMode: "COMPLIANCE" });
    expect(body.nextCursor).toBeDefined();
    expect(JSON.stringify(body)).not.toContain(B);
  });

  it("pages with the cursor it gave, filters, and takes a time range", async () => {
    const b = await world();
    const first = (await orgCall(b, adminOf(A), "GET", "/v1/app/org/audit/records?limit=5")).body as { nextCursor: string; records: unknown[] };
    const second = (await orgCall(b, adminOf(A), "GET", `/v1/app/org/audit/records?limit=5&cursor=${first.nextCursor}`)).body as { records: Array<{ record: { seq: number } }> };
    expect(second.records.map((entry) => entry.record.seq)).toStrictEqual([6, 7, 8, 9, 10]);
    const filtered = (await orgCall(b, adminOf(A), "GET", "/v1/app/org/audit/records?actorId=dev_2&fromSeq=1&toSeq=12")).body as { records: Array<{ record: { actor: { id: string } } }> };
    expect(filtered.records).toHaveLength(6);
    for (const entry of filtered.records) expect(entry.record.actor.id).toBe("dev_2");
    const ranged = (await orgCall(b, adminOf(A), "GET", `/v1/app/org/audit/records?from=${encodeURIComponent(iso(at(1) - 120_000))}`)).body as { records: Array<{ record: { seq: number } }> };
    expect(ranged.records.map((entry) => entry.record.seq)[0]).toBe(7);
  });

  it("QA6-09: order=newest returns the newest records first, pages back with its own cursor to the oldest, and honours the filters and the time range; without it the order is as before", async () => {
    const b = await world();
    const page = async (query: string) => (await orgCall(b, adminOf(A), "GET", `/v1/app/org/audit/records?${query}`)).body as { records: Array<{ record: { seq: number } }>; nextCursor?: string };
    const first = await page("order=newest&limit=5");
    expect(first.records.map((entry) => entry.record.seq)).toStrictEqual([12, 11, 10, 9, 8]);
    const second = await page(`order=newest&limit=5&cursor=${first.nextCursor!}`);
    expect(second.records.map((entry) => entry.record.seq)).toStrictEqual([7, 6, 5, 4, 3]);
    const third = await page(`order=newest&limit=5&cursor=${second.nextCursor!}`);
    expect(third.records.map((entry) => entry.record.seq)).toStrictEqual([2, 1]);
    expect(third.nextCursor).toBeUndefined();
    expect((await page("order=newest&limit=50")).nextCursor).toBeUndefined();
    const filtered = await page("order=newest&actorId=dev_2&fromSeq=1&toSeq=12&limit=3");
    expect(filtered.records).toHaveLength(3);
    const seqs = filtered.records.map((entry) => entry.record.seq);
    expect(seqs).toStrictEqual([...seqs].sort((x, y) => y - x));
    const ranged = await page(`order=newest&limit=50&from=${encodeURIComponent(iso(at(1) - 120_000))}`);
    expect(ranged.records.map((entry) => entry.record.seq)[0]).toBe(12);
    expect(ranged.records.at(-1)?.record.seq).toBe(7);
    expect((await page("limit=3")).records.map((entry) => entry.record.seq)).toStrictEqual([1, 2, 3]);
    await rejection(orgCall(b, adminOf(A), "GET", "/v1/app/org/audit/records?order=oldest")).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("QA6-09: names for the members the page names, from the resolver the route is given (display names only; ids it cannot name are left out); none asked, none returned", async () => {
    const b = await world();
    const asked: string[][] = [];
    const names = async (ids: string[]) => { asked.push(ids); return Object.fromEntries(ids.filter((id) => id === "dev_1").map((id) => [id, "Priya"])); };
    const reply = await routeAuditRequest(b.deps, adminOf(A), { method: "GET", body: {}, requestId: nextRequestId() }, url("/v1/app/org/audit/records?limit=4"), names);
    expect((reply.body as { actorNames?: Record<string, string> }).actorNames).toEqual({ dev_1: "Priya" });
    expect(asked).toHaveLength(1);
    expect(new Set(asked[0])).toContain("dev_1");
    expect(asked[0]!.length).toBe(new Set(asked[0]).size);
    const plain = await orgCall(b, adminOf(A), "GET", "/v1/app/org/audit/records?limit=4");
    expect(plain.body).not.toHaveProperty("actorNames");
    const failing = await routeAuditRequest(b.deps, adminOf(A), { method: "GET", body: {}, requestId: nextRequestId() }, url("/v1/app/org/audit/records?limit=4"), async () => { throw new Error("names down"); });
    expect(failing.status).toBe(200);
    expect(failing.body).not.toHaveProperty("actorNames");
  });

  it("refuses what is not a query of this route: unknown or repeated parameters, an org id, and whole numbers that are not", async () => {
    const b = await world();
    await rejection(orgCall(b, adminOf(A), "GET", `/v1/app/org/audit/records?orgId=${B}`)).toMatchObject({ code: "CONFIG_INVALID" });
    await rejection(orgCall(b, adminOf(A), "GET", "/v1/app/org/audit/records?reason=because")).toMatchObject({ code: "CONFIG_INVALID" });
    await rejection(orgCall(b, adminOf(A), "GET", "/v1/app/org/audit/records?limit=1&limit=2")).toMatchObject({ code: "CONFIG_INVALID" });
    for (const bad of ["fromSeq=abc", "fromSeq=0", "toSeq=-1", "limit=0", "limit=1.5", "fromSeq=5&toSeq=2"]) {
      await rejection(orgCall(b, adminOf(A), "GET", `/v1/app/org/audit/records?${bad}`)).toMatchObject({ code: "AUDIT_RANGE_INVALID", statusCode: 400 });
    }
  });

  it("passes a filter that is too wide through as AUDIT_FILTER_TOO_WIDE", async () => {
    const b = bench();
    b.h.db.set({ pk: `AUDIT#${C}`, sk: "HEAD", seq: 30_000, hash: "0".repeat(64), updatedAt: iso(at(0)) });
    await rejection(orgCall(b, adminOf(C), "GET", "/v1/app/org/audit/records?action=pull_request.opened")).toMatchObject({ code: "AUDIT_FILTER_TOO_WIDE", statusCode: 400 });
  });
});

describe("GET /v1/app/org/audit/status", () => {
  it("answers the ledger's state and the limits copy, as the CLI and the MCP tool show them", async () => {
    const b = await world();
    const reply = await orgCall(b, adminOf(A), "GET", "/v1/app/org/audit/status");
    expect(reply.body).toMatchObject({ headSeq: 12, sealedThroughSeq: 10, lockMode: "COMPLIANCE", limits: AUDIT_LIMITS_COPY });
    const body = reply.body as { epochsWithoutTimestamp: string[]; latestTimestamp?: string };
    // Nothing is stamped in this bench: the two epochs say so, and no date is offered beside them.
    expect(body.epochsWithoutTimestamp.length).toBe(2);
    expect(body.latestTimestamp).toBeUndefined();
    expect(Object.keys(reply.body).sort()).toStrictEqual(["epochsWithoutTimestamp", "headSeq", "limits", "lockMode", "sealedThroughSeq"]);
  });

  it("is the same for an org with no records", async () => {
    const b = bench();
    const reply = await orgCall(b, adminOf(C), "GET", "/v1/app/org/audit/status");
    expect(reply.body).toMatchObject({ headSeq: 0, sealedThroughSeq: 0, epochsWithoutTimestamp: [], limits: AUDIT_LIMITS_COPY });
  });
});

describe("org routes: tenancy", () => {
  it("shows B's admin B's data for A's ranges, A's cursors and A's filters, never A's", async () => {
    const b = await world();
    const mine = await orgCall(b, adminOf(A), "GET", "/v1/app/org/audit/records?limit=2");
    const cursor = (mine.body as { nextCursor: string }).nextCursor;
    for (const query of ["fromSeq=1&toSeq=12", `cursor=${cursor}`, "fromSeq=7&toSeq=12", "limit=200"]) {
      const reply = await orgCall(b, adminOf(B), "GET", `/v1/app/org/audit/records?${query}`);
      const body = reply.body as { records: Array<{ record: { orgId: string; seq: number } }>; headSeq: number };
      expect(body.headSeq).toBe(3);
      for (const entry of body.records) {
        expect(entry.record.orgId).toBe(B);
        expect(entry.record.seq).toBeLessThanOrEqual(3);
      }
      expect(JSON.stringify(reply.body)).not.toContain(A);
    }
    const status = await orgCall(b, adminOf(B), "GET", "/v1/app/org/audit/status");
    expect(status.body).toMatchObject({ headSeq: 3, sealedThroughSeq: 3 });
    // Every ledger read the calls of B made was under B's partitions.
    const touched = b.h.operations.filter((operation) => LEDGER_TABLES.has(operation.table)).map((operation) => operation.pk);
    expect(touched.some((pk) => pk.includes(A))).toBe(true);
    const mark = b.h.operations.length;
    await orgCall(b, adminOf(B), "GET", "/v1/app/org/audit/records");
    for (const operation of b.h.operations.slice(mark).filter((entry) => LEDGER_TABLES.has(entry.table))) expect(operation.pk, JSON.stringify(operation)).not.toContain(A);
  });

  it("answers NOT_FOUND to B's admin for A's export, and for an export id that is no export", async () => {
    const b = await world();
    const started = (await orgCall(b, adminOf(A), "POST", "/v1/app/org/audit/exports", { requestId: "mine", fromSeq: 1, toSeq: 12 })).body as { exportId: string };
    finishExport(b, A, started.exportId);
    expect((await orgCall(b, adminOf(A), "GET", `/v1/app/org/audit/exports/${started.exportId}`)).status).toBe(200);
    await rejection(orgCall(b, adminOf(B), "GET", `/v1/app/org/audit/exports/${started.exportId}`)).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    for (const id of ["aex_nothing", "..%2F..%2Fother", "aex_" + "0".repeat(32)]) {
      await rejection(orgCall(b, adminOf(B), "GET", `/v1/app/org/audit/exports/${id}`)).toMatchObject({ code: "NOT_FOUND" });
    }
    expect(b.presigned.every((input) => input.key.startsWith(`${A}/`))).toBe(true);
  });

  it("puts a request id's export under the caller's org: the same request id in two orgs is two exports", async () => {
    const b = await world();
    const mine = (await orgCall(b, adminOf(A), "POST", "/v1/app/org/audit/exports", { requestId: "same", fromSeq: 1, toSeq: 3 })).body as { exportId: string };
    const theirs = (await orgCall(b, adminOf(B), "POST", "/v1/app/org/audit/exports", { requestId: "same", fromSeq: 1, toSeq: 3 })).body as { exportId: string };
    expect(mine.exportId).toBe(auditExportId(A, "same"));
    expect(theirs.exportId).toBe(auditExportId(B, "same"));
    expect(mine.exportId).not.toBe(theirs.exportId);
    expect(b.invocations.map((event) => event.orgId)).toStrictEqual([A, B]);
  });

  it("takes the org from the session only: an orgId in the body is refused", async () => {
    const b = await world();
    await rejection(orgCall(b, adminOf(B), "POST", "/v1/app/org/audit/exports", { requestId: "x", fromSeq: 1, toSeq: 3, orgId: A })).toMatchObject({ code: "CONFIG_INVALID" });
    expect(b.invocations).toStrictEqual([]);
  });
});

describe("POST /v1/app/org/audit/exports", () => {
  it("records the request as running, starts the export function for this org, and says 202", async () => {
    const b = await world();
    const reply = await orgCall(b, member(A, "owner", "dev_9"), "POST", "/v1/app/org/audit/exports", { requestId: "export-1", fromSeq: 1, toSeq: 12, withDetails: true });
    const exportId = auditExportId(A, "export-1");
    expect(reply).toStrictEqual({ status: 202, body: { exportId, status: "running" } });
    expect(b.invocations).toStrictEqual([{ source: "agentx.audit-export", orgId: A, exportId }]);
    expect(b.h.db.get(exportMetaKey(A, exportId))).toMatchObject({ status: "running", requestedBy: { kind: "member", id: "dev_9" }, range: { fromSeq: 1, toSeq: 12 }, withDetails: true });
  });

  it("is idempotent in the request id: a repeat starts nothing and answers the same export", async () => {
    const b = await world();
    await orgCall(b, adminOf(A), "POST", "/v1/app/org/audit/exports", { requestId: "again", fromSeq: 1, toSeq: 12 });
    const repeat = await orgCall(b, adminOf(A), "POST", "/v1/app/org/audit/exports", { requestId: "again", fromSeq: 1, toSeq: 12 });
    expect(repeat.body).toStrictEqual({ exportId: auditExportId(A, "again"), status: "running" });
    expect(b.invocations).toHaveLength(1);
    expect(exportItems(b)).toHaveLength(1);
  });

  it("refuses a bad range with AUDIT_RANGE_INVALID and starts nothing", async () => {
    const b = await world();
    for (const range of [{ fromSeq: 5, toSeq: 2 }, { fromSeq: 0, toSeq: 2 }, { fromSeq: 1, toSeq: 200_001 }, { fromSeq: "1", toSeq: 2 }, { fromSeq: 1.5, toSeq: 2 }, { toSeq: 2 }]) {
      await rejection(orgCall(b, adminOf(A), "POST", "/v1/app/org/audit/exports", { requestId: "bad", ...range })).toMatchObject({ code: "AUDIT_RANGE_INVALID", statusCode: 400 });
    }
    expect(b.invocations).toStrictEqual([]);
    expect(exportItems(b)).toStrictEqual([]);
  });

  it("refuses a body that is not the request: no request id, unknown fields, a reason or a ticket (staff only), not an object", async () => {
    const b = await world();
    const post = (body: unknown) => orgCall(b, adminOf(A), "POST", "/v1/app/org/audit/exports", body);
    await rejection(post({ fromSeq: 1, toSeq: 2 })).toMatchObject({ code: "CONFIG_INVALID" });
    await rejection(post({ requestId: "", fromSeq: 1, toSeq: 2 })).toMatchObject({ code: "CONFIG_INVALID" });
    await rejection(post({ requestId: "x".repeat(201), fromSeq: 1, toSeq: 2 })).toMatchObject({ code: "CONFIG_INVALID" });
    await rejection(post({ requestId: "x", fromSeq: 1, toSeq: 2, reason: "because" })).toMatchObject({ code: "CONFIG_INVALID" });
    await rejection(post({ requestId: "x", fromSeq: 1, toSeq: 2, ticket: "T-1" })).toMatchObject({ code: "CONFIG_INVALID" });
    await rejection(post({ requestId: "x", fromSeq: 1, toSeq: 2, withDetails: "yes" })).toMatchObject({ code: "CONFIG_INVALID" });
    await rejection(post("nope")).toMatchObject({ code: "CONFIG_INVALID" });
    await rejection(post([])).toMatchObject({ code: "CONFIG_INVALID" });
    expect(b.invocations).toStrictEqual([]);
  });

  it("says failed (not 202) when the export function could not be started, and the record is failed", async () => {
    const b = await world();
    b.deps.invokeExport = async () => { throw new Error("lambda down"); };
    const reply = await orgCall(b, adminOf(A), "POST", "/v1/app/org/audit/exports", { requestId: "nostart", fromSeq: 1, toSeq: 2 });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ status: "failed" });
  });

  it("does not record an audit.read: the export itself is recorded (audit.exported) when it completes", async () => {
    const b = await world();
    await orgCall(b, adminOf(A), "POST", "/v1/app/org/audit/exports", { requestId: "quiet", fromSeq: 1, toSeq: 2 });
    expect(b.sqs.offered()).toBe(0);
  });
});

describe("GET /v1/app/org/audit/exports/{exportId}", () => {
  const start = async (b: Bench, requestId = "e1") => (await orgCall(b, adminOf(A), "POST", "/v1/app/org/audit/exports", { requestId, fromSeq: 1, toSeq: 12 })).body as { exportId: string };

  it("shows a running export without a download, and records no read", async () => {
    const b = await world();
    const { exportId } = await start(b);
    const reply = await orgCall(b, adminOf(A), "GET", `/v1/app/org/audit/exports/${exportId}`);
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ exportId, status: "running", range: { fromSeq: 1, toSeq: 12 } });
    expect(reply.body).not.toHaveProperty("download");
    expect(JSON.stringify(reply.body)).not.toContain("signed.test");
    expect(b.sqs.offered()).toBe(0);
  });

  it("gives a ready export's download link, signed for the file the record names, and records the read", async () => {
    const b = await world();
    const { exportId } = await start(b);
    const objectKey = finishExport(b, A, exportId);
    const reply = await orgCall(b, member(A, "admin", "dev_7"), "GET", `/v1/app/org/audit/exports/${exportId}`);
    expect(reply.body).toMatchObject({ exportId, status: "ready", download: { url: `https://signed.test/${EXPORTS_BUCKET}/${objectKey}?expires=900`, expiresInSeconds: 900 } });
    // The route never builds a key: what was signed is the key on the record, in this org's name.
    expect(b.presigned).toStrictEqual([{ bucket: EXPORTS_BUCKET, key: objectKey, expiresInSeconds: 900 }]);
    expect(queued(b).map((event) => [event.action, event.orgId, event.actor, event.facts])).toStrictEqual([
      ["audit.read", A, { kind: "member", id: "dev_7" }, { fromSeq: 1, toSeq: 12, count: 12, via: "export-download" }],
    ]);
  });

  it("offers no link for a failed export, nor for an expired one", async () => {
    const b = await world();
    const failed = await start(b, "f");
    b.h.db.set({ ...b.h.db.get(exportMetaKey(A, failed.exportId))!, status: "failed", failure: { code: "COULD_NOT_START" } });
    const failedReply = await orgCall(b, adminOf(A), "GET", `/v1/app/org/audit/exports/${failed.exportId}`);
    expect(failedReply.body).toMatchObject({ status: "failed", failure: { code: "COULD_NOT_START" } });
    expect(failedReply.body).not.toHaveProperty("download");

    const expired = await start(b, "x");
    finishExport(b, A, expired.exportId, { expiresAt: iso(b.h.clock.now - 1000) });
    const expiredReply = await orgCall(b, adminOf(A), "GET", `/v1/app/org/audit/exports/${expired.exportId}`);
    expect(expiredReply.body).toMatchObject({ status: "expired" });
    expect(expiredReply.body).not.toHaveProperty("download");
    expect(b.presigned).toStrictEqual([]);
    expect(b.sqs.offered()).toBe(0);
  });

  it("passes an unavailable signer through as 503 RUNTIME_UNAVAILABLE, not a 500, and records no read", async () => {
    const b = await world();
    const { exportId } = await start(b);
    finishExport(b, A, exportId);
    b.presignFault.error = agentXError("RUNTIME_UNAVAILABLE", "Rovara can't sign a download link just now. Try again in a minute.");
    await rejection(orgCall(b, adminOf(A), "GET", `/v1/app/org/audit/exports/${exportId}`)).toMatchObject({ code: "RUNTIME_UNAVAILABLE", statusCode: 503 });
    expect(b.sqs.offered()).toBe(0);
  });

  it("does not sign a file the ready record names in another org's folder", async () => {
    const b = await world();
    const { exportId } = await start(b);
    finishExport(b, A, exportId, { objectKey: exportObjectKey(B, exportId, "0123456789abcdef") });
    await rejection(orgCall(b, adminOf(A), "GET", `/v1/app/org/audit/exports/${exportId}`)).toMatchObject({ code: "NOT_FOUND" });
    expect(b.presigned).toStrictEqual([]);
  });
});

describe("org reads are recorded after the read (the documented exception)", () => {
  it("leaves one audit.read in the org's own chain for a records read, and one for a status read", async () => {
    const b = await world();
    await orgCall(b, member(A, "admin", "dev_3"), "GET", "/v1/app/org/audit/records?fromSeq=2&toSeq=4");
    await orgCall(b, member(A, "owner", "dev_4"), "GET", "/v1/app/org/audit/status");
    const events = queued(b);
    expect(events.map((event) => [event.action, event.orgId, event.actor.id, event.target])).toStrictEqual([
      ["audit.read", A, "dev_3", { kind: "audit", id: A }],
      ["audit.read", A, "dev_4", { kind: "audit", id: A }],
    ]);
    expect(events[0]!.facts).toStrictEqual({ fromSeq: 2, toSeq: 4, count: 3, via: "api" });
    expect(events[1]!.facts).toStrictEqual({ fromSeq: 0, toSeq: 0, count: 0, via: "status" });
    // Delivered, they are records of org A, and org B's chain is untouched.
    const headBefore = b.h.db.get(`AUDIT#${B}`, "HEAD")!.seq;
    await deliver(b);
    const after = await readAuditRecords(b.readDeps, A, { fromSeq: 13, toSeq: 14 });
    expect(after.records.map((entry) => entry.record.action)).toStrictEqual(["audit.read", "audit.read"]);
    expect(b.h.db.get(`AUDIT#${B}`, "HEAD")!.seq).toBe(headBefore);
  });

  it("records an empty read too (nothing in range), and each read once even when it is repeated", async () => {
    const b = await world();
    await orgCall(b, adminOf(A), "GET", "/v1/app/org/audit/records?fromSeq=100&toSeq=200");
    await orgCall(b, adminOf(A), "GET", "/v1/app/org/audit/records?fromSeq=100&toSeq=200");
    const events = queued(b);
    expect(events).toHaveLength(2);
    expect(events[0]!.facts).toStrictEqual({ fromSeq: 0, toSeq: 0, count: 0, via: "api" });
    expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
  });

  it("records a read only after it was served: a refused read leaves nothing", async () => {
    const b = await world();
    await rejection(orgCall(b, adminOf(A), "GET", "/v1/app/org/audit/records?fromSeq=5&toSeq=2")).toMatchObject({ code: "AUDIT_RANGE_INVALID" });
    expect(b.sqs.offered()).toBe(0);
    expect(pendingItems(b)).toStrictEqual([]);
  });

  it("serves the read when the queue is down, leaving the pending item for the drain; and when nothing can record, still serves it", async () => {
    const b = await world();
    b.sqs.mode = "throw";
    const reply = await orgCall(b, adminOf(A), "GET", "/v1/app/org/audit/records?limit=2");
    expect(reply.status).toBe(200);
    expect(pendingItems(b).map((event) => event.action)).toStrictEqual(["audit.read"]);
    b.h.db.injectFault({ command: "PutCommand", error: { name: "InternalServerError" } });
    expect((await orgCall(b, adminOf(A), "GET", "/v1/app/org/audit/records?limit=2")).status).toBe(200);
    expect(b.logs.some((entry) => entry.event === "audit.record_failed")).toBe(true);
  });

  it("serves the read on an install with a ledger but no outbox, recording nothing", async () => {
    const b = await world();
    const { audit: _audit, ...withoutOutbox } = b.deps;
    void _audit;
    const reply = await routeAuditRequest(withoutOutbox, adminOf(A), { method: "GET", body: {}, requestId: nextRequestId() }, url("/v1/app/org/audit/status"));
    expect(reply.status).toBe(200);
  });
});

// ---- the staff path -------------------------------------------------------------------------------------------------

describe("staff path: who may call, and which org", () => {
  it("is for administrators only", async () => {
    const b = await world();
    const mark = b.h.operations.length;
    await expect(staffCall(b, "GET", `/v1/admin/audit/${A}/records?${STAFF_QUERY}`, undefined, { ...staff, isAdministrator: false })).rejects.toMatchObject({ code: "FORBIDDEN", message: "FORBIDDEN: administrator claim is required" });
    expect(b.sqs.offered()).toBe(0);
    expect(pendingItems(b)).toStrictEqual([]);
    expect(b.h.operations.length).toBe(mark);
  });

  it("does not claim a path that is not an audit path", async () => {
    const b = await world();
    expect(await staffCall(b, "GET", "/v1/admin/projects")).toBeUndefined();
    expect(await staffCall(b, "GET", "/v1/admin/auditing/x")).toBeUndefined();
    await expect(staffCall(b, "GET", "/v1/admin/audit/nothing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(staffCall(b, "DELETE", `/v1/admin/audit/${A}/records`)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("answers NOT_FOUND for an org that does not exist or an id that is no org id, and records nothing in either", async () => {
    const b = await world();
    const mark = b.h.operations.length;
    for (const org of [C, "org_short", "..%2F..", "ORG_AAAAAAAAAAAAAAAAAAAA"]) {
      await expect(staffCall(b, "GET", `/v1/admin/audit/${org}/records?${STAFF_QUERY}`)).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    }
    // An operator's typo must not start a chain for an org that is not there.
    expect(b.sqs.offered()).toBe(0);
    expect(pendingItems(b)).toStrictEqual([]);
    expect(ledgerOperations(b, mark)).toStrictEqual([]);
  });

  it("answers NOT_FOUND where the install has no ledger", async () => {
    await expect(routeAuditAdminRequest({ ledger: undefined, orgExists: async () => true }, staff, { method: "GET", body: {}, requestId: nextRequestId() }, url(`/v1/admin/audit/${A}/records?${STAFF_QUERY}`)))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("staff path: the reason", () => {
  const routes: Array<[string, string, (query: string) => [string, string, unknown?]]> = [
    ["records", "GET", (query) => ["GET", `/v1/admin/audit/${A}/records?${query}`]],
    ["export start", "POST", () => ["POST", `/v1/admin/audit/${A}/exports`]],
    ["export download", "GET", (query) => ["GET", `/v1/admin/audit/${A}/exports/${auditExportId(A, "r")}?${query}`]],
  ];

  for (const [name, , make] of routes) {
    it(`${name}: a missing, empty, blank, too long or non-text reason is AUDIT_REASON_REQUIRED, with nothing recorded or read`, async () => {
      const b = await world();
      const mark = b.h.operations.length;
      const attempts: Array<{ query: string; body?: Record<string, unknown> }> = [
        { query: "ticket=SUP-1", body: { requestId: "r", fromSeq: 1, toSeq: 2, ticket: "SUP-1" } },
        { query: "reason=&ticket=SUP-1", body: { requestId: "r", fromSeq: 1, toSeq: 2, reason: "", ticket: "SUP-1" } },
        { query: "reason=%20%20%20", body: { requestId: "r", fromSeq: 1, toSeq: 2, reason: "   " } },
        { query: `reason=${"x".repeat(301)}`, body: { requestId: "r", fromSeq: 1, toSeq: 2, reason: "x".repeat(301) } },
        { query: "reason=a&reason=b", body: { requestId: "r", fromSeq: 1, toSeq: 2, reason: 42 } },
      ];
      for (const attempt of attempts) {
        const [method, path] = make(attempt.query);
        await expect(staffCall(b, method, path, attempt.body), `${method} ${path}`).rejects.toMatchObject({ code: "AUDIT_REASON_REQUIRED", statusCode: 400, message: REASON_COPY });
      }
      expect(b.h.operations.length).toBe(mark);
      expect(b.sqs.offered()).toBe(0);
      expect(b.invocations).toStrictEqual([]);
      expect(pendingItems(b)).toStrictEqual([]);
    });
  }

  it("takes a reason of exactly 1 and exactly 300 characters, and a ticket of 1 to 64", async () => {
    const b = await world();
    for (const reason of ["x", "y".repeat(300)]) {
      expect((await staffCall(b, "GET", `/v1/admin/audit/${A}/records?limit=1&reason=${reason}&ticket=${"t".repeat(64)}`))!.status).toBe(200);
    }
  });

  it("refuses a ticket that is empty or over 64 characters (CONFIG_INVALID) before recording", async () => {
    const b = await world();
    const mark = b.h.operations.length;
    for (const ticket of ["", "t".repeat(65)]) {
      await expect(staffCall(b, "GET", `/v1/admin/audit/${A}/records?reason=why&ticket=${ticket}`)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(b.sqs.offered()).toBe(0);
    expect(ledgerOperations(b, mark)).toStrictEqual([]);
  });

  it("refuses control, format and bidi characters in the reason (CONFIG_INVALID), on every staff route, before recording", async () => {
    const b = await world();
    const mark = b.h.operations.length;
    const exportId = auditExportId(A, "r");
    const bad = ["a\u001b[2Jb", "a\u202eb", "a\nb", "a\tb", "\nabc", "abc\n", "a\u0085b", "a\u200bb", "a\ufeffb", "a\u0000b", "a\u007fb"];
    for (const reason of bad) {
      const query = `reason=${encodeURIComponent(reason)}&ticket=SUP-1`;
      await expect(staffCall(b, "GET", `/v1/admin/audit/${A}/records?${query}`), JSON.stringify(reason)).rejects.toMatchObject({ code: "CONFIG_INVALID", statusCode: 400 });
      await expect(staffCall(b, "GET", `/v1/admin/audit/${A}/exports/${exportId}?${query}`), JSON.stringify(reason)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      await expect(staffCall(b, "POST", `/v1/admin/audit/${A}/exports`, { requestId: "r", fromSeq: 1, toSeq: 2, reason, ticket: "SUP-1" }), JSON.stringify(reason)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(b.sqs.offered()).toBe(0);
    expect(pendingItems(b)).toStrictEqual([]);
    expect(b.invocations).toStrictEqual([]);
    expect(b.h.operations.slice(mark).filter((operation) => LEDGER_TABLES.has(operation.table) || operation.pk.includes("#AUDIT_EXPORT#"))).toStrictEqual([]);
    // Ordinary text, accents and punctuation are fine.
    expect((await staffCall(b, "GET", `/v1/admin/audit/${A}/records?limit=1&reason=${encodeURIComponent("Kundenanfrage: Pr\u00fcfung (Fall #12), 50% done")}`))!.status).toBe(200);
  });

  it("limits the ticket to printable ASCII without spaces (CONFIG_INVALID), before recording", async () => {
    const b = await world();
    for (const ticket of ["SUP 42", "SUP-\u00e9", "SUP-\u202e1", "SUP-\u001b1", "SUP-\n1", "\u0ba4"]) {
      await expect(staffCall(b, "GET", `/v1/admin/audit/${A}/records?reason=why&ticket=${encodeURIComponent(ticket)}`), JSON.stringify(ticket)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      await expect(staffCall(b, "POST", `/v1/admin/audit/${A}/exports`, { requestId: "r", fromSeq: 1, toSeq: 2, reason: "why", ticket }), JSON.stringify(ticket)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(b.sqs.offered()).toBe(0);
    expect(pendingItems(b)).toStrictEqual([]);
    expect((await staffCall(b, "GET", `/v1/admin/audit/${A}/records?limit=1&reason=why&ticket=JIRA-123_a.b/c`))!.status).toBe(200);
  });

  it("says nothing the client sent in a CONFIG_INVALID message: fixed text only", async () => {
    const b = await world();
    const probe = "zzProbeName";
    const messages: string[] = [];
    const collect = async (promise: Promise<unknown>) => {
      try { await promise; } catch (error) { messages.push((error as Error).message); }
    };
    await collect(staffCall(b, "GET", `/v1/admin/audit/${A}/records?reason=why&${probe}=1`));
    await collect(staffCall(b, "GET", `/v1/admin/audit/${A}/records?reason=why&limit=1&limit=2`));
    await collect(staffCall(b, "GET", `/v1/admin/audit/${A}/exports/${auditExportId(A, "r")}?reason=why&${probe}=1`));
    await collect(staffCall(b, "POST", `/v1/admin/audit/${A}/exports`, { requestId: "x", fromSeq: 1, toSeq: 2, reason: "why", [probe]: 1 }));
    await collect(staffCall(b, "POST", `/v1/admin/audit/${A}/exports?${probe}=1`, { requestId: "x", fromSeq: 1, toSeq: 2, reason: "why" }));
    await collect(orgCall(b, adminOf(A), "GET", `/v1/app/org/audit/records?${probe}=1`));
    await collect(orgCall(b, adminOf(A), "GET", `/v1/app/org/audit/records?limit=1&limit=2&${probe}=1`));
    await collect(orgCall(b, adminOf(A), "GET", `/v1/app/org/audit/status?${probe}=1`));
    await collect(orgCall(b, adminOf(A), "POST", "/v1/app/org/audit/exports", { requestId: "x", fromSeq: 1, toSeq: 2, [probe]: 1 }));
    await collect(orgCall(b, adminOf(A), "POST", "/v1/app/org/audit/exports", { requestId: "x", fromSeq: 1, toSeq: 2, orgId: A }));
    expect(messages).toHaveLength(10);
    for (const message of messages) {
      expect(message).toMatch(/^CONFIG_INVALID: /);
      expect(message).not.toContain(probe);
      expect(message).not.toContain("orgId");
      expect(message).not.toContain("limit");
    }
  });

  it("refuses a parameter that is not part of the route, before recording", async () => {
    const b = await world();
    await expect(staffCall(b, "GET", `/v1/admin/audit/${A}/records?reason=why&orgId=${B}`)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(staffCall(b, "POST", `/v1/admin/audit/${A}/exports`, { requestId: "x", fromSeq: 1, toSeq: 2, reason: "why", orgId: B })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(b.sqs.offered()).toBe(0);
    expect(b.invocations).toStrictEqual([]);
  });
});

describe("staff path: records, recorded before they are read", () => {
  it("reads the org's records and leaves an audit.staff_read in that org, by the operator, with the reason and the ticket in details only", async () => {
    const b = await world();
    const reply = await staffCall(b, "GET", `/v1/admin/audit/${A}/records?fromSeq=1&toSeq=3&${STAFF_QUERY}`);
    expect(reply!.status).toBe(200);
    expect((reply!.body as { records: Array<{ record: { seq: number } }> }).records.map((entry) => entry.record.seq)).toStrictEqual([1, 2, 3]);
    const events = queued(b);
    expect(events).toHaveLength(1);
    const [event] = events as [AuditEventInput];
    expect(event).toMatchObject({ action: "audit.staff_read", orgId: A, actor: { kind: "operator", id: operatorId }, target: { kind: "audit", id: A } });
    expect(event.details).toStrictEqual([{ subject: "org", fields: { reason: "Customer ticket asked for it", ticket: "SUP-42" } }]);
    // Neither the reason nor the ticket nor anything personal is a fact.
    expect(JSON.stringify(event.facts)).not.toMatch(/Customer|SUP-42|staff-1/);
    expect(event.facts).toStrictEqual({ fromSeq: 1, toSeq: 3, count: 50, via: "api" });
    // Delivered, it is in the org's own chain, where the org's admin can read it.
    await deliver(b);
    const orgRead = await orgCall(b, adminOf(A), "GET", "/v1/app/org/audit/records?fromSeq=13&toSeq=13");
    expect((orgRead.body as { records: Array<{ record: { action: string; actor: { id: string } }; details: unknown[] }> }).records).toMatchObject([
      { record: { action: "audit.staff_read", actor: { kind: "operator", id: operatorId } }, details: [{ subject: "org", fields: { reason: "Customer ticket asked for it", ticket: "SUP-42" } }] },
    ]);
  });

  it("makes the record durable first: it is put, and sent, before the first read of the ledger", async () => {
    const b = await world();
    const mark = b.h.operations.length;
    let ledgerReadsWhenSent: number | undefined;
    b.sqs.onCall = () => { ledgerReadsWhenSent ??= ledgerOperations(b).length; };
    await staffCall(b, "GET", `/v1/admin/audit/${A}/records?${STAFF_QUERY}`);
    const operations = b.h.operations.slice(mark);
    const put = operations.findIndex((operation) => operation.action === "PutItem" && operation.table === STATE && operation.pk.startsWith("AUDIT_PENDING#"));
    const firstLedgerRead = operations.findIndex((operation) => LEDGER_TABLES.has(operation.table));
    expect(put).toBeGreaterThanOrEqual(0);
    expect(firstLedgerRead).toBeGreaterThan(put);
    // The queue had it before the ledger was read as well.
    expect(b.sqs.calls).toHaveLength(1);
    expect(ledgerReadsWhenSent).toBe(ledgerOperations(b).length - operations.filter((operation) => LEDGER_TABLES.has(operation.table)).length);
  });

  it("reads nothing at all, and answers 503 AUDIT_UNAVAILABLE, when the record cannot be put", async () => {
    const b = await world();
    const mark = b.h.operations.length;
    const commandsBefore = b.h.db.commandNames().length;
    b.h.db.injectFault({ command: "PutCommand", times: 5, error: { name: "InternalServerError" } });
    await expect(staffCall(b, "GET", `/v1/admin/audit/${A}/records?${STAFF_QUERY}`)).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE", statusCode: 503, message: UNAVAILABLE_COPY });
    expect(b.h.operations.slice(mark).filter((operation) => LEDGER_TABLES.has(operation.table))).toStrictEqual([]);
    // Everything the table was asked, after the failing put: the org's existence and the put, and nothing of the ledger.
    expect(b.h.db.commandNames().slice(commandsBefore).every((name) => name === "GetCommand" || name === "PutCommand")).toBe(true);
    expect(b.sqs.offered()).toBe(0);
  });

  it("is 503 with nothing read when the install has no outbox to record into (it must not read unrecorded)", async () => {
    const b = await world();
    const { audit: _audit, ...withoutOutbox } = b.deps;
    void _audit;
    const mark = b.h.operations.length;
    await expect(routeAuditAdminRequest({ ledger: withoutOutbox, orgExists: async () => true }, staff, { method: "GET", body: {}, requestId: nextRequestId() }, url(`/v1/admin/audit/${A}/records?${STAFF_QUERY}`)))
      .rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE", statusCode: 503 });
    expect(b.h.operations.slice(mark).filter((operation) => LEDGER_TABLES.has(operation.table))).toStrictEqual([]);
  });

  it("reads when only the queue is down: the pending item is durable and the drain delivers it", async () => {
    const b = await world();
    b.sqs.mode = "throw";
    const reply = await staffCall(b, "GET", `/v1/admin/audit/${A}/records?limit=2&${STAFF_QUERY}`);
    expect(reply!.status).toBe(200);
    expect(pendingItems(b)).toHaveLength(1);
    expect(pendingItems(b)[0]).toMatchObject({ action: "audit.staff_read", orgId: A, actor: { kind: "operator", id: operatorId } });
  });

  it("reads B's data for B's path whatever A's ranges, cursors and filters were, and records into B", async () => {
    const b = await world();
    const mine = (await staffCall(b, "GET", `/v1/admin/audit/${A}/records?limit=2&${STAFF_QUERY}`))!.body as { nextCursor: string };
    b.sqs.queue.length = 0;
    for (const query of ["fromSeq=1&toSeq=12", `cursor=${mine.nextCursor}`, "limit=200"]) {
      const reply = await staffCall(b, "GET", `/v1/admin/audit/${B}/records?${query}&${STAFF_QUERY}`);
      const body = reply!.body as { records: Array<{ record: { orgId: string } }>; headSeq: number };
      expect(body.headSeq).toBe(3);
      for (const entry of body.records) expect(entry.record.orgId).toBe(B);
      expect(JSON.stringify(reply!.body)).not.toContain(A);
    }
    for (const event of queued(b)) expect(event).toMatchObject({ orgId: B, action: "audit.staff_read", target: { kind: "audit", id: B } });
  });

  it("leaves exactly one record per successful read", async () => {
    const b = await world();
    for (let index = 0; index < 3; index += 1) await staffCall(b, "GET", `/v1/admin/audit/${A}/records?limit=1&${STAFF_QUERY}`);
    expect(queued(b)).toHaveLength(3);
    expect(new Set(queued(b).map((event) => event.eventId)).size).toBe(3);
  });

  it("refuses every fault the reader would refuse before it records, so a typo leaves no staff read", async () => {
    const b = await world();
    const mark = b.h.operations.length;
    const cursorOf = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    for (const bad of ["fromSeq=5&toSeq=2", "fromSeq=0", "toSeq=0", "limit=0", "from=not-a-time", "to=yesterday", "from=2026-10-21T00:00:00Z&to=2026-10-20T00:00:00Z",
      "cursor=%21%21", `cursor=${cursorOf({ seq: -1 })}`, `cursor=${cursorOf({ nope: 1 })}`, "action=", `action=${"a".repeat(65)}`, "actorId=", `actorId=${"a".repeat(201)}`]) {
      await expect(staffCall(b, "GET", `/v1/admin/audit/${A}/records?${bad}&${STAFF_QUERY}`), bad).rejects.toMatchObject({ code: "AUDIT_RANGE_INVALID", statusCode: 400 });
    }
    expect(b.sqs.offered()).toBe(0);
    expect(pendingItems(b)).toStrictEqual([]);
    expect(ledgerOperations(b, mark)).toStrictEqual([]);
    // A good cursor, time range and filter are recorded and served.
    const ok = await staffCall(b, "GET", `/v1/admin/audit/${A}/records?from=${encodeURIComponent(iso(at(0) - 3_600_000))}&cursor=${cursorOf({ seq: 2 })}&actorId=dev_1&limit=2&${STAFF_QUERY}`);
    expect(ok!.status).toBe(200);
    expect(queued(b)).toHaveLength(1);
  });
});

describe("staff path: exports", () => {
  const post = (b: Bench, org: string, body: Record<string, unknown>) => staffCall(b, "POST", `/v1/admin/audit/${org}/exports`, body);
  const request = { requestId: "staff-export-1", fromSeq: 1, toSeq: 12, reason: "Legal hold request", ticket: "LEGAL-7" };

  it("records the staff read first, then starts the export for the path's org with the operator as its requester", async () => {
    const b = await world();
    const mark = b.h.operations.length;
    const reply = await post(b, A, request);
    const exportId = auditExportId(A, "staff-export-1");
    expect(reply).toStrictEqual({ status: 202, body: { exportId, status: "running" } });
    expect(b.invocations).toStrictEqual([{ source: "agentx.audit-export", orgId: A, exportId }]);
    expect(b.h.db.get(exportMetaKey(A, exportId))).toMatchObject({ status: "running", requestedBy: { kind: "operator", id: operatorId } });
    const [event] = queued(b) as [AuditEventInput];
    expect(event).toMatchObject({ action: "audit.staff_read", orgId: A, actor: { kind: "operator", id: operatorId }, facts: { fromSeq: 1, toSeq: 12, count: 12, via: "export" } });
    expect(event.details).toStrictEqual([{ subject: "org", fields: { reason: "Legal hold request", ticket: "LEGAL-7", exportId } }]);
    const operations = b.h.operations.slice(mark);
    const put = operations.findIndex((operation) => operation.action === "PutItem" && operation.pk.startsWith("AUDIT_PENDING#"));
    const started = operations.findIndex((operation) => operation.pk.includes("#AUDIT_EXPORT#"));
    expect(put).toBeGreaterThanOrEqual(0);
    expect(started).toBeGreaterThan(put);
  });

  it("starts nothing, and answers 503, when the record cannot be put", async () => {
    const b = await world();
    b.h.db.injectFault({ command: "PutCommand", times: 5, error: { name: "InternalServerError" } });
    await expect(post(b, A, request)).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE", statusCode: 503 });
    expect(b.invocations).toStrictEqual([]);
    expect(exportItems(b)).toStrictEqual([]);
  });

  it("starts the export when only the queue is down", async () => {
    const b = await world();
    b.sqs.mode = "throw";
    expect((await post(b, A, request))!.status).toBe(202);
    expect(pendingItems(b)).toHaveLength(1);
  });

  it("refuses a range outside the limits, a body that is no request and an unknown field before it records anything, and starts nothing", async () => {
    const b = await world();
    for (const bad of [{ ...request, fromSeq: 9, toSeq: 2 }, { ...request, fromSeq: 1, toSeq: 200_001 }, { ...request, fromSeq: 1e20, toSeq: 2e20 }, { ...request, fromSeq: "1" }]) {
      await expect(post(b, A, bad)).rejects.toMatchObject({ code: "AUDIT_RANGE_INVALID", statusCode: 400 });
    }
    await expect(post(b, A, { ...request, requestId: "" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(post(b, A, { ...request, extra: 1 })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(post(b, A, { ...request, ticket: "" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(b.invocations).toStrictEqual([]);
    expect(b.sqs.offered()).toBe(0);
    expect(pendingItems(b)).toStrictEqual([]);
  });

  it("exports the path's org: B's path is B's export, under B's key, and A's id there is no export", async () => {
    const b = await world();
    const theirs = (await post(b, B, { ...request, toSeq: 3 }))!.body as { exportId: string };
    expect(theirs.exportId).toBe(auditExportId(B, "staff-export-1"));
    expect(b.h.db.get(exportMetaKey(B, theirs.exportId))).toBeDefined();
    expect(b.h.db.get(exportMetaKey(A, theirs.exportId))).toBeUndefined();
    for (const event of queued(b)) expect(event.orgId).toBe(B);
  });

  describe("the download", () => {
    const download = (b: Bench, org: string, exportId: string, query = STAFF_QUERY) => staffCall(b, "GET", `/v1/admin/audit/${org}/exports/${exportId}?${query}`);

    it("is itself a staff read: recorded durably before the export record is read, then the status and the link are given", async () => {
      const b = await world();
      const { exportId } = (await post(b, A, request))!.body as { exportId: string };
      const objectKey = finishExport(b, A, exportId);
      b.sqs.queue.length = 0;
      const mark = b.h.operations.length;
      const reply = await download(b, A, exportId);
      expect(reply!.body).toMatchObject({ exportId, status: "ready", download: { url: `https://signed.test/${EXPORTS_BUCKET}/${objectKey}?expires=900`, expiresInSeconds: 900 } });
      const [event] = queued(b) as [AuditEventInput];
      expect(event).toMatchObject({ action: "audit.staff_read", orgId: A, actor: { kind: "operator", id: operatorId }, facts: { via: "export-download" } });
      expect(event.details).toStrictEqual([{ subject: "org", fields: { reason: "Customer ticket asked for it", ticket: "SUP-42", exportId } }]);
      const operations = b.h.operations.slice(mark);
      const put = operations.findIndex((operation) => operation.action === "PutItem" && operation.pk.startsWith("AUDIT_PENDING#"));
      const readExport = operations.findIndex((operation) => operation.pk.includes("#AUDIT_EXPORT#"));
      expect(put).toBeGreaterThanOrEqual(0);
      expect(readExport).toBeGreaterThan(put);
      expect(b.presigned).toHaveLength(1);
    });

    it("reads no export and signs nothing, answering 503, when the record cannot be put", async () => {
      const b = await world();
      const { exportId } = (await post(b, A, request))!.body as { exportId: string };
      finishExport(b, A, exportId);
      const mark = b.h.operations.length;
      b.h.db.injectFault({ command: "PutCommand", times: 5, error: { name: "InternalServerError" } });
      await expect(download(b, A, exportId)).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE", statusCode: 503 });
      expect(b.h.operations.slice(mark).filter((operation) => operation.pk.includes("#AUDIT_EXPORT#"))).toStrictEqual([]);
      expect(b.presigned).toStrictEqual([]);
    });

    it("needs a reason like the other staff reads", async () => {
      const b = await world();
      const { exportId } = (await post(b, A, request))!.body as { exportId: string };
      finishExport(b, A, exportId);
      b.sqs.queue.length = 0;
      await expect(download(b, A, exportId, "ticket=SUP-1")).rejects.toMatchObject({ code: "AUDIT_REASON_REQUIRED" });
      expect(b.presigned).toStrictEqual([]);
      expect(b.sqs.offered()).toBe(1);
    });

    it("shows a running export without a link (and still records the read), and never a link for a failed or expired one", async () => {
      const b = await world();
      const { exportId } = (await post(b, A, request))!.body as { exportId: string };
      const running = await download(b, A, exportId);
      expect(running!.body).toMatchObject({ status: "running" });
      expect(running!.body).not.toHaveProperty("download");
      finishExport(b, A, exportId, { expiresAt: iso(b.h.clock.now - 1) });
      const expired = await download(b, A, exportId);
      expect(expired!.body).toMatchObject({ status: "expired" });
      expect(expired!.body).not.toHaveProperty("download");
      expect(b.presigned).toStrictEqual([]);
      expect(queued(b).filter((event) => event.action === "audit.staff_read")).toHaveLength(3);
    });

    it("answers NOT_FOUND for another org's export id, after recording the read in the org that was asked", async () => {
      const b = await world();
      const { exportId } = (await post(b, A, request))!.body as { exportId: string };
      finishExport(b, A, exportId);
      b.sqs.queue.length = 0;
      await expect(download(b, B, exportId)).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
      expect(queued(b).map((event) => event.orgId)).toStrictEqual([B]);
      expect(b.presigned).toStrictEqual([]);
    });

    it("passes an unavailable signer through as 503 RUNTIME_UNAVAILABLE", async () => {
      const b = await world();
      const { exportId } = (await post(b, A, request))!.body as { exportId: string };
      finishExport(b, A, exportId);
      b.presignFault.error = agentXError("RUNTIME_UNAVAILABLE", "Rovara can't sign a download link just now. Try again in a minute.");
      await expect(download(b, A, exportId)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", statusCode: 503 });
    });
  });
});


// ---- through the broker's handler ------------------------------------------------------------------------------------

describe("the broker's handler", () => {
  const ISSUER_URL = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth";
  const T0 = Date.parse("2026-09-27T12:00:00.000Z");
  const signer = localSigner();
  const developerId = "d".repeat(64);

  async function bearer(role: OrgRole): Promise<string> {
    const jwt = { iss: ISSUER_URL, aud: "agentx-developer", sub: developerId, amr: "slack", env: "staging", sid: "s-1", org: A, org_role: role, iat: T0 / 1000, nbf: T0 / 1000, exp: T0 / 1000 + 3600 };
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: (await signer.publicJwk()).kid })).toString("base64url");
    const input = `${header}.${Buffer.from(JSON.stringify(jwt)).toString("base64url")}`;
    return `Bearer ${input}.${(await signer.sign(Buffer.from(input))).toString("base64url")}`;
  }

  /** The broker over the bench's tables, with one developer who is `role` in org A. */
  async function wired(role: OrgRole) {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    const b = await world();
    const developer: DeveloperApiConfiguration = {
      issuer: ISSUER_URL, env: "staging", methods: { slack: true, oidc: false }, slackTeamId: "T0TEAM1", signInTableName: "signin",
      channelMembers: async () => ({ ok: true as const, memberOf: [] }),
      verifyAccessToken: developerTokenVerifier({ issuer: ISSUER_URL, keys: async () => [await signer.publicJwk()], now: () => Date.now() }),
    };
    const { handler } = await createAdminBroker({ developer, extra: { documentClient: b.h.deps.documentClient, tableName: STATE, auditLedger: b.deps, audit: b.deps.audit } });
    seedMembership(b.h.db, developerId, { orgId: A, role });
    b.h.db.set({ pk: "SESSION#s-1", sk: "META", sessionId: "s-1", developerId, amr: "slack", slackUserId: "U0MAYA001", startedAt: new Date(T0).toISOString(), authTime: new Date(T0).toISOString(), endsAt: T0 / 1000 + 604_800 });
    b.h.db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "slack", issuer: "https://slack.com", subject: "U0MAYA001", displayName: "Maya Chen", slackUserId: "U0MAYA001", firstSignInAt: "x", lastSignInAt: "x" });
    const dev = async (method: string, path: string, body?: unknown) => {
      const response = await handler({ rawPath: path.split("?")[0], rawQueryString: path.split("?")[1] ?? "", headers: { authorization: await bearer(role) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: nextRequestId(), http: { method } } });
      return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
    };
    return { b, handler, dev };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves an admin the status and the records over /v1/dev/org/audit, and records each read in the org", async () => {
    const { b, dev } = await wired("admin");
    const status = await dev("GET", "/v1/dev/org/audit/status");
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ headSeq: 12, sealedThroughSeq: 10, limits: AUDIT_LIMITS_COPY });
    const records = await dev("GET", "/v1/dev/org/audit/records?limit=2");
    expect(records.status).toBe(200);
    expect((records.body.records as unknown[]).length).toBe(2);
    expect(queued(b).map((event) => [event.action, event.orgId, event.actor.id])).toStrictEqual([["audit.read", A, developerId], ["audit.read", A, developerId]]);
  });

  it("answers a contributor 403 with the exact text, and a started export 202", async () => {
    const contributor = await wired("member");
    const refused = await contributor.dev("GET", "/v1/dev/org/audit/records");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "FORBIDDEN", message: "Only your organization's owners and admins can see its audit log." });
    expect(contributor.b.sqs.offered()).toBe(0);
    vi.useRealTimers();
    const owner = await wired("owner");
    const started = await owner.dev("POST", "/v1/dev/org/audit/exports", { requestId: "wired-1", fromSeq: 1, toSeq: 12 });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ exportId: auditExportId(A, "wired-1"), status: "running" });
    expect(owner.b.invocations).toHaveLength(1);
  });

  it("starting an export needs a fresh sign-in (controller default, pending the owner), reading does not", async () => {
    const { b, dev } = await wired("owner");
    // Eleven minutes after the sign-in: reads still work, an export is not started.
    vi.setSystemTime(T0 + 11 * 60_000);
    expect((await dev("GET", "/v1/dev/org/audit/status")).status).toBe(200);
    const refused = await dev("POST", "/v1/dev/org/audit/exports", { requestId: "stale-1", fromSeq: 1, toSeq: 12 });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(b.invocations).toHaveLength(0);
  });

  it("passes an unavailable download signer through as 503", async () => {
    const { b, dev } = await wired("owner");
    const started = await dev("POST", "/v1/dev/org/audit/exports", { requestId: "wired-2", fromSeq: 1, toSeq: 12 });
    finishExport(b, A, (started.body as { exportId: string }).exportId);
    b.presignFault.error = agentXError("RUNTIME_UNAVAILABLE", "Rovara can't sign a download link just now. Try again in a minute.");
    const answer = await dev("GET", `/v1/dev/org/audit/exports/${(started.body as { exportId: string }).exportId}`);
    expect(answer.status).toBe(503);
    expect(answer.body.error).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("serves the staff path to an administrator only, recording before it reads, and 503 with no read when it cannot record", async () => {
    const { b, handler } = await wired("member");
    const path = `/v1/admin/audit/${A}/records?limit=1&reason=Customer%20asked&ticket=SUP-1`;
    const refused = await adminCall(handler, { method: "GET", path, admin: false });
    expect(refused.status).toBe(403);
    expect(b.sqs.offered()).toBe(0);
    const served = await adminCall(handler, { method: "GET", path, subject: "staff-1" });
    expect(served.status).toBe(200);
    expect((served.body.records as unknown[]).length).toBe(1);
    expect(queued(b)).toMatchObject([{ action: "audit.staff_read", orgId: A, actor: { kind: "operator", id: auditOperatorId(adminIssuer, "staff-1") } }]);
    const unknownOrg = await adminCall(handler, { method: "GET", path: `/v1/admin/audit/${C}/records?reason=x` });
    expect(unknownOrg.status).toBe(404);
    // Fail-closed: no pending put, no read.
    const mark = b.h.operations.length;
    b.h.db.injectFault({ command: "PutCommand", times: 5, error: { name: "InternalServerError" } });
    const unavailable = await adminCall(handler, { method: "GET", path });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error).toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(b.h.operations.slice(mark).filter((operation) => LEDGER_TABLES.has(operation.table))).toStrictEqual([]);
    const noReason = await adminCall(handler, { method: "GET", path: `/v1/admin/audit/${A}/records` });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toMatchObject({ code: "AUDIT_REASON_REQUIRED" });
  });

  it("starts a staff export and gives its download through the handler, each recorded before it happens, and 503s with nothing started or signed when it cannot record", async () => {
    const { b, handler } = await wired("member");
    const asStaff = (h: typeof handler, options: Omit<Parameters<typeof adminCall>[1], "subject">) => adminCall(h, { subject: "staff-1", ...options });
    const staffId = auditOperatorId(adminIssuer, "staff-1");
    const exportPath = `/v1/admin/audit/${A}/exports`;
    const body = { requestId: "wired-staff-1", fromSeq: 1, toSeq: 12, reason: "Legal hold", ticket: "LEGAL-9" };

    // No administrator claim, no reason, an org that does not exist: nothing recorded, started or read.
    expect((await asStaff(handler, { method: "POST", path: exportPath, body, admin: false })).status).toBe(403);
    const noReason = await asStaff(handler, { method: "POST", path: exportPath, body: { ...body, reason: undefined } });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toMatchObject({ code: "AUDIT_REASON_REQUIRED" });
    expect((await asStaff(handler, { method: "POST", path: `/v1/admin/audit/${C}/exports`, body })).status).toBe(404);
    expect(b.sqs.offered()).toBe(0);
    expect(b.invocations).toStrictEqual([]);

    // Fail-closed start: no pending put, so no export record and no invocation.
    const mark = b.h.operations.length;
    b.h.db.injectFault({ command: "PutCommand", error: { name: "InternalServerError" } });
    const refusedStart = await asStaff(handler, { method: "POST", path: exportPath, body });
    expect(refusedStart.status).toBe(503);
    expect(refusedStart.body.error).toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(b.invocations).toStrictEqual([]);
    // Not counted: the one read of the org's SHREDDED marker in the keys table (task 15), made before the record so that a request that cannot happen is not recorded. It reads no record and no detail. Any other keys-table read (a DATA_KEY, say) would fail this test.
    expect(exportItems(b)).toStrictEqual([]);
    expect(b.h.operations.slice(mark).filter((operation) => LEDGER_TABLES.has(operation.table) && !(operation.table === KEYS && operation.action === "GetItem" && operation.pk === `ORG#${A}` && operation.sk === "SHREDDED"))).toStrictEqual([]);

    // Started: 202, the export function is invoked for the path's org, and the staff read was recorded first.
    const started = await asStaff(handler, { method: "POST", path: exportPath, body });
    const exportId = auditExportId(A, "wired-staff-1");
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ exportId, status: "running" });
    expect(b.invocations).toStrictEqual([{ source: "agentx.audit-export", orgId: A, exportId }]);
    expect(b.h.db.get(exportMetaKey(A, exportId))).toMatchObject({ requestedBy: { kind: "operator", id: staffId } });
    expect(queued(b)).toMatchObject([{ action: "audit.staff_read", orgId: A, actor: { kind: "operator", id: staffId }, details: [{ subject: "org", fields: { reason: "Legal hold", ticket: "LEGAL-9", exportId } }] }]);

    // The download is a staff read too: it needs a reason, is recorded before the export record is read, and then gives the link.
    const downloadPath = `/v1/admin/audit/${A}/exports/${exportId}`;
    const objectKey = finishExport(b, A, exportId);
    expect((await asStaff(handler, { method: "GET", path: downloadPath })).status).toBe(400);
    const downloaded = await asStaff(handler, { method: "GET", path: `${downloadPath}?reason=Legal%20hold&ticket=LEGAL-9` });
    expect(downloaded.status).toBe(200);
    expect(downloaded.body).toMatchObject({ exportId, status: "ready", download: { url: `https://signed.test/${EXPORTS_BUCKET}/${objectKey}?expires=900` } });
    expect(queued(b).map((event) => event.action)).toStrictEqual(["audit.staff_read", "audit.staff_read"]);

    // Fail-closed download: nothing recorded, so the export record is not read and nothing is signed.
    const signedBefore = b.presigned.length;
    const markDownload = b.h.operations.length;
    b.h.db.injectFault({ command: "PutCommand", error: { name: "InternalServerError" } });
    const refusedDownload = await asStaff(handler, { method: "GET", path: `${downloadPath}?reason=Legal%20hold` });
    expect(refusedDownload.status).toBe(503);
    expect(refusedDownload.body.error).toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(b.h.operations.slice(markDownload).filter((operation) => operation.pk.includes("#AUDIT_EXPORT#"))).toStrictEqual([]);
    expect(b.presigned.length).toBe(signedBefore);
  });
});
