// Convergence A7 (`cloud/audit-sink`): the name map from the events Rovara Code's core records on its `AuditSink` port to Cloud's audit ledger events.
//
// Cloud's ledger takes a closed set of actions (`AUDIT_ACTIONS`), each with its own list of allowed facts (`AUDIT_FACT_KEYS`), a target of a closed kind (an id, or a name the appender pseudonymizes) and personal
// data only in `details` (sealed per subject, so an erasure can make it unreadable). The core's events are free: a dotted action, a subject `{ type, id }` and a JSON `details` object. This table says, for each
// core action, which Cloud action it becomes and how: the target, the facts and the org's details.
//
// Rules that make the mapping safe by construction:
//  - A fact is taken only under a key the Cloud action allows (the default is the same-named detail; an entry may rename or compute one). Everything else in the core's `details` is dropped, so a detail the
//    core adds later reaches the ledger only when this table, and Cloud's own allowlist, name it.
//  - A fact value is a safe integer, a boolean or a printable-ASCII string of at most 128 characters that is not shaped like an email address (Cloud's own rules for facts). A value that fails them is left
//    out; the event still goes in.
//  - Names (a project, a repository, a server's label, a source id) go only in the org's details, or in a name-keyed target. Never in a fact.
//  - An action with no entry here is refused by the sink (see `sink.ts`); tests/unit/cloud-audit-sink.test.ts fails when the pinned core emits an action this table lacks.
import { AUDIT_FACT_KEYS, auditPullRequestId, type AuditAction, type AuditTarget, type AuditTargetKind } from "@agentx/cloud-contracts";
import type { AuditEvent, JsonObject, JsonValue } from "@rovara-code/contracts";

export interface MappingContext {
  readonly event: AuditEvent;
  readonly details: JsonObject;
}

/** A detail's name (a dotted path reaches into a nested object), or a function that computes the value. */
export type ValueSource = string | ((context: MappingContext) => unknown);

export type TargetRule =
  /** The subject's id is the target's id. */
  | { readonly id: AuditTargetKind }
  /** The subject's id is a name (a project's): a name-keyed target. */
  | { readonly name: "project" }
  /** The company. */
  | { readonly org: true }
  /** One rule per subject type. */
  | { readonly bySubject: Readonly<Record<string, TargetRule>> }
  | ((context: MappingContext) => AuditTarget | undefined);

export interface EventMapping {
  readonly cloud: AuditAction;
  readonly target: TargetRule;
  /** Cloud fact key to its source. Keys the Cloud action allows and this does not name are taken from the same-named detail; `null` leaves a key out. */
  readonly facts?: Readonly<Record<string, ValueSource | null>>;
  /** Fields of the org's details (personal data, sealed per subject), by the name they have there. */
  readonly org?: Readonly<Record<string, ValueSource>>;
  /** Ids of related records (at most 8, server-made ids only: never a name). */
  readonly related?: (context: MappingContext) => readonly (string | undefined)[];
}

const get = (details: JsonValue | undefined, path: string): JsonValue | undefined => {
  let at: JsonValue | undefined = details;
  for (const part of path.split(".")) {
    if (at === null || typeof at !== "object" || Array.isArray(at)) return undefined;
    at = at[part];
  }
  return at;
};

/** The value a source gives, or undefined. */
export function valueOf(source: ValueSource, context: MappingContext): unknown {
  return typeof source === "function" ? source(context) : get(context.details, source);
}

const suffix = (action: string): string => action.slice(action.indexOf(".") + 1);
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const wholeNumber = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) ? value : undefined);

const taskRelated = ({ event }: MappingContext): (string | undefined)[] => [event.subject?.type === "task" ? event.subject.id : undefined];

const MCP_ORG = { label: "label" } as const;
const lesson = (cloud: AuditAction): EventMapping => ({ cloud, target: { id: "lesson" }, org: { project: "project" } });
const same = (cloud: AuditAction, target: TargetRule, more: Omit<EventMapping, "cloud" | "target"> = {}): EventMapping => ({ cloud, target, ...more });

