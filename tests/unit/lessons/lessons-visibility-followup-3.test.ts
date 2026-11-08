// Lessons visibility follow-up, final round: the review's M1 (a scope cut at 300 characters must never read as repository-only), M2 / owner decision 36 (a lesson restricted only to project repository A loads into any
// project task, but is NAMED and PUBLISHED only in repository A itself), L1 (a PR comment by someone without a project role is never a member correction), L2 (a repository that was deleted or excluded stops
// converting at once) and L3 (lessons withheld because their source task is a legacy task with no session item are counted).
import { describe, expect, it } from "vitest";
import { createAccessCheckPort } from "../../../packages/broker/src/team-record/access-port.js";
import type { TaskVisibilityPort } from "../../../packages/broker/src/team-record/live-audience.js";
import { closeScope } from "../../../packages/broker/src/team-record/item-head.js";
import { CUT_SCOPE_PLACE, lessonPlaces, narrowestAudience, type Audience, type Lesson } from "../../../packages/broker/src/lessons/types.js";
import { repoOnlyScopes, tableProjectRepoScopes, viewedForLessons } from "../../../packages/broker/src/lessons/project-repo-audience.js";
import { ORG_A, addSource, githubDraft, world } from "../../support/team-record-core.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { projectRevisionKey } from "@agentx/contracts";
import { draft, lessonRecord } from "./lesson-helpers.js";
import { agentSessionKey } from "@agentx/contracts";
import { taskKey } from "../../../packages/broker/src/developer/task-records.js";
import { LegacyTaskNoSessionError, resolveLessonTaskAudience, tableLessonAudiencePort, withLessonAudiences } from "../../../packages/broker/src/lessons/task-audience.js";
import { createLessonLiveReader } from "../../../packages/broker/src/lessons/live-visibility.js";
import { ARJUN, ORG_A as WORLD_ORG, PRIYA, sessionWorld } from "../../support/agent-session-world.js";

const AT = "2026-11-08T00:00:00.000Z";
const repoAudience = (id: string): Audience => ({ kind: "restricted", acl: { source: "github", scope: `github:repo/${id}`, capturedAt: AT, liveCheck: "on_read" } });
const lessonOf = (audience: Audience, sourceScopes: string[] = []): Lesson => lessonRecord({ provenance: { ...draft().provenance, audience, sourceScopes } });

