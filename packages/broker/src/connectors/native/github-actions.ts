// Plan 4 Task 17: the GitHub Actions connector's tools. It reads the workflow runs, jobs, job logs and deployments of the project's repositories. It has no
// connection and holds no secret: every call mints Plan 3's agent installation token (`createAgentInstallationToken`) for ONE repository with exactly the
// permissions of the tool (`GITHUB_ACTIONS_AGENT_TOOL_PERMISSIONS`: `actions: read` or `deployments: read`, plus `metadata: read`), after the org's installation
// binding is checked, and runs the tool with it (`credentialFor` in `runtime.ts`). Nothing here can write: no tool name is a write word, and the token cannot.
//
// A scope is one repository: the project's own, with its GitHub repository id pinned. The server binds the owner, the name and the id on every call, and a tool
// shows an item only if what GitHub answered names that repository (the run's `repository.id`, a job's `run_url`, a deployment's `repository_url`).
//
// `get_job_log` is the one tool that follows a redirect. GitHub answers `GET .../actions/jobs/{id}/logs` with a 302 to a signed address in its log storage; the
// connector reads that address (the request itself follows nothing), checks it against GitHub's two storage host families, and asks it once, over the same
// pinned fetch, with no Authorization header. Redacted first, then cut: the answer is the end of the log.
//
// GitHub documentation read on 2026-10-22 (docs.github.com/en/rest): POST /app/installations/{installation_id}/access_tokens (`repositories`, `permissions` with
// `actions` and `deployments` at read or write); GET /repos/{owner}/{repo}/actions/runs (status, branch, per_page; each run has `repository.id`), /actions/runs/{run_id},
// /actions/runs/{run_id}/jobs (filter, per_page; a job has `run_id`, `run_url`, `steps`), /actions/jobs/{job_id}/logs (302, `Location` valid for 1 minute; the page names
// no host, so the two host families of the brief are used), /deployments (environment, per_page; `repository_url`) and /deployments/{id}/statuses (`deployment_url`, `repository_url`).
import { redactText, type OrgId, type RepositoryDefinition } from "@rovara-code/contracts";
import { CredentialUnavailable } from "@agentx/gateway";
import { GITHUB_ACTIONS_AGENT_TOOL_PERMISSIONS, githubActionsToolPermissions, type GitHubActionsToolPermissionSet, type GitHubAgentTokenPermissions } from "../../agents/github-agent-tools.js";
import { NativeToolRefusal, type NativeRouting, type NativeTool, type NativeToolContext } from "./runtime.js";
import { vendorFetch, type VendorResponse } from "./vendor-fetch.js";

export const GITHUB_API_ORIGIN = "https://api.github.com/";
/**
 * Sent on every request to GitHub's API. GitHub refuses a request with no `User-Agent` header with HTTP 403 (not a permissions answer), and the fixed-origin fetch under
 * a native connector is node's own https request, which sends none (v0.4.6 staging: every Actions tool call came back "refused" although the token was right).
 */
export const GITHUB_USER_AGENT = "agentx-control-plane";

/** What the engine binds a call to: the repository, with its pinned GitHub id. */
export interface GitHubActionsEngineScope { alias: string; repository: RepositoryDefinition }

/** What a tool runs with: one repository, and the way to read the log storage address GitHub gave. */
export interface GitHubActionsRunScope {
  alias: string;
  owner: string;
  repo: string;
  repositoryId: number;
  /** The installation the project registered the repository under, when it did: a token is minted only for that installation. */
  installationId: number | undefined;
  /** Reads a log from the address GitHub redirected to (`logDownloader`). */
  download(location: string): Promise<string>;
  /** Where a refused request is logged (names, ids, numbers and GitHub's own message; never a token). */
  log: (entry: Record<string, unknown>) => void;
}

// ---- the token

/** What the connector needs of the deployment's GitHub App: Plan 3's guarded way to mint an agent's token. */
export interface GitHubActionsTokens {
  createAgentInstallationToken(
    repository: { owner: string; name: string },
    permissions: GitHubAgentTokenPermissions,
    scope: { orgId: OrgId },
    options?: { installationId?: number | undefined },
  ): Promise<string>;
}

