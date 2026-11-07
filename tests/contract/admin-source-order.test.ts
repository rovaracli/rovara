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
  if (race === "actor") f.db.set({ ...orgMemberKey(org, actor), orgId: org, developerId: actor, role: "member" });
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
it("routes an expectedRevision body to the reviewed boundary and exposes only revision metadata on reads", async () => {
 const { routeModelSourceRequest } = await import("../../packages/broker/src/model-sources/routes.js");
 const f = fixture(), path = "/v1/app/org/model-sources-order", caller = { orgId: org, developerId: actor, orgRole: "owner" } as const;
 const deps = { modelSources: { store: f.store } } as unknown as Parameters<typeof routeModelSourceRequest>[0];
 const request = { method: "PUT", path, requestId: "fixture", headers: {}, body: JSON.stringify({ requestId: f.requestId, expectedRevision: 0, order: ["rovara"] }) };
 expect(await routeModelSourceRequest(deps, caller, request, new URL(path, "https://cell.example"))).toEqual({ order: ["rovara"], revision: 1 });
 const listPath = "/v1/app/org/model-sources", result = await routeModelSourceRequest(deps, caller, { ...request, method: "GET", path: listPath, body: "" }, new URL(listPath, "https://cell.example"));
 // UX1: the read also says which kinds can be added here (none: the launch list is empty on purpose).
 expect(result).toEqual({ orgId: org, developerId: actor, sources: [], order: ["rovara"], revision: 1, available: [] });
});
it("fails closed on malformed reviewed route input without echoing supplied fields", async () => {
 const { routeModelSourceRequest } = await import("../../packages/broker/src/model-sources/routes.js");const f = fixture(), path = "/v1/app/org/model-sources-order";
 const deps = { modelSources: { store: f.store } } as unknown as Parameters<typeof routeModelSourceRequest>[0];
 for (const body of [{ requestId: f.requestId, expectedRevision: -1, order: ["rovara"] }, { requestId: f.requestId, expectedRevision: 0, order: ["rovara"], untrustedField: "fixture" }]) {
  await expect(routeModelSourceRequest(deps, { orgId: org, developerId: actor, orgRole: "owner" }, { method: "PUT", path, headers: {}, requestId: "fixture", body: JSON.stringify(body) }, new URL(path, "https://cell.example"))).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: Review a valid company source order before submitting." });
 }
 expect(f.order()).toBeUndefined();
});
it("refuses a real pending-audit key conflict atomically", async () => {
 const { auditModelSourceOrderChanged, auditOccurrence } = await import("../../packages/broker/src/audit/events.js"), { auditPendingItem } = await import("../../packages/broker/src/audit/outbox.js");
 const f = fixture(), event = auditModelSourceOrderChanged({ orgId: org, actor: { kind: "member", id: actor }, occurredAt: "2026-10-27T12:00:00Z", occurrence: auditOccurrence("reviewed-source-order", org, f.requestId), count: 1 });
 const pending = auditPendingItem(event, f.deps.now());f.db.set({ ...pending });
 expect((await f.request()).code).toBe("AUDIT_UNAVAILABLE");expect(f.order()).toBeUndefined();expect(f.db.get({ pk: orgScoped(org, "SOURCE_ORDER_REVIEW"), sk: f.requestId })).toBeUndefined();expect(f.db.get(pending)).toEqual(pending);
});
it("never overwrites a physically retained expired receipt or reapplies a reversal", async () => {
 const f = fixture();const first = await f.request();await f.request({ requestId: randomUUID(), expectedRevision: 1, order: ["personal-chatgpt", "rovara"] });
 const key = { pk: orgScoped(org, "SOURCE_ORDER_REVIEW"), sk: f.requestId };f.db.set({ ...f.db.get(key), indexExpiresAt: 1 });
 expect(await f.request()).toEqual(first);expect((await f.request({ order: ["personal-chatgpt", "rovara"], expectedRevision: 2 })).code).toBe("CONFIG_INVALID");expect(f.order()).toEqual(["personal-chatgpt", "rovara"]);
});
it("keeps another company's canonical source order unchanged", async () => {
 const f = fixture();f.db.set({ ...modelSourcesKey(foreign), entityType: "ORG_MODEL_SOURCES", revision: 9, sources: [], order: ["personal-chatgpt", "rovara"], credentials: [], removing: [], updatedBy: other, updatedAt: "2026-10-27T12:00:00Z" });const before = f.db.get(modelSourcesKey(foreign));
 expect((await f.request()).code).toBeUndefined();expect(f.db.get(modelSourcesKey(foreign))).toEqual(before);
});
it("fences a concurrent source change against a reviewed no-op without a receipt", async () => {
 const f = fixture();await f.request();const requestId = randomUUID();f.beforeCommit(() => f.db.set({ ...f.db.get(modelSourcesKey(org)), revision: 2, order: ["personal-chatgpt", "rovara"] }));
 expect((await f.request({ requestId, expectedRevision: 1 })).code).toBe("CHANGE_STALE");expect(f.order()).toEqual(["personal-chatgpt", "rovara"]);expect(f.db.get({ pk: orgScoped(org, "SOURCE_ORDER_REVIEW"), sk: requestId })).toBeUndefined();expect(f.audit.recorded()).toHaveLength(1);
});
it("refuses same-org reverse pointer role disagreement before committing", async () => {
 const f = fixture("admin");f.db.set({ ...developerOrgKey(actor), orgId: org, role: "member" });expect((await f.request()).code).toBe("FORBIDDEN");expect(f.order()).toBeUndefined();expect(f.db.transactions()).toHaveLength(0);expect(f.audit.recorded()).toEqual([]);
});
it("fences only a reverse pointer role change during the commit", async () => {
 const f = fixture("admin");f.beforeCommit(() => f.db.set({ ...developerOrgKey(actor), orgId: org, role: "member" }));expect((await f.request()).code).toBe("FORBIDDEN");expect(f.order()).toBeUndefined();expect(f.db.get({ pk: orgScoped(org, "SOURCE_ORDER_REVIEW"), sk: f.requestId })).toBeUndefined();expect(f.audit.recorded()).toEqual([]);
});
it("validates expected company again at the internal reviewed boundary before any storage access", async () => {
 const f = fixture(), before = f.db.commandNames().length;
 const input = { orgId: org, expectedOrgId: foreign, by: actor, order: ["rovara"], expectedRevision: 0, request: { orgId: org, developerId: actor, requestId: randomUUID(), fingerprint: "a".repeat(64) } };
 await expect(f.store.setOrder(input)).rejects.toMatchObject({ code: "FORBIDDEN" });expect(f.db.commandNames()).toHaveLength(before);expect(f.order()).toBeUndefined();
});
it("rejects a reviewed actor mismatch internally before any storage command", async () => {
 const f=fixture(), before=f.db.commandNames().length, input={orgId:org,by:actor,expectedOrgId:org,expectedDeveloperId:other,expectedRevision:0,order:["rovara"],request:{orgId:org,developerId:actor,requestId:randomUUID(),fingerprint:"a".repeat(64)}};
 await expect(f.store.setOrder(input)).rejects.toMatchObject({code:"FORBIDDEN"});expect(f.db.commandNames()).toHaveLength(before);expect(f.order()).toBeUndefined();
});
