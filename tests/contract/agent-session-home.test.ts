// Plan 5 Task 15: Home. `GET /v1/app/home` answers one person's attention cards, ranked, with the reason each is shown, a destination (`href`) for every action they may take, and the total
// of all their cards; `POST /v1/app/home/cards/{cardId}/dismiss` hides a failure or an offer for that person. What Home shows is read for the caller, now: an approval only to a person who
// may decide it (and its confirm link only to them), a session only to a person who may view it, plan, pull request and failure cards only for sessions the caller owns now, and a dismissal
// only ever in the caller's own partition. Each source of cards is bounded and may fail without taking the others down.
import type { AgentRouteDependencies } from "../../packages/broker/src/agents/routes.js";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  HOME_CARDS_MAX, HOME_CARD_BUTTONS_MAX, HOME_CARD_KINDS, HOME_DISMISSIBLE_KINDS, HOME_DISMISS_DAYS, HOME_NOT_DISMISSIBLE, HOME_REASON_MAX, HomeCardReaderSchema, HomeCardSchema, HomeDismissResponseReaderSchema,
  HomeDismissResponseSchema, HomeResponseReaderSchema, HomeResponseSchema, agentSessionKey, homeDismissedKey, mySessionsKey, openSpendRequestsKey, spendRequestKey, type HomeCard, type HomeResponse, type OrgId, type SessionStatus,
} from "../../packages/contracts/src/index.js";
import { isAgentSessionRoute, routeAgentSessionRequest, type SessionRouteDependencies } from "../../packages/broker/src/agent-sessions/routes.js";
import { registerHomeCardSource, type HomeCardSource } from "../../packages/broker/src/agent-sessions/home.js";
import { createPendingChange, createWriteApprovalRecord, type ApprovalDependencies } from "../../packages/broker/src/agents/approvals.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { ARJUN, BO, CELL, MAX, MIA, OLA, ORG_A, ORG_B, PRIYA, T0, ZED, sessionWorld } from "../support/agent-session-world.js";

type Item = Record<string, unknown>;
const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;
const sha = (digit: string) => digit.repeat(64);
const PR_URL = "https://github.com/acme/web/pull/7";

const unregister: Array<() => void> = [];
afterEach(() => {
  while (unregister.length > 0) unregister.pop()!();
});

interface OwnSeed {
  owner?: string; status?: SessionStatus; stage?: string; state?: string; step?: string; lastRunFailed?: boolean; endedAgoDays?: number; title?: string; minute?: number; project?: string | null;
  kind?: "task" | "chain" | "local"; pullRequests?: unknown[]; currentOwner?: string; workflowBlocked?: boolean; people?: Array<{ developerId: string; role: "owner" | "commenter" | "viewer" | "denied" }>;
  updatedMinutesAgo?: number; agent?: boolean;
}

/** The plan's company, with a way to seed the sessions of one person the way the summary refresh leaves them, and the approvals they wait on. */
function world() {
  const w = sessionWorld();
  const logs: Array<Record<string, unknown>> = [];
  const approvals = {
    store: new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now }), projectMembers: w.members, documentClient: w.db, tableName: "state", signInStore: w.signInStore,
    now: () => w.clock.now, confirmOrigin: CELL, log: () => undefined,
  } as unknown as ApprovalDependencies & AgentRouteDependencies;
  const storeDeps = { documentClient: w.db, tableName: "state", now: () => w.clock.now };
  let counter = 0;
  const base = Date.parse("2026-10-22T06:00:00.000Z");
  const at = (minute: number) => iso(base + minute * 60_000);

  const own = (o: OwnSeed = {}) => {
    counter += 1;
    const minute = o.minute ?? counter;
    const owner = o.owner ?? PRIYA;
    const seeded = w.seedSession({ owner, ...(o.project === undefined ? {} : { project: o.project }), ...(o.kind === undefined ? {} : { kind: o.kind }), ...(o.currentOwner === undefined ? {} : { currentOwner: o.currentOwner }), ...(o.people === undefined ? {} : { people: o.people }) });
    const createdAt = at(minute);
    const meta = w.db.get(agentSessionKey(ORG_A, seeded.sessionId, "META")) as Item & { summary: Item };
    const endedAt = o.endedAgoDays === undefined ? undefined : iso(w.clock.now - o.endedAgoDays * DAY);
    const { endedAt: _unused, ...open } = meta; // eslint-disable-line @typescript-eslint/no-unused-vars -- the seed's own end is replaced
    w.db.set({
      ...open, createdAt, updatedAt: o.updatedMinutesAgo === undefined ? at(minute) : iso(w.clock.now - o.updatedMinutesAgo * 60_000), title: o.title ?? `Task ${String(minute)}`, ...(endedAt === undefined ? {} : { endedAt }),
      summary: {
        ...meta.summary, status: o.status ?? "running", ...(o.step === undefined ? {} : { step: o.step }), ...(o.lastRunFailed === true ? { lastRunFailed: true } : {}),
        ...(o.workflowBlocked === true ? { workflowBlocked: true } : {}), computedAt: createdAt,
      },
    });
    if (seeded.record.kind === "task" && o.agent === true) {
      const task = w.db.get(taskKey(seeded.taskId)) as Item;
      w.db.set({ ...task, agent: { agentId: "ticket-triage", name: "Ticket triage", version: 2, builtin: false, digest: sha("d") } });
    }
    if (seeded.record.kind === "task" && o.stage !== undefined) {
      const task = w.db.get(taskKey(seeded.taskId)) as Item;
      w.db.set({
        ...task, workflow: { revision: 3, stage: o.stage, state: o.state ?? "WAITING", path: "QUICK", artifacts: [], decisions: [], ...(o.pullRequests === undefined ? {} : { pullRequests: o.pullRequests }) },
      });
    }
    const listedFor = o.currentOwner ?? owner;
    w.db.set({ ...mySessionsKey(ORG_A, listedFor, createdAt, seeded.sessionId), entityType: "MY_SESSION", orgId: ORG_A, sessionId: seeded.sessionId, developerId: listedFor, createdAt });
    return { ...seeded, createdAt };
  };
  const plan = (o: OwnSeed = {}) => own({ status: "needs_person", stage: "PLAN_REVIEW", state: "WAITING", ...o });
  const pullRequest = (o: OwnSeed = {}) => own({ status: "waiting", stage: "WAIT_FOR_MERGE", state: "WAITING", pullRequests: [{ repositoryId: "r1", number: 7, url: PR_URL, candidateDigest: sha("c"), required: true, state: "OPEN" }], ...o });
  const failed = (o: OwnSeed = {}) => own({ status: "failed", endedAgoDays: 1, step: "Failed: runtime_unavailable", agent: true, ...o });

  /** A write approval a running session of `owner` waits on, listed for `approvers`. */
  const writeApproval = async (o: { id: string; taskId: string; approvers?: string[]; summary?: string; agent?: { agentId: string; name: string } | null; minute: number; owner?: string; expiresInDays?: number; status?: string } ) => {
    const record = {
      orgId: ORG_A, approvalId: o.id, kind: "write", subject: { kind: "agent_run", taskId: o.taskId, stepId: o.id.slice(4) }, operationId: randomUUID(), connector: "linear", connectorType: "linear",
      tool: "save_issue", toolAccess: "write", scope: "eng", schemaHash: "a".repeat(64), projectRevision: 1, scopeDigest: "b".repeat(64), arguments: { title: "SECRET-ARGUMENT" }, argumentsHash: "c".repeat(64),
      summary: o.summary ?? "Create a Linear issue", class: "consequential", approvers: { kind: "ids", ids: o.approvers ?? [PRIYA] }, status: o.status ?? "PENDING", project: "web",
      owner: { developerId: o.owner ?? MAX, name: o.owner === undefined ? "Max" : "Someone" }, ...(o.agent === null ? {} : { agent: o.agent ?? { agentId: "agt_aaaaaaaaaaaaaaaaaaaa", name: "Linear helper" } }),
      attempts: 0, createdAt: at(o.minute), expiresAt: iso(w.clock.now + (o.expiresInDays ?? 7) * DAY),
    };
    expect(await createWriteApprovalRecord(storeDeps, record as never, [], 8)).toBe("created");
    return o.id;
  };
  /** A change that waits for `approvers` (a take-over of a session nobody here owns), made `minute` minutes into the morning. */
  const changeApproval = async (minute: number, approvers: string[] = [PRIYA]) => {
    const before = w.clock.now;
    w.clock.now = base + minute * 60_000;
    const record = await createPendingChange(storeDeps, {
      orgId: ORG_A, requestId: randomUUID(), requestedBy: ARJUN, subject: { kind: "session_owner", sessionId: "ses_99999999999999999999", to: ARJUN, sessionRevision: 1 } as never,
      changes: ["Take this session over"], approvers: { kind: "ids", ids: approvers },
    });
    w.clock.now = before;
    return record.approvalId;
  };
  /** A running session of Max's in `web` and a write approval on it that `approvers` may decide. */
  const blocking = async (id: string, minute: number, o: { approvers?: string[]; agent?: { agentId: string; name: string } | null; summary?: string; people?: OwnSeed["people"]; ended?: boolean } = {}) => {
    const session = own({ owner: MAX, minute, title: `Max's run ${String(minute)}`, ...(o.people === undefined ? {} : { people: o.people }), ...(o.ended === true ? { status: "succeeded" as const, endedAgoDays: 0 } : {}) });
    await writeApproval({ id, taskId: session.taskId, minute, ...(o.approvers === undefined ? {} : { approvers: o.approvers }), ...(o.agent === undefined ? {} : { agent: o.agent }), ...(o.summary === undefined ? {} : { summary: o.summary }) });
    return session;
  };

  const deps = (extra: Partial<SessionRouteDependencies> = {}): SessionRouteDependencies => ({
    documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
    taskView: async () => ({}) as never, approvals, log: (entry) => logs.push(entry), ...extra,
  });
  const call = (method: string, path: string, who: string, orgId: OrgId = ORG_A, extra: Partial<SessionRouteDependencies> = {}) =>
    routeAgentSessionRequest(deps(extra), w.caller(who, orgId), { method, path, headers: {}, requestId: "r" }, new URL(`${CELL}${path}`));
  const home = (who: string, orgId: OrgId = ORG_A, extra: Partial<SessionRouteDependencies> = {}) => call("GET", "/v1/app/home", who, orgId, extra) as Promise<HomeResponse>;
  const dismiss = (who: string, cardId: string, orgId: OrgId = ORG_A, extra: Partial<SessionRouteDependencies> = {}) => call("POST", `/v1/app/home/cards/${encodeURIComponent(cardId)}/dismiss`, who, orgId, extra);
  const ids = async (who: string, orgId: OrgId = ORG_A) => (await home(who, orgId)).cards.map((card) => card.cardId);
  const dismissed = (who: string, cardId: string) => w.db.get(homeDismissedKey(ORG_A, who, cardId));
  return { ...w, logs, approvals, deps, call, home, dismiss, ids, dismissed, own, plan, pullRequest, failed, writeApproval, changeApproval, blocking, at, storeDeps };
}
type World = ReturnType<typeof world>;

