import { TaskFundingProofSchema, type TaskFundingProof } from "../org/task-stop-funding.js";
import {prepareTaskModelPolicyPin,parseTaskModelPolicyPin,taskModelPolicyAdmissionChecks,type TaskModelPolicyPin} from "../model-selection/task-pin.js";
// Plan 3 Task 15: starting a run from a frozen recipe. The developer task start (`startTask`, aws/developer-tasks.ts) holds the project checks, the
// budget floor, the workspace charge and the one transaction that creates a task; this file holds what is particular to an agent's run:
//   `prepareRun`        resolves the agent (access, roster, guardrails: nothing is charged or written), checks the payer and the result contract,
//                       works out the run limits, reads the head of a pull request in the run's context and builds the coding program;
//   `runStartItems`     the items that join the start transaction: the RECIPE snapshot, the agent's task index, the AGENT_RUN of an agent-step
//                       recipe and, for `startAgentRun`, the run's request item;
//   `startAgentRun`     H2's entry for a start that is not a person at a keyboard (an event, a schedule, a chain step) and for the app route;
//   `readTaskRecipe`    the frozen recipe of a task, for the dispatch and the worker.
import { createHash } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  AGENTX_NAME_PATTERN,
  AgentIdSchema,
  AgentXError,
  INDEX_EXPIRY_ATTRIBUTE,
  PER_TASK_BUDGET_USD,
  OrgIdSchema,
  PayerSchema,
  ResolvedRecipeSchema,
  ResultContractSchema,
  RunInputSchema,
  SessionBindingSchema,
  SessionTriggerSchema,
  WORK_ORIGINS,
  WorkflowPathSchema,
  WorkflowProgramSchema,
  agentTasksKey,
  agentXError,
  projectAiKey,
  canonicalJson,
  codingProgram,
  recipeRunner,
  runRequestKey,
  type AgentId,
  type AgentRunState,
  DiagnosisIdSchema,
  ErrorRefSchema,
  type ErrorRef,
  type ModelIdentifier,
  type OrgId,
  type Payer,
  type Place,
  type ProjectRole,
  type ResolvedRecipe,
  type ResultContract,
  type RunCheckout,
  type RunInput,
  type SessionBinding,
  type SessionTrigger,
  type WorkOrigin,
  type WorkflowPath,
  type WorkflowProgram,
  ROVARA_CODE_AGENT_ID,
  SetupAgentLimitsSchema,
  type SetupAgentLimits,
} from "@agentx/contracts";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { resolvePayer, type PayerFacts } from "../spend/payer.js";
import type { RequestRunLimit } from "../spend/estimate.js";
import { effectiveMaxPerRun, readProjectAiWithRevision } from "../spend/settings.js";
import type { AgentCaller } from "./access.js";
import { requireNewWorkAllowed } from "../developer/project-roles.js";
import { requireStepModelsApproved } from "./dispatch.js";
import { readGuardrails } from "./guardrails.js";
import { resolveAgentForAutonomousRun, resolveAgentForTask, roleOnProject, type RosterDependencies, type TaskAgentRef } from "./roster.js";
import { putNew, type TableInput, type TransactItem } from "./table-writes.js";
import { taskAgentRunKey, taskRecipeKey } from "../developer/task-records.js";

/** How long the run's request item and the agent's task index item last; the State table's TTL removes them after that. */
export const RUN_RECORD_MEMORY_DAYS = 90;

/** Reads a pull request's head commit through the GitHub App, for the org (a read-only token; the run only ever reads). */
export type PullRequestHeadReader = (input: { orgId: OrgId; repositoryUrl: string; number: number; /** The installation the project pinned for the repository, when it did. */ installationId?: number }) => Promise<{ headSha: string }>;

/** What the run start needs on top of the roster checks. */
export interface AgentRunDependencies extends RosterDependencies {
  /** Without it, a run whose context names a pull request of a project repository is refused (it fails closed: it never reviews the wrong commit). */
  pullRequestHead?: PullRequestHeadReader;
  /**
   * Task 34's seam to Task 32: makes the `run_limit` request when approving a plan needs a higher tier than the approver's. Without it (until Task 32 is
   * wired) the plan blocks with the same words and no request is made.
   */
  requestRunLimit?: RequestRunLimit;
}

