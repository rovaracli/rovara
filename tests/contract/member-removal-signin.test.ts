// Member removal (v1.1), task 2, review C1: a rejoin before the movers finish must not bring the old access back. The sign-in step always runs, with `at` the removal's own
// time (never "now"), and the grants, devices and limit S0 recorded are cut even when the person has come back; only the hand-offs are cancelled.
import { describe, expect, it } from "vitest";
import { memberRemovalRecordKey } from "@agentx/contracts";
import { onMemberRemoved } from "../../packages/broker/src/agents/lifecycle.js";
import { HOUR, OWNER, SAM, T0, removalWorld } from "../support/member-removal-world.js";

const T0_ISO = new Date(T0).toISOString();

describe("the sign-in step", () => {
  it("rejoin before sweep: pre-removal sessions, grants, devices and limit stay dead, the new membership's stay alive, the hand-offs are cancelled", async () => {
    const w = await removalWorld({ movers: "sweep" });
    await w.join(SAM, "Sam", "member");
    const oldCookie = w.session(SAM, T0 - HOUR);
    const oldToken = w.session(SAM, T0 - HOUR);
    expect(await w.cookieWorks(oldCookie)).toBe(true);
    w.grant(SAM, "payments", "grant-old", "maintainer");
    const oldDevice = w.device(SAM, "old", T0 - HOUR);
    w.setLimit(SAM, 25);
    const agent = await w.memberAgent(SAM, "Sam's agent");

    // T0: removed; the request's movers did nothing, so the marker waits for the sweep.
    const removed = await w.remove(SAM);
    expect(w.markers()).toHaveLength(1);

    // T1: invited again and signed in; given a project.
    w.tick(HOUR);
    await w.join(SAM, "Sam", "member");
    const newCookie = w.session(SAM, w.clock.now);
    const newToken = w.session(SAM, w.clock.now);
    w.grant(SAM, "billing", "grant-new");

    // T2: the sweep.
    w.tick(HOUR);
    w.lambda.calls.length = 0;
    const report = await w.sweep();
    expect(report).toMatchObject({ processed: 1, failed: 0 });

    expect(await w.cookieWorks(oldCookie)).toBe(false);
    expect(await w.tokenWorks(SAM, oldToken)).toBe(false);
    expect(await w.cookieWorks(newCookie)).toBe(true);
    expect(await w.tokenWorks(SAM, newToken)).toBe(true);
    expect(w.grantOf(SAM, "payments")).toBeUndefined();
    expect(w.grantOf(SAM, "billing")).toMatchObject({ grantId: "grant-new" });
    expect(w.db.find((item) => item.entityType === "DEVICE" && item.deviceId === oldDevice)[0]).toMatchObject({ revokedAt: expect.any(String) as string });
    // The limit S0 saw is gone, and nothing was handed over: the agent is still theirs.
    expect((w.db.get({ pk: `ORG#${w.orgId}#SETTINGS`, sk: "BUDGET" }) as { memberOverrides: Record<string, number> }).memberOverrides).toEqual({});
    expect((await w.store.get(w.orgId, agent.agentId))!.owner).toEqual({ kind: "member", developerId: SAM });
    expect(w.lambda.calls).toEqual([{ developerId: SAM, at: T0_ISO }]);
    expect(w.sessionsEndedAt()).toBe(T0_ISO);
    expect(w.record(removed.removalId)).toMatchObject({ state: "CANCELLED_REJOINED" });
    expect(w.markers()).toEqual([]);
    expect(w.audit.recordedBy("member.removal_completed")).toEqual([expect.objectContaining({ facts: expect.objectContaining({ outcome: "cancelled_rejoined", grantsRemoved: 1 }) as unknown })]);
  });

  it("a lambda that fails N times and then answers ends only the sessions from before the removal, and always at the removal's own time", async () => {
    const w = await removalWorld();
    await w.join(SAM, "Sam", "member");
    const before = w.session(SAM, T0 - HOUR);
    w.lambda.failures = 2;
    const removed = await w.remove(SAM);
    // The request's own run failed once; the marker stays.
    expect(w.markers()).toHaveLength(1);
    expect(w.record(removed.removalId)).toMatchObject({ state: "STARTED" });
    w.tick(60_000);
    expect(await w.sweep()).toMatchObject({ failed: 1 });
    w.tick(11 * 60_000);
    expect(await w.sweep()).toMatchObject({ processed: 1, failed: 0 });
    expect(w.lambda.calls).toHaveLength(3);
    for (const call of w.lambda.calls) expect(call).toEqual({ developerId: SAM, at: T0_ISO });
    expect(w.sessionsEndedAt()).toBe(T0_ISO);
    expect(await w.cookieWorks(before)).toBe(false);
    expect(w.record(removed.removalId)).toMatchObject({ state: "DONE" });
    expect(w.markers()).toEqual([]);
  });

  it("does not claim the sessions were ended when no sign-in function is wired", async () => {
    const w = await removalWorld();
    await w.join(SAM, "Sam", "member");
    delete (w.deps as { endDeveloperSessions?: unknown }).endDeveloperSessions;
    const removed = await w.remove(SAM);
    expect(w.record(removed.removalId)).toMatchObject({ state: "DONE", counts: expect.objectContaining({ signInEnded: false }) as unknown });
    expect(w.logs.map((entry) => entry.event)).toContain("member_removal.sign_in_not_wired");
  });

  it("a repeat with the same removal time changes nothing and finishes the removal once", async () => {
    const w = await removalWorld();
    await w.join(SAM, "Sam", "member");
    const removed = await w.remove(SAM);
    const event = { orgId: w.orgId, developerId: SAM, by: OWNER, removalId: removed.removalId, removedAt: removed.removedAt, successorId: OWNER };
    await onMemberRemoved(w.deps, event);
    await onMemberRemoved(w.deps, event);
    expect(w.sessionsEndedAt()).toBe(T0_ISO);
    expect(w.record(removed.removalId)).toMatchObject({ state: "DONE" });
    expect(w.audit.recordedBy("member.removal_completed")).toHaveLength(1);
  });

  it("a later admin 'end sessions' is never pulled back by a retry with the removal's earlier time", async () => {
    const w = await removalWorld({ movers: "sweep" });
    await w.join(SAM, "Sam", "member");
    const removed = await w.remove(SAM);
    const later = new Date(T0 + 3 * HOUR).toISOString();
    expect(await w.signInStore.endSessions(SAM, later)).toBe("ended");
    w.tick(HOUR);
    await w.sweep();
    expect(w.lambda.calls).toEqual([{ developerId: SAM, at: T0_ISO }]);
    expect(w.sessionsEndedAt()).toBe(later);
    expect(w.record(removed.removalId)).toMatchObject({ state: "DONE" });
  });

  it("rejoin after the hand-offs already ran: the removal is DONE and nothing is undone", async () => {
    const w = await removalWorld();
    await w.join(SAM, "Sam", "member");
    const agent = await w.memberAgent(SAM, "Sam's agent");
    w.grant(SAM, "payments", "grant-old");
    const removed = await w.remove(SAM);
    expect(w.record(removed.removalId)).toMatchObject({ state: "DONE" });
    expect((await w.store.get(w.orgId, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OWNER });
    w.tick(HOUR);
    await w.join(SAM, "Sam", "member");
    w.grant(SAM, "billing", "grant-new");
    w.tick(HOUR);
    await w.sweep();
    expect(w.record(removed.removalId)).toMatchObject({ state: "DONE" });
    expect(w.grantOf(SAM, "billing")).toMatchObject({ grantId: "grant-new" });
    expect((await w.store.get(w.orgId, agent.agentId))!.owner).toEqual({ kind: "member", developerId: OWNER });
    expect(w.db.get(memberRemovalRecordKey(w.orgId, removed.removalId))).toBeDefined();
  });
});
