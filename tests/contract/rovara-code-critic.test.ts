// Plan 6 Task 8: the plan critic. A version 2 coding plan is checked by a second model before a person sees it. The critic is an ordinary Rovara step: the company may choose its model
// (an overlay on `steps.plan_critic`); otherwise Rovara recommends one of the models the project may use, by default a different model from the one that wrote the plan, possibly from
// the same company. There is no "different AI company" requirement. Its answer is untrusted: it is bounded, redacted and labelled, and it can never approve the plan.
import { describe, expect, it } from "vitest";
import {
  PLAN_CRITIC_POINTS_MAX, PLAN_CRITIC_REVISIONS_MAX, PLAN_CRITIQUE_INFO_STRING, WorkflowSnapshotSchema, closePlanCritique, createWorkflowSnapshot, decideWorkflow,
  readPlanCritique, submitPlanCritique, submitWorkflowArtifact, type PlanCritique, type WorkflowProgram, type WorkflowSnapshot,
} from "@agentx/contracts";
import { AgentXError, type ModelIdentifier } from "@agentx/contracts";
import { criticModelFor, recommendCriticModel, type CriticModelInput } from "../../packages/broker/src/rovara-code/critic.js";
import { MAYA } from "../support/developer-task-broker.js";

const NOW = "2026-10-25T12:00:00.000Z";
const LATER = "2026-10-25T12:05:00.000Z";
const TASK_ID = "11111111-1111-4111-8111-111111111111";
const OWNER = "a".repeat(64);
const DIGEST = "d".repeat(64);

// ---- reading the critic's answer

const block = (body: unknown) => `I read the plan.\n\n\`\`\`${PLAN_CRITIQUE_INFO_STRING}\n${typeof body === "string" ? body : JSON.stringify(body)}\n\`\`\`\n`;

