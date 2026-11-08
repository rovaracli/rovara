// Owner decisions 31 and 32, checked against the REAL session access (`agent-sessions/access.ts`) on seeded random companies (fix round 3 re-check, G1; the reviewer's scratch test, folded in).
//
// 60 seeded setups, each with: org members of every role; grants on two projects; Slack-channel roles on BOTH projects; a removed member whose grant row is still there; a member filed under a merged-away id;
// an org-wide share at view, use or edit; several project shares; member shares at every level; People lists with denials, viewers, commenters and owners; a taken-over task; one task with an unreadable People list.
// For every task and every person (and every pair of tasks), the audience rules are only ever NARROWER than what the session access says:
//   - `inAudience(T, x)` true  =>  x opens T;                                  (person mode, decision 31)
//   - `openToWholeProject(T)` and x on the roster  =>  x opens T;              (decision 32)
//   - `audienceWithin(T, P)` true  =>  everyone who opens T opens P;           (agent mode, decision 31)
// and the same three, end to end through the live reader (one reader shared by every viewer of a setup) against the real State-table port. A task whose People list cannot be read is unknown, and every lesson that
// names it is withheld in all three modes.
import { describe, expect, it } from "vitest";
import { projectRevisionKey } from "@agentx/contracts";
import { sessionLevelOf } from "../../../packages/broker/src/agent-sessions/access.js";
import { createProjectMembers, listProjectMembers } from "../../../packages/broker/src/org/project-members.js";
import { createLessonLiveReader } from "../../../packages/broker/src/lessons/live-visibility.js";
import { audienceWithin, inAudience, openToWholeProject, resolveLessonTaskAudience, tableLessonAudiencePort, withLessonAudiences, type LessonTaskAudience } from "../../../packages/broker/src/lessons/task-audience.js";
import type { TaskVisibilityPort } from "../../../packages/broker/src/team-record/live-audience.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { ORG_A, sessionWorld } from "../../support/agent-session-world.js";
import { lessonRecord } from "./lesson-helpers.js";

/** A small seeded generator (mulberry32), so a failure replays. */
const rng = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const hex = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const team: TaskVisibilityPort = { read: async () => new Map() };
const lessonFrom = (id: string, tasks: string[]): Lesson =>
  lessonRecord({ id, type: "convention", tier: 1, approvals: [{ approvalId: "ap", by: "ann", at: 1, mode: "one" }], provenance: { ...lessonRecord().provenance, supportTasks: tasks } });

interface Seen { audienceChecks: number; personYes: number; personNo: number; wholeYes: number; withinYes: number; withinNo: number; readerPerson: number; readerNobody: number; readerAgent: number; unreadableChecked: number }

