// V3: a project's process layer cannot be published, confirmed or rolled back to while one of its model choices can't be resolved by lane C's resolver. The refusal carries the resolver's
// fixed codes (and the page to fix them on) in the existing error shape; nothing is stored and no approval is made. A draft save never asks, and a layer with no model choices (and an
// ordinary agent) publishes exactly as before.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectRevisionKey, ROVARA_CODE_AGENT_ID, type AgentId } from "../../packages/contracts/src/index.js";
import { parseStageRefusalMessage } from "../../packages/contracts/src/stage-model-publish-refusal.js";
import { bedrockClaudeModelIds } from "@agentx/model-runtime/catalog";
import { decideApproval, getAnyApproval } from "../../packages/broker/src/agents/approvals.js";
import { publishDraft, resolveRecipe, rollbackAgent } from "../../packages/broker/src/agents/changes.js";
import { diffLessSafe } from "../../packages/broker/src/playbook/process-diff.js";
import { MAX, OLA, ORG_A } from "../support/agent-session-world.js";
import { callerOf, failure, layerWith, world as baseWorld } from "../support/process-switch-world.js";
import type { MergeWorld } from "../support/rovara-code-merge-world.js";

const [MODEL_A, MODEL_B] = bedrockClaudeModelIds("us").map((modelId) => ({ provider: "amazon-bedrock", modelId }));
const UNVERIFIED = { provider: "openai", modelId: "gpt-5" };
const definition = (models?: unknown) => ({ name: "web", revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work.", ...(models === undefined ? {} : { models }) });
const setProject = (w: MergeWorld, models?: unknown) => w.db.set({ ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT", registeredAt: "2026-10-01T00:00:00Z", definition: definition(models), runtimeBinding: {} });
function world(): MergeWorld {
  const w = baseWorld();
  setProject(w);
  // The company can serve the unverified model (a source lists it) but nothing proves access to it for this account.
  (w.deps as { servableModels?: unknown }).servableModels = async () => [...bedrockClaudeModelIds("us").map((modelId) => ({ provider: "amazon-bedrock", modelId })), UNVERIFIED];
  return w;
}
const setDraft = async (w: MergeWorld, agentId: AgentId, steps: Record<string, unknown>) => {
  const agent = (await w.store.get(ORG_A, agentId))!;
  await w.store.saveDraft({ orgId: ORG_A, agentId, overlay: { steps } as never, expectedRevision: agent.draftRevision, by: MAX });
};
const publish = async (w: MergeWorld, agentId: AgentId, who = MAX) => {
  const agent = (await w.store.get(ORG_A, agentId))!;
  return publishDraft(w.deps, callerOf(w, who), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
};
const approvals = (w: MergeWorld) => [...w.db.items.values()].filter((item) => item["entityType"] === "APPROVAL").length;
const versions = async (w: MergeWorld, agentId: AgentId) => { const agent = (await w.store.get(ORG_A, agentId))!; return { current: agent.currentVersion, latest: (agent as { latestVersion?: number }).latestVersion }; };
const refusalOf = (error: { code: string | undefined; message: string } | undefined) => ({ code: error?.code, items: parseStageRefusalMessage((error?.message ?? "").replace(/^[A-Z_]+: /u, "")) });
const lock = (w: MergeWorld, stepOverrides: unknown) => w.db.set({ pk: `ORG#${ORG_A}#SETTINGS`, sk: "MODEL_SELECTION_POLICY", orgId: ORG_A, entityType: "MODEL_SELECTION_POLICY", version: 1, revision: 1, rankingVersion: "g3-v1", stepOverrides });
const decide = (w: MergeWorld, who: string, approvalId: string) => decideApproval(w.deps, callerOf(w, who), approvalId, { requestId: randomUUID(), decision: "APPROVE" });
const approvalIdOf = (w: MergeWorld, result: unknown) => w.approvalIdOf((result as { confirmUrl: string }).confirmUrl);

describe("publishing a process layer checks its model choices", () => {
  it("refuses an unverified model: MODEL_NOT_VERIFIED with its fix page, no version and no approval", async () => {
    const w = world();
    const layer = await layerWith(w);
    await setDraft(w, layer, { build: { model: UNVERIFIED } });
    const before = approvals(w);
    const refused = await failure(publish(w, layer));
    expect(refusalOf(refused)).toEqual({ code: "CONFIG_INVALID", items: [{ code: "MODEL_NOT_VERIFIED", stage: "build", fixHref: "/app/admin/models/sources" }] });
    expect(await versions(w, layer)).toEqual({ current: 1, latest: 1 });
    expect(approvals(w)).toBe(before);
  });

  it("refuses a model that conflicts with a company lock: STAGE_LOCKED, and lists nothing the company did not lock", async () => {
    const w = world();
    const layer = await layerWith(w);
    lock(w, { build: { model: MODEL_A, thinkingLevel: null, locked: true } });
    await setDraft(w, layer, { build: { model: MODEL_B } });
    const refused = await failure(publish(w, layer));
    expect(refusalOf(refused)).toEqual({ code: "CONFIG_INVALID", items: [{ code: "STAGE_LOCKED", stage: "build", fixHref: "/app/admin/how-we-work" }] });
    expect(await versions(w, layer)).toEqual({ current: 1, latest: 1 });
    expect(approvals(w)).toBe(0);
  });

  it("does not call a choice that matches the company lock a conflict", async () => {
    const w = world();
    const layer = await layerWith(w);
    lock(w, { build: { model: MODEL_A, thinkingLevel: null, locked: true } });
    await setDraft(w, layer, { build: { model: MODEL_A } });
    expect(await failure(publish(w, layer))).toBeUndefined();
  });

  it("keeps a choice the company lock later overrode when the draft leaves it as it was published", async () => {
    const w = world();
    const layer = await layerWith(w);
    await setDraft(w, layer, { build: { model: MODEL_B } });
    const first = await publish(w, layer);
    if (!first.applied) await decide(w, OLA, approvalIdOf(w, first));
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(2);
    lock(w, { build: { model: MODEL_A, thinkingLevel: null, locked: true } });
    await setDraft(w, layer, { build: { model: MODEL_B }, plan: { instructions: "Keep plans short." } });
    expect(await failure(publish(w, layer))).toBeUndefined();
  });

  it("publishes a valid choice", async () => {
    const w = world();
    const layer = await layerWith(w);
    await setDraft(w, layer, { build: { model: MODEL_B, thinkingLevel: "low" } });
    const result = await publish(w, layer);
    // A model from a company the version never used waits for a second person (the ordinary rule); it is not refused.
    if (!result.applied) await decide(w, OLA, approvalIdOf(w, result));
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(2);
  });

  it("refuses a pending less-safe publish at confirm when its choice can no longer be resolved", async () => {
    const w = world();
    const layer = await layerWith(w);
    await setDraft(w, layer, { build: { model: MODEL_B }, review: { instructions: "Be strict about tests." } });
    const waiting = await publish(w, layer);
    expect(waiting.applied).toBe(false);
    // Before the second person confirms, the project stops allowing that model.
    setProject(w, { approved: [MODEL_A], default: MODEL_A });
    const approvalId = approvalIdOf(w, waiting);
    await failure(decide(w, OLA, approvalId));
    const ended = await getAnyApproval(w.deps, ORG_A, approvalId) as { status?: string; failure?: string } | undefined;
    expect(ended?.status).toBe("APPROVED_FAILED");
    expect(ended?.failure).toContain("MODEL_NOT_ALLOWED_IN_PROJECT build");
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(1);
  });

  it("refuses a rollback to a version whose choice can no longer be resolved", async () => {
    const w = world();
    const layer = await layerWith(w);
    await setDraft(w, layer, { build: { model: MODEL_B } });
    const second = await publish(w, layer);
    if (!second.applied) await decide(w, OLA, approvalIdOf(w, second));
    await setDraft(w, layer, { build: { thinkingLevel: "low" } });
    await publish(w, layer);
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(3);
    setProject(w, { approved: [MODEL_A], default: MODEL_A });
    const refused = await failure(rollbackAgent(w.deps, callerOf(w, MAX), (await w.store.get(ORG_A, layer))!, { requestId: randomUUID(), version: 2 }));
    expect(refusalOf(refused)).toEqual({ code: "CONFIG_INVALID", items: [{ code: "MODEL_NOT_ALLOWED_IN_PROJECT", stage: "build", fixHref: "/app/projects/web" }] });
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(3);
  });

  it("refuses a pending rollback at confirm when the choice of the version it goes back to can no longer be resolved", async () => {
    const w = world();
    const layer = await layerWith(w);
    const settle = async (result: Awaited<ReturnType<typeof publish>>) => { if (!result.applied) await decide(w, OLA, approvalIdOf(w, result)); };
    await setDraft(w, layer, { build: { model: MODEL_B } });
    await settle(await publish(w, layer));
    await setDraft(w, layer, { build: { model: MODEL_B }, review: { instructions: "Be strict about tests." } });
    await settle(await publish(w, layer));
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(3);
    // Going back to version 2 drops the review instructions, so it waits for a second person.
    const waiting = await rollbackAgent(w.deps, callerOf(w, MAX), (await w.store.get(ORG_A, layer))!, { requestId: randomUUID(), version: 2 });
    expect(waiting.applied).toBe(false);
    setProject(w, { approved: [MODEL_A], default: MODEL_A });
    const approvalId = approvalIdOf(w, waiting);
    await failure(decide(w, OLA, approvalId));
    const ended = await getAnyApproval(w.deps, ORG_A, approvalId) as { status?: string; failure?: string } | undefined;
    expect(ended?.status).toBe("APPROVED_FAILED");
    expect(ended?.failure).toContain("MODEL_NOT_ALLOWED_IN_PROJECT build");
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(3);
  });

  it("lists the same less-safe reasons in Review changes as the publish waits for, model reasons included", async () => {
    const w = world();
    const layer = await layerWith(w);
    // A model from an AI company the version never used: the model part of the classifier flags it.
    await setDraft(w, layer, { build: { model: MODEL_B } });
    const waiting = await publish(w, layer);
    expect(waiting.applied).toBe(false);
    const agent = (await w.store.get(ORG_A, layer))!;
    const shown = diffLessSafe(agent, await resolveRecipe(w.deps, ORG_A, layer, 1), await resolveRecipe(w.deps, ORG_A, layer, "draft"), 1);
    const gate = (waiting as unknown as { changes: string[] }).changes;
    expect(gate).toEqual([expect.stringContaining("new AI company")]);
    expect(shown).toEqual(gate);
  });

  it("refuses, for now, a reviewer picked on Build's own model: the resolver has no approval to accept yet (see the V3 report)", async () => {
    const w = world();
    const layer = await layerWith(w);
    await setDraft(w, layer, { build: { model: MODEL_B }, review: { model: MODEL_B } });
    expect(refusalOf(await failure(publish(w, layer)))).toEqual({ code: "CONFIG_INVALID", items: [{ code: "DIFFERENT_FROM_UNSATISFIABLE", stage: "code_review", fixHref: "/app/admin/models/sources" }, { code: "DIFFERENT_FROM_UNSATISFIABLE", stage: "security_review", fixHref: "/app/admin/models/sources" }] });
    expect(approvals(w)).toBe(0);
  });

  it("checks a personal-plan model for the person who asked, also when someone else confirms", async () => {
    const w = world();
    const plan = { provider: "openai", modelId: "gpt-5.5" };
    (w.deps as { servableModels?: unknown }).servableModels = async () => [...bedrockClaudeModelIds("us").map((modelId) => ({ provider: "amazon-bedrock", modelId })), plan];
    // Only Max has connected a ChatGPT plan that lists the model.
    (w.deps as { chatgpt?: unknown }).chatgpt = {
      settings: async () => ({ enabled: true }),
      view: async (developerId: string) => developerId === MAX ? { connected: true, status: "connected", connectedAt: "2026-10-01T00:00:00Z", models: ["gpt-5.5"] } : { connected: false },
    };
    const layer = await layerWith(w);
    await setDraft(w, layer, { build: { model: plan }, review: { instructions: "Be strict about tests." } });
    const waiting = await publish(w, layer);
    expect(waiting.applied).toBe(false);
    await decide(w, OLA, approvalIdOf(w, waiting));
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(2);
    // The same choice is not verified for Ola, who has no plan: she cannot publish it herself.
    await setDraft(w, layer, { build: { model: plan }, plan: { instructions: "Keep plans short." } });
    expect(refusalOf(await failure(publish(w, layer, OLA)))).toMatchObject({ code: "CONFIG_INVALID", items: [{ code: "MODEL_NOT_VERIFIED", stage: "build" }] });
  });

  it("saves a draft with an unverified model: only publishing asks", async () => {
    const w = world();
    const layer = await layerWith(w);
    await expect(setDraft(w, layer, { build: { model: UNVERIFIED } })).resolves.toBeUndefined();
  });

  it("publishes a layer with no model choices exactly as before, without reading the model settings", async () => {
    const w = world();
    const layer = await layerWith(w);
    // Anything the resolver would read is broken: a layer with no choices must not need it.
    w.db.set({ ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT", definition: { bad: true } });
    w.db.set({ pk: `ORG#${ORG_A}#SETTINGS`, sk: "MODEL_SELECTION_POLICY", orgId: ORG_A, entityType: "MODEL_SELECTION_POLICY", version: 9 });
    await setDraft(w, layer, { build: { instructions: "Run the linter before you finish." } });
    expect(await publish(w, layer)).toMatchObject({ applied: true, value: { version: 2 } });
  });

  it("leaves an ordinary agent alone, whatever model it names", async () => {
    const w = world();
    const created = await w.store.create({ orgId: ORG_A, name: "reviewer", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, createdBy: MAX });
    expect(await publish(w, created.agentId)).toMatchObject({ applied: true });
    await setDraft(w, created.agentId, { build: { model: UNVERIFIED } });
    expect(await failure(publish(w, created.agentId))).toBeUndefined();
  });

  it("answers an unreadable model setting as unavailable, never as a pass", async () => {
    const w = world();
    const layer = await layerWith(w);
    await setDraft(w, layer, { build: { model: MODEL_B } });
    w.db.set({ ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT", definition: { bad: true } });
    expect(await failure(publish(w, layer))).toMatchObject({ code: "RUNTIME_UNAVAILABLE", status: 503 });
    expect(await versions(w, layer)).toEqual({ current: 1, latest: 1 });
  });
});

describe("the refusal text", () => {
  it("is exactly what the page parses, and nothing else parses", () => {
    expect(parseStageRefusalMessage("MODEL_NOT_VERIFIED: nothing")).toBeUndefined();
    expect(parseStageRefusalMessage("Model choices can't be published: BOGUS build")).toBeUndefined();
    expect(parseStageRefusalMessage("Model choices can't be published: STAGE_LOCKED build //evil.example")).toBeUndefined();
    expect(parseStageRefusalMessage("Model choices can't be published: STAGE_LOCKED nowhere")).toBeUndefined();
    expect(parseStageRefusalMessage("Model choices can't be published: STAGE_LOCKED build /app/admin/how-we-work; MODEL_FORBIDDEN code_review")).toEqual([{ code: "STAGE_LOCKED", stage: "build", fixHref: "/app/admin/how-we-work" }, { code: "MODEL_FORBIDDEN", stage: "code_review" }]);
  });
});
