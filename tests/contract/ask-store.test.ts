// Live interaction A5: the Ask record's retention (30 days), what it keeps by edition and audience (Public Slack and Linear keep no words), who reads it, and erasure (the asker's Asks are
// hard-deleted, the person's label in other people's answers becomes "@former-member", bounded and resumable, org-scoped).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ASK_RETENTION_DAYS, INDEX_EXPIRY_ATTRIBUTE, askByPersonKey, askMentionKey, sessionAskKey, type OrgId, type SessionId } from "../../packages/contracts/src/index.js";
import {
  ASK_MENTION_TAGS_MAX, ASK_SWEEP_LOOKBACK_DAYS, ASK_TTL_SECONDS, FORMER_MEMBER_MENTION, askPersonTag, askQuestionHash, eraseAskPerson, moveAsksOnMerge, readAskAsAsker, sweepExpiredAsks, writeAsk, type AskWriteInput,
} from "../../packages/broker/src/agent-sessions/ask-store.js";
import { erasePerson } from "../../packages/broker/src/team-record/erase.js";
import { ORG_A as RECORD_ORG, world as recordWorld } from "../support/team-record-core.js";
import { deleteDeps } from "../support/team-record-delete.js";
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

// A key built at run time: the source holds no key, and this one is only for these tests.
const HASH_KEY = ["ask", "hash", "key", "for", "tests", "only"].join("-");

