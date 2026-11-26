// Gate 1 (L5; BETA-CLOUD-PLAN section 2 and C3/C4): the DEPLOYED Cloud's own contract-drift check, against the Code commit that will be live.
// Check out the Cloud sha this environment is running (the DeployedCloudSha stack output) and run THAT tree's `npm run contract:drift -- check --code-ref <sha> --code-repo <clone>`:
// the deployed tree's rules, parsers and accepted-drift file are the ones that apply (candidate rules can name parsers the deployed tree lacks). The candidate tree is checked too.
// The one thing it writes is local: a git worktree, `npm ci` in it and the Code workspace packages the contracts import (built into that tree's node_modules) (a documented exception to "a gate never creates anything"); both child commands run with AWS credentials removed.
// Failure: "release Cloud first: run with CODE_RELEASE=skip, then Code". Read-only: it creates a worktree and runs npm ci in it, nothing else.
//
// First release (no DeployedCloudSha yet; an outputs-only first adoption may write none): fail closed, never pass. The deployed tree is known only
//   - in an ADOPTION run (manifest.mode === "adoption", the one adoption concept L2 owns: CLOUD_REF is the tag already live, and every change set must be empty, so deployed == candidate), or
//   - when the operator names it with ROVARA_ADOPT_DEPLOYED_CLOUD_SHA=<40 hex of a release tag's commit that is the candidate or an ancestor of it> (recorded in the verdict).
import { ADOPT_DEPLOYED_SHA_ENV, CODE_REPO_ENV, NO_AWS_ENV, codeShaThatWillBeLive, commitInRepo, envValue } from "../lib/gate-env.ts";
import { codeTargetOf } from "../lib/manifest.ts";
import { tagOfSha } from "../lib/refs.ts";
import type { Gate, GateInput } from "../types.ts";

const SHA = /^[0-9a-f]{40}$/u;
const NPM_CI = ["ci", "--no-audit", "--no-fund"];

interface Deployed { sha: string; source: "stack-output" | "adoption" | "operator-flag" }

async function deployedSha(input: GateInput): Promise<Deployed | string> {
  const live = input.manifest.cloud.liveSha[input.env];
  if (live !== null) return { sha: live, source: "stack-output" };
  if (input.manifest.mode === "adoption") return { sha: input.manifest.cloud.sha, source: "adoption" };
  const first = `first release: ${input.env} has no DeployedCloudSha output on its web stack (the gateway is Code's now and records a Code commit, not a Cloud one), so the deployed Cloud cannot be checked out and nothing is assumed.`;
  const flag = await envValue(input.ports, ADOPT_DEPLOYED_SHA_ENV);
  if (flag === null) return `${first} Run once as an adoption run (manifest mode adoption, CLOUD_REF = the tag already live, every change set empty), or name the live Cloud commit with ${ADOPT_DEPLOYED_SHA_ENV}=<40-hex sha of a release tag>.`;
  if (!SHA.test(flag)) return `${ADOPT_DEPLOYED_SHA_ENV} must be a 40-character lowercase hex commit sha`;
  const tag = await tagOfSha(input.ports, input.config, flag);
  if (tag === null) return `${ADOPT_DEPLOYED_SHA_ENV}=${flag.slice(0, 9)} is not the commit of a release tag: only a released Cloud can be named as the deployed one`;
  const candidate = input.manifest.cloud.sha;
  const related = flag === candidate || await input.ports.git.isAncestor(flag, candidate).catch(() => false);
  if (!related) return `${ADOPT_DEPLOYED_SHA_ENV}=${flag.slice(0, 9)} (${tag}) is neither the candidate ${candidate.slice(0, 9)} nor an ancestor of it`;
  input.log(`${first} Using ${tag} (${flag.slice(0, 12)}) named by ${ADOPT_DEPLOYED_SHA_ENV}.`);
  return { sha: flag, source: "operator-flag" };
}

interface DriftOutcome { ok: boolean; lines: string[] }

