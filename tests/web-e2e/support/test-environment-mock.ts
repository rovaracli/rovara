// The test-environment routes of the onboarding scenario (setup wizard E4): the answer for each phase of one journey, the way the broker words it. State lives for one scenario.
import { AppProjectDetailSchema, TestEnvironmentBodySchema, TestEnvironmentStateSchema, TestEnvApproveAnswerSchema } from "@agentx/contracts/web";
import type { MockExchange } from "./how-we-work-mock.js";

type Project = ReturnType<typeof AppProjectDetailSchema.parse>;
const DIGEST = "a".repeat(64);
let phase: "ready" | "proposed" | "proved" | "approved" = "ready";
let checked = false;
export function resetTestEnvironment(): void { phase = "ready"; checked = false; }

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
    approval: { status: "none" }, commandsNotInSettings: 2, check: { status: checked ? "ready" : "unchecked" },
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
  // TE-2: the proposal's own check runs first, on a fresh workspace, with nothing added to the project's settings.
  // TS-UX-1 item 2: one "Check it works" press proposes (no digest) and checks; a passed check reads as proved, with no Prove press.
  if (action === "/check") { checked = true; phase = "proved"; record({ checked: true }); json(202, state()); return true; }
  if (action === "/prove") {
    if (!checked) { json(400, { error: { code: "CONFIG_INVALID", message: "Run the check of this test environment first: it runs the proposed commands on a fresh workspace, before any of them is added to the project's settings." } }); return true; }
    phase = "proved"; json(200, state()); return true;
  }
  if (action === "/approve") {
    // The approval is what adds the commands to the project's settings.
    const current = project.get();
    const next = AppProjectDetailSchema.parse({ ...current, latestRevision: current.latestRevision + 1, setup: { status: "ready", checkedRevision: current.latestRevision + 1 }, settings: { ...current.settings, setupCommands: ["npm ci"], testCommands: ["npm test"] } });
    project.set(next); record({ applied: true });
    phase = "approved"; json(200, TestEnvApproveAnswerSchema.parse({ revision: 1, digest: DIGEST, replayed: false, state: state() })); return true;
  }
  return false;
}
