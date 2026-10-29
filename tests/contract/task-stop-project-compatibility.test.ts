import { fixtureProject } from "../support/project-ai-source.js";
import { fixtureActor } from "../support/money-authority.js";
import { expect, it } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ProjectAiSettingsSchema, defaultProjectAiSettings, type ProjectAiSettings } from "../../packages/contracts/src/spend.js";
import { projectAiKey } from "@agentx/contracts";
import { applyProjectAiChange, readProjectAiWithRevision, writeProjectAi } from "../../packages/broker/src/spend/settings.js";
import { resolveRunPayer } from "../../packages/broker/src/agents/runs.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { capturingAuditDeps } from "../support/audit-capture.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb", who = "a".repeat(64);
const policy = { schemaVersion: 1, stopMicrousd: 20_000_000 } as const;
function fixture() {
  const db = new FakeDynamoDb();
  fixtureProject(db, A, "web");
  const capture = capturingAuditDeps({ db });
  const deps = { documentClient: db, tableName: "state", now: () => Date.parse("2026-10-27T21:00:00Z"), audit: capture.audit };
  db.set({ ...projectAiKey(A, "web"), entityType: "PROJECT_AI", projectPays: false, monthlyBudgetUsd: 200, taskStopPolicy: policy, revision: 1 });
  return { db, capture, deps };
}
const oldClient = () => ({ projectPays: false, monthlyBudgetUsd: 300 });
const refused = async (job: Promise<unknown>) => job.then(() => undefined, (error: { code?: string; message?: string }) => error);

