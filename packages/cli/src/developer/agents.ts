// Plan 3 Task 35a: the agent platform from the command line. `agentx agents …`, `agentx project agents | connectors …`, `agentx skills …`,
// `agentx approvals …` and `agentx org guardrails | sources …`, each one or two signed-in calls to the control plane's /v1/app routes. The
// control plane decides who may do what; a refusal is printed as the broker wrote it (a revision conflict exits 1). A change that waits for a
// person prints the confirmation page's link. Nothing here decides an approval (R66): `approvals open` only fetches the page's link.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AgentXErrorCodeSchema, CLI_PACKAGE_NAME, TaskStatusSchema, agentXError, taskStatusText } from "@rovara-code/contracts";
import { ReportedFailure, exitCodeForError } from "../output.js";
import { jsonSafe, terminalSafe } from "./audit.js";
import { resolveOrgMember } from "./org.js";
import { developerAccessToken, type DeveloperSessionDeps } from "./session.js";

/**
 * Server text made safe for a terminal line: anything shaped like an AgentX refresh token or authorization code is hidden first, then every
 * control, format, separator or invisible character (a bidi override, CSI U+009B, a zero-width space) is shown as its `[U+XXXX]` marker and a
 * very long value is cut with a visible `...[truncated]` (review I1).
 */
export const clean = (text: string): string => terminalSafe(text.replace(/agx[rc]_[A-Za-z0-9_-]+/g, "[hidden]"));
type Body = Record<string, unknown>;

/** What a command prints: its JSON data (with --json) and its text. */
export interface AppResult { env: string; url: string; data: Body; text: string }

/**
 * One signed-in call to a `/v1/app/*` route. A refusal that carries the broker's words is a `ReportedFailure` that prints them as they
 * are, under the broker's code (a 409 exits 1, as a conflict the person resolves by reloading); 2xx answers, 202 included, are returned.
 */
