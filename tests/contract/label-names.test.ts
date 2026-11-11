// Plan 3 Task 14b (R3-3): a label id in an agent's call is turned into the label's name by the connector's own label list, read by the broker, so the
// trigger-label rule sees the name. An id that can't be resolved is `undefined`, which the caller treats as consequential. The model never supplies the mapping.
import { describe, expect, it, vi } from "vitest";
import { commentSignal, type OrgId } from "@rovara-code/contracts";
import { githubLabelLister, resolveLabelNames, type LabelConnector, type LabelLister } from "../../packages/broker/src/agents/label-names.js";
import { memoryRunCache, taskRunCache, type RunCache } from "../../packages/broker/src/agents/run-cache.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const GITHUB: LabelConnector = { type: "github", id: "con_github", repository: "example/demo" };
const LINEAR: LabelConnector = { type: "linear", id: "con_linear" };

const lister = (labels: Record<string, string>): LabelLister & ReturnType<typeof vi.fn> => vi.fn(async () => new Map(Object.entries(labels)));

/** One cache per (org, task), the way the table's run cache is: a task's calls share one, another task's do not. */
function caches() {
  const held = new Map<string, RunCache>();
  return (scope: { orgId: OrgId; taskId: string }) => {
    const key = `${scope.orgId}|${scope.taskId}`;
    if (!held.has(key)) held.set(key, memoryRunCache());
    return held.get(key)!;
  };
}

describe("resolveLabelNames", () => {
  it("maps each id to its name through the connector's own list", async () => {
    const github = lister({ "101": "bug", "102": "automerge", LA_103: "Deploy-prod" });
    const names = await resolveLabelNames({ labelListers: { github }, runCache: caches() }, { orgId: TEST_ORG, taskId: "t1", connector: GITHUB, ids: ["101", "102", "LA_103"] });
    expect([...names]).toEqual([["101", "bug"], ["102", "automerge"], ["LA_103", "Deploy-prod"]]);
    expect(github).toHaveBeenCalledWith({ orgId: TEST_ORG, connector: GITHUB });
  });

  it("leaves an id the list doesn't know undefined, and never takes a name from the call", async () => {
    const names = await resolveLabelNames({ labelListers: { github: lister({ "101": "bug" }) }, runCache: caches() }, { orgId: TEST_ORG, taskId: "t1", connector: GITHUB, ids: ["101", "999", "automerge", "", "__proto__", "constructor", "toString"] });
    expect(names.get("101")).toBe("bug");
    for (const id of ["999", "automerge", "", "__proto__", "constructor", "toString"]) expect(names.get(id), id).toBeUndefined();
    expect(names.size).toBe(7);
  });

  it("leaves every id undefined when the lookup fails, and tries again on the next call", async () => {
    let attempts = 0;
    const flaky: LabelLister = async () => { attempts += 1; if (attempts === 1) throw new Error("GitHub is down"); return new Map([["101", "bug"]]); };
    const deps = { labelListers: { github: flaky }, runCache: caches() };
    const input = { orgId: TEST_ORG, taskId: "t1", connector: GITHUB, ids: ["101"] };
    expect((await resolveLabelNames(deps, input)).get("101")).toBeUndefined();
    expect((await resolveLabelNames(deps, input)).get("101")).toBe("bug");
    expect(attempts).toBe(2);
  });

  it("leaves every id undefined for a connector type with no label list, without reading anything", async () => {
    const github = lister({ "101": "bug" });
    const names = await resolveLabelNames({ labelListers: { github }, runCache: caches() }, { orgId: TEST_ORG, taskId: "t1", connector: LINEAR, ids: ["101"] });
    expect(names.get("101")).toBeUndefined();
    expect(github).not.toHaveBeenCalled();
    // A type named like an inherited property is no type either.
    const odd = await resolveLabelNames({ labelListers: {}, runCache: caches() }, { orgId: TEST_ORG, taskId: "t1", connector: { type: "constructor", id: "x" }, ids: ["101"] });
    expect(odd.get("101")).toBeUndefined();
  });

  it("reads the list once per run, and again for the next run", async () => {
    const github = lister({ "101": "bug" });
    const deps = { labelListers: { github }, runCache: caches() };
    for (let call = 0; call < 3; call += 1) await resolveLabelNames(deps, { orgId: TEST_ORG, taskId: "t1", connector: GITHUB, ids: ["101"] });
    expect(github).toHaveBeenCalledTimes(1);
    await resolveLabelNames(deps, { orgId: TEST_ORG, taskId: "t2", connector: GITHUB, ids: ["101"] });
    expect(github).toHaveBeenCalledTimes(2);
    // Another org's run with the same task id shares nothing.
    await resolveLabelNames(deps, { orgId: ORG_B, taskId: "t1", connector: GITHUB, ids: ["101"] });
    expect(github).toHaveBeenCalledTimes(3);
  });

  it("keeps each connector's list apart: the same id in two repositories or two connectors names two labels", async () => {
    const github = vi.fn(async ({ connector }: { connector: LabelConnector }) => new Map([["1", connector.repository === "example/demo" ? "bug" : "automerge"]]));
    const deps = { labelListers: { github, linear: lister({ "1": "Triage" }) }, runCache: caches() };
    const ask = (connector: LabelConnector) => resolveLabelNames(deps, { orgId: TEST_ORG, taskId: "t1", connector, ids: ["1"] }).then((names) => names.get("1"));
    expect(await ask(GITHUB)).toBe("bug");
    expect(await ask({ ...GITHUB, repository: "example/other" })).toBe("automerge");
    expect(await ask({ ...GITHUB, id: "con_other" })).toBe("bug");
    expect(await ask(LINEAR)).toBe("Triage");
    expect(await ask(GITHUB)).toBe("bug");
  });

  it("keeps the list in the table under the org and the task when given the table's cache", async () => {
    const db = new FakeDynamoDb();
    const github = lister({ "101": "bug" });
    const deps = { labelListers: { github }, runCache: (scope: { orgId: OrgId; taskId: string }) => taskRunCache({ documentClient: db, tableName: "state", now: Date.now }, scope) };
    await resolveLabelNames(deps, { orgId: TEST_ORG, taskId: "t1", connector: GITHUB, ids: ["101"] });
    await resolveLabelNames(deps, { orgId: TEST_ORG, taskId: "t1", connector: GITHUB, ids: ["101"] });
    expect(github).toHaveBeenCalledTimes(1);
    expect(db.find((item) => item.entityType === "RUN_CACHE")).toMatchObject([{ pk: `ORG#${TEST_ORG}#RUN_CACHE#t1`, orgId: TEST_ORG, taskId: "t1" }]);
    // A kept value that is not a table of names is read again, not trusted.
    const [item] = db.find((candidate) => candidate.entityType === "RUN_CACHE");
    db.set({ ...item!, value: { "101": 7 } });
    expect((await resolveLabelNames(deps, { orgId: TEST_ORG, taskId: "t1", connector: GITHUB, ids: ["101"] })).get("101")).toBe("bug");
    expect(github).toHaveBeenCalledTimes(2);
  });

  it("answers an empty list of ids without reading anything", async () => {
    const github = lister({});
    expect((await resolveLabelNames({ labelListers: { github }, runCache: caches() }, { orgId: TEST_ORG, taskId: "t1", connector: GITHUB, ids: [] })).size).toBe(0);
    expect(github).not.toHaveBeenCalled();
  });

  it("looks at no more than 200 ids, and none longer than 256 characters", async () => {
    const labels: Record<string, string> = Object.fromEntries([...Array.from({ length: 300 }, (_, index): [string, string] => [String(index), `l${String(index)}`]), ["x".repeat(257), "long"] as [string, string]]);
    const ids = [...Array.from({ length: 300 }, (_, index) => String(index)), "x".repeat(257)];
    const names = await resolveLabelNames({ labelListers: { github: lister(labels) }, runCache: caches() }, { orgId: TEST_ORG, taskId: "t1", connector: GITHUB, ids });
    expect(names.get("0")).toBe("l0");
    expect(names.get("199")).toBe("l199");
    expect(names.get("200")).toBeUndefined();
    expect(names.get("x".repeat(257))).toBeUndefined();
  });

  it("gives the trigger-label rule the names: a label that is a merge trigger by name is consequential, one that isn't is not, and an unresolved id is", async () => {
    const names = await resolveLabelNames({ labelListers: { github: lister({ "1": "bug", "2": "automerge", "3": "Deploy-prod" }) }, runCache: caches() }, { orgId: TEST_ORG, taskId: "t1", connector: GITHUB, ids: ["1", "2", "3", "4"] });
    const signal = (id: string) => commentSignal({ labels: [names.get(id) ?? "unresolved label id"] }, { allowMentions: false, labelPaths: ["labels"] });
    expect(signal("1").consequential).toBe(false);
    expect(signal("2").consequential).toBe(true);
    expect(signal("3").consequential).toBe(true);
    // A caller treats an id with no name as consequential itself; the rule is on names.
    expect(names.get("4")).toBeUndefined();
  });
});

