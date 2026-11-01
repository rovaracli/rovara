// Live interaction L1: a Linear comment on an issue a session follows. Linear is ASK-ONLY: `@rovara ask <question>` becomes an Ask for the Linear audience; anything else addressed to Rovara gets one
// reply with a link and changes nothing; an unsigned delivery, another organization's, an unbound issue, another project's, a bot's comment and a comment that does not mention Rovara are ignored and
// write nothing. Every author is an outsider (no Linear-to-member link): the Ask is rated by a hash of the author, and its context is the Linear tier's alone.
import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { askRequestKey, type HookRecord, type OrgId } from "../../packages/contracts/src/index.js";
import { askIdFor, completeAsk, prepareAskTurn, type AskDependencies } from "../../packages/broker/src/agent-sessions/ask.js";
import { bindSessionSurface } from "../../packages/broker/src/agent-sessions/bindings.js";
import { LINEAR_BUSY_REPLY, LINEAR_LINK_REPLY, LINEAR_TOO_LONG_REPLY, askQuestionOf, handleLinearComment, linearAskerKey, type LinearReplyPort } from "../../packages/broker/src/rovara-code/linear-comments.js";
import { linearCommentOf, linearProvider } from "../../packages/broker/src/triggers/providers/linear.js";
import { ORG_A, PRIYA, sessionWorld } from "../support/agent-session-world.js";
import { LINEAR_TENANT, SECRET_1, setupHookWorld } from "../support/hook-fixtures.js";
import { capturingAuditDeps } from "../support/audit-capture.js";

const ISSUE = "ENG-142";
const OUTSIDER = "linear-user-outsider-1";
const KEY = "k".repeat(48);
const QUESTION = "Why is this blocked?";

type Replies = Array<{ orgId: OrgId; issueKey: string; text: string }>;

