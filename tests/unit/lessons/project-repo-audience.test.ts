// Owner decision 34 (LESSON-PROJECT-REPOS-PROJECT-WIDE): a lesson restricted ONLY because its evidence came from a repository that belongs to the lesson's project counts as visible to the whole project for lessons;
// decisions 31 and 32 then apply as for any project-wide lesson. Any other restriction (a Slack channel, another project's repository, an explicit list, mixed places) stays restricted. The Team record's own
// access check is unchanged: these tests run the REAL access port over a record that restricts the repository, and pin that it still says "restricted" for the same places.
import { describe, expect, it } from "vitest";
import { createAccessCheckPort } from "../../../packages/broker/src/team-record/access-port.js";
import type { TaskVisibilityPort } from "../../../packages/broker/src/team-record/live-audience.js";
import { learnedContextFromRefs } from "../../../packages/broker/src/lessons/deliver.js";
import { loadLessonsForStage, type LoadDeps, type LoadRequest } from "../../../packages/broker/src/lessons/load.js";
import { mentionsRepoPlace, repoOnlyScopes, tableProjectRepoScopes, viewedForLessons, withProjectRepoScopes } from "../../../packages/broker/src/lessons/project-repo-audience.js";
import { promoteToRule } from "../../../packages/broker/src/lessons/promote.js";
import { readVisible } from "../../../packages/broker/src/lessons/read-visible.js";
import { InMemoryLessonStore, type LoadManifest } from "../../../packages/broker/src/lessons/store.js";
import { withLessonAudiences, type LessonTaskAudience } from "../../../packages/broker/src/lessons/task-audience.js";
import { lessonsUsedReaderOver } from "../../../packages/broker/src/lessons/used-in-pr.js";
import type { Audience, Lesson } from "../../../packages/broker/src/lessons/types.js";
import { ORG_A, addSource, githubDraft, world } from "../../support/team-record-core.js";
import { Audit, Clock, KEY, MemoryVectors, PROJECT, WS, draft, embedder, lessonRecord, seed, settings, wideAudience } from "./lesson-helpers.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { projectRevisionKey } from "@agentx/contracts";

const T1 = "2026-10-30T09:00:00.000Z";
const REPO = "github:repo/9";
const OTHER_REPO = "github:repo/77";
const SLACK = "slack:T1/C9";
const repoAudience = (scope = REPO, over: Record<string, unknown> = {}): Audience => ({ kind: "restricted", acl: { source: "github", scope, capturedAt: T1, liveCheck: "on_read", ...over } });
const slackAudience = (scope = SLACK): Audience => ({ kind: "restricted", acl: { source: "slack", scope, principals: ["U1"], capturedAt: T1, liveCheck: "none" } });
const lessonWith = (id: string, audience: Audience, sourceScopes: string[], tasks: string[] = ["task-src"]): Lesson =>
  lessonRecord({ id, type: "convention", tier: 1, approvals: [{ approvalId: "ap", by: "ann", at: 1, mode: "one" }], provenance: { ...draft().provenance, audience, sourceScopes, supportTasks: tasks } });

type RepoRead = () => Promise<ReadonlySet<string>>;
const projectHas = (...scopes: string[]): RepoRead => async () => new Set(scopes);

/** The real record core's access port over a world whose record restricts the repository (readers of the repository only, no list), and the lesson ports on top. */
async function setup(repos: RepoRead, tasks: Record<string, LessonTaskAudience | undefined> = {}) {
  const w = world();
  await addSource(w, { source: "github", scope: REPO });
  await w.sink.put(githubDraft({ audience: repoAudience() }));
  const team: TaskVisibilityPort = { read: async () => new Map() };
  const taskVisibility = withProjectRepoScopes(withLessonAudiences(team, { read: async (_org, ids) => new Map(ids.map((id) => [id, id in tasks ? tasks[id] : wideAudience()])) }), { read: () => repos() });
  const access = createAccessCheckPort(w.table, { taskVisibility });
  const store = new InMemoryLessonStore();
  const vectors = new MemoryVectors();
  const clock = new Clock();
  const deps: LoadDeps = { store, embedder, vectors, settings: settings(), access, audit: new Audit(), now: clock.now };
  const put = async (...lessons: Lesson[]) => {
    await seed(store, ...lessons);
    for (const l of lessons) await vectors.upsert(l.workspaceId, l.project, l.id, await embedder.embed(`${l.title}\n${l.description}\n${l.body}`), { status: l.status });
  };
  const request: LoadRequest = { workspaceId: WS, project: PROJECT, taskId: "task-run", stage: "IMPLEMENT", round: 1, intent: "Retry failed HTTP calls", repos: ["api"], files: [], languages: [], taskAudience: { kind: "shared" } };
  const loaded = async () => (await loadLessonsForStage(deps, request)).context?.lessons.map((l) => l.id);
  return { w, access, taskVisibility, store, deps, put, loaded, request };
}