const NOT_AVAILABLE = "that GitHub Actions tool is not available";
const NO_TOKEN = "GitHub could not issue a token for this repository; try again later";

/** The words of an error we wrote, without the code the error carries in front of them. */
const wordsOf = (error: { message: string }): string => error.message.replace(/^[A-Z][A-Z_]*: /u, "");

/**
 * The token one call of `tool` runs with: Plan 3's agent installation token for the scope's repository, with exactly the tool's permissions (and `metadata:
 * read`), for the caller's org. A tool the permission map does not list is refused before GitHub is asked anything. An installation that is not bound to the
 * org, or is not the one the project registered, is "not connected" (the connector is unavailable for the repository); any other failure is fixed words.
 */
export async function mintActionsToken(input: {
  tokens: GitHubActionsTokens;
  orgId: OrgId;
  tool: string;
  scope: Pick<GitHubActionsRunScope, "owner" | "repo" | "installationId"> & Partial<Pick<GitHubActionsRunScope, "log">>;
  catalog?: Readonly<Record<string, Readonly<GitHubActionsToolPermissionSet>>>;
}): Promise<string> {
  let permissions: GitHubAgentTokenPermissions;
  try {
    permissions = githubActionsToolPermissions(input.tool, input.catalog ?? GITHUB_ACTIONS_AGENT_TOOL_PERMISSIONS);
  } catch {
    throw new NativeToolRefusal(NOT_AVAILABLE, "policy_denied");
  }
  try {
    return await input.tokens.createAgentInstallationToken(
      { owner: input.scope.owner, name: input.scope.repo }, permissions, { orgId: input.orgId },
      input.scope.installationId === undefined ? {} : { installationId: input.scope.installationId },
    );
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "GITHUB_NOT_CONNECTED" || code === "CONFIG_INVALID") throw new CredentialUnavailable(wordsOf(error as Error));
    // Which permissions were asked for and what failed, so a refused mint can be told from a refused call (our own words and codes only; no token exists yet).
    input.scope.log?.({
      event: "github_actions.token_not_issued", tool: input.tool, repository: `${input.scope.owner}/${input.scope.repo}`, requestedPermissions: permissions,
      ...(typeof code === "string" ? { code } : {}), message: clip(error instanceof Error ? redactText(error.message) : "unknown", 300),
    });
    throw new NativeToolRefusal(NO_TOKEN, "vendor_error");
  }
}

// ---- the scope

const OWNER = "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$";
// Not `.` or `..`: a path segment of dots would climb out of `/repos/{owner}/{repo}`.
const REPO = "^(?!\\.{1,2}$)[A-Za-z0-9._-]{1,100}$";
const DIGITS = "[1-9][0-9]{0,15}";

/** The values the server binds on every call; the model sets none of them. The installation id is empty when the project did not pin one. */
export const GITHUB_ACTIONS_ROUTING_PROPERTIES: NativeRouting<unknown>["properties"] = {
  scopeAlias: { type: "string", minLength: 1, maxLength: 63 },
  owner: { type: "string", pattern: OWNER },
  repo: { type: "string", pattern: REPO },
  repositoryId: { type: "string", pattern: `^${DIGITS}$` },
  installationId: { type: "string", pattern: `^(${DIGITS})?$` },
};

const OWNER_PATTERN = new RegExp(OWNER, "u");
const REPO_PATTERN = new RegExp(REPO, "u");

/** The owner and name of a repository the project registered, from its address; undefined where it is not a GitHub repository address or names anything unusual. */
export function repositoryNameOf(repository: RepositoryDefinition): { owner: string; repo: string } | undefined {
  let url: URL;
  try { url = new URL(repository.url); } catch { return undefined; }
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || segments.length !== 2) return undefined;
  const owner = segments[0]!;
  const repo = segments[1]!.replace(/\.git$/u, "");
  return OWNER_PATTERN.test(owner) && REPO_PATTERN.test(repo) ? { owner, repo } : undefined;
}

