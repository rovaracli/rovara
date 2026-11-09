// Lessons replay (lane 7): the install side of the replay's executor port, over the `agentx` CLI as an administrator (the way `scripts/e2e-replay-round.ts` reaches the e2e replay). Each call is one of
//   agentx --json --env <env> admin task lessons-replay start --task <past task> --request-id <id> --memory off|snapshot:<id> --max-usd <usd> [--lessons <refs.json>]
//   agentx --json --env <env> admin task lessons-replay show  --task <copy>
//   agentx --json --env <env> admin cancel --workspace <copy's workspace>
// The broker makes the copy: marked as a replay at creation, in the past task's project, never shared or published, its spend held to --max-usd. This port adds no authority: it is the administrator's own sign-in.
// It makes no AWS call of its own (the CLI talks to the control plane); on staging, run the script that uses it through ~/.local/share/rovara-tools/staging-aws.sh.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReplayStartRequest, ReplayTaskEnd, ReplayTaskPort } from "../packages/broker/src/lessons/replay-executor.js";

export type CliResult = { status: number; stdout: string; stderr: string };
export interface CliPortOptions {
  env: string;
  /** Runs `agentx --json --env <env> <arguments>`. */
  cli(argumentsList: readonly string[]): CliResult;
  sleep(ms: number): Promise<void>;
  now(): number;
  pollSeconds?: number;
  timeoutMinutes?: number;
}

type Json = Record<string, unknown>;
const parse = (text: string): Json | undefined => { try { const value: unknown = JSON.parse(text); return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : undefined; } catch { return undefined; } };
/** `agentx --json` wraps a success as { ok: true, data } and a failure as { ok: false, error }. */
const answerOf = (result: CliResult): Json | undefined => {
  if (result.status !== 0) return undefined;
  const body = parse(result.stdout);
  if (body === undefined || body["ok"] === false) return undefined;
  const data = body["data"];
  return body["ok"] === true && typeof data === "object" && data !== null && !Array.isArray(data) ? data as Json : body;
};
const refusal = (result: CliResult): string => {
  const error = (parse(result.stdout) ?? parse(result.stderr))?.["error"] as { message?: unknown } | undefined;
  return typeof error?.message === "string" ? error.message.slice(0, 300) : result.stderr.trim().slice(0, 300) || `exit ${String(result.status)}`;
};

export function cliReplayPort(options: CliPortOptions): ReplayTaskPort {
  const poll = (options.pollSeconds ?? 15) * 1000;
  const timeout = (options.timeoutMinutes ?? 60) * 60_000;
  const view = (taskId: string): Json | undefined => (answerOf(options.cli(["admin", "task", "lessons-replay", "show", "--task", taskId]))?.["replay"] as Json | undefined);
  const workspaces = new Map<string, string>();
  return {
    async start(request: ReplayStartRequest) {
      // A repeat of the same run key is the same start: the request id is derived from it.
      const requestId = uuidOf(request.runKey);
      const memory = request.memory;
      const args = ["admin", "task", "lessons-replay", "start", "--task", request.sourceTaskId, "--request-id", requestId, "--max-usd", String(request.maxUsd), "--memory", memory === undefined || memory.mode === "off" ? "off" : `snapshot:${memory.snapshotId}`];
      let dir: string | undefined;
      try {
        if (memory?.mode === "snapshot" && memory.lessons !== undefined) {
          dir = mkdtempSync(join(tmpdir(), "lessons-replay-"));
          const file = join(dir, "lessons.json");
          writeFileSync(file, JSON.stringify(memory.lessons));
          args.push("--lessons", file);
        }
        const started = options.cli(args);
        const replay = answerOf(started)?.["replay"] as Json | undefined;
        if (typeof replay?.["taskId"] !== "string") throw new Error(`the replay copy was not started: ${refusal(started)}`);
        return { taskId: replay["taskId"] };
      } finally { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); }
    },
    async readMark(taskId) {
      const shown = view(taskId);
      if (shown?.["workspaceId"] !== undefined && typeof shown["workspaceId"] === "string") workspaces.set(taskId, shown["workspaceId"]);
      return shown?.["evalRun"];
    },
    async cancel(taskId) {
      const workspaceId = workspaces.get(taskId) ?? (view(taskId)?.["workspaceId"] as string | undefined);
      if (workspaceId === undefined) return;
      options.cli(["admin", "cancel", "--workspace", workspaceId]);
    },
    async waitForEnd(taskId): Promise<ReplayTaskEnd> {
      const deadline = options.now() + timeout;
      for (;;) {
        const shown = view(taskId);
        const state = shown?.["state"];
        if (state === "completed" || state === "failed") return { state, evidence: taskId, costUsd: typeof shown?.["costUsd"] === "number" ? shown["costUsd"] : null };
        if (options.now() >= deadline) throw new Error(`the replay copy did not finish within ${String(options.timeoutMinutes ?? 60)} minutes`);
        await options.sleep(poll);
      }
    },
    async loadedKeys(taskId) {
      const keys = view(taskId)?.["loadedKeys"];
      return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [];
    },
    async learningCalls(taskId) { return view(taskId)?.["learningCalls"] === 0 ? 0 : 1; },
  };
}

/** A stable UUID-shaped id for a run key. */
export function uuidOf(text: string): string {
  const h = createHash("sha256").update(text).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function realCliPortOptions(input: { env: string; repoRoot: string; profile?: string; region?: string }): CliPortOptions {
  return {
    env: input.env,
    cli: (argumentsList) => {
      const result = spawnSync("node", [join(input.repoRoot, "packages/cli/dist/bin.js"), "--json", "--env", input.env, ...argumentsList], {
        cwd: input.repoRoot, encoding: "utf8", env: { ...process.env, ...(input.profile === undefined ? {} : { AWS_PROFILE: input.profile }), ...(input.region === undefined ? {} : { AWS_REGION: input.region }) } });
      return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
    now: () => Date.now(),
  };
}
