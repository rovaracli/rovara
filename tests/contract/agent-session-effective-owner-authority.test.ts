// Plan 5 Task 12a: every read of a task's owner that carries authority follows the person who took the task over. The creator's own fields, the task's principal
// (`ownerKey`) and its object prefixes never change. These tests take over tasks by writing `currentOwner` directly, as Task 12b will.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { orgMemberKey, orgMetaKey, orgRemovedKey } from "@agentx/contracts";
import { getTaskDocumentView, loadOwnedTask, ownerIndexRowOf, planWhyEntries, syncIndex } from "../../packages/broker/src/aws/developer-tasks.js";
import { resolveTaskAccess } from "../../packages/broker/src/developer/task-access.js";
import { requireCreatorStillMember } from "../../packages/broker/src/developer/creator-member.js";
import { effectiveTaskOwner, ownerActorIdOf, ownerDecisionCounts, taskIndexKey, taskOwnerKey, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { OMAR, PRIYA, SAM, pagePlan, pageTask } from "../support/page-tasks.js";
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
  fixture.db.set(next as never);
  return next as DeveloperTaskRecord;
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
    fixture.db.set({ ...record, currentOwner: { developerId: "" } } as never);
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
    await expect(loadOwnedTask(fixture.deps, { ...SAM, orgId: "org_zzzzzzzzzzzzzzzzzzzz" as never }, fixture.taskId)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("syncs the creator's index row and the taker's, and only the creator's for a task nobody took over", async () => {
    const fixture = pageTask();
    const plain = fixture.db.get(`DEVTASK#${fixture.taskId}`, "META") as unknown as DeveloperTaskRecord;
    const row = (developerId: string) => taskIndexKey(developerId, plain.createdAt, fixture.taskId);
    const seed = (developerId: string) => fixture.db.set({ ...row(developerId), entityType: "DEVELOPER_TASK_INDEX", taskId: fixture.taskId, orgId: TEST_ORG, status: "RUNNING", updatedAt: plain.createdAt } as never);
    seed(PRIYA.developerId);
    seed(SAM.developerId);
    expect(ownerIndexRowOf(plain)).toBeUndefined();
    await syncIndex(fixture.deps, plain, "WAITING");
    expect(fixture.db.get(row(PRIYA.developerId).pk, row(PRIYA.developerId).sk)).toMatchObject({ status: "WAITING" });
    expect(fixture.db.get(row(SAM.developerId).pk, row(SAM.developerId).sk)).toMatchObject({ status: "RUNNING" });
    const task = taken(fixture);
    expect(ownerIndexRowOf(task)).toEqual(row(SAM.developerId));
    await syncIndex(fixture.deps, task, "REVIEW");
    expect(fixture.db.get(row(PRIYA.developerId).pk, row(PRIYA.developerId).sk)).toMatchObject({ status: "REVIEW" });
    expect(fixture.db.get(row(SAM.developerId).pk, row(SAM.developerId).sk)).toMatchObject({ status: "REVIEW" });
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
    db.set({ ...orgMetaKey(ORG), entityType: "ORG_META", name: "Acme" } as never);
    for (const developerId of options.members ?? [priya, max, casey]) db.set({ ...orgMemberKey(ORG, developerId), entityType: "ORG_MEMBER", orgId: ORG, developerId, role: "member" } as never);
    for (const developerId of options.removed ?? []) db.set({ ...orgRemovedKey(ORG, developerId), entityType: "ORG_REMOVED", orgId: ORG, developerId } as never);
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
    const racing = { ...w.deps, documentClient: { async send(command: unknown, options?: unknown) {
      if (!flipped && (command as { constructor: { name: string } }).constructor.name === "UpdateCommand") {
        flipped = true;
        w.db.set({ ...stored(w.db), currentOwner: { developerId: casey, name: "Casey", provider: "oidc", since: after } } as never);
      }
      return w.db.send(command as never, options as never);
    } } };
    await expect(requireCreatorStillMember(racing, w.task)).resolves.toBeUndefined();
    expect(flipped).toBe(true);
    expect(stored(w.db).outcome).toBeUndefined();
  });

  it("answers an earlier recorded removal as before (a repeat leaves the first reason)", async () => {
    const w = world({ members: [priya, casey], removed: [max], currentOwner: MAX_OWNER });
    await expect(requireCreatorStillMember(w.deps, w.task)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    const first = stored(w.db).outcomeAt;
    await expect(requireCreatorStillMember(w.deps, stored(w.db))).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    expect(stored(w.db).outcomeAt).toBe(first);
  });
});
