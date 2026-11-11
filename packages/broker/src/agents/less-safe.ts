// Which changes to a recipe make an agent less safe, and so wait for a person on the confirmation page instead of applying at once
// (human decision 2026-10-20, R9-1, R9-2, R69). Every route that changes which recipe an agent runs (publish, rollback, adopting a
// built-in's version) compares the recipe that would run with the one that runs now. The check is deliberately blunt: a change to a
// pattern or a selector is reported without deciding whether it narrows (R9-2), because a wrong "safe" is worse than one more click.
import { EMPTY_RECIPE, STEP_TOOLS, type ResolvedRecipe, type ResolvedStep, type ToolGrant } from "@rovara-code/contracts";

const AUTONOMY_ORDER = ["suggest", "prepare", "run"] as const;

type AgentStep = Extract<ResolvedStep, { kind: "agent" }>;
type ReviewStep = Extract<ResolvedStep, { kind: "review" }>;

const connectorLabel = (connector: ToolGrant["connector"]): string => ("name" in connector ? `the "${connector.name}" connector` : `every ${connector.type} connector`);
const connectorKey = (connector: ToolGrant["connector"]): string => ("name" in connector ? `name:${connector.name}` : `type:${connector.type}`);
const accessLabel = (access: ToolGrant["access"]): string => (access === "read_write" ? "read and write" : "read");
const stepTools = (step: ResolvedStep): readonly string[] | undefined => (step.settings as { tools?: string[] }).tools;
const isApproval = (step: ResolvedStep): boolean => step.kind === "approval";
const isAgentStep = (step: ResolvedStep): step is AgentStep => step.kind === "agent";
const isReviewStep = (step: ResolvedStep): step is ReviewStep => step.kind === "review";

/** Whether `next` allows a pattern `current` did not (patterns are compared as written, never as globs). */
const addsPattern = (current: readonly string[], next: readonly string[]): boolean => next.some((pattern) => !current.includes(pattern));

/** How many steps that are not approvals run before the step at `index`: how much happens before a gate. */
const workBefore = (steps: readonly ResolvedStep[], index: number): number => steps.slice(0, index).filter((step) => !isApproval(step)).length;

function gateChanges(current: ResolvedRecipe, next: ResolvedRecipe, found: string[]): void {
  current.steps.forEach((step, index) => {
    const at = next.steps.findIndex((candidate) => candidate.id === step.id && candidate.kind === step.kind);
    if (isApproval(step)) {
      if (at < 0) found.push(`Removes the approval step "${step.name}"`);
      else if (workBefore(next.steps, at) > workBefore(current.steps, index)) found.push(`Moves the approval step "${step.name}" later, so more happens before it`);
    } else if (isReviewStep(step)) {
      const after = next.steps[at];
      if (at < 0 || after === undefined || !isReviewStep(after)) {
        found.push(`Removes the review step "${step.name}"`);
        return;
      }
      if (step.reviewers.some((reviewer) => !after.reviewers.includes(reviewer))) found.push(`Gives the review step "${step.name}" fewer reviewers`);
      if (step.onFindings !== undefined && after.onFindings === undefined) found.push(`Stops the review step "${step.name}" sending findings back`);
      else if (step.onFindings !== undefined && after.onFindings !== undefined && after.onFindings.maxRounds < step.onFindings.maxRounds) {
        found.push(`Lowers how many times the review step "${step.name}" sends findings back, from ${String(step.onFindings.maxRounds)} to ${String(after.onFindings.maxRounds)}`);
      }
    }
  });
}

function grantChanges(current: ResolvedRecipe, next: ResolvedRecipe, found: string[]): void {
  for (const grant of next.tools) {
    const before = current.tools.filter((candidate) => connectorKey(candidate.connector) === connectorKey(grant.connector));
    const label = connectorLabel(grant.connector);
    if (before.length === 0) {
      found.push(`Gives the agent access to ${label} (${accessLabel(grant.access)})`);
      continue;
    }
    if (grant.access === "read_write" && before.every((candidate) => candidate.access === "read")) found.push(`Lets the agent change things in ${label} (read and write)`);
    // What the connector could be used for before: everything if any grant of it was not limited to named tools.
    const limited = before.every((candidate) => candidate.tools !== undefined);
    if (limited && grant.tools === undefined) found.push(`Removes the tool limit on ${label}`);
    else if (limited && grant.tools !== undefined && addsPattern(before.flatMap((candidate) => candidate.tools ?? []), grant.tools)) found.push(`Allows more tools on ${label}`);
  }
}

