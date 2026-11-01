// The world for the poisoning suite (L7, tests/contract/learning-poisoning.test.ts): the REAL path from a planted word to a lesson in front of an agent, on in-memory ports.
//
//   capture   the real Slack / ticket / code-host taps, writing through the REAL record sink (`ingestRecord`) into an in-memory TeamRecord table. The stored row's trust is what ingest decided.
//   reflect   `learnFromEndedTask` (reflector subject, eligibility, spans, prompt) with a SCRIPTED model: no model call is ever made. The script plays a model that has been fooled
//             completely, so what stops a lesson is code, never the model's good manners.
//   curate    `processDraft` (curate, verify citations, tier, promote, auto-apply when the policy and the gate allow).
//   approve   `approveLesson` with an approver directory.
//   load      `loadLessonsForStage` with an access port.
//
// Nothing here calls AWS or a model. The task-side facts (who started a task, with what intent, steered by whom) come from `TaskSubjectSource`, which the connecting lane builds from the task record;
// here each test states them, and states them FROM the trust the real capture gave the planted rows (`trustOf`), never from the test's own idea of who is an outsider.
import { OrgIdSchema, type OrgId } from "@agentx/contracts";
import { approveLesson, listWaiting, type ApproveDeps } from "../../packages/broker/src/lessons/approve.js";
import { loadLessonsForStage, type LoadDeps, type LoadRequest } from "../../packages/broker/src/lessons/load.js";
import type { LearningSettings, LearningSettingsReader } from "../../packages/broker/src/lessons/policy.js";
import { setAutoApplyGate } from "../../packages/broker/src/lessons/policy.js";
import type { ProcessDeps } from "../../packages/broker/src/lessons/process.js";
import type { ReflectDeps } from "../../packages/broker/src/lessons/reflect.js";
import type { EvidenceSpan } from "../../packages/broker/src/lessons/reflect-input.js";
import { InMemoryLessonStore } from "../../packages/broker/src/lessons/store.js";
import { learnFromEndedTask, type LearnStatus, type TaskLearningDeps, type TaskSubjectBase } from "../../packages/broker/src/lessons/task-end.js";
import type { OutcomeRowReader } from "../../packages/broker/src/lessons/task-outcome-rows.js";
import type { SendBackFact, TaskSubjectFacts } from "../../packages/broker/src/lessons/task-subject.js";
import type { Lesson, SpanKind, TrustClass } from "../../packages/broker/src/lessons/types.js";
import { queryRecordEvents, type StoredEvent } from "../../packages/broker/src/team-record/store.js";
import { createSlackRecordTap, type SlackChannelInfo } from "../../packages/broker/src/team-record/sources/slack.js";
import { createTicketRecorder, type TicketItem } from "../../packages/broker/src/team-record/sources/tickets.js";
import { createCodeHostTap, type CodeHostEvent, type CodeHostRepo } from "../../packages/broker/src/team-record/sources/codehost.js";
import { createRovaraEmitter } from "../../packages/broker/src/team-record/sources/rovara.js";
import { tableOutcomeRows } from "../../packages/broker/src/lessons/task-outcome-rows.js";
import { minTrust } from "../../packages/broker/src/team-record/taint.js";
import type { AccessCheckPort } from "../../packages/broker/src/team-record/access-port.js";
import {
  Alerts, Audit, BASE, Clock, MERGED, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, allowAllAccess, defaultFacts, directory, embedder, memberSpan, settings, verifier,
} from "../unit/lessons/lesson-helpers.js";
import { FakeActors, FakeConfig, FakeDistiller, FakeMode, FakePushIndex, FakeRovaraPrs } from "./team-record-ingest-fakes.js";
import { ORG_A, T0, addSource, world as recordWorld, type World as RecordWorld } from "./team-record-core.js";

export { BASE, MERGED, PROJECT, WS };

/** The auto-apply gate is CLOSED in production (the pilot rule). A test says which world it lives in. */
export const closeAutoApply = (): void => setAutoApplyGate(() => false);
export const openAutoApply = (): void => setAutoApplyGate(() => true);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Capture: the real taps into the real record sink
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const SLACK_TEAM = "T0TEAM00001";
export const SLACK_PUBLIC = "C0PUBLIC001";
export const SLACK_PRIVATE = "G0PRIVATE01";
export const MEMBER_SLACK = "U0MEMBER001";
export const MEMBER2_SLACK = "U0MEMBER002";
export const OUTSIDER_SLACK = "U0OUTSIDE01";
export const GITHUB_REPO: CodeHostRepo = { host: "github", id: "77", fullName: "acme/api", isPrivate: true, defaultBranch: "main", workspaceId: ORG_A, project: "web" };
export const MEMBER_GITHUB = { id: "1001", login: "ann", isBot: false };
export const OUTSIDER_GITHUB = { id: "9999", login: "mallory", isBot: false };

