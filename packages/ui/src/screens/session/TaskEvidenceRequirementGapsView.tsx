import { VisibleText } from "../../design/VisibleText.js";
import type { ReadTask } from "./workspace-types.js";

type ReturnedGap = NonNullable<ReadTask["proofTable"]>["notTested"][number];

/** A leaf section for the explicit, task-scoped uncovered-requirement list. The owning Evidence tab supplies the parsed list and its code head. */
export function TaskEvidenceRequirementGapsView({ taskId, evidenceHead, uncoveredRequirements }: {
  taskId: string;
  evidenceHead: string | undefined;
  uncoveredRequirements: readonly ReturnedGap[] | undefined;
}) {
  const available = evidenceHead !== undefined && evidenceHead.length > 0 && uncoveredRequirements !== undefined;
  const requirements = available ? uncoveredRequirements.filter((item) => item.kind === "claim") : [];
  const count = requirements.length;
  const requirementText = requirements.map((item) => item.id + ": " + item.text).join("; ");

  return <section aria-label="What wasn't tested" className="rv-not-tested rv-task-evidence-requirement-gap" data-task-id={taskId} data-evidence-head={available ? evidenceHead : undefined}>
    <h2>What wasn't tested</h2>
    {!available ? <p>Uncovered requirements are unavailable for this evidence.</p>
      : count === 0 ? <p>No uncovered requirements were returned for this evidence. No passing result is claimed here.</p>
        : <p style={{ overflowWrap: "anywhere" }}>{count + (count === 1 ? " requirement was" : " requirements were") + " not tested: "}<VisibleText text={requirementText} />{(requirementText.endsWith(".") ? " " : ". ") + "No passing result is claimed for them. Review the missing evidence."}</p>}
  </section>;
}
