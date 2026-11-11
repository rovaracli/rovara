// Plan 4 Task 17: the GitHub Actions connector. It reads workflow runs, their jobs and logs, and deployments of the project's repositories, in the broker, with
// the project's GitHub App. There is no connection: each call mints Plan 3's agent installation token for ONE repository with exactly the permissions of that
// tool (`actions: read` or `deployments: read`, plus `metadata: read`), after the org's installation binding is checked. `get_job_log` follows GitHub's one
// redirect to its log storage, to GitHub's own storage hosts only, with no Authorization header on the second request. GitHub is faked; no test reaches a network.
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverTools, executeTool, type Ledger } from "@agentx/gateway";
import { agentXError, githubNotConnectedMessage, type GrantedTool, type OrgId } from "@rovara-code/contracts";
import { ProjectDefinitionSchema } from "@agentx/cloud-contracts";
import { GITHUB_ACTIONS_AGENT_TOOL_PERMISSIONS, githubActionsToolPermissions } from "../../packages/broker/src/agents/github-agent-tools.js";
import { classifyWrite } from "../../packages/broker/src/agents/write-class.js";
import { BUILT_IN_CONNECTOR_TYPES, resolveConnectors, type ResolvedConnector } from "../../packages/broker/src/aws/connector-types.js";
import { githubActionsConnectorType } from "../../packages/broker/src/aws/github-actions-connector-type.js";
import { PROJECT_CONNECTOR_TOOLS } from "../../packages/broker/src/connections/project-connectors.js";
import type * as VendorFetchModule from "../../packages/broker/src/connectors/native/vendor-fetch.js";
import { GITHUB_ACTIONS_TOOLS, GITHUB_ACTIONS_TOOL_NAMES, isLogStorageUrl, logDownloader, mintActionsToken, type GitHubActionsEngineScope } from "../../packages/broker/src/connectors/native/github-actions.js";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";
import { routeFetch } from "../support/developer-fakes.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { FAKE_GITHUB_REPOSITORIES, FAKE_GITHUB_STORAGE_HOST, fakeGitHubActions, type FakeGitHubActionsOptions } from "../support/fake-vendor-apis.js";

// The real `safeVendorFetch`, watched: a deployment (no `nativeFetch`) must get the one that hands a redirect back.
const watched = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("../../packages/broker/src/connectors/native/vendor-fetch.js", async (importOriginal) => {
  const original = await importOriginal<typeof VendorFetchModule>();
  return { ...original, safeVendorFetch: (options?: Parameters<typeof original.safeVendorFetch>[0]) => { watched.calls.push(options); return original.safeVendorFetch(options); } };
});

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const TOOLS = ["list_workflow_runs", "get_workflow_execution", "list_execution_jobs", "get_job_log", "list_deployments", "list_deployment_statuses"] as const;
const REPOSITORY = (name: string, extra: Record<string, unknown> = {}) => ({
  name, url: `https://github.com/example/${name}.git`, path: `repo/${name}`, defaultBranch: "main", credentialRef: "github-app", ...extra,
});