/** H2: a start that is not necessarily a person at a keyboard. */
export interface AgentRunRequest {
  /** Idempotency key: one run per request ID in an org. Plan 4 derives it from the event ID. */
  requestId: string;
  orgId: OrgId;
  project: string;
  agent: { agentId: AgentId; version?: number | "draft" };
  input: RunInput;
  origin: WorkOrigin;
  /** Becomes `DeveloperTaskRecord.developerId`, so the removed-creator rule (R60) covers the run. */
  owner: { developerId: string };
  /** Absent for work no person started. */
  startedBy?: { developerId: string };
  /**
   * Who pays. Left out, it is `resolvePayer`'s answer for the origin (the usual call); given, it must equal that answer. The one exception is a
   * `chain` run, whose payer is the chain's and is taken as given. A `chain` payer and `payerFacts` are trusted inputs: Plans 4 and 5 must take
   * them from their own trusted records (the chain, the Linear link, the offer), never from a client's request body.
   */
  payer?: Payer;
  /** The facts a Linear or offered run's payer is named from (trusted, see `payer`). */
  payerFacts?: PayerFacts;
  chain?: { chainRunId: string; stepId: string };
  /**
   * Plan 5 (N6): what started a run no person started, taken from a trusted trigger record (Plan 4's dispatch), never from a client body. It names
   * the session's starter; a request with a `startedBy` has none.
   */
  trigger?: SessionTrigger;
  /** A cap on this run: the smaller of it and the run limit applies, and 0 starts the run paused. */
  runLimitUsd?: number;
  /** Agent-step recipes only. */
  resultContract?: ResultContract;
  /** The owner's own authenticated caller when a route started the run; it must be the owner. Any other start acts as the owner. */
  caller?: DeveloperCaller;
  /**
   * The agent's owner approved running `agent.version`, an older version that is less safe than the one that runs now (owner decision 2026-10-22): the start
   * skips that one check and no other. Only the broker's own approval handler sets it, never a request body.
   */
  versionApproved?: true;
  /** Plan 6 Task 3: the run is a Rovara Code intent, started as a coding workflow. Only `startCodeIntent` sets it, never a request body. */
  codeIntent?: CodeIntentStart;
  /**
   * Plan 6 Task 10: the run is Rovara drafting the project's dev setup (a read-only look at the repositories, no workflow). Only `startSetupDraft` sets it, never a request body.
   * `seenTaskId` is the draft the project's pointer named when the route read it; it is not part of what the request IS, so it is not in the fingerprint.
   */
  setupDraft?: { seenTaskId?: string | undefined };
  /**
   * Live interaction F3: the run is the deep tier of Fix with agent, a read-only look at the repositories to diagnose one error (the same boundary as a setup draft; it starts, is admitted and is paid like any
   * task, as `startedBy`). Only `startDeepDiagnosis` sets it, never a request body. It carries ids and codes only: the data is the run's context.
   */
  diagnosis?: { diagnosisId: string; errorRef: ErrorRef };
  /**
   * SH14 (switch `su`): the run is a setup run that runs commands. Only `startSetupAgent` sets it (through the starter adapter), never a request body. `limits` are fixed by the broker (the project's setting cut
   * down to the company's lock); `seenTaskId` is the run the project's pointer named when the route read it.
   */
  setupAgent?: { limits: SetupAgentLimits; seenTaskId?: string | undefined };
  /** The named payer was worked out from the rules by the caller moments ago (not chosen by a client): a difference at the start is the setting changing under it (retryable busy). Only broker code sets it. */
  payerFromRules?: true;
}

/**
 * What `startCodeIntent` adds to a run (trusted, set by broker code): the start is a coding workflow, `path` is the Quick or Full path the request chose (absent: Understand
 * chooses it on version 2), and `binding` is the Slack thread or Linear issue the session follows. A Slack thread also shares the task to the thread's channel.
 */
export interface CodeIntentStart { path?: WorkflowPath; binding?: SessionBinding; /** The answered task a "change anyway" start follows (set by broker code only). */ retryOf?: string }

export interface AgentRunResult { taskId: string; runLimitUsd: number; stopAtUsd: number; paused: boolean }

/** What `startTask` takes from `startAgentRun` beyond the request body. */
export interface RunStartOptions {
  origin: WorkOrigin;
  /** No person started it: the agent is resolved without a caller (H3). */
  autonomous: boolean;
  startedBy?: { developerId: string };
  /** Worked out by `startAgentRun` with `resolvePayer`; `prepareRun` works it out again from the settings at the start and refuses a different answer. */
  payer?: Payer;
  /** True when the request named no payer, so one that no longer matches the rules (the project's setting changed meanwhile) is a retryable busy answer. */
  payerFromRules?: boolean;
  payerFacts?: PayerFacts;
  chain?: { chainRunId: string; stepId: string };
  /** Plan 5 (N6): what started a run no person started (see `AgentRunRequest.trigger`). */
  trigger?: SessionTrigger;
  runLimitUsd?: number;
  resultContract?: ResultContract;
  /** The owner OK'd an older, less safe version for this run (`AgentRunRequest.versionApproved`). */
  versionApproved?: true;
  /** The fingerprint of the request; when present the start also writes the run's request item. */
  requestFingerprint?: string;
  /** Plan 6 Task 3: the binding a Rovara Code intent's session follows (see `CodeIntentStart`). The workflow itself is asked for in the body. */
  codeIntent?: CodeIntentStart;
  /** Plan 6 Task 10: the run is a setup draft (see `AgentRunRequest.setupDraft`). */
  setupDraft?: { seenTaskId?: string | undefined };
  /** Live interaction F3: the run is a deep diagnosis (see `AgentRunRequest.diagnosis`). */
  diagnosis?: { diagnosisId: string; errorRef: ErrorRef };
  /** SH14: the run is a setup run (see `AgentRunRequest.setupAgent`). */
  setupAgent?: { limits: SetupAgentLimits; seenTaskId?: string | undefined };
}

/** What `startAgentRun` needs from the developer API: who the owner is as a caller, and the task start. */
export interface AgentRunStarter extends AgentRunDependencies {
  callerFor(orgId: OrgId, developerId: string): Promise<DeveloperCaller | undefined>;
  startTask(caller: DeveloperCaller, body: unknown, run: RunStartOptions): Promise<{ task: { taskId: string }; run: AgentRunResult }>;
  /** Plan 4 Task 9: Plan 3's cancel of a task, as its owner; a repeat of `requestId` is the same cancel. A task that is already over or closed is left as it is. Absent where tasks can't be cancelled this way. */
  cancelTask?(caller: DeveloperCaller, taskId: string, requestId: string): Promise<void>;
}

