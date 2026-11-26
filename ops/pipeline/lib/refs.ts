// Ref resolution (BETA-CLOUD-PLAN 1.3): the Cloud ref is the newest vX.Y.Z tag on the trunk, or the pipeline variable CLOUD_REF.
// The rule of FIND_RELEASE_TAG and RELEASE_TAG_ON_BRANCH (infra/lib/cloud-release-pipeline.ts) with the trunk names from config.json.
import { releaseTagRegex } from "../config.ts";
import type { PipelineConfig } from "../config.ts";
import { StageError } from "../types.ts";
import type { PipelineEnv, Ports } from "../types.ts";
import { readLastGood } from "./lastgood.ts";

/** How a Cloud ref was decided: the newest tag (no CLOUD_REF), an explicit CLOUD_REF, the one tag on the trigger's source commit, or the recorded last-good tag (a Code push: Cloud does not change). */
export interface ResolvedRef { tag: string; sha: string; ref: "latest-tag" | "CLOUD_REF" | "from-trigger" | "last-good"; trunk: string }

/** The pipeline's default CLOUD_REF (Code's release pipeline passes it with CLOUD_SOURCE_COMMIT = the Cloud source commit of the run). */
export const FROM_TRIGGER = "from-trigger";
/** Code's release pipeline documents CLOUD_REF_LATEST = "latest" = the newest release tag on the Cloud trunk: the same as no CLOUD_REF (the newest-tag path below). Never a ref of its own. */
export const LATEST = "latest";
const SHA40 = /^[0-9a-f]{40}$/u;
/** What `from-trigger` reads: the Cloud source commit of the run (CLOUD_SOURCE_COMMIT) and the environment whose last-good record a tagless commit falls back to (Beta). */
export interface TriggerFacts { sourceCommit: string | null; env: PipelineEnv }