let privateKey = "";
beforeAll(() => { privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(); });
// A tool reaches GitHub only through the fetch it is given; the global one fails the test.
beforeEach(() => { vi.stubGlobal("fetch", () => { throw new Error("test: the global fetch was used; the connector uses only the fetch it is given"); }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const project = (connectors: unknown[], repositories: unknown[] = [
  REPOSITORY("demo", { installationId: 55, githubRepositoryId: FAKE_GITHUB_REPOSITORIES.demo }),
  REPOSITORY("legacy"),
  REPOSITORY("other", { installationId: 55, githubRepositoryId: FAKE_GITHUB_REPOSITORIES.other }),
]) => ProjectDefinitionSchema.parse({
  name: "payments", revision: 1, repositories, setup: [], readiness: [], orchestratorInstructions: "x", integrations: { connectors },
});
const connectorConfig = (over: Record<string, unknown> = {}) => ({ name: "gha", type: "github-actions", scopes: "all-repositories", tools: TOOLS.map((name) => ({ name, access: "read" })), ...over });

interface WorldOptions { fake?: FakeGitHubActionsOptions; bound?: ConstructorParameters<typeof GitHubAppCredentialProvider>[0]["requireInstallationBound"]; orgId?: OrgId | undefined; definition?: ReturnType<typeof project> }

async function world(options: WorldOptions = {}) {
  const fake = fakeGitHubActions(options.fake);
  const net = routeFetch(fake.handler);
  const provider = new GitHubAppCredentialProvider({
    credentialRef: "github-app", appId: "123", getPrivateKey: async () => privateKey, fetchImplementation: net,
    ...(options.bound === undefined ? {} : { requireInstallationBound: options.bound }),
  });
  const orgId = "orgId" in options ? options.orgId : ORG_A;
  const context = { githubAgentTokens: provider, nativeFetch: net, ...(orgId === undefined ? {} : { orgId }) };
  const [connector] = resolveConnectors(options.definition ?? project([connectorConfig()]), context, { "github-actions": githubActionsConnectorType });
  return { fake, net, provider, context, connector: connector as ResolvedConnector<GitHubActionsEngineScope> };
}
type World = Awaited<ReturnType<typeof world>>;

const scopeOf = (w: World, alias: string) => w.connector.scopes.find((entry) => entry.alias === alias)!.scope;
const contextOf = (w: World, alias: string) => ({
  workspaceId: "ws", ownerKey: "owner", scopeAlias: alias, scope: scopeOf(w, alias), settingsRevision: 1,
  policy: { tools: TOOLS.map((name) => ({ name, access: "read" as const })) },
});
const ledger: Ledger = { claim: async () => true, get: async () => undefined, finish: async () => undefined };

async function definitionOf(w: World) {
  const definition = await w.connector.definition();
  if ("notConnected" in definition) throw new Error(`not connected: ${definition.notConnected}`);
  return definition;
}

async function run(w: World, tool: string, args: Record<string, unknown> = {}, alias = "demo") {
  const definition = await definitionOf(w);
  const discovered = (await discoverTools(definition, contextOf(w, alias), { connect: w.connector.connect! })).tools.find((entry) => entry.name === tool)!;
  return executeTool(
    { requestId: "11111111-1111-4111-8111-111111111111", scope: alias, tool, schemaHash: discovered.schemaHash, arguments: args },
    definition, contextOf(w, alias), { connect: w.connector.connect!, ledger },
  );
}
const apiCalls = (w: World) => w.fake.requests.filter((request) => request.url.includes("/actions/") || request.url.includes("/deployments"));

describe("the GitHub Actions connector type", () => {
  it("is built in, named github-actions, with no credential, and one scope per repository that has a pinned GitHub id", async () => {
    const w = await world();
    expect(BUILT_IN_CONNECTOR_TYPES["github-actions"]).toBe(githubActionsConnectorType);
    expect(w.connector).toMatchObject({
      name: "gha", type: "github-actions", label: "GitHub Actions", vendor: "GitHub", scopeNoun: "repository", attribution: false,
      ledger: { prefix: "CONNECTOR#gha#", entityType: "CONNECTOR_INVOCATION" },
    });
    expect(w.connector).not.toHaveProperty("credential");
    // `legacy` has no `githubRepositoryId`, so it is not offered.
    expect(w.connector.scopes.map((entry) => entry.alias)).toEqual(["demo", "other"]);
    expect(w.connector.scopes[0]).toMatchObject({ alias: "demo", scope: { alias: "demo", repository: { name: "demo", githubRepositoryId: 4242 } } });
  });

  it("holds a connector that lists repositories to those, and offers a listed repository only when it has a pinned GitHub id", async () => {
    const some = await world({ definition: project([connectorConfig({ scopes: ["other", "legacy"] })]) });
    expect(some.connector.scopes.map((entry) => entry.alias)).toEqual(["other"]);
    const none = await world({ definition: project([connectorConfig({ scopes: ["legacy"] })]) });
    expect(none.connector.scopes).toEqual([]);
    const badUrl = await world({ definition: project([connectorConfig()], [REPOSITORY("demo", { githubRepositoryId: 1, url: "https://gitlab.com/example/demo.git" })]) });
    expect(badUrl.connector.scopes).toEqual([]);
  });

  it("treats a malformed stored entry as unusable and never throws", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const reasons = () => log.mock.calls.map(([line]) => JSON.parse(String(line)) as { reason?: string }).flatMap((line) => (line.reason === undefined ? [] : [line.reason]));
    const stored = (entry: unknown) => ({ ...project([connectorConfig()]), integrations: { connectors: [entry] } }) as never;
    expect(resolveConnectors(stored(connectorConfig({ credentialRef: "con_aaaaaaaaaaaaaaaaaaaa" })), {}, { "github-actions": githubActionsConnectorType })).toEqual([]);
    expect(resolveConnectors(stored(connectorConfig({ scopes: [] })), {}, { "github-actions": githubActionsConnectorType })).toEqual([]);
    expect(reasons()).toEqual(["invalid github-actions connector configuration: entry", "invalid github-actions connector configuration: scopes"]);
  });

  it("lists exactly the six tools a project may approve, no item argument, no label argument, served from api.github.com", async () => {
    expect(PROJECT_CONNECTOR_TOOLS["github-actions"]).toEqual([...TOOLS]);
    expect(GITHUB_ACTIONS_TOOL_NAMES).toEqual([...TOOLS]);
    expect(Object.keys(GITHUB_ACTIONS_AGENT_TOOL_PERMISSIONS).sort()).toEqual([...TOOLS].sort());
    const definition = await definitionOf(await world());
    expect(definition.endpoint.href).toBe("https://api.github.com/");
    expect(definition.itemArguments).toEqual([]);
    expect(definition).not.toHaveProperty("labelArgument");
  });

  it("is not connected without the deployment's agent tokens or without an org, and says so in fixed words", async () => {
    const w = await world();
    const bare = (context: object) => resolveConnectors(project([connectorConfig()]), context, { "github-actions": githubActionsConnectorType })[0]!;
    expect(await bare({ orgId: ORG_A }).configured()).toBe(false);
    expect(await bare({ orgId: ORG_A }).definition()).toEqual({ notConnected: "GitHub is not configured in this deployment" });
    expect(await bare({ githubAgentTokens: w.provider }).configured()).toBe(false);
    expect(await bare({ githubAgentTokens: w.provider }).definition()).toEqual({ notConnected: "GitHub Actions connectors need an organization" });
    expect(await bare({ githubAgentTokens: w.provider, orgId: ORG_A }).configured()).toBe(true);
  });
});

describe("what the model is offered", () => {
  it("marks every tool read with the read-only hints and hides every server-bound value", async () => {
    const w = await world();
    const { tools, skipped } = await discoverTools(await definitionOf(w), contextOf(w, "demo"), { connect: w.connector.connect! });
    expect(skipped).toEqual([]);
    expect(tools.map((tool) => tool.name)).toEqual([...TOOLS]);
    for (const tool of tools) {
      expect(tool.access, tool.name).toBe("read");
      expect(tool.hints, tool.name).toEqual({ readOnlyHint: true, destructiveHint: false });
      const names = Object.keys(tool.inputSchema["properties"] as object);
      for (const hidden of ["scopeAlias", "owner", "repo", "repositoryId", "installationId", "repository"]) expect(names, tool.name).not.toContain(hidden);
    }
    const props = (name: string) => (tools.find((tool) => tool.name === name)!.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props("list_workflow_runs")["status"]).toMatchObject({ enum: ["completed", "in_progress", "failure", "success"] });
    expect(props("list_workflow_runs")["limit"]).toMatchObject({ type: "integer", minimum: 1, maximum: 20 });
    expect(props("list_workflow_runs")["branch"]).toMatchObject({ type: "string" });
    expect(props("get_workflow_execution")["workflowRunId"]).toMatchObject({ type: "integer" });
    expect(props("list_execution_jobs")["workflowRunId"]).toMatchObject({ type: "integer" });
    expect(props("get_job_log")["jobId"]).toMatchObject({ type: "integer" });
    expect(props("get_job_log")["tailLines"]).toMatchObject({ type: "integer", minimum: 50, maximum: 2000 });
    expect(props("list_deployments")["environment"]).toMatchObject({ type: "string" });
    expect(props("list_deployments")["limit"]).toMatchObject({ minimum: 1, maximum: 20 });
    expect(props("list_deployment_statuses")["deploymentId"]).toMatchObject({ type: "integer" });
  });

  it("is read for Plan 3's write classification", async () => {
    const w = await world();
    const { tools } = await discoverTools(await definitionOf(w), contextOf(w, "demo"), { connect: w.connector.connect! });
    for (const tool of tools) {
      const granted: GrantedTool = {
        connector: "gha", type: "github-actions", upstreamName: tool.name, presentedName: `gha__${tool.name}`, access: tool.access,
        facts: { connector: "gha", upstreamName: tool.name, access: tool.access, ...(tool.hints === undefined ? {} : { hints: tool.hints }) },
      };
      expect(classifyWrite({ tool: granted, args: { workflowRunId: 9001 }, rules: { alwaysAsk: [] }, autonomy: "run", allowMentions: false, ownItems: new Set<string>() }).class, tool.name).toBe("read");
    }
  });
});

describe("the token each call mints (R63)", () => {
  it("is for exactly one repository with exactly the tool's permissions plus metadata read", async () => {
    const w = await world();
    const args: Record<string, Record<string, unknown>> = {
      list_workflow_runs: {}, get_workflow_execution: { workflowRunId: 9001 }, list_execution_jobs: { workflowRunId: 9001 }, get_job_log: { jobId: 7001 },
      list_deployments: {}, list_deployment_statuses: { deploymentId: 5001 },
    };
    const expected: Record<string, Record<string, string>> = {
      list_workflow_runs: { actions: "read", metadata: "read" }, get_workflow_execution: { actions: "read", metadata: "read" },
      list_execution_jobs: { actions: "read", metadata: "read" }, get_job_log: { actions: "read", metadata: "read" },
      list_deployments: { deployments: "read", metadata: "read" }, list_deployment_statuses: { deployments: "read", metadata: "read" },
    };
    for (const tool of TOOLS) {
      const before = w.fake.minted().length;
      const result = await run(w, tool, args[tool]);
      expect(result.status, `${tool}: ${result.text}`).toBe("SUCCEEDED");
      const mints = w.fake.minted().slice(before);
      expect(mints.map((request) => request.body), tool).toEqual([{ repositories: ["demo"], permissions: expected[tool] }]);
    }
  });

  it("mints a fresh token for every call and sends it as that call's bearer, never one for another tool", async () => {
    const w = await world();
    await run(w, "list_workflow_runs");
    await run(w, "list_deployments");
    expect(w.fake.tokens).toEqual(["ghs_fake1_actions_metadata", "ghs_fake2_deployments_metadata"]);
    const [runs, deployments] = apiCalls(w);
    expect(runs).toMatchObject({ method: "GET", authorization: "Bearer ghs_fake1_actions_metadata" });
    expect(deployments).toMatchObject({ method: "GET", authorization: "Bearer ghs_fake2_deployments_metadata" });
  });

  it("is minted for the scope's repository, and for no other repository the model could name", async () => {
    const w = await world();
    await run(w, "list_workflow_runs", {}, "other");
    expect(w.fake.minted().map((request) => request.body)).toEqual([{ repositories: ["other"], permissions: { actions: "read", metadata: "read" } }]);
    expect(apiCalls(w).map((request) => new URL(request.url).pathname)).toEqual(["/repos/example/other/actions/runs"]);
    // A model that sets a routing value itself is refused by the engine before anything is minted.
    const before = w.fake.minted().length;
    await expect(run(w, "list_workflow_runs", { repo: "demo" })).rejects.toThrow("routing arguments are server controlled");
    expect(w.fake.minted()).toHaveLength(before);
  });

  it("goes through the org's installation binding, for the caller's org, before the token", async () => {
    const bound = vi.fn(async () => undefined);
    const w = await world({ bound });
    await run(w, "list_workflow_runs");
    expect(bound).toHaveBeenCalledWith(ORG_A, 55, { owner: "example", name: "demo" });
    expect(w.fake.requests.map((request) => new URL(request.url).pathname).slice(0, 2)).toEqual(["/repos/example/demo/installation", "/app/installations/55/access_tokens"]);
  });

  it("reads as not connected, and mints nothing, for an installation bound to another org (Review Focus 6)", async () => {
    const bound = async (orgId: OrgId) => { if (orgId !== ORG_A) throw agentXError("GITHUB_NOT_CONNECTED", githubNotConnectedMessage("example/demo")); };
    const w = await world({ bound, orgId: ORG_B });
    const result = await run(w, "list_workflow_runs");
    expect(result).toMatchObject({ status: "FAILED", reason: "not_connected" });
    expect(result.text).toContain(githubNotConnectedMessage("example/demo"));
    expect(w.fake.minted()).toEqual([]);
    expect(apiCalls(w)).toEqual([]);
    // The org it is bound to still works.
    const ok = await world({ bound });
    expect((await run(ok, "list_workflow_runs")).status).toBe("SUCCEEDED");
  });

  it("mints nothing for a repository the project registered under another installation", async () => {
    const w = await world({ definition: project([connectorConfig()], [REPOSITORY("demo", { installationId: 99, githubRepositoryId: FAKE_GITHUB_REPOSITORIES.demo })]) });
    const result = await run(w, "list_workflow_runs");
    expect(result).toMatchObject({ status: "FAILED", reason: "not_connected" });
    expect(result.text).toContain(githubNotConnectedMessage("example/demo"));
    expect(w.fake.minted()).toEqual([]);
  });

  it("says GitHub could not issue a token, in fixed words, when minting fails for any other reason", async () => {
    const w = await world();
    const failing = { ...w.context, githubAgentTokens: { createAgentInstallationToken: async () => { throw new Error("boom ghs_SECRETTOKEN and https://api.github.com"); } } };
    const [connector] = resolveConnectors(project([connectorConfig()]), failing, { "github-actions": githubActionsConnectorType });
    const failed = { ...w, connector: connector as typeof w.connector };
    const result = await run(failed, "list_workflow_runs");
    expect(result).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "GitHub could not issue a token for this repository; try again later" });
  });

  it("is not available for a tool the permission map does not list, and asks GitHub for nothing", async () => {
    const tokens = { createAgentInstallationToken: vi.fn(async () => "ghs_never") };
    const scope = { alias: "demo", owner: "example", repo: "demo", repositoryId: 4242, installationId: undefined };
    await expect(mintActionsToken({ tokens, orgId: ORG_A, tool: "cancel_workflow_run", scope })).rejects.toMatchObject({ name: "NativeToolRefusal", reason: "policy_denied" });
    await expect(mintActionsToken({ tokens, orgId: ORG_A, tool: "list_workflow_runs", scope, catalog: {} })).rejects.toMatchObject({ name: "NativeToolRefusal" });
    await expect(mintActionsToken({ tokens, orgId: ORG_A, tool: "constructor", scope })).rejects.toMatchObject({ name: "NativeToolRefusal" });
    expect(tokens.createAgentInstallationToken).not.toHaveBeenCalled();
    await expect(mintActionsToken({ tokens, orgId: ORG_A, tool: "list_workflow_runs", scope })).resolves.toBe("ghs_never");
    expect(tokens.createAgentInstallationToken).toHaveBeenCalledWith({ owner: "example", name: "demo" }, { actions: "read", metadata: "read" }, { orgId: ORG_A }, {});
    await mintActionsToken({ tokens, orgId: ORG_A, tool: "list_deployments", scope: { ...scope, installationId: 55 } });
    expect(tokens.createAgentInstallationToken).toHaveBeenLastCalledWith({ owner: "example", name: "demo" }, { deployments: "read", metadata: "read" }, { orgId: ORG_A }, { installationId: 55 });
  });

  it("has a permission map that is read only by type, frozen, and refuses what it does not list", () => {
    expect(GITHUB_ACTIONS_AGENT_TOOL_PERMISSIONS).toEqual({
      list_workflow_runs: { actions: "read" }, get_workflow_execution: { actions: "read" }, list_execution_jobs: { actions: "read" }, get_job_log: { actions: "read" },
      list_deployments: { deployments: "read" }, list_deployment_statuses: { deployments: "read" },
    });
    expect(Object.isFrozen(GITHUB_ACTIONS_AGENT_TOOL_PERMISSIONS)).toBe(true);
    for (const permissions of Object.values(GITHUB_ACTIONS_AGENT_TOOL_PERMISSIONS)) expect(Object.isFrozen(permissions)).toBe(true);
    expect(githubActionsToolPermissions("list_deployments")).toEqual({ deployments: "read", metadata: "read" });
    for (const tool of ["cancel_workflow_run", "rerun_workflow", "get_secret", "", "LIST_WORKFLOW_RUNS", "constructor", "__proto__"]) {
      expect(() => githubActionsToolPermissions(tool), tool).toThrow(expect.objectContaining({ code: "AGENT_TOOL_NOT_GRANTED" }) as Error);
    }
    expect(() => githubActionsToolPermissions("list_workflow_runs", {})).toThrow(expect.objectContaining({ code: "AGENT_TOOL_NOT_GRANTED" }) as Error);
  });
});