export class Capture {
  readonly record: RecordWorld = recordWorld({ edition: "enterprise" });
  readonly actors = new FakeActors();
  readonly config = new FakeConfig();
  readonly mode = new FakeMode();
  readonly distiller = new FakeDistiller();
  readonly pushes = new FakePushIndex();
  readonly prs = new FakeRovaraPrs();
  readonly channels: Record<string, SlackChannelInfo> = {
    [SLACK_PUBLIC]: { kind: "public", extShared: false },
    [SLACK_PRIVATE]: { kind: "private", extShared: false, memberIds: [MEMBER_SLACK] },
  };
  /** Pull request authors, commits and diffs are only ever claimed by what the test's fake host says. */
  readonly sink = this.record.sink;

  readonly slack = createSlackRecordTap({
    edition: "enterprise", sink: this.sink, distiller: this.distiller, actors: this.actors, mode: this.mode, config: this.config,
    resolveWorkspace: async (team) => (team === SLACK_TEAM ? { workspaceId: ORG_A, project: "web" } : undefined),
    notesOptIn: async () => false,
    directory: { channelInfo: async (_team, channel) => this.channels[channel] },
  });
  readonly tickets = createTicketRecorder({ sink: this.sink, actors: this.actors, mode: this.mode, config: this.config });
  readonly rovara = createRovaraEmitter({ sink: this.sink, actors: this.actors, mode: this.mode, config: this.config });
  /** The real reader of the rows the emitter wrote (who sent a task back, their standing, their words). */
  get outcomeRows() { return tableOutcomeRows(this.record.table); }
  readonly codehost = createCodeHostTap({ sink: this.sink, actors: this.actors, rovaraPrs: this.prs, mode: this.mode, config: this.config, pushes: this.pushes });

  private ts = 1_760_000_000;

  constructor() {
    this.actors.members.set(MEMBER_SLACK, "ann");
    this.actors.members.set(MEMBER2_SLACK, "bob");
    this.actors.members.set(MEMBER_GITHUB.id, "ann");
    this.actors.members.set("acc-ann", "ann");
    // Unmapped identities (the outsiders) match no member: `FakeActors` gives them the outsider trust.
  }

  /** Switches a source on in BOTH the tap's config port and the record core's own source row (the sink refuses a place nobody switched on). */
  async enable(source: "slack" | "github" | "jira" | "linear" | "rovara", scope: string, project = "web"): Promise<void> {
    this.config.set(source, scope, { retention: "D", audienceDefault: "project" });
    await addSource(this.record, { source, scope, project, retention: "D", audienceDefault: "project" });
  }

  async slackMessage(user: string, text: string, over: { channel?: string; attachments?: Array<Record<string, unknown>> } = {}): Promise<unknown> {
    this.ts += 1;
    const ts = `${this.ts}.000100`;
    return this.slack({
      type: "event_callback", team_id: SLACK_TEAM, api_app_id: "A0ROVARA001", event_id: `Ev${this.ts}`,
      event: { type: "message", channel: over.channel ?? SLACK_PUBLIC, user, text, ts, ...(over.attachments === undefined ? {} : { attachments: over.attachments }) },
    });
  }

  async ticket(authorId: string | undefined, title: string, body: string, id = `issue:${this.ts + 1}`): Promise<string> {
    this.ts += 1;
    const item: TicketItem = {
      source: "jira", system: "jira:acme.atlassian.net", id, kind: "ticket.created", scope: "jira:project/SHOP", title, body, occurredAt: new Date(T0 - 60_000).toISOString(),
      version: "v1", ...(authorId === undefined ? {} : { authorId }),
    };
    return this.tickets.record({ workspaceId: ORG_A, project: "web" }, item);
  }

  /** A ticket item with every field the test cares about (an edit, an updater, a version). */
  async ticketItem(over: Partial<TicketItem> & Pick<TicketItem, "id" | "version">): Promise<string> {
    const item: TicketItem = { source: "jira", system: "jira:acme.atlassian.net", kind: "ticket.created", scope: "jira:project/SHOP", occurredAt: new Date(T0 - 30_000).toISOString(), ...over };
    return this.tickets.record({ workspaceId: ORG_A, project: "web" }, item);
  }

  async codeHost(event: CodeHostEvent): Promise<unknown> { return this.codehost.handle(event); }

  /** Every row stored for the project, as ingest decided (trust, audience, scope, text). */
  async stored(): Promise<StoredEvent[]> {
    return queryRecordEvents(this.record.table, ORG_A, "web", { limit: 500 });
  }
}

