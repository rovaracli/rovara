// v1.2 learning loop: the task page knows whether each comment is already remembered. `canRemember` (once, for the caller) and `learning` (per comment) are filled only for a person with standing in the
// project, from the same standing the Remember route uses; for anyone else, and when the read fails, they are absent.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { INDEX_EXPIRY_ATTRIBUTE, TaskCommentLearningSchema } from "../../packages/contracts/src/index.js";
import { getTaskPageState, listPageComments } from "../../packages/broker/src/aws/developer-tasks.js";
import { createTaskWebApi, type TaskWebApiDependencies } from "../../packages/broker/src/aws/task-web-api.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { commentLearningFlags } from "../../packages/broker/src/learning/comment-flags.js";
import { forgetTaskComment, rememberTaskComment } from "../../packages/broker/src/learning/capture-comment.js";
import type { PageTaskFixture } from "../support/page-tasks.js";
import { TEST_ORG } from "../support/orgs.js";
import {
  OMAR, PRIYA, PROJECT, RETRY_TEXT, SAM, learningItems, learningTask, seedComment, seedGrant, seedMember, seedPerson, seedProject,
} from "../support/learning-page.js";

type Send = (command: unknown) => Promise<unknown>;
const nameOf = (command: unknown) => (command as { constructor: { name: string } }).constructor.name;

/** The fixture with its client wrapped: `onBatchGet` sees every BatchGet and may answer or throw instead of the table. */
function withBatchGet(fixture: PageTaskFixture, onBatchGet: (command: { input: { RequestItems: Record<string, { Keys: unknown[] }> } }, real: Send) => Promise<unknown>) {
  const real: Send = (command) => fixture.deps.documentClient.send(command);
  const batches: number[] = [];
  const deps = {
    ...fixture.deps,
    documentClient: {
      send: (command: unknown) => {
        if (nameOf(command) !== "BatchGetCommand") return real(command);
        const typed = command as { input: { RequestItems: Record<string, { Keys: unknown[] }> } };
        batches.push(Object.values(typed.input.RequestItems).reduce((total, spec) => total + spec.Keys.length, 0));
        return onBatchGet(typed, real);
      },
    },
  };
  return { deps, batches };
}

function membersTask(): PageTaskFixture {
  const fixture = learningTask();
  seedPerson(fixture.db, PRIYA, "contributor");
  seedPerson(fixture.db, SAM, "contributor");
  return fixture;
}
const read = (fixture: PageTaskFixture, who: DeveloperCaller = PRIYA) => listPageComments(fixture.deps, who, fixture.taskId);
const learningOf = (listing: Awaited<ReturnType<typeof read>>, commentId: string) => listing.comments.find((comment) => comment.id === commentId)!.learning;

