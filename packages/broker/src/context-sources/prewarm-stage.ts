// Review M9 (stdio MCP host redesign, section 6, "Prewarm"): when an operation is built for a stage that reads sources, the package-run servers among them are started, so the first tool call does
// not wait for a cold start. The stage's sources are read here the same way `stageHasContextSources` reads them; the host call is `ContextSourcesRuntime.prewarm`, which starts only approved
// package-run servers and is fire and forget. This never throws and never waits for a task to come up.
import { isContextSourceStage, type OrgId } from "@agentx/contracts";
import { dynamoContextSourceStore } from "./store.js";

const MAX_SERVERS = 16;

export async function prewarmStageServers(
  deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number; prewarm?: ((orgId: OrgId, serverIds: readonly string[]) => Promise<number>) | undefined },
  orgId: OrgId, project: string, mode: unknown,
): Promise<number> {
  // No prewarm where the install runs no package-run servers; never in Build or any other mode.
  if (deps.prewarm === undefined || !isContextSourceStage(mode)) return 0;
  try {
    const document = await dynamoContextSourceStore(deps).readDocument(orgId, project);
    const serverIds = new Set<string>();
    for (const source of document.sources) if (source.stages.includes(mode) && source.server.kind === "registered_server") serverIds.add(source.server.serverId);
    if (serverIds.size === 0) return 0;
    return await deps.prewarm(orgId, [...serverIds].slice(0, MAX_SERVERS));
  } catch {
    // A stage never fails, or waits, because a server could not be warmed.
    return 0;
  }
}
