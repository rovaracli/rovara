// S3 items 1, 4, 5 and 6: the company's core runtime, composed from Rovara Code's service factories over Cloud's adapters and rules (the counterpart of Code's
// `local/app/app.ts`, which composes the same factories with the laptop's rules). Nothing here is a copy of a Code service: each one is Code's factory, given Cloud's people, settings, words
// and clients as options. `cloudCoreRuntime(wiring)` is the `runtime` option of `createCloudApp`.
//
// What it joins, per company, once:
//   milestones       Code's document milestones (`createMilestoneService`), with the root's task-end handler for a merge (`coreTaskEndWiring`) and, when a chat adapter is registered,
//                    the thread notices (`channelThreadHandler`: the plan's approval card by risk, three milestone lines).
//   merge tracking   `createMergeTrackingService` with Cloud's MergePeople (A6's rules) and Cloud's code settings; its sweep is the `merge-tracking` job.
//   sessions         `createSessionService` over Cloud's facts and the cost ledger; its sweep is the `session-sweep` job. The notices a change calls for are queued by the notice service.
//   notices          `createNoticeService` with Cloud's footer, link and access rules; its delivery is the `notify-deliver` job.
//   decisions        `createDecisionService`, over Cloud's approvers adapter (A6) and the audit sink (A7). Who decides as the task's owner is Cloud's rule (`cloudActorFor`).
//   hold sweep       Cloud's admission adapter charges a hold whose caller died (`admission-hold-sweep`).
//   automation       `stopAutomationsWhenOff` as the `automation-stop` job (143c), when the deployment gives the chain runner's and the unattended door's dependencies.
//   Slack inbound    the channel sink over Cloud's `ChannelWork`, fed from Cloud's Slack request queue (`inbound.slack`).
// A deployment that gives less gets less: an area whose service is missing is refused by the root (`serviceGaps`), never half-run.
import { createDecisionService, createMergeTrackingService, createMilestoneService, createNoticeService, createSessionService, type NoticeServiceOptions, type SessionServiceOptions } from "@rovara-code/broker";
import { channelThreadHandler, planCardPosted, threadFollows, type ChannelCompanyOf, type ChannelMemberRule } from "@rovara-code/broker/core/channel";
import { costUsdOf, createCostLedger } from "@rovara-code/broker/core/cost";
import type { CodeSettingsReader, MergePeople } from "@rovara-code/broker/core/merge";
import { ticketMomentsOnChange } from "@rovara-code/broker/core/ticket-updates";
import type { RegistryTaskFlowOptions, TaskFlow } from "@rovara-code/broker/core/task-flow";
import type { AdapterRegistry, Admission, OrgId, Principal, WorkflowSnapshot } from "@rovara-code/contracts";
import { STANDING_ROLE_PREFIX } from "../adapters/people/methods.js";
import { createCloudSlackSink, type CloudSlackChannel } from "../../plugins/channel/slack-cloud/index.js";
import { coreTaskEndWiring } from "./task-end.js";
import { cloudAutomationSwitch, stopAutomationsWhenOff, type AutomationStopDeps } from "./automation.js";
import { cloudFlowOptions, type CoreInbound, type CoreRuntimeOptions, type CoreService, type CoreServiceName } from "./core-runtime.js";
import type { CloudCompanySettings } from "./settings-mapping.js";
import type { CloudModelFacts } from "./model-mapping.js";
import { createCloudChannelWork, createSlackIntake, type StartTask } from "./slack-work.js";
import type { CoreTaskEndedDeps } from "../rows/core-rows.js";
import type { CloudAppOptions } from "./app.js";

/** A developer id as Cloud keeps it: 64 lower-case hex. The core's workflow engine knows a person by nothing else. */
const DEVELOPER_ID = /^[a-f0-9]{64}$/u;

/** Whether the document waiting now is a coding plan (not the requirements or the design of a Full task): `currentDocumentType` of the core's workflow subject. */
const codingPlanWaiting = (workflow: Pick<WorkflowSnapshot, "path" | "reviewPhase">): boolean => workflow.path === "QUICK" || workflow.reviewPhase === "IMPLEMENTATION_PLAN";