const Hex64 = z.string().regex(/^[a-f0-9]{64}$/);
/** The parts of a request that name something: checked here, since a caller of `startAgentRun` is not a route that parsed a body. */
const AgentRunRequestShape = z.object({
  requestId: z.string().uuid(),
  orgId: OrgIdSchema,
  project: z.string().regex(AGENTX_NAME_PATTERN),
  agent: z.object({ agentId: AgentIdSchema, version: z.union([z.number().int().min(1), z.literal("draft")]).optional() }).strict(),
  input: RunInputSchema,
  origin: z.enum(WORK_ORIGINS),
  owner: z.object({ developerId: Hex64 }).strict(),
  startedBy: z.object({ developerId: Hex64 }).strict().optional(),
  payer: PayerSchema.optional(),
  payerFacts: z.object({
    assignedBy: z.object({ developerId: Hex64.optional(), bot: z.boolean() }).strict().optional(),
    approvedBy: z.object({ developerId: Hex64 }).strict().optional(),
    acceptedBy: z.object({ developerId: Hex64 }).strict().optional(),
  }).strict().optional(),
  chain: z.object({ chainRunId: z.string().min(1).max(200), stepId: z.string().min(1).max(200) }).strict().optional(),
  trigger: SessionTriggerSchema.optional(),
  runLimitUsd: z.number().finite().min(0).optional(),
  codeIntent: z.object({ path: WorkflowPathSchema.optional(), binding: SessionBindingSchema.optional(), retryOf: z.string().uuid().optional() }).strict().optional(),
  setupDraft: z.object({ seenTaskId: z.string().uuid().optional() }).strict().optional(),
  diagnosis: z.object({ diagnosisId: DiagnosisIdSchema, errorRef: ErrorRefSchema }).strict().optional(),
  setupAgent: z.object({ limits: SetupAgentLimitsSchema, seenTaskId: z.string().uuid().optional() }).strict().optional(),
  payerFromRules: z.literal(true).optional(),
}).passthrough().refine((request) => request.trigger === undefined || request.startedBy === undefined, { path: ["trigger"], message: "a run a person started has no trigger" });

const sha256 = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

// ---- the payer

/** A draft's run is a test run whatever it was started from; the origin the payer rules see is that one. */
const originOf = (origin: WorkOrigin, agent: { version?: number | "draft" } | undefined): WorkOrigin => (agent?.version === "draft" ? "test_run" : origin);

/**
 * Who pays for a run, worked out from the settings as they stand now (`resolvePayer`), with the revision of the project's AI settings it read so
 * the start can hold to it. A payer the caller named must be the same one; a different one is refused, never charged.
 */
export async function resolveRunPayer(deps: AgentRunDependencies, input: {
  orgId: OrgId; project: string; agentId: AgentId; origin: WorkOrigin; startedBy?: { developerId: string } | undefined; payer?: Payer | undefined; payerFacts?: PayerFacts | undefined;
  /** The payer was worked out by an earlier read of the same settings, not named by the caller: a difference now is the setting changing under the start. */
  payerFromRules?: boolean | undefined;
}): Promise<{ payer: Payer; place: Place; projectAiRevision: number; projectPays: boolean }> {
  const { settings, revision } = await readProjectAiWithRevision(deps, input.orgId, input.project);
  const payer = resolvePayer({
    origin: input.origin, project: input.project, projectPays: settings.projectPays, agentId: input.agentId,
    ...(input.payer === undefined ? {} : { chainPayer: input.payer }),
    ...(input.startedBy === undefined ? {} : { startedBy: input.startedBy }),
    ...(input.payerFacts ?? {}),
  });
  if (input.payer !== undefined && canonicalJson(input.payer) !== canonicalJson(payer)) {
    if (input.payerFromRules === true) throw agentXError("WORKSPACE_BUSY", "the project's payment settings changed while starting; try again with the same request_id");
    throw agentXError("CONFIG_INVALID", "payer: this run's payer is not the one its origin names");
  }
  return { payer, place: { project: input.project }, projectAiRevision: revision, projectPays: settings.projectPays };
}

/**
 * A person a run names, other than the owner it acts as (who started it, or who pays for it: an assigner, an approver, someone who accepted an
 * offer), must still be allowed to start work on the project. A person the project only lets view it cannot cause spend by being named. They must
 * be a member of the org now, with a role on the project that starts tasks, and the project must take new work.
 */
async function requireMayStart(deps: AgentRunStarter, input: { orgId: OrgId; project: string; developerId: string }): Promise<void> {
  const caller = await deps.callerFor(input.orgId, input.developerId);
  if (caller === undefined) throw agentXError("FORBIDDEN", "A person named for this run isn't a member of the organization.");
  const role = await roleOnProject(deps, caller, input.project);
  await requireNewWorkAllowed(deps, input.orgId, input.project, role, "task");
}

// ---- preparing a run: nothing is charged or written

