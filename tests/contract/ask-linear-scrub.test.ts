// Lane ask-linear (LA-1): an answer Rovara posted on a Linear issue names people; when one of them is erased, the stored Ask is scrubbed (already so) AND the posted comment is rewritten from the scrubbed
// words, by the Ask upkeep, through the comment id the Ask recorded. Held here: the waiting item holds ids only; Public (no stored words) leaves nothing to rewrite; a comment that is gone is done; a
// failure waits and is tried again; it is given up on (loudly) after a bounded number of tries; and another org's items are never touched.
import { describe, expect, it } from "vitest";
import { askLinearKeptPk, askLinearScrubKey, askLinearScrubPk, sessionAskKey, type OrgId, type SessionId } from "@rovara-code/contracts";
import { FORMER_MEMBER_MENTION, askPersonTag, eraseAskPerson, writeAsk, type AskWriteInput } from "../../packages/broker/src/agent-sessions/ask-store.js";
import { LINEAR_SCRUB_ATTEMPTS, settleLinearScrubs, type LinearScrubPort } from "../../packages/broker/src/agent-sessions/ask-linear-scrub.js";
import { linearAnswerText } from "../../packages/broker/src/agent-sessions/ask.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
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

const kept = (w: ReturnType<typeof world>, orgId: OrgId = ORG_A) => w.db.find((item) => item.pk === askLinearKeptPk(orgId)) as Array<Record<string, unknown>>;
const waiting = (w: ReturnType<typeof world>, orgId: OrgId = ORG_A) => w.db.find((item) => item.pk === askLinearScrubPk(orgId) && item.sk !== "CURSOR") as Array<Record<string, unknown>>;

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
    await w.ask({ askId: askId("2") });
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

  it("a failure waits and counts; it is tried again; after the bounded tries it is given up on, and the give-up is a LASTING record (an item an admin reads and an audit event), not only a log line (B1)", async () => {
    const w = world();
    await w.ask();
    await recordPost(w);
    await eraseAskPerson(w.deps, ORG_A, MAYA, undefined, ["Maya Chen"]);
    const logged: Array<Record<string, unknown>> = [];
    const audit = capturingAuditDeps({ db: w.db, now: () => NOW });
    const down = portOf({ failUpdate: () => Object.assign(new Error("linear down for lin_api_SECRET"), { code: "FORBIDDEN" }) });
    const deps = { documentClient: w.db, tableName: "state", port: down.port, audit: audit.audit, clock: () => NOW, log: (entry: Record<string, unknown>) => logged.push(entry) };
    expect(await settleLinearScrubs(deps, ORG_A)).toMatchObject({ waiting: 1, gaveUp: 0 });
    expect(waiting(w)[0]).toMatchObject({ attempts: 1 });
    for (let run = 2; run < LINEAR_SCRUB_ATTEMPTS; run += 1) await settleLinearScrubs(deps, ORG_A);
    expect(waiting(w)).toHaveLength(1);
    expect(kept(w)).toHaveLength(0);
    expect(await settleLinearScrubs(deps, ORG_A)).toMatchObject({ gaveUp: 1 });
    expect(waiting(w)).toHaveLength(0);
    expect(logged.at(-1)).toMatchObject({ event: "ask.linear_scrub_gave_up", reason: "not_rovaras" });
    expect(JSON.stringify(logged)).not.toContain("lin_api");
    // The lasting item: ids, a fixed reason word and the count; never words, never the comment's own id.
    expect(kept(w)).toHaveLength(1);
    expect(kept(w)[0]).toMatchObject({ orgId: ORG_A, sessionId: SESSION, askId: askId("1"), issueKey: "ENG-142", reason: "not_rovaras", attempts: LINEAR_SCRUB_ATTEMPTS });
    expect(JSON.stringify(kept(w))).not.toMatch(/Maya|reviewed|lin_api/u);
    // And one audit event of the same facts.
    const events = audit.recordedBy("ask.linear_comment_kept");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ orgId: ORG_A, target: { kind: "session", id: SESSION }, facts: { cause: "not_rovaras", attempts: LINEAR_SCRUB_ATTEMPTS } });
    expect(JSON.stringify(events)).not.toMatch(/Maya|reviewed|lin_api/u);
  });

  it("the reason word says what went wrong: no usable connection is no_connection, anything else unavailable", async () => {
    for (const [code, reason] of [["CONFIG_INVALID", "no_connection"], ["RUNTIME_UNAVAILABLE", "unavailable"]] as const) {
      const w = world();
      await w.ask();
      await recordPost(w);
      await eraseAskPerson(w.deps, ORG_A, MAYA, undefined, ["Maya Chen"]);
      const deps = { documentClient: w.db, tableName: "state", port: portOf({ failUpdate: () => Object.assign(new Error("x"), { code }) }).port, clock: () => NOW };
      for (let run = 1; run <= LINEAR_SCRUB_ATTEMPTS; run += 1) await settleLinearScrubs(deps, ORG_A);
      expect(kept(w)[0]).toMatchObject({ reason });
    }
  });

  it("when the lasting record cannot be written the item stays and is given up on again next run (never lost)", async () => {
    const w = world();
    await w.ask();
    await recordPost(w);
    await eraseAskPerson(w.deps, ORG_A, MAYA, undefined, ["Maya Chen"]);
    const fail = { on: true };
    const documentClient = { send: (command: unknown) => (fail.on && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand" ? Promise.reject(new Error("throttled")) : w.db.send(command as never)) } as unknown as typeof w.db;
    const deps = { documentClient, tableName: "state", port: portOf({ failUpdate: () => Object.assign(new Error("x"), { code: "RUNTIME_UNAVAILABLE" }) }).port, clock: () => NOW };
    for (let run = 1; run <= LINEAR_SCRUB_ATTEMPTS + 1; run += 1) await settleLinearScrubs(deps, ORG_A);
    expect(waiting(w)).toHaveLength(1);
    expect(kept(w)).toHaveLength(0);
    fail.on = false;
    expect(await settleLinearScrubs(deps, ORG_A)).toMatchObject({ gaveUp: 1 });
    expect(waiting(w)).toHaveLength(0);
    expect(kept(w)).toHaveLength(1);
  });

  it("Linear asking Rovara to slow down is nobody's fault: the run stops, nothing is counted against the item, the next run starts at that item (S4)", async () => {
    const w = world();
    for (const digit of ["1", "2", "3"]) {
      await w.ask({ askId: askId(digit) });
      await recordPost(w, askId(digit), { issueKey: "ENG-142", commentId: `00000000-0000-4000-8000-00000000000${digit}` });
    }
    await eraseAskPerson(w.deps, ORG_A, MAYA, undefined, ["Maya Chen"]);
    const seen: string[] = [];
    let limited = true;
    const port: LinearScrubPort = {
      update: async (input) => {
        if (input.commentId.endsWith("2") && limited) throw Object.assign(new Error("slow down"), { code: "TOO_MANY_REQUESTS" });
        seen.push(input.commentId.slice(-1));
      },
      remove: async () => undefined,
    };
    const deps = { documentClient: w.db, tableName: "state", port, clock: () => NOW };
    expect(await settleLinearScrubs(deps, ORG_A)).toMatchObject({ rewritten: 1, complete: false });
    expect(seen).toEqual(["1"]);
    expect(waiting(w).every((item) => (item["attempts"] as number) === 0)).toBe(true);
    limited = false;
    await settleLinearScrubs(deps, ORG_A);
    expect(waiting(w)).toHaveLength(0);
    expect([...seen].sort()).toEqual(["1", "2", "3"]);
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

describe("S2: the upkeep visits every waiting item, within a time budget, and a failing item cannot hold the others back", () => {
  async function many(w: ReturnType<typeof world>, count: number) {
    for (let index = 0; index < count; index += 1) {
      const id = `ask_${String(index).padStart(20, "0")}`;
      await w.ask({ askId: id });
      await recordPost(w, id, { issueKey: "ENG-142", commentId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` });
    }
    await eraseAskPerson(w.deps, ORG_A, MAYA, undefined, ["Maya Chen"]);
  }

  it("more than a page of items (and items before them that keep failing) are all settled in ONE run", async () => {
    const w = world();
    await many(w, 130);
    expect(waiting(w)).toHaveLength(130);
    const rewritten: string[] = [];
    // The first 30 comments fail every time (e.g. refused); the other 100 are fine.
    const port: LinearScrubPort = {
      update: async (input) => {
        if (Number(input.commentId.slice(-12)) < 30) throw Object.assign(new Error("refused"), { code: "FORBIDDEN" });
        rewritten.push(input.commentId);
      },
      remove: async () => undefined,
    };
    const result = await settleLinearScrubs({ documentClient: w.db, tableName: "state", port, clock: () => NOW }, ORG_A);
    expect(result).toMatchObject({ rewritten: 100, waiting: 30, complete: true });
    expect(waiting(w)).toHaveLength(30);
    expect(waiting(w).every((item) => item["attempts"] === 1)).toBe(true);
    // The failing ones are tried once per run, not more.
    await settleLinearScrubs({ documentClient: w.db, tableName: "state", port, clock: () => NOW }, ORG_A);
    expect(waiting(w).every((item) => item["attempts"] === 2)).toBe(true);
  });

  it("a run that runs out of time keeps where it stopped, and the next run goes on from there and wraps round: every item is reached", async () => {
    const w = world();
    await many(w, 12);
    const order: number[] = [];
    const port: LinearScrubPort = { update: async (input) => { order.push(Number(input.commentId.slice(-12))); }, remove: async () => undefined };
    // A clock that spends one second per item against a budget of five.
    let ticks = 0;
    const clock = () => NOW + ticks * 1000;
    const wrapped: LinearScrubPort = { update: async (input) => { ticks += 1; return port.update(input); }, remove: (input) => port.remove(input) };
    const deps = { documentClient: w.db, tableName: "state", port: wrapped, clock, budgetMs: 5000 };
    const first = await settleLinearScrubs(deps, ORG_A);
    expect(first.complete).toBe(false);
    expect(order).toHaveLength(5);
    expect(waiting(w)).toHaveLength(7);
    ticks = 0;
    const second = await settleLinearScrubs(deps, ORG_A);
    expect(second.complete).toBe(false);
    expect(order).toHaveLength(10);
    ticks = 0;
    const third = await settleLinearScrubs(deps, ORG_A);
    expect(third.complete).toBe(true);
    expect(order).toHaveLength(12);
    expect(new Set(order).size).toBe(12);
    expect(waiting(w)).toHaveLength(0);
    // The cursor is gone once everything has been visited.
    expect(w.db.find((item) => item.pk === askLinearScrubPk(ORG_A))).toHaveLength(0);
  });

  it("a cursor in the middle makes the next run wrap: items before it are reached after the ones behind it, and a failing item at the front does not starve those behind", async () => {
    const w = world();
    await many(w, 6);
    const order: number[] = [];
    let ticks = 0;
    const port: LinearScrubPort = {
      update: async (input) => {
        ticks += 1;
        const n = Number(input.commentId.slice(-12));
        if (n === 0) throw Object.assign(new Error("refused"), { code: "FORBIDDEN" });
        order.push(n);
      },
      remove: async () => undefined,
    };
    const deps = { documentClient: w.db, tableName: "state", port, clock: () => NOW + ticks * 1000, budgetMs: 2500 };
    await settleLinearScrubs(deps, ORG_A);
    expect(order).toEqual([1, 2]);
    ticks = 0;
    await settleLinearScrubs(deps, ORG_A);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    ticks = 0;
    await settleLinearScrubs(deps, ORG_A);
    expect(waiting(w)).toHaveLength(1);
    expect(waiting(w)[0]).toMatchObject({ attempts: 2 });
  });
});

describe("AL-1: the posting workspace goes with the comment to the port", () => {
  it("passes the workspace the post recorded to the rewrite and to the delete", async () => {
    const w = world();
    await w.ask();
    await recordPost(w, askId("1"), { issueKey: "ENG-142", commentId: COMMENT, workspace: "acme" });
    await eraseAskPerson(w.deps, ORG_A, MAYA, undefined, ["Maya Chen"]);
    const seen: Array<{ kind: string; workspace?: string | undefined }> = [];
    const port: LinearScrubPort = {
      update: async (input) => { seen.push({ kind: "update", workspace: input.workspace }); },
      remove: async (input) => { seen.push({ kind: "remove", workspace: input.workspace }); },
    };
    await settleLinearScrubs({ documentClient: w.db, tableName: "state", port }, ORG_A);
    expect(seen).toEqual([{ kind: "update", workspace: "acme" }]);
    // An Ask with nothing to rewrite from is deleted, in the same workspace.
    const p = world();
    await p.ask({ edition: "public", askId: askId("3") });
    await recordPost(p, askId("3"), { issueKey: "ENG-142", commentId: COMMENT, workspace: "acme" });
    p.db.set({ pk: askLinearScrubPk(ORG_A), sk: "x", entityType: "ASK_LINEAR_FIX", orgId: ORG_A, sessionId: SESSION, askId: askId("3"), issueKey: "ENG-142", commentId: COMMENT, workspace: "acme", attempts: 0 });
    seen.length = 0;
    await settleLinearScrubs({ documentClient: p.db, tableName: "state", port }, ORG_A);
    expect(seen).toEqual([{ kind: "remove", workspace: "acme" }]);
  });
});
