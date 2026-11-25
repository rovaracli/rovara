// Step gateway-check: the live gateway gates (gate 2: run-price versions and a settled, digest-pinned ECS service; L5). Read-only.
import type { StepContext } from "../lib/context.ts";
import { stageOf } from "../lib/manifest.ts";
import { gatePhase, requireManifest } from "../lib/run.ts";
import type { State } from "../lib/run.ts";

export async function gatewayCheckStep(ctx: StepContext, state: State): Promise<void> {
  const manifest = requireManifest(state);
  await gatePhase(ctx, state, stageOf(manifest, ctx.env), "gateway-live", [], null, ctx.inputs.workDir);
}
