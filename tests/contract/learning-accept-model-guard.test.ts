// v1.2 learning loop: Accept goes through the same model check as a How-we-work publish. A suggestion whose resulting draft has an unresolvable or company-locked model is refused with the
// resolver's own code (409, stage, fix page), creates no process version, and leaves the suggestion open and unchanged: no pending rule, no rule.accepted audit, the draft as it was.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bedrockClaudeModelIds } from "@agentx/model-runtime/catalog";
import { agentXError, canonicalModelName, orgMetaKey, projectLearningKey, projectRevisionKey, type AgentId } from "../../packages/contracts/src/index.js";
import { publishDraft } from "../../packages/broker/src/agents/changes.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { acceptSuggestion } from "../../packages/broker/src/learning/decide.js";
import { postProjectProcess } from "../../packages/broker/src/playbook/process-layer.js";
import type { LearningDecideDeps } from "../../packages/broker/src/learning/settle.js";
import { signatureOf } from "../../packages/broker/src/learning/similarity.js";
import { learningSalt } from "../../packages/broker/src/learning/standing.js";
import { captureCorrection } from "../../packages/broker/src/learning/store.js";
import { groupCorrections } from "../../packages/broker/src/learning/grouping.js";
import { ARJUN, MAX, OLA, ORG_A, PRIYA } from "../support/agent-session-world.js";
import { mergeWorld as baseWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";

const SCOPE = { orgId: ORG_A, project: "web", projectCreatedAt: "2026-10-02T00:00:00.000Z" };
const RETRY_A = "Use the shared retry helper for network calls, with exponential backoff.";
const RETRY_B = "Use the shared retry helper for network calls, with exponential backoff and jitter on every attempt.";
const RULE = "Use the shared retry helper for network calls.";
const ROLES: Record<string, "admin" | "member"> = { [OLA]: "admin" };
const [MODEL_A, MODEL_B, MODEL_C] = [...new Map(bedrockClaudeModelIds("us").map((modelId) => ({ provider: "amazon-bedrock", modelId })).map((model) => [canonicalModelName(model), model])).values()];
const UNVERIFIED = { provider: "openai", modelId: "gpt-5" };

const callerOf = (w: MergeWorld, who: string) => ({ ...w.caller(who), orgRole: ROLES[who] ?? ("member" as const) });
const definition = (models?: unknown) => ({ name: "web", revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work.", ...(models === undefined ? {} : { models }) });
const setProject = (w: MergeWorld, models?: unknown) => w.db.set({ ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT", registeredAt: "2026-10-01T00:00:00Z", definition: definition(models), runtimeBinding: {} });
function world(): MergeWorld {
  const w = baseWorld();
  const store = new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit });
  (w.deps as { store: AgentStore }).store = store;
  w.store = store;
  w.db.set({ ...orgMetaKey(ORG_A), orgId: ORG_A, createdAt: "2026-10-01T00:00:00.000Z" });
  setProject(w);
  // The company can serve the unverified model (a source lists it) but nothing proves access to it for this account.
  (w.deps as { servableModels?: unknown }).servableModels = async () => [...bedrockClaudeModelIds("us").map((modelId) => ({ provider: "amazon-bedrock", modelId })), UNVERIFIED];
  return w;
}
function decideDeps(w: MergeWorld): LearningDecideDeps {
  return {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, store: w.store, audit: w.audit.audit, approvals: w.deps,
    projectFor: async (caller, rawName) => {
      const role = await w.members.roleOf(caller.orgId, rawName, { developerId: caller.developerId, orgRole: ROLES[caller.developerId] ?? "member" });
      if (role === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
      return { name: rawName, role };
    },
  };
}
const learning = (w: MergeWorld) => ({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit });
const item = (w: MergeWorld, sk: string) => w.db.get(projectLearningKey(ORG_A, "web", sk)) as Record<string, unknown> | undefined;
const suggestionOf = (w: MergeWorld, id: string) => item(w, `SUGGESTION#${id}`)!;
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; status?: number; statusCode?: number; stage?: string; fixHref?: string }) => ({ code: error.code, stage: error.stage, fixHref: error.fixHref, status: error.statusCode ?? error.status }));
const lock = (w: MergeWorld, stepOverrides: unknown) => w.db.set({ pk: `ORG#${ORG_A}#SETTINGS`, sk: "MODEL_SELECTION_POLICY", orgId: ORG_A, entityType: "MODEL_SELECTION_POLICY", version: 1, revision: 1, rankingVersion: "g3-v1", stepOverrides });
const rules = (w: MergeWorld) => w.db.find((entry) => String(entry.sk).startsWith("RULE#"));

async function processLayer(w: MergeWorld): Promise<AgentId> {
  const { agentId } = await postProjectProcess(decideDeps(w), callerOf(w, MAX), "web");
  const agent = (await w.store.get(ORG_A, agentId))!;
  expect(await publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision })).toMatchObject({ applied: true });
  return agentId;
}
async function suggest(w: MergeWorld): Promise<string> {
  let n = 0;
  for (const source of [{ author: PRIYA, task: "t1", text: RETRY_A }, { author: ARJUN, task: "t2", text: RETRY_B }]) {
    n += 1;
    w.clock.now += 1000;
    const result = await captureCorrection(learning(w), SCOPE, {
      id: `c${randomUUID().slice(0, 8)}${n}`, stage: "build", source: "comment", sourceKey: `key-${randomUUID()}`, sourceRef: { taskId: source.task }, taskId: source.task, text: source.text,
      signature: [...signatureOf(source.text, learningSalt(SCOPE))], author: source.author, standing: "member", limit: "automatic",
    });
    expect(result).toMatchObject({ ok: true, created: true });
  }
  const grouped = await groupCorrections(learning(w), SCOPE, { prCaptureOff: async () => false });
  expect(grouped.opened).toHaveLength(1);
  return grouped.opened[0]!;
}
const acceptBody = (w: MergeWorld, id: string) => ({ requestId: randomUUID(), expectedRevision: suggestionOf(w, id).revision, stage: suggestionOf(w, id).stage, text: RULE });