export interface PreparedRun {
  fundingProof?: TaskFundingProof;
  modelPolicyPin?:TaskModelPolicyPin;
  recipe: ResolvedRecipe;
  digest: string;
  ref: TaskAgentRef;
  origin: WorkOrigin;
  runner: "coding" | "agent_steps";
  /** A coding recipe's own sequence, when it is not Rovara Code's built-in one. */
  program?: WorkflowProgram;
  input: RunInput;
  runLimitUsd: number;
  stopAtUsd: number;
  paused: boolean;
  maxPerRunUsd?: number;
  resultContract?: ResultContract;
  chain?: { chainRunId: string; stepId: string };
  checkout: RunCheckout[];
  /** Who pays and where it is counted (Task 29); the start stores both and holds to the project settings revision they were worked out from. */
  payer: Payer;
  place: Place;
  projectAiRevision: number;
  /** Exact payment input, kept separately from unrelated numeric policy revisions. */
  projectPays?: boolean;
}

export interface PrepareRunInput {
  /** Exact project definition revision already checked by task admission. */
  projectRevision?: number;
  orgId: OrgId;
  project: string;
  /** Absent for a start that names no agent: Rovara Code at the org's pin. */
  agent?: { agentId: AgentId; version?: number | "draft" };
  input: RunInput;
  origin: WorkOrigin;
  /** The person starting it, with the role `checkProjectAccess` gave them; absent for an autonomous run. */
  caller?: AgentCaller;
  role?: ProjectRole;
  startedBy?: { developerId: string };
  /** The payer the caller worked out or was given; checked against the rules, never trusted. Absent: the rules decide. */
  payer?: Payer;
  payerFromRules?: boolean;
  payerFacts?: PayerFacts;
  chain?: { chainRunId: string; stepId: string };
  runLimitUsd?: number;
  resultContract?: ResultContract;
  /** The owner OK'd the version named (`RunStartOptions.versionApproved`). */
  versionApproved?: true;
  /** The start is a Rovara Code intent (`RunStartOptions.codeIntent`), the one start that may run the project's process layer. */
  allowProcessLayer?: true;
  /** The project's repositories, from the revision the task starts on. */
  repositories: ReadonlyArray<{ name: string; url: string; installationId?: number | undefined }>;
  /** The models the project approves (`definition.models.approved`), from the same revision; absent when it lists none. */
  projectApproved?: ReadonlyArray<ModelIdentifier>;
}

/** The refusal for a result contract on a recipe that is not made of agent steps (G1). */
export const RESULT_CONTRACT_CODING_REFUSAL = "resultContract: only agents with agent steps can choose a branch";

/**
 * The plan's order (PF23): the agent is resolved first (the roster, the archive state, the guardrails), then the rest of the request is
 * checked, so a refusal never follows a charge. The seam for Task 34: the run limit is Plan 1's per-task cap until `estimateRun`
 * and the budget settings exist (Tasks 28 and 34).
 */
export async function prepareRun(deps: AgentRunDependencies, input: PrepareRunInput): Promise<PreparedRun> {
  const autonomous = input.caller === undefined;
  let resolved: { recipe: ResolvedRecipe; digest: string; ref: TaskAgentRef; testRun: boolean };
  if (input.caller !== undefined) {
    resolved = await resolveAgentForTask(deps, input.caller, {
      project: input.project,
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.versionApproved === true ? { versionApproved: true } : {}),
      ...(input.allowProcessLayer === true ? { allowProcessLayer: true } : {}),
    });
  } else {
    if (input.agent === undefined) throw agentXError("CONFIG_INVALID", "agent: an autonomous run names its agent");
    if (input.agent.version === "draft") throw agentXError("CONFIG_INVALID", "agent: only a person can run a draft");
    resolved = { ...(await resolveAgentForAutonomousRun(deps, { orgId: input.orgId, project: input.project, agentId: input.agent.agentId, ...(input.agent.version === undefined ? {} : { version: input.agent.version }) })), testRun: false };
  }
  const { recipe, digest, ref } = resolved;
  const runner = recipeRunner(recipe);
  // The project's half of the model checks (the company's guardrails were checked while the agent was resolved): refused before any charge.
  requireStepModelsApproved(recipe, ref, input.project, input.projectApproved);
  // A coding run is asked the text as written; an agent-step run keeps its input as state, so it must be a run input.
  if (runner === "agent_steps") {
    const valid = RunInputSchema.safeParse(input.input);
    if (!valid.success) throw agentXError("CONFIG_INVALID", `input: ${valid.error.issues[0]?.message ?? "is not valid"}`);
  }
  if (input.resultContract !== undefined) {
    if (runner === "coding") throw agentXError("CONFIG_INVALID", RESULT_CONTRACT_CODING_REFUSAL);
    const contract = ResultContractSchema.safeParse(input.resultContract);
    if (!contract.success) throw agentXError("CONFIG_INVALID", `resultContract: ${contract.error.issues[0]?.message ?? "is not valid"}`);
  }
  const origin: WorkOrigin = resolved.testRun ? "test_run" : input.origin;
  const { payer, place, projectAiRevision, projectPays } = await resolveRunPayer(deps, { orgId: input.orgId, project: input.project, agentId: ref.agentId, origin, startedBy: input.startedBy, payer: input.payer, payerFromRules: input.payerFromRules, payerFacts: input.payerFacts });
  if (autonomous && input.startedBy !== undefined) throw agentXError("CONFIG_INVALID", "startedBy: a run no person started has no one who started it");
  const program = runner === "coding" ? codingProgram(recipe) : undefined;
  if (program !== undefined) {
    const valid = WorkflowProgramSchema.safeParse(program);
    if (!valid.success) throw agentXError("CONFIG_INVALID", `${ref.name}'s steps can't run as a coding sequence: ${valid.error.issues[0]?.message ?? "the sequence is not valid"}`);
  }
  const limits = await runLimits(deps, input.orgId, ref, input.runLimitUsd);
  // Only an agent-step run checks a pull request out (a coding run is asked the text as written), so a coding run reads nothing from GitHub.
  const checkout = runner === "agent_steps" ? await pullRequestHeads(deps, input.orgId, input.input, input.repositories) : [];
  const processVersion=runner==="coding"&&ref.process===true&&typeof ref.version==="number"?await deps.store.getVersion(input.orgId,ref.agentId,ref.version):undefined;
  if(runner==="coding"&&ref.process===true&&processVersion===undefined)throw agentXError("RUNTIME_UNAVAILABLE","The task process version could not be verified.");
  const approvalProof=processVersion?.modelApproval;
  const modelPolicyPin=runner==="coding"?await prepareTaskModelPolicyPin(deps,{orgId:input.orgId,project:input.project,agentId:ref.agentId,recipe,digest,...(input.projectRevision===undefined?{}:{projectRevision:input.projectRevision}),...(processVersion===undefined?{}:{projectOverlay:processVersion.overlay}),...(approvalProof===undefined?{}:{approvalProof})}):undefined;
  return {
    recipe, digest, ref,
    ...(modelPolicyPin===undefined?{}:{modelPolicyPin}),
    origin,
    runner,
    ...(program === undefined ? {} : { program }),
    input: input.input,
    ...limits,
    ...(input.resultContract === undefined ? {} : { resultContract: input.resultContract }),
    ...(input.chain === undefined ? {} : { chain: input.chain }),
    checkout, payer, place, projectAiRevision, projectPays,
  };
}

