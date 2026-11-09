// Standing instructions (lanes I1, I2): what the dispatch of one operation hands `applyAgentStep` for the block: the company's newest rules (read now) and whether the switch moves "How we work" into it.
import type { CompanyInstructionsSnapshot } from "@agentx/contracts";
import type { DispatchMode } from "../agents/dispatch.js";
import { readCompanyInstructions, type CompanyInstructionsSource } from "./company-source.js";
import { standingInstructionsEnabled } from "./switch.js";

/**
 * The modes whose operations do not carry the block: verification (`CHECKS` runs the project's checks in the harness; a check step takes no instructions), the setup run that runs commands, and the spec write. A
 * deep diagnosis (a read-only look at a failure, with its own preamble) carries none either, as it carried none of the agent's instructions before.
 */
const WITHOUT_BLOCK: ReadonlySet<DispatchMode> = new Set<DispatchMode>(["CHECKS", "SETUP_AGENT", "SPEC_WRITE"]);

export interface StandingInput { moveHowWeWork: boolean; company?: CompanyInstructionsSnapshot | undefined }

/**
 * `undefined` for an operation that carries no block, or when there is nothing to carry (the switch is off and the company has no rules): the operation is then exactly what it was before this lane.
 * Reads the company's rules at every call (decision 57.5) and fails closed: see `readCompanyInstructions`.
 */
export async function standingInputFor(
  source: CompanyInstructionsSource | undefined, company: string, mode: DispatchMode | undefined, agentRun: boolean, task: { purpose?: string | undefined } | undefined,
): Promise<StandingInput | undefined> {
  if ((!agentRun && mode !== undefined && WITHOUT_BLOCK.has(mode)) || task?.purpose === "diagnosis") return undefined;
  const rules = await readCompanyInstructions(source, company);
  const moveHowWeWork = standingInstructionsEnabled();
  if (rules === undefined && !moveHowWeWork) return undefined;
  return { moveHowWeWork, ...(rules === undefined ? {} : { company: rules }) };
}
