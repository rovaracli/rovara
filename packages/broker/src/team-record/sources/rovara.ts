// R5: Rovara's own events. Pure mapping from what already happens in a task (a send-back, a remembered note, a plan outcome, a review
// outcome, the task ending) to record drafts. The five emit points live in the v1.2 learning and track-record code (`captureSendBack`,
// `rememberTaskComment`, `recordPlanOutcome`, `recordPublicationOutcomes`, `settleTaskOutcomes`); each calls one method here. Those branches
// are not on this lane's base, so nothing is wired yet (see the lane report, "Wiring pending").
//
// Structured parts (outcomes, counts, codes) are kept long-term. Free text (a send-back reason, a remembered note) follows the project's
// "rovara" source row: retention A drops it. Audience follows the task's visibility (Plan 5): a private task's events are never project-wide.
import { cleanText, linksOf, scalars, withRetention, type GateDependencies } from "./common.js";
import { MAINTAINERS_GROUP, type ActorResolverPort, type Audience, type ReflectorTriggerPort, type RecordDraft, type RecordKind, type RecordSinkPort, type Retention, type SourceConfig, type TapLog, type TrustClass } from "./ports.js";

export type TaskVisibility =
  | { kind: "shared" }
  | { kind: "private"; ownerDeveloperId: string }
  | { kind: "shared_with"; developerIds: readonly string[] };

export interface RovaraEventBase {
  workspaceId: string;
  project: string;
  taskId: string;
  visibility: TaskVisibility;
  at: string;
  /** A link to the task page. */
  url?: string;
}

export interface RovaraEmitterDependencies extends GateDependencies {
  sink: RecordSinkPort;
  actors: ActorResolverPort;
  reflector?: ReflectorTriggerPort;
  log?: TapLog;
  /**
   * What applies when the project has NO `rovara:project/<p>` source row: the edition's default retention for Rovara's own events (the same word the ingest uses as its ceiling then). Absent: no row means no
   * record (tests). A row that exists is read as written: its switch, its retention and its audience.
   */
  defaultRetention?: Retention;
}

export const rovaraScope = (project: string): string => `rovara:project/${project}`;

/**
 * Who may read the rows of a task. A private or shared-with task is restricted to the people named, whatever the source row says (a row never widens it). A shared task is the project's, unless the
 * project's Rovara row says maintainers only (`audienceDefault`), which narrows it to the project's maintainers.
 */
export function audienceOfVisibility(base: Pick<RovaraEventBase, "taskId" | "visibility" | "at">, audienceDefault: "project" | "maintainers" = "project"): Audience {
  const { visibility } = base;
  if (visibility.kind === "shared" && audienceDefault === "project") return { kind: "project" };
  if (visibility.kind === "shared") return { kind: "restricted", acl: { source: "rovara", scope: `rovara:task/${base.taskId}`, groups: [MAINTAINERS_GROUP], capturedAt: base.at, liveCheck: "none" } };
  const principals = visibility.kind === "private" ? [visibility.ownerDeveloperId] : [...visibility.developerIds].slice(0, 500);
  return { kind: "restricted", acl: { source: "rovara", scope: `rovara:task/${base.taskId}`, principals, capturedAt: base.at, liveCheck: "none" } };
}

export interface RovaraEmitter {
  sendBack(input: RovaraEventBase & { sendBackId: string; round: number; origin: "human" | "automatic"; code?: string; reasonText?: string; actorDeveloperId?: string }): Promise<void>;
  /** `origin: "slack"` when the note was written in Slack (a thread comment): the Slack rule then follows the words into this row. */
  remembered(input: RovaraEventBase & { noteId: string; text: string; actorDeveloperId: string; origin?: "slack" }): Promise<void>;
  planOutcome(input: RovaraEventBase & { planId: string; outcome: string; claims: number; claimsHeld: number }): Promise<void>;
  reviewOutcome(input: RovaraEventBase & { publicationId: string; outcome: string; claims: number; claimsHeld: number }): Promise<void>;
  /** The task reached a terminal state. Writes the `rovara.task` row and, only if that was accepted, tells the reflector (once per task: the row's key is the task). */
  taskEnded(input: RovaraEventBase & { outcome: "merged" | "closed" | "failed" | "cancelled" | "reverted"; rounds: number; sendBacks: number }): Promise<void>;
}

