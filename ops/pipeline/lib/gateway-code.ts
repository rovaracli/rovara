// Which Code commit a gateway comes from (#1478 phase 2). The gateway image is built from a Code tree and its stacks are synthesized from Code's CDK app, both at ONE commit,
// recorded in the manifest (gateway.codeSha), written to the stack as its DeployedCodeSha output and to last-good beside the digest.
//   a build or adoption: the Code commit that will be live in the environment when the run is done (the commit the run releases, or the one Code stays pinned to), never a guess;
//   a rollback to a recorded image: the Code commit recorded WITH that image, so the stack is synthesized from the Code the image was built from. An image recorded before the
//   gateway moved to Code has none: it is refused (its stack cannot be made from today's Code and be called a rollback), EXCEPT when it is the image the live gateway stack runs and that
//   stack was last deployed from Cloud: then the gateway is KEPT (no gateway change set; see keepsLiveGateway).
import { stackName } from "../config.ts";
import type { PipelineConfig } from "../config.ts";
import { StageError } from "../types.ts";
import type { LastGoodRecord, Manifest, PipelineEnv, Ports } from "../types.ts";
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

const isSha = (value: string | null): value is string => value !== null && SHA40.test(value);

/** What a refusal says it is: a rollback run (ROLLBACK_REFUSED) or a release run that names a GATEWAY_DIGEST (REFUSED, its own words: it is not a rollback). */
export type DigestUse = "rollback" | "release";

function findRecorded(record: LastGoodRecord | null, digest: string, env: PipelineEnv, use: DigestUse): RecordedGateway {
  const hits = recordedGateways(record).filter((entry) => entry.digest === digest);
  // The same image can be named twice (last-good and previous): the entry that has a Code commit wins, so a rollback to a pre-change `previous` whose image last-good also names with one is not refused.
  const hit = hits.find((entry) => isSha(entry.codeSha)) ?? hits[0];
  if (hit !== undefined) return hit;
  if (use === "release") throw new StageError("REFUSED", `this release run names the gateway digest ${digest.slice(0, 19)}... (GATEWAY_DIGEST), but the ${env} last-good record names no such image: a release run takes a gateway image only from the last-good record (the current one or the one it replaced), with the Code commit recorded for it`);
  throw new StageError("ROLLBACK_REFUSED", `the digest ${digest.slice(0, 19)}... is not one the ${env} last-good record names`);
}

function refusedNoCode(env: PipelineEnv, hit: RecordedGateway, digest: string, use: DigestUse, why: string): StageError {
  return new StageError(use === "release" ? "REFUSED" : "ROLLBACK_REFUSED",
    `the ${env} ${hit.which} record names the gateway image ${digest.slice(0, 19)}... but no Code commit for it: it was recorded before the gateway moved to Code, so its stack cannot be made from Code, and the pipeline cannot keep it either (${why}). `
    + "The pipeline keeps a gateway only when it is the image the live gateway stack runs now and that stack was last deployed from Cloud (no DeployedCodeSha); otherwise deploy that older gateway by hand. "
    + "To roll back the web side and keep the gateway that runs now, name the digest it runs (it must be one the last-good record names) as GATEWAY_DIGEST");
}

export type KeepVerdict = { keep: true } | { keep: false; why: string };

/**
 * Whether the pipeline may KEEP the gateway that runs now instead of making a gateway change set: the live gateway stack runs exactly this digest (its ImageDigest parameter), and it was last
 * deployed from Cloud (it has NO DeployedCodeSha output). Then there is nothing to change. A DeployedCodeSha that is present but not a 40-hex commit is NOT read as "from Cloud": it is refused
 * (an unknown state). Read-only: one DescribeStacks.
 */
export async function keepsLiveGateway(ports: Ports, config: PipelineConfig, env: PipelineEnv, digest: string): Promise<KeepVerdict> {
  const name = stackName(config, env, "gateway");
  const live = await ports.cfn.describeStack(name);
  if (live === null) return { keep: false, why: `the gateway stack ${name} does not exist` };
  const running = live.parameters.ImageDigest;
  if (running !== digest) return { keep: false, why: `the ${env} gateway stack runs ${running === undefined ? "no image digest" : `${running.slice(0, 19)}...`}, not that image` };
  const stamped = live.outputs.DeployedCodeSha;
  if (stamped === undefined) return { keep: true };
  return { keep: false, why: SHA40.test(stamped) ? `the ${env} gateway stack was already deployed from Code (${stamped.slice(0, 12)}), so a record without a Code commit does not describe it` : `the ${env} gateway stack's DeployedCodeSha output is not a 40-hex commit` };
}

/**
 * The Code commit the gateway of a run that names `digest` is made from, or `null` = KEEP the live gateway (no gateway change set): the digest has no recorded Code commit but is the image the
 * live gateway stack runs, deployed from Cloud (see keepsLiveGateway). Anything else without a Code commit is refused.
 */
export async function gatewayCodeForRecordedDigest(ports: Ports, config: PipelineConfig, record: LastGoodRecord | null, digest: string, env: PipelineEnv, use: DigestUse = "rollback"): Promise<string | null> {
  const hit = findRecorded(record, digest, env, use);
  if (isSha(hit.codeSha)) return hit.codeSha;
  const verdict = await keepsLiveGateway(ports, config, env, digest);
  if (verdict.keep) return null;
  throw refusedNoCode(env, hit, digest, use, verdict.why);
}