/** The repository a scope can be served for, or undefined: it needs a pinned GitHub repository id and an address of the shape above. */
export function actionsRepositoryOf(repository: RepositoryDefinition): { owner: string; repo: string; repositoryId: number } | undefined {
  const name = repositoryNameOf(repository);
  return name === undefined || repository.githubRepositoryId === undefined ? undefined : { ...name, repositoryId: repository.githubRepositoryId };
}

export const githubActionsRoutingValues = (scope: GitHubActionsEngineScope): Record<string, string> => {
  const repository = actionsRepositoryOf(scope.repository);
  if (repository === undefined) throw new CredentialUnavailable(`${scope.alias} has no pinned GitHub repository id; register the project again`);
  return {
    scopeAlias: scope.alias, owner: repository.owner, repo: repository.repo, repositoryId: String(repository.repositoryId),
    installationId: scope.repository.installationId === undefined ? "" : String(scope.repository.installationId),
  };
};

// ---- helpers

const CLIP = 300;
const clip = (value: unknown, max = CLIP): string => {
  const text = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const recordOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const sha = (value: unknown): string => clip(value, 40).slice(0, 7);
const loginOf = (value: unknown): string => clip(recordOf(value)["login"], 60);

const repoPath = (scope: GitHubActionsRunScope): string => `repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}`;
const headersOf = (ctx: NativeToolContext<GitHubActionsRunScope>) => ({
  authorization: `Bearer ${ctx.credential.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": GITHUB_USER_AGENT,
});

/**
 * Logs a request GitHub refused (not a plain "not found"): the tool, the repository, the status, the permissions the token was minted with, and GitHub's own `message`
 * (cut, redacted, the token removed). GitHub's words are for the log only; the model still gets the fixed words of `failureOf`.
 */
function logRefused(ctx: NativeToolContext<GitHubActionsRunScope>, tool: string, status: number, response: Pick<VendorResponse, "json" | "text">): void {
  if (status === 404) return;
  const said = isRecord(response.json) && typeof response.json["message"] === "string" ? response.json["message"] : response.text ?? "";
  const token = ctx.credential.token;
  const message = clip(redactText(token === "" ? said : said.split(token).join("[REDACTED]")), 300);
  let requestedPermissions: unknown;
  try { requestedPermissions = githubActionsToolPermissions(tool); } catch { requestedPermissions = undefined; }
  ctx.scope.log({
    event: "github_actions.request_refused", tool, repository: `${ctx.scope.owner}/${ctx.scope.repo}`, status, requestedPermissions,
    ...(ctx.scope.installationId === undefined ? {} : { installationId: ctx.scope.installationId }), message,
  });
}

/** Whether `url` is a GitHub API address for exactly `path`, however it is cased: what a list answer says an item belongs to. */
function isApiPath(url: unknown, path: string): boolean {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === "api.github.com" && parsed.pathname.toLowerCase() === `/${path}`.toLowerCase();
  } catch {
    return false;
  }
}

/** A GitHub failure, in fixed words by status: GitHub's own body (which can quote anything) is never shown. */
function failureOf(status: number, notFound: string): NativeToolRefusal {
  if (status === 401) return new NativeToolRefusal("GitHub refused the installation token. Check that the App is installed on this repository.", "vendor_error");
  if (status === 403) return new NativeToolRefusal("GitHub refused the request. Check that the App has the Actions and Deployments read permissions on this repository.", "vendor_error");
  if (status === 404) return new NativeToolRefusal(notFound, "vendor_error");
  if (status === 429) return new NativeToolRefusal("GitHub is limiting requests; try again later", "vendor_error");
  return new NativeToolRefusal(`GitHub answered HTTP ${String(status)}`, "vendor_error");
}

const UNREADABLE = "GitHub answered something this connector cannot read";

async function githubGet(ctx: NativeToolContext<GitHubActionsRunScope>, tool: string, path: string, query: Array<[string, string]>, notFound: string): Promise<unknown> {
  const search = new URLSearchParams(query).toString();
  const response = await ctx.fetch(`${repoPath(ctx.scope)}/${path}${search === "" ? "" : `?${search}`}`, { headers: headersOf(ctx) });
  if (response.status !== 200) {
    logRefused(ctx, tool, response.status, response);
    throw failureOf(response.status, notFound);
  }
  if (response.json === undefined) throw new NativeToolRefusal(UNREADABLE, "vendor_error");
  return response.json;
}

const limitOf = (args: Record<string, unknown>): number => (typeof args["limit"] === "number" ? args["limit"] : 10);
const plural = (count: number, noun: string): string => `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

// ---- runs

/** A run of the scope's repository: GitHub says which repository a run belongs to, and the answer is not trusted to have kept to the one asked for. */
const runInScope = (run: Record<string, unknown>, scope: GitHubActionsRunScope): boolean => recordOf(run["repository"])["id"] === scope.repositoryId;

function runLine(run: Record<string, unknown>): string {
  const state = run["conclusion"] === null || run["conclusion"] === undefined ? clip(run["status"], 20) : `${clip(run["status"], 20)}/${clip(run["conclusion"], 20)}`;
  return `${clip(run["id"], 20)} [${state}] ${clip(run["name"], 80)} "${clip(run["display_title"], 120)}" on ${clip(run["head_branch"], 80)} ${sha(run["head_sha"])} ${clip(run["event"], 30)} #${clip(run["run_number"], 12)} by ${loginOf(run["actor"])} at ${clip(run["created_at"], 30)}`;
}

const listWorkflowRuns: NativeTool<GitHubActionsRunScope> = {
  name: "list_workflow_runs",
  description: "List the latest GitHub Actions workflow runs of this repository, newest first, optionally only those in one state or on one branch.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["completed", "in_progress", "failure", "success"], description: "Only runs in this state or with this result" },
      branch: { type: "string", minLength: 1, maxLength: 255, description: "Only runs of this branch" },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "How many runs to return (default 10)" },
    },
    required: [],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const query: Array<[string, string]> = [["per_page", String(limitOf(args))]];
    if (typeof args["status"] === "string") query.push(["status", args["status"]]);
    if (typeof args["branch"] === "string") query.push(["branch", args["branch"]]);
    const runs = listOf(recordOf(await githubGet(ctx, "list_workflow_runs", "actions/runs", query, `GitHub has no such repository ${ctx.scope.alias}`))["workflow_runs"]).filter(isRecord)
      .filter((run) => runInScope(run, ctx.scope))
      // The filters are the server's, but the answer is not trusted to have kept to them.
      .filter((run) => typeof args["status"] !== "string" || run["status"] === args["status"] || run["conclusion"] === args["status"])
      .filter((run) => typeof args["branch"] !== "string" || run["head_branch"] === args["branch"])
      .slice(0, limitOf(args));
    if (runs.length === 0) return { text: `No workflow runs in ${ctx.scope.alias}.` };
    return { text: `${plural(runs.length, "workflow run")} in ${ctx.scope.alias}:\n${runs.map(runLine).join("\n")}` };
  },
};

