// agentx whoami and agentx logout (FR-011).
import { CLI_PACKAGE_NAME, TASK_VIEW_HEADER, TASK_VIEW_VERSION, AGENTX_CLI_CLIENT_ID, AgentXError, AgentXErrorCodeSchema, AppMeResponseSchema, AppProjectDetailSchema, ProjectArchiveResponseSchema, ProjectSettingsResponseSchema, type AppProjectDetail, type ProjectSettingsBody, type ProjectSettingsResponse, DeveloperCreateProjectResponseSchema, DeveloperProjectsResponseSchema, StartIdentityLinkAppResponseSchema, UnlinkIdentityAppResponseSchema, UnlinkableSignInMethodSchema, agentXError, type DeveloperCreateProjectResponse, type DeveloperProject, type DeveloperProjectsResponse, type LinkedIdentity } from "@agentx/contracts";
import { sanitizeServerText } from "../auth.js";
import { developerTokenKey, removeDeveloperEnvironment, resolveDeveloperEnvironment } from "./config.js";
import { developerAccessToken, type DeveloperSessionDeps } from "./session.js";

/**
 * One signed-in GET against a `/v1/dev/*` route, parsed with the route's schema. Every failure is
 * told apart the same way for every route: unreachable, a sign-in that has ended, an HTTP error,
 * and a body this CLI cannot read.
 */
export async function developerGet<T>(
  deps: DeveloperSessionDeps,
  env: string | undefined,
  path: string,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
): Promise<{ env: string; url: string; body: T }> {
  return developerRequest(deps, env, path, schema);
}

/**
 * developerGet for any method. `explain` shows the server's reason for a refusal (400, 403, 404)
 * instead of only its status: for routes whose refusals are the developer's to act on.
 */
