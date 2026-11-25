// Gate: the protected-resource check on the change sets just previewed (L3; BETA-CLOUD-PLAN section 4, C9).
// Preflight runs it on web+app, the gateway step runs it on the gateway change set (the "protected check on THAT change set"). Reads records only.
// The list is the pipeline tree's own ops/pipeline/protected.json (never the candidate's), so a release cannot loosen its own check.
// Replacement Conditional counts as a replacement (scratch proof 1). An image-only gateway change (infra unchanged from the deployed Cloud) may touch only the five image rows.
import { fileURLToPath } from "node:url";
import { stackName } from "../config.ts";
import { CODE_REPO_ENV, envValue } from "../lib/gate-env.ts";
import { checkProtected, parseProtected } from "../lib/protected.ts";
import { liveGatewayCodeSha } from "../lib/refs.ts";
import type { ProtectedList } from "../lib/protected.ts";
import type { Gate, GateInput } from "../types.ts";

const LIST_PATH = fileURLToPath(new URL("../protected.json", import.meta.url));

/**
 * True when the gateway infra is identical between what is deployed and what this run deploys, so that only the image rows may change. The gateway is Code's (#1478 phase 2), so the
 * comparison has two halves, and BOTH must hold: (1) Code's gateway infra paths (protected.json imageOnlyCodePaths) between the Code commit the live gateway stack was deployed from
 * (its DeployedCodeSha output) and the commit this run builds it from, judged in the Code clone; (2) the pipeline's own settings file (imageOnlyPaths: the gateway's cdk context rows)
 * between the live and the candidate Cloud commits. A gateway last deployed from Cloud has no DeployedCodeSha, so it is never image-only: the general rules apply (and the
 * gateway-source-switch gate holds that first change to no resource change at all). Unknown: false, with a note.
 */
async function infraUnchanged(input: GateInput, list: ProtectedList, notes: string[]): Promise<boolean> {
  const { ports, manifest, env } = input;
  const liveCloud = manifest.cloud.liveSha[env];
  const candidateCloud = manifest.cloud.sha;
  if (liveCloud === null) { notes.push("the deployed Cloud sha is unknown, so the gateway change is not treated as image-only"); return false; }
  if (liveCloud !== candidateCloud) {
    const diff = await ports.exec("git", ["-C", input.dirs.pipeline, "diff", "--quiet", liveCloud, candidateCloud, "--", ...list.imageOnlyPaths]);
    if (diff.code === 1) { notes.push(`the gateway settings changed between the deployed Cloud ${liveCloud.slice(0, 9)} and ${candidateCloud.slice(0, 9)}: the general rules apply`); return false; }
    if (diff.code !== 0) { notes.push(`could not compare the deployed Cloud ${liveCloud.slice(0, 9)} with ${candidateCloud.slice(0, 9)} (git exit ${diff.code}): the gateway change is not treated as image-only`); return false; }
  }
  const stack = await ports.cfn.describeStack(stackName(input.config, env, "gateway"));
  const liveCode = liveGatewayCodeSha(stack?.outputs ?? {});
  const candidateCode = manifest.gateway.codeSha ?? null;
  if (liveCode === null) { notes.push("the live gateway was not deployed from Code (no DeployedCodeSha output), so the change is not treated as image-only"); return false; }
  if (candidateCode === null) { notes.push("the manifest names no Code commit for the gateway, so the change is not treated as image-only"); return false; }
  if (liveCode === candidateCode) return true;
  const repo = await envValue(ports, CODE_REPO_ENV);
  if (repo === null) { notes.push(`${CODE_REPO_ENV} is not set, so the gateway infra cannot be compared in Code: the change is not treated as image-only`); return false; }
  const diff = await ports.exec("git", ["-C", repo, "diff", "--quiet", liveCode, candidateCode, "--", ...list.imageOnlyCodePaths]);
  if (diff.code === 0) return true;
  if (diff.code === 1) { notes.push(`the gateway infra changed in Code between the deployed ${liveCode.slice(0, 9)} and ${candidateCode.slice(0, 9)}: the general rules apply`); return false; }
  notes.push(`could not compare the deployed Code ${liveCode.slice(0, 9)} with ${candidateCode.slice(0, 9)} (git exit ${diff.code}): the gateway change is not treated as image-only`);
  return false;
}

export const gate: Gate = {
  name: "protected",
  phases: ["change-sets"],
  async run(input) {
    let list: ProtectedList;
    try { list = parseProtected(input.ports.fs.readText(LIST_PATH)); } catch (error) {
      return { result: "fail", failures: [`cannot read the protected list: ${error instanceof Error ? error.message : String(error)}`] };
    }
    if (input.changeSets.length === 0) return { result: "fail", failures: ["no change set was given to check"] };
    const notes: string[] = [];
    const hasGateway = input.changeSets.some((cs) => cs.part === "gateway");
    const imageOnly = hasGateway && input.manifest.mode !== "adoption" && await infraUnchanged(input, list, notes);
    const result = checkProtected(list, input.changeSets, { imageOnly });
    const data = { parts: input.changeSets.map((cs) => cs.part), rows: result.checkedRows, imageOnly };
    notes.push(...result.notes);
    return result.failures.length === 0 ? { result: "pass", notes, data } : { result: "fail", failures: result.failures, notes, data };
  },
};
