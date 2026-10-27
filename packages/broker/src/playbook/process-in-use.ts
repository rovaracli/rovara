// "How we work" follow-up (F1 fix round 1, I2): a project's process layer can't be archived while it is the project's default process. Archiving is one maintainer's action, and an archived layer
// stops the project's work; archiving the layer and then switching to the built-in would be a way round the second person the switch needs when the layer is stricter (process-switch.ts).
import { PROCESS_IN_USE_MESSAGE, agentXError } from "@agentx/contracts";
import type { AgentRecord } from "../agents/store.js";
import { readProjectPlaybook, type ProjectPlaybookReader } from "./project-playbook-store.js";

/** Refuses (`PROCESS_IN_USE`, 409) archiving a process layer the project's playbook points at. Any other agent, and a layer the playbook does not point at, pass. */
export async function requireNotCurrentProcess(deps: ProjectPlaybookReader, agent: Pick<AgentRecord, "orgId" | "agentId" | "purpose" | "owner">): Promise<void> {
  if (agent.purpose !== "process" || agent.owner.kind !== "project") return;
  const { defaultProcess } = await readProjectPlaybook(deps, agent.orgId, agent.owner.project, { lenient: true });
  if (defaultProcess.kind === "project_process" && defaultProcess.agentId === agent.agentId) throw agentXError("PROCESS_IN_USE", PROCESS_IN_USE_MESSAGE);
}
