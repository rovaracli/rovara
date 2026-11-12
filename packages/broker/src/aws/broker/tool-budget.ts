// Cloud's registration budget for connector and source tools. Code (from the vendor pin 0e340c0e, Code commit baf0e2522) raised its own limit to a sanity bound of 200 because its sessions
// declare tools past 20 lazily, through Pi's tool_search. Cloud's orchestrator and worker still declare every tool (the orchestrator refuses more than MAX_VISIBLE_TOOLS = 40 at turn time),
// so registration keeps the old rule here: warn above 20, refuse above 40. Owed: port Code's deferred tools to Cloud, then use Code's toolBudget and delete this file
// (DEFERRED-CHECKS CLOUD-DEFERRED-TOOLS-PORT).
import { IN_HOUSE_TOOL_COUNT } from "@rovara-code/contracts";

export const CLOUD_TOOL_WARNING_THRESHOLD = 20;
/** Kept equal to the orchestrator's MAX_VISIBLE_TOOLS by tests/contract/orchestrator-boundary.test.ts. */
export const CLOUD_TOOL_LIMIT = 40;

/** The most tools the model could see: every in-house tool plus every approval. */
export function cloudToolBudget(approved: number): { maximum: number; warning?: string; refusal?: string } {
  const maximum = IN_HOUSE_TOOL_COUNT + approved;
  if (maximum > CLOUD_TOOL_LIMIT) return { maximum, refusal: `this project could expose ${maximum} tools; at most ${CLOUD_TOOL_LIMIT} are allowed. Approve fewer connector tools.` };
  if (maximum > CLOUD_TOOL_WARNING_THRESHOLD) return { maximum, warning: `the model could see ${maximum} tools; above ${CLOUD_TOOL_WARNING_THRESHOLD}, tool choice gets less reliable. Approve fewer connector tools.` };
  return { maximum };
}