describe("the audience rules are never wider than session access (randomized, against the real access code)", () => {
  const fresh = (): Seen => ({ audienceChecks: 0, personYes: 0, personNo: 0, wholeYes: 0, withinYes: 0, withinNo: 0, readerPerson: 0, readerNobody: 0, readerAgent: 0, unreadableChecked: 0 });

  async function oneSetup(fixture: number, real: boolean, seen: Seen): Promise<void> {
    const next = rng(fixture * 104729 + 13 + (real ? 7 : 0));
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
    const w = sessionWorld();
    w.db.set({ ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT_REVISION" });
    w.db.set({ ...projectRevisionKey(ORG_A, "ops", 1), entityType: "PROJECT_REVISION" });
    const table = { documentClient: w.db, tableName: "state", now: () => 0 };
    const pool: string[] = [];
    const channel = new Set<string>();
    for (let n = 1; n <= 10; n += 1) {
      const id = hex(0x40 + n);
      pool.push(id);
      w.member(ORG_A, id, pick(["owner", "admin", "member", "member", "member", "auditor"] as const));
      if (next() < 0.5) w.grant(id, "web", pick(["maintainer", "contributor", "viewer"] as const));
      if (next() < 0.4) w.grant(id, "ops", pick(["contributor", "viewer"] as const));
      for (const project of ["web", "ops"]) if (next() < 0.25) { w.members.channel(ORG_A, project, id); channel.add(`${project}|${id}`); }
    }
    // A removed member (a grant row with no org member row), and one filed under a merged-away id (merged into a pool member).
    const removed = hex(0xa1);
    const merged = hex(0xa2);
    w.grant(removed, "web", "contributor");
    w.grant(merged, "web", "contributor");
    const mergedInto = pick(pool);
    const ghosts = [removed, merged, hex(0xa3)];
    const everyone = [...pool, ...ghosts];

    const tasks: Array<{ taskId: string; record: Parameters<typeof sessionLevelOf>[2]; readable: boolean }> = [];
    for (let n = 0; n < 7; n += 1) {
      const people = Array.from({ length: Math.floor(next() * 5) }, () => ({ developerId: pick(everyone), role: pick(["denied", "denied", "viewer", "commenter", "owner"] as const) }));
      const made = w.seedSession({ owner: pick(everyone), project: next() < 0.75 ? "web" : "ops", ...(next() < 0.25 ? { currentOwner: pick(pool) } : {}), ...(people.length > 0 ? { people } : {}) });
      if (next() < 0.2) w.seedShare(ORG_A, made.sessionId, { kind: "org" }, pick(["view", "use", "edit"] as const));
      for (let k = Math.floor(next() * 2.5); k > 0; k -= 1) w.seedShare(ORG_A, made.sessionId, { kind: "project", project: pick(["web", "ops"]) }, pick(["view", "use"] as const));
      for (let k = Math.floor(next() * 3); k > 0; k -= 1) w.seedShare(ORG_A, made.sessionId, { kind: "member", developerId: pick(everyone) }, pick(["view", "use", "edit"] as const));
      tasks.push({ taskId: made.taskId, record: made.record as never, readable: true });
    }
    // One task whose People list cannot be read: unknown for lessons (and a denial for everyone in session access).
    const garbled = w.seedSession({ project: "web" });
    w.db.set({ pk: `DEVTASK#${garbled.taskId}`, sk: "PEOPLE", schemaVersion: 7, people: "garbled" });
    tasks.push({ taskId: garbled.taskId, record: garbled.record as never, readable: false });

    // The access side. `real`: the real project-members reads (a merged id follows its survivor, a Slack channel is a function of the setup); else the fake with channel roles.
    const projectMembers = real
      ? createProjectMembers({ documentClient: w.db, tableName: "state", developerRecord: async (id) => (id === merged ? { mergedInto } : undefined), channelAccess: async (_org, project, id) => channel.has(`${project}|${id}`), channelProjects: async (_org, id) => ["web", "ops"].filter((project) => channel.has(`${project}|${id}`)) })
      : w.members;
    const deps = { documentClient: w.db, tableName: "state", now: () => 0, projectMembers };
    const openedCache = new Map<string, Promise<boolean>>();
    const opens = (person: string, task: (typeof tasks)[number]): Promise<boolean> => {
      const cacheKey = `${person}|${task.taskId}`;
      let found = openedCache.get(cacheKey);
      if (found === undefined) { found = sessionLevelOf(deps, { orgId: ORG_A, developerId: person }, task.record, {}).then((level) => level !== "none"); openedCache.set(cacheKey, found); }
      return found;
    };

    const memo = new Map<string, Promise<boolean>>();
    const audiences = new Map<string, LessonTaskAudience>();
    for (const task of tasks) {
      if (!task.readable) { await expect(resolveLessonTaskAudience(table, ORG_A, task.taskId, memo)).rejects.toThrow(); continue; }
      audiences.set(task.taskId, (await resolveLessonTaskAudience(table, ORG_A, task.taskId, memo))!);
    }
    const label = `fixture ${String(fixture)}${real ? " (real members)" : ""}`;
    const roster = new Set((await listProjectMembers(table, ORG_A, "web")).map((row) => row.developerId));

    // The rules on their own.
    for (const task of tasks.filter((t) => t.readable)) {
      const audience = audiences.get(task.taskId)!;
      seen.audienceChecks += 1;
      // People who can call at all: the org's current members. (A removed or merged-away id that a task still NAMES is in its audience by name, but cannot ask for anything.)
      for (const person of pool) {
        if (await inAudience(audience, person)) { seen.personYes += 1; expect(await opens(person, task), `${label}: inAudience(${person.slice(0, 4)}) but the session is closed to them`).toBe(true); } else seen.personNo += 1;
      }
      if (openToWholeProject(audience)) {
        seen.wholeYes += 1;
        for (const person of pool) if (await audience.onRoster(person)) expect(await opens(person, task), `${label}: on the roster of an open task but cannot open it`).toBe(true);
      }
      for (const other of tasks.filter((t) => t.readable && t !== task)) {
        if (await audienceWithin(audience, audiences.get(other.taskId)!)) {
          seen.withinYes += 1;
          for (const person of everyone) if (await opens(person, task)) expect(await opens(person, other), `${label}: within, but ${person.slice(0, 4)} opens T and not P`).toBe(true);
        } else seen.withinNo += 1;
      }
    }

    // The live reader over the real State-table port, ONE reader per mode for the whole setup (so the answers it remembers are asked for many viewers).
    const port = withLessonAudiences(team, tableLessonAudiencePort(table));
    const key = { workspaceId: ORG_A, project: "web" };
    const lessonsOf = tasks.map((task, index) => ({ task, lesson: lessonFrom(`les_t${String(index).padStart(7, "0")}`, [task.taskId]) }));
    const persons = createLessonLiveReader({ port, key, where: "soundness" });
    for (const person of pool) {
      const kept = new Set((await persons.keep({ developerId: person }, lessonsOf.map((entry) => entry.lesson))).map((lesson) => lesson.id));
      for (const { task, lesson } of lessonsOf) {
        if (kept.has(lesson.id)) { seen.readerPerson += 1; expect(task.readable, `${label}: an unreadable task's lesson was kept for a person`).toBe(true); expect(await opens(person, task), `${label}: lesson kept for a person who cannot open its task`).toBe(true); }
      }
    }
    const nobody = createLessonLiveReader({ port, key, where: "soundness" });
    const keptForNobody = new Set((await nobody.keep(undefined, lessonsOf.map((entry) => entry.lesson))).map((lesson) => lesson.id));
    for (const { task, lesson } of lessonsOf) {
      if (!keptForNobody.has(lesson.id)) continue;
      seen.readerNobody += 1;
      expect(task.readable, `${label}: an unreadable task's lesson was kept for nobody in particular`).toBe(true);
      // Decision 32: in the lesson's own project, and open to everyone on that project's roster.
      expect(audiences.get(task.taskId)!.project, label).toBe("web");
      for (const person of roster) expect(await opens(person, task), `${label}: kept for the project, but a roster member cannot open the task`).toBe(true);
    }
    for (const running of tasks) {
      const agent = createLessonLiveReader({ port, key, where: "soundness", running: { taskId: running.taskId } });
      const keptForAgent = new Set((await agent.keep(undefined, lessonsOf.map((entry) => entry.lesson))).map((lesson) => lesson.id));
      for (const { task, lesson } of lessonsOf) {
        if (!keptForAgent.has(lesson.id)) continue;
        seen.readerAgent += 1;
        expect(running.readable && task.readable, `${label}: a lesson was kept although the running task or its source task is unreadable`).toBe(true);
        for (const person of everyone) if (await opens(person, running)) expect(await opens(person, task), `${label}: agent mode kept a lesson that someone who can see the running task cannot see`).toBe(true);
      }
    }
    // The unreadable task: every lesson that names it is withheld in all three modes.
    const unreadable = lessonsOf.find((entry) => !entry.task.readable)!;
    const lone = [unreadable.lesson];
    expect(await createLessonLiveReader({ port, key, where: "soundness" }).keep(undefined, lone), label).toEqual([]);
    expect(await createLessonLiveReader({ port, key, where: "soundness" }).keep({ developerId: pool[0]! }, lone), label).toEqual([]);
    expect(await createLessonLiveReader({ port, key, where: "soundness", running: { taskId: tasks[0]!.taskId } }).keep(undefined, lone), label).toEqual([]);
    seen.unreadableChecked += 3;
  }

  /** Every rule said yes and no many times, in every mode: the checks above are not vacuous. */
  const nonVacuous = (seen: Seen): void => {
    expect(seen.audienceChecks).toBeGreaterThan(300);
    expect(seen.personYes).toBeGreaterThan(150);
    expect(seen.personNo).toBeGreaterThan(150);
    expect(seen.wholeYes).toBeGreaterThan(50);
    expect(seen.withinYes).toBeGreaterThan(25);
    expect(seen.withinNo).toBeGreaterThan(25);
    expect(seen.readerPerson).toBeGreaterThan(50);
    expect(seen.readerNobody).toBeGreaterThan(15);
    expect(seen.readerAgent).toBeGreaterThan(25);
    expect(seen.unreadableChecked).toBe(180);
  };

  it("60 seeded setups with the fake project members (Slack-channel roles on both projects, a removed member's stale grant)", async () => {
    const seen = fresh();
    for (let fixture = 1; fixture <= 60; fixture += 1) await oneSetup(fixture, false, seen);
    nonVacuous(seen);
  }, 280_000);

  it("the same 60 setups with the real project-members reads (a merged-away id follows its survivor; channels come from the setup)", async () => {
    const seen = fresh();
    for (let fixture = 1; fixture <= 60; fixture += 1) await oneSetup(fixture, true, seen);
    nonVacuous(seen);
  }, 280_000);
});
