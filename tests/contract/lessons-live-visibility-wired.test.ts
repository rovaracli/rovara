// Owner decisions 31, 32, 34 and 36, end to end on a REAL wired install: `installLessons` builds the runtime with the production ports (`tableTaskVisibilityPort` + `tableLessonAudiencePort` + the project's repository
// scopes), and the dispatcher (`learnedContextForOperation`) loads lessons for a running task.
//
// Every task, session, share and project revision here is written by the production writers, not by `db.set`: a task is started through the real developer route (`POST /v1/dev/tasks`, which writes the task row and its
// session items in the start transaction), a share goes through the real share route (`PUT /v1/app/sessions/{id}/shares`), and the project is registered through the admin route. The ONE exception is a task's
// People list (a "denied" entry): its writer is bound to a Slack thread and a proof of the person's channel membership (`changeTaskPeople`), so the row is written in the exact shape that writer produces (the same
// shape `tests/contract/task-people.test.ts` seeds), and the second project revision that pins a repository is written as the project revision item.
// The point is the keys: the task id, org and project the dispatcher passes are the exact keys `task-audience.ts` reads. If a key drifted, the live check would hide every lesson and learning would switch itself
// off silently; the positive controls here fail then. The other cases show the check really runs (a narrowed source task hides its lesson; an unreadable or legacy one fails closed) for the AGENT (the dispatcher and
// delivery), for a PERSON (the Lessons tab) and for the pull request's "Lessons used" list, with a lesson restricted only to a project repository (decisions 34 and 36).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentSessionKey, projectMemberKey, projectRevisionKey } from "@rovara-code/contracts";
import { orgMetaKey } from "@agentx/cloud-contracts";
import { installLessons } from "../../packages/broker/src/aws/broker/lessons-wiring.js";
import { learnedContextForOperation } from "../../packages/broker/src/aws/broker/lessons-dispatch.js";
import { createLessonDelivery } from "../../packages/broker/src/lessons/delivery-wiring.js";
import { buildLessonsView } from "../../packages/broker/src/lessons/view.js";
import { lessonsUsedForTask, lessonsUsedReaderOver } from "../../packages/broker/src/lessons/used-in-pr.js";
import { closeScope } from "../../packages/broker/src/team-record/item-head.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { lessonRecord } from "../unit/lessons/lesson-helpers.js";

const ON = { LEARNED_LESSONS_ENABLED: "1" };
const ZED: Developer = { developerId: "f".repeat(64), name: "Zed Park", provider: "oidc", sessionId: "s-zed" };
const ADMIN: Developer = { developerId: "9".repeat(64), name: "Ada Admin", provider: "oidc", sessionId: "s-ada" };
const definition = { repositories: [{ name: "api", url: "https://github.com/acme/api" }] } as never;
const REPO_PLACE = "github:repo/9";
const pinnedRepo = (name: string, id: number) => ({ name, url: `https://github.com/acme/${name}`, path: name, defaultBranch: "main", credentialRef: "github-app", githubRepositoryId: id, installationId: 5 });
const at = "2026-11-08T00:00:00.000Z";

