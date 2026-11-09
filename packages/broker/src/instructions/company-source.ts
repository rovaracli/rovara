// Standing instructions (lane I2, owner decision 51): the port the block reads the company's rules from. Provider-neutral: the Cloud store (lane I3) and Code's local file (lane I6) are two adapters
// of this one interface, and nothing here names an organisation table, a chat tool or a code host. Keep this folder free of Cloud-only imports (org/, spend/, audit/, team-record/) so the port to Code can carry it.
import { CompanyInstructionsSnapshotSchema, agentXError, assertCompanyRulesWithinBudget, type CompanyInstructionsSnapshot } from "@agentx/contracts";

export interface CompanyInstructionsSource {
  /**
   * The company's latest approved rules, read at every step (decision 57.5: a running task uses the newest approved version at its next step). `company` is an opaque key the adapter understands
   * (Cloud: the organisation id; Code: its one implicit company). Answers `undefined` (or no rules) when the company has none. A rejection fails the step closed: a step never runs without rules that exist.
   */
  current(company: string): Promise<CompanyInstructionsSnapshot | undefined>;
}

/** The Code default: no company rules. */
export const emptyCompanyInstructionsSource: CompanyInstructionsSource = { current: () => Promise.resolve(undefined) };

/**
 * The company's rules for one step, checked: `undefined` when there are none. A source that fails, answers something that is not a snapshot, or answers rules over the limits (30 rules, 600
 * characters each, 12,000 in all) refuses the step with a clear error; nothing is ever cut or skipped.
 */
export async function readCompanyInstructions(source: CompanyInstructionsSource | undefined, company: string): Promise<CompanyInstructionsSnapshot | undefined> {
  if (source === undefined) return undefined;
  let answer: unknown;
  try {
    answer = await source.current(company);
  } catch {
    // A transient fault may clear on a retry; the step does not run without the company's rules in the meantime.
    throw agentXError("RUNTIME_UNAVAILABLE", "The company rules could not be read, so this step did not start. Try again in a moment.");
  }
  if (answer === undefined) return undefined;
  const parsed = CompanyInstructionsSnapshotSchema.safeParse(answer);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "The company rules are not in a form Rovara can read. Ask a company admin to save them again.");
  if (parsed.data.rules.length === 0) return undefined;
  assertCompanyRulesWithinBudget(parsed.data.rules);
  return parsed.data;
}
