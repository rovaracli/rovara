// Step proof: the proof gates, then the last-good record (only after every proof gate passed), then the final promotion summary.
// L9: a proof gate that gave no proof either way (it skipped with data.holdsLastGood, e.g. an inconclusive canary) keeps last-good where it was, with a visible line.
import type { StepContext } from "../lib/context.ts";
import { buildLastGood, readLastGood, writeLastGood } from "../lib/lastgood.ts";
import { stageOf } from "../lib/manifest.ts";
import { gatePhase, requireManifest } from "../lib/run.ts";
import type { State } from "../lib/run.ts";

export async function proofStep(ctx: StepContext, state: State): Promise<void> {
  const manifest = requireManifest(state);
  const stage = stageOf(manifest, ctx.env);
  await gatePhase(ctx, state, stage, "proof", [], null, ctx.inputs.workDir);
  if (ctx.inputs.dryRun) { stage.warnings.push("dry run: the last-good record was not written"); return; }
  const proof = stage.gates.filter((g) => g.phase === "proof");
  const holding = proof.filter((g) => g.result === "skipped" && g.data.holdsLastGood === true).map((g) => g.name);
  if (holding.length > 0) {
    // Read the record anyway: an unreadable current record is refused here too, never skipped over (rule 9).
    await readLastGood(ctx.ports, ctx.config, ctx.env);
    const note = `last-good (${ctx.env}) did NOT move: ${holding.join(", ")} gave no proof either way (${proof.filter((g) => holding.includes(g.name)).map((g) => g.skippedReason ?? "").join("; ")})`;
    stage.warnings.push(note);
    ctx.log(note);
    return;
  }
  const previous = await readLastGood(ctx.ports, ctx.config, ctx.env);
  const names = proof.filter((g) => g.result === "pass").map((g) => g.name);
  const skipped = proof.filter((g) => g.result === "skipped").map((g) => g.name);
  const record = buildLastGood(manifest, ctx.env, names, previous, ctx.ports.clock.now(), skipped);
  await writeLastGood(ctx.ports, ctx.config, record);
  ctx.log(`last-good (${ctx.env}): ${record.cloud.tag} ${record.cloud.sha.slice(0, 12)}, gateway ${record.gateway.digest.slice(0, 19)}...${skipped.length === 0 ? "" : ` (proof skipped: ${skipped.join(", ")})`}`);
}
