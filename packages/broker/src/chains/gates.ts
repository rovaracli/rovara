// Plan 4 Task 8: gates. A chain gate is one of Plan 3's step approvals (`subject.kind === "chain_gate"`), made when the run enters the gate and decided only on Plan 3's
// confirmation page (R66: a browser session whose interactive sign-in is at most ten minutes old; a token, a task capability or a service token never decides). What
// this file adds to Plan 3's approvals is the three things that are specific to a gate:
//
//   - WHO MAY DECIDE (`gateEligible`, the approver rule `chain_gate`). Read live, at the moment someone decides, never from the people the approval was first listed for:
//     the caller is a member of the run's org now and holds `start_tasks` on the run's project now, and one of the gate's rules matches them (`starter`: the member who
//     started the run, never anyone when an event or a schedule did; `project_maintainers`; `chain_owner`; `members`). Being a candidate is not enough, and a gate that is
//     not the run's live, waiting gate on this very approval can't be decided at all.
//   - WHAT A DECISION DOES (`onChainGateDecided`, the subject's handler). It runs after Plan 3 has recorded the decision, for APPROVED, DECLINED and EXPIRED, from the
//     decision itself, from the approvals sweep and from the chain sweep; it is safe to run again and advances the run once. The attempt, the run and the event are one
//     transaction (`recordGateDecision`), conditional on the approval and the attempt's `seq`.
//   - OPENING (`openGateApproval`): the approval is created before the attempt that waits on it, under an id that is a function of the run and the attempt, so a second try
//     or one after a crash finds the same record.
//
// Nothing a step reports, a branch, an event or a trigger says can reach an approval record. Plan 4 makes no decide ticket and calls nothing that does (M12), and no event text carries a link
// to the confirmation page (the log is read by people who may not decide: review I-1); whoever decides finds it from their own approvals.
import { z } from "zod";
import { ChainRunIdSchema, GATE_DEFAULT_TIMEOUT_HOURS, agentXError, projectAllows, type ApproverRule, type OrgId } from "@agentx/contracts";
import { orgRoleOf } from "../agents/access.js";
import { safeDisplayName } from "../developer/person-name.js";
import {
  createStepApproval, registerApprovalSubjectHandler, registerApproverRefusal, registerApproverRule, shownText,
  type AnyApprovalRecord, type ApprovalCaller, type ApprovalDependencies, type ApproverRefusal, type StepApprovalRecord,
} from "../agents/approvals.js";
import { resolveMember, sameMember } from "../agents/lifecycle.js";
import { failedIndexes } from "../agents/table-writes.js";
import type { ChainRecord } from "./store.js";
import { readChainRun, readStepAttempt, recordGateDecision, recordGateExpiry, advanceChainRun, isTerminalStatus, type ChainRunRecord, type ChainRunnerDependencies, type StepAttemptRecord } from "./runner.js";
import { neutralText } from "./run-events.js";
import { answeredGateOrigin, answeredStepName, gateStepOf, type GateStep } from "./answered-gate.js";

/** The approver rule every chain gate's approval names. */
export const CHAIN_GATE_RULE = "chain_gate";

const HOUR_MS = 3_600_000;
const NAME_MAX = 80;
const WORDS_MAX = 200;
const FALLBACK_NAME = "a teammate";

const GateSubjectSchema = z.object({ kind: z.literal("chain_gate"), chainRunId: ChainRunIdSchema, seq: z.number().int().min(1) }).strict();

/** The part of the dependencies a gate's rule and words read: Plan 3's approvals, with the chain store they already carry. */
type Deps = ApprovalDependencies;

/** The run and the gate an approval is about, as they are stored now. */
interface Located { run: ChainRunRecord; attempt: StepAttemptRecord; gate: GateStep; seq: number; live: boolean }

/** The step approval's chain gate subject, or undefined when the record is anything else. */
function gateSubject(record: AnyApprovalRecord): { chainRunId: z.infer<typeof ChainRunIdSchema>; seq: number } | undefined {
  if (record.kind !== "step") return undefined;
  const subject = GateSubjectSchema.safeParse(record.subject);
  return subject.success ? subject.data : undefined;
}

/**
 * Reads the run, the attempt and the gate step an approval is about, all under the approval's own org. Undefined when any of them can't be read or does not belong to
 * this approval (the attempt waits on another approval, or the step is not a gate): fail closed. `live` is whether the gate is the run's current waiting gate.
 */
