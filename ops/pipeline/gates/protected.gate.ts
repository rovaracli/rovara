// Gate: the protected-resource check on the change sets just previewed (L3; BETA-CLOUD-PLAN section 4, C9).
// Preflight runs it on web+app, the gateway step runs it on the gateway change set (the "protected check on THAT change set"). Reads records only.
// The list is the pipeline tree's own ops/pipeline/protected.json (never the candidate's), so a release cannot loosen its own check.
// Replacement Conditional counts as a replacement (scratch proof 1). An image-only gateway change (infra unchanged from the deployed Cloud) may touch only the five image rows.
import { fileURLToPath } from "node:url";
import { checkProtected, parseProtected } from "../lib/protected.ts";
import type { ProtectedList } from "../lib/protected.ts";
import type { Gate, GateInput } from "../types.ts";

const LIST_PATH = fileURLToPath(new URL("../protected.json", import.meta.url));

/** True when the Cloud infra (the paths of protected.json's imageOnlyPaths) is identical between the deployed commit and the candidate. Unknown: false, with a note. */
async function infraUnchanged(input: GateInput, list: ProtectedList, notes: string[]): Promise<boolean> {
  const live = input.manifest.cloud.liveSha[input.env];
  const candidate = input.manifest.cloud.sha;
  if (live === null) { notes.push("the deployed Cloud sha is unknown, so the gateway change is not treated as image-only"); return false; }
  if (live === candidate) return true;
  const diff = await input.ports.exec("git", ["-C", input.dirs.pipeline, "diff", "--quiet", live, candidate, "--", ...list.imageOnlyPaths]);
  if (diff.code === 0) return true;
  if (diff.code === 1) { notes.push(`infra changed between the deployed ${live.slice(0, 9)} and ${candidate.slice(0, 9)}: the general rules apply`); return false; }
  notes.push(`could not compare the deployed ${live.slice(0, 9)} with ${candidate.slice(0, 9)} (git exit ${diff.code}): the gateway change is not treated as image-only`);
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