const versionOf = (tag: string): [number, number, number] => {
  const parts = tag.slice(1).split(".").map((part) => Number(part));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
};
export function compareTags(a: string, b: string): number {
  const x = versionOf(a);
  const y = versionOf(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

export async function resolveCloudRef(ports: Ports, config: PipelineConfig, requestedRaw: string | null, trigger: TriggerFacts | null = null): Promise<ResolvedRef> {
  const pattern = releaseTagRegex(config);
  // "latest" and an empty CLOUD_REF mean the newest release tag on the trunk (null), exactly like an unset one. Everything else is as before.
  const requested = requestedRaw === LATEST || requestedRaw === "" ? null : requestedRaw;
  // CLOUD_REF=from-trigger: decided from the source commit before anything is fetched. A missing or malformed commit is never guessed around.
  if (requested === FROM_TRIGGER) {
    if (trigger === null || trigger.sourceCommit === null || !SHA40.test(trigger.sourceCommit)) throw new StageError("REF_FAILED", `CLOUD_REF=${FROM_TRIGGER} needs CLOUD_SOURCE_COMMIT, the full 40-character commit of the Cloud source: it is missing or malformed, so no release is chosen (name a release tag in CLOUD_REF to start by hand)`);
    return fromTrigger(ports, config, trigger.sourceCommit, trigger.env);
  }
  if (requested !== null && !pattern.test(requested)) throw new StageError("REF_FAILED", `CLOUD_REF ${requested} is not a release tag (vX.Y.Z); the pipeline deploys release tags only`);
  await ports.git.fetchTags();
  const trunks: string[] = [];
  for (const branch of config.trunkBranches) if (await ports.git.fetchBranch(branch)) trunks.push(branch);
  if (trunks.length === 0) throw new StageError("REF_FAILED", `none of the trunk branches (${config.trunkBranches.join(", ")}) exists on origin`);
  const tags = (await ports.git.tags()).filter((tag) => pattern.test(tag)).sort((a, b) => compareTags(b, a));
  const onTrunk = async (sha: string): Promise<string | null> => {
    for (const branch of trunks) if (await ports.git.isAncestor(sha, `origin/${branch}`)) return branch;
    return null;
  };
  if (requested !== null) {
    if (!tags.includes(requested)) throw new StageError("REF_FAILED", `the release tag ${requested} does not exist`);
    const sha = await ports.git.revParse(`refs/tags/${requested}^{commit}`);
    const trunk = await onTrunk(sha);
    if (trunk === null) throw new StageError("REF_FAILED", `${requested} (${sha.slice(0, 9)}) is not on ${trunks.join(" or ")}: this pipeline deploys only release tags cut from the trunk`);
    return { tag: requested, sha, ref: "CLOUD_REF", trunk };
  }
  for (const tag of tags) {
    const sha = await ports.git.revParse(`refs/tags/${tag}^{commit}`);
    const trunk = await onTrunk(sha);
    if (trunk !== null) return { tag, sha, ref: "latest-tag", trunk };
  }
  throw new StageError("REF_FAILED", `no vX.Y.Z release tag is on ${trunks.join(" or ")}; the pipeline deploys release tags only`);
}

async function trunksOf(ports: Ports, config: PipelineConfig): Promise<string[]> {
  await ports.git.fetchTags();
  const trunks: string[] = [];
  for (const branch of config.trunkBranches) if (await ports.git.fetchBranch(branch)) trunks.push(branch);
  if (trunks.length === 0) throw new StageError("REF_FAILED", `none of the trunk branches (${config.trunkBranches.join(", ")}) exists on origin`);
  return trunks;
}

/**
 * from-trigger: exactly one release tag on the source commit is that tag; a commit with no release tag (a Code push: Code never changes Cloud) keeps the Cloud the environment's
 * last-good record names (never "the newest tag"; no record is refused); two or more tags, or a commit that is not on the trunk, are refused. Nothing is written before this answers.
 */
async function fromTrigger(ports: Ports, config: PipelineConfig, commit: string, env: PipelineEnv): Promise<ResolvedRef> {
  const pattern = releaseTagRegex(config);
  const trunks = await trunksOf(ports, config);
  let trunk: string | null = null;
  try { for (const branch of trunks) if (trunk === null && await ports.git.isAncestor(commit, `origin/${branch}`)) trunk = branch; } catch {
    throw new StageError("REF_FAILED", `the Cloud source commit ${commit.slice(0, 9)} is not known to git here, so it cannot be shown to be on ${trunks.join(" or ")}: nothing is released`);
  }
  if (trunk === null) throw new StageError("REF_FAILED", `the Cloud source commit ${commit.slice(0, 9)} is not on ${trunks.join(" or ")}: this pipeline releases only commits cut from the trunk`);
  const onCommit: string[] = [];
  for (const tag of (await ports.git.tags()).filter((t) => pattern.test(t)).sort((a, b) => compareTags(b, a))) {
    try { if ((await ports.git.revParse(`refs/tags/${tag}^{commit}`)) === commit) onCommit.push(tag); } catch { /* an unreadable tag is not on this commit */ }
  }
  if (onCommit.length > 1) throw new StageError("REF_FAILED", `the Cloud source commit ${commit.slice(0, 9)} carries ${onCommit.length} release tags (${onCommit.join(", ")}): it is not clear which one to release, so none is (start by hand with CLOUD_REF set to the tag)`);
  const record = await readLastGood(ports, config, env);
  if (onCommit.length === 1) {
    // A late push of an OLD tag must never roll Cloud back: a tag older than the last recorded good one is refused here (a deliberate rollback names CLOUD_REF on a manual start).
    const tag = onCommit[0]!;
    if (record !== null && record.cloud.tag !== tag) {
      let older = compareTags(tag, record.cloud.tag) < 0;
      try { older = older || await ports.git.isAncestor(commit, record.cloud.sha); } catch { /* the recorded commit is unknown here: the version order above stands */ }
      if (older) throw new StageError("REF_FAILED", `${tag} is older than ${record.cloud.tag}, the release ${env} last recorded as good: a pushed tag never rolls Cloud back (to roll back on purpose, start by hand with CLOUD_REF set to ${tag} and PIPELINE_MODE=rollback)`);
    }
    return { tag, sha: commit, ref: "from-trigger", trunk };
  }
  if (record === null) throw new StageError("REF_FAILED", `the Cloud source commit ${commit.slice(0, 9)} carries no release tag (a Code push), and ${env} has no recorded last-good release to keep: nothing is released (run an adoption run, or start by hand with CLOUD_REF set to a release tag)`);
  let recordedSha: string | null = null;
  try { recordedSha = await ports.git.revParse(`refs/tags/${record.cloud.tag}^{commit}`); } catch { /* checked below */ }
  if (recordedSha === null || recordedSha !== record.cloud.sha) throw new StageError("REF_FAILED", `the Cloud source commit ${commit.slice(0, 9)} carries no release tag, and the release ${env} last recorded (${record.cloud.tag}) no longer points at the commit recorded for it: nothing is released`);
  let recordedTrunk: string | null = null;
  for (const branch of trunks) if (recordedTrunk === null && await ports.git.isAncestor(recordedSha, `origin/${branch}`)) recordedTrunk = branch;
  if (recordedTrunk === null) throw new StageError("REF_FAILED", `the release ${env} last recorded (${record.cloud.tag}) is not on ${trunks.join(" or ")}: nothing is released`);
  return { tag: record.cloud.tag, sha: recordedSha, ref: "last-good", trunk: recordedTrunk };
}

/** The release tag (if any) whose commit is `sha`: for the rollback record's "live tag". */
export async function tagOfSha(ports: Ports, config: PipelineConfig, sha: string): Promise<string | null> {
  const pattern = releaseTagRegex(config);
  const tags = (await ports.git.tags()).filter((tag) => pattern.test(tag)).sort((a, b) => compareTags(b, a));
  for (const tag of tags) {
    try {
      if ((await ports.git.revParse(`refs/tags/${tag}^{commit}`)) === sha) return tag;
    } catch { /* an unreadable tag is not the one */ }
  }
  return null;
}

/**
 * The Cloud sha live in an environment: the web stack's DeployedCloudSha output (BETA-CLOUD-PLAN 1.6; written by L5's cdk change); absent is null, never guessed.
 * The WEB stack only (#1478 phase 2): the gateway is deployed from Code now and records its own Code commit (DeployedCodeSha, see liveGatewayCodeSha), so the gateway stack
 * says nothing about which Cloud is live, and a gateway that an earlier pipeline stamped with a Cloud sha is not read either.
 */
export async function readLiveCloudSha(ports: Ports, web: string): Promise<{ sha: string | null; warnings: string[] }> {
  const stack = await ports.cfn.describeStack(web);
  const value = stack?.outputs.DeployedCloudSha;
  const sha = value !== undefined && /^[0-9a-f]{40}$/u.test(value) ? value : null;
  return { sha, warnings: sha === null ? [`no DeployedCloudSha output on the web stack (${web}): the live Cloud sha is unknown`] : [] };
}

/** The Code commit a gateway stack was deployed from: its DeployedCodeSha output (a 40-hex commit), else null (a gateway last deployed from Cloud has none). */
export function liveGatewayCodeSha(outputs: Readonly<Record<string, string>>): string | null {
  const value = outputs.DeployedCodeSha;
  return value !== undefined && /^[0-9a-f]{40}$/u.test(value) ? value : null;
}

export interface ModeDecision { mode: "release" | "rollback" | "adoption"; codeRelease: "run" | "skip"; warnings: string[] }

/**
 * Mode (L2-STAGE-CLI-INTERFACE.md 5; L9b): a CLOUD_REF that is a strict ancestor of the live Cloud sha is a rollback, which forces CODE_RELEASE=skip
 * (the caller pins Code). PIPELINE_MODE=rollback DECLARES a rollback even when CLOUD_REF is the live tag (a Code-only rollback); it never lets Cloud move forward:
 * a ref that is not the live commit or one of its ancestors is refused. With a Code target the Code release runs (CODE_RELEASE_EFFECTIVE=run: Code deploys the target);
 * a CODE_RELEASE=skip request next to a target is refused, since Code would not be rolled back. An unknown live sha cannot be proven a rollback: not one, with a warning.
 */
export async function decideMode(ports: Ports, args: { requested: "run" | "skip"; resolved: ResolvedRef; liveSha: string | null; adopt: boolean; env: PipelineEnv; declared?: boolean; codeTarget?: string | null }): Promise<ModeDecision> {
  const warnings: string[] = [];
  const target = args.codeTarget ?? null;
  if (args.adopt) {
    if (args.declared === true || target !== null) throw new StageError("REFUSED", "an adoption run cannot also be a rollback (PIPELINE_MODE=rollback or a Code target)");
    if (args.resolved.ref !== "CLOUD_REF") throw new StageError("REFUSED", "an adoption run names the tag already live: set CLOUD_REF");
    if (args.liveSha !== null && args.liveSha !== args.resolved.sha) throw new StageError("REFUSED", `adoption: ${args.resolved.tag} (${args.resolved.sha.slice(0, 9)}) is not what is live (${args.liveSha.slice(0, 9)})`);
    if (args.liveSha === null) warnings.push("adoption with an unknown live Cloud sha: the empty change sets are the proof");
    return { mode: "adoption", codeRelease: args.requested, warnings };
  }
  if (args.declared === true) {
    if (target !== null && args.requested === "skip") throw new StageError("ROLLBACK_REFUSED", `a Code rollback to ${target.slice(0, 12)} needs CODE_RELEASE=run: with skip, Code would not be rolled back`);
    if (target === null && args.liveSha !== null && args.liveSha === args.resolved.sha) throw new StageError("ROLLBACK_REFUSED", `PIPELINE_MODE=rollback with CLOUD_REF ${args.resolved.tag} (what ${args.env} runs) and no Code target changes nothing: name an older tag, or a Code target`);
    if (args.liveSha === null) warnings.push("a rollback is declared but the live Cloud sha is unknown, so it cannot be proven that CLOUD_REF does not move Cloud forward");
    else if (args.liveSha !== args.resolved.sha) {
      let behind = false;
      try { behind = await ports.git.isAncestor(args.resolved.sha, args.liveSha); } catch { /* not in this repository: not proven, refused below */ }
      if (!behind) throw new StageError("ROLLBACK_REFUSED", `PIPELINE_MODE=rollback, but ${args.resolved.tag} (${args.resolved.sha.slice(0, 9)}) is not the live Cloud (${args.liveSha.slice(0, 9)}) or older than it: a rollback never moves Cloud forward (name the live tag, or an older one, in CLOUD_REF)`);
    }
    return { mode: "rollback", codeRelease: target === null ? "skip" : "run", warnings };
  }
  if (args.liveSha === null) {
    if (args.resolved.ref === "CLOUD_REF") warnings.push("CLOUD_REF is set but the live Cloud sha is unknown, so a rollback cannot be told from a release");
    return { mode: "release", codeRelease: args.requested, warnings };
  }
  if (args.liveSha !== args.resolved.sha) {
    let behind = false;
    try { behind = await ports.git.isAncestor(args.resolved.sha, args.liveSha); } catch { warnings.push(`the live Cloud sha ${args.liveSha.slice(0, 9)} is not in this repository, so a rollback cannot be told from a release`); }
    if (behind) return { mode: "rollback", codeRelease: "skip", warnings };
  }
  return { mode: "release", codeRelease: args.requested, warnings };
}
