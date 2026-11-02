// Stdio fixes lane, review M9: the prewarm of package-run servers has a caller. When an operation is built for a stage that has registered-server sources, the broker asks the host to start
// those servers (fire and forget), so the first tool call does not wait for a cold start.
import { describe, expect, it } from "vitest";
import { prewarmStageServers } from "../../../packages/broker/src/context-sources/prewarm-stage.js";
import { dynamoContextSourceStore } from "../../../packages/broker/src/context-sources/store.js";
import { confirmSourceChange, proposeSourceChange } from "../../../packages/broker/src/context-sources/settings.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { NOW, ORG, environment, source } from "./fixtures.js";

type Stage = "UNDERSTAND" | "PLAN" | "PLAN_CRITIQUE" | "REVIEW";
async function project(sources: Array<{ id: string; server: { kind: "connection"; connectionId: string } | { kind: "registered_server"; serverId: string }; stages: Stage[] }>) {
  const table = new FakeDynamoDb();
  const store = dynamoContextSourceStore({ documentClient: table, tableName: "state", now: () => NOW });
  const deps = { store, env: environment(), now: () => NOW };
  const actor = { orgId: ORG, developerId: "dev1", orgRole: "admin" };
  for (const item of sources) {
    const change = await proposeSourceChange(deps, actor, "proj", { kind: "set", source: source({ sourceId: item.id, label: `Source ${item.id}`, server: item.server as never, stages: item.stages }) });
    await confirmSourceChange(deps, actor, "proj", change.changeId);
  }
  const asked: Array<{ orgId: string; serverIds: readonly string[] }> = [];
  const prewarm = async (orgId: string, serverIds: readonly string[]): Promise<number> => { asked.push({ orgId, serverIds }); return serverIds.length; };
  return { asked, deps: { documentClient: table, tableName: "state", now: () => NOW, prewarm: prewarm as never } };
}
const registered = (serverId: string) => ({ kind: "registered_server" as const, serverId });

describe("review M9: prewarming the package-run servers of a stage", () => {
  it("asks the host to start the registered servers a stage reads, once each, and not the hosted connections", async () => {
    const w = await project([
      { id: "wiki", server: registered("mcpwiki000001"), stages: ["PLAN", "REVIEW"] },
      { id: "sim", server: registered("mcpsim0000001"), stages: ["PLAN"] },
      { id: "dup", server: registered("mcpwiki000001"), stages: ["PLAN"] },
      { id: "hosted", server: { kind: "connection", connectionId: "con_aaaaaaaaaaaaaaaaaaaa" }, stages: ["PLAN"] },
    ]);
    expect(await prewarmStageServers(w.deps, ORG, "proj", "PLAN")).toBe(2);
    expect(w.asked).toHaveLength(1);
    expect(w.asked[0]!.orgId).toBe(ORG);
    expect([...w.asked[0]!.serverIds].sort()).toEqual(["mcpsim0000001", "mcpwiki000001"]);
  });
  it("starts only the servers of the stage that is starting, in the stages that may read sources, never in Build or any other mode", async () => {
    const w = await project([{ id: "wiki", server: registered("mcpwiki000001"), stages: ["REVIEW"] }]);
    expect(await prewarmStageServers(w.deps, ORG, "proj", "PLAN")).toBe(0);
    expect(await prewarmStageServers(w.deps, ORG, "other-project", "REVIEW")).toBe(0);
    for (const mode of ["IMPLEMENT", "CHECKS", "FEEDBACK_REVIEW", "SETUP_DRAFT", undefined, 7]) expect(await prewarmStageServers(w.deps, ORG, "proj", mode), String(mode)).toBe(0);
    expect(w.asked).toEqual([]);
    expect(await prewarmStageServers(w.deps, ORG, "proj", "REVIEW")).toBe(1);
  });
  it("does nothing where the install runs no package-run servers (no prewarm given), and never throws or waits on a failure", async () => {
    const w = await project([{ id: "wiki", server: registered("mcpwiki000001"), stages: ["PLAN"] }]);
    const { prewarm: _none, ...without } = w.deps; // eslint-disable-line @typescript-eslint/no-unused-vars -- the install gives none
    expect(await prewarmStageServers(without, ORG, "proj", "PLAN")).toBe(0);
    expect(await prewarmStageServers({ ...w.deps, prewarm: async () => { throw new Error("host down"); } }, ORG, "proj", "PLAN")).toBe(0);
    const broken = { documentClient: { send: async () => { throw new Error("table down"); } }, tableName: "state", now: () => NOW, prewarm: w.deps.prewarm };
    expect(await prewarmStageServers(broken, ORG, "proj", "PLAN")).toBe(0);
    expect(w.asked).toEqual([]);
  });
  it("asks for every server of a project at the 16-source limit, and no more than 16", async () => {
    const many = Array.from({ length: 16 }, (_, index) => ({ id: `sa${String.fromCharCode(97 + index)}`, server: registered(`mcpserver${String(index).padStart(4, "0")}`), stages: ["PLAN" as const] }));
    const w = await project(many);
    expect(await prewarmStageServers(w.deps, ORG, "proj", "PLAN")).toBe(16);
    expect(w.asked[0]!.serverIds).toHaveLength(16);
  });
  it("review N3: waits for the host to accept the requests, for a short bound at most, so a function frozen when it returns has sent them", async () => {
    const w = await project([{ id: "wiki", server: registered("mcpwiki000001"), stages: ["PLAN"] }]);
    const finished: string[] = [];
    const slowButSent = { ...w.deps, boundMs: 1_000, prewarm: (async (_org: string, ids: readonly string[]) => { await new Promise((resolve) => setTimeout(resolve, 30)); finished.push(...ids); return ids.length; }) as never };
    expect(await prewarmStageServers(slowButSent, ORG, "proj", "PLAN")).toBe(1);
    expect(finished).toEqual(["mcpwiki000001"]);
    const began = Date.now();
    const never = { ...w.deps, boundMs: 60, prewarm: (() => new Promise<number>(() => undefined)) as never };
    expect(await prewarmStageServers(never, ORG, "proj", "PLAN")).toBe(0);
    const took = Date.now() - began;
    expect(took).toBeGreaterThanOrEqual(50);
    expect(took).toBeLessThan(1_000);
  });
  it("is called, and awaited, where an operation is built for a stage that has sources, and only then (the one line of wiring in the broker's task operations)", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("packages/broker/src/aws/broker/task-operations.ts", "utf8");
    const line = source.split("\n").find((text) => text.includes("prewarmStageServers("));
    expect(line).toBeDefined();
    expect(line).toContain("contextToolsOn");
    expect(line).toContain("dependencies.contextSources?.prewarm");
    expect(line).toContain("await prewarmStageServers(");
    expect(line).not.toContain("void ");
    expect(source.indexOf("prewarmStageServers(")).toBeGreaterThan(source.indexOf("const contextToolsOn = await stageHasContextSources("));
  });
});
