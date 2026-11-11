// Plan 3 Task 19: which connector tools one agent step may use. A recipe grants tools by connector (every connector of a type, or the one the project
// calls by a name) and by access (`read`, or `read_write`); a step can narrow them with tool patterns; the project decides what exists at all, by approving
// tools on its connectors. A tool is granted only when all of them agree. The result is a list of `GrantedTool`s, each with the facts Task 20b's write
// classification reads. `resolveToolGrants` is pure: the broker passes in the project's connectors and the catalogs it discovered, and calls it again at
// every call, so a grant is never a thing the model carries.
import { AgentConnectorTypeSchema, PI_TOOL_NAMES, agentXError, toolPatternMatches, type AgentConnectorType, type ConnectorCatalog, type GrantedTool, type PresentedTool, type ResolvedStep, type ToolFacts, type ToolGrant } from "@rovara-code/contracts";
import { GITHUB_AGENT_TOOL_PERMISSIONS, isGitHubAgentToolRefused } from "./github-agent-tools.js";
import { nonTextFactProblems } from "./write-class.js";

export { toolGrantProblems } from "@rovara-code/contracts";

/** What a grant needs to know about a project connector: its name, its type, and what the project approved on it. */
export interface GrantConnector {
  name: string;
  type: string;
  approvals: ReadonlyArray<{ name: string; access: "read" | "write" }>;
}

export interface ResolveToolGrantsInput {
  grants: readonly ToolGrant[];
  /** The step's connector tool patterns (`stepToolPatterns`); absent: the step does not narrow. */
  stepTools?: readonly string[] | undefined;
  connectors: readonly GrantConnector[];
  /** The connectors' catalogs, as `discoverConnector` presents them with the gate fields (`hints`, `itemArguments`). */
  catalogs: readonly ConnectorCatalog[];
}

const isAgentType = (type: string): type is AgentConnectorType => AgentConnectorTypeSchema.safeParse(type).success;

/** Whether the grant covers the connector: every connector of its type, or the one it names. A connector of a type agents can't use is never covered. */
export function grantCovers(grant: ToolGrant, connector: Pick<GrantConnector, "name" | "type">): boolean {
  if (!isAgentType(connector.type)) return false;
  return "type" in grant.connector ? grant.connector.type === connector.type : grant.connector.name === connector.name;
}

/**
 * What a call to the tool would do at the vendor, as far as the permission it needs says: a GitHub tool whose token carries a write permission writes,
 * whatever the project approved it for, so a `read` grant can't reach it. Every other tool is what the project approved it as.
 */
export function effectiveAccess(type: string, upstreamName: string, approved: "read" | "write"): "read" | "write" {
  if (type !== "github" || !Object.hasOwn(GITHUB_AGENT_TOOL_PERMISSIONS, upstreamName)) return approved;
  const permissions = GITHUB_AGENT_TOOL_PERMISSIONS[upstreamName];
  return permissions !== undefined && Object.values(permissions).includes("write") ? "write" : approved;
}

/** Whether a tool the project approved is one that GitHub's agent map and refusals let an agent have at all. */
function githubToolAllowed(upstreamName: string): boolean {
  return !isGitHubAgentToolRefused(upstreamName) && Object.hasOwn(GITHUB_AGENT_TOOL_PERMISSIONS, upstreamName);
}

/**
 * Whether the recipe's grants (and the step's patterns) let the agent use `upstreamName` on `connector`, given what the project approved it as. This is the
 * whole of the policy; `resolveToolGrants` adds only what the vendor offers. Nothing here asks a vendor, so a call that is not granted never reaches one.
 */
export function toolGranted(input: { grants: readonly ToolGrant[]; stepTools?: readonly string[] | undefined; connector: GrantConnector; upstreamName: string }): { access: "read" | "write" } | undefined {
  const { connector, upstreamName } = input;
  if (!isAgentType(connector.type)) return undefined;
  const approval = connector.approvals.find((entry) => entry.name === upstreamName);
  if (approval === undefined) return undefined;
  if (connector.type === "github" && !githubToolAllowed(upstreamName)) return undefined;
  const access = effectiveAccess(connector.type, upstreamName, approval.access);
  if (input.stepTools !== undefined && !input.stepTools.some((pattern) => toolPatternMatches(pattern, upstreamName))) return undefined;
  const allowed = input.grants.some((grant) => grantCovers(grant, connector)
    && (grant.access === "read_write" || access === "read")
    && (grant.tools === undefined || grant.tools.some((pattern) => toolPatternMatches(pattern, upstreamName))));
  return allowed ? { access } : undefined;
}

/**
 * The tools one agent step may use, each with the facts the write classification reads. Overlapping grants on a connector add up (a tool is granted when
 * any grant that covers the connector allows it, so `read` with `read_write` gives `read_write`); a grant's patterns and the step's patterns both narrow;
 * GitHub tools go through the agent map and its refusals first. A tool is listed once, in the connector's and the catalog's order.
 */
export function resolveToolGrants(input: ResolveToolGrantsInput): GrantedTool[] {
  const granted: GrantedTool[] = [];
  for (const connector of input.connectors) {
    if (!isAgentType(connector.type)) continue;
    const catalog = input.catalogs.find((entry) => entry.connector === connector.name);
    if (catalog === undefined || catalog.notConnected === true) continue;
    for (const tool of catalog.tools) {
      const decision = toolGranted({ grants: input.grants, stepTools: input.stepTools, connector, upstreamName: tool.upstreamName });
      if (decision === undefined) continue;
      granted.push({
        connector: connector.name, type: connector.type, upstreamName: tool.upstreamName, presentedName: tool.name, access: decision.access,
        facts: toolFactsFor({ name: connector.name, type: connector.type }, tool, decision.access),
      });
    }
  }
  return granted;
}