describe("no write, anywhere", () => {
  it("offers no tool that is not a read, and makes no request other than a GET (and the two App calls)", async () => {
    const w = await world();
    for (const tool of GITHUB_ACTIONS_TOOLS) expect(tool.inputSchema["additionalProperties"], tool.name).toBe(false);
    for (const [tool, args] of [["list_workflow_runs", {}], ["get_workflow_execution", { workflowRunId: 9001 }], ["list_execution_jobs", { workflowRunId: 9001 }], ["get_job_log", { jobId: 7001 }], ["list_deployments", {}], ["list_deployment_statuses", { deploymentId: 5001 }]] as const) {
      expect((await run(w, tool, args)).status, tool).toBe("SUCCEEDED");
    }
    const writes = w.fake.requests.filter((request) => request.method !== "GET" && !request.url.endsWith("/access_tokens"));
    expect(writes).toEqual([]);
    // The tokens were minted for reads of one repository each.
    for (const request of w.fake.minted()) {
      const permissions = (request.body as { permissions: Record<string, string> }).permissions;
      expect(Object.values(permissions).every((level) => level === "read")).toBe(true);
    }
  });

  it("refuses a call to a tool that is not one of the six, and one that was not approved", async () => {
    const w = await world({ definition: project([connectorConfig({ tools: [{ name: "list_workflow_runs", access: "read" }] })]) });
    const definition = await definitionOf(w);
    const { tools } = await discoverTools(definition, { ...contextOf(w, "demo"), policy: { tools: [{ name: "list_workflow_runs", access: "read" }] } }, { connect: w.connector.connect! });
    expect(tools.map((tool) => tool.name)).toEqual(["list_workflow_runs"]);
    const connection = await w.connector.connect!({ endpoint: definition.endpoint, token: "x", tools: ["list_workflow_runs", "cancel_workflow_run"] } as never);
    expect(connection.tools.map((tool) => tool.name)).toEqual(["list_workflow_runs"]);
    await expect(connection.call("cancel_workflow_run", {})).rejects.toThrow("MCP tool not allowed or unavailable");
    await expect(connection.call("get_job_log", {})).rejects.toThrow("MCP tool not allowed or unavailable");
    expect(w.fake.requests).toEqual([]);
  });
});

