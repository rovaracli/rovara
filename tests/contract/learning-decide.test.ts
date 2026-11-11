// v1.2 learning loop, B6: Accept, Dismiss, Reopen, Remove and settlement (design 5, 7.1 I6-I8, 9.2 B6). The world is the Rovara Code merge world: a real agent store, real approvals and a
// real audit capture, with the learning partition in the same table. Publishing goes through `publishDraft`, as the How-we-work route does; these tests check what the published
// versions, the approvals and the learning records say afterwards.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearningAcceptAnswerSchema, LearningDismissAnswerSchema, agentXError, approvalKey, orgLearningSettingsKey, projectLearningKey, projectMemberKey, type AgentId } from "@rovara-code/contracts";
import { orgMemberKey, orgMetaKey } from "@agentx/cloud-contracts";
import { decideApproval, getAnyApproval } from "../../packages/broker/src/agents/approvals.js";
import { publishDraft } from "../../packages/broker/src/agents/changes.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { wholeAgentLayers } from "../../packages/broker/src/playbook/process-reviewers.js";
import { resolveRecipe } from "../../packages/broker/src/agents/changes.js";
import { postProjectProcess } from "../../packages/broker/src/playbook/process-layer.js";
import { acceptRequestId, acceptSuggestion, appendRuleToOverlay, dismissSuggestion, removeRule, removeRuleFromOverlay, reopenDismissed } from "../../packages/broker/src/learning/decide.js";
import { routeLearning } from "../../packages/broker/src/learning/routes.js";
import { StatusReply } from "../../packages/broker/src/aws/status-reply.js";
import { eraseLearningSubject, learningWalkDeps, resumeOpenLearningWalks } from "../../packages/broker/src/learning/cleanup.js";
import { readBrokerSource } from "../support/broker-source.js";
import { viewLearning } from "../../packages/broker/src/learning/view.js";
import { forgetCorrection, groupCorrections } from "../../packages/broker/src/learning/grouping.js";
import { learningSettler, settleProject } from "../../packages/broker/src/learning/settle.js";
import type { LearningDecideDeps } from "../../packages/broker/src/learning/settle.js";
import { signatureOf } from "../../packages/broker/src/learning/similarity.js";
import { learningSalt } from "../../packages/broker/src/learning/standing.js";
import { captureCorrection } from "../../packages/broker/src/learning/store.js";
import { ARJUN, MAX, MIA, OLA, ORG_A, PRIYA } from "../support/agent-session-world.js";
import { mergeWorld as baseWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";

afterEach(() => { vi.unstubAllEnvs(); });

const SCOPE = { orgId: ORG_A, project: "web", projectCreatedAt: "2026-10-02T00:00:00.000Z" };
const RETRY_A = "Use the shared retry helper for network calls, with exponential backoff.";
const RETRY_B = "Use the shared retry helper for network calls, with exponential backoff and jitter on every attempt.";
const RULE = "Use the shared retry helper for network calls.";
const ROLES: Record<string, "admin" | "member"> = { [OLA]: "admin" };

const callerOf = (w: MergeWorld, who: string) => ({ ...w.caller(who), orgRole: ROLES[who] ?? ("member" as const) });
function world(): MergeWorld {
  const w = baseWorld();
  const store = new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit });
  (w.deps as { store: AgentStore }).store = store;
  w.store = store;
  w.db.set({ ...orgMetaKey(ORG_A), orgId: ORG_A, createdAt: "2026-10-01T00:00:00.000Z" });
  return w;
}
function decideDeps(w: MergeWorld, overrides: Partial<LearningDecideDeps> = {}): LearningDecideDeps {
  return {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, store: w.store, audit: w.audit.audit, approvals: w.deps,
    projectFor: async (caller, rawName) => {
      const role = await w.members.roleOf(caller.orgId, rawName, { developerId: caller.developerId, orgRole: ROLES[caller.developerId] ?? "member" });
      if (role === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
      return { name: rawName, role };
    },
    ...overrides,
  };
}
const learning = (w: MergeWorld) => ({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit });
const item = (w: MergeWorld, sk: string) => w.db.get(projectLearningKey(ORG_A, "web", sk)) as Record<string, unknown> | undefined;
const suggestionOf = (w: MergeWorld, id: string) => item(w, `SUGGESTION#${id}`)!;
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message }));

/** A process layer for web with its first version published (an empty overlay unless `overlay` is given). */
async function processLayer(w: MergeWorld, overlay: Record<string, unknown> = {}): Promise<AgentId> {
  const { agentId } = await postProjectProcess(decideDeps(w), callerOf(w, MAX), "web");
  if (Object.keys(overlay).length > 0) await setDraft(w, agentId, overlay);
  const agent = (await w.store.get(ORG_A, agentId))!;
  expect(await publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision })).toMatchObject({ applied: true });
  return agentId;
}
async function setDraft(w: MergeWorld, agentId: AgentId, overlay: Record<string, unknown>, by = MAX) {
  const agent = (await w.store.get(ORG_A, agentId))!;
  await w.store.saveDraft({ orgId: ORG_A, agentId, overlay: overlay, expectedRevision: agent.draftRevision, by });
}
const overlayOf = async (w: MergeWorld, agentId: AgentId, version: number) => (await w.store.getVersion(ORG_A, agentId, version))!.overlay;

interface SuggestOptions { stage?: string; sources?: Array<{ author: string; task: string; text?: string; source?: "comment" | "send_back" | "pr_comment" }> }
/** Captures the corrections the way B3/B4 do and lets grouping open the suggestion. Returns its id. */
async function suggest(w: MergeWorld, options: SuggestOptions = {}): Promise<string> {
  const sources = options.sources ?? [{ author: PRIYA, task: "t1", text: RETRY_A }, { author: ARJUN, task: "t2", text: RETRY_B }];
  let n = 0;
  for (const source of sources) {
    n += 1;
    w.clock.now += 1000;
    const text = source.text ?? RETRY_A;
    const kind = source.source ?? "comment";
    const result = await captureCorrection(learning(w), SCOPE, {
      id: `c${randomUUID().slice(0, 8)}${n}`, stage: (options.stage ?? "build"), source: kind, sourceKey: `key-${randomUUID()}`, sourceRef: { taskId: source.task }, taskId: source.task, text,
      signature: [...signatureOf(text, learningSalt(SCOPE))], author: source.author, standing: "member", limit: kind === "pr_comment" ? "automatic_pr" : "automatic",
    });
    expect(result).toMatchObject({ ok: true, created: true });
  }
  const grouped = await groupCorrections(learning(w), SCOPE, { prCaptureOff: async () => false });
  expect(grouped.opened).toHaveLength(1);
  return grouped.opened[0]!;
}
const acceptBody = (w: MergeWorld, id: string, text = RULE, stage?: string) => ({ requestId: randomUUID(), expectedRevision: suggestionOf(w, id).revision, stage: stage ?? suggestionOf(w, id).stage, text });
const approvalIdOf = (w: MergeWorld, answer: { outcome: string; confirmUrl?: string }) => w.approvalIdOf(answer.confirmUrl!);
const decide = (w: MergeWorld, who: string, approvalId: string, decision: "APPROVE" | "DECLINE" = "APPROVE") => decideApproval(w.deps, callerOf(w, who), approvalId, { requestId: randomUUID(), decision });
const setApprovalStatus = (w: MergeWorld, approvalId: string, status: string) => {
  const record = w.db.get(approvalKey(ORG_A, approvalId))!;
  w.db.set({ ...record, status });
};
const eventsOf = (w: MergeWorld, action: Parameters<MergeWorld["audit"]["recordedBy"]>[0]) => w.audit.recordedBy(action);

