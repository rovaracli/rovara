// Guided onboarding PR 15 (DEC 254l item 7, DEC 254n item 1): the "AI and spending" step's reads. Cloud answers them from Rovara Code as the
// signed-in person (packages/cloud-server/src/ai-spend-routes.ts). Every reader is total over untrusted data: a body that is not the shape throws
// ("couldn't be read"), never half drawn.
export const ENGINE_MODEL_PATH = "/v1/app/org/engine-model";
export const spendLimitsPath = (project: string) => `/v1/app/projects/${encodeURIComponent(project)}/spend-limits`;
/**
 * The company monthly limit the step prefills when none is saved yet, in US dollars: the existing placeholder company cap (contracts org-budget.ts
 * DEFAULT_ORG_MONTHLY_BUDGET_USD, ruling R29; a test holds the two together). The person sees it and saves it with one click, or changes it.
 */
export const COMPANY_MONTHLY_DEFAULT_USD = 500;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const MODEL_ID = /^(?:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}|[a-z0-9][a-z0-9._-]{0,62}\/[a-z0-9][a-z0-9._-]{0,62})$/u;

export interface EngineModelRead {
 /** What the company's tasks use now: its own model, else this Rovara's default; null when there is none. */
 model: string | null;
 /** "company" once the company saved its own model; "install" while it follows this Rovara's default. */
 source: "company" | "install";
 /** The models the company's gateway offers it now, best first. */
 offered: string[];
 /** The model the picker starts on. */
 preselect: string;
 /** Whether this person may change it (a company owner or admin). */
 canChange: boolean;
}
export function readEngineModel(body: unknown): EngineModelRead {
 if (!isRecord(body)) throw new Error("not the company's AI model");
 const { model, source, offered, preselect, canChange } = body;
 if (!(model === null || (typeof model === "string" && MODEL_ID.test(model))) || (source !== "company" && source !== "install") || typeof canChange !== "boolean") throw new Error("not the company's AI model");
 if (!Array.isArray(offered) || offered.length === 0 || !offered.every(id => typeof id === "string" && MODEL_ID.test(id)) || typeof preselect !== "string" || !offered.includes(preselect)) throw new Error("not the company's AI model");
 return { model, source, offered: (offered as string[]).slice(), preselect, canChange };
}

export interface SpendLimitsRead {
 project: string;
 revision: number;
 /** "Same as company" when the project has no per-task limit of its own; else its own amount in dollars (null: it asked for none of its own). */
 perTask: { sameAsCompany: true; usd: null } | { sameAsCompany: false; usd: number | null };
 /** The per-task limit that applies now, in dollars (null: no fixed amount, Rovara's estimate applies); undefined when Cloud didn't say. */
 appliedUsd: number | null | undefined;
 canChange: boolean;
}
export function readSpendLimits(body: unknown): SpendLimitsRead {
 if (!isRecord(body) || typeof body["project"] !== "string" || typeof body["revision"] !== "number" || !Number.isSafeInteger(body["revision"]) || body["revision"] < 0 || typeof body["canChange"] !== "boolean") throw new Error("not spending limits");
 const per = body["perTask"];
 if (!isRecord(per)) throw new Error("not spending limits");
 const money = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
 const perTask = per["sameAsCompany"] === true && per["usd"] === null ? { sameAsCompany: true as const, usd: null }
  : per["sameAsCompany"] === false && (per["usd"] === null || money(per["usd"])) ? { sameAsCompany: false as const, usd: per["usd"] } : undefined;
 if (perTask === undefined) throw new Error("not spending limits");
 const applied = body["appliedUsd"];
 return { project: body["project"], revision: body["revision"], perTask, appliedUsd: applied === null || money(applied) ? applied : undefined, canChange: body["canChange"] };
}

/** A dollar amount typed by a person: up to two decimals, at most `max`. undefined is "not an amount". */
export function dollarsOf(text: string, max: number): number | undefined {
 const t = text.trim();
 if (!/^\d{1,7}(?:\.\d{1,2})?$/u.test(t)) return undefined;
 const n = Number(t);
 return n <= max ? n : undefined;
}
