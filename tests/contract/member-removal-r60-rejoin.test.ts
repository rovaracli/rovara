// Member removal (v1.1), task 2, §5.1: ruling R60 after a rejoin. Work that started before a person's removal stays stopped when they come back, whether they were its owner or
// its member payer; work that started after the rejoin runs. The tombstone has no expiry, so it outlives any task. One function (`checkOwnerStillMember`) is behind every path;
// the model key mint and the paused-resume drop use the same rule.
import { describe, expect, it } from "vitest";
import { chainRunKey, orgRemovedKey } from "../../packages/contracts/src/index.js";
import { requireCreatorStillMember, requireOrgOpenFor, creatorRemovedMessage } from "../../packages/broker/src/developer/creator-member.js";
import { creatorGone } from "../../packages/broker/src/spend/requests.js";
import { taskKey, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { HOUR, OWNER, SAM, T0, removalWorld } from "../support/member-removal-world.js";

const iso = (ms: number) => new Date(ms).toISOString();

async function world() {
  const w = await removalWorld();
  await w.join(SAM, "Sam", "member");
  const deps = (orgId = w.orgId) => ({ documentClient: w.db, tableName: "state", orgId, now: () => w.clock.now });
  const task = (id: string, owner: string, createdAt: number, extra: Record<string, unknown> = {}): DeveloperTaskRecord => {
    const record = {
      ...taskKey(id), entityType: "DEVELOPER_TASK", taskId: id, orgId: w.orgId, developerId: owner, developerName: owner === SAM ? "Sam" : "Owen Owner", provider: "cloud",
      project: "payments", createdAt: iso(createdAt), updatedAt: iso(createdAt), ...extra,
    };
    w.db.set(record);
    return record as unknown as DeveloperTaskRecord;
  };
  return { w, deps, task };
}

/** Sam made a task at T-1h, was removed at T0 and came back at T1. */
async function rejoined() {
  const h = await world();
  const old = h.task("task-old", SAM, T0 - HOUR);
  await h.w.remove(SAM);
  h.w.tick(HOUR);
  await h.w.join(SAM, "Sam", "member");
  h.w.tick(HOUR / 2);
  return { ...h, old };
}

const refused = (message = creatorRemovedMessage("Sam", "Acme")) => expect.objectContaining({ code: "TASK_ACCESS_DENIED", message: expect.stringContaining(message) as string }) as unknown;

describe("R60 after a rejoin", () => {
  it("an old task after a rejoin is refused with the fixed reason", async () => {
    const { w, deps, old } = await rejoined();
    await expect(requireCreatorStillMember(deps(), old)).rejects.toEqual(refused());
    expect(w.db.get(taskKey("task-old"))).toMatchObject({ outcome: "creator_removed", outcomeReason: creatorRemovedMessage("Sam", "Acme") });
  });

  it("continue-as-task keeps the same record, so an old task continued after a rejoin is refused, and the spend-approval resume of it is dropped", async () => {
    const { w, deps, old, task } = await rejoined();
    // Continuing a thread as a task, or resuming after a spend approval, re-reads the same task record: its creation time is still before the removal.
    const continued = { ...old, updatedAt: iso(w.clock.now), workflow: { mode: "continue" } } as unknown as DeveloperTaskRecord;
    w.db.set(continued as unknown as Record<string, unknown>);
    await expect(requireCreatorStillMember(deps(), continued)).rejects.toEqual(refused());
    expect(await creatorGone(deps(), w.orgId, continued)).toBe(true);
    // A task started fresh after the rejoin and continued the same way runs.
    const fresh = task("task-fresh", SAM, w.clock.now);
    await expect(requireCreatorStillMember(deps(), { ...fresh, updatedAt: iso(w.clock.now + 1) })).resolves.toBeUndefined();
  });

  it("a new task made after the rejoin runs", async () => {
    const { w, deps, task } = await rejoined();
    const fresh = task("task-new", SAM, w.clock.now);
    await expect(requireCreatorStillMember(deps(), fresh)).resolves.toBeUndefined();
    expect(w.db.get(taskKey("task-new"))!.outcome).toBeUndefined();
  });

  it("a chain step's task made after the rejoin is refused when its run began before the removal", async () => {
    const { w, deps, task } = await rejoined();
    w.db.set({ ...chainRunKey(w.orgId, "run_00000000000000000001", "META"), entityType: "CHAIN_RUN", createdAt: iso(T0 - HOUR) });
    const step = task("task-step", SAM, w.clock.now, { chain: { chainRunId: "run_00000000000000000001", stepId: "s1" } });
    await expect(requireCreatorStillMember(deps(), step)).rejects.toEqual(refused());
    // The same step of a run that began after the rejoin runs.
    w.db.set({ ...chainRunKey(w.orgId, "run_00000000000000000002", "META"), entityType: "CHAIN_RUN", createdAt: iso(w.clock.now) });
    const fresh = task("task-step-2", SAM, w.clock.now, { chain: { chainRunId: "run_00000000000000000002", stepId: "s1" } });
    await expect(requireCreatorStillMember(deps(), fresh)).resolves.toBeUndefined();
  });

  it("a task whose member payer was removed and came back is refused, though its owner never left", async () => {
    const { deps, task, w } = await world();
    const old = task("task-paid", OWNER, T0 - HOUR, { payer: { kind: "member", developerId: SAM } });
    await w.remove(SAM);
    w.tick(HOUR);
    await w.join(SAM, "Sam", "member");
    await expect(requireCreatorStillMember(deps(), old)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    const fresh = task("task-paid-new", OWNER, w.clock.now, { payer: { kind: "member", developerId: SAM } });
    await expect(requireCreatorStillMember(deps(), fresh)).resolves.toBeUndefined();
  });

  it("the paused-resume drop and the model key mint use the same rule", async () => {
    const { w, deps, old, task } = await rejoined();
    expect(await creatorGone(deps(), w.orgId, old)).toBe(true);
    expect(await creatorGone(deps(), w.orgId, task("task-new", SAM, w.clock.now))).toBe(false);
    const broker = { documentClient: w.db, tableName: "state" } as never;
    await expect(requireOrgOpenFor(broker, w.orgId, [SAM], old.createdAt)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    await expect(requireOrgOpenFor(broker, w.orgId, [SAM], iso(w.clock.now))).resolves.toBeUndefined();
    // With no start time given, today's rule stands: a member is fine.
    await expect(requireOrgOpenFor(broker, w.orgId, [SAM])).resolves.toBeUndefined();
  });

  it("a person removed and not back is refused as before, new work or old", async () => {
    const { w, deps, task } = await world();
    const old = task("task-gone", SAM, T0 - HOUR);
    await w.remove(SAM);
    await expect(requireCreatorStillMember(deps(), old)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    await expect(requireCreatorStillMember(deps(), task("task-gone-2", SAM, w.clock.now + 1))).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
  });

  it("the tombstone has no expiry attribute, outlives a year and the rejoin, and a second removal moves it forward only", async () => {
    const { w, deps, old } = await rejoined();
    const tombstone = w.db.get(orgRemovedKey(w.orgId, SAM))!;
    for (const name of Object.keys(tombstone)) expect(name).not.toMatch(/expir|ttl/i);
    w.tick(366 * 24 * HOUR);
    expect(w.db.get(orgRemovedKey(w.orgId, SAM))).toBeDefined();
    await expect(requireCreatorStillMember(deps(), old)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    const first = String(tombstone.removedAt);
    await w.remove(SAM);
    expect(String(w.db.get(orgRemovedKey(w.orgId, SAM))!.removedAt) > first).toBe(true);
  });

  it("unbroken membership (joined before the work began): the tombstone is never read", async () => {
    const { w, deps, task } = await world();
    // Sam joined at T0 and never left; a task made later by Sam (or paid by Sam) runs, and no read touches the REMOVED partition.
    const reads: string[] = [];
    const send = w.db.send.bind(w.db);
    w.db.send = async (command) => {
      const key = (command as { input?: { Key?: { pk?: string } } }).input?.Key?.pk;
      if (command.constructor.name === "GetCommand" && typeof key === "string" && key.endsWith("#REMOVED")) reads.push(key);
      return send(command);
    };
    await requireCreatorStillMember(deps(), task("task-ok", SAM, w.clock.now + HOUR));
    expect(reads).toEqual([]);
  });
});
