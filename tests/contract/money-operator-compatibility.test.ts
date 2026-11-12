// Controller M30: existing operator credentials stay authoritative; no org membership is fabricated.
import { randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
// The chain case drives /v1/app/chains, which answers only while WEB_FEATURES names `chains` (chains/automations-gate.ts).
import "../support/automations-on.js";
import { orgSettingsKey, orgMemberKey } from "@agentx/cloud-contracts";
import { singleOrgIdForEnv } from "@rovara-code/contracts";
import { setOrgBudget } from "../../packages/cli/src/admin/budget.js";
import { writeBudgets } from "../../packages/broker/src/org/budget.js";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { DEFAULT_AGENT_GUARDRAILS } from "@rovara-code/contracts";
import { adminCall, createAdminBroker } from "../support/admin-broker.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { MAYA, seedMembership } from "../support/developer-task-broker.js";
import { setup, TRIAGE } from "../support/spend-world.js";
import { TEST_ENV, TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";
beforeAll(loadSlackBroker);
const orgId = singleOrgIdForEnv(TEST_ENV), key = orgSettingsKey(orgId, "BUDGET");
async function fixture() {
  const capture = capturingAuditDeps(), access = fakeModelAccess();
  const h = await createAdminBroker({ extra: { audit: capture.audit, modelAccess: { access, proxyUrl: "http://internal-proxy.example.test:4000" } } }); capture.attach(h.db);
  const transport: typeof fetch = async (url, init) => {
    expect(new Headers(init?.headers).has("authorization")).toBe(true);
    const result = await adminCall(h.handler, { method: "PUT", path: new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname, body: JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown, admin: true });
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
  };
  const operator = (usd: number) => setOrgBudget({ controlPlaneUrl: "https://cell.example.test", accessToken: "fixture-operator-token", orgMonthlyUsd: usd, requestId: randomUUID() }, transport);
  const deps = { documentClient: h.db, tableName: "state", access, audit: capture.audit };
  const admin = (usd: number) => writeBudgets(deps, orgId, { orgMonthlyUsd: usd, memberOverrides: {} }, MAYA.developerId, new Date().toISOString(), { authority: { developerId: MAYA.developerId, role: "admin" } });
  return { ...h, capture, access, operator, admin, deps };
}
it("the shipped operator CLI sets a fresh private budget with no members and records an operator audit", async () => {
  const f = await fixture();
  expect(f.db.find(item => item.entityType === "ORG_MEMBER")).toHaveLength(0);
  await expect(f.operator(800)).resolves.toMatchObject({ budget: { orgMonthlyUsd: 800 } });
  expect(f.db.find(item => item.entityType === "ORG_MEMBER")).toHaveLength(0);
  expect(f.db.get(key)?.revision).toBe(1);
  const events = f.capture.recordedBy("budget.changed"); expect(events).toHaveLength(1);
  expect(events[0]?.actor?.kind).toBe("operator");
  expect(events[0]?.actor?.id).toMatch(/^op_[0-9a-f]{24}$/);
  expect(f.access.upsertOrg).toHaveBeenCalledWith(orgId, 800);
});
for (const outer of ["operator", "admin"] as const) it(`one concurrent ${outer}/other budget wins, loser gets CHANGE_STALE and exact audit before`, async () => {
  const f = await fixture(); seedMembership(f.db, MAYA.developerId, { orgId, role: "admin" });
  f.db.set({ ...key, entityType: "ORG_BUDGET", orgMonthlyUsd: 500, memberOverrides: {}, revision: 1 });
  const send = f.db.send.bind(f.db); let raced = false;
  f.db.send = async command => {
    const items = (command.input as { TransactItems?: Array<{ Put?: { Item?: { pk?: string; sk?: string } } }> }).TransactItems;
    if (!raced && items?.some(item => item.Put?.Item?.pk === key.pk && item.Put.Item.sk === key.sk)) { raced = true; await (outer === "operator" ? f.admin(800) : f.operator(800)); }
    return send(command);
  };
  const change = outer === "operator" ? f.operator : f.admin;
  expect((await change(900).then(() => undefined, (e: { code?: string }) => e))?.code).toBe("CHANGE_STALE");
  expect(raced).toBe(true); expect(f.db.get(key)).toMatchObject({ orgMonthlyUsd: 800, revision: 2 });
  expect(f.capture.recordedBy("budget.changed").map(e => ({ from: e.facts?.fromCents, to: e.facts?.toCents }))).toEqual([{ from: 50000, to: 80000 }]);
  await change(900);
  expect(f.db.get(key)).toMatchObject({ orgMonthlyUsd: 900, revision: 3 });
  expect(f.capture.recordedBy("budget.changed").map(e => ({ from: e.facts?.fromCents, to: e.facts?.toCents }))).toEqual([{ from: 50000, to: 80000 }, { from: 80000, to: 90000 }]);
});
for (const revision of [0, 1.5, "broken"] as const) for (const authority of ["operator", "admin"] as const) it(`repairs raw revision ${revision} through ${authority}, then member removal works`, async () => {
  const f = await fixture(), victim = "b".repeat(64); seedMembership(f.db, MAYA.developerId, { orgId, role: "admin" }); seedMembership(f.db, victim, { orgId, role: "member" });
  f.db.set({ ...key, entityType: "ORG_BUDGET", orgMonthlyUsd: 500, memberOverrides: { [victim]: 30 }, revision });
  if (authority === "operator") await expect(f.operator(500)).resolves.toMatchObject({ budget: { orgMonthlyUsd: 500 } });
  else await expect(writeBudgets(f.deps, orgId, { orgMonthlyUsd: 500, memberOverrides: { [victim]: 30 } }, MAYA.developerId, new Date().toISOString(), { authority: { developerId: MAYA.developerId, role: "admin" } })).resolves.toBeUndefined();
  expect(f.db.get(key)).toMatchObject({ orgMonthlyUsd: 500, memberOverrides: { [victim]: 30 }, revision: 1 });
  await new OrgStore({ documentClient: f.db, tableName: "state", now: Date.now }).removeMember({ orgId, developerId: victim, emails: [], ban: false });
  expect(f.db.get(orgMemberKey(orgId, victim))).toBeUndefined(); expect(f.db.get(key)).toMatchObject({ orgMonthlyUsd: 500, memberOverrides: {}, revision: 2 });
});
for (const kind of ["budgets", "guardrails"] as const) it(`member role is refused inside ${kind} writer independently of its caller`, async () => {
  const t = await setup(), access = fakeModelAccess(), actor = { developerId: MAYA.developerId, role: "member" as const };
  await t.orgOf(MAYA); seedMembership(t.db, MAYA.developerId, { orgId: TEST_ORG, role: "member" });
  const write = (role: "member" | "admin") => kind === "budgets" ? writeBudgets({ documentClient: t.db, tableName: "state", access }, TEST_ORG, { orgMonthlyUsd: 800, memberOverrides: {} }, MAYA.developerId, new Date().toISOString(), { authority: { ...actor, role } }) : t.store.putGuardrails({ orgId: TEST_ORG, guardrails: DEFAULT_AGENT_GUARDRAILS, expectedRevision: 0, by: MAYA.developerId, actor: { ...actor, role } });
  expect((await write("member").then(() => undefined, (e: { code?: string }) => e))?.code).toBe("FORBIDDEN");
  seedMembership(t.db, MAYA.developerId, { orgId: TEST_ORG, role: "admin" }); await write("admin");
});
for (const kind of ["agent", "chain"] as const) it(`${kind} budgets require an actor without a request, while a legitimate member owner still succeeds`, async () => {
  const t = await setup(), plural = kind === "agent" ? "agents" : "chains";
  const made = await t.api(MAYA, "POST", `/v1/app/${plural}`, { name: "Owned money", ...(kind === "agent" ? { overlay: TRIAGE } : {}) }); expect(made.status).toBe(201);
  const row = made.body[kind] as Record<string, string>, id = row[kind === "agent" ? "agentId" : "chainId"]!;
  const set = (withActor: boolean) => kind === "agent" ? t.store.setBudget(TEST_ORG, id, { monthlyUsd: 10 }, MAYA.developerId, undefined, withActor ? { actor: { developerId: MAYA.developerId, role: "member" } } : {})
    : t.deps().chains!.setBudget(TEST_ORG, id, 10, MAYA.developerId, undefined, withActor ? { actor: { developerId: MAYA.developerId, role: "member" } } : {});
  expect((await set(false).then(() => undefined, (e: { code?: string }) => e))?.code).toBe("FORBIDDEN"); await set(true);
});

for (const authority of ["operator", "admin"] as const) it(`refuses ${authority} revision repair when the exact malformed raw revision changes concurrently`, async () => {
  const f = await fixture(); seedMembership(f.db, MAYA.developerId, { orgId, role: "admin" });
  f.db.set({ ...key, entityType: "ORG_BUDGET", orgMonthlyUsd: 500, memberOverrides: {}, revision: 1.5 });
  const send = f.db.send.bind(f.db); let raced = false;
  f.db.send = async command => {
    const items = (command.input as { TransactItems?: Array<{ Put?: { Item?: { pk?: string; sk?: string } } }> }).TransactItems;
    if (!raced && items?.some(item => item.Put?.Item?.pk === key.pk && item.Put.Item.sk === key.sk)) { raced = true; await send(new UpdateCommand({ TableName: "state", Key: key, UpdateExpression: "SET revision = :raw", ExpressionAttributeValues: { ":raw": "changed-corrupt-revision" } })); }
    return send(command);
  };
  expect((await (authority === "operator" ? f.operator(500) : f.admin(500)).then(() => undefined, (e: { code?: string }) => e))?.code).toBe("CHANGE_STALE");
  expect(raced).toBe(true); expect(f.db.get(key)).toMatchObject({ orgMonthlyUsd: 500, revision: "changed-corrupt-revision" });
  expect(f.capture.recordedBy("budget.changed")).toHaveLength(0);
});

for (const count of [98, 99]) it(`preserves the operator's existing atomic ${count}-event boundary`, async () => {
  const f = await fixture(), overrides: Record<string, number> = {};
  for (let i = 0; i < count; i += 1) { const id = i.toString(16).padStart(64, "0"); seedMembership(f.db, id, { orgId, role: "member" }); overrides[id] = 100 + i; }
  const result = await adminCall(f.handler, { method: "PUT", path: "/v1/admin/org/budget", body: { requestId: randomUUID(), memberOverrides: overrides }, admin: true });
  expect(result.status).toBe(count === 98 ? 200 : 400);
  expect(f.capture.recordedBy("budget.changed")).toHaveLength(count === 98 ? 98 : 0);
  if (count === 99) { expect(f.db.get(key)).toBeUndefined(); expect(f.access.upsertOrg).not.toHaveBeenCalled(); }
});
