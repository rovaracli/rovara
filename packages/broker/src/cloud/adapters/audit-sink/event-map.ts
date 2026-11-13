// Convergence A7 (`cloud/audit-sink`): the name map from the events Rovara Code's core records on its `AuditSink` port to Cloud's audit ledger events.
//
// Cloud's ledger takes a closed set of actions (`AUDIT_ACTIONS`), each with its own list of allowed facts (`AUDIT_FACT_KEYS`), a target of a closed kind (an id, or a name the appender pseudonymizes) and personal
// data only in `details` (sealed per subject, so an erasure can make it unreadable). The core's events are free: a dotted action, a subject `{ type, id }` and a JSON `details` object. This table says, for each
// core action, which Cloud action it becomes and how: the target, the facts and the org's details.
//
// Rules that make the mapping safe by construction:
//  - NO IMPLICIT FACTS. A Cloud fact key is filled only when the mapping names a core source for it (`facts`), and every fact has a value CHECK: an enum, a regular expression or an integer range. A value that
//    fails its check is left out (the event still goes in). A core detail that the mapping does not name never reaches the ledger, whatever it is called, so a new or free-text detail cannot ride in under
//    an allowed key's name. tests/unit/cloud-audit-sink.test.ts feeds a free-text marker under every allowed key name of every action and fails if it shows up in a fact.
//  - `required` facts: an event whose required fact is missing or fails its check is refused whole (a record that would say nothing it exists to say is worse than a loud refusal).
//  - Cloud's own fact rules still apply on top (safe integers, printable ASCII, at most 128 characters, nothing email-shaped; `AuditEventInputSchema`).
//  - Names (a project, a repository, a server's label, a source id) go only in the org's details, or in a name-keyed target. Never in a fact, a related id or an id target.
//  - An action with no entry here is refused by the sink (see `sink.ts`); tests/unit/cloud-audit-sink.test.ts fails when the pinned core emits an action this table lacks.
import { auditPullRequestId, type AuditAction, type AuditTarget, type AuditTargetKind } from "@agentx/cloud-contracts";
import type { AuditEvent, JsonObject, JsonValue } from "@rovara-code/contracts";

export interface MappingContext {
  readonly event: AuditEvent;
  readonly details: JsonObject;
}

/** A detail's name (a dotted path reaches into a nested object), or a function that computes the value. */
export type ValueSource = string | ((context: MappingContext) => unknown);

/** What a fact's value must be. Anything else is left out. */
export type FactCheck =
  | { readonly enum: readonly string[] }
  | { readonly pattern: RegExp }
  | { readonly int: readonly [min: number, max: number] }
  | "bool";

export interface FactRule {
  readonly from: ValueSource;
  readonly check: FactCheck;
}

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
  /** Cloud fact key to its source and check. A key not named here is never filled. */
  readonly facts?: Readonly<Record<string, FactRule>>;
  /** Fact keys the event cannot be recorded without. */
  readonly required?: readonly string[];
  /** Fields of the org's details (personal data, sealed per subject), by the name they have there. */
  readonly org?: Readonly<Record<string, ValueSource>>;
  /** Ids of related records (at most 8, server-made ids only: never a name). Each must look like an id (no space, no `@`, no `/`). */
  readonly related?: (context: MappingContext) => readonly (string | undefined)[];
  /** When `when` holds for an event, this mapping is replaced by `mapping` (another Cloud action, with its own facts): one core action that Cloud records as two kinds of event. */
  readonly alternate?: { readonly when: (context: MappingContext) => boolean; readonly mapping: EventMapping };
}