export async function developerRequest<T>(
  deps: DeveloperSessionDeps,
  env: string | undefined,
  path: string,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  options: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown; explain?: boolean } = {},
): Promise<{ env: string; url: string; body: T }> {
  const session = await developerAccessToken(deps, env);
  let response: Response;
  try {
    response = await deps.fetch(`${session.entry.url}${path}`, {
      method: options.method ?? "GET",
      headers: { authorization: `Bearer ${session.accessToken}`, [TASK_VIEW_HEADER]: TASK_VIEW_VERSION, ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", `could not reach AgentX at ${session.entry.url}; check your connection and try again`);
  }
  if (response.status === 401) {
    const reason = refusalReason(await response.json().catch(() => undefined));
    throw agentXError("AUTH_REQUIRED", `your AgentX sign-in for ${session.env} has ended${reason === undefined ? "" : ` (${reason})`}; run npx ${CLI_PACKAGE_NAME} login ${session.entry.url}`);
  }
  if (options.explain === true && (response.status === 400 || response.status === 403 || response.status === 404 || response.status === 409)) {
    const refusal = await response.json().catch(() => undefined);
    const reason = refusalMessage(refusal);
    // A 409 is a refusal the person can act on (such as LAST_OWNER), shown as the server worded it, under the code it named.
    const named = AgentXErrorCodeSchema.safeParse((refusal as { error?: { code?: unknown } } | undefined)?.error?.code);
    // A 403 that asks for a fresh sign-in (REAUTH_REQUIRED) keeps its code, so the caller can run one; any other 403 is FORBIDDEN.
    const forbidden = named.success && named.data === "REAUTH_REQUIRED" ? "REAUTH_REQUIRED" : "FORBIDDEN";
    if (reason !== undefined) throw agentXError(response.status === 400 ? "CONFIG_INVALID" : response.status === 403 ? forbidden : response.status === 409 ? (named.success ? named.data : "CONFIG_INVALID") : "NOT_FOUND", reason);
  }
  if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `AgentX answered HTTP ${response.status}; try again`);
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", `AgentX answered with something unexpected; try again, or upgrade: npx ${CLI_PACKAGE_NAME}@latest whoami`);
  return { env: session.env, url: session.entry.url, body: parsed.data };
}

export async function fetchDeveloperProjects(deps: DeveloperSessionDeps, env: string | undefined): Promise<{ env: string; url: string; projects: DeveloperProjectsResponse }> {
  const { env: resolved, url, body } = await developerGet(deps, env, "/v1/dev/projects", DeveloperProjectsResponseSchema);
  return { env: resolved, url, projects: body };
}

/**
 * The sign-in methods linked to the signed-in developer, for whoami. Best effort: a server without GET /v1/app/me, or any failure
 * reading it, leaves whoami as it was (no identities listed).
 */
export async function fetchLinkedIdentities(deps: DeveloperSessionDeps, env: string | undefined): Promise<LinkedIdentity[]> {
  try {
    return (await developerGet(deps, env, "/v1/app/me", AppMeResponseSchema)).body.identities;
  } catch {
    return [];
  }
}

/**
 * The broker's own words for a refusal (error.message), without its trailing hint, made safe to
 * show. Every one describes a token that was already verified (a bad token gets one generic line),
 * so it tells a caller only about their own sign-in.
 */
function refusalReason(body: unknown): string | undefined {
  const message = refusalMessage(body);
  if (message === undefined) return undefined;
  const reason = (message.split("; ")[0] ?? "").trim();
  return reason === "" ? undefined : reason;
}

/** The broker's whole message for a refusal, hint included, made safe to show. */
function refusalMessage(body: unknown): string | undefined {
  const message = typeof body === "object" && body !== null ? (body as { error?: { message?: unknown } }).error?.message : undefined;
  if (typeof message !== "string") return undefined;
  const text = sanitizeServerText(message).trim();
  return text === "" ? undefined : text;
}

/** How a developer signed in, for whoami: "Rovara sign-in" and "GitHub" are Rovara Cloud's. */
const SIGN_IN_METHOD_TEXT = { slack: "Slack", oidc: "your company sign-in", saml: "your company sign-in (SAML)", cloud: "Rovara sign-in", github: "GitHub" } as const;

/** The channels a Slack-channel role comes through: `#name` when it has a public name, else the channel's ID. */
const channelText = (project: DeveloperProject) => project.channels.map((channel) => (channel.name === undefined ? channel.channelId : `#${sanitizeServerText(channel.name)}`)).join(", ");

/**
 * What a person is in one project, and why (Plan 2, Task 21): "maintainer (you created it)", "<role> (added by <name>)", "maintainer (as org
 * owner|admin)" or "contributor (through #<channel>)". A control plane from before project roles sends none, and the line says only how.
 */
function projectRoleText(project: DeveloperProject, developer: DeveloperProjectsResponse["developer"]): string {
  if (project.role === undefined) return project.access === "granted" ? "you have access" : `through ${channelText(project)}`;
  const { role } = project;
  switch (project.roleSource) {
    case "org_role": return `${role} (as org ${developer.orgRole === "owner" || developer.orgRole === "admin" ? developer.orgRole : "owner or admin"})`;
    case "channel": return `${role} (through ${channelText(project)})`;
    default: {
      if (project.addedBy === undefined) return `${role} (added by an admin)`;
      if (project.addedBy.developerId === developer.id) return role === "maintainer" ? `${role} (you created it)` : `${role} (added by you)`;
      return `${role} (added by ${sanitizeServerText(project.addedBy.name)})`;
    }
  }
}

export function whoamiText(result: { env: string; url: string; projects: DeveloperProjectsResponse; identities?: LinkedIdentity[] }): string {
  const { developer, projects, notices } = result.projects;
  const method = SIGN_IN_METHOD_TEXT[developer.provider];
  const link = developer.slackUserId === undefined ? "" : ` (${developer.slackUserId})`;
  // The other sign-in methods of this one person (the signed-in method is already named).
  const others = (result.identities ?? []).filter((identity) => identity.provider !== developer.provider)
    .map((identity) => {
      const detail = identity.login ?? identity.email;
      return `${SIGN_IN_METHOD_TEXT[identity.provider]}${detail === undefined ? "" : ` (${sanitizeServerText(detail)})`}`;
    });
  const alsoLinked = others.length === 0 ? "" : `; also linked: ${others.join(", ")}`;
  const lines = [`Signed in to AgentX environment ${result.env} (${result.url}) as ${sanitizeServerText(developer.name)}, with ${method}${link}${alsoLinked}.`];
  if (projects.length === 0) {
    // Only Rovara Cloud signs people in with these two. There an owner or admin creates the org's projects; a member asks one.
    if (developer.provider === "cloud" || developer.provider === "github") {
      lines.push(developer.orgRole === "owner" || developer.orgRole === "admin"
        ? "Connect GitHub with agentx github connect, then: agentx project create --repository <owner/name>"
        : "You cannot use any project yet: ask your org's owner to create one.");
    } else {
      lines.push("You cannot use any project yet: join a project's Slack channel, or ask an admin for access.");
    }
  } else {
    lines.push("Projects you can use:");
    for (const project of projects) lines.push(`  ${sanitizeServerText(project.name)}: ${projectRoleText(project, developer)}`);
  }
  if (notices.includes("slack_unavailable")) lines.push("Slack could not be reached, so projects you use through a Slack channel are not listed; try again later.");
  return `${lines.join("\n")}\n`;
}

/** What `agentx signin unlink` and `agentx signin link` call each method, for their output. */
const UNLINK_METHOD_TEXT = { cloud: "Rovara sign-in (email code)", github: "GitHub" } as const;

/**
 * Runs a fresh sign-in for the environment (Plan 2, Task 8b): the browser or email-code sign-in `agentx login` does, with `exclude` (the
 * method being removed) left out of the choices. `reason` is the server's words for why one is needed.
 */
export type FreshSignIn = (input: { env: string; url: string; exclude?: "cloud" | "github"; reason: string }) => Promise<void>;

/**
 * Changing the account's sign-in methods needs a sign-in from the last ten minutes, with a method that is not the one being removed. When
 * the server says so (REAUTH_REQUIRED), this signs in again once, with `freshSignIn`, and retries the request once; a second refusal is
 * the person's to read. With no `freshSignIn` the refusal is shown at once.
 */
export async function withFreshSignIn<T>(deps: DeveloperSessionDeps, env: string | undefined, exclude: "cloud" | "github" | undefined, freshSignIn: FreshSignIn | undefined, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof AgentXError) || error.code !== "REAUTH_REQUIRED" || freshSignIn === undefined) throw error;
    const resolved = await resolveDeveloperEnvironment(deps.home, env);
    await freshSignIn({ env: resolved.env, url: resolved.entry.url, ...(exclude === undefined ? {} : { exclude }), reason: error.message.replace(/^REAUTH_REQUIRED: /, "") });
    return run();
  }
}

