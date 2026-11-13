// Switch blocker 2 (money): the switch must not change money behaviour. The payer a core admission counts against is Cloud's own (`resolvePayer` over the project's AI settings, as
// `resolveRunPayer` applies it to a person's start), held to v2's functions for the same inputs; a company enrolled in per-task spending stops stays on Cloud's start, which captures the stop.
import { describe, expect, it } from "vitest";
import { projectAiKey, scopeKey, type BudgetScope, orgSettingsKey } from "@agentx/cloud-contracts";
import { ROVARA_CODE_AGENT_ID, orgScoped, type AdmissionRequest } from "@rovara-code/contracts";
import { cloudAdmissionLevels, cloudLevelSources, readTaskStop, taskStopEnrolled } from "../../packages/broker/src/cloud/app/index.js";
import { resolveRunPayer } from "../../packages/broker/src/agents/runs.js";
import { taskPointerKey } from "../../packages/broker/src/developer/task-records.js";
import { budgetScopesFor } from "../../packages/broker/src/spend/payer.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_s3money00000000000a" as never;
const PERSON = "a".repeat(64);
const MONTH = "2026-11";

const request = (over: Partial<AdmissionRequest> = {}): AdmissionRequest => ({ companyId: ORG, idempotencyKey: "k", action: "task.start", projectName: "payments", actor: { personId: PERSON } as never, ...over });

function dbWith(projectPays: boolean | undefined): FakeDynamoDb {
  const db = new FakeDynamoDb();
  if (projectPays !== undefined) db.set({ ...projectAiKey(ORG, "payments"), entityType: "PROJECT_AI", projectPays, revision: 1 });
  return db;
}
const depsOf = (db: FakeDynamoDb) => ({ documentClient: db, tableName: "state", now: () => Date.parse("2026-11-13T10:00:00.000Z") }) as never;

describe("the payer of a core admission is Cloud's own", () => {
  it.each([[undefined], [false], [true]] as const)("a person's start with the project's pays setting %j: the same budgets as v2's resolveRunPayer and budgetScopesFor", async (projectPays) => {
    const db = dbWith(projectPays);
    const v2 = await resolveRunPayer(depsOf(db), { orgId: ORG, project: "payments", agentId: ROVARA_CODE_AGENT_ID, origin: "app", startedBy: { developerId: PERSON } });
    const expected = budgetScopesFor(v2.payer, v2.place, { agentId: ROVARA_CODE_AGENT_ID }).map((scope: BudgetScope) => scopeKey(scope));
    const levels = await cloudAdmissionLevels(cloudLevelSources(depsOf(db)))(request(), MONTH);
    expect(levels.map((level) => level.scope)).toEqual(expected);
    // The member's own budget is counted unless the project pays.
    expect(levels.some((level) => level.kind === "member")).toBe(projectPays !== true);
  });

  it("a request with no person and no task is charged to no one by default: it fails (the nightly run is the project's own work, as v2 charges it)", async () => {
    const sources = cloudLevelSources(depsOf(dbWith(false)));
    await expect(cloudAdmissionLevels(sources)(request({ actor: undefined } as never), MONTH)).rejects.toThrow(/no payer recorded/);
    const nightly = await cloudAdmissionLevels(sources)(request({ actor: undefined, action: "nightly.run", subject: { type: "project", id: "payments" } } as never), MONTH);
    expect(nightly.map((level) => level.kind)).toEqual(["org", "project"]);
  });

  it("a request that names no project is refused (no scopes is never free)", async () => {
    await expect(cloudAdmissionLevels(cloudLevelSources(depsOf(dbWith(false))))(request({ projectName: undefined } as never), MONTH)).rejects.toThrow();
  });
});