describe("task page: remembered flags", () => {
  it("a member with standing sees canRemember true, and remembered false then true after Remember, then false after Forget", async () => {
    const fixture = membersTask();
    const comment = seedComment(fixture, SAM, RETRY_TEXT);
    const other = seedComment(fixture, SAM, "Name the helper retryWithBackoff, not retry.");
    let listing = await read(fixture);
    expect(listing.canRemember).toBe(true);
    expect(learningOf(listing, comment.commentId)).toEqual({ remembered: false });
    const answer = await rememberTaskComment(fixture.deps, PRIYA, fixture.taskId, comment.commentId);
    listing = await read(fixture);
    expect(learningOf(listing, comment.commentId)).toEqual({ remembered: true, correctionId: answer.correction.id });
    expect(learningOf(listing, other.commentId)).toEqual({ remembered: false });
    await forgetTaskComment(fixture.deps, PRIYA, fixture.taskId, comment.commentId);
    listing = await read(fixture);
    expect(learningOf(listing, comment.commentId)).toEqual({ remembered: false });
    expect(listing.canRemember).toBe(true);
  });

  it("every member sees the same flag: another member (the commenter) sees what the owner remembered", async () => {
    const fixture = membersTask();
    const comment = seedComment(fixture, SAM, RETRY_TEXT);
    const answer = await rememberTaskComment(fixture.deps, PRIYA, fixture.taskId, comment.commentId);
    const listing = await read(fixture, SAM);
    expect(listing.canRemember).toBe(true);
    expect(learningOf(listing, comment.commentId)).toEqual({ remembered: true, correctionId: answer.correction.id });
  });

  it("the page state carries canRemember for a member, with no per-comment read", async () => {
    const fixture = membersTask();
    seedComment(fixture, SAM, RETRY_TEXT);
    const { deps, batches } = withBatchGet(fixture, async (command, real) => real(command));
    expect((await getTaskPageState(deps, PRIYA, fixture.taskId)).canRemember).toBe(true);
    expect(batches).toEqual([]);
  });

  it("an owner or admin of the company with no project grant has standing", async () => {
    const fixture = learningTask();
    seedPerson(fixture.db, PRIYA, "none", "owner");
    seedComment(fixture, SAM, RETRY_TEXT);
    expect((await read(fixture)).canRemember).toBe(true);
  });

  describe.each([
    ["a project viewer", (fixture: PageTaskFixture) => { seedPerson(fixture.db, OMAR, "viewer"); fixture.members.add(OMAR.slackUserId!); }],
    ["a commenter with no project grant", (fixture: PageTaskFixture) => { seedMember(fixture.db, OMAR); fixture.members.add(OMAR.slackUserId!); }],
    ["a channel-only person with no company record", (fixture: PageTaskFixture) => { fixture.members.add(OMAR.slackUserId!); }],
    ["a person removed from the company whose grant is left behind", (fixture: PageTaskFixture) => { seedGrant(fixture.db, OMAR, "maintainer"); fixture.members.add(OMAR.slackUserId!); }],
  ])("%s", (_label, setup) => {
    it("gets neither canRemember nor learning, on the comments or the state, and nothing is read for them", async () => {
      const fixture = membersTask();
      const comment = seedComment(fixture, SAM, RETRY_TEXT);
      await rememberTaskComment(fixture.deps, PRIYA, fixture.taskId, comment.commentId);
      setup(fixture);
      const { deps, batches } = withBatchGet(fixture, async (command, real) => real(command));
      const listing = await listPageComments(deps, OMAR, fixture.taskId);
      expect(listing.comments).toHaveLength(1);
      expect("canRemember" in listing).toBe(false);
      expect("learning" in listing.comments[0]!).toBe(false);
      const state = await getTaskPageState(deps, OMAR, fixture.taskId);
      expect("canRemember" in state).toBe(false);
      expect(batches).toEqual([]);
      expect(JSON.stringify(listing)).not.toContain("remembered");
    });
  });

  it("an outsider with no access to the task cannot read the page at all", async () => {
    const fixture = membersTask();
    seedComment(fixture, SAM, RETRY_TEXT);
    const stranger: DeveloperCaller = { ...OMAR, developerId: "7".repeat(64), slackUserId: "U0STRANGE1", sessionId: "s-stranger" };
    await expect(listPageComments(fixture.deps, stranger, fixture.taskId)).rejects.toBeDefined();
  });

  it("an archived project, or one with no META, shows nothing (Remember would be refused)", async () => {
    const fixture = membersTask();
    seedComment(fixture, SAM, RETRY_TEXT);
    seedProject(fixture.db, PROJECT, "archived");
    const listing = await read(fixture);
    expect("canRemember" in listing).toBe(false);
    expect("learning" in listing.comments[0]!).toBe(false);
  });

  it("a failing BatchGet still serves the page, with no learning field (and canRemember still true)", async () => {
    const fixture = membersTask();
    const comment = seedComment(fixture, SAM, RETRY_TEXT);
    const { deps } = withBatchGet(fixture, async () => { throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" }); });
    const listing = await listPageComments(deps, PRIYA, fixture.taskId);
    expect(listing.comments.map((view) => view.id)).toEqual([comment.commentId]);
    expect("learning" in listing.comments[0]!).toBe(false);
    expect(listing.canRemember).toBe(true);
  });

  it("keys the DynamoDB left unprocessed leave learning absent: unknown is not 'not remembered'", async () => {
    const fixture = membersTask();
    const comment = seedComment(fixture, SAM, RETRY_TEXT);
    await rememberTaskComment(fixture.deps, PRIYA, fixture.taskId, comment.commentId);
    const { deps } = withBatchGet(fixture, async (command) => ({ Responses: {}, UnprocessedKeys: command.input.RequestItems }));
    const listing = await listPageComments(deps, PRIYA, fixture.taskId);
    expect("learning" in listing.comments[0]!).toBe(false);
  });

  it("a BatchGet that never answers is cut off at the time limit, and learning stays absent", async () => {
    const fixture = membersTask();
    const comment = seedComment(fixture, SAM, RETRY_TEXT);
    const { deps } = withBatchGet(fixture, () => new Promise(() => undefined));
    const started = Date.now();
    const flags = await commentLearningFlags(deps, { caller: PRIYA, access: { task: fixture.db.get(`DEVTASK#${fixture.taskId}`, "META") as never, role: "owner", ownerActorIds: [] } },
      fixture.taskId, [comment.commentId], { timeoutMs: 40 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(flags).toEqual({ canRemember: true });
  });

  it("more than 100 comments are read in pages of at most 100 keys, and every flag is right", async () => {
    const fixture = membersTask();
    const comments = Array.from({ length: 230 }, (_unused, index) => seedComment(fixture, SAM, `${RETRY_TEXT} Variant ${index}.`, { createdAt: new Date(Date.parse("2026-10-11T10:00:00.000Z") + index * 1000).toISOString() }));
    const remembered = [3, 99, 100, 101, 199, 200, 229];
    const ids = new Map<number, string>();
    for (const index of remembered) ids.set(index, (await rememberTaskComment(fixture.deps, PRIYA, fixture.taskId, comments[index]!.commentId)).correction.id);
    const { deps, batches } = withBatchGet(fixture, async (command, real) => real(command));
    const listing = await listPageComments(deps, PRIYA, fixture.taskId);
    expect(listing.comments).toHaveLength(230);
    expect(batches.every((size) => size >= 1 && size <= 100)).toBe(true);
    expect(batches.reduce((total, size) => total + size, 0)).toBe(230);
    expect(batches).toHaveLength(3);
    comments.forEach((comment, index) => {
      const expected = remembered.includes(index) ? { remembered: true, correctionId: ids.get(index) } : { remembered: false };
      expect(learningOf(listing, comment.commentId)).toEqual(expected);
    });
  });

  it("reads only people's comments: AgentX's answers get no learning field, and a page with none reads nothing", async () => {
    const fixture = membersTask();
    const person = seedComment(fixture, SAM, RETRY_TEXT);
    const agentx = seedComment(fixture, SAM, "Answer.", { agentx: true });
    const { deps, batches } = withBatchGet(fixture, async (command, real) => real(command));
    const listing = await listPageComments(deps, PRIYA, fixture.taskId);
    expect(learningOf(listing, person.commentId)).toEqual({ remembered: false });
    expect("learning" in listing.comments.find((view) => view.id === agentx.commentId)!).toBe(false);
    expect(batches).toEqual([1]);
    const empty = membersTask();
    const quiet = withBatchGet(empty, async (command, real) => real(command));
    const none = await listPageComments(quiet.deps, PRIYA, empty.taskId);
    expect(none.canRemember).toBe(true);
    expect(quiet.batches).toEqual([]);
  });

  describe("the project epoch and expiry", () => {
    it("a source written for an earlier instance of the project, or one past its expiry, is not remembered", async () => {
      const fixture = membersTask();
      const earlier = seedComment(fixture, SAM, RETRY_TEXT);
      const expiring = seedComment(fixture, SAM, "Name the helper retryWithBackoff, not retry.");
      await rememberTaskComment(fixture.deps, PRIYA, fixture.taskId, earlier.commentId);
      await rememberTaskComment(fixture.deps, PRIYA, fixture.taskId, expiring.commentId);
      const sources = learningItems(fixture.db).filter((item) => String(item.sk).startsWith("SOURCE#"));
      expect(sources).toHaveLength(2);
      // The second source's time has passed (the table's TTL may not have run yet).
      const dead = sources.find((item) => String(item.sk).endsWith(expiring.commentId))!;
      fixture.db.set({ ...dead, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(fixture.deps.now() / 1000) - 10 });
      expect(learningOf(await read(fixture), earlier.commentId)).toMatchObject({ remembered: true });
      expect(learningOf(await read(fixture), expiring.commentId)).toEqual({ remembered: false });
      // The project is created again under the same name: nothing of the old one is remembered.
      seedProject(fixture.db, PROJECT, "active", "2026-10-20T00:00:00.000Z");
      expect(learningOf(await read(fixture), earlier.commentId)).toEqual({ remembered: false });
    });
  });

  describe("contract shape", () => {
    it("the stored shape is exact: remembered, with correctionId only when it is", async () => {
      const fixture = membersTask();
      const comment = seedComment(fixture, SAM, RETRY_TEXT);
      const open = seedComment(fixture, SAM, "Name the helper retryWithBackoff, not retry.");
      await rememberTaskComment(fixture.deps, PRIYA, fixture.taskId, comment.commentId);
      const listing = await read(fixture);
      const yes = learningOf(listing, comment.commentId)!;
      const no = learningOf(listing, open.commentId)!;
      expect(Object.keys(yes).sort()).toEqual(["correctionId", "remembered"]);
      expect(Object.keys(no)).toEqual(["remembered"]);
      expect(TaskCommentLearningSchema.parse(yes)).toEqual(yes);
      expect(TaskCommentLearningSchema.parse(no)).toEqual(no);
      expect(TaskCommentLearningSchema.safeParse({ remembered: true, extra: 1 }).success).toBe(false);
      expect(TaskCommentLearningSchema.safeParse({ correctionId: "x" }).success).toBe(false);
      expect(Object.keys(listing).sort()).toEqual(["canRemember", "comments", "suggestions"]);
    });

    const SESSION = "22222222-2222-4222-8222-222222222222";
    const caller: DeveloperCaller = { orgId: TEST_ORG, orgRole: "member" as const, developerId: "d".repeat(64), sessionId: SESSION, amr: "slack", name: "Maya Chen", slackUserId: "U0MAYA001" };
    const taskId = "11111111-1111-4111-8111-111111111111";
    const served = async (overrides: Partial<TaskWebApiDependencies>, suffix: "state" | "comments") => {
      const deps: TaskWebApiDependencies = {
        origin: "https://api.example.test", authenticateSession: async () => caller,
        taskState: async () => ({ revision: 4, waiting: true, stage: "Coding plan", documents: [], commentSeq: 2, canRead: true, canComment: true, canSuggest: true, canDecide: true, canAsk: true, canManagePeople: false, canTakeOwnership: false }),
        listComments: async () => ({ comments: [] }),
        createComment: async () => ({}) as never, editComment: async () => ({}) as never, deleteComment: async () => ({}) as never, setSuggestion: async () => ({}),
        decide: async () => ({ revision: 5 }), ...overrides,
      };
      const path = `/review/${taskId}/task/api/${suffix}`;
      const response = await createTaskWebApi(deps)({ method: "GET", path, requestId: "r", headers: { cookie: `__Host-agentx_review_session=${SESSION}` } }, new URL(`https://api.example.test${path}`));
      return JSON.parse(response.body) as Record<string, unknown>;
    };

    it("the API passes canRemember and learning through, and adds neither when the dependency does not", async () => {
      const comment = { id: randomUUID(), learning: { remembered: true, correctionId: "c1" } };
      const withFlags = await served({ listComments: async () => ({ comments: [comment as never], canRemember: true }) }, "comments");
      expect(Object.keys(withFlags).sort()).toEqual(["canRemember", "comments", "suggestions"]);
      expect((withFlags.comments as unknown[])[0]).toEqual(comment);
      const without = await served({}, "comments");
      expect(Object.keys(without).sort()).toEqual(["comments", "suggestions"]);
      const stateWith = await served({ taskState: async () => ({ revision: 4, waiting: true, stage: "s", documents: [], commentSeq: 2, canRead: true, canComment: true, canSuggest: true, canDecide: true, canAsk: true, canManagePeople: false, canTakeOwnership: false, canRemember: true }) }, "state");
      expect(stateWith.canRemember).toBe(true);
      expect("canRemember" in (await served({}, "state"))).toBe(false);
    });
  });
});