describe("list_workflow_runs", () => {
  it("lists the repository's runs with their state, branch and commit, and leaves the other repository's out", async () => {
    const w = await world();
    const result = await run(w, "list_workflow_runs", { limit: 5 });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text).toContain("9001");
    expect(result.text).toContain("Fix checkout");
    expect(result.text).toContain("failure");
    expect(result.text).toContain("main");
    expect(result.text).toContain("in_progress");
    expect(result.text).toContain("aaaaaaa");
    expect(result.text).not.toContain("9101");
    const url = new URL(apiCalls(w)[0]!.url);
    expect(url.pathname).toBe("/repos/example/demo/actions/runs");
    expect(url.searchParams.get("per_page")).toBe("5");
  });

  it("passes the status and branch filters on, and holds the answer to the repository even when GitHub's list leaks", async () => {
    const w = await world({ fake: { leak: true } });
    const failed = await run(w, "list_workflow_runs", { status: "failure", branch: "main" });
    const url = new URL(apiCalls(w)[0]!.url);
    expect(url.searchParams.get("status")).toBe("failure");
    expect(url.searchParams.get("branch")).toBe("main");
    expect(failed.text).toContain("9001");
    expect(failed.text).not.toContain("9101");
    const all = await run(w, "list_workflow_runs", {});
    expect(all.text).not.toContain("9101");
    expect(all.text).not.toContain("Other repository secret work");
  });

  it("holds the answer to the status, branch and limit asked for, even when GitHub ignores them", async () => {
    const w = await world({ fake: { ignoreFilters: true } });
    const ids = (text: string) => text.split("\n").filter((line) => /^\d+ \[/u.test(line)).map((line) => line.split(" ")[0]);
    expect(ids((await run(w, "list_workflow_runs", { status: "failure" })).text)).toEqual(["9001"]);
    expect(ids((await run(w, "list_workflow_runs", { status: "in_progress" })).text)).toEqual(["9002"]);
    expect(ids((await run(w, "list_workflow_runs", { status: "completed" })).text)).toEqual(["9001", "9003"]);
    expect(ids((await run(w, "list_workflow_runs", { branch: "feature" })).text)).toEqual(["9002"]);
    expect(ids((await run(w, "list_workflow_runs", { limit: 1 })).text)).toEqual(["9001"]);
    expect(ids((await run(w, "list_workflow_runs", {})).text)).toEqual(["9001", "9002", "9003"]);
  });

  it("defaults to ten runs, and says when there are none", async () => {
    const w = await world();
    await run(w, "list_workflow_runs", {});
    expect(new URL(apiCalls(w)[0]!.url).searchParams.get("per_page")).toBe("10");
    const none = await run(w, "list_workflow_runs", { branch: "no-such-branch" });
    expect(none.text).toBe("No workflow runs in demo.");
  });

  it("refuses a limit or a status outside the schema before minting anything", async () => {
    const w = await world();
    const before = w.fake.minted().length;
    for (const args of [{ limit: 21 }, { limit: 0 }, { status: "cancelled" }, { branch: 5 }, { extra: 1 }]) {
      expect(await run(w, "list_workflow_runs", args), JSON.stringify(args)).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    }
    const direct = await (await w.connector.connect!({ endpoint: new URL("https://api.github.com/"), token: "x", tools: ["list_workflow_runs"] } as never)).call("list_workflow_runs", { scopeAlias: "demo", owner: "example", repo: "demo", repositoryId: "4242", installationId: "", limit: 21 });
    expect(direct).toMatchObject({ isError: true, content: [{ text: "list_workflow_runs: limit is not allowed" }] });
    expect(w.fake.minted()).toHaveLength(before);
  });
});

describe("get_workflow_execution and list_execution_jobs", () => {
  it("shows one run, and refuses a run of another repository even when GitHub answers for it", async () => {
    const w = await world({ fake: { leak: true } });
    const one = await run(w, "get_workflow_execution", { workflowRunId: 9001 });
    expect(one.status).toBe("SUCCEEDED");
    expect(one.text).toContain("Fix checkout");
    expect(one.text).toContain("failure");
    expect(one.text).toContain("dana");
    expect(new URL(apiCalls(w)[0]!.url).pathname).toBe("/repos/example/demo/actions/runs/9001");
    const other = await run(w, "get_workflow_execution", { workflowRunId: 9101 });
    expect(other).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "that workflow run is not in demo" });
    expect(other.text).not.toContain("Other repository");
  });

  it("refuses a run GitHub answers with when it is not the one asked for", async () => {
    const w = await world({ fake: { wrongItem: true } });
    expect(await run(w, "get_workflow_execution", { workflowRunId: 9001 })).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "that workflow run is not in demo" });
  });

  it("answers an unknown run in fixed words", async () => {
    const w = await world();
    expect(await run(w, "get_workflow_execution", { workflowRunId: 4 })).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "GitHub has no such workflow run in demo" });
  });

  it("lists a run's jobs with their steps, and only the jobs that belong to that run of this repository", async () => {
    const w = await world({ fake: { leak: true } });
    const result = await run(w, "list_execution_jobs", { workflowRunId: 9001 });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text).toContain("7001");
    expect(result.text).toContain("build");
    expect(result.text).toContain("npm test");
    expect(result.text).toContain("lint");
    expect(result.text).not.toContain("other-repo-job");
    expect(result.text).not.toContain("another-run-job");
    expect(result.text).not.toContain("wrong-run-id-job");
    expect(result.text).not.toContain("wrong-run-url-job");
    const url = new URL(apiCalls(w)[0]!.url);
    expect(url.pathname).toBe("/repos/example/demo/actions/runs/9001/jobs");
    expect(url.searchParams.get("filter")).toBe("latest");
  });
});

