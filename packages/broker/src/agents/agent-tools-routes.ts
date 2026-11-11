// Plan 3 Task 19: the two internal routes through which a running agent step uses connector tools, and what stands behind them.
//
//   GET  /v1/internal/agent-tools        the tools the step may use, as the model sees them (only granted ones, no gate fields)
//   POST /v1/internal/agent-tools/call   one call: `ConnectorCallRequest & { connector }`
//
// The broker authorizes the request with the operation's own `agent-tools` capability and finds the run it belongs to (broker.ts); everything after that is
// here. A call goes through, in order: the task's creator is still a member of the org (A12); the creator still has authority on the project (A13); the grant
// is resolved again from the project's current connectors and the task's frozen recipe (`AGENT_TOOL_NOT_GRANTED`, before any vendor is asked); the call is
// prepared (mentions stripped, Rovara's label added to a ticket the agent creates); the write gate decides (`run`, `wait` or `refuse`); and only a `run` goes to
// the vendor, through the connector call path with the connector's ledger and attribution. Nothing the model supplies decides any of it.
//
// THE GATE: `AgentToolsDependencies.gate` is where a write is decided. The broker sets `approvalsWriteGate` (Task 21's `decideWrite`), which runs reads and safe
// writes, holds a consequential one for a person (`WAITING_FOR_APPROVAL`) and refuses what a project rule denies. `approvalsNotWiredGate` is what an install with no
// approvals gets: it runs reads and safe writes and refuses every other write with a clear message, so nothing that needs a person can run by accident.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AgentXErrorCodeSchema, ConnectorCallRequestSchema, ConnectorNameSchema, agentXError, repositoryHostOf, type AgentXErrorCode, type ApprovalRules, type Autonomy, type ConnectorCatalog, type ConnectorResult, type GrantedTool, type OrgId, type PresentedTool, type ProjectDefinition, type RepositoryDefinition, type ResolvedRecipe, type WorkspaceInstance } from "@rovara-code/contracts";
import { agentGitHubGuard, githubConnector, requestFingerprint, type CatalogCache, type Invocation, type Ledger } from "@agentx/gateway";
import { callConnector, discoverConnector, type ConnectorContextBase, type ScopeDiscovery } from "../aws/connector-routes.js";
import type { ResolvedConnector } from "../aws/connector-types.js";
import { UNNAMED_MEMBER, effectiveTaskOwner, inertName, ownerDisplayName, tryEffectiveTaskOwner } from "../developer/task-records.js";
import { personNameForText } from "../developer/requester-text.js";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { parseGitHubRepository, type AgentGitHubScope, type AgentRepositoryLabel, type AgentTokenOptions } from "../github-app.js";
import { githubAgentToolPermissions, type GitHubAgentTokenPermissions } from "./github-agent-tools.js";
import { errorNameOf, log, type ApprovalDependencies, type ApproverSpec, type TransactItem } from "./approvals-store.js";
import type { answerForHeldCall} from "./write-gate.js";
import { decideWrite, type ClassifyContext, type Regranted } from "./write-gate.js";
import { githubLabelLister, type LabelLister } from "./label-names.js";
import type { RunCache } from "./run-cache.js";
import { factsForCall, grantCovers, resolveToolGrants, stepToolPatterns, toolGranted, type GrantConnector } from "./tool-grants.js";
import {
  classifyAgentWrite,
  prepareAgentWrite,
  recordOwnItems,
  type ClassifyAgentWriteDependencies,
  type ClassifyAgentWriteInput,
  type WriteClassification,
} from "./write-class.js";

/** `ConnectorCallRequest & { connector }`: what the worker's bridge sends (its workspace id is the capability's, not the body's). */
export const AgentToolCallRequestSchema = ConnectorCallRequestSchema.extend({ connector: ConnectorNameSchema }).strict();
export type AgentToolCallRequest = z.infer<typeof AgentToolCallRequestSchema>;

/** The run a request belongs to, found by the broker from the operation's capability. */
export interface AgentToolsRun {
  orgId: OrgId;
  task: DeveloperTaskRecord;
  workspace: WorkspaceInstance;
  /** The operation; `programStepId` is the recipe step it runs (an agent step records its step id there). */
  operation: { id: string; programStepId?: string | undefined };
}

// ---------------------------------------------------------------------------------------------
// The write gate (Task 21's `decideWrite` goes here)
// ---------------------------------------------------------------------------------------------

/** What the gate decides: send the call, hold it for a person (the step must not send it again), or end it with a reason. */
export type AgentWriteDecision =
  | { decision: "run" }
  | { decision: "wait"; text: string; approvalId?: string }
  | { decision: "refuse"; code: AgentXErrorCode; message: string }
  /** The request id was already claimed while the gate decided: nothing was made, and the call replays what the claim holds. */
  | { decision: "replay" };

/** Everything the gate may need. `args` is exactly what will be sent if it says `run`; `classifyInput` is what classification reads (it also holds the values the server binds). */
export interface AgentWriteGateInput {
  orgId: OrgId;
  taskId: string;
  operationId: string;
  project: string;
  agent: { id: string; name: string };
  /** The recipe step the operation runs, and the person the run belongs to (the task's creator). */
  stepId: string;
  owner: { developerId: string; name: string };
  requestId: string;
  /** The project's name for the connector, the scope alias and the schema hash the step saw. */
  connector: string;
  scope: string;
  schemaHash: string;
  tool: GrantedTool;
  args: Record<string, unknown>;
  /** The @-mentions removed from the text on the way, as they were written. */
  strippedMentions: string[];
  recipe: { autonomy: Autonomy; approvals: ApprovalRules; allowMentions: boolean };
  classifyInput: ClassifyAgentWriteInput;
  /** `classifyAgentWrite` on `classifyInput`, with the lookups it needs, read now. */
  classify(): Promise<WriteClassification>;
  /** A conditional ledger put that claims the call's request id for `approvalId`, for the transaction that makes the approval. Absent where the install has no such ledger. */
  claimRequest?(approvalId: string): TransactItem;
  /** A condition that the step's operation has not ended, for the transaction that makes the approval (see `DecideWriteInput.operationGuard`). */
  operationGuard?: TransactItem;
  /** Plan 4 (N2): the chain step that started the task, for the registered selectors of who approves its writes. Absent for any other task. */
  chain?: { chainRunId: string; stepId: string };
}
export type AgentWriteGate = (input: AgentWriteGateInput) => Promise<AgentWriteDecision>;

