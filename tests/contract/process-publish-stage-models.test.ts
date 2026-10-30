// V3: a project's process layer cannot be published, confirmed or rolled back to while one of its model choices can't be resolved by lane C's resolver. The refusal carries the resolver's
// fixed codes (and the page to fix them on) in the existing error shape; nothing is stored and no approval is made. A draft save never asks, and a layer with no model choices (and an
// ordinary agent) publishes exactly as before.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalModelName, projectRevisionKey, recipeDigest, ROVARA_CODE_AGENT_ID, type AgentId } from "../../packages/contracts/src/index.js";
import { bedrockClaudeModelIds } from "@agentx/model-runtime/catalog";
import { decideApproval, getAnyApproval, getApprovalSubjectHandler, type ApprovalRecord } from "../../packages/broker/src/agents/approvals.js";
import { publishDraft, resolveRecipe, rollbackAgent } from "../../packages/broker/src/agents/changes.js";
import { diffLessSafe } from "../../packages/broker/src/playbook/process-diff.js";
import { postProjectProcess } from "../../packages/broker/src/playbook/process-layer.js";
import { writeProjectPlaybook } from "../../packages/broker/src/playbook/project-playbook-store.js";
import { putProjectPlaybook } from "../../packages/broker/src/playbook/routes.js";
import { MAX, OLA, ORG_A } from "../support/agent-session-world.js";
import { callerOf, failure, layerWith, playbook, playbookDeps, world as baseWorld } from "../support/process-switch-world.js";
import type { MergeWorld } from "../support/rovara-code-merge-world.js";

