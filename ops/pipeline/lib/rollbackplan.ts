// The rollback plan (L9): which release to go back to and the exact variables of the pipeline run that does it. Read-only: SSM (last-good), git and the stacks' outputs.
// A rollback is an ordinary pipeline run with CLOUD_REF set to an older tag (BETA-CLOUD-PLAN 5): L2 detects it, forces CODE_RELEASE=skip and pins Code to what is live,
// the rollback-floor gate refuses a ref below a floor, and the image step takes the recorded gateway digest. This command only names those inputs and checks them first.
// Rule 9: the target is the record the operator names (default: last-good). It never falls back to another record, and an unreadable record is an error, not "none".
import { stackName } from "../config.ts";
import type { PipelineConfig } from "../config.ts";
import { StageError } from "../types.ts";
import type { LastGoodRecord, PipelineEnv, Ports } from "../types.ts";
import { cloudFloors, codeFloors, gatewayCodeFloors, judgeCodeTarget, judgeDigest, judgeGatewayCodeSha, judgeRef, loadFloors } from "./floors.ts";
import { gatewayCodeForRecordedDigest, recordedGateways } from "./gateway-code.ts";
import { CODE_REPO_ENV, envValue } from "./gate-env.ts";
import { readLastGood } from "./lastgood.ts";
import { readLiveCloudSha, resolveCloudRef, tagOfSha } from "./refs.ts";

export type PlanTarget = "last-good" | "previous";

interface Target { tag: string; sha: string; digest: string | null; what: string }

const refuse = (message: string): StageError => new StageError("ROLLBACK_REFUSED", message);

function chooseTarget(record: LastGoodRecord, which: PlanTarget): Target {
  const recorded = `recorded ${record.recordedAt} by execution ${record.executionId.slice(0, 8)}, mode ${record.mode}`;
  if (which === "last-good") return { tag: record.cloud.tag, sha: record.cloud.sha, digest: record.gateway.digest, what: `last-good, ${recorded}` };
  // The record that last-good replaced. After a rollback run that record is the release that was rolled away from, so it is never offered as a target.
  if (record.mode === "rollback") throw refuse(`last-good was written by a rollback run, so its previous record is the release that was rolled away from: not a rollback target (name a tag with CLOUD_REF instead)`);
  if (record.previous === null) throw refuse("last-good has no previous record to go back to");
  if (record.previous.gatewayDigest === null) throw refuse(`the previous record (${record.previous.cloudTag}) has no gateway digest: a rollback run needs the digest that ran with it`);
  return { tag: record.previous.cloudTag, sha: record.previous.cloudSha, digest: record.previous.gatewayDigest, what: `previous of the last-good ${recorded}` };
}

export interface PlanArgs {
  ports: Ports; config: PipelineConfig; env: PipelineEnv; which: PlanTarget; codeLiveSha: string | null; pipelineDir: string;
  /** L9b (--code-target): a Code commit to roll Code back to as well. The Cloud half may then be the tag that is live (a Code-only rollback). */
  codeTarget?: string | null;
}

