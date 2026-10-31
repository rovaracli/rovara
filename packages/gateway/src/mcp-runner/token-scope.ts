// Stdio MCP host redesign (fix round 1, I4): what a runner task's token may do, as a contract the controller (T6) enforces.
//
// The server container can read its own token (/proc/<bridge pid>/environ keeps the initial environment, and the package runs as the same uid; accepted in design section 2).
// So a token must be worth nothing beyond its own task:
//   - it is bound to ONE task and ONE purpose;
//   - an install token may only PUT /bundles/<hash> (the controller allows it once, and hashes what it receives);
//   - a fetch, serve or probe token may only GET /bundles/<the one bundle hash its task was approved to run>. It may not PUT, and may not read another bundle;
//   - a token is 256 bits from a secure random source, compared in constant time.
import { randomBytes } from "node:crypto";

export type RunnerTokenScope =
  | { purpose: "install" }
  | { purpose: "fetch" | "serve" | "probe"; /** The approved bundle this task runs. */ bundleHash: string };

/** 32 random bytes as base64url: 43 characters, 256 bits. */
export function generateRunnerToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The shortest token the runner programs accept: 43 base64url characters carry 256 bits. */
export const RUNNER_TOKEN_MIN_LENGTH = 43;

export function runnerTokenWellFormed(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43,128}$/u.test(token);
}

/** Whether a token of this scope may make this request to the controller's bundle store. Anything not named here is refused. */
export function runnerTokenAllows(scope: RunnerTokenScope, method: string, pathname: string): boolean {
  const match = /^\/bundles\/([0-9a-f]{64})$/u.exec(pathname);
  if (match === null) return false;
  if (scope.purpose === "install") return method === "PUT";
  return method === "GET" && /^[0-9a-f]{64}$/u.test(scope.bundleHash) && match[1] === scope.bundleHash;
}