it("accepts a strict versioned project override while keeping unset distinct from zero", () => {
  expect(ProjectAiSettingsSchema.safeParse({ projectPays: false, taskStopPolicy: policy }).success).toBe(true);
  expect(ProjectAiSettingsSchema.safeParse({ projectPays: false, taskStopPolicy: { schemaVersion: 1, stopMicrousd: 0 } }).success).toBe(true);
  expect(Object.hasOwn(defaultProjectAiSettings(), "taskStopPolicy")).toBe(false);
});
it("keeps the project override through the canonical reader and unrelated patch application", async () => {
  const f = fixture();
  const stored = await readProjectAiWithRevision(f.deps, A, "web");
  expect(stored.settings).toMatchObject({ taskStopPolicy: policy });
  const next = applyProjectAiChange(stored.settings, { monthlyBudgetUsd: 300 });
  expect(next).toMatchObject({ monthlyBudgetUsd: 300, taskStopPolicy: policy });
});
it("preserves the override omitted by an old caller and audits only the ordinary monthly change", async () => {
  const f = fixture();
  const result = await writeProjectAi(f.deps, A, "web", oldClient(), fixtureActor(f.deps, A, who).developerId, { ...({ expectedRevision: 1 }), actor: fixtureActor(f.deps, A, who) });
  expect(result).toMatchObject({ revision: 2, settings: { monthlyBudgetUsd: 300, taskStopPolicy: policy } });
  expect(f.db.get(projectAiKey(A, "web"))?.taskStopPolicy).toEqual(policy);
  expect(f.capture.recordedBy("budget.changed").length).toBe(1);
  expect(f.capture.recorded().length).toBe(1);
});
it("uses canonical source policy rather than an incomplete caller before snapshot", async () => {
  const f = fixture();
  await writeProjectAi(f.deps, A, "web", oldClient(), fixtureActor(f.deps, A, who).developerId, { ...({ expectedRevision: 1, before: { projectPays: false, monthlyBudgetUsd: 200 } }), actor: fixtureActor(f.deps, A, who) });
  expect(f.db.get(projectAiKey(A, "web"))?.taskStopPolicy).toEqual(policy);
});
it("accepts the exact same policy payload without granting mutation rights", async () => {
  const f = fixture();
  const next = { projectPays: false, monthlyBudgetUsd: 200, taskStopPolicy: { stopMicrousd: 20_000_000, schemaVersion: 1 } };
  await writeProjectAi(f.deps, A, "web", next as ProjectAiSettings, fixtureActor(f.deps, A, who).developerId, { ...({ expectedRevision: 1 }), actor: fixtureActor(f.deps, A, who) });
  expect(f.db.get(projectAiKey(A, "web"))?.taskStopPolicy).toEqual(policy);
  expect(f.capture.recorded().length).toBe(0);
});
for (const [name, value] of [["changed", { schemaVersion: 1, stopMicrousd: 0 }], ["removed", null], ["unknown version", { schemaVersion: 2, stopMicrousd: 1 }]] as const) {
  it(`refuses an ordinary writer's ${name} task-stop payload`, async () => {
    const f = fixture();
    const input = { ...oldClient(), taskStopPolicy: value } as unknown as ProjectAiSettings;
    const error = await refused(writeProjectAi(f.deps, A, "web", input, fixtureActor(f.deps, A, who).developerId, { ...({ expectedRevision: 1 }), actor: fixtureActor(f.deps, A, who) }));
    expect(error?.code).toBe("CONFIG_INVALID");
    expect(error?.message?.startsWith("CONFIG_INVALID: taskStopPolicy:")).toBe(true);
    expect(f.db.get(projectAiKey(A, "web"))?.taskStopPolicy).toEqual(policy);
    expect(f.db.transactions().length).toBe(0);
    expect(f.capture.recorded().length).toBe(0);
  });
}
it("refuses introducing a task-stop override through the ordinary settings writer", async () => {
  const f = fixture();
  f.db.set({ ...projectAiKey(A, "web"), entityType: "PROJECT_AI", projectPays: false, revision: 1 });
  const input = { ...oldClient(), taskStopPolicy: policy };
  const error = await refused(writeProjectAi(f.deps, A, "web", input, fixtureActor(f.deps, A, who).developerId, { ...({ expectedRevision: 1 }), actor: fixtureActor(f.deps, A, who) }));
  expect(error?.code).toBe("CONFIG_INVALID");
  expect(Object.hasOwn(f.db.get(projectAiKey(A, "web"))!, "taskStopPolicy")).toBe(false);
  expect(f.db.transactions().length).toBe(0);
});
for (const [name, value] of [["undefined", undefined], ["null", null], ["missing amount", { schemaVersion: 1 }], ["fraction", { schemaVersion: 1, stopMicrousd: 0.1 }], ["unknown version", { schemaVersion: 2, stopMicrousd: 1 }], ["second ceiling", { schemaVersion: 1, stopMicrousd: 1, ceilingMicrousd: 1 }]] as const) {
  it(`refuses a stored ${name} project override instead of losing it on re-save`, async () => {
    const f = fixture();
    f.db.set({ ...f.db.get(projectAiKey(A, "web")), taskStopPolicy: value });
    const error = await refused(writeProjectAi(f.deps, A, "web", oldClient(), fixtureActor(f.deps, A, who).developerId, { ...({ expectedRevision: 1 }), actor: fixtureActor(f.deps, A, who) }));
    expect(error?.code).toBe("CONFIG_INVALID");
    expect(error?.message?.includes("project web")).toBe(true);
    expect(error?.message?.includes("Ask an org owner or admin")).toBe(true);
    expect(f.db.get(projectAiKey(A, "web"))?.revision).toBe(1);
    expect(f.db.transactions().length).toBe(0);
  });
}
it("refuses an unavailable canonical source even when the caller supplies before", async () => {
  const f = fixture();
  f.db.injectFault({ command: "GetCommand", error: { name: "ServiceUnavailable", message: "private source failure" } });
  const error = await refused(writeProjectAi(f.deps, A, "web", oldClient(), fixtureActor(f.deps, A, who).developerId, { ...({ expectedRevision: 1, before: { projectPays: false, monthlyBudgetUsd: 200 } }), actor: fixtureActor(f.deps, A, who) }));
  expect(error !== undefined).toBe(true);
  expect(f.db.get(projectAiKey(A, "web"))?.taskStopPolicy).toEqual(policy);
  expect(f.db.transactions().length).toBe(0);
});
it("cannot advance a maximum safe revision into an unsafe value", async () => {
  const f = fixture();
  f.db.set({ ...f.db.get(projectAiKey(A, "web")), revision: Number.MAX_SAFE_INTEGER });
  const error = await refused(writeProjectAi(f.deps, A, "web", oldClient(), fixtureActor(f.deps, A, who).developerId, { ...({ expectedRevision: Number.MAX_SAFE_INTEGER }), actor: fixtureActor(f.deps, A, who) }));
  expect(error?.code).toBe("CONFIG_INVALID");
  expect(f.db.get(projectAiKey(A, "web"))?.revision).toBe(Number.MAX_SAFE_INTEGER);
  expect(f.db.transactions().length).toBe(0);
});
it("does not overwrite an intervening configured policy revision or audit the refused monthly write", async () => {
  const f = fixture();
  const send = f.db.send.bind(f.db);
  let moved = false;
  f.db.send = async command => {
    const result = await send(command);
    const key = (command.input as { Key?: { pk?: string; sk?: string } }).Key;
    if (!moved && key?.pk === projectAiKey(A, "web").pk && key.sk === "SETTINGS") {
      moved = true;
      await send(new TransactWriteCommand({ TransactItems: [{ Update: { TableName: "state", Key: projectAiKey(A, "web"), UpdateExpression: "SET #policy = :policy, #revision = :revision", ExpressionAttributeNames: { "#policy": "taskStopPolicy", "#revision": "revision" }, ExpressionAttributeValues: { ":policy": { schemaVersion: 1, stopMicrousd: 30_000_000 }, ":revision": 2 } } }] }));
    }
    return result;
  };
  const error = await refused(writeProjectAi(f.deps, A, "web", oldClient(), fixtureActor(f.deps, A, who).developerId, { ...({ expectedRevision: 1, before: { projectPays: false, monthlyBudgetUsd: 200 } }), actor: fixtureActor(f.deps, A, who) }));
  expect(moved).toBe(true);
  expect(error?.code).toBe("AGENT_REVISION_CONFLICT");
  expect(f.db.get(projectAiKey(A, "web"))?.taskStopPolicy).toEqual({ schemaVersion: 1, stopMicrousd: 30_000_000 });
  expect(f.db.get(projectAiKey(A, "web"))?.monthlyBudgetUsd).toBe(200);
  expect(f.capture.recorded().length).toBe(0);
});
it("keeps project policy preservation in the caller's org", async () => {
  const f = fixture();
  f.db.set({ ...projectAiKey(B, "web"), entityType: "PROJECT_AI", projectPays: false, taskStopPolicy: { schemaVersion: 1, stopMicrousd: 1 }, revision: 5 });
  await writeProjectAi(f.deps, A, "web", oldClient(), fixtureActor(f.deps, A, who).developerId, { ...({ expectedRevision: 1 }), actor: fixtureActor(f.deps, A, who) });
  expect(f.db.get(projectAiKey(A, "web"))?.taskStopPolicy).toEqual(policy);
  expect(f.db.get(projectAiKey(B, "web"))?.taskStopPolicy).toEqual({ schemaVersion: 1, stopMicrousd: 1 });
  expect(f.db.get(projectAiKey(B, "web"))?.revision).toBe(5);
});

