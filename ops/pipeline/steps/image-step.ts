// The L2 side of the image step: what is checked around L6's runImage. This file is L2's; L6 only replaces steps/image.ts.
import { StageError } from "../types.ts";
import { checkoutCodeTree } from "../lib/candidate.ts";
import { codeShaForBuild, codeShaForRecordedDigest } from "../lib/gateway-code.ts";
import { readLastGood } from "../lib/lastgood.ts";
import type { StepContext } from "../lib/context.ts";
import { stageOf } from "../lib/manifest.ts";
import { recordedGatewayDigests } from "../lib/rollbackplan.ts";
import { requireManifest } from "../lib/run.ts";
import type { State } from "../lib/run.ts";
import { runImage } from "./image.ts";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export async function imageStep(ctx: StepContext, state: State, run: typeof runImage = runImage): Promise<void> {
  const manifest = requireManifest(state);
  const stage = stageOf(manifest, ctx.env);
  const { inputs } = ctx;
  if (manifest.gateway.source === "adopted") {
    // The adopted gateway keeps its digest; its stack is still synthesized from Code (the gateway step), at the commit that will be live in this environment.
    manifest.gateway.codeSha = codeShaForBuild(manifest, ctx.env);
    ctx.log(`adoption: the gateway keeps its live digest; no image is built or copied (its stack is made from Code ${manifest.gateway.codeSha.slice(0, 12)})`);
    return;
  }
  if (inputs.gatewayDigest !== null && !DIGEST.test(inputs.gatewayDigest)) throw new StageError("USAGE", "GATEWAY_DIGEST must look like sha256:<64 hex>");
  // L9: a rollback goes back to a gateway image that already ran (the recorded digest); it never builds a new image from old source.
  if (manifest.mode === "rollback" && ctx.env === "beta" && inputs.gatewayDigest === null) throw new StageError("ROLLBACK_REFUSED", "a rollback run needs GATEWAY_DIGEST, the digest recorded with the release it goes back to (stage.ts <env> rollback-plan prints it)");
  if (ctx.env === "production") {
    if (inputs.gatewayDigest !== null) throw new StageError("REFUSED", "production copies the digest beta ran; it takes no GATEWAY_DIGEST");
    if (manifest.gateway.digest === null || !DIGEST.test(manifest.gateway.digest)) throw new StageError("REFUSED", "production has no gateway digest to copy: the beta stage of this execution did not record one");
  }
  if (manifest.mode === "rollback") {
    // A rollback goes back to an image this environment already ran as a release that passed its proofs: the digest must be one its last-good record names
    // (current or previous), never a hand-typed digest of some older image that merely exists in the repository.
    const digest = ctx.env === "beta" ? inputs.gatewayDigest : manifest.gateway.digest;
    const recorded = await recordedGatewayDigests(ctx.ports, ctx.config, ctx.env);
    if (digest === null || !recorded.includes(digest)) throw new StageError("ROLLBACK_REFUSED", `the rollback's gateway digest ${digest === null ? "(none)" : `${digest.slice(0, 19)}...`} is not one the ${ctx.env} last-good record names${recorded.length === 0 ? " (there is no last-good record)" : ""}: use the digest stage.ts ${ctx.env} rollback-plan prints`);
  }
  if (inputs.dryRun) { stage.warnings.push("dry run: the image step did not run"); return; }
  // The Code commit this gateway comes from: a rollback to a recorded image takes the commit recorded with it; a build, the Code that will be live; production, beta's (the digest it copies).
  // An image chosen by digest (a rollback, or any supplied digest) was built from the Code recorded with it, never from the Code that will be live.
  const chosen = ctx.env === "beta" ? inputs.gatewayDigest : manifest.mode === "rollback" ? manifest.gateway.digest : null;
  const codeSha = chosen !== null ? codeShaForRecordedDigest(await readLastGood(ctx.ports, ctx.config, ctx.env), chosen, ctx.env)
    : ctx.env === "beta" ? codeShaForBuild(manifest, ctx.env)
    : (manifest.gateway.codeSha ?? null);
  if (codeSha === null) throw new StageError("REFUSED", "production has no Code commit for the gateway to copy: the beta image step of this execution did not record one");
  // Only a beta build needs a tree: production copies beta's digest and a supplied digest is only looked up.
  const code = ctx.env === "beta" && inputs.gatewayDigest === null ? await checkoutCodeTree(ctx, codeSha) : null;
  const result = await run({
    env: ctx.env, manifest, supplied: inputs.gatewayDigest === null ? null : { digest: inputs.gatewayDigest }, codeSha,
    dirs: { pipeline: ctx.pipelineDir, code, out: inputs.outDir, work: inputs.workDir }, ports: ctx.ports, log: ctx.log,
  });
  if (!DIGEST.test(result.digest)) throw new StageError("FAILED", "the image step returned a digest that is not sha256:<64 hex>");
  if (ctx.env === "production" && result.digest !== manifest.gateway.digest) throw new StageError("REFUSED", "the production image digest differs from the beta digest: the gateway must be byte-identical");
  manifest.gateway = { digest: result.digest, source: result.source, imageTag: result.imageTag, repository: result.repository, codeSha };
  ctx.log(`gateway image: ${result.digest.slice(0, 19)}... (${result.source}), from Code ${codeSha.slice(0, 12)}`);
}