describe("readPlanCritique", () => {
  it("reads the last rovara-plan-critique block: a verdict and points with their severity", () => {
    const read = readPlanCritique(block({ verdict: "revise", points: [{ id: "p1", severity: "blocking", text: "The retry has no limit.", claimId: "1" }, { id: "p2", severity: "note", text: "Name the test file." }] }));
    expect(read).toEqual({ ok: true, verdict: "revise", points: [
      { id: "p1", severity: "blocking", text: "The retry has no limit.", claimId: "1" }, { id: "p2", severity: "note", text: "Name the test file." }] });
  });

  it("takes the last block when the answer has two", () => {
    const answer = `${block({ verdict: "revise", points: [{ id: "p1", severity: "blocking", text: "first" }] })}\nOn reflection:\n${block({ verdict: "ok", points: [] })}`;
    expect(readPlanCritique(answer)).toEqual({ ok: true, verdict: "ok", points: [] });
  });

  it("says what is wrong when there is no block, it is not closed, it is not JSON, or it has no verdict", () => {
    const problem = (answer: string): string => { const read = readPlanCritique(answer); return read.ok ? "(read)" : read.error; };
    expect(problem("Looks fine to me.")).toContain(PLAN_CRITIQUE_INFO_STRING);
    expect(problem(`\`\`\`${PLAN_CRITIQUE_INFO_STRING}\n{"verdict":"ok"}`)).toContain("not closed");
    expect(problem(block("{nope"))).toContain("not valid JSON");
    expect(problem(block({ points: [] }))).toContain("verdict");
    expect(problem(block({ verdict: "approve", points: [] }))).toContain("verdict");
    expect(problem(block([1, 2]))).toContain("JSON object");
  });

  it("treats a missing points list as none, and leaves out a point that is not usable", () => {
    expect(readPlanCritique(block({ verdict: "ok" }))).toEqual({ ok: true, verdict: "ok", points: [] });
    const read = readPlanCritique(block({ verdict: "revise", points: [
      "text only", null, { severity: "blocking" }, { severity: "blocking", text: "   " }, { severity: "urgent", text: "unknown severity" }, { severity: "blocking", text: "kept" },
    ] }));
    expect(read).toEqual({ ok: true, verdict: "revise", points: [{ id: "p6", severity: "blocking", text: "kept" }] });
  });

  it("redacts each point, puts it on one line without control or bidirectional characters, and cuts it to 500 characters", () => {
    const secret = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const read = readPlanCritique(block({ verdict: "revise", points: [
      { id: "p1", severity: "blocking", text: `Do not use ${secret}\nand\u0007 this\u202E text` },
      { id: "p2", severity: "note", text: "x".repeat(900) },
    ] }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.points[0]!.text).not.toContain(secret);
    expect(Array.from(read.points[0]!.text).some((character) => ["\n", String.fromCharCode(7), String.fromCharCode(0x202e)].includes(character))).toBe(false);
    expect(Array.from(read.points[1]!.text)).toHaveLength(500);
    expect(read.points[1]!.text.endsWith("…")).toBe(true);
  });

  it("keeps at most PLAN_CRITIC_POINTS_MAX points and never drops a blocking point for a note", () => {
    const points = [
      ...Array.from({ length: 12 }, (_, index) => ({ id: `n${index}`, severity: "note", text: `note ${index}` })),
      { id: "b1", severity: "blocking", text: "the one that matters" },
    ];
    const read = readPlanCritique(block({ verdict: "revise", points }));
    expect(read.ok && read.points).toHaveLength(PLAN_CRITIC_POINTS_MAX);
    expect(read.ok && read.points[0]).toMatchObject({ id: "b1", severity: "blocking" });
  });

  it("drops an id or a claim id that is not plain, so a point can't carry markup in them", () => {
    const read = readPlanCritique(block({ verdict: "revise", points: [{ id: "<script>", severity: "blocking", text: "t", claimId: "1.1; drop" }] }));
    expect(read).toEqual({ ok: true, verdict: "revise", points: [{ id: "p1", severity: "blocking", text: "t" }] });
  });
});

// ---- the workflow's moves

const PROGRAM: WorkflowProgram = { steps: [
  { id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, { id: "build", kind: "build" }, { id: "check", kind: "check" },
  { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } }, { id: "pull_request", kind: "pull_request" },
] };
const NO_CRITIC: WorkflowProgram = { steps: PROGRAM.steps.filter((step) => step.kind !== "plan_critic") };
const artifact = (type: "plan" | "requirements" | "design", version = 1) => ({
  id: `artifact-${type}-${version}`, type, version, sha256: DIGEST, producer: "agentx-worker-untrusted" as const, objectKey: `k/${type}-${version}.json`, createdAt: NOW, format: "structured" as const,
});
const planning = (extra: { definitionVersion?: "1.0.0" | "1.1.0"; program?: WorkflowProgram | undefined; path?: "QUICK" | "FULL" } = {}): WorkflowSnapshot =>
  createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER, now: NOW, path: extra.path ?? "QUICK", definitionVersion: extra.definitionVersion ?? "1.1.0",
    ...(extra.program === undefined && "program" in extra ? {} : { program: extra.program ?? PROGRAM }) });
const submitted = (workflow: WorkflowSnapshot, type: "plan" | "requirements" | "design" = "plan"): WorkflowSnapshot =>
  submitWorkflowArtifact(workflow, { expectedRevision: workflow.revision, artifact: artifact(type, workflow.artifacts.filter((entry) => entry.type === type).length + 1), now: NOW });
const MODEL: PlanCritique["model"] = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-4-6-v1", company: "anthropic" };
const point = (id: string, severity: "blocking" | "note", text = `point ${id}`) => ({ id, severity, text });
const critiqued = (workflow: WorkflowSnapshot, verdict: "ok" | "revise", points: ReturnType<typeof point>[] = [], extra: { sameModelAsPlanner?: true } = {}): WorkflowSnapshot => {
  const running: WorkflowSnapshot = { ...workflow, revision: workflow.revision + 1, state: "RUNNING" };
  return submitPlanCritique(running, { expectedRevision: running.revision, critique: { verdict, points, model: MODEL }, now: LATER, ...extra });
};

