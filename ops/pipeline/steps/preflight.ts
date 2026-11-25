// Step preflight: resolve the ref and the Code pin, check out and build the candidate, capture the rollback record, run the preflight gates,
// preview the web and app change sets (never executed here), run the change-set gates on them, print the promotion summary.
import { changeSetNameFor, stackName } from "../config.ts";
import { StageError } from "../types.ts";
import type { Manifest, PipelineEnv } from "../types.ts";
import { buildCandidate } from "../lib/candidate.ts";
import type { StepContext } from "../lib/context.ts";
import { previewChangeSets } from "../lib/changesets.ts";
import { newStageRecord, stageOf } from "../lib/manifest.ts";
import { decideMode, readLiveCloudSha, resolveCloudRef } from "../lib/refs.ts";
import { captureRollbackRecord } from "../lib/rollback.ts";
import { readLastGood } from "../lib/lastgood.ts";
import { gatePhase, requireManifest } from "../lib/run.ts";
import type { State } from "../lib/run.ts";

export async function previewWebApp(ctx: StepContext, state: State, dir: string): Promise<void> {
  const manifest = requireManifest(state);
  const stage = stageOf(manifest, ctx.env);
  if (ctx.inputs.dryRun) { stage.warnings.push("dry run: no change sets were created"); return; }
  const stacks = (["app", "web"] as const).map((part) => ({ part, stack: stackName(ctx.config, ctx.env, part), stackId: ctx.config.stackIds[part] }));
  stage.changeSets = stage.changeSets.filter((cs) => cs.part === "gateway");
  stage.changeSets.push(...await previewChangeSets({
    ports: ctx.ports, dir, changeSetName: changeSetNameFor(manifest.exec8), stacks,
    context: { ...ctx.contextFor("web"), rovaraCloudSha: manifest.cloud.sha }, parameters: { CodeUrl: ctx.codeUrl }, log: ctx.log,
  }));
}

/**
 * A first release must go through an explicit adoption run: a release or rollback run in an environment with NO last-good record is refused (exit 42), because
 * nothing says what is live there and the adoption run is the one that proves a no-op against it. An adoption run keeps its own rules (empty change sets, live digest).
 */
export async function requireLastGoodUnlessAdoption(ctx: StepContext, mode: Manifest["mode"]): Promise<void> {
  if (mode === "adoption") return;
  if ((await readLastGood(ctx.ports, ctx.config, ctx.env)) === null) {
    throw new StageError("ADOPTION_REQUIRED", `${ctx.env} has no last-good record: its first release must be an adoption run (PIPELINE_MODE=adopt with CLOUD_REF set to the tag already live), not a ${mode} run`);
  }
}

const PIPELINE_EXEC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * The Code facts of a run (L9b): a pipeline execution gets them in CODE_CTX (the Code Preflight exports it to this action only), and a pipeline run WITHOUT it is refused: nothing is guessed.
 * A hand-started run (a local execution id) passes them as variables. A Code target needs a declared rollback (PIPELINE_MODE=rollback) and CODE_RELEASE=run: Code deploys the target.
 */
export function checkCodeInputs(ctx: StepContext): void {
  const { inputs } = ctx;
  if (PIPELINE_EXEC_ID.test(inputs.execId) && !inputs.codeCtxGiven) throw new StageError("REFUSED", "CODE_CTX is not set: the Code Preflight action exports it and the pipeline hands it to this action (live, target and supersession of Code); a pipeline run does not guess them");
  if (inputs.codeTarget !== null && !inputs.declaredRollback) throw new StageError("USAGE", "a Code rollback target needs PIPELINE_MODE=rollback");
  if (inputs.codeTarget !== null && inputs.codeLiveSha !== null && inputs.codeTarget === inputs.codeLiveSha) throw new StageError("ROLLBACK_REFUSED", `the Code rollback target ${inputs.codeTarget.slice(0, 12)} is the commit Code runs now: nothing to roll back`);
  if (inputs.supersedes !== null && inputs.supersedes.executionId === inputs.execId) throw new StageError("REFUSED", "this run cannot supersede itself (CODE_CTX names this execution)");
}

/** What Code is pinned to in a rollback: the target when there is one (Code moves there), else the commit that is live (Code stays). */
const pinFor = (inputs: StepContext["inputs"]): string | null => inputs.codeTarget ?? inputs.codeLiveSha;