async function locate(deps: Deps, record: AnyApprovalRecord): Promise<Located | undefined> {
  const subject = gateSubject(record);
  if (subject === undefined || deps.chains === undefined) return undefined;
  const run = await readChainRun(deps, record.orgId, subject.chainRunId);
  if (run === undefined) return undefined;
  const attempt = await readStepAttempt(deps, record.orgId, subject.chainRunId, subject.seq);
  if (attempt === undefined || attempt.kind !== "gate" || attempt.approvalId !== record.approvalId) return undefined;
  const version = await deps.chains.getVersion(record.orgId, run.chainId, run.chainVersion);
  const gate = gateStepOf(version?.definition, attempt);
  if (gate === undefined) return undefined;
  return { run, attempt, gate, seq: subject.seq, live: !isTerminalStatus(run.status) && run.currentSeq === subject.seq && attempt.status === "waiting" };
}

// ---- who

/** The project's maintainers, as the members they are now. */
async function maintainersOf(deps: Deps, orgId: OrgId, project: string): Promise<string[]> {
  const found = new Set<string>();
  for (const member of await deps.projectMembers.list(orgId, project)) {
    if (member.role === "maintainer") found.add(await resolveMember(deps, orgId, member.developerId));
  }
  return [...found];
}

/**
 * Whether `rule` names the caller, who has `role` on the run's project (the caller already holds `start_tasks` there). `owner` is the chain's owner as the chain has it
 * now (R68), never the one the run copied when it started: a transfer takes the gate away from the old owner. A chain that is gone has no owner, so `chain_owner` names no one.
 */
async function ruleMatches(deps: Deps, rule: ApproverRule, run: ChainRunRecord, caller: ApprovalCaller, member: string, role: string, owner: ChainRecord["owner"] | undefined): Promise<boolean> {
  switch (rule.kind) {
    // The member who started the run. A run an event or a schedule started has no such person, so this matches no one, whoever asks.
    case "starter": return run.startedBy.kind === "member" && await sameMember(deps, run.orgId, run.startedBy.developerId, caller.developerId);
    case "project_maintainers": return role === "maintainer";
    case "chain_owner": {
      if (owner === undefined) return false;
      if (owner.kind === "member") return sameMember(deps, run.orgId, owner.developerId, caller.developerId);
      const ownerRole = await deps.projectMembers.roleOf(run.orgId, owner.project, { developerId: member, orgRole: caller.orgRole });
      return ownerRole === "maintainer";
    }
    case "members": {
      for (const id of rule.developerIds) {
        if (await sameMember(deps, run.orgId, id, caller.developerId)) return true;
      }
      return false;
    }
  }
}

/**
 * Whether `caller` may decide the gate `record` is about, read now: they are a member of the run's org with `start_tasks` on the run's project, and one of the gate's
 * rules matches them. A pending approval whose gate is not the run's live, waiting gate (the run ended, moved on, or it is an older attempt in a loop) can't be decided
 * by anyone; once it has been decided the rule still answers by who, so the people it concerned can read what became of it. The chain is read now too: a pending gate of
 * a chain that is gone can't be decided, and `chain_owner` is the chain's owner now, not the run's copy from when it started.
 */
export async function gateEligible(deps: Deps, record: AnyApprovalRecord, caller: ApprovalCaller): Promise<boolean> {
  if (record.kind !== "step" || caller.orgId !== record.orgId) return false;
  const found = await locate(deps, record);
  if (found === undefined || found.run.orgId !== caller.orgId) return false;
  if (record.status === "PENDING" && !found.live) return false;
  const chain = await deps.chains?.get(record.orgId, found.run.chainId);
  if (chain === undefined && record.status === "PENDING") return false;
  const orgRole = await orgRoleOf(deps, record.orgId, caller.developerId);
  if (orgRole === undefined) return false;
  const member = await resolveMember(deps, record.orgId, caller.developerId);
  const role = await deps.projectMembers.roleOf(record.orgId, found.run.project, { developerId: member, orgRole });
  if (role === undefined || !projectAllows(role, "start_tasks")) return false;
  for (const rule of found.gate.approvers) {
    if (await ruleMatches(deps, rule, found.run, { ...caller, orgRole }, member, role, chain?.owner)) return true;
  }
  return false;
}

// ---- words

/** What the words of a gate's rules need besides the rules: the project, the chain's name and the names of the people a `members` rule lists. */
export interface ApproverWordsContext { project: string; chainName: string; memberNames: ReadonlyMap<string, string> }

