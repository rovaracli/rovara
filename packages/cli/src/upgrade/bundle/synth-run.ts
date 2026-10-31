// Runs the release's own pinned CDK app (the synthesis kit in a verified bundle) to build one install's templates. The kit is code, signed with the bundle, but a bundled CDK app
// holds a great many dependencies, so it is run as if it could be hostile, BEFORE the customer has seen anything:
//   - inside an OPERATING SYSTEM SANDBOX with no network and no sockets: macOS `sandbox-exec` with `(deny network*)` (that includes Unix sockets such as /var/run/docker.sock and
//     the loopback), Linux bubblewrap with every namespace unshared (a network namespace with no interface, and a file system that holds only the kit, its work and output
//     directories and the system libraries, so no socket file is visible at all). With no interface there is no route to the instance metadata service (169.254.169.254) either;
//   - if no such sandbox exists on this computer the kit is NOT run, and nothing falls back to running it without one;
//   - with a scrubbed environment (none of the caller's variables: no AWS credentials or profile, no proxy, no token), a home directory that is its own work directory, and its only
//     input a context file this command wrote;
//   - where Node's permission model exists, with file access confined to the kit, its work directory and its output directory.
// Node 22 and 24 have no network permission, which is why the operating system does that part.
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { dirname, delimiter, join } from "node:path";
import { agentXError } from "@agentx/contracts";

export interface SynthRunInput {
  /** Absolute path of the kit's entry module inside the verified private copy. */
  entry: string;
  /** The directory that holds the whole kit (the entry may read anything under it). */
  kitDir: string;
  /** The context file the entry reads, written by the caller. */
  contextFile: string;
  /** Where the entry writes its output. Empty on entry. */
  outDir: string;
  /** A scratch directory of the kit's own (its HOME and TMPDIR). */
  workDir: string;
}
export interface SynthRunner {
  /** Whether the runner also confines the kit's file access with Node's permission model. Shown to the approver. */
  readonly confined: boolean;
  /** The sandbox the kit runs in (for the summary), for example "macOS sandbox-exec (no network)". */
  readonly sandbox: string;
  run(input: SynthRunInput): Promise<void>;
}

/** The only environment a kit sees. Nothing of the caller's (no AWS credentials, no proxy, no token) is passed on. */
export function kitEnvironment(workDir: string): Record<string, string> {
  return { HOME: workDir, TMPDIR: workDir, TZ: "UTC", LANG: "C", LC_ALL: "C", NODE_ENV: "production" };
}

/** The wrapper that puts the kit's process in the sandbox: a command and the arguments that come before the program it starts. */
export interface SandboxPlan {
  kind: "sandbox-exec" | "bwrap";
  command: string;
  args: string[];
  description: string;
}

/** Paths in a sandbox profile are quoted; a path with a quote or a backslash in it is refused rather than escaped. */
const profilePath = (path: string): string => {
  if (path.includes('"') || path.includes("\\") || [...path].some((char) => char.charCodeAt(0) < 0x20)) throw agentXError("CONFIG_INVALID", "a directory name holds a character a sandbox profile cannot carry; nothing was built");
  return `"${path}"`;
};

/** Where the invoking user keeps credentials; the sandbox denies reading them whatever the kit does. Relative to the real home directory. */
const CREDENTIAL_DIRECTORIES = [".aws", ".ssh", ".docker", ".kube", ".config/gcloud", ".azure", ".gnupg", ".npmrc", ".netrc"];

/** The macOS profile: everything is allowed except the network (all of it: remote, local, Unix sockets), writing outside the two directories, and reading credential directories. */
export function macProfile(input: Pick<SynthRunInput, "workDir" | "outDir">, realHome: string | undefined): string {
  const lines = ["(version 1)", "(allow default)", "(deny network*)", "(deny file-write*)", `(allow file-write* (subpath ${profilePath(input.workDir)}) (subpath ${profilePath(input.outDir)}) (literal "/dev/null") (literal "/dev/dtracehelper"))`];
  if (realHome !== undefined && realHome !== "") for (const directory of CREDENTIAL_DIRECTORIES) lines.push(`(deny file-read* (subpath ${profilePath(join(realHome, directory))}))`);
  return lines.join("\n");
}

/** The Linux bubblewrap arguments: every namespace unshared (so a network namespace with no interface), a file system of read-only system directories plus the three directories, no environment. */
export function bwrapArguments(input: SynthRunInput, nodeBinary: string, env: Record<string, string>): string[] {
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv"];
  for (const directory of ["/usr", "/lib", "/lib64", "/bin", "/sbin"]) args.push("--ro-bind-try", directory, directory);
  const nodeDirectory = dirname(nodeBinary);
  if (!["/usr", "/bin", "/sbin", "/lib", "/lib64"].some((root) => nodeDirectory === root || nodeDirectory.startsWith(`${root}/`))) args.push("--ro-bind", nodeDirectory, nodeDirectory);
  args.push("--ro-bind", input.kitDir, input.kitDir, "--bind", input.workDir, input.workDir, "--bind", input.outDir, input.outDir, "--proc", "/proc", "--dev", "/dev");
  for (const [name, value] of Object.entries(env)) args.push("--setenv", name, value);
  args.push("--chdir", input.workDir, "--");
  return args;
}

export interface SandboxEnvironment {
  platform: NodeJS.Platform;
  /** The absolute path of an executable on this computer, or undefined. */
  find(name: string): string | undefined;
  realHome: string | undefined;
  nodeBinary: string;
}

