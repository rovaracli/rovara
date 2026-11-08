// Owner decision 31 (LESSON-TASK-AUDIENCE): for lessons, a task's audience is who can actually open its session (the project's members minus anyone its People list denies, plus anyone it names), and a lesson reaches a running
// task only if everyone who can see the task can see every source task. This file tests the audience sets and the subset rule, and pins that the Team record's own resolver (`task-visibility.ts`) is unchanged for the
// same tasks: the record's audience was NOT widened (an unshared task's rows still go to its owner alone).
import { describe, expect, it } from "vitest";
import { projectRevisionKey, type OrgId } from "@agentx/contracts";
import { AgentSessionStore } from "../../../packages/broker/src/agent-sessions/store.js";
import { resolveTaskVisibility } from "../../../packages/broker/src/lessons/task-visibility.js";
import { audienceWithin, inAudience, lessonAudiencesOf, resolveLessonTaskAudience, tableLessonAudiencePort, withLessonAudiences, type LessonTaskAudience } from "../../../packages/broker/src/lessons/task-audience.js";
import { mayReadTask } from "../../../packages/broker/src/team-record/live-audience.js";
import { tableTaskVisibilityPort } from "../../../packages/broker/src/team-record/live-audience-port.js";
import { ARJUN, MAX, MIA, OLA, ORG_A, ORG_B, PRIYA, ZED, sessionWorld } from "../../support/agent-session-world.js";

void AgentSessionStore;