export async function planRollback(args: PlanArgs): Promise<string[]> {
  const { ports, config, env } = args;
  const record = await readLastGood(ports, config, env);
  if (record === null) throw refuse(`${env} has no last-good record: there is nothing recorded to go back to. Name a release tag yourself with CLOUD_REF (the floors still apply)`);
  const target = chooseTarget(record, args.which);
  const codeTarget = args.codeTarget ?? null;
  if (target.digest === null) throw refuse("the target has no recorded gateway digest");
  // The tag must still be the recorded commit and be on the trunk (resolveCloudRef refuses a missing or off-trunk tag with exit 40).
  const resolved = await resolveCloudRef(ports, config, target.tag);
  if (resolved.sha !== target.sha) throw refuse(`${target.tag} now points at ${resolved.sha.slice(0, 12)} but was recorded at ${target.sha.slice(0, 12)}: release tags must not move`);
  const warnings: string[] = [];
  const live = await readLiveCloudSha(ports, stackName(config, env, "web"));
  warnings.push(...live.warnings);
  // With a Code target the Cloud half may stay where it is: a Code-only rollback names the tag that is live.
  const cloudStays = live.sha === target.sha && codeTarget !== null;
  if (live.sha === target.sha && !cloudStays) throw refuse(`${target.tag} is already what ${env} runs${args.which === "last-good" ? " (a passed release is last-good): use --target previous to go one release further back" : ""}`);
  if (live.sha !== null && !cloudStays) {
    let older: boolean;
    try { older = await ports.git.isAncestor(target.sha, live.sha); } catch { warnings.push(`the live Cloud sha ${live.sha.slice(0, 12)} is not in this repository, so the run cannot be proven a rollback`); older = true; }
    if (!older) throw refuse(`${target.tag} is not older than what ${env} runs (${live.sha.slice(0, 12)}): that is a release, not a rollback`);
  }
  // The gateway comes from Code (#1478 phase 2): the plan names the Code commit recorded with the target's image, which the run builds the stack from. An image recorded without one is refused,
  // unless it is the image the live gateway stack runs (deployed from Cloud): then the run KEEPS the gateway (null here; no gateway change set).
  const gatewayCodeSha = await gatewayCodeForRecordedDigest(ports, config, record, target.digest, env);
  const floors = loadFloorsOrRefuse(ports, args.pipelineDir);
  const verdict = await judgeRef(ports, floors, { tag: target.tag, sha: target.sha });
  const failures = [...verdict.failures, ...judgeDigest(floors, target.digest)];
  const codeNotes: string[] = [];
  const cloneForGateway = await envValue(ports, CODE_REPO_ENV);
  if (gatewayCodeSha === null) codeNotes.push("the gateway is kept as it runs now (the image has no recorded Code commit): no gateway change set is made, and no gatewayCode floor applies to it (its digest was judged above)");
  else if (cloneForGateway === null && gatewayCodeFloors(floors).length > 0) codeNotes.push(`the gateway's Code commit was not judged against the ${gatewayCodeFloors(floors).length} gatewayCode floor(s): no Code clone (${CODE_REPO_ENV}); the pipeline's rollback-floor gate judges it`);
  else {
    const gateway = await judgeGatewayCodeSha(ports, floors, cloneForGateway, gatewayCodeSha);
    failures.push(...gateway.failures);
  }
  if (codeTarget !== null) {
    // The Code floors are judged in a Code clone; the operator's machine may not have one (the pipeline's rollback-floor gate always does).
    const repo = await envValue(ports, CODE_REPO_ENV);
    if (repo === null && codeFloors(floors).length > 0) codeNotes.push(`the Code target was not judged against the ${codeFloors(floors).length} code floor(s): no Code clone (${CODE_REPO_ENV}); the pipeline's rollback-floor gate judges it`);
    else {
      const verdict = await judgeCodeTarget(ports, floors, repo, codeTarget);
      failures.push(...verdict.failures);
      codeNotes.push(...verdict.notes);
    }
  }
  if (failures.length > 0) throw refuse(`the rollback floor refuses ${codeTarget !== null ? "this rollback" : target.tag}: ${failures.join("; ")}`);
  if (record.proofSkipped !== undefined && record.proofSkipped.length > 0) warnings.push(`the target was recorded without proof from: ${record.proofSkipped.join(", ")}`);
  const liveTag = live.sha === null ? null : await tagOfSha(ports, config, live.sha);
  if (codeTarget !== null) return codePlanLines({ env, live, liveTag, target, gatewayCodeSha, floorsChecked: cloudFloors(floors).length, codeTarget, warnings: [...warnings, ...codeNotes] });
  warnings.push(...codeNotes);
  const lines = [
    `ROLLBACK PLAN ${env}  (read-only: nothing was changed)`,
    `  Live   : ${live.sha === null ? "unknown" : `${liveTag ?? "no release tag"} ${live.sha.slice(0, 12)}`}`,
    `  Target : ${target.tag} ${target.sha.slice(0, 12)}  (${target.what})`,
    `  Gateway: ${gatewayLine(target.digest, gatewayCodeSha)}`,
    `  Floors : ${cloudFloors(floors).length} checked, none below`,
    "  Run the pipeline with these variables (beta first, then production, each with its own CODE_LIVE_SHA):",
    `    CLOUD_REF=${target.tag}`,
    "    CODE_RELEASE=skip",
    `    GATEWAY_DIGEST=${target.digest}`,
    `    CODE_LIVE_SHA=${args.codeLiveSha ?? `<the Code sha live in ${env}>`}`,
    "  NOTE   : Code is skipped and pinned to the sha live in this environment; approving this run never promotes unreviewed Code",
  ];
  for (const warning of warnings) lines.push(`  WARN   : ${warning}`);
  return lines;
}