describe("Accept builds from the published overlay and publishes through publishDraft (I6)", () => {
  it("adds the rule as its own paragraph of one stage's instructions, and changes nothing else in the published version", async () => {
    const w = world();
    const layer = await processLayer(w, { steps: { build: { instructions: "Run the linter before you finish." }, plan: { instructions: "Keep plans short." } } });
    const id = await suggest(w);
    const answer = await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id));
    expect(answer).toEqual({ outcome: "published", version: 2 });
    expect(await overlayOf(w, layer, 2)).toEqual({ steps: { build: { instructions: `Run the linter before you finish.\n\n${RULE}` }, plan: { instructions: "Keep plans short." } } });
    expect((await w.store.getVersion(ORG_A, layer, 2))!.note).toMatch(/^Suggested rule /);
    expect(item(w, `SUGGESTION#${id}`)).toMatchObject({ status: "accepted", decidedBy: MAX });
    expect(item(w, `RULE#${suggestionOf(w, id).ruleId as string}`)).toMatchObject({ status: "active", processVersion: 2, text: RULE, stage: "build", processAgentId: layer });
  });

  it("first writes the rule into an empty stage; a project-wide rule goes to `instructions`", async () => {
    const w = world();
    const layer = await processLayer(w);
    const id = await suggest(w, { stage: "*" });
    await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id));
    expect(await overlayOf(w, layer, 2)).toEqual({ instructions: RULE });
  });

  it("never publishes someone else's unpublished draft: it refuses, and the draft and the suggestion are untouched", async () => {
    const w = world();
    const layer = await processLayer(w);
    await setDraft(w, layer, { steps: { build: { instructions: "Another person's work in progress." } } }, ARJUN);
    const id = await suggest(w);
    const draftBefore = await w.store.getDraft(ORG_A, layer);
    expect(await failure(acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id)))).toMatchObject({ code: "LEARNING_LAYER_BUSY", message: expect.stringContaining("unpublished changes") as unknown });
    expect(await w.store.getDraft(ORG_A, layer)).toEqual(draftBefore);
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(1);
    expect(suggestionOf(w, id)).toMatchObject({ status: "open", revision: 0 });
    expect(w.db.find((entry) => String(entry.sk).startsWith("RULE#"))).toEqual([]);
  });

  it("is busy while another publish waits for a person, and a second suggestion cannot slip in", async () => {
    const w = world();
    await processLayer(w);
    const first = await suggest(w, { stage: "review" });
    const waiting = await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", first, acceptBody(w, first));
    expect(waiting.outcome).toBe("awaiting_approval");
    const second = await suggest(w, { stage: "build", sources: [{ author: PRIYA, task: "t8", text: "Name database migrations with the date prefix and a short description." }, { author: ARJUN, task: "t9", text: "Database migrations need a date prefix in the name and a short description." }] });
    expect(await failure(acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", second, acceptBody(w, second, "Prefix migrations with the date.")))).toMatchObject({ code: "LEARNING_LAYER_BUSY" });
  });

  it("checks the 4,000-character limit of the resulting stage text before writing anything", async () => {
    const w = world();
    const layer = await processLayer(w, { steps: { build: { instructions: "x".repeat(3_990) } } });
    const id = await suggest(w);
    const draftBefore = await w.store.getDraft(ORG_A, layer);
    expect(await failure(acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id)))).toMatchObject({ code: "LEARNING_RULES_FULL", message: expect.stringContaining("rules are full") as unknown });
    expect(await w.store.getDraft(ORG_A, layer)).toEqual(draftBefore);
    expect(suggestionOf(w, id)).toMatchObject({ status: "open", revision: 0 });
    expect(w.db.find((entry) => String(entry.sk).startsWith("RULE#"))).toEqual([]);
  });

  it("uses the edited text (inert, one paragraph), and says the rule was edited", async () => {
    const w = world();
    const layer = await processLayer(w);
    const id = await suggest(w);
    await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id, "  Use the retry​ helper.\n\n\nAlways.  "));
    expect(await overlayOf(w, layer, 2)).toEqual({ steps: { build: { instructions: "Use the retry helper.\nAlways." } } });
    expect(eventsOf(w, "rule.accepted").at(-1)).toMatchObject({ facts: { edited: true, outcome: "published" } });
  });

  it("refuses a body that names another stage, a stale revision, and fields it does not take", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w);
    expect(await failure(acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id, RULE, "review")))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await failure(acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, { ...acceptBody(w, id), expectedRevision: 5 }))).toMatchObject({ code: "AGENT_REVISION_CONFLICT", message: expect.stringContaining("This suggestion changed. Refresh the page and try again.") as unknown });
    expect(await failure(acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, { ...acceptBody(w, id), standing: "member" }))).toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("I8: a project-wide rule never reaches a reviewing stage", () => {
  it("is written to the whole-agent instructions, which the plan check, review and pull request stages are not given", async () => {
    const w = world();
    const layer = await processLayer(w);
    const id = await suggest(w, { stage: "*" });
    await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id));
    const recipe = await resolveRecipe(w.deps, ORG_A, layer, 2);
    const stepOf = (kind: string) => recipe.steps.find((step) => step.kind === kind);
    const text = (layers: Array<{ text?: string; instructions?: string }>) => JSON.stringify(layers);
    expect(text(wholeAgentLayers(recipe, stepOf("build")) as never)).toContain(RULE);
    for (const kind of ["review", "pull_request"]) expect(stepOf(kind)).toBeDefined();
    for (const kind of ["review", "pull_request"]) expect(text(wholeAgentLayers(recipe, stepOf(kind)) as never)).not.toContain(RULE);
  });
});

describe("I7: a rule for a reviewing stage waits for a second person, through the ordinary How-we-work approval", () => {
  it("answers awaiting_approval with the confirmation link, and the requester cannot confirm it while another approver exists", async () => {
    const w = world();
    const layer = await processLayer(w);
    const id = await suggest(w, { stage: "review" });
    const answer = await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id));
    expect(answer.outcome).toBe("awaiting_approval");
    // Like a hand publish, a waiting answer always carries the list of changes (possibly empty), and it is the contract's answer.
    expect(Array.isArray((answer as { changes?: unknown }).changes)).toBe(true);
    expect(LearningAcceptAnswerSchema.safeParse(answer).success).toBe(true);
    const approvalId = approvalIdOf(w, answer);
    const ruleId = suggestionOf(w, id).ruleId as string;
    expect(item(w, `RULE#${ruleId}`)).toMatchObject({ status: "awaiting_approval", approvalId });
    expect(suggestionOf(w, id)).toMatchObject({ status: "awaiting_approval" });
    expect(eventsOf(w, "rule.accepted").at(-1)).toMatchObject({ facts: { outcome: "awaiting_approval", approvalId, lessSafe: true } });
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(1);
    expect(await failure(decide(w, MAX, approvalId))).toMatchObject({ code: "PROCESS_SELF_CONFIRM" });
    expect((await getAnyApproval(w.deps, ORG_A, approvalId))!.status).toBe("PENDING");
  });

  it("applies when another maintainer confirms; settlement then makes the rule active and the suggestion accepted", async () => {
    const w = world();
    const layer = await processLayer(w);
    const id = await suggest(w, { stage: "review" });
    const answer = await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id));
    await decide(w, OLA, approvalIdOf(w, answer));
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(2);
    expect(await settleProject(decideDeps(w), SCOPE)).toBe(1);
    expect(item(w, `RULE#${suggestionOf(w, id).ruleId as string}`)).toMatchObject({ status: "active", processVersion: 2 });
    expect(suggestionOf(w, id)).toMatchObject({ status: "accepted", decidedBy: OLA });
    expect(eventsOf(w, "rule.accepted").map((event) => event.facts?.outcome)).toEqual(["awaiting_approval", "published"]);
  });

  it("lets the requester confirm when they are the only one who could, and the version's audit event says so", async () => {
    const w = world();
    w.member(ORG_A, OLA, "member");
    const layer = await processLayer(w);
    const id = await suggest(w, { stage: "review" });
    const answer = await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id));
    const approvalId = approvalIdOf(w, answer);
    await w.decide(approvalId, await w.browser(MAX, approvalId));
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(2);
    expect(w.audit.recordedBy("process.published").at(-1)).toMatchObject({ facts: { selfConfirmedSoleOwner: true } });
  });
});

describe("settlement of a rule that waited", () => {
  async function waiting(w: MergeWorld) {
    const layer = await processLayer(w);
    const id = await suggest(w, { stage: "review" });
    const answer = await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id));
    return { layer, id, approvalId: approvalIdOf(w, answer), ruleId: suggestionOf(w, id).ruleId as string };
  }
  const state = (w: MergeWorld) => item(w, "STATE")!;

  it("approve: active, accepted, correction text and proposedText gone, the metric counts it, one rule.accepted per outcome", async () => {
    const w = world();
    const { id, approvalId, ruleId } = await waiting(w);
    expect(state(w)).toMatchObject({ pendingRules: 1, openSuggestions: 1 });
    await decide(w, OLA, approvalId);
    await settleProject(decideDeps(w), SCOPE);
    expect(item(w, `RULE#${ruleId}`)).toMatchObject({ status: "active", processVersion: 2, text: RULE });
    const accepted = suggestionOf(w, id);
    expect(accepted).toMatchObject({ status: "accepted", ruleId });
    expect(accepted.proposedText).toBeUndefined();
    expect(accepted.indexExpiresAt).toBeTypeOf("number");
    const corrections = w.db.find((entry) => String(entry.sk).startsWith("CORRECTION#"));
    expect(corrections).toHaveLength(2);
    for (const correction of corrections) expect(correction.text).toBeUndefined();
    expect(state(w)).toMatchObject({ pendingRules: 0, openSuggestions: 0 });
    expect(w.db.find((entry) => String(entry.sk).startsWith("METRIC#"))[0]).toMatchObject({ accepted: 1 });
    // Settling again changes nothing and records nothing twice.
    expect(await settleProject(decideDeps(w), SCOPE)).toBe(0);
    expect(eventsOf(w, "rule.accepted")).toHaveLength(2);
  });

  it.each([["DECLINE", "declined"], ["EXPIRED", "expired"], ["APPROVED_FAILED", "failed"]])("%s: not_applied, the suggestion open again with its text, rule.not_applied (%s)", async (how, outcome) => {
    const w = world();
    const { layer, id, approvalId, ruleId } = await waiting(w);
    if (how === "DECLINE") await decide(w, OLA, approvalId, "DECLINE");
    else setApprovalStatus(w, approvalId, how);
    await settleProject(decideDeps(w), SCOPE);
    expect(item(w, `RULE#${ruleId}`)).toMatchObject({ status: "not_applied" });
    const reopened = suggestionOf(w, id);
    expect(reopened).toMatchObject({ status: "open" });
    expect(reopened.ruleId).toBeUndefined();
    expect(reopened.proposedText).toBeTypeOf("string");
    expect(state(w)).toMatchObject({ pendingRules: 0, openSuggestions: 1 });
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(1);
    expect(eventsOf(w, "rule.not_applied").at(-1)).toMatchObject({ facts: { ruleId, approvalOutcome: outcome } });
    // The draft the declined request wrote is put back, so the layer is not left with unpublished changes.
    expect((await w.store.getDraft(ORG_A, layer))!.overlay).toEqual({});
  });

  it("a declined rule can be accepted again (a new request, a new approval)", async () => {
    const w = world();
    const { id, approvalId } = await waiting(w);
    await decide(w, OLA, approvalId, "DECLINE");
    await settleProject(decideDeps(w), SCOPE);
    const again = await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id));
    expect(again.outcome).toBe("awaiting_approval");
    expect(approvalIdOf(w, again as never)).not.toBe(approvalId);
  });

  it("the Home settler settles from an ended approval, from ids only", async () => {
    const w = world();
    const { id, approvalId, ruleId } = await waiting(w);
    await decide(w, OLA, approvalId);
    await learningSettler(decideDeps(w))({ ...SCOPE, ruleId, suggestionId: id, approvalId, approvalStatus: "APPROVED_DONE" } as never);
    expect(item(w, `RULE#${ruleId}`)).toMatchObject({ status: "active" });
  });

  it("every learning route settles the project first", async () => {
    const w = world();
    const { id, approvalId, ruleId } = await waiting(w);
    await decide(w, OLA, approvalId, "DECLINE");
    const other = await suggest(w, { sources: [{ author: PRIYA, task: "t5", text: "Validate every request body with the zod schema before using it." }, { author: ARJUN, task: "t6", text: "Validate request bodies with the zod schema before using them in handlers." }] });
    await dismissSuggestion(decideDeps(w), callerOf(w, MAX), "web", other, { expectedRevision: 0, dismissKind: "wrong" });
    expect(item(w, `RULE#${ruleId}`)).toMatchObject({ status: "not_applied" });
    expect(suggestionOf(w, id)).toMatchObject({ status: "open" });
  });
});

