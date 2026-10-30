import { expect, it } from "vitest";
import { TransactGetCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_AGENT_GUARDRAILS, agentGuardrailsKey, agentKey, developerOrgKey, orgMemberKey, orgMetaKey, orgProjectCatalogKey, orgSettingsKey, orgScoped, projectAiKey } from "@agentx/contracts";
import * as company from "../../packages/broker/src/org/task-stop-company.js";

const orgId = "org_aaaaaaaaaaaaaaaaaaaa", who = "a".repeat(64), agentId = "agt_aaaaaaaaaaaaaaaaaaaa", project = "project";
const now = Date.parse("2026-10-29T22:00:00Z");
function fixture() {
  const calls: unknown[] = [], order: string[] = [];
  const rows: Record<string, unknown>[] = [
    { ...orgMemberKey(orgId, who), orgId, developerId: who, role: "member" },
    { ...developerOrgKey(who), orgId, role: "member" },
    { ...orgMetaKey(orgId), orgId },
    { ...orgSettingsKey(orgId, "TASK_STOP_POLICY"), entityType: "ORG_TASK_STOP_POLICY", orgId, revision: 1,
      policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } }, enrollment: { version: 1, state: "enabled" } },
    { ...agentGuardrailsKey(orgId), entityType: "AGENT_GUARDRAILS", orgId, revision: 2, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 1 } },
    { ...orgProjectCatalogKey(orgId, project), entityType: "PROJECT_CATALOG", orgId, name: project, latestRevision: 2 },
    { ...projectAiKey(orgId, project), entityType: "PROJECT_AI", orgId, project, revision: 3, taskStopPolicy: { schemaVersion: 2, kind: "inherit" } },
    { ...agentKey(orgId, agentId, "META"), entityType: "AGENT", orgId, agentId, status: "active", revision: 4, stopKind: "inherit" },
    { pk: orgScoped(orgId, "TASK_STOP_SEED"), sk: "V1#bootstrap", entityType: "TASK_STOP_SEED", orgId, source: "bootstrap", version: 1, outcome: "created", policyRevision: 1 },
  ];
  const deps = { tableName: "state", now: () => now,
    requireScopeAccess: async () => { order.push("authorized"); },
    documentClient: { send: async (command: unknown) => {
      calls.push(command); order.push("snapshot");
      expect(command).toBeInstanceOf(TransactGetCommand);
      if (!(command instanceof TransactGetCommand)) throw new Error("nontransactional read");
      return { Responses: command.input.TransactItems?.map(item => ({ Item: structuredClone(rows.find(row => row.pk === item.Get?.Key?.pk && row.sk === item.Get.Key.sk)) })) };
    } },
  };
  const input = { orgId, developerId: who, role: "member", project, agentId, pathLimitMicrousd: 20_000_000 };
  async function capture(extra: Record<string, unknown> = {}) {
    const fn: unknown = Reflect.get(company, "captureTaskStopAdmission");
    expect(typeof fn).toBe("function");
    if (typeof fn !== "function") throw new Error("capture function missing");
    const invoke = fn as (deps: unknown, input: unknown) => Promise<unknown>;
    return invoke(deps, { ...input, ...extra });
  }
  return { rows, calls, order, deps, input, capture };
}
it("authorizes first, reads every scope in ONE native snapshot and retains an unapproved FULL20 under ceiling1", async () => {
  const f = fixture();
  expect(await f.capture()).toMatchObject({ kind: "captured", capturedAt: "2026-10-29T22:00:00.000Z", effectiveStopMicrousd: 20_000_000, approvalCapMicrousd: 1_000_000 });
  expect(f.order).toEqual(["authorized", "snapshot"]); expect(f.calls).toHaveLength(1);
});
it("never reads financial sources when scope authorization refuses", async () => {
  const f = fixture(); f.deps.requireScopeAccess = async () => { throw new Error("denied"); };
  await expect(f.capture()).rejects.toThrow("denied"); expect(f.calls).toEqual([]);
});
it("a captured policy is immutable across later edits; the next capture sees them", async () => {
  const f = fixture(); const first = await f.capture();
  f.rows[3]!.policy = { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 4_000_001 } }; f.rows[3]!.revision = 2;
  expect(await f.capture()).toMatchObject({ kind: "captured", effectiveStopMicrousd: 4_000_001 });
  expect(first).toMatchObject({ kind: "captured", effectiveStopMicrousd: 20_000_000 });
});
for (const index of [3, 4, 5, 6, 7]) {
  it(`refuses missing snapshot row ${index} rather than inventing inheritance/defaults`, async () => {
    const f = fixture(); f.rows.splice(index, 1);
    await expect(f.capture()).rejects.toMatchObject({ code: "TASK_STOP_CONFIG_MISSING" });
  });
}
for (const index of [3, 4, 5, 6, 7]) {
  it(`refuses foreign identity at snapshot row ${index}`, async () => {
    const f = fixture(); f.rows[index]!.orgId = "org_bbbbbbbbbbbbbbbbbbbb";
    await expect(f.capture()).rejects.toMatchObject({ code: "TASK_STOP_CONFIG_INVALID" });
  });
}
for (const change of ["member", "pointer", "closed"] as const) {
  it(`does not trust pre-read access after ${change} drift`, async () => {
    const f = fixture();
    if (change === "closed") f.rows[2]!.closingAt = "now";
    else f.rows[change === "member" ? 0 : 1]!.role = "viewer";
    await expect(f.capture()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
}
it("rejects corrupt or unrecognized inheritance rather than marking missing scope as inherit", async () => {
  const f = fixture(); delete f.rows[7]!.stopKind;
  await expect(f.capture()).rejects.toMatchObject({ code: "TASK_STOP_CONFIG_INVALID" });
});
it("does not enable bootstrap enrollment or claim a start permission", async () => {
  const f = fixture(); f.rows[3]!.enrollment = { version: 1, state: "disabled" };
  expect(await f.capture()).toEqual({ kind: "disabled" });
});
it("rejects above-ceiling NEW approved limit without tightening ordinary starting estimates", async () => {
  const f = fixture();
  await expect(f.capture({ approvedRunLimitMicrousd: 1_000_001 })).rejects.toMatchObject({ code: "TASK_STOP_APPROVAL_ABOVE_CEILING" });
});
it("does not return raw member, guardrail or private source metadata in the captured envelope", async () => {
  const f = fixture(); f.rows[7]!.privateFixture = "private source value";
  const result = await f.capture();
  expect(JSON.stringify(result)).not.toContain("private source value");
  expect(JSON.stringify(result)).not.toContain("forbiddenModels");
});

it("keeps an unseeded legacy org disabled only when both immutable seed receipts and policy are absent", async () => {
  const f = fixture(); f.rows.splice(8, 1); f.rows.splice(3, 1);
  expect(await f.capture()).toEqual({ kind: "disabled" });
  expect(f.calls).toHaveLength(1);
});
it("does not enable an apparent policy without an immutable seed receipt", async () => {
  const f = fixture(); f.rows.splice(8, 1);
  await expect(f.capture()).rejects.toMatchObject({ code: "TASK_STOP_CONFIG_MISSING" });
});
it("does not fall back to legacy behavior when a seeded company's policy disappears", async () => {
  const f = fixture(); f.rows.splice(3, 1);
  await expect(f.capture()).rejects.toMatchObject({ code: "TASK_STOP_CONFIG_MISSING" });
});
it("rejects a foreign seed receipt instead of considering it absent", async () => {
  const f = fixture(); f.rows[8]!.orgId = "org_bbbbbbbbbbbbbbbbbbbb";
  await expect(f.capture()).rejects.toMatchObject({ code: "TASK_STOP_CONFIG_INVALID" });
});
it("legacy Slack-derived callers retain pre-enrollment behavior after trusted scope authorization", async () => {
  const f = fixture(); f.rows.splice(8, 1); f.rows.splice(3, 1); f.rows.splice(0, 2);
  expect(await f.capture()).toEqual({ kind: "disabled" });
  expect(f.order).toEqual(["authorized", "snapshot"]);
});
for (const state of ["disabled", "ready"] as const) it(`seeded ${state} policy preserves trusted legacy callers until cutover`, async () => {
  const f = fixture(); f.rows[3]!.enrollment = { version: 1, state }; f.rows.splice(0, 2);
  expect(await f.capture()).toEqual({ kind: "disabled" });
  expect(f.order).toEqual(["authorized", "snapshot"]);
});

for (const state of ["disabled", "ready"] as const) it(`cutover preview uses the same snapshot calculator while enrollment stays ${state}`, async () => {
  const f = fixture(), enabled = await f.capture(); f.rows[3]!.enrollment = { version: 1, state };
  const before = structuredClone(f.rows);
  expect(await f.capture()).toEqual({ kind: "disabled" });
  const preview: unknown = Reflect.get(company, "previewTaskStopCutover"); expect(typeof preview).toBe("function");
  if (typeof preview !== "function") throw new Error("cutover preview missing");
  const invoke = preview as (deps: unknown, input: unknown) => Promise<unknown>;
  expect(await invoke(f.deps, f.input)).toEqual({ kind: "preview", enrolled: false, snapshot: enabled });
  expect(f.rows).toEqual(before); expect(f.calls).toHaveLength(3); expect(f.order.slice(-2)).toEqual(["authorized", "snapshot"]);
});
for (const drift of ["member", "pointer", "seed", "scope"] as const) it(`cutover preview refuses ${drift} loss without enabling enrollment`, async () => {
  const f = fixture(); f.rows[3]!.enrollment = { version: 1, state: "disabled" };
  if (drift === "member" || drift === "pointer") f.rows[drift === "member" ? 0 : 1]!.role = "viewer";
  if (drift === "seed") f.rows.pop();
  if (drift === "scope") f.deps.requireScopeAccess = async () => { throw new Error("scope denied"); };
  const preview: unknown = Reflect.get(company, "previewTaskStopCutover"); expect(typeof preview).toBe("function");
  if (typeof preview !== "function") throw new Error("cutover preview missing");
  const invoke = preview as (deps: unknown, input: unknown) => Promise<unknown>;
  await expect(invoke(f.deps, f.input)).rejects.toBeDefined();
  expect(f.rows[3]!.enrollment).toEqual({ version: 1, state: "disabled" });
  if (drift === "scope") expect(f.calls).toHaveLength(0);
});

it("cutover preview never labels an enabled org unenrolled or accepts a client review mode", async () => {
  const f = fixture(), preview: unknown = Reflect.get(company, "previewTaskStopCutover");
  expect(typeof preview).toBe("function"); if (typeof preview !== "function") throw new Error("cutover preview missing");
  const invoke = preview as (deps: unknown, input: unknown) => Promise<unknown>;
  await expect(invoke(f.deps, f.input)).rejects.toMatchObject({ code: "TASK_STOP_CONFIG_INVALID" });
  f.rows[3]!.enrollment = { version: 1, state: "disabled" };
  await expect(f.capture({ cutoverPreview: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(await f.capture()).toEqual({ kind: "disabled" });
});

for (const limited of [false, true]) it(`taskless eval capture uses explicit none_eval scope with ${limited ? "project stop" : "seeded estimate"}`, async () => {
  const f = fixture();
  f.rows.splice(7, 1); // There is no agent resource for a taskless eval.
  if (limited) f.rows[6]!.taskStopPolicy = { schemaVersion: 1, stopMicrousd: 1234567 };
  const { agentId: omitted, ...scope } = f.input;
  expect(omitted).toBe(agentId);
  const capture = await company.captureTaskStopAdmission(f.deps, { ...scope, agentScope: "none_eval" });
  expect(capture).toMatchObject({ kind: "captured", agentScope: "none_eval", effectiveStopMicrousd: limited ? 1234567 : 20000000, approvalCapMicrousd: 1000000 });
  expect(capture).not.toHaveProperty("agentId");
  expect(f.calls).toHaveLength(1);
  const command = f.calls[0] as TransactGetCommand;
  expect(command.input.TransactItems?.some(item => item.Get?.Key?.pk === agentKey(orgId, agentId, "META").pk)).toBe(false);
});