/** A source that answers `cards` for whoever asks, to stand in for a plan that is not built yet. */
function fakeSource(kind: HomeCard["kind"], cards: (caller: { developerId: string }) => Array<HomeCard & { blocksRunningSession?: true }>): HomeCardSource {
  const source: HomeCardSource = { kind, list: async (_deps, caller) => cards(caller) };
  unregister.push(registerHomeCardSource(source));
  return source;
}
const offer = (id: string, minute: number, extra: Partial<HomeCard> = {}): HomeCard => ({
  cardId: `offer:${id}`, kind: "offer", title: `Offer ${id}`, reason: "You may like this", at: iso(Date.parse("2026-10-22T06:00:00.000Z") + minute * 60_000),
  buttons: [{ label: "Try it", action: "start", href: `${CELL}/start/${id}`, method: "GET" }], ...extra,
});
const labels = (card: HomeCard) => card.buttons.map((button) => button.label);

describe("the shapes", () => {
  const card: HomeCard = {
    cardId: "approval:apr_aaaaaaaaaaaaaaaaaaaa", kind: "approval", title: "Create a Linear issue", reason: "Linear helper is waiting for you to approve: Create a Linear issue", sessionId: "ses_00000000000000000001",
    at: "2026-10-22T08:00:00.000Z", buttons: [{ label: "Open", action: "confirm", href: `${CELL}/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa`, method: "GET" }],
  };

  it("has a strict card and response with a reason, a total and buttons that carry their destination", () => {
    expect(HomeCardSchema.parse(card)).toEqual(card);
    expect(HomeResponseSchema.parse({ cards: [card], total: 14 })).toEqual({ cards: [card], total: 14 });
    expect(HomeCardSchema.safeParse({ ...card, extra: 1 }).success).toBe(false);
    expect(HomeCardSchema.safeParse({ ...card, reason: undefined }).success).toBe(false);
    expect(HomeCardSchema.safeParse({ ...card, reason: "r".repeat(HOME_REASON_MAX) }).success).toBe(true);
    expect(HomeCardSchema.safeParse({ ...card, reason: "r".repeat(HOME_REASON_MAX + 1) }).success).toBe(false);
    expect(HomeCardSchema.safeParse({ ...card, kind: "needs_you" }).success).toBe(false);
    expect(HomeCardSchema.safeParse({ ...card, cardId: "approval:" }).success).toBe(false);
    expect(HomeCardSchema.safeParse({ ...card, cardId: "failure:a b" }).success).toBe(false);
    expect(HomeCardSchema.safeParse({ ...card, buttons: Array.from({ length: HOME_CARD_BUTTONS_MAX + 1 }, () => card.buttons[0]) }).success).toBe(false);
    expect(HomeResponseSchema.safeParse({ cards: Array.from({ length: HOME_CARDS_MAX + 1 }, () => card), total: 11 }).success).toBe(false);
    expect(HomeResponseSchema.safeParse({ cards: [card] }).success).toBe(false);
    expect(HomeResponseSchema.safeParse({ cards: [], total: -1 }).success).toBe(false);
  });

  it("takes only a web address as a button's destination", () => {
    const withHref = (href: string) => HomeCardSchema.safeParse({ ...card, buttons: [{ label: "Open", action: "open", href, method: "GET" }] }).success;
    expect(withHref("https://example.com/s/ses_1")).toBe(true);
    expect(withHref("javascript:alert(1)")).toBe(false);
    expect(withHref("data:text/html,x")).toBe(false);
    expect(withHref("/relative")).toBe(false);
    expect(HomeCardSchema.safeParse({ ...card, buttons: [{ label: "Open", action: "open" }] }).success).toBe(true);
  });

  it("reads what a newer server adds, and a kind or an action it does not know as unknown", () => {
    const newer = HomeResponseReaderSchema.parse({ cards: [{ ...card, kind: "reminder", future: { a: 1 }, buttons: [{ label: "Snooze", action: "snooze", href: `${CELL}/x`, later: true }] }], total: 3, more: true });
    expect(newer.cards[0]).toMatchObject({ kind: "unknown", future: { a: 1 }, buttons: [{ action: "unknown", later: true }] });
    expect(HomeCardReaderSchema.safeParse({ ...card, title: undefined }).success).toBe(false);
  });

  it("has an answer to a dismissal, strict and readable, and names the kinds that can be dismissed", () => {
    expect(HomeDismissResponseSchema.parse({ cardId: "failure:ses_00000000000000000001", dismissed: true })).toEqual({ cardId: "failure:ses_00000000000000000001", dismissed: true });
    expect(HomeDismissResponseSchema.safeParse({ cardId: "failure:ses_00000000000000000001", dismissed: false }).success).toBe(false);
    expect(HomeDismissResponseReaderSchema.parse({ cardId: "failure:ses_00000000000000000001", dismissed: true, later: 1 })).toMatchObject({ later: 1 });
    expect([...HOME_DISMISSIBLE_KINDS]).toEqual(["failure", "offer"]);
    expect([...HOME_CARD_KINDS]).toEqual(["approval", "spend_request", "question", "plan", "pull_request", "failure", "offer"]);
    expect(HOME_DISMISS_DAYS).toBe(30);
  });

  it("keeps a person's dismissals in one partition of their own, per card", () => {
    expect(homeDismissedKey(ORG_A, PRIYA, "failure:ses_00000000000000000001")).toEqual({ pk: `ORG#${ORG_A}#HOME_DISMISSED#${PRIYA}`, sk: "failure:ses_00000000000000000001" });
    expect(() => homeDismissedKey(ORG_A, "a#b", "failure:x")).toThrow();
    expect(() => homeDismissedKey(ORG_A, PRIYA, "failure#x")).toThrow();
  });
});