/** The trust the record gave a set of stored rows: the lowest of them (a task started from, or steered by, these rows is only as trusted as its least trusted row). Nothing stored: outsider. */
export const trustOf = (rows: readonly Pick<StoredEvent, "trust">[]): TrustClass => minTrust(rows.map((row) => row.trust));

/** A stored row as the reflector would be handed it: its trust, audience and place come from ingest, never from the test. */
export function spanOfRow(row: StoredEvent, kind: SpanKind, authorId?: string): EvidenceSpan {
  return {
    kind, text: row.text ?? "", trust: row.trust, eventId: row.id,
    ...(authorId === undefined ? {} : { authorId }),
    audience: row.audience as NonNullable<EvidenceSpan["audience"]>, scopes: [row.scope],
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The lesson pipeline
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

class Rows implements OutcomeRowReader {
  sendBacks = new Map<string, SendBackFact>();
  reverter: { actorDeveloperId?: string } | undefined;
  async sendBack(input: { requestId: string }): Promise<SendBackFact | undefined> { return this.sendBacks.get(input.requestId); }
  async revertedBy(): Promise<{ actorDeveloperId?: string } | undefined> { return this.reverter; }
}

export const codeCitationFor = (over: Record<string, unknown> = {}) => ({ kind: "code" as const, repo: "api", path: "src/retry/index.ts", startLine: 12, endLine: 30, anchor: "export function withRetry(", commit: BASE, ...over });

/** One candidate in the reflector's JSON, as a fooled model would write it. */
export function candidate(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "convention", title: "Retries use withRetry", description: "The retry helper is called withRetry.", body: "HTTP retries in api use withRetry from src/retry/index.ts.",
    scope: { repos: ["api"], paths: ["src/**"] }, stages: ["IMPLEMENT"], citations: [codeCitationFor()], evidenceSpanIds: ["S1"], ...over,
  };
}
export const modelSays = (...candidates: unknown[]): string => JSON.stringify({ candidates });

export interface TaskInput {
  taskId?: string;
  /** Who started it and with what intent, as the connecting lane will read them from the task record and the rows; the default is a member working on a member's request. */
  initiatorTrust?: TrustClass | undefined;
  steeringTrust?: readonly TrustClass[];
  intentTrust?: TrustClass | undefined;
  starter?: string;
  spans?: readonly EvidenceSpan[];
  outcome?: TaskSubjectFacts["outcome"];
  sendBacks?: Array<{ id: string; actor: string | undefined; trust: TrustClass; text: string }>;
  /** With `outcomeRows` given, the send-backs are read from the record by these request ids (the rows the real emitter wrote). */
  sendBackIds?: string[];
  repositories?: readonly string[];
  baseCommit?: string;
  mergedCommit?: string;
}

export interface PipelineOptions {
  settings?: LearningSettings;
  access?: AccessCheckPort;
  verifierResult?: "valid" | "moved" | "stale" | "unknown";
  workspaceId?: string;
  eligible?: string[];
  owners?: string[];
  /** The real row reader over a record table, so a send-back's author, standing and words are what the record stored. */
  outcomeRows?: OutcomeRowReader;
}

export function pipeline(options: PipelineOptions = {}) {
  const workspaceId = options.workspaceId ?? WS;
  const store = new InMemoryLessonStore();
  const vectors = new MemoryVectors();
  const audit = new Audit();
  const alerts = new Alerts();
  const clock = new Clock();
  const reflectModel = new ScriptedModel();
  const judgeModel = new ScriptedModel();
  const reader: LearningSettingsReader = settings({ mode: "On", ...(options.settings ?? {}) });
  const dir = directory({ ownerIds: options.owners ?? ["owner"], eligibleIds: options.eligible ?? ["owner", "ann", "bob"] });
  const access = options.access ?? allowAllAccess;
  let counter = 0;
  const newId = (): string => `les_${String(++counter).padStart(4, "0")}`;
  const processDeps: ProcessDeps = {
    store, embedder, vectors, judgeModel, spend: new Spend(), audit, alerts, now: clock.now,
    verifier: verifier(options.verifierResult ?? "valid"), facts: defaultFacts, settings: reader, newId,
  };
  const reflectDeps: ReflectDeps = { model: reflectModel, spend: new Spend(), audit, settings: reader, edition: "enterprise", now: clock.now };
  const fakeRows = new Rows();
  const rows: OutcomeRowReader = options.outcomeRows ?? fakeRows;
  const bases = new Map<string, TaskSubjectBase>();
  const taskDeps: TaskLearningDeps = {
    source: { read: async (input) => bases.get(input.taskId) }, rows, settings: reader, reflect: reflectDeps, process: processDeps,
  };
  const approveDeps: ApproveDeps = { store, directory: dir, settings: reader, access, audit, now: clock.now };
  const loadDeps: LoadDeps = { access, store, embedder, vectors, settings: reader, audit, now: clock.now };
  const key = { workspaceId, project: PROJECT };

  /** Registers a finished task's facts. */
  function register(input: TaskInput = {}): string {
    const taskId = input.taskId ?? "task-1";
    const sendBackIds = [...(input.sendBacks ?? []).map((b) => b.id), ...(input.sendBackIds ?? [])];
    for (const back of input.sendBacks ?? []) {
      fakeRows.sendBacks.set(back.id, { id: `task:${taskId}:sendback:${back.id}`, origin: "human", actorDeveloperId: back.actor, actorTrust: back.trust, reasonText: back.text });
    }
    const outcome = input.outcome ?? "merged";
    bases.set(taskId, {
      sendBackRequestIds: sendBackIds,
      facts: {
        workspaceId, project: PROJECT, taskId, repositories: input.repositories ?? ["api"], baseCommit: input.baseCommit ?? BASE, mergedCommit: input.mergedCommit ?? MERGED, outcome,
        task: { developerId: input.starter ?? "starter", startedBy: { developerId: input.starter ?? "starter" }, agent: { agentId: "a" } },
        rest: {
          // `undefined` is a stated value here: the field was not filled in (the fail-closed cases).
          ...(("initiatorTrust" in input ? input.initiatorTrust : "member") === undefined ? {} : { initiatorTrust: ("initiatorTrust" in input ? input.initiatorTrust : "member") as TrustClass }),
          steeringTrust: input.steeringTrust ?? ["member"],
          ...(("intentTrust" in input ? input.intentTrust : "member") === undefined ? {} : { intentTrust: ("intentTrust" in input ? input.intentTrust : "member") as TrustClass }),
          links: ["https://github.com/acme/api/pull/7"], spans: input.spans ?? [memberSpan("Use withRetry for HTTP retries in api.", { eventId: "ev-1" })],
        },
      },
    });
    return taskId;
  }

  /** A task ends. The model (scripted) says what it says; the real code decides what becomes of it. */
  async function endTask(input: TaskInput = {}, modelReply?: string): Promise<{ status: LearnStatus; taskId: string }> {
    const taskId = register(input);
    if (modelReply !== undefined) reflectModel.replies.push(modelReply);
    const status = await learnFromEndedTask(taskDeps, { workspaceId, taskId, outcome: input.outcome ?? "merged" });
    return { status, taskId };
  }

  const lessons = (): Promise<Lesson[]> => store.list(key);
  const byStatus = async (...statuses: Lesson["status"][]): Promise<Lesson[]> => (await lessons()).filter((l) => statuses.includes(l.status));

  /** Approvals by people, one after another, until the lesson is active or the people run out. Returns what it ended as. */
  async function approveAll(lessonId: string, approvers = ["owner", "bob"]): Promise<Lesson | undefined> {
    for (const approverId of approvers) {
      const result = await approveLesson(approveDeps, { workspaceId, project: PROJECT, lessonId, approverId });
      if (result.ok && result.status === "active") break;
    }
    return store.get(key, lessonId);
  }

  const loadRequest = (over: Partial<LoadRequest> = {}): LoadRequest => ({
    workspaceId, project: PROJECT, taskId: "load-task", stage: "IMPLEMENT", round: 1, intent: "Retry failed HTTP calls in the api service", repos: ["api"], files: ["src/retry/client.ts"], languages: [],
    taskAudience: { kind: "shared" }, ...over,
  });
  async function load(over: Partial<LoadRequest> = {}) {
    const result = await loadLessonsForStage(loadDeps, loadRequest(over));
    return { result, ids: result.context?.lessons.map((l) => l.id) ?? [], text: JSON.stringify(result.context ?? {}) };
  }
  async function waiting(viewer = { principals: [] as string[], groups: [] as string[] }): Promise<Lesson[]> { return listWaiting(store, key, viewer, access); }

  return {
    key, workspaceId, store, vectors, audit, alerts, clock, reflectModel, judgeModel, processDeps, reflectDeps, taskDeps, approveDeps, loadDeps, rows,
    register, endTask, lessons, byStatus, approveAll, load, loadRequest, waiting, directory: dir,
    /** The prompt the reflector's model was actually shown, joined. */
    prompts: (): string => reflectModel.calls.map((c) => `${String(c.system)}\n${String(c.user)}`).join("\n----\n"),
  };
}
export type Pipeline = ReturnType<typeof pipeline>;

export { OrgIdSchema };
export type { OrgId };
