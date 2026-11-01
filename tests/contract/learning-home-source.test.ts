// v1.2 learning loop, B7: the Home card (design 6.3). One card per project with open suggestions, shown only to the project's maintainers; read from STATE alone; settlement of waiting rules
// is bounded (one approval read per awaiting rule, at most 5, inside the source's time) and its writes are left to a port. The first test imports no learning module: the card comes
// from the Home route itself, which proves the source is registered where Home is built.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { HOME_CARD_ID_PATTERN, HomeResponseSchema, approvalKey, type HomeResponse, type OrgId } from "../../packages/contracts/src/index.js";
import { routeAgentSessionRequest, type SessionRouteDependencies } from "../../packages/broker/src/agent-sessions/routes.js";
import { createPendingChange, type ApprovalDependencies } from "../../packages/broker/src/agents/approvals.js";
import type { AgentRouteDependencies } from "../../packages/broker/src/agents/routes.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { orgLearningSettingsKey, projectLearningKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { ARJUN, CELL, MAX, MIA, OLA, ORG_A, ORG_B, PRIYA, ZED, sessionWorld } from "../support/agent-session-world.js";

afterEach(() => { vi.unstubAllEnvs(); });

const PC = "2026-10-02T00:00:00.000Z";
type Item = Record<string, unknown>;

function world() {
  const w = sessionWorld();
  const approvals = {
    store: new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now }), projectMembers: w.members, documentClient: w.db, tableName: "state", signInStore: w.signInStore,
    now: () => w.clock.now, confirmOrigin: CELL, log: () => undefined,
  } as unknown as ApprovalDependencies & AgentRouteDependencies;
  const storeDeps = { documentClient: w.db, tableName: "state", now: () => w.clock.now };
  const state = (project: string, fields: Partial<{ openSuggestions: number; pendingRules: number; projectCreatedAt: string; lastGroupedAt: string }> = {}, orgId: OrgId = ORG_A) => {
    w.db.set({ ...projectLearningKey(orgId, project, "STATE"), entityType: "LEARNING_STATE", orgId, revision: 4, projectCreatedAt: PC, openSuggestions: 2, liveCorrections: 6, pendingRules: 0, ...fields });
  };
  const awaitingRule = async (project: string, n: number, status = "DECLINED") => {
    const record = await createPendingChange(storeDeps, {
      orgId: ORG_A, requestId: randomUUID(), requestedBy: ARJUN, subject: { kind: "session_owner", sessionId: "ses_99999999999999999999", to: ARJUN, sessionRevision: 1 } as never, changes: ["Publish a rule"], approvers: { kind: "ids", ids: [ZED] },
    });
    const key = approvalKey(ORG_A, record.approvalId);
    w.db.set({ ...(w.db.get(key) as Item), status });
    w.db.set({
      ...projectLearningKey(ORG_A, project, `RULE#r${String(n)}`), entityType: "LEARNING_RULE", orgId: ORG_A, id: `r${String(n)}`, suggestionId: `s${String(n)}`, stage: "build", text: "Use the shared retry helper.", processAgentId: "agt_1",
      requestId: `req-${String(n)}`, approvalId: record.approvalId, status: "awaiting_approval", projectCreatedAt: PC,
    });
    return record.approvalId;
  };
  const logs: Array<Record<string, unknown>> = [];
  const deps = (extra: Partial<SessionRouteDependencies> = {}): SessionRouteDependencies => ({
    documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
    taskView: async () => ({}) as never, approvals, log: (entry) => logs.push(entry), ...extra,
  });
  const home = (who: string, orgId: OrgId = ORG_A, extra: Partial<SessionRouteDependencies> = {}) =>
    routeAgentSessionRequest(deps(extra), w.caller(who, orgId), { method: "GET", path: "/v1/app/home", headers: {}, requestId: "r" }, new URL(`${CELL}/v1/app/home`)) as Promise<HomeResponse>;
  const cardsOf = async (who: string, orgId: OrgId = ORG_A) => (await home(who, orgId)).cards.filter((card) => card.kind === "rule_suggestion");
  return { ...w, approvals, state, awaitingRule, deps, home, cardsOf, logs };
}

