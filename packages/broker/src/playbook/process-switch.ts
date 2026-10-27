// "How we work" follow-up M2: setting a project's playbook back to the built-in Rovara Code. Anything the project's process layer adds that makes work safer (an always-ask rule, a review that
// cannot be skipped, a stronger reviewer, a lower time or spending limit, ...) is lost by the switch, so when the layer's published version is stricter than the built-in the company has
// adopted, the switch waits for a second person on the confirmation page, like a less-safe publish of the layer: the same approvers, the same process self-confirm rules (a project of one
// may confirm its own). "Stricter" is the layer-to-built-in reading of the rules a publish uses (`lessSafeChanges` and `processLessSafeChanges`). Pointing at the layer, and a switch that
// loses nothing, apply at once.
import { PLAYBOOK_STALE_MESSAGE, ROVARA_CODE_AGENT_ID, agentXError } from "@agentx/contracts";
import { randomUUID } from "node:crypto";
import { createPendingChange, type ApprovalDependencies } from "../agents/approvals.js";
import { agentApprovers, resolveRecipe } from "../agents/changes.js";
import { lessSafeChanges } from "../agents/less-safe.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { confirmationReply } from "../agent-sessions/shares.js";
import { StatusReply } from "../aws/status-reply.js";
import { processLessSafeChanges } from "./process-less-safe.js";
import { readProjectPlaybook, type ProjectPlaybookReader } from "./project-playbook-store.js";
import type { ProcessAgentReader } from "./project-process.js";

/** What the switch needs: the playbook documents, the agent store, and (for a switch that must wait) the approvals. */
export interface BuiltinSwitchDependencies extends ProjectPlaybookReader {
  store: ProcessAgentReader | undefined;
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
 * The reply that holds a switch of `project` to the built-in, or undefined when it may apply at once. The caller has checked the role and that `expectedRevision` is what the maintainer read.
 * A layer with no published version, or one that is gone, loses nothing. An archived layer that still has a published version is compared like any other: archiving it is no way round the second person (and the archive of the project's current default is refused anyway, process-in-use.ts). When the layer must be compared and the approvals are not available the switch
 * is refused (`RUNTIME_UNAVAILABLE`), never applied.
 */
export async function holdBuiltinSwitch(
  deps: BuiltinSwitchDependencies, caller: DeveloperCaller, project: string, expectedRevision: number,
): Promise<StatusReply | undefined> {
  const current = await readProjectPlaybook(deps, caller.orgId, project, { lenient: true });
  if (current.defaultProcess.kind !== "project_process") return undefined;
  if (expectedRevision !== current.revision) throw agentXError("PLAYBOOK_STALE", PLAYBOOK_STALE_MESSAGE);
  const { agentId } = current.defaultProcess;
  const layer = await deps.store?.get(caller.orgId, agentId);
  if (layer === undefined || layer.currentVersion === undefined) return undefined;
  const approvals = deps.approvals;
  if (approvals === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Switching back to the built-in way of working needs a second person's confirmation, which isn't available right now.");
  const lost = await switchLosses(approvals, caller.orgId, agentId, layer.currentVersion);
  if (lost.length === 0) return undefined;
  const reasons = lost.slice(0, REASONS_MAX);
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
  return new StatusReply(reply.status, reply.body);
}
