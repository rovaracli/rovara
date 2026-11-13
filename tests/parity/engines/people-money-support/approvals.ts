// Area 25 (approvals and authority), compared end to end at the decision: the SAME high-risk coding plan, the SAME people (the task's owner, a person with no
// standing who is an Auditor, a person of another company) and the SAME places (a tool's token, a signed-in browser, the browser under the decide-grade
// sign-in), decided on each path:
//   Cloud: `decideTaskWorkflow`, the one workflow decision every Cloud surface reaches (approval place U4, decision cards on), on a real task of Cloud's developer
//          task broker (the harness Cloud's own approval-place tests use; the Slack journey harness has no browser decide-grade surface);
//   core:  the core's decision gate on the core engine's real task, with A6's Cloud approvers on the approvers point (core-context `PARITY_CORE_PEOPLE`).
// Each attempt is one word `<case>:ok` or `<case>:refused` (the reason is kept apart: the two paths word refusals differently), then the task's state and decision.
import { createHash, randomUUID } from "node:crypto";
import { UNDERSTAND_ARTIFACT_NAME, type PlanDocument } from "@rovara-code/contracts";
import { decideTaskWorkflow } from "../../../../packages/broker/src/aws/developer-tasks/decide.js";
import { API_TOKEN_METHOD, BROWSER_SESSION_METHOD, BROWSER_STEP_UP_METHOD } from "../../../../packages/broker/src/cloud/adapters/people/index.js";
import { DEV_ISSUER, MAYA, OMAR, createSingleAnswerPlanBroker } from "../../../support/developer-task-broker.js";
import { OTHER_ORG } from "../../../support/cloud-people-world.js";
import { TEST_ORG } from "../../../support/orgs.js";
import { planAnswer, planDocument } from "../../../support/plan-documents.js";
import type { CoreContext } from "../core-context.js";

// Copied from Code's core/decisions/workflow-subject.ts (vendored, not exported by a shim): importing that file by path pulls Code's whole local
// composition into the type-check, where Code's own `@agentx/model-runtime` resolves to Cloud's package of that name.
const WORKFLOW_DOCUMENT_KIND = "workflow-document";
function waitingDocumentDigest(workflow: { path?: string; reviewPhase?: string; artifacts: ReadonlyArray<{ type: string; sha256: string }> }): string | undefined {
  const type = workflow.path === "QUICK" || workflow.reviewPhase === "IMPLEMENTATION_PLAN" ? "plan" : workflow.reviewPhase === "REQUIREMENTS" ? "requirements" : "design";
  return workflow.artifacts.filter((artifact) => artifact.type === type).at(-1)?.sha256;
}

/** A coding plan that changes infrastructure: the tier rule reads a file in infra as high risk (Cloud's own approval-place test plan). */
export const HIGH_RISK_PLAN: Partial<PlanDocument> = {
  title: "Let the payments role read the retry queue",
  claims: [{ id: "1", text: "The payments role may read the retry queue.", evidence: [{ kind: "code", path: "infra/iam/payments-role.tf", startLine: 1, endLine: 9, note: "Today the role cannot read it." }] }],
  decisions: [],
};
export const HIGH_RISK_PLAN_TEXT = planAnswer(planDocument(HIGH_RISK_PLAN));

export type ApprovalCase = "tool" | "browser" | "auditor-step-up" | "stranger-step-up" | "owner-step-up";

/** The attempts in order. A refused attempt changes nothing, so each case meets the same waiting plan; the last case is the one both paths should accept. */
export function casesFor(answer: "approve" | "refuse"): ApprovalCase[] {
  return answer === "approve" ? ["tool", "browser", "auditor-step-up", "stranger-step-up", "owner-step-up"] : ["tool", "auditor-step-up", "stranger-step-up", "browser"];
}

export interface MatrixResult {
  /** `<case>:ok` / `<case>:refused`, then `final:<stage>/<state>` and `decided:<decision>`. */
  words: string[];
  /** Each refusal's own words (shown on a difference, never compared). */
  reasons: string[];
}

const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };

