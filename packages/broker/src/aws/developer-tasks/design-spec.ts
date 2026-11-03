// Design review stage, DR7 slice C (DR12 wiring): the spec step's view of the design. `designSpecStateOf` is the `design` port of the spec gate and of the spec write (`SpecEndEnvironment.design`): off when the task has no design
// review, "wait" until a person approved a design whose text hashes to the approved digest, then the approved design to write. `specDesignLineOf` is the one line of counts on the spec pull request ("Design reviewed: 3
// reviewers, 0 open blockers"): counts only, only for an approved design, and nothing for a task with no design review (the spec pull request is then exactly what it was).
import type { SpecDesignState } from "../../spec/approved-design.js";
import { approvedDesignDigestOf, specDesignState } from "../../spec/approved-design.js";
import { designCardFactsOf } from "../../design-review/card-source.js";
import { designReviewedLine } from "../../design-review/proof-line.js";
import { readLatestDesignText } from "../../design-review/route-facts.js";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";

export async function designSpecStateOf(task: DeveloperTaskRecord | undefined, readArtifact: (objectKey: string, maxBytes: number) => Promise<string>): Promise<SpecDesignState> {
  const workflow = task?.workflow;
  if (workflow === undefined || workflow.designReview === undefined) return { kind: "off" };
  const text = await readLatestDesignText(workflow, (key, max) => readArtifact(key, max).catch(() => undefined));
  return specDesignState(workflow, () => text);
}

export function specDesignLineOf(task: DeveloperTaskRecord | undefined): string | undefined {
  const workflow = task?.workflow;
  if (workflow?.designReview === undefined || approvedDesignDigestOf(workflow) === undefined) return undefined;
  return designReviewedLine(workflow.designReview, designCardFactsOf(workflow.designReview, []).blockers.length);
}