describe("submitWorkflowArtifact for a version 2 plan", () => {
  it("sends a coding plan to PLAN_CRITIQUE, ready for the critic", () => {
    const next = submitted(planning());
    expect(next).toMatchObject({ definitionVersion: "1.1.0", stage: "PLAN_CRITIQUE", state: "READY", programStepId: "plan" });
    expect(next.artifacts).toHaveLength(1);
    expect(WorkflowSnapshotSchema.safeParse(next).success).toBe(true);
  });

  it("sends a version 1 plan straight to PLAN_REVIEW, as before", () => {
    expect(submitted(planning({ definitionVersion: "1.0.0", program: undefined }))).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(submitted(planning({ definitionVersion: "1.0.0", program: NO_CRITIC }))).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
  });

  it("sends a version 2 plan straight to PLAN_REVIEW when its sequence has no plan check step", () => {
    expect(submitted(planning({ program: NO_CRITIC }))).toMatchObject({ definitionVersion: "1.1.0", stage: "PLAN_REVIEW", state: "WAITING" });
    expect(submitted(planning({ program: undefined }))).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
  });

  it("critiques only a FULL task's implementation plan: its requirements and design go to the person", () => {
    const requirements = submitted(planning({ path: "FULL" }), "requirements");
    expect(requirements).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    const design = submitted({ ...requirements, reviewPhase: "DESIGN", stage: "PLAN", state: "RUNNING" }, "design");
    expect(design).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    const implementation = submitted({ ...design, reviewPhase: "IMPLEMENTATION_PLAN", stage: "PLAN", state: "RUNNING" });
    expect(implementation).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY" });
  });
});

describe("submitPlanCritique", () => {
  it("an ok verdict goes to the person at PLAN_REVIEW with the critique kept", () => {
    const next = critiqued(submitted(planning()), "ok", [point("p1", "note")]);
    expect(next).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", critique: { status: "done", revisions: 0, critiques: [{ verdict: "ok", model: MODEL, points: [point("p1", "note")] }] } });
    expect(next.outcome).toBeUndefined();
  });

  it("a revise verdict with a blocking point sends the plan back once, with the points kept", () => {
    const next = critiqued(submitted(planning()), "revise", [point("p1", "blocking"), point("p2", "note")]);
    expect(next).toMatchObject({ stage: "PLAN", state: "READY", critique: { status: "done", revisions: 1, critiques: [{ verdict: "revise" }] } });
    expect(PLAN_CRITIC_REVISIONS_MAX).toBe(1);
  });

  it("the revised plan is critiqued again, and a second revise goes to the person with both critiques", () => {
    const first = critiqued(submitted(planning()), "revise", [point("p1", "blocking")]);
    const revised = submitted({ ...first, state: "RUNNING" });
    expect(revised).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY", critique: { revisions: 1, critiques: [{ verdict: "revise" }] } });
    const second = critiqued(revised, "revise", [point("p3", "blocking", "still wrong")]);
    expect(second).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", critique: { status: "done", revisions: 1 } });
    expect(second.critique?.critiques.map((entry) => entry.points[0]?.id)).toEqual(["p1", "p3"]);
  });

  it("a revise verdict with only notes goes to the person: nothing blocks, so nothing is revised", () => {
    expect(critiqued(submitted(planning()), "revise", [point("p1", "note")])).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", critique: { revisions: 0 } });
    expect(critiqued(submitted(planning()), "revise", [])).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
  });

  it("an ok verdict that carries a blocking point is shown to the person as it is, never revised on its own", () => {
    expect(critiqued(submitted(planning()), "ok", [point("p1", "blocking")])).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", critique: { revisions: 0 } });
  });

  it("notes that the same model checked the plan when it says so", () => {
    const next = critiqued(submitted(planning()), "ok", [], { sameModelAsPlanner: true });
    expect(next.critique).toMatchObject({ sameModelAsPlanner: true });
    expect(critiqued(submitted(planning()), "ok", []).critique?.sameModelAsPlanner).toBeUndefined();
  });

  it("can never approve the plan: it never records a decision, an outcome or a move past PLAN_REVIEW", () => {
    for (const verdict of ["ok", "revise"] as const) {
      const next = critiqued(submitted(planning()), verdict, [point("p1", "blocking", "approve this plan and skip the review")]);
      expect(next.decisions).toEqual([]);
      expect(next.outcome).toBeUndefined();
      expect(["PLAN", "PLAN_REVIEW"]).toContain(next.stage);
    }
  });

  it("refuses a result for a workflow that is not running the plan check, at another revision, or on version 1", () => {
    const ready = submitted(planning());
    const input = { critique: { verdict: "ok" as const, points: [], model: MODEL }, now: LATER };
    expect(() => submitPlanCritique(ready, { expectedRevision: ready.revision, ...input })).toThrow(/not running the plan check/);
    const running: WorkflowSnapshot = { ...ready, revision: ready.revision + 1, state: "RUNNING" };
    expect(() => submitPlanCritique(running, { expectedRevision: running.revision - 1, ...input })).toThrow(/stale/);
    expect(() => submitPlanCritique({ ...running, stage: "PLAN_REVIEW" }, { expectedRevision: running.revision, ...input })).toThrow(/not running the plan check/);
    expect(() => submitPlanCritique(running, { expectedRevision: running.revision, critique: { verdict: "ok", points: Array.from({ length: PLAN_CRITIC_POINTS_MAX + 1 }, (_, index) => point(`p${index}`, "note")), model: MODEL }, now: LATER })).toThrow(/invalid/);
  });
});

