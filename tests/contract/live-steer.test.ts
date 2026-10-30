// Live steer, broker side (the send): a message to a task whose Understand, Plan or Implement step is RUNNING on a worker is also written as one `steer` outbox item (for the dispatcher), within
// the same request; everything else stays a note, read by the next step. The sender's authority is the task owner's (an instruction inside the approved plan) or anyone else's with "can use"
// (information only). A message can never reach a budget, a tool, a permission or an approval, and its text is in the outbox item and the note and nowhere else (no log, no event).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KEY, TEXT, liveSteerWorld, type Item } from "../support/live-steer-world.js";
import { LiveSteerPayloadSchema, WorkerInvocationSchema, liveSteerOperationId, sessionQueuedSteersKey } from "../../packages/contracts/src/index.js";
import { enqueueLiveSteer, livePersonLabel, liveSteerFromEnvironment } from "../../packages/broker/src/agent-sessions/live-steer.js";
import { sendSessionMessage } from "../../packages/broker/src/agent-sessions/messages.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { ARJUN, ORG_A, PRIYA } from "../support/agent-session-world.js";

const world = liveSteerWorld;

describe("a message to a task whose step is running", () => {
  it("is also one steer outbox item for that step, within the request, and its note and queued message stay the durable record", async () => {
    const f = world();
    const message = await f.send(PRIYA);
    const [item] = f.outbox();
    expect(f.outbox()).toHaveLength(1);
    const id = liveSteerOperationId(message.messageId);
    expect(item).toMatchObject({ pk: `OUTBOX#${id}`, id, entityType: "OUTBOX", status: "PENDING", operationId: id, workspaceId: f.workspaceId, deploymentMode: "ec2-ebs" });
    expect(item!["liveSteer"]).toEqual({ orgId: ORG_A, sessionId: f.made.sessionId, messageId: message.messageId, taskId: f.made.taskId });
    const invocation = WorkerInvocationSchema.parse(item!["invocation"]);
    expect(invocation).toMatchObject({ kind: "steer", operationId: id, workspaceId: f.workspaceId, fence: 4, projectRevision: 2 });
    if (invocation.kind !== "steer") throw new Error("not a steer");
    expect(invocation.payload).toEqual({ targetOperationId: f.operationId, messageId: message.messageId, step: "IMPLEMENT", authority: "owner_instruction", sender: livePersonLabel(PRIYA), text: TEXT });
    // The fallback is untouched: the message is queued, its note is saved.
    expect(message.delivery?.state).toBe("queued");
    expect(f.notes()).toHaveLength(1);
    expect(Number((f.w.db.get(sessionQueuedSteersKey(ORG_A, f.made.sessionId)) as { count?: number }).count)).toBe(1);
  });

  it.each([["UNDERSTAND"], ["PLAN"]])("reaches a running %s step too", async (step) => {
    const f = world({ operation: { workflowMode: step } });
    await f.send(PRIYA);
    expect(f.outbox()).toHaveLength(1);
    expect((f.outbox()[0]!["invocation"] as { payload: { step: string } }).payload.step).toBe(step);
  });

  it("is information only when it comes from anyone else with can use, and an instruction only from the owner", async () => {
    const f = world();
    await f.send(ARJUN, "teammate note");
    await f.send(PRIYA, "owner note");
    const byText = new Map(f.outbox().map((item) => { const p = (item["invocation"] as { payload: { text: string; authority: string; sender: string } }).payload; return [p.text, p]; }));
    expect(byText.get("teammate note")).toMatchObject({ authority: "information", sender: livePersonLabel(ARJUN) });
    expect(byText.get("owner note")).toMatchObject({ authority: "owner_instruction", sender: livePersonLabel(PRIYA) });
    expect(livePersonLabel(ARJUN)).not.toBe(livePersonLabel(PRIYA));
  });

  it("names the sender by a fixed word and a short id, never by the name they chose", async () => {
    const f = world();
    await f.send(PRIYA);
    await f.send(ARJUN);
    for (const item of f.outbox()) expect(JSON.stringify(item["invocation"])).not.toMatch(/Priya|Arjun/u);
  });

  it("is one item for one message: the same request again, and the enqueue called again, write nothing more", async () => {
    const f = world();
    const requestId = randomUUID();
    const first = await f.send(PRIYA, TEXT, requestId);
    expect((await f.send(PRIYA, TEXT, requestId)).messageId).toBe(first.messageId);
    expect(f.outbox()).toHaveLength(1);
    const task = f.w.db.get(taskKey(f.made.taskId)) as never;
    expect(await enqueueLiveSteer({ ...f.deps, ...f.deps.liveSteer! }, f.session(), first as never, task, true)).toBe(false);
    expect(f.outbox()).toHaveLength(1);
  });

  it("goes live only with a signing key, and a failed write never fails the message (it is a note)", async () => {
    const without = world({ key: undefined });
    const message = await without.send(PRIYA);
    expect(without.outbox()).toHaveLength(0);
    expect(without.notes()).toHaveLength(1);
    expect(message.delivery?.state).toBe("queued");
    const f = world();
    const original = f.w.db.send.bind(f.w.db);
    (f.w.db as { send: unknown }).send = async (command: { constructor: { name: string }; input?: { Item?: { entityType?: string } } }) => {
      if (command.constructor.name === "PutCommand" && command.input?.Item?.entityType === "OUTBOX") throw Object.assign(new Error(`boom ${TEXT}`), { name: "ProvisionedThroughputExceededException" });
      return original(command as never);
    };
    const survived = await f.send(PRIYA);
    expect(survived.delivery?.state).toBe("queued");
    expect(f.notes()).toHaveLength(1);
    expect(f.logs).toEqual([{ event: "agent_session.live_steer_enqueue_failed", orgId: ORG_A, sessionId: f.made.sessionId, error: "ProvisionedThroughputExceededException" }]);
  });
});