describe("the shape that counts as 'readers of the project's own repositories'", () => {
  it("exactly: a restricted audience with no list, whose places are all repositories", () => {
    expect(repoOnlyScopes(lessonWith("les_shape0001", repoAudience(), [REPO]))).toEqual([REPO]);
    expect(repoOnlyScopes(lessonWith("les_shape0002", repoAudience(`${REPO}+${OTHER_REPO}`), [REPO]))).toEqual([REPO, OTHER_REPO]);
    // Not that shape: project-wide, a Slack channel, a list, a group, an empty list, a repository joined with any other place.
    expect(repoOnlyScopes(lessonWith("les_shape0003", { kind: "project" }, []))).toBeUndefined();
    expect(repoOnlyScopes(lessonWith("les_shape0004", slackAudience(), [SLACK]))).toBeUndefined();
    expect(repoOnlyScopes(lessonWith("les_shape0005", repoAudience(REPO, { principals: ["123"] }), [REPO]))).toBeUndefined();
    expect(repoOnlyScopes(lessonWith("les_shape0006", repoAudience(REPO, { groups: ["g"] }), [REPO]))).toBeUndefined();
    expect(repoOnlyScopes(lessonWith("les_shape0007", repoAudience(REPO, { principals: [] }), [REPO]))).toBeUndefined();
    expect(repoOnlyScopes(lessonWith("les_shape0008", repoAudience(`${REPO}+${SLACK}`), [REPO, SLACK]))).toBeUndefined();
  });

  it("viewedForLessons converts only when EVERY place is a repository the project has now; the original lesson is never changed", () => {
    const lesson = lessonWith("les_view00001", repoAudience(), [REPO, "rovara:task/task-src"]);
    const frozen = JSON.stringify(lesson);
    const seen = viewedForLessons(lesson, new Set([REPO]));
    expect(seen.provenance.audience).toEqual({ kind: "project" });
    expect(seen.provenance.sourceScopes).toEqual(["rovara:task/task-src"]);
    expect(JSON.stringify(lesson)).toBe(frozen);
    expect(viewedForLessons(lesson, new Set([OTHER_REPO]))).toBe(lesson);
    expect(viewedForLessons(lesson, new Set())).toBe(lesson);
    expect(viewedForLessons(lesson, undefined)).toBe(lesson);
    const two = lessonWith("les_view00002", repoAudience(`${REPO}+${OTHER_REPO}`), [REPO, OTHER_REPO]);
    expect(viewedForLessons(two, new Set([REPO]))).toBe(two);
    expect(viewedForLessons(two, new Set([REPO, OTHER_REPO])).provenance.audience).toEqual({ kind: "project" });
    // A project-wide lesson that names a project repository among its sources stops being asked about that place.
    const wide = lessonWith("les_view00003", { kind: "project" }, [REPO, SLACK]);
    expect(mentionsRepoPlace(wide)).toBe(true);
    expect(viewedForLessons(wide, new Set([REPO])).provenance.sourceScopes).toEqual([SLACK]);
    expect(mentionsRepoPlace(lessonWith("les_view00004", slackAudience(), [SLACK]))).toBe(false);
  });
});

describe("the Team record is unchanged", () => {
  it("the real access port still says 'restricted' for the repository's places: nobody in particular is refused, whatever the project's repositories are", async () => {
    const t = await setup(projectHas(REPO));
    const lesson = lessonWith("les_pin000001", repoAudience(), [REPO]);
    const places = { scopes: [REPO], restrictedScopes: [REPO], capturedAt: T1 };
    expect(await t.access.mayRead(ORG_A, undefined, [places])).toEqual([false]);
    // The lesson read path asks the same port about NO repository place for it (they are the project's own now), and the lesson is kept.
    expect((await readVisible({ access: t.access, key: KEY, viewer: undefined, lessons: [lesson], where: "t", running: { taskId: "task-run" } })).map((l) => l.id)).toEqual(["les_pin000001"]);
    // A place the record restricts and that is NOT the project's repository is still refused by it.
    const gone = await setup(projectHas());
    expect(await readVisible({ access: gone.access, key: KEY, viewer: undefined, lessons: [lessonWith("les_pin000002", repoAudience(REPO), [REPO])], where: "t", running: { taskId: "task-run" } })).toEqual([]);
  });
});