export function createRovaraEmitter(deps: RovaraEmitterDependencies): RovaraEmitter {
  const log: TapLog = deps.log ?? (() => undefined);

  /** The project's Rovara row, or (no row) the edition's default. A disabled row, capture off, an unreadable row: nothing is recorded (fail closed). */
  async function rovaraConfigOf(base: RovaraEventBase): Promise<Pick<SourceConfig, "retention" | "audienceDefault"> | undefined> {
    try {
      const row = await deps.config.get(base.workspaceId, "rovara", rovaraScope(base.project));
      if (row === undefined && deps.defaultRetention === undefined) return undefined;
      if (row !== undefined && !row.enabled) return undefined;
      if (!await deps.mode.captureOn(base.workspaceId, base.project)) return undefined;
      return row ?? { retention: deps.defaultRetention!, audienceDefault: "project" };
    } catch {
      return undefined;
    }
  }

  async function emit(base: RovaraEventBase, kind: RecordKind, parts: {
    id: string; version: string; trust: TrustClass; text?: string; structured: Record<string, string | number | boolean | undefined>; actor?: RecordDraft["actor"]; origin?: "slack";
  }): Promise<"stored" | "duplicate" | "queued" | "refused" | "skipped" | "failed"> {
    try {
      const config = await rovaraConfigOf(base);
      if (config === undefined) return "skipped";
      const text = cleanText(parts.text);
      const draft: RecordDraft = {
        workspaceId: base.workspaceId, project: base.project, source: "rovara", kind, occurredAt: base.at,
        sourceRef: { system: "rovara", id: parts.id, ...(base.url === undefined ? {} : { url: base.url }), parentId: `task:${base.taskId}`, version: parts.version },
        ...(parts.actor === undefined ? {} : { actor: parts.actor }), trust: parts.trust, scope: rovaraScope(base.project), audience: audienceOfVisibility(base, config.audienceDefault),
        ...(text === undefined ? {} : { text }), structured: scalars({ taskId: base.taskId, ...parts.structured }), links: linksOf(base.url), retention: config.retention,
        ...(parts.origin === undefined ? {} : { origin: parts.origin }),
      };
      const outcome = await deps.sink.put(withRetention(draft, config.retention));
      return outcome.status;
    } catch {
      log("record.rovara_failed", { kind });
      return "failed";
    }
  }

  const personTrust = async (base: RovaraEventBase, developerId: string | undefined): Promise<{ trust: TrustClass; actor?: RecordDraft["actor"] }> => {
    if (developerId === undefined) return { trust: "rovara" };
    try {
      const resolved = await deps.actors.resolveDeveloper({ workspaceId: base.workspaceId, project: base.project, developerId });
      return { trust: resolved.trust, actor: { sourceId: developerId, developerId, trust: resolved.trust } };
    } catch {
      // Unknown standing is outsider: the text is kept tagged, and never used for learning.
      return { trust: "outsider", actor: { sourceId: developerId, developerId, trust: "outsider" } };
    }
  };

  return {
    async sendBack(input) {
      // A human reason is a member's words; an automatic send-back carries a fixed code and no free text.
      const who = input.origin === "human" ? await personTrust(input, input.actorDeveloperId) : { trust: "rovara" as TrustClass };
      await emit(input, "rovara.send_back", {
        id: `task:${input.taskId}:sendback:${input.sendBackId}`, version: "1", trust: who.trust,
        ...(input.origin === "human" && input.reasonText !== undefined ? { text: input.reasonText } : {}), ...("actor" in who && who.actor !== undefined ? { actor: who.actor } : {}),
        structured: { round: input.round, origin: input.origin, code: input.code },
      });
    },
    async remembered(input) {
      const who = await personTrust(input, input.actorDeveloperId);
      await emit(input, "rovara.remembered", { id: `task:${input.taskId}:note:${input.noteId}`, version: "1", trust: who.trust, text: input.text, ...(who.actor === undefined ? {} : { actor: who.actor }), ...(input.origin === undefined ? {} : { origin: input.origin }), structured: {} });
    },
    async planOutcome(input) {
      await emit(input, "rovara.plan", { id: `task:${input.taskId}:plan:${input.planId}`, version: input.outcome, trust: "rovara", structured: { outcome: input.outcome, claims: input.claims, claimsHeld: input.claimsHeld } });
    },
    async reviewOutcome(input) {
      await emit(input, "rovara.review", { id: `task:${input.taskId}:review:${input.publicationId}`, version: input.outcome, trust: "rovara", structured: { outcome: input.outcome, claims: input.claims, claimsHeld: input.claimsHeld } });
    },
    async taskEnded(input) {
      const outcome = await emit(input, "rovara.task", {
        id: `task:${input.taskId}`, version: "terminal", trust: "rovara", structured: { outcome: input.outcome, rounds: input.rounds, sendBacks: input.sendBacks },
      });
      // A refused or failed write, a missing source row or Mode Off all mean no reflection. A duplicate means the first call already told it. A queued write
      // is accepted: the reflector reads the record later and must tolerate a row that is a moment behind.
      if ((outcome !== "stored" && outcome !== "queued") || deps.reflector === undefined) return;
      try {
        await deps.reflector.taskEnded({ workspaceId: input.workspaceId, project: input.project, taskId: input.taskId, outcome: input.outcome });
      } catch {
        log("record.reflector_trigger_failed", { outcome: input.outcome });
      }
    },
  };
}
