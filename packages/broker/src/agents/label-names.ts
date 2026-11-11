// Plan 3 Task 14b (R3-3): a label in an agent's call can be given by id (`labelIds`, `addedLabelIds`, a declared `labelIdArgument`), and the id says
// nothing: `automerge` and `bug` look alike as ids. So the broker turns each id into the label's name through the connector's own label list, read with a
// read tool, and the name goes through the trigger-label patterns. The model never supplies the mapping. An id that can't be resolved (unknown, a
// failed lookup, a connector with no label list) comes back `undefined`, and the caller treats it as consequential.
//
// A connector type's label list is a `LabelLister` registered in `deps.labelListers`: GitHub's is here (`githubLabelLister`); Linear's, Jira's and an
// MCP tool's `labelListTool` are read through the connector call path (Tasks 19 and 20b) and register themselves the same way. The list is kept for the
// run (`deps.runCache`), so each run reads it once and the next run reads it again.
import type { OrgId } from "@rovara-code/contracts";
import type { AgentGitHubScope, AgentRepositoryLabel } from "../github-app.js";
import { cacheNameOf, type RunCache } from "./run-cache.js";

/** The connector a label id belongs to: its type, its id, and for GitHub the repository (`owner/name`) whose labels the ids name. */
export interface LabelConnector {
  type: string;
  id: string;
  repository?: string;
}

/** Every label of the connector as id -> name (all the id spellings the connector uses). Throws when the list can't be read. */
export type LabelLister = (input: { orgId: OrgId; connector: LabelConnector }) => Promise<ReadonlyMap<string, string>>;

export interface LabelNameDependencies {
  labelListers: Readonly<Record<string, LabelLister>>;
  /** The cache of one run; a fresh one for each call keeps nothing. */
  runCache: (scope: { orgId: OrgId; taskId: string }) => RunCache;
}

const MAX_IDS = 200;
const MAX_ID_LENGTH = 256;

function isLabelTable(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((name) => typeof name === "string");
}

/**
 * The name of each label id for the run's connector, or `undefined` for an id that can't be resolved. At most 200 ids are looked at; any beyond are
 * unresolved. The connector's list is read once per run (and kept in the run's cache), under the run's org.
 */
export async function resolveLabelNames(
  deps: LabelNameDependencies,
  input: { orgId: OrgId; taskId: string; connector: LabelConnector; ids: readonly string[] },
): Promise<Map<string, string | undefined>> {
  const answer = new Map<string, string | undefined>(input.ids.map((id) => [id, undefined]));
  const lister = Object.hasOwn(deps.labelListers, input.connector.type) ? deps.labelListers[input.connector.type] : undefined;
  if (lister === undefined || answer.size === 0) return answer;

  const cache = deps.runCache({ orgId: input.orgId, taskId: input.taskId });
  const name = cacheNameOf(input.connector.type, input.connector.id, input.connector.repository?.toLowerCase() ?? "");
  let table: Record<string, string> | undefined;
  const kept = await cache.get("label-names", name);
  if (isLabelTable(kept)) table = kept;
  if (table === undefined) {
    try {
      table = Object.fromEntries(await lister({ orgId: input.orgId, connector: input.connector }));
    } catch {
      // A failed lookup resolves nothing, and is not kept: the next call tries again.
      return answer;
    }
    await cache.set("label-names", name, table);
  }
  for (const id of [...answer.keys()].slice(0, MAX_IDS)) {
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH || !Object.hasOwn(table, id)) continue;
    answer.set(id, table[id]);
  }
  return answer;
}

/** GitHub's label list: the repository's labels, each under its numeric id and its node id. */
export function githubLabelLister(provider: { listAgentRepositoryLabels(repositoryUrl: string, scope: AgentGitHubScope): Promise<AgentRepositoryLabel[]> }): LabelLister {
  return async ({ orgId, connector }) => {
    if (connector.repository === undefined) throw new Error("a GitHub connector's labels need its repository");
    const labels = await provider.listAgentRepositoryLabels(`https://github.com/${connector.repository}.git`, { orgId });
    return new Map(labels.flatMap((label): Array<[string, string]> => [[String(label.id), label.name], [label.nodeId, label.name]]));
  };
}