function world() {
  const db = new FakeDynamoDb();
  const erased = new Set<string>();
  const checks = { count: 0, eraseOnCheck: undefined as undefined | { at: number; who: string } };
  const deps = {
    documentClient: db, tableName: "state", questionHashKey: HASH_KEY,
    isErased: async (developerId: string) => {
      checks.count += 1;
      if (checks.eraseOnCheck !== undefined && checks.count === checks.eraseOnCheck.at) erased.add(checks.eraseOnCheck.who);
      return erased.has(developerId);
    },
  };
  const ask = (overrides: Partial<AskWriteInput> = {}) => writeAsk(deps, {
    edition: "enterprise", orgId: ORG_A, sessionId: SESSION_1, askId: askId("1"), audience: "web", askedBy: ERIN, question: QUESTION, answer: ANSWER, contextBytes: 1234, model: "m-1", nowMs: NOW, ...overrides,
  });
  const everything = () => db.find(() => true);
  const text = () => JSON.stringify(everything());
  return { db, deps, ask, everything, text, erased, checks };
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

  it("hashes a question with a server-held key and the Ask's id, so the stored hash cannot be matched against a table of questions without the key (m4)", () => {
    const plain = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(askQuestionHash(HASH_KEY, askId("1"), QUESTION)).not.toBe(plain(QUESTION));
    expect(askQuestionHash(HASH_KEY, askId("1"), QUESTION)).not.toBe(plain(`ask-question\0${askId("1")}\0${QUESTION}`));
    expect(askQuestionHash(HASH_KEY, askId("1"), QUESTION)).toBe(askQuestionHash(HASH_KEY, askId("1"), QUESTION));
    expect(askQuestionHash(`${HASH_KEY}-other`, askId("1"), QUESTION)).not.toBe(askQuestionHash(HASH_KEY, askId("1"), QUESTION));
    expect(askQuestionHash(HASH_KEY, askId("2"), QUESTION)).not.toBe(askQuestionHash(HASH_KEY, askId("1"), QUESTION));
    expect(() => askQuestionHash("short", askId("1"), QUESTION)).toThrow(/too short/u);
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

describe("the person tag", () => {
  it("is the tag inside the label the Ask context shows (the erasure module computes it without importing the context)", () => {
    for (const id of [ERIN, SAM, "d".repeat(64), "0".repeat(64)]) expect(`person ${askPersonTag(id)}`).toBe(personLabel(id));
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

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Fix round 1
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("what the stored words never hold (I6, m8)", () => {
  const PEOPLE = [
    { developerId: SAM, names: ["Sam Okafor", "sokafor", "sam.okafor@example.test", "U0SAMOKAF1"] },
    { developerId: ERIN, names: ["Erin Vale", "evale-dev"] },
  ];

  it("replaces a member's real name, handle, email and Slack id by their label, in the question and the answer, case-insensitively and as whole words only", async () => {
    const w = world();
    await w.ask({ people: PEOPLE, question: "why did Sam Okafor (sokafor) and EVALE-DEV change it? ask sam.okafor@example.test", answer: "sam okafor wrote it; Erin Vale reviewed; U0SAMOKAF1; the sokaforish file is unrelated" });
    const record = w.db.get(sessionAskKey(ORG_A, SESSION_1, askId("1")))!;
    const samLabel = personLabel(SAM), erinLabel = personLabel(ERIN);
    expect(record.question).toBe(`why did ${samLabel} (${samLabel}) and ${erinLabel} change it? ask ${samLabel}`);
    expect(record.answer).toBe(`${samLabel} wrote it; ${erinLabel} reviewed; ${samLabel}; the sokaforish file is unrelated`);
    for (const leaked of ["Sam Okafor", "sam.okafor", "example.test", "Erin Vale", "evale-dev", "U0SAMOKAF1"]) expect(w.text().toLowerCase(), leaked).not.toContain(leaked.toLowerCase());
  });

  it("replaces an email address of someone the writer does not know by a neutral word, and redacts a secret the person pasted (the question is kept for 30 days)", async () => {
    const w = world();
    const secret = `ghp_${"Zy9Xw8Vu7T".repeat(4)}`;
    await w.ask({ question: `my token is ${secret} and mail is stranger@corp.example`, answer: "ok" });
    const record = w.db.get(sessionAskKey(ORG_A, SESSION_1, askId("1")))!;
    expect(record.question).not.toContain(secret);
    expect(record.question).not.toContain("Zy9Xw8Vu7T");
    expect(record.question).not.toContain("corp.example");
    expect(record.question).toContain("my token is");
    expect(record.question).toContain("@member");
  });

  it("indexes every person label with no cap: 11 and 60 people are all found by erasure, and more than the bound is refused instead of left out", async () => {
    const w = world();
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ developerId: `d${String(index).padStart(63, "0")}`, names: [`Person Number ${String(index)}X`] }));
    for (const count of [11, 60]) {
      const people = many(count);
      const id = askId(count === 11 ? "6" : "7");
      await w.ask({ askId: id, askedBy: SAM, people, answer: people.map((person) => person.names[0]).join(", ") });
      const record = w.db.get(sessionAskKey(ORG_A, SESSION_1, id))!;
      expect((record.mentionTags as string[]).length).toBeGreaterThanOrEqual(count - 1);
      // The last person is found, which the old first-10 cap would not have indexed.
      const last = people.at(-1)!.developerId;
      expect(w.db.get(askMentionKey(ORG_A, askPersonTag(last), SESSION_1, id)), `${String(count)} labels`).toBeDefined();
      expect(await eraseAskPerson(w.deps, ORG_A, last)).toMatchObject({ scrubbed: 1, complete: true });
      expect(w.db.get(sessionAskKey(ORG_A, SESSION_1, id))!.answer).toContain(FORMER_MEMBER_MENTION);
      expect(w.text()).not.toContain(askPersonTag(last));
    }
    await expect(w.ask({ askId: askId("8"), askedBy: SAM, people: many(ASK_MENTION_TAGS_MAX + 5), answer: many(ASK_MENTION_TAGS_MAX + 5).map((person) => person.names[0]).join(", ") })).rejects.toThrow(/too many people/u);
    expect(w.db.get(sessionAskKey(ORG_A, SESSION_1, askId("8")))).toBeUndefined();
  });

  it("erasure also scrubs the names it is given that survived in a record found by the person's label", async () => {
    const w = world();
    await w.ask({ askedBy: SAM, answer: `${personLabel(ERIN)} agreed, said Erin Vale (evale-dev) and EVALE-DEV again` });
    await eraseAskPerson(w.deps, ORG_A, ERIN, undefined, ["Erin Vale", "evale-dev"]);
    expect(w.db.get(sessionAskKey(ORG_A, SESSION_1, askId("1")))!.answer).toBe(`${FORMER_MEMBER_MENTION} agreed, said ${FORMER_MEMBER_MENTION} (${FORMER_MEMBER_MENTION}) and ${FORMER_MEMBER_MENTION} again`);
  });
});

describe("an erased person is not brought back (I7)", () => {
  const PEOPLE = [{ developerId: ERIN, names: ["Erin Vale"] }, { developerId: SAM, names: ["Sam Okafor"] }];

  it("refuses an Ask asked by an erased person and stores nothing", async () => {
    const w = world();
    w.erased.add(ERIN);
    expect(await w.ask()).toBe("erased");
    expect(w.everything()).toEqual([]);
  });

  it("names an erased member as @former-member and never gives them a label or an index item", async () => {
    const w = world();
    w.erased.add(ERIN);
    await w.ask({ askedBy: SAM, people: PEOPLE, question: "did Erin Vale approve it?", answer: `Yes, Erin Vale did; ${personLabel(ERIN)} too. Sam Okafor agreed.` });
    const record = w.db.get(sessionAskKey(ORG_A, SESSION_1, askId("1")))!;
    expect(record.question).toBe(`did ${FORMER_MEMBER_MENTION} approve it?`);
    expect(record.answer).toBe(`Yes, ${FORMER_MEMBER_MENTION} did; ${FORMER_MEMBER_MENTION} too. ${personLabel(SAM)} agreed.`);
    expect(w.text()).not.toContain(askPersonTag(ERIN));
    expect(w.text()).not.toContain(ERIN);
    expect(w.db.get(askMentionKey(ORG_A, askPersonTag(SAM), SESSION_1, askId("1")))).toBeDefined();
  });

  it("an erasure that runs while the answer is being made: the Ask is removed again when the marker appears after the write, and the answer says erased", async () => {
    const w = world();
    // checks: 1 = asker before, 2 = Erin before (people), 3 = Sam before; the marker appears at check 4, the asker's check after the write.
    w.checks.eraseOnCheck = { at: 4, who: ERIN };
    expect(await w.ask({ people: PEOPLE })).toBe("erased");
    expect(w.everything().filter((item) => ["ASK", "ASK_BY_PERSON", "ASK_MENTION", "ASK_EXPIRY"].includes(String(item.entityType)))).toEqual([]);
    expect(w.text()).not.toContain(ERIN);
  });

  it("a mentioned person erased while the answer is being made is scrubbed out of the stored text by the late check", async () => {
    const w = world();
    // checks: 1 asker (Sam), 2 Erin, 3 Sam; the marker for Erin appears at check 4 (the asker after the write: false), then 5 is Erin's late check.
    w.checks.eraseOnCheck = { at: 4, who: ERIN };
    expect(await w.ask({ askedBy: SAM, people: PEOPLE, answer: "Erin Vale approved" })).toBe("written");
    expect(w.db.get(sessionAskKey(ORG_A, SESSION_1, askId("1")))!.answer).toBe(`${FORMER_MEMBER_MENTION} approved`);
    expect(w.text()).not.toContain(askPersonTag(ERIN));
  });

  it("refuses to write when the erased marker cannot be read", async () => {
    const w = world();
    const failing = { ...w.deps, isErased: async () => { throw new Error("marker store down"); } };
    await expect(writeAsk(failing, { edition: "enterprise", orgId: ORG_A, sessionId: SESSION_1, askId: askId("1"), audience: "web", askedBy: ERIN, question: "q", answer: "a", contextBytes: 1, model: "m", nowMs: NOW })).rejects.toThrow(/marker store down/u);
    expect(w.everything()).toEqual([]);
  });

  it("the team record's person erasure includes the Asks step: the Asks are gone and the step is reported done", async () => {
    const rw = recordWorld();
    const d = deleteDeps(rw);
    const deps = { documentClient: rw.db, tableName: "TeamRecord", questionHashKey: HASH_KEY, isErased: async () => false };
    await writeAsk(deps, { edition: "enterprise", orgId: RECORD_ORG, sessionId: SESSION_1, askId: askId("1"), audience: "web", askedBy: ERIN, question: QUESTION, answer: ANSWER, contextBytes: 1, model: "m", nowMs: NOW });
    await writeAsk(deps, { edition: "enterprise", orgId: RECORD_ORG, sessionId: SESSION_1, askId: askId("2"), audience: "web", askedBy: SAM, question: "q2", answer: `${personLabel(ERIN)} did it`, contextBytes: 1, model: "m", nowMs: NOW });
    const result = await erasePerson(d.deps, RECORD_ORG, { developerId: ERIN, projects: ["web"] }, "ask-erase-1");
    expect(result.steps?.asks).toBe(true);
    expect(rw.db.get(sessionAskKey(RECORD_ORG, SESSION_1, askId("1")))).toBeUndefined();
    expect(rw.db.get(sessionAskKey(RECORD_ORG, SESSION_1, askId("2")))).toMatchObject({ answer: `${FORMER_MEMBER_MENTION} did it`, askedBy: SAM });
    expect(JSON.stringify(rw.db.find((item) => String(item.pk).includes("ASK")))).not.toContain(ERIN);
  });
});

describe("a member merge moves the Asks (I7)", () => {
  it("the duplicate's Asks and index become the survivor's, and the duplicate's label in other people's answers becomes the survivor's, so erasing the survivor finds everything", async () => {
    const w = world();
    const DUP = "d".repeat(64);
    await w.ask({ askId: askId("1"), askedBy: DUP, answer: "ANSWER-DUP" });
    await w.ask({ askId: askId("2"), askedBy: SAM, answer: `${personLabel(DUP)} approved` });
    expect(await moveAsksOnMerge(w.deps, ORG_A, DUP, ERIN)).toEqual({ moved: 1, complete: true });
    expect(w.db.get(sessionAskKey(ORG_A, SESSION_1, askId("1")))).toMatchObject({ askedBy: ERIN });
    expect(w.db.get(askByPersonKey(ORG_A, ERIN, SESSION_1, askId("1")))).toBeDefined();
    expect(w.db.find((item) => String(item.pk).includes(`ASKBY#${DUP}`))).toEqual([]);
    expect(w.db.get(sessionAskKey(ORG_A, SESSION_1, askId("2")))).toMatchObject({ answer: `${personLabel(ERIN)} approved` });
    expect(w.db.get(askMentionKey(ORG_A, askPersonTag(ERIN), SESSION_1, askId("2")))).toBeDefined();
    expect(w.text()).not.toContain(askPersonTag(DUP));
    // Erasing the survivor now takes both.
    expect(await eraseAskPerson(w.deps, ORG_A, ERIN)).toMatchObject({ deleted: 1, scrubbed: 1, complete: true });
    expect(w.text()).not.toContain(askPersonTag(ERIN));
    expect(w.text()).not.toContain("ANSWER-DUP");
  });
});

describe("the 30 days hold in every environment (m3)", () => {
  const DAY = 86_400_000;

  it("sweeps an Ask and all its index items after 30 days even though this table has no TTL, and not a day before", async () => {
    const w = world();
    await w.ask({ askedBy: ERIN, people: [{ developerId: SAM, names: ["Sam Okafor"] }], answer: "Sam Okafor helped" });
    expect(w.everything().filter((item) => item.entityType === "ASK_EXPIRY")).toHaveLength(1);
    expect(await sweepExpiredAsks(w.deps, ORG_A, NOW + 29 * DAY)).toEqual({ deleted: 0, complete: true });
    expect(w.db.get(sessionAskKey(ORG_A, SESSION_1, askId("1")))).toBeDefined();
    // The same calendar day, an hour BEFORE the Ask is 30 days old: its expiry bucket is read, and the Ask is kept.
    expect(await sweepExpiredAsks(w.deps, ORG_A, NOW + 30 * DAY - 3_600_000)).toEqual({ deleted: 0, complete: true });
    expect(w.db.get(sessionAskKey(ORG_A, SESSION_1, askId("1")))).toBeDefined();
    expect(w.everything().filter((item) => item.entityType === "ASK_EXPIRY")).toHaveLength(1);
    expect(await sweepExpiredAsks(w.deps, ORG_A, NOW + 30 * DAY + 60_000)).toEqual({ deleted: 1, complete: true });
    expect(w.everything()).toEqual([]);
  });

  it("finds an Ask whose day was missed by a few days, keeps a younger Ask, and is idempotent", async () => {
    const w = world();
    await w.ask({ askId: askId("1") });
    await w.ask({ askId: askId("2"), nowMs: NOW + 10 * DAY });
    const later = NOW + (30 + ASK_SWEEP_LOOKBACK_DAYS - 1) * DAY;
    expect((await sweepExpiredAsks(w.deps, ORG_A, later)).deleted).toBe(1);
    expect(w.db.get(sessionAskKey(ORG_A, SESSION_1, askId("1")))).toBeUndefined();
    expect(w.db.get(sessionAskKey(ORG_A, SESSION_1, askId("2")))).toBeDefined();
    expect((await sweepExpiredAsks(w.deps, ORG_A, later)).deleted).toBe(0);
  });

  it("is bounded: a small budget finishes over several runs", async () => {
    const w = world();
    for (const digit of "12345") await w.ask({ askId: askId(digit) });
    const at = NOW + 31 * DAY;
    const first = await sweepExpiredAsks(w.deps, ORG_A, at, { maxItems: 2 });
    expect(first).toEqual({ deleted: 2, complete: false });
    let deleted = first.deleted;
    for (let run = 0; run < 5; run += 1) { const next = await sweepExpiredAsks(w.deps, ORG_A, at, { maxItems: 2 }); deleted += next.deleted; if (next.complete) break; }
    expect(deleted).toBe(5);
  });

  it("stays inside the org", async () => {
    const w = world();
    await w.ask({ orgId: ORG_B, askId: askId("2") });
    await sweepExpiredAsks(w.deps, ORG_A, NOW + 40 * DAY);
    expect(w.db.get(sessionAskKey(ORG_B, SESSION_1, askId("2")))).toBeDefined();
  });
});
