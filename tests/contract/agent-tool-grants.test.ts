// Plan 3 Task 19: connector tools for agents. `resolveToolGrants` turns the recipe's grants into the tools one step may use; the two internal routes
// (`GET /v1/internal/agent-tools`, `POST /v1/internal/agent-tools/call`) serve only those, behind the operation's own `agent-tools` capability. A call
// goes through, in order: the creator is still a member (A12), the project authority (A13), the grant is resolved again, the call is prepared
// (`prepareAgentWrite`) and handed to the write gate (Task 21's `decideWrite`; here a stand-in and fakes), and only a `run` decision reaches the vendor.
// The broker is the real one, with a fake Linear MCP server and a fake GitHub MCP connection behind it. No test reaches a real vendor.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CatalogCache, connectMcp, type McpConnection } from "@agentx/gateway";
import { EMPTY_RECIPE, type ResolvedRecipe, type ToolGrant } from "../../packages/contracts/src/agent-recipe-node.js";
import { recipeDigest } from "../../packages/contracts/src/agent-recipe-node.js";
import { validateRecipeForOrg } from "../../packages/broker/src/agents/guardrails.js";
import { applyAgentStep, givesAgentTools } from "../../packages/broker/src/agents/dispatch.js";
import { DEFAULT_AGENT_GUARDRAILS as GUARDRAILS } from "../../packages/contracts/src/agent-guardrails.js";
import { nonTextFactProblems } from "../../packages/broker/src/agents/write-class.js";
import {
  factsForCall, resolveToolGrants, stepToolPatterns, toolGrantProblems, toolFactsFor, type GrantConnector,
} from "../../packages/broker/src/agents/tool-grants.js";
import {
  AgentToolCallRequestSchema, approvalsNotWiredGate, connectorLabelLister, type AgentToolsDependencies, type AgentWriteGate,
} from "../../packages/broker/src/agents/agent-tools-routes.js";
import { issueCapability } from "../../packages/broker/src/aws/cancellation.js";
import { githubConnectorType } from "../../packages/broker/src/aws/connector-types.js";
import { linearConnectorType } from "../../packages/broker/src/aws/linear-connector-type.js";
import { callConnector, connectorCatalogKey, discoverConnector, type ScopeDiscovery } from "../../packages/broker/src/aws/connector-routes.js";
import type { ResolvedConnector } from "../../packages/broker/src/aws/connector-types.js";
import type { OrgId, WorkspaceInstance } from "../../packages/contracts/src/index.js";
import { DEFAULT_AGENT_GUARDRAILS, agentGuardrailsKey, orgMemberKey, orgRemovedKey, projectMemberKey, projectRevisionKey } from "../../packages/contracts/src/index.js";
import type { ConnectorCatalog, PresentedTool } from "../../packages/contracts/src/connectors-node.js";
import { MAYA, OMAR, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { CHARTERARC_TEAM_ID, linearViaFake, startFakeLinearMcp } from "../support/fake-linear-mcp.js";
import { treeReader, workflow } from "../support/fake-repository.js";
import { TEST_ORG } from "../support/orgs.js";
import { call, loadSlackBroker, registerSlackProject } from "../support/slack-broker.js";
import { decideApproval, getAnyApproval, type ApprovalDependencies } from "../../packages/broker/src/agents/approvals.js";
import { deriveWriteRequestId } from "../../packages/broker/src/agents/write-gate.js";
import { readBrokerSource } from "../support/broker-source.js";

beforeAll(async () => { await loadSlackBroker(); }, 60_000);

const SIGNING = { callbackSigningKey: "c".repeat(64) };
const ADMIN = { subject: "admin-subject", admin: true };
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")) as { actions: string[] };
const BASE = ["artifacts", "events", "result"];
const NOT_GRANTED = (agent: string, connector: string, tool: string, project = "payments") => `${agent} isn't allowed to use ${connector} ${tool} on ${project}.`;
const PULL_REQUEST_FLOW = "Pushes and merges happen only through Rovara Code's pull request flow.";

// ---------------------------------------------------------------------------------------------
// issueCapability
// ---------------------------------------------------------------------------------------------

describe("issueCapability and agent tools", () => {
  it("adds the agent-tools action only when asked, and changes no other flag's actions", () => {
    expect(claimsOf(issueCapability(SIGNING, "ws", "op", 1)).actions).toEqual(BASE);
    expect(claimsOf(issueCapability(SIGNING, "ws", "op", 1, { agentTools: false })).actions).toEqual(BASE);
    expect(claimsOf(issueCapability(SIGNING, "ws", "op", 1, { agentTools: true })).actions).toEqual([...BASE, "agent-tools"]);
    expect(claimsOf(issueCapability(SIGNING, "ws", "op", 1, { agentSkills: true, agentTools: true })).actions).toEqual([...BASE, "agent-skills", "agent-tools"]);
  });
});

// ---------------------------------------------------------------------------------------------
// resolveToolGrants (pure)
// ---------------------------------------------------------------------------------------------

const tool = (connector: string, upstreamName: string, access: "read" | "write", extra: Partial<PresentedTool> = {}): PresentedTool => ({
  name: `${connector}__${upstreamName}`, upstreamName, description: upstreamName, inputSchema: { type: "object", properties: {} }, access,
  scopes: [{ alias: "team", schemaHash: "a".repeat(64) }], ...extra,
});
const connector = (name: string, type: string, tools: Array<[string, "read" | "write"]>): GrantConnector => ({ name, type, approvals: tools.map(([toolName, access]) => ({ name: toolName, access })) });
const catalogOf = (name: string, tools: Array<[string, "read" | "write"]>, extra: Record<string, Partial<PresentedTool>> = {}): ConnectorCatalog =>
  ({ connector: name, tools: tools.map(([toolName, access]) => tool(name, toolName, access, extra[toolName])), skipped: [] });

const LINEAR_TOOLS: Array<[string, "read" | "write"]> = [["get_issue", "read"], ["save_issue", "write"]];
const linearConnector = connector("linear", "linear", LINEAR_TOOLS);
const linearCatalog = catalogOf("linear", LINEAR_TOOLS);
const names = (granted: ReturnType<typeof resolveToolGrants>) => granted.map((entry) => `${entry.connector}.${entry.upstreamName}:${entry.access}`);
const grant = (selector: ToolGrant["connector"], access: ToolGrant["access"], tools?: string[]): ToolGrant => ({ connector: selector, access, ...(tools === undefined ? {} : { tools }) });

describe("resolveToolGrants", () => {
  it("a linear read grant exposes only get_issue", () => {
    expect(names(resolveToolGrants({ grants: [grant({ type: "linear" }, "read")], connectors: [linearConnector], catalogs: [linearCatalog] }))).toEqual(["linear.get_issue:read"]);
  });

  it("a read_write grant exposes save_issue too", () => {
    expect(names(resolveToolGrants({ grants: [grant({ type: "linear" }, "read_write")], connectors: [linearConnector], catalogs: [linearCatalog] }))).toEqual(["linear.get_issue:read", "linear.save_issue:write"]);
  });

  it("a step that allows no connector tool exposes none", () => {
    expect(resolveToolGrants({ grants: [grant({ type: "linear" }, "read_write")], stepTools: [], connectors: [linearConnector], catalogs: [linearCatalog] })).toEqual([]);
  });

  it("a step's tools narrow what the grant allows, over the upstream names", () => {
    const granted = resolveToolGrants({ grants: [grant({ type: "linear" }, "read_write")], stepTools: ["get_*"], connectors: [linearConnector], catalogs: [linearCatalog] });
    expect(names(granted)).toEqual(["linear.get_issue:read"]);
    // The step cannot add what no grant gives.
    expect(names(resolveToolGrants({ grants: [grant({ type: "linear" }, "read")], stepTools: ["save_*"], connectors: [linearConnector], catalogs: [linearCatalog] }))).toEqual([]);
  });

  it("a grant's own tools patterns narrow it, and both narrowings must match", () => {
    const connectors = [connector("linear", "linear", [["get_issue", "read"], ["list_issues", "read"], ["save_issue", "write"], ["save_comment", "write"]])];
    const catalogs = [catalogOf("linear", [["get_issue", "read"], ["list_issues", "read"], ["save_issue", "write"], ["save_comment", "write"]])];
    expect(names(resolveToolGrants({ grants: [grant({ type: "linear" }, "read_write", ["get_*", "save_comment"])], connectors, catalogs }))).toEqual(["linear.get_issue:read", "linear.save_comment:write"]);
    expect(names(resolveToolGrants({ grants: [grant({ type: "linear" }, "read_write", ["get_*", "save_comment"])], stepTools: ["save_*"], connectors, catalogs }))).toEqual(["linear.save_comment:write"]);
  });

  it("two grants on one connector, read and read_write, give read_write", () => {
    const granted = resolveToolGrants({ grants: [grant({ type: "linear" }, "read"), grant({ name: "linear" }, "read_write")], connectors: [linearConnector], catalogs: [linearCatalog] });
    expect(names(granted)).toEqual(["linear.get_issue:read", "linear.save_issue:write"]);
    // Order does not matter, and a tool is listed once.
    expect(names(resolveToolGrants({ grants: [grant({ name: "linear" }, "read_write"), grant({ type: "linear" }, "read")], connectors: [linearConnector], catalogs: [linearCatalog] }))).toHaveLength(2);
  });

  it("overlapping grants each keep their own patterns, and the tools of both are granted", () => {
    const connectors = [connector("linear", "linear", [["get_issue", "read"], ["save_issue", "write"], ["save_comment", "write"]])];
    const catalogs = [catalogOf("linear", [["get_issue", "read"], ["save_issue", "write"], ["save_comment", "write"]])];
    const granted = resolveToolGrants({ grants: [grant({ type: "linear" }, "read", ["get_*"]), grant({ type: "linear" }, "read_write", ["save_comment"])], connectors, catalogs });
    expect(names(granted)).toEqual(["linear.get_issue:read", "linear.save_comment:write"]);
  });

  it("a jira grant on a project without Jira exposes nothing", () => {
    expect(resolveToolGrants({ grants: [grant({ type: "jira" }, "read_write")], connectors: [linearConnector], catalogs: [linearCatalog] })).toEqual([]);
    expect(resolveToolGrants({ grants: [grant({ name: "jira" }, "read_write")], connectors: [linearConnector], catalogs: [linearCatalog] })).toEqual([]);
  });

  it("a type selector matches every connector of the type, and a name selector the one connector", () => {
    const connectors = [connector("eng", "linear", LINEAR_TOOLS), connector("ops", "linear", LINEAR_TOOLS), connector("sentry", "mcp", [["get_issue", "read"]])];
    const catalogs = [catalogOf("eng", LINEAR_TOOLS), catalogOf("ops", LINEAR_TOOLS), catalogOf("sentry", [["get_issue", "read"]])];
    expect(names(resolveToolGrants({ grants: [grant({ type: "linear" }, "read")], connectors, catalogs }))).toEqual(["eng.get_issue:read", "ops.get_issue:read"]);
    expect(names(resolveToolGrants({ grants: [grant({ name: "ops" }, "read")], connectors, catalogs }))).toEqual(["ops.get_issue:read"]);
    expect(names(resolveToolGrants({ grants: [grant({ type: "mcp" }, "read")], connectors, catalogs }))).toEqual(["sentry.get_issue:read"]);
  });

  it("a name selector naming a connector whose type is not one agents can use matches nothing", () => {
    const connectors = [connector("slack", "slack", [["post_message", "write"]]), linearConnector];
    const catalogs = [catalogOf("slack", [["post_message", "write"]]), linearCatalog];
    expect(resolveToolGrants({ grants: [grant({ name: "slack" }, "read_write")], connectors, catalogs })).toEqual([]);
    expect(names(resolveToolGrants({ grants: [grant({ name: "linear" }, "read")], connectors, catalogs }))).toEqual(["linear.get_issue:read"]);
  });

  it("a { name: \"slack\" } selector is a problem when the agent is published", async () => {
    expect(toolGrantProblems([grant({ name: "slack" }, "read_write"), grant({ name: "linear" }, "read"), grant({ type: "mcp" }, "read")])).toEqual([
      { path: "tools.0.connector", message: "slack isn't a connector agents can use; name a connector of the project, or pick a type: github, linear, jira, asana, mcp, sentry, datadog, cloudwatch, github-actions, grafana, vercel or pagerduty" },
    ]);
    const h = await createDeveloperTaskBroker();
    const recipe: ResolvedRecipe = { ...EMPTY_RECIPE, steps: [{ id: "triage", name: "Triage", kind: "agent", workspace: "none", settings: { instructions: [] } }], tools: [grant({ name: "slack" }, "read_write")] };
    const problems = await validateRecipeForOrg({ documentClient: h.db, tableName: "state" }, TEST_ORG, recipe);
    expect(problems).toContainEqual({ path: "tools.0.connector", message: "slack isn't a connector agents can use; name a connector of the project, or pick a type: github, linear, jira, asana, mcp, sentry, datadog, cloudwatch, github-actions, grafana, vercel or pagerduty" });
  });

  it("grants only tools the project approved and the vendor still offers", () => {
    const approved = connector("linear", "linear", [["get_issue", "read"], ["save_issue", "write"], ["gone", "read"]]);
    const catalog = catalogOf("linear", [["get_issue", "read"], ["save_issue", "write"], ["unapproved", "read"]]);
    expect(names(resolveToolGrants({ grants: [grant({ type: "linear" }, "read_write")], connectors: [approved], catalogs: [catalog] }))).toEqual(["linear.get_issue:read", "linear.save_issue:write"]);
  });

  it("a connector with no catalog, or a catalog marked not connected, grants nothing", () => {
    expect(resolveToolGrants({ grants: [grant({ type: "linear" }, "read")], connectors: [linearConnector], catalogs: [] })).toEqual([]);
    expect(resolveToolGrants({ grants: [grant({ type: "linear" }, "read")], connectors: [linearConnector], catalogs: [{ connector: "linear", notConnected: true, tools: [], skipped: [] }] })).toEqual([]);
  });

  it("gives each tool its presented name, its type and the access the project approved it for", () => {
    const [first, second] = resolveToolGrants({ grants: [grant({ type: "linear" }, "read_write")], connectors: [linearConnector], catalogs: [linearCatalog] });
    expect(first).toMatchObject({ connector: "linear", type: "linear", upstreamName: "get_issue", presentedName: "linear__get_issue", access: "read" });
    expect(second).toMatchObject({ upstreamName: "save_issue", presentedName: "linear__save_issue", access: "write", facts: { connector: "linear", upstreamName: "save_issue", access: "write" } });
  });

  describe("GitHub goes through the agent tool map and refusals first", () => {
    const GITHUB_TOOLS: Array<[string, "read" | "write"]> = [["issue_read", "read"], ["add_issue_comment", "write"], ["merge_pull_request", "write"], ["push_files", "write"], ["list_notifications", "read"], ["run_workflow_thing", "read"]];
    const github = connector("github", "github", GITHUB_TOOLS);
    const catalog = catalogOf("github", GITHUB_TOOLS);

    it("drops a refused tool and a tool the map lacks, though the project approved it and the grant is read_write", () => {
      expect(names(resolveToolGrants({ grants: [grant({ type: "github" }, "read_write")], connectors: [github], catalogs: [catalog] }))).toEqual(["github.issue_read:read", "github.add_issue_comment:write"]);
    });

    it("counts a tool whose token would write as a write, whatever the project approved it for", () => {
      const lenient = connector("github", "github", [["issue_read", "read"], ["add_issue_comment", "read"]]);
      const granted = resolveToolGrants({ grants: [grant({ type: "github" }, "read")], connectors: [lenient], catalogs: [catalogOf("github", [["issue_read", "read"], ["add_issue_comment", "read"]])] });
      expect(names(granted)).toEqual(["github.issue_read:read"]);
      const wide = resolveToolGrants({ grants: [grant({ type: "github" }, "read_write")], connectors: [lenient], catalogs: [catalogOf("github", [["issue_read", "read"], ["add_issue_comment", "read"]])] });
      expect(names(wide)).toEqual(["github.issue_read:read", "github.add_issue_comment:write"]);
    });
  });
});

describe("grants and the capability", () => {
  it("the broker gives the capability exactly when the dispatch says so", async () => {
    expect(readBrokerSource()).toContain("agentTools: givesAgentTools(applied),");
  });

  it("an agent step of a recipe with tool grants is given the agent-tools capability, and nothing else is", () => {
    const agentStep = { kind: "agent" as const, agentId: AGENT.agentId, version: 1, stepId: "triage", instructions: "x", workspace: "none" as const, inputs: "y" };
    const codingStep = { kind: "coding" as const, agentId: AGENT.agentId, version: 1, stepId: "build" };
    expect(givesAgentTools({ agentStep, toolGrants: true })).toBe(true);
    expect(givesAgentTools({ agentStep })).toBe(false);
    expect(givesAgentTools({ agentStep: codingStep, toolGrants: true })).toBe(false);
    expect(givesAgentTools({ toolGrants: true })).toBe(false);
    expect(givesAgentTools(undefined)).toBe(false);
  });

  it("the dispatch marks a recipe that grants tools, and one that grants none", () => {
    const recipe = (tools: ToolGrant[]): ResolvedRecipe => ({ ...EMPTY_RECIPE, chain: [{ agentId: AGENT.agentId, name: "triage-bot", version: 1, builtin: false }], steps: [{ id: "triage", name: "Triage", kind: "agent", workspace: "none", settings: { instructions: [] } }], tools });
    const apply = (tools: ToolGrant[]) => applyAgentStep({ recipe: recipe(tools), guardrails: GUARDRAILS, project: "payments", priorOperations: [], mode: "IMPLEMENT" });
    expect(apply([grant({ type: "linear" }, "read")]).toolGrants).toBe(true);
    expect(apply([]).toolGrants).toBeUndefined();
  });
});

describe("stepToolPatterns", () => {
  const step = (tools?: string[]) => ({ id: "s", name: "S", kind: "agent" as const, workspace: "read" as const, settings: { instructions: [], ...(tools === undefined ? {} : { tools }) } });
  it("takes the step's connector tool patterns and leaves out the workspace tools (Pi names)", () => {
    expect(stepToolPatterns(step(["get_*", "read", "grep"]))).toEqual(["get_*"]);
    // A list that holds only workspace tools is still an allow-list: it narrows to no connector tool.
    expect(stepToolPatterns(step(["read", "grep"]))).toEqual([]);
    expect(stepToolPatterns(step())).toBeUndefined();
    expect(stepToolPatterns(undefined)).toBeUndefined();
    // Only an agent step narrows connector tools.
    expect(stepToolPatterns({ id: "p", name: "P", kind: "plan", settings: { instructions: [], tools: ["get_*"] } })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// The facts a tool carries (Task 20b's hand-off)
// ---------------------------------------------------------------------------------------------

describe("the facts of a granted tool", () => {
  const factsOf = (type: Parameters<typeof toolFactsFor>[0]["type"], connectorName: string, upstreamName: string, access: "read" | "write", extra: Partial<PresentedTool> = {}) =>
    toolFactsFor({ name: connectorName, type }, tool(connectorName, upstreamName, access, extra), access);

  it("starts from the catalog: connector, name, access, the vendor's hints and the item arguments the tool offers", () => {
    expect(factsOf("linear", "linear", "get_issue", "read", { hints: { readOnlyHint: true }, itemArguments: ["id"] })).toMatchObject({
      connector: "linear", upstreamName: "get_issue", access: "read", hints: { readOnlyHint: true }, itemArguments: ["id"],
    });
  });

  it("Linear's save_issue labels: the argument that takes labels, and that setting it replaces the set", () => {
    expect(factsOf("linear", "linear", "save_issue", "write", { itemArguments: ["id"] })).toMatchObject({
      itemArguments: ["id"], labelArgument: "labels", labelsReplace: true, resultItemArguments: ["id", "identifier"],
    });
  });

  it("GitHub's tools declare owner and repo as scope arguments, not as non-text arguments", () => {
    const comment = factsOf("github", "github", "add_issue_comment", "write", { itemArguments: ["issue_number"] });
    expect(comment.itemScopeArguments).toEqual(["owner", "repo"]);
    expect(comment.nonTextArguments ?? []).not.toContain("owner");
    expect(comment.nonTextArguments ?? []).not.toContain("repo");
    // A comment annotates its issue: it is not a change to it.
    expect(comment.itemArguments).toEqual([]);
    expect(factsOf("github", "github", "pull_request_review_write", "write", { itemArguments: ["pullNumber"] })).toMatchObject({ itemArguments: [], nonTextArguments: ["method"], itemScopeArguments: ["owner", "repo"] });
    expect(factsOf("github", "github", "issue_write", "write", { itemArguments: ["issue_number"] })).toMatchObject({
      itemArguments: ["issue_number"], labelArgument: "labels", labelsReplace: true, resultItemArguments: ["number"], nonTextArguments: ["method"],
    });
  });

  it("GitHub's other issue writes take labels as a list that replaces the set", () => {
    expect(factsOf("github", "github", "create_issue", "write")).toMatchObject({ labelArgument: "labels", labelsReplace: true, resultItemArguments: ["number"] });
    expect(factsOf("github", "github", "update_issue", "write")).toMatchObject({ labelArgument: "labels", labelsReplace: true });
  });

  it("what the caller passes beats the table, and the table beats the catalog", () => {
    const facts = toolFactsFor({ name: "github", type: "github" }, tool("github", "add_issue_comment", "write", { itemArguments: ["issue_number"] }), "write", { itemArguments: ["x"], nonTextArguments: ["method"] });
    expect(facts.itemArguments).toEqual(["x"]);
    expect(facts.nonTextArguments).toEqual(["method"]);
    expect(facts.itemScopeArguments).toEqual(["owner", "repo"]);
  });

  it("editing a Jira issue replaces labels it sets", () => {
    expect(factsOf("jira", "jira", "editJiraIssue", "write").labelsReplace).toBe(true);
  });

  it("a comment on Jira annotates its issue; a Jira create takes labels as a list", () => {
    expect(factsOf("jira", "jira", "addOrEditJiraIssueComment", "write", { itemArguments: ["issueIdOrKey"] }).itemArguments).toEqual(["commentId"]);
    expect(factsOf("jira", "jira", "createJiraIssue", "write", { itemArguments: [] })).toMatchObject({ labelArgument: "labels", resultItemArguments: ["key", "id"] });
  });

  it("an Asana comment annotates its task", () => {
    expect(factsOf("asana", "asana", "add_comment", "write", { itemArguments: ["task_id"] }).itemArguments).toEqual([]);
    expect(factsOf("asana", "asana", "update_tasks", "write", { itemArguments: ["tasks[].task"] }).itemArguments).toEqual(["tasks[].task"]);
  });

  it("a generic MCP tool has the catalog's facts and nothing declared by Rovara", () => {
    const facts = factsOf("mcp", "sentry", "update_issue", "write", { itemArguments: ["issue_id"] });
    expect(facts).toMatchObject({ connector: "sentry", itemArguments: ["issue_id"] });
    expect(facts.labelArgument).toBeUndefined();
    expect(facts.nonTextArguments).toBeUndefined();
  });

  it("no tool's declared facts name a free-text field as a non-text argument", () => {
    const all: Array<[Parameters<typeof toolFactsFor>[0]["type"], string]> = [
      ["linear", "save_issue"], ["linear", "save_comment"], ["jira", "createJiraIssue"], ["jira", "editJiraIssue"], ["jira", "addOrEditJiraIssueComment"],
      ["asana", "create_tasks"], ["asana", "update_tasks"], ["asana", "add_comment"], ["github", "add_issue_comment"], ["github", "issue_write"],
      ["github", "create_issue"], ["github", "update_issue"], ["github", "pull_request_review_write"], ["mcp", "anything"],
    ];
    for (const [type, name] of all) expect(nonTextFactProblems(factsOf(type, "c", name, "write")), `${type} ${name}`).toEqual([]);
  });

  it("a bad non-text declaration is refused when the facts are built", () => {
    // A table entry that named `body` would be caught: the builder runs nonTextFactProblems and throws.
    expect(() => toolFactsFor({ name: "c", type: "mcp" }, tool("c", "x", "write"), "write", { nonTextArguments: ["body"] })).toThrow(/free-text field/);
  });

  describe("per call", () => {
    const UUID = "5d8a1f0e-3b7c-4e2a-9f10-6c2b8d4e7a91";
    const base = factsOf("linear", "linear", "save_issue", "write");
    it("Linear's labels and addLabels are label ids for a call whose value looks like an id, and names otherwise", () => {
      expect(factsForCall("linear", base, { title: "x", labels: ["bug"] }).labelIdArguments ?? []).toEqual([]);
      expect(factsForCall("linear", base, { title: "x", addLabels: [UUID] }).labelIdArguments).toEqual(["addLabels"]);
      expect(factsForCall("linear", base, { labels: ["bug", UUID], addLabels: [UUID] }).labelIdArguments).toEqual(["labels", "addLabels"]);
    });
    it("leaves every other type's facts as they are", () => {
      expect(factsForCall("jira", factsOf("jira", "jira", "createJiraIssue", "write"), { labels: [UUID] })).toEqual(factsOf("jira", "jira", "createJiraIssue", "write"));
      expect(factsForCall("github", factsOf("github", "github", "issue_write", "write"), { labels: [UUID] }).labelIdArguments).toBeUndefined();
      expect(factsForCall("mcp", factsOf("mcp", "c", "x", "write"), { addLabels: [UUID] }).labelIdArguments).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The label list of Linear and MCP connectors, read through the connector call path
// ---------------------------------------------------------------------------------------------

describe("connectorLabelLister", () => {
  const labels = JSON.stringify({ labels: [{ id: "5d8a1f0e-3b7c-4e2a-9f10-6c2b8d4e7a91", name: "automerge" }, { id: "x1", name: "Bug" }] });
  it("reads the connector's label tool and maps every id and every name to the name", async () => {
    const run = vi.fn<(tool: string, args: Record<string, unknown>) => Promise<string | undefined>>(async () => labels);
    const lister = connectorLabelLister({ tools: ["list_issue_labels"], run });
    const table = await lister({ orgId: TEST_ORG, connector: { type: "linear", id: "linear" } });
    expect(run).toHaveBeenCalledWith("list_issue_labels", {});
    expect(table.get("5d8a1f0e-3b7c-4e2a-9f10-6c2b8d4e7a91")).toBe("automerge");
    expect(table.get("x1")).toBe("Bug");
    expect(table.get("Bug")).toBe("Bug");
    // The label Rovara adds itself resolves without being in the list.
    expect(table.get("rovara")).toBe("rovara");
  });
  it("uses the first label tool the project approved, and fails closed with none", async () => {
    const run = vi.fn(async (name: string) => (name === "list_labels" ? labels : undefined));
    await expect(connectorLabelLister({ tools: ["list_issue_labels", "list_labels"], run })({ orgId: TEST_ORG, connector: { type: "mcp", id: "sentry" } })).resolves.toBeInstanceOf(Map);
    await expect(connectorLabelLister({ tools: [], run })({ orgId: TEST_ORG, connector: { type: "mcp", id: "sentry" } })).rejects.toThrow();
  });
  it("fails when the list holds no label", async () => {
    await expect(connectorLabelLister({ tools: ["list_labels"], run: async () => JSON.stringify({ labels: [] }) })({ orgId: TEST_ORG, connector: { type: "mcp", id: "c" } })).rejects.toThrow(/no labels/u);
  });
  it("fails when the tool answers nothing readable", async () => {
    await expect(connectorLabelLister({ tools: ["list_labels"], run: async () => "not json" })({ orgId: TEST_ORG, connector: { type: "mcp", id: "c" } })).rejects.toThrow();
    await expect(connectorLabelLister({ tools: ["list_labels"], run: async () => undefined })({ orgId: TEST_ORG, connector: { type: "mcp", id: "c" } })).rejects.toThrow();
  });
});

describe("the call request", () => {
  const valid = { requestId: randomUUID(), scope: "charterarc", tool: "get_issue", schemaHash: "a".repeat(64), arguments: {}, connector: "linear" };
  it("is the connector call request plus the connector, and nothing else", () => {
    expect(AgentToolCallRequestSchema.safeParse(valid).success).toBe(true);
    expect(AgentToolCallRequestSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(AgentToolCallRequestSchema.safeParse({ ...valid, connector: undefined }).success).toBe(false);
    expect(AgentToolCallRequestSchema.safeParse({ ...valid, connector: "Not Valid" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------------------------

const LINEAR_KEY = "lin_api_fixture_key_0123456789abcdef";
const LINEAR_PROJECT_TOOLS = [{ name: "list_issues", access: "read" }, { name: "get_issue", access: "read" }, { name: "save_issue", access: "write" }, { name: "save_comment", access: "write" }];
const LINEAR_CONNECTOR = {
  name: "linear", type: "linear", credentialRef: "linear-charterarc", scopes: [{ alias: "charterarc", teamId: CHARTERARC_TEAM_ID }], tools: LINEAR_PROJECT_TOOLS,
};
const GITHUB_PROJECT_TOOLS = [
  { name: "issue_read", access: "read" }, { name: "add_issue_comment", access: "write" }, { name: "issue_write", access: "write" }, { name: "merge_pull_request", access: "write" },
  { name: "pull_request_read", access: "read" },
];
const GITHUB_CONNECTOR = { name: "github", type: "github", scopes: ["demo"], tools: GITHUB_PROJECT_TOOLS };
const AGENT = { agentId: "agt_aaaaaaaaaaaaaaaaaaaa", name: "triage-bot", version: 1, builtin: false } as const;

const objectSchema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required });
const GITHUB_FAKE_TOOLS: McpConnection["tools"] = [
  { name: "issue_read", description: "Read an issue", inputSchema: objectSchema({ owner: { type: "string" }, repo: { type: "string" }, issue_number: { type: "number" }, method: { type: "string" } }, ["owner", "repo", "issue_number", "method"]) },
  { name: "add_issue_comment", description: "Comment on an issue", inputSchema: objectSchema({ owner: { type: "string" }, repo: { type: "string" }, issue_number: { type: "number" }, body: { type: "string" } }, ["owner", "repo", "issue_number", "body"]) },
  { name: "issue_write", description: "Create or update an issue", inputSchema: objectSchema({ owner: { type: "string" }, repo: { type: "string" }, method: { type: "string" }, issue_number: { type: "number" }, title: { type: "string" }, body: { type: "string" }, labels: { type: "array", items: { type: "string" } } }, ["owner", "repo", "method"]) },
  { name: "merge_pull_request", description: "Merge", inputSchema: objectSchema({ owner: { type: "string" }, repo: { type: "string" }, pullNumber: { type: "number" } }, ["owner", "repo", "pullNumber"]) },
  { name: "pull_request_read", description: "Read a pull request", inputSchema: objectSchema({ owner: { type: "string" }, repo: { type: "string" }, pullNumber: { type: "number" }, method: { type: "string" } }, ["owner", "repo", "pullNumber", "method"]) },
];

interface WorldOptions { standIn?: boolean; workflowFiles?: Record<string, string>; pinnedInstallation?: number; pinnedByHost?: number; labelTool?: boolean | "write"; linearAttribution?: boolean; extraRepositories?: unknown[] }

const UUID_AUTOMERGE = "5d8a1f0e-3b7c-4e2a-9f10-6c2b8d4e7a91";
const UUID_BUG = "7a1c2d3e-4f50-4a61-8b72-9c83d4e5f607";

async function world(options: WorldOptions = {}) {
  const linear = await startFakeLinearMcp();
  let labelListings = 0;
  const labelTool: McpConnection["tools"][number] = { name: "list_issue_labels", description: "List labels", inputSchema: { type: "object", properties: {} } };
  /** The fake Linear server, plus (when asked) a label list the recorded fixtures lack. */
  const linearType = options.labelTool === undefined ? linearViaFake(linear).type : {
    type: "linear",
    resolve: (config: Parameters<typeof linearConnectorType.resolve>[0], project: Parameters<typeof linearConnectorType.resolve>[1], context: Parameters<typeof linearConnectorType.resolve>[2]) => linearConnectorType.resolve(config, project, {
      ...context,
      connect: (async (input: Parameters<typeof connectMcp>[0]) => {
        const connection = await connectMcp({ ...input, endpoint: linear.url });
        return {
          ...connection,
          tools: [...connection.tools, ...((input.tools).includes("list_issue_labels") ? [labelTool] : [])],
          call: async (name: string, args: Record<string, unknown>) => {
            if (name !== "list_issue_labels") return connection.call(name, args);
            labelListings += 1;
            return { content: [{ type: "text" as const, text: JSON.stringify({ labels: [{ id: UUID_AUTOMERGE, name: "automerge" }, { id: UUID_BUG, name: "bug" }] }) }] };
          },
        };
      }),
    }),
  };
  const githubCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const githubConnections: Array<{ token: string }> = [];
  const connectGithub = vi.fn(async (input: Parameters<typeof connectMcp>[0]): Promise<McpConnection> => {
    githubConnections.push({ token: input.token });
    return {
      tools: GITHUB_FAKE_TOOLS.filter((candidate) => input.tools === undefined || (input.tools).includes(candidate.name)),
      call: async (name, args) => { githubCalls.push({ name, arguments: args }); return { content: [{ type: "text", text: JSON.stringify(name === "pull_request_read" ? { number: args.pullNumber } : { number: 7, id: 7 }) }] }; },
      close: async () => undefined,
    };
  });
  const tokens = vi.fn<(repository: unknown, permissions: unknown, scope: unknown, options?: unknown) => Promise<string>>(async () => "agent-installation-token");
  const heads = vi.fn<(url: string, number: number, scope: unknown, options?: unknown) => Promise<{ headSha: string; state: "open" }>>(async (...args) => {
    const number = args[1];
    if (number === 404) throw Object.assign(new Error(`pull request ${String(number)} doesn't exist`), { name: "AgentXError", code: "CONFIG_INVALID" });
    return { headSha: "a".repeat(40), state: "open" as const };
  });
  const repositories: string[] = [];
  const readerPins: Array<number | undefined> = [];
  const labelReads: Array<{ url: string; options: unknown }> = [];
  const listAgentRepositoryLabels = vi.fn(async (url: string, _scope: unknown, labelOptions?: unknown) => { labelReads.push({ url, options: labelOptions }); return [{ id: 11, nodeId: "LA_automerge", name: "automerge" }, { id: 12, nodeId: "LA_bug", name: "bug" }]; });
  const agentRepositoryReader = vi.fn(async (url: string, _scope: unknown, readerOptions?: { installationId?: number }) => { repositories.push(url); readerPins.push(readerOptions?.installationId); return treeReader(options.workflowFiles ?? {}); });
  const secrets = { read: vi.fn(async (name: string) => (name === "agentx/connectors/linear-charterarc" ? JSON.stringify({ apiKey: LINEAR_KEY }) : undefined)) };
  let configure: (base: AgentToolsDependencies) => AgentToolsDependencies = options.standIn === true ? (base) => ({ ...base, gate: approvalsNotWiredGate }) : (base) => base;
  const h = await createDeveloperTaskBroker({
    register: false,
    brokerExtra: {
      connectorTypes: { github: githubConnectorType, linear: linearType },
      connectorCredentials: { secrets, githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" } },
      githubMcp: { credentials: vi.fn(async () => ({ owner: "example", repo: "demo", token: "human-token" })), connect: connectGithub },
      githubPullRequests: {
        reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(),
        createAgentInstallationToken: tokens, getAgentPullRequestHead: heads, agentRepositoryReader, listAgentRepositoryLabels,
      },
      agents: {},
      agentTools: { configure: (base: AgentToolsDependencies) => configure(base) },
    },
  });
  expect((await call(h.handler, { method: "POST", path: "/v1/admin/credentials", user: ADMIN, body: { ref: "linear-charterarc", type: "static-secret", secretName: "agentx/connectors/linear-charterarc" } })).status).toBe(201);
  const linearProject = {
    ...LINEAR_CONNECTOR,
    ...(options.linearAttribution === undefined ? {} : { attribution: options.linearAttribution }),
    // `retired_tool` is approved but the vendor no longer offers it.
    tools: [...LINEAR_PROJECT_TOOLS, { name: "retired_tool", access: "read" }, ...(options.labelTool === undefined ? [] : [{ name: "list_issue_labels", access: options.labelTool === "write" ? "write" : "read" }])],
  };
  await registerSlackProject(h.handler, { connectors: [linearProject, GITHUB_CONNECTOR], ...(options.extraRepositories === undefined ? {} : { extraRepositories: options.extraRepositories }) });
  if (options.pinnedInstallation !== undefined) {
    const key = projectRevisionKey(TEST_ORG, "payments", 1);
    const record = h.db.get(key) as { definition: { repositories: Array<Record<string, unknown>> } };
    h.db.set({ ...record, definition: { ...record.definition, repositories: record.definition.repositories.map((repository) => ({ ...repository, installationId: options.pinnedInstallation })) } });
  }

  if (options.pinnedByHost !== undefined) {
    // The pin is on the repository's HOST record only (task P7), not in the old top-level field.
    const key = projectRevisionKey(TEST_ORG, "payments", 1);
    const record = h.db.get(key) as { definition: { repositories: Array<Record<string, unknown>> } };
    h.db.set({ ...record, definition: { ...record.definition, repositories: record.definition.repositories.map((repository) => ({ ...repository, host: { kind: "github", installationId: options.pinnedByHost } })) } });
  }

  /** Starts MAYA's task on payments, finishes the preparation, and freezes `recipe` as the task's agent snapshot. */
  async function startRun(recipeOverrides: Partial<ResolvedRecipe> = {}, agent: { name: string } = AGENT) {
    const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Triage it", client: "claude-code" });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const taskId = (started.body.task as { taskId: string }).taskId;
    const task = h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; orgId: string };
    const workspaceId = task.workspaceId;
    const active = () => String((h.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await h.finish(workspaceId, active(), "SUCCEEDED");
    const operationId = active();
    const recipe: ResolvedRecipe = {
      ...EMPTY_RECIPE,
      chain: [{ agentId: AGENT.agentId, name: agent.name, version: 1, builtin: false }],
      steps: [{ id: "triage", name: "Triage", kind: "agent", workspace: "none", settings: { instructions: [] } }],
      tools: [grant({ type: "linear" }, "read")],
      ...recipeOverrides,
    };
    const digest = recipeDigest(recipe);
    h.db.set({ ...task, agent: { ...AGENT, name: agent.name, digest } });
    h.db.set({ pk: `DEVTASK#${taskId}`, sk: "RECIPE", entityType: "TASK_RECIPE", orgId: task.orgId, digest, recipe });
    const operation = h.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`) as Record<string, unknown> & { fence: number };
    h.db.set({ ...operation, programStepId: "triage" });
    const capability = issueCapability(SIGNING, workspaceId, operationId, operation.fence, { agentTools: true });
    return { taskId, workspaceId, operationId, fence: operation.fence, capability, recipe, task };
  }

  const headers = (capability: string | null) => (capability === null ? {} : { "x-agentx-callback-capability": capability });
  const tools = (capability: string | null) => call(h.handler, { method: "GET", path: "/v1/internal/agent-tools", headers: headers(capability) });
  const callTool = (capability: string | null, body: Record<string, unknown>) => call(h.handler, { method: "POST", path: "/v1/internal/agent-tools/call", headers: headers(capability), body });
  const schemaHash = async (capability: string, connectorName: string, upstream: string) => {
    const catalogs = (await tools(capability)).body.catalogs as ConnectorCatalog[];
    return catalogs.find((entry) => entry.connector === connectorName)!.tools.find((entry) => entry.upstreamName === upstream)!.scopes[0]!.schemaHash;
  };
  /** A call request for `upstream` on the Linear connector; the schema hash is read from the catalog the step was shown (or given). */
  const linearCall = async (capability: string, upstream: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    callTool(capability, { requestId: randomUUID(), connector: "linear", scope: "charterarc", tool: upstream, schemaHash: await schemaHash(capability, "linear", upstream).catch(() => "b".repeat(64)), arguments: args, ...extra });
  const githubCall = async (capability: string, upstream: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    callTool(capability, { requestId: randomUUID(), connector: "github", scope: "demo", tool: upstream, schemaHash: await schemaHash(capability, "github", upstream).catch(() => "b".repeat(64)), arguments: args, ...extra });
  const removeCreator = () => {
    h.db.delete(orgMemberKey(TEST_ORG, MAYA.developerId));
    h.db.set({ ...orgRemovedKey(TEST_ORG, MAYA.developerId), entityType: "ORG_REMOVED", orgId: TEST_ORG, developerId: MAYA.developerId, removedAt: new Date().toISOString() });
  };
  return {
    ...h, linear, labelListings: () => labelListings, labelReads, githubCalls, githubConnections, connectGithub, tokens, heads, agentRepositoryReader, repositories, readerPins, secrets,
    startRun, tools, callTool, linearCall, githubCall, schemaHash, removeCreator,
    configure: (next: (base: AgentToolsDependencies) => AgentToolsDependencies) => { configure = next; },
  };
}
const errorOf = (reply: { body: Record<string, unknown> }) => reply.body.error as { code: string; message: string };
const bodyOf = (call: { arguments: Record<string, unknown> }) => (typeof call.arguments.body === "string" ? call.arguments.body : "");

/** A gate that records what it was given and answers as told. */
function recordingGate(decide: (input: Parameters<AgentWriteGate>[0]) => ReturnType<AgentWriteGate> | Awaited<ReturnType<AgentWriteGate>>) {
  const seen: Array<Parameters<AgentWriteGate>[0]> = [];
  const gate: AgentWriteGate = async (input) => { seen.push(input); return decide(input); };
  return { gate, seen };
}

describe("the routes' authorization", () => {
  it("refuses a request with no capability, and one without the agent-tools scope, on both routes", async () => {
    const w = await world();
    const run = await w.startRun();
    const plain = issueCapability(SIGNING, run.workspaceId, run.operationId, run.fence, { agentSkills: true });
    const body = { requestId: randomUUID(), connector: "linear", scope: "charterarc", tool: "get_issue", schemaHash: "a".repeat(64), arguments: { id: "CHA-1" } };
    for (const capability of [null, plain, "garbage", `${run.capability.split(".")[0]}.${"A".repeat(43)}`]) {
      const listed = await w.tools(capability);
      const called = await w.callTool(capability, body);
      expect([listed.status, called.status], String(capability)).toEqual([401, 401]);
    }
    expect(w.linear.calls).toEqual([]);
  });

  it("a capability for an operation that is finished, or is no longer the workspace's active operation, is refused", async () => {
    const w = await world();
    const run = await w.startRun();
    expect((await w.tools(run.capability)).status).toBe(200);
    const stale = issueCapability(SIGNING, run.workspaceId, run.operationId, run.fence + 1, { agentTools: true });
    expect((await w.tools(stale)).status).toBe(409);
    const other = issueCapability(SIGNING, run.workspaceId, randomUUID(), run.fence, { agentTools: true });
    expect((await w.tools(other)).status).toBe(404);
    await w.finish(run.workspaceId, run.operationId, "SUCCEEDED");
    const finished = await w.tools(run.capability);
    expect(finished.status).toBe(409);
    expect(errorOf(finished).code).toBe("STALE_FENCE");
  });

  it("serves the grants of the capability's own task, never another task's", async () => {
    const w = await world();
    const first = await w.startRun({ tools: [grant({ type: "linear" }, "read")] });
    // A second run in another workspace of the same org with a different recipe, built from copies of the first run's records.
    const workspaceB = randomUUID();
    const operationB = randomUUID();
    const taskB = `${first.taskId}-b`;
    const workspaceItem = w.db.get(`WORKSPACE#${first.workspaceId}`, "META") as Record<string, unknown>;
    w.db.set({ ...workspaceItem, pk: `WORKSPACE#${workspaceB}`, id: workspaceB, activeOperationId: operationB });
    const operationItem = w.db.get(`WORKSPACE#${first.workspaceId}`, `OPERATION#${first.operationId}`) as Record<string, unknown>;
    w.db.set({ ...operationItem, pk: `WORKSPACE#${workspaceB}`, sk: `OPERATION#${operationB}`, id: operationB, workspaceId: workspaceB });
    const pointer = w.db.find((item) => item.entityType === "DEVELOPER_TASK_POINTER" && item.taskId === first.taskId)[0]!;
    w.db.set({ ...pointer, pk: `WORKSPACE#${workspaceB}`, taskId: taskB });
    const taskItem = w.db.get(`DEVTASK#${first.taskId}`, "META") as Record<string, unknown>;
    const recipeB: ResolvedRecipe = { ...first.recipe, tools: [grant({ type: "linear" }, "read_write", ["save_issue"])] };
    const digestB = recipeDigest(recipeB);
    w.db.set({ ...taskItem, pk: `DEVTASK#${taskB}`, taskId: taskB, workspaceId: workspaceB, agent: { ...AGENT, digest: digestB } });
    w.db.set({ pk: `DEVTASK#${taskB}`, sk: "RECIPE", entityType: "TASK_RECIPE", orgId: TEST_ORG, digest: digestB, recipe: recipeB });
    const capabilityB = issueCapability(SIGNING, workspaceB, operationB, first.fence, { agentTools: true });
    const toolsOf = async (capability: string) => ((await w.tools(capability)).body.catalogs as ConnectorCatalog[]).flatMap((entry) => entry.tools.map((item) => item.upstreamName));
    expect(await toolsOf(first.capability)).toEqual(["list_issues", "get_issue"]);
    expect(await toolsOf(capabilityB)).toEqual(["save_issue"]);
  });

  it("refuses an operation whose org is not its task's, with 404 and no catalog", async () => {
    const w = await world();
    const run = await w.startRun();
    const operation = w.db.get(`WORKSPACE#${run.workspaceId}`, `OPERATION#${run.operationId}`) as Record<string, unknown>;
    w.db.set({ ...operation, orgId: "org_bbbbbbbbbbbbbbbbbbbb" });
    const listed = await w.tools(run.capability);
    expect(listed.status).toBe(404);
    expect(listed.body.catalogs).toBeUndefined();
    const called = await w.linearCall(run.capability, "get_issue", { id: "CHA-1" });
    expect(called.status).toBe(404);
    expect(w.linear.calls).toEqual([]);
  });

  it("refuses a task of another org, or of another workspace, than the operation's", async () => {
    const w = await world();
    const run = await w.startRun();
    const task = w.db.get(`DEVTASK#${run.taskId}`, "META") as Record<string, unknown>;
    const workspace = w.db.get(`WORKSPACE#${run.workspaceId}`, "META") as Record<string, unknown>;
    w.db.set({ ...task, orgId: "org_bbbbbbbbbbbbbbbbbbbb" });
    expect((await w.tools(run.capability)).status).toBe(404);
    w.db.set(task);
    w.db.set({ ...task, workspaceId: randomUUID() });
    expect((await w.tools(run.capability)).status).toBe(404);
    w.db.set(task);
    w.db.set({ ...workspace, orgId: "org_bbbbbbbbbbbbbbbbbbbb" });
    expect((await w.tools(run.capability)).status).toBe(404);
    w.db.set(workspace);
    expect((await w.tools(run.capability)).status).toBe(200);
  });

  it("an operation of a task with no agent gets an empty tool list, and cannot call", async () => {
    const w = await world();
    const run = await w.startRun();
    const { agent: _agent, ...withoutAgent } = w.db.get(`DEVTASK#${run.taskId}`, "META") as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars -- the task as it was before agents
    w.db.set(withoutAgent);
    const listed = await w.tools(run.capability);
    expect(listed.status).toBe(200);
    expect(listed.body.catalogs).toEqual([]);
    const called = await w.linearCall(run.capability, "get_issue", { id: "CHA-1" });
    expect(called.status).toBe(404);
    expect(w.linear.calls).toEqual([]);
  });

  it("an agent task whose snapshot is missing, or is not the one the task recorded, serves nothing and says so", async () => {
    const w = await world();
    const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
    const recipe = w.db.get(`DEVTASK#${run.taskId}`, "RECIPE") as Record<string, unknown> & { recipe: ResolvedRecipe };
    // Someone widened the frozen recipe after the task recorded its digest.
    w.db.set({ ...recipe, recipe: { ...recipe.recipe, tools: [grant({ type: "linear" }, "read_write"), grant({ type: "github" }, "read_write")] } });
    for (const reply of [await w.tools(run.capability), await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "hello" })]) {
      expect(reply.status).toBe(503);
      expect(errorOf(reply)).toEqual({ code: "RUNTIME_UNAVAILABLE", message: "the agent snapshot of this task can't be read" });
    }
    w.db.delete(`DEVTASK#${run.taskId}`, "RECIPE");
    expect((await w.tools(run.capability)).status).toBe(503);
    expect(w.linear.calls).toEqual([]);
  });

  it("refuses an operation that is not the workspace's active one, or is being stopped, on both routes", async () => {
    const w = await world();
    const run = await w.startRun({ tools: [grant({ type: "linear" }, "read")] });
    const body = { requestId: randomUUID(), connector: "linear", scope: "charterarc", tool: "get_issue", schemaHash: "a".repeat(64), arguments: { id: "CHA-1" } };
    const operation = w.db.get(`WORKSPACE#${run.workspaceId}`, `OPERATION#${run.operationId}`) as Record<string, unknown>;
    w.db.set({ ...operation, status: "CANCEL_REQUESTED" });
    for (const reply of [await w.tools(run.capability), await w.callTool(run.capability, body)]) expect(errorOf(reply).code).toBe("STALE_FENCE");
    // A finished step that is still the workspace's active operation (the callback has not cleared it yet) is refused too.
    w.db.set({ ...operation, status: "SUCCEEDED" });
    for (const reply of [await w.tools(run.capability), await w.callTool(run.capability, body)]) expect(errorOf(reply).code).toBe("STALE_FENCE");
    w.db.set(operation);
    const workspace = w.db.get(`WORKSPACE#${run.workspaceId}`, "META") as Record<string, unknown>;
    w.db.set({ ...workspace, activeOperationId: randomUUID() });
    for (const reply of [await w.tools(run.capability), await w.callTool(run.capability, body)]) {
      expect(reply.status).toBe(409);
      expect(errorOf(reply).code).toBe("STALE_FENCE");
    }
    expect(w.linear.calls).toEqual([]);
  });

  it("serves nothing for an operation whose step is not an agent step", async () => {
    const w = await world();
    const run = await w.startRun({ tools: [grant({ type: "linear" }, "read")], steps: [{ id: "triage", name: "Triage", kind: "plan", settings: { instructions: [] } }] });
    expect((await w.tools(run.capability)).status).toBe(404);
  });

  it("serves nothing for an operation that is not a step of the task's agent", async () => {
    const w = await world();
    const run = await w.startRun({ tools: [grant({ type: "linear" }, "read")] });
    const operation = w.db.get(`WORKSPACE#${run.workspaceId}`, `OPERATION#${run.operationId}`) as Record<string, unknown>;
    const stepless = { ...operation };
    delete stepless.programStepId;
    for (const without of [{ ...operation, programStepId: "no-such-step" }, stepless]) {
      w.db.set(without);
      const listed = await w.tools(run.capability);
      expect(listed.status).toBe(404);
      expect(listed.body.catalogs).toBeUndefined();
      expect((await w.linearCall(run.capability, "get_issue", { id: "CHA-1" })).status).toBe(404);
    }
    expect(w.linear.calls).toEqual([]);
  });
});

describe("GET /v1/internal/agent-tools", () => {
  it("serves only the granted tools, as the model sees them, with no gate fields", async () => {
    const w = await world();
    const run = await w.startRun({ tools: [grant({ type: "linear" }, "read")] });
    const listed = await w.tools(run.capability);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const catalogs = listed.body.catalogs as ConnectorCatalog[];
    expect(catalogs.map((entry) => entry.connector)).toEqual(["linear"]);
    expect(catalogs[0]!.tools.map((entry) => entry.upstreamName)).toEqual(["list_issues", "get_issue"]);
    expect(catalogs[0]!.tools.map((entry) => entry.name)).toEqual(["linear__list_issues", "linear__get_issue"]);
    for (const entry of catalogs[0]!.tools) {
      expect(entry.access).toBe("read");
      expect(entry).not.toHaveProperty("hints");
      expect(entry).not.toHaveProperty("itemArguments");
    }
  });

  it("read_write adds the writes, and a step's tools narrow them back", async () => {
    const w = await world();
    const writes = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
    const names = async (capability: string) => ((await w.tools(capability)).body.catalogs as ConnectorCatalog[]).flatMap((entry) => entry.tools.map((item) => item.upstreamName));
    expect(await names(writes.capability)).toEqual(["list_issues", "get_issue", "save_issue", "save_comment"]);
    const narrowed = await w.startRun({
      tools: [grant({ type: "linear" }, "read_write")],
      steps: [{ id: "triage", name: "Triage", kind: "agent", workspace: "none", settings: { instructions: [], tools: ["get_*"] } }],
    });
    expect(await names(narrowed.capability)).toEqual(["get_issue"]);
  });

  it("a step whose tools are only workspace tools exposes no connector tool, and cannot call one", async () => {
    const w = await world();
    const run = await w.startRun({
      tools: [grant({ type: "linear" }, "read_write")],
      steps: [{ id: "triage", name: "Triage", kind: "agent", workspace: "read", settings: { instructions: [], tools: ["read"] } }],
    });
    expect((await w.tools(run.capability)).body.catalogs).toEqual([]);
    const refused = await w.callTool(run.capability, { requestId: randomUUID(), connector: "linear", scope: "charterarc", tool: "get_issue", schemaHash: "a".repeat(64), arguments: { id: "CHA-1" } });
    expect(errorOf(refused).code).toBe("AGENT_TOOL_NOT_GRANTED");
    expect(w.linear.calls).toEqual([]);
  });

  it("serves nothing for a recipe with no grants, and nothing for a connector the project lacks", async () => {
    const w = await world();
    const none = await w.startRun({ tools: [] });
    expect((await w.tools(none.capability)).body.catalogs).toEqual([]);
    const jira = await w.startRun({ tools: [grant({ type: "jira" }, "read_write")] });
    expect((await w.tools(jira.capability)).body.catalogs).toEqual([]);
  });

  it("offers GitHub only the mapped tools, whatever the project approved, and asks GitHub with a read-only agent token", async () => {
    const w = await world();
    const run = await w.startRun({ tools: [grant({ type: "github" }, "read_write")] });
    const listed = await w.tools(run.capability);
    const catalog = (listed.body.catalogs as ConnectorCatalog[]).find((entry) => entry.connector === "github")!;
    expect(catalog.tools.map((entry) => entry.upstreamName)).toEqual(["issue_read", "add_issue_comment", "issue_write", "pull_request_read"]);
    expect(w.tokens).toHaveBeenCalled();
    for (const [repository, permissions, scope] of w.tokens.mock.calls) {
      expect(repository).toMatchObject({ owner: "example" });
      expect(permissions).toEqual({ issues: "read", pull_requests: "read", contents: "read" });
      expect(scope).toEqual({ orgId: TEST_ORG });
    }
    expect(w.githubConnections.every((connection) => connection.token === "agent-installation-token")).toBe(true);
  });

  it("lists nothing for a connector that is not connected, instead of a tool it cannot run", async () => {
    const w = await world();
    w.secrets.read.mockImplementation(async () => undefined);
    const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
    const listed = await w.tools(run.capability);
    expect(listed.status).toBe(200);
    expect(listed.body.catalogs).toEqual([]);
  });

  it("ends the task and serves nothing when its creator is no longer a member", async () => {
    const w = await world();
    const run = await w.startRun();
    w.removeCreator();
    const listed = await w.tools(run.capability);
    expect(listed.status).toBe(403);
    expect(errorOf(listed).code).toBe("TASK_ACCESS_DENIED");
    expect(w.db.get(`DEVTASK#${run.taskId}`, "META")).toMatchObject({ outcome: "creator_removed" });
  });
});

describe("POST /v1/internal/agent-tools/call", () => {
  it("runs a granted read through the vendor", async () => {
    const w = await world();
    const run = await w.startRun();
    const requestId = randomUUID();
    const hash = await w.schemaHash(run.capability, "linear", "get_issue");
    const reply = await w.callTool(run.capability, { requestId, connector: "linear", scope: "charterarc", tool: "get_issue", schemaHash: hash, arguments: { id: "CHA-1" } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.result).toMatchObject({ requestId, status: "SUCCEEDED", replayed: false });
    expect(w.linear.calls.filter((entry) => entry.name === "get_issue").length).toBeGreaterThan(0);
  });

  it("replays a write with the same request id without sending it twice", async () => {
    const w = await world();
    const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
    const requestId = randomUUID();
    const hash = await w.schemaHash(run.capability, "linear", "save_comment");
    const body = { requestId, connector: "linear", scope: "charterarc", tool: "save_comment", schemaHash: hash, arguments: { issueId: "CHA-1", body: "Looks like a duplicate" } };
    const first = await w.callTool(run.capability, body);
    expect(first.body.result).toMatchObject({ requestId, status: "SUCCEEDED", replayed: false });
    const second = await w.callTool(run.capability, body);
    expect(second.body.result).toMatchObject({ requestId, status: "SUCCEEDED", replayed: true });
    expect(w.linear.calls.filter((entry) => entry.name === "save_comment")).toHaveLength(1);
  });

  it("refuses save_issue under a read grant with the exact AGENT_TOOL_NOT_GRANTED text, and asks neither the gate nor the vendor", async () => {
    const w = await world();
    const { gate, seen } = recordingGate(() => ({ decision: "run" }));
    w.configure((base) => ({ ...base, gate }));
    const run = await w.startRun({ tools: [grant({ type: "linear" }, "read")] });
    const refused = await w.linearCall(run.capability, "save_issue", { title: "x" });
    expect(refused.status).toBe(403);
    expect(errorOf(refused)).toEqual({ code: "AGENT_TOOL_NOT_GRANTED", message: NOT_GRANTED("triage-bot", "linear", "save_issue") });
    expect(seen).toEqual([]);
    expect(w.linear.calls).toEqual([]);
  });

  it("asks no vendor anything about a tool the grants do not give", async () => {
    const w = await world();
    const run = await w.startRun({ tools: [grant({ type: "linear" }, "read")] });
    const refused = await w.callTool(run.capability, { requestId: randomUUID(), connector: "linear", scope: "charterarc", tool: "save_issue", schemaHash: "a".repeat(64), arguments: { title: "x" } });
    expect(refused.status).toBe(403);
    expect(w.linear.headers).toEqual([]);
  });

  it("refuses a tool the grants give but the vendor no longer offers, with the same words", async () => {
    const w = await world();
    const run = await w.startRun({ tools: [grant({ type: "linear" }, "read")] });
    const reply = await w.callTool(run.capability, { requestId: randomUUID(), connector: "linear", scope: "charterarc", tool: "retired_tool", schemaHash: "a".repeat(64), arguments: {} });
    expect(reply.status).toBe(403);
    expect(errorOf(reply)).toEqual({ code: "AGENT_TOOL_NOT_GRANTED", message: NOT_GRANTED("triage-bot", "linear", "retired_tool") });
    expect(w.linear.calls).toEqual([]);
  });

  it("gives the same text for a tool or a connector that does not exist, so nothing is learned from the difference", async () => {
    const w = await world();
    const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
    const base = { requestId: randomUUID(), scope: "charterarc", schemaHash: "a".repeat(64), arguments: {} };
    const unknownTool = await w.callTool(run.capability, { ...base, connector: "linear", tool: "drop_everything" });
    expect(errorOf(unknownTool)).toEqual({ code: "AGENT_TOOL_NOT_GRANTED", message: NOT_GRANTED("triage-bot", "linear", "drop_everything") });
    const unknownConnector = await w.callTool(run.capability, { ...base, connector: "sentry", tool: "get_issue" });
    expect(errorOf(unknownConnector)).toEqual({ code: "AGENT_TOOL_NOT_GRANTED", message: NOT_GRANTED("triage-bot", "sentry", "get_issue") });
    expect(w.linear.calls).toEqual([]);
  });

  it("refuses a scope the connector does not have before the gate, and says so in the connector's own words", async () => {
    const w = await world();
    const { gate, seen } = recordingGate(() => ({ decision: "run" }));
    w.configure((base) => ({ ...base, gate }));
    const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
    const reply = await w.callTool(run.capability, { requestId: randomUUID(), connector: "linear", scope: "elsewhere", tool: "save_comment", schemaHash: "a".repeat(64), arguments: { issueId: "CHA-1", body: "hi" } });
    expect(reply.status).toBe(404);
    expect(errorOf(reply).message).toBe("connector scope not found");
    expect(seen).toEqual([]);
    expect(w.linear.calls).toEqual([]);
  });

  it("answers a schema the vendor has changed since the step was shown its tools with the connector's own refusal", async () => {
    const w = await world();
    const run = await w.startRun();
    const reply = await w.callTool(run.capability, { requestId: randomUUID(), connector: "linear", scope: "charterarc", tool: "get_issue", schemaHash: "e".repeat(64), arguments: { id: "CHA-1" } });
    expect(reply.status).toBe(200);
    expect(reply.body.result).toMatchObject({ status: "FAILED", reason: "schema_changed" });
    expect(w.linear.calls).toEqual([]);
  });

  it("refuses a malformed request before anything else", async () => {
    const w = await world();
    const run = await w.startRun();
    for (const body of [{}, { connector: "linear" }, { requestId: "nope", connector: "linear", scope: "x", tool: "get_issue", schemaHash: "a".repeat(64), arguments: {} }, { requestId: randomUUID(), connector: "linear", scope: "x", tool: "get_issue", schemaHash: "a".repeat(64), arguments: {}, unexpected: true }]) {
      const reply = await w.callTool(run.capability, body);
      expect(reply.status).toBe(400);
      expect(errorOf(reply).code).toBe("CONFIG_INVALID");
    }
  });

  it("checks, in order: the creator, the project authority, the grant, the preparation, then the gate", async () => {
    const w = await world();
    const order: string[] = [];
    const { gate } = recordingGate(() => { order.push("gate"); return { decision: "run" }; });
    w.configure((base) => ({
      ...base, gate,
      requireCreatorStillMember: async (task) => { order.push("creator"); return base.requireCreatorStillMember(task); },
      requireProjectAuthority: async (...args) => { order.push("authority"); return base.requireProjectAuthority(...args); },
    }));
    const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
    const schemaHash = await w.schemaHash(run.capability, "linear", "save_comment");
    order.length = 0;
    const reply = await w.callTool(run.capability, { requestId: randomUUID(), connector: "linear", scope: "charterarc", tool: "save_comment", schemaHash, arguments: { issueId: "CHA-1", body: "cc @alice" } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(order).toEqual(["creator", "authority", "gate"]);
  });

  it("authorizes through requireProjectAuthority with the task's org, owner and project, and a person who lost the project gets nothing", async () => {
    const w = await world();
    const authority = vi.fn();
    w.configure((base) => ({ ...base, requireProjectAuthority: async (...args) => { authority(...args); return base.requireProjectAuthority(...args); } }));
    const run = await w.startRun();
    expect((await w.linearCall(run.capability, "get_issue", { id: "CHA-1" })).status).toBe(200);
    const ownerKey = (w.db.get(`DEVTASK#${run.taskId}`, "META") as { ownerKey: string }).ownerKey;
    expect(authority).toHaveBeenCalledWith(TEST_ORG, ownerKey, "payments", expect.objectContaining({ taskCreator: expect.any(Function) as unknown }));
    // The grant rows go, and the person is only a plain org member: the project is not theirs any more.
    for (const item of w.db.find((entry) => entry.entityType === "MEMBERSHIP")) w.db.delete(item.pk as string, item.sk as string);
    const before = w.linear.calls.length;
    const refused = await w.linearCall(run.capability, "get_issue", { id: "CHA-1" });
    expect(refused.status).toBe(404);
    expect(errorOf(refused).message).toBe("project not found");
    expect(w.linear.calls).toHaveLength(before);
  });

  it("ends the task creator_removed after the owner's removal, and calls neither the gate nor the vendor", async () => {
    const w = await world();
    const { gate, seen } = recordingGate(() => ({ decision: "run" }));
    w.configure((base) => ({ ...base, gate }));
    const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
    w.removeCreator();
    const refused = await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "hello" });
    expect(refused.status).toBe(403);
    expect(errorOf(refused).code).toBe("TASK_ACCESS_DENIED");
    expect(errorOf(refused).message).toContain("is no longer a member of");
    expect(w.db.get(`DEVTASK#${run.taskId}`, "META")).toMatchObject({ outcome: "creator_removed" });
    expect(seen).toEqual([]);
    expect(w.linear.calls).toEqual([]);
  });

  describe("the write gate seam", () => {
    it("hands the gate the chain step that started the task (Plan 4's write approver selectors read it), and nothing for any other task", async () => {
      const w = await world();
      const { gate, seen } = recordingGate(() => ({ decision: "run" }));
      w.configure((base) => ({ ...base, gate }));
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")], approvals: { alwaysAsk: ["save_comment"] }, autonomy: "run" });
      await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "one" });
      expect(seen[0]).not.toHaveProperty("chain");
      const task = w.db.get(`DEVTASK#${run.taskId}`, "META") as Record<string, unknown>;
      w.db.set({ ...task, chain: { chainRunId: "crn_aaaaaaaaaaaaaaaaaaaa", stepId: "look" } });
      await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "two" });
      expect(seen[1]).toMatchObject({ chain: { chainRunId: "crn_aaaaaaaaaaaaaaaaaaaa", stepId: "look" } });
    });

    it("is handed the prepared call and the grant, and a run decision sends it to the vendor", async () => {
      const w = await world();
      const { gate, seen } = recordingGate(() => ({ decision: "run" }));
      w.configure((base) => ({ ...base, gate }));
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")], approvals: { alwaysAsk: ["save_comment"] }, autonomy: "run" });
      const reply = await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "cc @alice and @bob" });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(seen).toHaveLength(1);
      const input = seen[0]!;
      expect(input).toMatchObject({
        orgId: TEST_ORG, taskId: run.taskId, project: "payments", connector: "linear", scope: "charterarc",
        tool: { connector: "linear", type: "linear", upstreamName: "save_comment", presentedName: "linear__save_comment", access: "write" },
        args: { issueId: "CHA-1", body: "cc alice and bob" },
        strippedMentions: ["@alice", "@bob"],
        recipe: { autonomy: "run", allowMentions: false, approvals: { alwaysAsk: ["save_comment"] } },
      });
      expect(typeof input.classify).toBe("function");
      const classified = await input.classify();
      expect(classified.class).toBe("consequential");
      // What the vendor was sent is what the gate was given, plus the footer the connector adds.
      const sent = w.linear.calls.find((entry) => entry.name === "save_comment")!;
      expect(String(sent.arguments.body)).toMatch(/^cc alice and bob/u);
    });

    it("a wait decision sends nothing and tells the step to wait, not to try again", async () => {
      const w = await world();
      const { gate } = recordingGate(() => ({ decision: "wait", approvalId: "apr_aaaaaaaaaaaaaaaaaaaa", text: "Waiting for a person to approve this change." }));
      w.configure((base) => ({ ...base, gate }));
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      const requestId = randomUUID();
      const reply = await w.linearCall(run.capability, "save_issue", { id: "CHA-1", title: "new" }, { requestId });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(reply.body.result).toEqual({ requestId, status: "WAITING_FOR_APPROVAL", text: "Waiting for a person to approve this change.", truncated: false, replayed: false });
      expect(reply.body.approvalId).toBe("apr_aaaaaaaaaaaaaaaaaaaa");
      expect(w.linear.calls.filter((entry) => entry.name === "save_issue")).toEqual([]);
    });

    it("a refuse decision ends the call with the gate's code and words, and sends nothing", async () => {
      const w = await world();
      const { gate } = recordingGate(() => ({ decision: "refuse", code: "APPROVAL_CLOSED", message: "This was already decided." }));
      w.configure((base) => ({ ...base, gate }));
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      const reply = await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "hello" });
      expect(reply.status).toBe(409);
      expect(errorOf(reply)).toEqual({ code: "APPROVAL_CLOSED", message: "This was already decided." });
      expect(w.linear.calls).toEqual([]);
    });

    it("a gate that throws, or answers something it should not, sends nothing", async () => {
      const w = await world();
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      w.configure((base) => ({ ...base, gate: async () => { throw new Error("boom: secret detail"); } }));
      const thrown = await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "hello" });
      expect(thrown.status).toBe(400);
      expect(JSON.stringify(thrown.body)).not.toContain("secret detail");
      w.configure((base) => ({ ...base, gate: (async () => ({ decision: "go-ahead" })) as never }));
      expect((await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "hello" })).status).toBe(400);
      expect(w.linear.calls).toEqual([]);
    });

    it("strips an @-mention before the vendor sees it, and keeps it only when the snapshot allows mentions and the gate says run", async () => {
      const plain = await world();
      plain.configure((base) => ({ ...base, gate: async () => ({ decision: "run" }) }));
      const run = await plain.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      await plain.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "cc @alice" });
      const sent = plain.linear.calls.find((entry) => entry.name === "save_comment")!;
      expect(bodyOf(sent)).toMatch(/^cc alice/u);
      expect(bodyOf(sent)).not.toContain("@alice");

      const allowing = await world();
      allowing.configure((base) => ({ ...base, gate: async () => ({ decision: "run" }) }));
      const allowed = await allowing.startRun({ tools: [grant({ type: "linear" }, "read_write")], allowMentions: true });
      await allowing.linearCall(allowed.capability, "save_comment", { issueId: "CHA-1", body: "cc @alice" });
      expect(bodyOf(allowing.linear.calls.find((entry) => entry.name === "save_comment")!)).toMatch(/^cc @alice/u);
    });

    it("adds Rovara's label to a ticket the agent creates", async () => {
      const w = await world();
      const { gate, seen } = recordingGate(() => ({ decision: "run" }));
      w.configure((base) => ({ ...base, gate }));
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      await w.linearCall(run.capability, "save_issue", { title: "Found a bug", labels: ["bug"] });
      expect(seen[0]!.args).toMatchObject({ title: "Found a bug", labels: ["bug", "rovara"] });
      expect(w.linear.calls.find((entry) => entry.name === "save_issue")!.arguments).toMatchObject({ labels: ["bug", "rovara"] });
    });

    it("classifies once however often the gate asks", async () => {
      const w = await world();
      const same: boolean[] = [];
      w.configure((base) => ({ ...base, gate: async (input) => { same.push(input.classify() === input.classify()); return { decision: "run" }; } }));
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "hello" });
      expect(same).toEqual([true]);
    });

    it("hands the gate a classification built from live data: the org's guardrails are read on each call", async () => {
      const w = await world();
      const classes: string[] = [];
      w.configure((base) => ({ ...base, gate: async (input) => { classes.push((await input.classify()).class); return { decision: "run" }; } }));
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      const say = () => w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "please shipit now" });
      await say();
      const key = agentGuardrailsKey(TEST_ORG);
      w.db.set({ ...key, entityType: "AGENT_GUARDRAILS", revision: 1, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, extraCommandWords: ["shipit"] } });
      await say();
      expect(classes).toEqual(["safe", "consequential"]);
    });
  });

  describe("the stand-in gate until approvals are wired", () => {
    it("lets reads and safe writes through", async () => {
      const w = await world();
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      expect((await w.linearCall(run.capability, "get_issue", { id: "CHA-1" })).body.result).toMatchObject({ status: "SUCCEEDED" });
      const comment = await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "Looks like a duplicate of CHA-9" });
      expect(comment.status, JSON.stringify(comment.body)).toBe(200);
      expect(comment.body.result).toMatchObject({ status: "SUCCEEDED" });
    });

    it("refuses a consequential call with a clear 'approvals are not available yet' message, and sends nothing", async () => {
      const w = await world({ standIn: true });
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      const refused = await w.linearCall(run.capability, "save_issue", { id: "CHA-1", title: "Rename it" });
      expect(refused.status).toBe(403);
      expect(errorOf(refused)).toEqual({
        code: "FORBIDDEN",
        message: "Changes that need a person's approval aren't available in this release yet, so this call was not sent. Nothing was changed.",
      });
      expect(w.linear.calls).toEqual([]);
    });

    it("refuses a call a project deny rule matches, even a read, with the not-granted text", async () => {
      const w = await world({ standIn: true });
      const key = projectRevisionKey(TEST_ORG, "payments", 1);
      const record = w.db.get(key) as { definition: Record<string, unknown> };
      w.db.set({ ...record, definition: { ...record.definition, actionPolicy: { rules: [{ tool: "linear__get_issue", outcome: "deny", reason: "closed to agents" }] } } });
      const run = await w.startRun();
      const refused = await w.linearCall(run.capability, "get_issue", { id: "CHA-1" });
      expect(refused.status).toBe(403);
      expect(errorOf(refused)).toEqual({ code: "AGENT_TOOL_NOT_GRANTED", message: NOT_GRANTED("triage-bot", "linear", "get_issue") });
      expect(w.linear.calls).toEqual([]);
    });

    it("exports the stand-in, which is what a broker without a gate of its own uses", () => {
      expect(typeof approvalsNotWiredGate).toBe("function");
    });
  });

  describe("the items a run created", () => {
    it("records nothing when the create failed", async () => {
      const w = await world();
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      const hash = await w.schemaHash(run.capability, "linear", "save_issue");
      w.linear.unauthorized.value = true;
      const failed = await w.callTool(run.capability, { requestId: randomUUID(), connector: "linear", scope: "charterarc", tool: "save_issue", schemaHash: hash, arguments: { title: "Found a bug" } });
      expect(failed.body.result).toMatchObject({ status: "FAILED" });
      expect(w.db.find((item) => item.entityType === "AGENT_ITEM")).toEqual([]);
    });

    it("records a GitHub issue under its repository, so only that repository's issue is the run's own", async () => {
      const w = await world();
      const run = await w.startRun({ tools: [grant({ type: "github" }, "read_write")] });
      const created = await w.githubCall(run.capability, "issue_write", { method: "create", title: "Found a bug", body: "details" });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      expect(w.db.find((item) => item.entityType === "AGENT_ITEM").map((item) => item.sk)).toEqual(["github#example/demo#7"]);
      const own = await w.githubCall(run.capability, "issue_write", { method: "update", issue_number: 7, title: "A worse bug" });
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      const foreign = await w.githubCall(run.capability, "issue_write", { method: "update", issue_number: 8, title: "Rename it" });
      expect(foreign.status).toBe(200);
      expect(foreign.body.result).toMatchObject({ status: "WAITING_FOR_APPROVAL" });
      expect(w.githubCalls.filter((entry) => entry.arguments.issue_number === 8)).toEqual([]);
    });

    it("records what a create made, so the same run may change it, and nothing else", async () => {
      const w = await world();
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      const created = await w.linearCall(run.capability, "save_issue", { title: "Found a bug" });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      expect(created.body.result).toMatchObject({ status: "SUCCEEDED" });
      const own = await w.linearCall(run.capability, "save_issue", { id: "CHA-2", title: "Found a worse bug" });
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      const foreign = await w.linearCall(run.capability, "save_issue", { id: "CHA-1", title: "Rename it" });
      expect(foreign.status).toBe(200);
      expect(foreign.body.result).toMatchObject({ status: "WAITING_FOR_APPROVAL" });
      expect(w.linear.calls.filter((entry) => entry.arguments.id === "CHA-1" && entry.name === "save_issue")).toEqual([]);
      expect(w.db.find((item) => item.entityType === "AGENT_ITEM").map((item) => item.sk)).toEqual(["linear##CHA-2"]);
    });
  });

  describe("attribution", () => {
    it("adds no footer for a connector the project set to attribution: false", async () => {
      const w = await world({ linearAttribution: false });
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "Looks like a duplicate" });
      expect(bodyOf(w.linear.calls.find((entry) => entry.name === "save_comment")!)).toBe("Looks like a duplicate");
    });

    it("adds a footer naming the person and the agent to the long text of a write", async () => {
      const w = await world();
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "Looks like a duplicate" });
      const sent = w.linear.calls.find((entry) => entry.name === "save_comment")!;
      expect(bodyOf(sent)).toContain("Looks like a duplicate");
      expect(bodyOf(sent)).toContain("Requested by `Maya Chen` via Rovara agent `triage-bot`");
    });
  });

  describe("label ids", () => {
    it("reads the connector's own label list through the call path, once per run, and a trigger label's id makes the call wait", async () => {
      const w = await world({ labelTool: true });
      const classes: Array<{ class: string; reason: string }> = [];
      w.configure((base) => ({ ...base, gate: async (input) => { classes.push(await input.classify()); return { decision: "run" }; } }));
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      await w.linearCall(run.capability, "save_issue", { title: "x", addLabels: [UUID_AUTOMERGE] });
      await w.linearCall(run.capability, "save_issue", { title: "y", addLabels: [UUID_BUG] });
      await w.linearCall(run.capability, "save_issue", { title: "z", addLabels: ["not-listed-id-7a1c2d3e-4f50-4a61-8b72-9c83d4e5f6aa"] });
      expect(classes.map((entry) => entry.class)).toEqual(["consequential", "safe", "safe"]);
      expect(classes[0]!.reason).toMatch(/automation/u);
      expect(w.labelListings()).toBe(1);
    });

    it("a lister the dependencies hand in replaces the connector's own", async () => {
      const w = await world({ labelTool: true });
      const classes: string[] = [];
      w.configure((base) => ({
        ...base,
        labelListers: () => ({ linear: async () => new Map([[UUID_AUTOMERGE, "bug"], ["rovara", "rovara"]]) }),
        gate: async (input) => { classes.push((await input.classify()).class); return { decision: "run" }; },
      }));
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      await w.linearCall(run.capability, "save_issue", { title: "x", addLabels: [UUID_AUTOMERGE] });
      expect(classes).toEqual(["safe"]);
      expect(w.labelListings()).toBe(0);
    });

    it("a label list tool the project approved for writing is not read", async () => {
      const w = await world({ labelTool: "write" });
      const classes: string[] = [];
      w.configure((base) => ({ ...base, gate: async (input) => { classes.push((await input.classify()).class); return { decision: "run" }; } }));
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      await w.linearCall(run.capability, "save_issue", { title: "x", addLabels: [UUID_BUG] });
      expect(classes).toEqual(["consequential"]);
      expect(w.labelListings()).toBe(0);
    });

    it("a label id the connector's list does not hold makes the call wait", async () => {
      const w = await world({ labelTool: true });
      const classes: string[] = [];
      w.configure((base) => ({ ...base, gate: async (input) => { classes.push((await input.classify()).class); return { decision: "run" }; } }));
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      await w.linearCall(run.capability, "save_issue", { title: "x", addLabels: ["9b2c3d4e-5f60-4b71-8c82-9d93e4f5a618"] });
      expect(classes).toEqual(["consequential"]);
    });

    it("resolves an id given in addLabels through the connector's label list, and a trigger label makes the call wait", async () => {
      const w = await world();
      const UUID = "5d8a1f0e-3b7c-4e2a-9f10-6c2b8d4e7a91";
      w.configure((base) => ({ ...base, labelListers: () => ({ linear: async () => new Map([[UUID, "automerge"], ["rovara", "rovara"]]) }) }));
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      const created = await w.linearCall(run.capability, "save_issue", { title: "x", addLabels: [UUID] });
      expect(created.status).toBe(200);
      expect(created.body.result).toMatchObject({ status: "WAITING_FOR_APPROVAL" });
      expect(w.linear.calls).toEqual([]);
    });
  });
});