function setup() {
  const w = sessionWorld();
  // A project is listed once a revision exists (the roster read follows `projectExists`).
  w.db.set({ ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT_REVISION" });
  const table = { documentClient: w.db, tableName: "state", now: () => 0 };
  const task = (options: Parameters<typeof w.seedSession>[0] = {}) => w.seedSession(options);
  const audienceOf = async (taskId: string, orgId: OrgId = ORG_A) => resolveLessonTaskAudience(table, orgId, taskId);
  const recordOf = (taskId: string, orgId: OrgId = ORG_A) => resolveTaskVisibility(table, orgId, taskId);
  return { w, table, task, audienceOf, recordOf };
}
const ROSTER = [PRIYA, ARJUN, MIA, MAX, OLA].sort();
const sorted = (set: ReadonlySet<string>): string[] => [...set].sort();

describe("a task's audience for lessons", () => {
  it("an unshared task is NOT the owner's alone: it is the project's roster (members and org admins) and its owner", async () => {
    const t = setup();
    const a = await t.audienceOf(t.task().taskId);
    expect(a).toBeDefined();
    expect(sorted(a!.roster)).toEqual(ROSTER);
    expect(sorted(a!.denied)).toEqual([]);
    expect(sorted(a!.extras)).toEqual([PRIYA]);
    expect(a!.orgWide).toBe(false);
    expect(a!.project).toBe("web");
    expect(inAudience(a!, ZED)).toBe(false);
    expect(inAudience(a!, MIA)).toBe(true);
  });

  it("a People 'denied' entry takes the person out; viewer, commenter and owner entries, and member shares, add people by name; shares never narrow", async () => {
    const t = setup();
    const made = t.task({ people: [{ developerId: MIA, role: "denied" }, { developerId: ZED, role: "viewer" }] });
    t.w.seedShare(ORG_A, made.sessionId, { kind: "member", developerId: MIA }, "use");
    t.w.seedShare(ORG_A, made.sessionId, { kind: "member", developerId: ARJUN }, "view");
    const a = (await t.audienceOf(made.taskId))!;
    expect(sorted(a.denied)).toEqual([MIA]);
    expect(sorted(a.extras)).toEqual([PRIYA, ARJUN, ZED].sort());
    expect(inAudience(a, MIA)).toBe(false);
    expect(inAudience(a, ZED)).toBe(true);
    // The Team record's resolver, for the same task, is the list (a share never made it the project's here).
    expect(await t.recordOf(made.taskId)).toMatchObject({ kind: "shared_with" });
  });

  it("a share with the company is org-wide; with another project adds that project; with this project adds nothing", async () => {
    const t = setup();
    const made = t.task();
    t.w.seedShare(ORG_A, made.sessionId, { kind: "org" }, "view");
    expect((await t.audienceOf(made.taskId))!.orgWide).toBe(true);
    const other = t.task();
    t.w.seedShare(ORG_A, other.sessionId, { kind: "project", project: "ops" }, "view");
    t.w.seedShare(ORG_A, other.sessionId, { kind: "project", project: "web" }, "view");
    const a = (await t.audienceOf(other.taskId))!;
    expect(sorted(a.otherProjects)).toEqual(["ops"]);
    expect(a.orgWide).toBe(false);
  });

  it("the earlier owner of a taken-over task is not named by a People 'owner' entry; the taker is the owner now", async () => {
    const t = setup();
    const a = (await t.audienceOf(t.task({ currentOwner: ARJUN, people: [{ developerId: PRIYA, role: "owner" }] }).taskId))!;
    expect(sorted(a.extras)).toEqual([ARJUN]);
  });

  it("fail closed: an unreadable People list, a missing or unreadable session, a failing read and a project with no roster are unknown; another company's task is undefined", async () => {
    const t = setup();
    const garbled = t.task();
    t.w.db.set({ pk: `DEVTASK#${garbled.taskId}`, sk: "PEOPLE", schemaVersion: 7, people: "garbled" });
    await expect(t.audienceOf(garbled.taskId)).rejects.toThrow();
    const noSession = t.task({ kind: "chain" });
    await expect(t.audienceOf(noSession.taskId)).resolves.toBeUndefined();
    const local = t.task({ project: null });
    await expect(t.audienceOf(local.taskId)).rejects.toThrow();
    const made = t.task();
    const failing = { documentClient: { send: async (command: unknown) => { if (JSON.stringify((command as { input?: unknown }).input).includes("SHARE#")) throw new Error("down"); return t.w.db.send(command as never); } }, tableName: "state", now: () => 0 };
    await expect(resolveLessonTaskAudience(failing, ORG_A, made.taskId)).rejects.toThrow();
    // Through the port every one of those is simply "unknown".
    const port = tableLessonAudiencePort(t.table);
    const read = await port.read(ORG_A, [garbled.taskId, made.taskId, "no-such-task"]);
    expect(read.get(garbled.taskId)).toBeUndefined();
    expect(read.get(made.taskId)).toBeDefined();
    expect(read.get("no-such-task")).toBeUndefined();
    expect((await port.read(ORG_B, [made.taskId])).get(made.taskId)).toBeUndefined();
    const noRoster = setup();
    const ops = noRoster.task({ project: "ops" });
    await expect(noRoster.audienceOf(ops.taskId)).resolves.toMatchObject({ roster: new Set() });
  });

  it("a project's roster is listed once for a whole request, however many tasks are read", async () => {
    const t = setup();
    const ids = [t.task().taskId, t.task().taskId, t.task({ owner: ARJUN }).taskId];
    let rosterReads = 0;
    const counting = { ...t.table, documentClient: { send: async (command: unknown) => { if ((command as { constructor: { name: string } }).constructor.name === "QueryCommand" && JSON.stringify((command as { input?: unknown }).input).includes(":prefix\":\"MEMBER#")) rosterReads += 1; return t.w.db.send(command as never); } } };
    const read = await tableLessonAudiencePort(counting).read(ORG_A, ids);
    expect([...read.values()].every((a) => a !== undefined)).toBe(true);
    expect(rosterReads).toBe(1);
  });

  it("the port stops starting reads once it is told to stop (a timeout)", async () => {
    const t = setup();
    const ids = Array.from({ length: 30 }, () => t.task().taskId);
    const abort = new AbortController();
    let started = 0;
    const counting = { ...t.table, documentClient: { send: async (command: unknown) => { if (JSON.stringify((command as { input?: unknown }).input).includes("DEVTASK#") || (command as { constructor?: { name?: string } }).constructor?.name === "GetCommand") { started += 1; if (started === 4) abort.abort(); } return t.w.db.send(command as never); } } };
    const read = await tableLessonAudiencePort(counting).read(ORG_A, ids, { signal: abort.signal });
    expect(read.size).toBeLessThan(ids.length);
  });
});

describe("audience(T) is a subset of audience(P)", () => {
  const base = (over: Partial<LessonTaskAudience> = {}): LessonTaskAudience => ({ project: "web", roster: new Set(ROSTER), denied: new Set(), extras: new Set([PRIYA]), orgWide: false, otherProjects: new Set(), ...over });

  it("the reviewer's scenario: P denies Z, X runs an unshared T (nobody denied): Z can see T but not P, so T is not within P", () => {
    const P = base({ denied: new Set([MIA]) });
    const T = base({ extras: new Set([ARJUN]) });
    expect(audienceWithin(T, P)).toBe(false);
  });

  it("positive controls: T that also denies Z; T that denies more; project-wide T with project-wide P; a denial on T but not on P", () => {
    expect(audienceWithin(base({ denied: new Set([MIA]) }), base({ denied: new Set([MIA]) }))).toBe(true);
    expect(audienceWithin(base({ denied: new Set([MIA, MAX]) }), base({ denied: new Set([MIA]) }))).toBe(true);
    expect(audienceWithin(base(), base())).toBe(true);
    expect(audienceWithin(base({ denied: new Set([MAX]) }), base())).toBe(true);
  });

  it("a different denial, a person named on T only, a wider share on T and a different project are all outside", () => {
    expect(audienceWithin(base({ denied: new Set([MAX]) }), base({ denied: new Set([MIA]) }))).toBe(false);
    expect(audienceWithin(base({ extras: new Set([PRIYA, ZED]) }), base())).toBe(false);
    expect(audienceWithin(base({ orgWide: true }), base())).toBe(false);
    expect(audienceWithin(base({ otherProjects: new Set(["ops"]) }), base())).toBe(false);
    expect(audienceWithin(base(), base({ project: "ops" }))).toBe(false);
  });

  it("what P names or shares with the company widens P: T may name the same people, or be inside a company-wide P", () => {
    expect(audienceWithin(base({ extras: new Set([PRIYA, ZED]) }), base({ extras: new Set([ZED]) }))).toBe(true);
    expect(audienceWithin(base({ extras: new Set([ZED]) }), base({ orgWide: true }))).toBe(true);
    expect(audienceWithin(base({ orgWide: true }), base({ orgWide: true }))).toBe(true);
    expect(audienceWithin(base({ orgWide: true }), base({ orgWide: true, denied: new Set([MIA]) }))).toBe(false);
  });

  it("end to end from the stored tasks", async () => {
    const t = setup();
    const p = (await t.audienceOf(t.task({ people: [{ developerId: MIA, role: "denied" }] }).taskId))!;
    const unshared = (await t.audienceOf(t.task({ owner: ARJUN }).taskId))!;
    const alsoDenies = (await t.audienceOf(t.task({ owner: ARJUN, people: [{ developerId: MIA, role: "denied" }] }).taskId))!;
    expect(audienceWithin(unshared, p)).toBe(false);
    expect(audienceWithin(alsoDenies, p)).toBe(true);
    const wide = (await t.audienceOf(t.task({ owner: ARJUN }).taskId))!;
    const wide2 = (await t.audienceOf(t.task().taskId))!;
    expect(audienceWithin(wide, wide2)).toBe(true);
  });
});

describe("the lesson-audience port rides on the visibility port without changing it", () => {
  it("withLessonAudiences keeps the port's own methods and adds the audiences; a plain port has none", async () => {
    const t = setup();
    const plain = tableTaskVisibilityPort(t.table);
    const wrapped = withLessonAudiences(plain, tableLessonAudiencePort(t.table));
    const made = t.task();
    expect((await wrapped.read(ORG_A, [made.taskId])).get(made.taskId)).toEqual(await plain.read(ORG_A, [made.taskId]).then((m) => m.get(made.taskId)));
    expect(lessonAudiencesOf(wrapped)).toBeDefined();
    expect(lessonAudiencesOf(plain)).toBeUndefined();
    expect(lessonAudiencesOf(undefined)).toBeUndefined();
  });

  it("the State-table visibility port stops starting reads once it is told to stop", async () => {
    const t = setup();
    const ids = Array.from({ length: 30 }, () => t.task().taskId);
    const abort = new AbortController();
    let started = 0;
    const counting = { ...t.table, documentClient: { send: async (command: unknown) => { started += 1; if (started === 6) abort.abort(); return t.w.db.send(command as never); } } };
    const read = await tableTaskVisibilityPort(counting).read(ORG_A, ids, { signal: abort.signal });
    expect(read.size).toBeLessThan(ids.length);
  });
});

// The Team record (SRL-4) reads rows through `resolveTaskVisibility` and `mayReadTask`. Decision 31 is for lessons only: these pin the record's answers for an unshared task, a narrowed task, a People-denied member and a
// project-wide task, so a change to the record's audience (it must NOT be widened) fails here. (No Team record file was changed by the lessons lane; `git diff` of team-record/ and lessons/task-visibility.ts is empty.)
describe("the Team record's audience is unchanged", () => {
  it("an unshared task: its rows go to its owner alone (not to the project), even though a lesson's audience is the roster", async () => {
    const t = setup();
    const made = t.task();
    const visibility = (await t.recordOf(made.taskId))!;
    expect(visibility).toEqual({ kind: "private", ownerDeveloperId: PRIYA });
    const as = (developerId: string) => ({ kind: "caller" as const, caller: { orgId: ORG_A, developerId, projectRole: undefined, identities: { ids: {}, groups: {} } } });
    expect(mayReadTask(as(PRIYA), visibility)).toBe(true);
    for (const other of [ARJUN, MIA, MAX, OLA, ZED]) expect(mayReadTask(as(other), visibility)).toBe(false);
    expect(mayReadTask({ kind: "shared", orgId: ORG_A }, visibility)).toBe(false);
    expect(inAudience((await t.audienceOf(made.taskId))!, ARJUN)).toBe(true);
  });

  it("a narrowed task (a People list): its rows go to the list, owner first", async () => {
    const t = setup();
    const made = t.task({ people: [{ developerId: MIA, role: "viewer" }, { developerId: ZED, role: "commenter" }] });
    expect(await t.recordOf(made.taskId)).toEqual({ kind: "shared_with", developerIds: [PRIYA, MIA, ZED].sort((a, b) => (a === PRIYA ? -1 : b === PRIYA ? 1 : a.localeCompare(b))) });
  });

  it("a People-denied member: not on the list, and a project share does not make the task the project's", async () => {
    const t = setup();
    const made = t.task({ people: [{ developerId: MIA, role: "denied" }, { developerId: ARJUN, role: "viewer" }] });
    t.w.seedShare(ORG_A, made.sessionId, { kind: "project", project: "web" }, "view");
    t.w.seedShare(ORG_A, made.sessionId, { kind: "member", developerId: MIA }, "use");
    expect(await t.recordOf(made.taskId)).toEqual({ kind: "shared_with", developerIds: [PRIYA, ARJUN] });
  });

  it("a project-wide task (a share with the project or the company): shared; read strictly through the port it is the same", async () => {
    const t = setup();
    const made = t.task();
    t.w.seedShare(ORG_A, made.sessionId, { kind: "project", project: "web" }, "view");
    expect(await t.recordOf(made.taskId)).toEqual({ kind: "shared" });
    expect((await tableTaskVisibilityPort(t.table).read(ORG_A, [made.taskId])).get(made.taskId)).toEqual({ kind: "shared" });
    const company = t.task();
    t.w.seedShare(ORG_A, company.sessionId, { kind: "org" }, "view");
    expect(await t.recordOf(company.taskId)).toEqual({ kind: "shared" });
  });
});