describe("a retry derives the same request", () => {
  it("the request id is a pure function of the suggestion, its revision, the stage and the exact text", () => {
    const a = acceptRequestId("s1", 0, "build", RULE);
    expect(acceptRequestId("s1", 0, "build", RULE)).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    for (const other of [acceptRequestId("s2", 0, "build", RULE), acceptRequestId("s1", 1, "build", RULE), acceptRequestId("s1", 0, "plan", RULE), acceptRequestId("s1", 0, "build", `${RULE}.`)]) expect(other).not.toBe(a);
  });

  it("a retry of an Accept that waited finds the same rule, the same approval and no second pending change", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w, { stage: "review" });
    const body = acceptBody(w, id);
    const first = await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, body);
    const again = await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, { ...body, requestId: randomUUID() });
    expect(again).toEqual(first);
    expect(w.db.find((entry) => String(entry.sk).startsWith("RULE#"))).toHaveLength(1);
    expect(w.db.find((entry) => entry.kind === "change" && entry.status === "PENDING")).toHaveLength(1);
    expect(eventsOf(w, "rule.accepted")).toHaveLength(1);
  });

  it("a retry of an Accept that applied answers the same version and publishes nothing more", async () => {
    const w = world();
    const layer = await processLayer(w);
    const id = await suggest(w);
    const body = acceptBody(w, id);
    expect(await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, body)).toEqual({ outcome: "published", version: 2 });
    expect(await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, body)).toEqual({ outcome: "published", version: 2 });
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(2);
    expect(eventsOf(w, "rule.accepted")).toHaveLength(1);
  });

  it("when the draft was written and the publish did not happen, the retry goes straight to the publish", async () => {
    const w = world();
    const layer = await processLayer(w);
    const id = await suggest(w);
    const body = acceptBody(w, id);
    const original = w.store.publish.bind(w.store);
    let failures = 1;
    (w.store as { publish: typeof w.store.publish }).publish = async (input) => {
      if (failures-- > 0) throw agentXError("RUNTIME_UNAVAILABLE", "the table is down");
      return original(input);
    };
    expect(await failure(acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, body))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    // Left as it was: the rule pending, the suggestion accepting, the draft holding exactly the rule.
    expect(suggestionOf(w, id)).toMatchObject({ status: "accepting" });
    expect(item(w, `RULE#${suggestionOf(w, id).ruleId as string}`)).toMatchObject({ status: "pending" });
    expect((await w.store.getDraft(ORG_A, layer))!.overlay).toEqual({ steps: { build: { instructions: RULE } } });
    expect(await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, body)).toEqual({ outcome: "published", version: 2 });
    expect(item(w, `RULE#${suggestionOf(w, id).ruleId as string}`)).toMatchObject({ status: "active" });
  });

  it("a refused publish puts the draft back and the suggestion open again", async () => {
    const w = world();
    const layer = await processLayer(w);
    const id = await suggest(w);
    const original = w.store.publish.bind(w.store);
    (w.store as { publish: typeof w.store.publish }).publish = async () => { throw agentXError("CONFIG_INVALID", "guardrails: not allowed"); };
    expect(await failure(acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id)))).toMatchObject({ code: "CONFIG_INVALID" });
    (w.store as { publish: typeof w.store.publish }).publish = original;
    expect(suggestionOf(w, id)).toMatchObject({ status: "open" });
    expect((await w.store.getDraft(ORG_A, layer))!.overlay).toEqual({});
    expect(item(w, "STATE")).toMatchObject({ pendingRules: 0 });
    expect(await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id))).toMatchObject({ outcome: "published" });
  });

  it("a rule stuck pending for 10 minutes is resolved by settlement: published (the note is in a version) or open again", async () => {
    const w = world();
    const layer = await processLayer(w);
    const stuck = await suggest(w);
    const original = w.store.publish.bind(w.store);
    (w.store as { publish: typeof w.store.publish }).publish = async (input) => {
      await original(input); // the version lands, then the broker "dies"
      throw agentXError("RUNTIME_UNAVAILABLE", "lost");
    };
    await failure(acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", stuck, acceptBody(w, stuck)));
    (w.store as { publish: typeof w.store.publish }).publish = original;
    expect(item(w, `RULE#${suggestionOf(w, stuck).ruleId as string}`)).toMatchObject({ status: "pending" });
    await settleProject(decideDeps(w), SCOPE);
    expect(item(w, `RULE#${suggestionOf(w, stuck).ruleId as string}`)).toMatchObject({ status: "pending" });
    w.clock.now += 11 * 60_000;
    await settleProject(decideDeps(w), SCOPE);
    expect(item(w, `RULE#${suggestionOf(w, stuck).ruleId as string}`)).toMatchObject({ status: "active", processVersion: 2 });
    expect(suggestionOf(w, stuck)).toMatchObject({ status: "accepted" });
    void layer;
  });
});

describe("the re-check at Accept", () => {
  it("refuses an accepter who is no longer a member (a contributor whose grant became viewer)", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w);
    w.db.set({ ...projectMemberKey(ORG_A, ARJUN, "web"), entityType: "MEMBERSHIP", ownerKey: ARJUN, projectName: "web", grantId: randomUUID(), role: "viewer", projectRole: "viewer" });
    w.members.grant(ORG_A, "web", ARJUN, "viewer");
    expect(await failure(acceptSuggestion(decideDeps(w), callerOf(w, ARJUN), "web", id, acceptBody(w, id)))).toMatchObject({ code: "FORBIDDEN" });
    expect(suggestionOf(w, id)).toMatchObject({ status: "open" });
  });

  it("drops a source whose author left the company; fewer than 2 sources from 2 tasks withdraws the suggestion and refuses", async () => {
    const w = world();
    const layer = await processLayer(w);
    const id = await suggest(w);
    w.db.delete(orgMemberKey(ORG_A, ARJUN));
    expect(await failure(acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id)))).toMatchObject({ code: "LEARNING_SOURCES_GONE", message: expect.stringContaining("This suggestion no longer has enough sources.") as unknown });
    const withdrawn = suggestionOf(w, id);
    expect(withdrawn).toMatchObject({ status: "withdrawn" });
    expect(withdrawn.proposedText).toBeUndefined();
    expect(item(w, "STATE")).toMatchObject({ openSuggestions: 0 });
    expect((await w.store.getDraft(ORG_A, layer))!.overlay).toEqual({});
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(1);
  });

  it("goes on when 2 sources from 2 tasks remain after one author left", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w, { sources: [{ author: PRIYA, task: "t1", text: RETRY_A }, { author: ARJUN, task: "t2", text: RETRY_B }, { author: MAX, task: "t3", text: RETRY_A }] });
    w.db.delete(orgMemberKey(ORG_A, ARJUN));
    expect(await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id))).toMatchObject({ outcome: "published" });
  });

  it("B5 obligation: sources that are all PR comments while PR capture is off are refused and the suggestion withdrawn", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w, { sources: [{ author: PRIYA, task: "t1", text: RETRY_A, source: "pr_comment" }, { author: ARJUN, task: "t2", text: RETRY_B, source: "pr_comment" }] });
    // Capture is on when it forms (the test passes the check), and off at Accept (no SETTINGS item: off by default).
    expect(await failure(acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id)))).toMatchObject({ code: "LEARNING_SOURCES_GONE" });
    expect(suggestionOf(w, id)).toMatchObject({ status: "withdrawn" });
    expect(suggestionOf(w, id).proposedText).toBeUndefined();
  });

  it("PR comments count while capture is on", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w, { sources: [{ author: PRIYA, task: "t1", text: RETRY_A, source: "pr_comment" }, { author: ARJUN, task: "t2", text: RETRY_B, source: "pr_comment" }] });
    expect(await acceptSuggestion(decideDeps(w, { prCaptureOff: async () => false }), callerOf(w, MAX), "web", id, acceptBody(w, id))).toMatchObject({ outcome: "published" });
  });
});

