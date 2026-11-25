// Gate: the Cloud ref (and, in the gateway step, the gateway digest) must not be below a rollback floor (BETA-CLOUD-PLAN 5; L9).
// Runs in a rollback AND in a release: when the live Cloud sha is unknown a rollback cannot be told from a release (L2 5), so a below-floor ref must not pass as "release".
// An adoption run deploys what is already live and is skipped. Floors come from the pipeline tree's rollback-floors.json (lib/floors.ts); the gate writes nothing.
import { judgeDigest, judgeRef, loadFloors } from "../lib/floors.ts";
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
    } else if (input.changeSets.some((cs) => cs.part === "gateway")) {
      // The digest is in the manifest once the image step ran. Digests have no order, so the file names the ones known to be below the floor.
      if (manifest.gateway.digest !== null) failures.push(...judgeDigest(floors, manifest.gateway.digest));
    } else return { result: "skipped", skippedReason: "the ref was judged in preflight; the gateway digest is judged with the gateway change set" };
    return failures.length === 0
      ? { result: "pass", notes, data: { mode: manifest.mode, floors: floors.floors.length, tag: manifest.cloud.tag } }
      : { result: "fail", failures, notes, data: { mode: manifest.mode, tag: manifest.cloud.tag } };
  },
};
