// What makes a new version of a chain less safe than the one that runs (Plan 4 Task 4, human decision N6). A publish or a rollback that does any
// of this waits for a person on the confirmation page; anything else applies at once. Pure but for two questions only the org can answer, which the
// caller supplies: an agent's name, and what a newer version of the same agent adds (Plan 3's `lessSafeChanges` over the two recipes).
import { GATE_DEFAULT_TIMEOUT_HOURS, STEP_DEFAULT_TIMEOUT_MINUTES, type ApproverRule, type PinnedChainDefinition } from "@rovara-code/contracts";

export interface ChainLessSafeLookups {
  /** The name people know an agent by (a built-in's name, or a custom agent's). */
  agentName(agentId: string): Promise<string> | string;
  /** What version `to` of an agent gives that version `from` did not (Plan 3's less-safe findings over their recipes); nothing when it only edits instructions. */
  repinFindings(agentId: string, from: number, to: number): Promise<string[]> | string[];
}

type Step = PinnedChainDefinition["steps"][number];
type Gate = Extract<Step, { kind: "gate" }>;
type AgentStep = Extract<Step, { kind: "agent" }>;
/** A design as far as its edges go: published or draft (the pinned version of an agent does not matter here). */
interface Graph { start: string; steps: ReadonlyArray<Gate | { kind: "agent"; id: string; next: AgentStep["next"] }> }

interface Edge { step: string; slot: string; to: string; bound: number | undefined }

/** Every edge of a design, with where it is written (`next`, a branch choice by id, or a gate's two edges) and its bound. */
function edgesOf(def: Graph): Edge[] {
  return def.steps.flatMap((step): Edge[] => {
    if (step.kind === "gate") {
      return [
        { step: step.id, slot: "onApprove", to: step.onApprove.to, bound: step.onApprove.maxTraversals },
        { step: step.id, slot: "onReject", to: step.onReject.to, bound: step.onReject.maxTraversals },
      ];
    }
    if (step.next.kind === "go") return [{ step: step.id, slot: "next", to: step.next.to, bound: step.next.maxTraversals }];
    if (step.next.kind === "branch") return step.next.choices.map((choice) => ({ step: step.id, slot: `choice:${choice.id}`, to: choice.to, bound: choice.maxTraversals }));
    return [];
  });
}

/** The ids reachable from `from` along the edges, never using the edge `blocked` (a gate's approval, say); `from` itself always counts. */
function reachableFrom(edges: readonly Edge[], from: string, blocked?: { step: string; slot: string }): Set<string> {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of edges) {
      if (edge.step !== id || edge.to === "$end") continue;
      if (blocked !== undefined && edge.step === blocked.step && edge.slot === blocked.slot) continue;
      queue.push(edge.to);
    }
  }
  return seen;
}

/**
 * The gates that guard `stepId`: a gate guards a step when the step cannot be reached from the start once the gate's approval edge (`onApprove`) is
 * taken away. Its rejection edge stays, because a rejection is not an approval: a step a rejection leads to is not behind the gate. In the order of
 * the design; a gate is not behind itself, and a step nothing reaches has none.
 */
export function gatesOnEveryPath(def: Graph, stepId: string): string[] {
  const edges = edgesOf(def);
  if (!reachableFrom(edges, def.start).has(stepId)) return [];
  return def.steps
    .filter((step): step is Gate => step.kind === "gate" && step.id !== stepId)
    .filter((gate) => !reachableFrom(edges, def.start, { step: gate.id, slot: "onApprove" }).has(stepId))
    .map((gate) => gate.id);
}

const WHO: Record<ApproverRule["kind"], string> = {
  starter: "the person who started the run",
  project_maintainers: "project maintainers",
  chain_owner: "the chain's owner",
  members: "named people",
};

const memberIds = (gate: Gate): Set<string> => new Set(gate.approvers.flatMap((rule) => (rule.kind === "members" ? rule.developerIds : [])));

function gateChanges(before: PinnedChainDefinition, after: PinnedChainDefinition): string[] {
  const changes: string[] = [];
  const nowGates = new Map(after.steps.flatMap((step) => (step.kind === "gate" ? [[step.id, step] as const] : [])));
  for (const step of before.steps) if (step.kind === "gate" && !nowGates.has(step.id)) changes.push(`removes the gate "${step.id}"`);
  for (const gate of nowGates.values()) {
    const was = before.steps.find((step): step is Gate => step.kind === "gate" && step.id === gate.id);
    if (was === undefined) continue;
    const wait = gate.timeoutHours ?? GATE_DEFAULT_TIMEOUT_HOURS;
    if (wait > (was.timeoutHours ?? GATE_DEFAULT_TIMEOUT_HOURS)) changes.push(`${gate.id} may now wait ${String(wait)} hours`);
    if (was.onReject.to === "$end" && gate.onReject.to !== "$end") changes.push(`a rejection at ${gate.id} now carries on to ${gate.onReject.to}`);
    const kindsBefore = new Set(was.approvers.map((rule) => rule.kind));
    for (const kind of new Set(gate.approvers.map((rule) => rule.kind))) {
      if (!kindsBefore.has(kind)) changes.push(`${gate.id} can now be decided by ${WHO[kind]}`);
      else if (kind === "members") {
        const known = memberIds(was);
        if ([...memberIds(gate)].some((id) => !known.has(id))) changes.push(`${gate.id} can now be decided by more named people`);
      }
    }
  }
  return changes;
}