describe("L3: being the author never grants the right to accept; How we work edit rights do", () => {
  it("refuses a contributor who wrote one of the corrections, and writes nothing", async () => {
    const w = world();
    const layer = await processLayer(w);
    const id = await suggest(w);
    const refusal = await failure(acceptSuggestion(decideDeps(w), callerOf(w, ARJUN), "web", id, acceptBody(w, id)));
    expect(refusal!.code).toBe("FORBIDDEN");
    expect(refusal!.message).toContain("only a project maintainer can change how the project works");
    expect(suggestionOf(w, id)).toMatchObject({ status: "open" });
    expect(ruleItems(w)).toEqual([]);
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(1);
  });

  it("lets a maintainer who wrote one of the corrections accept their own suggestion; the version is theirs", async () => {
    const w = world();
    const layer = await processLayer(w);
    const id = await suggest(w, { sources: [{ author: MAX, task: "t1", text: RETRY_A }, { author: ARJUN, task: "t2", text: RETRY_B }] });
    expect(await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id))).toEqual({ outcome: "published", version: 2 });
    expect((await w.store.getVersion(ORG_A, layer, 2))!.publishedBy).toBe(MAX);
    expect(eventsOf(w, "rule.accepted").at(-1)).toMatchObject({ actor: { id: MAX } });
  });

  it("refuses a contributor who wrote none of them, and a viewer", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w, { sources: [{ author: MAX, task: "t1", text: RETRY_A }, { author: OLA, task: "t2", text: RETRY_B }] });
    expect(await failure(acceptSuggestion(decideDeps(w), callerOf(w, PRIYA), "web", id, acceptBody(w, id)))).toMatchObject({ code: "FORBIDDEN" });
    expect(await failure(acceptSuggestion(decideDeps(w), callerOf(w, MIA), "web", id, acceptBody(w, id)))).toMatchObject({ code: "FORBIDDEN" });
  });

  it("only a maintainer dismisses or removes", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w);
    expect(await failure(dismissSuggestion(decideDeps(w), callerOf(w, ARJUN), "web", id, { expectedRevision: 0, dismissKind: "wrong" }))).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("Dismiss and reopen", () => {
  it("ends the suggestion, remembers the pattern without text, counts it, audits it, and never keeps the note", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w);
    const answer = await dismissSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, { expectedRevision: 0, dismissKind: "one_off", note: "SECRET-NOTE-WORDS" });
    expect(answer).toEqual({ suggestion: { id, status: "dismissed" } });
    // The answer the route sends is the contract's answer: the screens read it with the shared schema.
    expect(LearningDismissAnswerSchema.safeParse(answer).success).toBe(true);
    const stored = suggestionOf(w, id);
    expect(stored).toMatchObject({ status: "dismissed", dismissKind: "one_off", decidedBy: MAX });
    expect(stored.proposedText).toBeUndefined();
    expect(JSON.stringify([...w.db.find(() => true)])).not.toContain("SECRET-NOTE-WORDS");
    expect(item(w, "STATE")).toMatchObject({ openSuggestions: 0 });
    expect(w.db.find((entry) => String(entry.sk).startsWith("DISMISSED#"))).toHaveLength(1);
    expect(w.db.find((entry) => String(entry.sk).startsWith("METRIC#"))[0]).toMatchObject({ dismissed: 1 });
    expect(eventsOf(w, "rule.dismissed").at(-1)).toMatchObject({ actor: { id: MAX }, facts: { suggestionId: id, stage: "build", dismissKind: "one_off" } });
    expect(JSON.stringify(eventsOf(w, "rule.dismissed"))).not.toContain("SECRET-NOTE-WORDS");
    // The same group does not come back.
    expect((await groupCorrections(learning(w), SCOPE, { prCaptureOff: async () => false })).opened).toEqual([]);
  });

  it("refuses a stale revision and a suggestion that is being accepted", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w, { stage: "review" });
    expect(await failure(dismissSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, { expectedRevision: 3, dismissKind: "wrong" }))).toMatchObject({ code: "AGENT_REVISION_CONFLICT", message: expect.stringContaining("Refresh") as unknown });
    await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id));
    expect(await failure(dismissSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, { expectedRevision: 2, dismissKind: "wrong" }))).toMatchObject({ code: "LEARNING_LAYER_BUSY" });
  });

  it("reopening takes the pattern off the list and the same corrections form a suggestion again", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w);
    await dismissSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, { expectedRevision: 0, dismissKind: "wrong" });
    const [dismissed] = w.db.find((entry) => String(entry.sk).startsWith("DISMISSED#"));
    expect(await reopenDismissed(decideDeps(w), callerOf(w, MAX), "web", String(dismissed!.sk).slice("DISMISSED#".length))).toEqual({ reopened: true });
    expect(w.db.find((entry) => String(entry.sk).startsWith("DISMISSED#"))).toEqual([]);
    expect(w.db.find((entry) => String(entry.sk).startsWith("SUGGESTION#") && entry.status === "open")).toHaveLength(1);
  });
});

describe("Remove one rule", () => {
  async function accepted(w: MergeWorld, stage = "build") {
    const layer = await processLayer(w, { steps: { build: { instructions: "Run the linter before you finish." } } });
    const id = await suggest(w, { stage });
    await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id));
    return { layer, ruleId: suggestionOf(w, id).ruleId as string };
  }
  const remove = (w: MergeWorld, ruleId: string) => removeRule(decideDeps(w), callerOf(w, MAX), "web", ruleId, { requestId: randomUUID() });

  it("deletes exactly that paragraph from the published overlay and publishes", async () => {
    const w = world();
    const { layer, ruleId } = await accepted(w);
    expect(await remove(w, ruleId)).toEqual({ outcome: "published", version: 3 });
    expect(await overlayOf(w, layer, 3)).toEqual({ steps: { build: { instructions: "Run the linter before you finish." } } });
    expect(item(w, `RULE#${ruleId}`)).toMatchObject({ status: "removed", removedInVersion: 3 });
    expect(eventsOf(w, "rule.rolled_back").at(-1)).toMatchObject({ facts: { ruleId, processAgentId: layer, processVersion: 3 } });
    expect(await remove(w, ruleId)).toEqual({ outcome: "published", version: 3 });
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(3);
  });

  it("answers needs_editor, writing nothing, for a duplicate", async () => {
    const w = world();
    const { layer, ruleId } = await accepted(w);
    await setDraft(w, layer, { steps: { build: { instructions: `Run the linter before you finish.\n\n${RULE}\n\n${RULE}` } } });
    const agent = (await w.store.get(ORG_A, layer))!;
    await publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
    expect(await remove(w, ruleId)).toEqual({ outcome: "needs_editor", stage: "build" });
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(3);
    expect(item(w, `RULE#${ruleId}`)).toMatchObject({ status: "active" });
  });

  it("answers needs_editor for a rule that is only part of a longer paragraph (a substring), and for one that is gone", async () => {
    const w = world();
    const { layer, ruleId } = await accepted(w);
    await setDraft(w, layer, { steps: { build: { instructions: `Run the linter before you finish. ${RULE} And more words.` } } });
    let agent = (await w.store.get(ORG_A, layer))!;
    await publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
    expect(await remove(w, ruleId)).toEqual({ outcome: "needs_editor", stage: "build" });
    await setDraft(w, layer, { steps: { build: { instructions: "Something else entirely." } } });
    agent = (await w.store.get(ORG_A, layer))!;
    await publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
    expect(await remove(w, ruleId)).toEqual({ outcome: "needs_editor", stage: "build" });
    expect(item(w, `RULE#${ruleId}`)).toMatchObject({ status: "active" });
  });

  it("uses the same busy refusal as Accept", async () => {
    const w = world();
    const { layer, ruleId } = await accepted(w);
    await setDraft(w, layer, { steps: { build: { instructions: `Run the linter before you finish.\n\n${RULE}` }, plan: { instructions: "Unpublished." } } });
    expect(await failure(remove(w, ruleId))).toMatchObject({ code: "LEARNING_LAYER_BUSY" });
  });

  it("a reviewing stage's removal waits for a second person, and settlement removes the rule when it is confirmed", async () => {
    const w = world();
    const layer = await processLayer(w);
    const id = await suggest(w, { stage: "review" });
    const waiting = await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id));
    await decide(w, OLA, approvalIdOf(w, waiting));
    await settleProject(decideDeps(w), SCOPE);
    const ruleId = suggestionOf(w, id).ruleId as string;
    const removing = await remove(w, ruleId);
    expect(removing.outcome).toBe("awaiting_approval");
    expect(item(w, `RULE#${ruleId}`)).toMatchObject({ status: "active", removalApprovalId: expect.any(String) as unknown });
    await decide(w, OLA, approvalIdOf(w, removing));
    await settleProject(decideDeps(w), SCOPE);
    expect(item(w, `RULE#${ruleId}`)).toMatchObject({ status: "removed", removedInVersion: 3 });
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(3);
  });

  it("the overlay helpers: exact paragraph, no guessing", () => {
    const overlay = { steps: { build: { instructions: `A\n\n${RULE}\n\nB` } } } as never;
    expect(removeRuleFromOverlay(overlay, "build", RULE)).toMatchObject({ matches: 1, overlay: { steps: { build: { instructions: "A\n\nB" } } } });
    expect(removeRuleFromOverlay({ steps: { build: { instructions: RULE } } }, "build", RULE).overlay).toEqual({});
    expect(removeRuleFromOverlay(overlay, "build", "A\n\nB").matches).toBe(0);
    expect(() => appendRuleToOverlay({ instructions: "y".repeat(3_995) }, "*", RULE)).toThrow(/rules are full/);
  });
});