/**
 * `agentx signin unlink <cloud|github>` (Plan 2, Task 8 and 8b): removes one sign-in method from the signed-in developer's own account. Sessions
 * made with that method end; the others go on. The server refuses the account's only sign-in method and the one it was created with,
 * in its own words, and wants a sign-in from the last ten minutes with another method (see `withFreshSignIn`).
 */
/** The CLI changes cloud and GitHub only: the Slack link is made and removed in the web app (a signed-in browser session). */
const CliSignInMethodSchema = UnlinkableSignInMethodSchema.exclude(["slack"]);

export async function unlinkSignInMethod(deps: DeveloperSessionDeps, env: string | undefined, provider: string, freshSignIn?: FreshSignIn): Promise<{ env: string; url: string; provider: "cloud" | "github"; identities: LinkedIdentity[] }> {
  const method = CliSignInMethodSchema.safeParse(provider);
  if (!method.success) throw agentXError("CONFIG_INVALID", `unknown sign-in method ${JSON.stringify(sanitizeServerText(provider))}; use cloud or github`);
  const { env: resolved, url, body } = await withFreshSignIn(deps, env, method.data, freshSignIn,
    () => developerRequest(deps, env, `/v1/app/me/identities/${method.data}`, UnlinkIdentityAppResponseSchema, { method: "DELETE", explain: true }));
  return { env: resolved, url, provider: method.data, identities: body.identities };
}

export function unlinkText(result: { provider: "cloud" | "github"; identities: LinkedIdentity[] }): string {
  const left = result.identities.map((identity) => SIGN_IN_METHOD_TEXT[identity.provider]);
  return `Removed ${UNLINK_METHOD_TEXT[result.provider]} from your account. Sessions signed in that way have ended.\n`
    + `${left.length === 0 ? "No sign-in methods are linked." : `You can still sign in with ${left.join(", ")}.`}\n`;
}

