// A registered project revision's record, read the same way by the broker and the plan evidence job.
import { agentXError, projectRevisionKey, type OrgId } from "@rovara-code/contracts";
import { getItem, type StateTable } from "./cancellation.js";
import type { RegisteredProjectRecord } from "./broker.js";

export async function requireProject(dependencies: StateTable, orgId: OrgId, projectName: string, revision: number): Promise<RegisteredProjectRecord> {
  const project = await getItem<RegisteredProjectRecord>(dependencies, projectRevisionKey(orgId, projectName, revision));
  if (!project) throw agentXError("NOT_FOUND", "registered project revision not found");
  return project;
}
