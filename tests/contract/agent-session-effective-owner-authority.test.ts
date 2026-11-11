// Plan 5 Task 12a: every read of a task's owner that carries authority follows the person who took the task over. The creator's own fields, the task's principal
// (`ownerKey`) and its object prefixes never change. These tests take over tasks by writing `currentOwner` directly, as Task 12b will.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { orgMemberKey, orgMetaKey, orgRemovedKey } from "@agentx/cloud-contracts";
import { getTaskDocumentView, loadOwnedTask, ownerIndexRowOf, planWhyEntries, syncIndex } from "../../packages/broker/src/aws/developer-tasks.js";
import { resolveTaskAccess } from "../../packages/broker/src/developer/task-access.js";
import { requireCreatorStillMember } from "../../packages/broker/src/developer/creator-member.js";
import { effectiveTaskOwner, isTaskTakenOver, ownerActorIdOf, ownerDecisionCounts, takenOverSince, taskIndexKey, taskOwnerKey, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { OMAR, PRIYA, SAM, pagePlan, pageTask } from "../support/page-tasks.js";
import { attributionOf } from "../../packages/broker/src/agents/agent-tools-routes.js";
import { TEST_ORG } from "../support/orgs.js";

const SINCE = "2026-10-22T11:00:00.000Z";
const before = "2026-10-22T10:00:00.000Z";
const after = "2026-10-22T12:00:00.000Z";
const refusal = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as Error & { code?: string; owners?: string[] }; }
  throw new Error("expected a refusal");
};
/** Sam takes the page fixture's task over from Priya. */
function taken(fixture: ReturnType<typeof pageTask>, taker = SAM): DeveloperTaskRecord {
  const record = fixture.db.get(`DEVTASK#${fixture.taskId}`, "META") as unknown as DeveloperTaskRecord;
  const next = { ...record, currentOwner: { developerId: taker.developerId, name: taker.name, provider: taker.amr, ...(taker.slackUserId === undefined ? {} : { slackUserId: taker.slackUserId }), since: SINCE } };
  fixture.db.set(next);
  return next;
}

describe("the person who took a task over is its owner on the task page", () => {
  it("gives them the owner role and the decide action, with their own actor id as the owner, and the creator no more than a commenter", async () => {
    const fixture = pageTask();
    taken(fixture);
    const sam = await resolveTaskAccess(fixture.deps, SAM, fixture.taskId, "decide");
    expect(sam).toMatchObject({ role: "owner", ownerActorIds: [taskOwnerKey(SAM.developerId, fixture.taskId)] });
    expect(sam.ownerActorIds).not.toContain(taskOwnerKey(PRIYA.developerId, fixture.taskId));
    expect((await refusal(resolveTaskAccess(fixture.deps, PRIYA, fixture.taskId, "decide"))).code).toBe("TASK_NOT_FOUND");
    expect((await refusal(resolveTaskAccess(fixture.deps, PRIYA, fixture.taskId, "peopleManage"))).code).toBe("TASK_NOT_FOUND");
    await expect(resolveTaskAccess(fixture.deps, PRIYA, fixture.taskId, "comment")).resolves.toMatchObject({ role: "commenter" });
  });

  it("is unchanged for a task nobody took over", async () => {
    const fixture = pageTask();
    const priya = await resolveTaskAccess(fixture.deps, PRIYA, fixture.taskId, "decide");
    expect(priya).toMatchObject({ role: "owner", ownerActorIds: [taskOwnerKey(PRIYA.developerId, fixture.taskId)] });
    expect((await refusal(resolveTaskAccess(fixture.deps, SAM, fixture.taskId, "decide"))).code).toBe("TASK_NOT_FOUND");
  });

  it("fails closed on a current owner it can't read: nobody is the owner, the creator included", async () => {
    const fixture = pageTask();
    const record = fixture.db.get(`DEVTASK#${fixture.taskId}`, "META") as unknown as DeveloperTaskRecord;
    fixture.db.set({ ...record, currentOwner: { developerId: "" } });
    expect((await refusal(resolveTaskAccess(fixture.deps, PRIYA, fixture.taskId, "decide"))).code).toBe("TASK_ACCESS_DENIED");
    expect((await refusal(loadOwnedTask(fixture.deps, PRIYA, fixture.taskId))).code).toBe("TASK_NOT_FOUND");
  });

  it("tells a reader outside the channel to ask the taker, not the creator", async () => {
    const fixture = pageTask();
    taken(fixture);
    const denied = await refusal(resolveTaskAccess(fixture.deps, OMAR, fixture.taskId));
    expect(denied.code).toBe("TASK_ACCESS_DENIED");
    expect(denied.owners).toEqual([SAM.name]);
  });

  it("names the owner a decision was made by: the creator for the creator's actor id, the taker for theirs", async () => {
    const fixture = pageTask();
    const artifact = fixture.addVersion("plan", pagePlan());
    taken(fixture);
    const workflow = fixture.workflow();
    const decide = (who: typeof PRIYA, decision: "APPROVE" | "REQUEST_CHANGES", at: string) => ({
      requestId: randomUUID(), workflowRevision: workflow.revision, decision, actorId: taskOwnerKey(who.developerId, fixture.taskId), actorRole: "TASK_OWNER" as const,
      reason: "Looks right", artifactDigest: artifact.sha256, at,
    });
    fixture.setWorkflow({ ...workflow, decisions: [decide(PRIYA, "REQUEST_CHANGES", before), decide(SAM, "APPROVE", after)] });
    const view = await getTaskDocumentView(fixture.deps, SAM, fixture.taskId);
    const lines = view.history.map((entry) => entry.text);
    expect(lines.some((line) => line.startsWith(`${PRIYA.name} asked for changes to`))).toBe(true);
    expect(lines.some((line) => line.startsWith(`${SAM.name} approved`))).toBe(true);
    expect(lines.some((line) => line.startsWith(`${SAM.name} asked for changes`))).toBe(false);
    expect(view.role).toBe("owner");
  });
});