async function world(options: { edition?: "enterprise" | "public"; bind?: boolean; project?: string; enabled?: boolean; reply?: boolean } = {}) {
  const w = sessionWorld();
  const made = w.seedSession({ kind: "task", owner: PRIYA, project: options.project ?? "web" });
  w.db.set({
    ...w.db.get({ pk: `DEVTASK#${made.taskId}`, sk: "META" })!, title: "Bump the Stripe SDK",
    workflow: { revision: 1, stage: "IMPLEMENT", state: "RUNNING", artifacts: [], decisions: [], pullRequests: [], checkPolicy: { required: [], optional: [], selectedOptionalIds: [] } },
  });
  if (options.bind !== false) await bindSessionSurface({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, { orgId: ORG_A, sessionId: made.sessionId, binding: { kind: "linear_issue", issueId: ISSUE, url: `https://linear.app/issue/${ISSUE}` } });
  const hw = setupHookWorld({ linear: linearProvider }, { db: w.db, clock: w.clock });
  const hook = await hw.hook({ source: "linear", orgId: ORG_A, project: "web", secret: SECRET_1 });
  const replies: Replies = [];
  const reply: LinearReplyPort = { reply: async (input) => { replies.push(input); } };
  const sent: Array<{ body: string }> = [];
  const audit = capturingAuditDeps({ db: w.db, now: () => w.clock.now });
  const ask: AskDependencies = {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, edition: options.edition ?? "enterprise", enabled: options.enabled ?? true, queue: { send: async (message) => { sent.push(message); } },
    access: { documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members }, actions: {} as never, readers: {},
    store: () => ({ documentClient: w.db, tableName: "state", questionHashKey: KEY, isErased: async () => false, erasedPeople: async () => [] }),
    audit: { ...audit.deps, documentClient: w.db, tableName: "state" }, people: async () => [], orchestratorInstructions: async () => "x", defaultModel: "chat-runtime", linearReply: reply,
  };
  const deps = { documentClient: w.db, tableName: "state", now: () => w.clock.now, ask: options.enabled === false ? undefined : ask, reply: options.reply === false ? undefined : reply, taskPageLink: (_org: OrgId, id: string) => `https://app.example.invalid/s/${id}` };
  const outcomes: string[] = [];
  // The hook ingress offers the intake every verified Linear delivery's body.
  hw.deps.commentIntake = async (input) => { outcomes.push(await handleLinearComment(deps, input)); };
  const comment = (text: string, extra: Record<string, unknown> = {}, id: string = randomUUID()) => ({
    type: "Comment", action: "create", organizationId: LINEAR_TENANT.organizationId, url: `https://linear.app/acme/issue/${ISSUE}/bump-the-sdk#comment-${id}`, webhookTimestamp: w.clock.now,
    actor: { id: OUTSIDER, type: "user", name: "Outside Person" }, data: { id, body: text, userId: OUTSIDER, issueId: "uuid-of-the-issue", ...extra },
  });
  const send = (body: unknown, options2: { signed?: boolean; secret?: string | null } = {}) => hw.receive(hw.delivery(hook, JSON.stringify(body), options2.signed === false ? { secret: null } : {
    secret: null, headers: { "linear-signature": createHmac("sha256", options2.secret ?? SECRET_1).update(JSON.stringify(body)).digest("hex") },
  }));
  const table = () => (w.db.find(() => true) as Array<Record<string, unknown>>).map((item) => JSON.stringify(item)).sort();
  return { w, made, hw, hook, ask, deps, replies, sent, outcomes, comment, send, table, audit };
}

describe("a comment that asks", () => {
  it("`@rovara ask <question>` on a bound issue queues an Ask for the Linear audience, rated by a hash of the author, with no member and no question stored while it waits", async () => {
    const t = await world();
    const body = t.comment(`@rovara ask ${QUESTION}`);
    const reply = await t.send(body);
    expect(reply.status).toBeLessThan(300);
    expect(t.outcomes).toEqual(["asked"]);
    expect(t.sent).toHaveLength(1);
    const message = JSON.parse(t.sent[0]!.body) as { ask: { audience: string; askId: string; sessionId: string }; text: string };
    expect(message).toMatchObject({ ask: { audience: "linear", sessionId: t.made.sessionId }, text: QUESTION });
    const request = t.w.db.get(askRequestKey(ORG_A, t.made.sessionId, message.ask.askId)) as Record<string, unknown>;
    expect(request).toMatchObject({ audience: "linear", issueId: ISSUE, askerKey: linearAskerKey(OUTSIDER), state: "queued" });
    expect(request).not.toHaveProperty("askedBy");
    expect(JSON.stringify(t.table())).not.toContain(OUTSIDER);
    expect(JSON.stringify(t.table())).not.toContain("Why is this blocked");
    expect(message.ask.askId).toBe(askIdFor(ORG_A, linearAskerKey(OUTSIDER), (body.data as { id: string }).id));
  });

  it("the service gets the Linear context only (title, stage, next step; no plan, diff, checks or notes), and the answer goes back to the issue as Rovara's, with its label and no live @mention", async () => {
    const t = await world();
    await t.send(t.comment(`@rovara ask ${QUESTION}`));
    const askId = (JSON.parse(t.sent[0]!.body) as { ask: { askId: string } }).ask.askId;
    const ref = { orgId: ORG_A, sessionId: t.made.sessionId, askId };
    const turn = await prepareAskTurn(t.ask, ref);
    expect(turn.taskContext).toContain("Bump the Stripe SDK");
    expect(turn.taskContext).toContain("For more than this, open the task page.");
    for (const absent of ["task_document", "diff_patch", "person_note", "Check results", "Pull requests:"]) expect(turn.taskContext, absent).not.toContain(absent);
    await completeAsk(t.ask, { ...ref, outcome: "ANSWERED", text: `It is blocked on a check. Ask @maya about it. key ${`ghp_${"Ab1Cd2Ef3G".repeat(4)}`}`, question: QUESTION });
    expect(t.replies).toHaveLength(1);
    expect(t.replies[0]).toMatchObject({ orgId: ORG_A, issueKey: ISSUE });
    expect(t.replies[0]!.text).toContain("It is blocked on a check.");
    expect(t.replies[0]!.text).toContain("AI answer from this task's data; it can be wrong.");
    expect(t.replies[0]!.text).not.toContain("@maya");
    expect(t.replies[0]!.text).not.toContain("ghp_");
    // Enterprise audits it (as an outsider: the system), and it is stored per the edition's rule; the answer is read by no member.
    expect(t.audit.recordedBy("task.asked")).toHaveLength(1);
    // A redelivery of the answer replies nothing more.
    await completeAsk(t.ask, { ...ref, outcome: "ANSWERED", text: "again", question: QUESTION });
    expect(t.replies).toHaveLength(1);
  });

  it("a failed Ask tells the issue in fixed words, once", async () => {
    const t = await world();
    await t.send(t.comment(`@rovara ask ${QUESTION}`));
    const askId = (JSON.parse(t.sent[0]!.body) as { ask: { askId: string } }).ask.askId;
    await completeAsk(t.ask, { orgId: ORG_A, sessionId: t.made.sessionId, askId, outcome: "FAILED" });
    await completeAsk(t.ask, { orgId: ORG_A, sessionId: t.made.sessionId, askId, outcome: "FAILED" });
    expect(t.replies.map((entry) => entry.text)).toEqual(["Couldn't answer that just now."]);
  });

  it("is rated: a second question from the same author while the first waits is told so; another author is not held; the same comment again does nothing", async () => {
    const t = await world();
    await t.send(t.comment(`@rovara ask first`));
    await t.send(t.comment(`@rovara ask second`));
    expect(t.outcomes).toEqual(["asked", "refused"]);
    expect(t.replies.map((entry) => entry.text)).toEqual([LINEAR_BUSY_REPLY]);
    const other = t.comment(`@rovara ask third`, { userId: "someone-else" });
    other.actor = { id: "someone-else", type: "user", name: "Someone" };
    await t.send(other);
    expect(t.outcomes.at(-1)).toBe("asked");
    // Linear retries a delivery: the same comment is handled once.
    const again = t.comment(`@rovara ask once`, {}, "11111111-2222-4333-8444-555555555555");
    await t.send(again);
    await t.send(again);
    expect(t.outcomes.at(-1)).toBe("duplicate");
    expect(t.sent.filter((message) => message.body.includes("once"))).toHaveLength(0);
  });

  it("parses the question after the mention, in either form Linear writes it", () => {
    expect(askQuestionOf("@rovara ask why?")).toBe("why?");
    expect(askQuestionOf("  [@rovara](https://linear.app/acme/profiles/rovara) ask: why?")).toBe("why?");
    expect(askQuestionOf("@Rovara ASK   why\nand more")).toBe("why\nand more");
    for (const notAsk of ["@rovara", "@rovara ask", "@rovara stop", "please @rovara ask why", "@rovara asks why", "ask @rovara why"]) expect(askQuestionOf(notAsk), notAsk).toBeUndefined();
  });
});

describe("Linear is ask-only: nothing but a link comes back for a stop or an instruction", () => {
  it("a stop, a change, an approval or a request is one reply with the link and changes nothing at all", async () => {
    const t = await world();
    for (const text of ["@rovara stop", "@rovara stop this now", "@rovara please change the retry logic", "@rovara approve the plan", "@rovara redirect: use the other endpoint", "hey @rovara can you merge it"]) {
      const before = t.table();
      await t.send(t.comment(text));
      // Only the comment's own marker is new; no session, task, message, rate, lock, request or queue item.
      const added = t.table().filter((item) => !before.includes(item) && !/"pk":"[^"]*HOOK/u.test(item));
      expect(added.every((item) => item.includes('"ASK_LINEAR_COMMENT"')), `${text}: ${added.join(" | ").slice(0, 300)}`).toBe(true);
    }
    expect(t.outcomes).toEqual(Array(6).fill("link_reply"));
    expect(t.sent).toEqual([]);
    expect(t.replies).toHaveLength(6);
    for (const reply of t.replies) expect(reply.text).toBe(`${LINEAR_LINK_REPLY}: https://app.example.invalid/s/${t.made.sessionId}`);
    // The session, the task and the steer notes are as they were.
    expect(t.w.db.find((item) => String(item.sk).startsWith("MESSAGE#") || String(item.sk).startsWith("NOTE#") || String(item.sk).startsWith("REQUEST#") || String(item.pk).startsWith("OUTBOX#"))).toEqual([]);
  });

  it("a question that is too long is told to use the task page, and spends nothing", async () => {
    const t = await world();
    await t.send(t.comment(`@rovara ask ${"x".repeat(1001)}`));
    expect(t.outcomes).toEqual(["link_reply"]);
    expect(t.replies[0]!.text).toBe(`${LINEAR_TOO_LONG_REPLY}.`);
    expect(t.sent).toEqual([]);
  });
});

