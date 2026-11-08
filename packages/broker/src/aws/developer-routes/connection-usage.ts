// `GET /v1/app/connection-usage`: which projects use each company connection, for the "used by" line of the Connections page. Exact, not "company-wide":
//  - an AI provider (a model source) is used by every project whose EFFECTIVE source order holds it (the project's own order, else the company's);
//  - a tracker or monitoring connection (Linear, Jira, Sentry, ...) is used by every project that attaches it as a connector (`credentialRef`), and a Linear or
//    Jira connection also by every project with a watched intake source that reads through it (the one it names by id or label, else the only one of its type).
// Only the projects the viewer may see are named, and an archived project is left out. A project whose settings cannot be read is never guessed at: the answer
// says `complete: false` and the page falls back to its careful wording. Reads only; nothing is written or logged.
import { agentXError, defaultModelSourceOrder, type OrgId } from "@agentx/contracts";
import { listIntakeSources } from "../../intake/sources.js";
import { projectSourceOrder, readProjectAi } from "../../spend/settings.js";
import { readProjectMeta } from "../../developer/project-roles.js";
import type { OrgConnectionRecord } from "../../connections/store.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";
import { REVISION_READS_AT_ONCE, latestProjectRecord, mapLimit, visibleProjectRoles } from "./project-list.js";

/** The most projects read for one answer. More than this and the answer says it is not complete. */
export const CONNECTION_USAGE_MAX_PROJECTS = 200;

export interface ConnectionUsageResponse {
  /** False when some project could not be read (or there were too many): then an empty list does not mean "no project uses it". */
  complete: boolean;
  connections: Array<{ connectionId: string; projects: string[] }>;
  sources: Array<{ sourceId: string; projects: string[] }>;
}

/** The connection a watched Linear or Jira source reads through, the way the poll picks it: the one it names (id or label), else the only one of its type that holds a key. */
function connectionOfSource(connections: readonly OrgConnectionRecord[], type: "linear" | "jira", named: string | undefined): string | undefined {
  const keyed = connections.filter((entry) => entry.type === type && entry.hasSecret === true);
  const chosen = named === undefined ? keyed : keyed.filter((entry) => entry.connectionId === named || entry.label === named);
  return chosen.length === 1 ? chosen[0]!.connectionId : undefined;
}

/** `GET /v1/app/connection-usage`: any member of the company. */
export async function getConnectionUsage(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<ConnectionUsageResponse> {
  const orgId: OrgId = caller.orgId;
  const store = deps.agents?.connections;
  let connections: OrgConnectionRecord[];
  let orgOrder: readonly string[];
  try {
    connections = store === undefined ? [] : await store.list(orgId);
    orgOrder = deps.agents?.orgSourceOrder === undefined ? defaultModelSourceOrder(false) : await deps.agents.orgSourceOrder(orgId);
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", "Which projects use each connection could not be read. Reload and try again.");
  }
  const roles = await visibleProjectRoles(deps, caller);
  const all = [...roles.keys()].sort();
  const names = all.slice(0, CONNECTION_USAGE_MAX_PROJECTS);
  let complete = all.length <= CONNECTION_USAGE_MAX_PROJECTS;
  const byConnection = new Map<string, Set<string>>(connections.map((entry) => [entry.connectionId, new Set<string>()] as const));
  const bySource = new Map<string, Set<string>>();
  const table = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now };
  const read = await mapLimit(names, REVISION_READS_AT_ONCE, async (name) => {
    try {
      const [record, meta, ai, sources] = await Promise.all([
        latestProjectRecord(deps, orgId, name), readProjectMeta(deps, orgId, name), readProjectAi(table, orgId, name), listIntakeSources(table, orgId, name),
      ]);
      // A catalog entry with no readable revision is not a project the app shows; an archived one does not use anything now.
      if (record === undefined) return "unreadable" as const;
      if (meta?.status === "archived") return undefined;
      const used = new Set<string>();
      for (const connector of record.definition.integrations?.connectors ?? []) {
        const ref = (connector as { credentialRef?: unknown }).credentialRef;
        if (typeof ref === "string" && byConnection.has(ref)) used.add(ref);
      }
      for (const { ref } of sources) {
        const type = ref.channel === "jira" ? "jira" : ref.channel === "tracker" && ref.system === "linear" ? "linear" : undefined;
        const id = type === undefined ? undefined : connectionOfSource(connections, type, ref.connection);
        if (id !== undefined) used.add(id);
      }
      return { name, connections: used, order: projectSourceOrder(ai, orgOrder) };
    } catch {
      return "unreadable" as const;
    }
  });
  for (const result of read) {
    if (result === "unreadable") { complete = false; continue; }
    if (result === undefined) continue;
    for (const id of result.connections) byConnection.get(id)!.add(result.name);
    for (const id of result.order) {
      if (!bySource.has(id)) bySource.set(id, new Set());
      bySource.get(id)!.add(result.name);
    }
  }
  const sorted = (set: Set<string>) => [...set].sort();
  return {
    complete,
    connections: [...byConnection].map(([connectionId, projects]) => ({ connectionId, projects: sorted(projects) })),
    sources: [...bySource].map(([sourceId, projects]) => ({ sourceId, projects: sorted(projects) })),
  };
}
