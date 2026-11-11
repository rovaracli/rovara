// Lane 7: a replay copy of a past task (`evalRun` on its record) is never published and never announced. These are the refusals at the places a task reaches the outside world: a pull request opened or updated on the
// real repository, a branch synchronised, a Slack message, a tracker comment, a Team record row. Each caller asks `isReplayCopy` / `refuseReplayCopy` of the record it already holds. Fail closed: any `evalRun` value but absent,
// null or false counts (`lessons/eval-run.ts#isEvalRunMark`).
import { agentXError } from "@rovara-code/contracts";
import { isEvalRunMark } from "../lessons/eval-run.js";

export const REPLAY_COPY_REFUSAL = "This task is a replay copy made to measure the lessons. It is never published, shared or announced.";
export const isReplayCopy = (task: { evalRun?: unknown } | undefined): boolean => task !== undefined && isEvalRunMark(task.evalRun);
export function refuseReplayCopy(task: { evalRun?: unknown } | undefined): void {
  if (isReplayCopy(task)) throw agentXError("FORBIDDEN", REPLAY_COPY_REFUSAL);
}
