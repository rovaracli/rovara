import type { LoadedKnowledgeItem, LoadedKnowledgeManifest } from "@agentx/contracts/web";

export const STAGE_TITLES: Record<LoadedKnowledgeManifest["stage"], string> = { understand: "Understand", plan: "Plan", plan_check: "Plan check", build: "Build", review: "Review" };

const WHY: Record<string, string> = { always: "Always on", required: "Required by your company", read_by_tool: "Read by the agent" };
const SKIP: Record<string, string> = {
 not_matched: "No matching files", not_requested: "Not asked for", excluded_stage: "Not used in this stage", bad_front_matter: "Its header could not be read",
 too_large: "Too large", over_budget: "Left out: over the size budget", not_in_plan_set: "Not part of the plan's rules", unreadable: "Could not be read",
 symlink: "A link, not followed", found_not_run: "Found, not run (Rovara does not run repository hooks)", duplicate: "Duplicate of another file", overridden: "Replaced by an override file",
};
export const SKILL_SKIP: Record<string, string> = {
 bad_front_matter: "Header could not be read", bad_name: "Name not allowed", duplicate_name: "Same name as another skill", too_large: "Too large",
 over_cap: "Over the limit of 32 skills", digest_mismatch: "Changed since it was pinned", not_pinned: "Added after the skills were pinned", unreadable: "Could not be read", symlink: "A link, not followed",
};
const MODES: Record<string, string> = { always: "always", fileMatch: "matching files", manual: "when named", auto: "when it applies" };

/** One item in words. Everything here is a fixed sentence or a count; names and paths are shown separately as untrusted text. */
export function itemWords(item: LoadedKnowledgeItem): string {
 if (item.status === "loaded") {
  const why = item.why;
  if (why === undefined) return "Loaded";
  if (why.kind === "matched") return "Loaded: matched " + why.detail;
  if (why.kind === "named") return "Loaded: asked for as #" + why.detail;
  return WHY[why.kind] ?? "Loaded";
 }
 if (item.status === "available") return "Listed for the agent to read when it applies";
 return (item.reason !== undefined ? SKIP[item.reason] : undefined) ?? "Left out";
}
export function modeWords(item: LoadedKnowledgeItem): string { return item.activation === undefined ? "" : MODES[item.activation] ?? ""; }
export function kilobytes(bytes: number): string { return bytes < 1024 ? String(bytes) + " B" : (bytes / 1024).toFixed(1) + " KB"; }
export function budgetWords(budget: LoadedKnowledgeManifest["budget"]): string {
 return "Budget: " + String(Math.round(budget.alwaysOnBytes / 1024)) + " KB of " + String(Math.round(budget.alwaysOnLimitBytes / 1024)) + " KB always-on, " + String(budget.skipped) + " left out for size";
}
export function textRefusal(reason: "not_kept" | "unreadable" | "changed"): string {
 return reason === "not_kept" ? "The text of a file the agent read from its own working copy is not kept." : reason === "changed" ? "That file no longer matches what the agent saw, so it is not shown." : "The file could not be read right now.";
}