describe("Forget leaving sources from one task (B5/B3 re-check)", () => {
  it("withdraws the suggestion when 2 or more sources remain but all are from ONE task", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w, { sources: [{ author: PRIYA, task: "t1", text: RETRY_A }, { author: PRIYA, task: "t1", text: RETRY_B }, { author: ARJUN, task: "t2", text: RETRY_A }] });
    expect(suggestionOf(w, id).correctionIds).toHaveLength(3);
    const last = w.db.find((entry) => String(entry.sk).startsWith("CORRECTION#") && entry.taskId === "t2")[0]!;
    expect(await forgetCorrection(learning(w), SCOPE, { correctionSk: String(last.sk), actor: ARJUN })).toEqual({ ok: true });
    const stored = suggestionOf(w, id);
    expect(stored).toMatchObject({ status: "withdrawn" });
    expect(stored.proposedText).toBeUndefined();
    expect(item(w, "STATE")).toMatchObject({ openSuggestions: 0 });
  });

  it("says plainly that the item changed when only the revision moved, and 'being accepted' only when it is", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w, { sources: [{ author: PRIYA, task: "t1", text: RETRY_A }, { author: ARJUN, task: "t2", text: RETRY_B }, { author: MAX, task: "t3", text: RETRY_A }] });
    const target = w.db.find((entry) => String(entry.sk).startsWith("CORRECTION#") && entry.taskId === "t3")[0]!;
    const sk = projectLearningKey(ORG_A, "web", `SUGGESTION#${id}`);
    // The revision moves between Forget's read and its write (a member joins, a rewrite): not "accepting".
    w.db.injectFault({ command: "TransactWriteCommand", match: () => { const current = w.db.get(sk)!; w.db.set({ ...current, revision: Number(current.revision) + 1 }); return true; }, error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }] } });
    expect(await forgetCorrection(learning(w), SCOPE, { correctionSk: String(target.sk) })).toEqual({ ok: false, reason: "suggestion_changed" });
    // Being accepted is busy.
    const current = w.db.get(sk)!;
    w.db.set({ ...current, status: "accepting" });
    expect(await forgetCorrection(learning(w), SCOPE, { correctionSk: String(target.sk) })).toEqual({ ok: false, reason: "suggestion_busy" });
  });
});

describe("audit: every learning path emits", () => {
  it("rule.suggested when grouping opens a suggestion (by the system, ids and counts only)", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w);
    expect(eventsOf(w, "rule.suggested")).toEqual([expect.objectContaining({ actor: { kind: "system", id: "rovara" }, facts: { suggestionId: id, stage: "build", sourceCount: 2, sourceKinds: "comment", lessSafe: false, fromOnePerson: false } })]);
  });

  it("rule.withdrawn (not rule.dismissed) when Rovara withdraws a suggestion (Forget, a source gone)", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w);
    const one = w.db.find((entry) => String(entry.sk).startsWith("CORRECTION#"))[0]!;
    await forgetCorrection(learning(w), SCOPE, { correctionSk: String(one.sk), actor: PRIYA });
    expect(eventsOf(w, "rule.withdrawn").at(-1)).toMatchObject({ actor: { kind: "system" }, facts: { suggestionId: id, stage: "build", cause: "forgotten" } });
    expect(eventsOf(w, "rule.dismissed")).toEqual([]);
    expect(eventsOf(w, "rule.correction_remembered").at(-1)).toMatchObject({ actor: { id: PRIYA }, facts: { op: "forget" } });
  });

  it("no event holds correction, rule or note text", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w);
    await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id));
    const all = JSON.stringify(w.audit.recorded().filter((event) => event.action.startsWith("rule.")));
    expect(all).not.toContain("retry helper");
  });
});

describe("the routes", () => {
  const route = (w: MergeWorld, who: string, method: string, path: string, body: unknown, decide: LearningDecideDeps | null = decideDeps(w)) =>
    routeLearning({ task: {} as never, projectFor: (who, rawName) => decideDeps(w).projectFor(who, rawName), ...(decide === null ? {} : { decide }), audit: w.audit.audit }, callerOf(w, who), method, new URL(`https://cell.example.com/v1/app/projects/web/learning/${path}`), () => body);

  it("accept, dismiss, reopen and remove are reached under /learning, with strict bodies", async () => {
    const w = world();
    await processLayer(w);
    const first = await suggest(w);
    expect(await route(w, MAX, "POST", `suggestions/${first}/accept`, acceptBody(w, first))).toEqual({ outcome: "published", version: 2 });
    const ruleId = suggestionOf(w, first).ruleId as string;
    expect(await route(w, MAX, "POST", `rules/${ruleId}/remove`, { requestId: randomUUID() })).toEqual({ outcome: "published", version: 3 });
    expect(await failure(Promise.resolve(route(w, MAX, "POST", `rules/${ruleId}/remove`, { requestId: randomUUID(), extra: 1 })))).toMatchObject({ code: "CONFIG_INVALID" });
    const second = await suggest(w, { sources: [{ author: PRIYA, task: "t5", text: "Validate every request body with the zod schema before using it." }, { author: ARJUN, task: "t6", text: "Validate request bodies with the zod schema before using them in handlers." }] });
    expect(await route(w, MAX, "POST", `suggestions/${second}/dismiss`, { expectedRevision: 0, dismissKind: "wrong" })).toEqual({ suggestion: { id: second, status: "dismissed" } });
    const [dismissed] = w.db.find((entry) => String(entry.sk).startsWith("DISMISSED#"));
    expect(await route(w, MAX, "POST", `dismissed/${String(dismissed!.sk).slice(10)}/reopen`, {})).toEqual({ reopened: true });
    expect(await failure(Promise.resolve(route(w, MAX, "POST", `dismissed/${String(dismissed!.sk).slice(10)}/reopen`, { extra: 1 })))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("answers not found where agents are not set up, and leaves other paths and methods to the caller", async () => {
    const w = world();
    expect(await failure(Promise.resolve(route(w, MAX, "POST", "suggestions/abc/accept", {}, null)))).toMatchObject({ code: "NOT_FOUND" });
    expect(await route(w, MAX, "GET", "suggestions/abc/accept", {})).toBeUndefined();
    expect(await route(w, MAX, "POST", "suggestions/abc/other", {})).toBeUndefined();
  });
});


// ---- B6 review fixes (C1, I1, I2, I3, L3, minor items). Written first; run against the unfixed code they fail.

const FOREIGN = { steps: { build: { instructions: "Somebody else's unpublished work." } } };
const notesOf = async (w: MergeWorld, layer: AgentId) => {
  const agent = (await w.store.get(ORG_A, layer))!;
  const notes: Array<string | undefined> = [];
  for (let version = 1; version <= (agent.currentVersion ?? 0); version += 1) notes.push((await w.store.getVersion(ORG_A, layer, version))!.note);
  return notes;
};
const ruleItems = (w: MergeWorld) => w.db.find((entry) => String(entry.sk).startsWith("RULE#"));
type RawCommand = { input?: { TransactItems?: Array<{ Update?: { Key?: { sk?: string }; ExpressionAttributeValues?: Record<string, unknown> } }> } };

/** A store whose client lets a test run a foreign write right after the first draft save the code under test makes. The foreign write uses an ordinary store on the same table. */
function interleaved(w: MergeWorld) {
  const plain = w.store;
  const hooks: { afterDraftSave?: () => Promise<void> } = {};
  const client = {
    send: async (command: unknown) => {
      const result = await w.db.send(command as never);
      const items = (command as RawCommand).input?.TransactItems;
      if (hooks.afterDraftSave !== undefined && items?.some((entry) => entry.Update?.Key?.sk === "DRAFT")) {
        const run = hooks.afterDraftSave;
        delete hooks.afterDraftSave;
        await run();
      }
      return result;
    },
  };
  const store = new AgentStore({ documentClient: client, tableName: "state", now: () => w.clock.now, audit: w.audit.audit });
  (w.deps as { store: AgentStore }).store = store;
  w.store = store;
  const foreignSave = (layer: AgentId) => async () => {
    await plain.saveDraft({ orgId: ORG_A, agentId: layer, overlay: FOREIGN, expectedRevision: (await plain.getDraft(ORG_A, layer))!.revision, by: ARJUN });
  };
  return { hooks, plain, foreignSave };
}
/** A table client that runs `before` once, just before the first transaction. */
function beforeFirstTransaction(w: MergeWorld, before: () => void) {
  let armed = true;
  return {
    send: async (command: unknown) => {
      if (armed && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") { armed = false; before(); }
      return w.db.send(command as never);
    },
  };
}

describe("C1: Accept and Remove publish exactly the draft they saved", () => {
  it("Accept: a draft saved by someone else between Accept's save and its publish is refused; nothing is published and their draft stays", async () => {
    const w = world();
    const layer = await processLayer(w);
    const { hooks, plain, foreignSave } = interleaved(w);
    const id = await suggest(w);
    hooks.afterDraftSave = foreignSave(layer);
    expect(await failure(acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id)))).toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
    expect((await plain.get(ORG_A, layer))!.currentVersion).toBe(1);
    expect((await notesOf(w, layer)).some((note) => note?.startsWith("Suggested rule"))).toBe(false);
    expect((await plain.getDraft(ORG_A, layer))!.overlay).toEqual(FOREIGN);
    expect(suggestionOf(w, id)).toMatchObject({ status: "open" });
    expect(ruleItems(w)[0]).toMatchObject({ status: "not_applied" });
  });

  it("Remove: a draft saved by someone else between Remove's save and its publish is refused; nothing is published and their draft stays", async () => {
    const w = world();
    const layer = await processLayer(w, { steps: { build: { instructions: "Run the linter before you finish." } } });
    const id = await suggest(w);
    await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id));
    const ruleId = suggestionOf(w, id).ruleId as string;
    const { hooks, plain, foreignSave } = interleaved(w);
    hooks.afterDraftSave = foreignSave(layer);
    expect(await failure(removeRule(decideDeps(w), callerOf(w, MAX), "web", ruleId, { requestId: randomUUID() }))).toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
    expect((await plain.get(ORG_A, layer))!.currentVersion).toBe(2);
    expect((await plain.getDraft(ORG_A, layer))!.overlay).toEqual(FOREIGN);
    expect(item(w, `RULE#${ruleId}`)).toMatchObject({ status: "active" });
  });
});

