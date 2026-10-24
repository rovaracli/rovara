// Plan 5 Task 12a: one effective owner. A task's owner decides whose authority, approvals and budget its work uses, so there is ONE function that says who
// that is (`effectiveTaskOwner`): the creator, or the person who took the task over (`currentOwner`, which Task 12b writes). Read live, and fail closed: a
// `currentOwner` that is present but unreadable makes nobody the owner (never the creator, who handed the task over). Tasks stored before this still read.
// This file holds the function itself and the session reads that now use it; the other places that carry authority are in the sibling
// `agent-session-effective-owner-*.test.ts` files, and `task-owner-reads.test.ts` guards that no read of an owner goes around it.
import { describe, expect, it } from "vitest";
import {
  TASK_OWNER_UNREADABLE_MESSAGE,
  effectiveTaskOwner,
  ownerActorIdOf,
  ownerFenceOf,
  ownerNameOfActor,
  taskOwnerKey,
  tryEffectiveTaskOwner,
  type DeveloperTaskRecord,
} from "../../packages/broker/src/developer/task-records.js";

const hex = (digit: string) => digit.repeat(64);
const PRIYA = hex("a");
const MAX = hex("d");
const TASK_ID = "11111111-1111-4111-8111-111111111111";
const SINCE = "2026-10-22T10:00:00.000Z";