export function systemSandboxEnvironment(): SandboxEnvironment {
  const find = (name: string): string | undefined => {
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      if (directory === "") continue;
      const candidate = join(directory, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
    return undefined;
  };
  return { platform: process.platform, find, realHome: process.env.HOME, nodeBinary: process.execPath };
}

/** The sandbox this computer offers, or undefined: the kit is then not run. */
export function planSandbox(input: SynthRunInput, environment: SandboxEnvironment): SandboxPlan | undefined {
  if (environment.platform === "darwin") {
    const command = "/usr/bin/sandbox-exec";
    if (!existsSync(command) && environment.find("sandbox-exec") === undefined) return undefined;
    return { kind: "sandbox-exec", command: existsSync(command) ? command : (environment.find("sandbox-exec") as string), args: ["-p", macProfile(input, environment.realHome)], description: "macOS sandbox-exec (no network, no sockets, writes only to its own directories)" };
  }
  if (environment.platform === "linux") {
    const command = environment.find("bwrap");
    if (command === undefined) return undefined;
    return { kind: "bwrap", command, args: bwrapArguments(input, environment.nodeBinary, kitEnvironment(input.workDir)), description: "bubblewrap (no network, no sockets, a file system of its own)" };
  }
  return undefined;
}

export const NO_SANDBOX_MESSAGE = "this computer has no sandbox to run the bundle's synthesis kit in (macOS sandbox-exec, or bubblewrap on Linux), and the kit is not run without one. Install bubblewrap (bwrap) or run this on a machine that has a sandbox. Nothing was built";

const KIT_TIME_LIMIT_MS = 15 * 60 * 1000;
const KIT_OUTPUT_LIMIT = 64 * 1024;

/** Node's permission model flag for this runtime, or none. */
function permissionFlag(): string | undefined {
  const flags = process.allowedNodeEnvironmentFlags;
  if (flags.has("--permission")) return "--permission";
  if (flags.has("--experimental-permission")) return "--experimental-permission";
  return undefined;
}

/**
 * Starts the kit's process, inside `wrapper` when one is given, and waits for it. Exported for the tests that need to run a probe kit WITHOUT a sandbox as a positive control; the
 * runner the commands use (`createNodeSynthRunner`) never calls it without one.
 */
export async function runKitProcess(input: SynthRunInput, wrapper: Pick<SandboxPlan, "command" | "args"> | undefined, limits: { timeMs?: number; outputBytes?: number } = {}): Promise<void> {
  const flag = permissionFlag();
  const nodeArgs = [
    ...(flag === undefined ? [] : [flag, `--allow-fs-read=${input.kitDir}`, `--allow-fs-read=${input.workDir}`, `--allow-fs-read=${input.outDir}`, `--allow-fs-write=${input.workDir}`, `--allow-fs-write=${input.outDir}`]),
    input.entry, input.contextFile, input.outDir,
  ];
  const timeMs = limits.timeMs ?? KIT_TIME_LIMIT_MS;
  const outputBytes = limits.outputBytes ?? KIT_OUTPUT_LIMIT;
  await new Promise<void>((resolve, reject) => {
    const [command, args] = wrapper === undefined ? [process.execPath, nodeArgs] : [wrapper.command, [...wrapper.args, process.execPath, ...nodeArgs]];
    const child = spawn(command, args, { cwd: input.workDir, env: kitEnvironment(input.workDir), stdio: ["ignore", "pipe", "pipe"] });
    let seen = 0;
    let errorText = "";
    let tooLong = false;
    const keep = (chunk: Buffer) => { seen += chunk.length; if (seen > outputBytes) child.kill("SIGKILL"); };
    child.stdout.on("data", keep);
    child.stderr.on("data", (chunk: Buffer) => { keep(chunk); if (errorText.length < 400) errorText += chunk.toString("utf8"); });
    const timer = setTimeout(() => { tooLong = true; child.kill("SIGKILL"); }, timeMs);
    child.on("error", () => { clearTimeout(timer); reject(agentXError("CONFIG_INVALID", "the bundle's synthesis kit could not be started; nothing was built")); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null && seen <= outputBytes && !tooLong) resolve();
      else {
        // What the kit said on its error output, cut short and made safe to show on a terminal: it is the kit's own text, never a secret of ours (it was given none).
        const said = errorText.replace(/[^\x20-\x7e\n]/g, "?").split("\n").map((line) => line.trim()).filter((line) => line !== "").slice(0, 3).join(" | ").slice(0, 240);
        const why = tooLong ? "it ran too long" : seen > outputBytes ? "it printed too much" : "it exited with an error";
        reject(agentXError("CONFIG_INVALID", `the bundle's synthesis kit failed (${why})${said === "" ? "" : `: ${said}`}; nothing was built`));
      }
    });
  });
}

/** The runner the commands use. With no sandbox on this computer (`environment` finds none) it refuses to run the kit; it never runs it without one. */
export function createNodeSynthRunner(environment: SandboxEnvironment = systemSandboxEnvironment(), limits: { timeMs?: number; outputBytes?: number } = {}): SynthRunner {
  const probe = planSandbox({ entry: "", kitDir: "/", contextFile: "", outDir: "/", workDir: "/" }, environment);
  return {
    confined: permissionFlag() !== undefined,
    sandbox: probe?.description ?? "none",
    async run(input) {
      const plan = planSandbox(input, environment);
      if (plan === undefined) throw agentXError("CONFIG_INVALID", NO_SANDBOX_MESSAGE);
      await runKitProcess(input, plan, limits);
    },
  };
}

export const nodeSynthRunner: SynthRunner = createNodeSynthRunner();
