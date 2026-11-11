// Company AI sources (Plan 3 Task 24b, fix round 1): taking a source out of the world. A source lives in three places, the org's record, the model proxy
// (its models and key) and, for an endpoint, an egress item whose approved host is in the cell-wide union. Releasing one is the egress release and the
// proxy removal; both can be repeated, so a removal that died half-way is finished by running this again. Removing the record entry is the caller's.
import { AgentXError, agentXError, type OrgId } from "@rovara-code/contracts";
import type { ModelAccess } from "../model-proxy/access.js";
import { putEgressDomains, type EgressDomainsDependencies } from "../org/egress-domains.js";
import type { ModelSourceStore } from "./store.js";

export interface ModelSourceCleanupDependencies {
  store: ModelSourceStore;
  access: Pick<ModelAccess, "removeSource">;
  egress: EgressDomainsDependencies;
}

const UNAVAILABLE = "the model proxy couldn't take this change just now; try again";

/** What the proxy says, with its own error kept and anything else (whose text could hold a key) replaced. */
export async function viaProxy<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AgentXError) throw error;
    throw agentXError("MODEL_PROXY_UNAVAILABLE", UNAVAILABLE);
  }
}

/**
 * Releases a source's host and removes its models and key from the proxy. `actor` is the person whose request it is; nobody for the sweeper and the org
 * close, which the audit trail then names as Rovara's own.
 */
export async function releaseSource(deps: Pick<ModelSourceCleanupDependencies, "access" | "egress">, orgId: OrgId, sourceId: string, actor?: { developerId: string }): Promise<void> {
  // Whatever the kind: a source with no egress item has nothing to release, and asking costs one read.
  await putEgressDomains(deps.egress, orgId, { kind: "model-source", sourceId }, [], actor);
  await viaProxy(() => deps.access.removeSource(orgId, sourceId));
}

/** Finishes every removal whose tombstone is still in the org's record. Each one is released, then its tombstone is cleared; one that fails stays owed. */
export async function finishRemovals(deps: ModelSourceCleanupDependencies, orgId: OrgId, actor?: { developerId: string }): Promise<number> {
  const record = await deps.store.readIfAny(orgId);
  let finished = 0;
  for (const tombstone of record?.removing ?? []) {
    await releaseSource(deps, orgId, tombstone.sourceId, actor);
    await deps.store.finishRemoval({ orgId, sourceId: tombstone.sourceId });
    finished += 1;
  }
  return finished;
}

/**
 * Closing an org: every source (and every removal still owed) is released, then the record goes. A failure stops it with the record still there, so the
 * close can be run again. A registration the record never named is the sweeper's.
 */
export async function releaseOrgModelSources(deps: ModelSourceCleanupDependencies, orgId: OrgId): Promise<void> {
  // The record goes only at the revision whose sources were released: one added or removed meanwhile makes the delete refuse, and the loop releases again.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record = await deps.store.readIfAny(orgId);
    const ids = new Set([...(record?.sources ?? []).map((source) => source.sourceId), ...(record?.removing ?? []).map((entry) => entry.sourceId)]);
    for (const sourceId of ids) await releaseSource(deps, orgId, sourceId);
    try {
      await deps.store.deleteRecord(orgId, record?.revision);
      return;
    } catch (error) {
      if (!(error instanceof AgentXError && error.code === "IDEMPOTENCY_CONFLICT")) throw error;
    }
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "the organization's AI sources changed while it was closing; close it again");
}
