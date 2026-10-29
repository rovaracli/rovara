// Round 2 (PB22): "A newer Rovara Code is available" on How we work. A project's process layer stays on the Rovara Code version the company had adopted when the layer was made. The
// view says when the company has adopted a newer one (`process.update`, a read); "Update" moves the layer's DRAFT onto it (`updateBase`) and the change is published like any other:
// a newer base that loosens something the less-safe rules cover waits for a second person, one that only adds stricter steps publishes at once. Running tasks keep their version.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_AGENTS, HowWeWorkViewSchema, ROVARA_CODE_AGENT_ID, agentXError, builtinDefaultPin, builtinRecipe, currentBuiltinVersion, type AgentId, type OrgRole, type ResolvedRecipe,
} from "../../packages/contracts/src/index.js";
import { decideApproval } from "../../packages/broker/src/agents/approvals.js";
import { routeAgentRequest } from "../../packages/broker/src/agents/routes.js";
import { publishDraft, resolveRecipe } from "../../packages/broker/src/agents/changes.js";
import { AgentStore, updateAvailable, type BuiltinSource } from "../../packages/broker/src/agents/store.js";
import { computeHowWeWork, type HowWeWorkDependencies } from "../../packages/broker/src/playbook/effective.js";
import { postProjectProcess } from "../../packages/broker/src/playbook/process-layer.js";
import { diffLessSafe } from "../../packages/broker/src/playbook/process-diff.js";
import type { ProjectPlaybookDependencies } from "../../packages/broker/src/playbook/routes.js";
import { MAX, OLA, ORG_A } from "../support/agent-session-world.js";
import { mergeWorld as baseWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";

const ROLES: Record<string, OrgRole> = { [OLA]: "admin" };
const callerOf = (w: MergeWorld, who: string) => ({ ...w.caller(who), orgRole: ROLES[who] ?? "member" });

/** The shipped built-ins plus a Rovara Code version 3 whose review step sends findings back fewer times (a newer release that loosens a check; both reviewers stay, as a pull request step needs them). */
function loosenedReview(): ResolvedRecipe {
  const v2 = builtinRecipe(ROVARA_CODE_AGENT_ID, 2);
  return { ...v2, chain: v2.chain.map((entry) => ({ ...entry, version: 3 })), steps: v2.steps.map((step) => (step.kind === "review" && step.onFindings !== undefined ? { ...step, onFindings: { ...step.onFindings, maxRounds: step.onFindings.maxRounds - 1 } } : step)) };
}
const builtins: BuiltinSource = {
  currentVersion: (id) => (id === ROVARA_CODE_AGENT_ID ? 3 : currentBuiltinVersion(id as "rovara-code")),
  defaultPin: (id) => builtinDefaultPin(id as "rovara-code"),
  recipe: (id, version) => (id === ROVARA_CODE_AGENT_ID && version === 3 ? loosenedReview() : builtinRecipe(id as "rovara-code", version)),
  name: (id) => BUILTIN_AGENTS[id as "rovara-code"].name,
};

function world(): MergeWorld {
  const w = baseWorld();
  const store = new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit, builtins });
  (w.deps as { store: AgentStore }).store = store;
  w.store = store;
  return w;
}
function playbookDeps(w: MergeWorld): ProjectPlaybookDependencies {
  return {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, store: w.store, audit: w.audit.audit,
    projectFor: async (caller, rawName) => {
      const role = await w.members.roleOf(caller.orgId, rawName, { developerId: caller.developerId, orgRole: ROLES[caller.developerId] ?? "member" });
      if (role === undefined || caller.orgId !== ORG_A) throw agentXError("PROJECT_NOT_FOUND", "project not found");
      return { name: rawName, role };
    },
  };
}
const viewDeps = (w: MergeWorld): HowWeWorkDependencies => ({ ...playbookDeps(w), store: w.store });
const view = (w: MergeWorld) => computeHowWeWork(viewDeps(w), ORG_A, "web");
const adopt = async (w: MergeWorld, version: number) =>
  w.store.adoptBuiltinVersion({ orgId: ORG_A, agentId: ROVARA_CODE_AGENT_ID, version, expectedPinnedVersion: await w.store.pinnedBuiltinVersion(ORG_A, ROVARA_CODE_AGENT_ID), by: MAX });
