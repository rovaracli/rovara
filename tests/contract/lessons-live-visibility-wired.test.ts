// Owner decisions 31 and 32, end to end on a REAL wired install: `installLessons` builds the runtime with the production ports (`tableTaskVisibilityPort` + `tableLessonAudiencePort` + the project's repository
// scopes), and the dispatcher (`learnedContextForOperation`) loads lessons for a running task whose records are written the way a task start writes them (the task row, its session item, People list and shares).
// The point is the keys: the task id, org and project the dispatcher passes are the exact keys `task-audience.ts` reads. If a key drifted, the live check would hide every lesson and learning would switch itself off
// silently; the positive controls here fail then. The other cases show the check really runs (a narrowed source task hides its lesson; an unreadable one fails closed).
import { describe, expect, it } from "vitest";
import { agentSessionKey, projectRevisionKey } from "@agentx/contracts";
import { installLessons } from "../../packages/broker/src/aws/broker/lessons-wiring.js";
import { learnedContextForOperation } from "../../packages/broker/src/aws/broker/lessons-dispatch.js";
import { createLessonDelivery } from "../../packages/broker/src/lessons/delivery-wiring.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { ARJUN, MIA, ORG_A, ORG_B, PRIYA, sessionWorld } from "../support/agent-session-world.js";
import { lessonRecord } from "../unit/lessons/lesson-helpers.js";

const ON = { LEARNED_LESSONS_ENABLED: "1" };
const definition = { repositories: [{ name: "api", url: "https://github.com/acme/api" }] } as never;