const notGrantedText = (agent: string, connector: string, tool: string, project: string): string => `${agent} isn't allowed to use ${connector} ${tool} on ${project}.`;

/** The stand-in until Task 21: reads and safe writes run, a project's deny rule refuses, anything that needs a person is refused with a clear message. */
export const approvalsNotWiredGate: AgentWriteGate = async (input) => {
  const classification = await input.classify();
  if (classification.denied !== undefined) {
    return { decision: "refuse", code: "AGENT_TOOL_NOT_GRANTED", message: notGrantedText(input.agent.name, input.connector, input.tool.upstreamName, input.project) };
  }
  if (classification.class === "read" || classification.class === "safe") return { decision: "run" };
  return {
    // Not RUNTIME_UNAVAILABLE (a 503 reads as "try again"): this stays refused until approvals exist.
    decision: "refuse", code: "FORBIDDEN",
    message: "Changes that need a person's approval aren't available in this release yet, so this call was not sent. Nothing was changed.",
  };
};

// ---------------------------------------------------------------------------------------------
// Who approves a write (Plan 4, N2, R64): a registry beside the call, so that Plan 3 imports nothing from Plan 4
// ---------------------------------------------------------------------------------------------

/** The task a write is made in, as far as a selector may look at it: its id and the chain step that started it, if one did. */
export interface WriteApproverTask { taskId: string; chain?: { chainRunId: string; stepId: string } }

/** The run's project and its owner, as `decideWrite` takes them. */
export interface WriteApproverRun { orgId: OrgId; project: string; owner: { developerId: string; name: string } }

/**
 * Answers who decides a write of `task`, as a `rule` spec the call stores on the approval, or `undefined` to leave it to the next selector and in the end to
 * Plan 3's default (`write_approver`). It never changes the write's class: the write waits whatever a selector says.
 */
export type WriteApproverSelector = (deps: ApprovalDependencies, task: WriteApproverTask, run: WriteApproverRun) => Promise<ApproverSpec | undefined>;

const selectors: WriteApproverSelector[] = [];

/** How long one selector may take before the write falls back to Plan 3's default. */
export const WRITE_APPROVER_SELECTOR_TIMEOUT_MS = 1_000;

/** Registers a selector after the ones already there (they are asked in registration order). Returns the function that takes it off again. */
export function registerWriteApproverSelector(selector: WriteApproverSelector): () => void {
  selectors.push(selector);
  return () => {
    const index = selectors.indexOf(selector);
    if (index >= 0) selectors.splice(index, 1);
  };
}

/** A well-formed answer: a `rule` spec with a rule name and a list of people. Anything else is not an answer. */
const isRuleSpec = (answer: unknown): answer is Extract<ApproverSpec, { kind: "rule" }> => {
  if (typeof answer !== "object" || answer === null) return false;
  const spec = answer as { kind?: unknown; rule?: unknown; candidates?: unknown };
  return spec.kind === "rule" && typeof spec.rule === "string" && spec.rule !== "" && Array.isArray(spec.candidates) && spec.candidates.every((id) => typeof id === "string");
};

/**
 * Asks the registered selectors, in order, who approves a write: the first that answers with a `rule` spec wins and a later one can't override it. A selector
 * that throws, takes longer than `WRITE_APPROVER_SELECTOR_TIMEOUT_MS` or answers anything but `undefined` or a `rule` spec is logged as
 * `write_approver_selector.failed` (with the task id) and the write falls back to Plan 3's default approvers: never to none, and never to a different class.
 */
export async function selectWriteApprovers(deps: ApprovalDependencies, task: WriteApproverTask, run: WriteApproverRun): Promise<ApproverSpec | undefined> {
  for (const selector of [...selectors]) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([
        Promise.resolve().then(() => selector(deps, task, run)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), WRITE_APPROVER_SELECTOR_TIMEOUT_MS); }),
      ]);
      if (answer === undefined) continue;
      if (isRuleSpec(answer)) return { kind: "rule", rule: answer.rule, candidates: [...answer.candidates] };
      log(deps, "write_approver_selector.failed", { taskId: task.taskId, reason: "not_a_rule_spec" });
      return undefined;
    } catch (error) {
      log(deps, "write_approver_selector.failed", { taskId: task.taskId, reason: error instanceof Error && error.message === "timed out" ? "timeout" : errorNameOf(error) });
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return undefined;
}

/**
 * Task 21's `decideWrite` as the gate: the classification the route made (on the arguments the server binds too) decides. A read or a safe write runs; a project
 * rule's deny refuses; a consequential one or a merge becomes a pending approval and the step is told it waits. The approval holds exactly the prepared arguments.
 */
