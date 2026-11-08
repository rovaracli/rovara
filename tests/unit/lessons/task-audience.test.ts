// Owner decision 31 (LESSON-TASK-AUDIENCE): for lessons, a task's audience is who can actually open its session (the project's members minus anyone its People list denies, plus anyone it names), and a lesson reaches a running
// task only if everyone who can see the task can see every source task. This file tests the audience sets and the subset rule, and pins that the Team record's own resolver (`task-visibility.ts`) is unchanged for the
// same tasks: the record's audience was NOT widened (an unshared task's rows still go to its owner alone).
import { describe, expect, it } from "vitest";
import { orgMemberKey, projectRevisionKey, type OrgId } from "@agentx/contracts";
import { AgentSessionStore } from "../../../packages/broker/src/agent-sessions/store.js";
import { resolveTaskVisibility } from "../../../packages/broker/src/lessons/task-visibility.js";
import { audienceWithin, inAudience, lessonAudiencesOf, openToWholeProject, resolveLessonTaskAudience, tableLessonAudiencePort, withLessonAudiences, type LessonTaskAudience } from "../../../packages/broker/src/lessons/task-audience.js";
import { mayReadTask } from "../../../packages/broker/src/team-record/live-audience.js";
import { tableTaskVisibilityPort } from "../../../packages/broker/src/team-record/live-audience-port.js";
import { sessionLevelOf } from "../../../packages/broker/src/agent-sessions/access.js";
import { listProjectMembers } from "../../../packages/broker/src/org/project-members.js";
import { ARJUN, MAX, MIA, OLA, ORG_A, ORG_B, PRIYA, ZED, sessionWorld } from "../../support/agent-session-world.js";

void AgentSessionStore;

