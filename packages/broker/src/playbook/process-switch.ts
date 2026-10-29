// "How we work" follow-up M2: setting a project's playbook back to the built-in Rovara Code. Anything the project's process layer adds that makes work safer (an always-ask rule, a review that
// cannot be skipped, a stronger reviewer, a lower time or spending limit, ...) is lost by the switch, so when the layer's published version is stricter than the built-in the company has
// adopted, the switch waits for a second person on the confirmation page, like a less-safe publish of the layer: the same approvers, the same process self-confirm rules (a project of one
// may confirm its own). "Stricter" is the layer-to-built-in reading of the rules a publish uses (`lessSafeChanges` and `processLessSafeChanges`). Pointing at the layer, and a switch that
// loses nothing, apply at once.
import { PLAYBOOK_STALE_MESSAGE, ROVARA_CODE_AGENT_ID, agentXError, type AgentId, type OrgId } from "@agentx/contracts";
import { randomUUID } from "node:crypto";
import { createPendingChange, type ApprovalDependencies } from "../agents/approvals.js";
import { agentApprovers, resolveRecipe } from "../agents/changes.js";
import { lessSafeChanges } from "../agents/less-safe.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { confirmationReply } from "../agent-sessions/shares.js";
import { StatusReply } from "../aws/status-reply.js";
import type { AgentRecord } from "../agents/store.js";
import { processLessSafeChanges } from "./process-less-safe.js";
import { readProjectPlaybookState, type ProjectPlaybookReader } from "./project-playbook-store.js";
import type { ProcessAgentReader } from "./project-process.js";

/** The agent store the switch reads. `list` is required (PB21): with an unreadable playbook it is the only way to find the layer, and a store that could not list would skip the second person. */
export type SwitchAgentStore = ProcessAgentReader & { list(orgId: OrgId): Promise<AgentRecord[]> };

/** What the switch needs: the playbook documents, the agent store, and (for a switch that must wait) the approvals. */
export interface BuiltinSwitchDependencies extends ProjectPlaybookReader {
  store: SwitchAgentStore | undefined;
  approvals?: ApprovalDependencies | undefined;
}

/** The most reasons the confirmation page lists; the page says how many more there are. */
const REASONS_MAX = 20;

/** What the switch loses: the process layer's published recipe compared with the built-in at the version the company has adopted, as a person reads a less-safe publish. Empty when nothing is lost. */
export async function switchLosses(approvals: ApprovalDependencies, orgId: string, agentId: string, layerVersion: number): Promise<string[]> {
  const layer = await resolveRecipe(approvals, orgId, agentId, layerVersion);
  const pinned = await approvals.store.pinnedBuiltinVersion(orgId, ROVARA_CODE_AGENT_ID);
  const builtin = approvals.store.builtinRecipe(ROVARA_CODE_AGENT_ID, pinned);
  return [...new Set([...lessSafeChanges(layer, builtin), ...processLessSafeChanges(layer, builtin, { firstPublish: false })])];
}

/**
 * What `holdBuiltinSwitch` decided: `held` is the confirmation reply when the switch waits for a second person. Otherwise the switch may be written, and `ifLayer` is the published version
 * of the process layer that was compared (absent when there was no layer to compare), which the write must still find (F2: a layer published in between makes it stale).
 */
export type BuiltinSwitchDecision = { held: StatusReply; ifLayer?: undefined } | { held?: undefined; ifLayer?: { agentId: AgentId; version: number } };

/** The line the confirmation page shows when the project's saved way of working can't be read, so what the switch drops can't be listed. */
const UNREADABLE_REASON = "Replaces the project's saved way of working, which can't be read right now.";

/** The project's process layer when its playbook can't say which it is: the one process layer it owns (an active one first), as `existingLayer` finds it. */
async function ownedLayer(deps: BuiltinSwitchDependencies, orgId: OrgId, project: string): Promise<AgentRecord | undefined> {
  const owned = ((await deps.store?.list(orgId)) ?? []).filter((agent) => agent.purpose === "process" && agent.owner.kind === "project" && agent.owner.project === project);
  return owned.find((agent) => agent.status === "active") ?? owned[0];
}

/**
 * The reply that holds a switch of `project` to the built-in, or undefined when it may apply at once. The caller has checked the role and that `expectedRevision` is what the maintainer read.
 * A layer with no published version, or one that is gone, loses nothing. An archived layer that still has a published version is compared like any other: archiving it is no way round the second person (and the archive of the project's current default is refused anyway, process-in-use.ts). When the layer must be compared and the approvals are not available the switch
 * is refused (`RUNTIME_UNAVAILABLE`), never applied; so is a switch that has no agent store to find the layer with (R3-1).
 * A playbook document that exists but can't be read is not the built-in (F2, PB16): the project chose something we can't see, so a project that has a published process layer is held
 * for a second person whatever the comparison says. A project with no such layer has nothing to lose, and the write repairs the document.
 */
export async function holdBuiltinSwitch(
  deps: BuiltinSwitchDependencies, caller: DeveloperCaller, project: string, expectedRevision: number,
): Promise<BuiltinSwitchDecision> {
  const { playbook: current, unreadable } = await readProjectPlaybookState(deps, caller.orgId, project);
  if (current.defaultProcess.kind !== "project_process" && !unreadable) return {};
  if (expectedRevision !== current.revision) throw agentXError("PLAYBOOK_STALE", PLAYBOOK_STALE_MESSAGE);
  // Without the agent store the layer can't be found, and "no layer" would read as "nothing to lose": refuse, as for missing approvals below.
  const store = deps.store;
  if (store === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Switching back to the built-in way of working needs the project's saved way of working, which isn't available right now.");
  const layer = current.defaultProcess.kind === "project_process" ? await store.get(caller.orgId, current.defaultProcess.agentId) : await ownedLayer(deps, caller.orgId, project);
  if (layer === undefined || layer.currentVersion === undefined) return {};
  const { agentId } = layer;
  const approvals = deps.approvals;
  if (approvals === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Switching back to the built-in way of working needs a second person's confirmation, which isn't available right now.");
  const lost = await switchLosses(approvals, caller.orgId, agentId, layer.currentVersion);
  if (lost.length === 0 && !unreadable) return { ifLayer: { agentId, version: layer.currentVersion } };
  const reasons = lost.length === 0 ? [UNREADABLE_REASON] : lost.slice(0, REASONS_MAX);
  const record = await createPendingChange(approvals, {
    orgId: caller.orgId, requestId: randomUUID(), requestedBy: caller.developerId,
    subject: { kind: "playbook_default_process", project, agentId, layerVersion: layer.currentVersion, expectedRevision },
    changes: [
      "Switches this project back to Rovara's built-in way of working, which drops what the project's own process adds. It would:",
      ...reasons,
      ...(lost.length > REASONS_MAX ? [`and ${String(lost.length - REASONS_MAX)} more`] : []),
    ],
    approvers: await agentApprovers(approvals, layer, "agent_publish"),
  });
  const reply = await confirmationReply(approvals, caller, record);
  return { held: new StatusReply(reply.status, reply.body) };
}
