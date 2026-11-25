// Gate: the Cloud ref (and, in the gateway step, the gateway digest) must not be below a rollback floor (BETA-CLOUD-PLAN 5; L9).
// Runs in a rollback AND in a release: when the live Cloud sha is unknown a rollback cannot be told from a release (L2 5), so a below-floor ref must not pass as "release".
// With a Code rollback target (L9b) the preflight also judges the target against the `code` floors, in the Code clone (ROVARA_CODE_REPO). An adoption run deploys what is already live and is skipped. Floors come from the pipeline tree's rollback-floors.json (lib/floors.ts); the gate writes nothing.
import { cloudFloors, gatewayCodeFloors, judgeCodeTarget, judgeDigest, judgeGatewayCodeSha, judgeRef, loadFloors } from "../lib/floors.ts";
import { CODE_REPO_ENV, envValue } from "../lib/gate-env.ts";
import { codeTargetOf } from "../lib/manifest.ts";
import type { Gate } from "../types.ts";

export const gate: Gate = {
  name: "rollback-floor",
  phases: ["preflight", "change-sets"],
  async run(input) {
    const { manifest } = input;
    if (manifest.mode === "adoption") return { result: "skipped", skippedReason: "an adoption run deploys what is already live" };
    let floors;
    try { floors = loadFloors(input.ports, input.dirs.pipeline); } catch (error) { return { result: "fail", failures: [error instanceof Error ? error.message : String(error)] }; }
    const failures: string[] = [];
    const notes: string[] = [];
    if (input.phase === "preflight") {
      const verdict = await judgeRef(input.ports, floors, manifest.cloud);
      failures.push(...verdict.failures);
      notes.push(...verdict.notes);
      // A Code rollback (L9b): the target is judged against the `code` group in the Code clone the build action provides.
      const codeTarget = codeTargetOf(manifest);
      if (manifest.mode === "rollback" && codeTarget !== null) {
        const code = await judgeCodeTarget(input.ports, floors, await envValue(input.ports, CODE_REPO_ENV), codeTarget);
        failures.push(...code.failures);
        notes.push(...code.notes);
      }
    } else if (input.changeSets.some((cs) => cs.part === "gateway")) {
      // The digest is in the manifest once the image step ran. Digests have no order, so the file names the ones known to be below the floor.
      if (manifest.gateway.digest !== null) failures.push(...judgeDigest(floors, manifest.gateway.digest));
      // The gateway comes from Code (#1478 phase 2): its Code commit is judged against the `gatewayCode` floors in the Code clone. The Cloud-sha `gateway` floors are not lost: they keep
      // judging the Cloud ref in preflight (and each has a gatewayCode counterpart for the commit the image was built from).
      const codeSha = manifest.gateway.codeSha ?? null;
      if (codeSha === null) failures.push("the manifest names no Code commit for the gateway, so it cannot be judged against the gatewayCode floors");
      else {
        const verdict = await judgeGatewayCodeSha(input.ports, floors, await envValue(input.ports, CODE_REPO_ENV), codeSha);
        failures.push(...verdict.failures);
        notes.push(...verdict.notes);
      }
    } else return { result: "skipped", skippedReason: "the ref was judged in preflight; the gateway digest is judged with the gateway change set" };
    return failures.length === 0
      ? { result: "pass", notes, data: { mode: manifest.mode, floors: cloudFloors(floors).length, gatewayCodeFloors: gatewayCodeFloors(floors).length, tag: manifest.cloud.tag } }
      : { result: "fail", failures, notes, data: { mode: manifest.mode, tag: manifest.cloud.tag } };
  },
};