/**
 * Who decides as the task's owner (the decision service's `workflowSubject.actorFor`). Code's default knows only its one local owner. Cloud's rule reads the decider's LIVE standing, which the
 * approvers adapter (A6) read and checked before this mapping and put on the verified approver (`standing:<role>`, `STANDING_ROLE_PREFIX`):
 *   - the task's owner, and a co-owner, decide as TASK_OWNER, recorded under the owner's id (as v2 records a co-owner's decision: the engine knows one owner);
 *   - a project maintainer decides as PROJECT_ADMIN, and only the coding plan: never the requirements or the design of a Full task;
 *   - anyone else, or an approver whose standing is not named, is nobody (fail closed).
 * Still owed (DEFERRED S3-MAINTAINER-SEAT-LIMITS, a switch-on blocker): a maintainer may not close as answered, skip, or acknowledge a run limit (v2's seat limits), which need the decision's
 * details and the approver together; the gate gives `checkDecision` the attempt but not the approver.
 */
export function cloudActorFor(approver: Pick<Principal, "personId" | "roles">, workflow: Pick<WorkflowSnapshot, "ownerId" | "path" | "reviewPhase">): { actorId: string; role: "TASK_OWNER" | "PROJECT_ADMIN" } | undefined {
  if (!DEVELOPER_ID.test(approver.personId)) return undefined;
  const standing = approver.roles.find((role) => role.startsWith(STANDING_ROLE_PREFIX))?.slice(STANDING_ROLE_PREFIX.length);
  if (standing === "owner" || standing === "co-owner") return { actorId: workflow.ownerId, role: "TASK_OWNER" };
  if (standing === "maintainer" && codingPlanWaiting(workflow)) return { actorId: approver.personId, role: "PROJECT_ADMIN" };
  return undefined;
}

/** Cloud's Slack, for the channel sink: the company of a team, the person behind a Slack account, the person as the core knows them and the words that finish linking. */
type DecisionSubject = NonNullable<Parameters<typeof createDecisionService>[0]["subjects"]>[number];

export interface CloudSlackInbound {
  /** `OrgStore.orgForSlackTeam`. */
  orgOfTeam: (teamId: string) => Promise<OrgId | undefined>;
  /** `slackRequesterStanding` reduced to the person it names (a throw for anyone it refuses). */
  standingOf: (orgId: OrgId, slackUserId: string) => Promise<string>;
  /** Lane A6's `identity.getPrincipal`: undefined for anyone who is not of this company now. */
  principalOf: (orgId: OrgId, personId: string) => Promise<Principal | undefined>;
  linkWords: (code: string) => string;
}

export interface CloudCoreWiring {
  /** Cloud's settings for this company (`cloudSettingsFromEnvironment`). */
  settings: (companyId: OrgId) => CloudCompanySettings;
  models?: (companyId: OrgId) => CloudModelFacts | undefined;
  callbackSigningKey: string | Buffer;
  repositoryGrantKey: Buffer;
  repositoryCredential: CoreRuntimeOptions["repositoryCredential"];
  access: CoreRuntimeOptions["access"];
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
  /** Whose approval on the code host counts toward a merge: `createCloudMergePeople` over Cloud's member directory. */
  people: MergePeople;
  /** A project's code settings (self-approval, merge method, reviewers): Cloud's settings item. */
  codeSettings: CodeSettingsReader;
  /** What Cloud's end bookkeeping reads and calls when a core task ends (`coreTaskEndWiring`). */
  taskEnd: CoreTaskEndedDeps;
  /** What a task's session shows, from Cloud's records (Code's own facts source is local to its laptop composition: an upstream need). */
  sessionFacts: SessionServiceOptions["facts"];
  /** Cloud's words and rules for the notice a person gets (the footer, the page link, who may be told, their address). */
  notices?: Pick<NoticeServiceOptions, "footer" | "link" | "access" | "address" | "urgent" | "emailLinks">;
  /** The chat adapters' rules (owner decision 131): which company a tenant is, and whether the person is served now. Used for the thread notices. The runtime pins both to its own company. */
  channels?: { companyOf?: ChannelCompanyOf; isMember?: ChannelMemberRule; taskUrl?: (taskId: string) => string | undefined; footer?: string };
  /** Cloud's Slack inbound. Absent: no inbound wiring (Slack keeps going through Cloud's own path). */
  slack?: CloudSlackInbound;
  /** Other kinds of decision this host has (a test environment, a setup run, a design choice). */
  decisionSubjects?: readonly DecisionSubject[];
  /** The `automation-stop` job (143c): the chain runner's and the unattended door's dependencies. Absent: the job is skipped (`service_not_wired`). */
  automation?: Omit<AutomationStopDeps, "automation" | "companyId" | "store" | "log">;
  /** Extra flow options (limits, prompts, the design review, ...), spread last EXCEPT the ones this file owns (milestones, taskEnded). */
  flowOptions?: Partial<RegistryTaskFlowOptions>;
}

