// The candidate tree: a detached worktree of the Cloud sha being released, built where cdk needs it (L2-STAGE-CLI-INTERFACE.md 2.1).
import { StageError } from "../types.ts";
import type { StepContext } from "./context.ts";
import { CODE_REPO_ENV, NO_AWS_ENV, commitInRepo, envValue } from "./gate-env.ts";

export function candidateDir(ctx: StepContext, sha: string): string {
  return `${ctx.inputs.workDir}/cloud-${sha.slice(0, 12)}`;
}

export async function checkoutCandidate(ctx: StepContext, sha: string): Promise<string> {
  const dir = candidateDir(ctx, sha);
  if (ctx.ports.fs.exists(dir)) ctx.log(`candidate tree ${dir} exists; reusing it`);
  else {
    ctx.ports.fs.mkdirp(ctx.inputs.workDir);
    await ctx.ports.git.worktree(sha, dir);
    ctx.log(`candidate tree: ${sha.slice(0, 12)} at ${dir}`);
  }
  return dir;
}

/** Checks the candidate out and runs the build commands of config.json (the common ones, and the web build when `web`). */
export async function buildCandidate(ctx: StepContext, sha: string, web: boolean): Promise<string> {
  const dir = await checkoutCandidate(ctx, sha);
  for (const command of [...ctx.config.build.common, ...(web ? ctx.config.build.web : [])]) {
    ctx.log(`build: ${command}`);
    const run = await ctx.ports.exec("bash", ["-c", command], { cwd: dir });
    if (run.code !== 0) throw new StageError("FAILED", `the build command "${command}" exited ${run.code}: ${run.stderr.split("\n").filter((l) => l !== "").slice(-3).join(" / ")}`);
  }
  return dir;
}

/** The Code commit's checkout directory (a detached worktree of the Code clone), beside the Cloud candidate's. */
export function codeTreeDir(ctx: StepContext, sha: string): string {
  return `${ctx.inputs.workDir}/code-${sha.slice(0, 12)}`;
}

/**
 * A detached worktree of the Code commit the gateway comes from (#1478 phase 2: the gateway image is built from it and its stacks are synthesized from it), taken from the full
 * Code clone the build action provides (ROVARA_CODE_REPO, the pipeline's Source input). A missing clone, or a commit the clone does not hold, REFUSES: the gateway is never
 * built from something else.
 */
export async function checkoutCodeTree(ctx: StepContext, sha: string): Promise<string> {
  const repo = await envValue(ctx.ports, CODE_REPO_ENV);
  if (repo === null) throw new StageError("REFUSED", `${CODE_REPO_ENV} is not set: the gateway comes from Code, so the build action must provide a full clone of Rovara Code (the pipeline's Source input)`);
  if (!await commitInRepo(ctx.ports, repo, sha)) throw new StageError("REFUSED", `the Code commit ${sha.slice(0, 12)} the gateway comes from is not in the Code clone at ${CODE_REPO_ENV}`);
  const dir = codeTreeDir(ctx, sha);
  if (ctx.ports.fs.exists(dir)) {
    // A tree that is already there is reused only when it is at the commit asked for (the image step makes the same check before it hashes the tree).
    const head = await ctx.ports.exec("git", ["-C", dir, "rev-parse", "HEAD"]);
    if (head.code !== 0 || head.stdout.trim() !== sha) throw new StageError("REFUSED", `the Code tree ${dir} exists but is not at the Code commit ${sha.slice(0, 12)} the gateway comes from: it is not reused`);
    ctx.log(`Code tree ${dir} exists at ${sha.slice(0, 12)}; reusing it`);
  } else {
    ctx.ports.fs.mkdirp(ctx.inputs.workDir);
    const added = await ctx.ports.exec("git", ["-C", repo, "worktree", "add", "--detach", dir, sha]);
    if (added.code !== 0) throw new StageError("FAILED", `git worktree add of the Code commit ${sha.slice(0, 12)} failed: ${added.stderr.trim().split("\n").slice(-1)[0] ?? ""}`);
    ctx.log(`Code tree: ${sha.slice(0, 12)} at ${dir}`);
  }
  return dir;
}

/**
 * The Code checkout made ready to synthesize the gateway stacks: its install and build commands (config.json build.codeGateway), run WITHOUT AWS credentials (the install runs Code's
 * dependency tree on a build machine whose role can change stacks; the deployed-drift gate holds the same line). cdk itself runs later with the credentials, as it does for Cloud's app.
 */
export async function buildCodeGateway(ctx: StepContext, sha: string): Promise<string> {
  const dir = await checkoutCodeTree(ctx, sha);
  for (const command of ctx.config.build.codeGateway) {
    ctx.log(`build (Code ${sha.slice(0, 12)}): ${command}`);
    const run = await ctx.ports.exec("bash", ["-c", command], { cwd: dir, env: NO_AWS_ENV });
    if (run.code !== 0) throw new StageError("FAILED", `the Code build command "${command}" exited ${run.code}: ${run.stderr.split("\n").filter((l) => l !== "").slice(-3).join(" / ")}`);
  }
  return dir;
}
