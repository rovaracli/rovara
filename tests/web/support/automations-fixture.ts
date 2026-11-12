// exp/automations: fixtures for the automation screens, shaped by the broker's own contract schemas (a fixture that doesn't parse fails here, not in a screen).
import { AutomationChainResponseSchema, AutomationTriggerViewSchema, ProjectAutomationsResponseSchema, type AutomationChainView, type AutomationTriggerView, type ProjectAutomationsResponse } from "@agentx/cloud-contracts";

export const CHAIN_ID = "chn_" + "a".repeat(20);
export const OTHER_CHAIN_ID = "chn_" + "c".repeat(20);
export const TRIGGER_ID = "ctr_" + "b".repeat(20);
export const RUN_ID = "crn_" + "d".repeat(20);
export const DEVELOPER = "e".repeat(64);
export const SECOND_DEVELOPER = "f".repeat(64);
export const CONFIRM_URL = "https://cell.example/v1/app/approve/apr_fixtureconfirm";
export const DESIGN = { start: "look_into_it", steps: [{ kind: "agent", id: "look_into_it", name: "Look into it", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }] };

export function triggerOf(overrides: Partial<AutomationTriggerView> = {}): AutomationTriggerView {
  return AutomationTriggerViewSchema.parse({
    triggerId: TRIGGER_ID, target: { kind: "chain", chainId: CHAIN_ID }, project: "payments", spec: { kind: "event", source: "github", type: "pull_request.opened" }, enabled: true, maxRunsPerHour: 30,
    createdBy: { developerId: DEVELOPER, name: "Priya" }, createdAt: "2026-11-10T09:00:00.000Z", updatedAt: "2026-11-10T09:00:00.000Z", ...overrides,
  });
}
export function chainOf(overrides: Partial<AutomationChainView> = {}): AutomationChainView {
  return AutomationChainResponseSchema.shape.chain.parse({
    chainId: CHAIN_ID, name: "Refund triage", description: "Look into refund bugs", owner: { kind: "project", project: "payments" }, accountable: { developerId: DEVELOPER }, currentVersion: 2, latestVersion: 2, draftRevision: 3,
    status: "active", monthlyBudgetUsd: 50, openRuns: 0, createdBy: DEVELOPER, createdAt: "2026-11-01T09:00:00.000Z", updatedAt: "2026-11-09T09:00:00.000Z", access: "manage", ...overrides,
  });
}
export function projectAutomations(overrides: Partial<ProjectAutomationsResponse> = {}): ProjectAutomationsResponse {
  return ProjectAutomationsResponseSchema.parse({
    project: "payments", canEdit: true,
    chains: [{ chainId: CHAIN_ID, name: "Refund triage", description: "Look into refund bugs", owner: { kind: "project", project: "payments" }, currentVersion: 2, status: "active", access: "manage", monthlyBudgetUsd: 50 }],
    triggers: [{ ...triggerOf({ lastFiredAt: "2026-11-11T08:00:00.000Z", lastRunId: RUN_ID }), targetName: "Refund triage" }],
    ...overrides,
  });
}
export const runList = (status = "succeeded") => ({ runs: [{ contractVersion: 1, sessionId: RUN_ID, kind: "chain", chain: { chainId: CHAIN_ID, name: "Refund triage", version: 2 }, project: "payments", owner: { developerId: DEVELOPER, name: "Priya" }, status, currentSeq: 1, createdAt: "2026-11-11T08:00:00.000Z", updatedAt: "2026-11-11T08:05:00.000Z", cost: { spentUsd: 1.5, runLimitUsd: 5 } }] });
export const error = (code: string, message: string) => ({ error: { code, message } });
export const people = () => ({
  project: "payments", revision: 4,
  members: [{ developerId: DEVELOPER, name: "Priya", role: "maintainer", source: "grant" }, { developerId: SECOND_DEVELOPER, name: "Sam", role: "maintainer", source: "grant" }, { developerId: "9".repeat(64), name: "Viewer Vi", role: "viewer", source: "grant" }],
  viewer: { role: "maintainer", canManageMembers: true, assignableRoles: ["maintainer", "contributor", "viewer"], canInvite: true, invitableRoles: ["maintainer", "contributor", "viewer"], canEditCodeSettings: true, canConfirmSelfApproval: false },
});
export const versions = () => ({ versions: [
  { version: 2, digest: "d".repeat(64), publishedBy: DEVELOPER, publishedAt: "2026-11-09T09:00:00.000Z", note: "Look at refunds first", current: true },
  { version: 1, digest: "c".repeat(64), publishedBy: DEVELOPER, publishedAt: "2026-11-02T09:00:00.000Z", current: false },
] });
export const draft = (problems: Array<{ path: string; message: string }> = []) => ({ draft: { revision: 3, definition: DESIGN, updatedBy: DEVELOPER, updatedAt: "2026-11-09T10:00:00.000Z" }, problems });
export const shares = () => ({ shares: [{ principal: { kind: "org" }, level: "view", grantedBy: DEVELOPER, grantedAt: "2026-11-05T09:00:00.000Z" }] });