export function approvalsWriteGate(deps: ApprovalDependencies): AgentWriteGate {
  return async (input) => {
    const classification = await input.classify();
    const context: ClassifyContext = {
      rules: input.recipe.approvals, autonomy: input.recipe.autonomy, allowMentions: input.recipe.allowMentions,
      projectPolicy: input.classifyInput.projectPolicy, guardrails: input.classifyInput.guardrails,
    };
    // Only a write that will wait for a person has approvers to choose; the selectors are not asked for a read, a safe write or a refused one.
    const needsApprovers = classification.denied === undefined && (classification.class === "consequential" || classification.class === "merge");
    const approvers = needsApprovers ? await selectWriteApprovers(deps, { taskId: input.taskId, ...(input.chain === undefined ? {} : { chain: input.chain }) }, { orgId: input.orgId, project: input.project, owner: input.owner }) : undefined;
    const decided = await decideWrite(deps, {
      ...(approvers === undefined ? {} : { approvers }),
      orgId: input.orgId, taskId: input.taskId, operationId: input.operationId, stepId: input.stepId, agentId: input.agent.id, agentName: input.agent.name,
      tool: input.tool, call: { scope: input.scope, schemaHash: input.schemaHash, arguments: input.args }, classify: context, classification,
      run: { project: input.project, owner: input.owner }, ...(input.claimRequest === undefined ? {} : { claimRequest: (approvalId: string) => input.claimRequest!(approvalId) }),
      ...(input.operationGuard === undefined ? {} : { operationGuard: input.operationGuard }),
    });
    if (decided.outcome === "run") return { decision: "run" };
    if (decided.outcome === "replay") return { decision: "replay" };
    if (decided.outcome === "wait") return { decision: "wait", text: decided.answer.text, approvalId: decided.approvalId };
    return { decision: "refuse", code: "FORBIDDEN", message: decided.reason };
  };
}

const GateDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("run") }).strict(),
  z.object({ decision: z.literal("replay") }).strict(),
  z.object({ decision: z.literal("wait"), text: z.string().min(1).max(2_000), approvalId: z.string().min(1).max(64).optional() }).strict(),
  z.object({ decision: z.literal("refuse"), code: AgentXErrorCodeSchema, message: z.string().min(1).max(2_000) }).strict(),
]);

// ---------------------------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------------------------

/** The GitHub App calls an agent's tools need. `createAgentInstallationToken` carries exactly the permissions it is given (plus `metadata: read`) and nothing wider. */
export interface AgentGitHubProvider {
  createAgentInstallationToken(repository: { owner: string; name: string }, permissions: GitHubAgentTokenPermissions, scope: AgentGitHubScope, options?: AgentTokenOptions): Promise<string>;
  getAgentPullRequestHead(repositoryUrl: string, number: number, scope: AgentGitHubScope, options?: AgentTokenOptions): Promise<{ headSha: string; state: string }>;
  listAgentRepositoryLabels?(repositoryUrl: string, scope: AgentGitHubScope, options?: AgentTokenOptions): Promise<AgentRepositoryLabel[]>;
}

export interface AgentToolsDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  audit?: ClassifyAgentWriteDependencies["audit"];
  /** A12: ends the task `creator_removed` and refuses (TASK_ACCESS_DENIED) when its creator is no longer a member of the org. */
  requireCreatorStillMember(task: DeveloperTaskRecord): Promise<void>;
  /** A13: refuses when the task's person has no authority on the project now. */
  requireProjectAuthority(orgId: OrgId, ownerKey: string, project: string, options: { taskCreator?: () => Promise<string | undefined> }): Promise<unknown>;
  /** The project's latest registered revision (read now). */
  latestProject(orgId: OrgId, project: string): Promise<{ definition: ProjectDefinition }>;
  /** The recipe the task froze, checked against the digest it recorded; undefined for a task with no agent. */
  readSnapshot(task: DeveloperTaskRecord, orgId: OrgId): Promise<ResolvedRecipe | undefined>;
  /** The project's connectors, resolved for the org. */
  connectors(input: { orgId: OrgId; definition: ProjectDefinition }): ResolvedConnector[];
  catalogs: CatalogCache<ScopeDiscovery>;
  ledger(workspaceId: string, connector: ResolvedConnector): Ledger;
  /** The org's guardrails that add to the maintained command and trigger-label lists (read now). */
  guardrails(orgId: OrgId): Promise<{ extraCommandWords: readonly string[]; extraTriggerLabels: readonly string[] }>;
  github?: AgentGitHubProvider;
  /** A read-only view of a repository's default branch, for the comment-trigger rule. Absent: a GitHub write can't be checked, so it waits. */
  repositoryReader?: ClassifyAgentWriteDependencies["repositoryReader"];
  runCache(scope: { orgId: OrgId; taskId: string }): RunCache;
  /** The ledger item that holds a call for approval (see `claimRequest`); absent where approvals are not set up. */
  holdItem?(input: { workspaceId: string; connector: ResolvedConnector; record: Invocation; approvalId: string }): TransactItem;
  /** What the approval a held call waits on says now (see `answerForHeldCall`); absent where approvals are not set up. */
  heldCall?(orgId: OrgId, approvalId: string): ReturnType<typeof answerForHeldCall>;
  /** Extra or replacement label listers by connector type; the connector's own are built in. */
  labelListers?(run: AgentToolsRun): Readonly<Record<string, LabelLister>>;
  gate: AgentWriteGate;
  /** C55: the login of the GitHub account a person linked, for a footer that cannot name them by an email address; absent: the footer says "a member". */
  githubLoginOf?(developerId: string): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------------------------
// Label lists through the connector call path
// ---------------------------------------------------------------------------------------------

const MAX_LABELS = 5_000;

