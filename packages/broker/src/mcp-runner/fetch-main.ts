// Stdio MCP host redesign (T4): the process the `fetch` container of a runner task runs (uid 10002). It downloads the approved bundle from the controller, checks its hash, unpacks
// it into the bundle volume, and exits 0; any failure exits 1 and leaves nothing behind, so the `server` container (which depends on this one succeeding) never starts.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { FetchError, fetchBundle, runnerTokenWellFormed } from "@agentx/gateway";

export interface FetchConfig { controllerUrl: string; token: string; bundleHash: string; destination: string; ca?: string | undefined }

/** Reads and checks the settings. A missing or invalid one stops the step. */
export function readFetchConfig(env: Record<string, string | undefined>): FetchConfig {
  const controllerUrl = env.MCP_CONTROLLER_URL;
  const token = env.MCP_RUNNER_TOKEN;
  const bundleHash = env.MCP_BUNDLE_HASH;
  if (controllerUrl === undefined || controllerUrl === "") throw new Error("MCP_CONTROLLER_URL is not set");
  if (token === undefined || !runnerTokenWellFormed(token)) throw new Error("MCP_RUNNER_TOKEN is not set");
  if (bundleHash === undefined || !/^[0-9a-f]{64}$/u.test(bundleHash)) throw new Error("MCP_BUNDLE_HASH is not valid");
  return { controllerUrl, token, bundleHash, destination: env.MCP_BUNDLE_DIR ?? "/bundle", ...(env.ROVARA_MCP_CONTROLLER_CA === undefined ? {} : { ca: env.ROVARA_MCP_CONTROLLER_CA }) };
}

/** Returns the exit code, and writes one line that holds a fixed code only (never the controller's text, a path, or the token). */
export async function main(dependencies: { env: Record<string, string | undefined>; getuid?: () => number | undefined; write?: (line: string) => void }): Promise<number> {
  const write = dependencies.write ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  let config: FetchConfig;
  try { config = readFetchConfig(dependencies.env); } catch { write(JSON.stringify({ component: "mcp-fetch", ok: false, code: "bad_request" })); return 1; }
  delete dependencies.env.MCP_RUNNER_TOKEN;
  try {
    await fetchBundle({ ...config, ...(dependencies.getuid === undefined ? {} : { getuid: dependencies.getuid }) });
    write(JSON.stringify({ component: "mcp-fetch", ok: true }));
    return 0;
  } catch (error) {
    write(JSON.stringify({ component: "mcp-fetch", ok: false, code: error instanceof FetchError ? error.code : "failed" }));
    return 1;
  }
}

/** Whether this file is the program being run (and not just imported). The real path is compared: a program started through a link would otherwise never start. */
function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isMainModule()) {
  void main({ env: process.env }).then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
