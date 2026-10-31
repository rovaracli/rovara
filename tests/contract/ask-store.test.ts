// Live interaction A5: the Ask record's retention (30 days), what it keeps by edition and audience (Public Slack and Linear keep no words), who reads it, and erasure (the asker's Asks are
// hard-deleted, the person's label in other people's answers becomes "@former-member", bounded and resumable, org-scoped).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ASK_RETENTION_DAYS, INDEX_EXPIRY_ATTRIBUTE, askByPersonKey, askMentionKey, sessionAskKey, type OrgId, type SessionId } from "../../packages/contracts/src/index.js";
import { ASK_TTL_SECONDS, FORMER_MEMBER_MENTION, askQuestionHash, eraseAskPerson, readAskAsAsker, writeAsk, type AskWriteInput } from "../../packages/broker/src/agent-sessions/ask-store.js";
import { personLabel } from "../../packages/broker/src/aws/developer-tasks/thread-notes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const SESSION_1 = "ses_aaaaaaaaaaaaaaaaaaaa" as SessionId;
const SESSION_2 = "ses_bbbbbbbbbbbbbbbbbbbb" as SessionId;
const ERIN = "e".repeat(64);
const SAM = "5".repeat(64);
const NOW = Date.parse("2026-10-31T10:00:00.000Z");
const QUESTION = "QUESTION-MARKER why did it change the retry logic?";
const ANSWER = "ANSWER-MARKER because the helper retries twice.";
const askId = (digit: string) => `ask_${digit.repeat(20)}`;
const tagOf = (developerId: string) => personLabel(developerId).slice("person ".length);

function world() {
  const db = new FakeDynamoDb();
  const deps = { documentClient: db, tableName: "state" };
  const ask = (overrides: Partial<AskWriteInput> = {}) => writeAsk(deps, {
    edition: "enterprise", orgId: ORG_A, sessionId: SESSION_1, askId: askId("1"), audience: "web", askedBy: ERIN, question: QUESTION, answer: ANSWER, contextBytes: 1234, model: "m-1", nowMs: NOW, ...overrides,
  });
  const everything = () => db.find(() => true);
  const text = () => JSON.stringify(everything());
  return { db, deps, ask, everything, text };
}