/** Every `{ id, name }` pair in a label list's answer, wherever the vendor nests it. */
function labelPairs(value: unknown, depth = 0, found: Array<[string, string]> = []): Array<[string, string]> {
  if (depth > 5 || found.length >= MAX_LABELS || value === null || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const entry of value as unknown[]) labelPairs(entry, depth + 1, found);
    return found;
  }
  const record = value as Record<string, unknown>;
  const id = record["id"];
  const name = record["name"];
  if ((typeof id === "string" || typeof id === "number") && typeof name === "string" && name !== "") found.push([String(id), name]);
  for (const entry of Object.values(record)) labelPairs(entry, depth + 1, found);
  return found;
}

/**
 * A connector's label list, read through its own read tool (the first of `tools` that answers): every id and every name maps to the name, so a call that
 * writes names resolves as well as one that writes ids. The label Rovara adds itself resolves without being listed. Throws when no tool answers or the
 * answer holds no labels, which makes the call that needed it wait.
 */
export function connectorLabelLister(input: { tools: readonly string[]; run(tool: string, args: Record<string, unknown>): Promise<string | undefined> }): LabelLister {
  return async () => {
    for (const tool of input.tools) {
      const text = await input.run(tool, {});
      if (text === undefined) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new Error("the label list is not readable"); }
      const pairs = labelPairs(parsed);
      if (pairs.length === 0) throw new Error("the label list holds no labels");
      const table = new Map<string, string>();
      for (const [id, name] of pairs) { table.set(id, name); table.set(name, name); }
      table.set("rovara", "rovara");
      return table;
    }
    throw new Error("the connector has no label list to read");
  };
}

/** The read tools that list labels, by connector type (an MCP server's own name for it is not known, so the usual ones are tried). */
const LABEL_LIST_TOOLS: Readonly<Record<string, readonly string[]>> = { linear: ["list_issue_labels"], mcp: ["list_labels", "list_issue_labels"] };

// ---------------------------------------------------------------------------------------------
// GitHub, for an agent
// ---------------------------------------------------------------------------------------------

/** What a catalog read asks GitHub's tools list with: read permissions only. */
const GITHUB_DISCOVERY_PERMISSIONS = { issues: "read", pull_requests: "read", contents: "read" } as const;

/**
 * The installation a repository's record pins, read from its host record (task P7; the old top-level `installationId` reads as before). Only a GitHub host has one: a record on
 * another code host pins nothing here, and its repository is not one this GitHub connector reaches (the connector is GitHub's, outside the code-host port).
 * Latent asymmetry: other control-plane checks still read the top-level field alone (see project-working-branch-host.ts); no record that exists differs.
 */
const pinOf = (repository: Pick<RepositoryDefinition, "host" | "installationId" | "githubRepositoryId">): AgentTokenOptions => {
  const host = repositoryHostOf(repository);
  const installationId = host.kind === "github" ? (host as { installationId?: number | undefined }).installationId : undefined;
  return installationId === undefined ? {} : { installationId };
};

/**
 * The project's GitHub connector as an agent uses it: the same repositories, tools and ledger, but the credential is an agent token for the run's org with
 * exactly the permissions of the tool being called (`githubAgentToolPermissions`; read-only for a catalog), held to the installation the project pinned, and
 * the guard is the agent guard (a pull request tool needs a pull request that exists in the bound repository). The human tokens of the Slack path are never used.
 */
export function agentGitHubConnector(connector: ResolvedConnector, deps: AgentToolsDependencies, input: { orgId: OrgId; tool?: string }): ResolvedConnector {
  const provider = deps.github;
  return {
    ...connector,
    async definition() {
      const human = await connector.definition();
      if ("notConnected" in human) return human;
      if (provider === undefined) return { notConnected: "GitHub is not set up for agents in this deployment" };
      const permissions: GitHubAgentTokenPermissions = input.tool === undefined ? { ...GITHUB_DISCOVERY_PERMISSIONS } : githubAgentToolPermissions(input.tool);
      const scope = { orgId: input.orgId };
      const pullRequestExists = async (found: { owner: string; repo: string; number: number }): Promise<boolean> => {
        const pin = pinOfRepository(connector, found);
        try {
          await provider.getAgentPullRequestHead(`https://github.com/${found.owner}/${found.repo}.git`, found.number, scope, pin);
          return true;
        } catch (error) {
          if (error instanceof Error && (error as { code?: unknown }).code === "CONFIG_INVALID") return false;
          throw error;
        }
      };
      return {
        ...githubConnector(async (repository) => {
          const { owner, name } = parseGitHubRepository(repository.url);
          const token = await provider.createAgentInstallationToken({ owner, name }, permissions, scope, pinOf(repository as { installationId?: number }));
          return { owner, repo: name, token };
        }),
        guards: [agentGitHubGuard({ pullRequestExists })],
      };
    },
  };
}

/** The installation pin of the project repository named `owner/repo` among the connector's scopes. */
function pinOfRepository(connector: ResolvedConnector, found: { owner: string; repo: string }): AgentTokenOptions {
  for (const scope of connector.scopes) {
    const repository = scope.scope as { url?: unknown; installationId?: number };
    if (typeof repository.url !== "string") continue;
    try {
      const parsed = parseGitHubRepository(repository.url);
      if (parsed.owner.toLowerCase() === found.owner.toLowerCase() && parsed.name.toLowerCase() === found.repo.toLowerCase()) return pinOf(repository);
    } catch {
      // A repository entry that isn't a GitHub URL pins nothing.
    }
  }
  return {};
}

