// Lane ask-linear (LA-1): an answer Rovara posted on a Linear issue names people; when one of them is erased, the stored Ask is scrubbed (already so) AND the posted comment is rewritten from the scrubbed
// words, by the Ask upkeep, through the comment id the Ask recorded. Held here: the waiting item holds ids only; Public (no stored words) leaves nothing to rewrite; a comment that is gone is done; a
// failure waits and is tried again; it is given up on (loudly) after a bounded number of tries; and another org's items are never touched.
import { describe, expect, it } from "vitest";
import { askLinearScrubKey, askLinearScrubPk, sessionAskKey, type OrgId, type SessionId } from "../../packages/contracts/src/index.js";
import { FORMER_MEMBER_MENTION, askPersonTag, eraseAskPerson, writeAsk, type AskWriteInput } from "../../packages/broker/src/agent-sessions/ask-store.js";
import { LINEAR_SCRUB_ATTEMPTS, settleLinearScrubs, type LinearScrubPort } from "../../packages/broker/src/agent-sessions/ask-linear-scrub.js";
import { linearAnswerText } from "../../packages/broker/src/agent-sessions/ask.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const SESSION = "ses_aaaaaaaaaaaaaaaaaaaa" as SessionId;
const MAYA = "m".repeat(64);
const NOW = Date.parse("2026-11-02T10:00:00.000Z");
const askId = (digit: string) => `ask_${digit.repeat(20)}`;
const HASH_KEY = ["ask", "hash", "key", "for", "tests", "only"].join("-");
const COMMENT = "11111111-2222-4333-8444-555555555555";

function world() {
  const db = new FakeDynamoDb();
  const erased = new Set<string>();
  const deps = { documentClient: db, tableName: "state", questionHashKey: HASH_KEY, erasedPeople: async () => [], isErased: async (developerId: string) => erased.has(developerId) };
  const ask = async (overrides: Partial<AskWriteInput> = {}) => {
    const input: AskWriteInput = { edition: "enterprise", orgId: ORG_A, sessionId: SESSION, askId: askId("1"), audience: "linear", question: "who reviewed it?", answer: "Maya Chen reviewed it.", contextBytes: 10, model: "m", nowMs: NOW, people: [{ developerId: MAYA, names: ["Maya Chen"] }], ...overrides };
    return writeAsk(deps, input);
  };
  return { db, deps, ask, erased };
}

/** The Ask's own record gets the post the way `completeAsk` records it. */
async function recordPost(w: ReturnType<typeof world>, id = askId("1"), post: Record<string, unknown> = { issueKey: "ENG-142", commentId: COMMENT }, orgId: OrgId = ORG_A) {
  const key = sessionAskKey(orgId, SESSION, id);
  w.db.set({ ...w.db.get(key)!, linearComment: post });
}

function portOf(options: { failUpdate?: () => unknown; gone?: boolean } = {}) {
  const updates: Array<{ commentId: string; text: string }> = [];
  const removed: string[] = [];
  const port: LinearScrubPort = {
    update: async (input) => {
      if (options.failUpdate !== undefined) throw options.failUpdate();
      if (options.gone === true) throw Object.assign(new Error("gone"), { code: "NOT_FOUND" });
      updates.push({ commentId: input.commentId, text: input.text });
    },
    remove: async (input) => { removed.push(input.commentId); },
  };
  return { port, updates, removed };
}

const waiting = (w: ReturnType<typeof world>, orgId: OrgId = ORG_A) => w.db.find((item) => item.pk === askLinearScrubPk(orgId)) as Array<Record<string, unknown>>;

describe("erasing a person leaves their Linear comments waiting to be rewritten", () => {
  it("leaves one waiting item per posted comment that named them, with ids only", async () => {
    const w = world();
    await w.ask();
    await recordPost(w);
    expect(await eraseAskPerson(w.deps, ORG_A, MAYA, undefined, ["Maya Chen"])).toMatchObject({ scrubbed: 1, complete: true });
    const items = waiting(w);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ ...askLinearScrubKey(ORG_A, SESSION, askId("1")), orgId: ORG_A, sessionId: SESSION, askId: askId("1"), issueKey: "ENG-142", commentId: COMMENT });
    expect(JSON.stringify(items)).not.toMatch(/Maya|reviewed|who reviewed/u);
  });

  it("an Ask that was not posted to Linear leaves nothing waiting, and neither does Public (no stored words, so no one is named in what is kept)", async () => {
    const w = world();
    await w.ask({ askId: askId("2") }, null);
    await eraseAskPerson(w.deps, ORG_A, MAYA, undefined, ["Maya Chen"]);
    expect(waiting(w)).toHaveLength(0);
    const p = world();
    await p.ask({ edition: "public" });
    await recordPost(p);
    await eraseAskPerson(p.deps, ORG_A, MAYA, undefined, ["Maya Chen"]);
    expect(waiting(p)).toHaveLength(0);
  });
});

