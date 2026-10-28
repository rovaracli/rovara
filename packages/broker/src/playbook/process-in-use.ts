// "How we work" follow-up (F1 fix round 1, I2): a project's process layer can't be archived while it is the project's default process. Archiving is one maintainer's action, and an archived layer
// stops the project's work; archiving the layer and then switching to the built-in would be a way round the second person the switch needs when the layer is stricter (process-switch.ts).
// F2: a playbook document that exists but can't be read could be pointing at the layer, so it holds the archive too (a missing one does not).
import { PROCESS_IN_USE_MESSAGE, agentXError } from "@agentx/contracts";
import type { AgentRecord } from "../agents/store.js";
import { readProjectPlaybookState, type ProjectPlaybookReader } from "./project-playbook-store.js";

/** Refuses (`PROCESS_IN_USE`, 409) archiving a process layer the project's playbook points at, or may point at (an unreadable document). Any other agent, and a layer the playbook does not point at, pass. */
export async function requireNotCurrentProcess(deps: ProjectPlaybookReader, agent: Pick<AgentRecord, "orgId" | "agentId" | "purpose" | "owner">): Promise<void> {
  if (agent.purpose !== "process" || agent.owner.kind !== "project") return;
  const { playbook, unreadable } = await readProjectPlaybookState(deps, agent.orgId, agent.owner.project);
  const { defaultProcess } = playbook;
  if (unreadable || (defaultProcess.kind === "project_process" && defaultProcess.agentId === agent.agentId)) throw agentXError("PROCESS_IN_USE", PROCESS_IN_USE_MESSAGE);
}