/**
 * The limits of a run (H2): the run limit is `base` unless a request lowers it, `stopAtUsd = min(runLimitUsd, maxPerRunUsd ?? Infinity)`, and a run limit
 * of 0 starts the run paused. `base` is Plan 1's cap on one task here; `startTask` replaces it with the planning limit or the estimate's run limit (Task 34).
 */
export function runLimitsOf(base: number, requested: number | undefined, maxPerRunUsd: number | undefined): Pick<PreparedRun, "runLimitUsd" | "stopAtUsd" | "paused"> {
  if (requested !== undefined && (!Number.isFinite(requested) || requested < 0)) throw agentXError("CONFIG_INVALID", "runLimitUsd: must be zero or more");
  const runLimitUsd = requested === undefined ? base : Math.min(base, requested);
  return { runLimitUsd, stopAtUsd: maxPerRunUsd === undefined ? runLimitUsd : Math.min(runLimitUsd, maxPerRunUsd), paused: runLimitUsd === 0 };
}

/**
 * The limits of a run of the agent `ref`. A project's process layer ("How we work") is Rovara Code with the project's rules on top: its tasks keep the org's Rovara Code max per run (set by an
 * owner or admin on the built-in), and the layer's own, when it has one, can only lower it. A project publishing a layer never lifts the org's cap.
 */
async function runLimits(deps: AgentRunDependencies, orgId: OrgId, ref: TaskAgentRef, requested: number | undefined): Promise<Pick<PreparedRun, "runLimitUsd" | "stopAtUsd" | "paused" | "maxPerRunUsd">> {
  const record = ref.builtin ? await deps.store.getBuiltinSettings(orgId, ref.agentId) : await deps.store.get(orgId, ref.agentId);
  const guardrails = await readGuardrails(deps, orgId);
  const own = record === undefined ? undefined : effectiveMaxPerRun(record, guardrails);
  const base = ref.process === true && !ref.builtin ? await deps.store.getBuiltinSettings(orgId, ROVARA_CODE_AGENT_ID) : undefined;
  const fromBase = base === undefined ? undefined : effectiveMaxPerRun(base, guardrails);
  const maxPerRunUsd = own === undefined ? fromBase : fromBase === undefined ? own : Math.min(own, fromBase);
  return { ...runLimitsOf(PER_TASK_BUDGET_USD, requested, maxPerRunUsd), ...(maxPerRunUsd === undefined ? {} : { maxPerRunUsd }) };
}

// ---- a pull request in the run's context (PF16)

const PULL_REQUEST_REFERENCE = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})#([1-9][0-9]{0,8})$/;

function githubRepositoryOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") return undefined;
    const parts = parsed.pathname.split("/").filter((part) => part !== "");
    if (parts.length !== 2) return undefined;
    return `${parts[0]!}/${parts[1]!.replace(/\.git$/u, "")}`.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * For each `pull_request` item named `<owner>/<repo>#<n>` that is a repository of the project, reads the head commit through the App for the
 * org; the run's workspace checks that commit out read-only (Task 22 carries it to the step). Anything else in the context is information
 * and reads nothing. Fails closed: when the head cannot be read the run is not started, so a review never looks at the wrong commit.
 */
