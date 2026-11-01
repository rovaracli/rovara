// Live interaction A3: the broker's service routes for the chat service (`/v1/service/asks/*`), the daily upkeep, the erased people's kept aliases (register LI-2), and the Slack question's rates and
// record. The routes answer the orchestrator role only, name the Ask (never a Slack thread), trust nothing in the request about who asks or what they pay, and are NOT_FOUND while the switch is off.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { ASK_RATE, askCountKey, askErasedAliasPk, orgBanKey, orgMemberKey, sessionRateKey, sessionAskKey } from "../../packages/contracts/src/index.js";

const mint = vi.hoisted(() => vi.fn((...args: unknown[]) => { void args; return Promise.resolve({ baseUrl: "https://proxy.example.invalid", apiKey: "fake-key-not-a-secret", expiresAt: 1 }); }));
vi.mock("../../packages/broker/src/aws/broker/model-access.js", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), mintChatTurnKey: mint }));

import { askDependenciesFor, handleAskServiceRoute, runAskMaintenance } from "../../packages/broker/src/aws/broker/ask-service.js";
import { recordSlackAsk, takeSlackAskRates, type AskDependencies } from "../../packages/broker/src/agent-sessions/ask.js";
import { ERASED_ALIAS_RETENTION_DAYS, aliasHashesOf, askAliasHashKey, readErasedAliases, rememberErasedAliases, scrubWithAliasHashes, sweepErasedAliases } from "../../packages/broker/src/agent-sessions/ask-erased-aliases.js";
import { ASK_SWEEP_LOOKBACK_DAYS } from "../../packages/broker/src/agent-sessions/ask-store.js";
import type { AwsBrokerDependencies } from "../../packages/broker/src/aws/broker/definitions.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { ARJUN, ORG_A, PRIYA, sessionWorld } from "../support/agent-session-world.js";
import { capturingAuditDeps } from "../support/audit-capture.js";

const ORCHESTRATOR = "arn:aws:iam::123456789012:role/orchestrator";
const PRINCIPAL = "arn:aws:sts::123456789012:assumed-role/orchestrator/session-1";
const KEY = "k".repeat(48);

function world(options: { enabled?: boolean; level?: "use" | "view" | "none" | "throws"; edition?: "enterprise" | "public" } = {}) {
  const w = sessionWorld();
  const made = w.seedSession({ kind: "task", owner: PRIYA });
  w.seedShare(ORG_A, made.sessionId, { kind: "member", developerId: ARJUN }, "use");
  const task = w.db.get({ pk: `DEVTASK#${made.taskId}`, sk: "META" })! as unknown as DeveloperTaskRecord;
  w.db.set({ ...task, workflow: { revision: 1, stage: "IMPLEMENT", state: "RUNNING", artifacts: [], decisions: [], pullRequests: [], checkPolicy: { required: [], optional: [], selectedOptionalIds: [] } } });
  const audit = capturingAuditDeps({ db: w.db, now: () => w.clock.now });
  const access = { documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members };
  const ask: AskDependencies = {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, edition: options.edition ?? "enterprise", enabled: true, queue: { send: async () => undefined }, access,
    actions: {} as never, readers: {},
    store: () => ({ documentClient: w.db, tableName: "state", questionHashKey: KEY, isErased: async () => false, erasedPeople: async () => [] }),
    audit: { ...audit.deps, documentClient: w.db, tableName: "state" }, people: async () => [], orchestratorInstructions: async () => "x", defaultModel: "chat-runtime",
  };
  const dependencies = { slack: { orchestratorRoleArn: ORCHESTRATOR }, documentClient: w.db, tableName: "state", audit: audit.audit } as unknown as AwsBrokerDependencies;
  const request = (path: string, body: unknown, principal: string | null = PRINCIPAL, method = "POST") => ({ method, path: `/v1/service${path}`, headers: {}, body: JSON.stringify(body), requestId: randomUUID(), ...(principal === null ? {} : { iamPrincipalArn: principal }) });
  return { w, made, ask, audit, dependencies, request, enabled: options.enabled ?? true };
}

async function queuedAsk(t: ReturnType<typeof world>, who = PRIYA) {
  const { submitAsk } = await import("../../packages/broker/src/agent-sessions/ask.js");
  const status = await submitAsk(t.ask, t.w.caller(who), t.made.sessionId, { requestId: randomUUID(), question: "Why?" });
  return { orgId: ORG_A, sessionId: t.made.sessionId, askId: status.askId };
}