/**
 * `agentx signin link <cloud|github>` (Plan 2, Task 8b): asks for the sign-in link that adds a method the person removed earlier back to
 * their own account. It only ever links that identity back to this account; the page the link opens says how it went. Like a removal it
 * wants a sign-in from the last ten minutes (any method).
 */
export async function linkSignInMethod(deps: DeveloperSessionDeps, env: string | undefined, provider: string, freshSignIn?: FreshSignIn): Promise<{ env: string; url: string; provider: "cloud" | "github"; authorizeUrl: string }> {
  const method = CliSignInMethodSchema.safeParse(provider);
  if (!method.success) throw agentXError("CONFIG_INVALID", `unknown sign-in method ${JSON.stringify(sanitizeServerText(provider))}; use cloud or github`);
  const { env: resolved, url, body } = await withFreshSignIn(deps, env, undefined, freshSignIn,
    () => developerRequest(deps, env, `/v1/app/me/identities/${method.data}`, StartIdentityLinkAppResponseSchema, { method: "POST", explain: true }));
  return { env: resolved, url, provider: method.data, authorizeUrl: body.authorizeUrl };
}

export function linkText(result: { provider: "cloud" | "github"; authorizeUrl: string }, browser: boolean): string {
  const method = UNLINK_METHOD_TEXT[result.provider];
  const first = browser
    ? `Opening your browser to add ${method} back to your account. If it does not open, open this link:`
    : `Open this link in a browser to add ${method} back to your account:`;
  return `${first}\n${result.authorizeUrl}\n`
    + "When the page says it was added, run agentx whoami to see it. Only a sign-in method you removed from this account can be added back.\n";
}

/**
 * `agentx project create` (Plan 2, Task 16): the signed-in owner or admin of a cloud org creates a project from a repository their org's
 * GitHub connection reaches. `requestId` makes a retry of the same command answer the same project instead of a second one.
 */
export async function createDeveloperProject(
  deps: DeveloperSessionDeps,
  env: string | undefined,
  input: { requestId: string; repository: string; name?: string; description?: string; setupCommands?: string[]; testCommands?: string[] },
): Promise<{ env: string; url: string; created: DeveloperCreateProjectResponse }> {
  const { env: resolved, url, body } = await developerRequest(deps, env, "/v1/app/projects", DeveloperCreateProjectResponseSchema, {
    method: "POST",
    body: {
      requestId: input.requestId,
      repository: input.repository,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...commandFields("setupCommand", input.setupCommands),
      ...commandFields("testCommand", input.testCommands),
    },
    explain: true,
  });
  return { env: resolved, url, created: body };
}

/**
 * A project's commands as the create route reads them: one command as the single field it has always been (so a control plane from before lists reads it), several as the whole
 * list in the order they were given.
 */
function commandFields(single: "setupCommand" | "testCommand", commands: string[] | undefined): Record<string, string | string[]> {
  if (commands === undefined || commands.length === 0) return {};
  return commands.length === 1 ? { [single]: commands[0]! } : { [`${single}s`]: commands };
}

/** What `agentx project create` prints, with the next step. */
export function createProjectText(result: { env: string; created: DeveloperCreateProjectResponse }): string {
  const name = result.created.project.definition.name;
  const first = result.created.duplicate
    ? `Project ${name} already exists in AgentX environment ${result.env} with these settings. You have access to it.`
    : `Created project ${name} in AgentX environment ${result.env}. You have access to it.`;
  return `${first}\nNext: start a task in ${name} from your coding tool (agentx mcp install connects it), or run agentx whoami to see your projects.\n`;
}

/** `agentx project show <name>` (Plan 2, Task 17): the project as the app shows it, through `GET /v1/app/projects/{name}`. */
export async function showDeveloperProject(deps: DeveloperSessionDeps, env: string | undefined, name: string): Promise<{ env: string; url: string; project: AppProjectDetail }> {
  const { env: resolved, url, body } = await developerRequest(deps, env, `/v1/app/projects/${encodeURIComponent(name)}`, AppProjectDetailSchema, { explain: true });
  return { env: resolved, url, project: body };
}

const clean = sanitizeServerText;

