// The candidate tree: a detached worktree of the Cloud sha being released, built where cdk needs it (L2-STAGE-CLI-INTERFACE.md 2.1).
import { StageError } from "../types.ts";
import type { StepContext } from "./context.ts";

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