async function install() {
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
  const roster = (who: Developer, grant = true) => {
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role: who === ADMIN ? "admin" : "member" });
    if (grant && who !== ADMIN) h.db.set({ ...projectMemberKey(TEST_ORG, who.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: "payments", grantId: randomUUID(), role: "developer", projectRole: "contributor" });
  };
  // MAYA and OMAR are contributors on the project (its roster); ZED is in the company with NO role on the project; ADMIN is a company admin (decides lessons).
  roster(MAYA); roster(OMAR); roster(ZED, false); roster(ADMIN);
  // The company's approval-tracking marker, as a company that has run for a while has it: without it the approver roster is "incomplete" and nobody may decide a lesson.
  h.db.set({ ...(h.db.get(orgMetaKey(TEST_ORG)) as Record<string, unknown>), approvalMembershipVersion: 1, approvalTrackingSince: "2026-10-01T00:00:00.000Z" });
  const dependencies = {
    documentClient: h.db, tableName: "state", agents: {}, developer: { signInTableName: "signin" }, artifactBucketName: "artifacts", s3: { send: async () => ({}) },
    teamRecord: { table: { documentClient: h.db, tableName: "record" }, edition: "public", emitter: { sendBack: async () => undefined }, taskVisibility: async () => ({ kind: "shared" }) },
  } as Record<string, unknown>;
  installLessons(dependencies as never);
  const runtime = dependencies.lessons as {
    store: { setVersion(key: unknown): Promise<number>; commit(key: unknown, version: number, lessons: unknown[], by: number): Promise<unknown> };
    routes: Parameters<typeof buildLessonsView>[0];
  };
  const key = { workspaceId: TEST_ORG, project: "payments" };

  /** A task started through the real route, by `who`: the task row and its session items come from the start transaction. */
  const start = async (who: Developer) => {
    const reply = await h.dev(who, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Retry failed HTTP calls", client: "test-client" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const task = reply.body.task as { taskId: string; sessionId: string };
    expect(h.db.get(agentSessionKey(TEST_ORG, task.sessionId, "META")), "the start wrote the session").toBeDefined();
    return { taskId: task.taskId, sessionId: task.sessionId };
  };
  /** A share through the real share route. */
  const share = async (owner: Developer, sessionId: string, principal: Record<string, unknown>, level = "view") => {
    const reply = await h.dev(owner, "PUT", `/v1/app/sessions/${sessionId}/shares`, { requestId: randomUUID(), principal, level });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  };
  /** The task's People list, in the shape its (Slack-bound) writer produces. */
  const deny = (taskId: string, who: Developer) => h.db.set({
    pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [{ developerId: who.developerId, slackUserId: "U0PERSON00", name: who.name, role: "denied" }],
  });
  /** A live lesson (one person approved it) learned from `sources`; `restrictedTo` restricts it to the readers of one repository, the way capture writes a code-host row. */
  const teach = async (id: string, sources: string[], restrictedTo?: string): Promise<void> => {
    const base = lessonRecord().provenance;
    const lesson = lessonRecord({
      id, workspaceId: TEST_ORG, project: "payments", type: "convention", tier: 1, stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"], approvals: [{ approvalId: "ap", by: "ann", at: 1, mode: "one" }],
      provenance: { ...base, supportTasks: sources, ...(restrictedTo === undefined ? {} : { audience: { kind: "restricted", acl: { source: "github", scope: restrictedTo, capturedAt: at, liveCheck: "on_read" } }, sourceScopes: [restrictedTo] }) },
    });
    await runtime.store.commit(key, await runtime.store.setVersion(key), [lesson], 1);
  };
  /** The dispatcher's call for the running task `taskId`, with the task row read back as the broker would read it, and the delivery asked again from the refs it stored. */
  const dispatch = async (taskId: string) => {
    const task = { ...(h.db.get(taskKey(taskId)) as object), workflow: { revision: 1 } } as never;
    const result = await learnedContextForOperation(dependencies, { orgId: TEST_ORG, task, workflowMode: "IMPLEMENT", definition }, ON);
    if (result.learnedRefs !== undefined) {
      const delivered = await createLessonDelivery({ documentClient: h.db, stateTable: "state", recordTable: "record", enabled: () => true })!(result.learnedRefs);
      expect(delivered?.lessons.map((lesson) => lesson.id), "delivery follows the load").toEqual(result.learnedRefs.lessons.map((lesson) => lesson.id));
    }
    return result.learnedRefs?.lessons.map((lesson) => lesson.id);
  };
  /** What the Lessons tab shows `who` (a person's path): the ids of the active lessons, and the count held for legacy tasks. */
  const tab = async (who: Developer) => {
    const view = await buildLessonsView(runtime.routes, { orgId: TEST_ORG, developerId: who.developerId }, "payments");
    return { active: view.active.map((lesson) => lesson.id), legacyHeld: view.legacyHeld, hidden: view.hidden };
  };
  /** The project's repositories: a new revision that pins them. */
  const pin = (revision: number, ...repositories: ReturnType<typeof pinnedRepo>[]) => h.db.set({ ...projectRevisionKey(TEST_ORG, "payments", revision), entityType: "PROJECT_REVISION", definition: { name: "payments", revision, repositories } });
  return { h, dependencies, runtime, key, start, share, deny, teach, dispatch, tab, pin };
}