/**
 * Who a gate waits for, in words, from its rules: "the person who started this run", "a maintainer of <project>", "<chain>'s owner" and the names of the people listed,
 * joined with ", " and the last with " or ". The same person or phrase is said once.
 */
export function approverWords(rules: readonly ApproverRule[], context: ApproverWordsContext): string {
  const parts: string[] = [];
  for (const rule of rules) {
    if (rule.kind === "starter") parts.push("the person who started this run");
    else if (rule.kind === "project_maintainers") parts.push(`a maintainer of ${context.project}`);
    else if (rule.kind === "chain_owner") parts.push(`${context.chainName}'s owner`);
    else for (const id of rule.developerIds) parts.push(context.memberNames.get(id) ?? FALLBACK_NAME);
  }
  const unique = [...new Set(parts)];
  if (unique.length <= 1) return unique.join("");
  return `${unique.slice(0, -1).join(", ")} or ${unique.at(-1)!}`;
}

/** A person's name as the sign-in store holds it, made safe to show; a missing or unreadable record is a teammate. */
export async function displayNameOf(deps: Deps, developerId: string): Promise<string> {
  try {
    const record = await deps.signInStore.getDeveloper(developerId) as { displayName?: unknown } | undefined;
    const name = typeof record?.displayName === "string" ? shownText(safeDisplayName(record.displayName, developerId), NAME_MAX) : "";
    return name === "" ? FALLBACK_NAME : name;
  } catch {
    return FALLBACK_NAME;
  }
}

export async function wordsFor(deps: Deps, run: Pick<ChainRunRecord, "project" | "chainName">, gate: GateStep): Promise<string> {
  const memberNames = new Map<string, string>();
  for (const rule of gate.approvers) {
    if (rule.kind === "members") for (const id of rule.developerIds) memberNames.set(id, await displayNameOf(deps, id));
  }
  return neutralText(approverWords(gate.approvers, { project: run.project, chainName: shownText(run.chainName, NAME_MAX), memberNames }), WORDS_MAX);
}

registerApproverRefusal(CHAIN_GATE_RULE, async (deps, record): Promise<ApproverRefusal | undefined> => {
  const found = await locate(deps, record);
  if (found === undefined) return undefined;
  const name = shownText(found.attempt.stepName, NAME_MAX);
  const who = await wordsFor(deps, found.run, found.gate);
  if (record.status === "PENDING" && !found.live) {
    // A closed gate is answered with a closed code, so a client says "closed" and not "you are not allowed".
    return isTerminalStatus(found.run.status)
      ? { who, text: `This run has ended, so "${name}" can't be approved.`, code: "CHAIN_RUN_CLOSED" }
      : { who, text: `"${name}" is not waiting for approval any more.`, code: "APPROVAL_CLOSED" };
  }
  return { who, text: `Only ${who} can approve "${name}".` };
});

// ---- opening

/** A gate's approval, as made, and the words the run's `gate_waiting` event says. */
export interface OpenedGate { record: StepApprovalRecord; waitingText: string }

/** Every person the gate's rules name now: the starter, the project's maintainers, the chain's owner, the people listed. They only decide who sees the gate listed. */
async function candidatesOf(deps: Deps, run: ChainRunRecord, gate: GateStep): Promise<string[]> {
  const people = new Set<string>();
  const owner = gate.approvers.some((rule) => rule.kind === "chain_owner") ? (await deps.chains?.get(run.orgId, run.chainId))?.owner : undefined;
  const add = async (developerId: string) => { people.add(await resolveMember(deps, run.orgId, developerId)); };
  for (const rule of gate.approvers) {
    if (rule.kind === "starter") {
      if (run.startedBy.kind === "member") await add(run.startedBy.developerId);
    } else if (rule.kind === "project_maintainers") {
      for (const id of await maintainersOf(deps, run.orgId, run.project)) await add(id);
    } else if (rule.kind === "chain_owner") {
      // The owner as the chain has it now; a chain that is gone lists no one.
      if (owner?.kind === "member") await add(owner.developerId);
      else if (owner !== undefined) for (const id of await maintainersOf(deps, run.orgId, owner.project)) await add(id);
    } else {
      for (const id of rule.developerIds) await add(id);
    }
  }
  return [...people];
}

/**
 * Makes the gate's approval for the attempt `seq` of `run` (or finds the one an earlier try made): the gate's prompt, the people its rules name now, and its own time to
 * decide. The id is a function of the run and `seq`, so asking again changes nothing. The attempt that waits on it is written by the caller, in the transaction that moves the run.
 */
