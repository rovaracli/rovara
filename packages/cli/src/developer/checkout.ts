// Lessons for local coding tools (decision 46b, lane B2): which repository a command or the MCP server is running in. Read only: it runs `git rev-parse` and `git remote get-url` and looks for `.rovara/lessons.md`;
// nothing is written to git or the working tree. A remote that carries a user name or password is sent without them (a token in a clone address must never reach Rovara), and any failure is "no checkout".
import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { LOCAL_LESSONS_REPO_FILE } from "@agentx/contracts";

export interface Checkout {
  /** The `origin` remote, without credentials. Absent outside a checkout or with no `origin`. */
  remote?: string | undefined;
  /** The checkout holds the team's merged lessons file, so the lessons already in it need not be fetched again (decision 50a). */
  hasLessonsFile: boolean;
}
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string | undefined>;

const runGit: GitRunner = (args, cwd) => new Promise((resolve) => {
  execFile("git", [...args], { cwd, timeout: 5_000, maxBuffer: 64 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout) => resolve(error === null ? stdout.trim() : undefined));
});

/** The address with no user name or password. An address that is not a URL (scp style `git@host:owner/name`, a path) is returned as it is: it carries no password. */
export function withoutCredentials(remote: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(remote)) return remote;
  try {
    const url = new URL(remote);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return remote;
  }
}

export async function readCheckout(cwd: string, git: GitRunner = runGit): Promise<Checkout> {
  const top = await git(["rev-parse", "--show-toplevel"], cwd);
  if (top === undefined || top === "") return { hasLessonsFile: false };
  const remote = await git(["remote", "get-url", "origin"], top);
  const file = await lstat(join(top, LOCAL_LESSONS_REPO_FILE)).then((info) => info.isFile(), () => false);
  return { ...(remote === undefined || remote === "" ? {} : { remote: withoutCredentials(remote) }), hasLessonsFile: file };
}
