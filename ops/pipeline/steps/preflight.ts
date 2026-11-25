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

async function createManifest(ctx: StepContext, state: State): Promise<Manifest> {
  const { ports, config, inputs } = ctx;
  const resolved = await resolveCloudRef(ports, config, inputs.cloudRef);
  ctx.log(`Cloud ref: ${resolved.tag} at ${resolved.sha.slice(0, 12)} (${resolved.ref}, on ${resolved.trunk})`);
  const live = await readLiveCloudSha(ports, stackName(config, ctx.env, "web"), stackName(config, ctx.env, "gateway"));
  const decision = await decideMode(ports, { requested: inputs.codeRelease, resolved, liveSha: live.sha, adopt: inputs.adopt, env: ctx.env });
  await requireLastGoodUnlessAdoption(ctx, decision.mode);
  const exec8 = inputs.execId.slice(0, 8);
  if (decision.mode === "rollback" && inputs.codeLiveSha === null) throw new StageError("ROLLBACK_REFUSED", `${resolved.tag} is older than the live Cloud (${live.sha?.slice(0, 9)}): a rollback run needs CODE_LIVE_SHA to pin Code to what is live`);
  const manifest: Manifest = {
    schema: 1, executionId: inputs.execId, exec8, createdAt: ports.clock.now().toISOString(), mode: decision.mode,
    cloud: { tag: resolved.tag, sha: resolved.sha, ref: resolved.ref, trunk: resolved.trunk, liveSha: { beta: null, production: null } },
    code: { sha: inputs.codeSha, release: decision.codeRelease, requestedRelease: inputs.codeRelease, pinnedSha: { beta: null, production: null }, supersedes: inputs.supersedes },
    gateway: { digest: null, source: null, imageTag: null, repository: null },
    stages: {},
  };
  manifest.cloud.liveSha[ctx.env] = live.sha;
  if (decision.mode === "rollback") manifest.code.pinnedSha[ctx.env] = inputs.codeLiveSha;
  const stage = newStageRecord(ctx.env, ports.clock.now(), inputs.dryRun);
  stage.warnings.push(...live.warnings, ...decision.warnings);
  manifest.stages[ctx.env] = stage;
  state.manifest = manifest;
  return manifest;
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
  if (manifest.mode === "rollback") {
    if (inputs.codeLiveSha === null) throw new StageError("ROLLBACK_REFUSED", `this is a rollback run: ${ctx.env} preflight needs CODE_LIVE_SHA to pin Code to what is live there`);
    manifest.code.pinnedSha[ctx.env] = inputs.codeLiveSha;
  }
  const stage = newStageRecord(ctx.env, ports.clock.now(), inputs.dryRun);
  stage.warnings.push(...live.warnings);
  manifest.stages[ctx.env] = stage;
  return manifest;
}

export async function preflight(ctx: StepContext, state: State): Promise<void> {
  const first = state.manifest === null;
  if (first && ctx.env !== "beta") throw new StageError("REFUSED", `${ctx.env} preflight needs the manifest of the earlier stage`);
  const manifest = first ? await createManifest(ctx, state) : await joinManifest(ctx, state);
  const stage = stageOf(manifest, ctx.env);
  if (ctx.inputs.supersedes !== null) ctx.log(`this run supersedes execution ${ctx.inputs.supersedes.executionId.slice(0, 8)}`);
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
