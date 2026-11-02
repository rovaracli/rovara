// Setup agent, the confirm step (sh-setup-wire, SH15): "Use this setup" turns what the run found into the project's PROPOSED test environment, and nothing more.
//
// The hard rule (owner, 2026-11-02): a setup run's proposal is applied only after (1) the broker re-read every citation from the code host (`verifiedView`, final) and (2) a passing Prove on a NEW workspace the broker
// prepares, never the agent's. This file is step 1 and the hand-over to step 2; it applies NOTHING itself:
//   - it saves no setting, starts no check and approves nothing. It stores the verified commands as the test-environment PROPOSAL (`editTestEnvironment`, the maintainer's own path), where the wizard's existing
//     steps take over: put the commands in the settings, run the project's setup check (a fresh workspace the broker prepares from the default branch; the agent's workspace is never reused and a report is never
//     read from a worker), derive the Prove from that check, and approve. `approveTestEnvironment` refuses an environment with no passing Prove for exactly its digest;
//   - an item whose citation FAILED the re-read is left out, and so is any command that fetches and runs code or holds a secret-shaped value (`refusedCommand`);
//   - the reply says `proved: false` until the wizard has a passing Prove for this digest, and the page keeps its approve step behind the wizard's, not behind this reply.
// Pure where it can be: `environmentFromProposal` builds the environment and says what it left out; `confirmSetupAgent` is the checked sequence.
import { z } from "zod";
import {
  SETUP_TIMEOUT, TEST_TIMEOUT, TestEnvironmentBodySchema, agentXError, parseCommandLine, setupItemsOf,
  type ProjectRole, type SetupProposal, type SetupVerification, type StoredProjectDefinition, type TestEnvironmentBody,
} from "@agentx/contracts";
import { refusedCommand } from "../test-env/draft.js";
import type { DeveloperCaller } from "../aws/developer-routes/types.js";
import { StatusReply } from "../aws/status-reply.js";
import { maintainerOf, readState, verifiedView, type SetupAgentDependencies } from "./setup-agent.js";

export const SetupConfirmBodySchema = z.object({
  requestId: z.string().uuid(),
  /** The project settings revision the person looked at. */
  expectedRevision: z.number().int().min(0),
  /** Items to use, by id (setup and tests items only). Absent: every item that passed. */
  itemIds: z.array(z.string().min(1).max(100)).max(64).optional(),
}).strict();

export const SETUP_CONFIRM_WORDS = {
  notReady: "There is no setup from Rovara to use. Ask Rovara to set the project up first.",
  old: "Rovara found this setup for an earlier version of the project's settings. Set the project up again.",
  notChecked: "Rovara could not finish checking where each suggestion came from. Try again in a minute.",
  nothing: "None of the suggestions can be used: each one failed its check, or is a command Rovara does not carry into a test environment.",
  unknownItem: "That suggestion is not part of this setup.",
  testEnvironmentOff: "The test environment is not turned on in this deployment, so a setup can't be used yet.",
  noSmokeOrTest: "The setup has no test command to prove, so there is nothing to use yet.",
  invalid: "The commands could not be made into a test environment.",
} as const;

export type SetupConfirmLeftOut = "unverified" | "refused_command" | "not_a_command_item" | "too_many" | "invalid_command";

export interface SetupConfirmEnvironment { environment: TestEnvironmentBody; used: string[]; unchecked: string[]; left: Array<{ id: string; reason: SetupConfirmLeftOut }> }

const pathOf = (definition: Pick<StoredProjectDefinition, "repositories">, repo: string): string | undefined => definition.repositories.find((repository) => repository.name === repo)?.path;
const idOf = (prefix: string, repo: string, n: number): string => `${prefix}-${repo.toLowerCase().replace(/[^a-z0-9-]+/gu, "-")}-${String(n)}`.replace(/^[^a-z]+/u, "t").slice(0, 63);

