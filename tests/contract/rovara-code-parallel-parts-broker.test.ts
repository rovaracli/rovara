import { describe, expect, it } from "vitest";
import { PARALLEL_PARTS_MAX, orgPk, type OrgId, type TaskGraphV1, type WorkItemProgressV1 } from "@agentx/contracts";
import { parallelPartsDecision, parallelPartsForTask, parallelStartTrees, serialWorkerCanResume, workflowDependenciesAllowed } from "../../packages/broker/src/rovara-code/parallel-parts.js";
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

  it("counts the room against the charge the task actually holds (task.charge), not the creator's keys", async () => {
    // The creator's own keys are free, but the slot was charged to a payer whose person and org are full: the payer's counters decide.
    const payer = developerCharge({ orgId: ORG, developerId: "payer-9" });
    const items = new Map<string, Record<string, unknown>>();
    const keyOf = (key: { pk: string; sk: string }) => `${key.pk}|${key.sk}`;
    items.set(keyOf(workspaceLimitsKey(ORG)), { perPerson: 3, perOrganization: 20 });
    items.set(keyOf(payer.member), { count: 3 });
    items.set(keyOf(payer.organization), { count: 5 });
    const client = { send: async (command: unknown) => ({ Item: items.get(keyOf((command as { input: { Key: { pk: string; sk: string } } }).input.Key)) }) };
    expect(await parallelPartsForTask(deps(client), { ...task, charge: payer, workflow: { definitionVersion: "1.1.0" } })).toEqual({ max: 1 });
    // Without a stored charge the creator's keys are the fallback, as everywhere else.
    expect(await parallelPartsForTask(deps(client), { ...task, workflow: { definitionVersion: "1.1.0" } })).toEqual({ max: PARALLEL_PARTS_MAX });
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

describe("the timeline line that says why parts run one after another (Bug N)", () => {
  const v2 = { ...task, workflow: { definitionVersion: "1.1.0" } };
  const item = (id: string, dependsOn: string[] = []) => ({ id: `${id.repeat(8)}-${id.repeat(4)}-4${id.repeat(3)}-8${id.repeat(3)}-${id.repeat(12)}`, title: id, description: id, repository: "r", dependsOn });
  const ids = { a: item("a").id, b: item("b").id, c: item("c").id };
  const graph = (...items: ReturnType<typeof item>[]): TaskGraphV1 => ({ schemaVersion: 1, taskId: "8c330a74-b4c6-4f01-9356-5fe54fc55b19", version: 1, items });
  const independent = graph(item("a"), item("b"));
  const note = async (input: Parameters<typeof table>[0], tasks = v2, plan = independent) => (await parallelPartsDecision(deps(table(input)), tasks, plan)).note;

  it("says how many of the person's workspaces are in use when the person's limit allows one part", async () => {
    expect(await note({ member: 3, organization: 20, memberCount: 3, orgCount: 5 })).toBe("Running parts one at a time: 3 of 3 of your workspaces are in use.");
    expect((await parallelPartsDecision(deps(table({ member: 3, organization: 20, memberCount: 3, orgCount: 5 })), v2, independent)).parallel).toEqual({ max: 1 });
  });

  it("names the organization when its limit is the tighter one", async () => {
    expect(await note({ member: 5, organization: 5, memberCount: 2, orgCount: 5 })).toBe("Running parts one at a time: 5 of 5 of your organization's workspaces are in use.");
  });

  it("says up to how many parts run when the room allows some but fewer than the plan could use", async () => {
    const three = graph(item("a"), item("b"), item("c"));
    expect(await note({ member: 5, organization: 20, memberCount: 4, orgCount: 5 }, v2, three)).toBe("Running up to 2 parts at a time: 4 of 5 of your workspaces are in use.");
  });

  it("says nothing when the room covers every part the plan can run together, or the plan has nothing to run together", async () => {
    expect(await note({ member: 50, organization: 1000, memberCount: 1, orgCount: 1 })).toBeUndefined();
    // Two parts and room for two: no line, though the cap is three.
    expect(await note({ member: 5, organization: 20, memberCount: 4, orgCount: 5 })).toBeUndefined();
    const chain = graph(item("a"), item("b", [ids.a]), item("c", [ids.b]));
    expect(await note({ member: 3, organization: 20, memberCount: 3, orgCount: 5 }, v2, chain)).toBeUndefined();
    expect(await note({ member: 3, organization: 20, memberCount: 3, orgCount: 5 }, v2, graph(item("a")))).toBeUndefined();
  });

  it("says nothing for a version 1 task, which never runs parts together", async () => {
    expect(await note({ member: 3, organization: 20, memberCount: 3, orgCount: 5 }, { ...task, workflow: { definitionVersion: "1.0.0" } })).toBeUndefined();
  });

  it("says so when the limits could not be read, and still runs one part", async () => {
    const decision = await parallelPartsDecision(deps(table({ fail: true })), v2, independent);
    expect(decision.parallel).toEqual({ max: 1 });
    expect(decision.note).toBe("Running parts one at a time: AgentX could not read your workspace limits.");
  });
});
