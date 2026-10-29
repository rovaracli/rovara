// "How we work" (R2): a project's process layer builds on the Rovara Code version the company had adopted when the layer was made, so it stays there when the company adopts a newer one.
// This says when it can move: the version the layer's RUNNING version builds on, against the version the company has adopted now. It is a read. The running version is compared, not the
// draft, so the notice stays until the move is published (a draft moved by "Update" and left unpublished is still an update waiting). Moving the draft is the agent's `update-base`
// route and publishing it is the ordinary publish, which asks a second person when the newer Rovara Code loosens what the less-safe rules cover.
import { ROVARA_CODE_AGENT_ID, type AgentId, type OrgId } from "@agentx/contracts";
import type { AgentStore } from "../agents/store.js";

export async function processUpdate(store: AgentStore, orgId: OrgId, agentId: AgentId, version: number): Promise<{ from: number; to: number } | undefined> {
  const base = (await store.getVersion(orgId, agentId, version))?.extends;
  if (base === undefined || base.agentId !== ROVARA_CODE_AGENT_ID) return undefined;
  const adopted = await store.pinnedBuiltinVersion(orgId, ROVARA_CODE_AGENT_ID);
  return adopted > base.version ? { from: base.version, to: adopted } : undefined;
}
