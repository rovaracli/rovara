// v1.2 learning loop: `GET /v1/app/projects/{p}/learning` (design 6.2). Anyone who can see the project reads it; what is in it depends on who asks (live standing, never the sign-in), terminal
// suggestions carry no correction text, expired items are absent, the reads are bounded and the whole answer has a time limit.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_GUARDRAILS, LearningViewAnswerReaderSchema, LearningViewAnswerSchema, agentGuardrailsKey, agentXError, projectLearningKey,
} from "../../packages/contracts/src/index.js";
import { routeLearning } from "../../packages/broker/src/learning/routes.js";
import { dismissSuggestion } from "../../packages/broker/src/learning/decide.js";
import { viewLearning } from "../../packages/broker/src/learning/view.js";
import { groupCorrections } from "../../packages/broker/src/learning/grouping.js";
import type { LearningDecideDeps } from "../../packages/broker/src/learning/settle.js";
import { signatureOf } from "../../packages/broker/src/learning/similarity.js";
import { learningSalt } from "../../packages/broker/src/learning/standing.js";
import { captureCorrection } from "../../packages/broker/src/learning/store.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { ARJUN, MAX, MIA, OLA, ORG_A, PRIYA, ZED } from "../support/agent-session-world.js";
import { mergeWorld as baseWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";

const SCOPE = { orgId: ORG_A, project: "web", projectCreatedAt: "2026-10-02T00:00:00.000Z" };
const RETRY_A = "Use the shared retry helper for network calls, with exponential backoff.";
const RETRY_B = "Use the shared retry helper for network calls, with exponential backoff and jitter on every attempt.";
const DAY = 86_400_000;
const STRANGER = "1".repeat(64);
const ROLES: Record<string, "admin" | "member"> = { [OLA]: "admin" };

const callerOf = (w: MergeWorld, who: string) => ({ ...w.caller(who), orgRole: ROLES[who] ?? ("member" as const) });
function world(): MergeWorld {
  const w = baseWorld();
  const store = new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit });
  (w.deps as { store: AgentStore }).store = store;
  w.store = store;
  return w;
}
const projectFor = (w: MergeWorld) => async (caller: { orgId: typeof ORG_A; developerId: string }, rawName: string) => {
  const role = await w.members.roleOf(caller.orgId, rawName, { developerId: caller.developerId, orgRole: ROLES[caller.developerId] ?? "member" });
  if (role === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  return { name: rawName, role };
};
const viewDeps = (w: MergeWorld, overrides: Record<string, unknown> = {}) => ({ documentClient: w.db, tableName: "state", now: () => w.clock.now, projectFor: projectFor(w), ...overrides });
const learning = (w: MergeWorld) => ({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit });
const decideDeps = (w: MergeWorld): LearningDecideDeps => (({ ...learning(w), store: w.store, approvals: w.deps, projectFor: projectFor(w) }));
const view = (w: MergeWorld, who: string, overrides: Record<string, unknown> = {}, options?: { millis?: number }) => viewLearning(viewDeps(w, overrides), callerOf(w, who), "web", options);
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message }));

interface Source { author: string; task: string; text: string; source?: "comment" | "send_back" | "pr_comment" }
async function suggest(w: MergeWorld, sources: Source[] = [{ author: PRIYA, task: "t1", text: RETRY_A }, { author: ARJUN, task: "t2", text: RETRY_B }], stage = "build"): Promise<string> {
  for (const source of sources) {
    w.clock.now += 1000;
    const result = await captureCorrection(learning(w), SCOPE, {
      id: `c${randomUUID().slice(0, 8)}`, stage, source: source.source ?? "comment", sourceKey: `key-${randomUUID()}`, sourceRef: { taskId: source.task }, taskId: source.task, text: source.text,
      signature: [...signatureOf(source.text, learningSalt(SCOPE))], author: source.author, standing: "member", limit: "automatic",
    });
    expect(result).toMatchObject({ ok: true, created: true });
  }
  const grouped = await groupCorrections(learning(w), SCOPE, { prCaptureOff: async () => false });
  expect(grouped.opened).toHaveLength(1);
  return grouped.opened[0]!;
}
const put = (w: MergeWorld, sk: string, fields: Record<string, unknown>) => w.db.set({ ...projectLearningKey(ORG_A, "web", sk), orgId: ORG_A, projectCreatedAt: SCOPE.projectCreatedAt, ...fields });

