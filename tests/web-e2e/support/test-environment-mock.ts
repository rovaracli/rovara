// The test-environment routes of the onboarding scenario (setup wizard E4): the answer for each phase of one journey, the way the broker words it. State lives for one scenario.
import { AppProjectDetailSchema, TestEnvironmentBodySchema, TestEnvironmentStateSchema, TestEnvApplyAnswerSchema, TestEnvApproveAnswerSchema } from "@agentx/contracts/web";
import type { MockExchange } from "./how-we-work-mock.js";

type Project = ReturnType<typeof AppProjectDetailSchema.parse>;
const DIGEST = "a".repeat(64);
let phase: "ready" | "proposed" | "proved" | "approved" = "ready";
let applied = false;
export function resetTestEnvironment(): void { phase = "ready"; applied = false; }

const command = (executable: string, args: string[], timeoutSeconds: number) => ({ cwd: "repo/payments", executable, args, timeoutSeconds });
const ENVIRONMENT = TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "payments", setupCommands: [command("npm", ["ci"], 900)], checks: [{ id: "unit", label: "Unit tests", command: command("npm", ["test"], 1800), kind: "test", selectArgs: ["{tests}"] }] }],
  roundBudgetMin: 30, selection: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
  services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
});
const SUMMARY = { tier: "sandbox", repositories: [{ repositoryId: "payments", setupCommands: 1, checks: [{ id: "unit", label: "Unit tests", kind: "test", selectArgs: ["{tests}"] }] }], selectionMethod: "coverage_map", roundBudgetMin: 30, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: 0 };
const state = () => TestEnvironmentStateSchema.parse({
  ...(phase === "approved" ? { approved: { revision: 1, approvedAt: "2026-11-01T12:00:00.000Z", digest: DIGEST, summary: SUMMARY } } : {}),
  draft: { status: "ready", notes: ["Found a package.json."], questions: [], pendingServices: [] },
  ...(phase === "ready" || phase === "approved" ? {} : { proposal: {
    digest: DIGEST, source: "setup", risk: "medium", lessSafe: [], summary: SUMMARY, environment: ENVIRONMENT,
    runs: [{ repositoryId: "payments", setup: ["npm ci"], checks: [{ id: "unit", label: "Unit tests", kind: "test", command: "npm test", selectArgs: ["{tests}"] }] }],
    valueSources: [{ field: "repos[0].setupCommands[0]", source: { path: "package.json", line: 4 } }, { field: "repos[0].checks[0]", source: "detector:node" }],
    proved: phase === "proved", proveSteps: phase === "proved" ? [{ step: "setup", status: "passed" }, { step: "full_suite", status: "passed" }] : [], needs: { freshSignIn: false, secondPerson: false },
    approval: { status: "none" }, commandsNotInSettings: applied ? 0 : 2,
  } }),
});

/** Answers the test-environment routes of the `payments` onboarding project; false when the request is not one of them. */
export async function testEnvironmentMock({ url, method, json, record }: MockExchange, project: { get(): Project; set(value: Project): void }): Promise<boolean> {
  const base = "/v1/web/projects/payments/test-environment";
  if (!url.pathname.startsWith(base)) return false;
  const action = url.pathname.slice(base.length);
  if (action === "" && method === "GET") { json(200, state()); return true; }
  if (method !== "POST") return false;
  if (action === "/propose") { phase = "proposed"; json(200, state()); return true; }
  if (action === "/apply-commands") {
    const current = project.get();
    applied = true;
    const next = AppProjectDetailSchema.parse({ ...current, latestRevision: current.latestRevision + 1, setup: { status: "ready", checkedRevision: current.latestRevision + 1 }, settings: { ...current.settings, setupCommands: ["npm ci"], testCommands: ["npm test"] } });
    project.set(next); record({ applied: true });
    json(200, TestEnvApplyAnswerSchema.parse({ added: ["npm ci", "npm test"], skipped: [], settingsRevision: next.latestRevision, setupCheck: "started", state: state() })); return true;
  }
  if (action === "/prove") {
    if (!applied) { json(400, { error: { code: "CONFIG_INVALID", message: "Some of the proposed commands are not among the commands the setup check ran. Apply the proposal's commands to the project's settings, then run the setup check again." } }); return true; }
    phase = "proved"; json(200, state()); return true;
  }
  if (action === "/approve") { phase = "approved"; json(200, TestEnvApproveAnswerSchema.parse({ revision: 1, digest: DIGEST, replayed: false, state: state() })); return true; }
  return false;
}
