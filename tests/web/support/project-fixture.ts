import { ProjectOverviewSchema } from "@agentx/cloud-contracts/web";
import { liveFixture } from "./live-fixture.js";
type Overview = ReturnType<typeof ProjectOverviewSchema.parse>;
export function projectFixture(overrides: Partial<Overview> = {}): Overview {
 return ProjectOverviewSchema.parse({ project: { name: "payments", description: "Keep customer payments dependable.", status: "active", repositories: [{ fullName: "acme/payments", defaultBranch: "main" }], setup: { status: "ready" }, channels: ["payments-dev"] }, you: { role: "maintainer", canStartWork: true, canEditSettings: true, canViewSpend: true }, agents: [{ agentId: "agt_aaaaaaaaaaaaaaaaaaaa", name: "Payments expert", description: "Investigates and fixes payment issues.", running: 1 }, { agentId: "rovara-code", name: "Rovara Code", description: "Code work", running: 0 }], budget: { month: "2026-10", spentUsd: 812, limitUsd: 2000, mergedPullRequests: 2, costPerMergedPullRequestUsd: 3.9 }, running: [liveFixture()], ...overrides });
}