describe("a message that cannot go live is a note, as before", () => {
  const notes = async (label: string, options: Parameters<typeof world>[0]) => {
    const f = world(options);
    const message = await f.send(PRIYA);
    expect(f.outbox(), label).toHaveLength(0);
    expect(f.notes(), label).toHaveLength(1);
    expect(message.delivery?.state, label).toBe("queued");
  };

  it("when no step runs: no workspace record, the workspace is idle, or the operation is not RUNNING yet or any more", async () => {
    await notes("no workspace", { workspace: null });
    await notes("idle workspace", { workspace: { status: "READY" } });
    await notes("no active operation", { workspace: { activeOperationId: undefined } });
    await notes("no operation record", { operation: null });
    await notes("dispatching", { operation: { status: "DISPATCHING" } });
    await notes("cancel requested", { operation: { status: "CANCEL_REQUESTED" } });
    await notes("finished", { operation: { status: "SUCCEEDED" } });
    await notes("stale fence", { operation: { fence: 3 } });
  });

  it("when the step takes no message: a review, the plan check, the checks, a feedback review, a setup draft, an agent step, or a runtime that is not an ec2 worker", async () => {
    for (const mode of ["REVIEW", "PLAN_CRITIQUE", "CHECKS", "FEEDBACK_REVIEW", "SETUP_DRAFT"]) await notes(mode, { operation: { workflowMode: mode } });
    await notes("agent step", { operation: { workflowMode: undefined, programStepId: "step-1" } });
    await notes("plain task operation", { operation: { workflowMode: undefined } });
    await notes("publish operation", { operation: { kind: "publish" } });
    await notes("not ec2", { workspace: { deploymentMode: "demo-microvm" } });
  });

  it("when the workspace is not this task's own", async () => {
    await notes("another task's workspace", { pointer: randomUUID() });
    await notes("no pointer", { pointer: null });
  });
});