for (const firstWrite of [false, true]) {
  it(`keeps task-stop intent absent after ${firstWrite ? "a first revision0 write" : "an existing policyless document edit"}`, async () => {
    const f = fixture();
    if (firstWrite) f.db.delete(projectAiKey(A, "web"));
    else f.db.set({ ...projectAiKey(A, "web"), entityType: "PROJECT_AI", projectPays: false, monthlyBudgetUsd: 200, revision: 1 });
    const result = await writeProjectAi(f.deps, A, "web", oldClient(), fixtureActor(f.deps, A, who).developerId, { ...({ expectedRevision: firstWrite ? 0 : 1 }), actor: fixtureActor(f.deps, A, who) });
    expect(Object.hasOwn(f.db.get(projectAiKey(A, "web"))!, "taskStopPolicy")).toBe(false);
    expect(Object.hasOwn(result.settings, "taskStopPolicy")).toBe(false);
  });
}
it("names the project and org owner/admin remedy when malformed stop settings block a start", async () => {
  const f = fixture();
  const deps = { ...f.deps, store: new AgentStore({ documentClient: f.db, tableName: "state", now: f.deps.now }), projectMembers: new FakeProjectMembers(), signInStore: { getDeveloper: async () => undefined }, confirmOrigin: "https://cell.example" };
  const input = { orgId: A, project: "web", agentId: "rovara-code", origin: "app" as const, startedBy: { developerId: who } };
  expect((await resolveRunPayer(deps, input)).payer).toEqual({ kind: "member", developerId: who });
  f.db.set({ ...f.db.get(projectAiKey(A, "web")), taskStopPolicy: { schemaVersion: 1 } });
  const error = await refused(resolveRunPayer(deps, input));
  expect(error?.code).toBe("CONFIG_INVALID");
  expect(error?.message?.includes("project web")).toBe(true);
  expect(error?.message?.includes("Ask an org owner or admin")).toBe(true);
  expect(error?.message).toBe("CONFIG_INVALID: The per-task stop for project web is invalid. Ask an org owner or admin to fix it before starting work.");
  expect(f.db.transactions().length).toBe(0);
});

it("preserves an explicit zero stop during an ordinary edit instead of turning it into unset", async () => {
  const f = fixture();
  f.db.set({ ...f.db.get(projectAiKey(A, "web")), taskStopPolicy: { schemaVersion: 1, stopMicrousd: 0 } });
  const result = await writeProjectAi(f.deps, A, "web", oldClient(), fixtureActor(f.deps, A, who).developerId, { ...({ expectedRevision: 1 }), actor: fixtureActor(f.deps, A, who) });
  expect(f.db.get(projectAiKey(A, "web"))?.taskStopPolicy).toEqual({ schemaVersion: 1, stopMicrousd: 0 });
  expect(result.settings).toMatchObject({ taskStopPolicy: { schemaVersion: 1, stopMicrousd: 0 } });
});