describe("how much of a run's jobs is shown", () => {
  it("shows at most thirty jobs, and twenty-five steps of each", async () => {
    const w = await world({ fake: { jobCount: 40, stepCount: 40 } });
    const text = (await run(w, "list_execution_jobs", { workflowRunId: 9001 })).text;
    expect(text).toContain("30 jobs of workflow run 9001");
    expect(text.split("\n").filter((line) => /^\d{4} \[/u.test(line))).toHaveLength(30);
    expect(text.split("\n").filter((line) => /^ {2}\d+\. /u.test(line))).toHaveLength(25);
    expect(text).toContain("25. step 25");
    expect(text).not.toContain("26. step 26");
  });
});

describe("get_job_log", () => {
  const callLog = (w: World, args: Record<string, unknown> = { jobId: 7001 }) => run(w, "get_job_log", args);

  it("follows GitHub's redirect once, to its log storage, with no Authorization on the second request, and returns the end of the log", async () => {
    const w = await world();
    const result = await callLog(w, { jobId: 7001, tailLines: 100 });
    expect(result.status, result.text).toBe("SUCCEEDED");
    expect(apiCalls(w)).toHaveLength(1);
    const first = apiCalls(w)[0]!;
    const second = w.fake.requests.find((request) => request.url.includes(FAKE_GITHUB_STORAGE_HOST))!;
    expect(first).toMatchObject({ method: "GET", authorization: "Bearer ghs_fake1_actions_metadata" });
    expect(new URL(first.url).pathname).toBe("/repos/example/demo/actions/jobs/7001/logs");
    expect(new URL(second.url).hostname).toBe(FAKE_GITHUB_STORAGE_HOST);
    expect(second.authorization).toBeUndefined();
    expect(w.fake.requests.filter((request) => request.url.includes(FAKE_GITHUB_STORAGE_HOST))).toHaveLength(1);
    const lines = result.text.split("\n").filter((line) => line.includes("of the log"));
    expect(lines).toHaveLength(100);
    expect(lines[0]).toContain("line 201 of the log");
    expect(lines.at(-1)).toContain("line 300 of the log");
    expect(result.text).not.toContain("line 200 of the log");
  });

  it("returns 200 lines by default, and as many as asked up to 2000", async () => {
    const w = await world();
    const lines = (text: string) => text.split("\n").filter((line) => line.includes("of the log"));
    expect(lines((await callLog(w)).text)).toHaveLength(200);
    expect(lines((await callLog(w, { jobId: 7001, tailLines: 2000 })).text)).toHaveLength(300);
    expect(lines((await callLog(w, { jobId: 7001, tailLines: 50 })).text)).toHaveLength(50);
    expect(await callLog(w, { jobId: 7001, tailLines: 49 })).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    expect(await callLog(w, { jobId: 7001, tailLines: 2001 })).toMatchObject({ status: "FAILED", reason: "policy_denied" });
  });

  it.each([
    ["another host", "https://example.com/log"],
    ["a lookalike that only ends the same", "https://evilactions.githubusercontent.com/log"],
    ["a host that only starts like one", "https://pipelines.actions.githubusercontent.com.evil.example/log"],
    ["the bare domain", "https://actions.githubusercontent.com/log"],
    ["the bare blob domain", "https://blob.core.windows.net/log"],
    ["a blob lookalike", "https://x.blob.core.windows.net.evil.example/log"],
    ["plain http", `http://${FAKE_GITHUB_STORAGE_HOST}/log`],
    ["a login in the address", `https://user:pass@${FAKE_GITHUB_STORAGE_HOST}/log`],
    ["another port", `https://${FAKE_GITHUB_STORAGE_HOST}:8443/log`],
    ["an address", "https://203.0.113.9/log"],
    ["GitHub's own API host", "https://api.github.com/repos/example/other/actions/jobs/1/logs"],
    ["a relative address", "/log"],
    ["nothing a URL can be", "not a url at all"],
  ])("refuses a redirect to %s, and makes no request to it", async (_name, location) => {
    const w = await world({ fake: { logRedirect: location } });
    const result = await callLog(w);
    expect(result).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "GitHub sent the log somewhere other than its log storage; it was not fetched" });
    expect(w.net.calls.filter((call) => !call.includes("api.github.com"))).toEqual([]);
  });

  it.each([301, 303, 307, 308])("reads a %i redirect the same way", async (status) => {
    const w = await world({ fake: { logRedirectStatus: status } });
    expect((await callLog(w)).status).toBe("SUCCEEDED");
  });

  it("refuses an answer that is neither a redirect nor an error, such as a 204, in fixed words", async () => {
    const w = await world({ fake: { logRedirectStatus: 204 } });
    expect(await callLog(w)).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "GitHub answered HTTP 204" });
  });

  it("refuses a log bigger than eight mebibytes through the tool, and reads one just under it", async () => {
    const big = await world({ fake: { logText: "x".repeat(8 * 1_048_576 + 1) } });
    expect(await callLog(big)).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "the vendor answered with more than a connector reads" });
    const fits = await world({ fake: { logText: `${"x".repeat(100)}\n${"y".repeat(8 * 1_048_576 - 200)}` } });
    expect((await callLog(fits)).status).toBe("SUCCEEDED");
  });

  it("says so when the storage answers with an error, and when the log is empty", async () => {
    const empty = await world({ fake: { logText: "" } });
    expect((await callLog(empty)).text).toBe("The log of job 7001 in demo is empty.");
    const quiet = logDownloader((async () => new Response("denied", { status: 403 })));
    await expect(quiet(`https://${FAKE_GITHUB_STORAGE_HOST}/log`)).rejects.toMatchObject({ name: "NativeToolRefusal", message: "GitHub's log storage answered HTTP 403", reason: "vendor_error" });
  });

  it("accepts GitHub's two storage hosts and nothing else", () => {
    for (const ok of [`https://${FAKE_GITHUB_STORAGE_HOST}/a`, "https://pipelinesghubeus6.actions.githubusercontent.com/a?sig=1", "https://productionresultssa7.blob.core.windows.net/actions-results/x?sig=2", "https://A.B.actions.githubusercontent.com/a"]) {
      expect(isLogStorageUrl(new URL(ok)), ok).toBe(true);
    }
    for (const bad of ["https://example.com/a", "https://githubusercontent.com/a", "https://actions.githubusercontent.com/a", "https://-.actions.githubusercontent.com/a", "http://x.blob.core.windows.net/a", "https://x.blob.core.windows.net:444/a", "https://u@x.blob.core.windows.net/a", "https://:p@x.blob.core.windows.net/a", "https://xblob.core.windows.net/a", "https://x.actions.githubusercontent.com.attacker.io/a", "https://a-.b.actions.githubusercontent.com/a", "https://-a.b.actions.githubusercontent.com/a", "https://under_score.actions.githubusercontent.com/a", "https://a.-b.blob.core.windows.net/a"]) {
      expect(isLogStorageUrl(new URL(bad)), bad).toBe(false);
    }
  });

  it("follows exactly one redirect: a storage host that redirects again is refused", async () => {
    const w = await world({ fake: { storageRedirects: true } });
    const result = await callLog(w);
    expect(result).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "the vendor answered with a redirect, which is refused" });
    expect(w.fake.requests.filter((request) => request.url.includes(FAKE_GITHUB_STORAGE_HOST))).toHaveLength(1);
  });

  it("refuses a log request that is not answered with a redirect with a Location", async () => {
    const none = await world({ fake: { logRedirect: null } });
    expect(await callLog(none)).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "GitHub answered something this connector cannot read" });
    const inline = await world({ fake: { logInline: true } });
    expect(await callLog(inline)).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "GitHub answered something this connector cannot read" });
  });

  it("answers a job it does not have in fixed words", async () => {
    const w = await world();
    expect(await callLog(w, { jobId: 12 })).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "GitHub has no such job in demo" });
  });

  it("scrubs the installation token from the log, before any cap or cut, and never shows the Authorization header", async () => {
    const w = await world({ fake: { logText: (tokens) => `${Array.from({ length: 300 }, (_unused, index) => `line ${String(index + 1)}`).join("\n")}\ncurl -H "Authorization: Bearer ${tokens.at(-1)!}" https://api.github.com` } });
    const result = await callLog(w, { jobId: 7001, tailLines: 50 });
    expect(result.status).toBe("SUCCEEDED");
    const token = w.fake.tokens.at(-1)!;
    expect(result.text).toContain("[REDACTED]");
    expect(result.text).not.toContain(token);
    expect(result.text.toLowerCase()).not.toContain("ghs_fake");
  });

  it("scrubs the token from a long line before the line is clipped, so no piece of it survives the clip", async () => {
    const w = await world({ fake: { logText: (tokens) => `first\n${"z".repeat(985)}${tokens.at(-1) ?? ""}${"z".repeat(50)}\nlast` } });
    const result = await callLog(w);
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text).not.toContain("ghs_f");
    expect(result.text).not.toContain("ghs_");
  });

  it("keeps the end of a log that is longer than the answer can hold, within the answer's limit", async () => {
    const long = (tokens: readonly string[]) => `${Array.from({ length: 3000 }, (_unused, index) => `${String(index + 1).padStart(4, "0")} ${"x".repeat(100)}`).join("\n")}\nthe last line holds ${tokens.at(-1) ?? ""} and ends here`;
    const w = await world({ fake: { logText: long } });
    const result = await callLog(w, { jobId: 7001, tailLines: 2000 });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text.length).toBeLessThanOrEqual(32_768);
    expect(result.text.endsWith("and ends here")).toBe(true);
    expect(result.text).toContain("3000 xxxx");
    expect(result.text).toContain("earlier lines are not shown");
    expect(result.text).not.toContain("1500 xxxx");
    expect(result.text).not.toContain(w.fake.tokens.at(-1)!);
  });

  it("drops terminal colour codes and clips a very long line", async () => {
    const w = await world({ fake: { logText: `\u001b[31;1mred line\u001b[0m\n${"y".repeat(5000)}\nplain line` } });
    const result = await callLog(w);
    expect(result.text).toContain("red line");
    expect(result.text).not.toContain("\u001b");
    expect(result.text).not.toContain("y".repeat(1500));
    expect(result.text).toContain("plain line");
  });

  it("refuses a log bigger than the connector reads, and one that is too slow, in fixed words", async () => {
    const big = logDownloader(vi.fn(async () => new Response("x".repeat(2_000), { status: 200 })), { maxBytes: 1_000 });
    await expect(big(`https://${FAKE_GITHUB_STORAGE_HOST}/log`)).rejects.toThrow("the vendor answered with more than a connector reads");
    const slow = logDownloader(((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error)); })), { timeoutMs: 30 });
    await expect(slow(`https://${FAKE_GITHUB_STORAGE_HOST}/log`)).rejects.toThrow("the vendor did not answer in time");
  });

  it("downloads with no credential of any kind, and refuses the host again before it asks", async () => {
    const seen: Array<{ url: string; headers: Headers; redirect: string | undefined }> = [];
    const base = (async (input: unknown, init?: RequestInit) => {
      seen.push({ url: String(input instanceof URL ? input.href : input), headers: new Headers(init?.headers), redirect: init?.redirect });
      return new Response("the log", { status: 200 });
    }) as typeof fetch;
    const download = logDownloader(base);
    expect(await download(`https://${FAKE_GITHUB_STORAGE_HOST}/abc/log.txt?sig=1`)).toBe("the log");
    expect(seen).toHaveLength(1);
    expect([...seen[0]!.headers.keys()].filter((name) => name === "authorization" || name === "cookie")).toEqual([]);
    expect(seen[0]!.redirect).toBe("error");
    await expect(download("https://example.com/log")).rejects.toMatchObject({ name: "NativeToolRefusal" });
    expect(seen).toHaveLength(1);
  });
});

