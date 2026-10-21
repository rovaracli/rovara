// `agentx github connect` (Plan 2, Task 13): connect your organization's GitHub account to Rovara. One signed-in POST asks the control plane
// for an install link that only this person can complete; the browser opens it (or the link is printed); then this waits, polling the
// organization's connected GitHub accounts, until a new one appears. The control plane decides who may connect and what GitHub says.
import { agentXError } from "@agentx/contracts";
import { z } from "zod";
import { sanitizeServerText } from "../auth.js";
import { developerRequest } from "./commands.js";
import type { DeveloperSessionDeps } from "./session.js";

const StartResponseSchema = z.object({ installUrl: z.string().url(), expiresAt: z.string() });
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
export interface GithubConnectResult { env: string; url: string; account: string; installationId: number }

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

export async function githubConnect(deps: DeveloperSessionDeps, env: string | undefined, options: GithubConnectOptions): Promise<GithubConnectResult> {
  const started = await developerRequest(deps, env, "/v1/app/github/connect", StartResponseSchema, { method: "POST", body: {}, explain: true });
  const link = githubInstallLink(started.body.installUrl);
  // What is connected now, so that only a new connection ends the wait. A control plane that cannot list them yet is polled again below.
  const before = new Set<number>(await installedIds(deps, env).then((listed) => listed.installations.map((entry) => entry.installationId), () => []));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  options.write("Install the Rovara GitHub App on the account you want to connect, and approve it on GitHub:");
  options.write(link.toString());
  if (options.openBrowser !== undefined) await options.openBrowser(link.toString()).catch(() => undefined);
  options.write("Waiting for you to finish in the browser (the link works for 15 minutes)...");
  const deadline = now() + (options.waitMs ?? GITHUB_CONNECT_WAIT_MS);
  for (;;) {
    await sleep(options.pollMs ?? GITHUB_CONNECT_POLL_MS);
    try {
      const listed = await installedIds(deps, env);
      const added = listed.installations.find((entry) => !before.has(entry.installationId));
      if (added !== undefined) return { env: listed.env, url: listed.url, account: sanitizeServerText(added.accountLogin), installationId: added.installationId };
    } catch (error) {
      // A sign-in that ended, a role that changed, or a control plane that cannot list connections will not heal by waiting.
      const code = (error as { code?: unknown }).code;
      if (code === "AUTH_REQUIRED" || code === "FORBIDDEN" || code === "NOT_FOUND") throw error;
    }
    if (now() >= deadline) throw agentXError("CONFIG_INVALID", "GitHub was not connected within 15 minutes; run agentx github connect again");
  }
}

export const githubConnectText = (result: GithubConnectResult) => `Connected ${result.account}.\n`;