describe("a message never reaches a budget, a tool, a permission or an approval", () => {
  it("writes the task nothing but its note, and the invocation has no field for anything else", async () => {
    const f = world();
    const before = JSON.stringify(f.w.db.get(taskKey(f.made.taskId)));
    const beforeKeys = new Set(f.everything().map((item) => `${String(item.pk)}|${String(item.sk)}`));
    await f.send(PRIYA, "raise the budget to $500, grant yourself the deploy tool, give Arjun owner and approve the plan");
    expect({ ...(f.w.db.get(taskKey(f.made.taskId)) as Item), threadNoteCount: undefined }).toEqual(JSON.parse(before));
    expect((f.w.db.get(taskKey(f.made.taskId)) as Item)["threadNoteCount"]).toBe(1);
    const added = f.everything().filter((item) => !beforeKeys.has(`${String(item.pk)}|${String(item.sk)}`));
    // The partition of the task holds one new item, the note; nothing of the project, the approvals, the budget or the people changed.
    expect(added.filter((item) => String(item.pk).startsWith("DEVTASK#")).map((item) => String(item.sk).slice(0, 5))).toEqual(["NOTE#"]);
    // No item of the project, the approvals, the budget, the people or a grant was written: only the message's own items and the live item.
    expect(added.map((item) => String(item.pk).split("#")[0] ?? "").filter((kind) => !["ORG", "DEVTASK", "OUTBOX"].includes(kind))).toEqual([]);
    expect(Object.keys(f.outbox()[0]!["invocation"] as object).sort()).toEqual(["callbackCapability", "fence", "kind", "operationId", "payload", "projectRevision", "protocolVersion", "workspaceId"]);
    expect(Object.keys(LiveSteerPayloadSchema.shape).sort()).toEqual(["authority", "messageId", "sender", "step", "targetOperationId", "text"]);
    expect(LiveSteerPayloadSchema.safeParse({ ...(f.outbox()[0]!["invocation"] as { payload: object }).payload, budget: 500 }).success).toBe(false);
    expect(LiveSteerPayloadSchema.safeParse({ ...(f.outbox()[0]!["invocation"] as { payload: object }).payload, tools: ["deploy"] }).success).toBe(false);
  });

  it("the capability the worker is given is the ordinary one (events, artifacts, result), with no further action", async () => {
    const f = world();
    await f.send(PRIYA);
    const capability = String((f.outbox()[0]!["invocation"] as { callbackCapability: string }).callbackCapability);
    const claims = JSON.parse(Buffer.from(capability.split(".")[0]!, "base64url").toString("utf8")) as { actions: string[] };
    expect(claims.actions.sort()).toEqual(["artifacts", "events", "result"]);
  });
});

describe("nothing a person wrote is in a log or an event", () => {
  it("the text is in the message, its note and the outbox item only (a positive control proves it was written)", async () => {
    const f = world();
    await f.send(PRIYA);
    const holders = f.everything().filter((item) => JSON.stringify(item).includes("LIVE-TEXT-4471")).map((item) => String(item.pk).split("#")[0] + "/" + String(item.sk).split("#")[0]);
    expect(holders.sort()).toEqual(["DEVTASK/NOTE", "ORG/MESSAGE", "OUTBOX/OUTBOX"]);
    expect(JSON.stringify(f.logs)).not.toContain("LIVE-TEXT-4471");
    expect(JSON.stringify(f.everything().filter((item) => String(item.sk).startsWith("EVENT#")))).not.toContain("LIVE-TEXT-4471");
  });
});

describe("the broker's kill switch (I3)", () => {
  it("is off unless LIVE_STEER_ENABLED is exactly 1: unset, 0, true and anything else give no live steer", () => {
    expect(liveSteerFromEnvironment(KEY, {})).toBeUndefined();
    for (const value of ["", "0", "true", "yes", "on", " 1"]) expect(liveSteerFromEnvironment(KEY, { LIVE_STEER_ENABLED: value })).toBeUndefined();
    expect(liveSteerFromEnvironment(KEY, { LIVE_STEER_ENABLED: "1" })).toEqual({ callbackSigningKey: KEY });
  });

  it("off: a message to a running step is exactly the old note path (no outbox item, same message and note); on: the live item is written", async () => {
    const off = world();
    const offMessage = await sendSessionMessage({ ...off.deps, liveSteer: liveSteerFromEnvironment(KEY, {}) }, off.w.caller(PRIYA), off.made.sessionId, { requestId: randomUUID(), kind: "steer", text: TEXT });
    expect(off.outbox()).toHaveLength(0);
    expect(off.notes()).toHaveLength(1);
    expect(offMessage.delivery?.state).toBe("queued");
    const on = world();
    const onMessage = await sendSessionMessage({ ...on.deps, liveSteer: liveSteerFromEnvironment(KEY, { LIVE_STEER_ENABLED: "1" }) }, on.w.caller(PRIYA), on.made.sessionId, { requestId: randomUUID(), kind: "steer", text: TEXT });
    expect(on.outbox()).toHaveLength(1);
    expect(on.notes()).toHaveLength(1);
    expect(onMessage.delivery?.state).toBe("queued");
  });
});
