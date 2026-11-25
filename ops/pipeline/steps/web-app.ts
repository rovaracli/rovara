// Step web-app: re-verify the web and app change sets previewed in preflight (same id, same template hash, still available), run the release check
// (the 1 s poller) around the execute, execute by name, wait, require a settled stack.
import { changeSetNameFor, stackName } from "../config.ts";
import { StageError } from "../types.ts";
import type { StepContext } from "../lib/context.ts";
import { executeRecorded, tidyChangeSets } from "../lib/changesets.ts";
import { stageOf } from "../lib/manifest.ts";
import { baseUrlFromOutputs, startReleaseCheck } from "../lib/releasecheck.ts";
import { requireManifest } from "../lib/run.ts";
import type { State } from "../lib/run.ts";
import { SETTLE_TIMEOUT_SECONDS } from "./gateway.ts";

export async function webAppStep(ctx: StepContext, state: State): Promise<void> {
  const manifest = requireManifest(state);
  const stage = stageOf(manifest, ctx.env);
  if (ctx.inputs.dryRun) { stage.warnings.push("dry run: the web and app change sets were not executed"); return; }
  const records = (["app", "web"] as const).map((part) => stage.changeSets.find((cs) => cs.part === part));
  if (records.some((record) => record === undefined)) throw new StageError("REFUSED", "the manifest has no web and app change sets: preflight did not record them");
  const webStack = stackName(ctx.config, ctx.env, "web");
  const base = baseUrlFromOutputs((await ctx.ports.cfn.describeStack(webStack))?.outputs);
  const poller = base === null ? null : startReleaseCheck(ctx.ports, base, ctx.config.releaseCheck.paths, ctx.config.releaseCheck.intervalSeconds * 1000);
  ctx.log(base === null ? "release check: no live address yet (the first deploy of the web stack), so nothing to check" : `release check: asking ${base} every ${ctx.config.releaseCheck.intervalSeconds} s during the deploy`);
  let executed;
  try {
    executed = await executeRecorded({ ports: ctx.ports, records: records as NonNullable<(typeof records)[number]>[], settleTimeoutSeconds: SETTLE_TIMEOUT_SECONDS, log: ctx.log });
  } finally {
    if (poller !== null) {
      const result = await poller.stop();
      stage.releaseCheck = { base, probes: result.probes, failures: result.failures };
    }
  }
  stage.changeSets = stage.changeSets.map((cs) => executed.find((e) => e.part === cs.part) ?? cs);
  if (stage.releaseCheck !== null && stage.releaseCheck.failures.length > 0) {
    throw new StageError("RELEASE_CHECK_FAILED", `the release check saw errors on ${base} during the deploy: ${stage.releaseCheck.failures.slice(0, 5).join("; ")}`);
  }
  if (stage.releaseCheck !== null) ctx.log(`release check: no errors on ${base} during the deploy (${stage.releaseCheck.probes} probes)`);
  await tidyChangeSets(ctx.ports, (["app", "web"] as const).map((part) => stackName(ctx.config, ctx.env, part)), changeSetNameFor(manifest.exec8), ctx.log);
}
