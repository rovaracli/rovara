// The Wiki tab's words, in one place (design: designs-2026-11-17/project-wiki-ux.md; DEC 254zh: "source found", never "verified"). Wiki text itself is never here:
// it comes from the page read and is drawn as plain text.
import type { WikiIndexEntry, WikiLastBuild, WikiSourceState } from "../../../api/wiki.js";

export const T = {
  TITLE: "Project wiki",
  SUBTITLE: "A map of the code. Hints, not rules.",
  NAV: "Wiki pages",
  SEARCH: "Search the wiki",
  SEARCH_PLACEHOLDER: "Search pages",
  BROWSE: "Browse pages",
  HIDE: "Hide pages",
  LOADING: "Loading the wiki",
  LOADING_PAGE: "Loading the page",
  GROUP_PROJECT: "Project",
  GROUP_REPOS: "Repos",
  EMPTY_NONE_TITLE: "No wiki yet",
  EMPTY_NONE: "A project admin builds the wiki on Project setup. They see the cost forecast and the cap first.",
  EMPTY_BUILDING_TITLE: "The wiki is being built",
  EMPTY_BUILDING: "Pages show here as soon as the build ends.",
  EMPTY_STOPPED_TITLE: "The wiki build stopped before any page was written",
  UNAVAILABLE: "The project wiki could not be read just now. Try again.",
  RETRY: "Try again",
  NO_PAGE: "That page isn't in this wiki.",
  FLAGGED_PAGE: "Someone marked this page wrong. It is hidden from agents until the next refresh rewrites it.",
  MOSTLY_OLD: "Most claims on this page may be out of date. Check the code.",
  WRITTEN_BY: "Written by Rovara from the code",
  TRUTH_EXTRA: "This wiki lives in Rovara's store and is never committed to your repos.",
  ON_PAGE: "On this page",
  ABOUT: "About this page",
  SOURCES: "Relevant source files",
  SOURCES_LOADING: "Loading the cited files",
  SOURCES_FAILED: "The cited files could not be read just now.",
  SOURCE_OPEN: "Open on the code host",
  SOURCE_CLOSE: "Close source",
  DIAGRAM: "Diagram (text form)",
  NOTE_FROM: "Note from",
  NOTE_PENDING: "Shown to people now. Agents get it after a maintainer approves it.",
  NOTE_APPROVED: "Pinned for people and agents. Kept through every refresh.",
  NOTE_FILE: "It points to",
  STALE: "May be stale.",
  STALE_NOTE: "A file this paragraph cites changed since this page was written.",
  NOT_FOUND_NOTE: "A source was not found when this was last checked.",
  WRONG: "Marked wrong.",
  WRONG_AFTER: "Hidden from agents now. The next refresh rewrites it.",
  NO_RESULTS: "No page mentions that. The wiki does not guess. Try another word.",
  KEY_CHANGED: "some claims may be out of date",
  KEY_BAD: "out of date or marked wrong",
  REFRESHING: "A refresh is running.",
} as const;

export const SOURCE_WORDS: Record<WikiSourceState, string> = {
  found: "Source found",
  changed: "A file this claim cites changed since the page was written. The claim may be out of date.",
  not_found: "The source was not found when this was last checked.",
};

export const BUILD_STOP_WORDS: Record<NonNullable<WikiLastBuild["stopReason"]>, string> = {
  cap: "The last build stopped at its cost limit.",
  person: "The last build was stopped by a person.",
  repo_unreadable: "The last build stopped because Rovara could not read a repo.",
  no_ai_key: "The last build did not run: no AI key is connected.",
  unpriced_model: "The last build did not run: the model has no price.",
  failed: "The last build failed.",
};
/** One sentence about the last build when it did not finish well, else nothing. */
export function buildNotice(build: WikiLastBuild | undefined): string | undefined {
  if (build === undefined) return undefined;
  if (build.state === "running") return T.REFRESHING;
  if (build.state === "stopped" || build.state === "failed") return build.stopReason !== undefined ? BUILD_STOP_WORDS[build.stopReason] : BUILD_STOP_WORDS.failed;
  return undefined;
}

export interface Chip { tone: "ok" | "warn" | "bad"; short: string; long: string }
/** The one freshness chip: "Up to date" or "3 of 12 cited claims may be out of date"; "Out of date" once half or more changed. */
export function chipOf(claims: { found: number; changed: number }): Chip {
  const total = claims.found + claims.changed;
  if (claims.changed === 0) return { tone: "ok", short: "Up to date", long: "No cited file has changed since this page was written." };
  const long = `${String(claims.changed)} of the ${String(total)} cited claims may be out of date: a file they cite changed since this page was written.`;
  return claims.changed * 2 >= total ? { tone: "bad", short: "Out of date", long } : { tone: "warn", short: `${String(claims.changed)} of ${String(total)} cited claims may be out of date`, long };
}

/** A tree dot for a page, with its words (also read aloud). Pages with nothing to say have none. */
export function dotOf(entry: Pick<WikiIndexEntry, "claims" | "flagged">): { tone: "warn" | "bad"; words: string } | undefined {
  if (entry.flagged) return { tone: "bad", words: "Marked wrong" };
  if (entry.claims.changed === 0) return undefined;
  return chipOf(entry.claims).tone === "bad" ? { tone: "bad", words: "Out of date" } : { tone: "warn", words: "Some claims may be out of date" };
}

export interface TreeGroups { project: WikiIndexEntry[]; repos: Array<{ page: WikiIndexEntry; children: WikiIndexEntry[] }> }
const byOrder = (a: WikiIndexEntry, b: WikiIndexEntry) => a.order - b.order || a.title.localeCompare(b.title);
/** The tree: project pages first, then each repo's page with the module pages under it, each level in Code's order. */
export function treeOf(pages: readonly WikiIndexEntry[]): TreeGroups {
  const ids = new Set(pages.map((page) => page.pageId));
  const repos = pages.filter((page) => page.kind === "repo").sort(byOrder);
  const repoIds = new Set(repos.map((page) => page.pageId));
  const under = (id: string) => pages.filter((page) => page.parentId === id && page.kind !== "repo").sort(byOrder);
  const project = pages.filter((page) => page.kind !== "repo" && (page.parentId === undefined || !ids.has(page.parentId) || !repoIds.has(page.parentId))).sort(byOrder);
  return { project, repos: repos.map((page) => ({ page, children: under(page.pageId) })) };
}

export const crumbOf = (entry: Pick<WikiIndexEntry, "kind" | "parentId" | "repos">, pages: readonly WikiIndexEntry[]): string => {
  if (entry.kind === "repo") return "Repos";
  const parent = pages.find((page) => page.pageId === entry.parentId && page.kind === "repo");
  return parent !== undefined ? parent.title : "Project";
};
export const shortSha = (sha: string): string => sha.slice(0, 7);
export const linesWords = (line: number, lineEnd?: number): string => (lineEnd === undefined || lineEnd === line ? `line ${String(line)}` : `lines ${String(line)}-${String(lineEnd)}`);
