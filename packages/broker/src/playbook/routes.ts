// "How we work" (H2): `GET` and `PUT /v1/app/projects/{p}/playbook`. Anyone who can see the project reads it; the PUT needs `edit_settings` (a maintainer), as the project's code
// settings do, and the revision the caller read. The project is found through `projectFor`, so another org's project and one the caller has no role in answer the same 404.
import {
  ProjectPlaybookBodySchema,
  agentXError,
  designReviewSettingOf,
  featureEnabled,
  projectAllows,
  type AgentId,
  type EditionPolicy,
  type HowWeWorkView,
  type OrgId,
  type ProjectPlaybook,
  type ProjectPlaybookResponse,
  type ProjectRole,
} from "@agentx/contracts";
import type { ApprovalDependencies } from "../agents/approvals.js";
import { assertStoredVersionModelsResolvable, pointerModelGuards } from "../agents/changes.js";
import type { AuditRuntime, TransactItem } from "../audit/outbox.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { StatusReply } from "../aws/status-reply.js";
import { designReviewAvailableFor, designReviewEnabled } from "../design-review/switch.js";
import { checkDesignReviewWrite, effectiveDesignReviewSetting, lockedFields, readDesignReviewCompany, readDesignReviewLock, type DesignReviewCompanyRead } from "../design-review/lock.js";
import { computeHowWeWork, type HowWeWorkDependencies } from "./effective.js";
import { postProjectProcess } from "./process-layer.js";
import { DESIGN_REVIEW_GROUP_EDITION, DESIGN_REVIEW_LOCKED, DESIGN_REVIEW_LOCK_UNREADABLE, readProjectPlaybook, writeProjectPlaybook } from "./project-playbook-store.js";
import { registerPlaybookApprovals } from "./process-switch-approval.js";
import { holdBuiltinSwitch, type SwitchAgentStore } from "./process-switch.js";
import { requireProcessLayer } from "./project-process.js";

// Loading this module registers what confirming a switch back to the built-in does (the agent routes register the rest of the approvals).
registerPlaybookApprovals();

/** The path this module owns under `/v1/app/projects/`. */
export const PLAYBOOK_PATH = /^\/v1\/app\/projects\/([^/]+)\/playbook$/;
/** `POST` here makes sure the project has its process layer (process-layer.ts). */
export const PLAYBOOK_PROCESS_PATH = /^\/v1\/app\/projects\/([^/]+)\/playbook\/process$/;

/** `GET` here is the effective view of the project's process (effective.ts). */
export const HOW_WE_WORK_PATH = /^\/v1\/app\/projects\/([^/]+)\/how-we-work$/;
export type { HowWeWorkDependencies };

export interface ProjectPlaybookDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  store: SwitchAgentStore | undefined;
  audit?: AuditRuntime | undefined;
  /** The approvals: a switch back to the built-in that loses something waits for a second person (process-switch.ts). Absent where agents are not set up. */
  approvals?: ApprovalDependencies | undefined;
  /**
   * The install's edition policy. The design review setting may name a group as its high-risk approver only where the edition has groups (Enterprise); absent, groups are refused (fail closed).
   * Wiring pending: the dependency builder (a hot file) passes the install's policy.
   */
  edition?: EditionPolicy | undefined;
  /**
   * Who may be named as the high-risk approver in a project: its maintainers and members whose role can approve, never an Auditor or a viewer. When present, a setting that names anyone else is refused
   * (store). Wiring pending: the dependency builder (a hot file) passes it.
   */
  namedApproverCandidates?: ((orgId: OrgId, project: string) => Promise<readonly string[]>) | undefined;
  /** The caller's role in the project: the project's name, or the one `PROJECT_NOT_FOUND` for no access, no such project and another org's. */
  projectFor(caller: DeveloperCaller, rawName: string): Promise<{ name: string; role: ProjectRole }>;
}

const MAINTAINERS_ONLY = "only a project maintainer can change how the project works";

