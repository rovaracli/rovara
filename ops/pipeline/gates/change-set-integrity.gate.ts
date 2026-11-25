// Gate: the change sets just previewed are what the pipeline expects (the staging pack's G0, plus the adoption rule of BETA-CLOUD-PLAN 3.1).
// Reads the records only: it creates and deletes nothing.
import type { Gate } from "../types.ts";

export const gate: Gate = {
  name: "change-set-integrity",
  phases: ["change-sets"],
  async run(input) {
    const failures: string[] = [];
    const expected = `rovara-pipeline-${input.manifest.exec8}`;
    const seen = new Set<string>();
    for (const cs of input.changeSets) {
      if (seen.has(cs.stack)) failures.push(`${cs.stack}: more than one change set recorded for it`);
      seen.add(cs.stack);
      if (cs.changeSetName !== expected) failures.push(`${cs.stack}: the change set is named ${cs.changeSetName}, not ${expected}`);
      if (!cs.noChanges) {
        if (cs.changeSetId === null || cs.templateSha256 === null) failures.push(`${cs.stack}: the change set has no id or template hash recorded`);
        if (cs.status !== "CREATE_COMPLETE" || cs.executionStatus !== "AVAILABLE") failures.push(`${cs.stack}: the change set is ${cs.status}/${cs.executionStatus}, not CREATE_COMPLETE/AVAILABLE`);
      }
      if (input.manifest.mode === "adoption") {
        // An adoption run is a true no-op: the only row allowed is the CDK metadata line.
        for (const row of cs.rows) {
          if (!(row.action === "Modify" && row.resourceType === "AWS::CDK::Metadata")) failures.push(`${cs.stack}: adoption must change nothing, but ${row.action} ${row.logicalId} (${row.resourceType})`);
        }
      }
    }
    if (input.changeSets.length === 0) failures.push("no change set was recorded for this phase");
    return failures.length === 0 ? { result: "pass", data: { stacks: [...seen] } } : { result: "fail", failures };
  },
};