/** The mapping that applies to an event: the alternate when its condition holds, else the mapping itself. */
export function mappingFor(mapping: EventMapping, context: MappingContext): EventMapping {
  return mapping.alternate?.when(context) === true ? mapping.alternate.mapping : mapping;
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

/** The fact a rule gives, or undefined when the source gives nothing or the value fails its check. */
export function checkedFact(rule: FactRule, context: MappingContext): string | number | boolean | undefined {
  const value = valueOf(rule.from, context);
  const check = rule.check;
  if (check === "bool") return typeof value === "boolean" ? value : undefined;
  if ("enum" in check) return typeof value === "string" && check.enum.includes(value) ? value : undefined;
  if ("pattern" in check) return typeof value === "string" && check.pattern.test(value) ? value : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= check.int[0] && value <= check.int[1] ? value : undefined;
}

/** What an id of a related record looks like: no space, no `@`, no `/` (a name, a branch or an address does not pass). */
export const RELATED_ID = /^[A-Za-z0-9][A-Za-z0-9_.:#-]{0,99}$/u;

// ---- value checks -----------------------------------------------------------------------------------------------------------------------------------------------------------------

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const COUNT = { int: [0, 2_147_483_647] } as const;
const HEX64 = { pattern: /^[0-9a-f]{64}$/u } as const;
/** A fixed word the core takes from a type in its own code (never from a person): lower-case, no space. */
const WORD = { pattern: /^[a-z][a-z0-9_-]{0,39}$/u } as const;
/** A server-made id (a request, a run, a suggestion): no space, no `@`, no `/`. */
const ID = { pattern: /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u } as const;
/** An error code of the core (`BUDGET_EXCEEDED`). */
const CODE = { pattern: /^[A-Z][A-Z0-9_]{1,63}$/u } as const;
/** A model key (`provider:vendor/model`), no space and no `@`. */
const MODEL = { pattern: /^[A-Za-z0-9][A-Za-z0-9:_.#/-]{0,127}$/u } as const;
const MONTH = { pattern: /^\d{4}-(0[1-9]|1[0-2])$/u } as const;
const DAY = { pattern: /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u } as const;
const INTEGRITY = { pattern: /^sha(256|384|512)-[A-Za-z0-9+/]{20,120}={0,2}$/u } as const;
const SEMVER = { pattern: /^\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z.-]{1,40})?$/u } as const;
const PACKAGE_NAME = { pattern: /^(@[a-z0-9][a-z0-9._~-]{0,63}\/)?[a-z0-9][a-z0-9._~-]{0,63}$/u } as const;
const IMAGE_DIGEST = { pattern: /^sha256:[0-9a-f]{64}$/u } as const;
const OPERATOR = { pattern: /^op_[0-9a-f]{24}$/u } as const;

const fact = (from: ValueSource, check: FactCheck): FactRule => ({ from, check });
const count = (from: ValueSource): FactRule => fact(from, COUNT);
const flag = (from: ValueSource): FactRule => fact(from, "bool");
const word = (from: ValueSource): FactRule => fact(from, WORD);
const oneOf = (from: ValueSource, ...values: readonly string[]): FactRule => fact(from, { enum: values });

const subjectType = ({ event }: MappingContext): string | undefined => event.subject?.type;
const taskRelated = ({ event }: MappingContext): (string | undefined)[] => [event.subject?.type === "task" ? event.subject.id : undefined];
const suffix = (action: string): string => action.slice(action.indexOf(".") + 1);

// ---- vocabularies of Cloud's ledger and of the core ------------------------------------------------------------------------------------------------------------------------------

const AUTOMATIC_JOBS = ["nightly", "image_rebuild", "scheduled_check"] as const;
const AUTOMATIC_RUN_END_REASONS = ["project_stopped", "too_old"] as const;
const AUTOMATED_ORIGINS = ["event", "schedule", "chain", "nightly", "automatic"] as const;
const RUN_OUTCOMES = ["succeeded", "cancelled", "failed", "gone"] as const;
const SECOND_REVIEW_SCOPES = ["company", "project"] as const;
const MCP_TASK_STOP_REASONS = ["idle", "lifetime", "disabled", "secret_replaced", "crash", "leftover", "room", "approval_changed", "tools_changed", "failed", "done", "shutdown"] as const;
const SAVED_ENV_CHANGES = [
  "lease_refused", "scan_started", "rebuild_queued", "build_recorded", "build_refused", "build_failed", "marked_stale", "reset_requested", "images_deleted", "project_archived", "project_deleted", "project_registered", "ceiling_walk",
] as const;
const SCRIPT_TOKEN_REVOKERS = ["creator", "admin", "access_changed", "limit", "switch_off"] as const;
const DECISION_WORDS: Readonly<Record<string, string>> = { "decision.approved": "approved", "decision.rejected": "rejected", "decision.changes_requested": "changes_requested" };

// ---- targets -------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const same = (cloud: AuditAction, target: TargetRule, more: Omit<EventMapping, "cloud" | "target"> = {}): EventMapping => ({ cloud, target, ...more });

/**
 * A lesson event's target. The lessons library names the lesson, or, for an event about the whole project (a repository switch, a preset, a rollback, a snapshot), the PROJECT's name in the subject's id.
 * A project's name is personal data: it is a name-keyed target (the appender pseudonymizes it and seals the name in the org's details), never an id the chain would hold in clear.
 */
const lessonTarget = ({ event, details }: MappingContext): AuditTarget | undefined => {
  if (event.subject === undefined || event.subject.id === "") return undefined;
  const project = text(details["project"]);
  return project !== undefined && event.subject.id === project ? { kind: "lesson", name: project.slice(0, 200) } : { kind: "lesson", id: event.subject.id };
};

/**
 * The repository a pull request event names, as one string for both events of a pull request: the repository key (`owner/name`) when the event carries it (`repositoryKey`), else its `repository`. The core's
 * `pull_request.merge_requested` carries the key in `repository`; its `pull_request.opened` carries the repository's id in `repository` and no key (owed upstream: gaps.ts, A7-G1), so the two ids differ until
 * Code adds `repositoryKey` to the opened event. Lower-cased and trimmed, as `auditPullRequestId` does.
 */
export const repositoryOf = (details: JsonObject): string | undefined => {
  const key = text(get(details, "repositoryKey")) ?? text(get(details, "repository"));
  return key === undefined || key.trim() === "" ? undefined : key.trim().toLowerCase();
};
const pullNumber = (details: JsonObject): number | undefined => {
  const raw = get(details, "number");
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : typeof raw === "string" && /^[0-9]{1,9}$/u.test(raw) ? Number(raw) : undefined;
};
const pullRequestTarget = ({ details }: MappingContext): AuditTarget | undefined => {
  const repository = repositoryOf(details);
  const number = pullNumber(details);
  return repository === undefined || number === undefined ? undefined : { kind: "pull_request", id: auditPullRequestId(repository, number) };
};
const pullRequestOrg = { repository: ({ details }: MappingContext): string | undefined => repositoryOf(details) } as const;

// ---- the rows ------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const MCP_ORG = { label: "label" } as const;
const MCP = (cloud: AuditAction, more: Omit<EventMapping, "cloud" | "target"> = {}): EventMapping => same(cloud, { id: "mcp_server" }, more);
const TRANSPORT = oneOf("transport", "http", "stdio");
const SECOND_REVIEW_MODE = (key: string): FactRule => word(key);
const SECOND_REVIEW_COMPANY = { bySubject: { company: { org: true }, project: { org: true } } } as const;

const decision = (action: string): EventMapping => same("approval.decided", ({ event }) => {
  // In the core the request IS the approval: a decision event's id is `approval:<request id>`, and the request id is the approval's id here. A Cloud `approval.requested` is written by Cloud's own approval store and
  // names Cloud's approval id, which a core request does not have, so the two do not link until Cloud's approvals move onto the core (A6); the task the decision is about is a related record meanwhile.
  const id = event.eventId.startsWith("approval:") ? event.eventId.slice("approval:".length) : "";
  return id.length >= 1 && id.length <= 100 && RELATED_ID.test(id) ? { kind: "approval", id } : undefined;
}, {
  facts: { kind: word("kind"), decision: oneOf(() => DECISION_WORDS[action], "approved", "rejected", "changes_requested"), subjectKind: word(subjectType) },
  required: ["decision"], related: ({ event }) => [event.subject?.id],
});

const lesson = (cloud: AuditAction, facts: Record<string, FactRule> = {}): EventMapping => same(cloud, lessonTarget, { facts, org: { project: "project" } });
const TIER = count("tier");

/** Core action to the Cloud event it becomes. Keep it sorted by the core's action. */
export const CORE_AUDIT_EVENT_MAP: Readonly<Record<string, EventMapping>> = {
  // Agents and chains.
  "agent.archived": same("agent.archived", { id: "agent" }),
  "agent.created": same("agent.created", { id: "agent" }),
  "agent.published": same("agent.published", { id: "agent" }, { facts: { version: count("version") } }),
  "agent.unarchived": same("agent.unarchived", { id: "agent" }),
  "chain.archived": same("chain.archived", { id: "chain" }),
  "chain.created": same("chain.created", { id: "chain" }),
  "chain.published": same("chain.published", { id: "chain" }, { facts: { version: count("version") } }),
  "chain.unarchived": same("chain.unarchived", { id: "chain" }),

  // Automatic runs and automation.
  "automatic_run.ended": same("automatic_run.ended", { name: "project" }, { facts: { job: oneOf("job", ...AUTOMATIC_JOBS), cause: oneOf("reason", ...AUTOMATIC_RUN_END_REASONS) } }),
  "automatic_run.started": same("automatic_run.started", { name: "project" }, { facts: { job: oneOf("job", ...AUTOMATIC_JOBS), setupApprovedBy: fact("setupApprovedBy", ID), runsThisMonth: count("runsThisMonth"), cap: count("cap") } }),
  "automatic_runs.cap_changed": same("project.automatic_runs_cap_changed", { name: "project" }, { facts: { fromCap: count("fromCap"), toCap: count("toCap") } }),
  "automatic_runs.paused": same("automatic_runs.paused", { name: "project" }, { facts: { month: fact("month", MONTH), cap: count("cap") } }),
  "automation.run_ended": same("automation.run_ended", { org: true }, { facts: { outcome: oneOf("outcome", ...RUN_OUTCOMES), origin: oneOf("origin", ...AUTOMATED_ORIGINS) }, related: ({ event }) => [event.subject?.id] }),

  // Approvals and settings.
  "decision.approved": decision("decision.approved"),
  "decision.changes_requested": decision("decision.changes_requested"),
  "decision.rejected": decision("decision.rejected"),
  // Cloud's model policy facts are a strict schema: the revision and the two digests. The core's `reviewDefault` and `lessSafe` have no fact here, and `stage` / `mode` belong to Cloud's own flow.
  "model.policy.changed": same("model_policy.changed", { org: true }, { facts: { revision: count("revision"), policyDigest: fact("policyDigest", HEX64), previousDigest: fact("previousDigest", HEX64) }, required: ["revision", "policyDigest"] }),
  // The company's recent sign-in setting (decision 62). Between two windows it is Cloud's `company.approval_window_changed` (whole seconds before and after, a direct change). A change to or from "trust any active
  // company sign-in" has no seconds, so it is Cloud's `company.approval_sign_in_changed` (owner decision 118): the two mode words, the seconds where a side has them, and the revision. Anything else is refused.
  "setting.approval_sign_in_changed": same("company.approval_window_changed", { org: true }, {
    facts: {
      from: count(({ details }) => (get(details, "previous.mode") === "window" ? get(details, "previous.seconds") : undefined)),
      to: count(({ details }) => (get(details, "mode") === "window" ? get(details, "seconds") : undefined)),
      mode: oneOf(() => "direct", "direct"),
      revision: count("revision"),
    },
    required: ["from", "to", "revision"],
    alternate: {
      when: ({ details }) => get(details, "mode") === "any-active" || get(details, "previous.mode") === "any-active",
      mapping: same("company.approval_sign_in_changed", { org: true }, {
        facts: {
          mode: oneOf("mode", "window", "any-active"),
          fromMode: oneOf("previous.mode", "window", "any-active"),
          seconds: count(({ details }) => (get(details, "mode") === "window" ? get(details, "seconds") : undefined)),
          fromSeconds: count(({ details }) => (get(details, "previous.mode") === "window" ? get(details, "previous.seconds") : undefined)),
          revision: count("revision"),
        },
        required: ["mode", "fromMode", "revision"],
      }),
    },
  }),

  // Second review.
  "company.second_review_choice_changed": same("company.second_review_choice_changed", { org: true }, { facts: { change: oneOf("change", "clear", "choose"), count: count("count") } }),
  "company.second_review_context_changed": same("company.second_review_context_changed", { org: true }, { facts: { to: oneOf("to", "change_only", "same_as_first"), widens: flag("widens") } }),
  "company.second_review_mode_cancelled": same("company.second_review_mode_cancelled", SECOND_REVIEW_COMPANY, { facts: { scope: oneOf("scope", ...SECOND_REVIEW_SCOPES), from: SECOND_REVIEW_MODE("from"), to: SECOND_REVIEW_MODE("to"), cause: oneOf("cause", "stale", "withdrawn") } }),
  "company.second_review_mode_changed": same("company.second_review_mode_changed", SECOND_REVIEW_COMPANY, { facts: { scope: oneOf("scope", ...SECOND_REVIEW_SCOPES), from: SECOND_REVIEW_MODE("from"), to: SECOND_REVIEW_MODE("to"), mode: oneOf("mode", "direct", "owner", "second_person", "sole_owner_exception") } }),
  "company.second_review_mode_proposed": same("company.second_review_mode_proposed", SECOND_REVIEW_COMPANY, { facts: { scope: oneOf("scope", ...SECOND_REVIEW_SCOPES), from: SECOND_REVIEW_MODE("from"), to: SECOND_REVIEW_MODE("to") } }),
  "company.second_review_replay_recorded": same("company.second_review_replay_recorded", { org: true }, { facts: { runId: fact("runId", ID), cases: count("cases"), passed: flag("passed") } }),
  "company.second_review_verdict_recorded": same("company.second_review_verdict_recorded", { org: true }, { facts: { model: fact("model", MODEL), runId: fact("runId", ID), days: count("days"), findings: count("findings"), agreed: count("agreed") } }),
  "company.second_review_verdict_withdrawn": same("company.second_review_verdict_withdrawn", { org: true }, { facts: { model: fact("model", MODEL) } }),
  "project.second_review_narrowed": same("project.second_review_narrowed", { name: "project" }, { facts: { change: oneOf("change", "clear", "choose"), count: count("count") } }),
  "task.second_review_acknowledged": same("task.second_review_acknowledged", { id: "task" }, { facts: { cause: word("cause") } }),

  // Connections, MCP servers and Sources.
  "connection.removed": same("connection.removed", { id: "connection" }, { facts: { connectorType: word("connectorType") } }),
  "connection.saved": same("connection.saved", { id: "connection" }, { facts: { connectorType: word("connectorType") } }),
  "context_source.applied": same("context_source.applied", { name: "project" }, { facts: { change: oneOf("change", "set", "remove") }, org: { sourceId: "sourceId" }, related: ({ details }) => [text(get(details, "changeId"))] }),
  "context_source.proposed": same("context_source.proposed", { name: "project" }, { facts: { change: oneOf("change", "set", "remove") }, org: { sourceId: "sourceId" }, related: ({ details }) => [text(get(details, "changeId"))] }),
  "context_source.rejected": same("context_source.rejected", { name: "project" }, { facts: { change: oneOf("change", "set", "remove") }, org: { sourceId: "sourceId" }, related: ({ details }) => [text(get(details, "changeId"))] }),
  "mcp_server.added": MCP("mcp_server.added", { facts: { transport: TRANSPORT, hasCredential: flag("hasToken") }, org: MCP_ORG }),
  "mcp_server.approved": MCP("mcp_server.approved", {
    facts: {
      transport: TRANSPORT, hasCredential: flag("hasToken"), integrity: fact("pin.integrity", INTEGRITY), lockfileHash: fact("pin.lockfileHash", HEX64), bundleHash: fact("pin.bundleHash", HEX64), toolsHash: fact("pin.toolsHash", HEX64),
      destinationCount: count("pin.destinationCount"), credentialCount: count("pin.secretCount"), credentialVersion: fact("pin.secretVersion", ID),
    },
    org: { ...MCP_ORG, destinations: "pin.destinations", secretNames: "pin.secretNames" },
  }),
  "mcp_server.changed_needs_review": MCP("mcp_server.changed_needs_review", { facts: { approvedToolsHash: fact("approved", HEX64), observedToolsHash: fact("observed", HEX64) } }),
  "mcp_server.disabled": MCP("mcp_server.disabled", { facts: { transport: TRANSPORT }, org: MCP_ORG }),
  "mcp_server.egress_updated": MCP("mcp_server.egress_updated", { facts: { added: count("added"), removed: count("removed") }, org: { addresses: "addresses" } }),
  "mcp_server.installed": MCP("mcp_server.installed", {
    facts: {
      package: fact("name", PACKAGE_NAME), version: fact("version", SEMVER), integrity: fact("integrity", INTEGRITY), lockfileHash: fact("lockfileHash", HEX64), bundleHash: fact("bundleHash", HEX64),
      packageCount: count("packageCount"), unpackedBytes: count("unpackedBytes"),
    },
  }),
  "mcp_server.probed": MCP("mcp_server.probed", { facts: { purpose: oneOf("purpose", "proposal", "approval"), toolsHash: fact("toolsHash", HEX64), bundleHash: fact("bundleHash", HEX64), toolCount: count("toolCount") } }),
  "mcp_server.removed": MCP("mcp_server.removed", { facts: { transport: TRANSPORT }, org: MCP_ORG }),
  "mcp_server.task_started": MCP("mcp_server.task_started", { facts: { trigger: oneOf("trigger", "call", "warm") } }),
  "mcp_server.task_stopped": MCP("mcp_server.task_stopped", { facts: { cause: oneOf("reason", ...MCP_TASK_STOP_REASONS) } }),
  "mcp_server.token_changed": MCP("mcp_server.token_changed", { facts: { change: oneOf("change", "stored", "deleted") } }),

  // Playbook, design review, diagnosis.
  "diagnosis.proposed": same("diagnosis.proposed", { id: "diagnosis" }, {
    facts: {
      total: count("total"), dropped: count("dropped"), explain: count("explain"), retryWithNote: count("retryWithNote"), redirect: count("redirect"), settingsChange: count("settingsChange"),
      newTask: count("newTask"), adminSteps: count("adminSteps"), contactSupport: count("contactSupport"),
    },
  }),
  "diagnosis.started": same("diagnosis.started", { id: "diagnosis" }, { facts: { errorKind: word("errorKind"), errorCode: fact("errorCode", CODE), tier: oneOf("tier", "light", "deep") } }),
  "playbook.design_review_changed": same("playbook.design_review_changed", { name: "project" }, {
    facts: {
      revision: count("revision"), mode: oneOf("mode", "auto", "always", "never"), tier: oneOf("tier", "light", "standard", "thorough"), allowSkip: flag("allowSkip"), capCents: count("capCents"),
      approverKind: oneOf("approverKind", "maintainers", "people", "group"), approverCount: count("approverCount"),
    },
  }),
  "playbook.file_changed": same("playbook.file_changed", { name: "project" }, { facts: { revision: count("revision"), filePresent: flag("filePresent") } }),

  // Pull requests. The repository's name is the org's detail (sealed), never a fact or the id.
  "pull_request.merge_requested": same("pull_request.merge_requested", pullRequestTarget, {
    facts: { number: fact(({ details }) => pullNumber(details), COUNT), method: oneOf("method", "squash", "merge", "rebase") }, org: pullRequestOrg, related: ({ details }) => [text(get(details, "requestId"))],
  }),
  "pull_request.opened": same("pull_request.opened", pullRequestTarget, { facts: { number: fact(({ details }) => pullNumber(details), COUNT) }, org: pullRequestOrg, related: taskRelated }),
  // Written by the core's merge tracking since the 0.5.17 pin (public PR #493): the repository in `details` is already the key (`owner/name`), so its id matches the other two events of the pull request. The host's login for who merged stays out (an unmapped detail).
  "pull_request.merged": same("pull_request.merged", pullRequestTarget, { facts: { number: fact(({ details }) => pullNumber(details), COUNT) }, org: pullRequestOrg, related: taskRelated }),

  // Saved project images: one ledger event for the registry's changes, one for the setting.
  ...Object.fromEntries(SAVED_ENV_CHANGES.map((change) => [`saved_env.${change}`, same("saved_env.changed", { name: "project" }, {
    facts: { change: oneOf(() => suffix(`saved_env.${change}`), ...SAVED_ENV_CHANGES), cause: fact("cause", { pattern: /^[a-z][a-z0-9_-]{0,59}$/u }), digest: fact("digest", IMAGE_DIGEST), count: count("count") },
  })])),
  "saved_env.setting_changed": same("saved_env.setting_changed", { name: "project" }, { facts: { enabled: flag("enabled") } }),

  // Script tokens. The token's owner (on a revoke) and the task a token started (on a use) are related records, as Cloud's own writers record them.
  "script_token.created": same("script_token.created", { id: "script_token" }, { facts: { days: count("days"), projects: count("projects"), permissions: fact("permissions", { pattern: /^[a-z_]{1,24}(,[a-z_]{1,24}){0,4}$/u }) } }),
  "script_token.revoked": same("script_token.revoked", { id: "script_token" }, { facts: { by: oneOf("by", ...SCRIPT_TOKEN_REVOKERS) }, related: ({ details }) => [text(get(details, "related"))] }),
  "script_token.used": same("script_token.used", { id: "script_token" }, { facts: { day: fact("day", DAY), permission: fact("permission", { pattern: /^[a-z_]{1,24}$/u }) }, related: ({ details }) => [text(get(details, "related"))] }),

  // Sessions and tasks. The core records no fact for these; the Cloud keys (`sessionKind`, `branch`, `audience`...) are left empty rather than guessed.
  "session.closed": same("session.closed", { id: "session" }),
  "session.message_sent": same("session.message_sent", { id: "session" }),
  "session.retried": same("session.retried", { id: "session" }),
  "session.stopped": same("session.stopped", { id: "session" }),
  "task.asked": same("task.asked", { id: "session" }),
  "task.closed": same("task.closed", { id: "task" }, { org: { project: "project" } }),
  "task.start_refused": same("task.start_refused", { id: "task" }, { facts: { code: fact("code", CODE) }, org: { project: "project" } }),
  "task.started": same("task.started", { id: "task" }, { facts: { workflow: flag("workflow"), path: oneOf("path", "QUICK", "FULL") }, org: { project: "project" } }),
  "trigger.enabled": same("trigger.enabled", { id: "trigger" }),

  // Lessons: the library already names its ledger events as Cloud does (vendor/.../lessons/audit-sink.ts), with the Cloud fact keys, after its own word filter; each fact is checked again here. The project's name goes in
  // the org's details.
  "lesson.activated": lesson("lesson.activated", { lessonType: word("lessonType"), tier: TIER, auto: flag("auto") }),
  "lesson.approved": lesson("lesson.approved", { tier: TIER, approvals: count("approvals"), soleOwner: flag("soleOwner") }),
  "lesson.edited": lesson("lesson.edited", { tier: TIER, fromTier: count("fromTier") }),
  "lesson.expired": lesson("lesson.expired", { tier: TIER }),
  "lesson.model_set": lesson("lesson.model_set", { fromModel: fact("fromModel", MODEL), toModel: fact("toModel", MODEL) }),
  "lesson.preset_changed": lesson("lesson.preset_changed", { scope: oneOf("scope", "project", "company"), fromPreset: word("fromPreset"), toPreset: word("toPreset"), mode: word("mode") }),
  "lesson.preset_proposed": lesson("lesson.preset_proposed", { scope: oneOf("scope", "project", "company"), fromPreset: word("fromPreset"), toPreset: word("toPreset") }),
  "lesson.promoted": lesson("lesson.promoted", { tier: TIER }),
  "lesson.proposed": lesson("lesson.proposed", { lessonType: word("lessonType"), tier: TIER }),
  "lesson.refused": lesson("lesson.refused", { refusal: word("refusal") }),
  "lesson.rejected": lesson("lesson.rejected", { tier: TIER }),
  "lesson.replay_read": lesson("lesson.replay_read", { operator: fact("operator", OPERATOR), what: oneOf("what", "subject", "settings", "model_grade", "model_learn"), maxCents: count("maxCents"), target: fact("target", ID) }),
  "lesson.replay_started": lesson("lesson.replay_started", { operator: fact("operator", OPERATOR), memory: oneOf("memory", "off", "snapshot"), snapshotLessons: count("snapshotLessons"), maxCents: count("maxCents"), sourceTask: fact("sourceTask", ID) }),
  "lesson.repo_file_pr_closed": lesson("lesson.repo_file_pr_closed", { cause: word("cause"), pullRequest: count("pullRequest") }),
  "lesson.repo_file_pr_opened": lesson("lesson.repo_file_pr_opened", { removals: count("removals"), edits: count("edits"), adds: count("adds") }),
  "lesson.local_tools_switched": lesson("lesson.local_tools_switched", { scope: oneOf("scope", "project", "company"), enabled: flag("enabled") }),
  "lesson.repo_file_retire_decided": lesson("lesson.repo_file_retire_decided", { verdict: oneOf("verdict", "retire", "keep"), missing: count("missing") }),
  "lesson.repo_file_switched": lesson("lesson.repo_file_switched", { enabled: flag("enabled") }),
  "lesson.retire_requested": lesson("lesson.retire_requested", { pullRequest: count("pullRequest") }),
  "lesson.retired": lesson("lesson.retired", { cause: word("cause"), tier: TIER }),
  "lesson.rolled_back": lesson("lesson.rolled_back", { fromSetVersion: count("fromSetVersion"), toSetVersion: count("toSetVersion") }),
  "lesson.snapshot_created": lesson("lesson.snapshot_created", { lessonSetVersion: count("lessonSetVersion"), lessonCount: count("lessonCount") }),
  "lesson.sole_owner_switch_changed": lesson("lesson.sole_owner_switch_changed", { fromEnabled: flag("fromEnabled"), toEnabled: flag("toEnabled"), mode: word("mode") }),
  "lesson.sole_owner_switch_proposed": lesson("lesson.sole_owner_switch_proposed", { fromEnabled: flag("fromEnabled"), toEnabled: flag("toEnabled") }),
  "lesson.tier0_setting_changed": lesson("lesson.tier0_setting_changed", { scope: oneOf("scope", "project", "company"), fromLevel: word("fromLevel"), toLevel: word("toLevel"), mode: word("mode") }),
  "lesson.tier0_setting_proposed": lesson("lesson.tier0_setting_proposed", { scope: oneOf("scope", "project", "company"), fromLevel: word("fromLevel"), toLevel: word("toLevel") }),
  "lesson.trial_stable": lesson("lesson.trial_stable", { tier: TIER }),
  "lesson.withdrawn": lesson("lesson.withdrawn", { cause: word("cause") }),
};

/**
 * Core events that only Rovara Code's own local runtime (`rovara up`, the laptop) records, and that Cloud never runs: they have NO Cloud ledger event, on purpose (owner decision: the laptop and Cloud are
 * separate use cases). The scan still lists them (the strict "every core event is accounted for" check stays); in Cloud the sink REFUSES one and logs a wiring fault (`audit.record_invalid`, reason `laptop_only`,
 * already alarmed), and writes no ledger row. An event listed here must not also be in `CORE_AUDIT_EVENT_MAP` (a test fails if it is: mapping it again is a decision, not an edit).
 */
export const LAPTOP_ONLY_CORE_EVENTS: Readonly<Record<string, string>> = {
  "test_services.image_approved": "the owner's test-service image list (local/test-services-owner-list.ts), a `rovara up` page; Cloud's company images are a separate, admin-approved list",
  "test_services.image_removed": "the owner's test-service image list (local/test-services-owner-list.ts), a `rovara up` page; Cloud's company images are a separate, admin-approved list",
};

/** The Cloud action a core action becomes, or undefined when the map has none. */
export function cloudActionOf(coreAction: string): AuditAction | undefined {
  return Object.hasOwn(CORE_AUDIT_EVENT_MAP, coreAction) ? CORE_AUDIT_EVENT_MAP[coreAction]!.cloud : undefined;
}

/** The core actions with no entry in `map` and not listed as laptop-only (both default to the real tables; a test passes a map with an entry dropped). */
export function unmappedCoreActions(coreActions: Iterable<string>, map: Readonly<Record<string, EventMapping>> = CORE_AUDIT_EVENT_MAP, laptopOnly: Readonly<Record<string, string>> = LAPTOP_ONLY_CORE_EVENTS): string[] {
  return [...new Set(coreActions)].filter((action) => !Object.hasOwn(map, action) && !Object.hasOwn(laptopOnly, action)).sort();
}