describe("I1: only a refusal before the publish undoes an Accept", () => {
  it("a failure after the publish (the trigger re-check, with a network error code) never marks the published rule not_applied", async () => {
    const w = world();
    const layer = await processLayer(w);
    (w.deps as { triggerHooks?: unknown }).triggerHooks = { recheckTriggersForTarget: async () => { throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); } };
    const id = await suggest(w);
    const answer = await failure(acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id))).then(() => "settled");
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(2);
    expect(answer).toBe("settled");
    expect(ruleItems(w)[0]).toMatchObject({ status: "active", processVersion: 2 });
    expect(suggestionOf(w, id)).toMatchObject({ status: "accepted" });
  });

  it("a failure while recording the outcome (ECONNRESET) leaves the rule pending, the version published and the draft alone; settlement then completes it", async () => {
    const w = world();
    const layer = await processLayer(w);
    const id = await suggest(w);
    const failing = { send: async (command: unknown) => {
      if ((command as RawCommand).input?.TransactItems?.some((entry) => entry.Update?.ExpressionAttributeValues?.[":to"] === "active")) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      return w.db.send(command as never);
    } };
    await expect(acceptSuggestion(decideDeps(w, { documentClient: failing }), callerOf(w, MAX), "web", id, acceptBody(w, id))).rejects.toMatchObject({ code: "ECONNRESET" });
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(2);
    expect(ruleItems(w)[0]).toMatchObject({ status: "pending" });
    expect(suggestionOf(w, id)).toMatchObject({ status: "accepting" });
    expect((await w.store.getDraft(ORG_A, layer))!.overlay).toEqual({ steps: { build: { instructions: RULE } } });
    w.clock.now += 11 * 60_000;
    await settleProject(decideDeps(w), SCOPE);
    expect(ruleItems(w)[0]).toMatchObject({ status: "active", processVersion: 2 });
    expect(suggestionOf(w, id)).toMatchObject({ status: "accepted" });
  });

  it("an error from the publish that is not an AgentX refusal (a network code) is ambiguous: nothing is undone", async () => {
    const w = world();
    const layer = await processLayer(w);
    const id = await suggest(w);
    (w.store as { publish: typeof w.store.publish }).publish = async () => { throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); };
    await expect(acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id))).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(ruleItems(w)[0]).toMatchObject({ status: "pending" });
    expect(suggestionOf(w, id)).toMatchObject({ status: "accepting" });
    expect((await w.store.getDraft(ORG_A, layer))!.overlay).toEqual({ steps: { build: { instructions: RULE } } });
  });

  it("CONFIG_INVALID from the publish (the stage-choice guard) is a refusal: the draft is restored and the suggestion opens again, for Accept and for Remove", async () => {
    const w = world();
    const layer = await processLayer(w, { steps: { build: { instructions: "Run the linter before you finish." } } });
    const id = await suggest(w);
    await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id));
    const ruleId = suggestionOf(w, id).ruleId as string;
    const original = w.store.publish.bind(w.store);
    (w.store as { publish: typeof w.store.publish }).publish = async () => { throw agentXError("CONFIG_INVALID", "steps.build.model: pick a model for this stage"); };
    expect(await failure(removeRule(decideDeps(w), callerOf(w, MAX), "web", ruleId, { requestId: randomUUID() }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect((await w.store.getDraft(ORG_A, layer))!.overlay).toEqual(await overlayOf(w, layer, 2));
    expect(item(w, `RULE#${ruleId}`)).toMatchObject({ status: "active" });
    const second = await suggest(w, { sources: [{ author: PRIYA, task: "t5", text: "Validate every request body with the zod schema before using it." }, { author: ARJUN, task: "t6", text: "Validate request bodies with the zod schema before using them in handlers." }] });
    expect(await failure(acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", second, acceptBody(w, second, "Validate request bodies.")))).toMatchObject({ code: "CONFIG_INVALID" });
    (w.store as { publish: typeof w.store.publish }).publish = original;
    expect(suggestionOf(w, second)).toMatchObject({ status: "open" });
    expect((await w.store.getDraft(ORG_A, layer))!.overlay).toEqual(await overlayOf(w, layer, 2));
  });
});

describe("I2: a waiting Accept or Remove answers 202 like a hand publish", () => {
  const route = (w: MergeWorld, who: string, path: string, body: unknown) =>
    routeLearning({ task: {} as never, projectFor: (caller, rawName) => decideDeps(w).projectFor(caller, rawName), decide: decideDeps(w), audit: w.audit.audit }, callerOf(w, who), "POST", new URL(`https://cell.example.com/v1/app/projects/web/learning/${path}`), () => body);

  it("Accept: StatusReply 202 with status, confirmUrl and changes (and the outcome the screens read)", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w, { stage: "review" });
    const reply = await route(w, MAX, `suggestions/${id}/accept`, acceptBody(w, id));
    expect(reply).toBeInstanceOf(StatusReply);
    expect((reply as StatusReply).statusCode).toBe(202);
    expect((reply as StatusReply).body).toMatchObject({ status: "NEEDS_CONFIRMATION", outcome: "awaiting_approval", confirmUrl: expect.stringContaining("/v1/app/approve/") as unknown, changes: expect.any(Array) as unknown });
  });

  it("Remove: the same 202", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w, { stage: "review" });
    const waiting = await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id));
    await decide(w, OLA, approvalIdOf(w, waiting));
    await settleProject(decideDeps(w), SCOPE);
    const reply = await route(w, MAX, `rules/${suggestionOf(w, id).ruleId as string}/remove`, { requestId: randomUUID() });
    expect(reply).toBeInstanceOf(StatusReply);
    expect((reply as StatusReply).statusCode).toBe(202);
    expect((reply as StatusReply).body).toMatchObject({ status: "NEEDS_CONFIRMATION", outcome: "awaiting_approval", confirmUrl: expect.any(String) as unknown, changes: expect.any(Array) as unknown });
  });

  it("an applied Accept is still a plain 200 answer", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w);
    expect(await route(w, MAX, `suggestions/${id}/accept`, acceptBody(w, id))).toEqual({ outcome: "published", version: 2 });
  });
});

describe("I3: a Remove that was declined or expired gives the draft back", () => {
  async function removing(w: MergeWorld) {
    const layer = await processLayer(w);
    const id = await suggest(w, { stage: "review" });
    const waiting = await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id));
    await decide(w, OLA, approvalIdOf(w, waiting));
    await settleProject(decideDeps(w), SCOPE);
    const ruleId = suggestionOf(w, id).ruleId as string;
    const asked = await removeRule(decideDeps(w), callerOf(w, MAX), "web", ruleId, { requestId: randomUUID() });
    expect(asked.outcome).toBe("awaiting_approval");
    return { layer, ruleId, approvalId: approvalIdOf(w, asked) };
  }

  for (const how of ["declined", "expired"] as const) {
    it(`${how}: the draft goes back to the published overlay, the rule stays active, and the next Accept is not busy`, async () => {
      const w = world();
      const { layer, ruleId, approvalId } = await removing(w);
      expect((await w.store.getDraft(ORG_A, layer))!.overlay).toEqual({});
      if (how === "declined") await decide(w, OLA, approvalId, "DECLINE");
      else setApprovalStatus(w, approvalId, "EXPIRED");
      await settleProject(decideDeps(w), SCOPE);
      expect(item(w, `RULE#${ruleId}`)).not.toHaveProperty("removalApprovalId");
      expect(item(w, `RULE#${ruleId}`)).toMatchObject({ status: "active" });
      expect((await w.store.getDraft(ORG_A, layer))!.overlay).toEqual(await overlayOf(w, layer, 2));
      const next = await suggest(w, { stage: "build", sources: [{ author: PRIYA, task: "t8", text: "Name database migrations with the date prefix and a short description." }, { author: ARJUN, task: "t9", text: "Database migrations need a date prefix in the name and a short description." }] });
      expect(await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", next, acceptBody(w, next, "Prefix migrations with the date."))).toMatchObject({ outcome: "published" });
    });
  }

  it("leaves a draft alone that is not exactly the published overlay without the rule (someone else's edit)", async () => {
    const w = world();
    const { layer, ruleId, approvalId } = await removing(w);
    await setDraft(w, layer, FOREIGN, ARJUN);
    await decide(w, OLA, approvalId, "DECLINE");
    await settleProject(decideDeps(w), SCOPE);
    expect((await w.store.getDraft(ORG_A, layer))!.overlay).toEqual(FOREIGN);
    expect(item(w, `RULE#${ruleId}`)).toMatchObject({ status: "active" });
  });
});

describe("a project with no How we work layer yet", () => {
  it("refuses a contributor author with the same words as a publish (no set-up message, no link), and writes nothing", async () => {
    const w = world();
    const id = await suggest(w);
    const refusal = await failure(acceptSuggestion(decideDeps(w), callerOf(w, ARJUN), "web", id, acceptBody(w, id)));
    expect(refusal!.code).toBe("FORBIDDEN");
    expect(refusal!.message).toContain("only a project maintainer can change how the project works");
    expect(refusal!.message).not.toContain("set up How we work");
    expect(refusal!.message).not.toContain("how-we-work");
    expect(suggestionOf(w, id)).toMatchObject({ status: "open" });
    expect(ruleItems(w)).toEqual([]);
  });

  it("lets a maintainer set the layer up as they accept", async () => {
    const w = world();
    const id = await suggest(w);
    const answer = await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id));
    expect(answer).toMatchObject({ outcome: "published" });
  });
});