async function runDrift(input: GateInput, dir: string, codeSha: string, repo: string, label: string): Promise<DriftOutcome> {
  const { ports } = input;
  const pkg = `${dir}/package.json`;
  if (!ports.fs.exists(pkg) || !ports.fs.readText(pkg).includes('"contract:drift"')) return { ok: false, lines: [`${label}: this tree has no contract:drift script (it predates the check), so it cannot vouch for itself`] };
  // The tree's own drift tool exports only packages/contracts from the Code clone; a tree that predates its fix cannot load Code's contracts once they import a sibling workspace package
  // (@preplabsai/rovara-code-api, Code train 42). The PIPELINE tree's helper puts the Code workspace packages the contracts need, built from the pinned Code commit, into this tree's node_modules.
  // Fail closed: if they cannot be installed, the check does not run.
  const link = await ports.exec("node", [`${input.dirs.pipeline}/scripts/contract-drift/link-code-workspaces.ts`, dir, repo, codeSha], { env: NO_AWS_ENV });
  if (link.code !== 0) return { ok: false, lines: [`${label}: the Code workspace packages that Code's contracts import could not be installed (exit ${link.code}): ${(link.stderr || link.stdout).split("\n").filter((l) => l !== "").slice(-2).join(" / ").slice(0, 300)}`] };
  const run = await ports.exec("npm", ["run", "contract:drift", "--", "check", "--code-ref", codeSha, "--code-repo", repo], { cwd: dir, env: NO_AWS_ENV });
  const all = `${run.stdout}\n${run.stderr}`.split("\n").map((l) => l.trimEnd()).filter((l) => l !== "");
  for (const line of all.slice(-6)) input.log(`${label}: ${line}`);
  if (run.code === 0) {
    // A check older than the text rules reads the schemas only; it would pass a Code sentence it cannot parse. That is no proof.
    if (!all.some((l) => /^Code text [0-9a-f]+ .*sentences read/u.test(l))) return { ok: false, lines: [`${label}: the drift check passed but never read Code's sentences (this tree predates the text rules), so it proves nothing about them`] };
    return { ok: true, lines: [] };
  }
  const findings = all.filter((l) => /^(DRIFT|STALE|TEXT)\b/u.test(l) || /refused by Cloud/u.test(l)).slice(0, 6);
  return { ok: false, lines: [`${label}: contract:drift exited ${run.code}${findings.length === 0 ? `: ${all.slice(-2).join(" / ")}` : ""}`, ...findings.map((l) => `${label}:   ${l.slice(0, 240)}`)] };
}

export const gate: Gate = {
  name: "deployed-drift",
  phases: ["preflight"],
  async run(input) {
    const { ports, manifest, env } = input;
    const candidate = manifest.cloud.sha;
    if (input.dirs.cloud === null) return { result: "fail", failures: ["no candidate tree to check"] };
    const deployed = await deployedSha(input);
    if (typeof deployed === "string") return { result: "fail", failures: [deployed] };
    const code = codeShaThatWillBeLive(manifest, env);
    if (code.sha === null) return { result: "fail", failures: [code.why] };
    const repo = await envValue(ports, CODE_REPO_ENV);
    if (repo === null) return { result: "fail", failures: [`${CODE_REPO_ENV} is not set: the build action must provide a full clone of Rovara Code`] };
    if (!await commitInRepo(ports, repo, code.sha)) return { result: "fail", failures: [`the Code commit ${code.sha.slice(0, 12)} is not in the Code clone at ${CODE_REPO_ENV}`] };
    const data = { deployedSha: deployed.sha, deployedSource: deployed.source, candidateSha: candidate, codeSha: code.sha, codeWhy: code.why };
    const failures: string[] = [];

    const same = deployed.sha === candidate;
    const deployedDir = same ? input.dirs.cloud : `${input.dirs.work}/cloud-deployed-${deployed.sha.slice(0, 12)}`;
    let deployedResult: DriftOutcome;
    if (same) deployedResult = { ok: true, lines: [] };
    else {
      try {
        if (!ports.fs.exists(deployedDir)) {
          await ports.git.worktree(deployed.sha, deployedDir);
          const install = await ports.exec("npm", NPM_CI, { cwd: deployedDir, env: NO_AWS_ENV });
          if (install.code !== 0) throw new Error(`npm ci in the deployed tree exited ${install.code}: ${install.stderr.split("\n").filter((l) => l !== "").slice(-2).join(" / ")}`);
        }
        deployedResult = await runDrift(input, deployedDir, code.sha, repo, `deployed ${deployed.sha.slice(0, 9)}`);
      } catch (error) {
        deployedResult = { ok: false, lines: [`deployed ${deployed.sha.slice(0, 9)}: could not be checked out and prepared: ${error instanceof Error ? error.message : String(error)}`] };
      }
    }
    const candidateResult = await runDrift(input, input.dirs.cloud, code.sha, repo, `candidate ${candidate.slice(0, 9)}`);
    if (!deployedResult.ok) {
      failures.push(...deployedResult.lines);
      failures.push(codeTargetOf(manifest) !== null
        ? "this is a Code rollback: the Cloud that is live cannot read the Code it rolls back to; roll Cloud back with it (an older CLOUD_REF), or choose another Code target"
        : manifest.code.release === "run"
        ? "release Cloud first: run with CODE_RELEASE=skip, then Code (the Cloud that is live cannot read what this Code sends)"
        : "the Code that stays live and the Cloud that is live already disagree; fix that before releasing anything");
    }
    if (!candidateResult.ok) failures.push(...candidateResult.lines, "the candidate Cloud cannot read that Code either");
    if (same) input.log(`the candidate is the deployed Cloud (${deployed.source}); checked once`);
    return failures.length === 0 ? { result: "pass", data } : { result: "fail", failures, data };
  },
};