describe("M-2: follow-on spend is charged to the payer the task's start captured, as v2 charges it", () => {
  const TASK = "77777777-7777-4777-8777-777777777777";
  const WORKSPACE = "88888888-8888-4888-8888-888888888888";
  const startOf = () => ({ ...request({ idempotencyKey: `task.start:${TASK}:1`, subject: { type: "task", id: TASK } }) });
  const followOn = (over: Partial<AdmissionRequest>): AdmissionRequest => request({ actor: undefined, action: "model.call", subject: { type: "task", id: TASK } as never, ...over } as never);

  /** Starts the task: the start's admission captures the payer (its items go into the start's own transaction, here applied to the same table). */
  async function started(db: FakeDynamoDb) {
    const sources = cloudLevelSources(depsOf(db));
    for (const item of await sources.capture!(startOf())) if (item.kind === "put") db.set(item.item);
    db.set({ ...taskPointerKey(WORKSPACE), entityType: "TASK_POINTER", taskId: TASK });
    return sources;
  }
  const kinds = async (sources: ReturnType<typeof cloudLevelSources>, request: AdmissionRequest) => (await cloudAdmissionLevels(sources)(request, MONTH)).map((level) => level.kind);

  it("a person-paid task: the second review's, the design review's and the re-run's spend count against the person who started it, even after the project switches to paying", async () => {
    const db = dbWith(false);
    const sources = await started(db);
    expect(await kinds(sources, followOn({}))).toEqual(["org", "project", "member"]);
    db.set({ ...projectAiKey(ORG, "payments"), entityType: "PROJECT_AI", projectPays: true, revision: 2 });
    expect(await kinds(sources, followOn({}))).toEqual(["org", "project", "member"]);
    expect(await kinds(sources, followOn({ action: "autofix.base-merged" }))).toEqual(["org", "project", "member"]);
    // The same scopes v2 counts for the payer its start recorded (paymentOfTask).
    const levels = await cloudAdmissionLevels(sources)(followOn({}), MONTH);
    expect(levels.map((level) => level.scope)).toEqual(budgetScopesFor({ kind: "member", developerId: PERSON }, { project: "payments" }, { agentId: ROVARA_CODE_AGENT_ID }).map((scope: BudgetScope) => scopeKey(scope)));
  });

  it("a project-paid task: follow-on spend counts against the project only, even after the project stops paying", async () => {
    const db = dbWith(true);
    const sources = await started(db);
    expect(await kinds(sources, followOn({}))).toEqual(["org", "project"]);
    db.set({ ...projectAiKey(ORG, "payments"), entityType: "PROJECT_AI", projectPays: false, revision: 2 });
    expect(await kinds(sources, followOn({}))).toEqual(["org", "project"]);
  });

  it("the machine of a workspace is the workspace's task's: its payer, by the pointer", async () => {
    const sources = await started(dbWith(false));
    expect(await kinds(sources, followOn({ action: "machine.start", subject: { type: "workspace", id: WORKSPACE } }))).toEqual(["org", "project", "member"]);
  });

  it("a task with no captured payer, another company's, or a subject that is neither a task nor a workspace fails, never the project by default", async () => {
    const db = dbWith(false);
    const sources = cloudLevelSources(depsOf(db));
    await expect(cloudAdmissionLevels(sources)(followOn({}), MONTH)).rejects.toThrow(/no payer recorded/);
    await started(db);
    await expect(cloudAdmissionLevels(sources)({ ...followOn({}), companyId: "org_s3other000000000000z" }, MONTH)).rejects.toThrow(/no payer recorded/);
    await expect(cloudAdmissionLevels(sources)(followOn({ subject: { type: "run", id: TASK } }), MONTH)).rejects.toThrow(/no payer recorded/);
  });

  it("the capture holds the project's AI settings as read: a change between the read and the commit stops the start (absent where there were none)", async () => {
    const absent = dbWith(undefined);
    const items = await cloudLevelSources(depsOf(absent)).capture!(startOf());
    const check = items.find((item) => item.kind === "check")!;
    expect(JSON.stringify((check as { condition: unknown }).condition)).toContain("notExists");
    const present = dbWith(false);
    const heldAt = await cloudLevelSources(depsOf(present)).capture!(startOf());
    expect(JSON.stringify((heldAt.find((item) => item.kind === "check") as { condition: unknown }).condition)).toContain("revision");
  });

  it("only a start by a person captures (no row for a follow-on request)", async () => {
    const db = dbWith(false);
    expect(await cloudLevelSources(depsOf(db)).capture!(followOn({}))).toEqual([]);
  });
});