/** What Accept leaves behind when the model check refuses: no version, the draft as it was, the suggestion open again, the rule `not_applied` (never left pending) and no rule.accepted. */
async function expectUntouched(w: MergeWorld, layer: AgentId, id: string, before: { overlay: unknown; version: number | undefined }) {
  expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(before.version);
  // The draft is put back as it was (its revision moves on, as for any save).
  expect((await w.store.getDraft(ORG_A, layer))!.overlay).toEqual(before.overlay);
  expect(suggestionOf(w, id)).toMatchObject({ status: "open" });
  expect(rules(w).map((rule) => rule.status)).toEqual(["not_applied"]);
  expect(w.audit.recordedBy("rule.accepted")).toEqual([]);
}
const snapshotOf = async (w: MergeWorld, layer: AgentId) => ({ overlay: (await w.store.getDraft(ORG_A, layer))!.overlay, version: (await w.store.get(ORG_A, layer))!.currentVersion });

describe("Accept runs the How-we-work model check (a refusal changes nothing)", () => {
  it("refuses with LOCK_UNSATISFIABLE when a company lock puts the stage on a model nothing verifies", async () => {
    const w = world();
    const layer = await processLayer(w);
    lock(w, { build: { model: UNVERIFIED, thinkingLevel: null, locked: true } });
    const id = await suggest(w);
    const before = await snapshotOf(w, layer);
    expect(await failure(acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id)))).toEqual({ code: "LOCK_UNSATISFIABLE", stage: "build", fixHref: "/app/admin/how-we-work", status: 409 });
    await expectUntouched(w, layer, id, before);
    // Nothing is left blocking the layer: once the company lock is lifted the same suggestion accepts.
    w.db.delete({ pk: `ORG#${ORG_A}#SETTINGS`, sk: "MODEL_SELECTION_POLICY" });
    expect(await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id))).toEqual({ outcome: "published", version: 2 });
  });

  it("refuses with MODEL_NOT_ALLOWED_IN_PROJECT when the stage's model is no longer allowed in the project", async () => {
    const w = world();
    const layer = await processLayer(w);
    // The published version carries a model the project then stops allowing; the rule changes another part of the same stage, so the stale choice is re-checked.
    const agent = (await w.store.get(ORG_A, layer))!;
    await w.store.saveDraft({ orgId: ORG_A, agentId: layer, overlay: { steps: { build: { model: MODEL_B } } }, expectedRevision: agent.draftRevision, by: MAX });
    const published = await publishDraft(w.deps, callerOf(w, MAX), (await w.store.get(ORG_A, layer))!, { requestId: randomUUID(), expectedRevision: (await w.store.get(ORG_A, layer))!.draftRevision });
    if (!published.applied) {
      const { decideApproval } = await import("../../packages/broker/src/agents/approvals.js");
      await decideApproval(w.deps, callerOf(w, OLA), w.approvalIdOf((published as unknown as { confirmUrl: string }).confirmUrl), { requestId: randomUUID(), decision: "APPROVE" });
    }
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(2);
    setProject(w, { approved: [MODEL_A, MODEL_C], default: MODEL_A });
    const id = await suggest(w);
    const before = await snapshotOf(w, layer);
    expect(await failure(acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, acceptBody(w, id)))).toEqual({ code: "MODEL_NOT_ALLOWED_IN_PROJECT", stage: "build", fixHref: "/app/admin/how-we-work", status: 409 });
    await expectUntouched(w, layer, id, before);
  });
});