async function pullRequestHeads(deps: AgentRunDependencies, orgId: OrgId, input: RunInput, repositories: ReadonlyArray<{ name: string; url: string; installationId?: number | undefined }>): Promise<RunCheckout[]> {
  const found: RunCheckout[] = [];
  for (const item of input.context ?? []) {
    if (item.kind !== "pull_request") continue;
    const reference = PULL_REQUEST_REFERENCE.exec(item.ref);
    if (reference === null) continue;
    const named = `${reference[1]!}/${reference[2]!}`.toLowerCase();
    const repository = repositories.find((candidate) => githubRepositoryOf(candidate.url) === named);
    if (repository === undefined) continue;
    const number = Number(reference[3]);
    if (found.some((entry) => entry.repository === repository.name && entry.pullRequest === number)) continue;
    try {
      if (deps.pullRequestHead === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "reading pull requests is not set up in this deployment");
      const { headSha } = await deps.pullRequestHead({ orgId, repositoryUrl: repository.url, number, ...(repository.installationId === undefined ? {} : { installationId: repository.installationId }) });
      if (!/^[a-f0-9]{40}$/.test(headSha)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub did not answer with a commit");
      found.push({ repository: repository.name, pullRequest: number, headSha });
    } catch (error) {
      if (error instanceof AgentXError && error.code !== "RUNTIME_UNAVAILABLE") throw error;
      throw agentXError("RUNTIME_UNAVAILABLE", `Rovara couldn't read pull request ${String(number)} of ${repository.name} from GitHub, so the run wasn't started. Try again shortly.`);
    }
  }
  return found;
}

// ---- what joins the start transaction

/** What the start writes for a run, beside the task: all in the task's own transaction (the caller adds them to its items). */
export function runStartItems(table: TableInput, input: {
  orgId: OrgId;
  taskId: string;
  createdAt: string;
  project: string;
  developerId: string;
  prepared: PreparedRun;
  /** Enrolled starts already captured numeric policy; fence payment independently. */
  policySnapshotCaptured?: boolean;
  /** `startAgentRun`'s request: its item is written with the run, so a repeat of the request is answered from it. */
  request?: { requestId: string; fingerprint: string };
  /** Plan 5: the run's session, remembered on the request item so a repeat answers the same one. */
  sessionId?: string;
}): TransactItem[] {
  const { prepared } = input;
  if (input.policySnapshotCaptured === true && typeof prepared.projectPays !== "boolean") throw agentXError("TASK_STOP_CONFIG_INVALID", "The project payer binding is missing. Start again after reviewing Spending.");
  const modelPolicyPin=prepared.runner==="coding"?parseTaskModelPolicyPin(prepared.modelPolicyPin,{orgId:input.orgId,project:input.project,agentId:prepared.ref.agentId,recipe:prepared.recipe,digest:prepared.digest}):undefined;
  const nowSeconds = Math.floor(table.now() / 1000);
  const expires = nowSeconds + RUN_RECORD_MEMORY_DAYS * 86_400;
  const items: TransactItem[] = [
    putNew(table, taskRecipeKey(input.taskId), "TASK_RECIPE", { orgId: input.orgId, recipe: prepared.recipe, digest: prepared.digest, ...(prepared.fundingProof === undefined ? {} : { fundingProof: prepared.fundingProof }),...(modelPolicyPin===undefined?{}:{modelPolicyPin}) }),
    putNew(table, agentTasksKey(input.orgId, prepared.ref.agentId, input.createdAt, input.taskId), "AGENT_TASK", {
      orgId: input.orgId, agentId: prepared.ref.agentId, taskId: input.taskId, project: input.project, version: prepared.ref.version, origin: prepared.origin, createdAt: input.createdAt,
      [INDEX_EXPIRY_ATTRIBUTE]: expires,
    }),
  ];
  if(modelPolicyPin!==undefined) items.push(...taskModelPolicyAdmissionChecks(table.tableName,modelPolicyPin));
  if (prepared.runner === "agent_steps") {
    const state: AgentRunState = {
      orgId: input.orgId, revision: 1, state: "RUNNING", cursor: 0, input: prepared.input,
      steps: prepared.recipe.steps.map((step) => ({ id: step.id, status: "pending" as const, operationIds: [], approvalIds: [] })),
      reports: [],
      ...(prepared.resultContract === undefined ? {} : { resultContract: prepared.resultContract }),
      ...(prepared.checkout.length === 0 ? {} : { checkout: prepared.checkout }),
    };
    items.push(putNew(table, taskAgentRunKey(input.taskId), "AGENT_RUN", { ...state }));
  }
  // The payer was worked out from the project's AI settings (whether the project pays) as they stood at this revision; the start holds to it.
  items.push({
    ConditionCheck: {
      TableName: table.tableName,
      Key: projectAiKey(input.orgId, input.project),
      ...(input.policySnapshotCaptured === true
        ? { ConditionExpression: "#type = :type AND #org = :org AND #project = :project AND #pays = :pays", ExpressionAttributeNames: { "#type": "entityType", "#org": "orgId", "#project": "project", "#pays": "projectPays" }, ExpressionAttributeValues: { ":type": "PROJECT_AI", ":org": input.orgId, ":project": input.project, ":pays": prepared.projectPays } }
        : prepared.projectAiRevision === 0
          ? { ConditionExpression: "attribute_not_exists(pk)" }
          : { ConditionExpression: "#revision = :revision", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": prepared.projectAiRevision } }),
    },
  });
  if (input.request !== undefined) {
    items.push({
      Put: {
        TableName: table.tableName,
        Item: {
          ...runRequestKey(input.orgId, input.request.requestId), entityType: "RUN_REQUEST", orgId: input.orgId, taskId: input.taskId, developerId: input.developerId,
          fingerprint: input.request.fingerprint, ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }), payer: prepared.payer, runLimitUsd: prepared.runLimitUsd, stopAtUsd: prepared.stopAtUsd, paused: prepared.paused,
          at: new Date(table.now()).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: expires,
        },
        // An expired item the TTL has not removed yet is as good as gone.
        ConditionExpression: "attribute_not_exists(pk) OR #expires <= :now",
        ExpressionAttributeNames: { "#expires": INDEX_EXPIRY_ATTRIBUTE },
        ExpressionAttributeValues: { ":now": nowSeconds },
      },
    });
  }
  return items;
}

// ---- reading a run back

/** The frozen recipe of a task, or undefined for a task from before agents. The item is a named exception to org-scoped keys: another org's refuses. */
export async function readTaskRecipe(deps: Pick<TableInput, "documentClient" | "tableName">, taskId: string, orgId: OrgId): Promise<{ recipe: ResolvedRecipe; digest: string; modelPolicyPin?:TaskModelPolicyPin; fundingProof?: TaskFundingProof } | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskRecipeKey(taskId), ConsistentRead: true })) as { Item?: { orgId?: unknown; recipe?: unknown; digest?: unknown; modelPolicyPin?:unknown; fundingProof?: unknown } };
  const item = response.Item;
  if (item === undefined) return undefined;
  if (item.orgId !== orgId) throw agentXError("NOT_FOUND", "no agent snapshot belongs to this task");
  const recipe = ResolvedRecipeSchema.safeParse(item.recipe);
  if (!recipe.success || typeof item.digest !== "string") throw agentXError("RUNTIME_UNAVAILABLE", "the agent snapshot of this task can't be read");
  const modelPolicyPin=item.modelPolicyPin===undefined?undefined:parseTaskModelPolicyPin(item.modelPolicyPin,{orgId,recipe:recipe.data,digest:item.digest});
  const funding = item.fundingProof === undefined ? undefined : TaskFundingProofSchema.safeParse(item.fundingProof);
  if (funding !== undefined && !funding.success) throw agentXError("TASK_STOP_CONFIG_INVALID", "The pinned funding proof is invalid.");
  return { recipe: recipe.data, digest: item.digest,...(modelPolicyPin===undefined?{}:{modelPolicyPin}), ...(funding?.success ? { fundingProof: funding.data } : {}) };
}

