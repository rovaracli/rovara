// Plan 4 Task 10: the seams Plan 5's sessions read a chain run through. Plan 5 keeps a chain session's summary, who may read it and its body behind three interfaces
// (`ChainSessionSource`, `chainReadAccess` and `ChainSessionReads`, in its `agent-sessions/summary.ts` and `access.ts`); this file is Plan 4's side of each, declared
// structurally so the two plans meet without either importing the other:
//   - `chainSessionSource(deps)`: the facts of a run for the session's summary (`read`), and which session a record of the stream is about (`targetOf`). Every fact
//     carries the `orgId` of the run's own record: Plan 5 compares it with the session's and ignores facts of another org.
//   - `chainReadAccessFor(deps)`: whether a caller reads a chain session, by this plan's rule (the starter, the run's owner, `view` on the chain and the project, org
//     owners and admins).
//   - `chainSessionReads(deps, orgId)`: the body of a chain session (`runView`) and a step's task (`stepTask`), read as the internal session actor after Plan 5's own level
//     check. Plan 5's actor names a developer and no org, so the reads are bound to one: the broker makes one for the org of the request.
import { ChainRunIdSchema, OrgIdSchema, type ChainRunStatus, type DeveloperTaskView, type OrgId } from "@agentx/contracts";
import { orgRoleOf } from "../agents/access.js";
import { shownText } from "../agents/approvals.js";
import { approverWords, displayNameOf } from "./gates.js";
import { readChainRun, readStepAttempt, type ChainRunRecord, type StepAttemptRecord } from "./runner.js";
import type { ChainRouteDependencies } from "./routes.js";
import { chainRunView, chainStepTask, mayReadRun, type ChainSessionActor } from "./view.js";

type Deps = ChainRouteDependencies;
type Item = Record<string, unknown>;

/** What a session's summary needs of a chain run. `gate` is a run waiting at a gate; the other statuses are the run's own. */
export interface ChainSessionFacts {
  orgId: OrgId;
  status: "running" | "gate" | "paused" | "succeeded" | "failed" | "timed_out" | "cancelled";
  /** The current section's name. */
  stepName?: string;
  /** What the run's finished steps cost. */
  spentUsd: number;
  /** The running step's task, whose own spend is added; or a stopped run's, until its spend has been added to the run. */
  stepTaskId?: string;
  /** Who a waiting gate waits for. */
  needsPeople?: string[];
  endedAt?: string;
}

export interface ChainSessionSource {
  read(orgId: OrgId, chainRunId: string): Promise<ChainSessionFacts | undefined>;
  targetOf(record: Item): { orgId: OrgId; sessionId: string } | undefined;
}

const NAME_MAX = 80;
const LIVE_ATTEMPT: ReadonlySet<string> = new Set(["starting", "running", "paused"]);
const RECORD_PK = /^ORG#(org_[0-9a-z]{20})#CHAIN_RUN#(crn_[0-9a-z]{20})$/;

const statusOf = (status: ChainRunStatus): ChainSessionFacts["status"] => (status === "waiting" ? "gate" : status);

/** Who a waiting gate waits for, one phrase per rule: the starter by name, the project's maintainers, the chain's owner and each person listed. */
async function needsPeopleOf(deps: Deps, run: ChainRunRecord, attempt: StepAttemptRecord): Promise<string[] | undefined> {
  const definition = (await deps.chains?.getVersion(run.orgId, run.chainId, run.chainVersion).catch(() => undefined))?.definition;
  const step = definition?.steps.find((candidate) => candidate.id === attempt.stepId);
  if (step === undefined || step.kind !== "gate") return undefined;
  const people: string[] = [];
  for (const rule of step.approvers) {
    const memberNames = new Map<string, string>();
    if (rule.kind === "members") for (const id of rule.developerIds) memberNames.set(id, await displayNameOf(deps, id));
    const phrase = rule.kind === "starter" && run.startedBy.kind === "member"
      ? await displayNameOf(deps, run.startedBy.developerId)
      : approverWords([rule], { project: run.project, chainName: shownText(run.chainName, NAME_MAX), memberNames });
    for (const person of rule.kind === "members" ? [...memberNames.values()] : [phrase]) if (person !== "" && !people.includes(person)) people.push(person);
  }
  return people.length === 0 ? undefined : people;
}