describe("the Home source", () => {
  it("is registered by Home itself: a maintainer gets a card for a project with open suggestions, with no learning module imported here", async () => {
    const w = world();
    w.state("web");
    const cards = await w.cardsOf(MAX);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "rule_suggestion", buttons: [{ label: "Review", action: "open", method: "GET", href: `${CELL}/app/projects/web?tab=how-we-work` }] });
    expect(cards[0]!.cardId).toMatch(HOME_CARD_ID_PATTERN);
    expect(cards[0]!.cardId.startsWith("rule_suggestion:")).toBe(true);
    // The project's name is not in the card id; the card holds a count, never a correction's or a rule's words.
    expect(cards[0]!.cardId).not.toContain("web");
    expect(cards[0]!.reason).toContain("2");
    expect(HomeResponseSchema.safeParse(await w.home(MAX)).success).toBe(true);
  });

  it("shows it only to maintainers of the project: not to a contributor, a viewer or a member with no role, and to an org admin for every project", async () => {
    const w = world();
    w.state("web");
    w.state("ops");
    expect((await w.cardsOf(MAX)).length).toBe(1);
    for (const who of [PRIYA, ARJUN, MIA, ZED]) expect(await w.cardsOf(who), who).toEqual([]);
    expect((await w.cardsOf(OLA)).length).toBe(2);
  });

  it("makes no card when there are no open suggestions, when the STATE belongs to an earlier project of that name, or when the project is archived", async () => {
    const w = world();
    w.state("web", { openSuggestions: 0 });
    expect(await w.cardsOf(MAX)).toEqual([]);
    w.state("web", { openSuggestions: 3, projectCreatedAt: "2026-01-01T00:00:00.000Z" });
    expect(await w.cardsOf(MAX)).toEqual([]);
    w.state("web", { openSuggestions: 3 });
    expect(await w.cardsOf(MAX)).toHaveLength(1);
    w.members.archive(ORG_A, "web");
    expect(await w.cardsOf(MAX)).toEqual([]);
  });

  it("never shows another company's project, and reads at most 25 projects", async () => {
    const w = world();
    w.state("web", {}, ORG_A);
    w.state("web", { openSuggestions: 5 }, ORG_B);
    expect((await w.cardsOf(MAX)).length).toBe(1);
    for (let n = 0; n < 40; n += 1) {
      const name = `p${String(n).padStart(2, "0")}`;
      w.project(ORG_A, name);
      w.state(name);
    }
    const cards = await w.cardsOf(OLA);
    expect(cards.length).toBeLessThanOrEqual(25);
    expect(cards.length).toBeGreaterThan(0);
  });

  it("writes nothing when it builds the card: no notification item, no stream filter, no state change", async () => {
    const w = world();
    w.state("web");
    const before = JSON.stringify([...w.db.items.entries()]);
    await w.home(MAX);
    expect(JSON.stringify([...w.db.items.entries()])).toBe(before);
    const writes = w.db.commandNames().filter((name) => /^(Put|Update|Delete|TransactWrite|BatchWrite)Command$/.test(name));
    expect(writes).toEqual([]);
  });

  it("is not dismissible: the card goes away when its suggestions are decided", async () => {
    const w = world();
    w.state("web");
    const [card] = await w.cardsOf(MAX);
    const answer = routeAgentSessionRequest(w.deps(), w.caller(MAX), { method: "POST", path: `/v1/app/home/cards/${encodeURIComponent(card!.cardId)}/dismiss`, headers: {}, requestId: "r" }, new URL(`${CELL}/v1/app/home/cards/${encodeURIComponent(card!.cardId)}/dismiss`));
    await expect(answer).rejects.toThrow();
    w.state("web", { openSuggestions: 0 });
    expect(await w.cardsOf(MAX)).toEqual([]);
  });
});

