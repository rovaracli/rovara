// Plan 2, Task 13: the two public routes GitHub's install flow and the confirm page use. They have no API Gateway authorizer and no
// developer token: the callback is a redirect from github.com whose state names the person (checked against GitHub), and the confirm
// post is authorized by a cookie only the callback's browser holds, plus the cell's own Origin.
import { agentXError } from "@rovara-code/contracts";
import {
  clearedConnectCookie, completeGithubConnect, connectReturnTo, confirmGithubConnect, connectCookie, GITHUB_CONNECT_COOKIE,
  type ConnectOutcome, type GithubConnectionDependencies,
} from "../org/github-connection.js";
import { githubConnectPage } from "../org/github-connect-page.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import { parseCookie, type WebResponse } from "./web-session.js";

export const GITHUB_INSTALL_CALLBACK_PATH = "/v1/github/install/callback";
export const GITHUB_INSTALL_CONFIRM_PATH = "/v1/github/install/confirm";
const MAX_FORM_BYTES = 2_048;

/** Whether the path is one of the two routes; the caller answers anything else. */
export const isGithubInstallPath = (pathname: string) => pathname === GITHUB_INSTALL_CALLBACK_PATH || pathname === GITHUB_INSTALL_CONFIRM_PATH;

/** `deps` is undefined where the install has no GitHub connection to offer (not a cloud install, or no developer sign-in): both routes are then NOT_FOUND. */
export async function routeGithubInstall(deps: GithubConnectionDependencies | undefined, request: AdaptedHttpRequest, url: URL): Promise<WebResponse> {
  if (deps === undefined || !deps.cloud) throw agentXError("NOT_FOUND", "route not found");
  if (request.method === "GET" && url.pathname === GITHUB_INSTALL_CALLBACK_PATH) {
    // A callback is always a browser navigation: a failure the flow did not map (a store error, say) is the expired page, not raw JSON.
    const result = await completeGithubConnect(deps, {
      code: url.searchParams.get("code") ?? undefined, installation_id: url.searchParams.get("installation_id") ?? undefined,
      setup_action: url.searchParams.get("setup_action") ?? undefined, state: url.searchParams.get("state") ?? undefined,
    }).catch((error: unknown): ConnectOutcome => {
      deps.log?.({ event: "github.connect_callback_failed", error: error instanceof Error ? error.name : "unknown" });
      return { outcome: "expired" };
    });
    const returnTo = await connectReturnTo(deps, { state: url.searchParams.get("state") });
    const page = githubConnectPage(result.outcome, {
      returnTo,
      ...(result.accountLogin === undefined ? {} : { accountLogin: result.accountLogin }),
      ...(result.orgName === undefined ? {} : { orgName: result.orgName }),
      ...(result.connectId === undefined ? {} : { connectId: result.connectId }),
      ...(result.ownerName === undefined ? {} : { ownerName: result.ownerName }),
    });
    return result.confirmToken === undefined ? page : { ...page, headers: { ...page.headers, "set-cookie": connectCookie(result.confirmToken) } };
  }
  if (request.method === "POST" && url.pathname === GITHUB_INSTALL_CONFIRM_PATH) {
    if (request.body === undefined || Buffer.byteLength(request.body, "utf8") > MAX_FORM_BYTES) throw agentXError("CONFIG_INVALID", "the confirmation form is missing or too large");
    const form = new URLSearchParams(request.body);
    const decision = form.get("decision");
    const connect = form.get("connect");
    if ((decision !== "connect" && decision !== "cancel") || connect === null) throw agentXError("CONFIG_INVALID", "the confirmation form is incomplete");
    // Read before the confirm spends the state: the page after it goes back to where the person started.
    const returnTo = await connectReturnTo(deps, { hash: connect });
    const result = await confirmGithubConnect(deps, { connect, decision }, parseCookie(request.headers, GITHUB_CONNECT_COOKIE), request.headers.origin);
    const page = githubConnectPage(result.outcome, {
      returnTo,
      ...(result.accountLogin === undefined ? {} : { accountLogin: result.accountLogin }),
      ...(result.orgName === undefined ? {} : { orgName: result.orgName }),
    });
    // Whatever the outcome, the confirmation token is not needed again.
    return { ...page, headers: { ...page.headers, "set-cookie": clearedConnectCookie() } };
  }
  throw agentXError("NOT_FOUND", "route not found");
}
