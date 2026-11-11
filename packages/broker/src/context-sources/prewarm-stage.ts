// Review M9 (stdio MCP host redesign, section 6, "Prewarm"): when an operation is built for a stage that reads sources, the package-run servers among them are started, so the first tool call does
// not wait for a cold start. The stage's sources are read here the same way `stageHasContextSources` reads them; the host call is `ContextSourcesRuntime.prewarm`, which starts only approved
// package-run servers. This never throws and never waits for a task to come up, only for the host to accept the requests (bounded; review N3).
import { isContextSourceStage, type OrgId } from "@rovara-code/contracts";
import { dynamoContextSourceStore } from "./store.js";

const MAX_SERVERS = 16;

export async function prewarmStageServers(
  deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number; prewarm?: ((orgId: OrgId, serverIds: readonly string[]) => Promise<number>) | undefined; boundMs?: number | undefined },
  orgId: OrgId, project: string, mode: unknown,
): Promise<number> {
  // No prewarm where the install runs no package-run servers; never in Build or any other mode.
  if (deps.prewarm === undefined || !isContextSourceStage(mode)) return 0;
  const prewarm = deps.prewarm;
  const run = async (): Promise<number> => {
    try {
      const document = await dynamoContextSourceStore(deps).readDocument(orgId, project);
      const serverIds = new Set<string>();
      for (const source of document.sources) if (source.stages.includes(mode) && source.server.kind === "registered_server") serverIds.add(source.server.serverId);
      if (serverIds.size === 0) return 0;
      return await prewarm(orgId, [...serverIds].slice(0, MAX_SERVERS));
    } catch {
      // A stage never fails because a server could not be warmed.
      return 0;
    }
  };
  // Review N3: the caller awaits this, for at most `boundMs` (default 3 seconds), because the broker runs in a Lambda that is frozen when it returns: a request still in flight then may never be sent.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<number>((resolve) => { timer = setTimeout(() => resolve(0), deps.boundMs ?? 3_000); });
  try { return await Promise.race([run(), bound]); } finally { if (timer !== undefined) clearTimeout(timer); }
}
