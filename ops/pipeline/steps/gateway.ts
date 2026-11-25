// Step gateway: preview the gateway change set (only ImageDigest as a parameter), run the change-set gates (the protected check) on THAT change set,
// verify it by id and template hash, execute it by name, wait for the stack to settle. The gateway is Code's (#1478 phase 2): the stack is synthesized by CODE's CDK app from the
// Code checkout at manifest.gateway.codeSha (the commit its image was built from), and the stack records that commit as its DeployedCodeSha output. No Cloud tree is built here.
import { changeSetNameFor, stackName } from "../config.ts";
import { StageError } from "../types.ts";
import { buildCodeGateway } from "../lib/candidate.ts";
import type { StepContext } from "../lib/context.ts";
import { discardChangeSets, executeRecorded, previewChangeSets, tidyChangeSets } from "../lib/changesets.ts";
import { stageOf } from "../lib/manifest.ts";
import { gatePhase, requireManifest } from "../lib/run.ts";
import type { State } from "../lib/run.ts";

export const SETTLE_TIMEOUT_SECONDS = 30 * 60;
/** Code's CDK app reads the commit it records as the gateway's DeployedCodeSha from this context (infra/lib/model-gateway-deployed-sha.ts in Code). */
export const CODE_SHA_CONTEXT_KEY = "rovaraCodeSha";

export async function gatewayStep(ctx: StepContext, state: State): Promise<void> {
  const manifest = requireManifest(state);
  const stage = stageOf(manifest, ctx.env);
  const digest = manifest.gateway.digest;
  if (digest === null) throw new StageError("REFUSED", "the manifest has no gateway digest: the image step did not complete");
  const codeSha = manifest.gateway.codeSha ?? null;
  if (codeSha === null) throw new StageError("REFUSED", "the manifest has no Code commit for the gateway: the image step did not record one, so the gateway stack cannot be made from Code");
  if (ctx.inputs.dryRun) { stage.warnings.push("dry run: the gateway change set was not created"); return; }
  const dir = await buildCodeGateway(ctx, codeSha);
  const name = stackName(ctx.config, ctx.env, "gateway");
  const changeSetName = changeSetNameFor(manifest.exec8);
  try {
    const [record] = await previewChangeSets({
      ports: ctx.ports, dir, changeSetName, stacks: [{ part: "gateway", stack: name, stackId: ctx.config.stackIds.gateway }],
      context: { ...ctx.contextFor("gateway"), [CODE_SHA_CONTEXT_KEY]: codeSha }, parameters: { ImageDigest: digest }, log: ctx.log,
    });
    stage.changeSets = [...stage.changeSets.filter((cs) => cs.part !== "gateway"), record!];
    // No Cloud tree is involved: the gates of this phase read the records and the live stack, never a Cloud checkout.
    await gatePhase(ctx, state, stage, "change-sets", [record!], null, ctx.inputs.workDir);
    const [executed] = await executeRecorded({ ports: ctx.ports, records: [record!], settleTimeoutSeconds: SETTLE_TIMEOUT_SECONDS, log: ctx.log });
    stage.changeSets = stage.changeSets.map((cs) => (cs.part === "gateway" ? executed! : cs));
  } catch (error) {
    await discardChangeSets(ctx.ports, [name], changeSetName, ctx.log);
    throw error;
  }
  await tidyChangeSets(ctx.ports, [name], changeSetName, ctx.log);
}
