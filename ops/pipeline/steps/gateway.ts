// Step gateway: preview the gateway change set (only ImageDigest as a parameter), run the change-set gates (the protected check) on THAT change set,
// verify it by id and template hash, execute it by name, wait for the stack to settle.
import { changeSetNameFor, stackName } from "../config.ts";
import { StageError } from "../types.ts";
import { buildCandidate } from "../lib/candidate.ts";
import type { StepContext } from "../lib/context.ts";
import { discardChangeSets, executeRecorded, previewChangeSets, tidyChangeSets } from "../lib/changesets.ts";
import { stageOf } from "../lib/manifest.ts";
import { gatePhase, requireManifest } from "../lib/run.ts";
import type { State } from "../lib/run.ts";

export const SETTLE_TIMEOUT_SECONDS = 30 * 60;

export async function gatewayStep(ctx: StepContext, state: State): Promise<void> {
  const manifest = requireManifest(state);
  const stage = stageOf(manifest, ctx.env);
  const digest = manifest.gateway.digest;
  if (digest === null) throw new StageError("REFUSED", "the manifest has no gateway digest: the image step did not complete");
  if (ctx.inputs.dryRun) { stage.warnings.push("dry run: the gateway change set was not created"); return; }
  const dir = await buildCandidate(ctx, manifest.cloud.sha, false);
  const name = stackName(ctx.config, ctx.env, "gateway");
  const changeSetName = changeSetNameFor(manifest.exec8);
  try {
    const [record] = await previewChangeSets({
      ports: ctx.ports, dir, changeSetName, stacks: [{ part: "gateway", stack: name, stackId: ctx.config.stackIds.gateway }],
      context: { ...ctx.contextFor("gateway"), rovaraCloudSha: manifest.cloud.sha }, parameters: { ImageDigest: digest }, log: ctx.log,
    });
    stage.changeSets = [...stage.changeSets.filter((cs) => cs.part !== "gateway"), record!];
    await gatePhase(ctx, state, stage, "change-sets", [record!], dir, ctx.inputs.workDir);
    const [executed] = await executeRecorded({ ports: ctx.ports, records: [record!], settleTimeoutSeconds: SETTLE_TIMEOUT_SECONDS, log: ctx.log });
    stage.changeSets = stage.changeSets.map((cs) => (cs.part === "gateway" ? executed! : cs));
  } catch (error) {
    await discardChangeSets(ctx.ports, [name], changeSetName, ctx.log);
    throw error;
  }
  await tidyChangeSets(ctx.ports, [name], changeSetName, ctx.log);
}
