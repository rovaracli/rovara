// Ref resolution (BETA-CLOUD-PLAN 1.3): the Cloud ref is the newest vX.Y.Z tag on the trunk, or the pipeline variable CLOUD_REF.
// The rule of FIND_RELEASE_TAG and RELEASE_TAG_ON_BRANCH (infra/lib/cloud-release-pipeline.ts) with the trunk names from config.json.
import { releaseTagRegex } from "../config.ts";
import type { PipelineConfig } from "../config.ts";
import { StageError } from "../types.ts";
import type { PipelineEnv, Ports } from "../types.ts";

export interface ResolvedRef { tag: string; sha: string; ref: "latest-tag" | "CLOUD_REF"; trunk: string }

const versionOf = (tag: string): [number, number, number] => {
  const parts = tag.slice(1).split(".").map((part) => Number(part));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
};
export function compareTags(a: string, b: string): number {
  const x = versionOf(a);
  const y = versionOf(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

export async function resolveCloudRef(ports: Ports, config: PipelineConfig, requested: string | null): Promise<ResolvedRef> {
  const pattern = releaseTagRegex(config);
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

/** The Cloud sha live in an environment: the DeployedCloudSha output (BETA-CLOUD-PLAN 1.6; written by L5's cdk change). Web first, then the gateway; absent is null, never guessed. */
export async function readLiveCloudSha(ports: Ports, web: string, gateway: string): Promise<{ sha: string | null; warnings: string[] }> {
  const warnings: string[] = [];
  const fromStack = async (name: string): Promise<string | null> => {
    const stack = await ports.cfn.describeStack(name);
    const value = stack?.outputs.DeployedCloudSha;
    return value !== undefined && /^[0-9a-f]{40}$/u.test(value) ? value : null;
  };
  const w = await fromStack(web);
  const g = await fromStack(gateway);
  if (w !== null && g !== null && w !== g) warnings.push(`DeployedCloudSha differs: ${web} says ${w.slice(0, 9)}, ${gateway} says ${g.slice(0, 9)}`);
  const sha = w ?? g;
  if (sha === null) warnings.push("no DeployedCloudSha output on the web or gateway stack: the live Cloud sha is unknown");
  return { sha, warnings };
}

export interface ModeDecision { mode: "release" | "rollback" | "adoption"; codeRelease: "run" | "skip"; warnings: string[] }

/**
 * Mode (L2-STAGE-CLI-INTERFACE.md 5): a CLOUD_REF that is a strict ancestor of the live Cloud sha is a rollback, which forces CODE_RELEASE=skip
 * (the caller pins Code). An unknown live sha cannot be proven a rollback: not one, with a warning.
 */
export async function decideMode(ports: Ports, args: { requested: "run" | "skip"; resolved: ResolvedRef; liveSha: string | null; adopt: boolean; env: PipelineEnv }): Promise<ModeDecision> {
  const warnings: string[] = [];
  if (args.adopt) {
    if (args.resolved.ref !== "CLOUD_REF") throw new StageError("REFUSED", "an adoption run names the tag already live: set CLOUD_REF");
    if (args.liveSha !== null && args.liveSha !== args.resolved.sha) throw new StageError("REFUSED", `adoption: ${args.resolved.tag} (${args.resolved.sha.slice(0, 9)}) is not what is live (${args.liveSha.slice(0, 9)})`);
    if (args.liveSha === null) warnings.push("adoption with an unknown live Cloud sha: the empty change sets are the proof");
    return { mode: "adoption", codeRelease: args.requested, warnings };
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
