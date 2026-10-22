// Plan 3 Task 19: connector tools for agents. `resolveToolGrants` turns the recipe's grants into the tools one step may use; the two internal routes
// (`GET /v1/internal/agent-tools`, `POST /v1/internal/agent-tools/call`) serve only those, behind the operation's own `agent-tools` capability. A call
// goes through, in order: the creator is still a member (A12), the project authority (A13), the grant is resolved again, the call is prepared
// (`prepareAgentWrite`) and handed to the write gate (Task 21's `decideWrite`; here a stand-in and fakes), and only a `run` decision reaches the vendor.
// The broker is the real one, with a fake Linear MCP server and a fake GitHub MCP connection behind it. No test reaches a real vendor.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { connectMcp, type McpConnection } from "@agentx/gateway";
import { EMPTY_RECIPE, type ResolvedRecipe, type ToolGrant } from "../../packages/contracts/src/agent-recipe.js";
import { recipeDigest } from "../../packages/contracts/src/agent-recipe.js";
import { validateRecipeForOrg } from "../../packages/broker/src/agents/guardrails.js";
import { nonTextFactProblems } from "../../packages/broker/src/agents/write-class.js";
import {
  factsForCall, resolveToolGrants, stepToolPatterns, toolGrantProblems, toolFactsFor, type GrantConnector,
} from "../../packages/broker/src/agents/tool-grants.js";
import {
  AgentToolCallRequestSchema, approvalsNotWiredGate, connectorLabelLister, type AgentToolsDependencies, type AgentWriteGate,
} from "../../packages/broker/src/agents/agent-tools-routes.js";
import { issueCapability } from "../../packages/broker/src/aws/cancellation.js";
import { githubConnectorType } from "../../packages/broker/src/aws/connector-types.js";
import { DEFAULT_AGENT_GUARDRAILS, agentGuardrailsKey, orgMemberKey, orgRemovedKey, projectRevisionKey } from "../../packages/contracts/src/index.js";
import type { ConnectorCatalog, PresentedTool } from "../../packages/contracts/src/connectors.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { CHARTERARC_TEAM_ID, linearViaFake, startFakeLinearMcp } from "../support/fake-linear-mcp.js";
import { treeReader, workflow } from "../support/fake-repository.js";
import { TEST_ORG } from "../support/orgs.js";
import { call, loadSlackBroker, registerSlackProject } from "../support/slack-broker.js";

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
      { path: "tools.0.connector", message: "slack isn't a connector agents can use; name a connector of the project, or pick a type: github, linear, jira, asana or mcp" },
    ]);
    const h = await createDeveloperTaskBroker();
    const recipe: ResolvedRecipe = { ...EMPTY_RECIPE, steps: [{ id: "triage", name: "Triage", kind: "agent", workspace: "none", settings: { instructions: [] } }], tools: [grant({ name: "slack" }, "read_write")] };
    const problems = await validateRecipeForOrg({ documentClient: h.db, tableName: "state" } as never, TEST_ORG, recipe);
    expect(problems).toContainEqual({ path: "tools.0.connector", message: "slack isn't a connector agents can use; name a connector of the project, or pick a type: github, linear, jira, asana or mcp" });
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