describe("what the server binds", () => {
  const direct = async (values: Record<string, string>, args: Record<string, unknown> = {}) => {
    const w = await world();
    const connection = await w.connector.connect!({ endpoint: new URL("https://api.github.com/"), token: "x", tools: ["list_workflow_runs"] } as never);
    return { w, result: await connection.call("list_workflow_runs", { scopeAlias: "demo", owner: "example", repo: "demo", repositoryId: "4242", installationId: "", ...values, ...args }) };
  };

  it.each([
    ["an owner with a slash", { owner: "a/b" }, "owner"], ["an empty owner", { owner: "" }, "owner"], ["an owner with a dot", { owner: "a.b" }, "owner"],
    ["a repository that is two dots", { repo: ".." }, "repo"], ["a repository that is one dot", { repo: "." }, "repo"], ["a repository with a slash", { repo: "demo/x" }, "repo"],
    ["a repository id of zero", { repositoryId: "0" }, "repositoryId"], ["a repository id that is not digits", { repositoryId: "42x" }, "repositoryId"],
    ["an installation id that is not digits", { installationId: "abc" }, "installationId"], ["an installation id of zero", { installationId: "0" }, "installationId"],
    ["an empty alias", { scopeAlias: "" }, "scopeAlias"],
  ])("refuses %s before anything is minted", async (_name, values, key) => {
    const { w, result } = await direct(values);
    expect(result).toMatchObject({ isError: true, content: [{ text: `list_workflow_runs: ${key} is not allowed` }] });
    expect(w.fake.requests).toEqual([]);
  });

  it("accepts the bound values it is given and nothing else, with an installation id when there is one", async () => {
    const { w, result } = await direct({ installationId: "55" });
    expect(result.isError).not.toBe(true);
    expect(w.fake.minted()).toHaveLength(1);
    // An installation the repository is not under: the connector is not connected for it (the engine reports that), and nothing is minted.
    await expect(direct({ installationId: "56" })).rejects.toThrow("Rovara can't reach example/demo");
  });

  it("reads the owner and name from the repository's address, and offers only a name that is safe in a path", async () => {
    // Built without the schema, which would refuse some of these before the connector sees them: a stored project is not trusted to have passed it.
    const offered = async (url: string) => (await world({ definition: { ...project([connectorConfig()]), repositories: [REPOSITORY("demo", { githubRepositoryId: 1, url })] } })).connector.scopes.length;
    expect(await offered("https://github.com/example/demo.git")).toBe(1);
    expect(await offered("https://github.com/example/demo")).toBe(1);
    expect(await offered("https://GitHub.com/example/demo.git")).toBe(1);
    expect(await offered("https://github.com/example/de.mo_1-x.git")).toBe(1);
    for (const bad of ["https://github.com/example/..git", "https://github.com/example/...git", "https://github.com/example", "https://github.com/a/b/c", "http://github.com/example/demo", "https://github.com.evil.example/example/demo", "https://github.com/-bad/demo", "https://github.com/example/de%2Fmo"]) {
      expect(await offered(bad), bad).toBe(0);
    }
  });

  it("is not connected for a repository the App is not installed on, with GitHub's own words about it", async () => {
    const w = await world({ definition: project([connectorConfig()], [REPOSITORY("demo", { githubRepositoryId: 1, url: "https://github.com/stranger/demo.git" })]) });
    const result = await run(w, "list_workflow_runs");
    expect(result).toMatchObject({ status: "FAILED", reason: "not_connected" });
    expect(result.text).toContain("the GitHub App cannot access stranger/demo");
    expect(w.fake.minted()).toEqual([]);
  });

  it("refuses to serve a scope whose repository has no pinned id, even if it is handed one", async () => {
    const w = await world();
    const definition = await definitionOf(w);
    const legacy = { alias: "legacy", repository: REPOSITORY("legacy") } as never;
    await expect(definition.credentials.issue(legacy, "read")).rejects.toThrow("legacy has no pinned GitHub repository id");
    await expect(definition.credentials.issue(scopeOf(w, "demo"), "write")).rejects.toThrow("read-only");
    expect(() => definition.binder.bind(legacy, { token: "x", bindings: {} })).toThrow("legacy has no pinned GitHub repository id");
    expect(definition.binder.bind(scopeOf(w, "demo"), { token: "x", bindings: {} })).toEqual({ scopeAlias: "demo", owner: "example", repo: "demo", repositoryId: "4242", installationId: "55" });
    expect(definition.binder.bind(scopeOf(await world({ definition: project([connectorConfig()], [REPOSITORY("demo", { githubRepositoryId: 9 })]) }), "demo"), { token: "x", bindings: {} }))
      .toMatchObject({ repositoryId: "9", installationId: "" });
  });

  it("takes its fetch from the pinned, public-address-only one that hands a redirect back, when the deployment gives none", async () => {
    const w = await world();
    const bare = resolveConnectors(project([connectorConfig()]), { githubAgentTokens: w.provider, orgId: ORG_A }, { "github-actions": githubActionsConnectorType })[0]!;
    watched.calls.length = 0;
    await (await bare.connect!({ endpoint: new URL("https://api.github.com/"), token: "x", tools: ["get_job_log"] } as never)).close();
    expect(watched.calls).toEqual([{ returnRedirects: true }]);
    // A deployment's own `nativeFetch` (a test's) is used as it is.
    watched.calls.length = 0;
    await (await w.connector.connect!({ endpoint: new URL("https://api.github.com/"), token: "x", tools: ["get_job_log"] } as never)).close();
    expect(watched.calls).toEqual([]);
  });

  it("holds an owner to GitHub's 39 characters and a repository name to 100", async () => {
    const outcome = async (values: Record<string, string>) => {
      try { return (await direct(values)).result; } catch (error) { return error; }
    };
    expect(await outcome({ owner: "a".repeat(40) })).toMatchObject({ isError: true });
    expect(await outcome({ owner: "a".repeat(39) })).not.toMatchObject({ isError: true });
    expect(await outcome({ repo: "a".repeat(101) })).toMatchObject({ isError: true });
    expect(await outcome({ repo: "a".repeat(100) })).not.toMatchObject({ isError: true });
    expect(await outcome({ owner: "-a" })).toMatchObject({ isError: true });
    expect(await outcome({ owner: "a-" })).toMatchObject({ isError: true });
  });

  it("serves api.github.com only", async () => {
    const w = await world();
    await expect(w.connector.connect!({ endpoint: new URL("https://evil.example/"), token: "x", tools: ["list_workflow_runs"] } as never)).rejects.toThrow("api.github.com only");
    await expect(w.connector.connect!({ endpoint: new URL("http://api.github.com/"), token: "x", tools: ["list_workflow_runs"] } as never)).rejects.toThrow("api.github.com only");
  });
});