async function createManifest(ctx: StepContext, state: State): Promise<Manifest> {
  const { ports, config, inputs } = ctx;
  const resolved = await resolveCloudRef(ports, config, inputs.cloudRef);
  ctx.log(`Cloud ref: ${resolved.tag} at ${resolved.sha.slice(0, 12)} (${resolved.ref}, on ${resolved.trunk})`);
  const live = await readLiveCloudSha(ports, stackName(config, ctx.env, "web"), stackName(config, ctx.env, "gateway"));
  const decision = await decideMode(ports, { requested: inputs.codeRelease, resolved, liveSha: live.sha, adopt: inputs.adopt, env: ctx.env, declared: inputs.declaredRollback, codeTarget: inputs.codeTarget });
  await requireLastGoodUnlessAdoption(ctx, decision.mode);
  const exec8 = inputs.execId.slice(0, 8);
  if (decision.mode === "rollback" && inputs.codeLiveSha === null) throw new StageError("ROLLBACK_REFUSED", `this is a rollback to ${resolved.tag} (the live Cloud is ${live.sha?.slice(0, 9) ?? "unknown"}): a rollback run needs the live Code commit (CODE_CTX live; CODE_LIVE_SHA in a hand-started run) to pin Code`);
  const manifest: Manifest = {
    schema: 1, executionId: inputs.execId, exec8, createdAt: ports.clock.now().toISOString(), mode: decision.mode,
    cloud: { tag: resolved.tag, sha: resolved.sha, ref: resolved.ref, trunk: resolved.trunk, liveSha: { beta: null, production: null } },
    code: { sha: inputs.codeSha, release: decision.codeRelease, requestedRelease: inputs.codeRelease, pinnedSha: { beta: null, production: null }, supersedes: inputs.supersedes, liveSha: { beta: null, production: null }, rollbackTarget: inputs.codeTarget },
    gateway: { digest: null, source: null, imageTag: null, repository: null },
    stages: {},
  };
  manifest.cloud.liveSha[ctx.env] = live.sha;
  manifest.code.liveSha![ctx.env] = inputs.codeLiveSha;
  if (decision.mode === "rollback") manifest.code.pinnedSha[ctx.env] = pinFor(inputs);
  const stage = newStageRecord(ctx.env, ports.clock.now(), inputs.dryRun);
  stage.warnings.push(...live.warnings, ...decision.warnings);
  manifest.stages[ctx.env] = stage;
  state.manifest = manifest;
  return manifest;
}

/**
 * A rollback (declared or detected) never moves a stage's Cloud forward. Beta's preflight proves it for Beta (decideMode); production may lag Beta (a superseded run waits at the
 * gate), so production proves it for itself: its live Cloud, when known and different, must descend from the manifest's Cloud sha (the manifest's Cloud is then an ancestor: older).
 * Not provable (the commit is unknown to git) = refused. A live sha that is unknown cannot be judged: a warning, and the summary says the change is not proven.
 */
async function requireNoForwardMove(ctx: StepContext, manifest: Manifest, liveSha: string | null): Promise<string[]> {
  if (manifest.mode !== "rollback") return [];
  if (liveSha === null) return [`${ctx.env}'s live Cloud sha is unknown, so it is not proven that this rollback leaves ${ctx.env}'s Cloud where it is or moves it back`];
  if (liveSha === manifest.cloud.sha) return [];
  let older = false;
  try { older = await ctx.ports.git.isAncestor(manifest.cloud.sha, liveSha); } catch { /* unknown to git: not proven, refused below */ }
  if (!older) throw new StageError("ROLLBACK_REFUSED", `this is a rollback, but ${manifest.cloud.tag} (${manifest.cloud.sha.slice(0, 9)}) is not the Cloud ${ctx.env} runs (${liveSha.slice(0, 9)}) or older than it: a rollback never moves Cloud forward (${ctx.env} may lag beta; roll it back to a tag it can reach, or release instead)`);
  return [];
}

/**
 * Production joins a run Beta decided: its Code facts must agree with the manifest's (never re-decided). The target is the one value of the run, and a stage that disagrees refuses.
 * Production's CODE_CTX says `none` for the supersession (Beta's stay in the manifest); a supersession it names itself must be the manifest's.
 */
function joinCodeFacts(ctx: StepContext, manifest: Manifest): void {
  const { inputs } = ctx;
  const target = manifest.code.rollbackTarget ?? null;
  // A hand-started run may omit the target (the manifest's stands), but one it names must be the manifest's: never silently ignored.
  if ((inputs.codeCtxGiven || inputs.codeTarget !== null) && inputs.codeTarget !== target) throw new StageError("REFUSED", `${ctx.env} CODE_CTX names the Code target ${inputs.codeTarget === null ? "none" : inputs.codeTarget.slice(0, 12)}, but this execution's target (from beta) is ${target === null ? "none" : target.slice(0, 12)}: a run has one Code target`);
  if (inputs.supersedes !== null) {
    const kept = manifest.code.supersedes;
    if (kept === null || kept.executionId !== inputs.supersedes.executionId || kept.codeSha !== inputs.supersedes.codeSha) throw new StageError("REFUSED", `${ctx.env} CODE_CTX names a superseded execution that beta's record does not (a supersession is decided once, by beta)`);
  }
  if (manifest.mode === "rollback") {
    if (inputs.codeLiveSha === null) throw new StageError("ROLLBACK_REFUSED", `this is a rollback run: ${ctx.env} preflight needs the live Code commit (CODE_CTX live) to pin Code`);
    manifest.code.pinnedSha[ctx.env] = target ?? inputs.codeLiveSha;
  }
  manifest.code.liveSha = { beta: manifest.code.liveSha?.beta ?? null, production: manifest.code.liveSha?.production ?? null };
  manifest.code.liveSha[ctx.env] = inputs.codeLiveSha;
}