function install() {
  const w = sessionWorld();
  w.db.set({ ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT_REVISION" });
  const dependencies = {
    documentClient: w.db, tableName: "state", agents: {}, developer: { signInTableName: "signin" }, artifactBucketName: "artifacts", s3: { send: async () => ({}) },
    teamRecord: { table: { documentClient: w.db, tableName: "record" }, edition: "public", emitter: { sendBack: async () => undefined }, taskVisibility: async () => ({ kind: "shared" }) },
  } as Record<string, unknown>;
  installLessons(dependencies as never);
  const runtime = dependencies.lessons as { store: { setVersion(key: unknown): Promise<number>; commit(key: unknown, version: number, lessons: unknown[], by: number): Promise<unknown> } };
  const key = { workspaceId: ORG_A, project: "web" };
  /** A live lesson (one person approved it) learned from `sources`. */
  const teach = async (id: string, sources: string[]): Promise<void> => {
    const lesson = lessonRecord({ id, workspaceId: ORG_A, project: "web", type: "convention", tier: 1, stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"], approvals: [{ approvalId: "ap", by: "ann", at: 1, mode: "one" }], provenance: { ...lessonRecord().provenance, supportTasks: sources } });
    await runtime.store.commit(key, await runtime.store.setVersion(key), [lesson], 1);
  };
  /** The dispatcher's call for the running task `taskId`, with the task row read back as the broker would read it. */
  const dispatch = async (taskId: string, org: string = ORG_A) => {
    const task = { ...(w.db.get(taskKey(taskId)) as object), title: "Retry failed HTTP calls", workflow: { revision: 1 } } as never;
    const result = await learnedContextForOperation(dependencies, { orgId: org, task, workflowMode: "IMPLEMENT", definition }, ON);
    // Delivery asks again, from the refs the dispatcher stored (the same task id, org and project), with the dispatcher's own ports.
    if (result.learnedRefs !== undefined) {
      const delivered = await createLessonDelivery({ documentClient: w.db, stateTable: "state", recordTable: "record", enabled: () => true })!(result.learnedRefs);
      expect(delivered?.lessons.map((lesson) => lesson.id), "delivery follows the load").toEqual(result.learnedRefs.lessons.map((lesson) => lesson.id));
    }
    return result.learnedRefs?.lessons.map((lesson) => lesson.id);
  };
  return { w, dependencies, teach, dispatch };
}

describe("a wired install loads a lesson into a task whose records are written as a task start writes them", () => {
  it("positive control: a lesson from a project-wide task loads into another project-wide task of the same project", async () => {
    const t = install();
    const source = t.w.seedSession({ owner: PRIYA }), running = t.w.seedSession({ owner: ARJUN });
    await t.teach("les_wired0001", [source.taskId]);
    expect(await t.dispatch(running.taskId)).toEqual(["les_wired0001"]);
  });

  it("the check really runs: a source task that denies a person the running task lets in hides the lesson; the same lesson loads once the running task denies them too", async () => {
    const t = install();
    const source = t.w.seedSession({ owner: PRIYA, people: [{ developerId: MIA, role: "denied" }] });
    await t.teach("les_wired0002", [source.taskId]);
    const open = t.w.seedSession({ owner: ARJUN });
    expect(await t.dispatch(open.taskId)).toBeUndefined();
    const alsoDenies = t.w.seedSession({ owner: ARJUN, people: [{ developerId: MIA, role: "denied" }] });
    expect(await t.dispatch(alsoDenies.taskId)).toEqual(["les_wired0002"]);
  });

  it("a source task shared with the whole company, or a running task shared wider than its source, follows decision 31", async () => {
    const t = install();
    const source = t.w.seedSession({ owner: PRIYA });
    const wider = t.w.seedSession({ owner: ARJUN });
    t.w.seedShare(ORG_A, wider.sessionId, { kind: "org" }, "view");
    await t.teach("les_wired0003", [source.taskId]);
    // Everyone in the company can open the running task but not the source: the lesson stays out.
    expect(await t.dispatch(wider.taskId)).toBeUndefined();
    t.w.seedShare(ORG_A, source.sessionId, { kind: "org" }, "view");
    expect(await t.dispatch(wider.taskId)).toEqual(["les_wired0003"]);
  });

  it("fails closed with the real reads: a source task with no session item, another company's source task, and a running task whose session is missing load nothing", async () => {
    const t = install();
    const noSession = t.w.seedSession({ owner: PRIYA });
    t.w.db.delete(agentSessionKey(ORG_A, noSession.sessionId, "META"));
    const running = t.w.seedSession({ owner: ARJUN });
    await t.teach("les_wired0004", [noSession.taskId]);
    const foreign = t.w.seedSession({ owner: PRIYA, taskOrgId: ORG_B });
    await t.teach("les_wired0005", [foreign.taskId]);
    expect(await t.dispatch(running.taskId)).toBeUndefined();
    const noSessionRunning = t.w.seedSession({ owner: ARJUN });
    t.w.db.delete(agentSessionKey(ORG_A, noSessionRunning.sessionId, "META"));
    const fine = t.w.seedSession({ owner: PRIYA });
    await t.teach("les_wired0006", [fine.taskId]);
    expect(await t.dispatch(noSessionRunning.taskId)).toBeUndefined();
  });
});

describe("the installed runtime reads the project's own repositories live for tier and trial (decision 34)", () => {
  it("the process dependencies answer from the project's latest revision; no revision or no pinned repository is 'not known' or not the project's", async () => {
    const t = install();
    const routes = (t.dependencies.lessons as { routes: { projectRepos: (key: { workspaceId: string; project: string }) => Promise<ReadonlySet<string> | undefined> } }).routes;
    const repo = { name: "api", url: "https://github.com/acme/api", path: "api", defaultBranch: "main", credentialRef: "github-app", githubRepositoryId: 9, installationId: 5 };
    t.w.db.set({ ...projectRevisionKey(ORG_A, "web", 2), entityType: "PROJECT_REVISION", definition: { repositories: [repo] } });
    expect([...(await routes.projectRepos({ workspaceId: ORG_A, project: "web" }))!]).toEqual(["github:repo/9"]);
    expect(await routes.projectRepos({ workspaceId: ORG_A, project: "ops" })).toBeUndefined();
    expect(await routes.projectRepos({ workspaceId: "not-an-org", project: "web" })).toBeUndefined();
  });
});