/** Plan 4's `ChainSessionSource`. */
export function chainSessionSource(deps: Deps): ChainSessionSource {
  return {
    read: async (orgId, chainRunId) => {
      const org = OrgIdSchema.safeParse(orgId);
      const id = ChainRunIdSchema.safeParse(chainRunId);
      if (!org.success || !id.success) return undefined;
      const run = await readChainRun(deps, org.data, id.data);
      if (run === undefined) return undefined;
      const attempt = await readStepAttempt(deps, run.orgId, run.runId, run.currentSeq);
      const over = run.status === "succeeded" || run.status === "failed" || run.status === "cancelled" || run.status === "timed_out";
      const owesSpend = attempt?.taskId !== undefined && attempt.kind === "agent" && (attempt.spendPending === true || (!over && LIVE_ATTEMPT.has(attempt.status)));
      const needsPeople = run.status === "waiting" && attempt?.kind === "gate" ? await needsPeopleOf(deps, run, attempt) : undefined;
      return {
        orgId: run.orgId,
        status: statusOf(run.status),
        ...(attempt === undefined ? {} : { stepName: shownText(attempt.stepName, NAME_MAX) }),
        spentUsd: run.spentUsd,
        ...(owesSpend ? { stepTaskId: attempt.taskId! } : {}),
        ...(needsPeople === undefined ? {} : { needsPeople }),
        ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
      };
    },
    // A run's META and its attempts move the summary; its events are written in the same transactions as the META, so they add nothing.
    targetOf: (record) => {
      const pk = record["pk"];
      const sk = record["sk"];
      if (typeof pk !== "string" || typeof sk !== "string" || (sk !== "META" && !sk.startsWith("STEP#"))) return undefined;
      const parts = RECORD_PK.exec(pk);
      return parts === null || record["orgId"] !== parts[1] ? undefined : { orgId: parts[1] as OrgId, sessionId: parts[2]! };
    },
  };
}

/** Plan 4's `chainReadAccess`: whether `caller` reads the chain run a chain session is about. Their org role is read now. Anything that is not a chain run reads as no. */
export function chainReadAccessFor(deps: Deps): (caller: { orgId: OrgId; developerId: string }, session: { subject: { kind: string; chainRunId?: string } }) => Promise<boolean> {
  return async (caller, session) => {
    const id = session.subject.kind === "chain" ? ChainRunIdSchema.safeParse(session.subject.chainRunId) : undefined;
    if (id === undefined || !id.success) return false;
    const run = await readChainRun(deps, caller.orgId, id.data);
    if (run === undefined) return false;
    const orgRole = await orgRoleOf(deps, caller.orgId, caller.developerId);
    return orgRole !== undefined && mayReadRun(deps, { orgId: caller.orgId, developerId: caller.developerId, orgRole }, run);
  };
}

/** Plan 4's `ChainSessionReads`, for one org: the two reads Plan 5's session view and its step-task route make as the session actor. */
export interface ChainSessionReads {
  runView(actor: ChainSessionActor, runId: string): Promise<unknown>;
  stepTask(actor: ChainSessionActor, runId: string, seq: number): Promise<DeveloperTaskView>;
}

export function chainSessionReads(deps: Deps, orgId: OrgId): ChainSessionReads {
  // The role in this caller is a placeholder: with an actor the reads take the person's org role from the table.
  const callerOf = (actor: ChainSessionActor) => ({ orgId, developerId: actor.developerId, orgRole: "member" as const });
  return {
    runView: (actor, runId) => chainRunView(deps, callerOf(actor), runId, { actor }),
    stepTask: async (actor, runId, seq) => (await chainStepTask(deps, callerOf(actor), runId, seq, { actor })).task,
  };
}
