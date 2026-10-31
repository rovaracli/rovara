// E2: whether a stage of a project has any context source, read when the operation is built so that the capability is issued only then. A stage without
// sources gets no capability, so the worker neither asks nor shows a tool.
import { isContextSourceStage, type OrgId } from "@agentx/contracts";
import { dynamoContextSourceStore } from "./store.js";

export async function stageHasContextSources(
  deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number; contextSourcesConfigured: boolean },
  orgId: OrgId, project: string, mode: unknown,
): Promise<boolean> {
  // Build and every other mode: never, whatever the project has.
  if (!isContextSourceStage(mode) || !deps.contextSourcesConfigured) return false;
  const document = await dynamoContextSourceStore(deps).readDocument(orgId, project);
  return document.sources.some((source) => source.stages.includes(mode));
}
