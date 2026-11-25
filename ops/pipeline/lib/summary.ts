// The promotion summary (L2-STAGE-CLI-INTERFACE.md 2.5): what an approver reads before enabling the Production transition.
import type { Manifest, PipelineEnv, PromotionSummary, StageRecord } from "../types.ts";

const short = (sha: string | null): string => (sha === null ? "none" : sha.slice(0, 12));

export function buildSummary(manifest: Manifest, env: PipelineEnv, stage: StageRecord): PromotionSummary {
  const warnings = [...stage.warnings];
  return {
    schema: 1,
    env,
    executionId: manifest.executionId,
    mode: manifest.mode,
    code: {
      sha: manifest.code.sha, release: manifest.code.release, pinnedSha: manifest.code.pinnedSha[env], supersedes: manifest.code.supersedes,
      liveSha: manifest.code.liveSha?.[env] ?? null, rollbackTarget: manifest.code.rollbackTarget ?? null,
    },
    cloud: { tag: manifest.cloud.tag, sha: manifest.cloud.sha, liveSha: manifest.cloud.liveSha[env] },
    gateway: { digest: manifest.gateway.digest, source: manifest.gateway.source },
    changeSets: stage.changeSets.map((cs) => ({ part: cs.part, stack: cs.stack, noChanges: cs.noChanges, counts: cs.counts })),
    gates: stage.gates.map((g) => ({ name: g.name, phase: g.phase, result: g.result, skippedReason: g.skippedReason })),
    warnings,
  };
}

/** What the summary may say about Cloud in a rollback: the preflight proved the change is no move forward whenever the live sha is known (it refuses otherwise); unknown = not proven. */
const cloudClaim = (summary: PromotionSummary): string =>
  summary.cloud.liveSha === null ? "Cloud: the live Cloud is unknown, so whether it stays or rolls back is not proven" : `Cloud ${summary.cloud.liveSha === summary.cloud.sha ? "stays" : "rolls back"}`;

export function renderSummary(summary: PromotionSummary): string {
  const lines: string[] = [];
  lines.push(`PROMOTION SUMMARY ${summary.env}  execution ${summary.executionId.slice(0, 8)}  mode ${summary.mode}`);
  lines.push(`  Code   : sha ${short(summary.code.sha)}  release=${summary.code.release}  (pinned: ${short(summary.code.pinnedSha)})`);
  lines.push(`  Cloud  : ${summary.cloud.tag} ${short(summary.cloud.sha)}  (live: ${summary.cloud.liveSha === null ? "unknown" : short(summary.cloud.liveSha)})`);
  lines.push(`  Gateway: ${summary.gateway.digest === null ? "no digest yet" : `${summary.gateway.digest.slice(0, 19)}...`}  source=${summary.gateway.source ?? "none"}`);
  const sets = summary.changeSets.map((cs) => (cs.noChanges ? `${cs.part}  no changes` : `${cs.part}  +${cs.counts.add} ~${cs.counts.modify} -${cs.counts.remove} r${cs.counts.replace}`));
  lines.push(`  Change sets: ${sets.length === 0 ? "none yet" : sets.join(" | ")}`);
  const gates = summary.gates.map((g) => (g.result === "skipped" ? `skipped ${g.name} (${g.skippedReason ?? ""})` : `${g.result} ${g.name}`));
  lines.push(`  Gates  : ${gates.length === 0 ? "none yet" : gates.join(" | ")}`);
  const target = summary.code.rollbackTarget ?? null;
  if (summary.code.supersedes !== null) {
    // The waiting run's Code commit is promoted by this run only when this run releases that very commit (not in a Code rollback: Code goes to the target).
    const same = summary.code.supersedes.codeSha !== null && summary.code.supersedes.codeSha === summary.code.sha && summary.code.release === "run" && target === null;
    lines.push(`  NOTE   : this run supersedes execution ${summary.code.supersedes.executionId.slice(0, 8)}, whose Code sha ${short(summary.code.supersedes.codeSha)} is ${same ? "promoted by this run" : "not promoted"}`);
  }
  if (summary.mode === "rollback" && target !== null) lines.push(`  NOTE   : Code rolls back to ${short(target)} (from ${short(summary.code.liveSha ?? null)}); ${cloudClaim(summary)}`);
  else if (summary.mode === "rollback") lines.push(`  NOTE   : rollback run: Code is skipped and pinned to ${short(summary.code.pinnedSha)}`);
  if (summary.code.release === "skip" && summary.mode !== "rollback") lines.push("  NOTE   : Code release is skipped in this run; its Code waits for a later run");
  for (const warning of summary.warnings) lines.push(`  WARN   : ${warning}`);
  return `${lines.join("\n")}\n`;
}

/** The KEY=value lines CodeBuild exports from the preflight (L2-STAGE-CLI-INTERFACE.md 2.6). Values are quoted so a `.` of the file cannot run anything. */
export function renderExports(manifest: Manifest, env: PipelineEnv): string {
  const quote = (value: string): string => `'${value.replaceAll("'", "")}'`;
  const pinned = manifest.code.pinnedSha[env] ?? "";
  const line = `${manifest.cloud.tag} ${manifest.cloud.sha.slice(0, 12)} mode=${manifest.mode} code=${manifest.code.release}`;
  return [
    `export CLOUD_TAG=${quote(manifest.cloud.tag)}`,
    `export CLOUD_SHA=${quote(manifest.cloud.sha)}`,
    `export CLOUD_MODE=${quote(manifest.mode)}`,
    `export CODE_RELEASE_EFFECTIVE=${quote(manifest.code.release)}`,
    `export CODE_PINNED_SHA=${quote(pinned)}`,
    `export GATEWAY_DIGEST=${quote(manifest.gateway.digest ?? "")}`,
    `export SUMMARY_LINE=${quote(line)}`,
  ].join("\n") + "\n";
}