describe("deployments", () => {
  it("lists the repository's deployments, filtered by environment, and leaves another repository's out", async () => {
    const w = await world({ fake: { leak: true } });
    const all = await run(w, "list_deployments", {});
    expect(all.status).toBe("SUCCEEDED");
    expect(all.text).toContain("5001");
    expect(all.text).toContain("production");
    expect(all.text).toContain("staging");
    for (const other of ["6001", "6002", "6003"]) expect(all.text).not.toContain(other);
    const url = new URL(apiCalls(w)[0]!.url);
    expect(url.pathname).toBe("/repos/example/demo/deployments");
    expect(url.searchParams.get("per_page")).toBe("10");
    expect(url.searchParams.has("environment")).toBe(false);
    const staging = await run(w, "list_deployments", { environment: "staging", limit: 3 });
    const filtered = new URL(apiCalls(w)[1]!.url);
    expect(filtered.searchParams.get("environment")).toBe("staging");
    expect(filtered.searchParams.get("per_page")).toBe("3");
    expect(staging.text).toContain("5002");
    expect(staging.text).not.toContain("5001");
  });

  it("holds the answer to the environment and limit asked for, even when GitHub ignores them", async () => {
    const w = await world({ fake: { ignoreFilters: true } });
    const ids = (text: string) => text.split("\n").filter((line) => /^\d{4} /u.test(line)).map((line) => line.split(" ")[0]);
    expect(ids((await run(w, "list_deployments", { environment: "staging" })).text)).toEqual(["5002"]);
    expect(ids((await run(w, "list_deployments", { limit: 1 })).text)).toEqual(["5001"]);
    expect(ids((await run(w, "list_deployments", {})).text)).toEqual(["5001", "5002"]);
  });

  it("says when there are no deployments or no statuses", async () => {
    const w = await world();
    expect((await run(w, "list_deployments", { environment: "qa" })).text).toBe("No deployments in demo.");
    const empty = await world({ definition: project([connectorConfig()]), fake: { leak: false } });
    expect((await run(empty, "list_execution_jobs", { workflowRunId: 9003 })).text).toContain("2 jobs of workflow run 9003 in demo");
  });

  it("lists a deployment's statuses, and only those of this repository's deployment", async () => {
    const w = await world({ fake: { leak: true } });
    const result = await run(w, "list_deployment_statuses", { deploymentId: 5001 });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text).toContain("success");
    expect(result.text).toContain("in_progress");
    for (const other of ["failure", "queued", "error"]) expect(result.text, other).not.toContain(other);
    expect(new URL(apiCalls(w)[0]!.url).pathname).toBe("/repos/example/demo/deployments/5001/statuses");
    // A deployment of another repository is not found in this one.
    expect(await run(w, "list_deployment_statuses", { deploymentId: 6001 })).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "GitHub has no such deployment in demo" });
  });

  it("rejects an environment that is not a plain name before asking GitHub", async () => {
    const w = await world();
    const before = w.fake.minted().length;
    expect(await run(w, "list_deployments", { environment: "a&b=c" })).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    expect(await run(w, "list_deployments", { environment: "x".repeat(300) })).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    expect(w.fake.minted()).toHaveLength(before);
  });
});

