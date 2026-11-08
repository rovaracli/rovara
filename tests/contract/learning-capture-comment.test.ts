// v1.2 learning loop, B3: "Remember this" and "Forget" on a task-page comment (design 2.1, 2.4, 5.1; review Critical 1).
// Standing is worked out at capture, from the live company and project records, never from the request.
import { describe, expect, it } from "vitest";
import { LEARNING_REMEMBER_MAX, LearningCorrectionSchema } from "../../packages/contracts/src/project-learning.js";
import { forgetTaskComment, liveRememberedNoteIds, rememberTaskComment } from "../../packages/broker/src/learning/capture-comment.js";
import { groupCorrections } from "../../packages/broker/src/learning/grouping.js";
import { openSuggestion, readLearningState, suggestionSk } from "../../packages/broker/src/learning/store.js";
import { githubMemberKey, orgLearningSettingsKey, projectMemberKey } from "../../packages/contracts/src/index.js";
import type { PageTaskFixture } from "../support/page-tasks.js";
import { TEST_ORG } from "../support/orgs.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import {
  LEO, MAYA_ADMIN, OMAR, PRIYA, PROJECT, PROJECT_CREATED_AT, RETRY_TEXT, SAM, learningItems, learningTask, seedComment, seedGrant, seedMember, seedPerson, seedProject, takeOver,
} from "../support/learning-page.js";

const learningDeps = (fixture: PageTaskFixture) => ({ documentClient: fixture.db, tableName: "state", now: () => fixture.deps.now() });
const scope = { orgId: TEST_ORG, project: PROJECT, projectCreatedAt: PROJECT_CREATED_AT };
const remember = (fixture: PageTaskFixture, who: typeof PRIYA, commentId: string) => rememberTaskComment(fixture.deps, who, fixture.taskId, commentId);
const forget = (fixture: PageTaskFixture, who: typeof PRIYA, commentId: string) => forgetTaskComment(fixture.deps, who, fixture.taskId, commentId);
const refusal = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as Error & { code?: string; pageReason?: string }; }
  throw new Error("expected a refusal");
};
const corrections = (fixture: PageTaskFixture) => learningItems(fixture.db).filter((item) => String(item.sk).startsWith("CORRECTION#"));
const nothingStored = (fixture: PageTaskFixture) => expect(learningItems(fixture.db)).toEqual([]);

/** Priya owns the task and is a member (contributor); Sam comments and is a member too. */
function membersTask(): PageTaskFixture {
  const fixture = learningTask();
  seedPerson(fixture.db, PRIYA, "contributor");
  seedPerson(fixture.db, SAM, "contributor");
  return fixture;
}