const [MODEL_A, MODEL_B, MODEL_C] = [...new Map(bedrockClaudeModelIds("us").map((modelId) => ({ provider: "amazon-bedrock", modelId })).map((model) => [canonicalModelName(model), model])).values()];
/** The project allows A and C (two models, so the checking stages can still differ from Build) but not B. */
const ALLOW_A_AND_C = { approved: [MODEL_A, MODEL_C], default: MODEL_A };
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
/** Lane C's ProcessModelRefusal: the code, the stage and the page that fixes it (409), the first refusal only. */
const refusalOf = (error: { code: string | undefined; status?: number; stage?: string; fixHref?: string } | undefined) => ({ code: error?.code, stage: error?.stage, fixHref: error?.fixHref, status: error?.status });
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
    expect(refusalOf(refused)).toEqual({ code: "MODEL_NOT_VERIFIED", stage: "build", fixHref: "/app/admin/models/sources", status: 409 });
    expect(await versions(w, layer)).toEqual({ current: 1, latest: 1 });
    expect(approvals(w)).toBe(before);
  });

  it("refuses a model that conflicts with a company lock: STAGE_LOCKED, and lists nothing the company did not lock", async () => {
    const w = world();
    const layer = await layerWith(w);
    lock(w, { build: { model: MODEL_A, thinkingLevel: null, locked: true } });
    await setDraft(w, layer, { build: { model: MODEL_B } });
    const refused = await failure(publish(w, layer));
    expect(refusalOf(refused)).toEqual({ code: "STAGE_LOCKED", stage: "build", fixHref: "/app/admin/how-we-work", status: 409 });
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
    setProject(w, ALLOW_A_AND_C);
    const approvalId = approvalIdOf(w, waiting);
    await failure(decide(w, OLA, approvalId));
    const ended = await getAnyApproval(w.deps, ORG_A, approvalId) as { status?: string; failure?: string } | undefined;
    expect(ended?.status).toBe("APPROVED_FAILED");
    expect(ended?.failure).toContain("build: MODEL_NOT_ALLOWED_IN_PROJECT");
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
    setProject(w, ALLOW_A_AND_C);
    const refused = await failure(rollbackAgent(w.deps, callerOf(w, MAX), (await w.store.get(ORG_A, layer))!, { requestId: randomUUID(), version: 2 }));
    expect(refusalOf(refused)).toEqual({ code: "MODEL_NOT_ALLOWED_IN_PROJECT", stage: "build", fixHref: "/app/admin/how-we-work", status: 409 });
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
    setProject(w, ALLOW_A_AND_C);
    const approvalId = approvalIdOf(w, waiting);
    await failure(decide(w, OLA, approvalId));
    const ended = await getAnyApproval(w.deps, ORG_A, approvalId) as { status?: string; failure?: string } | undefined;
    expect(ended?.status).toBe("APPROVED_FAILED");
    expect(ended?.failure).toContain("build: MODEL_NOT_ALLOWED_IN_PROJECT");
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

  it("waits for a second person when a reviewer is picked on Build's own model (lane C's same-model approval), and stores nothing until then", async () => {
    const w = world();
    const layer = await layerWith(w);
    await setDraft(w, layer, { build: { model: MODEL_B }, review: { model: MODEL_B } });
    const waiting = await publish(w, layer);
    expect(waiting.applied).toBe(false);
    expect((waiting as unknown as { changes: string[] }).changes).toEqual(expect.arrayContaining([expect.stringContaining("same model as build")]));
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(1);
  });

  it("checks a personal-plan model for the person who asked, also when someone else confirms", async () => {
    const w = world();
    const plan = { provider: "openai", modelId: "gpt-5.5" };
    (w.deps as { servableModels?: unknown }).servableModels = async () => [...bedrockClaudeModelIds("us").map((modelId) => ({ provider: "amazon-bedrock", modelId })), plan];
    // Only Max has connected a ChatGPT plan that lists the model.
    (w.deps as { stageChatgpt?: unknown }).stageChatgpt = {
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
    expect(refusalOf(await failure(publish(w, layer, OLA)))).toMatchObject({ code: "MODEL_NOT_VERIFIED", stage: "build", status: 409 });
  });

  it("saves a draft with an unverified model: only publishing asks", async () => {
    const w = world();
    const layer = await layerWith(w);
    await expect(setDraft(w, layer, { build: { model: UNVERIFIED } })).resolves.toBeUndefined();
  });

  it("publishes a layer with no model choices exactly as before (lane C's check passes over a layer that names no model)", async () => {
    const w = world();
    const layer = await layerWith(w);
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

describe("pointing the playbook at a process layer checks the layer's model choices too", () => {
  const writer = (w: MergeWorld) => ({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit });
  /** A layer whose current version holds a model choice, with the project set back to the built-in (so the layer is not what runs). */
  async function chosenLayerOnBuiltin(w: MergeWorld): Promise<AgentId> {
    const layer = await layerWith(w);
    await setDraft(w, layer, { build: { model: MODEL_B } });
    const second = await publish(w, layer);
    if (!second.applied) await decide(w, OLA, approvalIdOf(w, second));
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(2);
    const current = await playbook(w);
    await writeProjectPlaybook(writer(w), { orgId: ORG_A, project: "web", developerId: MAX, expectedRevision: current.revision, defaultProcess: { kind: "builtin" } });
    return layer;
  }
  const putAt = async (w: MergeWorld, defaultProcess: unknown) => putProjectPlaybook(playbookDeps(w), callerOf(w, MAX), "web", { expectedRevision: (await playbook(w)).revision, defaultProcess });

  it("refuses to point at a layer whose current version no longer resolves, and leaves the playbook as it was", async () => {
    const w = world();
    const layer = await chosenLayerOnBuiltin(w);
    setProject(w, ALLOW_A_AND_C);
    const before = await playbook(w);
    const refused = await failure(putAt(w, { kind: "project_process", agentId: layer }));
    expect(refusalOf(refused)).toEqual({ code: "MODEL_NOT_ALLOWED_IN_PROJECT", stage: "build", fixHref: "/app/admin/how-we-work", status: 409 });
    expect(await playbook(w)).toEqual(before);
  });

  it("still points at a layer whose choices resolve", async () => {
    const w = world();
    const layer = await chosenLayerOnBuiltin(w);
    expect(await failure(putAt(w, { kind: "project_process", agentId: layer }))).toBeUndefined();
    expect((await playbook(w)).defaultProcess).toEqual({ kind: "project_process", agentId: layer });
  });

  it("checks a personal-plan model for the person who points the playbook", async () => {
    const w = world();
    const plan = { provider: "openai", modelId: "gpt-5.5" };
    (w.deps as { servableModels?: unknown }).servableModels = async () => [...bedrockClaudeModelIds("us").map((modelId) => ({ provider: "amazon-bedrock", modelId })), plan];
    (w.deps as { stageChatgpt?: unknown }).stageChatgpt = {
      settings: async () => ({ enabled: true }),
      view: async (developerId: string) => developerId === MAX ? { connected: true, status: "connected", connectedAt: "2026-10-01T00:00:00Z", models: ["gpt-5.5"] } : { connected: false },
    };
    const layer = await layerWith(w);
    await setDraft(w, layer, { build: { model: plan } });
    const second = await publish(w, layer);
    if (!second.applied) await decide(w, OLA, approvalIdOf(w, second));
    const current = await playbook(w);
    await writeProjectPlaybook(writer(w), { orgId: ORG_A, project: "web", developerId: MAX, expectedRevision: current.revision, defaultProcess: { kind: "builtin" } });
    const asOla = await failure(putProjectPlaybook(playbookDeps(w), callerOf(w, OLA), "web", { expectedRevision: (await playbook(w)).revision, defaultProcess: { kind: "project_process", agentId: layer } }));
    expect(refusalOf(asOla)).toMatchObject({ code: "MODEL_NOT_VERIFIED", stage: "build", status: 409 });
    expect(await failure(putAt(w, { kind: "project_process", agentId: layer }))).toBeUndefined();
  });

  /** A layer whose version 2 holds a confirmed same-model exception (the reviewer on Build's own model), with the project set back to the built-in. */
  async function exceptionLayerOnBuiltin(w: MergeWorld): Promise<AgentId> {
    const layer = await layerWith(w);
    await setDraft(w, layer, { build: { model: MODEL_B }, review: { model: MODEL_B } });
    const waiting = await publish(w, layer);
    expect(waiting.applied).toBe(false);
    await decide(w, OLA, approvalIdOf(w, waiting));
    const stored = (await w.store.getVersion(ORG_A, layer, 2))!;
    expect(stored.modelApproval?.exceptions.length, "the version carries its approval").toBeGreaterThan(0);
    const current = await playbook(w);
    await writeProjectPlaybook(writer(w), { orgId: ORG_A, project: "web", developerId: MAX, expectedRevision: current.revision, defaultProcess: { kind: "builtin" } });
    return layer;
  }

  it("points again at a version approved for the same model (its stored approval carries the exception)", async () => {
    const w = world();
    const layer = await exceptionLayerOnBuiltin(w);
    expect(await failure(putAt(w, { kind: "project_process", agentId: layer }))).toBeUndefined();
    expect((await playbook(w)).defaultProcess).toEqual({ kind: "project_process", agentId: layer });
  });

  it("refuses that version after the company policy changed: the approval was for the old company revision", async () => {
    const w = world();
    const layer = await exceptionLayerOnBuiltin(w);
    lock(w, {});
    w.db.set({ pk: `ORG#${ORG_A}#SETTINGS`, sk: "MODEL_SELECTION_POLICY", orgId: ORG_A, entityType: "MODEL_SELECTION_POLICY", version: 1, revision: 2, rankingVersion: "g3-v1", stepOverrides: {} });
    const before = await playbook(w);
    expect(refusalOf(await failure(putAt(w, { kind: "project_process", agentId: layer })))).toEqual({ code: "DIFFERENT_FROM_UNSATISFIABLE", stage: "code_review", fixHref: "/app/admin/how-we-work", status: 409 });
    expect(await playbook(w)).toEqual(before);
  });

  it("refuses a version with the same exception but no stored approval", async () => {
    const w = world();
    const layer = await exceptionLayerOnBuiltin(w);
    // Only version 2 holds an approval, so the stored item that carries one is that version's.
    for (const [key, item] of w.db.items) if (item["modelApproval"] !== undefined) w.db.items.set(key, Object.fromEntries(Object.entries(item).filter(([name]) => name !== "modelApproval")));
    expect((await w.store.getVersion(ORG_A, layer, 2))!.modelApproval).toBeUndefined();
    const before = await playbook(w);
    expect(refusalOf(await failure(putAt(w, { kind: "project_process", agentId: layer })))).toMatchObject({ code: "DIFFERENT_FROM_UNSATISFIABLE", status: 409 });
    expect(await playbook(w)).toEqual(before);
  });

  it("does not stop a switch to the built-in, whatever the layer holds", async () => {
    const w = world();
    const layer = await chosenLayerOnBuiltin(w);
    await putAt(w, { kind: "project_process", agentId: layer });
    setProject(w, ALLOW_A_AND_C);
    expect(await failure(putAt(w, { kind: "builtin" }))).toBeUndefined();
  });

  /** Version 1 (with a model choice) committed, then the broker died before the playbook write. */
  async function lostPointer(w: MergeWorld) {
    const { agentId } = await postProjectProcess(playbookDeps(w), w.caller(MAX), "web");
    await setDraft(w, agentId, { build: { model: MODEL_B } });
    const agent = (await w.store.get(ORG_A, agentId))!;
    const digest = recipeDigest(await resolveRecipe(w.deps, ORG_A, agentId, "draft"));
    await w.store.publish({ orgId: ORG_A, agentId, expectedDraftRevision: agent.draftRevision, digest, by: MAX, expectedCurrentVersion: null });
    return { agentId, draftRevision: agent.draftRevision, digest };
  }
  const redrive = (w: MergeWorld, x: { agentId: AgentId; draftRevision: number; digest: string }) => getApprovalSubjectHandler("agent_publish")!(w.deps, {
    orgId: ORG_A, approvalId: "apr_r", decidedBy: OLA, requestedBy: MAX, subject: { kind: "agent_publish", agentId: x.agentId, draftRevision: x.draftRevision, digest: x.digest },
  } as unknown as ApprovalRecord);
  const pointed = async (w: MergeWorld) => (await playbook(w)).defaultProcess.kind;

  it("repairs a lost first-version pointer, by a republish or a redriven confirmation, only while the choices resolve", async () => {
    for (const how of ["republish", "redrive"] as const) {
      const ok = world();
      const x = await lostPointer(ok);
      if (how === "republish") await publishDraft(ok.deps, callerOf(ok, MAX), (await ok.store.get(ORG_A, x.agentId))!, { requestId: randomUUID(), expectedRevision: x.draftRevision });
      else await redrive(ok, x);
      expect(await pointed(ok), `${how} control`).toBe("project_process");

      const w = world();
      const lost = await lostPointer(w);
      setProject(w, ALLOW_A_AND_C);
      const refused = how === "republish"
        ? await failure(publishDraft(w.deps, callerOf(w, MAX), (await w.store.get(ORG_A, lost.agentId))!, { requestId: randomUUID(), expectedRevision: lost.draftRevision }))
        : await failure(redrive(w, lost));
      expect(refusalOf(refused), how).toMatchObject({ code: "MODEL_NOT_ALLOWED_IN_PROJECT", stage: "build", status: 409 });
      expect(await pointed(w), how).toBe("builtin");
    }
  });
});