/**
 * The playbook as a person is shown it, for GET and for the answer to PUT alike (money N7): the design review setting the project RUNS with, held to the company's lock, with the locked fields named. A lock that
 * cannot be read (or a read that fails) is never "no lock". The stored document is untouched by this; a client that saves again sends only the fields it changed.
 */
async function playbookView(deps: ProjectPlaybookDependencies, orgId: OrgId, playbook: ProjectPlaybook, project: string): Promise<ProjectPlaybookResponse> {
  void project;
  // OFF reading (the safer one): where the design review stage does not exist (`dr` off) the answer is exactly what it was before the stage existed: the playbook without a design review setting, no lock list, no groups
  // flag and no company word, and nothing is read. The stored setting is kept untouched; it shows again when the stage is on.
  if (!designReviewEnabled()) {
    const { designReview: _kept, ...plain } = playbook;
    void _kept;
    return { playbook: plain };
  }
  const company: DesignReviewCompanyRead = await readDesignReviewCompany(deps, orgId).catch((): DesignReviewCompanyRead => ({ lock: { kind: "unreadable" }, policy: { allowed: false }, policyUnreadable: true, revision: undefined }));
  // `dr` is on but design review is not available for the company (DR-FU4): not allowed, or its stored rules cannot be read (fail closed to off): the setting is not shown or edited, and the page says why from this one flag.
  if (!company.policy.allowed || company.lock.kind === "unreadable") {
    const { designReview: _kept, ...plain } = playbook;
    void _kept;
    return { playbook: plain, designReviewAllowed: false };
  }
  // Groups can be named as the high-risk approver only where the edition has them (Enterprise): the page offers the choice from this flag alone.
  const groups = deps.edition !== undefined && featureEnabled(deps.edition, "groups") ? { designReviewGroups: true as const } : {};
  const { lock } = company;
  // What the project RUNS with: its own setting, or Off when it has none, held to the lock.
  const held = effectiveDesignReviewSetting(playbook, lock);
  const locked = lock.kind === "lock" ? lockedFields(lock.lock) : [];
  return { playbook: { ...playbook, designReview: { ...held, highRiskApprover: { ...held.highRiskApprover } } }, designReviewAllowed: true, ...(locked.length === 0 ? {} : { designReviewLocked: locked }), ...groups };
}

/** `GET /v1/app/projects/{p}/playbook`: to anyone who can see the project. */
export async function getProjectPlaybook(deps: ProjectPlaybookDependencies, caller: DeveloperCaller, rawProject: string): Promise<ProjectPlaybookResponse> {
  const { name } = await deps.projectFor(caller, rawProject);
  return playbookView(deps, caller.orgId, await readProjectPlaybook(deps, caller.orgId, name, { lenient: true }), name);
}

/**
 * `PUT /v1/app/projects/{p}/playbook`. A maintainer sets the project's default process under the revision they read (`PLAYBOOK_STALE` for another). A `project_process` must be
 * one of this project's own published, active process layers (`PROCESS_UNAVAILABLE`). The built-in applies at once unless the project's process layer is stricter than it: then `202`, and a
 * second person confirms (process-switch.ts).
 */