describe("stepToolPatterns", () => {
  const step = (tools?: string[]) => ({ id: "s", name: "S", kind: "agent" as const, workspace: "read" as const, settings: { instructions: [], ...(tools === undefined ? {} : { tools }) } });
  it("takes the step's connector tool patterns and leaves out the workspace tools (Pi names)", () => {
    expect(stepToolPatterns(step(["get_*", "read", "grep"]))).toEqual(["get_*"]);
    expect(stepToolPatterns(step(["read", "grep"]))).toBeUndefined();
    expect(stepToolPatterns(step())).toBeUndefined();
    expect(stepToolPatterns(undefined)).toBeUndefined();
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
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The label list of Linear and MCP connectors, read through the connector call path
// ---------------------------------------------------------------------------------------------

describe("connectorLabelLister", () => {
  const labels = JSON.stringify({ labels: [{ id: "5d8a1f0e-3b7c-4e2a-9f10-6c2b8d4e7a91", name: "automerge" }, { id: "x1", name: "Bug" }] });
  it("reads the connector's label tool and maps every id and every name to the name", async () => {
    const run = vi.fn(async (_tool: string, _args: Record<string, unknown>) => labels);
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

interface WorldOptions { workflowFiles?: Record<string, string>; pinnedInstallation?: number }

async function world(options: WorldOptions = {}) {
  const linear = await startFakeLinearMcp();
  const { type: linearType } = linearViaFake(linear);
  const githubCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const githubConnections: Array<{ token: string }> = [];
  const connectGithub = vi.fn(async (input: Parameters<typeof connectMcp>[0]): Promise<McpConnection> => {
    githubConnections.push({ token: input.token });
    return {
      tools: GITHUB_FAKE_TOOLS.filter((candidate) => input.tools === undefined || (input.tools as readonly string[]).includes(candidate.name)),
      call: async (name, args) => { githubCalls.push({ name, arguments: args }); return { content: [{ type: "text", text: JSON.stringify(name === "pull_request_read" ? { number: args.pullNumber } : { number: 7, id: 7 }) }] }; },
      close: async () => undefined,
    };
  });
  const tokens = vi.fn(async (_repository: unknown, _permissions: unknown, _scope: unknown, _options?: unknown) => "agent-installation-token");
  const heads = vi.fn(async (_url: string, number: number, _scope: unknown, _options?: unknown) => {
    if (number === 404) throw Object.assign(new Error(`pull request ${String(number)} doesn't exist`), { name: "AgentXError", code: "CONFIG_INVALID" });
    return { headSha: "a".repeat(40), state: "open" as const };
  });
  const repositories: string[] = [];
  const readerPins: Array<number | undefined> = [];
  const agentRepositoryReader = vi.fn(async (url: string, _scope: unknown, readerOptions?: { installationId?: number }) => { repositories.push(url); readerPins.push(readerOptions?.installationId); return treeReader(options.workflowFiles ?? {}); });
  const secrets = { read: vi.fn(async (name: string) => (name === "agentx/connectors/linear-charterarc" ? JSON.stringify({ apiKey: LINEAR_KEY }) : undefined)) };
  let configure: (base: AgentToolsDependencies) => AgentToolsDependencies = (base) => base;
  const h = await createDeveloperTaskBroker({
    register: false,
    brokerExtra: {
      connectorTypes: { github: githubConnectorType, linear: linearType },
      connectorCredentials: { secrets, githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" } },
      githubMcp: { credentials: vi.fn(async () => ({ owner: "example", repo: "demo", token: "human-token" })), connect: connectGithub },
      githubPullRequests: {
        reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(),
        createAgentInstallationToken: tokens, getAgentPullRequestHead: heads, agentRepositoryReader,
      },
      agents: {},
      agentTools: { configure: (base: AgentToolsDependencies) => configure(base) },
    },
  });
  expect((await call(h.handler, { method: "POST", path: "/v1/admin/credentials", user: ADMIN, body: { ref: "linear-charterarc", type: "static-secret", secretName: "agentx/connectors/linear-charterarc" } })).status).toBe(201);
  await registerSlackProject(h.handler, { connectors: [LINEAR_CONNECTOR, GITHUB_CONNECTOR] });
  if (options.pinnedInstallation !== undefined) {
    const key = projectRevisionKey(TEST_ORG, "payments", 1);
    const record = h.db.get(key) as { definition: { repositories: Array<Record<string, unknown>> } };
    h.db.set({ ...record, definition: { ...record.definition, repositories: record.definition.repositories.map((repository) => ({ ...repository, installationId: options.pinnedInstallation })) } } as never);
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
    h.db.set({ ...orgRemovedKey(TEST_ORG, MAYA.developerId), entityType: "ORG_REMOVED", orgId: TEST_ORG, developerId: MAYA.developerId, removedAt: new Date().toISOString() } as never);
  };
  return {
    ...h, linear, githubCalls, githubConnections, connectGithub, tokens, heads, agentRepositoryReader, repositories, readerPins, secrets,
    startRun, tools, callTool, linearCall, githubCall, schemaHash, removeCreator,
    configure: (next: (base: AgentToolsDependencies) => AgentToolsDependencies) => { configure = next; },
  };
}
type World = Awaited<ReturnType<typeof world>>;
const errorOf = (reply: { body: Record<string, unknown> }) => reply.body.error as { code: string; message: string };
const bodyOf = (call: { arguments: Record<string, unknown> }) => String(call.arguments.body ?? "");

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

  it("an operation of a task with no agent snapshot gets an empty tool list, and cannot call", async () => {
    const w = await world();
    const run = await w.startRun();
    w.db.delete(`DEVTASK#${run.taskId}`, "RECIPE");
    const listed = await w.tools(run.capability);
    expect(listed.status).toBe(200);
    expect(listed.body.catalogs).toEqual([]);
    const called = await w.linearCall(run.capability, "get_issue", { id: "CHA-1" });
    expect(called.status).toBe(404);
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
  it("runs a granted read, and replays the same request id without asking the vendor again", async () => {
    const w = await world();
    const run = await w.startRun();
    const requestId = randomUUID();
    const hash = await w.schemaHash(run.capability, "linear", "get_issue");
    const body = { requestId, connector: "linear", scope: "charterarc", tool: "get_issue", schemaHash: hash, arguments: { id: "CHA-1" } };
    const first = await w.callTool(run.capability, body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.result).toMatchObject({ requestId, status: "SUCCEEDED", replayed: false });
    const afterFirst = w.linear.calls.filter((entry) => entry.name === "get_issue").length;
    expect(afterFirst).toBeGreaterThan(0);
    const second = await w.callTool(run.capability, body);
    expect(second.body.result).toMatchObject({ requestId, status: "SUCCEEDED", replayed: true });
    expect(w.linear.calls.filter((entry) => entry.name === "get_issue")).toHaveLength(afterFirst);
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
    const reply = await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "cc @alice" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(order).toEqual(["creator", "authority", "gate"]);
  });

  it("authorizes through requireProjectAuthority with the task's org, owner and project, and a person who lost the project gets nothing", async () => {
    const w = await world();
    const authority = vi.fn();
    w.configure((base) => ({ ...base, requireProjectAuthority: async (...args) => { authority(...args); return base.requireProjectAuthority(...args); } }));
    const run = await w.startRun();
    expect((await w.linearCall(run.capability, "get_issue", { id: "CHA-1" })).status).toBe(200);
    expect(authority).toHaveBeenCalledWith(TEST_ORG, MAYA.developerId, "payments", expect.anything());
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
    it("is handed the prepared call and the grant, and a run decision sends it to the vendor", async () => {
      const w = await world();
      const { gate, seen } = recordingGate(() => ({ decision: "run" }));
      w.configure((base) => ({ ...base, gate }));
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")], approvals: { alwaysAsk: ["save_comment"] }, autonomy: "act" });
      const reply = await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "cc @alice and @bob" });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(seen).toHaveLength(1);
      const input = seen[0]!;
      expect(input).toMatchObject({
        orgId: TEST_ORG, taskId: run.taskId, project: "payments", connector: "linear", scope: "charterarc",
        tool: { connector: "linear", type: "linear", upstreamName: "save_comment", presentedName: "linear__save_comment", access: "write" },
        args: { issueId: "CHA-1", body: "cc alice and bob" },
        strippedMentions: ["alice", "bob"],
        recipe: { autonomy: "act", allowMentions: false, approvals: { alwaysAsk: ["save_comment"] } },
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
      expect(reply.body.result).toEqual({ requestId, status: "IN_PROGRESS", text: "Waiting for a person to approve this change.", truncated: false, replayed: false });
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
      w.configure((base) => ({ ...base, gate: async () => { throw new Error("boom"); } }));
      expect((await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "hello" })).status).toBe(500);
      w.configure((base) => ({ ...base, gate: (async () => ({ decision: "go-ahead" })) as never }));
      expect((await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "hello" })).status).toBe(500);
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

    it("hands the gate a classification built from live data: the org's guardrails are read on each call", async () => {
      const w = await world();
      const classes: string[] = [];
      w.configure((base) => ({ ...base, gate: async (input) => { classes.push((await input.classify()).class); return { decision: "run" }; } }));
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      const say = () => w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "please shipit now" });
      await say();
      const key = agentGuardrailsKey(TEST_ORG);
      w.db.set({ ...key, entityType: "AGENT_GUARDRAILS", revision: 1, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, extraCommandWords: ["shipit"] } } as never);
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
      const w = await world();
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      const refused = await w.linearCall(run.capability, "save_issue", { id: "CHA-1", title: "Rename it" });
      expect(refused.status).toBe(503);
      expect(errorOf(refused)).toEqual({
        code: "RUNTIME_UNAVAILABLE",
        message: "Changes that need a person's approval aren't available in this release yet, so this call was not sent. Nothing was changed.",
      });
      expect(w.linear.calls).toEqual([]);
    });

    it("refuses a call a project deny rule matches, even a read, with the not-granted text", async () => {
      const w = await world();
      const key = projectRevisionKey(TEST_ORG, "payments", 1);
      const record = w.db.get(key) as { definition: Record<string, unknown> };
      w.db.set({ ...record, definition: { ...record.definition, actionPolicy: { rules: [{ tool: "linear__get_issue", outcome: "deny", reason: "closed to agents" }] } } } as never);
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
    it("records what a create made, so the same run may change it, and nothing else", async () => {
      const w = await world();
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      const created = await w.linearCall(run.capability, "save_issue", { title: "Found a bug" });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      expect(created.body.result).toMatchObject({ status: "SUCCEEDED" });
      const own = await w.linearCall(run.capability, "save_issue", { id: "CHA-2", title: "Found a worse bug" });
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      const foreign = await w.linearCall(run.capability, "save_issue", { id: "CHA-1", title: "Rename it" });
      expect(foreign.status).toBe(503);
      expect(w.db.find((item) => item.entityType === "AGENT_ITEM").map((item) => item.sk)).toEqual(["linear##CHA-2"]);
    });
  });

  describe("attribution", () => {
    it("adds a footer naming the person and the agent to the long text of a write", async () => {
      const w = await world();
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      await w.linearCall(run.capability, "save_comment", { issueId: "CHA-1", body: "Looks like a duplicate" });
      const sent = w.linear.calls.find((entry) => entry.name === "save_comment")!;
      expect(bodyOf(sent)).toContain("Looks like a duplicate");
      expect(bodyOf(sent)).toContain("Requested by Maya Chen via Rovara agent triage-bot");
    });
  });

  describe("label ids", () => {
    it("resolves an id given in addLabels through the connector's label list, and a trigger label makes the call wait", async () => {
      const w = await world();
      const UUID = "5d8a1f0e-3b7c-4e2a-9f10-6c2b8d4e7a91";
      w.configure((base) => ({ ...base, labelListers: () => ({ linear: async () => new Map([[UUID, "automerge"], ["rovara", "rovara"]]) }) }));
      const run = await w.startRun({ tools: [grant({ type: "linear" }, "read_write")] });
      const created = await w.linearCall(run.capability, "save_issue", { title: "x", addLabels: [UUID] });
      expect(created.status).toBe(503);
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
    const before = w.tokens.mock.calls.length;
    const reply = await w.githubCall(run.capability, "add_issue_comment", { owner: "other", repo: "secret", issue_number: 3, body: "hi" });
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

  it("makes a comment wait when the repository has workflows that react to comments, and sends nothing", async () => {
    const w = await world({ workflowFiles: { ".github/workflows/triage.yml": workflow("issue_comment", "./scripts/triage.sh"), "scripts/triage.sh": "echo triage" } });
    const run = await w.startRun({ tools: [grant({ type: "github" }, "read_write")] });
    const reply = await w.githubCall(run.capability, "add_issue_comment", { issue_number: 3, body: "hello" });
    expect(reply.status).toBe(503);
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
