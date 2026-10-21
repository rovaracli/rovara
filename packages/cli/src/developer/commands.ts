// agentx whoami and agentx logout (FR-011).
import { CLI_PACKAGE_NAME, AGENTX_CLI_CLIENT_ID, AgentXError, AgentXErrorCodeSchema, AppMeResponseSchema, DeveloperCreateProjectResponseSchema, DeveloperProjectsResponseSchema, UnlinkIdentityAppResponseSchema, UnlinkableSignInMethodSchema, agentXError, type DeveloperCreateProjectResponse, type DeveloperProjectsResponse, type LinkedIdentity } from "@agentx/contracts";
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
      headers: { authorization: `Bearer ${session.accessToken}`, ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
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
    if (reason !== undefined) throw agentXError(response.status === 400 ? "CONFIG_INVALID" : response.status === 403 ? "FORBIDDEN" : response.status === 409 ? (named.success ? named.data : "CONFIG_INVALID") : "NOT_FOUND", reason);
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
const SIGN_IN_METHOD_TEXT = { slack: "Slack", oidc: "your company sign-in", cloud: "Rovara sign-in", github: "GitHub" } as const;

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
        ? "You cannot use any project yet. Create one with: agentx project create --repository <owner/name>"
        : "You cannot use any project yet: ask your org's owner to create one.");
    } else {
      lines.push("You cannot use any project yet: join a project's Slack channel, or ask an admin for access.");
    }
  } else {
    lines.push("Projects you can use:");
    for (const project of projects) {
      const how = project.access === "granted" ? "an admin granted you access" : `you are in its Slack channel ${project.channels.map((channel) => channel.channelId).join(", ")}`;
      lines.push(`  ${project.name}  (${how})`);
    }
  }
  if (notices.includes("slack_unavailable")) lines.push("Slack could not be reached, so projects you use through a Slack channel are not listed; try again later.");
  return `${lines.join("\n")}\n`;
}

/** What `agentx signin unlink` calls each method, for its output. */
const UNLINK_METHOD_TEXT = { cloud: "Rovara sign-in (email code)", github: "GitHub" } as const;

/**
 * `agentx signin unlink <cloud|github>` (Plan 2, Task 8): removes one sign-in method from the signed-in developer's own account. Sessions
 * made with that method end; the others go on. The server refuses the account's only sign-in method and the one it was created with,
 * in its own words.
 */
export async function unlinkSignInMethod(deps: DeveloperSessionDeps, env: string | undefined, provider: string): Promise<{ env: string; url: string; provider: "cloud" | "github"; identities: LinkedIdentity[] }> {
  const method = UnlinkableSignInMethodSchema.safeParse(provider);
  if (!method.success) throw agentXError("CONFIG_INVALID", `unknown sign-in method ${JSON.stringify(sanitizeServerText(provider))}; use cloud or github`);
  const { env: resolved, url, body } = await developerRequest(deps, env, `/v1/app/me/identities/${method.data}`, UnlinkIdentityAppResponseSchema, { method: "DELETE", explain: true });
  return { env: resolved, url, provider: method.data, identities: body.identities };
}

export function unlinkText(result: { provider: "cloud" | "github"; identities: LinkedIdentity[] }): string {
  const left = result.identities.map((identity) => SIGN_IN_METHOD_TEXT[identity.provider]);
  return `Removed ${UNLINK_METHOD_TEXT[result.provider]} from your account. Sessions signed in that way have ended.\n`
    + `${left.length === 0 ? "No sign-in methods are linked." : `You can still sign in with ${left.join(", ")}.`}\n`;
}

/** `agentx project create` (ruling R55): the signed-in owner or admin of a cloud org creates a project from a repository. */
export async function createDeveloperProject(
  deps: DeveloperSessionDeps,
  env: string | undefined,
  input: { repository: string; name?: string; setupCommand?: string; testCommand?: string },
): Promise<{ env: string; url: string; created: DeveloperCreateProjectResponse }> {
  const { env: resolved, url, body } = await developerRequest(deps, env, "/v1/dev/projects", DeveloperCreateProjectResponseSchema, {
    method: "POST",
    body: {
      repository: input.repository,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.setupCommand === undefined ? {} : { setupCommand: input.setupCommand }),
      ...(input.testCommand === undefined ? {} : { testCommand: input.testCommand }),
    },
    explain: true,
  });
  return { env: resolved, url, created: body };
}

/** What `agentx project create` prints, with the next step. */
export function createProjectText(result: { env: string; created: DeveloperCreateProjectResponse }): string {
  const name = result.created.project.definition.name;
  const first = result.created.duplicate
    ? `Project ${name} already exists in AgentX environment ${result.env} with these settings. You have access to it.`
    : `Created project ${name} in AgentX environment ${result.env}. You have access to it.`;
  return `${first}\nNext: start a task in ${name} from your coding tool (agentx mcp install connects it), or run agentx whoami to see your projects.\n`;
}

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