async function joinManifest(ctx: StepContext, state: State): Promise<Manifest> {
  // Production (or a later environment): the run is already decided in the first stage; this stage reads its own live state.
  const manifest = requireManifest(state);
  const { ports, config, inputs } = ctx;
  // Production starts only from a beta that finished its proof in THIS execution.
  const beta = manifest.stages.beta;
  if (ctx.env === "production" && beta?.completed.includes("proof") !== true) throw new StageError("REFUSED", "production preflight comes after beta's proof, which has not completed in this execution");
  // A dry run proves nothing, and a record that does not say it was real is not proof either.
  if (ctx.env === "production" && beta?.dryRun !== false) throw new StageError("REFUSED", "beta's proof in this execution was a dry run (or does not say it was real): it is not proof for production");
  await requireLastGoodUnlessAdoption(ctx, manifest.mode);
  const live = await readLiveCloudSha(ports, stackName(config, ctx.env, "web"), stackName(config, ctx.env, "gateway"));
  manifest.cloud.liveSha[ctx.env] = live.sha;
  const warnings = await requireNoForwardMove(ctx, manifest, live.sha);
  joinCodeFacts(ctx, manifest);
  const stage = newStageRecord(ctx.env, ports.clock.now(), inputs.dryRun);
  stage.warnings.push(...live.warnings, ...warnings);
  manifest.stages[ctx.env] = stage;
  return manifest;
}

export async function preflight(ctx: StepContext, state: State): Promise<void> {
  checkCodeInputs(ctx);
  const first = state.manifest === null;
  if (first && ctx.env !== "beta") throw new StageError("REFUSED", `${ctx.env} preflight needs the manifest of the earlier stage`);
  const manifest = first ? await createManifest(ctx, state) : await joinManifest(ctx, state);
  const stage = stageOf(manifest, ctx.env);
  const superseded = manifest.code.supersedes;
  if (superseded !== null) ctx.log(`this run supersedes execution ${superseded.executionId.slice(0, 8)}${superseded.codeSha === null ? "" : `, whose Code sha ${superseded.codeSha.slice(0, 12)} ${superseded.codeSha === manifest.code.sha && manifest.code.release === "run" && manifest.code.rollbackTarget == null ? "this run promotes" : "is not promoted"}`}`);
  if (manifest.code.rollbackTarget != null) ctx.log(`Code rolls back to ${manifest.code.rollbackTarget.slice(0, 12)} (from ${(manifest.code.liveSha?.[ctx.env] ?? null) === null ? "an unknown commit" : manifest.code.liveSha![ctx.env]!.slice(0, 12)})`);
  if (manifest.mode === "adoption") await adoptGatewayDigest(ctx, manifest);
  const dir = await buildCandidate(ctx, manifest.cloud.sha, true);
  stage.rollback = await captureRollbackRecord(ctx.ports, ctx.config, ctx.env, ctx.inputs, manifest.cloud.liveSha[ctx.env]);
  await gatePhase(ctx, state, stage, "preflight", [], dir, ctx.inputs.workDir);
  await previewWebApp(ctx, state, dir);
  if (!ctx.inputs.dryRun) await gatePhase(ctx, state, stage, "change-sets", stage.changeSets.filter((cs) => cs.part !== "gateway"), dir, ctx.inputs.workDir);
}

/** Adoption: the gateway keeps the digest it runs now (BETA-CLOUD-PLAN 3.1): no build, no new image. */
async function adoptGatewayDigest(ctx: StepContext, manifest: Manifest): Promise<void> {
  const stack = await ctx.ports.cfn.describeStack(stackName(ctx.config, ctx.env, "gateway"));
  const digest = stack?.parameters.ImageDigest;
  if (digest === undefined || !/^sha256:[0-9a-f]{64}$/u.test(digest)) throw new StageError("REFUSED", `adoption needs the live gateway ImageDigest parameter, and ${ctx.env} has none`);
  // Each environment keeps its OWN live digest in an adoption run (the manifest holds the digest of the stage being processed).
  manifest.gateway = { digest, source: "adopted", imageTag: null, repository: null };
}

export type { PipelineEnv };
