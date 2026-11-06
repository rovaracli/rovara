// One-time operator values an upgrade sets on purpose, whatever the deployed value (owner decision for 0.5.9: decision cards on for existing installs too, an explicit 0 included).
// Each entry is keyed to the release that forces it: it applies only to an upgrade that CROSSES that release (from below it to it or past it). An upgrade that starts at or after the release never
// forces it again, so an operator who turns the switch off after the upgrade keeps it off on every later upgrade. Both `agentx upgrade` and `agentx upgrade --export` use this list.
import type { DeployPart } from "../deploy/parameters.js";
import { compareVersions } from "./target.js";

export const DECISION_CARDS_ON_LINE = "Decision cards are now on (decisionCards.enabled=1). To turn them off again: agentx config set decisionCards.enabled 0";

interface ForcedOperatorValue { release: string; part: DeployPart; parameter: string; value: string; line: string }

export const FORCED_OPERATOR_VALUES: readonly ForcedOperatorValue[] = [
  { release: "0.5.9", part: "control-plane", parameter: "DecisionCardsEnabled", value: "1", line: DECISION_CARDS_ON_LINE },
];

/** Whether an upgrade from `from` to `to` crosses `release`: from is below it and to is at or above it. */
export const crosses = (from: string, to: string, release: string): boolean => compareVersions(from, release) < 0 && compareVersions(to, release) >= 0;

/** The values this upgrade forces, per stack part. `list` is for tests. */
export function forcedOperatorValues(from: string, to: string, list: readonly ForcedOperatorValue[] = FORCED_OPERATOR_VALUES): Partial<Record<DeployPart, Record<string, string>>> {
  const forced: Partial<Record<DeployPart, Record<string, string>>> = {};
  for (const entry of list) if (crosses(from, to, entry.release)) forced[entry.part] = { ...forced[entry.part], [entry.parameter]: entry.value };
  return forced;
}

/** The lines this upgrade says: one for each forced value that changes what the stack holds now (a stack already at that value hears nothing). */
export function forcedValueLines(from: string, to: string, deployed: (part: DeployPart) => Record<string, string> | undefined, list: readonly ForcedOperatorValue[] = FORCED_OPERATOR_VALUES): string[] {
  return list.filter((entry) => crosses(from, to, entry.release) && deployed(entry.part)?.[entry.parameter] !== undefined && deployed(entry.part)?.[entry.parameter] !== entry.value).map((entry) => entry.line);
}