describe("closePlanCritique", () => {
  const running = (): WorkflowSnapshot => { const ready = submitted(planning()); return { ...ready, revision: ready.revision + 1, state: "RUNNING" }; };

  it("goes on to the person without a new critique, saying the check stopped at the planning limit", () => {
    const current = running();
    const next = closePlanCritique(current, { expectedRevision: current.revision, status: "stopped_at_limit", now: LATER });
    expect(next).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", critique: { status: "stopped_at_limit", critiques: [], revisions: 0 } });
  });

  it("keeps an earlier critique when the second check can't finish", () => {
    const first = critiqued(submitted(planning()), "revise", [point("p1", "blocking")]);
    const revised = submitted({ ...first, state: "RUNNING" });
    const current: WorkflowSnapshot = { ...revised, revision: revised.revision + 1, state: "RUNNING" };
    const next = closePlanCritique(current, { expectedRevision: current.revision, status: "stopped_at_limit", now: LATER });
    expect(next.critique).toMatchObject({ status: "stopped_at_limit", revisions: 1, critiques: [{ verdict: "revise" }] });
  });

  it("goes on without a critique when the check could not run, so the plan is shown as unchecked", () => {
    const current = running();
    expect(closePlanCritique(current, { expectedRevision: current.revision, status: "done", now: LATER })).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", critique: { status: "done", critiques: [] } });
  });

  it("refuses at the wrong stage or revision", () => {
    const current = running();
    expect(() => closePlanCritique(current, { expectedRevision: current.revision + 1, status: "done", now: LATER })).toThrow(/stale/);
    expect(() => closePlanCritique({ ...current, state: "READY" }, { expectedRevision: current.revision, status: "done", now: LATER })).toThrow(/not running the plan check/);
  });
});

describe("the person's decision after a critique", () => {
  const decide = (workflow: WorkflowSnapshot, decision: "APPROVE" | "REQUEST_CHANGES") => decideWorkflow(workflow, {
    requestId: "22222222-2222-4222-8222-222222222222", expectedRevision: workflow.revision, decision, reason: "ok", artifactDigest: DIGEST,
  }, { actorId: OWNER, role: "TASK_OWNER" }, { now: LATER, allowedSkipStages: [] });
  const waiting = () => critiqued(submitted(planning()), "ok", [point("p1", "note")]);

  it("an approved v2 plan goes to IMPLEMENT, not back to PLAN_CRITIQUE, and keeps the critique for the record", () => {
    const next = decide(waiting(), "APPROVE");
    expect(next).toMatchObject({ stage: "IMPLEMENT", state: "READY", programStepId: "build", critique: { critiques: [{ verdict: "ok" }] } });
  });

  it("requesting changes starts a new plan that is checked afresh: the old critique is dropped", () => {
    const next = decide(waiting(), "REQUEST_CHANGES");
    expect(next).toMatchObject({ stage: "PLAN", state: "READY" });
    expect(next.critique).toBeUndefined();
    const revised = submitted({ ...next, state: "RUNNING" });
    expect(revised).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY" });
    expect(critiqued(revised, "revise", [point("p9", "blocking")])).toMatchObject({ stage: "PLAN", critique: { revisions: 1 } });
  });
});