describe("what is stored, and for how long", () => {
  it("keeps the question and answer for 30 days, on the record and on every index item, with the asker's index", async () => {
    const w = world();
    expect(await w.ask()).toBe("written");
    const record = w.db.get(sessionAskKey(ORG_A, SESSION_1, askId("1")))!;
    expect(record).toMatchObject({ entityType: "ASK", question: QUESTION, answer: ANSWER, audience: "web", askedBy: ERIN, contextBytes: 1234, model: "m-1" });
    expect(ASK_RETENTION_DAYS).toBe(30);
    const expectedTtl = Math.floor(NOW / 1000) + 30 * 86_400;
    expect(ASK_TTL_SECONDS).toBe(30 * 86_400);
    expect(record.ttl).toBe(expectedTtl);
    expect(record[INDEX_EXPIRY_ATTRIBUTE]).toBe(expectedTtl);
    const index = w.db.get(askByPersonKey(ORG_A, ERIN, SESSION_1, askId("1")))!;
    expect(index).toMatchObject({ entityType: "ASK_BY_PERSON", [INDEX_EXPIRY_ATTRIBUTE]: expectedTtl });
    expect(JSON.stringify(index)).not.toContain("MARKER");
  });

  it.each([
    ["enterprise", "web", true], ["enterprise", "slack", true], ["enterprise", "linear", true], ["public", "web", true], ["public", "slack", false], ["public", "linear", false],
  ] as const)("%s %s: the words are %s", async (edition, audience, kept) => {
    const w = world();
    await w.ask({ edition, audience: audience });
    const record = w.db.get(sessionAskKey(ORG_A, SESSION_1, askId("1")))!;
    // Positive control: the record is there, with its sizes and hash, in every case.
    expect(record).toMatchObject({ audience, answerBytes: Buffer.byteLength(ANSWER, "utf8"), contextBytes: 1234 });
    expect(record.questionSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(w.text().includes("QUESTION-MARKER")).toBe(kept);
    expect(w.text().includes("ANSWER-MARKER")).toBe(kept);
  });

  it("hashes a question with the Ask's own salt, so the hash cannot be looked up in a table of questions", () => {
    expect(askQuestionHash(askId("1"), QUESTION)).not.toBe(createHash("sha256").update(QUESTION).digest("hex"));
    expect(askQuestionHash(askId("1"), QUESTION)).toBe(askQuestionHash(askId("1"), QUESTION));
    expect(askQuestionHash(askId("2"), QUESTION)).not.toBe(askQuestionHash(askId("1"), QUESTION));
  });

  it("never keeps a Slack id: mentions become the neutral word before anything is stored", async () => {
    const w = world();
    await w.ask({ question: "why did <@U0ERASED01> change it? cc <@W0OTHER002|sam>", answer: "<@U0ERASED01> asked for it" });
    expect(w.text()).not.toContain("U0ERASED01");
    expect(w.text()).not.toContain("W0OTHER002");
    expect(w.db.get(sessionAskKey(ORG_A, SESSION_1, askId("1")))).toMatchObject({ question: "why did @member change it? cc @member", answer: "@member asked for it" });
  });

  it("answers `exists` to a redelivered Ask and keeps the first answer", async () => {
    const w = world();
    expect(await w.ask()).toBe("written");
    expect(await w.ask({ answer: "A DIFFERENT ANSWER" })).toBe("exists");
    expect(w.db.get(sessionAskKey(ORG_A, SESSION_1, askId("1")))).toMatchObject({ answer: ANSWER });
    expect(w.text()).not.toContain("DIFFERENT");
  });

  it("makes no asker index for an asker who is not a member", async () => {
    const w = world();
    await w.ask({ askedBy: undefined, audience: "slack" });
    expect(w.everything().filter((item) => item.entityType === "ASK_BY_PERSON")).toEqual([]);
    expect(w.db.get(sessionAskKey(ORG_A, SESSION_1, askId("1")))).not.toHaveProperty("askedBy");
  });
});

describe("who reads a web answer", () => {
  it("the asker only: not the session's owner, a teammate, another org, an expired record, or an Ask from another audience", async () => {
    const w = world();
    await w.ask();
    await w.ask({ askId: askId("2"), audience: "slack" });
    const read = (id: string, who: string, org: OrgId = ORG_A, at = NOW + 1_000) => readAskAsAsker(w.deps, org, SESSION_1, id, who, at);
    expect(await read(askId("1"), ERIN)).toMatchObject({ askId: askId("1"), question: QUESTION, answer: ANSWER, askedBy: ERIN });
    expect(await read(askId("1"), SAM)).toBeUndefined();
    expect(await read(askId("1"), ERIN, ORG_B)).toBeUndefined();
    expect(await read(askId("1"), ERIN, ORG_A, NOW + 31 * 86_400_000)).toBeUndefined();
    expect(await read(askId("2"), ERIN)).toBeUndefined();
    expect(await read(askId("9"), ERIN)).toBeUndefined();
  });
});

describe("erasing a person", () => {
  it("hard-deletes the Asks they asked, every index item of them, and nothing of anyone else's", async () => {
    const w = world();
    await w.ask({ sessionId: SESSION_1, askId: askId("1"), answer: `ANSWER-ERIN-1 ${personLabel(SAM)} helped` });
    await w.ask({ sessionId: SESSION_2, askId: askId("2"), answer: "ANSWER-ERIN-2" });
    await w.ask({ sessionId: SESSION_1, askId: askId("3"), askedBy: SAM, answer: "ANSWER-SAM-1" });
    expect(w.everything().filter((item) => item.entityType === "ASK")).toHaveLength(3);
    const result = await eraseAskPerson(w.deps, ORG_A, ERIN);
    expect(result).toEqual({ deleted: 2, scrubbed: 0, complete: true });
    // Per-case attribution: each of Erin's is gone, Sam's is intact with its own index.
    expect(w.db.get(sessionAskKey(ORG_A, SESSION_1, askId("1")))).toBeUndefined();
    expect(w.db.get(sessionAskKey(ORG_A, SESSION_2, askId("2")))).toBeUndefined();
    expect(w.db.get(sessionAskKey(ORG_A, SESSION_1, askId("3")))).toMatchObject({ answer: "ANSWER-SAM-1", askedBy: SAM });
    expect(w.db.get(askByPersonKey(ORG_A, SAM, SESSION_1, askId("3")))).toBeDefined();
    // Erin is named nowhere; the mention index of Sam that Erin's Ask made went with it.
    expect(w.text()).not.toContain(ERIN);
    expect(w.text()).not.toContain("ANSWER-ERIN");
    expect(w.db.get(askMentionKey(ORG_A, tagOf(SAM), SESSION_1, askId("1")))).toBeUndefined();
    // A repeat finds nothing and is complete.
    expect(await eraseAskPerson(w.deps, ORG_A, ERIN)).toEqual({ deleted: 0, scrubbed: 0, complete: true });
  });

  it("turns the person's label in other people's stored answers into @former-member, and keeps those Asks", async () => {
    const w = world();
    await w.ask({ sessionId: SESSION_1, askId: askId("1"), askedBy: SAM, question: `did ${personLabel(ERIN)} approve it?`, answer: `Yes, ${personLabel(ERIN)} approved the plan; ${tagOf(ERIN)} also commented.` });
    expect(w.db.get(askMentionKey(ORG_A, tagOf(ERIN), SESSION_1, askId("1")))).toBeDefined();
    const result = await eraseAskPerson(w.deps, ORG_A, ERIN);
    expect(result).toEqual({ deleted: 0, scrubbed: 1, complete: true });
    const kept = w.db.get(sessionAskKey(ORG_A, SESSION_1, askId("1")))!;
    expect(kept).toMatchObject({ askedBy: SAM, question: `did ${FORMER_MEMBER_MENTION} approve it?`, answer: `Yes, ${FORMER_MEMBER_MENTION} approved the plan; ${FORMER_MEMBER_MENTION} also commented.` });
    expect(w.text()).not.toContain(tagOf(ERIN));
    expect(w.db.get(askMentionKey(ORG_A, tagOf(ERIN), SESSION_1, askId("1")))).toBeUndefined();
    // The Ask's own index of its mention was updated: erasing Sam later leaves nothing behind.
    await eraseAskPerson(w.deps, ORG_A, SAM);
    expect(w.everything().filter((item) => ["ASK", "ASK_BY_PERSON", "ASK_MENTION"].includes(String(item.entityType)))).toEqual([]);
  });

  it("is bounded and resumable: a small budget deletes a few at a time and finishes over several calls", async () => {
    const w = world();
    for (const digit of "12345") await w.ask({ askId: askId(digit) });
    const first = await eraseAskPerson(w.deps, ORG_A, ERIN, { maxItems: 2 });
    expect(first).toEqual({ deleted: 2, scrubbed: 0, complete: false });
    expect(w.everything().filter((item) => item.entityType === "ASK")).toHaveLength(3);
    let calls = 1, deleted = first.deleted;
    for (let result = first; !result.complete && calls < 10; calls += 1) { result = await eraseAskPerson(w.deps, ORG_A, ERIN, { maxItems: 2 }); deleted += result.deleted; if (result.complete) break; }
    expect(deleted).toBe(5);
    expect(w.everything().filter((item) => item.entityType === "ASK" || item.entityType === "ASK_BY_PERSON")).toEqual([]);
  });

  it("stays inside the org: the same developer id in another org keeps their Asks", async () => {
    const w = world();
    await w.ask({ orgId: ORG_A, askId: askId("1") });
    await w.ask({ orgId: ORG_B, askId: askId("2") });
    await eraseAskPerson(w.deps, ORG_A, ERIN);
    expect(w.db.get(sessionAskKey(ORG_A, SESSION_1, askId("1")))).toBeUndefined();
    expect(w.db.get(sessionAskKey(ORG_B, SESSION_1, askId("2")))).toMatchObject({ question: QUESTION });
    expect(w.db.get(askByPersonKey(ORG_B, ERIN, SESSION_1, askId("2")))).toBeDefined();
  });

  it("erases a Public Slack Ask's record too (it holds the asker's id and a hash)", async () => {
    const w = world();
    await w.ask({ edition: "public", audience: "slack" });
    expect(await eraseAskPerson(w.deps, ORG_A, ERIN)).toMatchObject({ deleted: 1, complete: true });
    expect(w.text()).not.toContain(ERIN);
  });
});

describe("the keys", () => {
  it("are scoped by org and hold the person only in the index partition", () => {
    expect(sessionAskKey(ORG_A, SESSION_1, askId("1"))).toEqual({ pk: `ORG#${ORG_A}#AGENT_SESSION#${SESSION_1}`, sk: `ASK#${askId("1")}` });
    expect(askByPersonKey(ORG_A, ERIN, SESSION_1, askId("1")).pk).toBe(`ORG#${ORG_A}#ASKBY#${ERIN}`);
    expect(askByPersonKey(ORG_A, ERIN, SESSION_1, askId("1")).pk).not.toBe(askByPersonKey(ORG_B, ERIN, SESSION_1, askId("1")).pk);
    expect(askMentionKey(ORG_A, "p_a1b2c3", SESSION_1, askId("1")).pk).toBe(`ORG#${ORG_A}#ASKMENTION#p_a1b2c3`);
    expect(() => askByPersonKey(ORG_A, "a#b", SESSION_1, askId("1"))).toThrow();
  });
});
