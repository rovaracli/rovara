import { AgentXError, agentXError, CSRF_STALE_MESSAGE } from "@agentx/contracts";
import { APP_CSRF_HEADER, appCsrfMatches } from "../developer/app-csrf.js";
import { authenticateDeveloperSessionId, type DeveloperCaller, type DeveloperRouteDependencies } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import { SESSION_COOKIE, parseCookie } from "./web-session.js";
export const WEB_ROUTE_FAMILIES = ["me", "nav", "home", "live", "changes", "realtime", "sessions", "projects", "agents", "models", "skills", "approvals", "spend-requests", "connections", "org", "github", "budget", "usage", "notices", "chains", "chain-runs", "tasks/{id}/continue-as-task", "trash", "devices"] as const;
export const WEB_REQUEST_REFUSED = "This request didn't come from Rovara's app.";
export function webRouteAllowed(method: string, pathname: string): boolean {
 if (!pathname.startsWith("/v1/web/")) return false;
 const relative = pathname.slice("/v1/web/".length), family = relative.split("/")[0]!;
 const read = method === "GET" || method === "HEAD";
 if (relative === "org/service-status" || relative.startsWith("org/service-status/")) return read && relative === "org/service-status";
 // L3b / K1: the task page also reads what the agent loaded (the records and one rule file's text) and the lessons it loaded and marks one "Helpful" / "Wrong here" (exact shapes only; nothing else under tasks/ is reachable from a browser).
 // OWNER DECISION 7: what the old review page did on a task (Retry the checks, Revise the plan, a held spec's choices, People, a comment's Remember and Forget); the routes re-check who may.
 if (family === "tasks" && method === "POST" && /^tasks\/[0-9a-f-]{36}\/(?:workflow\/(?:checks-retry|revise-plan)|spec\/(?:retry|continue|keep|replan)|people\/(?:role|take-ownership)|comments\/[0-9a-f-]{36}\/(?:remember|forget))$/i.test(relative)) return true;
 if (family === "tasks" && read && /^tasks\/[0-9a-f-]{36}\/(?:people|comments)$/i.test(relative)) return true;
 // OWNER DECISION 18: the plan panel (a document, comments, replies, edits, deletes, suggestions, Ask) and the PR feedback view; exact shapes, mirroring developer-routes/plan-panel.ts, which re-checks who may.
 if (family === "tasks" && read && /^tasks\/[0-9a-f-]{36}\/(?:documents\/(?:requirements|design|plan)|workflow\/feedback)$/i.test(relative)) return true;
 if (family === "tasks" && method === "POST" && /^tasks\/[0-9a-f-]{36}\/(?:comments|comments\/[0-9a-f-]{36}\/(?:edit|delete)|suggestions|workflow\/feedback-decision)$/i.test(relative)) return true;
 // UX2 slice 2: the task page's Resolve findings and Send back to coding (the routes re-check who may, as Slack's and the MCP tools' do).
 if (family === "tasks" && method === "POST" && /^tasks\/[0-9a-f-]{36}\/workflow\/(?:review-findings|send-back)$/i.test(relative)) return true;
 if (family === "tasks") return (method === "POST" && /^tasks\/[0-9a-f-]{36}\/second-review-acknowledge$/i.test(relative)) || (method === "POST" && /^tasks\/[0-9a-f-]{36}\/continue-as-task$/i.test(relative)) || (read && /^tasks\/[0-9a-f-]{36}\/design-review\/approve$/i.test(relative)) || (method === "POST" && /^tasks\/[0-9a-f-]{36}\/design-review\/(?:first|skip|answers|retry|resume|approve|spend\/(?:lower-tier|raise-cap|run-unpriced|skip))$/i.test(relative)) || (read && /^tasks\/[0-9a-f-]{36}\/lessons$/.test(relative)) || (read && /^tasks\/[0-9a-f-]{36}\/loaded-knowledge(?:\/[A-Za-z0-9_-]{1,80}\/[a-z_]{1,20}(?:\.[A-Z]{1,10})?\/items\/\d{1,3}\/text)?$/.test(relative)) || (method === "POST" && /^tasks\/[0-9a-f-]{36}\/lessons\/[A-Za-z0-9_-]{4,64}\/feedback$/.test(relative));
 // WEB-1 (owner, 2026-11-02): the decision cards. Exact shapes only, mirroring PATH in decisions/routes.ts: read the list; press one card (approve, reject or note that its evidence was opened). Nothing else under decisions/ is reachable from a browser.
 if (family === "decisions") return (method === "GET" && relative === "decisions") || (method === "POST" && /^decisions\/[a-z_]+\/[A-Za-z0-9_-]{1,150}\/(?:approve|reject|evidence-opened|request-changes)$/u.test(relative));
 // Fix with agent (switch `fd`): the browser may ask for a diagnosis and read one, and nothing else under diagnoses/ (the deep tier and "Apply this change" stay on the token API). Exact shapes, mirroring routes.ts in diagnosis/.
 if (family === "diagnoses") return (method === "POST" && relative === "diagnoses") || (method === "GET" && /^diagnoses\/dgn_[0-9a-z]{20}$/u.test(relative));
 // UX5b: the settings screen for script tokens. Exact shapes, mirroring script-tokens/routes.ts: list, make, revoke one.
 if (family === "script-tokens") return ((method === "GET" || method === "POST") && relative === "script-tokens") || (method === "DELETE" && /^script-tokens\/stk_[0-9a-z]{20}$/u.test(relative));
 if (!(WEB_ROUTE_FAMILIES as readonly string[]).includes(family)) return false;
 // Lane B: legacy lifecycle writes remain on the token API for compatibility.
 // Cookie callers must use reviewed paths; legacy Slack writes remain held until B34 exposure ships.
 if (family === "projects" && /^projects\/[^/]+\/(archive|restore|slack-channel)$/.test(relative)) return false;
 // RULING Q9: identity linking/unlinking stays in the CLI fresh-session flow; a browser may read /me. Release 0.4.16: and set its own display name (PUT /me/name, which
 // authenticateWebRequest guards with the cookie, the Origin and the CSRF token like every browser write).
 // The one exception (owner, 2026-11-05): a signed-in web user links their own Slack account, and removes that link (never another method).
 // UX2 slice 2: the person's own notification setting (their own row only; no id in the path).
 if (family === "me" && relative === "me/notifications") return read || method === "PUT";
 // UX1 (owner-approved platform UX, slice 1): and links their own GitHub account (any sign-in method), finished in the same browser; removing it stays in the CLI.
 if (family === "me") return (read && relative === "me") || (method === "PUT" && relative === "me/name") || ((method === "POST" || method === "DELETE") && relative === "me/identities/slack") || (method === "POST" && relative === "me/identities/github");
 if (family === "approvals" || family === "devices") return read && !relative.endsWith("/decide");
 if (family === "spend-requests") return relative === "spend-requests" && (read || method === "POST");
 return true;
}
export async function authenticateWebRequest(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest): Promise<DeveloperCaller> {
 if (request.headers.authorization !== undefined) throw agentXError("AUTH_REQUIRED", "Use the /v1/app routes with a token.");
 const cookie = parseCookie(request.headers, SESSION_COOKIE);
 if (cookie === undefined || cookie === "") throw agentXError("AUTH_REQUIRED", "Sign in to continue.");
 let caller: DeveloperCaller;
 try { caller = await authenticateDeveloperSessionId(deps, cookie); }
 catch (error) { if (error instanceof AgentXError && error.code === "AUTH_REQUIRED") throw agentXError("AUTH_REQUIRED", "Sign in to continue.");throw error; }
 if (deps.developer.methods[caller.amr] !== true) throw agentXError("AUTH_REQUIRED", "Sign in to continue.");
 const site = request.headers["sec-fetch-site"];
 if (site !== undefined && site !== "same-origin") throw agentXError("FORBIDDEN", WEB_REQUEST_REFUSED);
 if (request.method !== "GET" && request.method !== "HEAD") {
  const csrf = request.headers[APP_CSRF_HEADER];
  if (request.headers.origin !== new URL(deps.developer.issuer).origin || csrf === undefined) throw agentXError("FORBIDDEN", WEB_REQUEST_REFUSED);
  if (!appCsrfMatches(cookie, csrf)) throw agentXError("CSRF_STALE", CSRF_STALE_MESSAGE);
 }
 // Only this function says a caller came through a browser session with its CSRF token: Merge merges at once for such a caller and never for a token.
 return { ...caller, browserSession: true };
}
