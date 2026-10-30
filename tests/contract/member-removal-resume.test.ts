// Member removal (v1.1), task 2: a removal that stops part-way is finished by the sweep. Each cut-off step is conditional and repeatable, each hand-off moves an item once, the
// successor is read again at every run (the one chosen, then the one they were replaced by, then the remover, then the first owner), and "leave" ends sessions once.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ANA, HOUR, OWNER, PAT, SAM, removalWorld } from "../support/member-removal-world.js";

describe("a removal that stops part-way", () => {
  it("finishes the recorded grants by their ids: a second run deletes what is left and never touches a grant given afterwards", async () => {
    const w = await removalWorld();
    await w.join(SAM, "Sam", "member");
    w.grant(SAM, "payments", "g-1");
    w.grant(SAM, "web", "g-2", "maintainer");
    // The second grant's delete fails once: the request's run stops, the marker stays.
    w.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("g-2") && JSON.stringify(input).includes("web"), error: { name: "InternalServerError" } });
    const removed = await w.remove(SAM);
    expect(w.grantOf(SAM, "payments")).toBeUndefined();
    expect(w.grantOf(SAM, "web")).toBeDefined();
    expect(w.record(removed.removalId)).toMatchObject({ state: "STARTED" });
    // A new grant (a new id) appears after a rejoin; the repeat must not touch it.
    w.tick(HOUR);
    await w.join(SAM, "Sam", "member");
    w.grant(SAM, "billing", "g-new");
    w.tick(HOUR);
    await w.sweep();
    expect(w.grantOf(SAM, "web")).toBeUndefined();
    expect(w.grantOf(SAM, "billing")).toMatchObject({ grantId: "g-new" });
    expect(w.record(removed.removalId)).toMatchObject({ state: "CANCELLED_REJOINED", counts: expect.objectContaining({ grantsRemoved: 1 }) as unknown });
  });

  it("moves an owned item once: a run that stopped after the first item is finished by the next, with one owner_changed each", async () => {
    const w = await removalWorld();
    await w.join(SAM, "Sam", "member");
    const first = await w.memberAgent(SAM, "First");
    const second = await w.memberAgent(SAM, "Second");
    w.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes(second.agentId) && JSON.stringify(input).includes("owner"), error: { name: "InternalServerError" } });
    const removed = await w.remove(SAM);
    expect(w.markers()).toHaveLength(1);
    expect(w.record(removed.removalId)).toMatchObject({ state: "STARTED" });
    w.tick(HOUR);
    await w.sweep();
    for (const agent of [first, second]) {
      expect((await w.store.get(w.orgId, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OWNER });
      expect((await w.store.listEvents(w.orgId, agent.agentId)).filter((event) => event.kind === "owner_changed")).toHaveLength(1);
    }
    expect(w.markers()).toEqual([]);
    expect(w.record(removed.removalId)).toMatchObject({ state: "DONE" });
  });

  it("hands over to the chosen successor, not the first owner", async () => {
    const w = await removalWorld();
    await w.join(ANA, "Ana", "admin");
    await w.join(SAM, "Sam", "member");
    const agent = await w.memberAgent(SAM, "Sam's agent");
    await w.remove(SAM, { successorId: ANA });
    expect((await w.store.get(w.orgId, agent.agentId))!.owner).toEqual({ kind: "member", developerId: ANA });
  });

  it("defaults to the person who removed them", async () => {
    const w = await removalWorld();
    await w.join(ANA, "Ana", "admin");
    await w.join(SAM, "Sam", "member");
    const agent = await w.memberAgent(SAM, "Sam's agent");
    await w.remove(SAM, { by: ANA, callerRole: "admin" });
    expect((await w.store.get(w.orgId, agent.agentId))!.owner).toEqual({ kind: "member", developerId: ANA });
  });

  it("reads the successor again at the run: one removed since follows their own successor (Ana was replaced by the owner)", async () => {
    const w = await removalWorld({ movers: "sweep" });
    await w.join(ANA, "Ana", "admin");
    await w.join(SAM, "Sam", "member");
    const agent = await w.memberAgent(SAM, "Sam's agent");
    await w.remove(SAM, { successorId: ANA });
    // Ana is removed before Sam's movers ran; her own successor is the owner.
    w.tick(1000);
    await w.remove(ANA, { successorId: OWNER });
    w.tick(HOUR);
    await w.sweep();
    expect((await w.store.get(w.orgId, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OWNER });
    expect(w.markers()).toEqual([]);
  });

  it("falls back to the remover, then the first owner, when the chain gives nobody", async () => {
    const w = await removalWorld({ movers: "sweep" });
    await w.join(ANA, "Ana", "admin");
    await w.join(PAT, "Pat", "admin");
    await w.join(SAM, "Sam", "member");
    const agent = await w.memberAgent(SAM, "Sam's agent");
    await w.remove(SAM, { successorId: ANA, by: PAT, callerRole: "admin" });
    // Ana is gone with no tombstone to follow (and no successor of her own recorded), and Pat, who removed Sam, is still there: the remover takes it.
    w.db.delete({ pk: `ORG#${w.orgId}`, sk: `MEMBER#${ANA}` });
    w.tick(HOUR);
    await w.sweep();
    expect((await w.store.get(w.orgId, agent.agentId))!.owner).toEqual({ kind: "member", developerId: PAT });
  });

  it("a rejoin cancels the hand-offs but the cut-off still finishes (S7 is CANCELLED_REJOINED)", async () => {
    const w = await removalWorld({ movers: "sweep" });
    await w.join(SAM, "Sam", "member");
    const agent = await w.memberAgent(SAM, "Sam's agent");
    w.grant(SAM, "payments", "g-1");
    const removed = await w.remove(SAM);
    w.tick(HOUR);
    await w.join(SAM, "Sam", "member");
    await w.sweep();
    expect(w.grantOf(SAM, "payments")).toBeUndefined();
    expect((await w.store.get(w.orgId, agent.agentId))!.owner).toEqual({ kind: "member", developerId: SAM });
    expect(w.record(removed.removalId)).toMatchObject({ state: "CANCELLED_REJOINED" });
    expect(w.logs.map((entry) => entry.event)).toContain("member_removal.handoffs_cancelled");
  });

  it("a marker from before this release (no removal id, no successor) still works: first owner takes over, sessions end at the marker's time", async () => {
    const w = await removalWorld({ movers: "sweep" });
    await w.join(SAM, "Sam", "member");
    const agent = await w.memberAgent(SAM, "Sam's agent");
    const removed = await w.remove(SAM);
    // Make the marker look like the old one.
    const [marker] = w.markers();
    const { removalId: _id, successorId: _successor, removedAt: _at, ...legacy } = marker!;
    w.db.set(legacy);
    w.db.delete({ pk: `ORG#${w.orgId}#MEMBER_REMOVAL`, sk: removed.removalId });
    w.tick(HOUR);
    await w.sweep();
    expect((await w.store.get(w.orgId, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OWNER });
    expect(w.lambda.calls).toEqual([{ developerId: SAM, at: removed.removedAt }]);
    expect(w.markers()).toEqual([]);
  });

  it("'leave' ends sessions once, through the sign-in step", async () => {
    const w = await removalWorld();
    await w.join(SAM, "Sam", "member");
    await w.orgs.removeMember({ orgId: w.orgId, developerId: SAM, emails: [], ban: false, by: { kind: "member", id: SAM }, requestId: randomUUID() });
    expect(w.lambda.calls).toHaveLength(1);
  });
});