export async function openGateApproval(deps: Deps, run: ChainRunRecord, gate: GateStep, seq: number): Promise<OpenedGate> {
  const hours = gate.timeoutHours ?? GATE_DEFAULT_TIMEOUT_HOURS;
  const record = await createStepApproval(deps, {
    orgId: run.orgId, subject: { kind: "chain_gate", chainRunId: run.runId, seq }, prompt: gate.prompt,
    approvers: { kind: "rule", rule: CHAIN_GATE_RULE, candidates: await candidatesOf(deps, run, gate) },
    expiresAt: new Date(deps.now() + hours * HOUR_MS).toISOString(),
    project: run.project, owner: { developerId: run.owner.developerId, name: await displayNameOf(deps, run.owner.developerId) },
  });
  const origin = answeredGateOrigin(gate.id);
  const waitingText = origin === undefined ? `Waiting for ${await wordsFor(deps, run, gate)} to approve "${shownText(gate.name, NAME_MAX)}".`
    : `Waiting for ${await wordsFor(deps, run, gate)} to continue or stop: "${shownText(answeredStepName(gate.name), NAME_MAX)}" answered instead of changing code.`;
  return { record, waitingText };
}

// ---- what a decision does

/** Where the handler finds the chain runner's dependencies when the approvals' own dependencies have none (the broker sets it at start). */
let runnerProvider: ((deps: Deps) => ChainRunnerDependencies | undefined) | undefined;

function runnerOf(deps: Deps): ChainRunnerDependencies {
  const candidate = deps as Partial<ChainRunnerDependencies>;
  const found = runnerProvider?.(deps) ?? (candidate.chains !== undefined && candidate.chainRuns !== undefined ? candidate as ChainRunnerDependencies : undefined);
  if (found === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "chain runs are not set up in this deployment");
  return found;
}

/**
 * Tells a gate how its approval ended (the subject's handler of `chain_gate`, also called by the approvals sweep and the chain sweep). APPROVED and DECLINED pass the
 * gate, once, by its `onApprove` or `onReject` edge; EXPIRED ends the run `timed_out`. A run that has ended, a gate that is not the run's current one or is not waiting on
 * this approval, and any other status change nothing. Told again for the same record it changes nothing, but it still moves the run on, so a crash between the decision's
 * write and the next step's start is finished by the next telling.
 */
export async function onChainGateDecided(deps: Deps, record: AnyApprovalRecord): Promise<void> {
  const subject = gateSubject(record);
  if (subject === undefined) return;
  const runner = runnerOf(deps);
  if (record.status === "EXPIRED") {
    await recordGateExpiry(runner, record.orgId, subject.chainRunId, subject.seq, record.approvalId);
    return;
  }
  if (record.status !== "APPROVED" && record.status !== "DECLINED") return;
  const name = record.decidedBy === undefined ? FALLBACK_NAME : await displayNameOf(deps, record.decidedBy);
  for (let round = 0; round < 3; round += 1) {
    try {
      await recordGateDecision(runner, record.orgId, subject.chainRunId, subject.seq, record.status === "APPROVED" ? "approved" : "declined", { approvalId: record.approvalId, name });
      break;
    } catch (error) {
      // The run moved while the decision was written (another writer got in first): read it again. Anything else is the sweep's to retry.
      if (!isLostRace(error) || round === 2) throw error;
    }
  }
  await advanceChainRun(runner, record.orgId, subject.chainRunId);
}

const isLostRace = (error: unknown): boolean => failedIndexes(error) !== undefined;

/**
 * What the broker registers at start (H4): the gate's approver rule and its words, and its subject's handler. Safe to call more than once; `provider` is where the handler
 * finds the runner's dependencies when the approvals' own have none. Returns what takes the provider off again.
 */
export function registerChainGates(provider?: (deps: Deps) => ChainRunnerDependencies | undefined): () => void {
  registerApproverRule(CHAIN_GATE_RULE, gateEligible);
  registerApprovalSubjectHandler("chain_gate", onChainGateDecided);
  if (provider !== undefined) runnerProvider = provider;
  return () => {
    if (provider !== undefined && runnerProvider === provider) runnerProvider = undefined;
  };
}

// The rule and the handler exist as soon as the code is loaded, so a gate can be opened wherever the runner runs (a gate made while nothing could decide it would wait for nothing).
registerChainGates();