export async function appRequest(
  deps: DeveloperSessionDeps, env: string | undefined, path: string, options: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown; headers?: Readonly<Record<string, string>> } = {},
): Promise<{ env: string; url: string; status: number; body: Body }> {
  const session = await developerAccessToken(deps, env);
  let response: Response;
  try {
    response = await deps.fetch(`${session.entry.url}${path}`, {
      method: options.method ?? "GET",
      headers: { ...options.headers, authorization: `Bearer ${session.accessToken}`, ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", `could not reach AgentX at ${session.entry.url}; check your connection and try again`);
  }
  const value: unknown = await response.json().catch(() => undefined);
  if (response.status === 401) throw agentXError("AUTH_REQUIRED", `your AgentX sign-in for ${session.env} has ended; run npx ${CLI_PACKAGE_NAME} login ${session.entry.url}`);
  if (!response.ok) {
    const error = typeof value === "object" && value !== null ? (value as { error?: { code?: unknown; message?: unknown } }).error : undefined;
    const message = typeof error?.message === "string" ? clean(error.message).trim() : "";
    if (message === "") throw agentXError("RUNTIME_UNAVAILABLE", `AgentX answered HTTP ${response.status}; try again`);
    const code = AgentXErrorCodeSchema.safeParse(error?.code);
    throw new ReportedFailure(code.success ? code.data : "REFUSED", message, response.status === 409 || !code.success ? 1 : exitCodeForError(code.data));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw agentXError("RUNTIME_UNAVAILABLE", `AgentX answered with something unexpected; try again, or upgrade: npx ${CLI_PACKAGE_NAME}@latest whoami`);
  }
  return { env: session.env, url: session.entry.url, status: response.status, body: value as Body };
}

export const result = (answer: { env: string; url: string }, data: Body, text: string): AppResult => ({ env: answer.env, url: answer.url, data: jsonSafe(data) as Body, text });
/** One path segment from an ID the person typed; `.` and `..` are refused, since a URL would read them as a step up the path (review M7). */
export const seg = (id: string): string => {
  if (id === "." || id === "..") throw agentXError("CONFIG_INVALID", "an ID cannot be . or ..");
  return encodeURIComponent(id);
};
export const str = (value: unknown, fallback = ""): string => (typeof value === "string" || typeof value === "number" ? clean(String(value)) : fallback);
export const pretty = (value: unknown): string => JSON.stringify(jsonSafe(value), null, 2);
export const list = (value: unknown): Body[] => (Array.isArray(value) ? value.filter((entry): entry is Body => typeof entry === "object" && entry !== null) : []);
export const item = (value: unknown): string => (typeof value === "string" ? clean(value) : clean(JSON.stringify(value)));

/** A JSON file the person wrote: an object, or (for shares) an array. Read before anything is sent. */
export async function readJsonFile(path: string | undefined, flag: string, shape: "object" | "array"): Promise<unknown> {
  if (path === undefined) throw agentXError("CONFIG_INVALID", `name the file with ${flag}`);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw agentXError("CONFIG_INVALID", `${flag}: could not read ${path}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw agentXError("CONFIG_INVALID", `${flag}: ${path} is not JSON`);
  }
  const fits = shape === "array" ? Array.isArray(value) : typeof value === "object" && value !== null && !Array.isArray(value);
  if (!fits) throw agentXError("CONFIG_INVALID", `${flag}: ${path} must hold a JSON ${shape}`);
  return value;
}

/** A change that waits for a person on the confirmation page, in words, or undefined when the answer is not one. */
export function waitingText(body: Body): string | undefined {
  if (body.status !== "NEEDS_CONFIRMATION" || typeof body.confirmUrl !== "string") return undefined;
  const changes = Array.isArray(body.changes) ? (body.changes as unknown[]).map((change) => `  - ${item(change)}`) : [];
  return [`This change waits for a person to confirm it. Nothing changed yet. Open: ${clean(body.confirmUrl)}`, ...changes, ""].join("\n");
}

// ---- agents

const agentLine = (agent: Body): string => {
  const version = agent.builtin === true ? `pinned v${str(agent.pinnedVersion, "?")}` : agent.currentVersion === undefined ? "unpublished" : `v${str(agent.currentVersion)}`;
  const flags = [agent.builtin === true ? "built in" : undefined, agent.disabled === true ? "turned off" : undefined, agent.status === "archived" ? "archived" : undefined].filter((flag) => flag !== undefined);
  return `  ${str(agent.agentId)}  ${str(agent.name)}  ${version}  ${str(agent.access)}${flags.length === 0 ? "" : `  (${flags.join(", ")})`}`;
};

export async function agentsList(deps: DeveloperSessionDeps, env: string | undefined, filter: { scope?: "mine" | "shared" | "builtin"; project?: string }): Promise<AppResult> {
  const query = filter.project !== undefined ? `?project=${seg(filter.project)}` : `?scope=${filter.scope ?? "all"}`;
  const answer = await appRequest(deps, env, `/v1/app/agents${query}`);
  const agents = list(answer.body.agents);
  const text = agents.length === 0 ? `No agents here on ${answer.env}. Create one with agentx agents create --name <name>.\n` : `${[`Agents on ${answer.env} (${answer.url}):`, ...agents.map(agentLine)].join("\n")}\n`;
  return result(answer, { agents }, text);
}

export async function agentsShow(deps: DeveloperSessionDeps, env: string | undefined, agentId: string): Promise<AppResult> {
  const answer = await appRequest(deps, env, `/v1/app/agents/${seg(agentId)}`);
  const agent = (answer.body.agent ?? {}) as Body;
  const current = answer.body.current as Body | undefined;
  const lines = [
    `${str(agent.name)} (${str(agent.agentId)})${agent.builtin === true ? ", built in" : ""}`,
    ...(str(agent.description) === "" ? [] : [`  ${str(agent.description)}`]),
    `  your access: ${str(agent.access)}; status: ${str(agent.status)}`,
    current === undefined ? "  not published yet" : `  runs version ${str(current.version)}${current.changed === true ? "; the draft has unpublished changes" : ""}${current.problem === undefined ? "" : ` (${str(current.problem)})`}`,
    ...(agent.monthlyBudgetUsd === undefined ? [] : [`  monthly budget: $${str(agent.monthlyBudgetUsd)}`]),
    ...(answer.body.maxPerRunUsd === undefined ? [] : [`  most per run: $${str(answer.body.maxPerRunUsd)}`]),
    ...(answer.body.suggestedMaxPerRunUsd === undefined ? [] : [`  suggested most per run: $${str(answer.body.suggestedMaxPerRunUsd)}`]),
  ];
  return result(answer, answer.body, `${lines.join("\n")}\n`);
}

/** The org member an email or developer ID names, as the `{ developerId }` the routes take. */
export async function developerRef(deps: DeveloperSessionDeps, env: string | undefined, who: string): Promise<{ developerId: string; name: string }> {
  const { member } = await resolveOrgMember(deps, env, who);
  return { developerId: member.developerId, name: member.name };
}

export async function agentsCreate(
  deps: DeveloperSessionDeps, env: string | undefined, input: { name?: string; description?: string; extends?: string; projectOwner?: string; accountable?: string },
): Promise<AppResult> {
  if (input.name === undefined || input.name.trim() === "") throw agentXError("CONFIG_INVALID", "name the agent with --name");
  if (input.accountable !== undefined && input.projectOwner === undefined) throw agentXError("CONFIG_INVALID", "--accountable names who answers for a project's agent; give the project with --project-owner");
  const accountable = input.accountable === undefined ? undefined : await developerRef(deps, env, input.accountable);
  const answer = await appRequest(deps, env, "/v1/app/agents", {
    method: "POST",
    body: {
      requestId: randomUUID(), name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.projectOwner === undefined ? {} : { owner: { kind: "project", project: input.projectOwner } }),
      ...(accountable === undefined ? {} : { accountable: { developerId: accountable.developerId } }),
      ...(input.extends === undefined ? {} : { extends: input.extends }),
    },
  });
  const agent = (answer.body.agent ?? {}) as Body;
  return result(answer, answer.body, `Created ${str(agent.name)} (${str(agent.agentId)}). Edit its draft with agentx agents draft set ${str(agent.agentId)} --file <overlay.json>, then publish it.\n`);
}

async function draftOf(deps: DeveloperSessionDeps, env: string | undefined, agentId: string) {
  const answer = await appRequest(deps, env, `/v1/app/agents/${seg(agentId)}/draft`);
  const draft = (answer.body.draft ?? {}) as Body;
  if (typeof draft.revision !== "number") throw agentXError("RUNTIME_UNAVAILABLE", "AgentX answered with a draft that has no revision; try again");
  return { answer, draft, revision: draft.revision };
}

const draftText = (agentId: string, draft: Body): string => `Draft of ${clean(agentId)} at revision ${str(draft.revision)}${draft.extends === undefined ? "" : `, building on ${item(draft.extends)}`}:\n${pretty(draft.overlay ?? {})}\n`;

export async function agentsDraftGet(deps: DeveloperSessionDeps, env: string | undefined, agentId: string): Promise<AppResult> {
  const { answer, draft } = await draftOf(deps, env, agentId);
  return result(answer, { draft }, draftText(agentId, draft));
}

/** Saves an overlay as the draft, at the revision read just before, so someone else's edit since is a conflict, not lost. */
export async function agentsDraftSet(deps: DeveloperSessionDeps, env: string | undefined, agentId: string, file: string | undefined): Promise<AppResult> {
  const overlay = await readJsonFile(file, "--file", "object");
  const { revision } = await draftOf(deps, env, agentId);
  const answer = await appRequest(deps, env, `/v1/app/agents/${seg(agentId)}/draft`, { method: "PUT", body: { requestId: randomUUID(), expectedRevision: revision, overlay } });
  const draft = (answer.body.draft ?? {}) as Body;
  return result(answer, answer.body, `Saved the draft of ${clean(agentId)}; it is at revision ${str(draft.revision)}. Publish it with agentx agents publish ${clean(agentId)}.\n`);
}

export async function agentsPublish(deps: DeveloperSessionDeps, env: string | undefined, agentId: string, note: string | undefined): Promise<AppResult> {
  const { revision } = await draftOf(deps, env, agentId);
  const answer = await appRequest(deps, env, `/v1/app/agents/${seg(agentId)}/publish`, { method: "POST", body: { requestId: randomUUID(), expectedRevision: revision, ...(note === undefined ? {} : { note }) } });
  const version = (answer.body.version ?? {}) as Body;
  return result(answer, answer.body, waitingText(answer.body) ?? `Published ${clean(agentId)} as version ${str(version.version)}; new runs use it.\n`);
}

/** What a version list says of a version against the one that runs now (owner decision 2026-10-22): a run of a less safe one needs the agent's owner's OK. */
function safetyMark(version: Body): string {
  if (version.safety === "less_safe") return "  less safe than the current version, needs the owner's OK";
  return version.safety === "same_or_safer" ? "  same or safer" : "";
}

export async function agentsVersions(deps: DeveloperSessionDeps, env: string | undefined, agentId: string): Promise<AppResult> {
  const answer = await appRequest(deps, env, `/v1/app/agents/${seg(agentId)}/versions`);
  const versions = list(answer.body.versions);
  const lines = versions.map((version) => `  v${str(version.version)}${version.current === true ? " (runs now)" : ""}  ${str(version.publishedAt ?? version.releasedIn)}${safetyMark(version)}${version.note === undefined && version.notes === undefined ? "" : `  ${str(version.note ?? version.notes)}`}`);
  return result(answer, { versions }, `${[`Versions of ${clean(agentId)}:`, ...lines].join("\n")}\n`);
}

export async function agentsDiff(deps: DeveloperSessionDeps, env: string | undefined, agentId: string, from: string, to: string): Promise<AppResult> {
  const answer = await appRequest(deps, env, `/v1/app/agents/${seg(agentId)}/diff?from=${seg(from)}&to=${seg(to)}`);
  const changes = Array.isArray(answer.body.changes) ? answer.body.changes as unknown[] : [];
  const lessSafe = Array.isArray(answer.body.lessSafe) ? answer.body.lessSafe as unknown[] : [];
  const lines = changes.length === 0 ? [`No differences between ${clean(from)} and ${clean(to)}.`] : [`From ${clean(from)} to ${clean(to)}:`, ...changes.map((change) => `  ${item(change)}`)];
  if (lessSafe.length > 0) lines.push("Less safe:", ...lessSafe.map((change) => `  ${item(change)}`));
  return result(answer, answer.body, `${lines.join("\n")}\n`);
}

export const positive = (raw: string, what: string): number => {
  if (!/^[1-9][0-9]{0,5}$/.test(raw)) throw agentXError("CONFIG_INVALID", `${what} must be a version number, such as 2`);
  return Number(raw);
};

export async function agentsRollback(deps: DeveloperSessionDeps, env: string | undefined, agentId: string, version: string): Promise<AppResult> {
  const body = { requestId: randomUUID(), version: positive(version, "the version") };
  const answer = await appRequest(deps, env, `/v1/app/agents/${seg(agentId)}/rollback`, { method: "POST", body });
  return result(answer, answer.body, waitingText(answer.body) ?? `${clean(agentId)} runs version ${body.version} again.\n`);
}

export async function agentsUpdateBase(deps: DeveloperSessionDeps, env: string | undefined, agentId: string): Promise<AppResult> {
  const { revision } = await draftOf(deps, env, agentId);
  const answer = await appRequest(deps, env, `/v1/app/agents/${seg(agentId)}/update-base`, { method: "POST", body: { requestId: randomUUID(), expectedRevision: revision } });
  const changes = Array.isArray(answer.body.changes) ? answer.body.changes as unknown[] : [];
  const text = changes.length === 0 ? `The draft of ${clean(agentId)} already builds on the latest base.\n` : `${[`The draft of ${clean(agentId)} now builds on the latest base. What changed:`, ...changes.map((change) => `  ${item(change)}`)].join("\n")}\nPublish it to use it.\n`;
  return result(answer, answer.body, text);
}

export async function agentsAdopt(deps: DeveloperSessionDeps, env: string | undefined, builtinId: string, version: string): Promise<AppResult> {
  const body = { requestId: randomUUID(), version: positive(version, "the version") };
  const answer = await appRequest(deps, env, `/v1/app/agents/${seg(builtinId)}/adopt`, { method: "POST", body });
  return result(answer, answer.body, waitingText(answer.body) ?? `Your company now runs ${clean(builtinId)} at version ${str(answer.body.pinnedVersion ?? body.version)}.\n`);
}

export async function agentsShare(deps: DeveloperSessionDeps, env: string | undefined, agentId: string, file: string | undefined): Promise<AppResult> {
  const shares = await readJsonFile(file, "--file", "array");
  const answer = await appRequest(deps, env, `/v1/app/agents/${seg(agentId)}/shares`, { method: "PUT", body: { requestId: randomUUID(), shares } });
  return result(answer, answer.body, waitingText(answer.body) ?? `${clean(agentId)} is now shared with ${list(answer.body.shares).length} ${list(answer.body.shares).length === 1 ? "principal" : "principals"}.\n`);
}

export async function agentsArchive(deps: DeveloperSessionDeps, env: string | undefined, agentId: string, archive: boolean): Promise<AppResult> {
  const answer = await appRequest(deps, env, `/v1/app/agents/${seg(agentId)}/${archive ? "archive" : "unarchive"}`, { method: "POST", body: { requestId: randomUUID() } });
  return result(answer, answer.body, archive ? `Archived ${clean(agentId)}; it no longer runs. Bring it back with agentx agents unarchive ${clean(agentId)}.\n` : `${clean(agentId)} is active again.\n`);
}

export async function agentsAccountable(deps: DeveloperSessionDeps, env: string | undefined, agentId: string, who: string): Promise<AppResult> {
  const person = await developerRef(deps, env, who);
  const answer = await appRequest(deps, env, `/v1/app/agents/${seg(agentId)}/accountable`, { method: "PUT", body: { requestId: randomUUID(), accountable: { developerId: person.developerId } } });
  return result(answer, answer.body, `${clean(person.name)} now answers for ${clean(agentId)}.\n`);
}

export async function agentsRun(
  deps: DeveloperSessionDeps, env: string | undefined, agentId: string, input: { project?: string; input?: string; draft: boolean; version?: string },
): Promise<AppResult> {
  if (input.project === undefined) throw agentXError("CONFIG_INVALID", "name the project to run it on with --project");
  if (input.input === undefined || input.input.trim() === "") throw agentXError("CONFIG_INVALID", "say what the agent is asked with --input <text>");
  if (input.draft && input.version !== undefined) throw agentXError("CONFIG_INVALID", "--draft and --version each pick what runs; give one");
  const version = input.draft ? "draft" as const : input.version === undefined ? undefined : positive(input.version, "--version");
  const answer = await appRequest(deps, env, `/v1/app/agents/${seg(agentId)}/runs`, {
    method: "POST", body: { requestId: randomUUID(), project: input.project, ...(version === undefined ? {} : { version }), input: { text: input.input } },
  });
  if (answer.body.status === "NEEDS_OWNER_APPROVAL" && typeof answer.body.confirmUrl === "string") {
    const changes = Array.isArray(answer.body.changes) ? (answer.body.changes as unknown[]).map((change) => `  - ${item(change)}`) : [];
    return result(answer, answer.body, [`This run of ${clean(agentId)}${version === undefined ? "" : ` version ${version}`} waits for the agent's owner to OK it. Nothing started yet; it starts once they approve it. Open: ${clean(answer.body.confirmUrl)}`, ...changes, ""].join("\n"));
  }
  const task = (answer.body.task ?? {}) as Body;
  return result(answer, answer.body, `Started ${clean(agentId)}${version === "draft" ? " (its draft, as a test run)" : version === undefined ? "" : ` version ${version}`} on ${clean(input.project)}: task ${str(task.taskId)}: ${taskStatusLine(task)}.\n`);
}

// ---- a project's agents and connectors

export async function projectAgentsChange(deps: DeveloperSessionDeps, env: string | undefined, project: string, agentId: string, add: boolean): Promise<AppResult> {
  const answer = await appRequest(deps, env, `/v1/app/projects/${seg(project)}/agents/${seg(agentId)}`, { method: add ? "PUT" : "DELETE", body: { requestId: randomUUID() } });
  const text = add ? `${clean(agentId)} now works on ${clean(project)}.\n` : answer.body.removed === false ? `${clean(agentId)} was not on ${clean(project)}; nothing changed.\n` : `${clean(agentId)} no longer works on ${clean(project)}.\n`;
  return result(answer, answer.body, text);
}

async function connectorsOf(deps: DeveloperSessionDeps, env: string | undefined, project: string) {
  const answer = await appRequest(deps, env, `/v1/app/projects/${seg(project)}/connectors`);
  if (typeof answer.body.revision !== "number") throw agentXError("RUNTIME_UNAVAILABLE", "AgentX answered without the project's revision; try again");
  return { answer, revision: answer.body.revision };
}

export async function projectConnectorsList(deps: DeveloperSessionDeps, env: string | undefined, project: string): Promise<AppResult> {
  const { answer } = await connectorsOf(deps, env, project);
  const connectors = list(answer.body.connectors);
  const lines = connectors.map((connector) => {
    const tools = list(connector.tools).map((tool) => `${str(tool.name)} (${str(tool.access)})`).join(", ");
    return `  ${str(connector.name)}  ${str(connector.type)}  ${str(connector.status)}${tools === "" ? "" : `  ${tools}`}${connector.problem === undefined ? "" : `  ${str(connector.problem)}`}`;
  });
  const text = connectors.length === 0 ? `${clean(project)} has no connectors yet.\n` : `${[`Connectors of ${clean(project)} at revision ${str(answer.body.revision)}:`, ...lines].join("\n")}\n`;
  return result(answer, answer.body, text);
}

/** Saves a connector from a file; the file's `name` may be left out (it is the argument's), but a file naming another connector is refused. */
export async function projectConnectorsSet(deps: DeveloperSessionDeps, env: string | undefined, project: string, name: string, file: string | undefined): Promise<AppResult> {
  const read = await readJsonFile(file, "--file", "object") as Body;
  if (read.name !== undefined && read.name !== name) throw agentXError("CONFIG_INVALID", `--file: the connector in ${file} is named ${terminalSafe(JSON.stringify(read.name))}, not ${clean(name)}`);
  const connector = { ...read, name };
  const { revision } = await connectorsOf(deps, env, project);
  const answer = await appRequest(deps, env, `/v1/app/projects/${seg(project)}/connectors/${seg(name)}`, { method: "PUT", body: { requestId: randomUUID(), expectedRevision: revision, connector } });
  if (answer.body.status === "EXECUTING") {
    return result(answer, answer.body, `The change to the connector ${clean(name)} on ${clean(project)} is being applied; check it with agentx project connectors list ${clean(project)}.\n`);
  }
  return result(answer, answer.body, waitingText(answer.body) ?? `Saved the connector ${clean(name)} on ${clean(project)}${answer.body.revision === undefined ? "" : ` (revision ${str(answer.body.revision)})`}.\n`);
}

export async function projectConnectorsRemove(deps: DeveloperSessionDeps, env: string | undefined, project: string, name: string): Promise<AppResult> {
  const { revision } = await connectorsOf(deps, env, project);
  const answer = await appRequest(deps, env, `/v1/app/projects/${seg(project)}/connectors/${seg(name)}`, { method: "DELETE", body: { requestId: randomUUID(), expectedRevision: revision } });
  return result(answer, answer.body, `Removed the connector ${clean(name)} from ${clean(project)}.\n`);
}

const triggersPath = (project: string) => `/v1/app/projects/${seg(project)}/connectors/github/comment-triggers`;

async function commentTriggerScan(deps: DeveloperSessionDeps, env: string | undefined, project: string, repository: string) {
  const answer = await appRequest(deps, env, `${triggersPath(project)}?repository=${seg(repository)}`);
  const scanned = list(answer.body.repositories).find((entry) => typeof entry.repository === "string" && entry.repository.toLowerCase() === repository.toLowerCase());
  if (scanned === undefined) throw agentXError("NOT_FOUND", `AgentX did not scan ${clean(repository)}; check it is one of ${clean(project)}'s repositories`);
  return { answer, scanned };
}

/** What the scan found: whether workflows act on comments, the files it read and the digest an opt-out names. */
export async function commentTriggersShow(deps: DeveloperSessionDeps, env: string | undefined, project: string, repository: string): Promise<AppResult> {
  const { answer, scanned } = await commentTriggerScan(deps, env, project, repository);
  const files = Array.isArray(scanned.files) ? scanned.files as unknown[] : [];
  const optOut = scanned.optOut as Body | undefined;
  const lines = [
    `${str(scanned.repository)}: ${scanned.failedClosed === true ? "the scan could not finish, so agent comments wait for a person" : scanned.triggers === true ? "workflows act on comments, so agent comments wait for a person" : "no workflow acts on comments"}`,
    ...(scanned.hint === undefined ? [] : [`  ${str(scanned.hint)}`]),
    `  digest: ${str(scanned.digest)}`,
    `  files read:${files.length === 0 ? " none" : ""}`, ...files.map((file) => `    ${item(file)}`),
    ...(optOut === undefined ? [] : [`  opted out: ${str(optOut.reason)}`]),
    ...(answer.body.coverage === undefined ? [] : [str(answer.body.coverage)]),
  ];
  return result(answer, answer.body, `${lines.join("\n")}\n`);
}

/** Asks for an opt-out of exactly the workflows just shown: the scan's digest is sent, so a change since is refused. An org admin confirms it on the page. */
export async function commentTriggersOptOut(deps: DeveloperSessionDeps, env: string | undefined, project: string, repository: string, reason: string | undefined): Promise<AppResult> {
  if (reason === undefined || reason.trim() === "") throw agentXError("CONFIG_INVALID", "say why agent comments are safe in this repository with --reason <text>");
  const { scanned } = await commentTriggerScan(deps, env, project, repository);
  const answer = await appRequest(deps, env, triggersPath(project), { method: "PUT", body: { requestId: randomUUID(), repository: scanned.repository, expectedDigest: scanned.digest, reason } });
  return result(answer, answer.body, waitingText(answer.body) ?? `Asked for the opt-out of ${clean(repository)}.\n`);
}

// ---- skills

export async function skillsAdd(deps: DeveloperSessionDeps, env: string | undefined, file: string | undefined): Promise<AppResult> {
  if (file === undefined) throw agentXError("CONFIG_INVALID", "name the SKILL.md with --file");
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch {
    throw agentXError("CONFIG_INVALID", `--file: could not read ${file}`);
  }
  const answer = await appRequest(deps, env, "/v1/app/skills", { method: "POST", body: { requestId: randomUUID(), content } });
  const skill = (answer.body.skill ?? {}) as Body;
  return result(answer, answer.body, `Added the skill ${str(skill.name)} (${str(skill.skillId)}).\n`);
}

export async function skillsList(deps: DeveloperSessionDeps, env: string | undefined): Promise<AppResult> {
  const answer = await appRequest(deps, env, "/v1/app/skills");
  const skills = list(answer.body.skills);
  const text = skills.length === 0 ? "Your organization has no skills yet. Add one with agentx skills add --file SKILL.md.\n"
    : `${["Skills of your organization:", ...skills.map((skill) => `  ${str(skill.skillId)}  ${str(skill.name)}  ${str(skill.description)}`)].join("\n")}\n`;
  return result(answer, { skills }, text);
}

// ---- approvals (R66: read and link only)

export async function approvalsList(deps: DeveloperSessionDeps, env: string | undefined): Promise<AppResult> {
  const answer = await appRequest(deps, env, "/v1/app/approvals?status=PENDING");
  const approvals = list(answer.body.approvals);
  const lines = approvals.map((approval) => `  ${str(approval.approvalId)}  ${str(approval.kind)}  ${str(approval.summary ?? approval.prompt ?? approval.subjectKind)}  until ${str(approval.expiresAt)}`);
  const text = approvals.length === 0 ? "Nothing waits for your approval.\n" : `${["Waiting for your approval (decide each on its page: agentx approvals open <id>):", ...lines].join("\n")}\n`;
  return result(answer, { approvals }, text);
}

export async function approvalsShow(deps: DeveloperSessionDeps, env: string | undefined, approvalId: string): Promise<AppResult> {
  const answer = await appRequest(deps, env, `/v1/app/approvals/${seg(approvalId)}`);
  const approval = (answer.body.approval ?? {}) as Body;
  const lines = [
    `${str(approval.approvalId)}  ${str(approval.kind)}  ${str(approval.status)}`,
    ...(approval.summary === undefined ? [] : [`  ${str(approval.summary)}`]),
    ...(approval.connector === undefined ? [] : [`  ${str(approval.connector)} ${str(approval.tool)} on ${str(approval.project)}`]),
    ...(approval.prompt === undefined ? [] : [`  ${str(approval.prompt)}`]),
    ...(approval.changes === undefined ? [] : (Array.isArray(approval.changes) ? approval.changes as unknown[] : []).map((change) => `  - ${item(change)}`)),
    ...(approval.arguments === undefined ? [] : ["Arguments:", pretty(approval.arguments)]),
    `Decide it on its page: ${str(approval.confirmUrl)}`,
  ];
  return result(answer, answer.body, `${lines.join("\n")}\n`);
}

/** The link as a URL a browser may be handed: https, on the signed-in cell's own origin, under its confirmation pages; otherwise undefined (review M3). */
function confirmationPage(raw: string, cellUrl: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.origin === new URL(cellUrl).origin && url.pathname.startsWith("/v1/app/approve/") ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The confirmation page's link for one approval (ticketed for a person who may decide it now). Nothing is decided here. `openUrl` is set only
 * when the link is this cell's own confirmation page; any other link is printed, never handed to a browser.
 */
export const approvalsConfirmLink = (deps: DeveloperSessionDeps, env: string | undefined, approvalId: string): Promise<AppResult & { openUrl?: string }> =>
  confirmLink(deps, env, `/v1/app/approvals/${seg(approvalId)}/confirm-link`);

/** The same for a spend request (`agentx spend-requests open`): its page is the one place it is decided. */
export const spendRequestConfirmLink = (deps: DeveloperSessionDeps, env: string | undefined, spendRequestId: string): Promise<AppResult & { openUrl?: string }> =>
  confirmLink(deps, env, `/v1/app/spend-requests/${seg(spendRequestId)}/confirm-link`);

async function confirmLink(deps: DeveloperSessionDeps, env: string | undefined, path: string): Promise<AppResult & { openUrl?: string }> {
  const answer = await appRequest(deps, env, path, { method: "POST" });
  if (typeof answer.body.confirmUrl !== "string") throw agentXError("RUNTIME_UNAVAILABLE", "AgentX answered without the confirmation link; try again");
  const openUrl = confirmationPage(answer.body.confirmUrl, answer.url);
  const text = `Approve or decline it on its page: ${clean(answer.body.confirmUrl)}\n${openUrl === undefined ? "That is not this AgentX's confirmation page, so it was not opened.\n" : ""}`;
  return { ...result(answer, answer.body, text), ...(openUrl === undefined ? {} : { openUrl }) };
}

// ---- the org's guardrails and AI sources

const GUARDRAILS = "/v1/app/org/agent-guardrails";

export async function guardrailsShow(deps: DeveloperSessionDeps, env: string | undefined): Promise<AppResult> {
  const answer = await appRequest(deps, env, GUARDRAILS);
  return result(answer, answer.body, `Your company's agent guardrails (revision ${str(answer.body.revision)}):\n${pretty(answer.body.guardrails ?? {})}\n`);
}

export async function guardrailsSet(deps: DeveloperSessionDeps, env: string | undefined, file: string | undefined): Promise<AppResult> {
  const guardrails = await readJsonFile(file, "--file", "object");
  const current = await appRequest(deps, env, GUARDRAILS);
  if (typeof current.body.revision !== "number") throw agentXError("RUNTIME_UNAVAILABLE", "AgentX answered without the guardrails' revision; try again");
  const answer = await appRequest(deps, env, GUARDRAILS, { method: "PUT", body: { requestId: randomUUID(), expectedRevision: current.body.revision, guardrails } });
  return result(answer, answer.body, waitingText(answer.body) ?? "Saved your company's agent guardrails.\n");
}

const SOURCES = "/v1/app/org/model-sources";

export async function sourcesList(deps: DeveloperSessionDeps, env: string | undefined): Promise<AppResult> {
  const answer = await appRequest(deps, env, SOURCES);
  const sources = list(answer.body.sources);
  const lines = sources.map((source) => `  ${str(source.sourceId)}  ${str(source.kind)}  ${str(source.label)}  ${source.hasCredential === true ? "key saved" : "no key"}${source.hostStatus === undefined ? "" : `  host ${str(source.hostStatus)}`}`);
  const order = Array.isArray(answer.body.order) ? (answer.body.order as unknown[]).map(item).join(", ") : "";
  return result(answer, answer.body, `${["Your company's AI sources:", ...lines, `Tried in this order: ${order}`].join("\n")}\n`);
}

/**
 * Adds a source. Its key is read only from the environment variable `--key-from-env` names (set there by a secrets wrapper such as asm-exec),
 * never from a flag, so it is not in the shell history or the process list; it is sent once and never printed.
 */
export async function sourcesAdd(deps: DeveloperSessionDeps, env: string | undefined, input: { file?: string; keyFromEnv?: string; key?: string }, processEnv: Readonly<Record<string, string | undefined>>): Promise<AppResult> {
  if (input.key !== undefined) throw agentXError("CONFIG_INVALID", "a provider key is never taken as a flag; put it in an environment variable (for example with asm-exec) and name it with --key-from-env <VAR>");
  const source = await readJsonFile(input.file, "--file", "object");
  let apiKey: string | undefined;
  if (input.keyFromEnv !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.keyFromEnv)) throw agentXError("CONFIG_INVALID", "--key-from-env takes the name of an environment variable");
    apiKey = processEnv[input.keyFromEnv]?.trim();
    // The name is repeated only when it reads as a variable's name: a key pasted in its place is never printed (review M5).
    const named = /^[A-Z_][A-Z0-9_]{0,63}$/.test(input.keyFromEnv) ? `the environment variable ${input.keyFromEnv}` : "the environment variable --key-from-env names";
    if (apiKey === undefined || apiKey === "") throw agentXError("CONFIG_INVALID", `${named} is not set or is empty`);
  }
  const answer = await appRequest(deps, env, SOURCES, { method: "POST", body: { requestId: randomUUID(), source, ...(apiKey === undefined ? {} : { apiKey }) } });
  // A server that echoed the key would have it printed; it is taken out of the answer first, in text and in --json (review M4).
  const body = apiKey === undefined ? answer.body : withoutSecret(answer.body, apiKey) as Body;
  const extra = [body.message, body.warning].filter((line): line is string => typeof line === "string").map((line) => `${clean(line)}\n`).join("");
  return result(answer, body, `Added the AI source ${str(answer.body.sourceId)}. Test it with agentx org sources check ${str(answer.body.sourceId)}.\n${extra}`);
}

/** Every string in a value with the secret replaced by [REDACTED]. */
function withoutSecret(value: unknown, secret: string): unknown {
  if (typeof value === "string") return value.split(secret).join("[REDACTED]");
  if (Array.isArray(value)) return value.map((child) => withoutSecret(child, secret));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, withoutSecret(child, secret)]));
  return value;
}