describe("the ranking, the page and the total (the plan's fourteen cards)", () => {
  /** Priya's fourteen: two approvals that block a running session, two plans, two pull requests, two approvals that block nothing, four failures and two offers. */
  async function fourteen() {
    const w = world();
    const first = await w.blocking("apr_blocking1aaaaaaaaaaa", 10, { agent: { agentId: "agt_aaaaaaaaaaaaaaaaaaaa", name: "Linear helper" } });
    const second = await w.blocking("apr_blocking2aaaaaaaaaaa", 20, { agent: null });
    const plans = [w.plan({ minute: 31, title: "Plan A" }), w.plan({ minute: 30, title: "Plan B" })];
    const prs = [w.pullRequest({ minute: 41, title: "PR A" }), w.pullRequest({ minute: 40, title: "PR B" })];
    const changes = [await w.changeApproval(51), await w.changeApproval(50)];
    const failures = [4, 3, 2, 1].map((days) => w.failed({ endedAgoDays: days, title: `Failure ${String(days)}d`, minute: 60 + days }));
    fakeSource("offer", (who) => (who.developerId === PRIYA ? [offer("o2", 71), offer("o1", 70)] : []));
    return { w, first, second, plans, prs, changes, failures };
  }

  it("gives the first ten in ranking order and the total of all fourteen", async () => {
    const { w, first, second, plans, prs, changes, failures } = await fourteen();
    const answer = await w.home(PRIYA);
    expect(HomeResponseSchema.parse(answer)).toEqual(answer);
    expect(answer.total).toBe(14);
    expect(answer.cards.map((card) => card.cardId)).toEqual([
      "approval:apr_blocking1aaaaaaaaaaa", "approval:apr_blocking2aaaaaaaaaaa",
      `plan:${plans[1]!.sessionId}`, `plan:${plans[0]!.sessionId}`,
      `pull_request:${prs[1]!.sessionId}`, `pull_request:${prs[0]!.sessionId}`,
      `approval:${changes[1]!}`, `approval:${changes[0]!}`,
      `failure:${failures[0]!.sessionId}`, `failure:${failures[1]!.sessionId}`,
    ]);
    expect(answer.cards.map((card) => card.kind)).toEqual(["approval", "approval", "plan", "plan", "pull_request", "pull_request", "approval", "approval", "failure", "failure"]);
    expect(first.sessionId).toBeDefined();
    expect(second.sessionId).toBeDefined();
  });

  it("puts a question before a plan and an offer last, and the oldest first within a kind", async () => {
    const w = world();
    w.plan({ minute: 5, title: "Plan" });
    w.failed({ endedAgoDays: 2 });
    fakeSource("offer", () => [offer("late", 90), offer("early", 80)]);
    const question: HomeCard = { cardId: "question:q1", kind: "question", title: "Which database?", reason: "The agent asked you", at: iso(T0), buttons: [] };
    fakeSource("question", () => [question]);
    const cards = (await w.home(PRIYA)).cards;
    expect(cards.map((card) => card.kind)).toEqual(["question", "plan", "failure", "offer", "offer"]);
    expect(cards.filter((card) => card.kind === "offer").map((card) => card.cardId)).toEqual(["offer:early", "offer:late"]);
  });

  it("leaves a blocking approval first and names the agent from the write record, and An agent for a record from before names were stored", async () => {
    const { w } = await fourteen();
    const [one, two] = (await w.home(PRIYA)).cards;
    expect(one).toMatchObject({ cardId: "approval:apr_blocking1aaaaaaaaaaa", kind: "approval", title: "Create a Linear issue", reason: "Linear helper is waiting for you to approve: Create a Linear issue" });
    expect(two!.reason).toBe("An agent is waiting for you to approve: Create a Linear issue");
  });

  it("ranks an approval on a session that has ended with the approvals that block nothing", async () => {
    const w = world();
    await w.blocking("apr_endedsession1aaaaaaa", 1, { ended: true });
    w.plan({ minute: 50 });
    const kinds = (await w.home(PRIYA)).cards.map((card) => card.kind);
    expect(kinds).toEqual(["plan", "approval"]);
  });

  it("carries no ticket anywhere: every address is bare, and only a confirm button leads to an approval", async () => {
    const { w } = await fourteen();
    const answer = await w.home(PRIYA);
    const text = JSON.stringify(answer);
    expect(text).not.toMatch(/ticket/iu);
    for (const card of answer.cards) for (const button of card.buttons) if (button.href !== undefined) expect(button.href, `${card.cardId} ${button.label}`).not.toMatch(button.action === "dismiss" ? /#|\?(?!occurrence=[^&]+$)/u : /[?#]/u);
    expect(text).not.toContain("SECRET-ARGUMENT");
    for (const card of answer.cards.filter((entry) => entry.kind === "approval")) {
      expect(card.buttons.find((button) => button.href?.includes("/v1/app/approve/"))).toMatchObject({ label: "Open", action: "confirm", method: "GET" });
    }
  });

  it("makes the same few reads for 450 sessions as for 250: never one per session, with the cut logged", async () => {
    const small = world();
    for (let index = 0; index < 5; index += 1) small.failed({ minute: index + 1 });
    const reads = async (w: World) => {
      const before = w.db.commandNames().length;
      await w.home(PRIYA);
      return w.db.commandNames().slice(before);
    };
    const smallReads = await reads(small);
    const medium = world();
    for (let index = 0; index < 250; index += 1) medium.failed({ minute: index + 1 });
    const large = world();
    for (let index = 0; index < 450; index += 1) large.failed({ minute: index + 1 });
    const mediumReads = await reads(medium);
    const largeReads = await reads(large);
    expect(largeReads.length).toBe(mediumReads.length);
    expect(largeReads.length).toBeLessThan(400);
    expect(smallReads.length).toBeLessThan(largeReads.length);
    expect(large.logs.map((entry) => entry.event)).toContain("home.sessions_truncated");
    expect((await large.home(PRIYA)).cards).toHaveLength(HOME_CARDS_MAX);
    expect(JSON.stringify(large.logs)).not.toContain("Task ");
  });
});

describe("approval cards", () => {
  it("checks a fixed number of approvals however many are waiting", async () => {
    const reads = async (count: number) => {
      const w = world();
      const session = w.own({ owner: MAX });
      for (let index = 0; index < count; index += 1) await w.writeApproval({ id: `apr_${String(index).padStart(20, "0")}`, taskId: session.taskId, minute: index + 1, approvers: [ARJUN] });
      const before = w.db.commandNames().length;
      const answer = await w.home(ARJUN);
      return { total: answer.total, commands: w.db.commandNames().length - before };
    };
    const some = await reads(105);
    const more = await reads(140);
    // Listing reads one record each; Plan 3's decide check (several reads each) runs on a hundred of them at most.
    expect(more.commands - some.commands).toBeLessThanOrEqual(140 - 105);
    expect(more.total).toBe(100);
  });

  it("keeps the longest-waiting hundred when more are waiting, not the newest", async () => {
    const w = world();
    const session = w.own({ owner: MAX });
    for (let index = 0; index < 105; index += 1) await w.writeApproval({ id: `apr_${String(index).padStart(20, "0")}`, taskId: session.taskId, minute: index + 1, approvers: [ARJUN] });
    const shown = (await w.home(ARJUN)).cards.map((card) => card.cardId);
    expect(shown).toContain("approval:apr_00000000000000000000");
    expect(shown).not.toContain("approval:apr_00000000000000000104");
    expect((await w.home(ARJUN)).total).toBe(100);
  });

  it("shows an approval to the people who may decide it now, with the bare confirm link, and to nobody else", async () => {
    const w = world();
    const session = await w.blocking("apr_forarjunaaaaaaaaaaaa", 1, { approvers: [ARJUN, MIA] });
    const arjun = (await w.home(ARJUN)).cards;
    expect(arjun).toHaveLength(1);
    expect(arjun[0]).toMatchObject({ cardId: "approval:apr_forarjunaaaaaaaaaaaa", sessionId: session.sessionId });
    expect(arjun[0]!.buttons).toEqual([
      { label: "Open", action: "confirm", href: `${CELL}/v1/app/approve/apr_forarjunaaaaaaaaaaaa`, method: "GET" },
      { label: "Open session", action: "open", href: `${CELL}/s/${session.sessionId}`, method: "GET" },
    ]);
    // Mia is named, but a viewer of the project may not decide: no card, and no confirm link. Priya, Max (the run's owner), Ola (an org admin) and Zed are not approvers.
    for (const who of [MIA, PRIYA, MAX, OLA, ZED]) expect(await w.ids(who), who).toEqual([]);
  });

  it("reads the right to decide when it asks: a grant taken away removes the card", async () => {
    const w = world();
    await w.blocking("apr_revokedaaaaaaaaaaaaa", 1, { approvers: [ARJUN] });
    expect(await w.ids(ARJUN)).toEqual(["approval:apr_revokedaaaaaaaaaaaaa"]);
    w.members.revoke(ORG_A, "web", ARJUN);
    expect(await w.ids(ARJUN)).toEqual([]);
  });

  it("leaves out an approval that is decided or whose time has run out, although nothing has swept it yet", async () => {
    const w = world();
    const session = w.own({ owner: MAX });
    await w.writeApproval({ id: "apr_declinedaaaaaaaaaaaa", taskId: session.taskId, minute: 1, approvers: [ARJUN], status: "DECLINED" });
    await w.writeApproval({ id: "apr_lateaaaaaaaaaaaaaaaa", taskId: session.taskId, minute: 2, approvers: [ARJUN], expiresInDays: -1 });
    await w.writeApproval({ id: "apr_openaaaaaaaaaaaaaaaa", taskId: session.taskId, minute: 3, approvers: [ARJUN] });
    expect(await w.ids(ARJUN)).toEqual(["approval:apr_openaaaaaaaaaaaaaaaa"]);
  });

  it("gives a decider who may not view the session the approval and its link, but nothing of the session", async () => {
    const w = world();
    const session = await w.blocking("apr_noviewaaaaaaaaaaaaaa", 1, { approvers: [ARJUN], people: [{ developerId: ARJUN, role: "denied" }] });
    const [card] = (await w.home(ARJUN)).cards;
    expect(card).toMatchObject({ cardId: "approval:apr_noviewaaaaaaaaaaaaaa", kind: "approval" });
    expect(labels(card!)).toEqual(["Open"]);
    expect(card).not.toHaveProperty("sessionId");
    expect(JSON.stringify(card)).not.toContain(session.sessionId);
    expect(JSON.stringify(card)).not.toContain("Max's run");
    // It still blocks a running session, so it still ranks above a plan.
    expect(w.logs.filter((entry) => entry.event === "home.source_failed")).toEqual([]);
  });

  it("says what a pending change is by its title, and shows it to the people listed for it", async () => {
    const w = world();
    const id = await w.changeApproval(5, [PRIYA]);
    const [card] = (await w.home(PRIYA)).cards;
    expect(card).toMatchObject({ cardId: `approval:${id}`, kind: "approval", title: "Take over a session" });
    expect(card!.reason).toBe("A change is waiting for you to approve: Take over a session");
    expect(card!.buttons).toEqual([{ label: "Open", action: "confirm", href: `${CELL}/v1/app/approve/${id}`, method: "GET" }]);
    expect(await w.ids(ARJUN)).toEqual([]);
  });

  it("keeps a reason within its limit and free of control characters whatever the prompt says", async () => {
    const w = world();
    await w.blocking("apr_longaaaaaaaaaaaaaaaa", 1, { approvers: [ARJUN], summary: `Delete\u0007 the ${"very ".repeat(60)}important table`, agent: { agentId: "agt_aaaaaaaaaaaaaaaaaaaa", name: "Agent‮ name" } });
    const [card] = (await w.home(ARJUN)).cards;
    expect([...card!.reason].length).toBeLessThanOrEqual(HOME_REASON_MAX);
    expect(card!.reason).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(card!.reason.startsWith("Agent name is waiting for you to approve: Delete the very")).toBe(true);
  });

  it("shows Home without approval cards when the install has no approvals", async () => {
    const w = world();
    await w.blocking("apr_withoutaaaaaaaaaaaaa", 1, { approvers: [ARJUN] });
    w.plan({ minute: 2 });
    expect(await w.ids(ARJUN, ORG_A)).toHaveLength(1);
    const none = await w.home(ARJUN, ORG_A, { approvals: undefined } as never);
    expect(none).toEqual({ cards: [], total: 0 });
  });
});

describe("spend request cards", () => {
  /** An open request the org's admins decide (a month's top-up for the whole company), kept as Plan 3 keeps it. */
  function spendRequest(w: World, o: { id?: string; taskId?: string; status?: string; expiresInDays?: number; amountUsd?: number } = {}) {
    const spendRequestId = o.id ?? "spr_0123456789abcdefghij";
    const createdAt = w.at(15);
    w.db.set({
      ...spendRequestKey(ORG_A, spendRequestId), entityType: "SPEND_REQUEST", orgId: ORG_A, spendRequestId, kind: "owner_cap", amountUsd: o.amountUsd ?? 12.5, reason: "More please", requestedBy: { kind: "system" },
      approverRole: "org_admin", approverIds: [OLA], status: o.status ?? "PENDING", createdAt, expiresAt: iso(w.clock.now + (o.expiresInDays ?? 3) * DAY), ...(o.taskId === undefined ? {} : { taskId: o.taskId }),
    });
    w.db.set({ ...openSpendRequestsKey(ORG_A, createdAt, spendRequestId), entityType: "OPEN_SPEND_REQUEST", orgId: ORG_A, spendRequestId });
    return spendRequestId;
  }

  it("shows an open request to a person who may decide it, with a Decide button to the bare link", async () => {
    const w = world();
    const id = spendRequest(w);
    const ola = (await w.home(OLA)).cards;
    expect(ola).toHaveLength(1);
    expect(ola[0]).toMatchObject({ cardId: `spend_request:${id}`, kind: "spend_request", reason: "An agent owner's budget needs $12.5 more" });
    expect(ola[0]!.buttons).toEqual([{ label: "Decide", action: "confirm", href: `${CELL}/v1/app/approve/${id}`, method: "GET" }]);
    for (const who of [PRIYA, ARJUN, MAX, MIA]) expect(await w.ids(who), who).toEqual([]);
  });

  it("leaves out a request that is decided or out of time", async () => {
    const w = world();
    spendRequest(w, { id: "spr_decidedaaaaaaaaaaaa", status: "APPROVED" });
    spendRequest(w, { id: "spr_lateaaaaaaaaaaaaaaa", expiresInDays: -1 });
    expect(await w.ids(OLA)).toEqual([]);
  });

  it("names nothing of the session when the person who decides may not view it: the scope's words, no session, no link to it", async () => {
    const w = world();
    // A session with no project is seen by its owner and the people it is shared with: an org admin who decides the request does not see it.
    const hidden = w.own({ owner: MAX, title: "Secret plan", minute: 3, project: null });
    spendRequest(w, { taskId: hidden.taskId });
    const [card] = (await w.home(OLA)).cards;
    expect(card).toMatchObject({ kind: "spend_request", reason: "An agent owner's budget needs $12.5 more" });
    expect(card).not.toHaveProperty("sessionId");
    expect(labels(card!)).toEqual(["Decide"]);
    expect(JSON.stringify(card)).not.toContain("Secret plan");
    expect(JSON.stringify(card)).not.toContain(hidden.sessionId);
  });

  it("names the session when the request is for a task the person may view, and ranks it first only then", async () => {
    const w = world();
    const session = w.own({ owner: MAX, title: "Fix login", minute: 3 });
    const id = spendRequest(w, { taskId: session.taskId });
    const [card] = (await w.home(OLA)).cards;
    expect(card).toMatchObject({ cardId: `spend_request:${id}`, sessionId: session.sessionId, reason: "\"Fix login\" needs $12.5 more" });
    expect(labels(card!)).toEqual(["Decide", "Open session"]);
  });
});

describe("plan, pull request and failure cards", () => {
  it("shows a plan to review to the session's owner with the plan's words and a Review plan button", async () => {
    const w = world();
    const plan = w.plan({ title: "Bump the Stripe SDK" });
    const [card] = (await w.home(PRIYA)).cards;
    expect(card).toMatchObject({ cardId: `plan:${plan.sessionId}`, kind: "plan", title: "Bump the Stripe SDK", sessionId: plan.sessionId, reason: "Your plan for \"Bump the Stripe SDK\" is ready to review" });
    expect(card!.buttons).toEqual([{ label: "Review plan", action: "open", href: `${CELL}/s/${plan.sessionId}`, method: "GET" }]);
  });

  it("shows a pull request ready for review with a button to the pull request on GitHub", async () => {
    const w = world();
    const pr = w.pullRequest({ title: "Bump the Stripe SDK" });
    const [card] = (await w.home(PRIYA)).cards;
    expect(card).toMatchObject({ cardId: `pull_request:${pr.sessionId}`, kind: "pull_request", reason: "Your pull request for \"Bump the Stripe SDK\" is ready for review", sessionId: pr.sessionId });
    expect(card!.buttons).toEqual([{ label: "Open pull request", action: "open", href: PR_URL, method: "GET" }]);
  });

  it("offers only a web address on GitHub as the pull request's destination, and the session otherwise", async () => {
    for (const url of ["javascript:alert(1)", "http://github.com/acme/web/pull/7", "https://evil.example.com/acme/web/pull/7", "https://github.com.evil.example.com/pull/7", "https://user:secret@github.com/acme/web/pull/7", "https://github.com:8443/acme/web/pull/7", "not a url"]) {
      const w = world();
      const pr = w.pullRequest({ pullRequests: [{ repositoryId: "r1", number: 7, url, candidateDigest: sha("c"), required: true, state: "OPEN" }] });
      const [card] = (await w.home(PRIYA)).cards;
      expect(card!.buttons, url).toEqual([{ label: "Open session", action: "open", href: `${CELL}/s/${pr.sessionId}`, method: "GET" }]);
    }
  });

  it("offers a pull request's address without its search and hash", async () => {
    const w = world();
    const pr = w.pullRequest({ pullRequests: [{ repositoryId: "r1", number: 7, url: `${PR_URL}?token=SECRET-TOKEN#discussion_r1`, candidateDigest: sha("c"), required: true, state: "OPEN" }] });
    const [card] = (await w.home(PRIYA)).cards;
    expect(card!.buttons).toEqual([{ label: "Open pull request", action: "open", href: PR_URL, method: "GET" }]);
    expect(JSON.stringify(card)).not.toContain("SECRET-TOKEN");
    expect(card!.sessionId).toBe(pr.sessionId);
  });

  it("shows a plan or pull request only while the workflow waits at that stage", async () => {
    const w = world();
    w.own({ status: "needs_person", stage: "PLAN_REVIEW", state: "RUNNING" });
    w.own({ status: "needs_person", stage: "IMPLEMENT", state: "BLOCKED", workflowBlocked: true });
    w.own({ status: "waiting", stage: "WAIT_FOR_MERGE", state: "RUNNING" });
    w.own({ status: "running" });
    w.own({ status: "succeeded", endedAgoDays: 0, stage: "MERGED", state: "COMPLETE" });
    expect(await w.ids(PRIYA)).toEqual([]);
  });

  it("shows a failure with the words of what failed, and Open session, Retry and Dismiss with their destinations", async () => {
    const w = world();
    const session = w.failed({ title: "Fix the flaky test", step: "Failed: runtime_unavailable", project: "web" });
    const [card] = (await w.home(PRIYA)).cards;
    expect(card).toMatchObject({ cardId: `failure:${session.sessionId}`, kind: "failure", title: "Fix the flaky test", sessionId: session.sessionId, reason: "\"Fix the flaky test\" failed: runtime_unavailable" });
    expect(card!.buttons).toEqual([
      { label: "Open session", action: "open", href: `${CELL}/s/${session.sessionId}`, method: "GET" },
      { label: "Retry", action: "retry", href: `${CELL}/v1/app/sessions/${session.sessionId}/retry`, method: "POST" },
      { label: "Dismiss", action: "dismiss", href: `${CELL}/v1/app/home/cards/${encodeURIComponent(`failure:${session.sessionId}`)}/dismiss?occurrence=${encodeURIComponent(`ended:${(w.db.get(agentSessionKey(ORG_A, session.sessionId, "META")) as Item)["endedAt"] as string}`)}`, method: "POST" },
    ]);
  });

  it("cuts what failed to 120 characters", async () => {
    const w = world();
    w.failed({ step: `Failed: ${"x".repeat(150)}` });
    const [card] = (await w.home(PRIYA)).cards;
    const failure = card!.reason.slice(card!.reason.indexOf("failed: ") + "failed: ".length);
    expect([...failure].length).toBe(120);
    expect([...card!.reason].length).toBeLessThanOrEqual(HOME_REASON_MAX);
  });

  it("says what a failure without words is, and shows an open session whose last run failed", async () => {
    const w = world();
    const open = w.own({ status: "waiting", lastRunFailed: true, title: "Still going" });
    const [card] = (await w.home(PRIYA)).cards;
    expect(card).toMatchObject({ cardId: `failure:${open.sessionId}`, reason: "\"Still going\" failed: it did not finish" });
  });

  it("shows a failure for seven days from its end, and not a cancelled or finished session", async () => {
    const w = world();
    const recent = w.failed({ endedAgoDays: 6.9 });
    w.failed({ endedAgoDays: 7.1 });
    w.own({ status: "cancelled", endedAgoDays: 1 });
    w.own({ status: "succeeded", endedAgoDays: 1 });
    w.own({ status: "failed", lastRunFailed: true, endedAgoDays: 8 });
    expect(await w.ids(PRIYA)).toEqual([`failure:${recent.sessionId}`]);
  });

  it("offers no Retry for a plain task that failed: it is continued where it was started, so a retry would only refuse", async () => {
    const w = world();
    const plain = w.failed({ agent: false });
    const [card] = (await w.home(PRIYA)).cards;
    expect(card).toMatchObject({ cardId: `failure:${plain.sessionId}` });
    expect(labels(card!)).toEqual(["Open session", "Dismiss"]);
  });

  it("offers Retry for a workflow that is blocked, and for a chain run that failed", async () => {
    const w = world();
    const blocked = w.own({ status: "needs_person", lastRunFailed: true, stage: "IMPLEMENT", state: "BLOCKED", workflowBlocked: true });
    const chain = w.failed({ kind: "chain", project: "web" });
    const cards = (await w.home(PRIYA)).cards;
    expect(labels(cards.find((card) => card.cardId === `failure:${blocked.sessionId}`)!)).toContain("Retry");
    expect(labels(cards.find((card) => card.cardId === `failure:${chain.sessionId}`)!)).toContain("Retry");
  });

  it("offers Retry only to a person who may retry it: a project viewer who owns the session, and a Mac session, get none", async () => {
    const w = world();
    const mac = w.failed({ kind: "local", project: null, minute: 1 });
    const cloud = w.failed({ minute: 2 });
    let cards = (await w.home(PRIYA)).cards;
    expect(labels(cards.find((card) => card.cardId === `failure:${mac.sessionId}`)!)).toEqual(["Open session", "Dismiss"]);
    expect(labels(cards.find((card) => card.cardId === `failure:${cloud.sessionId}`)!)).toEqual(["Open session", "Retry", "Dismiss"]);
    w.grant(PRIYA, "web", "viewer");
    cards = (await w.home(PRIYA)).cards;
    expect(labels(cards.find((card) => card.cardId === `failure:${cloud.sessionId}`)!)).toEqual(["Open session", "Dismiss"]);
  });

  it("shows Priya's cards to Priya alone: not to Arjun, not to Max, not to an org admin", async () => {
    const w = world();
    w.plan({}); w.pullRequest({}); w.failed({});
    expect((await w.home(PRIYA)).total).toBe(3);
    for (const who of [ARJUN, MAX, OLA, MIA, ZED]) expect(await w.home(who), who).toEqual({ cards: [], total: 0 });
  });

  it("drops a card for a session the owner may no longer view", async () => {
    const w = world();
    w.plan({ people: [{ developerId: PRIYA, role: "denied" }] });
    w.failed({ people: [{ developerId: PRIYA, role: "denied" }] });
    w.plan({ minute: 9, title: "Still hers" });
    expect((await w.home(PRIYA)).cards.map((card) => card.title)).toEqual(["Still hers"]);
  });

  it("moves the plan card to Max once Max takes the session over (and off Priya)", async () => {
    const w = world();
    const plan = w.plan({ title: "Bump the Stripe SDK" });
    expect(await w.ids(PRIYA)).toEqual([`plan:${plan.sessionId}`]);
    // What a take-over writes: the task's new owner, and the session in the taker's list instead of the previous owner's.
    const task = w.db.get(taskKey(plan.taskId)) as Item;
    w.db.set({ ...task, currentOwner: { developerId: MAX, name: "Max", provider: "oidc", since: iso(T0) } });
    w.db.delete(mySessionsKey(ORG_A, PRIYA, plan.createdAt, plan.sessionId));
    w.db.set({ ...mySessionsKey(ORG_A, MAX, plan.createdAt, plan.sessionId), entityType: "MY_SESSION", orgId: ORG_A, sessionId: plan.sessionId, developerId: MAX, createdAt: plan.createdAt });
    expect(await w.ids(MAX)).toEqual([`plan:${plan.sessionId}`]);
    expect(await w.ids(PRIYA)).toEqual([]);
  });

  it("does not show a session in a list it is not owned from: a stale row of the previous owner's list gives them nothing", async () => {
    const w = world();
    const plan = w.plan({});
    const task = w.db.get(taskKey(plan.taskId)) as Item;
    w.db.set({ ...task, currentOwner: { developerId: MAX, name: "Max", provider: "oidc", since: iso(T0) } });
    // Priya's row was not moved yet.
    expect(await w.ids(PRIYA)).toEqual([]);
  });

  it("ignores another org's session, a row naming one, and a list row with no session behind it", async () => {
    const w = world();
    w.db.set({ ...mySessionsKey(ORG_A, PRIYA, w.at(1), "ses_88888888888888888888"), entityType: "MY_SESSION", orgId: ORG_A, sessionId: "ses_88888888888888888888", developerId: PRIYA, createdAt: w.at(1) });
    const other = w.failed({});
    const foreign = w.failed({ minute: 5 });
    w.db.set({ ...(w.db.get(agentSessionKey(ORG_A, foreign.sessionId, "META")) as Item), orgId: ORG_B });
    expect(await w.ids(PRIYA)).toEqual([`failure:${other.sessionId}`]);
    expect(JSON.stringify(w.logs)).not.toContain("Task ");
  });
});

describe("dismissing", () => {
  it("removes a failure for the person who dismissed it, answers the card, and keeps the dismissal for thirty days", async () => {
    const w = world();
    const first = w.failed({ minute: 1 });
    const second = w.failed({ minute: 2 });
    expect((await w.home(PRIYA)).total).toBe(2);
    const answer = await w.dismiss(PRIYA, `failure:${first.sessionId}`);
    expect(HomeDismissResponseReaderSchema.parse(answer)).toEqual({ cardId: `failure:${first.sessionId}`, dismissed: true });
    expect(await w.ids(PRIYA)).toEqual([`failure:${second.sessionId}`]);
    expect((await w.home(PRIYA)).total).toBe(1);
    expect(w.dismissed(PRIYA, `failure:${first.sessionId}`)).toMatchObject({ entityType: "HOME_DISMISSED", orgId: ORG_A, developerId: PRIYA, cardId: `failure:${first.sessionId}`, indexExpiresAt: Math.floor(T0 / 1000) + 30 * 86_400 });
  });

  it("is idempotent: a repeat answers the same and writes nothing, the first dismissal stands", async () => {
    const w = world();
    const failure = w.failed({});
    await w.dismiss(PRIYA, `failure:${failure.sessionId}`);
    const first = w.dismissed(PRIYA, `failure:${failure.sessionId}`);
    w.clock.now += 60_000;
    const writes = w.db.commandNames().filter((name) => name === "PutCommand" || name === "TransactWriteCommand").length;
    expect(await w.dismiss(PRIYA, `failure:${failure.sessionId}`)).toEqual({ cardId: `failure:${failure.sessionId}`, dismissed: true });
    expect(w.dismissed(PRIYA, `failure:${failure.sessionId}`)).toEqual(first);
    expect(w.db.commandNames().filter((name) => name === "PutCommand" || name === "TransactWriteCommand").length).toBe(writes);
  });

  it("is per person: another person's dismissal hides nothing from the owner, and writes nothing for a card that is not theirs", async () => {
    const w = world();
    const failure = w.failed({});
    expect(await w.dismiss(ARJUN, `failure:${failure.sessionId}`)).toEqual({ cardId: `failure:${failure.sessionId}`, dismissed: true });
    expect(await w.dismiss(MAX, `failure:${failure.sessionId}`)).toEqual({ cardId: `failure:${failure.sessionId}`, dismissed: true });
    expect(w.db.find((item) => item.entityType === "HOME_DISMISSED")).toEqual([]);
    expect(await w.ids(PRIYA)).toEqual([`failure:${failure.sessionId}`]);
  });

  it("does not let a dismissal row that names another org, or one that is not a card, hide anything", async () => {
    const w = world();
    const failure = w.failed({});
    const key = homeDismissedKey(ORG_A, PRIYA, `failure:${failure.sessionId}`);
    w.db.set({ ...key, entityType: "HOME_DISMISSED", orgId: ORG_B, developerId: PRIYA, cardId: `failure:${failure.sessionId}`, dismissedAt: iso(T0), indexExpiresAt: Math.floor(T0 / 1000) + 1000 });
    w.db.set({ ...homeDismissedKey(ORG_A, PRIYA, "junk"), entityType: "HOME_DISMISSED", orgId: ORG_A, developerId: PRIYA, cardId: "junk", dismissedAt: iso(T0) });
    expect(await w.ids(PRIYA)).toEqual([`failure:${failure.sessionId}`]);
  });

  it("is per org: a person of another org dismisses nothing here, and sees nothing of it", async () => {
    const w = world();
    const failure = w.failed({});
    expect(await w.dismiss(BO, `failure:${failure.sessionId}`, ORG_B)).toEqual({ cardId: `failure:${failure.sessionId}`, dismissed: true });
    expect(w.db.find((item) => item.entityType === "HOME_DISMISSED")).toEqual([]);
    expect(await w.home(BO, ORG_B)).toEqual({ cards: [], total: 0 });
    expect(await w.ids(PRIYA)).toEqual([`failure:${failure.sessionId}`]);
  });

  it("refuses to dismiss a card that goes away when it is done, with the exact words, and writes nothing", async () => {
    const w = world();
    const id = await w.changeApproval(1);
    const plan = w.plan({});
    const pr = w.pullRequest({});
    for (const cardId of [`approval:${id}`, `plan:${plan.sessionId}`, `pull_request:${pr.sessionId}`, "spend_request:spr_0123456789abcdefghij", "question:q1"]) {
      expect(await code(w.dismiss(PRIYA, cardId)), cardId).toEqual({ code: "CONFIG_INVALID", message: HOME_NOT_DISMISSIBLE });
    }
    expect(HOME_NOT_DISMISSIBLE).toBe("This card goes away when it's done.");
    expect(w.db.find((item) => item.entityType === "HOME_DISMISSED")).toEqual([]);
    expect((await w.home(PRIYA)).total).toBe(3);
  });

  it("refuses a card id that is not one, and a path that cannot be decoded", async () => {
    const w = world();
    for (const cardId of ["", "failure", "failure:", "failure:a b", "nonsense:ses_1", "failure:ses_1#2", `failure:${"x".repeat(200)}`]) {
      expect(await code(w.dismiss(PRIYA, cardId)), cardId).toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(await code(w.call("POST", "/v1/app/home/cards/%E0%A4%A/dismiss", PRIYA))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("answers a card that is no longer there as dismissed, without writing", async () => {
    const w = world();
    const gone = w.own({ status: "succeeded", endedAgoDays: 1 });
    expect(await w.dismiss(PRIYA, `failure:${gone.sessionId}`)).toEqual({ cardId: `failure:${gone.sessionId}`, dismissed: true });
    expect(await w.dismiss(PRIYA, "failure:ses_77777777777777777777")).toEqual({ cardId: "failure:ses_77777777777777777777", dismissed: true });
    expect(w.db.find((item) => item.entityType === "HOME_DISMISSED")).toEqual([]);
  });

  it("dismisses an offer of a source later plans register", async () => {
    const w = world();
    fakeSource("offer", () => [offer("o1", 1), offer("o2", 2)]);
    expect(await w.ids(PRIYA)).toEqual(["offer:o1", "offer:o2"]);
    await w.dismiss(PRIYA, "offer:o1");
    expect(await w.ids(PRIYA)).toEqual(["offer:o2"]);
    expect(await w.ids(ARJUN)).toEqual(["offer:o1", "offer:o2"]);
  });

  it("brings the card back once the dismissal has run out, although the table has not deleted it yet", async () => {
    const w = world();
    const open = w.own({ status: "waiting", lastRunFailed: true });
    await w.dismiss(PRIYA, `failure:${open.sessionId}`);
    expect(await w.ids(PRIYA)).toEqual([]);
    w.clock.now += 31 * DAY;
    const meta = w.db.get(agentSessionKey(ORG_A, open.sessionId, "META")) as Item;
    w.db.set({ ...meta, updatedAt: iso(w.clock.now - 60_000) });
    expect(await w.ids(PRIYA)).toEqual([`failure:${open.sessionId}`]);
  });

  it("shows a card again when the same session fails anew, and keeps it hidden while the same failure stands", async () => {
    const w = world();
    const open = w.own({ status: "waiting", lastRunFailed: true });
    const key = agentSessionKey(ORG_A, open.sessionId, "META");
    await w.dismiss(PRIYA, `failure:${open.sessionId}`);
    expect(await w.ids(PRIYA)).toEqual([]);
    // Nothing about the failure moved (a later touch of the record only): still hidden.
    w.db.set({ ...(w.db.get(key) as Item), updatedAt: iso(w.clock.now - 1000) });
    expect(await w.ids(PRIYA)).toEqual([]);
    // The run is retried and fails again: the summary moved on, so this is a new failure.
    const meta = w.db.get(key) as Item;
    w.db.set({ ...meta, summaryRevision: (meta["summaryRevision"] as number) + 2 });
    expect(await w.ids(PRIYA)).toEqual([`failure:${open.sessionId}`]);
    // Dismissing it again hides this occurrence and replaces the old row.
    await w.dismiss(PRIYA, `failure:${open.sessionId}`);
    expect(await w.ids(PRIYA)).toEqual([]);
    expect(w.db.find((item) => item.entityType === "HOME_DISMISSED")).toHaveLength(1);
  });

  it("shows an ended failure again when the session ended anew", async () => {
    const w = world();
    const failure = w.failed({ endedAgoDays: 3 });
    await w.dismiss(PRIYA, `failure:${failure.sessionId}`);
    expect(await w.ids(PRIYA)).toEqual([]);
    const key = agentSessionKey(ORG_A, failure.sessionId, "META");
    w.db.set({ ...(w.db.get(key) as Item), endedAt: iso(w.clock.now - DAY) });
    expect(await w.ids(PRIYA)).toEqual([`failure:${failure.sessionId}`]);
  });

  it("does not let a failure that happens between seeing the card and dismissing it be hidden unseen", async () => {
    const w = world();
    const open = w.own({ status: "waiting", lastRunFailed: true });
    const [card] = (await w.home(PRIYA)).cards;
    const dismissButton = card!.buttons.find((button) => button.action === "dismiss")!;
    const key = agentSessionKey(ORG_A, open.sessionId, "META");
    const meta = w.db.get(key) as Item;
    w.db.set({ ...meta, summaryRevision: (meta["summaryRevision"] as number) + 1 });
    const url = new URL(dismissButton.href!);
    expect(await w.call("POST", `${url.pathname}${url.search}`, PRIYA)).toEqual({ cardId: `failure:${open.sessionId}`, dismissed: true });
    expect(await w.ids(PRIYA)).toEqual([`failure:${open.sessionId}`]);
  });

  it("hides nothing for a dismissal row that names no occurrence, or another one", async () => {
    const w = world();
    const failure = w.failed({});
    const row = { ...homeDismissedKey(ORG_A, PRIYA, `failure:${failure.sessionId}`), entityType: "HOME_DISMISSED", orgId: ORG_A, developerId: PRIYA, cardId: `failure:${failure.sessionId}`, dismissedAt: iso(T0), indexExpiresAt: Math.floor(T0 / 1000) + 1000 };
    w.db.set(row);
    expect(await w.ids(PRIYA)).toEqual([`failure:${failure.sessionId}`]);
    w.db.set({ ...row, occurrence: "ended:2020-01-01T00:00:00.000Z" });
    expect(await w.ids(PRIYA)).toEqual([`failure:${failure.sessionId}`]);
  });

  it("shows an offer again when its source offers it anew (a later time)", async () => {
    const w = world();
    let minute = 1;
    fakeSource("offer", () => [offer("o1", minute)]);
    await w.dismiss(PRIYA, "offer:o1");
    expect(await w.ids(PRIYA)).toEqual([]);
    minute = 5;
    expect(await w.ids(PRIYA)).toEqual(["offer:o1"]);
  });

  it("logs when the person has more dismissals than are read", async () => {
    const w = world();
    for (let index = 0; index < 350; index += 1) {
      const cardId = `offer:old${String(index)}`;
      w.db.set({ ...homeDismissedKey(ORG_A, PRIYA, cardId), entityType: "HOME_DISMISSED", orgId: ORG_A, developerId: PRIYA, cardId, occurrence: "x", dismissedAt: iso(T0), indexExpiresAt: Math.floor(T0 / 1000) + 1000 });
    }
    await w.home(PRIYA);
    expect(w.logs.filter((entry) => entry.event === "home.dismissals_truncated")).toEqual([{ event: "home.dismissals_truncated" }]);
    const quiet = world();
    await quiet.home(PRIYA);
    expect(quiet.logs.map((entry) => entry.event)).not.toContain("home.dismissals_truncated");
  });

  it("offers the dismiss button's address as the route that dismisses it", async () => {
    const w = world();
    const failure = w.failed({});
    const [card] = (await w.home(PRIYA)).cards;
    const dismissButton = card!.buttons.find((button) => button.action === "dismiss")!;
    const path = new URL(dismissButton.href!).pathname;
    expect(await w.call(dismissButton.method!, path, PRIYA)).toEqual({ cardId: `failure:${failure.sessionId}`, dismissed: true });
    expect(await w.ids(PRIYA)).toEqual([]);
  });
});

describe("the sources", () => {
  it("leaves the other cards when one source throws, and logs it with fixed words and no message", async () => {
    const w = world();
    const plan = w.plan({});
    unregister.push(registerHomeCardSource({ kind: "offer", list: async () => { throw new Error("SECRET-DETAIL from a vendor"); } }));
    expect(await w.ids(PRIYA)).toEqual([`plan:${plan.sessionId}`]);
    expect(w.logs.filter((entry) => entry.event === "home.source_failed")).toEqual([{ event: "home.source_failed", source: "offer", reason: "error", error: "Error" }]);
    expect(JSON.stringify(w.logs)).not.toContain("SECRET-DETAIL");
  });

  it("skips a source that takes longer than its time and goes on without waiting for it", async () => {
    const w = world();
    const plan = w.plan({});
    unregister.push(registerHomeCardSource({ kind: "offer", list: () => new Promise(() => undefined) }));
    const started = Date.now();
    const answer = await w.home(PRIYA, ORG_A, { homeSourceTimeoutMs: 30 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(answer.cards.map((card) => card.cardId)).toEqual([`plan:${plan.sessionId}`]);
    expect(w.logs.filter((entry) => entry.event === "home.source_failed")).toEqual([{ event: "home.source_failed", source: "offer", reason: "timeout" }]);
  });

  it("drops a card a source built wrongly, or of a kind that is not its own, and logs it without the card", async () => {
    const w = world();
    unregister.push(registerHomeCardSource({
      kind: "offer",
      list: async () => [offer("good", 1), { ...offer("bad", 2), reason: "" }, { ...offer("worse", 3), cardId: "failure:ses_00000000000000000001", kind: "failure" }, { ...offer("wrongid", 5), cardId: "failure:ses_00000000000000000002" }, { ...offer("wrongkind", 6), kind: "failure" }, { ...offer("href", 4), buttons: [{ label: "x", action: "open", href: "javascript:alert(1)" }] }],
    }));
    expect(await w.ids(PRIYA)).toEqual(["offer:good"]);
    expect(w.logs.filter((entry) => entry.event === "home.card_invalid")).toHaveLength(5);
    expect(JSON.stringify(w.logs)).not.toContain("Offer bad");
  });

  it("shows a card once when two sources answer it, and cuts a source at its cap", async () => {
    const w = world();
    fakeSource("offer", () => [offer("same", 1)]);
    fakeSource("offer", () => [offer("same", 1), ...Array.from({ length: 120 }, (_, index) => offer(`more${String(index)}`, 5 + index))]);
    const answer = await w.home(PRIYA);
    expect(answer.total).toBe(100);
    expect(answer.cards.filter((card) => card.cardId === "offer:same")).toHaveLength(1);
    expect(w.logs.map((entry) => entry.event)).toContain("home.source_truncated");
  });

  it("gives a source the caller, and a source that is unregistered is not asked again", async () => {
    const w = world();
    const asked: string[] = [];
    unregister.push(registerHomeCardSource({ kind: "offer", list: async (_deps, caller) => { asked.push(caller.developerId); return []; } }));
    await w.home(ARJUN);
    const off = registerHomeCardSource({ kind: "offer", list: async () => [offer("x", 1)] });
    expect(await w.ids(PRIYA)).toEqual(["offer:x"]);
    off();
    expect(await w.ids(PRIYA)).toEqual([]);
    expect(asked).toEqual([ARJUN, PRIYA, PRIYA]);
  });

  it("asks no source of a person who is not in the org, and answers an empty Home", async () => {
    const w = world();
    const asked: string[] = [];
    unregister.push(registerHomeCardSource({ kind: "offer", list: async (_deps, caller) => { asked.push(caller.developerId); return [offer("x", 1)]; } }));
    const stranger = sha("8");
    expect(await w.home(stranger)).toEqual({ cards: [], total: 0 });
    expect(await w.home(BO, ORG_A)).toEqual({ cards: [], total: 0 });
    expect(asked).toEqual([]);
  });

  it("keeps the built-in sources when a test source is added, and answers an empty Home to someone with nothing", async () => {
    const w = world();
    expect(await w.home(PRIYA)).toEqual({ cards: [], total: 0 });
  });
});

describe("the routes", () => {
  it("answers GET /v1/app/home with a response the shared readers accept, and takes no other method", async () => {
    const w = world();
    w.failed({});
    const answer = await w.call("GET", "/v1/app/home", PRIYA);
    expect(HomeResponseSchema.parse(answer)).toEqual(answer);
    expect(HomeResponseReaderSchema.parse(answer)).toEqual(answer);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) expect(await code(w.call(method, "/v1/app/home", PRIYA)), method).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(w.call("GET", "/v1/app/home/cards/failure%3Ases_1/dismiss", PRIYA))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(w.call("POST", "/v1/app/home/cards", PRIYA))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(w.call("POST", "/v1/app/home/other", PRIYA))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("is a route of this module", () => {
    expect(isAgentSessionRoute("/v1/app/home")).toBe(true);
    expect(isAgentSessionRoute("/v1/app/home/cards/failure%3Ases_1/dismiss")).toBe(true);
    expect(isAgentSessionRoute("/v1/app/homes")).toBe(false);
  });
});

describe("Home retires the kinds decision cards carry (Decisions Q5)", () => {
  it("drops its own cards of the retired kinds only when the wiring says decision cards are mounted, and keeps every other kind", async () => {
    const w = world();
    fakeSource("offer", () => [offer("x", 1)]);
    fakeSource("plan", () => [{ cardId: "plan:ses_aaaaaaaaaaaaaaaaaaaa", kind: "plan", title: "A plan", reason: "Review it", at: iso(w.clock.now), buttons: [] }]);
    expect(await w.ids(PRIYA)).toEqual(expect.arrayContaining(["offer:x", "plan:ses_aaaaaaaaaaaaaaaaaaaa"]));
    const retired = (await w.home(PRIYA, ORG_A, { retiredHomeKinds: ["plan", "approval", "spend_request", "pull_request"] })).cards.map((card) => card.cardId);
    expect(retired).toContain("offer:x");
    expect(retired).not.toContain("plan:ses_aaaaaaaaaaaaaaaaaaaa");
  });
});