/**
 * The safest environment (sandbox tier, no services, nothing else) that holds the proposal's setup commands and test commands. Setup items become the repository's setup commands; each test command becomes a `test`
 * check. An item that failed its re-read, a flagged or secret-shaped command and a command that does not parse are left out, each with its reason. Pure.
 */
export function environmentFromProposal(
  proposal: Pick<SetupProposal, "repositories" | "setup" | "tests" | "checks" | "testEnvironment" | "devcontainer" | "knowledge" | "specTarget" | "sources" | "intake" | "allowedDomains" | "secretsNeeded">,
  verification: Readonly<Record<string, SetupVerification>>,
  definition: Pick<StoredProjectDefinition, "repositories">,
  only?: ReadonlySet<string>,
): SetupConfirmEnvironment | { error: "nothing" | "unknown_item" | "invalid" | "no_test"; id?: string } {
  const items = setupItemsOf(proposal);
  const wanted = items.filter((item) => item.kind === "setup" || item.kind === "tests");
  if (only !== undefined) for (const id of only) if (!wanted.some((item) => item.id === id)) return { error: "unknown_item", id };
  const left: SetupConfirmEnvironment["left"] = [];
  const used: string[] = [];
  const unchecked: string[] = [];
  const repos = new Map<string, { setupCommands: ReturnType<typeof parseCommandLine>[]; checks: Array<Record<string, unknown>> }>();
  const forRepo = (repo: string) => { const found = repos.get(repo) ?? { setupCommands: [], checks: [] }; repos.set(repo, found); return found; };
  let tests = 0;
  for (const item of wanted) {
    if (only !== undefined && !only.has(item.id)) continue;
    const verdict = verification[item.id] ?? "unchecked";
    if (verdict === "unverified") { left.push({ id: item.id, reason: "unverified" }); continue; }
    const value = item.proposed.value as { repo: string; commands: string[] };
    const cwd = pathOf(definition, value.repo);
    if (cwd === undefined) { left.push({ id: item.id, reason: "invalid_command" }); continue; }
    let kept = 0;
    for (const line of value.commands) {
      let command: ReturnType<typeof parseCommandLine>;
      try { command = parseCommandLine(line, cwd, item.kind === "setup" ? SETUP_TIMEOUT : TEST_TIMEOUT); } catch { left.push({ id: item.id, reason: "invalid_command" }); continue; }
      if (refusedCommand(command)) { left.push({ id: item.id, reason: "refused_command" }); continue; }
      const target = forRepo(value.repo);
      if (item.kind === "setup") {
        if (target.setupCommands.length >= 20) { left.push({ id: item.id, reason: "too_many" }); continue; }
        target.setupCommands.push(command);
      } else {
        if (tests >= 32) { left.push({ id: item.id, reason: "too_many" }); continue; }
        tests += 1;
        target.checks.push({ id: idOf("tests", value.repo, target.checks.length + 1), label: "Tests", command, kind: "test" });
      }
      kept += 1;
    }
    if (kept > 0) { used.push(item.id); if (verdict === "unchecked") unchecked.push(item.id); }
  }
  if (used.length === 0) return { error: "nothing" };
  if (![...repos.values()].some((repo) => repo.checks.length > 0)) return { error: "no_test" };
  const parsed = TestEnvironmentBodySchema.safeParse({
    tier: "sandbox",
    repos: [...repos.entries()].map(([repositoryId, repo]) => ({ repositoryId, setupCommands: repo.setupCommands, checks: repo.checks })),
    roundBudgetMin: 30,
    selection: { method: "full", alwaysRun: [], fullSuiteOn: [] },
    nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
    services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] },
    capture: { screenshots: "failed", video: false, traces: false },
  });
  if (!parsed.success) return { error: "invalid" };
  return { environment: parsed.data, used, unchecked, left };
}