/** A task as the start writes it (Priya's), before any take-over: no `currentOwner`. */
function task(extra: Record<string, unknown> = {}): DeveloperTaskRecord {
  return {
    pk: `DEVTASK#${TASK_ID}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK_ID, developerId: PRIYA, provider: "slack", developerName: "Priya", slackUserId: "U0PRIYA001",
    ownerKey: taskOwnerKey(PRIYA, TASK_ID), project: "web", ...extra,
  } as unknown as DeveloperTaskRecord;
}
const taken = (extra: Record<string, unknown> = {}) => task({ currentOwner: { developerId: MAX, name: "Max", provider: "oidc", since: SINCE, ...extra } });

describe("the one function that says who owns a task", () => {
  it("is the creator for a task nobody took over, and the owner actor id is the task's own owner key", () => {
    expect(effectiveTaskOwner(task())).toEqual({ developerId: PRIYA, name: "Priya", provider: "slack", slackUserId: "U0PRIYA001" });
    expect(ownerActorIdOf(task())).toBe(task().ownerKey);
    expect(effectiveTaskOwner(task({ slackUserId: undefined }))).toEqual({ developerId: PRIYA, name: "Priya", provider: "slack" });
  });

  it("is the taker once the task was taken over, with their own name, sign-in method and Slack id, and never the creator's", () => {
    expect(effectiveTaskOwner(taken())).toEqual({ developerId: MAX, name: "Max", provider: "oidc" });
    expect(effectiveTaskOwner(taken({ slackUserId: "U0MAX00001" }))).toEqual({ developerId: MAX, name: "Max", provider: "oidc", slackUserId: "U0MAX00001" });
    expect(ownerActorIdOf(taken())).toBe(taskOwnerKey(MAX, TASK_ID));
    expect(ownerActorIdOf(taken())).not.toBe(taken().ownerKey);
  });

  it("leaves the task's principal alone: the task's own owner key is still the creator's", () => {
    expect(taken().ownerKey).toBe(taskOwnerKey(PRIYA, TASK_ID));
  });

  it("names an actor as an earlier decision shows them: the creator's actor id as the creator, the taker's as the taker, anyone else as nobody", () => {
    expect(ownerNameOfActor(taken(), taskOwnerKey(PRIYA, TASK_ID))).toBe("Priya");
    expect(ownerNameOfActor(taken(), taskOwnerKey(MAX, TASK_ID))).toBe("Max");
    expect(ownerNameOfActor(taken(), taskOwnerKey(hex("e"), TASK_ID))).toBeUndefined();
    expect(ownerNameOfActor(task(), taskOwnerKey(PRIYA, TASK_ID))).toBe("Priya");
    expect(ownerNameOfActor(task(), taskOwnerKey(MAX, TASK_ID))).toBeUndefined();
    // An unreadable taker names the creator's actor (history) and no one else.
    expect(ownerNameOfActor(task({ currentOwner: { developerId: "" } }), taskOwnerKey(PRIYA, TASK_ID))).toBe("Priya");
    expect(ownerNameOfActor(task({ currentOwner: { developerId: "" } }), taskOwnerKey(MAX, TASK_ID))).toBeUndefined();
  });

  it.each([
    ["an empty developer id", { developerId: "" }],
    ["a blank developer id", { developerId: "   " }],
    ["a developer id that is not a string", { developerId: 7 }],
    ["no name", { name: undefined }],
    ["a name that is not a string", { name: 3 }],
    ["a sign-in method nobody knows", { provider: "carrier-pigeon" }],
    ["no sign-in method", { provider: undefined }],
    ["no time", { since: undefined }],
    ["a time that is not a date", { since: "yesterday-ish" }],
    ["a Slack id that is not a string", { slackUserId: 12 }],
    ["an empty Slack id", { slackUserId: "" }],
  ])("fails closed on a taker with %s: nobody owns the task, and it is never the creator", (_name, change) => {
    const bad = taken(change as Record<string, unknown>);
    expect(() => effectiveTaskOwner(bad)).toThrow(expect.objectContaining({ code: "TASK_ACCESS_DENIED", message: expect.stringContaining(TASK_OWNER_UNREADABLE_MESSAGE) }));
    expect(() => ownerActorIdOf(bad)).toThrow(expect.objectContaining({ code: "TASK_ACCESS_DENIED" }));
    expect(() => ownerFenceOf(bad)).toThrow(expect.objectContaining({ code: "TASK_ACCESS_DENIED" }));
    expect(tryEffectiveTaskOwner(bad)).toBeUndefined();
  });

  it.each([null, "Max", 5, [], [MAX], true])("fails closed on a `currentOwner` that is %j, not a taker", (value) => {
    const bad = task({ currentOwner: value });
    expect(() => effectiveTaskOwner(bad)).toThrow(expect.objectContaining({ code: "TASK_ACCESS_DENIED" }));
    expect(tryEffectiveTaskOwner(bad)).toBeUndefined();
  });

  it("fails closed on a task with no creator, and `tryEffectiveTaskOwner` answers the owner when there is one", () => {
    expect(() => effectiveTaskOwner(task({ developerId: "" }))).toThrow(expect.objectContaining({ code: "TASK_ACCESS_DENIED" }));
    expect(() => effectiveTaskOwner(task({ developerName: undefined }))).toThrow(expect.objectContaining({ code: "TASK_ACCESS_DENIED" }));
    expect(tryEffectiveTaskOwner(taken())).toEqual({ developerId: MAX, name: "Max", provider: "oidc" });
    expect(tryEffectiveTaskOwner(task())?.developerId).toBe(PRIYA);
  });

  it("reads a task as it was stored before take-overs existed (no `currentOwner`, including an explicit undefined) exactly as the creator's", () => {
    const stored = JSON.parse(JSON.stringify(task())) as DeveloperTaskRecord;
    expect(Object.hasOwn(stored, "currentOwner")).toBe(false);
    expect(effectiveTaskOwner(stored).developerId).toBe(PRIYA);
    expect(effectiveTaskOwner(task({ currentOwner: undefined })).developerId).toBe(PRIYA);
  });

  it("fences a write on the owner it was decided for: no taker for an untaken task, else the taker and the time they took it", () => {
    expect(ownerFenceOf(task())).toEqual({ expression: "attribute_not_exists(#ownerFence)", names: { "#ownerFence": "currentOwner" }, values: {} });
    expect(ownerFenceOf(taken())).toEqual({
      expression: "#ownerFence.#ownerFenceId = :ownerFenceId AND #ownerFence.#ownerFenceSince = :ownerFenceSince",
      names: { "#ownerFence": "currentOwner", "#ownerFenceId": "developerId", "#ownerFenceSince": "since" },
      values: { ":ownerFenceId": MAX, ":ownerFenceSince": SINCE },
    });
  });
});
