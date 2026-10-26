import { describe, expect, it } from "vitest";
import { PARALLEL_PARTS_MAX, orgPk, type OrgId, type TaskGraphV1, type WorkItemProgressV1 } from "@agentx/contracts";
import { parallelPartsForTask, parallelStartTrees, serialWorkerCanResume, workflowDependenciesAllowed } from "../../packages/broker/src/rovara-code/parallel-parts.js";
import { developerCharge, workspaceLimitsKey } from "../../packages/broker/src/developer/limits.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaaaaaaaa" as OrgId;
const task = { developerId: "dev-1" };

/** A table of counters and one limits setting, read the way the broker reads them. */
function table(input: { member?: number; organization?: number; memberCount?: number; orgCount?: number; fail?: boolean }) {
  const charge = developerCharge({ orgId: ORG, developerId: task.developerId });
  const items = new Map<string, Record<string, unknown>>();
  const keyOf = (key: { pk: string; sk: string }) => `${key.pk}|${key.sk}`;
  if (input.member !== undefined && input.organization !== undefined) items.set(keyOf(workspaceLimitsKey(ORG)), { perPerson: input.member, perOrganization: input.organization });
  if (input.memberCount !== undefined) items.set(keyOf(charge.member), { count: input.memberCount });
  if (input.orgCount !== undefined) items.set(keyOf(charge.organization), { count: input.orgCount });
  return {
    send: async (command: unknown) => {
      if (input.fail === true) throw new Error("table unavailable");
      const key = (command as { input: { Key: { pk: string; sk: string } } }).input.Key;
      return { Item: items.get(keyOf(key)) };
    },
  };
}
const deps = (client: { send(command: unknown): Promise<unknown> }) => ({ documentClient: client, tableName: "t", orgId: ORG, limitDefaults: { member: 3, organization: 20 } });

describe("the number of parts that may run together", () => {
  it("version 1 tasks get no parts setting at all", async () => {
    expect(await parallelPartsForTask(deps(table({})), { ...task, workflow: { definitionVersion: "1.0.0" } })).toBeUndefined();
    expect(await parallelPartsForTask(deps(table({})), task)).toBeUndefined();
  });

  it("a version 2 task gets the plan's cap when the person and the org have room, whatever the room", async () => {
    const roomy = await parallelPartsForTask(deps(table({ member: 50, organization: 1000, memberCount: 1, orgCount: 1 })), { ...task, workflow: { definitionVersion: "1.1.0" } });
    expect(roomy).toEqual({ max: PARALLEL_PARTS_MAX });
  });

  it("is held to the free workspace slots of the person and of the org: the task's own slot, plus what is free", async () => {
    const run = (member: number, organization: number, memberCount: number, orgCount: number) =>
      parallelPartsForTask(deps(table({ member, organization, memberCount, orgCount })), { ...task, workflow: { definitionVersion: "1.1.0" } });
    expect(await run(3, 20, 3, 5)).toEqual({ max: 1 });
    expect(await run(3, 20, 2, 5)).toEqual({ max: 2 });
    expect(await run(5, 6, 2, 5)).toEqual({ max: 2 });
    expect(await run(5, 5, 2, 5)).toEqual({ max: 1 });
    expect(await run(5, 20, 1, 5)).toEqual({ max: 3 });
    // The smaller room decides: the org is nearly full though the person is not.
    expect(await run(5, 7, 1, 6)).toEqual({ max: 2 });
    // Counts above the limits (a limit lowered after tasks were started) leave one part.
    expect(await run(2, 3, 9, 9)).toEqual({ max: 1 });
  });

  it("uses the install's defaults when the org set no limits, and counts nothing as no room used", async () => {
    expect(await parallelPartsForTask(deps(table({})), { ...task, workflow: { definitionVersion: "1.1.0" } })).toEqual({ max: PARALLEL_PARTS_MAX });
    // The task's own slot is counted: with a limit of 1 and one used there is nothing free.
    expect(await parallelPartsForTask({ ...deps(table({ memberCount: 1, orgCount: 1 })), limitDefaults: { member: 1, organization: 1 } }, { ...task, workflow: { definitionVersion: "1.1.0" } })).toEqual({ max: 1 });
    expect(await parallelPartsForTask({ ...deps(table({ memberCount: 1, orgCount: 1 })), limitDefaults: { member: 2, organization: 2 } }, { ...task, workflow: { definitionVersion: "1.1.0" } })).toEqual({ max: 2 });
  });

  it("fails closed to one part when the limits or counts cannot be read", async () => {
    expect(await parallelPartsForTask(deps(table({ fail: true })), { ...task, workflow: { definitionVersion: "1.1.0" } })).toEqual({ max: 1 });
  });

  it("keys every read by the task's org", () => {
    expect(orgPk(ORG)).toBeDefined();
    expect(workspaceLimitsKey(ORG).pk).toContain(ORG);
  });
});

