import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { AgentXError, developerOrgKey, modelSourcesKey, orgMemberKey, orgMetaKey, orgScoped } from "@agentx/contracts";
import { ModelSourceStore, type ModelSourceStoreInput } from "../../packages/broker/src/model-sources/store.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
const org = "org_aaaaaaaaaaaaaaaaaaaa", foreign = "org_bbbbbbbbbbbbbbbbbbbb", actor = "a".repeat(64), other = "b".repeat(64);
function fixture(role = "owner") {
 const db = new FakeDynamoDb(), now = () => Date.parse("2026-10-27T12:00:00Z"), audit = capturingAuditDeps({ db, now });
 for (const orgId of [org, foreign]) db.set({ ...orgMetaKey(orgId), orgId });
 function member(who = actor, nextRole = role, orgId = org) { db.set({ ...orgMemberKey(orgId, who), orgId, developerId: who, role: nextRole });db.set({ ...developerOrgKey(who), orgId, role: nextRole }); }
 member();member(other, "admin");
 const deps: ModelSourceStoreInput = { documentClient: db, tableName: "state", now, chatgptSwitch: async () => true, audit: audit.audit }, store = new ModelSourceStore(deps), requestId = randomUUID();
 let before: (() => void) | undefined;const send = db.send.bind(db);
 db.send = async command => { if (command.constructor.name === "TransactWriteCommand" && before) { const run = before;before = undefined;run(); }return send(command); };
 const request = async (overrides: { order?: string[]; expectedRevision?: number; requestId?: string; orgId?: string; by?: string } = {}) => {
  const by = overrides.by ?? actor, orgId = overrides.orgId ?? org;
  const input = { orgId, by, order: overrides.order ?? ["rovara"], expectedRevision: overrides.expectedRevision ?? 0, request: { orgId: orgId as typeof org, developerId: by, requestId: overrides.requestId ?? requestId, fingerprint: "a".repeat(64) } };
  try { return { result: await store.setOrder(input), code: undefined }; }catch (e) { if (!(e instanceof AgentXError)) throw e;return { result: undefined, code: e.code }; }
 };
 return { db, deps, store, audit, requestId, request, member, beforeCommit(run: () => void) { before = run; }, order: () => db.get(modelSourcesKey(org))?.order };
}
for (const role of ["owner", "admin", "maintainer", "member", "viewer", "future-role"]) it(`reviewed source order requires live ${role} authority`, async () => {
 const f = fixture(role), allowed = role === "owner" || role === "admin", result = await f.request();
 expect(result.code).toBe(allowed ? undefined : "FORBIDDEN");expect(f.order()).toEqual(allowed ? ["rovara"] : undefined);expect(f.audit.recorded().length).toBe(allowed ? 1 : 0);
 if (allowed) expect(result.result).toEqual({ order: ["rovara"], revision: 1 });
});
it("stores revision, receipt and audit in one transaction and replays without a new write", async () => {
 const f = fixture(), first = await f.request();expect(first.result).toEqual({ order: ["rovara"], revision: 1 });const count = f.db.transactions().length;
 expect(await f.request()).toEqual(first);expect(f.db.transactions()).toHaveLength(count);expect(f.audit.recorded()).toHaveLength(1);
 const receipt = f.db.get({ pk: orgScoped(org, "SOURCE_ORDER_REVIEW"), sk: f.requestId });expect(receipt).toMatchObject({ by: actor, orgId: org, order: ["rovara"], revision: 1 });expect(receipt?.indexExpiresAt).toBe(Date.parse("2026-10-28T12:00:00Z") / 1000);
 const tx = f.db.transactions()[0]!;expect(tx.some(item => String((item.Put as { Item?: { pk?: string } } | undefined)?.Item?.pk).startsWith("AUDIT_PENDING#"))).toBe(true);
});
it("rejects stale reviewed revision even when the proposal is currently a no-op", async () => {
 const f = fixture();await f.request();expect((await f.request({ requestId: randomUUID() })).code).toBe("CHANGE_STALE");expect(f.audit.recorded()).toHaveLength(1);
});
it("stores no-op evidence without a false change event", async () => {
 const f = fixture();await f.request();const id = randomUUID();expect((await f.request({ requestId: id, expectedRevision: 1 })).result).toEqual({ order: ["rovara"], revision: 1 });expect(f.audit.recorded()).toHaveLength(1);
});
it("replays the original receipt after a reversal without reapplying it", async () => {
 const f = fixture();const first = await f.request();expect((await f.request({ requestId: randomUUID(), expectedRevision: 1, order: ["personal-chatgpt", "rovara"] })).code).toBeUndefined();
 expect(await f.request()).toEqual(first);expect(f.order()).toEqual(["personal-chatgpt", "rovara"]);expect(f.audit.recorded()).toHaveLength(2);
 expect((await f.request({ order: ["personal-chatgpt", "rovara"] })).code).toBe("CONFIG_INVALID");expect((await f.request({ by: other })).code).toBe("CONFIG_INVALID");
});
for (const kind of ["missing", "misbound", "pointer", "closed", "foreign"]) it(`refuses ${kind} authority without changing a company source order`, async () => {
 const f = fixture();
 if (kind === "missing") f.db.delete(orgMemberKey(org, actor));
 if (kind === "misbound") f.db.set({ ...orgMemberKey(org, actor), orgId: foreign, developerId: actor, role: "owner" });
 if (kind === "pointer") f.db.set({ ...developerOrgKey(actor), orgId: foreign, role: "owner" });
 if (kind === "closed") f.db.set({ ...orgMetaKey(org), orgId: org, closedAt: "2026-10-27T11:00:00Z" });
 expect((await f.request(kind === "foreign" ? { orgId: foreign } : {})).code).toBe("FORBIDDEN");expect(f.order()).toBeUndefined();expect(f.audit.recorded()).toEqual([]);
});
for (const race of ["actor", "pointer", "org", "revision"]) it(`fences a concurrent ${race} change at the commit`, async () => {
 const f = fixture();f.beforeCommit(() => {
  if (race === "actor") f.member(actor, "member");
  if (race === "pointer") f.db.set({ ...developerOrgKey(actor), orgId: foreign, role: "owner" });
  if (race === "org") f.db.set({ ...orgMetaKey(org), orgId: org, closingAt: "2026-10-27T12:00:00Z" });
  if (race === "revision") f.db.set({ ...modelSourcesKey(org), entityType: "ORG_MODEL_SOURCES", revision: 1, sources: [], order: ["personal-chatgpt", "rovara"], credentials: [], removing: [], updatedAt: "2026-10-27T12:00:00Z", updatedBy: other });
 });
 expect((await f.request()).code).toBe(race === "revision" ? "CHANGE_STALE" : "FORBIDDEN");expect(f.audit.recorded()).toEqual([]);expect(f.db.get({ pk: orgScoped(org, "SOURCE_ORDER_REVIEW"), sk: f.requestId })).toBeUndefined();
});
it("checks revoked authority on receipt replay", async () => { const f = fixture();await f.request();f.member(actor, "member");expect((await f.request()).code).toBe("FORBIDDEN");expect(f.audit.recorded()).toHaveLength(1); });
for (const kind of ["missing", "foreign"]) it(`refuses ${kind} audit configuration before persisting`, async () => {
 const f = fixture();if (kind === "missing") delete f.deps.audit;else f.deps.audit = { ...f.audit.audit, tableName: "other" };
 expect((await f.request()).code).toBe("AUDIT_UNAVAILABLE");expect(f.order()).toBeUndefined();
});
it("rolls back the source order and receipt if its pending audit cannot be written", async () => {
 const f = fixture();f.db.injectFault({ command: "TransactWriteCommand", error: { name: "ServiceUnavailable" } });expect((await f.request()).code).toBe("AUDIT_UNAVAILABLE");expect(f.order()).toBeUndefined();expect(f.audit.recorded()).toEqual([]);expect((await f.request()).code).toBeUndefined();
});
it("recovers an atomic receipt after lost acknowledgement", async () => {
 const f = fixture(), send = f.db.send.bind(f.db);let lost = true;f.db.send = async command => { const result = await send(command);if (command.constructor.name === "TransactWriteCommand" && lost) { lost = false;throw new Error("fixture timeout"); }return result; };
 expect((await f.request()).result).toEqual({ order: ["rovara"], revision: 1 });expect(f.db.transactions()).toHaveLength(1);expect(f.audit.pending()).toHaveLength(1);
});
it("keeps durable audit when queue delivery is unavailable", async () => { const f = fixture();f.audit.queueDown();expect((await f.request()).code).toBeUndefined();expect(f.audit.pending()).toHaveLength(1); });
it("refuses disabled ChatGPT additions and invalid source order without writes", async () => {
 const f = fixture();f.deps.chatgptSwitch = async () => false;
 for (const order of [["personal-chatgpt", "rovara"], [], ["rovara", "rovara"], ["src_not_registered"]]) expect((await f.request({ order })).code).toBe("CONFIG_INVALID");expect(f.order()).toBeUndefined();
});
it("does not accept malformed revisions or request IDs", async () => {
 const f = fixture();for (const expectedRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) expect((await f.request({ expectedRevision })).code).toBe("CONFIG_INVALID");expect((await f.request({ requestId: "bad" })).code).toBe("CONFIG_INVALID");expect(f.order()).toBeUndefined();
});