/** `owner/name` (as the URL spells it) and the pin of a GitHub scope's repository, or undefined for a scope that isn't one. */
function githubScopeRepository(connector: ResolvedConnector, alias: string): { owner: string; name: string; installationId?: number } | undefined {
  const scope = connector.scopes.find((entry) => entry.alias === alias);
  const repository = scope?.scope as ({ url?: unknown } & Pick<RepositoryDefinition, "host" | "installationId" | "githubRepositoryId">) | undefined;
  if (repository === undefined || typeof repository.url !== "string") return undefined;
  try {
    const parsed = parseGitHubRepository(repository.url);
    const pin = pinOf(repository).installationId;
    return { owner: parsed.owner, name: parsed.name, ...(pin === undefined ? {} : { installationId: pin }) };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// The run's frame
// ---------------------------------------------------------------------------------------------

interface Frame {
  project: { definition: ProjectDefinition };
  recipe: ResolvedRecipe;
  agentId: string;
  agentName: string;
  stepId: string;
  stepTools: string[] | undefined;
  connectors: ResolvedConnector[];
  context: ConnectorContextBase;
}

/** The authority checks, then what the run is made of. Undefined for a task with no agent snapshot. */
async function frameOf(deps: AgentToolsDependencies, run: AgentToolsRun): Promise<Frame | undefined> {
  const { task, orgId } = run;
  await deps.requireCreatorStillMember(task);
  await deps.requireProjectAuthority(orgId, task.ownerKey, task.project, { taskCreator: async () => effectiveTaskOwner(task).developerId });
  const recipe = await deps.readSnapshot(task, orgId);
  if (recipe === undefined) return undefined;
  const step = recipe.steps.find((entry) => entry.id === run.operation.programStepId && entry.kind === "agent");
  if (step === undefined) throw agentXError("NOT_FOUND", "no agent step belongs to this operation");
  const project = await deps.latestProject(orgId, task.project);
  const last = recipe.chain.at(-1);
  return {
    project, recipe,
    agentId: task.agent?.agentId ?? last?.agentId ?? "agent",
    agentName: task.agent?.name ?? last?.name ?? "This agent",
    stepId: step.id,
    stepTools: stepToolPatterns(step),
    connectors: deps.connectors({ orgId, definition: project.definition }),
    context: { orgId, workspaceId: run.workspace.id, ownerKey: task.ownerKey, settingsRevision: project.definition.revision },
  };
}

const asGrantConnector = (connector: ResolvedConnector): GrantConnector => ({ name: connector.name, type: connector.type, approvals: connector.approvals.map((approval) => ({ name: approval.name, access: accessOf(connector, approval.name) })) });

/** The access the project approved a tool for (its policy, which the presentation's approvals mirror). */
function accessOf(connector: ResolvedConnector, name: string): "read" | "write" {
  return connector.policy.tools.find((entry) => entry.name === name)?.access ?? "write";
}

function withoutGateFields(tool: PresentedTool): PresentedTool {
  const copy = { ...tool };
  delete copy.hints;
  delete copy.itemArguments;
  return copy;
}

/** The connector's catalog, with the gate fields, through the cache. A GitHub connector is asked with a read-only agent token. */
function discover(deps: AgentToolsDependencies, run: Pick<AgentToolsRun, "orgId" | "workspace">, frame: Pick<Frame, "context">, connector: ResolvedConnector): Promise<ConnectorCatalog> {
  const forAgent = connector.type === "github" ? agentGitHubConnector(connector, deps, { orgId: run.orgId }) : connector;
  return discoverConnector({ connector: forAgent, workspace: run.workspace, context: frame.context, catalogs: deps.catalogs, includeGateFields: true });
}

// ---------------------------------------------------------------------------------------------
// GET /v1/internal/agent-tools
// ---------------------------------------------------------------------------------------------

/** The tools the step's agent may use: only granted ones, shown as the model sees them. A connector with none granted is not listed. */
export async function listAgentTools(deps: AgentToolsDependencies, run: AgentToolsRun): Promise<{ catalogs: ConnectorCatalog[] }> {
  const frame = await frameOf(deps, run);
  if (frame === undefined) return { catalogs: [] };
  const catalogs: ConnectorCatalog[] = [];
  for (const connector of frame.connectors) {
    if (!frame.recipe.tools.some((grant) => grantCovers(grant, connector))) continue;
    const catalog = await discover(deps, run, frame, connector);
    const granted = resolveToolGrants({ grants: frame.recipe.tools, stepTools: frame.stepTools, connectors: [asGrantConnector(connector)], catalogs: [catalog] });
    if (granted.length === 0) continue;
    const names = new Set(granted.map((tool) => tool.upstreamName));
    catalogs.push({ connector: catalog.connector, tools: catalog.tools.filter((tool) => names.has(tool.upstreamName)).map(withoutGateFields), skipped: [] });
  }
  return { catalogs };
}

// ---------------------------------------------------------------------------------------------
// POST /v1/internal/agent-tools/call
// ---------------------------------------------------------------------------------------------

/** The footer a connector adds to the long text of a write: the person and the agent it is for. */
export function attributionOf(task: DeveloperTaskRecord, agentName: string, githubLogin?: string): string {
  // C55: never an email address (the display name can be one): the name without it, else the GitHub login, else the fixed label.
  const who = personNameForText(ownerDisplayName(task), githubLogin) ?? UNNAMED_MEMBER;
  return `Requested by ${inertName(who)} via Rovara agent ${inertName(agentName)}`;
}

/** The linked GitHub login of the task's owner, asked for only when their display name is an email address (the one case a footer needs it). */
export async function ownerGithubLoginOf(deps: Pick<AgentToolsDependencies, "githubLoginOf">, task: DeveloperTaskRecord): Promise<string | undefined> {
  const name = ownerDisplayName(task);
  if (deps.githubLoginOf === undefined || personNameForText(name) !== undefined) return undefined;
  const owner = tryEffectiveTaskOwner(task);
  return owner === undefined ? undefined : deps.githubLoginOf(owner.developerId);
}

/** The label listers for this run: GitHub's, the connectors' own through the call path, and whatever the dependencies add or replace. */
function labelListersFor(deps: AgentToolsDependencies, run: AgentToolsRun, frame: Frame): Readonly<Record<string, LabelLister>> {
  const listers: Record<string, LabelLister> = {};
  const github = deps.github;
  if (github?.listAgentRepositoryLabels !== undefined) {
    // The labels of a repository are read with a token held to the installation the project pinned for it.
    listers["github"] = githubLabelLister({ listAgentRepositoryLabels: (url, scope) => github.listAgentRepositoryLabels!(url, scope, pinOfProjectRepository(frame.project.definition, url)) });
  }
  for (const type of Object.keys(LABEL_LIST_TOOLS)) {
    listers[type] = async ({ connector: label }) => {
      const connector = frame.connectors.find((entry) => entry.name === label.id && entry.type === type);
      if (connector === undefined) throw new Error("no such connector");
      const catalog = await discover(deps, run, frame, connector);
      const candidates = LABEL_LIST_TOOLS[type] ?? [];
      const offered = candidates.filter((name) => catalog.tools.some((tool) => tool.upstreamName === name && tool.access === "read"));
      return connectorLabelLister({
        tools: offered,
        run: async (name, args) => {
          const tool = catalog.tools.find((entry) => entry.upstreamName === name);
          const scope = tool?.scopes[0];
          if (tool === undefined || scope === undefined) return undefined;
          const result = await callConnector({
            connector, workspace: run.workspace, context: frame.context, catalogs: deps.catalogs, ledger: deps.ledger(run.workspace.id, connector),
            request: { requestId: randomUUID(), scope: scope.alias, tool: name, schemaHash: scope.schemaHash, arguments: args },
          });
          return result.status === "SUCCEEDED" ? result.text : undefined;
        },
      })({ orgId: run.orgId, connector: label });
    };
  }
  return { ...listers, ...deps.labelListers?.(run) };
}

/** What a call that waits for a person answers: the connector result's shape with the status that says so. */
export type WaitingResult = Omit<ConnectorResult, "status"> & { status: "WAITING_FOR_APPROVAL" };

/** What classification reads: the State table, the run's cache, the label lists and the repository reader. */
export function classifyDependenciesOf(deps: AgentToolsDependencies, labelListers: Readonly<Record<string, LabelLister>>): ClassifyAgentWriteDependencies {
  return {
    documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...(deps.audit === undefined ? {} : { audit: deps.audit }),
    labelListers, runCache: (scope) => deps.runCache(scope),
    repositoryReader: deps.repositoryReader ?? (async () => { throw new Error("reading repositories is not set up in this deployment"); }),
  };
}

/** One tool call by an agent step. Returns the connector's result, or a wait for a person (the step must not send the call again). */
export async function callAgentTool(deps: AgentToolsDependencies, run: AgentToolsRun, rawBody: unknown): Promise<{ result: ConnectorResult | WaitingResult; approvalId?: string }> {
  const parsed = AgentToolCallRequestSchema.safeParse(rawBody);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "invalid agent tool request");
  const { connector: connectorName, ...request } = parsed.data;
  const { task, orgId } = run;

  const frame = await frameOf(deps, run);
  if (frame === undefined) throw agentXError("NOT_FOUND", "no agent snapshot belongs to this operation");
  const notGranted = () => agentXError("AGENT_TOOL_NOT_GRANTED", notGrantedText(frame.agentName, connectorName, request.tool, task.project));

  // The grant, from the project's connectors as they are now and the recipe the task froze. GitHub's own map and refusals come first.
  const connector = frame.connectors.find((entry) => entry.name === connectorName);
  if (connector === undefined) throw notGranted();
  if (connector.type === "github") githubAgentToolPermissions(request.tool);
  if (toolGranted({ grants: frame.recipe.tools, stepTools: frame.stepTools, connector: asGrantConnector(connector), upstreamName: request.tool }) === undefined) throw notGranted();
  if (!connector.scopes.some((entry) => entry.alias === request.scope)) throw agentXError("NOT_FOUND", "connector scope not found");
  // The repository a GitHub call is about is the scope's, from the project's repositories; the server binds owner and repo from it. A call that names a
  // repository of its own (a model has no reason to) names that one, or is refused before any token is minted.
  const named = namedRepository(request.arguments);
  const scopeRepository = connector.type === "github" ? githubScopeRepository(connector, request.scope) : undefined;
  if (connector.type === "github" && scopeRepository === undefined) throw notGranted();
  if (scopeRepository !== undefined && named !== undefined && named !== `${scopeRepository.owner}/${scopeRepository.name}`.toLowerCase()) throw notGranted();

  const catalog = await discover(deps, run, frame, connector);
  const granted = resolveToolGrants({ grants: frame.recipe.tools, stepTools: frame.stepTools, connectors: [asGrantConnector(connector)], catalogs: [catalog] })
    .find((tool) => tool.upstreamName === request.tool);
  if (granted === undefined) throw notGranted();

  // Prepared: what the vendor will be sent is what the gate decides on.
  const prepared = prepareAgentWrite(granted, request.arguments, { allowMentions: frame.recipe.allowMentions });
  const github = scopeRepository;
  // The server binds a GitHub call's owner and repo; classification needs them to tell the run's own issues from another repository's.
  const classifyArgs = github === undefined ? prepared.args : { ...prepared.args, owner: github.owner, repo: github.name };
  const classifyTool: GrantedTool = { ...granted, facts: factsForCall(granted.type, granted.facts, classifyArgs) };
  const guardrails = await deps.guardrails(orgId);
  const classifyInput: ClassifyAgentWriteInput = {
    tool: classifyTool, args: classifyArgs,
    ...(frame.project.definition.actionPolicy === undefined ? {} : { projectPolicy: frame.project.definition.actionPolicy }),
    rules: frame.recipe.approvals, autonomy: frame.recipe.autonomy, allowMentions: frame.recipe.allowMentions,
    guardrails, orgId, taskId: task.taskId, project: task.project,
    ...(github === undefined ? {} : { repository: `${github.owner}/${github.name}`, ...(github.installationId === undefined ? {} : { installationId: github.installationId }) }),
  };
  const classifyDeps = classifyDependenciesOf(deps, labelListersFor(deps, run, frame));
  let classification: Promise<WriteClassification> | undefined;

  const ledger = deps.ledger(run.workspace.id, connector);
  const toolRequest = { requestId: request.requestId, scope: request.scope, tool: request.tool, schemaHash: request.schemaHash, arguments: prepared.args };
  const executing = connector.type === "github" ? agentGitHubConnector(connector, deps, { orgId, tool: request.tool }) : connector;
  /** The call through the connector call path, with the connector's ledger: a repeated request id replays what the ledger holds, and nothing is sent twice. */
  const callThrough = async (options: { durable?: boolean } = {}) => callConnector({
    connector: executing, workspace: run.workspace, context: frame.context, catalogs: deps.catalogs, ledger, request: toolRequest,
    ...(options.durable === true ? { durable: true } : {}),
    ...(connector.attribution ? { attribution: attributionOf(task, frame.agentName, await ownerGithubLoginOf(deps, task)) } : {}),
  });

  /**
   * A request id the ledger already holds is a call that ran (or was held) before: it is answered from the ledger, with the owner, workspace and fingerprint
   * checks the engine makes, and never asked of the gate. Otherwise a retry of a call that already ran could be held now (a lookup failing closed, a rule
   * changed) and sent a second time, under another request id, when a person approves it.
   */
  const replayOfRecorded = async (): Promise<{ result: ConnectorResult | WaitingResult; approvalId?: string } | undefined> => {
    const recorded = await ledger.get(request.requestId);
    if (recorded === undefined) return undefined;
    const held = (recorded as Invocation & { approvalId?: unknown }).approvalId;
    // The checks the engine makes on a recorded request id: the same owner and workspace, nobody on whose behalf it was asked (an agent has no requester), and
    // the same call. A different tool or different arguments under the id is a conflict, and nothing is sent.
    if (recorded.ownerKey !== frame.context.ownerKey || recorded.workspaceId !== run.workspace.id || recorded.requestedBy !== undefined) throw agentXError("NOT_FOUND", "MCP invocation not found");
    if (recorded.fingerprint !== requestFingerprint(toolRequest)) throw agentXError("IDEMPOTENCY_CONFLICT", "MCP request ID already used with different inputs");
    // An ordinary record is answered from the record itself, never by calling the connector: the engine reads the ledger only for a durable call, so a call of a
    // tool approved for reading would be sent again, with no gate and no approval.
    if (typeof held !== "string") return { result: { ...recorded.result, replayed: true } };
    // A call held for a person: the approval answers (waiting, its result once it ran, or decided).
    const answer = await deps.heldCall?.(orgId, held);
    if (answer === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the approval this call waits on can't be read");
    if (answer.kind === "wait") return { result: { requestId: request.requestId, status: "WAITING_FOR_APPROVAL", text: answer.text, truncated: false, replayed: true }, approvalId: held };
    if (answer.kind === "result") return { result: { requestId: request.requestId, status: "SUCCEEDED", text: answer.result.text, truncated: answer.result.truncated, replayed: true } };
    throw agentXError("FORBIDDEN", answer.text);
  };
  const replayed = await replayOfRecorded();
  if (replayed !== undefined) return replayed;

  const holdRecord = (): Invocation => {
    const at = new Date(deps.now()).toISOString();
    return {
      requestId: request.requestId, workspaceId: run.workspace.id, ownerKey: frame.context.ownerKey, repository: request.scope, tool: request.tool,
      fingerprint: requestFingerprint(toolRequest), createdAt: at, updatedAt: at,
      result: { requestId: request.requestId, status: "IN_PROGRESS", text: "This call is waiting for a person to approve it.", truncated: false, replayed: false },
      ...(frame.context.settingsRevision === undefined ? {} : { settingsRevision: frame.context.settingsRevision }),
    };
  };
  const holdItem = deps.holdItem?.bind(deps);
  const decision = GateDecisionSchema.safeParse(await deps.gate({
    orgId, taskId: task.taskId, operationId: run.operation.id, project: task.project, agent: { id: frame.agentId, name: frame.agentName },
    stepId: frame.stepId, owner: { developerId: effectiveTaskOwner(task).developerId, name: effectiveTaskOwner(task).name }, ...(task.chain === undefined ? {} : { chain: task.chain }),
    requestId: request.requestId, connector: connectorName, scope: request.scope, schemaHash: request.schemaHash,
    tool: classifyTool, args: prepared.args, strippedMentions: prepared.strippedMentions,
    recipe: { autonomy: frame.recipe.autonomy, approvals: frame.recipe.approvals, allowMentions: frame.recipe.allowMentions },
    classifyInput,
    classify: () => (classification ??= classifyAgentWrite(classifyDeps, classifyInput)),
    ...(holdItem === undefined ? {} : { claimRequest: (approvalId: string) => holdItem({ workspaceId: run.workspace.id, connector, record: holdRecord(), approvalId }) }),
    // The approval is made only while the step's operation is still running (Task 22 review, M2).
    operationGuard: {
      ConditionCheck: {
        TableName: deps.tableName, Key: { pk: `WORKSPACE#${run.workspace.id}`, sk: `OPERATION#${run.operation.id}` },
        ConditionExpression: "#status = :accepted OR #status = :dispatching OR #status = :running",
        ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":running": "RUNNING" },
      },
    },
  }));
  if (!decision.success) throw new Error("the write gate answered something unexpected");
  if (decision.data.decision === "refuse") throw agentXError(decision.data.code, decision.data.message);
  if (decision.data.decision === "replay") {
    // The id was claimed while the gate decided (by a run that got there first, or another hold): answer from that claim.
    const again = await replayOfRecorded();
    if (again === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the request id was claimed but its record can't be read");
    return again;
  }
  if (decision.data.decision === "wait") {
    return {
      // Not "IN_PROGRESS": the model is told what is happening and that it must not send the call again (a person decides it; the outcome comes back to the run).
      result: { requestId: request.requestId, status: "WAITING_FOR_APPROVAL", text: decision.data.text, truncated: false, replayed: false },
      ...(decision.data.approvalId === undefined ? {} : { approvalId: decision.data.approvalId }),
    };
  }

  // Run: through the connector call path. Whatever is not a plain read is claimed in the ledger when it runs, whatever access the project gave the tool, so a
  // call that could be held for a person (and a hold that races this run) finds the request id taken.
  const klass = classification === undefined ? undefined : (await classification).class;
  const result = await callThrough(klass === "read" ? {} : { durable: true });
  // What a create made is the run's own to change afterwards. The create already happened, so a record that fails never fails the call.
  if (result.status === "SUCCEEDED" && !result.replayed) {
    await recordOwnItems({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, { orgId, taskId: task.taskId, tool: classifyTool, args: classifyArgs, resultText: result.text });
  }
  return { result };
}

/** The installation the project pinned for the repository at `url`, if it pinned one. */
function pinOfProjectRepository(definition: ProjectDefinition, url: string): AgentTokenOptions {
  try {
    const wanted = parseGitHubRepository(url);
    const found = definition.repositories.find((repository) => {
      try {
        const parsed = parseGitHubRepository(repository.url);
        return parsed.owner.toLowerCase() === wanted.owner.toLowerCase() && parsed.name.toLowerCase() === wanted.name.toLowerCase();
      } catch {
        return false;
      }
    });
    return found === undefined ? {} : pinOf(found);
  } catch {
    return {};
  }
}

/** `owner/repo` (lower case) when a call's arguments name both; undefined otherwise. */
function namedRepository(args: Record<string, unknown>): string | undefined {
  const { owner, repo } = args;
  return typeof owner === "string" && typeof repo === "string" ? `${owner.trim()}/${repo.trim()}`.toLowerCase() : undefined;
}

/**
 * Task 21's `regrant`: the agent's grant for the tool of an approved write, resolved again against the project's CURRENT revision and the recipe the task froze
 * (the step is the one the approval names), with the classifier's live inputs. `refused` carries the words shown on the approval's page. The snapshot and the
 * catalog are read as a call reads them, so a snapshot that can't be read throws (`RUNTIME_UNAVAILABLE`) and the approval is tried again.
 */
export async function regrantAgentTool(
  deps: AgentToolsDependencies,
  input: { orgId: OrgId; task: DeveloperTaskRecord; workspace: WorkspaceInstance; stepId: string; connector: string; scope: string; tool: string; args: Record<string, unknown>; definition: ProjectDefinition },
): Promise<Regranted> {
  const { orgId, task, definition } = input;
  const recipe = await deps.readSnapshot(task, orgId);
  if (recipe === undefined) return { refused: "This task no longer has an agent to run this for." };
  const agentName = task.agent?.name ?? recipe.chain.at(-1)?.name ?? "This agent";
  const notGranted = { refused: notGrantedText(agentName, input.connector, input.tool, task.project) };
  const step = recipe.steps.find((entry) => entry.id === input.stepId && entry.kind === "agent");
  if (step === undefined) return notGranted;
  const connector = deps.connectors({ orgId, definition }).find((entry) => entry.name === input.connector);
  if (connector === undefined) return notGranted;
  if (connector.type === "github") {
    try { githubAgentToolPermissions(input.tool); } catch { return notGranted; }
  }
  const stepTools = stepToolPatterns(step);
  if (toolGranted({ grants: recipe.tools, stepTools, connector: asGrantConnector(connector), upstreamName: input.tool }) === undefined) return notGranted;
  const context: ConnectorContextBase = { orgId, workspaceId: input.workspace.id, ownerKey: task.ownerKey, settingsRevision: definition.revision };
  const catalog = await discover(deps, { orgId, workspace: input.workspace }, { context }, connector);
  const granted = resolveToolGrants({ grants: recipe.tools, stepTools, connectors: [asGrantConnector(connector)], catalogs: [catalog] }).find((tool) => tool.upstreamName === input.tool);
  if (granted === undefined) return notGranted;
  // The server binds a GitHub call's owner and repo, so the stored call has neither; classification and the own-item record need them.
  const github = connector.type === "github" ? githubScopeRepository(connector, input.scope) : undefined;
  const classifyArgs = github === undefined ? input.args : { ...input.args, owner: github.owner, repo: github.name };
  const guardrails = await deps.guardrails(orgId);
  return {
    tool: { ...granted, facts: factsForCall(granted.type, granted.facts, classifyArgs) },
    classifyArgs,
    classify: {
      rules: recipe.approvals, autonomy: recipe.autonomy, allowMentions: recipe.allowMentions,
      ...(definition.actionPolicy === undefined ? {} : { projectPolicy: definition.actionPolicy }), guardrails,
    },
  };
}