/** What a step can use: its limit, or the most its kind may have (an agent step has Pi tools only with a workspace). */
function effectiveTools(step: ResolvedStep): readonly string[] {
  const limit = stepTools(step);
  if (limit !== undefined) return limit;
  if (step.kind === "agent") return step.workspace === "read" ? STEP_TOOLS.agent : [];
  return (STEP_TOOLS as Record<string, readonly string[]>)[step.kind] ?? [];
}

/**
 * A step under an id the recipe did not have is judged against what it can stand in for, so renaming a step is no way round its limit.
 * Against the steps of its kind that left (ids missing from `next`): when every one of them was limited, it must be limited and fit
 * inside one of their limits (so splitting a step is fine and merging two with different limits is not). With none gone, it is added
 * beside the others: when every one of them was limited it may not be unlimited or wider than them together. A kind the recipe had no
 * step of can use no more than the steps before it could.
 */
function newStepChanges(current: ResolvedRecipe, next: ResolvedRecipe, step: ResolvedStep, found: string[]): void {
  const limit = stepTools(step);
  const unlimited = `Adds the step "${step.name}" without the tool limit the other steps have`;
  const wider = `Allows more tools in the step "${step.name}"`;
  const peers = current.steps.filter((candidate) => candidate.kind === step.kind);
  if (peers.length === 0) {
    const before = new Set(current.steps.flatMap((candidate) => effectiveTools(candidate)));
    if (current.steps.length > 0 && effectiveTools(step).some((tool) => !before.has(tool))) found.push(`Adds the step "${step.name}", which can use more tools than any step before it`);
    return;
  }
  const left = peers.filter((peer) => !next.steps.some((candidate) => candidate.id === peer.id && candidate.kind === peer.kind));
  const compared = left.length > 0 ? left : peers;
  if (!compared.every((peer) => stepTools(peer) !== undefined)) return;
  if (limit === undefined) found.push(unlimited);
  else if (left.length > 0 ? !left.some((peer) => !addsPattern(stepTools(peer) ?? [], limit)) : addsPattern(peers.flatMap((peer) => stepTools(peer) ?? []), limit)) found.push(wider);
}

function stepChanges(current: ResolvedRecipe, next: ResolvedRecipe, found: string[]): void {
  for (const step of next.steps) {
    const before = current.steps.find((candidate) => candidate.id === step.id && candidate.kind === step.kind);
    if (isAgentStep(step) && step.workspace === "read" && !(before !== undefined && isAgentStep(before) && before.workspace === "read")) {
      found.push(`Gives the step "${step.name}" read access to the project's files`);
    }
    if (before === undefined) {
      newStepChanges(current, next, step, found);
      continue;
    }
    const tools = stepTools(step);
    const was = stepTools(before);
    if (was !== undefined && tools === undefined) found.push(`Removes the tool limit on the step "${step.name}"`);
    else if (was !== undefined && tools !== undefined && addsPattern(was, tools)) found.push(`Allows more tools in the step "${step.name}"`);
  }
}

/**
 * What `next` does that `current` (the recipe that runs now) does not make as safe, in words a person can read. `current` is the
 * published version, or for a first publish the base the agent builds on; without either it is the empty recipe. An empty list means
 * the change may apply at once. A change is less safe when it:
 * - removes an approval step, moves one later, removes a review step, gives it fewer reviewers or fewer rounds of findings;
 * - removes an always-ask pattern, or changes one in any way;
 * - adds a tool grant (so also a selector that covers more connectors), widens one to read and write, or drops or widens a
 *   tool limit on a grant or on a step;
 * - raises autonomy, turns on @-mentions, or turns on a trigger other than a person starting it;
 * - gives an agent step access to the project's files.
 */
export function lessSafeChanges(current: ResolvedRecipe | undefined, next: ResolvedRecipe): string[] {
  const before = current ?? EMPTY_RECIPE;
  const found: string[] = [];
  gateChanges(before, next, found);
  for (const pattern of before.approvals.alwaysAsk) {
    if (!next.approvals.alwaysAsk.includes(pattern)) found.push(`Removes or changes the always-ask rule "${pattern}"`);
  }
  grantChanges(before, next, found);
  stepChanges(before, next, found);
  if (AUTONOMY_ORDER.indexOf(next.autonomy) > AUTONOMY_ORDER.indexOf(before.autonomy)) found.push(`Raises the agent's autonomy from ${before.autonomy} to ${next.autonomy}`);
  if (next.allowMentions && !before.allowMentions) found.push("Lets the agent @-mention people in its comments");
  const kindsBefore = new Set<string>(before.triggers.map((trigger) => trigger.kind));
  for (const kind of new Set<string>(next.triggers.map((trigger) => trigger.kind))) {
    if (kind !== "person" && !kindsBefore.has(kind)) found.push(`Lets the agent be started by ${kind} triggers`);
  }
  return [...new Set(found)];
}