/**
 * The connector tool patterns of an agent step: its `tools` setting less the workspace tools (Pi's `read`, `grep`, ...), which are not connector tools.
 * `tools` is an allow-list, so a list that names only workspace tools allows no connector tool (an empty list); only a step with no `tools` setting
 * narrows nothing (undefined).
 */
export function stepToolPatterns(step: ResolvedStep | undefined): string[] | undefined {
  if (step === undefined || step.kind !== "agent") return undefined;
  const listed = step.settings.tools;
  if (listed === undefined) return undefined;
  const pi: readonly string[] = PI_TOOL_NAMES;
  return listed.filter((pattern) => !pi.includes(pattern));
}

// ---------------------------------------------------------------------------------------------
// The facts of a tool
// ---------------------------------------------------------------------------------------------

type FactPatch = Partial<Omit<ToolFacts, "connector" | "upstreamName" | "access" | "hints">>;

/** GitHub names the repository in `owner` and `repo`: the same issue number in another repository is another issue. The broker binds both to the project's. */
const GITHUB_SCOPE = ["owner", "repo"] as const;

/**
 * What the broker declares about each connector type's tools, beyond what the catalog says (Task 20b's hand-off). Only scope arguments, paths, URLs and
 * choices may be `nonTextArguments`; a free-text field never (the builder refuses it). Absent tools take the catalog's facts alone, which the classification
 * reads strictly: a create of something that is not a record, a ticket without Rovara's label, or a change to an item the run did not create waits.
 */
const TYPE_FACTS: Readonly<Record<AgentConnectorType, { all?: FactPatch; tools?: Readonly<Record<string, FactPatch>> }>> = {
  github: {
    all: { itemScopeArguments: GITHUB_SCOPE },
    tools: {
      // A comment or a review annotates its issue or pull request; it does not change it.
      add_issue_comment: { itemArguments: [] },
      pull_request_review_write: { itemArguments: [], nonTextArguments: ["method"] },
      // `labels` replaces the issue's whole label set.
      issue_write: { nonTextArguments: ["method"], labelArgument: "labels", labelsReplace: true, resultItemArguments: ["number"] },
      create_issue: { labelArgument: "labels", labelsReplace: true, resultItemArguments: ["number"] },
      update_issue: { labelArgument: "labels", labelsReplace: true },
    },
  },
  linear: {
    tools: {
      // `labels` replaces the issue's label set; `addLabels` adds to it. Either takes names or ids (see `factsForCall`).
      save_issue: { labelArgument: "labels", labelsReplace: true, resultItemArguments: ["id", "identifier"] },
    },
  },
  jira: {
    tools: {
      createJiraIssue: { labelArgument: "labels", resultItemArguments: ["key", "id"] },
      editJiraIssue: { labelsReplace: true },
      // The issue is where the comment goes; the comment itself is what `commentId` names when one is edited.
      addOrEditJiraIssueComment: { itemArguments: ["commentId"] },
    },
  },
  asana: {
    tools: {
      add_comment: { itemArguments: [] },
    },
  },
  mcp: {},
  // Plan 4 Task 12: the native connectors only read, offer no create or bulk tool and take no item argument (H9), so the catalog's facts are all there are.
  sentry: {}, datadog: {}, cloudwatch: {}, "github-actions": {}, grafana: {}, vercel: {}, pagerduty: {},
};

/**
 * The facts of one granted tool: the catalog's (the connector, the name, the access, the vendor's hints, the item arguments the tool offers) and what the
 * broker declares for its type. Throws `CONFIG_INVALID` when a declaration names a free-text field as not text: that argument would go unscanned.
 */
export function toolFactsFor(connector: { name: string; type: AgentConnectorType }, tool: PresentedTool, access: "read" | "write", extra: FactPatch = {}): ToolFacts {
  const declared = TYPE_FACTS[connector.type];
  const patch = declared.tools !== undefined && Object.hasOwn(declared.tools, tool.upstreamName) ? declared.tools[tool.upstreamName] : undefined;
  const facts: ToolFacts = {
    connector: connector.name,
    upstreamName: tool.upstreamName,
    access,
    ...(tool.hints === undefined ? {} : { hints: tool.hints }),
    ...(tool.itemArguments === undefined ? {} : { itemArguments: [...tool.itemArguments] }),
    ...declared.all,
    ...patch,
    ...extra,
  };
  const problems = nonTextFactProblems(facts);
  if (problems.length > 0) throw agentXError("CONFIG_INVALID", `the facts of ${connector.type} ${tool.upstreamName} are wrong: ${problems.join("; ")}`);
  return facts;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const LINEAR_LABEL_ARGUMENTS = ["labels", "addLabels"] as const;

/**
 * The facts for one call. Linear's `labels` and `addLabels` take names or ids, and an id says nothing about the label it names (`automerge` and `bug`
 * look alike as ids), so when a call's value looks like an id the argument is read as label ids and resolved through the connector's label list. A call
 * with names only needs no lookup.
 */
export function factsForCall(type: AgentConnectorType, facts: ToolFacts, args: Record<string, unknown>): ToolFacts {
  if (type !== "linear") return facts;
  const holdsId = (value: unknown): boolean => (Array.isArray(value) ? (value as unknown[]).some(holdsId) : typeof value === "string" && UUID.test(value.trim()));
  const ids = LINEAR_LABEL_ARGUMENTS.filter((path) => Object.hasOwn(args, path) && holdsId(args[path]));
  if (ids.length === 0) return facts;
  return { ...facts, labelIdArguments: [...new Set([...(facts.labelIdArguments ?? []), ...ids])] };
}
