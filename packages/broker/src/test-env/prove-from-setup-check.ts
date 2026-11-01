// Test environment (wire-testenv): the Prove report of a proposed environment, built from the project's SETUP CHECK.
//
// The setup check already exists and is the one place that runs a project's own commands on a fresh workspace: its setup commands, then its readiness commands (the build, smoke and test checks a task needs to
// pass). It proves "these commands work on a clean checkout of the default branch" with no new thing to run. So the Prove report is DERIVED here, by the broker, from what that check recorded:
//   - the check must have passed (`ready`) at the project's latest settings revision, and be recent (a week, the life of a proposal);
//   - every setup command and every build, smoke and test check of the proposal must be among the commands the project's settings had at that revision (the commands the check ran), compared by program, arguments
//     and directory. A command the check did not run is not proved, and the proposal then says "apply these commands to the project's settings and run the setup check again";
//   - the report claims only what ran: each step it names passed, the rest are skipped. It does not claim the boot of a service, a timed full run, a coverage map or a mock (those need the full Prove run, which
//     needs a worker run with no task: not built yet), and a proposal with services is never proved here.
// A report is never read from a worker for this: the worker's word is not asked, so it cannot be forged.
import { TestEnvProveReportSchema, type AppProjectSummary, type ProjectCommand, type TestEnvProveReport, type TestEnvRefusal, type TestEnvironmentBody, testEnvDigest } from "@agentx/contracts";

/** How old a passing setup check may be and still prove a proposal: the proposal's own life. */
export const SETUP_CHECK_MAX_AGE_MS = 7 * 86_400_000;

export interface ProjectCommandsAt { revision: number; setup: readonly ProjectCommand[]; readiness: readonly ProjectCommand[] }

const sameCommand = (left: ProjectCommand, right: ProjectCommand): boolean => left.cwd === right.cwd && left.executable === right.executable && JSON.stringify(left.args) === JSON.stringify(right.args);
const covered = (command: ProjectCommand, among: readonly ProjectCommand[]): boolean => among.some((candidate) => sameCommand(candidate, command));

export type ProveFromSetupCheck = { ok: true; report: TestEnvProveReport } | { ok: false; refusal: TestEnvRefusal };

export function proveReportFromSetupCheck(input: {
  environment: TestEnvironmentBody;
  definition: ProjectCommandsAt;
  setup: AppProjectSummary["setup"];
  nowMs: number;
}): ProveFromSetupCheck {
  const { environment, definition, setup } = input;
  if (setup.status === "unchecked") return { ok: false, refusal: "no_setup_check" };
  if (setup.status === "checking") return { ok: false, refusal: "checking" };
  if (setup.status === "failed") return { ok: false, refusal: "failed" };
  if (setup.status === "outdated") return { ok: false, refusal: "outdated" };
  // Ready, for exactly the settings these commands come from, and recent.
  const checkedAt = setup.checkedAt === undefined ? Number.NaN : Date.parse(setup.checkedAt);
  if (setup.checkedRevision !== definition.revision) return { ok: false, refusal: "outdated" };
  if (!Number.isFinite(checkedAt) || checkedAt > input.nowMs + 5 * 60_000 || input.nowMs - checkedAt > SETUP_CHECK_MAX_AGE_MS) return { ok: false, refusal: "setup_check_old" };
  // A service needs its boot and its mock or probe proved: that is the full Prove run, not this.
  if (environment.services.length > 0) return { ok: false, refusal: "services_need_prove" };

  const setupCommands = environment.repos.flatMap((repo) => repo.setupCommands);
  const checksOf = (kind: string) => environment.repos.flatMap((repo) => repo.checks).filter((check) => check.kind === kind);
  const build = checksOf("build"), smoke = checksOf("smoke"), tests = checksOf("test");
  if (smoke.length + tests.length === 0) return { ok: false, refusal: "nothing_to_prove" };
  // A setup command is proved by a setup or readiness command that matches it. A build, smoke or test check is proved ONLY by the readiness command that is exactly it: a command that merely matches a setup
  // command (a proposal that lists `npm ci` as a test) did not run as a test, and the report must not say the suite passed.
  const checkCommands = [...build, ...smoke, ...tests].map((check) => check.command);
  if (!setupCommands.every((command) => covered(command, definition.setup) || covered(command, definition.readiness)) || !checkCommands.every((command) => covered(command, definition.readiness))) return { ok: false, refusal: "commands_differ" };

  const step = (name: TestEnvProveReport["steps"][number]["step"], did: boolean) => ({ step: name, status: did ? "passed" as const : "skipped" as const, durationMs: 0 });
  const report = TestEnvProveReportSchema.safeParse({
    schemaVersion: 1,
    proposalDigest: testEnvDigest(environment),
    steps: [step("setup", setupCommands.length > 0), step("build", build.length > 0), step("smoke", smoke.length > 0), step("full_suite", tests.length > 0)],
    services: [],
    finishedAt: new Date(input.nowMs).toISOString(),
  });
  return report.success ? { ok: true, report: report.data } : { ok: false, refusal: "not_provable" };
}

/** What a refusal says to a person (fixed words, never a value). */
export const TEST_ENV_REFUSAL_WORDS: Record<TestEnvRefusal, string> = {
  no_draft: "Ask Rovara to draft the project's setup first; the test environment is proposed from that look at the default branch.",
  stale_draft: "The setup draft is older than the project's settings. Ask Rovara to draft the setup again.",
  no_proposal: "Propose the environment first.",
  not_provable: "This environment could not be checked from the setup check.",
  outdated: "The project's settings changed since the last setup check. Run the setup check again.",
  checking: "The setup check is still running.",
  failed: "The setup check failed. Fix the setup, then run it again.",
  no_setup_check: "Run the project's setup check first.",
  commands_differ: "Some of the proposed commands are not among the commands the setup check ran. Apply the proposal's commands to the project's settings, then run the setup check again.",
  nothing_to_prove: "The proposal has no smoke or test command, so there is nothing to prove.",
  services_need_prove: "This environment calls services, which need the full Prove run. It is not available yet.",
  setup_check_old: "The last setup check is more than a week old. Run it again.",
};
