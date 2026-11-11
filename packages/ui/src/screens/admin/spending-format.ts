// Plain words and arithmetic for the Spending page. No money rule lives here: this only turns what the reads return into numbers and sentences to show.
export interface Figures { spentUsd: number; committedUsd: number; limitUsd?: number | undefined }
const micro = (usd: number): number => Math.round(usd * 1_000_000);
/** "2026-11" as "November 2026" (UTC, so the month never moves with the device's zone). */
export function monthLabel(month: string): string {
 const match = /^(\d{4})-(0[1-9]|1[0-2])$/u.exec(month);
 if (match === null) return "This month";
 return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}
/** What is left of the allowance after what was spent and what is held, never below zero; undefined when there is no allowance to measure against. */
export function availableUsd(figures: Figures): number | undefined {
 if (figures.limitUsd === undefined) return undefined;
 return Math.max(0, micro(figures.limitUsd) - micro(figures.spentUsd) - micro(figures.committedUsd)) / 1_000_000;
}
/** True when spent and held together are past the allowance. */
export function isOverAllowance(figures: Figures): boolean {
 return figures.limitUsd !== undefined && micro(figures.spentUsd) + micro(figures.committedUsd) > micro(figures.limitUsd);
}
/** The two bar segments as whole-or-fractional percentages of the allowance: spent first, then held, together never past 100. Both 0 when there is no allowance to measure. */
export function barShares(figures: Figures): { spent: number; held: number } {
 if (figures.limitUsd === undefined || figures.limitUsd <= 0) return { spent: 0, held: 0 };
 const limit = micro(figures.limitUsd), spent = Math.min(100, (micro(figures.spentUsd) / limit) * 100), held = Math.min(100 - spent, (micro(figures.committedUsd) / limit) * 100);
 return { spent: Math.round(spent * 10) / 10, held: Math.round(held * 10) / 10 };
}
/** A share of a total as a whole percent; 0 when the total is 0. */
export function percentOf(part: number, total: number): number {
 return total <= 0 ? 0 : Math.round((micro(part) / micro(total)) * 100);
}
const SOURCES: Record<string, string> = {
 rovara: "Rovara-provided", "personal-chatgpt": "A person's ChatGPT plan", anthropic: "Company Anthropic key", openai: "Company OpenAI key", openrouter: "Company OpenRouter key", bedrock: "Company Amazon Bedrock", endpoint: "Company custom endpoint",
};
/** Where the money came from, in words. A source this page does not know is "Another source", never the raw value. */
export function sourceWords(source: string): string { return Object.hasOwn(SOURCES, source) ? SOURCES[source]! : "Another source"; }
const KINDS: Record<string, string> = {
 run_limit: "More budget for one task", max_per_run: "A higher limit for one run", planning: "A higher planning limit", month: "More monthly budget", owner_cap: "More budget for an agent owner",
};
export function requestKindWords(kind: string | undefined): string { return kind !== undefined && Object.hasOwn(KINDS, kind) ? KINDS[kind]! : "Other request"; }
const APPROVERS: Record<string, string> = {
 payer: "The person paying", project_maintainer: "The project's maintainers", agent_owner: "The agent's owner", chain_owner: "The owner of the agent chain", org_admin: "Company owners and admins",
};
export function approverWords(role: string | undefined): string { return role !== undefined && Object.hasOwn(APPROVERS, role) ? APPROVERS[role]! : "Whoever the company allows"; }
