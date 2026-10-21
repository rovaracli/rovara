// `agentx github connect` (Plan 2, Task 13): connect your organization's GitHub account to Rovara. One signed-in POST asks the control plane
// for an install link that only this person can complete; the browser opens it (or the link is printed); then this waits, polling the
// organization's connected GitHub accounts, until a new one appears. The control plane decides who may connect and what GitHub says.
import { agentXError, githubAdminMessage, githubInstallRequestCopy, type GithubInstallRequestShownStatus } from "@agentx/contracts";
import { z } from "zod";
import { sanitizeServerText } from "../auth.js";
import { developerRequest } from "./commands.js";
import type { DeveloperSessionDeps } from "./session.js";

const StartResponseSchema = z.object({ installUrl: z.string().url(), expiresAt: z.string(), orgName: z.string().optional(), ownerName: z.string().optional() });
const REQUEST_STATUS = z.enum(["waiting", "connected", "declined", "expired", "taken", "reinstall_needed", "cancelled"]);
const RequestsResponseSchema = z.object({
  requests: z.array(z.object({
    githubLogin: z.string(), status: REQUEST_STATUS, accountLogin: z.string().optional(), requestedAt: z.string(), expiresAt: z.string(),
    requestedBy: z.object({ developerId: z.string(), name: z.string() }).passthrough(),
  }).passthrough()),
});
const MeResponseSchema = z.object({ developer: z.object({ id: z.string() }).passthrough() }).passthrough();
const InstallationsResponseSchema = z.object({
  installations: z.array(z.object({ installationId: z.number(), accountLogin: z.string() }).passthrough()),
});

export const GITHUB_CONNECT_POLL_MS = 5_000;
export const GITHUB_CONNECT_WAIT_MS = 15 * 60_000;

export interface GithubConnectOptions {
  /** Opens a URL in the person's browser; absent, the link is only printed. */
  openBrowser?: (url: string) => Promise<void>;
  /** Progress lines for the person (standard error). */
  write: (line: string) => void;
  pollMs?: number;
  waitMs?: number;
}
/**
 * `connected`: an account is connected (`installationId` when this CLI saw the installation itself; a request a GitHub admin approved shows
 * only the account). `waiting`: a request is still open after the wait, and nothing is wrong.
 */
export interface GithubConnectResult { env: string; url: string; status: "connected" | "waiting"; account?: string; installationId?: number }

export const GITHUB_STILL_WAITING_TEXT = "Still waiting for your GitHub admin; check later with agentx github list.";

/** The link the server sent must be GitHub's own install page: nothing else is ever opened. */
function githubInstallLink(value: string): URL {
  const link = new URL(value);
  if (link.protocol !== "https:" || link.hostname !== "github.com" || !link.pathname.startsWith("/apps/") || link.username !== "" || link.password !== "") {
    throw agentXError("RUNTIME_UNAVAILABLE", "the control plane answered with a link that is not a GitHub App install page; nothing was opened");
  }
  return link;
}

async function installedIds(deps: DeveloperSessionDeps, env: string | undefined): Promise<{ env: string; url: string; installations: Array<{ installationId: number; accountLogin: string }> }> {
  const { env: resolved, url, body } = await developerRequest(deps, env, "/v1/app/github/installations", InstallationsResponseSchema, { explain: true });
  return { env: resolved, url, installations: body.installations };
}

type RequestEntry = z.infer<typeof RequestsResponseSchema>["requests"][number];
const requestKey = (entry: RequestEntry) => `${entry.status}|${entry.requestedAt}`;

/** The org's requests keyed by the GitHub login, and which of them are this developer's own. `mine` is who this developer is; never all of the org's. */
async function requestsNow(deps: DeveloperSessionDeps, env: string | undefined, mine: string): Promise<{ env: string; url: string; requests: Map<string, RequestEntry> }> {
  const { env: resolved, url, body } = await developerRequest(deps, env, "/v1/app/github/requests", RequestsResponseSchema, { explain: true });
  const requests = new Map<string, RequestEntry>();
  for (const entry of body.requests) if (entry.requestedBy.developerId === mine) requests.set(entry.githubLogin, entry);
  return { env: resolved, url, requests };
}