export interface SetupConfirmDependencies extends SetupAgentDependencies {
  /** The test environment is on in this deployment (`TEST_ENVIRONMENT_ENABLED`). */
  testEnvironmentOn: boolean;
  /** The approved environment, when there is one: the proposal keeps what a person set there (`mergeDraftWithApproved`). */
  merge(project: string, environment: TestEnvironmentBody): Promise<TestEnvironmentBody | undefined>;
  /** Stores the body as the test-environment proposal for this maintainer (`editTestEnvironment`): never approves it. */
  propose(caller: DeveloperCaller, project: string, role: ProjectRole, environment: TestEnvironmentBody): Promise<{ digest: string }>;
}

const refuse = (code: Parameters<typeof agentXError>[0], message: string) => agentXError(code, message);

/**
 * `POST /v1/app/projects/{name}/setup-agent/confirm`: sends the run's verified setup commands to the test environment as the PROPOSAL. A maintainer, `su` on, the run `ready`, written for the settings the person
 * looked at, with its citations re-read from the code host and final. Nothing is applied: see the file header. The answer names what was used, what was left out and why, and `proved: false`.
 */
export async function confirmSetupAgent(deps: SetupConfirmDependencies, caller: DeveloperCaller, rawName: string, rawBody: unknown): Promise<StatusReply> {
  const { name, role } = await maintainerOf(deps, caller, rawName);
  const parsed = SetupConfirmBodySchema.safeParse(rawBody);
  if (!parsed.success) throw refuse("CONFIG_INVALID", `${parsed.error.issues[0]?.path.join(".") || "body"}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const body = parsed.data;
  if (!deps.testEnvironmentOn) throw refuse("NOT_FOUND", SETUP_CONFIRM_WORDS.testEnvironmentOff);
  const latest = await deps.latest(caller.orgId, name);
  if (latest === undefined) throw refuse("PROJECT_NOT_FOUND", "project not found");
  if (body.expectedRevision !== latest.revision) throw refuse("PROJECT_REVISION_MISMATCH", SETUP_CONFIRM_WORDS.old);
  const state = await readState(deps, caller.orgId, name, latest.revision);
  if (state.view.status !== "ready" || state.view.proposal === undefined) throw refuse("CONFIG_INVALID", SETUP_CONFIRM_WORDS.notReady);
  if (state.view.proposal.basedOnRevision !== latest.revision) throw refuse("PROJECT_REVISION_MISMATCH", SETUP_CONFIRM_WORDS.old);
  // Step 1 of the hard rule: the citations, read again from the code host NOW (or the verdicts kept once final). A re-read that could not finish is not a pass.
  const view = await verifiedView(deps, caller, latest.definition, state.view);
  if (view.verified !== true || view.verification === undefined) throw refuse("CHANGE_STALE", SETUP_CONFIRM_WORDS.notChecked);
  const made = environmentFromProposal(view.proposal!, view.verification, latest.definition, body.itemIds === undefined ? undefined : new Set(body.itemIds));
  if ("error" in made) {
    if (made.error === "unknown_item") throw refuse("CONFIG_INVALID", SETUP_CONFIRM_WORDS.unknownItem);
    if (made.error === "no_test") throw refuse("CONFIG_INVALID", SETUP_CONFIRM_WORDS.noSmokeOrTest);
    throw refuse("CONFIG_INVALID", made.error === "nothing" ? SETUP_CONFIRM_WORDS.nothing : SETUP_CONFIRM_WORDS.invalid);
  }
  const merged = await deps.merge(name, made.environment);
  if (merged === undefined) throw refuse("CONFIG_INVALID", SETUP_CONFIRM_WORDS.invalid);
  const stored = await deps.propose(caller, name, role, merged);
  return new StatusReply(200, {
    digest: stored.digest,
    used: made.used, unchecked: made.unchecked, left: made.left,
    // Applying needs the wizard's next steps; nothing is proved yet.
    proved: false, next: "apply_commands",
  });
}