/** What `agentx project show` prints: the revision, the people-facing settings and each domain's status. */
export function projectShowText(project: AppProjectDetail): string {
  const { settings } = project;
  const lines = [
    `${clean(project.name)}  (${project.status}, revision ${String(project.latestRevision)}, you are a ${project.myRole})`,
    ...(project.description === undefined ? [] : [clean(project.description)]),
    `Setup check: ${project.setup.status}${project.setup.failedStep === undefined ? "" : ` (${clean(project.setup.failedStep)})`}`,
    "Repositories:",
    ...project.repositories.map((repository) => `  ${clean(repository.fullName)}  (${clean(repository.defaultBranch)})`),
    "Setup commands:",
    ...(settings.setupCommands.length === 0 ? ["  none"] : settings.setupCommands.map((command) => `  ${clean(command)}`)),
    "Test commands:",
    ...(settings.testCommands.length === 0 ? ["  none"] : settings.testCommands.map((command) => `  ${clean(command)}`)),
    `Devcontainer: ${settings.devcontainer === null ? "none" : `${clean(settings.devcontainer.repository)} (${clean(settings.devcontainer.configPath)})`}`,
    "Allowed domains:",
    ...(settings.allowedDomains.length === 0 ? ["  none beyond the defaults every project has"] : settings.allowedDomains.map((entry) => `  ${clean(entry.domain)}  (${entry.status}${entry.reason === undefined ? "" : `: ${clean(entry.reason)}`})`)),
  ];
  return `${lines.join("\n")}\n`;
}

/** The settings `agentx project settings` was given; only a field that is present changes. */
export type ProjectSettingsChange = Omit<ProjectSettingsBody, "requestId" | "expectedRevision">;

/**
 * `agentx project settings <name> ...` (Plan 2, Task 17): reads the project to learn the revision the person is changing (the server refuses
 * the change if someone saved another since), then sends only the settings given through `PUT /v1/app/projects/{name}/settings`.
 */
export async function changeDeveloperProjectSettings(
  deps: DeveloperSessionDeps,
  env: string | undefined,
  name: string,
  change: ProjectSettingsChange,
  requestId: string,
): Promise<{ env: string; url: string } & ProjectSettingsResponse> {
  if (Object.values(change).every((value) => value === undefined)) throw agentXError("CONFIG_INVALID", "give at least one setting to change; run agentx project settings --help");
  const shown = await showDeveloperProject(deps, env, name);
  const { url, body } = await developerRequest(deps, env, `/v1/app/projects/${encodeURIComponent(name)}/settings`, ProjectSettingsResponseSchema, {
    method: "PUT",
    body: { requestId, expectedRevision: shown.project.latestRevision, ...change },
    explain: true,
  });
  return { env: shown.env, url, ...body };
}

/** What `agentx project settings` prints: the new revision, then any warnings. */
export function projectSettingsText(result: ProjectSettingsResponse): string {
  // TE-4: commands and the dev container sent with an API key are held until their check passes; the reply says so.
  const held = result.held === undefined ? "" : result.held.status === "checking"
    ? `Held: the ${result.held.fields.join(", ")} change is being checked on a fresh machine and is not saved yet. It is written only if the check passes; run agentx project show to see.\n`
    : `Not saved: the ${result.held.fields.join(", ")} change${result.held.reason === undefined ? "" : ` (${clean(result.held.reason)})`}. Nothing was changed for it.\n`;
  const saved = result.held === undefined ? `Saved ${clean(result.project.name)}: it is at revision ${String(result.project.latestRevision)}.\n` : `${clean(result.project.name)} is at revision ${String(result.project.latestRevision)}.\n`;
  return saved + held + result.warnings.map((warning) => `Note: ${clean(warning)}\n`).join("");
}

/** What `agentx project archive` asks before it archives: what stops, and what keeps going. */
export const archiveProjectQuestion = (name: string) =>
  `Archive ${clean(name)}? Nobody can start new tasks in it until it is restored. Tasks already running keep going, but lose access to this project's approved extra domains.`;

/**
 * `agentx project archive <name>` and `agentx project restore <name>` (Plan 2, Task 20): a maintainer of the project, through
 * `POST /v1/app/projects/{name}/archive|restore`. Repeating one on a project already in that state is harmless; a fresh request id each time.
 */
