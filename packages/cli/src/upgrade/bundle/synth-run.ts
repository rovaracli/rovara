// Runs the release's own pinned CDK app (the synthesis kit in a verified bundle) to build one install's templates. The kit is code, signed with the bundle, so it is run as
// little as possible: its only input is a context file this command wrote, it gets no credentials and no environment of the caller's, it runs in a directory of its own,
// and where the platform's permission model exists it can read only its own files and write only its output directory. It is given no network on purpose and needs none;
// nothing here fetches anything.
import { spawn } from "node:child_process";
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
  /** Whether the runner confines the kit to its own files (Node's permission model). Shown to the approver; false is not a refusal. */
  readonly confined: boolean;
  run(input: SynthRunInput): Promise<void>;
}

/** The only environment a kit sees. Nothing of the caller's (no AWS credentials, no proxy, no token) is passed on. */
export function kitEnvironment(workDir: string): Record<string, string> {
  return { HOME: workDir, TMPDIR: workDir, TZ: "UTC", LANG: "C", LC_ALL: "C", NODE_ENV: "production" };
}

const KIT_TIME_LIMIT_MS = 15 * 60 * 1000;
const KIT_OUTPUT_LIMIT = 64 * 1024;

/** Node's permission model flag for this runtime, or none. The kit is then confined to its own files; without it the signed bundle's trust is all there is, which the summary says. */
function permissionFlag(): string | undefined {
  const flags = process.allowedNodeEnvironmentFlags;
  if (flags.has("--permission")) return "--permission";
  if (flags.has("--experimental-permission")) return "--experimental-permission";
  return undefined;
}

export const nodeSynthRunner: SynthRunner = {
  confined: permissionFlag() !== undefined,
  async run(input) {
    const flag = permissionFlag();
    const args = [
      ...(flag === undefined ? [] : [flag, `--allow-fs-read=${input.kitDir}`, `--allow-fs-read=${input.workDir}`, `--allow-fs-read=${input.outDir}`, `--allow-fs-write=${input.workDir}`, `--allow-fs-write=${input.outDir}`]),
      input.entry, input.contextFile, input.outDir,
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: input.workDir, env: kitEnvironment(input.workDir), stdio: ["ignore", "pipe", "pipe"] });
      let seen = 0;
      let errorText = "";
      const keep = (chunk: Buffer) => { seen += chunk.length; if (seen > KIT_OUTPUT_LIMIT) child.kill("SIGKILL"); };
      child.stdout.on("data", keep);
      child.stderr.on("data", (chunk: Buffer) => { keep(chunk); if (errorText.length < 400) errorText += chunk.toString("utf8"); });
      const timer = setTimeout(() => child.kill("SIGKILL"), KIT_TIME_LIMIT_MS);
      child.on("error", () => { clearTimeout(timer); reject(agentXError("CONFIG_INVALID", "the bundle's synthesis kit could not be started; nothing was built")); });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0 && signal === null && seen <= KIT_OUTPUT_LIMIT) resolve();
        else {
          // What the kit said on its error output, cut short and made safe to show on a terminal: it is the kit's own text, never a secret of ours (it was given none).
          const said = errorText.replace(/[^\x20-\x7e\n]/g, "?").split("\n").map((line) => line.trim()).filter((line) => line !== "").slice(0, 3).join(" | ").slice(0, 240);
          reject(agentXError("CONFIG_INVALID", `the bundle's synthesis kit failed (it printed too much, ran too long or exited with an error)${said === "" ? "" : `: ${said}`}; nothing was built`));
        }
      });
    });
  },
};