/** Cloud's admission adapter charges a hold whose caller died (A5 open question 3). A registered admission that has no sweep is a wiring fault: the job reports it, it never throws. */
function holdSweep(admission: Admission, companyId: OrgId): CoreService {
  return {
    async pass() {
      const sweep = (admission as unknown as { sweepExpiredHolds?: (company: string) => Promise<number> }).sweepExpiredHolds;
      if (sweep === undefined) return { skipped: "admission_cannot_sweep" };
      return { charged: await sweep.call(admission, companyId) };
    },
  };
}

/**
 * The `runtime` option of `createCloudApp`: for each company, the core's flow options and services built from Code's factories and Cloud's wiring. The milestone service and the task-end
 * handler exist before the flow (the flow records milestones and tells the end), the services after it (they read the flow's dependencies).
 */
export function cloudCoreRuntime(wiring: CloudCoreWiring): CloudAppOptions["runtime"] {
  return (registry: AdapterRegistry, companyId: OrgId): Omit<CoreRuntimeOptions, "registry" | "companyId" | "flags"> => {
    const store = registry.require("storage");
    const nowMs = (): number => wiring.now().getTime();
    const log = (event: string, fields: Record<string, unknown>): void => wiring.log({ component: "milestones", event, ...fields });
    const milestones = createMilestoneService({ store, now: nowMs, log });
    const end = coreTaskEndWiring(wiring.taskEnd);
    milestones.register(end.onMerged);
    const ledger = createCostLedger({ store, metering: registry.require("metering"), now: wiring.now });
    const settings = wiring.settings(companyId);
    const models = wiring.models?.(companyId);

    const flowOptions: Partial<RegistryTaskFlowOptions> = {
      ...cloudFlowOptions(settings, models),
      taskSpendUsd: async (taskId) => costUsdOf(await ledger.taskCost(companyId, taskId)),
      ...(wiring.flowOptions ?? {}),
      milestones,
      taskEnded: end.onClose,
    };

    // A chat tenant counts only when it is THIS company's: another company's tenant (or nobody's) is never sent to or served by this runtime (owner decision 131).
    const pinnedCompanyOf: ChannelCompanyOf | undefined = wiring.channels?.companyOf === undefined ? undefined : async (where) => { const org = await wiring.channels!.companyOf!(where); return org === companyId ? org : undefined; };
    // Built once per flow (the services and the inbound share one decision gate).
    let composed: { flow: TaskFlow; services: Partial<Record<CoreServiceName, CoreService>>; inbound: CoreInbound } | undefined;
    const compose = (flow: TaskFlow): { services: Partial<Record<CoreServiceName, CoreService>>; inbound: CoreInbound } => {
      if (composed !== undefined && composed.flow === flow) return composed;
      const channelOn = registry.names("channel").length > 0;
      const notices = createNoticeService({
        store, registry, now: wiring.now, log: wiring.log, ...(wiring.notices ?? {}),
        doneToldInThread: () => registry.names("channel").length > 0,
        planCarded: planCardPosted({ store, now: nowMs }),
        ...(pinnedCompanyOf === undefined ? {} : { companyOf: pinnedCompanyOf }),
      });
      const decisions = createDecisionService({
        flow: flow.deps, blobs: registry.require("object-storage"), store, approvers: registry.require("approvers"), audit: registry.require("audit-sink"), companyId,
        identity: registry.require("identity"), now: wiring.now,
        ...(wiring.decisionSubjects === undefined ? {} : { subjects: wiring.decisionSubjects }),
        workflowSubject: { actorFor: cloudActorFor },
      });
      if (channelOn) {
        // The plan's approval card by risk (low and medium: Approve in the thread; high: a pointer to the web with a fresh sign-in) and the milestone lines, registered before any milestone is written.
        milestones.register(channelThreadHandler({
          store, registry, now: nowMs, plan: { gate: decisions.gate }, log: (event, fields) => wiring.log({ component: "channel_thread", event, ...fields }),
          ...(pinnedCompanyOf === undefined ? {} : { companyOf: pinnedCompanyOf }),
          ...(wiring.channels?.isMember === undefined ? {} : { isMember: wiring.channels.isMember }),
          ...(wiring.channels?.taskUrl === undefined ? {} : { taskUrl: wiring.channels.taskUrl }),
          ...(wiring.channels?.footer === undefined ? {} : { footer: wiring.channels.footer }),
        }));
      }
      const threadMoments = ticketMomentsOnChange({ store, milestones, now: nowMs, log: (event, fields) => wiring.log({ component: "channel_thread", event, ...fields }), follows: threadFollows({ store }) });
      const sessions = createSessionService({
        store, facts: wiring.sessionFacts, cost: { async costUsd(company, taskId) { return costUsdOf(await ledger.taskCost(company, taskId)) ?? 0; } }, now: wiring.now, log: wiring.log, notices,
        onChange: [async (change) => { if (channelOn) await threadMoments(change); }],
      });
      const tracking = createMergeTrackingService({ flow: flow.deps, registry, companyId, milestones, people: wiring.people, settings: wiring.codeSettings, now: nowMs, log: wiring.log });
      const automationSwitch = cloudAutomationSwitch();
      const services: Partial<Record<CoreServiceName, CoreService>> = {
        "merge-tracking": { async pass() { return { ...(await tracking.sweep()) }; } },
        "session-sweep": { async pass({ budgetMs }) { return { ...(await sessions.sweep({ budgetMs })) }; } },
        "notify-deliver": { async pass({ budgetMs }) { const outcome = await notices.deliver({ deadlineMs: nowMs() + budgetMs }); return outcome === undefined ? { skipped: "nobody_can_be_told" } : { ...outcome }; } },
        "admission-hold-sweep": holdSweep(registry.require("admission"), companyId),
        ...(wiring.automation === undefined ? {} : { "automation-stop": { async pass() { return { ...(await stopAutomationsWhenOff({ ...wiring.automation!, automation: automationSwitch, companyId, store, log: wiring.log })) }; } } }),
      };
      composed = { flow, services, inbound: inboundOf(flow, decisions.gate) };
      return composed;
    };

    const inboundOf = (flow: TaskFlow, gate: ReturnType<typeof createDecisionService>["gate"]): CoreInbound => {
      const slack = wiring.slack;
      const adapter = registry.get("channel", "slack") as CloudSlackChannel | undefined;
      if (slack === undefined || adapter === undefined) return { gate };
      const start: StartTask = (caller, request) => flow.start(caller, request);
      // A plain message with Understand off has no step to choose its path: it starts as Quick, and the lighter flow sizes it from the diff (178/179; P5 replaces this default).
      const work = createCloudChannelWork({ store, now: nowMs, start, gate, principalOf: slack.principalOf, ...(flowOptions.understandFirst === true ? {} : { defaultPath: "QUICK" as const }), log: wiring.log });
      const sink = createCloudSlackSink({ adapter, store, now: nowMs, work, orgOfTeam: async (teamId) => { const org = await slack.orgOfTeam(teamId); return org === companyId ? org : undefined; }, standingOf: slack.standingOf, linkWords: slack.linkWords, log: wiring.log });
      return { slack: createSlackIntake(sink), slackSink: sink, gate };
    };

    return {
      callbackSigningKey: wiring.callbackSigningKey, access: wiring.access, repositoryGrantKey: wiring.repositoryGrantKey, repositoryCredential: wiring.repositoryCredential,
      now: wiring.now, log: wiring.log, flowOptions, services: (flow) => compose(flow).services, inbound: (flow) => compose(flow).inbound,
    };
  };
}
