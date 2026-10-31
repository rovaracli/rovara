// Wiring lane B, WA-2/WA-3: the reflector's facts about a finished task are read from the Team record's own rows: each human send-back (who, their standing, their words) and the
// `rovara.reverted_by` person-link row. A row that is not there, was erased, or names someone who is not a member gives no person (nothing measured).
import { describe, expect, it } from "vitest";
import { tableOutcomeRows } from "../../../packages/broker/src/lessons/task-outcome-rows.js";
import { erasePerson } from "../../../packages/broker/src/team-record/erase.js";
import { ORG_A, ORG_B, addSource, githubDraft, world, type World } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";

const AT = "2026-10-30T10:00:00.000Z";
const rovara = (id: string, kind: "rovara.send_back" | "rovara.reverted_by" | "rovara.task", over: Record<string, unknown> = {}) => githubDraft({
  source: "rovara", kind, repo: undefined, scope: "rovara:project/web", sourceRef: { system: "rovara", id, version: "1" }, audience: { kind: "project" }, trust: "member",
  actor: { sourceId: "dev-ann", developerId: "dev-ann", trust: "member" }, text: undefined, links: [], structured: { taskId: "task-1" }, occurredAt: AT, ...over,
} as never);
async function setup(): Promise<World> {
  const w = world();
  await addSource(w, { source: "rovara", scope: "rovara:project/web", retention: "D" });
  return w;
}

describe("send-backs", () => {
  it("returns the person, their standing and their words from the row", async () => {
    const w = await setup();
    await w.sink.put(rovara("task:task-1:sendback:req-1", "rovara.send_back", { text: "use the shared helper", structured: { taskId: "task-1", round: 1, origin: "human" } }));
    const rows = tableOutcomeRows(w.table);
    expect(await rows.sendBack({ workspaceId: ORG_A, project: "web", taskId: "task-1", requestId: "req-1" })).toEqual({
      id: "task:task-1:sendback:req-1", origin: "human", actorDeveloperId: "dev-ann", actorTrust: "member", reasonText: "use the shared helper",
    });
  });
  it("an automatic send-back names nobody; a row that is not there, or is another task's, project's or workspace's, is nothing", async () => {
    const w = await setup();
    await w.sink.put(rovara("task:task-1:sendback:auto-1", "rovara.send_back", { trust: "rovara", actor: undefined, structured: { taskId: "task-1", round: 2, origin: "automatic", code: "CHECKS_FAILED" } }));
    const rows = tableOutcomeRows(w.table);
    expect(await rows.sendBack({ workspaceId: ORG_A, project: "web", taskId: "task-1", requestId: "auto-1" })).toMatchObject({ origin: "automatic" });
    expect((await rows.sendBack({ workspaceId: ORG_A, project: "web", taskId: "task-1", requestId: "auto-1" }))?.actorDeveloperId).toBeUndefined();
    expect(await rows.sendBack({ workspaceId: ORG_A, project: "web", taskId: "task-1", requestId: "missing" })).toBeUndefined();
    expect(await rows.sendBack({ workspaceId: ORG_A, project: "api", taskId: "task-1", requestId: "auto-1" })).toBeUndefined();
    expect(await rows.sendBack({ workspaceId: ORG_B, project: "web", taskId: "task-1", requestId: "auto-1" })).toBeUndefined();
    expect(await rows.sendBack({ workspaceId: ORG_A, project: "web", taskId: "task-2", requestId: "auto-1" })).toBeUndefined();
  });
  it("an erased person's row is gone, and so are their words", async () => {
    const w = await setup();
    await w.sink.put(rovara("task:task-1:sendback:req-1", "rovara.send_back", { text: "use the shared helper", structured: { taskId: "task-1", round: 1, origin: "human" } }));
    await erasePerson(deleteDeps(w).deps, ORG_A, { developerId: "dev-ann" }, "e1");
    expect(await tableOutcomeRows(w.table).sendBack({ workspaceId: ORG_A, project: "web", taskId: "task-1", requestId: "req-1" })).toBeUndefined();
  });
});

describe("the revert's person-link row", () => {
  it("names the reverter, a member only", async () => {
    const w = await setup();
    await w.sink.put(rovara("task:task-1:reverted_by", "rovara.reverted_by", { actor: { sourceId: "dev-rita", developerId: "dev-rita", trust: "member" } }));
    expect(await tableOutcomeRows(w.table).revertedBy({ workspaceId: ORG_A, project: "web", taskId: "task-1" })).toEqual({ actorDeveloperId: "dev-rita" });
    expect(await tableOutcomeRows(w.table).revertedBy({ workspaceId: ORG_A, project: "web", taskId: "task-9" })).toBeUndefined();
    expect(await tableOutcomeRows(w.table).revertedBy({ workspaceId: ORG_B, project: "web", taskId: "task-1" })).toBeUndefined();
  });
  it("an outsider on the row, or an erased reverter, names no one", async () => {
    const w = await setup();
    await w.sink.put(rovara("task:task-1:reverted_by", "rovara.reverted_by", { trust: "outsider", actor: { sourceId: "dev-x", developerId: "dev-x", trust: "outsider" } }));
    expect(await tableOutcomeRows(w.table).revertedBy({ workspaceId: ORG_A, project: "web", taskId: "task-1" })).toEqual({});
    const w2 = await setup();
    await w2.sink.put(rovara("task:task-1:reverted_by", "rovara.reverted_by", { actor: { sourceId: "dev-rita", developerId: "dev-rita", trust: "member" } }));
    await erasePerson(deleteDeps(w2).deps, ORG_A, { developerId: "dev-rita" }, "e2");
    expect(await tableOutcomeRows(w2.table).revertedBy({ workspaceId: ORG_A, project: "web", taskId: "task-1" })).toBeUndefined();
  });
});