describe("a lesson from a PR comment in a private project repository", () => {
  const prLesson = lessonWith("les_prcomment1", repoAudience(), [REPO]);

  it("positive: it loads into a project task; the live task rules (decisions 31 and 32) still apply to it", async () => {
    const t = await setup(projectHas(REPO));
    await t.put(prLesson);
    expect(await t.loaded()).toEqual(["les_prcomment1"]);
    // Decision 31 still applies: the source task denies someone the running task shows it to, so the lesson is withheld.
    const narrowed = await setup(projectHas(REPO), { "task-src": wideAudience({ denied: new Set(["z"]) }) });
    await narrowed.put(prLesson);
    expect(await narrowed.loaded()).toBeUndefined();
  });

  it("negative control: the same lesson, with the repository NOT the project's, does not load (the rule is the repository, not the lesson)", async () => {
    const t = await setup(projectHas(OTHER_REPO));
    await t.put(prLesson);
    expect(await t.loaded()).toBeUndefined();
  });

  it("the repository is removed from the project: withheld, the next time it is read", async () => {
    let current = new Set([REPO]);
    const t = await setup(async () => current);
    await t.put(prLesson);
    expect(await t.loaded()).toEqual(["les_prcomment1"]);
    current = new Set();
    expect(await t.loaded()).toBeUndefined();
  });

  it("a lesson from ANOTHER project's repository is withheld", async () => {
    const t = await setup(projectHas(REPO));
    await t.put(lessonWith("les_otherrepo1", repoAudience(OTHER_REPO), [OTHER_REPO]));
    expect(await t.loaded()).toBeUndefined();
    // Learned from BOTH this project's repository and another's: only people who read both may see it, so it stays restricted.
    const both = await setup(projectHas(REPO));
    await both.put(lessonWith("les_bothrepos1", repoAudience(`${REPO}+${OTHER_REPO}`), [REPO, OTHER_REPO]));
    expect(await both.loaded()).toBeUndefined();
  });

  it("a mixed restriction (the repository and a Slack channel) is withheld, with or without a list", async () => {
    const t = await setup(projectHas(REPO));
    await t.put(lessonWith("les_mixednolst", repoAudience(`${REPO}+${SLACK}`), [REPO, SLACK]), lessonWith("les_mixedlist01", { kind: "restricted", acl: { source: "github", scope: `${REPO}+${SLACK}`, principals: [], capturedAt: T1, liveCheck: "none" } }, [REPO, SLACK]));
    expect(await t.loaded()).toBeUndefined();
  });

  it("an explicit list on the repository's place stays restricted; a Slack-only lesson stays restricted", async () => {
    const t = await setup(projectHas(REPO));
    await t.put(lessonWith("les_listed0001", repoAudience(REPO, { principals: ["123"] }), [REPO]), lessonWith("les_slackonly01", slackAudience(), [SLACK]));
    expect(await t.loaded()).toBeUndefined();
  });

  it("an unreadable project definition withholds (fail closed): a throwing read, a hung read, and a port that is not wired", async () => {
    const lines: Array<[string, Record<string, unknown>]> = [];
    const throwing = await setup(async () => { throw new Error("down"); });
    await throwing.put(prLesson);
    expect(await throwing.loaded()).toBeUndefined();
    expect(await readVisible({ access: throwing.access, key: KEY, viewer: undefined, lessons: [prLesson], where: "t", running: { taskId: "task-run" }, log: (event, fields) => { lines.push([event, fields]); } })).toEqual([]);
    expect(lines.some(([event, fields]) => event.endsWith("_audience_unreadable") && fields.reason === "project_repos_error")).toBe(true);
    // Not wired at all (an older wiring, a test stub).
    const t = await setup(projectHas(REPO));
    const bare = createAccessCheckPort(t.w.table, { taskVisibility: withLessonAudiences({ read: async () => new Map() }, { read: async (_o, ids) => new Map(ids.map((id) => [id, wideAudience()])) }) });
    expect(await readVisible({ access: bare, key: KEY, viewer: undefined, lessons: [prLesson], where: "t", running: { taskId: "task-run" } })).toEqual([]);
  });

  it("a person: the lessons tab and the digest read it through the same path, for a project member who can open the source task", async () => {
    const t = await setup(projectHas(REPO), { "task-src": wideAudience({ denied: new Set(["z"]) }) });
    const viewer = (developerId: string) => ({ principals: [], groups: [], developerId });
    expect((await readVisible({ access: t.access, key: KEY, viewer: viewer("ann"), lessons: [prLesson], where: "t" })).map((l) => l.id)).toEqual(["les_prcomment1"]);
    expect(await readVisible({ access: t.access, key: KEY, viewer: viewer("z"), lessons: [prLesson], where: "t" })).toEqual([]);
  });

  it("delivery: the dispatcher's read delivers it, and stops when the repository leaves the project", async () => {
    let current = new Set([REPO]);
    const t = await setup(async () => current);
    await t.put(prLesson);
    const deps = { store: t.store, settings: settings(), access: t.access, identity: async () => ({ principals: [], groups: [] }), now: t.deps.now };
    const refs = { v: 1 as const, orgId: WS, project: PROJECT, setVersion: 5, stage: "IMPLEMENT" as const, audience: { kind: "shared" as const }, taskId: "task-run", lessons: [{ id: "les_prcomment1", version: 1 }] };
    expect((await learnedContextFromRefs(deps, refs))?.lessons.map((l) => l.id)).toEqual(["les_prcomment1"]);
    current = new Set();
    expect(await learnedContextFromRefs(deps, refs)).toBeUndefined();
  });

  it("the pull request list counts it, and names it only for a private repository with every source task open to the project", async () => {
    const t = await setup(projectHas(REPO));
    await t.put(prLesson);
    const manifest: LoadManifest = { taskId: "task-run", workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1, lessons: [{ id: "les_prcomment1", version: 1, score: 0.5, why: "scope", citation: "valid" }], bytes: 10 };
    await t.store.putManifest(manifest);
    const names = { memberName: async () => undefined, isErased: async () => false } as never;
    const input = { orgId: WS, project: PROJECT, taskId: "task-run", pageUrl: "https://app.example.test/review/x/task" };
    const read = lessonsUsedReaderOver({ store: t.store, settings: settings(), access: t.access, names, visibility: async () => "private" });
    expect(await read(input)).toMatchObject({ count: 1, items: [{ id: "les_prcomment1" }] });
    const removed = lessonsUsedReaderOver({ store: t.store, settings: settings(), access: (await setup(projectHas())).access, names, visibility: async () => "private" });
    expect(await removed(input)).toBeUndefined();
  });

  it("promote: a repository-restricted lesson is promoted as a project-wide one (and refused when the repository is not the project's)", async () => {
    const a = { ...(await setup(projectHas(REPO))) };
    const b = { ...(await setup(projectHas())) };
    await a.put(prLesson);
    await b.put(prLesson);
    const base = { directory: { eligibility: async () => ({ complete: true, eligibleIds: ["owner"], ownerIds: ["owner"] }) }, settings: settings(), now: () => 1, audit: new Audit() };
    const attempt = async (t: typeof a) => promoteToRule({ ...base, store: t.store, taskVisibility: t.taskVisibility } as never, { workspaceId: WS, project: PROJECT, lessonId: "les_prcomment1", approverId: "owner" });
    expect(await attempt(b)).toEqual({ ok: false, code: "restricted" });
    expect(await attempt(a)).not.toEqual({ ok: false, code: "restricted" });
  });
});