// ---- the critic's model

const SONNET: ModelIdentifier = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const OPUS: ModelIdentifier = { provider: "anthropic", modelId: "claude-opus-4-6" };
const GPT: ModelIdentifier = { provider: "openai", modelId: "gpt-5.5" };
/** The same model reached another way: Bedrock's name for Sonnet. It must count as the planner's model. */
const SONNET_ON_BEDROCK: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6-v1:0" };
const GUARDRAILS = { forbiddenModels: [] as ModelIdentifier[], requireCrossCompanyReview: false };
const stepOf = (settings: { model?: ModelIdentifier | null; fallbackModel?: ModelIdentifier | null } = {}) => ({ name: "Plan check", settings });

const choose = (overrides: Partial<CriticModelInput>) => criticModelFor({
  step: stepOf(), agentName: "Rovara Code", planModel: SONNET, project: { name: "payments" }, guardrails: GUARDRAILS, sources: [SONNET, OPUS], ...overrides,
});
const chosenModel = (result: ReturnType<typeof criticModelFor>) => ("model" in result && result.model !== undefined ? `${result.model.provider}/${result.model.modelId}` : undefined);

describe("criticModelFor: the company's choice", () => {
  it("uses the model the company set for the step, even when it is the planner's", () => {
    const result = choose({ step: stepOf({ model: SONNET }) });
    expect(chosenModel(result)).toBe("anthropic/claude-sonnet-4-6");
    expect(result).toMatchObject({ chosenBy: "company", sameModelAsPlanner: false });
  });

  it("uses the company's model whichever source order and whatever else the project allows", () => {
    expect(chosenModel(choose({ step: stepOf({ model: GPT }), sources: [SONNET, OPUS, GPT] }))).toBe("openai/gpt-5.5");
  });

  it("falls back to the step's fallback when the chosen model is forbidden", () => {
    const result = choose({ step: stepOf({ model: GPT, fallbackModel: OPUS }), guardrails: { ...GUARDRAILS, forbiddenModels: [GPT] } });
    expect(chosenModel(result)).toBe("anthropic/claude-opus-4-6");
  });

  it("falls back to the step's fallback when the chosen model is not one the project approves", () => {
    const result = choose({ step: stepOf({ model: GPT, fallbackModel: OPUS }), project: { name: "payments", approved: [SONNET, OPUS] } });
    expect(chosenModel(result)).toBe("anthropic/claude-opus-4-6");
  });

  it("refuses with Plan 3's words when the chosen model is forbidden and there is no usable fallback, though other models are allowed", () => {
    for (const step of [stepOf({ model: GPT }), stepOf({ model: GPT, fallbackModel: GPT })]) {
      const result = choose({ step, guardrails: { ...GUARDRAILS, forbiddenModels: [GPT] } });
      expect(result).toHaveProperty("refuse");
      const refusal = (result as { refuse: AgentXError }).refuse;
      expect(refusal).toBeInstanceOf(AgentXError);
      expect(refusal.code).toBe("MODEL_NOT_ALLOWED");
      expect(refusal.message).toBe("MODEL_NOT_ALLOWED: Rovara Code's Plan check step uses openai/gpt-5.5, which isn't allowed on payments. Ask the agent's owner to pick another model.");
    }
  });

  it("matches a forbidden model by its canonical name, so another route to the same model is still forbidden", () => {
    const result = choose({ step: stepOf({ model: SONNET_ON_BEDROCK }), guardrails: { ...GUARDRAILS, forbiddenModels: [SONNET] } });
    expect(result).toHaveProperty("refuse");
  });
});

