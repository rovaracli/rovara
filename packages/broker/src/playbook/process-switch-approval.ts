// "How we work" follow-up M2: what confirming a `playbook_default_process` change does. A project's playbook is set back to the built-in Rovara Code, but only while the playbook is still
// at the revision that was asked about and the process layer it leaves is still at the version that was compared (a new revision or a new version means the person was shown something
// else: ask again). The write is the ordinary one, so `playbook.default_process_changed` is recorded in the same transaction, by the person who confirmed it.
// This file does not import the agent changes module (which registers it), so there is no import cycle.
import { PLAYBOOK_STALE_MESSAGE, agentXError } from "@rovara-code/contracts";
import { registerApprovalSubjectHandler } from "../agents/approvals.js";
import { readProjectPlaybookState, writeProjectPlaybook } from "./project-playbook-store.js";

/** Registers what confirming a `playbook_default_process` change does. The approvers are the process layer's (the `agent_publish` rule, read when the decision is made). Safe to call more than once. */
export function registerPlaybookApprovals(): void {
  registerApprovalSubjectHandler("playbook_default_process", async (deps, record) => {
    if (record.kind !== "change" || record.subject.kind !== "playbook_default_process") return;
    // A record nobody has decided is never applied.
    if (record.decidedBy === undefined) throw agentXError("CONFIG_INVALID", "this change has not been decided by anyone, so it can't be applied");
    const subject = record.subject;
    const { playbook: current, unreadable } = await readProjectPlaybookState(deps, record.orgId, subject.project);
    // Already applied (a redrive after a crash): the revision it made, pointing at the built-in.
    if (current.revision === subject.expectedRevision + 1 && current.defaultProcess.kind === "builtin") return;
    const layer = await deps.store.get(record.orgId, subject.agentId);
    // A document that could not be read when the switch was held (F2) is still unreadable at the same revision: nothing changed since.
    const unchanged = current.revision === subject.expectedRevision && (unreadable || (current.defaultProcess.kind === "project_process" && current.defaultProcess.agentId === subject.agentId))
      && layer !== undefined && layer.currentVersion === subject.layerVersion;
    if (!unchanged) throw agentXError("PLAYBOOK_STALE", PLAYBOOK_STALE_MESSAGE);
    await writeProjectPlaybook(deps, { orgId: record.orgId, project: subject.project, developerId: record.decidedBy, expectedRevision: subject.expectedRevision, defaultProcess: { kind: "builtin" }, ifLayer: { agentId: subject.agentId, version: subject.layerVersion } });
  });
}
