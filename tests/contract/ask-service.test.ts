// Live interaction A3: the broker's service routes for the chat service (`/v1/service/asks/*`), the daily upkeep, the erased people's kept aliases (register LI-2), and the Slack question's rates and
// record. The routes answer the orchestrator role only, name the Ask (never a Slack thread), trust nothing in the request about who asks or what they pay, and are NOT_FOUND while the switch is off.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { ASK_RATE, askErasedAliasPk, sessionRateKey, sessionAskKey } from "../../packages/contracts/src/index.js";

const mint = vi.hoisted(() => vi.fn((...args: unknown[]) => { void args; return Promise.resolve({ baseUrl: "https://proxy.example.invalid", apiKey: "fake-key-not-a-secret", expiresAt: 1 }); }));
vi.mock("../../packages/broker/src/aws/broker/model-access.js", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), mintChatTurnKey: mint }));

import { handleAskServiceRoute, runAskMaintenance } from "../../packages/broker/src/aws/broker/ask-service.js";
import { recordSlackAsk, takeSlackAskRates, type AskDependencies } from "../../packages/broker/src/agent-sessions/ask.js";
import { ERASED_ALIAS_RETENTION_DAYS, readErasedAliases, rememberErasedAliases, sweepErasedAliases } from "../../packages/broker/src/agent-sessions/ask-erased-aliases.js";
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
    t.w.db.delete(t.w.db.find((item) => String(item.sk) === `SHARE#MEMBER#${ARJUN}`)[0]!);
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

describe("erased people's kept aliases (LI-2): at most 30 days, then deleted", () => {
  const table = (w: ReturnType<typeof sessionWorld>) => ({ documentClient: w.db, tableName: "state" });

  it("keeps the names and handles under the person's label tag only, for the same 30 days as an Ask", async () => {
    const w = sessionWorld();
    await rememberErasedAliases(table(w), ORG_A, { developerId: PRIYA, names: ["Priya Raman"], handles: ["U0PRIYA001"] }, w.clock.now);
    const items = w.db.find((item) => item.pk === askErasedAliasPk(ORG_A));
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items)).not.toContain(PRIYA);
    expect(items[0]!["sk"]).toMatch(/^p_[0-9a-f]{6}$/u);
    expect(ERASED_ALIAS_RETENTION_DAYS).toBe(30);
    expect(items[0]!["indexExpiresAt"]).toBe(Math.floor(w.clock.now / 1000) + 30 * 86_400);
    const [alias] = await readErasedAliases(table(w), ORG_A, w.clock.now);
    expect(alias).toMatchObject({ names: ["Priya Raman"], handles: ["U0PRIYA001"], tag: items[0]!["sk"] });
    expect(alias!.developerId.startsWith("erased:")).toBe(true);
  });

  it("is merged by the erase's second pass (which carries no names) and keeps the first erasure's expiry", async () => {
    const w = sessionWorld();
    await rememberErasedAliases(table(w), ORG_A, { developerId: PRIYA, names: ["Priya Raman"], handles: ["a"] }, w.clock.now);
    await rememberErasedAliases(table(w), ORG_A, { developerId: PRIYA, handles: ["b"] }, w.clock.now + 20 * 60_000);
    const [alias] = await readErasedAliases(table(w), ORG_A, w.clock.now);
    expect(alias).toMatchObject({ names: ["Priya Raman"], handles: ["a", "b"] });
    const [item] = w.db.find((entry) => entry.pk === askErasedAliasPk(ORG_A));
    expect(item!["indexExpiresAt"]).toBe(Math.floor(w.clock.now / 1000) + 30 * 86_400);
  });

  it("ignores an alias past its time even before the table removes it, and the sweep deletes it", async () => {
    const w = sessionWorld();
    await rememberErasedAliases(table(w), ORG_A, { developerId: PRIYA, names: ["Priya Raman"] }, w.clock.now);
    const after = w.clock.now + 31 * 86_400_000;
    expect(await readErasedAliases(table(w), ORG_A, after)).toEqual([]);
    expect(await sweepErasedAliases(table(w), ORG_A, w.clock.now)).toBe(0);
    expect(await sweepErasedAliases(table(w), ORG_A, after)).toBe(1);
    expect(w.db.find((item) => item.pk === askErasedAliasPk(ORG_A))).toEqual([]);
  });

  it("is per org: another org's list is not read", async () => {
    const w = sessionWorld();
    await rememberErasedAliases(table(w), ORG_A, { developerId: PRIYA, names: ["Priya Raman"] }, w.clock.now);
    expect(await readErasedAliases(table(w), "org_bbbbbbbbbbbbbbbbbbbb", w.clock.now)).toEqual([]);
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
    const orgs = async () => [ORG_A];
    expect(await runAskMaintenance(brokerOf(w), later, env(true), orgs)).toBe("ran");
    expect(w.db.get(sessionAskKey(ORG_A, made.sessionId as never, askId))).toBeUndefined();
    // Once a day: the same day again does nothing, the next day runs.
    expect(await runAskMaintenance(brokerOf(w), later + 60_000, env(true), orgs)).toBe("skipped");
    expect(await runAskMaintenance(brokerOf(w), later + 86_400_000, env(true), orgs)).toBe("ran");
    expect(ASK_SWEEP_LOOKBACK_DAYS).toBeGreaterThan(0);
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
  it("keeps the erased person's names and source ids for 30 days under their label tag, and never puts the names in the erase's second-pass item", async () => {
    const { erasePerson } = await import("../../packages/broker/src/team-record/erase.js");
    const { ORG_A: RECORD_ORG, world: recordWorld } = await import("../support/team-record-core.js");
    const { deleteDeps } = await import("../support/team-record-delete.js");
    const rw = recordWorld();
    const d = deleteDeps(rw);
    const erased = "e".repeat(64);
    await erasePerson(d.deps, RECORD_ORG, { developerId: erased, projects: ["web"], names: ["Dana Whitfield"], identities: [{ system: "slack", sourceId: "U0DANA0001" }] }, "ask-alias-1");
    const [alias] = await readErasedAliases({ documentClient: rw.db, tableName: "TeamRecord" }, RECORD_ORG, Date.now());
    expect(alias).toMatchObject({ names: ["Dana Whitfield"], handles: ["U0DANA0001"] });
    expect(JSON.stringify(rw.db.find((item) => String(item.pk).includes("ASKERASED")))).not.toContain(erased);
    const sweep = rw.db.find((item) => String(item.sk).startsWith("ERASESWEEP#"));
    expect(sweep.length).toBeGreaterThan(0);
    expect(JSON.stringify(sweep)).not.toContain("Dana Whitfield");
  });
});
