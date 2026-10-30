// "How we work" (H3): a project's process layer. It is a project-owned custom agent marked `purpose: "process"` that extends Rovara Code and is edited through "How we work",
// never chosen as an agent. `POST /v1/app/projects/{p}/playbook/process` makes sure the project has exactly one; the first version it publishes makes the playbook point at it.
import {
  AGENT_NAME_MAX,
  ROVARA_CODE_AGENT_ID,
  agentXError,
  projectAllows,
  type AgentId,
  type OrgId,
  type ProjectPlaybook,
} from "@agentx/contracts";
import type { AgentRecord, AgentStore } from "../agents/store.js";
import { requireBaseEnabled } from "../agents/guardrails.js";
import { readProjectPlaybook, readProjectPlaybookWrittenAt, writeProjectPlaybook, type ProjectPlaybookWriter } from "./project-playbook-store.js";
import type { ProjectPlaybookDependencies } from "./routes.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";

/** Fixed words: a process layer's description is never the user's. */
export const PROCESS_LAYER_DESCRIPTION = "How Rovara Code works in this project.";
const MAINTAINERS_ONLY = "only a project maintainer can change how the project works";

/** What the process layer needs of the agent store. */
export type ProcessLayerStore = Pick<AgentStore, "get" | "getVersion" | "list" | "create">;

export interface ProcessLayerAnswer {
  agentId: AgentId;
  draftRevision: number;
  currentVersion?: number;
}

const answerOf = (agent: AgentRecord): ProcessLayerAnswer => ({
  agentId: agent.agentId, draftRevision: agent.draftRevision, ...(agent.currentVersion === undefined ? {} : { currentVersion: agent.currentVersion }),
});

/** The project's process layer, if it has one: the one its playbook points at, else any process layer it owns (a draft not yet published). */
export async function existingLayer(deps: ProjectPlaybookDependencies, store: ProcessLayerStore, orgId: OrgId, project: string): Promise<AgentRecord | undefined> {
  const { defaultProcess } = await readProjectPlaybook(deps, orgId, project, { lenient: true });
  if (defaultProcess.kind === "project_process") {
    const pointed = await store.get(orgId, defaultProcess.agentId);
    if (pointed !== undefined && pointed.purpose === "process" && pointed.owner.kind === "project" && pointed.owner.project === project) return pointed;
  }
  const owned = (await store.list(orgId)).filter((agent) => agent.purpose === "process" && agent.owner.kind === "project" && agent.owner.project === project);
  return owned.find((agent) => agent.status === "active") ?? owned[0];
}

/**
 * `POST /v1/app/projects/{p}/playbook/process` [`edit_settings`]: idempotently ensures the project has one process layer and answers it. A new layer is a draft custom agent
 * that extends the version of Rovara Code the company has adopted (as "Build on Rovara Code" does), with an empty overlay. Two calls at once make one layer: the agent's name is
 * unique in the company, so the second create is refused and finds the first.
 */
export async function postProjectProcess(deps: ProjectPlaybookDependencies, caller: DeveloperCaller, rawProject: string): Promise<ProcessLayerAnswer> {
  const found = await deps.projectFor(caller, rawProject);
  if (!projectAllows(found.role, "edit_settings")) throw agentXError("FORBIDDEN", MAINTAINERS_ONLY);
  const store = deps.store as ProcessLayerStore | undefined;
  if (store === undefined || typeof store.create !== "function") throw agentXError("NOT_FOUND", "agents are not set up in this deployment");
  const { orgId } = caller;
  const project = found.name;
  const present = await existingLayer(deps, store, orgId, project);
  if (present !== undefined) return answerOf(present);
  await requireBaseEnabled({ ...deps, store }, orgId, ROVARA_CODE_AGENT_ID);
  try {
    const created = await store.create({
      orgId, name: `${project} process`.slice(0, AGENT_NAME_MAX).trim(), description: PROCESS_LAYER_DESCRIPTION, owner: { kind: "project", project },
      accountable: { developerId: caller.developerId }, extends: ROVARA_CODE_AGENT_ID, overlay: {}, purpose: "process", createdBy: caller.developerId,
    });
    return answerOf(created);
  } catch (error) {
    // Lost the race: the other call made the layer in one transaction, so it is there now.
    const winner = await existingLayer(deps, store, orgId, project);
    if (winner !== undefined) return answerOf(winner);
    throw error;
  }
}

/**
 * The hook after a process layer's FIRST version is published (the publish, immediate or confirmed): the project's playbook points at it. It is written right after the publish
 * with the document's revision (the publish transaction is the agent store's, so the two cannot be one); a stale revision is read again, a few times. The playbook is left alone
 * when it already points at this layer, and for any later version: a maintainer who set the project back to the built-in is not switched again by a new version.
 *
 * `repair` is the same hook asked again for a version 1 published earlier (a no-op republish, or a confirmation driven again), to mend a playbook write lost with the broker. It
 * writes only when nobody has written the playbook since version 1 was published: the document is absent, or was last written before `repair.publishedAt`. Otherwise a
 * maintainer may have set the project back to the built-in since, and that choice stands (final review I1).
 */
export async function pointPlaybookAtFirstVersion(
  deps: ProjectPlaybookWriter, agent: Pick<AgentRecord, "orgId" | "agentId" | "purpose" | "owner">, version: number, developerId: string, repair?: { publishedAt: string; /** Run just before a repair writes: it refuses (nothing is written) when the version must not become effective. */ before?: () => Promise<void> },
): Promise<ProjectPlaybook | undefined> {
  if (agent.purpose !== "process" || version !== 1 || agent.owner.kind !== "project") return undefined;
  const project = agent.owner.project;
  for (let attempt = 0; ; attempt += 1) {
    const current = await readProjectPlaybook(deps, agent.orgId, project, { lenient: true });
    if (current.defaultProcess.kind === "project_process" && current.defaultProcess.agentId === agent.agentId) return current;
    // Read after the playbook: a write in between shows here as a later time, and the conditional write below refuses one after it.
    if (repair !== undefined && !writtenBefore(await readProjectPlaybookWrittenAt(deps, agent.orgId, project), repair.publishedAt)) return undefined;
    await repair?.before?.();
    try {
      return await writeProjectPlaybook(deps, { orgId: agent.orgId, project, developerId, expectedRevision: current.revision, defaultProcess: { kind: "project_process", agentId: agent.agentId } });
    } catch (error) {
      if ((error as { code?: string }).code !== "PLAYBOOK_STALE" || attempt >= 2) throw error;
    }
  }
}

/** Whether the playbook was never written, or last written strictly before `publishedAt`. A document without a readable time counts as written since: it is left alone. */
function writtenBefore(written: Awaited<ReturnType<typeof readProjectPlaybookWrittenAt>>, publishedAt: string): boolean {
  if (!written.exists) return true;
  const at = written.updatedAt === undefined ? Number.NaN : Date.parse(written.updatedAt);
  const published = Date.parse(publishedAt);
  return Number.isFinite(at) && Number.isFinite(published) && at < published;
}