export async function changeDeveloperProjectArchive(
  deps: DeveloperSessionDeps,
  env: string | undefined,
  name: string,
  change: "archive" | "restore",
  requestId: string,
): Promise<{ env: string; url: string; project: AppProjectDetail; warnings: string[] }> {
  const { env: resolved, url, body } = await developerRequest(deps, env, `/v1/app/projects/${encodeURIComponent(name)}/${change}`, ProjectArchiveResponseSchema, {
    method: "POST",
    body: { requestId },
    explain: true,
  });
  return { env: resolved, url, project: body.project, warnings: body.warnings };
}

const warningLines = (warnings: readonly string[]) => warnings.map((warning) => `Note: ${clean(warning)}\n`).join("");
export const archiveProjectText = (result: { project: AppProjectDetail; warnings: readonly string[] }) =>
  `Archived ${clean(result.project.name)}. To bring it back, run: agentx project restore ${clean(result.project.name)}\n${warningLines(result.warnings)}`;
export const restoreProjectText = (result: { project: AppProjectDetail; warnings: readonly string[] }) =>
  `Restored ${clean(result.project.name)}. People can start tasks in it again, and its approved domains are allowed again.\n${warningLines(result.warnings)}`;

/** How the logout went at the server: revoked, not answered at all, or answered without confirming. */
export interface DeveloperLogoutResult {
  env: string;
  revoked: boolean;
  problem?: "unreachable" | "not_confirmed";
  /** The server's reason when it did not confirm, made safe to show. */
  reason?: string;
}

/**
 * Ends the sign-in at the server (RFC 7009 revoke) and on this computer. The local tokens and
 * environment are removed whatever the server answers; `revoked` and `problem` say how that went.
 */
export async function developerLogout(deps: DeveloperSessionDeps, env: string | undefined): Promise<DeveloperLogoutResult> {
  let resolved: Awaited<ReturnType<typeof resolveDeveloperEnvironment>>;
  try {
    resolved = await resolveDeveloperEnvironment(deps.home, env);
  } catch (error) {
    // No developer sign-in here: the person may mean the admin one, which --admin ends.
    if (error instanceof AgentXError && error.code === "AUTH_REQUIRED") {
      throw agentXError("AUTH_REQUIRED", `${error.message.slice(error.code.length + 2)}; for the admin login, run agentx logout --admin`);
    }
    throw error;
  }
  const key = developerTokenKey(resolved.entry.issuer);
  const tokens = await deps.tokenStore.get(key);
  let outcome: Omit<DeveloperLogoutResult, "env"> = { revoked: false };
  if (tokens?.refreshToken !== undefined) {
    let response: Response | undefined;
    try {
      response = await deps.fetch(resolved.entry.revocationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokens.refreshToken, client_id: AGENTX_CLI_CLIENT_ID }).toString(),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      response = undefined;
    }
    if (response === undefined) {
      outcome = { revoked: false, problem: "unreachable" };
    } else if (response.ok) {
      outcome = { revoked: true };
    } else {
      const body: unknown = await response.json().catch(() => undefined);
      const description = typeof body === "object" && body !== null ? (body as Record<string, unknown>).error_description : undefined;
      outcome = { revoked: false, problem: "not_confirmed", ...(typeof description === "string" ? { reason: sanitizeServerText(description) } : {}) };
    }
  }
  await deps.tokenStore.delete(key);
  await removeDeveloperEnvironment(deps.home, resolved.env);
  return { env: resolved.env, ...outcome };
}

/** The text agentx logout prints. */
export function logoutText(result: DeveloperLogoutResult): string {
  const local = `Signed out of AgentX environment ${result.env}`;
  if (result.problem === "unreachable") {
    return `${local} on this computer. AgentX could not be reached to end the sign-in there, so the server session may stay until it expires.\n`;
  }
  if (result.problem === "not_confirmed") {
    const reason = result.reason === undefined ? "" : ` (${result.reason})`;
    return `${local} on this computer. AgentX did not confirm it ended the sign-in there${reason}, so the server session may stay until it expires.\n`;
  }
  return `${local}.\n`;
}