describe("the project's repositories, read from the project definition", () => {
  const project = (repositories: unknown[]) => {
    const db = new FakeDynamoDb();
    db.set({ ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT_REVISION", definition: { repositories } });
    return tableProjectRepoScopes({ documentClient: db, tableName: "state" });
  };
  const repo = (name: string, over: Record<string, unknown> = {}) => ({ name, url: `https://github.com/acme/${name}`, path: name, defaultBranch: "main", credentialRef: "github-app", ...over });

  it("GitHub repositories by their pinned id; meta-only repositories, unpinned ones and other hosts are not counted", async () => {
    const scopes = await project([
      repo("api", { githubRepositoryId: 9, installationId: 5 }),
      repo("web", { host: { kind: "github", repositoryId: 10, installationId: 5 } }),
      repo("meta", { githubRepositoryId: 11, installationId: 5, role: "meta" }),
      repo("loose"),
      repo("other", { host: { kind: "examplehost", ref: "x1" } }),
    ]).read(ORG_A, "web");
    expect([...scopes].sort()).toEqual(["github:repo/10", "github:repo/9"]);
  });

  it("a project with no revision, or a definition without repositories, throws (unreadable)", async () => {
    await expect(tableProjectRepoScopes({ documentClient: new FakeDynamoDb(), tableName: "state" }).read(ORG_A, "web")).rejects.toThrow();
    const db = new FakeDynamoDb();
    db.set({ ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT_REVISION", definition: {} });
    await expect(tableProjectRepoScopes({ documentClient: db, tableName: "state" }).read(ORG_A, "web")).rejects.toThrow();
  });

  it("the latest revision decides: a repository dropped in a newer revision is no longer the project's", async () => {
    const db = new FakeDynamoDb();
    db.set({ ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT_REVISION", definition: { repositories: [repo("api", { githubRepositoryId: 9, installationId: 5 })] } });
    db.set({ ...projectRevisionKey(ORG_A, "web", 2), entityType: "PROJECT_REVISION", definition: { repositories: [repo("web", { githubRepositoryId: 10, installationId: 5 })] } });
    expect([...await tableProjectRepoScopes({ documentClient: db, tableName: "state" }).read(ORG_A, "web")]).toEqual(["github:repo/10"]);
  });
});