describe("what is ignored without a word, and writes nothing", () => {
  async function ignored(t: Awaited<ReturnType<typeof world>>, body: unknown, options?: { signed?: boolean; secret?: string | null }) {
    const before = t.table();
    const reply = await t.send(body, options);
    expect(t.replies).toEqual([]);
    expect(t.sent).toEqual([]);
    expect(t.table().filter((item) => !before.includes(item) && !/"pk":"[^"]*HOOK/u.test(item))).toEqual([]);
    return reply;
  }

  it("an unsigned or wrongly signed delivery is refused by the hook before anything is read: the intake never runs", async () => {
    const t = await world();
    const body = t.comment(`@rovara ask ${QUESTION}`);
    expect((await t.send(body, { signed: false })).status).toBe(403);
    expect((await t.send(body, { secret: "not-the-secret-0123456789abcdef" })).status).toBe(403);
    expect(t.outcomes).toEqual([]);
    expect(t.sent).toEqual([]);
    expect(t.replies).toEqual([]);
  });

  it("another Linear organization's delivery is refused at the hook, and a comment that carries the wrong team is not read", async () => {
    const t = await world();
    expect((await t.send({ ...t.comment(`@rovara ask ${QUESTION}`), organizationId: "22222222-2222-4222-8222-222222222222" })).status).toBe(403);
    expect(t.outcomes).toEqual([]);
    await ignored(t, t.comment(`@rovara ask ${QUESTION}`, { teamId: "99999999-9999-4999-8999-999999999999" }));
    expect(t.outcomes).toEqual(["ignored"]);
  });

  it("a comment on an issue no session follows, or that a session of another project follows, is ignored", async () => {
    const unbound = await world({ bind: false });
    await ignored(unbound, unbound.comment(`@rovara ask ${QUESTION}`));
    expect(unbound.outcomes).toEqual(["ignored"]);
    const other = await world({ project: "ops" });
    await ignored(other, other.comment(`@rovara ask ${QUESTION}`));
    expect(other.outcomes).toEqual(["ignored"]);
    const elsewhere = await world();
    const moved = elsewhere.comment(`@rovara ask ${QUESTION}`);
    moved.url = "https://linear.app/acme/issue/ENG-999/some-other-issue#comment-x";
    await ignored(elsewhere, moved);
    expect(elsewhere.outcomes).toEqual(["ignored"]);
  });

  it("the issue is read from the comment's own https link on linear.app, never from free text: a comment that only SAYS an issue key, or links elsewhere, is ignored", async () => {
    const t = await world();
    const said = t.comment(`@rovara ask about ENG-142 please`);
    delete (said as { url?: string }).url;
    await ignored(t, said);
    const elsewhere = t.comment(`@rovara ask ${QUESTION}`);
    elsewhere.url = `https://evil.example.invalid/issue/${ISSUE}`;
    await ignored(t, elsewhere);
    const insecure = t.comment(`@rovara ask ${QUESTION}`);
    insecure.url = `http://linear.app/acme/issue/${ISSUE}`;
    await ignored(t, insecure);
    expect(t.outcomes).toEqual(["ignored", "ignored", "ignored"]);
  });

  it("a comment by an application or integration (Rovara's own replies among them), a deleted or edited comment, and a comment that does not mention Rovara are ignored", async () => {
    const t = await world();
    const bot = t.comment(`@rovara ask ${QUESTION}`);
    bot.actor = { id: "app-1", type: "application", name: "Some app" };
    await ignored(t, bot);
    await ignored(t, { ...t.comment(`@rovara ask ${QUESTION}`), action: "update" });
    await ignored(t, { ...t.comment(`@rovara ask ${QUESTION}`), action: "remove" });
    await ignored(t, t.comment("just talking to a colleague about this issue"));
    await ignored(t, { ...t.comment(`@rovara ask ${QUESTION}`), type: "Issue" });
    expect(t.outcomes.filter((outcome) => outcome !== "ignored")).toEqual([]);
  });

  it("does nothing while the Ask switch is off, or while Rovara has no way to write in Linear: nothing is read, spent or queued", async () => {
    for (const options of [{ enabled: false }, { reply: false }] as const) {
      const t = await world(options);
      const before = t.table();
      await t.send(t.comment(`@rovara ask ${QUESTION}`));
      expect(t.outcomes, JSON.stringify(options)).toEqual(["unavailable"]);
      expect(t.sent).toEqual([]);
      expect(t.table().filter((item) => !before.includes(item) && !/"pk":"[^"]*HOOK/u.test(item))).toEqual([]);
    }
  });

  it("the comment parser believes the hook's own organization and nothing else", () => {
    const hook = { source: "linear", tenant: LINEAR_TENANT } as unknown as HookRecord;
    const ok = { type: "Comment", action: "create", organizationId: LINEAR_TENANT.organizationId, url: `https://linear.app/acme/issue/${ISSUE}/x`, actor: { id: "u", type: "user" }, data: { id: "c1", body: "@rovara ask x" } };
    expect(linearCommentOf(ok, hook)).toMatchObject({ commentId: "c1", issueKey: ISSUE, authorId: "u" });
    expect(linearCommentOf({ ...ok, organizationId: "other" }, hook)).toBeUndefined();
    expect(linearCommentOf({ ...ok, actor: { id: "u", type: "integration" } }, hook)).toBeUndefined();
    expect(linearCommentOf({ ...ok, actor: null }, hook)).toBeUndefined();
    expect(linearCommentOf(ok, { source: "jira", tenant: LINEAR_TENANT } as unknown as HookRecord)).toBeUndefined();
    expect(linearCommentOf("nope", hook)).toBeUndefined();
  });
});
