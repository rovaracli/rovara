// Lessons replay (lane 7): the install side of the replay's executor, grader and importer, over the `agentx` CLI as an administrator (the way `scripts/e2e-replay-round.ts` reaches the e2e replay). Each call is one of
//   agentx --json --env <env> admin task lessons-replay start|show|approve|close|evidence ...
//   agentx --json --env <env> admin lessons-replay import-snapshot|model ...
//   agentx --json --env <env> admin cancel --workspace <copy's workspace>
// The broker makes the copy: a workflow of the past task's shape, marked as a replay at creation, billed to the project as a test and started by the operator (a company owner or admin), never shared or published, its
// spend held to --max-usd. This port adds no authority: it is the administrator's own sign-in. It makes no AWS call of its own (the CLI talks to the control plane); on staging, run the script that uses it through
// ~/.local/share/rovara-tools/staging-aws.sh.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceReader, GradedEvidence, GraderModel } from "../packages/broker/src/lessons/replay-grader.js";
import type { ReplayStartRequest, ReplayTaskEnd, ReplayTaskPort } from "../packages/broker/src/lessons/replay-executor.js";
import type { PipelineModel } from "../packages/broker/src/lessons/ports.js";
import type { ReflectSubject } from "../packages/broker/src/lessons/reflect-input.js";
import type { LearningSettings } from "../packages/broker/src/lessons/policy.js";
import type { Lesson } from "../packages/broker/src/lessons/types.js";

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
/** Runs a CLI call that takes a JSON file, with the file made and removed around it. */
function withFile<T>(content: unknown, run: (file: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "lessons-replay-"));
  try {
    const file = join(dir, "body.json");
    writeFileSync(file, JSON.stringify(content));
    return run(file);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function cliReplayPort(options: CliPortOptions): ReplayTaskPort {
  const poll = (options.pollSeconds ?? 15) * 1000;
  const timeout = (options.timeoutMinutes ?? 90) * 60_000;
  const task = (verb: string, taskId: string): CliResult => options.cli(["admin", "task", "lessons-replay", verb, "--task", taskId]);
  const view = (taskId: string): Json | undefined => (answerOf(task("show", taskId))?.["replay"] as Json | undefined);
  const workspaces = new Map<string, string>();
  const cost = (shown: Json | undefined): number | null => (typeof shown?.["costUsd"] === "number" ? shown["costUsd"] : null);
  const cancel = async (taskId: string): Promise<void> => {
    const workspaceId = workspaces.get(taskId) ?? (view(taskId)?.["workspaceId"] as string | undefined);
    if (workspaceId !== undefined) options.cli(["admin", "cancel", "--workspace", workspaceId]);
  };
  return {
    async start(request: ReplayStartRequest) {
      // A repeat of the same run key is the same start: the request id is derived from it.
      const memory = request.memory;
      const args = ["admin", "task", "lessons-replay", "start", "--task", request.sourceTaskId, "--request-id", uuidOf(request.runKey), "--max-usd", String(request.maxUsd), "--memory", memory === undefined || memory.mode === "off" ? "off" : `snapshot:${memory.snapshotId}`,
        ...(request.file === true ? ["--file"] : [])];
      const started = options.cli(args);
      const replay = answerOf(started)?.["replay"] as Json | undefined;
      if (typeof replay?.["taskId"] !== "string") throw new Error(`the replay copy was not started: ${refusal(started)}`);
      return { taskId: replay["taskId"], startLimitUsd: typeof replay["startLimitUsd"] === "number" ? replay["startLimitUsd"] : null };
    },
    async readMark(taskId) {
      const shown = view(taskId);
      if (typeof shown?.["workspaceId"] === "string") workspaces.set(taskId, shown["workspaceId"]);
      return shown?.["evalRun"];
    },
    cancel,
    async waitForEnd(taskId, limits): Promise<ReplayTaskEnd> {
      const deadline = options.now() + timeout;
      for (;;) {
        const shown = view(taskId);
        const spent = cost(shown);
        const state = shown?.["state"];
        if (state === "completed") return { state: "completed", evidence: taskId, costUsd: spent };
        if (state === "failed") return { state: "failed", evidence: taskId, costUsd: spent };
        // The copy's spend reached the run's limit, or the wait ran out: stop it here, whatever it is doing.
        if (spent !== null && spent >= limits.maxUsd) { await cancel(taskId); return { state: "failed", evidence: taskId, costUsd: spent }; }
        if (options.now() >= deadline) { await cancel(taskId); return { state: "failed", evidence: taskId, costUsd: spent }; }
        // The one automatic step: a plan that waits is approved by the install's guarded route (a copy and nothing else). A refusal leaves the copy waiting and the wait runs out.
        if (state === "awaiting_plan") task("approve", taskId);
        await options.sleep(poll);
      }
    },
    async costOf(taskId) { return cost(view(taskId)); },
    async loadedKeys(taskId) {
      const keys = view(taskId)?.["loadedKeys"];
      return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [];
    },
    // Every learning path refuses a replay copy (tests prove each), and the install does not count calls; a copy that cannot be read at all is reported as having made one so the replay stops.
    async learningCalls(taskId) { return view(taskId) === undefined ? 1 : 0; },
    async close(taskId) { task("close", taskId); },
  };
}

/** The evidence reader for the rubric grader: the copy's request, its change and the past task's merged change, through the install's evidence route. */
export function cliEvidenceReader(options: CliPortOptions): EvidenceReader {
  return {
    async read(taskId): Promise<GradedEvidence> {
      const evidence = answerOf(options.cli(["admin", "task", "lessons-replay", "evidence", "--task", taskId]))?.["evidence"] as Json | undefined;
      if (typeof evidence?.["request"] !== "string") throw new Error("the copy's evidence could not be read");
      return { request: evidence["request"], ...(typeof evidence["attempt"] === "string" ? { attempt: evidence["attempt"] } : {}), ...(typeof evidence["reference"] === "string" ? { reference: evidence["reference"] } : {}) };
    },
  };
}

/** The grader's model: the company's own model path through the install's operator route (not behind the lessons switch: a grading is not learning), one call at a time, each held to `holdUsd`. */
export function cliGraderModel(options: CliPortOptions, input: { project: string; model: string; version: string; holdUsd: number; maxOutputTokens?: number }): GraderModel {
  return {
    model: input.model, version: input.version, holdUsd: input.holdUsd,
    async complete({ system, user }) {
      const answered = withFile({ purpose: "grade", system, user, maxOutputTokens: input.maxOutputTokens ?? 600, maxUsd: input.holdUsd }, (file) => options.cli(["admin", "lessons-replay", "model", "--project", input.project, "--file", file]));
      const body = answerOf(answered);
      if (typeof body?.["text"] !== "string") throw new Error(`the grader's model call was refused: ${refusal(answered)}`);
      // The grading must come from the model the replay declared: the company's route can change under a long run (its lessons model is a setting), and gradings by different models are not comparable.
      if (body["model"] !== input.model) throw new Error(`the grader answered as ${typeof body["model"] === "string" ? body["model"] : "an unnamed model"}, not the declared ${input.model}; the replay's grader must not change`);
      return { text: body["text"], costUsd: typeof body["costUsd"] === "number" ? body["costUsd"] : null };
    },
  };
}

/** The offline pipeline's model: the company's own model path through the install's operator route (purpose "learn"), each call held to `holdUsd`; the reply carries the cost, which the pipeline counts. */
export function cliPipelineModel(options: CliPortOptions, input: { project: string; holdUsd: number }): PipelineModel {
  return {
    async quote() { return { ok: true, usd: input.holdUsd }; },
    async complete(request) {
      const answered = withFile({ purpose: "learn", system: request.system, user: request.user, maxOutputTokens: request.maxOutputTokens, maxUsd: input.holdUsd }, (file) => options.cli(["admin", "lessons-replay", "model", "--project", input.project, "--file", file]));
      const body = answerOf(answered);
      if (typeof body?.["text"] !== "string") throw new Error(`the pipeline's model call was refused: ${refusal(answered)}`);
      return { text: body["text"], costUsd: typeof body["costUsd"] === "number" ? body["costUsd"] : input.holdUsd, model: "company" };
    },
  };
}

/** The project's learning settings as the live pipeline reads them, whether the install's auto-apply switch is on and whether it has an embedder, through the install (a company owner or admin). */
export function cliProjectSettings(options: CliPortOptions, project: string): { settings: LearningSettings; autoApply: boolean; embedder: boolean } {
  const answered = options.cli(["admin", "lessons-replay", "settings", "--project", project]);
  const body = answerOf(answered);
  const settings = body?.["settings"];
  if (typeof settings !== "object" || settings === null || Array.isArray(settings) || typeof body?.["autoApply"] !== "boolean") throw new Error(`the project's learning settings could not be read: ${refusal(answered)}`);
  return { settings: settings, autoApply: body["autoApply"], embedder: body["embedder"] === true };
}

/** A historical task as the reflector sees it at its end, through the install (a replay copy, or a task of another project, is not found). */
export function cliSubjectOf(options: CliPortOptions, project: string): (taskId: string) => Promise<ReflectSubject | undefined> {
  return async (taskId) => {
    const subject = answerOf(options.cli(["admin", "lessons-replay", "subject", "--project", project, "--task", taskId]))?.["subject"];
    return typeof subject === "object" && subject !== null ? subject as ReflectSubject : undefined;
  };
}

/** Imports one frozen snapshot of an arm's lessons; the answer's id is the one the install derived from the lessons. */
export function importSnapshot(options: CliPortOptions, input: { project: string; pipeline: string; day: string; lessons: readonly Lesson[] }): string {
  const answered = withFile(input.lessons, (file) => options.cli(["admin", "lessons-replay", "import-snapshot", "--project", input.project, "--pipeline", input.pipeline, "--day", input.day, "--file", file]));
  const snapshotId = (answerOf(answered)?.["snapshot"] as Json | undefined)?.["snapshotId"];
  if (typeof snapshotId !== "string") throw new Error(`the snapshot was not imported: ${refusal(answered)}`);
  return snapshotId;
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