function setup() {
  const w = sessionWorld();
  // A project is listed once a revision exists (the reference roster read below follows `projectExists`).
  w.db.set({ ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT_REVISION" });
  const table = { documentClient: w.db, tableName: "state", now: () => 0 };
  const task = (options: Parameters<typeof w.seedSession>[0] = {}) => w.seedSession(options);
  const audienceOf = async (taskId: string, orgId: OrgId = ORG_A) => resolveLessonTaskAudience(table, orgId, taskId);
  const recordOf = (taskId: string, orgId: OrgId = ORG_A) => resolveTaskVisibility(table, orgId, taskId);
  return { w, table, task, audienceOf, recordOf };
}
const ROSTER = [PRIYA, ARJUN, MIA, MAX, OLA].sort();
const sorted = (set: ReadonlySet<string>): string[] => [...set].sort();

const PEOPLE = [PRIYA, ARJUN, MIA, MAX, OLA, ZED];

describe("a task's audience for lessons", () => {
  it("an unshared task is NOT the owner's alone: it is the project's roster (members and org admins) and its owner", async () => {
    const t = setup();
    const a = await t.audienceOf(t.task().taskId);
    expect(a).toBeDefined();
    expect(sorted(a!.denied)).toEqual([]);
    expect(sorted(a!.extras)).toEqual([PRIYA]);
    expect(a!.orgWide).toBe(false);
    expect(a!.project).toBe("web");
    // The roster is asked one person at a time: a grant (viewer included), an org admin; not a member with no project role.
    expect(await inAudience(a!, ZED)).toBe(false);
    expect(await inAudience(a!, MIA)).toBe(true);
    expect(await inAudience(a!, OLA)).toBe(true);
    expect(await inAudience(a!, PRIYA)).toBe(true);
    expect(await inAudience(a!, "not-a-member")).toBe(false);
  });

  it("a People 'denied' entry takes the person out; viewer, commenter and owner entries, and member shares, add people by name; shares never narrow", async () => {
    const t = setup();
    const made = t.task({ people: [{ developerId: MIA, role: "denied" }, { developerId: ZED, role: "viewer" }] });
    t.w.seedShare(ORG_A, made.sessionId, { kind: "member", developerId: MIA }, "use");
    t.w.seedShare(ORG_A, made.sessionId, { kind: "member", developerId: ARJUN }, "view");
    const a = (await t.audienceOf(made.taskId))!;
    expect(sorted(a.denied)).toEqual([MIA]);
    expect(sorted(a.extras)).toEqual([PRIYA, ARJUN, ZED].sort());
    expect(await inAudience(a, MIA)).toBe(false);
    expect(await inAudience(a, ZED)).toBe(true);
    expect(openToWholeProject(a)).toBe(false);
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
    expect(openToWholeProject(a)).toBe(true);
  });

  it("the earlier owner of a taken-over task is not named by a People 'owner' entry; the taker is the owner now", async () => {
    const t = setup();
    const a = (await t.audienceOf(t.task({ currentOwner: ARJUN, people: [{ developerId: PRIYA, role: "owner" }] }).taskId))!;
    expect(sorted(a.extras)).toEqual([ARJUN]);
  });

  it("fail closed: an unreadable People list, a missing or unreadable session and a failing read are unknown; another company's task is undefined; a roster entry that cannot be read throws", async () => {
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
    // A project with no grants has nobody on its roster (the owner is named, so still in).
    const ops = t.task({ project: "ops" });
    const opsAudience = (await t.audienceOf(ops.taskId))!;
    expect(await inAudience(opsAudience, ARJUN)).toBe(false);
    expect(await inAudience(opsAudience, PRIYA)).toBe(true);
    // A roster read that fails is an error, never "not on the roster", and is not remembered.
    let down = true;
    const flaky = { ...t.table, documentClient: { send: async (command: unknown) => { if (down && JSON.stringify((command as { input?: unknown }).input).includes("MEMBER#")) throw new Error("down"); return t.w.db.send(command as never); } } };
    const memo = new Map<string, Promise<boolean>>();
    const flakyAudience = (await resolveLessonTaskAudience(flaky, ORG_A, made.taskId, memo))!;
    await expect(inAudience(flakyAudience, MIA)).rejects.toThrow();
    down = false;
    await expect(inAudience(flakyAudience, MIA)).resolves.toBe(true);
  });

  it("G1: a member row whose own developer id is not the id it is filed under (a stale or merged-away entry) is not on the roster; the listed roster does not name it either", async () => {
    const t = setup();
    const a = (await t.audienceOf(t.task().taskId))!;
    // A row filed under "old-id" that says it is ZED's, with an admin role: reading it by key would put "old-id" on the roster.
    const stale = "e".repeat(10) + "-old";
    t.w.db.set({ ...orgMemberKey(ORG_A, stale), entityType: "ORG_MEMBER", orgId: ORG_A, developerId: ZED, role: "admin", joinedAt: "2026-10-01T00:00:00.000Z" });
    expect(await inAudience(a, stale)).toBe(false);
    expect(await a.onRoster(stale)).toBe(false);
    expect((await listProjectMembers(t.table, ORG_A, "web")).map((row) => row.developerId)).not.toContain(stale);
    // Positive control: a row filed under its own id as an admin IS on the roster.
    t.w.db.set({ ...orgMemberKey(ORG_A, ZED), entityType: "ORG_MEMBER", orgId: ORG_A, developerId: ZED, role: "admin", joinedAt: "2026-10-01T00:00:00.000Z" });
    expect(await a.onRoster(ZED)).toBe(true);
  });

  it("F3: the roster is never listed or read member by member: a task's audience and a comparison read only the people that differ, and each person once per request", async () => {
    const t = setup();
    const ids = [t.task().taskId, t.task().taskId, t.task({ owner: ARJUN }).taskId, t.task({ people: [{ developerId: MIA, role: "denied" }] }).taskId];
    const sent: string[] = [];
    const counting = { ...t.table, documentClient: { send: async (command: unknown) => {
      const input = (command as { input?: { Key?: { pk?: string; sk?: string }; ExpressionAttributeValues?: Record<string, string> } }).input;
      sent.push(`${(command as { constructor: { name: string } }).constructor.name} ${input?.Key?.pk ?? input?.ExpressionAttributeValues?.[":pk"] ?? ""} ${input?.Key?.sk ?? input?.ExpressionAttributeValues?.[":prefix"] ?? ""}`);
      return t.w.db.send(command as never);
    } } };
    const memo = new Map<string, Promise<boolean>>();
    const read = await tableLessonAudiencePort(counting).read(ORG_A, ids, { memo });
    const [a, b, c, d] = ids.map((id) => read.get(id)!);
    // Reading the audiences of four tasks lists no roster and reads no member row at all.
    expect(sent.filter((line) => line.includes("MEMBER#"))).toEqual([]);
    const before = sent.length;
    // Priya's tasks compared with each other: Priya is named by both, so nobody is read.
    expect(await audienceWithin(a!, b!)).toBe(true);
    expect(await audienceWithin(b!, a!)).toBe(true);
    expect(await audienceWithin(a!, d!)).toBe(false); // d denies Mia, a does not
    expect(await audienceWithin(d!, a!)).toBe(true);
    expect(sent.length).toBe(before);
    // c is Arjun's: he is named on c but not on a, so exactly his org member row and his grant are read (two Gets, no Query), once however many comparisons.
    expect(await audienceWithin(c!, a!)).toBe(true); // Arjun holds a grant on web
    expect(await audienceWithin(c!, b!)).toBe(true);
    const reads = sent.slice(before);
    expect(reads).toHaveLength(2);
    expect(reads.every((line) => line.startsWith("GetCommand"))).toBe(true);
    expect(reads[0]).toContain("MEMBER#");
  });

  it("the port stops starting reads once it is told to stop (a timeout), and every read it starts carries the signal", async () => {
    const t = setup();
    const ids = Array.from({ length: 30 }, () => t.task().taskId);
    const abort = new AbortController();
    let started = 0;
    const seen: Array<AbortSignal | undefined> = [];
    const counting = { ...t.table, documentClient: { send: async (command: unknown, options?: { abortSignal?: AbortSignal }) => { seen.push(options?.abortSignal); if ((command as { constructor?: { name?: string } }).constructor?.name === "GetCommand") { started += 1; if (started === 4) abort.abort(); } return t.w.db.send(command as never); } } };
    const read = await tableLessonAudiencePort(counting).read(ORG_A, ids, { signal: abort.signal });
    expect(read.size).toBeLessThan(ids.length);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((signal) => signal === abort.signal)).toBe(true);
  });

  it("a roster read made after the deadline passes is refused, and a read in flight is given the signal", async () => {
    const t = setup();
    const made = t.task();
    const a = (await t.audienceOf(made.taskId))!;
    const abort = new AbortController();
    abort.abort();
    await expect(inAudience(a, MIA, abort.signal)).rejects.toThrow();
  });
});

describe("audience(T) is a subset of audience(P)", () => {
  const ON_ROSTER = new Set(ROSTER);
  const base = (over: Partial<LessonTaskAudience> = {}): LessonTaskAudience => ({ project: "web", denied: new Set(), extras: new Set([PRIYA]), orgWide: false, otherProjects: new Set(), onRoster: async (person) => ON_ROSTER.has(person), ...over });

  it("the reviewer's scenario: P denies Z, X runs an unshared T (nobody denied): Z can see T but not P, so T is not within P", async () => {
    const P = base({ denied: new Set([MIA]) });
    const T = base({ extras: new Set([ARJUN]) });
    expect(await audienceWithin(T, P)).toBe(false);
  });

  it("F2: P denies someone who is NOT on the roster (a Slack-channel member, an Auditor with a grant, a merged id) and T does not deny them: T is not within P; T that denies them too is", async () => {
    const stranger = "slack-channel-member";
    expect(ON_ROSTER.has(stranger)).toBe(false);
    expect(await audienceWithin(base(), base({ denied: new Set([stranger]) }))).toBe(false);
    expect(await audienceWithin(base({ denied: new Set([stranger]) }), base({ denied: new Set([stranger]) }))).toBe(true);
  });

  it("positive controls: T that also denies Z; T that denies more; project-wide T with project-wide P; a denial on T but not on P", async () => {
    expect(await audienceWithin(base({ denied: new Set([MIA]) }), base({ denied: new Set([MIA]) }))).toBe(true);
    expect(await audienceWithin(base({ denied: new Set([MIA, MAX]) }), base({ denied: new Set([MIA]) }))).toBe(true);
    expect(await audienceWithin(base(), base())).toBe(true);
    expect(await audienceWithin(base({ denied: new Set([MAX]) }), base())).toBe(true);
  });

  it("a different denial, a person named on T only, a wider share on T and a different project are all outside", async () => {
    expect(await audienceWithin(base({ denied: new Set([MAX]) }), base({ denied: new Set([MIA]) }))).toBe(false);
    expect(await audienceWithin(base({ extras: new Set([PRIYA, ZED]) }), base())).toBe(false);
    expect(await audienceWithin(base({ orgWide: true }), base())).toBe(false);
    expect(await audienceWithin(base({ otherProjects: new Set(["ops"]) }), base())).toBe(false);
    expect(await audienceWithin(base(), base({ project: "ops" }))).toBe(false);
  });

  it("what P names or shares with the company widens P: T may name the same people, or be inside a company-wide P", async () => {
    expect(await audienceWithin(base({ extras: new Set([PRIYA, ZED]) }), base({ extras: new Set([ZED]) }))).toBe(true);
    expect(await audienceWithin(base({ extras: new Set([ZED]) }), base({ orgWide: true }))).toBe(true);
    expect(await audienceWithin(base({ orgWide: true }), base({ orgWide: true }))).toBe(true);
    expect(await audienceWithin(base({ orgWide: true }), base({ orgWide: true, denied: new Set([MIA]) }))).toBe(false);
    // Another project's share is covered by the same share on P, or by a company-wide P.
    expect(await audienceWithin(base({ otherProjects: new Set(["ops"]) }), base({ otherProjects: new Set(["ops", "qa"]) }))).toBe(true);
    expect(await audienceWithin(base({ otherProjects: new Set(["ops"]) }), base({ orgWide: true }))).toBe(true);
  });

  it("end to end from the stored tasks", async () => {
    const t = setup();
    const p = (await t.audienceOf(t.task({ people: [{ developerId: MIA, role: "denied" }] }).taskId))!;
    const unshared = (await t.audienceOf(t.task({ owner: ARJUN }).taskId))!;
    const alsoDenies = (await t.audienceOf(t.task({ owner: ARJUN, people: [{ developerId: MIA, role: "denied" }] }).taskId))!;
    expect(await audienceWithin(unshared, p)).toBe(false);
    expect(await audienceWithin(alsoDenies, p)).toBe(true);
    const wide = (await t.audienceOf(t.task({ owner: ARJUN }).taskId))!;
    const wide2 = (await t.audienceOf(t.task().taskId))!;
    expect(await audienceWithin(wide, wide2)).toBe(true);
  });
});

// F3: the comparison asks only the people that DIFFER and must agree exactly with the full computation (the whole roster listed, the old rule) AND be sound against the session access itself
// (`agent-sessions/access.ts`): if the fast check says "within", then everyone who can open T really can open P.
describe("the fast comparison agrees with the full computation and with session access, on randomized small fixtures", () => {
  /** A small seeded generator (mulberry32), so a failure replays. */
  const rng = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const hex = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

  /** The OLD rule, run over the whole roster (every member listed): the reference the fast check must equal. */
  const reference = (inner: LessonTaskAudience, outer: LessonTaskAudience, roster: ReadonlySet<string>): boolean => {
    const within = (a: LessonTaskAudience, person: string): boolean => !a.denied.has(person) && (a.orgWide || roster.has(person) || a.extras.has(person));
    if (inner.project !== outer.project) return false;
    for (const person of outer.denied) if (!inner.denied.has(person)) return false;
    if (inner.orgWide && !outer.orgWide) return false;
    if (!outer.orgWide) for (const project of inner.otherProjects) if (!outer.otherProjects.has(project)) return false;
    for (const person of roster) if (!inner.denied.has(person) && !within(outer, person)) return false;
    for (const person of inner.extras) if (!within(outer, person)) return false;
    return true;
  };

  it("300+ random fixtures: fast === full roster computation, and fast implies 'everyone who can open T can open P' by the real session access", async () => {
    let compared = 0, within = 0, notWithin = 0;
    for (let fixture = 1; fixture <= 30; fixture += 1) {
      const next = rng(fixture * 7919);
      const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
      const w = sessionWorld();
      w.db.set({ ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT_REVISION" });
      w.db.set({ ...projectRevisionKey(ORG_A, "ops", 1), entityType: "PROJECT_REVISION" });
      const table = { documentClient: w.db, tableName: "state", now: () => 0 };
      // A pool of people: org members with every role (some with a grant on web, some on ops, some with a Slack-channel role on web only), and ghosts who are in no org.
      const pool: string[] = [];
      for (let n = 1; n <= 9; n += 1) {
        const id = hex(0x40 + n);
        pool.push(id);
        const role = pick(["owner", "admin", "member", "member", "member", "member", "auditor"] as const);
        w.member(ORG_A, id, role);
        if (next() < 0.55) w.grant(id, "web", pick(["maintainer", "contributor", "viewer"] as const));
        if (next() < 0.3) w.grant(id, "ops", pick(["contributor", "viewer"] as const));
        if (next() < 0.25) w.members.channel(ORG_A, "web", id);
      }
      const ghosts = [hex(0xa1), hex(0xa2)];
      const everyone = [...pool, ...ghosts, ...PEOPLE];
      // Tasks: owners, People lists (with denials), shares of every kind.
      const tasks: Array<{ taskId: string; sessionId: string; record: Parameters<typeof sessionLevelOf>[2] }> = [];
      for (let n = 0; n < 6; n += 1) {
        const people = Array.from({ length: Math.floor(next() * 4) }, () => ({ developerId: pick(everyone), role: pick(["denied", "denied", "viewer", "commenter", "owner"] as const) }));
        const made = w.seedSession({ owner: pick(pool), project: next() < 0.9 ? "web" : "ops", ...(next() < 0.2 ? { currentOwner: pick(pool) } : {}), ...(people.length > 0 ? { people } : {}) });
        if (next() < 0.25) w.seedShare(ORG_A, made.sessionId, { kind: "org" }, "view");
        if (next() < 0.25) w.seedShare(ORG_A, made.sessionId, { kind: "project", project: pick(["web", "ops"]) }, "view");
        for (let k = Math.floor(next() * 3); k > 0; k -= 1) w.seedShare(ORG_A, made.sessionId, { kind: "member", developerId: pick(everyone) }, "view");
        tasks.push({ taskId: made.taskId, sessionId: made.sessionId, record: made.record as never });
      }
      const audiences = new Map<string, LessonTaskAudience>();
      const memo = new Map<string, Promise<boolean>>();
      for (const task of tasks) audiences.set(task.taskId, (await resolveLessonTaskAudience(table, ORG_A, task.taskId, memo))!);
      const rosters: Record<string, ReadonlySet<string>> = {};
      for (const project of ["web", "ops"]) rosters[project] = new Set((await listProjectMembers(table, ORG_A, project)).map((row) => row.developerId));
      const deps = { documentClient: w.db, tableName: "state", now: () => 0, projectMembers: w.members };
      const opens = async (person: string, task: (typeof tasks)[number]): Promise<boolean> => (await sessionLevelOf(deps, { orgId: ORG_A, developerId: person }, task.record, {})) !== "none";
      for (const T of tasks) for (const P of tasks) {
        if (T === P) continue;
        const fast = await audienceWithin(audiences.get(T.taskId)!, audiences.get(P.taskId)!);
        // The reference lists the whole roster of the tasks' project (tasks of two projects answer false in both).
        expect(fast, `fixture ${String(fixture)}`).toBe(reference(audiences.get(T.taskId)!, audiences.get(P.taskId)!, rosters[audiences.get(T.taskId)!.project] ?? new Set()));
        compared += 1;
        if (fast) {
          within += 1;
          for (const person of everyone) if (await opens(person, T)) expect(await opens(person, P), `fixture ${String(fixture)}: a person who can open T can open P`).toBe(true);
        } else notWithin += 1;
      }
    }
    // Non-vacuous: both answers occur plenty of times.
    expect(compared).toBe(30 * 30);
    expect(within).toBeGreaterThan(30);
    expect(notWithin).toBeGreaterThan(30);
  }, 120_000);
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
// project-wide task, so a change to the record's audience (it must NOT be widened) fails here. (The lessons lane changed three Team record files, and only by ADDING things: `access-port.ts` carries a required `taskVisibility` port, `live-audience-port.ts` and `live-audience.ts` take an optional abort signal and a timeout given as a function. `acl.ts`, `task-visibility.ts` and the answers of `mayReadTask` and `verdictOf` are unchanged, and these tests pin them.)
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
    expect(await inAudience((await t.audienceOf(made.taskId))!, ARJUN)).toBe(true);
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
