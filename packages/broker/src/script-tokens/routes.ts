// Script tokens (UX5b): the settings routes. `GET` and `POST /v1/app/script-tokens` and `DELETE /v1/app/script-tokens/{id}`, for a live browser session only (a sign-in token, the CLI,
// Slack and every script token are refused before anything is read). Off switch: not found, like any unknown path. Any other method or path under the prefix is not found.
import { agentXError } from "@rovara-code/contracts";
import { readChosenName } from "../developer/chosen-name.js";
import { safeDisplayName } from "../developer/person-name.js";
import { isFreshSignIn, type DeveloperRecord, type SessionRecord } from "../developer/store.js";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { StatusReply } from "../aws/status-reply.js";
import { getSignIn } from "../aws/developer-routes/authentication.js";
import { checkProjectAccess } from "../aws/developer-routes/project-access.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes/types.js";
import { scriptTokensEnabled } from "./switch.js";
import { createScriptToken, listScriptTokens, revokeScriptToken, type ScriptTokenDependencies } from "./store.js";

export const SCRIPT_TOKENS_PATH = "/v1/app/script-tokens";
const TOKEN_PATH = /^\/v1\/app\/script-tokens\/([^/]+)$/u;
export const SCRIPT_TOKENS_BROWSER_MESSAGE = "Use a live browser session to manage script tokens.";
export const SCRIPT_TOKEN_FRESH_SIGN_IN_MESSAGE = "Sign in again to make a script token.";

/** The paths this module owns under `/v1/app/`. */
export function isScriptTokensPath(pathname: string): boolean {
  return pathname === SCRIPT_TOKENS_PATH || pathname.startsWith(`${SCRIPT_TOKENS_PATH}/`);
}

const notFound = () => agentXError("NOT_FOUND", "route not found");

function jsonBody(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    throw agentXError("CONFIG_INVALID", "the request body is not JSON");
  }
}

export async function routeScriptTokens(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  if (!scriptTokensEnabled()) throw notFound();
  // Checked again here (the dispatcher checks first): only the browser's own session manages tokens, so no token can ever make, list or revoke one.
  if (caller.browserSession !== true || caller.scriptToken !== undefined) throw agentXError("FORBIDDEN", SCRIPT_TOKENS_BROWSER_MESSAGE);
  const store: ScriptTokenDependencies = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...(deps.audit === undefined ? {} : { audit: deps.audit }) };
  const who = { developerId: caller.developerId, orgId: caller.orgId, orgRole: caller.orgRole, amr: caller.amr };
  if (url.pathname === SCRIPT_TOKENS_PATH) {
    if (request.method === "GET") return { tokens: await listScriptTokens(store, who, (developerId) => personName(deps, developerId)) };
    if (request.method === "POST") {
      // Review I2: a long-lived credential needs a sign-in made within the last few minutes (the rule of the audit export). The session also says which identity the token is
      // made from and when the person signed in, so an unlink or a SAML cut-off ends the token as it ends the session (review I1).
      const session = await getSignIn<Pick<SessionRecord, "authTime" | "identityKey">>(deps, `SESSION#${caller.sessionId}`);
      if (session === undefined || !isFreshSignIn(session, deps.now())) throw agentXError("REAUTH_REQUIRED", SCRIPT_TOKEN_FRESH_SIGN_IN_MESSAGE);
      const maker = { ...who, ...(session.identityKey === undefined ? {} : { identityKey: session.identityKey }), ...(session.authTime === undefined ? {} : { authTime: session.authTime }) };
      // Review I1: where the edition caps every session, a token lives no longer than one.
      const cap = deps.editionPolicy?.sessionMaxSeconds;
      return new StatusReply(201, await createScriptToken(store, maker, jsonBody(request), async (project) => { await checkProjectAccess(deps, caller, project); }, cap === undefined ? {} : { lifetimeCapSeconds: cap }));
    }
    throw notFound();
  }
  const token = TOKEN_PATH.exec(url.pathname);
  if (token !== null && request.method === "DELETE") return { token: await revokeScriptToken(store, who, token[1]!) };
  throw notFound();
}

/** A person's name as the app shows it (the one they chose, else their sign-in's, never an email address). */
async function personName(deps: DeveloperRouteDependencies, developerId: string): Promise<string | undefined> {
  const [chosen, developer] = await Promise.all([
    readChosenName(deps.documentClient, deps.tableName, developerId),
    getSignIn<Pick<DeveloperRecord, "displayName">>(deps, `DEVELOPER#${developerId}`),
  ]);
  return chosen ?? (developer === undefined ? undefined : safeDisplayName(developer.displayName, developerId));
}