describe("a task's owner as it is read for its list, its index rows and its why entries", () => {
  it("lists a task for the person who took it over, and no longer for the creator's own owner checks", async () => {
    const fixture = pageTask();
    taken(fixture);
    await expect(loadOwnedTask(fixture.deps, SAM, fixture.taskId)).resolves.toMatchObject({ taskId: fixture.taskId });
    expect((await refusal(loadOwnedTask(fixture.deps, PRIYA, fixture.taskId))).code).toBe("TASK_NOT_FOUND");
    await expect(loadOwnedTask(fixture.deps, { ...SAM, orgId: "org_zzzzzzzzzzzzzzzzzzzz" }, fixture.taskId)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("syncs the creator's index row and the taker's, and only the creator's for a task nobody took over", async () => {
    const fixture = pageTask();
    const plain = fixture.db.get(`DEVTASK#${fixture.taskId}`, "META") as unknown as DeveloperTaskRecord;
    const row = (developerId: string) => taskIndexKey(developerId, plain.createdAt, fixture.taskId);
    const seed = (developerId: string) => fixture.db.set({ ...row(developerId), entityType: "DEVELOPER_TASK_INDEX", taskId: fixture.taskId, orgId: TEST_ORG, status: "RUNNING", updatedAt: plain.createdAt });
    seed(PRIYA.developerId);
    seed(SAM.developerId);
    expect(ownerIndexRowOf(plain)).toBeUndefined();
    await syncIndex(fixture.deps, plain, "SUCCEEDED");
    expect(fixture.db.get(row(PRIYA.developerId).pk, row(PRIYA.developerId).sk)).toMatchObject({ status: "SUCCEEDED" });
    expect(fixture.db.get(row(SAM.developerId).pk, row(SAM.developerId).sk)).toMatchObject({ status: "RUNNING" });
    const task = taken(fixture);
    expect(ownerIndexRowOf(task)).toEqual(row(SAM.developerId));
    await syncIndex(fixture.deps, task, "FAILED");
    expect(fixture.db.get(row(PRIYA.developerId).pk, row(PRIYA.developerId).sk)).toMatchObject({ status: "FAILED" });
    expect(fixture.db.get(row(SAM.developerId).pk, row(SAM.developerId).sk)).toMatchObject({ status: "FAILED" });
  });

  it("quotes the request as the creator's words and a teammate's note as the owner's, which is the taker after a take-over", async () => {
    const fixture = pageTask();
    const record = taken(fixture);
    const withRequest = { ...record, requestText: "Retry failed payments", threadNotesFedThrough: "2026-10-22T10:30:00.000Z" };
    fixture.db.set({ pk: `DEVTASK#${fixture.taskId}`, sk: "NOTE#1695500000.000200", entityType: "WORKFLOW_THREAD_NOTE", schemaVersion: 1, taskId: fixture.taskId, slackUserId: SAM.slackUserId, isOwner: true,
      teamId: "T0PAGE001", channelId: "C0PAGE001", threadTs: "1695500000.000100", messageTs: "1695500000.000200", eventId: "Ev1", text: "Please use the new endpoint", truncated: false, receivedAt: "2026-10-22T10:20:00.000Z", workflowRevision: 1 });
    const entries = await planWhyEntries(fixture.deps, withRequest, []);
    expect(entries[0]).toMatchObject({ text: "Retry failed payments", author: PRIYA.name });
    expect(entries.slice(1).every((entry) => entry.author === SAM.name)).toBe(true);
  });

  // C60 (v0412 final rehearsal): the plan's Why section credited the request to "alice@example.com" when the sign-in provider had no name for the requester and used their address. The plan is read by
  // others, so it names a person as every other text Rovara writes for others does (C55): the display name without an address, else their linked GitHub login, else "the task owner".
  it("never credits the request to an email address: the display name, else the linked GitHub login, else the task owner (C60)", async () => {
    const fixture = pageTask();
    const record = taken(fixture);
    const withRequest = { ...record, developerName: "priya@example.com", requestText: "Retry failed payments", threadNotesFedThrough: "2026-10-22T10:30:00.000Z",
      currentOwner: { ...record.currentOwner!, name: "sam@example.com" } };
    fixture.db.set({ pk: `DEVTASK#${fixture.taskId}`, sk: "NOTE#1695500000.000200", entityType: "WORKFLOW_THREAD_NOTE", schemaVersion: 1, taskId: fixture.taskId, slackUserId: SAM.slackUserId, isOwner: true,
      teamId: "T0PAGE001", channelId: "C0PAGE001", threadTs: "1695500000.000100", messageTs: "1695500000.000200", eventId: "Ev1", text: "Please use the new endpoint", truncated: false, receivedAt: "2026-10-22T10:20:00.000Z", workflowRevision: 1 });
    const none = await planWhyEntries(fixture.deps, withRequest, []);
    expect(none.map((entry) => entry.author)).toEqual(["the task owner", "the task owner"]);
    const linked = await planWhyEntries(fixture.deps, withRequest, [], async (id) => ({ [PRIYA.developerId]: "priya-gh", [SAM.developerId]: "sam-gh" })[id]);
    expect(linked.map((entry) => entry.author)).toEqual(["priya-gh", "sam-gh"]);
    // A display name that has an address beside a name keeps the name.
    const named = await planWhyEntries(fixture.deps, { ...withRequest, developerName: "Priya Rao <priya@example.com>" }, []);
    expect(named[0]!.author).toBe("Priya Rao");
    expect(JSON.stringify([none, linked, named])).not.toContain("@");
  });
});

describe("the owner functions applied to a task's decisions", () => {
  const task = (taker?: { developerId: string }): DeveloperTaskRecord => ({
    pk: "DEVTASK#t", sk: "META", entityType: "DEVELOPER_TASK", taskId: "11111111-1111-4111-8111-111111111111", developerId: PRIYA.developerId, developerName: "Priya", provider: "slack",
    ownerKey: taskOwnerKey(PRIYA.developerId, "11111111-1111-4111-8111-111111111111"),
    ...(taker === undefined ? {} : { currentOwner: { developerId: taker.developerId, name: "Sam", provider: "oidc", since: SINCE } }),
  } as unknown as DeveloperTaskRecord);

  it("counts the creator's decision made before the take-over, never the time it is acted on, and refuses the creator's decision made after it", () => {
    const record = task(SAM);
    const priya = taskOwnerKey(PRIYA.developerId, record.taskId);
    const sam = taskOwnerKey(SAM.developerId, record.taskId);
    expect(ownerDecisionCounts(record, priya, before)).toBe(true);
    expect(ownerDecisionCounts(record, priya, after)).toBe(false);
    expect(ownerDecisionCounts(record, sam, after)).toBe(true);
    // The taker was not the owner before they took the task over, so a decision of theirs from then is no owner's.
    expect(ownerDecisionCounts(record, sam, before)).toBe(false);
    expect(ownerDecisionCounts(record, taskOwnerKey(OMAR.developerId, record.taskId), after)).toBe(false);
    // An unreadable time is not before anything: the creator's decision does not count on a taken-over task.
    expect(ownerDecisionCounts(record, priya, "not a time")).toBe(false);
  });

  it("counts the creator's decision, whenever it was made, on a task nobody took over, and nobody else's", () => {
    const record = task();
    const priya = taskOwnerKey(PRIYA.developerId, record.taskId);
    expect(ownerDecisionCounts(record, priya, before)).toBe(true);
    expect(ownerDecisionCounts(record, priya, after)).toBe(true);
    expect(ownerDecisionCounts(record, taskOwnerKey(SAM.developerId, record.taskId), after)).toBe(false);
  });

  it("with a People list, counts its owners, and the creator's earlier decision", () => {
    const record = task(SAM);
    const priya = taskOwnerKey(PRIYA.developerId, record.taskId);
    const sam = taskOwnerKey(SAM.developerId, record.taskId);
    expect(ownerDecisionCounts(record, sam, after, [sam])).toBe(true);
    expect(ownerDecisionCounts(record, priya, before, [sam])).toBe(true);
    expect(ownerDecisionCounts(record, priya, after, [sam])).toBe(false);
  });

  it("tells a task someone took over from one nobody did: an absent or explicitly undefined current owner is nobody's take-over, an unreadable one still is", () => {
    expect(isTaskTakenOver(task())).toBe(false);
    expect(isTaskTakenOver({ ...task(), currentOwner: undefined } as unknown as DeveloperTaskRecord)).toBe(false);
    expect(isTaskTakenOver(task(SAM))).toBe(true);
    expect(isTaskTakenOver({ ...task(), currentOwner: { developerId: "" } } as unknown as DeveloperTaskRecord)).toBe(true);
    expect(takenOverSince(task())).toBeUndefined();
    expect(takenOverSince(task(SAM))).toBe(SINCE);
    expect(takenOverSince({ ...task(), currentOwner: { developerId: "" } } as unknown as DeveloperTaskRecord)).toBeUndefined();
  });

  it("counts a decision made at the very moment of the take-over as the taker's, not the creator's", () => {
    const record = task(SAM);
    expect(ownerDecisionCounts(record, taskOwnerKey(SAM.developerId, record.taskId), SINCE)).toBe(true);
    expect(ownerDecisionCounts(record, taskOwnerKey(PRIYA.developerId, record.taskId), SINCE)).toBe(false);
  });

  it("names the owner actor of a taker as the taker's task-scoped key", () => {
    expect(ownerActorIdOf(task(SAM))).toBe(taskOwnerKey(SAM.developerId, task().taskId));
    expect(effectiveTaskOwner(task(SAM)).developerId).toBe(SAM.developerId);
  });
});

describe("the creator-still-a-member check follows the task's owner", () => {
  const ORG = TEST_ORG;
  const TASK = "11111111-1111-4111-8111-111111111111";
  const priya = "a".repeat(64);
  const max = "b".repeat(64);
  const casey = "c".repeat(64);
  function world(options: { removed?: string[]; members?: string[]; currentOwner?: unknown } = {}) {
    const db = new FakeDynamoDb();
    db.set({ ...orgMetaKey(ORG), entityType: "ORG_META", name: "Acme" });
    for (const developerId of options.members ?? [priya, max, casey]) db.set({ ...orgMemberKey(ORG, developerId), entityType: "ORG_MEMBER", orgId: ORG, developerId, role: "member" });
    for (const developerId of options.removed ?? []) db.set({ ...orgRemovedKey(ORG, developerId), entityType: "ORG_REMOVED", orgId: ORG, developerId });
    const task = {
      pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK, orgId: ORG, developerId: priya, developerName: "Priya", provider: "slack", project: "payments",
      ownerKey: taskOwnerKey(priya, TASK), workspaceId: randomUUID(),
      ...(options.currentOwner === undefined ? {} : { currentOwner: options.currentOwner }),
    } as unknown as DeveloperTaskRecord;
    db.set(task as never);
    return { db, task, deps: { documentClient: db, tableName: "state", orgId: ORG, now: () => Date.parse(SINCE) } };
  }
  const stored = (db: FakeDynamoDb) => db.get(`DEVTASK#${TASK}`, "META") as unknown as DeveloperTaskRecord;
  const MAX_OWNER = { developerId: max, name: "Max", provider: "oidc", since: SINCE };

  it("lets a task go on when its creator was removed after someone else took it over", async () => {
    const w = world({ members: [max, casey], removed: [priya], currentOwner: MAX_OWNER });
    await expect(requireCreatorStillMember(w.deps, w.task)).resolves.toBeUndefined();
    expect(stored(w.db).outcome).toBeUndefined();
  });

  it("ends the task creator_removed, naming the taker, when the taker was removed", async () => {
    const w = world({ members: [priya, casey], removed: [max], currentOwner: MAX_OWNER });
    await expect(requireCreatorStillMember(w.deps, w.task)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED", message: expect.stringContaining("Max is no longer a member of Acme, so Rovara stopped this task.") as string });
    expect(stored(w.db)).toMatchObject({ outcome: "creator_removed", outcomeReason: "Max is no longer a member of Acme, so Rovara stopped this task." });
  });

  it("still names the creator for a task nobody took over", async () => {
    const w = world({ members: [max], removed: [priya] });
    await expect(requireCreatorStillMember(w.deps, w.task)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED", message: expect.stringContaining("Priya is no longer a member of Acme") as string });
    expect(stored(w.db)).toMatchObject({ outcome: "creator_removed" });
  });

  it("refuses a task whose current owner can't be read, recording nothing and never judging the creator", async () => {
    const w = world({ members: [priya], currentOwner: { developerId: max } });
    await expect(requireCreatorStillMember(w.deps, w.task)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED", message: expect.stringContaining("can't tell who owns this task") as string });
    expect(stored(w.db).outcome).toBeUndefined();
  });

  it("writes the removal only while the removed owner still owns the task: a take-over that lands first makes it check the new owner", async () => {
    const w = world({ members: [priya, casey], removed: [max], currentOwner: MAX_OWNER });
    let flipped = false;
    const racing = { ...w.deps, documentClient: { async send(command: unknown) {
      if (!flipped && (command as { constructor: { name: string } }).constructor.name === "UpdateCommand") {
        flipped = true;
        w.db.set({ ...stored(w.db), currentOwner: { developerId: casey, name: "Casey", provider: "oidc", since: after } });
      }
      return w.db.send(command as never);
    } } };
    await expect(requireCreatorStillMember(racing, w.task)).resolves.toBeUndefined();
    expect(flipped).toBe(true);
    expect(stored(w.db).outcome).toBeUndefined();
  });

  it("gives up after a few take-overs in a row rather than chasing the owner for ever: it refuses naming the owner it last read, recording nothing", async () => {
    const w = world({ members: [], removed: [priya, max, casey], currentOwner: MAX_OWNER });
    const owners = [priya, max, casey];
    let flips = 0;
    const racing = { ...w.deps, documentClient: { async send(command: unknown) {
      if ((command as { constructor: { name: string } }).constructor.name === "UpdateCommand") {
        flips += 1;
        if (flips > 50) throw new Error("it chased the owner without end");
        w.db.set({ ...stored(w.db), currentOwner: { developerId: owners[flips % owners.length], name: `Owner ${String(flips)}`, provider: "oidc", since: `2026-10-22T12:00:${String(flips % 60).padStart(2, "0")}.000Z` } });
      }
      return w.db.send(command as never);
    } } };
    await expect(requireCreatorStillMember(racing, w.task)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    expect(flips).toBe(4);
    expect(stored(w.db).outcome).toBeUndefined();
  });

  it("answers an earlier recorded removal as before (a repeat leaves the first reason)", async () => {
    const w = world({ members: [priya, casey], removed: [max], currentOwner: MAX_OWNER });
    await expect(requireCreatorStillMember(w.deps, w.task)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    const first = stored(w.db).outcomeAt;
    let updates = 0;
    const counting = { ...w.deps, documentClient: { async send(command: unknown) {
      if ((command as { constructor: { name: string } }).constructor.name === "UpdateCommand") updates += 1;
      return w.db.send(command as never);
    } } };
    await expect(requireCreatorStillMember(counting, stored(w.db))).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    expect(stored(w.db).outcomeAt).toBe(first);
    // One refused write, then it knows the removal was already recorded: no more attempts.
    expect(updates).toBe(1);
  });
});

describe("the caller the broker's own steps act as for a task", () => {
  const brokerModule = () => loadSlackBroker().then(() => import("../../packages/broker/src/aws/broker.js"));
  const task = (extra: Record<string, unknown> = {}): DeveloperTaskRecord => ({
    pk: "DEVTASK#t", sk: "META", entityType: "DEVELOPER_TASK", taskId: "11111111-1111-4111-8111-111111111111", orgId: TEST_ORG, developerId: PRIYA.developerId, developerName: "Priya", provider: "slack",
    slackUserId: PRIYA.slackUserId, ...extra,
  } as unknown as DeveloperTaskRecord);

  it("is the creator for a task nobody took over, as before", async () => {
    const h = await createDeveloperTaskBroker();
    const { ownerCallerOf } = await brokerModule();
    expect(await ownerCallerOf(h.brokerInput as never, task(), "workflow-dispatch")).toEqual({
      developerId: PRIYA.developerId, sessionId: "workflow-dispatch", amr: "slack", name: "Priya", orgId: TEST_ORG, orgRole: "member", slackUserId: PRIYA.slackUserId,
    });
  });

  it("is the person who took the task over, with their own sign-in method, name and Slack id, so the owner actor id is theirs", async () => {
    const h = await createDeveloperTaskBroker();
    const { ownerCallerOf } = await brokerModule();
    const taken = task({ currentOwner: { developerId: SAM.developerId, name: "Sam Lee", provider: "oidc", slackUserId: SAM.slackUserId, since: SINCE } });
    const caller = await ownerCallerOf(h.brokerInput as never, taken, "github-webhook");
    expect(caller).toEqual({ developerId: SAM.developerId, sessionId: "github-webhook", amr: "oidc", name: "Sam Lee", orgId: TEST_ORG, orgRole: "member", slackUserId: SAM.slackUserId });
    expect(taskOwnerKey(caller.developerId, taken.taskId)).toBe(ownerActorIdOf(taken));
    // No Slack id for a taker who has none: the caller carries none either, never the creator's.
    const none = await ownerCallerOf(h.brokerInput as never, task({ currentOwner: { developerId: SAM.developerId, name: "Sam Lee", provider: "oidc", since: SINCE } }), "workflow-dispatch");
    expect(none).not.toHaveProperty("slackUserId");
  });

  it("is no one for a task whose current owner can't be read", async () => {
    const h = await createDeveloperTaskBroker();
    const { ownerCallerOf } = await brokerModule();
    await expect(ownerCallerOf(h.brokerInput as never, task({ currentOwner: { developerId: "" } }), "workflow-dispatch")).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
  });
});

describe("an owner with no usable name is shown with a fixed label, never the creator's name or a blank (ruling on 12a question 1)", () => {
  const base = (extra: Record<string, unknown> = {}): DeveloperTaskRecord => ({
    pk: "DEVTASK#t", sk: "META", entityType: "DEVELOPER_TASK", taskId: "11111111-1111-4111-8111-111111111111", developerId: PRIYA.developerId, developerName: "Priya", provider: "slack",
    ownerKey: taskOwnerKey(PRIYA.developerId, "11111111-1111-4111-8111-111111111111"), ...extra,
  } as unknown as DeveloperTaskRecord);

  it("writes the connector footer for a taker with no name as 'a member', and for a blank creator name too, never 'Requested by  via'", () => {
    expect(attributionOf(base({ currentOwner: { developerId: SAM.developerId, provider: "oidc", since: SINCE } }), "Triage")).toBe("Requested by `a member` via Rovara agent `Triage`");
    expect(attributionOf(base({ developerName: "  " }), "Triage")).toBe("Requested by `a member` via Rovara agent `Triage`");
    expect(attributionOf(base(), "Triage")).toBe("Requested by `Priya` via Rovara agent `Triage`");
  });

  it("credits an owner's reply on a task whose taker can't be read to the fixed label, not to the creator who handed it over", async () => {
    const fixture = pageTask();
    const record = fixture.db.get(`DEVTASK#${fixture.taskId}`, "META") as unknown as DeveloperTaskRecord;
    const unreadable = { ...record, currentOwner: { developerId: "" }, requestText: "Retry failed payments", threadNotesFedThrough: "2026-10-22T10:30:00.000Z" } as unknown as DeveloperTaskRecord;
    fixture.db.set({ pk: `DEVTASK#${fixture.taskId}`, sk: "NOTE#1695500000.000200", entityType: "WORKFLOW_THREAD_NOTE", schemaVersion: 1, taskId: fixture.taskId, slackUserId: SAM.slackUserId, isOwner: true,
      teamId: "T0PAGE001", channelId: "C0PAGE001", threadTs: "1695500000.000100", messageTs: "1695500000.000200", eventId: "Ev1", text: "Please use the new endpoint", truncated: false, receivedAt: "2026-10-22T10:20:00.000Z", workflowRevision: 1 });
    const entries = await planWhyEntries(fixture.deps, unreadable, []);
    expect(entries[0]).toMatchObject({ author: PRIYA.name });
    expect(entries.slice(1).map((entry) => entry.author)).toEqual(["a member"]);
  });
});

describe("a taker who was merged into another member (12a review M-3)", () => {
  const DUPLICATE = "9".repeat(64);
  /** Sam's earlier account, merged into Sam: the task was taken over under it. */
  const takenAsDuplicate = (fixture: ReturnType<typeof pageTask>) => {
    const record = fixture.db.get(`DEVTASK#${fixture.taskId}`, "META") as unknown as DeveloperTaskRecord;
    fixture.db.set({ ...record, currentOwner: { developerId: DUPLICATE, name: "Sam", provider: "oidc", since: SINCE } });
  };
  const withMerge = (fixture: ReturnType<typeof pageTask>) => ({ ...fixture.deps, resolveMember: async (id: string) => (id === DUPLICATE ? SAM.developerId : id) });

  it("is the task's owner on the person's own tasks and on the task page, read as the member they became", async () => {
    const fixture = pageTask();
    takenAsDuplicate(fixture);
    const deps = withMerge(fixture);
    await expect(loadOwnedTask(deps, SAM, fixture.taskId)).resolves.toMatchObject({ taskId: fixture.taskId });
    await expect(resolveTaskAccess(deps, SAM, fixture.taskId, "read")).resolves.toMatchObject({ role: "owner" });
    // Anyone else, the creator included, is still not the owner.
    expect((await refusal(loadOwnedTask(deps, PRIYA, fixture.taskId))).code).toBe("TASK_NOT_FOUND");
    expect((await refusal(loadOwnedTask(deps, OMAR, fixture.taskId))).code).toBe("TASK_NOT_FOUND");
  });

  it("reads exactly as before without a way to follow merges: only the stored id is the owner", async () => {
    const fixture = pageTask();
    takenAsDuplicate(fixture);
    expect((await refusal(loadOwnedTask(fixture.deps, SAM, fixture.taskId))).code).toBe("TASK_NOT_FOUND");
  });
});

describe("the merge follow-up (12a review M-3), bounds", () => {
  it("follows a merge only for a task someone took over: the creator's own tasks are not read through a merge", async () => {
    const fixture = pageTask();
    const deps = { ...fixture.deps, resolveMember: async (id: string) => (id === "9".repeat(64) ? PRIYA.developerId : id) };
    expect((await refusal(loadOwnedTask(deps, { ...SAM, developerId: "9".repeat(64) }, fixture.taskId))).code).toBe("TASK_NOT_FOUND");
    await expect(loadOwnedTask(deps, PRIYA, fixture.taskId)).resolves.toMatchObject({ taskId: fixture.taskId });
  });

  it("is wired into the route dependencies from the sign-in records' merge chain", async () => {
    const { developerTaskRouteDependencies } = await import("../../packages/broker/src/aws/developer-routes.js");
    const records: Record<string, { mergedInto?: string }> = { ["8".repeat(64)]: { mergedInto: "7".repeat(64) }, ["7".repeat(64)]: {} };
    const routes = developerTaskRouteDependencies({
      documentClient: { send: async (command: { input: { Key: { pk: string } } }) => ({ Item: { developerId: "x", ...records[command.input.Key.pk.replace("DEVELOPER#", "")] } }) },
      tableName: "state", signInTableName: "sign-ins", developer: { issuer: "https://issuer.example/v1/auth" }, now: Date.now,
    } as never, { orgId: "org_aaaaaaaaaaaaaaaaaaaa", orgRole: "member", developerId: "d", sessionId: "s", amr: "oidc", name: "D" });
    expect(await routes.resolveMember!("8".repeat(64))).toBe("7".repeat(64));
  });
});