const gatewayLine = (digest: string, codeSha: string | null): string => (codeSha === null ? `${digest}  (kept: the image the gateway runs now, recorded before the gateway moved to Code; no gateway change set)` : `${digest}  (built from Code ${codeSha.slice(0, 12)})`);

/**
 * The plan of a rollback that moves Code too (L9b). The pipeline supplies CODE_LIVE_SHA and the supersession itself (inside CODE_CTX), so they are not variables to set. The Code history
 * lives in the release account (SSM, written by the Code release build): the Cloud roles cannot read it, so the operator reads it; the Code Preflight enforces membership either way.
 */
function codePlanLines(a: { env: PipelineEnv; live: { sha: string | null }; liveTag: string | null; target: Target; gatewayCodeSha: string | null; floorsChecked: number; codeTarget: string; warnings: string[] }): string[] {
  const stays = a.live.sha === a.target.sha;
  const lines = [
    `ROLLBACK PLAN ${a.env} with a Code rollback  (read-only: nothing was changed)`,
    `  Live   : ${a.live.sha === null ? "unknown" : `${a.liveTag ?? "no release tag"} ${a.live.sha.slice(0, 12)}`}`,
    `  Cloud  : ${stays ? `stays at ${a.target.tag}` : `${a.target.tag} ${a.target.sha.slice(0, 12)}`}  (${a.target.what})`,
    `  Code   : rolls back to ${a.codeTarget.slice(0, 12)}`,
    `  Gateway: ${gatewayLine(a.target.digest ?? "", a.gatewayCodeSha)}`,
    `  Floors : ${a.floorsChecked} cloud floor(s) checked, none below`,
    "  Run the pipeline with these variables (CODE_LIVE_SHA and the supersession are supplied by the pipeline itself):",
    "    PIPELINE_MODE=rollback",
    `    CODE_ROLLBACK_TARGET=${a.codeTarget}`,
    "    CODE_RELEASE=run",
    `    CLOUD_REF=${a.target.tag}`,
    `    GATEWAY_DIGEST=${a.target.digest}`,
    `  NOTE   : the target must be in the ${a.env} Code release history; read it in the release account: aws ssm get-parameter --name /agentx/release/code-history/${a.env}`,
    "  NOTE   : Production's own Preflight checks Production's history: roll Production back only to a Code commit Production released. Production still waits for the owner's approval",
  ];
  for (const warning of a.warnings) lines.push(`  WARN   : ${warning}`);
  return lines;
}

function loadFloorsOrRefuse(ports: Ports, pipelineDir: string): ReturnType<typeof loadFloors> {
  try { return loadFloors(ports, pipelineDir); } catch (error) { throw refuse(error instanceof Error ? error.message : String(error)); }
}

/** The gateway digests this environment's last-good record names: the current one and the one it replaced (the digests `rollback-plan` prints). */
export async function recordedGatewayDigests(ports: Ports, config: PipelineConfig, env: PipelineEnv): Promise<string[]> {
  return recordedGateways(await readLastGood(ports, config, env)).map((entry) => entry.digest);
}