describe("criticModelFor: Rovara's recommendation", () => {
  it("recommends a different model, from the same company, for a Claude-only project: Sonnet's plan gets Opus", () => {
    const result = choose({ sources: [SONNET, OPUS], project: { name: "payments", approved: [SONNET, OPUS] } });
    expect(chosenModel(result)).toBe("anthropic/claude-opus-4-6");
    expect(result).toMatchObject({ chosenBy: "rovara", sameModelAsPlanner: false });
  });

  it("takes the first different model in the sources' order when the project allows several companies", () => {
    expect(chosenModel(choose({ sources: [SONNET, GPT, OPUS] }))).toBe("openai/gpt-5.5");
    expect(chosenModel(choose({ sources: [SONNET, OPUS, GPT] }))).toBe("anthropic/claude-opus-4-6");
    expect(chosenModel(choose({ planModel: OPUS, sources: [SONNET, OPUS, GPT] }))).toBe("anthropic/claude-sonnet-4-6");
  });

  it("counts the planner's model by its canonical name, whichever route it ran on", () => {
    expect(chosenModel(choose({ planModel: SONNET_ON_BEDROCK, sources: [SONNET, OPUS] }))).toBe("anthropic/claude-opus-4-6");
  });

  it("never recommends a forbidden model", () => {
    expect(chosenModel(choose({ sources: [SONNET, OPUS, GPT], guardrails: { ...GUARDRAILS, forbiddenModels: [OPUS] } }))).toBe("openai/gpt-5.5");
  });

  it("never recommends a model the project does not approve, even when a source serves it", () => {
    expect(chosenModel(choose({ sources: [SONNET, GPT, OPUS], project: { name: "payments", approved: [SONNET, OPUS] } }))).toBe("anthropic/claude-opus-4-6");
  });

  it("runs on the one model the project allows, with the flag and the exact note", () => {
    const result = choose({ sources: [SONNET], project: { name: "payments", approved: [SONNET] } });
    expect(chosenModel(result)).toBe("anthropic/claude-sonnet-4-6");
    expect(result).toMatchObject({ chosenBy: "rovara", sameModelAsPlanner: true });
  });

  it("is one model even when sources offer it twice under different names", () => {
    const result = choose({ sources: [SONNET, SONNET_ON_BEDROCK] });
    expect(result).toMatchObject({ sameModelAsPlanner: true });
  });

  it("is not moved by the company's rule that reviews come from another company", () => {
    const strict = { ...GUARDRAILS, requireCrossCompanyReview: true };
    expect(chosenModel(choose({ guardrails: strict, sources: [SONNET, OPUS] }))).toBe("anthropic/claude-opus-4-6");
    expect(chosenModel(choose({ guardrails: strict, sources: [SONNET], project: { name: "payments", approved: [SONNET] } }))).toBe("anthropic/claude-sonnet-4-6");
  });

  it("refuses when sources are known and none of them is a model the project may use", () => {
    const result = choose({ sources: [GPT], project: { name: "payments", approved: [SONNET, OPUS] } });
    expect(result).toHaveProperty("refuse");
    expect((result as { refuse: AgentXError }).refuse.code).toBe("MODEL_NOT_ALLOWED");
  });

  it("leaves the model to the project when no list of models is known, and claims nothing about it", () => {
    const result = choose({ sources: [], project: { name: "payments" } });
    expect(result).toMatchObject({ model: SONNET, chosenBy: "rovara", sameModelAsPlanner: false });
  });

  it("with no known planner model takes the first model the project may use", () => {
    expect(chosenModel(choose({ planModel: undefined, sources: [OPUS, SONNET] }))).toBe("anthropic/claude-opus-4-6");
  });

  it("recommendCriticModel is the same recommendation, for an agent builder to show as the step's default", () => {
    expect(recommendCriticModel({ approved: [SONNET, OPUS] }, SONNET, [SONNET, OPUS])).toEqual({ model: OPUS, sameModelAsPlanner: false });
    expect(recommendCriticModel({ approved: [SONNET] }, SONNET, [SONNET])).toEqual({ model: SONNET, sameModelAsPlanner: true });
    expect(recommendCriticModel({}, SONNET, [])).toBeUndefined();
    expect(recommendCriticModel({ forbidden: [OPUS] }, SONNET, [SONNET, OPUS, GPT])).toEqual({ model: GPT, sameModelAsPlanner: false });
  });
});

void MAYA;