describe("when ordered work is allowed", () => {
  it("a version 2 task always may; a version 1 task only when the install's switch is on", () => {
    expect(workflowDependenciesAllowed({ workflowDependenciesEnabled: false }, { definitionVersion: "1.1.0" })).toBe(true);
    expect(workflowDependenciesAllowed({}, { definitionVersion: "1.1.0" })).toBe(true);
    expect(workflowDependenciesAllowed({ workflowDependenciesEnabled: false }, { definitionVersion: "1.0.0" })).toBe(false);
    expect(workflowDependenciesAllowed({}, undefined)).toBe(false);
    expect(workflowDependenciesAllowed({ workflowDependenciesEnabled: true }, { definitionVersion: "1.0.0" })).toBe(true);
  });
});

describe("the trees a part may start from", () => {
  const t = (digit: string) => digit.repeat(40);
  it("are the tree the run began at and each tree a finished part was merged into, and no other", () => {
    const trees = parallelStartTrees([
      { state: "STARTED", candidateTreeSha: undefined }, { state: "IMPLEMENTED", candidateTreeSha: t("1"), integratedTreeSha: t("2") },
      { state: "FAILED" }, { state: "IMPLEMENTED", candidateTreeSha: t("3"), integratedTreeSha: t("4") }, { state: "UNKNOWN" },
    ], t("0"));
    expect([...trees].sort()).toEqual([t("0"), t("2"), t("4")]);
    expect(trees.has(t("1"))).toBe(false);
    expect(trees.has(t("3"))).toBe(false);
  });

  it("count a part built one after another by the tree it ended on", () => {
    expect([...parallelStartTrees([{ state: "IMPLEMENTED", candidateTreeSha: t("5") }], t("0"))].sort()).toEqual([t("0"), t("5")]);
  });

  it("are only the finished parts' when the run has no first tree", () => {
    expect([...parallelStartTrees([{ state: "IMPLEMENTED", integratedTreeSha: t("2") }], undefined)]).toEqual([t("2")]);
    expect(parallelStartTrees([], undefined).size).toBe(0);
  });
});

describe("whether an older worker can take over a plan's retained progress", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const C = "33333333-3333-4333-8333-333333333333";
  const graph: TaskGraphV1 = { schemaVersion: 1, taskId: "8c330a74-b4c6-4f01-9356-5fe54fc55b19", version: 1, items: [
    { id: A, title: "A", description: "A.", repository: "r", dependsOn: [] }, { id: B, title: "B", description: "B.", repository: "r", dependsOn: [] },
    { id: C, title: "C", description: "C.", repository: "r", dependsOn: [A, B] },
  ] };
  const done = (itemId: string, tree: string, state: WorkItemProgressV1["state"] = "IMPLEMENTED"): WorkItemProgressV1 => ({
    schemaVersion: 1, graphDigest: "d".repeat(64), runId: "8c330a74-b4c6-4f01-9356-5fe54fc55b21", itemId, sequence: 1, state, operationId: "8c330a74-b4c6-4f01-9356-5fe54fc55b20",
    baseTreeSha: "0".repeat(40), ...(state === "IMPLEMENTED" ? { candidateTreeSha: tree, integratedTreeSha: tree } : {}), at: "2026-10-26T12:00:00.000Z", producer: "agentx-worker",
  });
  const t = (digit: string) => digit.repeat(40);

  it("can when nothing was finished", () => {
    expect(serialWorkerCanResume({ graph, resumeProgress: [], resumeTreeSha: undefined })).toBe(true);
    expect(serialWorkerCanResume({ graph })).toBe(true);
    expect(serialWorkerCanResume({ graph, resumeProgress: [done(A, t("1"), "UNKNOWN")] })).toBe(true);
  });

  it("can from a completed prefix of the plan's order that ended on the workspace's tree", () => {
    expect(serialWorkerCanResume({ graph, resumeProgress: [done(A, t("1"))], resumeTreeSha: t("1") })).toBe(true);
    expect(serialWorkerCanResume({ graph, resumeProgress: [done(A, t("1")), done(B, t("2"))], resumeTreeSha: t("2") })).toBe(true);
  });

  it("cannot from a set that is closed under dependencies but is not a prefix (B done, A not)", () => {
    expect(serialWorkerCanResume({ graph, resumeProgress: [done(B, t("2"))], resumeTreeSha: t("2") })).toBe(false);
    expect(serialWorkerCanResume({ graph, resumeProgress: [done(B, t("2")), done(A, t("1"), "FAILED")], resumeTreeSha: t("2") })).toBe(false);
  });

  it("cannot from a prefix whose last item did not end on the tree the workspace holds (the parts were merged after it)", () => {
    expect(serialWorkerCanResume({ graph, resumeProgress: [done(A, t("1")), done(B, t("2"))], resumeTreeSha: t("3") })).toBe(false);
    expect(serialWorkerCanResume({ graph, resumeProgress: [done(A, t("1"))], resumeTreeSha: undefined })).toBe(false);
  });
});