/** The pull request's opaque id, from the repository and number the core's event carries. */
const pullRequestTarget = ({ details }: MappingContext): AuditTarget | undefined => {
  const repository = text(get(details, "repository"));
  const raw = get(details, "number");
  const number = typeof raw === "number" ? raw : typeof raw === "string" && /^[0-9]{1,9}$/u.test(raw) ? Number(raw) : undefined;
  return repository === undefined || repository === "" || number === undefined ? undefined : { kind: "pull_request", id: auditPullRequestId(repository, number) };
};

const SAVED_ENV_CHANGES = [
  "lease_refused", "scan_started", "rebuild_queued", "build_recorded", "build_refused", "build_failed", "marked_stale", "reset_requested", "images_deleted", "project_archived", "project_deleted", "project_registered", "ceiling_walk",
] as const;
const savedEnv = (action: string): EventMapping => same("saved_env.changed", { name: "project" }, { facts: { change: () => suffix(action) } });

const DECISION_WORDS: Readonly<Record<string, string>> = { "decision.approved": "approved", "decision.rejected": "rejected", "decision.changes_requested": "changes_requested" };
const decision = (action: string): EventMapping => same("approval.decided", ({ event }) => {
  // The core's decision event is named `approval:<request id>`; the request id is the approval's id in the ledger.
  const id = event.eventId.startsWith("approval:") ? event.eventId.slice("approval:".length) : "";
  return id.length >= 1 && id.length <= 100 ? { kind: "approval", id } : { kind: "org", id: event.companyId };
}, { facts: { decision: () => DECISION_WORDS[action], subjectKind: ({ event }) => event.subject?.type, class: null }, related: taskRelated });

