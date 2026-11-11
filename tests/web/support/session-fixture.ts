import { SessionViewSchema, SessionMessageSchema, DeveloperTaskViewSchema, type SessionView } from "@agentx/cloud-contracts/web";
export const SESSION_FIXTURE_ID = "ses_aaaaaaaaaaaaaaaaaaaa";
export const sessionPerson = { developerId: "a".repeat(64), name: "Priya" };
export function sessionFixture(overrides: Partial<SessionView> = {}): SessionView {
 return SessionViewSchema.parse({ contractVersion: 1, sessionId: SESSION_FIXTURE_ID, kind: "local", mode: "delegate", title: "Fix duplicate refunds", project: "payments", agent: { agentId: "agt_aaaaaaaaaaaaaaaaaaaa", name: "Payments expert", version: 3 }, owner: sessionPerson, startedBy: { kind: "member", developerId: sessionPerson.developerId }, where: { kind: "mac", label: "Priya's MacBook", offline: true }, status: "running", step: "Building", cost: { spentUsd: 1.2, runLimitUsd: 4, payer: { kind: "project", name: "payments" } }, approvals: [], followers: 1, viewingNow: [sessionPerson], you: { level: "edit", owner: true, following: false, actions: ["watch", "comment", "steer", "share"] }, link: "https://cell.example/s/" + SESSION_FIXTURE_ID, bindings: [], legs: [], revision: 1, createdAt: "2026-10-23T12:00:00.000Z", updatedAt: "2026-10-23T12:00:00.000Z", body: { kind: "local", tool: "codex" }, ...overrides });
}
export function messageFixture(overrides: Record<string, unknown> = {}) {
 return SessionMessageSchema.parse({ messageId: "msg_aaaaaaaaaaaaaaaaaaaa", sessionId: SESSION_FIXTURE_ID, kind: "comment", source: "app", author: sessionPerson, text: "Check refunds before retrying.", createdAt: "2026-10-23T12:00:00.000Z", rev: 1, ...overrides });
}

export function taskFixture(overrides: Record<string, unknown> = {}) {
 return DeveloperTaskViewSchema.parse({ taskId: "11111111-1111-4111-8111-111111111111", title: "Fix duplicate refunds", project: "payments", status: "RUNNING", startingRevision: 1, client: "app", shared: false, createdAt: "2026-10-23T12:00:00.000Z", updatedAt: "2026-10-23T12:00:00.000Z", events: [], ...overrides });
}
