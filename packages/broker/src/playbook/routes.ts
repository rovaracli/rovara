// "How we work" (H2): `GET` and `PUT /v1/app/projects/{p}/playbook`. Anyone who can see the project reads it; the PUT needs `edit_settings` (a maintainer), as the project's code
// settings do, and the revision the caller read. The project is found through `projectFor`, so another org's project and one the caller has no role in answer the same 404.
import {
  ProjectPlaybookBodySchema,
  agentXError,
  projectAllows,
  type AgentId,
  type HowWeWorkView,
  type ProjectPlaybookResponse,
  type ProjectRole,
} from "@agentx/contracts";
import type { ApprovalDependencies } from "../agents/approvals.js";
import { assertStoredVersionModelsResolvable } from "../agents/changes.js";
import type { AuditRuntime } from "../audit/outbox.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { StatusReply } from "../aws/status-reply.js";
import { computeHowWeWork, type HowWeWorkDependencies } from "./effective.js";
import { postProjectProcess } from "./process-layer.js";
import { readProjectPlaybook, writeProjectPlaybook } from "./project-playbook-store.js";
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
  /** The caller's role in the project: the project's name, or the one `PROJECT_NOT_FOUND` for no access, no such project and another org's. */
  projectFor(caller: DeveloperCaller, rawName: string): Promise<{ name: string; role: ProjectRole }>;
}

const MAINTAINERS_ONLY = "only a project maintainer can change how the project works";

/** `GET /v1/app/projects/{p}/playbook`: to anyone who can see the project. */
export async function getProjectPlaybook(deps: ProjectPlaybookDependencies, caller: DeveloperCaller, rawProject: string): Promise<ProjectPlaybookResponse> {
  const { name } = await deps.projectFor(caller, rawProject);
  return { playbook: await readProjectPlaybook(deps, caller.orgId, name, { lenient: true }) };
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
  const { expectedRevision, defaultProcess } = parsed.data;
  let ifLayer: { agentId: AgentId; version: number } | undefined;
  if (defaultProcess.kind === "project_process") {
    const version = await requireProcessLayer(deps.store, caller.orgId, found.name, defaultProcess.agentId);
    // The layer's current version becomes what the project runs, so lane C's model check runs on it as for a publish (a refusal is a ProcessModelRefusal). Without the approvals (agents not set up) nothing is checked.
    if (deps.approvals !== undefined) await assertStoredVersionModelsResolvable(deps.approvals, caller, defaultProcess.agentId, version);
  } else {
    // A switch back to the built-in that drops something stricter waits for a second person (follow-up M2).
    const decision = await holdBuiltinSwitch(deps, caller, found.name, expectedRevision);
    if (decision.held !== undefined) return decision.held;
    ifLayer = decision.ifLayer;
  }
  const playbook = await writeProjectPlaybook(deps, { orgId: caller.orgId, project: found.name, developerId: caller.developerId, expectedRevision, defaultProcess, ...(ifLayer === undefined ? {} : { ifLayer }) });
  return new StatusReply(200, { playbook } satisfies ProjectPlaybookResponse);
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