describe("M1: a scope cut at 300 characters never reads as repository-only", () => {
  // The reviewer's probe (lvfr-trunc.mts): 7 eight-digit and 7 nine-digit project repositories make 14 places of exactly 300 characters with their separators; another project's private repository sorts last
  // and used to be the part that was cut away.
  const project = [...Array.from({ length: 7 }, (_, i) => String(20000000 + i)), ...Array.from({ length: 7 }, (_, i) => String(300000000 + i))];
  const otherProjectRepo = "999999999";
  const projectRepos = new Set(project.map((id) => `github:repo/${id}`));
  const cut = narrowestAudience([...project, otherProjectRepo].map(repoAudience));

  it("the probe: the cut scope stays within the limit, ends with a place nobody matches, and is NOT judged project-wide", () => {
    expect(cut.kind).toBe("restricted");
    if (cut.kind !== "restricted") return;
    expect(cut.acl.scope.length).toBeLessThanOrEqual(300);
    expect(cut.acl.scope.endsWith(`+${CUT_SCOPE_PLACE}`)).toBe(true);
    const lesson = lessonOf(cut);
    expect(repoOnlyScopes(lesson)).toBeUndefined();
    expect(viewedForLessons(lesson, projectRepos).provenance.audience.kind).toBe("restricted");
  });

  it("positive control: the same fourteen places without the other project's repository are complete, short enough, and DO convert", () => {
    const whole = narrowestAudience(project.map(repoAudience));
    expect(whole.kind === "restricted" && whole.acl.scope.length).toBe(300);
    const lesson = lessonOf(whole);
    // Exactly at the limit a scope may have been cut elsewhere, so it is not believed; one place fewer is below it and converts.
    expect(viewedForLessons(lesson, projectRepos).provenance.audience.kind).toBe("restricted");
    const shorter = lessonOf(narrowestAudience(project.slice(1).map(repoAudience)));
    expect(repoOnlyScopes(shorter)).toHaveLength(13);
    expect(viewedForLessons(shorter, projectRepos).provenance.audience.kind).toBe("project");
  });

  it("a scope of the limit's length that carries no marker (stored before this fix, or cut elsewhere) is not believed either", () => {
    const places = project.map((id) => `github:repo/${id}`);
    const scope = places.join("+");
    expect(scope.length).toBe(300);
    const stored: Audience = { kind: "restricted", acl: { source: "github", scope, capturedAt: AT, liveCheck: "on_read" } };
    expect(repoOnlyScopes(lessonOf(stored))).toBeUndefined();
    expect(viewedForLessons(lessonOf(stored), projectRepos).provenance.audience.kind).toBe("restricted");
  });

  it("merging an already-cut scope with more places still ends in the marker, and the marker place matches no access record", async () => {
    const again = narrowestAudience([cut, repoAudience("888888888"), repoAudience("111111111")]);
    expect(again.kind === "restricted" && again.acl.scope.endsWith(`+${CUT_SCOPE_PLACE}`)).toBe(true);
    // The real access port: the marker place has no record, and it is one of the lesson's own restricted places, so a reader of nobody in particular is denied.
    const w = world();
    const team: TaskVisibilityPort = { read: async () => new Map() };
    const access = createAccessCheckPort(w.table, { taskVisibility: team });
    const places = lessonPlaces(lessonOf(cut));
    expect(places.restrictedScopes).toContain(CUT_SCOPE_PLACE);
    expect(await access.mayRead(ORG_A, undefined, [places])).toEqual([false]);
    expect(await access.mayRead(ORG_A, { principals: ["U1"], groups: [] }, [places])).toEqual([false]);
  });

  it("N3 positive control: a real place that has a record admits its reader; the same lesson with ONLY the cut marker added is denied to that same reader", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: "github:repo/9" });
    await w.sink.put(githubDraft());
    const access = createAccessCheckPort(w.table, { taskVisibility: { read: async () => new Map() } });
    const reader = { principals: ["123"], groups: [] };
    const real = { scopes: ["github:repo/9"], restrictedScopes: ["github:repo/9"], capturedAt: AT };
    const cutToo = { scopes: ["github:repo/9", CUT_SCOPE_PLACE], restrictedScopes: ["github:repo/9", CUT_SCOPE_PLACE], capturedAt: AT };
    // The record is real: it admits its reader and refuses a stranger (so the deny below is not "nothing is allowed here").
    expect(await access.mayRead(ORG_A, reader, [real])).toEqual([true]);
    expect(await access.mayRead(ORG_A, { principals: ["999"], groups: [] }, [real])).toEqual([false]);
    // Only the marker differs.
    expect(await access.mayRead(ORG_A, reader, [cutToo])).toEqual([false]);
  });
});