describe("a company enrolled in per-task spending stops is known by what v2's capture reads (H-1: the bootstrap's rows are not enrollment)", () => {
  const policyRow = (state: unknown, extra: Record<string, unknown> = {}) => ({ ...orgSettingsKey(ORG, "TASK_STOP_POLICY"), entityType: "ORG_TASK_STOP_POLICY", orgId: ORG, revision: 1, enrollment: { version: 1, state }, ...extra });
  const receipt = (sk: string, extra: Record<string, unknown> = {}) => ({ pk: orgScoped(ORG, "TASK_STOP_SEED"), sk, entityType: "TASK_STOP_SEED", orgId: ORG, version: 1, source: sk === "V1#bootstrap" ? "bootstrap" : "upgrade", outcome: "created", policyRevision: 1, ...extra });
  const over = (...rows: Record<string, unknown>[]) => { const db = new FakeDynamoDb(); for (const row of rows) db.set(row); return { documentClient: db, tableName: "state" } as never; };
  const enrolled = async (...rows: Record<string, unknown>[]) => await taskStopEnrolled(over(...rows), ORG);

  it("not enrolled: no policy row and no receipt (a company the bootstrap never reached)", async () => {
    expect(await enrolled()).toBe(false);
    expect(await taskStopEnrolled(over(policyRow("enabled")), "org_s3other000000000000z")).toBe(false);
  });

  it("not enrolled: what the bootstrap writes for EVERY company (a policy row with state disabled, and a seed receipt), and a company ready to enrol", async () => {
    expect(await enrolled(policyRow("disabled"), receipt("V1#bootstrap"))).toBe(false);
    expect(await enrolled(policyRow("disabled"), receipt("V1#bootstrap"), receipt("V1#upgrade", { outcome: "preserved" }))).toBe(false);
    expect(await enrolled(policyRow("ready"), receipt("V1#bootstrap"))).toBe(false);
    expect(await enrolled(policyRow("disabled"))).toBe(false);
  });

  it("enrolled (stays on Cloud): state enabled", async () => {
    expect(await enrolled(policyRow("enabled"), receipt("V1#bootstrap"))).toBe(true);
  });

  it("stays on Cloud for anything Cloud's capture would not read as disabled: a receipt with no policy row, malformed rows, an unknown state", async () => {
    expect(await enrolled(receipt("V1#bootstrap"))).toBe(true);
    expect(await enrolled(receipt("V1#upgrade"))).toBe(true);
    expect(await enrolled(policyRow("disabled"), receipt("V1#bootstrap", { version: 2 }))).toBe(true);
    expect(await enrolled(policyRow("disabled"), receipt("V1#bootstrap", { outcome: "failed" }))).toBe(true);
    expect(await enrolled(policyRow("disabled"), receipt("V1#bootstrap", { source: "upgrade" }))).toBe(true);
    expect(await enrolled(policyRow("disabled"), receipt("V1#bootstrap", { policyRevision: 0 }))).toBe(true);
    expect(await enrolled(policyRow("paused"), receipt("V1#bootstrap"))).toBe(true);
    expect(await enrolled(policyRow(undefined, { enrollment: undefined }), receipt("V1#bootstrap"))).toBe(true);
    expect(await enrolled(policyRow("disabled", { revision: "1" }), receipt("V1#bootstrap"))).toBe(true);
    expect(await enrolled(policyRow("disabled", { entityType: "SOMETHING" }), receipt("V1#bootstrap"))).toBe(true);
    expect(await enrolled(policyRow("disabled", { ceilingMicrousd: 5 }), receipt("V1#bootstrap"))).toBe(true);
    expect(await enrolled(policyRow("disabled", { enrollment: { version: 2, state: "disabled" } }), receipt("V1#bootstrap"))).toBe(true);
  });

  it("M-3: the read carries the fence the core start commits under: the policy absent, or at the revision read, and each absent receipt", async () => {
    const none = await readTaskStop(over(), ORG);
    expect(none.fence.map((item) => item.key.sk)).toEqual(["TASK_STOP_POLICY", "V1#bootstrap", "V1#upgrade"]);
    const seeded = await readTaskStop(over(policyRow("disabled", { revision: 7 }), receipt("V1#bootstrap")), ORG);
    expect(seeded.enrolled).toBe(false);
    expect(seeded.fence).toHaveLength(2);
    expect(JSON.stringify(seeded.fence[0]!.condition)).toContain("7");
  });
});
