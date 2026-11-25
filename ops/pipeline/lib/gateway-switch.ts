// The first gateway deploy from Code (#1478 phase 2, "Gate"): the change set built from Code's CDK app must show NO RESOURCE CHANGE against the gateway stack Cloud last deployed.
// The template the change set holds and the live stack's template must be equal except for the Outputs, and the Outputs may differ only by dropping Cloud's DeployedCloudSha and
// adding DeployedCodeSha. The ImageDigest parameter is a stack parameter (a value, not template text), so a new digest changes no template text. Pure: two templates in, findings out.
import { canonicalJson } from "./hash.ts";

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const SHA40 = /^[0-9a-f]{40}$/u;

export const DROPPED_OUTPUTS: readonly string[] = ["DeployedCloudSha"];
export const ADDED_OUTPUT = "DeployedCodeSha";

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const list = (names: readonly string[]): string => `${names.slice(0, 8).join(", ")}${names.length > 8 ? `, and ${names.length - 8} more` : ""}`;

/** What differs between the two templates outside the Outputs, by name only (a bounded list); empty when they are equal. */
function nonOutputDifferences(live: Record<string, unknown>, next: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const section of new Set([...Object.keys(live), ...Object.keys(next)])) {
    if (section === "Outputs" || same(live[section], next[section])) continue;
    const a = live[section];
    const b = next[section];
    if (!isObject(a) || !isObject(b)) { found.push(`section ${section} differs`); continue; }
    const added = Object.keys(b).filter((key) => !(key in a));
    const removed = Object.keys(a).filter((key) => !(key in b));
    const changed = Object.keys(a).filter((key) => key in b && !same(a[key], b[key]));
    if (added.length > 0) found.push(`${section}: added ${list(added)}`);
    if (removed.length > 0) found.push(`${section}: removed ${list(removed)}`);
    if (changed.length > 0) found.push(`${section}: changed ${list(changed)}`);
  }
  return found;
}

export interface SwitchVerdict { failures: string[] }

/**
 * `codeSha` is the Code commit the run records: the new stack's DeployedCodeSha output must say exactly it. Returns the failures (empty = the change is outputs only: no resource, parameter,
 * condition, rule, mapping or metadata change).
 */
export function judgeGatewaySwitch(live: unknown, next: unknown, codeSha: string): SwitchVerdict {
  if (!isObject(live) || !isObject(next)) return { failures: ["a template is not a JSON object, so the gateway change cannot be compared with the live stack"] };
  const failures = nonOutputDifferences(live, next).map((line) => `the Code-made gateway template differs from the live stack's outside the Outputs (${line})`);
  const before = isObject(live.Outputs) ? live.Outputs : {};
  const after = isObject(next.Outputs) ? next.Outputs : {};
  const removed = Object.keys(before).filter((key) => !(key in after));
  const added = Object.keys(after).filter((key) => !(key in before));
  const changed = Object.keys(before).filter((key) => key in after && !same(before[key], after[key]));
  const strayRemoved = removed.filter((key) => !DROPPED_OUTPUTS.includes(key));
  if (strayRemoved.length > 0) failures.push(`the change drops the output(s) ${list(strayRemoved)}: only ${DROPPED_OUTPUTS.join(", ")} may go`);
  const strayAdded = added.filter((key) => key !== ADDED_OUTPUT);
  if (strayAdded.length > 0) failures.push(`the change adds the output(s) ${list(strayAdded)}: only ${ADDED_OUTPUT} may be new`);
  if (changed.length > 0) failures.push(`the change alters the output(s) ${list(changed)}`);
  const recorded = isObject(after[ADDED_OUTPUT]) ? after[ADDED_OUTPUT].Value : undefined;
  if (typeof recorded !== "string" || !SHA40.test(recorded)) failures.push(`the new template has no ${ADDED_OUTPUT} output with a 40-hex commit`);
  else if (recorded !== codeSha) failures.push(`${ADDED_OUTPUT} says ${recorded.slice(0, 12)}, not the Code commit ${codeSha.slice(0, 12)} the gateway is built from`);
  return { failures };
}
