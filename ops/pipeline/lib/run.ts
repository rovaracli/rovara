// The step runner: loads the manifest, handles the production skip and the already-done no-op, enforces the order, runs the step, writes the outputs
// (also after a failure, so the build log and artifact say how far it got), prints the summary.
import { StageError } from "../types.ts";
import { checkAccount } from "./account.ts";
import type { GatePhase, Manifest, StageRecord } from "../types.ts";
import type { StepContext } from "./context.ts";
import { errorText } from "./context.ts";
import { mergeGateRecords, runPhase } from "./gates.ts";
import { markCompleted, newStageRecord, parseManifest, requirePredecessor, serializeManifest, stageOf } from "./manifest.ts";
import { buildSummary, renderExports, renderSummary } from "./summary.ts";
import type { ChangeSetRecord } from "../types.ts";

export interface State { manifest: Manifest | null }
export type StepFunction = (ctx: StepContext, state: State) => Promise<void>;

function readManifest(ctx: StepContext): Manifest | null {
  const path = ctx.inputs.manifestPath;
  if (path === null) return null;
  if (!ctx.ports.fs.exists(path)) throw new StageError("REFUSED", `the manifest ${path} does not exist`);
  return parseManifest(ctx.ports.fs.readText(path));
}

export function requireManifest(state: State): Manifest {
  if (state.manifest === null) throw new StageError("REFUSED", "this step needs the manifest of the previous action (--manifest or PIPELINE_MANIFEST)");
  return state.manifest;
}

/** Runs the gates of a phase against the current manifest, records their verdicts, and throws when one failed or a required one is missing. */
export async function gatePhase(ctx: StepContext, state: State, stage: StageRecord, phase: GatePhase, changeSets: readonly ChangeSetRecord[], cloudDir: string | null, work: string): Promise<void> {
  const manifest = requireManifest(state);
  ctx.log(`gates: ${phase}`);
  const result = await runPhase({
    env: ctx.env, phase, region: ctx.row.region, config: ctx.config, gates: ctx.gates, required: ctx.requiredGates[phase] ?? [], manifest, changeSets,
    dirs: { pipeline: ctx.pipelineDir, cloud: cloudDir, out: ctx.inputs.outDir, work }, ports: ctx.ports, log: ctx.log, dryRun: ctx.inputs.dryRun,
  });
  stage.gates = mergeGateRecords(stage.gates, result.records);
  if (result.missing.length > 0) throw new StageError("GATE_MISSING", `required gate(s) not found for phase ${phase}: ${result.missing.join(", ")}`);
  if (result.failed) throw new StageError("GATE_FAILED", `gate(s) failed in phase ${phase}: ${result.records.filter((r) => r.result === "fail").map((r) => r.name).join(", ")}`);
}

export function writeOutputs(ctx: StepContext, state: State, withExports: boolean): void {
  const manifest = state.manifest;
  if (manifest === null) return;
  const { fs } = ctx.ports;
  const out = ctx.inputs.outDir;
  fs.mkdirp(out);
  const stage = manifest.stages[ctx.env];
  if (stage !== undefined) {
    stage.summary = buildSummary(manifest, ctx.env, stage);
    fs.writeText(`${out}/summary.txt`, renderSummary(stage.summary));
    fs.mkdirp(`${out}/change-sets`);
    for (const cs of stage.changeSets) fs.writeText(`${out}/change-sets/${cs.stack}.json`, `${JSON.stringify(cs, null, 2)}\n`);
  }
  fs.writeText(`${out}/manifest.json`, serializeManifest(manifest));
  if (withExports) fs.writeText(`${out}/exports.env`, renderExports(manifest, ctx.env));
}

function logEvent(ctx: StepContext, event: string, detail: string): void {
  const { fs } = ctx.ports;
  const path = `${ctx.inputs.outDir}/steps.jsonl`;
  const line = JSON.stringify({ at: ctx.ports.clock.now().toISOString(), env: ctx.env, step: ctx.step, event, detail });
  fs.mkdirp(ctx.inputs.outDir);
  fs.writeText(path, `${fs.exists(path) ? fs.readText(path) : ""}${line}\n`);
}

export async function runStep(ctx: StepContext, step: StepFunction): Promise<void> {
  const state: State = { manifest: readManifest(ctx) };
  const isFirst = ctx.env === "beta" && ctx.step === "preflight";
  logEvent(ctx, "start", ctx.inputs.dryRun ? "dry run" : "");
  if (!isFirst) {
    const manifest = requireManifest(state);
    if (manifest.executionId !== ctx.inputs.execId) throw new StageError("REFUSED", `the manifest belongs to execution ${manifest.executionId.slice(0, 8)}, not ${ctx.inputs.execId.slice(0, 8)}`);
    // One execution is either real or dry, never both: a dry stage's "completed" steps must not stand in for real ones (or the reverse).
    for (const other of Object.values(manifest.stages)) {
      if (other.dryRun === !ctx.inputs.dryRun) throw new StageError("REFUSED", `this execution has a ${other.dryRun ? "dry" : "real"} ${other.env} stage: a ${ctx.inputs.dryRun ? "dry" : "real"} run cannot be mixed into it`);
    }
    if (ctx.env === "production" && !ctx.inputs.cloudProd) {
      const stage = manifest.stages.production ?? newStageRecord("production", ctx.ports.clock.now(), ctx.inputs.dryRun);
      manifest.stages.production = stage;
      stage.skipped = "CLOUD_PROD=off";
      ctx.log(`production ${ctx.step}: skipped (CLOUD_PROD is off)`);
      writeOutputs(ctx, state, false);
      logEvent(ctx, "skipped", "CLOUD_PROD=off");
      return;
    }
    if (ctx.step !== "preflight") {
      const stage = stageOf(manifest, ctx.env);
      if (stage.completed.includes(ctx.step)) {
        ctx.log(`${ctx.env} ${ctx.step}: already completed in this execution; nothing to do`);
        writeOutputs(ctx, state, false);
        logEvent(ctx, "already-done", "");
        return;
      }
      requirePredecessor(stage, ctx.step);
    } else if (manifest.stages[ctx.env]?.completed.includes("preflight")) {
      ctx.log(`${ctx.env} preflight: already completed in this execution; nothing to do`);
      writeOutputs(ctx, state, false);
      logEvent(ctx, "already-done", "");
      return;
    }
  }
  const account = await checkAccount(ctx);
  ctx.account = account;
  try {
    await step(ctx, state);
  } catch (error) {
    writeOutputs(ctx, state, false);
    logEvent(ctx, "failed", errorText(error));
    throw error;
  }
  const manifest = requireManifest(state);
  const stage = stageOf(manifest, ctx.env);
  stage.account = account;
  markCompleted(stage, ctx.step);
  writeOutputs(ctx, state, ctx.step === "preflight");
  logEvent(ctx, "done", "");
  ctx.log(renderSummary(stage.summary ?? buildSummary(manifest, ctx.env, stage)));
}
