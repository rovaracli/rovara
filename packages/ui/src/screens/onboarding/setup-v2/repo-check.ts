// Project setup, step "Environment check": one row per repository, read for a person. The broker's setup check is ONE check for the whole project (a single status and one failing step), so a row is derived:
// a passing or running check covers every repository; a failed one is attributed to the repository whose command it names, using the commands the test environment proposal lists per repository, or a repository
// name in the failing line. When the failing step names no repository the failure is shown for the whole check instead of guessing. A per-repository check is "needs broker" (see report.md).
import type { ProjectSetupStatus } from "@agentx/cloud-contracts/web";
import { setupFailureOf, type SetupFailure } from "../steps/setup-failure.js";

export type RepoState = "ready" | "checking" | "needs_action" | "not_checked" | "meta";
export interface RepoRow {
 fullName: string;
 role: "code" | "meta";
 state: RepoState;
 /** The words of the status, never colour alone. */
 label: string;
 detail: string;
 failure?: SetupFailure;
}
/** One repository's commands from the test environment proposal (`runs`), as far as matching a failing command needs. */
export interface EnvRun { repositoryId: string; setup: readonly string[]; checks: ReadonlyArray<{ command: string }> }
/**
 * The project's meta repository. The object is the project read's own `metaRepository`: authoritative and kept across a reload, and it is also listed in `repositories`, so it is not a code repository
 * unless `alsoCode` says the project's one repository is its own meta repo. A bare name is what this setup session chose before the read says it: it is told apart only when `repositories` leaves it out.
 */
export type MetaRepositoryRef = string | { fullName: string; alsoCode?: boolean | undefined };
export const metaNameOf = (meta: MetaRepositoryRef | undefined): string | undefined => typeof meta === "string" ? meta : meta?.fullName;
/** The repositories Rovara builds from: the project's, without a meta repository the project read names as separate. */
export function codeRepositoriesOf<T extends { fullName: string }>(repositories: readonly T[], meta: MetaRepositoryRef | undefined): T[] {
 if (meta === undefined || typeof meta === "string" || meta.alsoCode === true) return [...repositories];
 return repositories.filter(repository => repository.fullName.toLowerCase() !== meta.fullName.toLowerCase());
}
export interface RepoCheckInput {
 repositories: ReadonlyArray<{ fullName: string }>;
 setup: { status: ProjectSetupStatus; failedStep?: string | undefined };
 runs?: readonly EnvRun[] | undefined;
 /** The meta repository: from the project's own read (an object), or the name this setup session chose. */
 metaRepository?: MetaRepositoryRef | undefined;
}
export interface RepoCheckModel {
 rows: RepoRow[];
 /** A failure the check could not place in one repository: shown once for the whole check, with the same recovery. */
 unattributed?: SetupFailure;
 /** Every code repository passed. */
 allReady: boolean;
}

const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
const shortName = (fullName: string): string => fullName.slice(fullName.lastIndexOf("/") + 1);
/** Whether a test environment repository id names this repository (its full name, its short name, or an id built from the clone address). */
export function runIsOf(repositoryId: string, fullName: string): boolean {
 const id = repositoryId.toLowerCase(), full = fullName.toLowerCase();
 return id === full || id === shortName(full) || id.endsWith("/" + full) || slug(id).endsWith(slug(full));
}

/** The one repository a failure belongs to, or undefined when it names none or several. */
export function attributeFailure(failure: SetupFailure, repositories: ReadonlyArray<{ fullName: string }>, runs: readonly EnvRun[] = []): string | undefined {
 if (repositories.length === 1) return repositories[0]!.fullName;
 const hits = new Set<string>();
 if (failure.command !== undefined) {
  for (const run of runs) if (run.setup.includes(failure.command) || run.checks.some(check => check.command === failure.command)) for (const repository of repositories) if (runIsOf(run.repositoryId, repository.fullName)) hits.add(repository.fullName);
 }
 if (hits.size === 0) { const text = (failure.cause + " " + (failure.command ?? "")).toLowerCase();for (const repository of repositories) if (text.includes(repository.fullName.toLowerCase())) hits.add(repository.fullName); }
 return hits.size === 1 ? [...hits][0] : undefined;
}

const NO_REASON: SetupFailure = { step: "Setup check", cause: "No reason was recorded.", fix: "Run the check again. If it fails again, edit the setup commands or let the setup agent try." };

export function repoCheckModel(input: RepoCheckInput): RepoCheckModel {
 const { setup } = input, repositories = codeRepositoriesOf(input.repositories, input.metaRepository), metaName = metaNameOf(input.metaRepository), rows: RepoRow[] = [];
 const failure = setup.status === "failed" ? setupFailureOf(setup.failedStep) ?? NO_REASON : undefined;
 const culprit = failure === undefined ? undefined : attributeFailure(failure, repositories, input.runs);
 for (const repository of repositories) {
  const base = { fullName: repository.fullName, role: "code" as const };
  if (setup.status === "ready") rows.push({ ...base, state: "ready", label: "Ready", detail: "Passed the project's setup check." });
  else if (setup.status === "checking") rows.push({ ...base, state: "checking", label: "Checking", detail: "Rovara is installing and testing on a fresh machine. You can leave and come back." });
  else if (failure !== undefined && culprit === repository.fullName) rows.push({ ...base, state: "needs_action", label: "Needs action", detail: "The check stopped here.", failure });
  else if (failure !== undefined) rows.push({ ...base, state: "not_checked", label: "Not checked on its own", detail: culprit === undefined ? "The check stopped before it said which repository." : "The check stopped at " + culprit + " first." });
  else rows.push({ ...base, state: "not_checked", label: setup.status === "outdated" ? "Settings changed" : "Not checked yet", detail: setup.status === "outdated" ? "The setup changed since the last check. Check it again." : "Run the check so the first task doesn't fail on setup." });
 }
 if (metaName !== undefined && !repositories.some(repository => repository.fullName.toLowerCase() === metaName.toLowerCase())) {
  rows.push({ fullName: metaName, role: "meta", state: "meta", label: "Meta repo", detail: "Holds your plans, rules and lessons. Nothing is built from it." });
 }
 const unattributed = failure !== undefined && culprit === undefined && repositories.length > 1 ? failure : undefined;
 return { rows, ...(unattributed === undefined ? {} : { unattributed }), allReady: repositories.length > 0 && setup.status === "ready" };
}

export type Recovery = "fix_with_agent" | "retry" | "edit_setup";
export const RECOVERY_LABEL: Readonly<Record<Recovery, string>> = { fix_with_agent: "Fix with the setup agent", retry: "Retry the check", edit_setup: "Edit the setup" };
/** The ways forward for a row, best first: the setup agent only where it is on (the `su` switch), Retry, then editing the commands by hand. Rows that are fine or already running offer none. */
export function recoveryChoices(state: RepoState, options: { agentAvailable: boolean }): Recovery[] {
 if (state === "needs_action") return [...(options.agentAvailable ? ["fix_with_agent" as const] : []), "retry", "edit_setup"];
 if (state === "not_checked") return ["retry", "edit_setup"];
 return [];
}