/** The request item of a run, if one is there and has not expired. */
export async function readRunRequest(deps: Pick<TableInput, "documentClient" | "tableName" | "now">, orgId: OrgId, requestId: string): Promise<{ taskId: string; fingerprint: string; payer?: Payer; sessionId?: string; result: AgentRunResult } | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: runRequestKey(orgId, requestId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const item = response.Item;
  if (item === undefined || item.orgId !== orgId) return undefined;
  const expires = item[INDEX_EXPIRY_ATTRIBUTE];
  if (typeof expires === "number" && expires <= Math.floor(deps.now() / 1000)) return undefined;
  const { taskId, fingerprint, runLimitUsd, stopAtUsd, paused } = item;
  if (typeof taskId !== "string" || typeof fingerprint !== "string" || typeof runLimitUsd !== "number" || typeof stopAtUsd !== "number" || typeof paused !== "boolean") return undefined;
  const payer = PayerSchema.safeParse(item["payer"]);
  const sessionId = typeof item["sessionId"] === "string" ? item["sessionId"] : undefined;
  return { taskId, fingerprint, ...(payer.success ? { payer: payer.data } : {}), ...(sessionId === undefined ? {} : { sessionId }), result: { taskId, runLimitUsd, stopAtUsd, paused } };
}

/**
 * What identifies a request, so the same ID with other contents is refused. The owner and the agent are in it; the ID itself is not. The payer in it is
 * the one the run was started with (`startAgentRun` puts the resolved payer there), so naming the payer the rules chose is the same request.
 */
export function runRequestFingerprint(request: Omit<AgentRunRequest, "caller">): string {
  return sha256({
    project: request.project, agent: request.agent, input: request.input, origin: request.origin, owner: request.owner, startedBy: request.startedBy ?? null,
    payer: request.payer ?? null, payerFacts: request.payerFacts ?? null, chain: request.chain ?? null, runLimitUsd: request.runLimitUsd ?? null, resultContract: request.resultContract ?? null,
    // Only when there is one, so a request stored before triggers existed keeps the fingerprint it was stored with.
    ...(request.trigger === undefined ? {} : { trigger: request.trigger }),
    // Likewise: a run that is not a Rovara Code intent keeps the fingerprint it always had.
    ...(request.codeIntent === undefined ? {} : { codeIntent: request.codeIntent }),
    // Likewise: only a setup draft carries this (its pointer's seen task is not part of the request).
    ...(request.setupDraft === undefined ? {} : { purpose: "setup_draft" }),
    // Likewise: only a deep diagnosis carries this.
    ...(request.diagnosis === undefined ? {} : { purpose: "diagnosis", diagnosis: request.diagnosis.diagnosisId }),
    // Likewise: only a setup run carries this (its pointer's seen task is not part of the request; its limits are).
    ...(request.setupAgent === undefined ? {} : { purpose: "setup_agent", limits: request.setupAgent.limits }),
  });
}