describe("GET learning: the answer", () => {
  it("has exactly the contract's shape for a maintainer, with every member's text and the settings off by default", async () => {
    const w = world();
    const id = await suggest(w);
    const answer = await view(w, MAX);
    expect(LearningViewAnswerSchema.safeParse(answer).success).toBe(true);
    expect(LearningViewAnswerReaderSchema.safeParse({ ...answer, somethingNew: 1 }).success).toBe(true);
    expect(Object.keys(answer).sort()).toEqual(["canDecide", "dismissed", "rules", "settings", "skippedUnlinked", "suggestions"]);
    expect(answer.settings).toEqual({ prComments: "off", locked: false });
    expect(answer.canDecide).toBe(true);
    expect(answer.skippedUnlinked).toBe(0);
    expect(answer.dismissed).toEqual([]);
    expect(answer.rules).toEqual([]);
    expect(answer.suggestions).toHaveLength(1);
    const card = answer.suggestions[0]!;
    expect(card).toMatchObject({ id, stage: "build", status: "open", allFromOnePerson: false, lessSafe: false, lessSafeWords: [], overlaps: [], revision: 0 });
    expect(typeof card.proposedText).toBe("string");
    expect(card.sources.map((source) => source.label).sort()).toEqual([RETRY_A, RETRY_B].sort());
    expect(card.sources.map((source) => source.taskId).sort()).toEqual(["t1", "t2"]);
    for (const source of card.sources) expect(source).toEqual({ kind: "comment", taskId: source.taskId, label: source.label, at: expect.any(String) as string, standing: "member", href: `/review/${source.taskId}/task` });
    // No person is named: not in the sources, not anywhere.
    expect(JSON.stringify(answer)).not.toContain(PRIYA);
    expect(JSON.stringify(answer)).not.toContain(ARJUN);
  });

  it("says `all from one person` when every member is the same person, and still shows every member's text", async () => {
    const w = world();
    await suggest(w, [{ author: PRIYA, task: "t1", text: RETRY_A }, { author: PRIYA, task: "t2", text: RETRY_B }, { author: PRIYA, task: "t3", text: `${RETRY_A} Always.` }]);
    const card = (await view(w, MAX)).suggestions[0]!;
    expect(card.allFromOnePerson).toBe(true);
    expect(card.sources).toHaveLength(3);
    expect(card.sources.every((source) => source.label.length > 0)).toBe(true);
  });

  it("lists active and waiting rules, not the ones that were removed or never applied", async () => {
    const w = world();
    const rule = (id: string, status: string, extra: Record<string, unknown> = {}) => put(w, `RULE#${id}`, { entityType: "LEARNING_RULE", id, suggestionId: `s-${id}`, stage: "build", text: `Rule ${id} words.`, processAgentId: "agt_1", requestId: randomUUID(), status, ...extra });
    rule("r1", "active", { processVersion: 3 });
    rule("r2", "awaiting_approval");
    rule("r3", "pending");
    rule("r4", "removed", { processVersion: 4 });
    rule("r5", "not_applied");
    const answer = await view(w, MAX);
    expect(answer.rules.map((entry) => entry.id).sort()).toEqual(["r1", "r2", "r3"]);
    expect(answer.rules.find((entry) => entry.id === "r1")).toEqual({ id: "r1", stage: "build", text: "Rule r1 words.", status: "active", processVersion: 3 });
    expect(LearningViewAnswerSchema.safeParse(answer).success).toBe(true);
  });

  it("is read-only: it writes nothing", async () => {
    const w = world();
    await suggest(w);
    const before = JSON.stringify(w.db.find(() => true));
    await view(w, MAX);
    expect(JSON.stringify(w.db.find(() => true))).toBe(before);
  });

  it("does not show another project instance's items", async () => {
    const w = world();
    put(w, "RULE#old", { entityType: "LEARNING_RULE", id: "old", suggestionId: "s", stage: "build", text: "Old project rule.", processAgentId: "agt_1", requestId: randomUUID(), status: "active", projectCreatedAt: "2026-01-01T00:00:00.000Z" });
    expect((await view(w, MAX)).rules).toEqual([]);
  });
});