describe("GitHub through the agent routes", () => {
  it("mints an agent token with exactly the tool's permissions for the org, and calls the tool with it", async () => {
    const w = await world();
    const run = await w.startRun({ tools: [grant({ type: "github" }, "read_write")] });
    const reply = await w.githubCall(run.capability, "add_issue_comment", { issue_number: 3, body: "Looks like a duplicate" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.result).toMatchObject({ status: "SUCCEEDED" });
    const commentToken = w.tokens.mock.calls.filter(([, permissions]) => JSON.stringify(permissions) === JSON.stringify({ issues: "write", metadata: "read" }));
    expect(commentToken.length).toBeGreaterThan(0);
    expect(commentToken[0]![0]).toEqual({ owner: "example", name: "demo" });
    expect(commentToken[0]![2]).toEqual({ orgId: TEST_ORG });
    const sent = w.githubCalls.find((entry) => entry.name === "add_issue_comment")!;
    expect(sent.arguments).toMatchObject({ owner: "example", repo: "demo", issue_number: 3 });
    expect(bodyOf(sent)).toContain("Looks like a duplicate");
  });

  it("refuses a tool on the refusal list with the pull request flow text, though the project approved it, and mints nothing", async () => {
    const w = await world();
    const run = await w.startRun({ tools: [grant({ type: "github" }, "read_write")] });
    await w.tools(run.capability);
    const before = w.tokens.mock.calls.length;
    const reply = await w.githubCall(run.capability, "merge_pull_request", { pullNumber: 4 });
    expect(reply.status).toBe(403);
    expect(errorOf(reply)).toEqual({ code: "AGENT_TOOL_NOT_GRANTED", message: PULL_REQUEST_FLOW });
    expect(w.tokens.mock.calls).toHaveLength(before);
    expect(w.githubCalls).toEqual([]);
  });

  it("refuses a call that names a repository the project does not have, before any token is minted", async () => {
    const w = await world();
    const run = await w.startRun({ tools: [grant({ type: "github" }, "read_write")] });
    await w.tools(run.capability);
    const before = w.tokens.mock.calls.length;
    const reply = await w.githubCall(run.capability, "add_issue_comment", { owner: "other", repo: "secret", issue_number: 3, body: "hi" });
    expect(reply.status).toBe(403);
    expect(errorOf(reply)).toEqual({ code: "AGENT_TOOL_NOT_GRANTED", message: NOT_GRANTED("triage-bot", "github", "add_issue_comment") });
    expect(w.tokens.mock.calls).toHaveLength(before);
    expect(w.githubCalls).toEqual([]);
  });

  it("refuses a call that names another repository of the project than the scope's, before any token is minted", async () => {
    const w = await world({ extraRepositories: [{ name: "billing", url: "https://github.com/example/billing.git", path: "repo/billing", defaultBranch: "main", credentialRef: "github-app" }] });
    const run = await w.startRun({ tools: [grant({ type: "github" }, "read_write")] });
    await w.tools(run.capability);
    const before = w.tokens.mock.calls.length;
    const reply = await w.githubCall(run.capability, "add_issue_comment", { owner: "example", repo: "billing", issue_number: 3, body: "hi" });
    expect(reply.status).toBe(403);
    expect(errorOf(reply)).toEqual({ code: "AGENT_TOOL_NOT_GRANTED", message: NOT_GRANTED("triage-bot", "github", "add_issue_comment") });
    expect(w.tokens.mock.calls).toHaveLength(before);
    expect(w.githubCalls).toEqual([]);
  });

  it("passes the project repository's pinned installation to the token and to the repository scan", async () => {
    const w = await world({ pinnedInstallation: 4242, workflowFiles: {} });
    const run = await w.startRun({ tools: [grant({ type: "github" }, "read_write")] });
    const reply = await w.githubCall(run.capability, "add_issue_comment", { issue_number: 3, body: "hello" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const optionsOf = w.tokens.mock.calls.map((entry) => entry[3]);
    expect(optionsOf.length).toBeGreaterThan(0);
    for (const options of optionsOf) expect(options).toEqual({ installationId: 4242 });
    expect(w.readerPins.length).toBeGreaterThan(0);
    for (const pin of w.readerPins) expect(pin).toBe(4242);
  });

  it("reads the pinned installation from the repository's host record as well as from the old top-level field (task P7)", async () => {
    const w = await world({ pinnedByHost: 4243, workflowFiles: {} });
    const run = await w.startRun({ tools: [grant({ type: "github" }, "read_write")] });
    const reply = await w.githubCall(run.capability, "add_issue_comment", { issue_number: 3, body: "hello" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const optionsOf = w.tokens.mock.calls.map((entry) => entry[3]);
    expect(optionsOf.length).toBeGreaterThan(0);
    for (const options of optionsOf) expect(options).toEqual({ installationId: 4243 });
  });

  it("makes a comment wait when the repository has workflows that react to comments, and sends nothing", async () => {
    const w = await world({ workflowFiles: { ".github/workflows/triage.yml": workflow("issue_comment", "./scripts/triage.sh"), "scripts/triage.sh": "echo triage" } });
    const run = await w.startRun({ tools: [grant({ type: "github" }, "read_write")] });
    const reply = await w.githubCall(run.capability, "add_issue_comment", { issue_number: 3, body: "hello" });
    expect(reply.status).toBe(200);
    expect(reply.body.result).toMatchObject({ status: "WAITING_FOR_APPROVAL" });
    expect(w.githubCalls).toEqual([]);
  });

  it("holds a pull request tool to a pull request that exists in the repository", async () => {
    const w = await world();
    const run = await w.startRun({ tools: [grant({ type: "github" }, "read")] });
    const missing = await w.githubCall(run.capability, "pull_request_read", { pullNumber: 404, method: "get" });
    expect(missing.status, JSON.stringify(missing.body)).toBe(200);
    expect(missing.body.result).toMatchObject({ status: "FAILED" });
    expect(String((missing.body.result as { text: string }).text)).toContain("pull request in the selected repository");
    expect(w.githubCalls).toEqual([]);
    const found = await w.githubCall(run.capability, "pull_request_read", { pullNumber: 5, method: "get" });
    expect(found.body.result).toMatchObject({ status: "SUCCEEDED" });
  });

  it("holds the pull request lookup and the label read to the pinned installation too", async () => {
    const w = await world({ pinnedInstallation: 4242 });
    const classes: string[] = [];
    w.configure((base) => ({ ...base, gate: async (input) => { classes.push((await input.classify()).class); return { decision: "run" }; } }));
    const run = await w.startRun({ tools: [grant({ type: "github" }, "read_write")] });
    await w.githubCall(run.capability, "pull_request_read", { pullNumber: 5, method: "get" });
    expect(w.heads.mock.calls.length).toBeGreaterThan(0);
    for (const entry of w.heads.mock.calls) expect(entry[3]).toEqual({ installationId: 4242 });
    await w.githubCall(run.capability, "add_issue_comment", { issue_number: 3, body: "hello", labelIds: [11] });
    expect(w.labelReads.length).toBeGreaterThan(0);
    for (const read of w.labelReads) expect(read.options).toEqual({ installationId: 4242 });
    expect(classes.at(-1)).toBe("consequential");
  });

  it("a read mints a read-only token for just that tool", async () => {
    const w = await world();
    const run = await w.startRun({ tools: [grant({ type: "github" }, "read")] });
    const reply = await w.githubCall(run.capability, "issue_read", { issue_number: 3, method: "get" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const permissions = w.tokens.mock.calls.map((entry) => JSON.stringify(entry[1]));
    expect(permissions).toContain(JSON.stringify({ issues: "read", metadata: "read" }));
    expect(permissions.some((entry) => entry.includes("\"write\""))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The catalog cache is per org
// ---------------------------------------------------------------------------------------------

describe("the catalog cache", () => {
  const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
  const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
  const fake = (served: { description: string }) => {
    const connect = (async () => ({
      tools: [{ name: "get_issue", description: served.description, inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }],
      call: async () => ({ content: [{ type: "text" as const, text: "{}" }] }),
      close: async () => undefined,
    })) as unknown as Parameters<typeof discoverConnector>[0]["connector"]["connect"];
    const connector: ResolvedConnector = {
      name: "linear", type: "linear", label: "Linear issues", vendor: "Linear", scopeNoun: "team", scopes: [{ alias: "team", scope: {} }],
      policy: { tools: [{ name: "get_issue", access: "read" }] }, approvals: [{ name: "get_issue" }], attribution: true, ledger: { prefix: "LINEAR", entityType: "LINEAR" },
      configured: async () => true,
      definition: async () => ({
        label: "Linear", endpoint: new URL("https://mcp.linear.test/mcp"), permissionsHint: "x",
        credentials: { issue: async () => ({ token: "t", bindings: {} }) }, binder: { properties: [], bind: () => ({}) }, guards: [],
      }),
      ...(connect === undefined ? {} : { connect }),
    };
    return connector;
  };
  const workspace = { projectName: "web" } as WorkspaceInstance;
  const context = (orgId: OrgId) => ({ orgId, workspaceId: "ws", ownerKey: "owner", settingsRevision: 1 });

  it("keeps org A's discovery from org B: the same project, revision, connector and alias in two orgs are two entries", async () => {
    const catalogs = new CatalogCache<ScopeDiscovery>({ ttlMs: 600_000, maxEntries: 16 });
    const forB = await discoverConnector({ connector: fake({ description: "B's private tool" }), workspace, context: context(ORG_B), catalogs });
    const forA = await discoverConnector({ connector: fake({ description: "A's tool" }), workspace, context: context(ORG_A), catalogs });
    expect(forB.tools[0]!.description).toContain("B's private tool");
    expect(forA.tools[0]!.description).toContain("A's tool");
    expect(forA.tools[0]!.description).not.toContain("B's");
    // And each is served from its own entry afterwards, even when the vendor now says something else.
    const againA = await discoverConnector({ connector: fake({ description: "changed" }), workspace, context: context(ORG_A), catalogs });
    expect(againA.tools[0]!.description).toContain("A's tool");
    const againB = await discoverConnector({ connector: fake({ description: "changed" }), workspace, context: context(ORG_B), catalogs });
    expect(againB.tools[0]!.description).toContain("B's private tool");
  });

  it("drops only the calling org's entry when a call finds its schema changed", async () => {
    const catalogs = new CatalogCache<ScopeDiscovery>({ ttlMs: 600_000, maxEntries: 16 });
    for (const orgId of [ORG_A, ORG_B]) await discoverConnector({ connector: fake({ description: orgId }), workspace, context: context(orgId), catalogs });
    const stale = await callConnector({
      connector: fake({ description: ORG_A }), workspace, context: context(ORG_A), catalogs,
      request: { requestId: randomUUID(), scope: "team", tool: "get_issue", schemaHash: "e".repeat(64), arguments: { id: "1" } },
      ledger: { claim: async () => true, get: async () => undefined, finish: async () => undefined },
    });
    expect(stale).toMatchObject({ status: "FAILED", reason: "schema_changed" });
    expect(catalogs.get(connectorCatalogKey(ORG_A, "web", 1, "linear", "team"))).toBeUndefined();
    expect(catalogs.get(connectorCatalogKey(ORG_B, "web", 1, "linear", "team"))).toBeDefined();
  });

  it("a refresh by one org drops that org's entry and no other's", async () => {
    const catalogs = new CatalogCache<ScopeDiscovery>({ ttlMs: 600_000, maxEntries: 16 });
    for (const orgId of [ORG_A, ORG_B]) await discoverConnector({ connector: fake({ description: orgId }), workspace, context: context(orgId), catalogs });
    const refreshed = await discoverConnector({ connector: fake({ description: "new A" }), workspace, context: context(ORG_A), catalogs, refresh: true });
    expect(refreshed.tools[0]!.description).toContain("new A");
    const stillB = await discoverConnector({ connector: fake({ description: "new B" }), workspace, context: context(ORG_B), catalogs });
    expect(stillB.tools[0]!.description).toContain(ORG_B);
  });

  it("puts the org in the key", () => {
    expect(connectorCatalogKey(ORG_A, "web", 1, "linear", "team")).not.toBe(connectorCatalogKey(ORG_B, "web", 1, "linear", "team"));
  });
});

// ---------------------------------------------------------------------------------------------
// Task 19 wired to Task 21: the real write gate, the approved call and the settlement job's sweep
// ---------------------------------------------------------------------------------------------

describe("write approvals through the agent routes", () => {
  /** Another person's issue: changing it is consequential, so it waits for a person. */
  const CHANGE = { id: "CHA-1", title: "Rename it" };

  async function approvalWorld(recipe: Partial<ResolvedRecipe> = {}, options: WorldOptions = {}) {
    const w = await world(options);
    const seen: Array<Parameters<AgentWriteGate>[0]> = [];
    // The broker's own gate (Task 21's decideWrite), observed.
    w.configure((base) => ({ ...base, gate: async (input) => { seen.push(input); return base.gate(input); } }));
    const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")], ...recipe });
    const broker = await loadSlackBroker() as unknown as { createAgentRouteDependencies(input: never): ApprovalDependencies | undefined };
    const deps = broker.createAgentRouteDependencies(w.brokerInput as never);
    if (deps === undefined) throw new Error("the broker has no agent route dependencies");
    const approve = (approvalId: string, requestId: string = randomUUID()) =>
      decideApproval(deps, { orgId: TEST_ORG, developerId: MAYA.developerId, orgRole: "owner" }, approvalId, { requestId, decision: "APPROVE" });
    const saves = () => w.linear.calls.filter((entry) => entry.name === "save_issue");
    const sweep = () => w.handler({ source: "agentx.spend-settlement" }) as Promise<{ statusCode: number; body: string }>;
    return { w, run, seen, deps, approve, saves, sweep };
  }

  it("holds a consequential save_issue for a person, then sends it exactly once with the arguments it was asked with", async () => {
    const { w, run, seen, deps, approve, saves } = await approvalWorld();
    const waiting = await w.linearCall(run.capability, "save_issue", CHANGE);
    expect(waiting.status, JSON.stringify(waiting.body)).toBe(200);
    expect(waiting.body.result).toMatchObject({ status: "WAITING_FOR_APPROVAL", truncated: false, replayed: false });
    expect(String((waiting.body.result as { text: string }).text)).toContain("A person must approve this before it happens.");
    const approvalId = String(waiting.body.approvalId);
    expect(approvalId).toMatch(/^apr_/u);
    expect(saves()).toEqual([]);
    // The approval holds exactly what the gate was given: the prepared arguments (no owner or repo, which only GitHub's server binds).
    const stored = await getAnyApproval(deps, TEST_ORG, approvalId);
    expect(stored).toMatchObject({ kind: "write", status: "PENDING", connector: "linear", tool: "save_issue", operationId: run.operationId, subject: { kind: "agent_run", taskId: run.taskId, stepId: "triage" }, agent: { agentId: AGENT.agentId } });
    expect((stored as { arguments: unknown }).arguments).toEqual(seen[0]!.args);
    expect(seen[0]).toMatchObject({ stepId: "triage", owner: { developerId: MAYA.developerId } });

    // Asking again for the same change (a new request id) is the same approval, and still nothing is sent.
    const again = await w.linearCall(run.capability, "save_issue", CHANGE);
    expect(again.body.approvalId).toBe(approvalId);
    expect(saves()).toEqual([]);

    expect((await approve(approvalId)).status).toBe("APPROVED_DONE");
    expect(saves()).toHaveLength(1);
    expect(saves()[0]!.arguments).toMatchObject(seen[0]!.args);
    // The ledger holds the call under the approval's own request id, in the task's workspace.
    const ledgered = w.db.find((item) => item.pk === `WORKSPACE#${run.workspaceId}` && item.sk === `CONNECTOR#linear#${deriveWriteRequestId(approvalId)}`);
    expect(ledgered).toHaveLength(1);
    expect(await getAnyApproval(deps, TEST_ORG, approvalId as never)).toMatchObject({ status: "APPROVED_DONE", result: { status: "SUCCEEDED" } });

    // A repeat of the decision, and the settlement job's sweep, send nothing more.
    await approve(approvalId).catch(() => undefined);
    expect(saves()).toHaveLength(1);
  });

  it("makes no approval when the step's operation ended after the route's check and before the gate (Task 22 review, M2)", async () => {
    const { w, run } = await approvalWorld();
    w.configure((base) => ({ ...base, gate: async (input) => {
      const key = { pk: `WORKSPACE#${run.workspaceId}`, sk: `OPERATION#${run.operationId}` };
      w.db.set({ ...w.db.get(key.pk, key.sk)!, status: "SUCCEEDED" });
      return base.gate(input);
    } }));
    const reply = await w.linearCall(run.capability, "save_issue", CHANGE);
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toEqual([]);
    expect(w.db.find((item) => item.entityType === "OPEN_APPROVAL")).toEqual([]);
  });

  it("runs a safe call at once and never holds a read", async () => {
    const { w, run, seen } = await approvalWorld();
    const read = await w.linearCall(run.capability, "get_issue", { id: "CHA-1" });
    expect(read.body.result).toMatchObject({ status: "SUCCEEDED" });
    const comment = await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "Looks like a duplicate of CHA-9" });
    expect(comment.body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(seen.map((input) => input.tool.upstreamName)).toEqual(["get_issue", "save_comment"]);
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toEqual([]);
    expect(w.db.find((item) => item.entityType === "OPEN_APPROVAL")).toEqual([]);
  });

  it("never holds a read, whatever the recipe asks for", async () => {
    const { w, run } = await approvalWorld({ autonomy: "suggest" });
    for (let index = 0; index < 3; index += 1) {
      const read = await w.linearCall(run.capability, "get_issue", { id: "CHA-1" });
      expect(read.body.result).toMatchObject({ status: "SUCCEEDED" });
    }
  });

  it("refuses what a project rule denies, even a read, without making an approval", async () => {
    const { w, run, deps } = await approvalWorld();
    const key = projectRevisionKey(TEST_ORG, "payments", 1);
    const record = w.db.get(key) as { definition: Record<string, unknown> };
    w.db.set({ ...record, definition: { ...record.definition, actionPolicy: { rules: [{ tool: "linear__save_issue", outcome: "deny", reason: "closed to agents" }] } } });
    const refused = await w.linearCall(run.capability, "save_issue", CHANGE);
    expect(refused.status).toBe(403);
    expect(errorOf(refused).message).toBe("A rule on this project doesn't allow this action.");
    expect(w.linear.calls.filter((entry) => entry.name === "save_issue")).toEqual([]);
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toEqual([]);
    expect(deps).toBeDefined();
  });

  it("declining sends nothing", async () => {
    const { w, run, deps, saves } = await approvalWorld();
    const waiting = await w.linearCall(run.capability, "save_issue", CHANGE);
    const approvalId = String(waiting.body.approvalId);
    const declined = await decideApproval(deps, { orgId: TEST_ORG, developerId: MAYA.developerId, orgRole: "owner" }, approvalId, { requestId: randomUUID(), decision: "DECLINE" });
    expect(declined.status).toBe("DECLINED");
    expect(saves()).toEqual([]);
  });

  it("does not throw once the vendor may have been asked: an outcome in doubt stays for the settlement job's sweep, which sends it once", async () => {
    const { w, run, deps, approve, saves, sweep } = await approvalWorld();
    const waiting = await w.linearCall(run.capability, "save_issue", CHANGE);
    const approvalId = String(waiting.body.approvalId);
    // The ledger breaks while the approved call is made, before the vendor is asked: the broker answers a result, never an error, and the record stays for the sweep.
    let broken = true;
    w.configure((base) => ({
      ...base,
      ledger: (workspaceId, connector) => {
        const ledger = base.ledger(workspaceId, connector);
        return {
          claim: async (record) => { if (broken) throw new Error("the table is unavailable"); return ledger.claim(record); },
          get: (requestId) => ledger.get(requestId), finish: (record) => ledger.finish(record),
        };
      },
    }));
    const decided = await approve(approvalId);
    expect(decided.status).toBe("EXECUTING");
    expect(saves()).toEqual([]);
    expect(await getAnyApproval(deps, TEST_ORG, approvalId as never)).toMatchObject({ status: "EXECUTING", attempts: 1 });
    broken = false;
    // Ten minutes later the sweep (with the write gate on its dependencies too) finds it stuck and drives it again.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 10 * 60_000 });
    try {
      const run1 = await sweep();
      const jobs = (JSON.parse(run1.body) as { jobs: Array<{ name: string; ok: boolean; result?: unknown }> }).jobs;
      expect(jobs.find((job) => job.name === "expire-approvals")).toMatchObject({ ok: true, result: { redriven: 1 } });
    } finally {
      vi.useRealTimers();
    }
    expect(saves()).toHaveLength(1);
    expect(await getAnyApproval(deps, TEST_ORG, approvalId as never)).toMatchObject({ status: "APPROVED_DONE" });
  });

  describe("after a take-over (Plan 5 Task 12a)", () => {
    const setRole = (w: Awaited<ReturnType<typeof world>>, who: { developerId: string }, role: "member" | "admin") =>
      w.db.set({ ...orgMemberKey(TEST_ORG, who.developerId), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: who.developerId, role, joinedAt: "2026-10-01T00:00:00.000Z" });
    const takeOver = (w: Awaited<ReturnType<typeof world>>, taskId: string) =>
      w.db.set({ ...w.db.get(`DEVTASK#${taskId}`, "META")!, currentOwner: { developerId: OMAR.developerId, name: OMAR.name, provider: "oidc", since: "2026-10-22T11:00:00.000Z" } });

    it("makes the approval the taker's: it names them as its owner and in the event the task shows", async () => {
      const { w, run, deps } = await approvalWorld();
      takeOver(w, run.taskId);
      const waiting = await w.linearCall(run.capability, "save_issue", CHANGE);
      expect(waiting.status, JSON.stringify(waiting.body)).toBe(200);
      const stored = await getAnyApproval(deps, TEST_ORG, String(waiting.body.approvalId));
      expect(stored).toMatchObject({ kind: "write", owner: { developerId: OMAR.developerId, name: OMAR.name } });
      expect(w.db.find((item) => item.pk === `DEVTASK#${run.taskId}` && String(item.sk).startsWith("EVENT#")).map((item) => String(item.text)).join("\n")).toContain(`needs approval from ${OMAR.name} or a project maintainer`);
    });

    it("runs an approved write on the taker's org role when the task's principal holds no grant, and refuses it when only the creator holds the role", async () => {
      const allowed = await approvalWorld();
      setRole(allowed.w, MAYA, "member");
      setRole(allowed.w, OMAR, "admin");
      allowed.w.db.delete(projectMemberKey(TEST_ORG, String(allowed.run.task.ownerKey), "payments"));
      const first = await allowed.w.linearCall(allowed.run.capability, "save_issue", CHANGE);
      // Still Maya's task, with no role of her own: the call is refused before it can ask.
      expect(first.status).not.toBe(200);
      takeOver(allowed.w, allowed.run.taskId);
      const waiting = await allowed.w.linearCall(allowed.run.capability, "save_issue", CHANGE);
      expect(waiting.status, JSON.stringify(waiting.body)).toBe(200);
      const byOmar = await decideApproval(allowed.deps, { orgId: TEST_ORG, developerId: OMAR.developerId, orgRole: "admin" }, String(waiting.body.approvalId), { requestId: randomUUID(), decision: "APPROVE" });
      expect(byOmar.status).toBe("APPROVED_DONE");
      expect(allowed.saves()).toHaveLength(1);

      const refused = await approvalWorld();
      const asked = await refused.w.linearCall(refused.run.capability, "save_issue", CHANGE);
      expect(asked.status).toBe(200);
      setRole(refused.w, MAYA, "admin");
      setRole(refused.w, OMAR, "member");
      refused.w.db.delete(projectMemberKey(TEST_ORG, String(refused.run.task.ownerKey), "payments"));
      takeOver(refused.w, refused.run.taskId);
      const decided = await refused.approve(String(asked.body.approvalId));
      expect(decided.status).toBe("APPROVED_FAILED");
      expect(refused.saves()).toEqual([]);
    });
  });

  it("records what an approved create made, so the run may change it afterwards with no approval", async () => {
    const { w, run, deps, approve, saves } = await approvalWorld();
    // A create that adds a trigger label (one that makes automations act) is consequential.
    const UUID = "5d8a1f0e-3b7c-4e2a-9f10-6c2b8d4e7a91";
    w.configure((base) => ({ ...base, labelListers: () => ({ linear: async () => new Map([[UUID, "automerge"], ["rovara", "rovara"]]) }) }));
    const waiting = await w.linearCall(run.capability, "save_issue", { title: "Found a bug", addLabels: [UUID] });
    expect(waiting.body.result).toMatchObject({ status: "WAITING_FOR_APPROVAL" });
    const approvalId = String(waiting.body.approvalId);
    expect((await approve(approvalId)).status).toBe("APPROVED_DONE");
    expect(saves()).toHaveLength(1);
    expect(deps).toBeDefined();
    // The fake Linear answers a created issue as CHA-2: it is now the run's own, so changing it is not held (the fake Linear has no such issue to change).
    expect(w.db.find((item) => item.entityType === "AGENT_ITEM").map((item) => item.sk)).toEqual(["linear##CHA-2"]);
    const own = await w.linearCall(run.capability, "save_issue", { id: "CHA-2", title: "A worse bug" });
    expect(own.status).toBe(200);
    expect(own.body.approvalId).toBeUndefined();
    expect(own.body.result).not.toMatchObject({ status: "WAITING_FOR_APPROVAL" });
    const other = await w.linearCall(run.capability, "save_issue", { id: "CHA-1", title: "Rename it" });
    expect(other.body.result).toMatchObject({ status: "WAITING_FOR_APPROVAL" });
  });

  it("sends an approved GitHub change with the repository the server binds, which the stored call does not hold", async () => {
    const { w, run, deps, approve } = await approvalWorld({ tools: [grant({ type: "github" }, "read_write")] });
    // The fake GitHub answers the guard's preflight with the issue it was asked for (the world's own fake answers a different shape).
    w.connectGithub.mockImplementation(async (input): Promise<McpConnection> => ({
      tools: GITHUB_FAKE_TOOLS.filter((candidate) => input.tools === undefined || input.tools.includes(candidate.name)),
      call: async (name, args) => {
        w.githubCalls.push({ name, arguments: args });
        const issue = Number(args.issue_number);
        return { content: [{ type: "text", text: JSON.stringify(name === "issue_read" ? { number: issue, html_url: `https://github.com/example/demo/issues/${issue}` } : { number: issue }) }] };
      },
      close: async () => undefined,
    }));
    const waiting = await w.githubCall(run.capability, "issue_write", { method: "update", issue_number: 7, title: "Rename it" });
    expect(waiting.body.result).toMatchObject({ status: "WAITING_FOR_APPROVAL" });
    const approvalId = String(waiting.body.approvalId);
    expect((await getAnyApproval(deps, TEST_ORG, approvalId as never) as unknown as { arguments: Record<string, unknown> }).arguments).toEqual({ method: "update", issue_number: 7, title: "Rename it" });
    expect(w.githubCalls.filter((entry) => entry.name === "issue_write")).toEqual([]);
    expect((await approve(approvalId)).status).toBe("APPROVED_DONE");
    const sent = w.githubCalls.filter((entry) => entry.name === "issue_write");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.arguments).toMatchObject({ owner: "example", repo: "demo", method: "update", issue_number: 7, title: "Rename it" });
  });

  // ---- the wiring fix round

  /** Sets (or clears) the project's action policy on its registered revision. */
  const setPolicy = (w: Awaited<ReturnType<typeof world>>, rules: unknown[] | undefined) => {
    const key = projectRevisionKey(TEST_ORG, "payments", 1);
    const record = w.db.get(key) as { definition: Record<string, unknown> };
    const { actionPolicy: _dropped, ...definition } = record.definition; // eslint-disable-line @typescript-eslint/no-unused-vars -- the old policy is replaced
    w.db.set({ ...record, definition: { ...definition, ...(rules === undefined ? {} : { actionPolicy: { rules } }) } });
  };
  const ASK_COMMENT = { tool: "save_comment", connector: "linear", outcome: "ask", reason: "comments are looked at" };
  const COMMENT = { issueId: "CHA-1", body: "Looks like a duplicate of CHA-9" };
  /** Lets the next sweep find a record driven ten minutes ago. */
  const tenMinutesLater = () => vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 10 * 60_000 });

  it("answers a repeat of a held call from the approval even when the call now classifies as safe, and sends it once (F1)", async () => {
    const { w, run, approve } = await approvalWorld();
    setPolicy(w, [ASK_COMMENT]);
    const held = await w.linearCall(run.capability, "save_comment", COMMENT);
    expect(held.body.result).toMatchObject({ status: "WAITING_FOR_APPROVAL" });
    const approvalId = String(held.body.approvalId);
    // The same held call sent again with another request id is the same approval.
    const second = await w.linearCall(run.capability, "save_comment", COMMENT);
    expect(second.body.approvalId).toBe(approvalId);
    // The rule is lifted: the call now classifies as safe, but the approval exists, so it still waits.
    setPolicy(w, undefined);
    const third = await w.linearCall(run.capability, "save_comment", COMMENT);
    expect(third.body.result).toMatchObject({ status: "WAITING_FOR_APPROVAL" });
    expect(third.body.approvalId).toBe(approvalId);
    expect(w.linear.calls.filter((entry) => entry.name === "save_comment")).toEqual([]);
    expect((await approve(approvalId)).status).toBe("APPROVED_DONE");
    expect(w.linear.calls.filter((entry) => entry.name === "save_comment")).toHaveLength(1);
  });

  it("sends a held read-access tool once even when the run dies after the vendor answered (F2)", async () => {
    const { w, run, deps, approve, sweep } = await approvalWorld();
    setPolicy(w, [{ tool: "get_issue", connector: "linear", outcome: "ask", reason: "reads of issues are looked at" }]);
    const held = await w.linearCall(run.capability, "get_issue", { id: "CHA-1" });
    expect(held.body.result).toMatchObject({ status: "WAITING_FOR_APPROVAL" });
    const approvalId = String(held.body.approvalId);
    // The run dies after the vendor answered, before the approval is marked done.
    w.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("APPROVED_DONE"), error: { name: "InternalServerError" } });
    await approve(approvalId).catch(() => undefined);
    // (The Linear guard asks get_issue itself before the call, so what is counted is what the vendor was asked in all, which must not grow.)
    const asked = () => w.linear.calls.length;
    const askedOnce = asked();
    expect(askedOnce).toBeGreaterThan(0);
    expect(w.db.find((item) => item.pk === `WORKSPACE#${run.workspaceId}` && item.sk === `CONNECTOR#linear#${deriveWriteRequestId(approvalId)}`)).toHaveLength(1);
    tenMinutesLater();
    try { await sweep(); } finally { vi.useRealTimers(); }
    expect(asked()).toBe(askedOnce);
    expect(await getAnyApproval(deps, TEST_ORG, approvalId)).toMatchObject({ status: "APPROVED_DONE" });
  });

  it("sends an approved write once when the run dies after the vendor answered, and the sweep replays it from the ledger", async () => {
    const { w, run, deps, approve, saves, sweep } = await approvalWorld();
    const held = await w.linearCall(run.capability, "save_issue", CHANGE);
    const approvalId = String(held.body.approvalId);
    w.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("APPROVED_DONE"), error: { name: "InternalServerError" } });
    await approve(approvalId).catch(() => undefined);
    expect(saves()).toHaveLength(1);
    tenMinutesLater();
    try { await sweep(); } finally { vi.useRealTimers(); }
    expect(saves()).toHaveLength(1);
    expect(await getAnyApproval(deps, TEST_ORG, approvalId)).toMatchObject({ status: "APPROVED_DONE", result: { status: "SUCCEEDED", replayed: true } });
  });

  it("refuses to send an approved call through a workspace of another org (minor 3)", async () => {
    const { w, run, deps, approve, saves } = await approvalWorld();
    const held = await w.linearCall(run.capability, "save_issue", CHANGE);
    const approvalId = String(held.body.approvalId);
    const workspace = w.db.get(`WORKSPACE#${run.workspaceId}`, "META") as Record<string, unknown>;
    w.db.set({ ...workspace, orgId: "org_zzzzzzzzzzzzzzzzzzzz" });
    await approve(approvalId).catch(() => undefined);
    expect(saves()).toEqual([]);
    expect(await getAnyApproval(deps, TEST_ORG, approvalId)).toMatchObject({ status: "APPROVED_FAILED" });
  });

  it("names the agent the approver saw in the footer of an approved write (minor 4)", async () => {
    const { w, run, approve } = await approvalWorld();
    setPolicy(w, [ASK_COMMENT]);
    const held = await w.linearCall(run.capability, "save_comment", COMMENT);
    const approvalId = String(held.body.approvalId);
    const task = w.db.get(`DEVTASK#${run.taskId}`, "META") as { agent: Record<string, unknown> };
    w.db.set({ ...task, agent: { ...task.agent, name: "renamed-bot" } });
    expect((await approve(approvalId)).status).toBe("APPROVED_DONE");
    const sent = w.linear.calls.find((entry) => entry.name === "save_comment")!;
    expect(bodyOf(sent)).toContain("via Rovara agent `triage-bot`");
    expect(bodyOf(sent)).not.toContain("renamed-bot");
  });

  // ---- wiring fix round 2 (N1)

  it("replays a call that already ran when it is sent again with the same request id, even if it would be held now, and sends it once", async () => {
    const { w, run } = await approvalWorld();
    const requestId = randomUUID();
    const first = await w.linearCall(run.capability, "save_comment", COMMENT, { requestId });
    expect(first.body.result).toMatchObject({ status: "SUCCEEDED" });
    setPolicy(w, [ASK_COMMENT]);
    const again = await w.linearCall(run.capability, "save_comment", COMMENT, { requestId });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.result).toMatchObject({ status: "SUCCEEDED", replayed: true });
    expect(again.body.approvalId).toBeUndefined();
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toEqual([]);
    expect(w.linear.calls.filter((entry) => entry.name === "save_comment")).toHaveLength(1);
    // The same request id with other arguments is still a conflict, as for any call.
    const changed = await w.linearCall(run.capability, "save_comment", { ...COMMENT, body: "Another body" }, { requestId });
    expect(changed.status).toBeGreaterThanOrEqual(400);
    expect(w.linear.calls.filter((entry) => entry.name === "save_comment")).toHaveLength(1);
  });

  it("holds a call and claims its request id with the approval, so a repeat of the id answers the approval, and after the approval its result", async () => {
    const { w, run, approve } = await approvalWorld();
    setPolicy(w, [ASK_COMMENT]);
    const requestId = randomUUID();
    const held = await w.linearCall(run.capability, "save_comment", COMMENT, { requestId });
    const approvalId = String(held.body.approvalId);
    expect(held.body.result).toMatchObject({ status: "WAITING_FOR_APPROVAL" });
    // The rule is lifted; the repeat of the same id is answered from the approval, not run.
    setPolicy(w, undefined);
    const repeat = await w.linearCall(run.capability, "save_comment", COMMENT, { requestId });
    expect(repeat.body.result).toMatchObject({ status: "WAITING_FOR_APPROVAL" });
    expect(repeat.body.approvalId).toBe(approvalId);
    expect(w.linear.calls.filter((entry) => entry.name === "save_comment")).toEqual([]);
    expect((await approve(approvalId)).status).toBe("APPROVED_DONE");
    expect(w.linear.calls.filter((entry) => entry.name === "save_comment")).toHaveLength(1);
    const after = await w.linearCall(run.capability, "save_comment", COMMENT, { requestId });
    expect(after.body.result).toMatchObject({ status: "SUCCEEDED", replayed: true });
    expect(w.linear.calls.filter((entry) => entry.name === "save_comment")).toHaveLength(1);
  });

  it("never both holds and runs two calls with the same request id that race: the one that claims the id wins and the other replays it", async () => {
    const { w, run } = await approvalWorld();
    setPolicy(w, [ASK_COMMENT]);
    // The first call classifies as consequential, then is slow to reach the gate; meanwhile the rule is lifted and the second call, the same id, runs.
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    w.configure((base) => ({
      ...base,
      gate: async (input) => {
        const classification = await input.classify();
        if (first) { first = false; await slow; }
        expect(classification.class).toBeDefined();
        return base.gate(input);
      },
    }));
    const requestId = randomUUID();
    const a = w.linearCall(run.capability, "save_comment", COMMENT, { requestId });
    await vi.waitFor(() => expect(first).toBe(false));
    setPolicy(w, undefined);
    const b = await w.linearCall(run.capability, "save_comment", COMMENT, { requestId });
    expect(b.body.result).toMatchObject({ status: "SUCCEEDED" });
    release();
    const resolved = await a;
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body.result).toMatchObject({ status: "SUCCEEDED", replayed: true });
    expect(resolved.body.approvalId).toBeUndefined();
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toEqual([]);
    expect(w.linear.calls.filter((entry) => entry.name === "save_comment")).toHaveLength(1);
  });

  // ---- wiring fix round 3 (N2)

  /** Changes the access the project approved a Linear tool for, on its registered revision. */
  const setAccess = (w: Awaited<ReturnType<typeof world>>, tool: string, access: "read" | "write") => {
    const key = projectRevisionKey(TEST_ORG, "payments", 1);
    const record = w.db.get(key) as { definition: { integrations: { connectors: Array<{ name: string; tools: Array<{ name: string; access: string }> }> } } };
    const connectors = record.definition.integrations.connectors.map((entry) => (entry.name === "linear" ? { ...entry, tools: entry.tools.map((approved) => (approved.name === tool ? { ...approved, access } : approved)) } : entry));
    w.db.set({ ...record, definition: { ...record.definition, integrations: { ...record.definition.integrations, connectors } } });
  };

  it("never sends a read-approved, write-named tool under a request id that holds another call's record: a conflict, then one approved send in all (P2)", async () => {
    const { w, run, approve } = await approvalWorld();
    setAccess(w, "save_comment", "read");
    const requestId = randomUUID();
    // An earlier ordinary write leaves a ledger record under the id.
    const made = await w.linearCall(run.capability, "save_issue", { title: "Found a bug" }, { requestId });
    expect(made.body.result).toMatchObject({ status: "SUCCEEDED" });
    const comments = () => w.linear.calls.filter((entry) => entry.name === "save_comment");
    // Control: with a fresh id the same call is held (its name says it writes, and the project approved it only for reading).
    const held = await w.linearCall(run.capability, "save_comment", COMMENT);
    expect(held.body.result).toMatchObject({ status: "WAITING_FOR_APPROVAL" });
    // The reused id is another call: refused as a conflict, and nothing is sent.
    const reused = await w.linearCall(run.capability, "save_comment", COMMENT, { requestId });
    expect(reused.status).toBeGreaterThanOrEqual(400);
    expect(errorOf(reused).code).toBe("IDEMPOTENCY_CONFLICT");
    expect(comments()).toEqual([]);
    expect((await approve(String(held.body.approvalId))).status).toBe("APPROVED_DONE");
    expect(comments()).toHaveLength(1);
  });

  it("answers a reused request id on another tool as a conflict and sends nothing (P1)", async () => {
    const { w, run } = await approvalWorld();
    const requestId = randomUUID();
    expect((await w.linearCall(run.capability, "save_comment", COMMENT, { requestId })).body.result).toMatchObject({ status: "SUCCEEDED" });
    setPolicy(w, [{ tool: "get_issue", connector: "linear", outcome: "ask", reason: "reads of issues are looked at" }]);
    const sent = w.linear.calls.length;
    const reused = await w.linearCall(run.capability, "get_issue", { id: "CHA-1" }, { requestId });
    expect(reused.status).toBeGreaterThanOrEqual(400);
    expect(errorOf(reused).code).toBe("IDEMPOTENCY_CONFLICT");
    expect(w.linear.calls.length).toBe(sent);
  });

  it("answers a repeat of an ordinary record from the record, not by sending, whatever the tool's access", async () => {
    const { w, run } = await approvalWorld();
    setAccess(w, "save_comment", "read");
    // The gate lets this read-approved, write-named call run (as it would for an install whose gate says so): it is claimed in the ledger because its class is not a read.
    w.configure((base) => ({ ...base, gate: async (input) => { await input.classify(); return { decision: "run" }; } }));
    const requestId = randomUUID();
    const first = await w.linearCall(run.capability, "save_comment", COMMENT, { requestId });
    expect(first.body.result).toMatchObject({ status: "SUCCEEDED", replayed: false });
    const sent = w.linear.calls.filter((entry) => entry.name === "save_comment").length;
    const again = await w.linearCall(run.capability, "save_comment", COMMENT, { requestId });
    expect(again.body.result).toMatchObject({ status: "SUCCEEDED", replayed: true });
    expect(w.linear.calls.filter((entry) => entry.name === "save_comment")).toHaveLength(sent);
  });

  it("never both runs and holds a read-approved call that races a hold with the same request id", async () => {
    const { w, run } = await approvalWorld();
    setAccess(w, "save_comment", "read");
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    // The first call is held (the broker's own gate) but is slow to reach it; the second, the same id, is let through by a gate that runs it.
    w.configure((base) => ({
      ...base,
      gate: async (input) => {
        await input.classify();
        if (first) { first = false; await slow; return base.gate(input); }
        return { decision: "run" };
      },
    }));
    const requestId = randomUUID();
    const a = w.linearCall(run.capability, "save_comment", COMMENT, { requestId });
    await vi.waitFor(() => expect(first).toBe(false));
    const b = await w.linearCall(run.capability, "save_comment", COMMENT, { requestId });
    expect(b.body.result).toMatchObject({ status: "SUCCEEDED" });
    release();
    const resolved = await a;
    expect(resolved.body.result).toMatchObject({ status: "SUCCEEDED", replayed: true });
    expect(resolved.body.approvalId).toBeUndefined();
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toEqual([]);
    expect(w.linear.calls.filter((entry) => entry.name === "save_comment")).toHaveLength(1);
  });
});


describe("an agent run on a task someone took over (Plan 5 Task 12a)", () => {
  /** Omar takes the run's task over from Maya. */
  const takeOver = (w: Awaited<ReturnType<typeof world>>, taskId: string) =>
    w.db.set({ ...w.db.get(`DEVTASK#${taskId}`, "META")!, currentOwner: { developerId: OMAR.developerId, name: OMAR.name, provider: "oidc", since: "2026-10-22T11:00:00.000Z" } });

  it("asks the gate for the taker as the run's owner, so a new write approval names them", async () => {
    const w = await world();
    const { gate, seen } = recordingGate(() => ({ decision: "run" }));
    w.configure((base) => ({ ...base, gate }));
    const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")], approvals: { alwaysAsk: ["save_comment"] }, autonomy: "run" });
    takeOver(w, run.taskId);
    const reply = await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "hello" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(seen[0]).toMatchObject({ taskId: run.taskId, owner: { developerId: OMAR.developerId, name: OMAR.name } });
    expect(JSON.stringify(seen[0]!.owner)).not.toContain(MAYA.name);
  });

  it("names the taker in the footer a write carries", async () => {
    const w = await world();
    const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
    takeOver(w, run.taskId);
    await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "Looks like a duplicate" });
    const sent = w.linear.calls.find((entry) => entry.name === "save_comment")!;
    expect(bodyOf(sent)).toContain("Requested by `Omar Diaz` via Rovara agent `triage-bot`");
    expect(bodyOf(sent)).not.toContain("Maya Chen");
  });

  it("goes on after the creator who handed it over was removed", async () => {
    const w = await world();
    const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
    takeOver(w, run.taskId);
    w.removeCreator();
    const reply = await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "hello" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(w.db.get(`DEVTASK#${run.taskId}`, "META")?.outcome).toBeUndefined();
  });

  it("ends the task creator_removed naming the taker when the taker was removed, and calls neither the gate nor the vendor", async () => {
    const w = await world();
    const { gate, seen } = recordingGate(() => ({ decision: "run" }));
    w.configure((base) => ({ ...base, gate }));
    const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
    takeOver(w, run.taskId);
    w.db.delete(orgMemberKey(TEST_ORG, OMAR.developerId));
    w.db.set({ ...orgRemovedKey(TEST_ORG, OMAR.developerId), entityType: "ORG_REMOVED", orgId: TEST_ORG, developerId: OMAR.developerId, removedAt: new Date().toISOString() });
    const refused = await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "hello" });
    expect(refused.status).toBe(403);
    expect(errorOf(refused).code).toBe("TASK_ACCESS_DENIED");
    expect(errorOf(refused).message).toContain("Omar Diaz is no longer a member of");
    expect(w.db.get(`DEVTASK#${run.taskId}`, "META")).toMatchObject({ outcome: "creator_removed" });
    expect(seen).toEqual([]);
    expect(w.linear.calls).toEqual([]);
  });
});