/** Cloud: a high-risk plan of Maya's on Cloud's developer task broker, decided by each case through `decideTaskWorkflow`. */
export async function cloudMatrix(answer: "approve" | "refuse"): Promise<MatrixResult> {
  const previous = process.env.DECISION_CARDS_ENABLED;
  process.env.DECISION_CARDS_ENABLED = "1";
  try {
    const h = await createSingleAnswerPlanBroker({ brokerExtra: { agents: {} } });
    const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: { revision: number; stage: string; state: string; decisions: Array<{ decision: string }>; artifacts: Array<{ sha256: string }> } };
    const operation = (workspaceId: string, predicate: (item: Record<string, unknown>) => boolean) => String(h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION").filter(predicate).at(-1)!.id);
    const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Let the payments role read the retry queue", client: "test-client", workflow: true, workflowPath: "QUICK" });
    if (started.status !== 200) throw new Error(`Cloud refused the start: ${JSON.stringify(started.body).slice(0, 200)}`);
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const workspaceId = meta(taskId).workspaceId;
    await h.finish(workspaceId, operation(workspaceId, (item) => item.kind === "prepare"), "SUCCEEDED", PREPARED);
    const planning = operation(workspaceId, (item) => item.workflowMode === "PLAN" && item.status !== "SUCCEEDED");
    await h.artifact(workspaceId, planning, "plan.md", HIGH_RISK_PLAN_TEXT);
    await h.finish(workspaceId, planning, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    // A high run limit already set, so the approval raises nothing (the run limit rule is not what is compared here).
    h.db.set({ ...meta(taskId), budgetUsd: 1000 });
    const deps = {
      documentClient: h.db, tableName: "state", signInTableName: "signin", actions: h.actions, orgId: TEST_ORG, log: () => undefined, now: () => Date.now(), issuer: DEV_ISSUER,
      checkAccess: async () => ({ revision: 1, policy: {} as never, access: "granted" as const, channelIds: [], role: "contributor" as const }), projectChannelIds: async () => [],
    } as never;
    const caller = (who: typeof MAYA, extra: Record<string, unknown> = {}) => ({ orgId: TEST_ORG, developerId: who.developerId, orgRole: "member", name: who.name, amr: who.provider, sessionId: who.sessionId, ...extra }) as never;
    const callers: Record<ApprovalCase, { who: never; options: Record<string, unknown> }> = {
      tool: { who: caller(MAYA), options: {} },
      browser: { who: caller(MAYA, { browserSession: true }), options: {} },
      "auditor-step-up": { who: caller(OMAR, { orgRole: "auditor", browserSession: true }), options: { decideGrade: true } },
      "stranger-step-up": { who: caller(OMAR, { orgId: OTHER_ORG, orgRole: "owner", browserSession: true }), options: { decideGrade: true } },
      "owner-step-up": { who: caller(MAYA, { browserSession: true }), options: { decideGrade: true } },
    };
    const result: MatrixResult = { words: [], reasons: [] };
    for (const name of casesFor(answer)) {
      const workflow = meta(taskId).workflow;
      const request = { requestId: randomUUID(), expectedRevision: workflow.revision, decision: answer === "approve" ? "APPROVE" : "REJECT", reason: answer === "approve" ? "Approved" : "Not this way", artifactDigest: workflow.artifacts.at(-1)!.sha256 };
      try {
        await decideTaskWorkflow(deps, callers[name].who, taskId, request, callers[name].options);
        result.words.push(`${name}:ok`);
      } catch (error) {
        const e = error as { code?: string; message?: string };
        result.words.push(`${name}:refused`);
        result.reasons.push(`${name}: ${String(e.code)} ${String(e.message).slice(0, 160)}`);
      }
    }
    const workflow = meta(taskId).workflow;
    result.words.push(`final:${workflow.stage}/${workflow.state}`, `decided:${workflow.decisions.map((entry) => entry.decision).join(",") || "none"}`);
    return result;
  } finally {
    if (previous === undefined) delete process.env.DECISION_CARDS_ENABLED; else process.env.DECISION_CARDS_ENABLED = previous;
  }
}

/** Core: the core engine's task, planned with the same high-risk plan, decided by each case through the core's decision gate with A6's approvers. */
export async function coreMatrix(ctx: CoreContext, answer: "approve" | "refuse"): Promise<MatrixResult> {
  const people = ctx.people;
  if (people === undefined) throw new Error("the core engine was not started with Cloud's people (PARITY_CORE_PEOPLE)");
  // The planner answers with the high-risk plan (and Understand / the plan check, if this install runs them).
  for (let round = 0; round < 6; round += 1) {
    const job = await ctx.nextJob();
    if (job === undefined) break;
    const mode = ctx.modeOf(job);
    if (mode === "UNDERSTAND") {
      await ctx.callback(job, "artifacts", { name: UNDERSTAND_ARTIFACT_NAME, mediaType: "application/json", content: JSON.stringify({ kind: "ready", path: "QUICK", restatement: "Let the payments role read the retry queue", assumptions: [] }) });
    } else if (mode === "PLAN") {
      await ctx.callback(job, "artifacts", { name: "plan.md", mediaType: "text/markdown", content: HIGH_RISK_PLAN_TEXT });
    } else if (mode === "PLAN_CRITIQUE") {
      await ctx.callback(job, "artifacts", { name: "plan-critique.md", mediaType: "text/markdown", content: "I read the plan.\n\n```rovara-plan-critique\n{\"verdict\":\"ok\",\"points\":[]}\n```\n" });
    } else { ctx.task.pending = job; break; }
    await ctx.callback(job, "result", { status: "SUCCEEDED" });
  }
  const { owner, auditor, stranger } = people.people;
  const result: MatrixResult = { words: [], reasons: [] };
  for (const name of casesFor(answer)) {
    const task = await ctx.readTask();
    const offer = approvalOfferOf(ctx.task.taskId, task?.workflow as { stage: string; state: string; revision: number } | undefined);
    if (offer === undefined) { result.words.push(`${name}:no_offer`); continue; }
    const stepUp = (who: typeof owner) => people.stepUp(who, ctx.task.taskId, { contentVersion: offer.artifactDigest });
    const credential = name === "tool" ? { method: API_TOKEN_METHOD, token: people.tokenOf(owner) }
      : name === "browser" ? { method: BROWSER_SESSION_METHOD, token: owner.sessionId }
      : { method: BROWSER_STEP_UP_METHOD, token: await stepUp(name === "auditor-step-up" ? auditor : name === "stranger-step-up" ? stranger : owner) };
    const outcome = await ctx.runtime.app.gate.decide({
      companyId: ctx.companyId, kind: WORKFLOW_DOCUMENT_KIND, subjectId: ctx.task.taskId, requestId: offer.requestId, outcome: answer === "approve" ? "approve" : "reject",
      seen: { revision: offer.revision, artifactDigest: offer.artifactDigest }, credentials: [credential], ...(answer === "approve" ? {} : { reason: "Not this way" }),
    });
    if (outcome.status === "decided" || outcome.status === "replayed") result.words.push(`${name}:ok`);
    else { result.words.push(`${name}:refused`); result.reasons.push(`${name}: ${outcome.reason} ${outcome.detail.slice(0, 160)}`); }
  }
  // Cloud's decision starts the next step in the same call; the core queues it and the dispatch runs it on the next pass: one pass, so both are read once the step is under way.
  await ctx.runtime.tick();
  const workflow = (await ctx.readTask())?.workflow as { stage?: string; state?: string; decisions?: Array<{ decision: string }> } | undefined;
  result.words.push(`final:${String(workflow?.stage)}/${String(workflow?.state)}`, `decided:${(workflow?.decisions ?? []).map((entry) => entry.decision).join(",") || "none"}`);
  return result;
}

/**
 * The approval a waiting plan offers, as Code's local pages name it (vendor local/app/page-data.ts `approvalOfferOf` and `approvalRequestId`, copied here: that module
 * pulls the whole local composition into this program). The request id is a pure function of the task, the revision and the plan's digest.
 */
function approvalOfferOf(taskId: string, workflow: { stage: string; state: string; revision: number } | undefined): { requestId: string; revision: number; artifactDigest: string } | undefined {
  if (workflow?.stage !== "PLAN_REVIEW" || workflow.state !== "WAITING") return undefined;
  const digest = waitingDocumentDigest(workflow as never);
  if (digest === undefined) return undefined;
  const hex = createHash("sha256").update(`approval\0${taskId}\0${String(workflow.revision)}\0${digest}`).digest("hex");
  const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return { requestId, revision: workflow.revision, artifactDigest: digest };
}

/** A short digest of a refusal list, so a differing reason is visible in the debug log without being compared. */
export const reasonsDigest = (reasons: readonly string[]): string => createHash("sha256").update(reasons.join("\n")).digest("hex").slice(0, 12);