describe("GET learning: who reads, and what they get", () => {
  it("refuses a person who cannot see the project, with the one `not found`", async () => {
    const w = world();
    await suggest(w);
    expect(await failure(view(w, STRANGER))).toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("gives a contributor the cards with canDecide false, and an org admin canDecide true", async () => {
    const w = world();
    await suggest(w);
    const contributor = await view(w, PRIYA);
    expect(contributor.canDecide).toBe(false);
    expect(contributor.suggestions[0]!.sources.map((source) => source.label).sort()).toEqual([RETRY_A, RETRY_B].sort());
    expect((await view(w, OLA)).canDecide).toBe(true);
  });

  it("gives a viewer the list but no correction text, and canDecide false", async () => {
    const w = world();
    await suggest(w);
    const answer = await view(w, MIA);
    expect(answer.canDecide).toBe(false);
    expect(answer.suggestions).toHaveLength(1);
    expect(JSON.stringify(answer)).not.toContain("retry helper");
    expect(answer.suggestions[0]!.proposedText).toBeUndefined();
    expect(answer.suggestions[0]!.sources).toHaveLength(2);
    expect(LearningViewAnswerSchema.safeParse(answer).success).toBe(true);
  });

  it("reads standing live: a person the project role calls a maintainer but who holds no grant (a stale sign-in, a Slack-only person) is an outsider", async () => {
    const w = world();
    await suggest(w);
    const answer = await view(w, ZED, { projectFor: async () => ({ name: "web", role: "maintainer" }) });
    expect(answer.canDecide).toBe(false);
    expect(JSON.stringify(answer)).not.toContain("retry helper");
  });

  it("answers `not found` when the project has no META or is archived", async () => {
    const w = world();
    expect(await failure(viewLearning(viewDeps(w, { projectFor: async () => ({ name: "ghost", role: "maintainer" }) }) as never, callerOf(w, MAX), "ghost"))).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("GET learning: terminal text and expiry", () => {
  it("never shows text of a terminal suggestion or a dismissed one, whatever is still stored on it, and lists the dismissed pattern", async () => {
    const w = world();
    const id = await suggest(w);
    await dismissSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, { expectedRevision: 0, dismissKind: "one_off", note: "SECRET-NOTE-WORDS" });
    // A stray text left on terminal items by a bad writer must not reach the answer either.
    put(w, "SUGGESTION#stray", {
      entityType: "LEARNING_SUGGESTION", id: "stray", stage: "plan", status: "accepted", correctionIds: ["a", "b"], allFromOnePerson: false, proposedText: "STRAY-PROPOSED-TEXT", dismissNote: "STRAY-NOTE",
      signature: ["h"], lessSafe: false, kinds: [], overlaps: [], revision: 3, createdAt: "2026-10-03T00:00:00.000Z", terminalAt: "2026-10-04T00:00:00.000Z", indexExpiresAt: Math.floor(w.clock.now / 1000) + 86_400,
    });
    for (const who of [MAX, OLA, PRIYA, MIA]) {
      const answer = await view(w, who);
      const text = JSON.stringify(answer);
      for (const secret of ["SECRET-NOTE-WORDS", "STRAY-PROPOSED-TEXT", "STRAY-NOTE", "retry helper"]) expect(text, `${who} ${secret}`).not.toContain(secret);
      expect(answer.suggestions).toEqual([]);
      expect(answer.dismissed).toEqual([{ id: expect.stringMatching(/^[a-f0-9]{32}$/) as string, stage: "build", dismissedAt: expect.any(String) as string, dismissKind: "one_off" }]);
      expect(LearningViewAnswerSchema.safeParse(answer).success).toBe(true);
    }
  });

  it("treats an expired item as absent: a dismissed pattern past its 180 days, and a source whose correction expired", async () => {
    const w = world();
    const id = await suggest(w);
    const second = await suggest(w, [{ author: PRIYA, task: "t8", text: "Name database migrations with the date prefix and a short description." }, { author: ARJUN, task: "t9", text: "Database migrations need a date prefix in the name and a short description." }], "plan");
    await dismissSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, { expectedRevision: 0, dismissKind: "wrong" });
    expect((await view(w, MAX)).dismissed).toHaveLength(1);
    w.clock.now += 181 * DAY;
    const answer = await view(w, MAX);
    expect(answer.dismissed).toEqual([]);
    // The open suggestion has no expiry of its own; its corrections do, and an expired one is not a source.
    expect(answer.suggestions.map((card) => card.id)).toEqual([second]);
    expect(answer.suggestions[0]!.sources).toEqual([]);
  });
});

describe("GET learning: bounded reads", () => {
  it("returns at most 200 dismissed patterns and says it cut the list", async () => {
    const w = world();
    for (let n = 0; n < 230; n += 1) {
      const key = n.toString(16).padStart(32, "0");
      put(w, `DISMISSED#${key}`, { entityType: "LEARNING_DISMISSED", signature: ["h"], suggestionId: `d${String(n)}`, dismissedAt: new Date(w.clock.now - n * 1000).toISOString(), indexExpiresAt: Math.floor(w.clock.now / 1000) + 86_400 });
      put(w, `SUGGESTION#d${String(n)}`, {
        entityType: "LEARNING_SUGGESTION", id: `d${String(n)}`, stage: "build", status: "dismissed", dismissKind: "wrong", correctionIds: ["a", "b"], allFromOnePerson: false, signature: ["h"], lessSafe: false, kinds: [],
        overlaps: [], revision: 1, createdAt: "2026-10-03T00:00:00.000Z", terminalAt: "2026-10-04T00:00:00.000Z", indexExpiresAt: Math.floor(w.clock.now / 1000) + 86_400,
      });
    }
    const answer = await view(w, MAX);
    expect(answer.dismissed).toHaveLength(200);
    expect(answer.truncated).toEqual(["dismissed"]);
    expect(LearningViewAnswerSchema.safeParse(answer).success).toBe(true);
    // Newest first.
    const times = answer.dismissed.map((entry) => entry.dismissedAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("gives up with one plain error when the table does not answer within the time limit", async () => {
    const w = world();
    await suggest(w);
    const send = w.db.send.bind(w.db);
    const slow = { ...w.db, send: (command: { constructor: { name: string } }) => (command.constructor.name === "QueryCommand" ? new Promise(() => undefined) : send(command as never)) };
    const started = Date.now();
    expect(await failure(view(w, MAX, { documentClient: slow }, { millis: 60 }))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("GET learning: the settings block", () => {
  const lock = (w: MergeWorld, value: "allowed" | "locked_off") => w.db.set({ ...agentGuardrailsKey(ORG_A), entityType: "AGENT_GUARDRAILS", revision: 1, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, prCommentLearning: value } });

  it("reports the project's own setting when there is one", async () => {
    const w = world();
    put(w, "SETTINGS", { entityType: "LEARNING_SETTINGS", revision: 2, prComments: "on", changedBy: MAX, changedAt: "2026-10-05T00:00:00.000Z" });
    expect((await view(w, MAX)).settings).toEqual({ prComments: "on", locked: false, revision: 2 });
  });

  it("reports off and locked by the company when the guardrails lock PR-comment learning off, whatever the project says", async () => {
    const w = world();
    put(w, "SETTINGS", { entityType: "LEARNING_SETTINGS", revision: 2, prComments: "on", changedBy: MAX, changedAt: "2026-10-05T00:00:00.000Z" });
    lock(w, "locked_off");
    expect((await view(w, MAX)).settings).toMatchObject({ prComments: "off", locked: true, lockedBy: "company" });
    lock(w, "allowed");
    expect((await view(w, MAX)).settings).toMatchObject({ prComments: "on", locked: false });
  });

  it("shows a pending proposal's id", async () => {
    const w = world();
    put(w, "SETTINGS", { entityType: "LEARNING_SETTINGS", revision: 1, prComments: "off", changedBy: MAX, changedAt: "2026-10-05T00:00:00.000Z", pendingProposalId: "prop-1" });
    expect((await view(w, MAX)).settings.pendingProposal).toEqual({ id: "prop-1" });
  });
});

describe("GET learning: the route", () => {
  const routed = (w: MergeWorld, who: string, method: string, path: string) =>
    routeLearning({ task: { documentClient: w.db, tableName: "state", now: () => w.clock.now } as never, projectFor: projectFor(w) }, callerOf(w, who), method, new URL(`https://cell.example.com${path}`), () => ({}));

  it("answers the view for GET on the learning path, and leaves other methods and other paths to their own handlers", async () => {
    const w = world();
    await suggest(w);
    const answer = await routed(w, MAX, "GET", "/v1/app/projects/web/learning");
    expect(LearningViewAnswerSchema.safeParse(answer).success).toBe(true);
    expect(await routed(w, MAX, "POST", "/v1/app/projects/web/learning")).toBeUndefined();
    expect(await routed(w, MAX, "GET", "/v1/app/projects/web/learning/other")).toBeUndefined();
  });

  it("refuses the stranger through the route as well", async () => {
    const w = world();
    expect(await failure(routed(w, STRANGER, "GET", "/v1/app/projects/web/learning") as Promise<unknown>)).toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });
});