const publish = async (w: MergeWorld, agentId: AgentId, who = MAX) => {
  const agent = (await w.store.get(ORG_A, agentId))!;
  return publishDraft(w.deps, callerOf(w, who), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
};
const approvalIdOf = (w: MergeWorld, result: { applied: boolean }) => w.approvalIdOf((result as unknown as { confirmUrl: string }).confirmUrl);
/** A project process layer published (version 1) on the Rovara Code version the company has adopted now; the playbook points at it. */
async function publishedLayer(w: MergeWorld): Promise<AgentId> {
  const { agentId } = await postProjectProcess(playbookDeps(w), w.caller(MAX), "web");
  expect(await publish(w, agentId)).toMatchObject({ applied: true, value: { version: 1 } });
  return agentId;
}
const rebase = async (w: MergeWorld, agentId: AgentId) => {
  const agent = (await w.store.get(ORG_A, agentId))!;
  return w.store.updateBase({ orgId: ORG_A, agentId, expectedRevision: agent.draftRevision, by: MAX });
};

describe("the view says when the company has adopted a newer Rovara Code than the layer's", () => {
  it("has process.update from the layer's version to the one the company adopted", async () => {
    const w = world();
    await publishedLayer(w);
    await adopt(w, 2);
    const v = await view(w);
    expect(v.process).toMatchObject({ kind: "project_process", version: 1, update: { from: 1, to: 2 } });
    expect(HowWeWorkViewSchema.safeParse(v).success).toBe(true);
  });

  it("has none when the layer is on the version the company adopted", async () => {
    const w = world();
    await adopt(w, 2);
    await publishedLayer(w);
    expect((await view(w)).process.update).toBeUndefined();
  });

  it("has none for a newer release the company has not adopted", async () => {
    const w = world();
    await adopt(w, 2);
    await publishedLayer(w);
    expect(currentBuiltinVersion(ROVARA_CODE_AGENT_ID)).toBe(2);
    expect(builtins.currentVersion(ROVARA_CODE_AGENT_ID)).toBe(3);
    expect((await view(w)).process.update).toBeUndefined();
  });

  it("has none with no layer, and none for a saved draft layer the project does not run", async () => {
    const w = world();
    await adopt(w, 2);
    expect((await view(w)).process.update).toBeUndefined();
    await postProjectProcess(playbookDeps(w), w.caller(MAX), "web");
    await adopt(w, 3);
    const v = await view(w);
    expect(v.process.kind).toBe("builtin");
    expect(v.process.update).toBeUndefined();
  });

  it("goes on saying so while the moved draft is unpublished (the running version is the one compared), and stops once it is published", async () => {
    const w = world();
    const layer = await publishedLayer(w);
    await adopt(w, 2);
    await rebase(w, layer);
    expect((await view(w)).process).toMatchObject({ version: 1, update: { from: 1, to: 2 } });
    expect(await publish(w, layer)).toMatchObject({ applied: true, value: { version: 2 } });
    expect((await view(w)).process.update).toBeUndefined();
  });

  it("is a read: nothing is written", async () => {
    const w = world();
    await publishedLayer(w);
    await adopt(w, 2);
    const before = JSON.stringify(w.db.find(() => true));
    await view(w);
    expect(JSON.stringify(w.db.find(() => true))).toBe(before);
  });
});

describe("Update is a normal reviewed change", () => {
  it("moves the draft onto the adopted version, keeps other unpublished edits in it, and leaves the running version alone", async () => {
    const w = world();
    const layer = await publishedLayer(w);
    const draft = (await w.store.getDraft(ORG_A, layer))!;
    await w.store.saveDraft({ orgId: ORG_A, agentId: layer, overlay: { instructions: "Keep changes small." }, expectedRevision: draft.revision, by: MAX });
    await adopt(w, 2);
    const moved = await rebase(w, layer);
    expect(moved.extends).toEqual({ agentId: ROVARA_CODE_AGENT_ID, version: 2 });
    expect(moved.overlay).toEqual({ instructions: "Keep changes small." });
    // Running tasks keep their version: version 1 still resolves on Rovara Code 1, with no plan check.
    const running = await resolveRecipe(w.deps, ORG_A, layer, 1);
    expect(running.steps.map((step) => step.id)).not.toContain("plan_critic");
    const next = await resolveRecipe(w.deps, ORG_A, layer, "draft");
    expect(next.steps.map((step) => step.id)).toContain("plan_critic");
    expect(next.instructions.map((entry) => entry.text)).toContain("Keep changes small.");
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(1);
  });

  it("publishes at once when the newer Rovara Code only adds stricter steps (version 1 to 2 adds the plan check)", async () => {
    const w = world();
    const layer = await publishedLayer(w);
    await adopt(w, 2);
    await rebase(w, layer);
    expect(await publish(w, layer)).toMatchObject({ applied: true, value: { version: 2 } });
    expect((await w.store.getVersion(ORG_A, layer, 2))!.extends).toEqual({ agentId: ROVARA_CODE_AGENT_ID, version: 2 });
    expect(await updateAvailable(w.store, ORG_A, layer)).toBeUndefined();
  });

  it("waits for a second person when the newer Rovara Code weakens the review step's setting; the requester cannot confirm it, another approver can", async () => {
    const w = world();
    await adopt(w, 2);
    const layer = await publishedLayer(w);
    await adopt(w, 3);
    await rebase(w, layer);
    const waiting = await publish(w, layer);
    expect(waiting).toMatchObject({ applied: false, changes: ['Lowers how many times the review step "Review" sends findings back, from 3 to 2'] });
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(1);
    await expect(decideApproval(w.deps, callerOf(w, MAX), approvalIdOf(w, waiting), { requestId: randomUUID(), decision: "APPROVE" })).rejects.toMatchObject({ code: "PROCESS_SELF_CONFIRM" });
    await decideApproval(w.deps, callerOf(w, OLA), approvalIdOf(w, waiting), { requestId: randomUUID(), decision: "APPROVE" });
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(2);
    expect((await w.store.getVersion(ORG_A, layer, 2))!.extends).toEqual({ agentId: ROVARA_CODE_AGENT_ID, version: 3 });
  });

  it("moving the base writes no audit event of its own (drafts are unaudited); the publish is audited as process.published", async () => {
    const w = world();
    const layer = await publishedLayer(w);
    const published = w.audit.recordedBy("process.published").length;
    const all = w.audit.recorded().length;
    await adopt(w, 2);
    const afterAdopt = w.audit.recorded().length;
    await rebase(w, layer);
    expect(w.audit.recorded().length).toBe(afterAdopt);
    expect(afterAdopt).toBeGreaterThanOrEqual(all);
    await publish(w, layer);
    expect(w.audit.recordedBy("process.published")).toHaveLength(published + 1);
  });
});

describe("the diff the Review changes dialog shows for a process layer", () => {
  const v1 = builtinRecipe(ROVARA_CODE_AGENT_ID, 2);
  const v3 = loosenedReview();
  it("lists the process layer's own less-safe reasons as well as the ordinary ones", () => {
    const sameModel = (recipe: ResolvedRecipe): ResolvedRecipe => ({ ...recipe, steps: recipe.steps.map((step) => (step.kind === "plan" || step.kind === "plan_critic" ? { ...step, settings: { ...step.settings, model: { provider: "anthropic", modelId: "claude-opus-4-8" } } } : step)) });
    const independent = { ...v1, steps: v1.steps.map((step) => (step.kind === "plan_critic" ? { ...step, settings: { ...step.settings, model: { provider: "anthropic", modelId: "claude-sonnet-4-6" } } } : step.kind === "plan" ? { ...step, settings: { ...step.settings, model: { provider: "anthropic", modelId: "claude-opus-4-8" } } } : step)) };
    const reasons = diffLessSafe({ purpose: "process" }, independent, sameModel(v1), 1);
    expect(reasons).toEqual(['Makes the plan check "Plan check" use the same model as the plan step "Plan"']);
    expect(diffLessSafe({}, independent, sameModel(v1), 1)).toEqual([]);
    expect(diffLessSafe({ purpose: "process" }, v1, v3, 1)).toEqual(['Lowers how many times the review step "Review" sends findings back, from 3 to 2']);
  });
  it("words a first publish by what the layer builds on", () => {
    const build = (recipe: ResolvedRecipe): ResolvedRecipe => ({ ...recipe, steps: recipe.steps.map((step) => (step.kind === "build" ? { ...step, settings: { ...step.settings, model: { provider: "openai", modelId: "gpt-5" } } } : step)) });
    expect(diffLessSafe({ purpose: "process" }, v1, build(v1), "base")).toEqual(['Lets the step "Build" send data to an AI company (openai) that the process it builds on does not use']);
    expect(diffLessSafe({ purpose: "process" }, v1, build(v1), 1)).toEqual(['Lets the step "Build" send data to a new AI company (openai)']);
  });
});

describe("GET /v1/app/agents/{id}/diff on a process layer", () => {
  const CELL = "https://cell.example.com";
  const get = async (w: MergeWorld, path: string) => {
    const answer = await routeAgentRequest(w.deps as never, callerOf(w, MAX), { method: "GET", path, requestId: "r", headers: {} }, new URL(`${CELL}${path}`));
    return answer as { lessSafe: string[]; changes: string[] };
  };
  it("lists the process layer's own reasons (a changed review instruction) beside the move onto the newer base, so the dialog shows what the publish asks about", async () => {
    const w = world();
    const layer = await publishedLayer(w);
    await adopt(w, 2);
    await rebase(w, layer);
    const draft = (await w.store.getDraft(ORG_A, layer))!;
    await w.store.saveDraft({ orgId: ORG_A, agentId: layer, overlay: { steps: { review: { instructions: "Be strict." } } }, expectedRevision: draft.revision, by: MAX });
    const diff = await get(w, `/v1/app/agents/${layer}/diff?from=1&to=draft`);
    expect(diff.lessSafe).toContain('Changes the instructions of the review step "Review"');
    // What the diff lists is what the publish asks a second person about.
    const waiting = await publish(w, layer);
    expect(waiting.applied).toBe(false);
    for (const reason of diff.lessSafe) expect((waiting as unknown as { changes: string[] }).changes).toContain(reason);
  });
});