function limitChanges(before: PinnedChainDefinition, after: PinnedChainDefinition): string[] {
  const changes: string[] = [];
  const usd = { was: before.limits?.maxRunUsd, now: after.limits?.maxRunUsd };
  if (usd.was !== undefined) {
    if (usd.now === undefined) changes.push(`removes the limit on what one run may cost (it was $${String(usd.was)})`);
    else if (usd.now > usd.was) changes.push(`raises the most one run may cost, from $${String(usd.was)} to $${String(usd.now)}`);
  }
  const hours = { was: before.limits?.maxRunHours, now: after.limits?.maxRunHours };
  if (hours.was !== undefined) {
    if (hours.now === undefined) changes.push(`removes the limit on how long one run may take (it was ${String(hours.was)} hours)`);
    else if (hours.now > hours.was) changes.push(`raises the longest one run may take, from ${String(hours.was)} to ${String(hours.now)} hours`);
  }
  return changes;
}

/** Whether the edge `from` to `to` lies on a loop: `to` leads back to `from`. */
const onLoop = (edges: readonly Edge[], edge: Edge): boolean => edge.to !== "$end" && reachableFrom(edges, edge.to).has(edge.step);

function edgeChanges(before: PinnedChainDefinition, after: PinnedChainDefinition): string[] {
  const changes: string[] = [];
  const edgesBefore = edgesOf(before);
  const edgesAfter = edgesOf(after);
  for (const edge of edgesAfter) {
    if (edge.to === "$end") continue;
    const was = edgesBefore.find((candidate) => candidate.step === edge.step && candidate.slot === edge.slot);
    if (was !== undefined && was.bound !== undefined) {
      if (edge.bound === undefined) changes.push(`${edge.step} may now go back to ${edge.to} with no limit`);
      else if (edge.bound > was.bound) changes.push(`${edge.step} may now go back to ${edge.to} up to ${String(edge.bound)} times, up from ${String(was.bound)}`);
    } else if (edge.bound !== undefined && onLoop(edgesAfter, edge) && (was === undefined || !onLoop(edgesBefore, was))) {
      changes.push(`${edge.step} can now go back to ${edge.to}, up to ${String(edge.bound)} times`);
    }
  }
  return changes;
}

function skipChanges(before: PinnedChainDefinition, after: PinnedChainDefinition): string[] {
  const changes: string[] = [];
  const gatesNow = new Set(after.steps.flatMap((step) => (step.kind === "gate" ? [step.id] : [])));
  for (const step of after.steps) {
    if (step.kind !== "agent" || !before.steps.some((candidate) => candidate.kind === "agent" && candidate.id === step.id)) continue;
    const passed = new Set(gatesOnEveryPath(after, step.id));
    for (const gate of gatesOnEveryPath(before, step.id)) {
      // A gate that is gone is reported as removed; this is for a gate that is still there and can now be gone around.
      if (gatesNow.has(gate) && !passed.has(gate)) changes.push(`${step.id} can now be reached without passing "${gate}"`);
    }
  }
  return changes;
}

async function stepChanges(before: PinnedChainDefinition, after: PinnedChainDefinition, lookups: ChainLessSafeLookups): Promise<string[]> {
  const changes: string[] = [];
  for (const step of after.steps) {
    if (step.kind !== "agent") continue;
    const was = before.steps.find((candidate): candidate is AgentStep => candidate.kind === "agent" && candidate.id === step.id);
    if (was === undefined) {
      changes.push(`adds step ${step.id} (${await lookups.agentName(step.agent.agentId)} version ${String(step.agent.version)})`);
      continue;
    }
    if (was.agent.agentId !== step.agent.agentId) {
      changes.push(`${step.id} now uses ${await lookups.agentName(step.agent.agentId)} version ${String(step.agent.version)} instead of ${await lookups.agentName(was.agent.agentId)} version ${String(was.agent.version)}`);
    } else if (was.agent.version !== step.agent.version) {
      const findings = await lookups.repinFindings(step.agent.agentId, was.agent.version, step.agent.version);
      if (findings.length > 0) {
        const name = await lookups.agentName(step.agent.agentId);
        changes.push(`${step.id} now uses ${name} version ${String(step.agent.version)} instead of ${name} version ${String(was.agent.version)}`, ...findings.map((finding) => `${step.id}: ${finding}`));
      }
    }
    const retries = step.retries ?? 0;
    if (retries > (was.retries ?? 0)) changes.push(`${step.id} may now retry ${String(retries)} times`);
    const minutes = step.timeoutMinutes ?? STEP_DEFAULT_TIMEOUT_MINUTES;
    if (minutes > (was.timeoutMinutes ?? STEP_DEFAULT_TIMEOUT_MINUTES)) changes.push(`${step.id} may now run ${String(minutes)} minutes`);
    if (step.handoff === "all" && was.handoff !== "all") changes.push(`${step.id} now receives every earlier report`);
  }
  return changes;
}

/**
 * What `next` makes less safe than `current`, the version that runs now, in words (empty: nothing, so it applies at once; a first publish, with no
 * `current`, has nothing to compare). Anything that removes or weakens a gate, widens who decides one, raises a limit, a repeat bound, a retry or a
 * timeout, lets a step be reached around a gate, adds a step, changes an agent or widens what a step is told is less safe. Editing instructions,
 * lowering a limit and narrowing approvers are not.
 */
export async function chainLessSafeChanges(current: PinnedChainDefinition | undefined, next: PinnedChainDefinition, lookups: ChainLessSafeLookups): Promise<string[]> {
  if (current === undefined) return [];
  return [
    ...gateChanges(current, next),
    ...limitChanges(current, next),
    ...edgeChanges(current, next),
    ...skipChanges(current, next),
    ...await stepChanges(current, next, lookups),
  ];
}