describe("project authority of a run on a task someone took over (Plan 5 Task 12a)", () => {
  const setRole = (w: Awaited<ReturnType<typeof world>>, who: { developerId: string }, role: "member" | "admin") =>
    w.db.set({ ...orgMemberKey(TEST_ORG, who.developerId), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: who.developerId, role, joinedAt: "2026-10-01T00:00:00.000Z" });
  /** The task's principal holds no grant of its own, so authority comes from the owner's org role, read for whoever owns the task now. */
  const ownerByRoleAlone = (w: Awaited<ReturnType<typeof world>>, run: { task: Record<string, unknown> }) =>
    w.db.delete(projectMemberKey(TEST_ORG, String(run.task["ownerKey"]), "payments"));
  const takeOver = (w: Awaited<ReturnType<typeof world>>, taskId: string) =>
    w.db.set({ ...w.db.get(`DEVTASK#${taskId}`, "META")!, currentOwner: { developerId: OMAR.developerId, name: OMAR.name, provider: "oidc", since: "2026-10-22T11:00:00.000Z" } });

  it("lets a tool call through on the taker's org role, though the creator holds none", async () => {
    const w = await world();
    const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
    setRole(w, MAYA, "member");
    setRole(w, OMAR, "admin");
    ownerByRoleAlone(w, run);
    takeOver(w, run.taskId);
    const reply = await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "hello" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  });

  it("refuses a tool call when only the creator who handed the task over holds the role", async () => {
    const w = await world();
    const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
    setRole(w, MAYA, "admin");
    setRole(w, OMAR, "member");
    ownerByRoleAlone(w, run);
    takeOver(w, run.taskId);
    const reply = await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "hello" });
    expect(reply.status).toBe(404);
    expect(w.linear.calls).toEqual([]);
  });
});