describe("what GitHub spells and sends", () => {
  it("matches an item to its repository however GitHub spells the account", async () => {
    const w = await world({ fake: { ownerCase: "Example" } });
    expect((await run(w, "list_execution_jobs", { workflowRunId: 9001 })).text).toContain("7001");
    expect((await run(w, "list_deployments", {})).text).toContain("5001");
    expect((await run(w, "list_deployment_statuses", { deploymentId: 5001 })).text).toContain("success");
  });

  it("answers fixed words for a 200 that is not JSON", async () => {
    const w = await world({ fake: { plainText: true } });
    for (const [tool, args] of [["list_workflow_runs", {}], ["get_workflow_execution", { workflowRunId: 9001 }], ["list_execution_jobs", { workflowRunId: 9001 }], ["list_deployments", {}], ["list_deployment_statuses", { deploymentId: 5001 }]] as const) {
      expect(await run(w, tool, args), tool).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "GitHub answered something this connector cannot read" });
    }
  });

  it("reads a lone carriage return (a progress line rewritten in place) as a line end", async () => {
    const w = await world({ fake: { logText: `${Array.from({ length: 60 }, (_unused, index) => `step ${String(index + 1)}`).join("\r")}\r` } });
    const result = await run(w, "get_job_log", { jobId: 7001, tailLines: 50 });
    expect(result.text.split("\n").filter((line) => line.startsWith("step "))).toHaveLength(50);
    expect(result.text).toContain("(10 earlier lines are not shown)");
  });

  it("reads a log with Windows line ends as lines, and keeps no carriage return", async () => {
    const w = await world({ fake: { logText: `${Array.from({ length: 80 }, (_unused, index) => `row ${String(index + 1)}`).join("\r\n")}\r\n` } });
    const result = await run(w, "get_job_log", { jobId: 7001, tailLines: 50 });
    expect(result.text).not.toContain("\r");
    expect(result.text.split("\n").filter((line) => line.startsWith("row "))).toHaveLength(50);
    expect(result.text.endsWith("row 80")).toBe(true);
    expect(result.text).toContain("(30 earlier lines are not shown)");
  });
});

describe("what GitHub says", () => {
  it("is answered in fixed words by status, and never quotes GitHub's body", async () => {
    for (const [status, text] of [
      [401, "GitHub refused the installation token. Check that the App is installed on this repository."],
      [403, "GitHub refused the request. Check that the App has the Actions and Deployments read permissions on this repository."],
      [404, "GitHub has no such workflow run in demo"],
      [429, "GitHub is limiting requests; try again later"],
      [500, "GitHub answered HTTP 500"],
      [202, "GitHub answered HTTP 202"],
    ] as const) {
      const w = await world({ fake: { status } });
      const result = await run(w, "get_workflow_execution", { workflowRunId: 9001 });
      expect(result, String(status)).toMatchObject({ status: "FAILED", reason: "vendor_error", text });
      expect(result.text).not.toContain("secret-detail-xyz");
    }
  });
});

describe("the request GitHub sees (v0.4.6 staging: every call came back refused with HTTP 403)", () => {
  it("carries a User-Agent on every request to GitHub's API, the App's calls and the tool's, because GitHub refuses one that has none", async () => {
    const w = await world();
    const args: Record<string, Record<string, unknown>> = {
      list_workflow_runs: {}, get_workflow_execution: { workflowRunId: 9001 }, list_execution_jobs: { workflowRunId: 9001 }, get_job_log: { jobId: 7001 },
      list_deployments: {}, list_deployment_statuses: { deploymentId: 5001 },
    };
    for (const tool of TOOLS) expect((await run(w, tool, args[tool])).status, tool).toBe("SUCCEEDED");
    const toGitHubApi = w.fake.requests.filter((request) => new URL(request.url).hostname === "api.github.com");
    expect(toGitHubApi.length).toBeGreaterThan(12);
    for (const request of toGitHubApi) expect(request.userAgent, `${request.method} ${request.url}`).toBe("agentx-control-plane");
  });

  it("logs a refused call with the tool, the repository, the status, the permissions the token was minted with and GitHub's message, and never the token", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const w = await world({ fake: { status: 403 } });
    const result = await run(w, "list_workflow_runs");
    expect(result).toMatchObject({ status: "FAILED", reason: "vendor_error" });
    // The model still gets the fixed words, not GitHub's.
    expect(result.text).not.toContain("secret-detail-xyz");
    const entries = log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>).filter((entry) => String(entry["event"]).startsWith("github_actions."));
    expect(entries).toEqual([{
      component: "broker", event: "github_actions.request_refused", tool: "list_workflow_runs", repository: "example/demo", status: 403,
      requestedPermissions: { actions: "read", metadata: "read" }, installationId: 55, message: "fake outage with secret-detail-xyz",
    }]);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/ghs_/u);
    // The permissions it names are what the token request carried.
    expect(w.fake.minted().map((request) => request.body)).toEqual([{ repositories: ["demo"], permissions: { actions: "read", metadata: "read" } }]);
  });

  it("logs the deployments tools with the deployments permission, and a plain not-found with nothing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const refused = await world({ fake: { status: 401 } });
    await run(refused, "list_deployments");
    const missing = await world({ fake: { status: 404 } });
    await run(missing, "get_workflow_execution", { workflowRunId: 9001 });
    const entries = log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>).filter((entry) => String(entry["event"]).startsWith("github_actions."));
    expect(entries).toMatchObject([{ event: "github_actions.request_refused", tool: "list_deployments", status: 401, requestedPermissions: { deployments: "read", metadata: "read" } }]);
  });

  it("logs a token that could not be issued with the permissions asked for and our own error words", async () => {
    const entries: Array<Record<string, unknown>> = [];
    const tokens = { createAgentInstallationToken: async () => { throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App installation token request failed with HTTP 500"); } };
    await expect(mintActionsToken({
      tokens, orgId: ORG_A, tool: "list_deployments", scope: { owner: "example", repo: "demo", installationId: 55, log: (entry) => entries.push(entry) },
    })).rejects.toMatchObject({ name: "NativeToolRefusal", reason: "vendor_error" });
    expect(entries).toEqual([{
      event: "github_actions.token_not_issued", tool: "list_deployments", repository: "example/demo", requestedPermissions: { deployments: "read", metadata: "read" },
      code: "RUNTIME_UNAVAILABLE", message: "RUNTIME_UNAVAILABLE: GitHub App installation token request failed with HTTP 500",
    }]);
  });
});

describe("the connector context", () => {
  it("carries the deployment's agent token minter and the caller's org, and nothing when the deployment has no minter", async () => {
    await loadSlackBroker();
    const broker = await import("../../packages/broker/src/aws/broker.js") as unknown as {
      connectorTypeContext: (dependencies: Record<string, unknown>, orgId: OrgId | undefined, scope: () => Promise<unknown>) => { orgId?: OrgId; githubAgentTokens?: { createAgentInstallationToken(...args: unknown[]): Promise<string> } };
    };
    const noToken = () => Promise.reject(new Error("no token"));
    const mint = vi.fn<(...args: unknown[]) => Promise<string>>(async () => "ghs_fake");
    const context = broker.connectorTypeContext({ githubPullRequests: { createAgentInstallationToken: mint } }, ORG_A, noToken);
    expect(context.orgId).toBe(ORG_A);
    expect(await context.githubAgentTokens!.createAgentInstallationToken({ owner: "example", name: "demo" }, { actions: "read" }, { orgId: ORG_A }, { installationId: 55 })).toBe("ghs_fake");
    expect(mint).toHaveBeenCalledWith({ owner: "example", name: "demo" }, { actions: "read" }, { orgId: ORG_A }, { installationId: 55 });
    expect(broker.connectorTypeContext({ githubPullRequests: {} }, ORG_A, noToken).githubAgentTokens).toBeUndefined();
    expect(broker.connectorTypeContext({}, ORG_A, noToken).githubAgentTokens).toBeUndefined();
  });
});