/** Core action to the Cloud event it becomes. Keep it sorted by the core's action. */
export const CORE_AUDIT_EVENT_MAP: Readonly<Record<string, EventMapping>> = {
  // Agents and chains.
  "agent.archived": same("agent.archived", { id: "agent" }),
  "agent.created": same("agent.created", { id: "agent" }),
  "agent.published": same("agent.published", { id: "agent" }),
  "agent.unarchived": same("agent.unarchived", { id: "agent" }),
  "chain.archived": same("chain.archived", { id: "chain" }),
  "chain.created": same("chain.created", { id: "chain" }),
  "chain.published": same("chain.published", { id: "chain" }),
  "chain.unarchived": same("chain.unarchived", { id: "chain" }),

  // Automatic runs and automation.
  "automatic_run.ended": same("automatic_run.ended", { name: "project" }, { facts: { cause: "reason" } }),
  "automatic_run.started": same("automatic_run.started", { name: "project" }),
  "automatic_runs.cap_changed": same("project.automatic_runs_cap_changed", { name: "project" }),
  "automatic_runs.paused": same("automatic_runs.paused", { name: "project" }),
  "automation.run_ended": same("automation.run_ended", { org: true }, { related: ({ event }) => [event.subject?.id] }),

  // Approvals and settings.
  "decision.approved": decision("decision.approved"),
  "decision.changes_requested": decision("decision.changes_requested"),
  "decision.rejected": decision("decision.rejected"),
  // Cloud's model policy facts are a strict schema: the revision and the two digests. The core's `reviewDefault` and `lessSafe` have no fact here, and `stage` / `mode` belong to Cloud's own flow.
  "model.policy.changed": same("model_policy.changed", { org: true }, { facts: { stage: null, mode: null } }),
  "setting.approval_sign_in_changed": same("company.approval_sign_in_changed", { org: true }, {
    facts: {
      mode: "mode",
      seconds: ({ details }) => wholeNumber(get(details, "seconds")) ?? 0,
      fromMode: "previous.mode",
      fromSeconds: ({ details }) => wholeNumber(get(details, "previous.seconds")) ?? 0,
    },
  }),

  // Second review.
  "company.second_review_choice_changed": same("company.second_review_choice_changed", { org: true }),
  "company.second_review_context_changed": same("company.second_review_context_changed", { org: true }),
  "company.second_review_mode_cancelled": same("company.second_review_mode_cancelled", { bySubject: { company: { org: true }, project: { org: true } } }),
  "company.second_review_mode_changed": same("company.second_review_mode_changed", { bySubject: { company: { org: true }, project: { org: true } } }),
  "company.second_review_mode_proposed": same("company.second_review_mode_proposed", { bySubject: { company: { org: true }, project: { org: true } } }),
  "company.second_review_replay_recorded": same("company.second_review_replay_recorded", { org: true }),
  "company.second_review_verdict_recorded": same("company.second_review_verdict_recorded", { org: true }),
  "company.second_review_verdict_withdrawn": same("company.second_review_verdict_withdrawn", { org: true }),
  "project.second_review_narrowed": same("project.second_review_narrowed", { name: "project" }),
  "task.second_review_acknowledged": same("task.second_review_acknowledged", { id: "task" }),

  // Connections, MCP servers and Sources.
  "connection.removed": same("connection.removed", { id: "connection" }),
  "connection.saved": same("connection.saved", { id: "connection" }),
  "context_source.applied": same("context_source.applied", { name: "project" }, { org: { sourceId: "sourceId" }, related: ({ details }) => [text(get(details, "changeId"))] }),
  "context_source.proposed": same("context_source.proposed", { name: "project" }, { org: { sourceId: "sourceId" }, related: ({ details }) => [text(get(details, "changeId"))] }),
  "context_source.rejected": same("context_source.rejected", { name: "project" }, { org: { sourceId: "sourceId" }, related: ({ details }) => [text(get(details, "changeId"))] }),
  "mcp_server.added": same("mcp_server.added", { id: "mcp_server" }, { facts: { hasCredential: "hasToken" }, org: MCP_ORG }),
  "mcp_server.approved": same("mcp_server.approved", { id: "mcp_server" }, {
    facts: {
      hasCredential: "hasToken", integrity: "pin.integrity", lockfileHash: "pin.lockfileHash", bundleHash: "pin.bundleHash", toolsHash: "pin.toolsHash",
      destinationCount: "pin.destinationCount", credentialCount: "pin.secretCount", credentialVersion: "pin.secretVersion",
    },
    org: { ...MCP_ORG, destinations: "pin.destinations", secretNames: "pin.secretNames" },
  }),
  "mcp_server.changed_needs_review": same("mcp_server.changed_needs_review", { id: "mcp_server" }, { facts: { approvedToolsHash: "approved", observedToolsHash: "observed" } }),
  "mcp_server.disabled": same("mcp_server.disabled", { id: "mcp_server" }, { org: MCP_ORG }),
  "mcp_server.egress_updated": same("mcp_server.egress_updated", { id: "mcp_server" }, { org: { addresses: "addresses" } }),
  "mcp_server.installed": same("mcp_server.installed", { id: "mcp_server" }, { facts: { package: "name" } }),
  "mcp_server.probed": same("mcp_server.probed", { id: "mcp_server" }),
  "mcp_server.removed": same("mcp_server.removed", { id: "mcp_server" }, { org: MCP_ORG }),
  "mcp_server.task_started": same("mcp_server.task_started", { id: "mcp_server" }),
  "mcp_server.task_stopped": same("mcp_server.task_stopped", { id: "mcp_server" }, { facts: { cause: "reason" } }),
  "mcp_server.token_changed": same("mcp_server.token_changed", { id: "mcp_server" }),

  // Playbook, design review, diagnosis.
  "diagnosis.proposed": same("diagnosis.proposed", { id: "diagnosis" }),
  "diagnosis.started": same("diagnosis.started", { id: "diagnosis" }),
  "playbook.design_review_changed": same("playbook.design_review_changed", { name: "project" }),
  "playbook.file_changed": same("playbook.file_changed", { name: "project" }),

  // Pull requests.
  "pull_request.merge_requested": same("pull_request.merge_requested", pullRequestTarget, { org: { repository: "repository" }, related: ({ details }) => [text(get(details, "requestId"))] }),
  "pull_request.opened": same("pull_request.opened", pullRequestTarget, {
    facts: { number: ({ details }) => { const raw = get(details, "number"); return typeof raw === "string" && /^[0-9]{1,9}$/u.test(raw) ? Number(raw) : raw; } },
    org: { repository: "repository" }, related: taskRelated,
  }),

  // Saved project images: one ledger event for the registry's changes, one for the setting.
  ...Object.fromEntries(SAVED_ENV_CHANGES.map((change) => [`saved_env.${change}`, savedEnv(`saved_env.${change}`)])),
  "saved_env.setting_changed": same("saved_env.setting_changed", { name: "project" }),

  // Script tokens.
  "script_token.created": same("script_token.created", { id: "script_token" }),
  "script_token.revoked": same("script_token.revoked", { id: "script_token" }),
  "script_token.used": same("script_token.used", { id: "script_token" }),

  // Sessions and tasks.
  "session.closed": same("session.closed", { id: "session" }),
  "session.message_sent": same("session.message_sent", { id: "session" }),
  "session.retried": same("session.retried", { id: "session" }),
  "session.stopped": same("session.stopped", { id: "session" }),
  "task.asked": same("task.asked", { id: "session" }),
  "task.closed": same("task.closed", { id: "task" }, { org: { project: "project" } }),
  "task.start_refused": same("task.start_refused", { id: "task" }, { org: { project: "project" } }),
  "task.started": same("task.started", { id: "task" }, { org: { project: "project" } }),
  "trigger.enabled": same("trigger.enabled", { id: "trigger" }),

  // Lessons: the library already names its ledger events as Cloud does (vendor/.../lessons/audit-sink.ts), with the Cloud fact keys; the project's name goes in the org's details.
  "lesson.activated": lesson("lesson.activated"),
  "lesson.approved": lesson("lesson.approved"),
  "lesson.edited": lesson("lesson.edited"),
  "lesson.expired": lesson("lesson.expired"),
  "lesson.model_set": lesson("lesson.model_set"),
  "lesson.preset_changed": lesson("lesson.preset_changed"),
  "lesson.preset_proposed": lesson("lesson.preset_proposed"),
  "lesson.promoted": lesson("lesson.promoted"),
  "lesson.proposed": lesson("lesson.proposed"),
  "lesson.refused": lesson("lesson.refused"),
  "lesson.rejected": lesson("lesson.rejected"),
  "lesson.replay_read": lesson("lesson.replay_read"),
  "lesson.replay_started": lesson("lesson.replay_started"),
  "lesson.repo_file_pr_closed": lesson("lesson.repo_file_pr_closed"),
  "lesson.repo_file_pr_opened": lesson("lesson.repo_file_pr_opened"),
  "lesson.repo_file_switched": lesson("lesson.repo_file_switched"),
  "lesson.retire_requested": lesson("lesson.retire_requested"),
  "lesson.retired": lesson("lesson.retired"),
  "lesson.rolled_back": lesson("lesson.rolled_back"),
  "lesson.snapshot_created": lesson("lesson.snapshot_created"),
  "lesson.sole_owner_switch_changed": lesson("lesson.sole_owner_switch_changed"),
  "lesson.sole_owner_switch_proposed": lesson("lesson.sole_owner_switch_proposed"),
  "lesson.tier0_setting_changed": lesson("lesson.tier0_setting_changed"),
  "lesson.tier0_setting_proposed": lesson("lesson.tier0_setting_proposed"),
  "lesson.trial_stable": lesson("lesson.trial_stable"),
  "lesson.withdrawn": lesson("lesson.withdrawn"),
};

/** The Cloud action a core action becomes, or undefined when the map has none. */
export function cloudActionOf(coreAction: string): AuditAction | undefined {
  return Object.hasOwn(CORE_AUDIT_EVENT_MAP, coreAction) ? CORE_AUDIT_EVENT_MAP[coreAction]!.cloud : undefined;
}

/** The core actions with no entry in `map` (the map defaults to the real one; a test passes one with an entry dropped). */
export function unmappedCoreActions(coreActions: Iterable<string>, map: Readonly<Record<string, EventMapping>> = CORE_AUDIT_EVENT_MAP): string[] {
  return [...new Set(coreActions)].filter((action) => !Object.hasOwn(map, action)).sort();
}

/** The fact keys of a mapping's Cloud action. */
export function allowedFactKeys(mapping: EventMapping): readonly string[] {
  return AUDIT_FACT_KEYS[mapping.cloud];
}
