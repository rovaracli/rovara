// The wiki panel's words (design: designs-2026-11-17/project-wiki-ux.md section 4a and the demo's setup tab; DEC 254zh: "source found", never "verified"; DEC 254zi: no dollar figure until the build is priced; the nightly upkeep cap and spend are the exception).
// The panel shows PAGES. It names no cap and no cost: the first measured build prices it. Wiki text itself is never here.
import type { WikiSetupBuild, WikiSetupRepo } from "../../../api/wiki-setup.js";

export const T = {
  TITLE: "Project wiki",
  SUBTITLE: "A map of the code, written by Rovara. Hints, not rules.",
  READ_ONLY: "Only project admins can build the wiki or change these settings. You can see where it stands.",
  OPEN: "Open the wiki",
  LOADING: "Loading the project wiki",
  UNAVAILABLE: "The wiki build could not be read just now. Try again.",
  RETRY: "Try again",
  // Before a build
  NO_MAP: "Rovara reads your repos and writes a wiki for people and agents. Nothing is written until you press Build. First, map the files: that is free and uses no AI.",
  NO_MAP_VIEWER: "A project admin builds the wiki here. They see how many pages it will have first.",
  MAP_FILES: "Map the files",
  MAP_AGAIN: "Map the files again",
  MAP_UNAVAILABLE: "The file map isn't available on this Rovara yet.",
  FORECAST_LEDE: "Rovara reads your repos and writes a wiki for people and agents. Nothing is written until you press Build. Here is what it expects to write.",
  FORECAST_PARTIAL: "This forecast rests on a map that is not whole, so the real number of pages may be higher.",
  TOTAL: "Total, with the overview and the cross-repo pages",
  SPENDS: "Building uses your AI key and counts against this project's monthly limit. The build has its own limit and keeps the pages it finishes. There is no cost figure yet: the first build measures it.",
  FREE_MAP: "Mapping the files is free and uses no AI. Module pages start with the most active parts of the code. Secret-shaped files such as .env are skipped.",
  BUILD: "Build wiki",
  BUILD_NOTE: "Pressing Build is your act on this page. It does not use the automation switch.",
  MATTERS: "Tell Rovara what matters (optional)",
  MATTERS_HINT: "These steer which parts get pages first. They are kept in Rovara, not in your repos, and never become wiki text: every sentence still needs a source.",
  CHIPS_FIRST: "Write these first",
  CHIPS_SKIP: "Skip these",
  NOTES_LABEL: "Notes for the wiki build",
  NOTES_PLACEHOLDER: "For example: the core is billing and booking in the api repo. Skip the old reports module.",
  CONNECT_KEY_LINK: "Connect an AI key",
  CONNECT_KEY_ASK: "Ask a company owner or admin to connect one.",
  // While and after a build
  RUNNING: "Building the wiki",
  STOP: "Stop",
  CONTINUE: "Continue",
  RAISE_CAP: "This wiki build already used its spending limit. Raising it is not something this page can do yet; finished pages are kept.",
  CONTINUE_NOTE: "Starts where it stopped.",
  PROGRESS: "Wiki build progress",
  PAGES_OF: (written: number, planned: number) => `${String(written)} of ${String(planned)} pages`,
  STOPPED_BY: (name: string) => `Stopped by ${name}.`,
  REPORT: "Build report",
  PAGES_WRITTEN: "Pages written",
  PAGES_KEPT: "Pages kept from before",
  CLAIMS_KEPT: "Sentences with a source found",
  CLAIMS_DROPPED: "Sentences dropped",
  DROPPED_NOTE: "A sentence whose source was not found is dropped, so every sentence on a page points at a file and line. You do not need to approve each page.",
  SKIPPED: "Skipped",
  SKIPPED_FOLDERS: "See the skipped folders",
  // Controls
  AGENTS: "Give the wiki to agents",
  AGENTS_TEXT: "Each task step gets a short index of the wiki and can read full pages. Agents are told the wiki is a hint and the code wins.",
  AGENTS_ON: "New tasks get the index. Running tasks are not changed.",
  AGENTS_OFF: "People can still read the wiki. Agents do not get it until you turn this on.",
  REFRESH: "Refresh now",
  REFRESH_TEXT: "Rewrites the pages whose cited files changed and the pages someone marked wrong.",
  REFRESH_SOME: (n: number) => `${String(n)} ${n === 1 ? "page is" : "pages are"} out of date or marked wrong.`,
  REFRESH_NONE: "Every page is up to date.",
  DELETE: "Delete wiki",
  DELETE_TEXT: "Removes all pages, notes and build records. The wiki lives in Rovara's store, never in your repos, so nothing changes in your code.",
  DELETE_RUNNING: "Stop the build first, then delete the wiki.",
  DELETE_ASK: "Delete all pages and notes?",
  DELETE_YES: "Delete",
  CANCEL: "Cancel",
  DELETED: "The wiki was deleted. Pages, notes and build records are gone. You can build it again.",
  // Nightly upkeep
  UPKEEP: "Nightly upkeep",
  UPKEEP_TEXT: "Every night your code changed, Rovara re-checks the setup and the mocks, drafts a fix when something breaks, and refreshes the project wiki. Rovara never approves anything for you.",
  UPKEEP_ON: "Nightly upkeep is on. It says nothing when all is fine.",
  UPKEEP_OFF: "Nightly upkeep is off. Pages still show when their files changed. Use Refresh now when you want.",
  OFFER_TITLE: "Keep this project healthy every night",
  OFFER_BUTTON: "Keep this project healthy every night",
  OFFER_CONFIRM_LINE: "Setup check and mock checks: no AI. Wiki refresh: AI, uses your key.",
  OFFER_CONFIRM_ASK: "Turn this on for the company?",
  OFFER_YES: "Yes, keep it healthy",
  CAP_LINE_SET: "Monthly cap:",
  CAP_LINE_UNSET: "Monthly cap: set in",
  CAP_LINK_LIMITS: "Spending limits",
  CAP_LINK_RAISE: "Raise the cap",
  NEEDS_ADMIN: "A company admin must allow nightly upkeep first.",
  COMPANY_TITLE: "Nightly upkeep for the company",
  COMPANY_ALLOWED: "Allowed",
  COMPANY_NOT_ALLOWED: "Not allowed",
  COMPANY_WITHDRAW: "Withdraw",
  COMPANY_WITHDRAW_ASK: "Nightly runs stop for every project now. Projects keep their switch.",
  COMPANY_WITHDRAW_YES: "Yes, withdraw",
  COMPANY_WITHDRAWN: "Withdrawn. Nightly runs stopped for every project. Projects keep their switch.",
  COMPANY_ALLOW_WHERE: "To allow it, use \"Keep this project healthy every night\" on a project's setup page.",
  COMPANY_NOT_AVAILABLE: "Nightly upkeep isn't available on this Rovara yet.",
  COMPANY_UNREADABLE: "Nightly upkeep for the company could not be read just now. Try again.",
  COMPANY_LINK: "Company settings",
  COMPANY_LINK_LINE: "Withdraw nightly upkeep for the whole company in",
  UPKEEP_NOT_YET: "Nightly upkeep isn't available on this Rovara yet.",
  SPEND_LINE: "Nightly upkeep this month:",
  SPEND_OF: "of",
  SPEND_AT_LEAST: "at least",
  SPEND_TINY: "less than $0.01",
  UPKEEP_LIMITS: "Which limit each part uses",
  LIMIT_FREE: "Setup and mock checks: no AI. They use machine minutes, held by the project's automatic-run limit.",
  LIMIT_CAP: "Wiki refresh and repair drafts: your AI key, held by the nightly upkeep cap below.",
  LIMIT_MANUAL: "Build wiki and Refresh now, when you press them: your AI key, held by this project's monthly limit and the build's own limit.",
  CAP: "Monthly cap on nightly upkeep",
  CAP_HINT: "The most nightly upkeep may spend on AI in a month. $0 stops it spending. A lower cap saves at once; a higher one asks you to confirm it's you.",
  CAP_DEFAULT: "This is the standard cap for nightly upkeep. Saving gives this project its own cap.",
  CAP_OWN: "This project has its own cap.",
  CAP_NONE: "No cap is set.",
  CAP_SAVE: "Save cap",
  CAP_SAVED: "Saved.",
  CAP_INVALID: "Use an amount from 0 to 1,000,000, with at most two decimals.",
  CAP_ASK_ADMIN: "A company owner or admin sets the monthly cap.",
  CAP_UNREADABLE: "The monthly cap could not be read just now.",
  CAP_FAILED: "That could not be saved just now. Try again.",
  ACT_FAILED: "That could not be done just now. Try again.",
} as const;

