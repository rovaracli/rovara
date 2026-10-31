// Stdio MCP host redesign (T4): the process the `server` container of a runner task runs (uid 10003). It reads the task's settings from its environment, starts the bridge
// (gateway/mcp-runner/bridge.ts) and serves it on the task's port. If the program it started stops, this process exits, so the task stops.
//
// The settings are not secrets (the bundle hash, the package name, its arguments, the NAMES of its secrets) except the task token and the secret values, which ECS puts in the
// environment; both are removed from it as soon as they have been read (the bridge removes the secret values once the program has them).
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createServer, type Server } from "node:http";
import { McpStdioProposalSchema } from "@agentx/contracts";
import { CONFINE_LIMITS, DEFAULT_CONFINE_TOOLS, confinedCommand, createBridge, runnerTokenWellFormed, type Bridge, type ConfineTools } from "@agentx/gateway";

export interface ServeConfig {
  token: string;
  bundleHash: string;
  packageName: string;
  args: string[];
  secretEnv: string[];
  memoryMiB: number;
  port: number;
  bundleDir: string;
  homeDir: string;
  tmpDir: string;
  tools: ConfineTools;
}

function jsonList(text: string | undefined, label: string): unknown {
  if (text === undefined || text === "") return [];
  try { return JSON.parse(text) as unknown; } catch { throw new Error(`${label} is not valid`); }
}

/** Reads and checks the task's settings. A setting that is missing or not valid stops the task; nothing is defaulted that the approval decides. */
export function readServeConfig(env: Record<string, string | undefined>): ServeConfig {
  const token = env.MCP_RUNNER_TOKEN;
  if (token === undefined || !runnerTokenWellFormed(token)) throw new Error("MCP_RUNNER_TOKEN is not set");
  const bundleHash = env.MCP_BUNDLE_HASH;
  if (bundleHash === undefined || !/^[0-9a-f]{64}$/u.test(bundleHash)) throw new Error("MCP_BUNDLE_HASH is not valid");
  const parsed = McpStdioProposalSchema.safeParse({ registry: "npm", name: env.MCP_PACKAGE_NAME, version: "0.0.0", args: jsonList(env.MCP_SERVER_ARGS, "MCP_SERVER_ARGS"), secretEnv: jsonList(env.MCP_SECRET_ENV, "MCP_SECRET_ENV") });
  if (!parsed.success) throw new Error("the package, its arguments or its secret names are not valid");
  const memoryMiB = Number(env.MCP_MEMORY_MIB);
  if (!Number.isInteger(memoryMiB) || memoryMiB < 256 || memoryMiB > 2_048) throw new Error("MCP_MEMORY_MIB is not valid");
  const port = Number(env.PORT ?? 8_080);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT is not valid");
  return {
    token, bundleHash, packageName: parsed.data.name, args: parsed.data.args, secretEnv: parsed.data.secretEnv, memoryMiB, port,
    bundleDir: env.MCP_BUNDLE_DIR ?? "/bundle", homeDir: env.MCP_HOME_DIR ?? "/home/server", tmpDir: env.MCP_TMP_DIR ?? "/tmp",
    // The programs that confine the package are the image's, at fixed paths. Nothing in the environment (a RunTask override, a mistake) can name others.
    tools: { ...DEFAULT_CONFINE_TOOLS },
  };
}

export interface ServeDependencies {
  env: Record<string, string | undefined>;
  getuid?: () => number | undefined;
  getgid?: () => number | undefined;
  /** A test seam only: production never passes it, and the environment cannot. */
  tools?: ConfineTools;
  /** Called if the program stops. The default exits the process with 1. */
  onChildExit?: () => void;
  log?: (event: string, fields: Record<string, string | number>) => void;
}

/** Starts the bridge and its listener. Rejects (with nothing left running) if the bundle is not the approved one or the program does not start. */
export async function start(dependencies: ServeDependencies): Promise<{ bridge: Bridge; server: Server }> {
  const config = readServeConfig(dependencies.env);
  // The token is held here only. The program never sees this process's environment (the bridge builds its own).
  delete dependencies.env.MCP_RUNNER_TOKEN;
  const bridge = createBridge({
    token: config.token, bundleHash: config.bundleHash, bundleDir: config.bundleDir, packageName: config.packageName, args: config.args, secretEnv: config.secretEnv,
    memoryMiB: config.memoryMiB, environment: dependencies.env, homeDir: config.homeDir, tmpDir: config.tmpDir,
    confine: (program, args) => confinedCommand(dependencies.tools ?? config.tools, program, args, CONFINE_LIMITS),
    ...(dependencies.getuid === undefined ? {} : { getuid: dependencies.getuid }),
    ...(dependencies.getgid === undefined ? {} : { getgid: dependencies.getgid }),
    onChildExit: dependencies.onChildExit ?? (() => { process.exit(1); }),
    ...(dependencies.log === undefined ? {} : { log: dependencies.log }),
  });
  const server = createServer((req, res) => { void bridge.handle(req, res); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.port, "0.0.0.0", () => resolve()); });
  try {
    await bridge.start();
  } catch (error) {
    server.close();
    await bridge.close();
    throw error;
  }
  return { bridge, server };
}

/** Whether this file is the program being run (and not just imported). The real path is compared: a program started through a link would otherwise never start. */
function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isMainModule()) {
  const log = (event: string, fields: Record<string, string | number>): void => { console.log(JSON.stringify({ component: "mcp-bridge", event, ...fields })); };
  start({ env: process.env, log }).then(({ bridge, server }) => {
    const stop = (): void => { server.close(); void bridge.close().finally(() => process.exit(0)); };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  }, () => { log("bridge.start_failed", {}); process.exit(1); });
}