export async function githubConnect(deps: DeveloperSessionDeps, env: string | undefined, options: GithubConnectOptions): Promise<GithubConnectResult> {
  const started = await developerRequest(deps, env, "/v1/app/github/connect", StartResponseSchema, { method: "POST", body: {}, explain: true });
  const link = githubInstallLink(started.body.installUrl);
  // What is connected now, so that only a new connection ends the wait. A control plane that cannot list them yet is polled again below.
  const before = new Set<number>(await installedIds(deps, env).then((listed) => listed.installations.map((entry) => entry.installationId), () => []));
  // The same for requests to a GitHub admin: only this developer's own, and only a change from now on is reported. Best effort.
  const mine = await developerRequest(deps, env, "/v1/app/me", MeResponseSchema, { explain: true }).then((reply) => reply.body.developer.id, () => undefined);
  // When /v1/app/me fails, `mine` is unknown and requests are not polled at all: another member's request must never end this person's wait.
  const seenRequests = new Map<string, string>(mine === undefined ? [] : await requestsNow(deps, env, mine).then((found) => [...found.requests].map(([login, entry]) => [login, requestKey(entry)] as [string, string]), () => []));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  options.write("Install the Rovara GitHub App on the account you want to connect, and approve it on GitHub:");
  options.write(link.toString());
  // GitHub offers a person who is not an admin of their GitHub organization a request to its admin, and shows the admin no Rovara org name:
  // this is what to write if GitHub asks for a message.
  if (started.body.orgName !== undefined && started.body.ownerName !== undefined) {
    options.write(`If GitHub asks for a message to your admin, write: ${sanitizeServerText(githubAdminMessage(started.body.orgName, started.body.ownerName))}`);
  }
  if (options.openBrowser !== undefined) await options.openBrowser(link.toString()).catch(() => undefined);
  options.write("Waiting for you to finish in the browser (the link works for 15 minutes)...");
  const deadline = now() + (options.waitMs ?? GITHUB_CONNECT_WAIT_MS);
  let waitingOnAdmin = false;
  let where = { env: env ?? "", url: "" };
  for (;;) {
    await sleep(options.pollMs ?? GITHUB_CONNECT_POLL_MS);
    try {
      // A request to a GitHub admin: print each state change once; an approval is a connection, and any other end is the answer.
      const asked = mine === undefined ? undefined : await requestsNow(deps, env, mine).catch((error: unknown) => {
        const code = (error as { code?: unknown }).code;
        if (code === "AUTH_REQUIRED" || code === "FORBIDDEN") throw error;
        return undefined;
      });
      if (asked !== undefined) where = { env: asked.env, url: asked.url };
      for (const [login, entry] of asked?.requests ?? []) {
        if (seenRequests.get(login) === requestKey(entry)) continue;
        seenRequests.set(login, requestKey(entry));
        const status: GithubInstallRequestShownStatus = entry.status;
        const account = entry.accountLogin === undefined ? undefined : sanitizeServerText(entry.accountLogin);
        const copy = githubInstallRequestCopy(status, { account, orgName: started.body.orgName === undefined ? undefined : sanitizeServerText(started.body.orgName), ownerName: started.body.ownerName === undefined ? undefined : sanitizeServerText(started.body.ownerName) });
        options.write(copy.title);
        for (const line of copy.lines) options.write(line);
        if (status === "waiting") waitingOnAdmin = true;
        else if (status === "connected") return { ...where, status: "connected", ...(account === undefined ? {} : { account }) };
        else throw agentXError("CONFIG_INVALID", copy.title);
      }
      const listed = await installedIds(deps, env);
      const added = listed.installations.find((entry) => !before.has(entry.installationId));
      if (added !== undefined) return { env: listed.env, url: listed.url, status: "connected", account: sanitizeServerText(added.accountLogin), installationId: added.installationId };
    } catch (error) {
      // A sign-in that ended, a role that changed, or a control plane that cannot list connections will not heal by waiting.
      const code = (error as { code?: unknown }).code;
      if (code === "AUTH_REQUIRED" || code === "FORBIDDEN" || code === "NOT_FOUND" || code === "CONFIG_INVALID") throw error;
    }
    if (now() >= deadline) {
      if (waitingOnAdmin) {
        options.write(GITHUB_STILL_WAITING_TEXT);
        return { ...where, status: "waiting" };
      }
      throw agentXError("CONFIG_INVALID", "GitHub was not connected within 15 minutes; run agentx github connect again");
    }
  }
}

export const githubConnectText = (result: GithubConnectResult) =>
  result.status === "waiting" ? "" : result.account === undefined ? "Connected.\n" : `Connected ${result.account}.\n`;
