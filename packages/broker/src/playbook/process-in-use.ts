// "How we work" follow-up (F1 fix round 1, I2): a project's process layer can't be archived while it is the project's default process. Archiving is one maintainer's action, and an archived layer
// stops the project's work; archiving the layer and then switching to the built-in would be a way round the second person the switch needs when the layer is stricter (process-switch.ts).
// F2: a playbook document that exists but can't be read could be pointing at the layer, so it holds the archive too (a missing one does not).
import { PROCESS_IN_USE_MESSAGE, agentXError, projectPlaybookKey } from "@agentx/contracts";
import type { AgentRecord } from "../agents/store.js";
import type { TransactItem } from "../agents/table-writes.js";
import { readProjectPlaybookState, type ProjectPlaybookReader } from "./project-playbook-store.js";

/** What the archive's own transaction must still find: the playbook document as it was read here, and the refusal when it is not. */
export interface ArchiveGuard {
  items: TransactItem[];
  refused: () => Error;
}

const inUse = (): Error => agentXError("PROCESS_IN_USE", PROCESS_IN_USE_MESSAGE);

/**
 * Refuses (`PROCESS_IN_USE`, 409) archiving a process layer the project's playbook points at, or may point at (an unreadable document). Any other agent, and a layer the playbook does
 * not point at, pass. A process layer that passes gets the guard to give the archive (F2): the archive applies only while the playbook document is still as it was read here (missing, or
 * at the same revision), so a publish or a PUT that pointed the playbook at the layer since is not archived under.
 */
export async function requireNotCurrentProcess(deps: ProjectPlaybookReader, agent: Pick<AgentRecord, "orgId" | "agentId" | "purpose" | "owner">): Promise<ArchiveGuard | undefined> {
  if (agent.purpose !== "process" || agent.owner.kind !== "project") return undefined;
  const { playbook, exists, unreadable } = await readProjectPlaybookState(deps, agent.orgId, agent.owner.project);
  const { defaultProcess } = playbook;
  if (unreadable || (defaultProcess.kind === "project_process" && defaultProcess.agentId === agent.agentId)) throw inUse();
  const key = projectPlaybookKey(agent.orgId, agent.owner.project);
  return {
    refused: inUse,
    items: [{
      ConditionCheck: {
        TableName: deps.tableName, Key: key,
        ...(exists
          ? { ConditionExpression: "#revision = :revision", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": playbook.revision } }
          : { ConditionExpression: "attribute_not_exists(pk)" }),
      },
    }],
  };
}
