// Shared by the follow-up F2 tests of the switch to the built-in and the archive of a process layer (process-switch-*.test.ts, process-archive-atomic.test.ts).
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { agentKey, agentXError, projectPlaybookKey, type AgentId, type OrgRole } from "../../packages/contracts/src/index.js";
import { publishDraft } from "../../packages/broker/src/agents/changes.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { postProjectProcess } from "../../packages/broker/src/playbook/process-layer.js";
import { readProjectPlaybook } from "../../packages/broker/src/playbook/project-playbook-store.js";
import { putProjectPlaybook, type ProjectPlaybookDependencies } from "../../packages/broker/src/playbook/routes.js";
import { MAX, OLA, ORG_A } from "./agent-session-world.js";
import { mergeWorld as baseWorld, type MergeWorld } from "./rovara-code-merge-world.js";

export const ROLES: Record<string, OrgRole> = { [OLA]: "admin" };
export const callerOf = (w: MergeWorld, who: string) => ({ ...w.caller(who), orgRole: ROLES[who] ?? "member" });
export function world(): MergeWorld {
  const w = baseWorld();
  const store = new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit });
  (w.deps as { store: AgentStore }).store = store;
  w.store = store;
  return w;
}
export type Client = { send(command: unknown): Promise<unknown> };
/** A client that runs `before` ahead of each command (a test uses it to change something between a check and a write). */
export const intercepting = (db: Client, before: (command: { constructor: { name: string }; input: Record<string, unknown> }) => void | Promise<void>): Client => ({
  send: async (command) => { await before(command as never); return db.send(command); },
});
export function playbookDeps(w: MergeWorld, client: Client = w.db): ProjectPlaybookDependencies {
  return {
    documentClient: client, tableName: "state", now: () => w.clock.now, store: w.store, audit: w.audit.audit, approvals: w.deps,
    projectFor: async (caller, rawName) => {
      const role = await w.members.roleOf(caller.orgId, rawName, { developerId: caller.developerId, orgRole: ROLES[caller.developerId] ?? "member" });
      if (role === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
      return { name: rawName, role };
    },
  };
}
export const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; statusCode?: number; message: string }) => ({ code: error.code, status: error.statusCode, message: error.message }));
export const playbook = (w: MergeWorld) => readProjectPlaybook(playbookDeps(w), ORG_A, "web", { lenient: true });
export const toBuiltin = async (w: MergeWorld, deps = playbookDeps(w)) => putProjectPlaybook(deps, callerOf(w, MAX), "web", { expectedRevision: (await playbook(w)).revision, defaultProcess: { kind: "builtin" } });
export const publish = async (w: MergeWorld, agentId: AgentId) => {
  const agent = (await w.store.get(ORG_A, agentId))!;
  return publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
};
export const STRICT = { review: { instructions: "Be strict about tests." } };
/** A process layer with its first (safe) version published, so the playbook points at it; with `strict`, a second version the built-in lacks (confirmed by the org admin). */
export async function layerWith(w: MergeWorld, strict = false): Promise<AgentId> {
  const { agentId } = await postProjectProcess(playbookDeps(w), w.caller(MAX), "web");
  expect(await publish(w, agentId)).toMatchObject({ applied: true, value: { version: 1 } });
  if (strict) {
    const agent = (await w.store.get(ORG_A, agentId))!;
    await w.store.saveDraft({ orgId: ORG_A, agentId, overlay: { steps: STRICT }, expectedRevision: agent.draftRevision, by: MAX });
    const waiting = await publish(w, agentId) as unknown as { confirmUrl: string };
    const { decideApproval } = await import("../../packages/broker/src/agents/approvals.js");
    await decideApproval(w.deps, callerOf(w, OLA), w.approvalIdOf(waiting.confirmUrl), { requestId: randomUUID(), decision: "APPROVE" });
    expect((await w.store.get(ORG_A, agentId))!.currentVersion).toBe(2);
  }
  expect((await playbook(w)).defaultProcess).toEqual({ kind: "project_process", agentId });
  return agentId;
}
/** Writes the playbook document as something that can't be read, at its current revision: it exists, but is not a playbook. */
export function corruptPlaybook(w: MergeWorld): number {
  const revision = (w.db.get(projectPlaybookKey(ORG_A, "web").pk, projectPlaybookKey(ORG_A, "web").sk) as { revision?: number } | undefined)?.revision ?? 0;
  w.db.set({ ...projectPlaybookKey(ORG_A, "web"), entityType: "PROJECT_PLAYBOOK", orgId: ORG_A, revision, defaultProcess: { kind: "not-a-kind" } });
  return revision;
}
export const rawPlaybook = (w: MergeWorld) => structuredClone(w.db.get(projectPlaybookKey(ORG_A, "web").pk, projectPlaybookKey(ORG_A, "web").sk));
export const changedEvents = (w: MergeWorld) => w.audit.recordedBy("playbook.default_process_changed");
export const bumpLayerVersion = (w: MergeWorld, agentId: AgentId) => {
  const meta = w.db.get(agentKey(ORG_A, agentId, "META").pk, agentKey(ORG_A, agentId, "META").sk) as Record<string, unknown>;
  w.db.set({ ...meta, currentVersion: (meta["currentVersion"] as number) + 1, latestVersion: (meta["latestVersion"] as number) + 1 });
};
export const isPlaybookWrite = (command: { constructor: { name: string }; input: Record<string, unknown> }) =>
  command.constructor.name === "TransactWriteCommand" && ((command.input["TransactItems"] as Array<{ Put?: { Item?: { entityType?: string } } }>) ?? []).some((item) => item.Put?.Item?.entityType === "PROJECT_PLAYBOOK");