describe("settlement of waiting rules from Home", () => {
  async function settling() {
    const { setLearningHomeSettler } = await import("../../packages/broker/src/learning/home-source.js");
    const settled: Array<Record<string, unknown>> = [];
    setLearningHomeSettler(async (input) => { settled.push(input as never); });
    return { settled, off: () => setLearningHomeSettler(undefined) };
  }
  /** A table that counts the reads of approval records and can hold them for as long as a test says. */
  function counting(w: ReturnType<typeof world>, hang = false) {
    const reads: string[] = [];
    const client = {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (command instanceof GetCommand && String((command.input.Key as Item | undefined)?.["pk"]).includes("APPROVAL")) {
          reads.push(String((command.input.Key as Item)["pk"]));
          if (hang) return new Promise(() => undefined);
        }
        return w.db.send(command);
      },
    };
    return { reads, approvals: { ...w.approvals, documentClient: client } as never };
  }

  it("reads one approval for each awaiting rule, at most 5 in a call, and hands the ended ones to the settler (fire and forget)", async () => {
    const w = world();
    const { settled, off } = await settling();
    try {
      w.state("web", { pendingRules: 7 });
      for (let n = 1; n <= 7; n += 1) await w.awaitingRule("web", n, n === 1 ? "PENDING" : n === 2 ? "APPROVED_DONE" : "DECLINED");
      const c = counting(w);
      const cards = (await w.home(MAX, ORG_A, { approvals: c.approvals })).cards.filter((card) => card.kind === "rule_suggestion");
      expect(cards).toHaveLength(1);
      expect(c.reads.length).toBe(5);
      expect(new Set(c.reads).size).toBe(5);
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The one still waiting is not handed on; the others read are, each once, with only ids and the approval's status.
      expect(settled.length).toBe(4);
      expect(new Set(settled.map((entry) => entry.ruleId)).size).toBe(4);
      expect(settled.every((entry) => ["APPROVED_DONE", "DECLINED"].includes(String(entry.approvalStatus)))).toBe(true);
      expect(JSON.stringify(settled)).not.toContain("Use the shared retry helper");
    } finally { off(); }
  });

  it("reads no approval when no rule is waiting, and none for a caller who is not a maintainer", async () => {
    const w = world();
    const { off } = await settling();
    try {
      w.state("web", { pendingRules: 0 });
      await w.awaitingRule("web", 1);
      const c = counting(w);
      await w.home(MAX, ORG_A, { approvals: c.approvals });
      expect(c.reads.length).toBe(0);
      w.state("web", { pendingRules: 1 });
      await w.home(PRIYA, ORG_A, { approvals: c.approvals });
      expect(c.reads.length).toBe(0);
    } finally { off(); }
  });

  it("keeps the card inside the source's time when the approval reads do not answer, and leaves settlement to the next read", async () => {
    const w = world();
    const { settled, off } = await settling();
    try {
      w.state("web", { pendingRules: 2 });
      await w.awaitingRule("web", 1);
      await w.awaitingRule("web", 2);
      const c = counting(w, true);
      const started = Date.now();
      const answer = await w.home(MAX, ORG_A, { approvals: c.approvals, homeSourceTimeoutMs: 400 });
      expect(Date.now() - started).toBeLessThan(900);
      expect(answer.cards.filter((card) => card.kind === "rule_suggestion")).toHaveLength(1);
      expect(c.reads.length).toBe(2);
      expect(settled).toEqual([]);
      expect(w.logs.filter((entry) => entry.event === "home.source_failed")).toEqual([]);
    } finally { off(); }
  });

  it("counts the settling window from the start of the source: a slow batch read leaves less time for approvals, never more", async () => {
    const w = world();
    const { settled, off } = await settling();
    try {
      w.state("web", { pendingRules: 1 });
      await w.awaitingRule("web", 1);
      // The source has 400 ms, so approvals may be read in the first 200 ms of it. The batch read alone takes 250 ms, so no approval is read at all.
      const slow = { send: async (command: { constructor: { name: string } }) => { if (command.constructor.name === "BatchGetCommand") await new Promise((resolve) => setTimeout(resolve, 250)); return w.db.send(command as never); } };
      const c = counting(w);
      const answer = await w.home(MAX, ORG_A, { approvals: c.approvals, homeSourceTimeoutMs: 400, documentClient: slow });
      expect(answer.cards.filter((card) => card.kind === "rule_suggestion")).toHaveLength(1);
      expect(c.reads).toEqual([]);
      expect(settled).toEqual([]);
      // With a fast batch read the same rule is read and settled.
      const fast = counting(w);
      await w.home(MAX, ORG_A, { approvals: fast.approvals, homeSourceTimeoutMs: 400 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fast.reads.length).toBe(1);
      expect(settled).toHaveLength(1);
    } finally { off(); }
  });

  it("does not fail the card when the settler fails", async () => {
    const w = world();
    const { setLearningHomeSettler } = await import("../../packages/broker/src/learning/home-source.js");
    setLearningHomeSettler(async () => { throw new Error("SECRET-DETAIL"); });
    try {
      w.state("web", { pendingRules: 1 });
      await w.awaitingRule("web", 1);
      expect((await w.cardsOf(MAX)).length).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(JSON.stringify(w.logs)).not.toContain("SECRET-DETAIL");
    } finally { setLearningHomeSettler(undefined); }
  });
});

describe("the company's master suggestions switch", () => {
  const setSwitch = (w: ReturnType<typeof world>, suggestions: "on" | "off", revision = 1) => w.db.set({
    ...orgLearningSettingsKey(ORG_A), entityType: "LEARNING_COMPANY_SETTINGS", orgId: ORG_A, revision, suggestions, changedBy: MAX, changedAt: PC,
  });

  it("makes no rule_suggestion card while off, for a maintainer and an admin alike, and the card is back when it is on", async () => {
    const w = world();
    w.state("web");
    expect((await w.cardsOf(MAX)).length).toBe(1);
    setSwitch(w, "off");
    expect(await w.cardsOf(MAX)).toEqual([]);
    expect(await w.cardsOf(OLA)).toEqual([]);
    setSwitch(w, "on", 2);
    expect((await w.cardsOf(MAX)).length).toBe(1);
  });

  it("follows the install default when the company never chose", async () => {
    const w = world();
    w.state("web");
    vi.stubEnv("LEARNING_SUGGESTIONS_DEFAULT", "off");
    expect(await w.cardsOf(MAX)).toEqual([]);
    vi.stubEnv("LEARNING_SUGGESTIONS_DEFAULT", "on");
    expect((await w.cardsOf(MAX)).length).toBe(1);
  });

  it("still hands ended approvals to the settler while off (settlement is never gated)", async () => {
    const w = world();
    const { setLearningHomeSettler } = await import("../../packages/broker/src/learning/home-source.js");
    const settled: Array<Record<string, unknown>> = [];
    setLearningHomeSettler(async (input) => { settled.push(input as never); });
    try {
      setSwitch(w, "off");
      w.state("web", { pendingRules: 1 });
      await w.awaitingRule("web", 1, "DECLINED");
      expect(await w.cardsOf(MAX)).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({ ruleId: "r1", approvalStatus: "DECLINED" });
    } finally { setLearningHomeSettler(undefined); }
  });
});