describe("a wired install loads a lesson into a task whose records are written by the real start and share routes", () => {
  it("positive control: a lesson from a project-wide task loads into another project-wide task of the same project", async () => {
    const t = await install();
    const source = await t.start(MAYA), running = await t.start(OMAR);
    await t.teach("les_wired0001", [source.taskId]);
    expect(await t.dispatch(running.taskId)).toEqual(["les_wired0001"]);
  });

  it("the check really runs: a source task that denies a person the running task lets in hides the lesson; the same lesson loads once the running task denies them too", async () => {
    const t = await install();
    const source = await t.start(MAYA);
    t.deny(source.taskId, ZED);
    await t.teach("les_wired0002", [source.taskId]);
    const open = await t.start(OMAR);
    expect(await t.dispatch(open.taskId)).toBeUndefined();
    const alsoDenies = await t.start(OMAR);
    t.deny(alsoDenies.taskId, ZED);
    expect(await t.dispatch(alsoDenies.taskId)).toEqual(["les_wired0002"]);
  });

  it("a running task shared (through the share route) with a person the source task is not, stays out; sharing the source with them too lets it in (decision 31)", async () => {
    const t = await install();
    const source = await t.start(MAYA), running = await t.start(OMAR);
    await t.share(OMAR, running.sessionId, { kind: "member", developerId: ZED.developerId });
    await t.teach("les_wired0003", [source.taskId]);
    // ZED can open the running task but not the source (he has no role on the project): the lesson stays out.
    expect(await t.dispatch(running.taskId)).toBeUndefined();
    await t.share(MAYA, source.sessionId, { kind: "member", developerId: ZED.developerId });
    expect(await t.dispatch(running.taskId)).toEqual(["les_wired0003"]);
  });

  it("fails closed with the real reads: a source task with no session item, another company's source task, and a running task whose session is missing load nothing", async () => {
    const t = await install();
    const noSession = await t.start(MAYA);
    t.h.db.delete(agentSessionKey(TEST_ORG, noSession.sessionId, "META"));
    const running = await t.start(OMAR);
    await t.teach("les_wired0004", [noSession.taskId]);
    const foreign = await t.start(MAYA);
    t.h.db.set({ ...(t.h.db.get(taskKey(foreign.taskId)) as object), orgId: "org_bbbbbbbbbbbbbbbbbbbb" });
    await t.teach("les_wired0005", [foreign.taskId]);
    expect(await t.dispatch(running.taskId)).toBeUndefined();
    const noSessionRunning = await t.start(OMAR);
    t.h.db.delete(agentSessionKey(TEST_ORG, noSessionRunning.sessionId, "META"));
    const fine = await t.start(MAYA);
    await t.teach("les_wired0006", [fine.taskId]);
    expect(await t.dispatch(noSessionRunning.taskId)).toBeUndefined();
  });
});

describe("a person reads the same lessons through the Lessons tab (decision 31, the person rule)", () => {
  it("a project member who can open the source task sees the lesson; a person its People list denies does not; a legacy source task holds it back and the deciders are told how many", async () => {
    const t = await install();
    const source = await t.start(MAYA);
    t.deny(source.taskId, OMAR);
    const legacy = await t.start(MAYA);
    t.h.db.delete(agentSessionKey(TEST_ORG, legacy.sessionId, "META"));
    await t.teach("les_person0001", [source.taskId]);
    await t.teach("les_person0002", [legacy.taskId]);
    // The positive control is MAYA (can open the source task); OMAR is denied it; the legacy-task lesson is held for everyone.
    expect(await t.tab(MAYA)).toMatchObject({ active: ["les_person0001"] });
    expect((await t.tab(OMAR)).active).toEqual([]);
    // The company admin decides lessons: the admin sees the count of lessons held because their source task has no session item (and the lesson from the denied-OMAR task, which the admin may open).
    const admin = await t.tab(ADMIN);
    expect(admin.legacyHeld).toBe(1);
    expect(admin.active).toEqual(["les_person0001"]);
    // N2: the held lesson is counted once. It is not ALSO a lesson "from sources you can't see".
    expect(admin.hidden).toBe(0);
    // Not for a person who does not decide.
    expect((await t.tab(MAYA)).legacyHeld).toBeUndefined();
  });
});