describe("the upkeep rewrites them", () => {
  it("rewrites the comment from the scrubbed record: the person is gone from it, the label and the AI line stay, and the waiting item is removed", async () => {
    const w = world();
    await w.ask();
    await recordPost(w);
    await eraseAskPerson(w.deps, ORG_A, MAYA, undefined, ["Maya Chen"]);
    const port = portOf();
    const result = await settleLinearScrubs({ documentClient: w.db, tableName: "state", port: port.port }, ORG_A);
    expect(result).toMatchObject({ rewritten: 1, removed: 0, waiting: 0 });
    expect(port.updates).toHaveLength(1);
    expect(port.updates[0]!.commentId).toBe(COMMENT);
    // The mention is written with a break after the @, as every Linear text is, so it can never notify anyone.
    expect(port.updates[0]!.text.replace(/\u200b/gu, "")).toContain(FORMER_MEMBER_MENTION);
    expect(port.updates[0]!.text).not.toMatch(/Maya|Chen/u);
    expect(port.updates[0]!.text).not.toContain(askPersonTag(MAYA));
    expect(port.updates[0]!.text).toBe(linearAnswerText(`${FORMER_MEMBER_MENTION} reviewed it.`));
    expect(waiting(w)).toHaveLength(0);
    // Run again: nothing left.
    expect(await settleLinearScrubs({ documentClient: w.db, tableName: "state", port: port.port }, ORG_A)).toMatchObject({ rewritten: 0, removed: 0, waiting: 0 });
  });

  it("deletes the comment when there are no scrubbed words to put back (the Ask is gone)", async () => {
    const w = world();
    await w.ask();
    await recordPost(w);
    await eraseAskPerson(w.deps, ORG_A, MAYA, undefined, ["Maya Chen"]);
    w.db.delete(sessionAskKey(ORG_A, SESSION, askId("1")));
    const port = portOf();
    expect(await settleLinearScrubs({ documentClient: w.db, tableName: "state", port: port.port }, ORG_A)).toMatchObject({ rewritten: 0, removed: 1 });
    expect(port.removed).toEqual([COMMENT]);
    expect(waiting(w)).toHaveLength(0);
  });

  it("a comment that is already gone is done", async () => {
    const w = world();
    await w.ask();
    await recordPost(w);
    await eraseAskPerson(w.deps, ORG_A, MAYA, undefined, ["Maya Chen"]);
    await settleLinearScrubs({ documentClient: w.db, tableName: "state", port: portOf({ gone: true }).port }, ORG_A);
    expect(waiting(w)).toHaveLength(0);
  });

  it("a failure waits and counts; it is tried again; after the bounded tries it is given up on with a log line by name, not a silent drop", async () => {
    const w = world();
    await w.ask();
    await recordPost(w);
    await eraseAskPerson(w.deps, ORG_A, MAYA, undefined, ["Maya Chen"]);
    const logged: Array<Record<string, unknown>> = [];
    const down = portOf({ failUpdate: () => Object.assign(new Error("linear down for lin_api_SECRET"), { code: "RUNTIME_UNAVAILABLE" }) });
    const deps = { documentClient: w.db, tableName: "state", port: down.port, log: (entry: Record<string, unknown>) => logged.push(entry) };
    expect(await settleLinearScrubs(deps, ORG_A)).toMatchObject({ waiting: 1, gaveUp: 0 });
    expect(waiting(w)[0]).toMatchObject({ attempts: 1 });
    for (let run = 2; run < LINEAR_SCRUB_ATTEMPTS; run += 1) await settleLinearScrubs(deps, ORG_A);
    expect(waiting(w)).toHaveLength(1);
    expect(await settleLinearScrubs(deps, ORG_A)).toMatchObject({ gaveUp: 1 });
    expect(waiting(w)).toHaveLength(0);
    expect(logged.at(-1)).toMatchObject({ event: "ask.linear_scrub_gave_up" });
    expect(JSON.stringify(logged)).not.toContain("lin_api");
    // And once Linear is back, a fresh erase is rewritten as normal.
  });

  it("never touches another org's waiting items", async () => {
    const w = world();
    w.db.set({ ...askLinearScrubKey(ORG_B, SESSION, askId("9")), entityType: "ASK_LINEAR_FIX", orgId: ORG_B, sessionId: SESSION, askId: askId("9"), issueKey: "ENG-1", commentId: COMMENT, attempts: 0 });
    const port = portOf();
    await settleLinearScrubs({ documentClient: w.db, tableName: "state", port: port.port }, ORG_A);
    expect(port.updates).toHaveLength(0);
    expect(port.removed).toHaveLength(0);
    expect(waiting(w, ORG_B)).toHaveLength(1);
  });
});
