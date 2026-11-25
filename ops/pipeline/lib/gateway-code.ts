// Which Code commit a gateway comes from (#1478 phase 2). The gateway image is built from a Code tree and its stacks are synthesized from Code's CDK app, both at ONE commit,
// recorded in the manifest (gateway.codeSha), written to the stack as its DeployedCodeSha output and to last-good beside the digest.
//   a build or adoption: the Code commit that will be live in the environment when the run is done (the commit the run releases, or the one Code stays pinned to), never a guess;
//   a rollback to a recorded image: the Code commit recorded WITH that image, so the stack is synthesized from the Code the image was built from (an image recorded before the
//   gateway moved to Code has none, and is refused: its stack cannot be made from today's Code and be called a rollback).
import { StageError } from "../types.ts";
import type { LastGoodRecord, Manifest, PipelineEnv } from "../types.ts";
import { codeShaThatWillBeLive } from "./gate-env.ts";

const SHA40 = /^[0-9a-f]{40}$/u;

/** The Code commit a built or adopted gateway comes from: what Code will be live as in this environment. */
export function codeShaForBuild(manifest: Readonly<Manifest>, env: PipelineEnv): string {
  const choice = codeShaThatWillBeLive(manifest, env);
  if (choice.sha === null || !SHA40.test(choice.sha)) throw new StageError("REFUSED", `the gateway comes from Code, and the Code commit it would come from is not known: ${choice.why}`);
  return choice.sha;
}

/** A gateway image the last-good record names (the current one or the one it replaced) with the Code commit recorded for it (null: recorded before the gateway moved to Code). */
export interface RecordedGateway { digest: string; codeSha: string | null; which: "last-good" | "previous" }

export function recordedGateways(record: LastGoodRecord | null): RecordedGateway[] {
  if (record === null) return [];
  const found: RecordedGateway[] = [{ digest: record.gateway.digest, codeSha: record.gateway.codeSha ?? null, which: "last-good" }];
  if (record.previous?.gatewayDigest != null) found.push({ digest: record.previous.gatewayDigest, codeSha: record.previous.gatewayCodeSha ?? null, which: "previous" });
  return found;
}

/** The Code commit recorded with a digest a rollback goes back to. REFUSES when the record names none: the gateway would have to be rebuilt from a Code the image was never built from. */
export function codeShaForRecordedDigest(record: LastGoodRecord | null, digest: string, env: PipelineEnv): string {
  const hit = recordedGateways(record).find((entry) => entry.digest === digest);
  if (hit === undefined) throw new StageError("ROLLBACK_REFUSED", `the digest ${digest.slice(0, 19)}... is not one the ${env} last-good record names`);
  if (hit.codeSha === null || !SHA40.test(hit.codeSha)) {
    throw new StageError("ROLLBACK_REFUSED", `the ${env} ${hit.which} record names the gateway image ${digest.slice(0, 19)}... but no Code commit for it: it was recorded before the gateway moved to Code, so its stack cannot be made from Code. Keep the gateway that runs now (use the last-good record's digest), or deploy that older gateway by hand`);
  }
  return hit.codeSha;
}