describe("standing is carried in the transactions", () => {
  it("a source author who loses their place between the read and the write stops the first attempt (nothing is written)", async () => {
    const w = world();
    const layer = await processLayer(w);
    const id = await suggest(w);
    const deps = decideDeps(w, { documentClient: beforeFirstTransaction(w, () => w.db.delete(orgMemberKey(ORG_A, ARJUN))) });
    expect(await failure(acceptSuggestion(deps, callerOf(w, MAX), "web", id, acceptBody(w, id)))).toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(1);
    expect(ruleItems(w)).toEqual([]);
    expect(suggestionOf(w, id)).toMatchObject({ status: "open" });
  });

  async function stuckAccept(w: MergeWorld) {
    const layer = await processLayer(w);
    const id = await suggest(w);
    const body = acceptBody(w, id);
    const original = w.store.publish.bind(w.store);
    (w.store as { publish: typeof w.store.publish }).publish = async () => { throw agentXError("RUNTIME_UNAVAILABLE", "the table is down"); };
    expect(await failure(acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, body))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    (w.store as { publish: typeof w.store.publish }).publish = original;
    return { layer, id, body };
  }

  it("a retry re-reads the source authors: with fewer than 2 sources left it is refused and publishes nothing", async () => {
    const w = world();
    const { layer, id, body } = await stuckAccept(w);
    w.db.delete(orgMemberKey(ORG_A, ARJUN));
    expect(await failure(acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, body))).toMatchObject({ code: "LEARNING_SOURCES_GONE" });
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(1);
  });

  it("a retry carries the standing checks in a transaction: an author lost between the read and the write stops it", async () => {
    const w = world();
    const { layer, id, body } = await stuckAccept(w);
    const deps = decideDeps(w, { documentClient: beforeFirstTransaction(w, () => w.db.delete(orgMemberKey(ORG_A, ARJUN))) });
    expect(await failure(acceptSuggestion(deps, callerOf(w, MAX), "web", id, body))).toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(1);
  });

  it("a retry with everyone still in place goes through", async () => {
    const w = world();
    const { id, body } = await stuckAccept(w);
    expect(await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, body)).toEqual({ outcome: "published", version: 2 });
  });
});

describe("settleProject pages through every rule", () => {
  it("settles a waiting rule that sits past the first hundred rules of the project", async () => {
    const w = world();
    const layer = await processLayer(w);
    const id = await suggest(w, { stage: "review" });
    const answer = await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id));
    await decide(w, OLA, approvalIdOf(w, answer));
    for (let n = 0; n < 130; n += 1) {
      const filler = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      w.db.set({ ...projectLearningKey(ORG_A, "web", `RULE#${filler}`), entityType: "LEARNING_RULE", orgId: ORG_A, id: filler, suggestionId: filler, stage: "build", text: `Filler rule ${String(n)}.`, processAgentId: layer, requestId: filler, status: "active", processVersion: 1, projectCreatedAt: SCOPE.projectCreatedAt });
    }
    expect(await settleProject(decideDeps(w), SCOPE)).toBe(1);
    expect(item(w, `RULE#${suggestionOf(w, id).ruleId as string}`)).toMatchObject({ status: "active", processVersion: 2 });
  });
});

describe("erase never lets a pending approval publish erased words", () => {
  it("an awaiting suggestion that still has 2 other sources is withdrawn, its rule is not applied and loses its words, and the draft goes back", async () => {
    const w = world();
    const layer = await processLayer(w);
    const id = await suggest(w, { stage: "review", sources: [{ author: PRIYA, task: "t1", text: RETRY_A }, { author: ARJUN, task: "t2", text: RETRY_B }, { author: MAX, task: "t3", text: RETRY_A }] });
    const waiting = await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id, RETRY_A));
    const approvalId = approvalIdOf(w, waiting);
    const ruleId = suggestionOf(w, id).ruleId as string;
    expect((await w.store.getDraft(ORG_A, layer))!.overlay).toEqual({ steps: { review: { instructions: RETRY_A } } });

    await eraseLearningSubject(learning(w), ORG_A, PRIYA);

    expect(suggestionOf(w, id)).toMatchObject({ status: "withdrawn" });
    expect(suggestionOf(w, id).proposedText).toBeUndefined();
    expect(item(w, `RULE#${ruleId}`)).toMatchObject({ status: "not_applied" });
    expect(JSON.stringify(item(w, `RULE#${ruleId}`))).not.toContain("retry helper");
    expect(item(w, "STATE")).toMatchObject({ pendingRules: 0, openSuggestions: 0 });
    expect((await w.store.getDraft(ORG_A, layer))!.overlay).toEqual({});
    // The approval, if a person confirms it now, publishes nothing.
    await decide(w, OLA, approvalId).catch(() => undefined);
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(1);
    expect(JSON.stringify(await notesOf(w, layer))).not.toContain("retry");
  });
});


describe("canDecide is per suggestion, from the rule Accept authorises by", () => {
  const viewOf = async (w: MergeWorld, who: string) => (await viewLearning(decideDeps(w), callerOf(w, who), "web")).suggestions[0]!;

  /** Both directions: what the screen says, and whether Accept lets the person through the authority check. */
  async function agree(w: MergeWorld, who: string, id: string, expected: boolean) {
    const seen = await viewOf(w, who).then((one) => one.canDecide, (error: { code?: string }) => error.code);
    const refusal = await failure(acceptSuggestion(decideDeps(w), callerOf(w, who), "web", id, acceptBody(w, id)));
    if (expected) {
      expect(seen).toBe(true);
      expect(refusal?.code).not.toBe("FORBIDDEN");
      expect(refusal?.code).not.toBe("PROJECT_NOT_FOUND");
    } else {
      expect(seen === false || seen === "PROJECT_NOT_FOUND").toBe(true);
      expect(["FORBIDDEN", "PROJECT_NOT_FOUND"]).toContain(refusal?.code);
    }
  }

  it("a maintainer: true, and Accept goes through", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w);
    await agree(w, MAX, id, true);
  });

  it("a contributor who wrote a source: false, and Accept refuses (being the author grants nothing)", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w);
    await agree(w, ARJUN, id, false);
  });

  it("a maintainer who wrote a source: true, and Accept goes through", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w, { sources: [{ author: MAX, task: "t1", text: RETRY_A }, { author: ARJUN, task: "t2", text: RETRY_B }] });
    await agree(w, MAX, id, true);
  });

  it("an org admin (edit rights through the company role): view and Accept agree", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w);
    const seen = (await viewLearning(decideDeps(w), callerOf(w, OLA), "web")).suggestions[0]!.canDecide;
    const refusal = await failure(acceptSuggestion(decideDeps(w), callerOf(w, OLA), "web", id, acceptBody(w, id)));
    // An org admin holds How we work edit rights through the company role: the screen offers Accept and Accept succeeds.
    expect(seen).toBe(true);
    expect(refusal).toBeUndefined();
  });

  it("view and Accept agree for every role", async () => {
    for (const [who, expected] of [[MAX, true], [PRIYA, false], [ARJUN, false], [MIA, false]] as const) {
      const w = world();
      await processLayer(w);
      const id = await suggest(w);
      await agree(w, who, id, expected);
    }
  });

  it("an author who has lost standing (now a viewer): false, and Accept refuses", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w);
    w.db.set({ ...projectMemberKey(ORG_A, ARJUN, "web"), entityType: "MEMBERSHIP", ownerKey: ARJUN, projectName: "web", grantId: randomUUID(), role: "viewer", projectRole: "viewer" });
    w.members.grant(ORG_A, "web", ARJUN, "viewer");
    await agree(w, ARJUN, id, false);
  });

  it("a contributor who wrote none of the sources: false, and Accept refuses", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w, { sources: [{ author: MAX, task: "t1", text: RETRY_A }, { author: OLA, task: "t2", text: RETRY_B }] });
    await agree(w, PRIYA, id, false);
  });

  it("a viewer: false, and Accept refuses; a person with no place in the project cannot even read it", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w);
    await agree(w, MIA, id, false);
    await agree(w, "f".repeat(64), id, false);
  });

  it("a contributor sees false on every suggestion, including the one they wrote", async () => {
    const w = world();
    await processLayer(w);
    await suggest(w, { sources: [{ author: PRIYA, task: "t1", text: RETRY_A }, { author: ARJUN, task: "t2", text: RETRY_B }] });
    await suggest(w, { stage: "plan", sources: [{ author: MAX, task: "t3", text: "Name database migrations with the date prefix and a short description." }, { author: OLA, task: "t4", text: "Database migrations need a date prefix in the name and a short description." }] });
    const view = await viewLearning(decideDeps(w), callerOf(w, PRIYA), "web");
    expect(view.suggestions).toHaveLength(2);
    expect(view.suggestions.every((one) => one.canDecide === false)).toBe(true);
    expect(view.canDecide).toBe(false);
  });

  it("keeps the tightening: a viewer sees the fixed phrase and no proposed text; a member sees the words", async () => {
    const w = world();
    await processLayer(w);
    await suggest(w);
    const viewer = await viewOf(w, MIA);
    expect(viewer.proposedText).toBeUndefined();
    expect(viewer.sources.every((source) => source.label === "A correction from a project member")).toBe(true);
    expect((await viewOf(w, ARJUN)).proposedText).toBeDefined();
  });
});


