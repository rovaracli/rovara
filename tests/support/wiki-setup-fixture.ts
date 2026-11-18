// The pretend Code's wiki build, for the setup page's wiki panel (lead 4 W6): the file map (W0) and the build state (W4) a made-up project has, in the shapes Rovara Code answers (Code local branch
// pr/l4-wiki-controls at fafd0ea13; Cloud's mirror is packages/contracts/src/app-wiki-setup.ts). The dollar members, the task id and the commits are in the answers on purpose: Cloud must not pass them on.
import { WIKI_SETUP_CODE_WORDS } from "../../packages/contracts/src/app-wiki-setup.js";

export interface FakeWikiSetup {
  status: "none" | "running" | "built" | "stopped";
  stop?: "built" | "budget_used" | "pages_used" | "time_used" | "stopped_by_person" | "needs_ai_key" | "repo_unreadable" | "access_lost" | "infrastructure";
  pages: number; refreshPages: number; agentsOn: boolean; aiKey: "connected" | "missing" | "unknown"; mapMade: boolean; planned: number; written: number; upkeepOn: boolean; off?: boolean; upkeepOff?: boolean;
  /** L4-P2: the operator ceiling is off (Code answers `available: false`). */ ceilingOff?: boolean;
  /** The cap Code states (it has no read today, so the default is `null`). */ capUsd?: number;
  /** A Code with the project switch only (L4-N1): no consent members in the answer. */ legacyUpkeep?: boolean;
  /** L4-U5: the project's setup is broken: the check's failing step, and whether a checked fix waits for approval. Absent: the setup works. */ repair?: { step: string; fixReady: boolean; changed?: string };
  /** L4-U5: nightly upkeep is paused now, for this reason (Code tells managers only). */ paused?: "no_budget" | "monthly_limit" | "cost_too_high";
  /** L4-U5: a Code with no `setup-check` read: its unknown-route 404. */ setupCheckOff?: boolean;
  /** L4-U5: how many "Re-check setup" starts Code took, and whether one is running (a second start is 409). */ rechecks?: number; rechecking?: boolean;
}
const commit = (c: string) => c.repeat(40);

/** The map of a made-up project: two repos, one with a partial reading, chips with the generated-folder one on by default. */
export function wikiMapOf(project: string): Record<string, unknown> {
  return {
    version: 1, project, computedAt: "2026-11-17T09:00:00.000Z", complete: true, repositoriesOmitted: 0,
    repositories: [
      { name: "web", url: "https://github.com/example/web", status: "ok", branch: "main", commit: commit("a"), files: 1_204, skipped: { generated: 4, vendored: 9, lockfiles: 1, assets: 30, secret: 2 }, languages: [{ language: "TypeScript", files: 900, percent: 75 }],
        areas: [{ path: "src/billing", files: 120, kind: "source", commits: 40, rank: 1 }], testFolders: ["tests"], skippedFolders: ["dist", "vendor"], activity: { status: "ok", days: 90 }, pages: { repository: 1, modules: 14, modulesCapped: false } },
      { name: "api", url: "https://github.com/example/api", status: "ok", branch: "main", commit: commit("b"), files: 2_310, skipped: { generated: 0, vendored: 0, lockfiles: 2, assets: 4, secret: 0 }, languages: [{ language: "Python", files: 1_800, percent: 78 }],
        areas: [{ path: "app/payments", files: 200, kind: "source", commits: 61, rank: 1 }], testFolders: ["tests"], skippedFolders: [], activity: { status: "ok", days: 90 }, pages: { repository: 1, modules: 6, modulesCapped: false } },
    ],
    chips: [
      { id: "write-first-web-src-billing", kind: "write_first", repo: "web", path: "src/billing", label: "Write these first? web/src/billing", defaultOn: false },
      { id: "skip-old-api-legacy", kind: "skip_old", repo: "api", path: "legacy", label: "Skip? api/legacy (no change in 90 days)", defaultOn: false },
      { id: "skip-generated-web-dist", kind: "skip_generated", repo: "web", path: "dist", label: "Skip? web/dist (generated)", defaultOn: true },
    ],
    forecast: { repositories: 2, files: 3_514, pages: 24, pagesCapped: false, complete: true, price: "not_priced_yet" },
    limits: { activityDays: 90, modulePagesPerRepository: 40, pagesPerProject: 300, areasPerRepository: 40 },
  };
}

/** W4's state, as Code answers it. */
export function wikiSetupBuildView(one: FakeWikiSetup, manage: boolean): Record<string, unknown> {
  const done = one.status === "built";
  return {
    status: one.status, limits: { pages: 300, budgetCents: 2_500, wallClockMin: 180, pageReserveCents: 100 },
    ...(one.status === "none" ? {} : { taskId: "task-fake-0001", startedAt: "2026-11-17T10:00:00.000Z" }),
    ...(one.stop === undefined ? (done ? { stop: "built" } : {}) : { stop: one.stop }),
    ...(done ? { message: WIKI_SETUP_CODE_WORDS.built } : one.stop !== undefined ? { message: WIKI_SETUP_CODE_WORDS[one.stop] } : {}),
    ...(one.status === "none" ? {} : { summary: { pagesPlanned: one.planned, pagesWritten: one.written, pagesKeptFromEarlier: 0, claimsKept: one.written * 6, claimsDropped: one.written > 0 ? 3 : 0, spentCents: one.written * 31 } }),
    ...(one.status === "stopped" ? { canContinue: true } : {}),
    payer: "project", ...(one.stop === "stopped_by_person" ? { stoppedBy: { name: "Priya", at: "2026-11-17T10:30:00.000Z" } } : {}),
    canManage: manage, aiKey: one.aiKey, ...(one.aiKey === "missing" ? { connectKey: WIKI_SETUP_CODE_WORDS.connectKey } : {}),
    agents: { on: one.agentsOn }, wiki: { pages: one.pages, refreshPages: one.refreshPages },
  };
}