/** The refusals of Cloud's spending-limit routes that the cap field may show (fixed sentences; anything else reads CAP_FAILED). */
export const CAP_SENTENCES: ReadonlySet<string> = new Set([
  "Only a company admin can see or change spending limits.",
  "Your company's rules don't allow raising a limit.",
  "Raising this limit needs a second admin under your company's rules. Ask an owner to change the rules, or raise the company default in Company settings.",
  "Send the amount in dollars, from 0 to 1,000,000 with at most two decimals, or null to remove the limit.",
  "That project doesn't exist, or you can't use it.",
  "This limit changed since you opened it. Refresh and try again.",
  "There are too many limits of this kind. Remove some first.",
  "The spending limits couldn't be read. Ask an installation administrator to check them.",
  "Spending limits are unavailable right now. Try again.",
  "Spending limits aren't set up on this Cloud.",
]);

export type RowState = "done" | "needs_you" | "running" | "optional";
/** The checklist pill for the wiki row: not built (optional), running, stopped with something to do, built. */
export function rowStateOf(build: Pick<WikiSetupBuild, "status" | "canManage" | "canContinue">): RowState {
  if (build.status === "running") return "running";
  if (build.status === "built") return "done";
  if (build.status === "stopped") return build.canManage && build.canContinue === true ? "needs_you" : "done";
  return "optional";
}

/** What was skipped across the repos, as one sentence of counts (never a name; secret-shaped files are only counted). */
export function skippedLine(repos: readonly WikiSetupRepo[]): string | undefined {
  const sum = (pick: (repo: WikiSetupRepo) => number) => repos.reduce((total, repo) => total + pick(repo), 0);
  const parts: string[] = [];
  const codeless = sum((repo) => repo.skipped.generated + repo.skipped.vendored);
  if (codeless > 0) parts.push(`${String(codeless)} generated or vendored files`);
  if (sum((repo) => repo.skipped.lockfiles) > 0) parts.push(`${String(sum((repo) => repo.skipped.lockfiles))} lock files`);
  if (sum((repo) => repo.skipped.assets) > 0) parts.push(`${String(sum((repo) => repo.skipped.assets))} images and other binary files`);
  if (sum((repo) => repo.skipped.secret) > 0) parts.push(`${String(sum((repo) => repo.skipped.secret))} secret-shaped files (never read)`);
  return parts.length === 0 ? undefined : parts.join(", ");
}