describe("a lesson restricted only to a project repository (decisions 34 and 36), through the wired runtime", () => {
  it("loads into any project task while the project pins the repository, stops when a newer revision drops it, and stops at once when the repository's place is closed", async () => {
    const t = await install();
    const source = await t.start(MAYA), running = await t.start(OMAR);
    await t.teach("les_repo00001", [source.taskId], REPO_PLACE);
    // The project's registered revision pins no repository: the restriction is not "the project's own", so the lesson stays out.
    expect(await t.dispatch(running.taskId)).toBeUndefined();
    t.pin(2, pinnedRepo("api", 9));
    expect(await t.dispatch(running.taskId)).toEqual(["les_repo00001"]);
    expect((await t.tab(MAYA)).active).toEqual(["les_repo00001"]);
    // L2: the repository was deleted or excluded: its place is closed the moment the removal is queued, though the pinned id is still in the project definition.
    await closeScope({ documentClient: t.h.db, tableName: "record" }, TEST_ORG, REPO_PLACE, "source_deleted", at);
    expect(await t.dispatch(running.taskId)).toBeUndefined();
    expect((await t.tab(MAYA)).active).toEqual([]);
  });

  it("a newer revision that drops the repository takes the lesson out again", async () => {
    const t = await install();
    const source = await t.start(MAYA), running = await t.start(OMAR);
    await t.teach("les_repo00002", [source.taskId], REPO_PLACE);
    t.pin(2, pinnedRepo("api", 9));
    expect(await t.dispatch(running.taskId)).toEqual(["les_repo00002"]);
    t.pin(3, pinnedRepo("web", 10));
    expect(await t.dispatch(running.taskId)).toBeUndefined();
  });

  it("decision 36: the pull request counts it everywhere in the project but names it only in the repository itself", async () => {
    const t = await install();
    const source = await t.start(MAYA), running = await t.start(OMAR);
    t.pin(2, pinnedRepo("api", 9), pinnedRepo("web", 10));
    await t.teach("les_repo00003", [source.taskId], REPO_PLACE);
    expect(await t.dispatch(running.taskId)).toEqual(["les_repo00003"]);
    // The dispatcher recorded what it loaded as the task's load manifest; once the citation check has passed at the prompt the lesson counts as used (`REACHED`).
    // The same reader with the repository known to be private: named in "api" (the lesson's own repository), only counted in "web".
    const routes = t.runtime.routes as unknown as Parameters<typeof lessonsUsedReaderOver>[0] & { store: { manifests(key: unknown, taskId: string): Promise<Array<{ lessons: Array<{ citation: string }> }>>; updateManifest(manifest: unknown): Promise<void> } };
    const [manifest] = await routes.store.manifests({ workspaceId: TEST_ORG, project: "payments" }, running.taskId);
    await routes.store.updateManifest({ ...manifest!, lessons: manifest!.lessons.map((entry) => ({ ...entry, citation: "valid" })) });
    const read = lessonsUsedReaderOver({ store: routes.store, settings: routes.settings, access: routes.access, names: { memberName: async () => undefined, isErased: async () => false }, visibility: async () => "private" });
    const input = { orgId: TEST_ORG, project: "payments", taskId: running.taskId, pageUrl: "https://app.example.test/t/x", startingRevision: 2 };
    expect(await read({ ...input, repo: "api" })).toMatchObject({ count: 1, items: [{ id: "les_repo00003" }] });
    expect(await read({ ...input, repo: "web" })).toMatchObject({ count: 1, items: [] });
    // N1: the pull request's repository is matched by its GitHub id. Revision 3 renames repository 9 ("api" -> "api-v2") and adds a DIFFERENT repository (11) that is also called "api".
    t.pin(3, pinnedRepo("api-v2", 9), pinnedRepo("api", 11), pinnedRepo("web", 10));
    expect(await read({ ...input, repo: "api" })).toMatchObject({ count: 1, items: [{ id: "les_repo00003" }] });
    expect(await read({ ...input, repo: "api", startingRevision: 3 })).toMatchObject({ count: 1, items: [] });
    expect(await read({ ...input, repo: "api-v2", startingRevision: 3 })).toMatchObject({ count: 1, items: [{ id: "les_repo00003" }] });
    // The reader installed for pull requests (its repository visibility is asked of the code host, which this harness does not have: unknown, so only the count and the link are written).
    expect(await lessonsUsedForTask({ orgId: TEST_ORG, project: "payments", taskId: running.taskId, pageUrl: "https://app.example.test/t/x", repo: "api" })).toMatchObject({ count: 1, items: [] });
    // Revision 4 drops repository 9 for good: the lesson is not the project's any more, so it is not counted at all.
    t.pin(4, pinnedRepo("api", 11), pinnedRepo("web", 10));
    expect(await read({ ...input, repo: "api" })).toBeUndefined();
  });

  it("the installed runtime answers the project's repositories from the latest revision; no revision or no pinned repository is 'not known' or not the project's", async () => {
    const t = await install();
    const routes = (t.dependencies.lessons as { routes: { projectRepos: (key: { workspaceId: string; project: string }) => Promise<ReadonlySet<string> | undefined> } }).routes;
    t.pin(2, pinnedRepo("api", 9));
    expect([...(await routes.projectRepos({ workspaceId: TEST_ORG, project: "payments" }))!]).toEqual([REPO_PLACE]);
    expect(await routes.projectRepos({ workspaceId: TEST_ORG, project: "ops" })).toBeUndefined();
    expect(await routes.projectRepos({ workspaceId: "not-an-org", project: "payments" })).toBeUndefined();
  });
});