describe("erase emits rule.withdrawn with the cause `erased`, through the wiring the broker uses", () => {
  const erasedEvents = (w: MergeWorld) => eventsOf(w, "rule.withdrawn").filter((event) => event.facts?.cause === "erased");

  it("the helper the broker builds its erase and resume dependencies with carries the ledger", () => {
    const w = world();
    expect(learningWalkDeps({ documentClient: w.db, tableName: "state", now: () => 1, audit: w.audit.audit }).audit).toBe(w.audit.audit);
    expect("audit" in learningWalkDeps({ documentClient: w.db, tableName: "state", now: () => 1 })).toBe(false);
  });

  it("broker.ts builds both the erase hook and the walk-resume job through it, with the install's ledger", () => {
    const source = readBrokerSource();
    expect(source).toMatch(/eraseLearning: learningEraseHook\(learningWalkDeps\(\{[^}]*audit[^}]*\}\)[,)]/);
    expect(source).toMatch(/resumeOpenLearningWalks\(learningWalkDeps\(\{[^}]*audit: dependencies\.audit[^}]*\}\)/);
  });

  it("an erase run with those dependencies writes one rule.withdrawn (erased) per withdrawn suggestion", async () => {
    const w = world();
    await processLayer(w);
    const first = await suggest(w, { sources: [{ author: PRIYA, task: "t1", text: MARK_A_TEXT }, { author: ARJUN, task: "t2", text: MARK_B_TEXT }] });
    await eraseLearningSubject(learningWalkDeps({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit }), ORG_A, PRIYA);
    expect(suggestionOf(w, first)).toMatchObject({ status: "withdrawn" });
    expect(erasedEvents(w)).toHaveLength(1);
    expect(erasedEvents(w)[0]).toMatchObject({ actor: { kind: "system" }, facts: { suggestionId: first, stage: "build", cause: "erased" } });
    expect(JSON.stringify(erasedEvents(w))).not.toContain(PRIYA);
  });

  it("a walk that stopped at its budget and was finished by the scheduled resume emits it too", async () => {
    const w = world();
    await processLayer(w);
    const first = await suggest(w, { sources: [{ author: PRIYA, task: "t1", text: MARK_A_TEXT }, { author: ARJUN, task: "t2", text: MARK_B_TEXT }] });
    const deps = learningWalkDeps({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit });
    expect((await eraseLearningSubject(deps, ORG_A, PRIYA, { writes: 1 })).status).toBe("running");
    for (let tick = 0; tick < 10 && w.db.find((entry) => entry.pk === "LEARNING_WALKS_OPEN").length > 0; tick += 1) await resumeOpenLearningWalks(deps, { writes: 5 });
    expect(suggestionOf(w, first)).toMatchObject({ status: "withdrawn" });
    expect(erasedEvents(w)).toHaveLength(1);
  });

  it("a suggestion of an earlier project instance that is withdrawn by the erase has its event too", async () => {
    const w = world();
    await processLayer(w);
    const old = "2026-01-01T00:00:00.000Z";
    w.db.set({ ...projectLearningKey(ORG_A, "web", "CORRECTION#2026-01-02T00:00:00.000Z#oldc"), entityType: "LEARNING_CORRECTION", orgId: ORG_A, id: "oldc", stage: "build", source: "comment", taskId: "told", sourceRef: { taskId: "told" }, signature: ["h"], author: PRIYA, standing: "member", text: "old words", createdAt: "2026-01-02T00:00:00.000Z", projectCreatedAt: old });
    w.db.set({ ...projectLearningKey(ORG_A, "web", "SUGGESTION#olds"), entityType: "LEARNING_SUGGESTION", orgId: ORG_A, id: "olds", stage: "plan", status: "open", correctionIds: ["oldc", "oldd"], allFromOnePerson: false, proposedText: "old words", signature: ["h"], lessSafe: false, kinds: [], overlaps: [], revision: 0, createdAt: "2026-01-02T00:00:00.000Z", projectCreatedAt: old });
    await suggest(w);
    await eraseLearningSubject(learningWalkDeps({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit }), ORG_A, PRIYA);
    expect(item(w, "SUGGESTION#olds")).toMatchObject({ status: "withdrawn" });
    expect(item(w, "SUGGESTION#olds")).not.toHaveProperty("proposedText");
    expect(erasedEvents(w).some((event) => event.facts?.suggestionId === "olds" && event.facts?.stage === "plan")).toBe(true);
  });
});
const MARK_A_TEXT = "Use the shared retry helper for network calls, with exponential backoff, ZEBRAMARK.";
const MARK_B_TEXT = "Use the shared retry helper for network calls, with exponential backoff and jitter, QUOKKAMARK.";

describe("the company's master suggestions switch: deciding is gated, settlement and rules are not", () => {
  const setSwitch = (w: MergeWorld, suggestions: "on" | "off", revision: number) => w.db.set({
    ...orgLearningSettingsKey(ORG_A), entityType: "LEARNING_COMPANY_SETTINGS", orgId: ORG_A, revision, suggestions, changedBy: MAX, changedAt: new Date(w.clock.now).toISOString(),
  });

  it("Accept, Dismiss and Reopen answer 409 LEARNING_SUGGESTIONS_OFF while off and change nothing; the suggestion is there unchanged when the switch is on again", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w);
    const second = await suggest(w, { sources: [{ author: PRIYA, task: "t3", text: "Name database migrations with a date prefix and a short description." }, { author: ARJUN, task: "t4", text: "Database migrations need a date prefix in the name and a short description." }] });
    await dismissSuggestion(decideDeps(w), callerOf(w, MAX), "web", second, { expectedRevision: 0, dismissKind: "wrong" });
    const [dismissed] = w.db.find((entry) => String(entry.sk).startsWith("DISMISSED#"));
    const dismissedId = String(dismissed!.sk).slice("DISMISSED#".length);
    const before = JSON.stringify([...w.db.items.entries()]);
    setSwitch(w, "off", 1);
    const afterSwitch = JSON.stringify([...w.db.items.entries()]);
    expect(await failure(acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id)))).toMatchObject({ code: "LEARNING_SUGGESTIONS_OFF" });
    expect(await failure(dismissSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, { expectedRevision: 0, dismissKind: "wrong" }))).toMatchObject({ code: "LEARNING_SUGGESTIONS_OFF" });
    expect(await failure(reopenDismissed(decideDeps(w), callerOf(w, MAX), "web", dismissedId))).toMatchObject({ code: "LEARNING_SUGGESTIONS_OFF" });
    expect(JSON.stringify([...w.db.items.entries()])).toBe(afterSwitch);
    expect(before).not.toBe(afterSwitch);
    expect(suggestionOf(w, id)).toMatchObject({ status: "open", revision: 0 });
    setSwitch(w, "on", 2);
    expect(await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id))).toMatchObject({ outcome: "published" });
  });

  it("with no company record the install default decides: off refuses, on allows", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w);
    vi.stubEnv("LEARNING_SUGGESTIONS_DEFAULT", "off");
    expect(await failure(acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id)))).toMatchObject({ code: "LEARNING_SUGGESTIONS_OFF" });
    vi.stubEnv("LEARNING_SUGGESTIONS_DEFAULT", "on");
    expect(await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id))).toMatchObject({ outcome: "published" });
  });

  it("an awaiting_approval suggestion still settles while off (settlement is never gated), and the accepted rule can still be removed", async () => {
    const w = world();
    const layer = await processLayer(w);
    const id = await suggest(w, { stage: "review" });
    const answer = await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id));
    expect(answer.outcome).toBe("awaiting_approval");
    setSwitch(w, "off", 1);
    await decide(w, OLA, approvalIdOf(w, answer));
    expect(await settleProject(decideDeps(w), SCOPE)).toBe(1);
    const ruleId = suggestionOf(w, id).ruleId as string;
    expect(item(w, `RULE#${ruleId}`)).toMatchObject({ status: "active", processVersion: 2 });
    expect(suggestionOf(w, id)).toMatchObject({ status: "accepted" });
    expect(eventsOf(w, "rule.accepted").map((event) => event.facts?.outcome)).toEqual(["awaiting_approval", "published"]);
    // Rules, remove and the view's rules list keep working with the switch off.
    const viewDeps = decideDeps(w);
    expect((await viewLearning({ documentClient: w.db, tableName: "state", now: () => w.clock.now, projectFor: (who, rawName) => viewDeps.projectFor(who, rawName) }, callerOf(w, MAX), "web")).rules).toHaveLength(1);
    expect(await removeRule(decideDeps(w), callerOf(w, MAX), "web", ruleId, { requestId: randomUUID() })).toSatisfy((answer: { outcome: string }) => ["published", "awaiting_approval"].includes(answer.outcome));
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBeGreaterThanOrEqual(2);
  });

  it("a declined approval while off also settles: the suggestion goes back to open (still hidden) and the rule is not applied", async () => {
    const w = world();
    await processLayer(w);
    const id = await suggest(w, { stage: "review" });
    const answer = await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id));
    const ruleId = suggestionOf(w, id).ruleId as string;
    setSwitch(w, "off", 1);
    await decide(w, OLA, approvalIdOf(w, answer), "DECLINE");
    expect(await settleProject(decideDeps(w), SCOPE)).toBe(1);
    expect(item(w, `RULE#${ruleId}`)).toMatchObject({ status: "not_applied" });
    expect(suggestionOf(w, id)).toMatchObject({ status: "open" });
  });
});