const getWorkflowExecution: NativeTool<GitHubActionsRunScope> = {
  name: "get_workflow_execution",
  description: "Show one GitHub Actions workflow run of this repository: its state, result, branch, commit, trigger and times.",
  inputSchema: {
    type: "object",
    properties: { workflowRunId: { type: "integer", minimum: 1, description: "The workflow run's id" } },
    required: ["workflowRunId"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const id = args["workflowRunId"] as number;
    const run = recordOf(await githubGet(ctx, "get_workflow_execution", `actions/runs/${String(id)}`, [], `GitHub has no such workflow run in ${ctx.scope.alias}`));
    if (run["id"] !== id || !runInScope(run, ctx.scope)) throw new NativeToolRefusal(`that workflow run is not in ${ctx.scope.alias}`);
    return { text: `${runLine(run)}\nupdated ${clip(run["updated_at"], 30)}${typeof run["html_url"] === "string" ? `, ${clip(run["html_url"], 200)}` : ""}` };
  },
};

// ---- jobs

const MAX_JOBS = 30;
const MAX_STEPS = 25;

/** A job of this run of the scope's repository: its `run_id` is the run asked for and its `run_url` is that run of this repository. */
function jobInRun(job: Record<string, unknown>, runId: number, scope: GitHubActionsRunScope): boolean {
  return job["run_id"] === runId && isApiPath(job["run_url"], `${repoPath(scope)}/actions/runs/${String(runId)}`);
}

function jobLines(job: Record<string, unknown>): string {
  const state = job["conclusion"] === null || job["conclusion"] === undefined ? clip(job["status"], 20) : `${clip(job["status"], 20)}/${clip(job["conclusion"], 20)}`;
  const steps = listOf(job["steps"]).filter(isRecord).slice(0, MAX_STEPS)
    .map((step) => `  ${clip(step["number"], 4)}. ${clip(step["name"], 100)} [${clip(step["status"], 20)}${step["conclusion"] === null || step["conclusion"] === undefined ? "" : `/${clip(step["conclusion"], 20)}`}]`);
  return [`${clip(job["id"], 20)} [${state}] ${clip(job["name"], 100)} ${clip(job["started_at"], 30)} to ${clip(job["completed_at"], 30)}`, ...steps].join("\n");
}

const listExecutionJobs: NativeTool<GitHubActionsRunScope> = {
  name: "list_execution_jobs",
  description: "List the jobs of one GitHub Actions workflow run of this repository (latest attempt), each with its steps and their results.",
  inputSchema: {
    type: "object",
    properties: { workflowRunId: { type: "integer", minimum: 1, description: "The workflow run's id" } },
    required: ["workflowRunId"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const id = args["workflowRunId"] as number;
    const jobs = listOf(recordOf(await githubGet(ctx, "list_execution_jobs", `actions/runs/${String(id)}/jobs`, [["filter", "latest"], ["per_page", "100"]], `GitHub has no such workflow run in ${ctx.scope.alias}`))["jobs"])
      .filter(isRecord).filter((job) => jobInRun(job, id, ctx.scope)).slice(0, MAX_JOBS);
    if (jobs.length === 0) return { text: `No jobs for workflow run ${String(id)} in ${ctx.scope.alias}.` };
    return { text: `${plural(jobs.length, "job")} of workflow run ${String(id)} in ${ctx.scope.alias}:\n${jobs.map(jobLines).join("\n")}` };
  },
};

// ---- the job log

/** The most characters of log an answer holds (the rest of the answer's limit is for its heading), counted after each line is clipped. */
const LOG_CHAR_BUDGET = 30_000;
const LOG_LINE_MAX = 1_000;
const DEFAULT_TAIL = 200;
/** The most a log may be: GitHub's logs of a long job are megabytes, and a connector reads no more than this. */
export const LOG_MAX_BYTES = 8 * 1_048_576;
export const LOG_TIMEOUT_MS = 20_000;
const NOT_STORAGE = "GitHub sent the log somewhere other than its log storage; it was not fetched";

// `*.actions.githubusercontent.com` and `*.blob.core.windows.net`: one or more labels of letters, digits and inner hyphens in front of the domain, and nothing after it.
const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const LOG_STORAGE_HOSTS: readonly RegExp[] = [
  new RegExp(`^(?:${LABEL}\\.)+actions\\.githubusercontent\\.com$`, "u"),
  new RegExp(`^(?:${LABEL}\\.)+blob\\.core\\.windows\\.net$`, "u"),
];

/** Whether `url` is an address in GitHub's log storage: https, the standard port, no login, and a host of one of the two families. */
export function isLogStorageUrl(url: URL): boolean {
  return url.protocol === "https:" && url.port === "" && url.username === "" && url.password === "" && LOG_STORAGE_HOSTS.some((pattern) => pattern.test(url.hostname));
}

/**
 * Reads the log at the address GitHub redirected to, once: the address must be in GitHub's log storage (`isLogStorageUrl`), and is fetched over `base` held to
 * that one host, with no Authorization header or any other credential, no redirect, at most `maxBytes` and `timeoutMs` for the whole exchange.
 */
export function logDownloader(base: typeof fetch, options: { timeoutMs?: number; maxBytes?: number } = {}): (location: string) => Promise<string> {
  return async (location) => {
    let url: URL;
    try { url = new URL(location); } catch { throw new NativeToolRefusal(NOT_STORAGE, "policy_denied"); }
    if (!isLogStorageUrl(url)) throw new NativeToolRefusal(NOT_STORAGE, "policy_denied");
    const response = await vendorFetch({
      url, allowedHosts: [url.hostname], fetch: base, headers: { accept: "text/plain" },
      timeoutMs: options.timeoutMs ?? LOG_TIMEOUT_MS, maxBytes: options.maxBytes ?? LOG_MAX_BYTES,
    });
    if (response.status !== 200) throw new NativeToolRefusal(`GitHub's log storage answered HTTP ${String(response.status)}`, "vendor_error");
    return response.text ?? "";
  };
}

// eslint-disable-next-line no-control-regex -- the point is to remove terminal escape sequences and control characters
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b-\u001f\u007f]/gu;

/**
 * The end of `log`: redacted (`secret` is replaced wherever it occurs, before any line is clipped or cut), cleaned of terminal codes, each line clipped, the last
 * `tail` lines, and as many of those from the end as fit the answer. Says how many earlier lines are not shown.
 */
export function tailOfLog(log: string, secret: string, tail: number): { lines: string[]; omitted: number } {
  const redacted = secret === "" ? log : log.split(secret).join("[REDACTED]");
  const all = redacted.replace(/\r\n?/gu, "\n").replace(ANSI, "").split("\n").map((line) => (line.length > LOG_LINE_MAX ? `${line.slice(0, LOG_LINE_MAX - 1)}…` : line));
  while (all.length > 0 && all.at(-1) === "") all.pop();
  const wanted = all.slice(-tail);
  let used = 0;
  let from = wanted.length;
  while (from > 0 && used + wanted[from - 1]!.length + 1 <= LOG_CHAR_BUDGET) {
    from -= 1;
    used += wanted[from]!.length + 1;
  }
  return { lines: wanted.slice(from), omitted: all.length - (wanted.length - from) };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const getJobLog: NativeTool<GitHubActionsRunScope> = {
  name: "get_job_log",
  description: "Read the end of the log of one job of this repository's GitHub Actions runs (the last 50 to 2,000 lines, default 200).",
  inputSchema: {
    type: "object",
    properties: {
      jobId: { type: "integer", minimum: 1, description: "The job's id, from the jobs of a workflow run" },
      tailLines: { type: "integer", minimum: 50, maximum: 2000, description: "How many of the last lines to return (default 200)" },
    },
    required: ["jobId"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const id = args["jobId"] as number;
    const tail = typeof args["tailLines"] === "number" ? args["tailLines"] : DEFAULT_TAIL;
    // GitHub answers with a redirect to a signed address; read it here and follow it (once) only to its own log storage.
    const first = await ctx.fetch(`${repoPath(ctx.scope)}/actions/jobs/${String(id)}/logs`, { headers: headersOf(ctx), redirect: "capture" });
    if (!REDIRECTS.has(first.status) && first.status !== 200) logRefused(ctx, "get_job_log", first.status, first);
    if (!REDIRECTS.has(first.status)) throw first.status === 200 ? new NativeToolRefusal(UNREADABLE, "vendor_error") : failureOf(first.status, `GitHub has no such job in ${ctx.scope.alias}`);
    if (first.location === undefined) throw new NativeToolRefusal(UNREADABLE, "vendor_error");
    const log = await ctx.scope.download(first.location);
    const { lines, omitted } = tailOfLog(log, ctx.credential.token, tail);
    if (lines.length === 0) return { text: `The log of job ${String(id)} in ${ctx.scope.alias} is empty.` };
    return { text: `Job ${String(id)} in ${ctx.scope.alias}, last ${plural(lines.length, "line")}:\n${omitted > 0 ? `(${String(omitted)} earlier lines are not shown)\n` : ""}${lines.join("\n")}` };
  },
};

// ---- deployments

const deploymentInScope = (deployment: Record<string, unknown>, scope: GitHubActionsRunScope): boolean => isApiPath(deployment["repository_url"], repoPath(scope));

const listDeployments: NativeTool<GitHubActionsRunScope> = {
  name: "list_deployments",
  description: "List the latest deployments of this repository, newest first, optionally only those to one environment.",
  inputSchema: {
    type: "object",
    properties: {
      environment: { type: "string", pattern: "^[A-Za-z0-9 _./:-]{1,100}$", description: "Only deployments to this environment, for example production" },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "How many deployments to return (default 10)" },
    },
    required: [],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const query: Array<[string, string]> = [["per_page", String(limitOf(args))]];
    if (typeof args["environment"] === "string") query.push(["environment", args["environment"]]);
    const deployments = listOf(await githubGet(ctx, "list_deployments", "deployments", query, `GitHub has no such repository ${ctx.scope.alias}`)).filter(isRecord)
      .filter((deployment) => deploymentInScope(deployment, ctx.scope))
      .filter((deployment) => typeof args["environment"] !== "string" || deployment["environment"] === args["environment"]).slice(0, limitOf(args));
    if (deployments.length === 0) return { text: `No deployments in ${ctx.scope.alias}.` };
    const lines = deployments.map((deployment) =>
      `${clip(deployment["id"], 20)} ${clip(deployment["environment"], 60)} ${clip(deployment["ref"], 80)} ${sha(deployment["sha"])} ${clip(deployment["task"], 30)} created ${clip(deployment["created_at"], 30)} by ${loginOf(deployment["creator"])}`);
    return { text: `${plural(deployments.length, "deployment")} in ${ctx.scope.alias}:\n${lines.join("\n")}` };
  },
};

const listDeploymentStatuses: NativeTool<GitHubActionsRunScope> = {
  name: "list_deployment_statuses",
  description: "List the statuses of one deployment of this repository, newest first: each state change with its description and time.",
  inputSchema: {
    type: "object",
    properties: { deploymentId: { type: "integer", minimum: 1, description: "The deployment's id" } },
    required: ["deploymentId"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const id = args["deploymentId"] as number;
    const statuses = listOf(await githubGet(ctx, "list_deployment_statuses", `deployments/${String(id)}/statuses`, [["per_page", "20"]], `GitHub has no such deployment in ${ctx.scope.alias}`)).filter(isRecord)
      .filter((status) => isApiPath(status["repository_url"], repoPath(ctx.scope)) && isApiPath(status["deployment_url"], `${repoPath(ctx.scope)}/deployments/${String(id)}`)).slice(0, 20);
    if (statuses.length === 0) return { text: `No statuses for deployment ${String(id)} in ${ctx.scope.alias}.` };
    const lines = statuses.map((status) =>
      `${clip(status["created_at"], 30)} ${clip(status["state"], 20)} ${clip(status["environment"], 60)}: ${clip(status["description"], 140)}${clip(status["target_url"], 120) === "" ? "" : ` (${clip(status["target_url"], 120)})`}`);
    return { text: `${plural(statuses.length, "status")} of deployment ${String(id)} in ${ctx.scope.alias}:\n${lines.join("\n")}` };
  },
};

export const GITHUB_ACTIONS_TOOLS: readonly NativeTool<GitHubActionsRunScope>[] = [
  listWorkflowRuns, getWorkflowExecution, listExecutionJobs, getJobLog, listDeployments, listDeploymentStatuses,
];
/** The tools a project may approve on a github-actions connector (`PROJECT_CONNECTOR_TOOLS["github-actions"]`). */
export const GITHUB_ACTIONS_TOOL_NAMES: readonly string[] = GITHUB_ACTIONS_TOOLS.map((tool) => tool.name);