// ---- H2

/**
 * Starts a run. Idempotent on `requestId`: the repeat of a request returns the first run's result and starts nothing, and the same ID with
 * other contents is `IDEMPOTENCY_CONFLICT`. A run no person started (no `startedBy`) resolves its agent through the roster first (G12). The payer is
 * `resolvePayer`'s answer for the origin (a payer the request names must equal it), and the owner may be anyone who is a member: whoever else the
 * run names must be allowed to start work on the project.
 */
export async function startAgentRun(deps: AgentRunStarter, request: AgentRunRequest): Promise<AgentRunResult> {
  const shape = AgentRunRequestShape.safeParse(request);
  if (!shape.success) {
    const issue = shape.error.issues[0];
    throw agentXError("CONFIG_INVALID", `${issue === undefined || issue.path.length === 0 ? "request" : issue.path.join(".")}: ${issue?.message ?? "is not valid"}`);
  }
  const { caller, ...rest } = request;
  const previous = await readRunRequest(deps, request.orgId, request.requestId);
  if (previous !== undefined) {
    // A request that names no payer is the same request as the first run's, whatever the rules would say now; one that names it must name that one.
    const effective = request.payer ?? previous.payer;
    if (previous.fingerprint !== runRequestFingerprint({ ...rest, ...(effective === undefined ? {} : { payer: effective }) })) throw agentXError("IDEMPOTENCY_CONFLICT", "this request_id was already used for another run; use a new request_id");
    return previous.result;
  }
  const autonomous = request.startedBy === undefined;
  if (autonomous) {
    await resolveAgentForAutonomousRun(deps, { orgId: request.orgId, project: request.project, agentId: request.agent.agentId, ...(typeof request.agent.version === "number" ? { version: request.agent.version } : {}) });
  }
  if (caller !== undefined && (caller.developerId !== request.owner.developerId || caller.orgId !== request.orgId)) {
    throw agentXError("CONFIG_INVALID", "caller: a run is started as its owner");
  }
  const actingAs = caller ?? await deps.callerFor(request.orgId, request.owner.developerId);
  if (actingAs === undefined) throw agentXError("FORBIDDEN", "The person this run is for isn't a member of the organization.");
  // Who pays, from the origin and the project's settings now; a payer the request named must be that one. The owner is who the run acts as, and
  // may differ from who started it and who pays, so everyone else the run names must be allowed to start work here.
  const { payer } = await resolveRunPayer(deps, {
    orgId: request.orgId, project: request.project, agentId: request.agent.agentId, origin: originOf(request.origin, request.agent),
    startedBy: request.startedBy, payer: request.payer, payerFacts: request.payerFacts, ...(request.payerFromRules === true ? { payerFromRules: true } : {}),
  });
  const fingerprint = runRequestFingerprint({ ...rest, payer });
  const named = new Set([request.startedBy?.developerId, payer.kind === "member" ? payer.developerId : undefined].filter((id): id is string => id !== undefined && id !== request.owner.developerId));
  for (const developerId of named) await requireMayStart(deps, { orgId: request.orgId, project: request.project, developerId });
  // A Rovara Code intent is a coding workflow: it asks for one (with the request's path, if it chose one) and, for a Slack thread, for the task to be shared to that thread's channel.
  const intent = request.codeIntent;
  const body = {
    requestId: request.requestId, project: request.project, instructions: request.input.text, input: request.input, agent: request.agent, client: request.origin,
    ...(intent === undefined ? {} : { workflow: true as const, ...(intent.path === undefined ? {} : { workflowPath: intent.path }) }),
    ...(intent?.binding?.kind === "slack_thread" ? { shareToChannel: true, channel: intent.binding.channelId } : {}),
  };
  const started = await deps.startTask(actingAs, body, {
    origin: request.origin, autonomous, payer, ...(request.payer === undefined || request.payerFromRules === true ? { payerFromRules: true } : {}), requestFingerprint: fingerprint,
    ...(request.payerFacts === undefined ? {} : { payerFacts: request.payerFacts }),
    ...(request.startedBy === undefined ? {} : { startedBy: request.startedBy }),
    ...(request.chain === undefined ? {} : { chain: request.chain }),
    ...(request.trigger === undefined ? {} : { trigger: request.trigger }),
    ...(request.runLimitUsd === undefined ? {} : { runLimitUsd: request.runLimitUsd }),
    ...(request.resultContract === undefined ? {} : { resultContract: request.resultContract }),
    ...(request.versionApproved === true ? { versionApproved: true as const } : {}),
    ...(intent === undefined ? {} : { codeIntent: intent }),
    ...(request.setupDraft === undefined ? {} : { setupDraft: request.setupDraft }),
    ...(request.diagnosis === undefined ? {} : { diagnosis: request.diagnosis }),
    ...(request.setupAgent === undefined ? {} : { setupAgent: request.setupAgent }),
  });
  return started.run;
}