describe("model access for an Ask", () => {
  it("mints the turn's key for the Ask's project in the asker's name, taking only the turn id and the models from the request", async () => {
    mint.mockClear();
    const t = world();
    const ref = await queuedAsk(t);
    const reply = await handleAskServiceRoute(t.dependencies, t.ask, t.request("/asks/model-access", { ...ref, turnId: "Ev1234567890", model: { provider: "amazon-bedrock", modelId: "m" } }), "/v1/asks/model-access");
    expect(reply?.statusCode).toBe(200);
    expect(mint).toHaveBeenCalledTimes(1);
    const args = mint.mock.calls[0]!;
    expect(args[1]).toBe(ORG_A);
    expect(args[2]).toBe("web");
    expect(args[3]).toMatchObject({ kind: "developer", developerId: PRIYA });
    expect(args[4]).toMatchObject({ turnId: "Ev1234567890" });
  });

  it("hands the mint the asker's standing to assert again in the key's write: it holds while nothing changes, and fails once the asker is removed, banned or changed (SY-7)", async () => {
    const t = world();
    const ref = await queuedAsk(t);
    const run = async () => {
      mint.mockClear();
      const reply = await handleAskServiceRoute(t.dependencies, t.ask, t.request("/asks/model-access", { ...ref, turnId: "Ev1234567890" }), "/v1/asks/model-access");
      expect(reply?.statusCode).toBe(200);
      const guard = mint.mock.calls[0]![5] as { checks: Array<Record<string, unknown>>; refusal: () => { code: string } } | undefined;
      expect(guard, "the mint is given a guard").toBeDefined();
      return guard!;
    };
    const holds = async (guard: { checks: Array<Record<string, unknown>> }) => t.w.db.send(new TransactWriteCommand({ TransactItems: guard.checks })).then(() => true, () => false);
    const memberKey = orgMemberKey(ORG_A, PRIYA);
    const original = t.w.db.get(memberKey)!;
    expect(await holds(await run())).toBe(true);
    expect((await run()).refusal()).toMatchObject({ code: "REMOVED_FROM_ORG" });
    // Removed: the record is deleted and a tombstone written.
    const removed = await run();
    t.w.db.delete(memberKey);
    expect(await holds(removed)).toBe(false);
    t.w.db.set(original);
    // Banned.
    const banned = await run();
    t.w.db.set({ ...orgBanKey(ORG_A, PRIYA), orgId: ORG_A, developerId: PRIYA });
    expect(await holds(banned)).toBe(false);
    t.w.db.delete(orgBanKey(ORG_A, PRIYA));
    // Changed to the Auditor in place, and removed then invited again.
    for (const change of [{ role: "auditor" }, { joinedAt: "2031-01-01T00:00:00.000Z" }]) {
      const before = await run();
      t.w.db.set({ ...original, ...change });
      expect(await holds(before), JSON.stringify(change)).toBe(false);
      t.w.db.set(original);
    }
  });

  it("is refused for anyone but the orchestrator role, and mints nothing", async () => {
    mint.mockClear();
    const t = world();
    const ref = await queuedAsk(t);
    for (const principal of [null, "arn:aws:sts::123456789012:assumed-role/someone-else/s", "arn:aws:sts::999999999999:assumed-role/orchestrator/s"]) {
      for (const [path, body] of [["/asks/turn", ref], ["/asks/answered", { ...ref, outcome: "FAILED" }], ["/asks/model-access", { ...ref, turnId: "Ev1" }]] as const) {
        await expect(handleAskServiceRoute(t.dependencies, t.ask, t.request(path, body, principal), `/v1${path}`)).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
    }
    expect(mint).not.toHaveBeenCalled();
  });

  it("is NOT_FOUND while the switch is off, and for an Ask the broker did not queue, one already ended, or another org's", async () => {
    mint.mockClear();
    const t = world();
    const ref = await queuedAsk(t);
    await expect(handleAskServiceRoute(t.dependencies, undefined, t.request("/asks/turn", ref), "/v1/asks/turn")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(handleAskServiceRoute(t.dependencies, undefined, t.request("/asks/model-access", { ...ref, turnId: "Ev1" }), "/v1/asks/model-access")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(handleAskServiceRoute(t.dependencies, t.ask, t.request("/asks/model-access", { ...ref, askId: "ask_zzzzzzzzzzzzzzzzzzzz", turnId: "Ev1" }), "/v1/asks/model-access")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(handleAskServiceRoute(t.dependencies, t.ask, t.request("/asks/model-access", { ...ref, orgId: "org_bbbbbbbbbbbbbbbbbbbb", turnId: "Ev1" }), "/v1/asks/model-access")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await handleAskServiceRoute(t.dependencies, t.ask, t.request("/asks/answered", { ...ref, outcome: "FAILED" }), "/v1/asks/answered");
    await expect(handleAskServiceRoute(t.dependencies, t.ask, t.request("/asks/model-access", { ...ref, turnId: "Ev1" }), "/v1/asks/model-access")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mint).not.toHaveBeenCalled();
  });

  it("mints nothing once the asker no longer 'can use' the session (read now), once the task is closed, and refuses a body with a field it does not know", async () => {
    mint.mockClear();
    const t = world();
    const ref = await queuedAsk(t, ARJUN);
    // Arjun's 'use' share ends after he asked.
    const share = t.w.db.find((item) => String(item.sk) === `SHARE#MEMBER#${ARJUN}`)[0]!;
    t.w.db.delete(String(share.pk), String(share.sk));
    await expect(handleAskServiceRoute(t.dependencies, t.ask, t.request("/asks/model-access", { ...ref, turnId: "Ev1" }), "/v1/asks/model-access")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const closing = world();
    const owned = await queuedAsk(closing, PRIYA);
    closing.w.db.set({ ...closing.w.db.get({ pk: `DEVTASK#${closing.made.taskId}`, sk: "META" })!, closedAt: "2026-10-30T00:00:00.000Z" });
    await expect(handleAskServiceRoute(closing.dependencies, closing.ask, closing.request("/asks/model-access", { ...owned, turnId: "Ev1" }), "/v1/asks/model-access")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const fresh = world();
    const live = await queuedAsk(fresh);
    await expect(handleAskServiceRoute(fresh.dependencies, fresh.ask, fresh.request("/asks/model-access", { ...live, turnId: "Ev1", budget: 1000 }), "/v1/asks/model-access")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(mint).not.toHaveBeenCalled();
  });

  it("answers undefined for any other path or method, so the caller goes on", async () => {
    const t = world();
    expect(await handleAskServiceRoute(t.dependencies, t.ask, t.request("/threads/workspace", {}), "/v1/threads/workspace")).toBeUndefined();
    expect(await handleAskServiceRoute(t.dependencies, t.ask, t.request("/asks/turn", {}, PRINCIPAL, "GET"), "/v1/asks/turn")).toBeUndefined();
    expect(await handleAskServiceRoute(t.dependencies, t.ask, t.request("/asks/other", {}), "/v1/asks/other")).toBeUndefined();
  });
});

describe("the Slack question: the same rates, record and audit", () => {
  const taskOf = (t: ReturnType<typeof world>) => t.w.db.get({ pk: `DEVTASK#${t.made.taskId}`, sk: "META" })! as unknown as DeveloperTaskRecord;

  it("spends the rates before the answer turn, and the 21st question of an hour is refused", async () => {
    const t = world();
    for (let index = 0; index < ASK_RATE.perPersonPerHour; index += 1) await takeSlackAskRates(t.ask, taskOf(t), PRIYA);
    await expect(takeSlackAskRates(t.ask, taskOf(t), PRIYA)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    // Another person is not held by it, and the task's own day count was spent by every question.
    await takeSlackAskRates(t.ask, taskOf(t), ARJUN);
    expect(t.w.db.get(sessionRateKey(ORG_A, t.made.sessionId as never, "task", "ask_day"))!["count"]).toBe(ASK_RATE.perPersonPerHour + 1);
  });

  it("two Slack questions at the same moment both get their place (a lost race is retried), and a counter that never settles is tried a bounded number of times", async () => {
    const t = world();
    const direct = t.ask.documentClient;
    let interleave: (() => Promise<void>) | undefined = () => takeSlackAskRates({ ...t.ask, documentClient: direct }, taskOf(t), PRIYA);
    t.ask.documentClient = { send: async (command: unknown) => {
      if (command instanceof TransactWriteCommand && interleave !== undefined) { const run = interleave; interleave = undefined; await run(); }
      return direct.send(command);
    } };
    await takeSlackAskRates(t.ask, taskOf(t), ARJUN);
    expect(t.w.db.get(sessionRateKey(ORG_A, t.made.sessionId as never, "task", "ask_day"))!["count"]).toBe(2);
    t.ask.documentClient = { send: async (command: unknown) => {
      if (command instanceof TransactWriteCommand) await takeSlackAskRates({ ...t.ask, documentClient: direct }, taskOf(t), PRIYA).catch(() => undefined);
      return direct.send(command);
    } };
    await expect(takeSlackAskRates(t.ask, taskOf(t), ARJUN)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("Enterprise keeps the words of a Slack Ask and audits it; Public keeps a hash and sizes, never the words, and counts it", async () => {
    const enterprise = world({ edition: "enterprise" });
    await recordSlackAsk(enterprise.ask, { task: taskOf(enterprise), messageTs: "1695500002.000001", askedBy: PRIYA, question: "Why the rule?", answer: "Because the plan says so.", contextBytes: 500 });
    const stored = enterprise.w.db.find((item) => String(item.sk).startsWith("ASK#"))[0]!;
    expect(stored).toMatchObject({ audience: "slack", question: "Why the rule?", answer: "Because the plan says so." });
    expect(enterprise.audit.recordedBy("task.asked")).toHaveLength(1);
    // A redelivered "answered" is the same Ask.
    await recordSlackAsk(enterprise.ask, { task: taskOf(enterprise), messageTs: "1695500002.000001", askedBy: PRIYA, question: "Why the rule?", answer: "A different answer.", contextBytes: 500 });
    expect(enterprise.w.db.find((item) => String(item.sk).startsWith("ASK#"))).toHaveLength(1);
    expect(enterprise.audit.recordedBy("task.asked")).toHaveLength(1);
    const pub = world({ edition: "public" });
    await recordSlackAsk(pub.ask, { task: taskOf(pub), messageTs: "1695500002.000001", askedBy: PRIYA, question: "Why the rule?", answer: "Because the plan says so.", contextBytes: 500 });
    const record = pub.w.db.find((item) => String(item.sk).startsWith("ASK#"))[0]!;
    expect(record).not.toHaveProperty("question");
    expect(record).not.toHaveProperty("answer");
    expect(record["questionSha256"]).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(pub.w.db.find(() => true))).not.toContain("Because the plan");
    expect(pub.audit.recordedBy("task.asked")).toEqual([]);
  });

  it("never throws: a store that fails leaves the posted answer alone", async () => {
    const t = world();
    const broken = { ...t.ask, store: () => { throw new Error("table down"); } } as AskDependencies;
    await expect(recordSlackAsk(broken, { task: taskOf(t), messageTs: "1695500002.000002", askedBy: PRIYA, question: "q", answer: "a", contextBytes: 1 })).resolves.toBeUndefined();
  });
});

describe("erased people's kept aliases (LI-2): hashes only, at most 30 days, then deleted", () => {
  const table = (w: ReturnType<typeof sessionWorld>) => ({ documentClient: w.db, tableName: "state" });
  const HASH_KEY = askAliasHashKey(KEY);
  const raw = ["Priya Raman", "Raman", "U0PRIYA001", "priya.raman@example.com", "priyaraman"];

  it("keeps keyed hashes of the names and handles under the person's label tag only, never a raw name, email or Slack id, for the same 30 days as an Ask", async () => {
    const w = sessionWorld();
    await rememberErasedAliases(table(w), ORG_A, { developerId: PRIYA, names: ["Priya Raman"], handles: ["U0PRIYA001", "priya.raman@example.com"] }, w.clock.now, HASH_KEY);
    const items = w.db.find((item) => item.pk === askErasedAliasPk(ORG_A));
    expect(items).toHaveLength(1);
    const text = JSON.stringify(items);
    expect(text).not.toContain(PRIYA);
    for (const secret of raw) expect(text.toLowerCase(), secret).not.toContain(secret.toLowerCase());
    expect(items[0]!["sk"]).toMatch(/^p_[0-9a-f]{6}$/u);
    expect(items[0]!["nameHashes"] as string[]).toHaveLength(2);
    expect(items[0]!["handleHashes"] as string[]).toHaveLength(2);
    for (const value of [...(items[0]!["nameHashes"] as string[]), ...(items[0]!["handleHashes"] as string[]), ...(items[0]!["mentionHashes"] as string[])]) expect(value).toMatch(/^[0-9a-f]{64}$/u);
    expect(ERASED_ALIAS_RETENTION_DAYS).toBe(30);
    expect(items[0]!["indexExpiresAt"]).toBe(Math.floor(w.clock.now / 1000) + 30 * 86_400);
    const [alias] = await readErasedAliases(table(w), ORG_A, w.clock.now);
    expect(alias!.tag).toBe(items[0]!["sk"]);
    // The hashes are keyed: another key makes other hashes.
    await rememberErasedAliases(table(w), ORG_A, { developerId: ARJUN, names: ["Priya Raman"] }, w.clock.now, askAliasHashKey("z".repeat(48)));
    const other = (await readErasedAliases(table(w), ORG_A, w.clock.now)).find((entry) => entry.tag !== alias!.tag)!;
    expect(other.names).not.toEqual(alias!.names);
  });

  it("without a key only the label tag is kept: nothing raw, nothing hashed", async () => {
    const w = sessionWorld();
    await rememberErasedAliases(table(w), ORG_A, { developerId: PRIYA, names: ["Priya Raman"], handles: ["U0PRIYA001"] }, w.clock.now);
    const [item] = w.db.find((entry) => entry.pk === askErasedAliasPk(ORG_A));
    expect(item).toMatchObject({ nameHashes: [], handleHashes: [], mentionHashes: [] });
    expect(JSON.stringify(item).toLowerCase()).not.toContain("priya");
  });

  it("is merged by the erase's second pass (which carries no names) and keeps the first erasure's expiry", async () => {
    const w = sessionWorld();
    await rememberErasedAliases(table(w), ORG_A, { developerId: PRIYA, names: ["Priya Raman"], handles: ["aa"] }, w.clock.now, HASH_KEY);
    await rememberErasedAliases(table(w), ORG_A, { developerId: PRIYA, handles: ["bb"] }, w.clock.now + 20 * 60_000, HASH_KEY);
    const [alias] = await readErasedAliases(table(w), ORG_A, w.clock.now);
    expect(alias!.names).toHaveLength(2);
    expect(alias!.handles).toHaveLength(2);
    const [item] = w.db.find((entry) => entry.pk === askErasedAliasPk(ORG_A));
    expect(item!["indexExpiresAt"]).toBe(Math.floor(w.clock.now / 1000) + 30 * 86_400);
  });

  it("ignores an alias past its time even before the table removes it, and the sweep deletes it", async () => {
    const w = sessionWorld();
    await rememberErasedAliases(table(w), ORG_A, { developerId: PRIYA, names: ["Priya Raman"] }, w.clock.now, HASH_KEY);
    const after = w.clock.now + 31 * 86_400_000;
    expect(await readErasedAliases(table(w), ORG_A, after)).toEqual([]);
    expect(await sweepErasedAliases(table(w), ORG_A, w.clock.now)).toBe(0);
    expect(await sweepErasedAliases(table(w), ORG_A, after)).toBe(1);
    expect(w.db.find((item) => item.pk === askErasedAliasPk(ORG_A))).toEqual([]);
  });

  it("is per org: another org's list is not read", async () => {
    const w = sessionWorld();
    await rememberErasedAliases(table(w), ORG_A, { developerId: PRIYA, names: ["Priya Raman"] }, w.clock.now, HASH_KEY);
    expect(await readErasedAliases(table(w), "org_bbbbbbbbbbbbbbbbbbbb", w.clock.now)).toEqual([]);
  });

  describe("scrubbing by hashing the text's own tokens", () => {
    const entry = (names: string[], handles: string[]) => ({ tag: "p_aaaaaa", ...aliasHashesOf(HASH_KEY, { names, handles }) });
    const dana = entry(["Dana Whitfield"], ["U0DANA0001", "dana.whitfield@example.com", "danaw"]);
    const scrub = (text: string, ...entries: Array<ReturnType<typeof entry>>) => scrubWithAliasHashes(text, entries, HASH_KEY);

    it("removes the name in the spellings people use, the email, the Slack id, the login and the @mention", () => {
      for (const text of [
        "Dana Whitfield approved it", "dana whitfield approved it", "DANA WHITFIELD approved it", "Whitfield, Dana approved it", "Dana-Whitfield approved it", "DanaWhitfield approved it", "Dana\nWhitfield approved it",
        "Dаna Whitfield approved it", "Dána Whitfield approved it", "@dana approved it", "@Whitfield approved it", "dana.whitfield@example.com approved it", "Dana.Whitfield@Example.com, approved it", "U0DANA0001 approved it",
        "@U0DANA0001 approved it", "danaw approved it", "@danaw approved it",
      ]) {
        const out = scrub(text, dana);
        expect(out, text).toContain("@former-member");
        expect(out, text).toContain("approved it");
        for (const gone of ["Dana", "dana", "Whitfield", "whitfield", "U0DANA0001", "danaw"]) expect(out, `${text} / ${gone}`).not.toContain(gone);
      }
    });

    it("leaves other text alone: a common word, a surname or first name alone without @, other people, URLs and code", () => {
      const mark = entry(["Mark Vale"], []);
      for (const text of ["mark the file as done", "Vale of tears", "the dana branch", "Sam Okafor approved it"]) expect(scrub(text, mark, dana), text).toBe(text);
      // A URL path and code identifiers hold no run that is a name or a handle.
      expect(scrub("https://example.com/path/dana/whitfield-docs", dana)).toBe("https://example.com/path/dana/whitfield-docs");
      expect(scrub("const whitfieldDanaX = 1;", dana)).toBe("const whitfieldDanaX = 1;");
      expect(scrub("mark the file as done", mark)).toBe("mark the file as done");
      expect(scrub("Dana is a common first name here", dana)).toBe("Dana is a common first name here");
      expect(scrub("Sam Okafor approved it", mark, dana)).toBe("Sam Okafor approved it");
      expect(scrub("danawhitfield2 is another", dana)).toBe("danawhitfield2 is another");
      expect(scrub("nothing here", { tag: "p_bbbbbb", names: [], handles: [], mentions: [] })).toBe("nothing here");
    });
  });

  it("a stored Ask is scrubbed with the kept hashes, read on the server, and the item holds no raw alias", async () => {
    const w = sessionWorld();
    const made = w.seedSession({ kind: "task", owner: PRIYA });
    await rememberErasedAliases(table(w), ORG_A, { developerId: ARJUN, names: ["Dana Whitfield"], handles: ["U0DANA0001", "dana.whitfield@example.com"] }, w.clock.now, HASH_KEY);
    const dependencies = { documentClient: w.db, tableName: "state", callbackSigningKey: KEY, githubPullRequests: {}, editionPolicy: { edition: "enterprise" } } as unknown as AwsBrokerDependencies;
    const ask = askDependenciesFor(dependencies, {} as never, {} as never, { LIVE_ASK_ENABLED: "1" })!;
    const { writeAsk } = await import("../../packages/broker/src/agent-sessions/ask-store.js");
    const askId = `ask_${"7".repeat(20)}`;
    await writeAsk(ask.store(ORG_A), { edition: "enterprise", orgId: ORG_A, sessionId: made.sessionId, askId, audience: "web", askedBy: PRIYA, question: "Who is Whitfield, Dana?", answer: "Dana Whitfield (dana.whitfield@example.com, U0DANA0001) did it.", contextBytes: 1, model: "m", nowMs: w.clock.now });
    const record = w.db.get(sessionAskKey(ORG_A, made.sessionId, askId)) as Record<string, unknown>;
    expect(record["answer"]).toBe("@former-member (@member, @former-member) did it.");
    expect(record["question"]).toBe("Who is @former-member?");
    expect(JSON.stringify(w.db.find((item) => String(item.pk).includes("ASKERASED")))).not.toMatch(/whitfield|dana|U0DANA/iu);
  });
});

describe("the daily upkeep", () => {
  const env = (on: boolean) => ({ LIVE_ASK_ENABLED: on ? "1" : "0" }) as NodeJS.ProcessEnv;
  const brokerOf = (w: ReturnType<typeof sessionWorld>) => ({ documentClient: w.db, tableName: "state", editionPolicy: { edition: "enterprise" } } as unknown as AwsBrokerDependencies);

  it("does nothing while the switch is off, runs once a day, and deletes the Asks past their 30 days", async () => {
    const w = sessionWorld();
    const made = w.seedSession({ kind: "task", owner: PRIYA });
    const { writeAsk } = await import("../../packages/broker/src/agent-sessions/ask-store.js");
    const store = { documentClient: w.db, tableName: "state", questionHashKey: KEY, isErased: async () => false, erasedPeople: async () => [] };
    const askId = "ask_" + "1".repeat(20);
    await writeAsk(store, { edition: "enterprise", orgId: ORG_A, sessionId: made.sessionId, askId, audience: "web", askedBy: PRIYA, question: "q", answer: "a", contextBytes: 1, model: "m", nowMs: w.clock.now });
    expect(w.db.get(sessionAskKey(ORG_A, made.sessionId as never, askId))).toBeDefined();
    expect(await runAskMaintenance(brokerOf(w), w.clock.now + 31 * 86_400_000, env(false))).toBe("off");
    expect(w.db.get(sessionAskKey(ORG_A, made.sessionId as never, askId))).toBeDefined();
    const later = w.clock.now + 31 * 86_400_000;
    const orgs = { listOrgs: async (after: string | undefined) => (after === undefined ? [ORG_A] : []) };
    expect(await runAskMaintenance(brokerOf(w), later, env(true), orgs)).toBe("ran");
    expect(w.db.get(sessionAskKey(ORG_A, made.sessionId as never, askId))).toBeUndefined();
    // Once a day: the same day again does nothing, the next day runs.
    expect(await runAskMaintenance(brokerOf(w), later + 60_000, env(true), orgs)).toBe("skipped");
    expect(await runAskMaintenance(brokerOf(w), later + 86_400_000, env(true), orgs)).toBe("ran");
    expect(ASK_SWEEP_LOOKBACK_DAYS).toBeGreaterThan(0);
  });

  it("covers EVERY org, not the first 200, and a run cut off by its time budget goes on from where it stopped (S4)", async () => {
    const w = sessionWorld();
    const audit = capturingAuditDeps({ db: w.db, now: () => w.clock.now });
    const broker = { documentClient: w.db, tableName: "state", editionPolicy: { edition: "public" }, audit: audit.audit } as unknown as AwsBrokerDependencies;
    const orgs = Array.from({ length: 450 }, (_, index) => `org_${index.toString(36).padStart(20, "0")}`).sort();
    const now = Date.UTC(2026, 10, 3, 12, 0, 0);
    const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
    for (const orgId of orgs) w.db.set({ ...askCountKey(orgId, yesterday, "web"), entityType: "ASK_COUNT", orgId, projectName: "web", day: yesterday, count: 3 });
    const requested: Array<[string | undefined, number]> = [];
    const listOrgs = async (after: string | undefined, limit: number) => { requested.push([after, limit]); return orgs.filter((id) => after === undefined || id > after).slice(0, limit); };
    // A clock that moves 1 ms for every look at it: about 100 orgs fit in a 100 ms budget.
    let ticks = 0;
    const options = { listOrgs, budgetMs: 100, clock: () => (ticks += 1) };
    const statuses: string[] = [];
    for (let run = 0; run < 20 && statuses.at(-1) !== "ran"; run += 1) {
      ticks = 0;
      statuses.push(await runAskMaintenance(broker, now, env(true), options));
    }
    expect(statuses.filter((status) => status === "partial").length).toBeGreaterThanOrEqual(3);
    expect(statuses.at(-1)).toBe("ran");
    // Every org got its daily event, once, though there are more than the 200 a page holds; and the next run the same day has nothing left to do.
    const events = audit.recordedBy("task.asked");
    expect(events).toHaveLength(450);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(450);
    expect(requested.every(([, limit]) => limit === 200)).toBe(true);
    expect(requested.some(([after]) => after !== undefined)).toBe(true);
    ticks = 0;
    expect(await runAskMaintenance(broker, now, env(true), options)).toBe("skipped");
    // The next day starts again from the first org.
    ticks = 0;
    requested.length = 0;
    expect(["partial", "ran"]).toContain(await runAskMaintenance(broker, now + 86_400_000, env(true), options));
    expect(requested[0]![0]).toBeUndefined();
  });

  it("with time to spare one run walks every page to the end", async () => {
    const w = sessionWorld();
    const audit = capturingAuditDeps({ db: w.db, now: () => w.clock.now });
    const broker = { documentClient: w.db, tableName: "state", editionPolicy: { edition: "public" }, audit: audit.audit } as unknown as AwsBrokerDependencies;
    const orgs = Array.from({ length: 450 }, (_, index) => `org_${index.toString(36).padStart(20, "0")}`).sort();
    const now = Date.UTC(2026, 10, 3, 12, 0, 0);
    const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
    for (const orgId of orgs) w.db.set({ ...askCountKey(orgId, yesterday, "web"), entityType: "ASK_COUNT", orgId, projectName: "web", day: yesterday, count: 1 });
    const listOrgs = async (after: string | undefined, limit: number) => orgs.filter((id) => after === undefined || id > after).slice(0, limit);
    expect(await runAskMaintenance(broker, now, env(true), { listOrgs })).toBe("ran");
    expect(audit.recordedBy("task.asked")).toHaveLength(450);
  });

  it("an org whose upkeep fails does not stop the others", async () => {
    const w = sessionWorld();
    const broker = { documentClient: { send: async (command: unknown) => {
      const key = (command as { input?: { Key?: { pk?: string } } }).input?.Key?.pk ?? "";
      const query = (command as { input?: { ExpressionAttributeValues?: Record<string, unknown> } }).input?.ExpressionAttributeValues?.[":pk"];
      if ((typeof query === "string" ? query : key).includes("org_bad")) throw new Error("table says no");
      return w.db.send(command as never);
    } }, tableName: "state", editionPolicy: { edition: "public" } } as unknown as AwsBrokerDependencies;
    const outcome = await runAskMaintenance(broker, w.clock.now, env(true), { listOrgs: async (after) => (after === undefined ? ["org_bad0000000000000000", "org_good000000000000000"] : []) });
    expect(outcome).toBe("ran");
  });
});

describe("the switch and the wiring", () => {
  const stubs = (queue?: { send(): Promise<void> }) => ({
    documentClient: {}, tableName: "state", callbackSigningKey: KEY, githubPullRequests: {}, developer: queue === undefined ? undefined : { slackRequestQueue: queue },
    editionPolicy: { edition: "enterprise" },
  } as unknown as AwsBrokerDependencies);

  it("builds nothing unless LIVE_ASK_ENABLED is exactly '1'", async () => {
    const { askDependenciesFor } = await import("../../packages/broker/src/aws/broker/ask-service.js");
    for (const value of [undefined, "", "0", "true", " 1", "1 ", "on", "yes", "2"]) {
      expect(askDependenciesFor(stubs(), {} as never, {} as never, { LIVE_ASK_ENABLED: value }), String(value)).toBeUndefined();
    }
    const built = askDependenciesFor(stubs({ send: async () => undefined }), {} as never, {} as never, { LIVE_ASK_ENABLED: "1" });
    expect(built).toMatchObject({ enabled: true, edition: "enterprise" });
    expect(built?.queue).toBeDefined();
    // The question hash key comes from the broker's signing key, never from code, and is not that key.
    expect(JSON.stringify(built?.store(ORG_A))).not.toContain(KEY);
  });

  it("the session routes answer NOT_FOUND for the Ask paths while there are no Ask dependencies, and route them when there are", async () => {
    const { routeAgentSessionRequest } = await import("../../packages/broker/src/agent-sessions/routes.js");
    const t = world();
    const url = (path: string) => new URL(`https://x.invalid${path}`);
    const request = (method: string, body?: unknown) => ({ method, path: "", headers: {}, requestId: "r", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const path = `/v1/app/sessions/${t.made.sessionId}`;
    await expect(routeAgentSessionRequest({} as never, t.w.caller(PRIYA), request("POST", { requestId: randomUUID(), question: "Why?" }), url(`${path}/ask`))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(routeAgentSessionRequest({} as never, t.w.caller(PRIYA), request("GET"), url(`${path}/asks/ask_aaaaaaaaaaaaaaaaaaaa`))).rejects.toMatchObject({ code: "NOT_FOUND" });
    const asked = await routeAgentSessionRequest({ ask: t.ask } as never, t.w.caller(PRIYA), request("POST", { requestId: randomUUID(), question: "Why?" }), url(`${path}/ask`)) as { askId: string; state: string };
    expect(asked.state).toBe("queued");
    expect(await routeAgentSessionRequest({ ask: t.ask } as never, t.w.caller(PRIYA), request("GET"), url(`${path}/asks/${asked.askId}`))).toEqual({ askId: asked.askId, state: "queued" });
    // The wrong method on either path is not a route.
    await expect(routeAgentSessionRequest({ ask: t.ask } as never, t.w.caller(PRIYA), request("GET"), url(`${path}/ask`))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(routeAgentSessionRequest({ ask: t.ask } as never, t.w.caller(PRIYA), request("POST", {}), url(`${path}/asks/${asked.askId}`))).rejects.toMatchObject({ code: "NOT_FOUND" });
    // An Ask is read by the person who asked alone.
    await expect(routeAgentSessionRequest({ ask: t.ask } as never, t.w.caller(ARJUN), request("GET"), url(`${path}/asks/${asked.askId}`))).rejects.toSatisfy((error: { code?: string }) => ["NOT_FOUND", "SESSION_LEVEL_REQUIRED"].includes(String(error.code)));
  });
});

describe("the erase walk remembers the aliases (LI-2)", () => {
  async function erased(options: { key?: string; chosenName?: string }) {
    const { erasePerson } = await import("../../packages/broker/src/team-record/erase.js");
    const { ORG_A: RECORD_ORG, world: recordWorld } = await import("../support/team-record-core.js");
    const { deleteDeps } = await import("../support/team-record-delete.js");
    const rw = recordWorld();
    const d = deleteDeps(rw);
    const person = "e".repeat(64);
    if (options.chosenName !== undefined) rw.db.set({ pk: `DEVELOPER_NAME#${person}`, sk: "NAME", entityType: "DEVELOPER_NAME", developerId: person, name: options.chosenName, chosenAt: "2026-10-01T00:00:00.000Z" });
    await erasePerson({ ...d.deps, ...(options.key === undefined ? {} : { askAliasKey: options.key }) }, RECORD_ORG, { developerId: person, projects: ["web"], names: ["Dana Whitfield"], identities: [{ system: "slack", sourceId: "U0DANA0001" }, { system: "github", sourceId: "dana.w@example.com" }] }, "ask-alias-1");
    return { rw, RECORD_ORG, person, entries: () => readErasedAliases({ documentClient: rw.db, tableName: "TeamRecord" }, RECORD_ORG, Date.now()) };
  }

  it("keeps hashes of the names (the caller's and the one the person chose) and of the source ids for 30 days under their label tag; no raw alias, no developer id, and no names in the second-pass item", async () => {
    const key = askAliasHashKey(KEY);
    const t = await erased({ key, chosenName: "Dani W" });
    const [alias] = await t.entries();
    expect(scrubWithAliasHashes("Dana Whitfield, U0DANA0001, dana.w@example.com and @dani", [alias!], key)).toBe("@former-member, @former-member, @former-member and @former-member");
    const kept = JSON.stringify(t.rw.db.find((item) => String(item.pk).includes("ASKERASED")));
    for (const secret of ["Dana", "Whitfield", "U0DANA0001", "dana.w@example.com", "Dani", t.person]) expect(kept.toLowerCase(), secret).not.toContain(secret.toLowerCase());
    const sweep = rw(t).db.find((item) => String(item.sk).startsWith("ERASESWEEP#"));
    expect(sweep.length).toBeGreaterThan(0);
    expect(JSON.stringify(sweep)).not.toContain("Dana Whitfield");
  });

  it("without the install's key only the label tag is kept", async () => {
    const t = await erased({});
    const [alias] = await t.entries();
    expect(alias).toMatchObject({ names: [], handles: [], mentions: [] });
    expect(JSON.stringify(t.rw.db.find((item) => String(item.pk).includes("ASKERASED"))).toLowerCase()).not.toContain("dana");
  });
});
const rw = (t: { rw: { db: { find(predicate: (item: Record<string, unknown>) => boolean): Array<Record<string, unknown>> } } }) => t.rw;