export async function putProjectPlaybook(deps: ProjectPlaybookDependencies, caller: DeveloperCaller, rawProject: string, rawBody: unknown): Promise<StatusReply> {
  const found = await deps.projectFor(caller, rawProject);
  if (!projectAllows(found.role, "edit_settings")) throw agentXError("FORBIDDEN", MAINTAINERS_ONLY);
  const parsed = ProjectPlaybookBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Field names only: the values are the caller's.
    const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
    throw agentXError("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
  }
  const { expectedRevision, defaultProcess, designReview } = parsed.data;
  // Where the design review stage does not exist (`dr` off, or the company has not allowed it), the route takes no design review setting, as before the stage existed (the same words as any field it does not take).
  if (designReview !== undefined && !(await designReviewAvailableFor(deps, caller.orgId))) throw agentXError("CONFIG_INVALID", "designReview: has a field this route does not take");
  // A design review setting is held to the company's lock BEFORE anything is written: a project can never loosen it (a stricter value is fine). A lock that is there but unreadable refuses the write.
  if (designReview !== undefined) {
    const check = checkDesignReviewWrite(designReview, await readDesignReviewLock(deps, caller.orgId), deps.edition);
    if (!check.ok) {
      if (check.reason === "locked") throw agentXError("CONFIG_INVALID", `${check.fields.join(", ")}: ${DESIGN_REVIEW_LOCKED}`);
      throw agentXError("CONFIG_INVALID", `designReview: ${check.reason === "group_not_available" ? DESIGN_REVIEW_GROUP_EDITION : DESIGN_REVIEW_LOCK_UNREADABLE}`);
    }
  }
  // A switch back to the built-in can wait for a second person (below), and what waits is only the switch: a design review setting riding on it would be lost. Said at once, nothing is written or opened.
  if (designReview !== undefined && defaultProcess.kind === "builtin" && (await readProjectPlaybook(deps, caller.orgId, found.name, { lenient: true })).defaultProcess.kind !== "builtin") {
    throw agentXError("CONFIG_INVALID", "designReview: change the process first, then save the design review setting");
  }
  let ifLayer: { agentId: AgentId; version: number } | undefined;
  let guards: readonly TransactItem[] | undefined;
  if (defaultProcess.kind === "project_process") {
    const version = await requireProcessLayer(deps.store, caller.orgId, found.name, defaultProcess.agentId);
    // The layer's current version becomes what the project runs, so lane C's model check runs on it as for a publish (a refusal is a ProcessModelRefusal). Without the approvals (agents not set up) nothing is checked.
    // The write then commits only while the layer is still at that version and the policy, sources and authority the check read still hold (C53: PLAYBOOK_STALE otherwise).
    ifLayer = { agentId: defaultProcess.agentId, version };
    if (deps.approvals !== undefined) guards = pointerModelGuards(deps.approvals, caller.orgId, await assertStoredVersionModelsResolvable(deps.approvals, caller, defaultProcess.agentId, version));
  } else {
    // A switch back to the built-in that drops something stricter waits for a second person (follow-up M2).
    const decision = await holdBuiltinSwitch(deps, caller, found.name, expectedRevision);
    if (decision.held !== undefined) return decision.held;
    ifLayer = decision.ifLayer;
  }
  const playbook = await writeProjectPlaybook(deps, { orgId: caller.orgId, project: found.name, developerId: caller.developerId, expectedRevision, defaultProcess, ...(designReview === undefined ? {} : { designReview }), ...(ifLayer === undefined ? {} : { ifLayer }), ...(guards === undefined ? {} : { guards }) });
  return new StatusReply(200, await playbookView(deps, caller.orgId, playbook, found.name) satisfies ProjectPlaybookResponse);
}

/** `POST /v1/app/projects/{p}/playbook/process`: 200 with the project's process layer (made now, or the one it already had). */
export async function routeProjectProcess(deps: ProjectPlaybookDependencies, caller: DeveloperCaller, rawProject: string): Promise<StatusReply> {
  return new StatusReply(200, await postProjectProcess(deps, caller, rawProject));
}

/** Routes one request on `PLAYBOOK_PATH`; the caller has matched the path and the method (GET or PUT). */
export async function routeProjectPlaybook(deps: ProjectPlaybookDependencies, caller: DeveloperCaller, method: "GET" | "PUT", rawProject: string, body: () => unknown): Promise<StatusReply | ProjectPlaybookResponse> {
  return method === "GET" ? getProjectPlaybook(deps, caller, rawProject) : putProjectPlaybook(deps, caller, rawProject, body());
}

/** `GET /v1/app/projects/{p}/how-we-work`: the project's process as stages, every value marked with where it comes from. To anyone who can see the project; nothing is written. */
export async function getProjectHowWeWork(deps: HowWeWorkDependencies, caller: DeveloperCaller, rawProject: string): Promise<HowWeWorkView> {
  const { name } = await deps.projectFor(caller, rawProject);
  return computeHowWeWork(deps, caller.orgId, name);
}