describe("githubLabelLister", () => {
  it("lists the repository's labels for the org under both of the ids GitHub uses for each", async () => {
    const listAgentRepositoryLabels = vi.fn(async () => [{ id: 101, nodeId: "LA_kw101", name: "bug" }, { id: 102, nodeId: "LA_kw102", name: "automerge" }]);
    const table = await githubLabelLister({ listAgentRepositoryLabels })({ orgId: TEST_ORG, connector: GITHUB });
    expect(Object.fromEntries(table)).toEqual({ "101": "bug", LA_kw101: "bug", "102": "automerge", LA_kw102: "automerge" });
    expect(listAgentRepositoryLabels).toHaveBeenCalledWith("https://github.com/example/demo.git", { orgId: TEST_ORG });
  });

  it("needs the connector's repository, and lets a failed read through for the caller to treat as unresolved", async () => {
    const provider = { listAgentRepositoryLabels: vi.fn(async () => { throw new Error("down"); }) };
    await expect(githubLabelLister(provider)({ orgId: TEST_ORG, connector: { type: "github", id: "c" } })).rejects.toThrow("repository");
    await expect(githubLabelLister(provider)({ orgId: TEST_ORG, connector: GITHUB })).rejects.toThrow("down");
    const names = await resolveLabelNames({ labelListers: { github: githubLabelLister(provider) }, runCache: caches() }, { orgId: TEST_ORG, taskId: "t1", connector: GITHUB, ids: ["101"] });
    expect(names.get("101")).toBeUndefined();
  });
});