describe("Remember this", () => {
  it("stores one correction from a member's comment, with the comment author's standing", async () => {
    const fixture = membersTask();
    const comment = seedComment(fixture, SAM, RETRY_TEXT);
    const answer = await remember(fixture, PRIYA, comment.commentId);
    expect(answer).toEqual({ correction: { id: answer.correction.id, standing: "member", stage: "plan" } });
    const [stored] = corrections(fixture);
    const correction = LearningCorrectionSchema.parse(Object.fromEntries(Object.entries(stored!).filter(([key]) => !["pk", "sk", "entityType", "orgId"].includes(key))));
    expect(correction).toMatchObject({
      id: answer.correction.id, stage: "plan", source: "comment", sourceRef: { taskId: fixture.taskId, commentId: comment.commentId }, taskId: fixture.taskId,
      author: SAM.developerId, rememberedBy: PRIYA.developerId, standing: "member", projectCreatedAt: PROJECT_CREATED_AT,
    });
    expect(correction.text).toContain("shared retry helper");
    expect(correction.signature.length).toBeGreaterThan(3);
    expect(JSON.stringify(correction.signature)).not.toContain("retry");
    expect((await readLearningState(learningDeps(fixture), scope))?.liveCorrections).toBe(1);
  });

  it("is idempotent per comment: a repeat, even by another member, adds nothing and counts nothing", async () => {
    const fixture = membersTask();
    const comment = seedComment(fixture, SAM, RETRY_TEXT);
    const first = await remember(fixture, PRIYA, comment.commentId);
    const again = await remember(fixture, PRIYA, comment.commentId);
    const byOther = await remember(fixture, SAM, comment.commentId);
    expect(again).toEqual(first);
    expect(byOther).toEqual(first);
    expect(corrections(fixture)).toHaveLength(1);
    expect((await readLearningState(learningDeps(fixture), scope))?.liveCorrections).toBe(1);
    const rateItems = learningItems(fixture.db).filter((item) => String(item.sk).startsWith("RATE#"));
    expect(rateItems.map((item) => item.rememberCount)).toEqual([1]);
  });

  it("I1: an outsider's comment, remembered by a member, is stored as outsider", async () => {
    const fixture = membersTask();
    seedPerson(fixture.db, OMAR, "viewer");
    const comment = seedComment(fixture, OMAR, RETRY_TEXT);
    const answer = await remember(fixture, PRIYA, comment.commentId);
    expect(answer.correction.standing).toBe("outsider");
    expect(corrections(fixture)[0]).toMatchObject({ standing: "outsider", author: OMAR.developerId, rememberedBy: PRIYA.developerId });
  });

  it("the author's standing is read at capture: a comment by someone since removed from the company is an outsider", async () => {
    const fixture = membersTask();
    const comment = seedComment(fixture, SAM, RETRY_TEXT);
    fixture.db.delete({ pk: `ORG#${TEST_ORG}`, sk: `MEMBER#${SAM.developerId}` });
    expect((await remember(fixture, PRIYA, comment.commentId)).correction.standing).toBe("outsider");
  });

  it("an org admin with no grant counts as a member, for the rememberer and the author", async () => {
    const fixture = learningTask();
    seedPerson(fixture.db, PRIYA, "none", "owner");
    seedPerson(fixture.db, MAYA_ADMIN, "none", "admin");
    const comment = seedComment(fixture, MAYA_ADMIN, RETRY_TEXT);
    expect((await remember(fixture, PRIYA, comment.commentId)).correction.standing).toBe("member");
  });

  describe("review Critical 1: the rememberer's own standing is checked at capture", () => {
    it.each([
      ["a project viewer", () => ({ grant: "viewer" as const, member: true })],
      ["a company member with no project grant", () => ({ grant: "none" as const, member: true })],
      ["a person with a grant but no company record (removed)", () => ({ grant: "maintainer" as const, member: false })],
      ["a person with no records at all", () => ({ grant: "none" as const, member: false })],
    ])("an owner who took the task over as %s cannot Remember, and nothing is stored", async (_label, make) => {
      const fixture = learningTask();
      seedPerson(fixture.db, SAM, "contributor");
      const { grant, member } = make();
      if (member) seedMember(fixture.db, LEO); // LEO: a company member
      seedGrant(fixture.db, LEO, grant);
      takeOver(fixture, LEO);
      const comment = seedComment(fixture, SAM, RETRY_TEXT);
      const error = await refusal(remember(fixture, LEO, comment.commentId));
      expect(error).toMatchObject({ code: "FORBIDDEN", pageReason: "not_allowed" });
      nothingStored(fixture);
    });

    it("a commenter reaching the project only through its Slack channel cannot Remember (owner Q1)", async () => {
      const fixture = membersTask();
      seedMember(fixture.db, OMAR); // signed in, in the channel, no grant
      fixture.members.add(OMAR.slackUserId!);
      const comment = seedComment(fixture, SAM, RETRY_TEXT);
      const error = await refusal(remember(fixture, OMAR, comment.commentId));
      expect(error).toMatchObject({ code: "FORBIDDEN", pageReason: "not_allowed" });
      nothingStored(fixture);
    });

    it("a person linked only through GitHub, with no company member record, cannot Remember", async () => {
      const fixture = learningTask();
      seedPerson(fixture.db, SAM, "contributor");
      seedGrant(fixture.db, LEO, "maintainer");
      fixture.db.set({ ...githubMemberKey(TEST_ORG, "4242"), entityType: "GITHUB_MEMBER", orgId: TEST_ORG, githubUserId: "4242", developerId: LEO.developerId });
      takeOver(fixture, LEO);
      const comment = seedComment(fixture, SAM, RETRY_TEXT);
      expect(await refusal(remember(fixture, LEO, comment.commentId))).toMatchObject({ code: "FORBIDDEN", pageReason: "not_allowed" });
      nothingStored(fixture);
    });

    it("the same owner is refused for the same reason on every comment, whoever wrote it", async () => {
      const fixture = learningTask();
      seedPerson(fixture.db, PRIYA, "contributor");
      seedPerson(fixture.db, LEO, "viewer");
      takeOver(fixture, LEO);
      const ownComment = seedComment(fixture, LEO, RETRY_TEXT);
      const priyasComment = seedComment(fixture, PRIYA, RETRY_TEXT);
      for (const id of [ownComment.commentId, priyasComment.commentId]) expect(await refusal(remember(fixture, LEO, id))).toMatchObject({ pageReason: "not_allowed" });
      nothingStored(fixture);
    });

    it("a reader who may only view the task is refused", async () => {
      const fixture = membersTask();
      const comment = seedComment(fixture, SAM, RETRY_TEXT);
      const stranger = await refusal(remember(fixture, { ...OMAR }, comment.commentId));
      expect(["TASK_NOT_FOUND", "TASK_ACCESS_DENIED", "FORBIDDEN"]).toContain(stranger.code);
      nothingStored(fixture);
    });

    it("fails closed when the records cannot be read: nothing is stored", async () => {
      const fixture = membersTask();
      const comment = seedComment(fixture, SAM, RETRY_TEXT);
      fixture.db.injectFault({ command: "GetCommand", match: (input) => String((input.Key as { sk?: string }).sk ?? "").startsWith("MEMBER#"), error: { name: "InternalServerError" }, times: 10 });
      await expect(remember(fixture, PRIYA, comment.commentId)).rejects.toBeDefined();
      nothingStored(fixture);
    });
  });

  describe("review: standing and project status are checked inside the capture transaction", () => {
    /** Runs `change` after the standing was read and before the capture is written, as a removal made at that moment would. */
    function racing(fixture: PageTaskFixture, change: () => void) {
      let done = false;
      const send = fixture.db.send;
      const documentClient = {
        send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
          if (!done && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("CORRECTION#")) { done = true; change(); }
          return send(command);
        },
      };
      return { ...fixture.deps, documentClient } as never;
    }
    const memberKey = (who: typeof PRIYA) => ({ pk: `ORG#${TEST_ORG}`, sk: `MEMBER#${who.developerId}` });

    it.each([
      ["is removed from the company", (fixture: PageTaskFixture) => { fixture.db.delete(memberKey(PRIYA)); }],
      ["is downgraded to a project viewer", (fixture: PageTaskFixture) => { seedGrant(fixture.db, PRIYA, "viewer"); }],
      ["loses the project grant", (fixture: PageTaskFixture) => { fixture.db.delete(projectMemberKey(TEST_ORG, PRIYA.developerId, PROJECT)); }],
      ["is moved to another company role", (fixture: PageTaskFixture) => { seedMember(fixture.db, PRIYA, "owner"); }],
      ["is in a project that is archived", (fixture: PageTaskFixture) => { seedProject(fixture.db, PROJECT, "archived"); }],
    ])("a Remember by someone who %s between the read and the write is refused and stores nothing", async (_label, change) => {
      const fixture = membersTask();
      const comment = seedComment(fixture, SAM, RETRY_TEXT);
      const deps = racing(fixture, () => change(fixture));
      const error = await refusal(rememberTaskComment(deps, PRIYA, fixture.taskId, comment.commentId));
      expect(error.pageReason).toBeDefined();
      expect(corrections(fixture)).toEqual([]);
      expect(learningItems(fixture.db).filter((item) => /^(SOURCE|RATE)#/.test(String(item.sk)))).toEqual([]);
    });

    it("an unchanged standing still captures with the checks in the same transaction", async () => {
      const fixture = membersTask();
      const comment = seedComment(fixture, SAM, RETRY_TEXT);
      await rememberTaskComment(racing(fixture, () => undefined), PRIYA, fixture.taskId, comment.commentId);
      expect(corrections(fixture)).toHaveLength(1);
    });
  });

  describe("what is not a correction", () => {
    it.each([
      ["a short comment", "Fix this please."],
      ["a generic comment", "Looks good to me, please see the included comments again."],
    ])("%s is refused and stores nothing", async (_label, text) => {
      const fixture = membersTask();
      const comment = seedComment(fixture, SAM, text);
      expect(await refusal(remember(fixture, PRIYA, comment.commentId))).toMatchObject({ pageReason: "refused" });
      nothingStored(fixture);
    });

    it("an AgentX reply, a deleted comment and an unknown comment are refused", async () => {
      const fixture = membersTask();
      const reply = seedComment(fixture, SAM, RETRY_TEXT, { agentx: true });
      const deleted = seedComment(fixture, SAM, RETRY_TEXT, { deleted: true });
      expect(await refusal(remember(fixture, PRIYA, reply.commentId))).toMatchObject({ pageReason: "refused" });
      expect(await refusal(remember(fixture, PRIYA, deleted.commentId))).toMatchObject({ pageReason: "gone" });
      expect(await refusal(remember(fixture, PRIYA, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))).toMatchObject({ pageReason: "gone" });
      nothingStored(fixture);
    });

    it("another task's comment id is not found on this task", async () => {
      const fixture = membersTask();
      const other = membersTask();
      const comment = seedComment(other, SAM, RETRY_TEXT);
      expect(await refusal(remember(fixture, PRIYA, comment.commentId))).toMatchObject({ pageReason: "gone" });
    });

    it("stores no code from the comment (I11), only the prose", async () => {
      const fixture = membersTask();
      const comment = seedComment(fixture, SAM, `${RETRY_TEXT}\n\n\`\`\`ts\nconst secretKey = loadPrivateCode();\n\`\`\`\n\n    indented private line`);
      await remember(fixture, PRIYA, comment.commentId);
      const text = String(corrections(fixture)[0]!.text);
      expect(text).toContain("shared retry helper");
      expect(text).not.toContain("loadPrivateCode");
      expect(text).not.toContain("indented private");
    });

    it("a project with no META (or an archived one) captures nothing", async () => {
      const fixture = membersTask();
      const comment = seedComment(fixture, SAM, RETRY_TEXT);
      seedProject(fixture.db, PROJECT, "archived");
      expect(await refusal(remember(fixture, PRIYA, comment.commentId))).toMatchObject({ pageReason: "not_here" });
      fixture.db.delete({ pk: `ORG#${TEST_ORG}#PROJECT#${PROJECT}`, sk: "META" });
      nothingStored(fixture);
    });
  });

  describe("rate: 30 per person per project per 10 minutes", () => {
    it("refuses the 31st, leaves another person unaffected, and starts again in the next window", async () => {
      const fixture = membersTask();
      const ids: string[] = [];
      for (let n = 0; n < LEARNING_REMEMBER_MAX + 2; n += 1) ids.push(seedComment(fixture, SAM, `Rule number ${String(n)}: always name the helper module explicitly in review.`).commentId);
      for (const id of ids.slice(0, LEARNING_REMEMBER_MAX)) await remember(fixture, PRIYA, id);
      expect(await refusal(remember(fixture, PRIYA, ids[LEARNING_REMEMBER_MAX]!))).toMatchObject({ pageReason: "slow_down" });
      expect(corrections(fixture)).toHaveLength(LEARNING_REMEMBER_MAX);
      // Sam has her own count; a repeat of a remembered comment does not use the rate.
      await remember(fixture, SAM, ids[LEARNING_REMEMBER_MAX]!);
      await remember(fixture, PRIYA, ids[0]!);
      fixture.advance(11 * 60_000);
      await remember(fixture, PRIYA, ids[LEARNING_REMEMBER_MAX + 1]!);
      expect(corrections(fixture)).toHaveLength(LEARNING_REMEMBER_MAX + 2);
    });
  });

  it("I9: the correction lands in this project's partition only", async () => {
    const fixture = membersTask();
    const comment = seedComment(fixture, SAM, RETRY_TEXT);
    await remember(fixture, PRIYA, comment.commentId);
    expect(corrections(fixture)).toHaveLength(1);
    expect(learningItems(fixture.db, "web")).toEqual([]);
  });
});

describe("Forget", () => {
  async function remembered(fixture: PageTaskFixture, author = SAM, by = PRIYA) {
    const comment = seedComment(fixture, author, RETRY_TEXT);
    const { correction } = await remember(fixture, by, comment.commentId);
    return { comment, correction };
  }

  it("deletes the correction and its source, takes it out of the count, and lets the comment be remembered again", async () => {
    const fixture = membersTask();
    const { comment } = await remembered(fixture);
    expect(await forget(fixture, PRIYA, comment.commentId)).toEqual({ forgotten: true });
    expect(learningItems(fixture.db).filter((item) => /^(CORRECTION|SOURCE)#/.test(String(item.sk)))).toEqual([]);
    expect((await readLearningState(learningDeps(fixture), scope))?.liveCorrections).toBe(0);
    expect(await forget(fixture, PRIYA, comment.commentId)).toEqual({ forgotten: true });
    await remember(fixture, PRIYA, comment.commentId);
    expect(corrections(fixture)).toHaveLength(1);
  });

  it("takes a grouped correction out of the month's counters (it is B5's Forget)", async () => {
    const fixture = membersTask();
    const first = seedComment(fixture, SAM, RETRY_TEXT);
    const second = seedComment(fixture, SAM, RETRY_TEXT);
    await remember(fixture, PRIYA, first.commentId);
    await remember(fixture, PRIYA, second.commentId);
    for (const item of corrections(fixture)) fixture.db.set({ ...item, taskId: `${String(item.taskId)}-${String(item.id)}` });
    await groupCorrections(learningDeps(fixture), scope);
    const metric = () => learningItems(fixture.db).find((item) => String(item.sk).startsWith("METRIC#"));
    expect(metric()).toMatchObject({ memberCorrections: 2 });
    await forget(fixture, PRIYA, first.commentId);
    expect(metric()).toMatchObject({ memberCorrections: 1 });
  });

  it("is refused while the suggestion is being accepted", async () => {
    const fixture = membersTask();
    const { commentId } = await inSuggestion(fixture, 2);
    const key = { pk: `ORG#${TEST_ORG}#PROJECT_LEARNING#${PROJECT}`, sk: suggestionSk("s1") };
    fixture.db.set({ ...fixture.db.get(key)!, status: "accepting" });
    expect(await refusal(forget(fixture, PRIYA, commentId))).toMatchObject({ pageReason: "refused" });
    expect(corrections(fixture)).toHaveLength(2);
  });

  it("is allowed for the person who remembered it, the comment's author and a project maintainer", async () => {
    for (const forgetter of [PRIYA, SAM, LEO]) {
      const fixture = membersTask();
      seedPerson(fixture.db, LEO, "maintainer");
      fixture.members.add(LEO.slackUserId!);
      const { comment } = await remembered(fixture);
      // Priya remembered Sam's comment. Leo is a maintainer who reads the task through its channel.
      expect(await forget(fixture, forgetter, comment.commentId)).toEqual({ forgotten: true });
      expect(corrections(fixture)).toEqual([]);
    }
  });

  it("is refused to a member who is neither (the owner of the correction's source is someone else)", async () => {
    const fixture = membersTask();
    seedPerson(fixture.db, LEO, "contributor");
    fixture.members.add(LEO.slackUserId!);
    const { comment } = await remembered(fixture);
    expect(await refusal(forget(fixture, LEO, comment.commentId))).toMatchObject({ code: "FORBIDDEN", pageReason: "not_allowed" });
    expect(corrections(fixture)).toHaveLength(1);
  });

  it("is refused to a person whose maintainer role is gone, even if they remembered nothing", async () => {
    const fixture = membersTask();
    seedPerson(fixture.db, LEO, "maintainer");
    fixture.members.add(LEO.slackUserId!);
    const { comment } = await remembered(fixture);
    seedGrant(fixture.db, LEO, "viewer");
    expect(await refusal(forget(fixture, LEO, comment.commentId))).toMatchObject({ pageReason: "not_allowed" });
    expect(corrections(fixture)).toHaveLength(1);
  });

  async function inSuggestion(fixture: PageTaskFixture, sources: number) {
    const ids: string[] = [];
    let commentId = "";
    for (let n = 0; n < sources; n += 1) {
      const comment = seedComment(fixture, SAM, `${RETRY_TEXT} Variant ${String(n)}.`);
      ids.push((await remember(fixture, PRIYA, comment.commentId)).correction.id);
      if (n === 0) commentId = comment.commentId;
    }
    const opened = await openSuggestion(learningDeps(fixture), scope, {
      id: "s1", stage: "plan", correctionIds: ids, allFromOnePerson: true, proposedText: RETRY_TEXT, signature: ["h"], lessSafe: false, kinds: [], overlaps: [],
    });
    expect(opened.ok).toBe(true);
    // Each source on its own task: a suggestion needs sources from at least 2 tasks.
    for (const item of corrections(fixture)) fixture.db.set({ ...item, suggestionId: "s1", taskId: `task-of-${String(item.id)}` });
    return { ids, commentId };
  }

  it("W7: a suggestion left with fewer than 2 sources is withdrawn, and its text dropped", async () => {
    const fixture = membersTask();
    const { commentId } = await inSuggestion(fixture, 2);
    await forget(fixture, PRIYA, commentId);
    const suggestion = fixture.db.get({ pk: `ORG#${TEST_ORG}#PROJECT_LEARNING#${PROJECT}`, sk: suggestionSk("s1") })!;
    expect(suggestion).toMatchObject({ status: "withdrawn" });
    expect(suggestion.proposedText).toBeUndefined();
    expect(suggestion.indexExpiresAt).toEqual(expect.any(Number));
    expect((await readLearningState(learningDeps(fixture), scope))?.openSuggestions).toBe(0);
  });

  it("a suggestion that keeps 2 or more sources stays open, loses the source and changes revision", async () => {
    const fixture = membersTask();
    const { commentId, ids } = await inSuggestion(fixture, 3);
    const before = fixture.db.get({ pk: `ORG#${TEST_ORG}#PROJECT_LEARNING#${PROJECT}`, sk: suggestionSk("s1") })!;
    await forget(fixture, PRIYA, commentId);
    const after = fixture.db.get({ pk: `ORG#${TEST_ORG}#PROJECT_LEARNING#${PROJECT}`, sk: suggestionSk("s1") })!;
    // The fixture's clock is frozen, so the three corrections share a time and grouping orders them by id (a hash of a random comment id): compare as a set.
    expect(after).toMatchObject({ status: "open" });
    expect([...(after.correctionIds as string[])].sort()).toEqual(ids.slice(1).sort());
    expect(after.revision).toBe((before.revision as number) + 1);
    expect((await readLearningState(learningDeps(fixture), scope))?.openSuggestions).toBe(1);
  });

  it("is refused once the correction is part of an accepted rule", async () => {
    const fixture = membersTask();
    const { commentId } = await inSuggestion(fixture, 2);
    const key = { pk: `ORG#${TEST_ORG}#PROJECT_LEARNING#${PROJECT}`, sk: suggestionSk("s1") };
    fixture.db.set({ ...fixture.db.get(key)!, status: "accepted" });
    expect(await refusal(forget(fixture, PRIYA, commentId))).toMatchObject({ pageReason: "refused" });
    expect(corrections(fixture)).toHaveLength(2);
  });
});

describe("audit: Remember and Forget emit rule.correction_remembered", () => {
  it("writes the event in the capture's own transaction (remember), and again for the forget; a repeat of a Remember records nothing more", async () => {
    const fixture = membersTask();
    const audit = capturingAuditDeps({ db: fixture.db, now: () => fixture.deps.now() });
    const comment = seedComment(fixture, SAM, RETRY_TEXT);
    const answer = await rememberTaskComment(fixture.deps, PRIYA, fixture.taskId, comment.commentId, { audit: audit.audit });
    await rememberTaskComment(fixture.deps, PRIYA, fixture.taskId, comment.commentId, { audit: audit.audit });
    expect(audit.recordedBy("rule.correction_remembered")).toEqual([
      expect.objectContaining({ actor: { kind: "member", id: PRIYA.developerId }, target: { kind: "project", name: PROJECT }, facts: { correctionId: answer.correction.id, stage: "plan", standing: "member", op: "remember" } }),
    ]);
    await forgetTaskComment(fixture.deps, PRIYA, fixture.taskId, comment.commentId, { audit: audit.audit });
    expect(audit.recordedBy("rule.correction_remembered").map((event) => event.facts?.op)).toEqual(["remember", "forget"]);
    expect(JSON.stringify(audit.recorded())).not.toContain("retry");
  });

  it("an install with no ledger records nothing and still remembers", async () => {
    const fixture = membersTask();
    const comment = seedComment(fixture, SAM, RETRY_TEXT);
    await remember(fixture, PRIYA, comment.commentId);
    expect(corrections(fixture)).toHaveLength(1);
  });
});

describe("the company's master suggestions switch does not stop capture", () => {
  it("Remember still stores the correction and counts it while suggestions are off, and grouping then only judges it (opens nothing)", async () => {
    const fixture = membersTask();
    fixture.db.set({ ...orgLearningSettingsKey(TEST_ORG), entityType: "LEARNING_COMPANY_SETTINGS", orgId: TEST_ORG, revision: 1, suggestions: "off", changedBy: PRIYA.developerId, changedAt: new Date(0).toISOString() });
    const comment = seedComment(fixture, SAM, RETRY_TEXT);
    const answer = await remember(fixture, PRIYA, comment.commentId);
    expect(answer.correction.standing).toBe("member");
    expect(corrections(fixture)).toHaveLength(1);
    expect((await readLearningState(learningDeps(fixture), scope))?.liveCorrections).toBe(1);
    expect(await groupCorrections(learningDeps(fixture), scope)).toMatchObject({ judged: 1, opened: [] });
    expect(corrections(fixture)[0]).toHaveProperty("groupedAt");
    // Forget keeps working too.
    const forgotten = await forget(fixture, PRIYA, comment.commentId);
    expect(forgotten).toEqual({ forgotten: true });
    expect(corrections(fixture)).toHaveLength(0);
  });
});

describe("M1: the notes lessons may read are the LIVE corrections, so Forget reaches lessons", () => {
  it("a remembered comment is listed (the note id is the correction's id); after Forget it is not, and a comment never remembered never is", async () => {
    const fixture = membersTask();
    const kept = seedComment(fixture, SAM, RETRY_TEXT);
    const forgotten = seedComment(fixture, SAM, "Name the file after the component, in kebab case.");
    const never = seedComment(fixture, SAM, "A comment nobody remembered.");
    const keptAnswer = await remember(fixture, PRIYA, kept.commentId);
    const forgottenAnswer = await remember(fixture, PRIYA, forgotten.commentId);
    const ids = [kept.commentId, forgotten.commentId, never.commentId];
    const live = () => liveRememberedNoteIds(fixture.deps, TEST_ORG, PROJECT, fixture.taskId, ids);
    // Positive control: before the forget both remembered comments are listed.
    expect((await live()).sort()).toEqual([keptAnswer.correction.id, forgottenAnswer.correction.id].sort());
    await forget(fixture, PRIYA, forgotten.commentId);
    expect(await live()).toEqual([keptAnswer.correction.id]);
  });
});