describe("L2: a repository that was deleted, transferred or excluded stops converting at once, while its pinned id is still in the project", () => {
  const repo = (name: string, id: number) => ({ name, url: `https://github.com/acme/${name}`, path: name, defaultBranch: "main", credentialRef: "github-app", githubRepositoryId: id, installationId: 5 });
  function pinned() {
    const db = new FakeDynamoDb();
    db.set({ ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT_REVISION", definition: { repositories: [repo("api", 9), repo("web", 10)] } });
    return db;
  }

  it("a closed place (the removal was queued, `closeScope`) is left out of the project's repositories; the open one stays; without the record table nothing changes", async () => {
    const w = world();
    const port = tableProjectRepoScopes({ documentClient: pinned(), tableName: "state" }, { record: w.table });
    expect([...await port.read(ORG_A, "web")].sort()).toEqual(["github:repo/10", "github:repo/9"]);
    await closeScope(w.table, ORG_A, "github:repo/9", "source_deleted", AT);
    expect([...await port.read(ORG_A, "web")]).toEqual(["github:repo/10"]);
    expect(await port.placeOf?.(ORG_A, "web", "api", 1)).toBeUndefined();
    expect(await port.placeOf?.(ORG_A, "web", "web", 1)).toBe("github:repo/10");
    // The old reader (no record table) is unchanged.
    expect([...await tableProjectRepoScopes({ documentClient: pinned(), tableName: "state" }).read(ORG_A, "web")].sort()).toEqual(["github:repo/10", "github:repo/9"]);
  });

  it("so a lesson restricted to the closed repository is restricted again (it stops loading) before any withdrawal has run; a marker that can't be read refuses the whole read", async () => {
    const w = world();
    const port = tableProjectRepoScopes({ documentClient: pinned(), tableName: "state" }, { record: w.table });
    const lesson = lessonOf(repoAudience("9"));
    expect(viewedForLessons(lesson, await port.read(ORG_A, "web")).provenance.audience.kind).toBe("project");
    await closeScope(w.table, ORG_A, "github:repo/9", "excluded", AT);
    expect(viewedForLessons(lesson, await port.read(ORG_A, "web")).provenance.audience.kind).toBe("restricted");
    const broken = { documentClient: { send: async () => { throw new Error("down"); } }, tableName: "record" };
    await expect(tableProjectRepoScopes({ documentClient: pinned(), tableName: "state" }, { record: broken }).read(ORG_A, "web")).rejects.toThrow();
  });
});

describe("L3: lessons withheld because their source task is a legacy task with no session item are counted apart", () => {
  const table = (w: ReturnType<typeof sessionWorld>) => ({ documentClient: w.db, tableName: "state", now: () => 1 });
  const learnedFrom = (id: string, taskId: string): Lesson => lessonRecord({ id, provenance: { ...draft().provenance, supportTasks: [taskId] } });

  it("the audience read tells 'no session item' (a legacy task) from a task that is gone, another company's, or unreadable", async () => {
    const w = sessionWorld();
    const legacy = w.seedSession({ owner: PRIYA });
    w.db.delete(agentSessionKey(WORLD_ORG, legacy.sessionId, "META"));
    await expect(resolveLessonTaskAudience(table(w), WORLD_ORG, legacy.taskId)).rejects.toBeInstanceOf(LegacyTaskNoSessionError);
    // A task row that never named a session (started before sessions): the same.
    const before = w.seedSession({ owner: PRIYA });
    const row = { ...(w.db.get(taskKey(before.taskId)) as Record<string, unknown>) };
    delete row.sessionId;
    w.db.set(row);
    await expect(resolveLessonTaskAudience(table(w), WORLD_ORG, before.taskId)).rejects.toBeInstanceOf(LegacyTaskNoSessionError);
    // Not legacy: a task that does not exist, and a task of another company, read as absent; a session that is not a task session is an ordinary failure.
    expect(await resolveLessonTaskAudience(table(w), WORLD_ORG, "11111111-1111-4111-8111-111111111111")).toBeUndefined();
    const foreign = w.seedSession({ owner: PRIYA, taskOrgId: "org_bbbbbbbbbbbbbbbbbbbb" });
    expect(await resolveLessonTaskAudience(table(w), WORLD_ORG, foreign.taskId)).toBeUndefined();
    const port = tableLessonAudiencePort(table(w));
    const legacySet = new Set<string>();
    const answer = await port.read(WORLD_ORG, [legacy.taskId, before.taskId, foreign.taskId, "11111111-1111-4111-8111-111111111111"], { legacy: legacySet });
    expect([...answer.values()].every((value) => value === undefined)).toBe(true);
    expect([...legacySet].sort()).toEqual([before.taskId, legacy.taskId].sort());
  });

  it("the live reader withholds such a lesson, counts it once, logs a fixed event, and does not count a lesson withheld for another reason", async () => {
    const w = sessionWorld();
    const legacy = w.seedSession({ owner: PRIYA });
    w.db.delete(agentSessionKey(WORLD_ORG, legacy.sessionId, "META"));
    const fine = w.seedSession({ owner: PRIYA });
    const narrowed = w.seedSession({ owner: PRIYA, people: [{ developerId: ARJUN, role: "denied" }] });
    const lines: Array<[string, Record<string, unknown>]> = [];
    const reader = createLessonLiveReader({
      port: withLessonAudiences({ read: async () => new Map() }, tableLessonAudiencePort(table(w))), key: { workspaceId: WORLD_ORG, project: "web" }, where: "view", log: (event, fields) => lines.push([event, fields]),
    });
    const lessons = [learnedFrom("les_legacy0001", legacy.taskId), learnedFrom("les_fine0000001", fine.taskId), learnedFrom("les_narrowed001", narrowed.taskId)];
    // Read as nobody in particular: a task with a People denial is withheld too, but it is not legacy.
    expect((await reader.keep(undefined, lessons)).map((lesson) => lesson.id)).toEqual(["les_fine0000001"]);
    expect((await reader.keep(undefined, lessons)).map((lesson) => lesson.id)).toEqual(["les_fine0000001"]);
    expect(reader.legacyWithheld()).toEqual(["les_legacy0001"]);
    expect(lines.filter(([event]) => event === "learning.view_legacy_task_withheld")).toEqual([["learning.view_legacy_task_withheld", { lessons: 1 }]]);
    expect(JSON.stringify(lines)).not.toContain(legacy.taskId);
    // A reader that shares its reads (the pull request description's second reader) reports the same lessons.
    expect(reader.withoutRunningTask().legacyWithheld()).toEqual(["les_legacy0001"]);
  });
});

describe("N1: the pull request's repository is matched by its GitHub repository id (stable across renames and revisions), never by name against the latest revision", () => {
  const repo = (name: string, id: number | undefined) => ({ name, url: `https://github.com/acme/${name}`, path: name, defaultBranch: "main", credentialRef: "github-app", ...(id === undefined ? {} : { githubRepositoryId: id }), installationId: 5 });
  const revisions = (...repositories: Array<Array<ReturnType<typeof repo>>>) => {
    const db = new FakeDynamoDb();
    repositories.forEach((list, i) => db.set({ ...projectRevisionKey(ORG_A, "web", i + 1), entityType: "PROJECT_REVISION", definition: { repositories: list } }));
    return tableProjectRepoScopes({ documentClient: db, tableName: "state" });
  };

  it("positive control: the same revision resolves the name to its place; a revision where the name is the same repository later still does", async () => {
    const port = revisions([repo("api", 9), repo("web", 10)], [repo("api", 9), repo("web", 10)]);
    expect(await port.placeOf?.(ORG_A, "web", "api", 1)).toBe("github:repo/9");
    expect(await port.placeOf?.(ORG_A, "web", "web", 1)).toBe("github:repo/10");
  });

  it("a repository renamed in a later revision is still the same repository (same id)", async () => {
    const port = revisions([repo("api", 9)], [repo("api-v2", 9)]);
    expect(await port.placeOf?.(ORG_A, "web", "api", 1)).toBe("github:repo/9");
  });

  it("a repository removed in a later revision is not the project's any more: unknown, so a lesson is only counted", async () => {
    const port = revisions([repo("api", 9), repo("web", 10)], [repo("web", 10)]);
    expect(await port.placeOf?.(ORG_A, "web", "api", 1)).toBeUndefined();
    expect(await port.placeOf?.(ORG_A, "web", "web", 1)).toBe("github:repo/10");
  });

  it("the same name on a DIFFERENT repository (a later revision replaced it) is not the pull request's repository", async () => {
    const port = revisions([repo("api", 9)], [repo("api", 11)]);
    expect(await port.placeOf?.(ORG_A, "web", "api", 1)).toBeUndefined();
    // and the pull request is in the new repository once its task started on the later revision
    expect(await port.placeOf?.(ORG_A, "web", "api", 2)).toBe("github:repo/11");
  });

  it("a missing id on either side, a missing revision, or a revision that does not exist is unknown", async () => {
    const noOld = revisions([repo("api", undefined)], [repo("api", 9)]);
    expect(await noOld.placeOf?.(ORG_A, "web", "api", 1)).toBeUndefined();
    const noNew = revisions([repo("api", 9)], [repo("api", undefined)]);
    expect(await noNew.placeOf?.(ORG_A, "web", "api", 1)).toBeUndefined();
    const fine = revisions([repo("api", 9)]);
    expect(await fine.placeOf?.(ORG_A, "web", "api")).toBeUndefined();
    expect(await fine.placeOf?.(ORG_A, "web", "api", 7)).toBeUndefined();
  });

  it("a closed place (deleted or excluded repository) stays unknown, as before", async () => {
    const w = world();
    const db = new FakeDynamoDb();
    db.set({ ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT_REVISION", definition: { repositories: [repo("api", 9)] } });
    const port = tableProjectRepoScopes({ documentClient: db, tableName: "state" }, { record: w.table });
    expect(await port.placeOf?.(ORG_A, "web", "api", 1)).toBe("github:repo/9");
    await closeScope(w.table, ORG_A, "github:repo/9", "source_deleted", AT);
    expect(await port.placeOf?.(ORG_A, "web", "api", 1)).toBeUndefined();
  });
});