export async function sourcesRemove(deps: DeveloperSessionDeps, env: string | undefined, sourceId: string): Promise<AppResult> {
  const answer = await appRequest(deps, env, `${SOURCES}/${seg(sourceId)}`, { method: "DELETE", body: { requestId: randomUUID() } });
  return result(answer, answer.body, `Removed the AI source ${clean(sourceId)}.\n`);
}

export async function sourcesOrder(deps: DeveloperSessionDeps, env: string | undefined, order: readonly string[]): Promise<AppResult> {
  if (order.length === 0) throw agentXError("CONFIG_INVALID", "name the sources in the order to try them");
  const answer = await appRequest(deps, env, "/v1/app/org/model-sources-order", { method: "PUT", body: { requestId: randomUUID(), order } });
  return result(answer, answer.body, `Your company's AI sources are now tried in this order: ${order.map(clean).join(", ")}.\n`);
}

export async function sourcesCheck(deps: DeveloperSessionDeps, env: string | undefined, sourceId: string): Promise<AppResult> {
  const answer = await appRequest(deps, env, `${SOURCES}/${seg(sourceId)}/check`, { method: "POST" });
  if (answer.body.ok !== true) throw new ReportedFailure("SOURCE_CHECK_FAILED", `The AI source ${clean(sourceId)} did not pass its check${answer.body.message === undefined ? "" : `: ${str(answer.body.message)}`}.`);
  return result(answer, answer.body, `The AI source ${clean(sourceId)} works.\n`);
}

/** UX2 slice 2: a task's status in the one status model's words, never the raw code (a server from before the model is read through the same words). */
const PLAIN_STATUS_WORDS: Record<string, string> = {
  STARTING: "Understanding the request", RUNNING: "Building", SUCCEEDED: "Finished its run", FAILED: "Failed: the run stopped with an error", CANCELLED: "Stopped", INTERRUPTED: "Failed: the run was interrupted", CLOSED: "Closed",
};
export function taskStatusLine(task: Record<string, unknown>): string {
  const view = TaskStatusSchema.safeParse(task["statusView"]);
  if (view.success) return clean(taskStatusText(view.data));
  return typeof task["status"] === "string" ? PLAIN_STATUS_WORDS[task["status"]] ?? "Status unavailable" : "Status unavailable";
}
