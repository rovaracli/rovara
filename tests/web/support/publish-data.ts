import { AGENT_FIXTURE_ID } from "./agent-fixture.js";
// Fixtures for agent publishing (exp/agent-publish), shaped exactly like the doc `briefs/agent-publish-api.md`. Ids are built here, never real-looking secrets.
export const uuid = (n: number): string => "00000000-0000-4000-8000-" + n.toString(16).padStart(12, "0");
export const approvalId = (n: number): string => "apr_" + n.toString(36).padStart(20, "a");
export const person = (name: string, fill: string) => ({ id: fill.repeat(64), name });
export const me = person("Priya", "a"), other = person("Ada Admin", "c");
export const summary = (extra: Record<string, unknown> = {}) => ({ steps: 4, tools: [{ connector: "github", access: "read_write" }, { connector: "sentry", access: "read" }], autonomy: "prepare", triggers: ["manual", "schedule"], skills: 1, monthlyBudgetUsd: 20, maxPerRunUsd: 2, lessSafe: ["Adds write access to github"], ...extra });
export function publishRequest(n: number, extra: Record<string, unknown> = {}) {
 return {
  requestId: uuid(n), approvalId: approvalId(n), agent: { agentId: AGENT_FIXTURE_ID, name: "Release notes writer", description: "Writes release notes." }, target: { kind: "project", project: "payments" },
  version: 3, digest: "d".repeat(64), state: "pending", requestedBy: other, requestedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), expiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
  note: "Used it on 6 releases.", decidedBy: null, decidedAt: null, summary: summary(), effect: "Moves Release notes writer to the payments project. Ada Admin keeps edit access.",
  approval: { canDecide: true, reason: null, freshSignInNeeded: true, confirmUrl: "https://cell.example/v1/app/approve/tkt_abc123" },
  ...extra,
 };
}
export function agentCard(id: string, name: string, reason: string, extra: Record<string, unknown> = {}) {
 return { agentId: id, name, description: name + " does its work.", builtin: id.startsWith("agt_") ? false : true, status: "active", access: "use", currentVersion: 2, publication: { level: "company", projects: [], pending: null }, reason, ...extra };
}
export const myAgents = (favourites: unknown[], suggested: unknown[], revision = 4) => ({ favourites, suggested, limits: { maxFavourites: 12, maxSuggested: 6 }, revision });
export const errorBody = (code: string, message: string) => ({ error: { code, message } });
