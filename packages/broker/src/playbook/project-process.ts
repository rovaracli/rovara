// "How we work" (H2): which process a project runs. `projectProcessOf` is what the start of work asks. The project's process layer is a project-owned custom agent marked
// `purpose: "process"`; the document points at it. A pointer that no longer holds (archived, deleted, moved, unpublished) is `PROCESS_UNAVAILABLE`: work for the project does not
// quietly run on the built-in instead.
import { PROCESS_UNAVAILABLE_MESSAGE, ROVARA_CODE_AGENT_ID, agentXError, type AgentId, type OrgId } from "@agentx/contracts";
import type { AgentRecord } from "../agents/store.js";
import { readProjectPlaybook, type ProjectPlaybookReader } from "./project-playbook-store.js";

/** The one thing the playbook needs of the agent store: an agent's record, or nothing. */
export interface ProcessAgentReader {
  get(orgId: OrgId, agentId: AgentId): Promise<AgentRecord | undefined>;
}

export interface ProjectProcessDependencies extends ProjectPlaybookReader {
  /** Absent where agents are not set up: no process layer can be used there. */
  store: ProcessAgentReader | undefined;
}

export type ProjectProcess =
  | { kind: "builtin"; agentId: typeof ROVARA_CODE_AGENT_ID }
  | { kind: "project_process"; agentId: AgentId; version: number };

const unavailable = () => agentXError("PROCESS_UNAVAILABLE", PROCESS_UNAVAILABLE_MESSAGE);

/**
 * The agent's current version when it can be the process of `project`: it exists in the org, belongs to this project, is marked as a process, is active and has a published
 * version. Otherwise `PROCESS_UNAVAILABLE`, with the same words whatever the reason.
 */
export async function requireProcessLayer(store: ProcessAgentReader | undefined, orgId: OrgId, project: string, agentId: AgentId): Promise<number> {
  const agent = await store?.get(orgId, agentId);
  if (agent === undefined || agent.owner.kind !== "project" || agent.owner.project !== project || agent.purpose !== "process" || agent.status !== "active" || agent.currentVersion === undefined) throw unavailable();
  return agent.currentVersion;
}

/** The process `project` runs: the built-in Rovara Code unless its playbook points at a process layer. */
export async function projectProcessOf(deps: ProjectProcessDependencies, orgId: OrgId, project: string): Promise<ProjectProcess> {
  const { defaultProcess } = await readProjectPlaybook(deps, orgId, project);
  if (defaultProcess.kind === "builtin") return { kind: "builtin", agentId: ROVARA_CODE_AGENT_ID };
  const version = await requireProcessLayer(deps.store, orgId, project, defaultProcess.agentId);
  return { kind: "project_process", agentId: defaultProcess.agentId, version };
}
