// Spending limits (lead 3 B1, DEC 254t b): Cloud's `/v1/app/org/spend-limits` routes. Company admins only. The reader is total over untrusted data: a body
// that is not the shape is unreadable (the page says so, and draws no number it did not read).
export const SPEND_LIMITS_PATH = "/v1/app/org/spend-limits";
/** The ids a limit may name (the same formats Cloud's routes accept), by what the limit is about. */
export const PROJECT_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
export const PERSON_ID = /^[a-f0-9]{64}$/u;
export type SpendLimitScope = "project" | "person";
export const SCOPE_ID: Readonly<Record<SpendLimitScope, RegExp>> = { project: PROJECT_NAME, person: PERSON_ID };
/** Which company default a table's rows replace (so the page can say what everyone else keeps). */
export type DefaultKey = "projectMonthlyUsd" | "memberMonthlyUsd";
/**
 * THE table of the page's limit tables, one per kind in Cloud's SPEND_LIMIT_KINDS (cloud-server company-store.ts): `listKey` names the members of the answer
 * that hold its rows and its bound, `segment` the path. A new kind is an entry here (and its words in the screen's WORDS) and nothing else on this page;
 * tests/web/admin-spend-limits.test.ts draws every entry.
 */
export interface SpendLimitTable { listKey: string; segment: string; scope: SpendLimitScope; defaultKey: DefaultKey; /** The table's heading. */ title: string }
export const SPEND_LIMIT_TABLES: readonly SpendLimitTable[] = [
 { listKey: "projects", segment: "projects", scope: "project", defaultKey: "projectMonthlyUsd", title: "Projects with their own limit" },
 { listKey: "people", segment: "people", scope: "person", defaultKey: "memberMonthlyUsd", title: "People with their own limit" },
];
export const limitPath = (table: SpendLimitTable, id: string) => `${SPEND_LIMITS_PATH}/${table.segment}/${encodeURIComponent(id)}`;
export interface SpendLimitRow { id: string; monthlyUsd: number; version: number }
export interface SpendLimitsRead {
 /** The company defaults (null: no limit of that kind). Changed in Company settings, never here. */
 defaults: { companyMonthlyUsd: number | null; memberMonthlyUsd: number | null; projectMonthlyUsd: number | null; taskUsd: number | null };
 /** The rows of each table, by its `listKey`. */
 lists: Readonly<Record<string, SpendLimitRow[]>>;
 /** There were more limits than the page lists. */
 partial: boolean;
 /** The most rows of each table, by its `listKey`. */
 max: Readonly<Record<string, number>>;
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const usd = (v: unknown): number | null | undefined => (v === null ? null : typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
function rows(raw: unknown, id: RegExp): SpendLimitRow[] {
 if (!Array.isArray(raw)) throw new Error("not spending limits");
 return raw.map(entry => {
  if (!isRecord(entry) || typeof entry["id"] !== "string" || !id.test(entry["id"]) || typeof entry["monthlyUsd"] !== "number" || !Number.isFinite(entry["monthlyUsd"]) || entry["monthlyUsd"] < 0 || !whole(entry["version"]) || entry["version"] < 1) throw new Error("not spending limits");
  return { id: entry["id"], monthlyUsd: entry["monthlyUsd"], version: entry["version"] };
 });
}
export function readSpendLimits(body: unknown): SpendLimitsRead {
 if (!isRecord(body) || !isRecord(body["defaults"]) || !isRecord(body["max"])) throw new Error("not spending limits");
 const d = body["defaults"], company = usd(d["companyMonthlyUsd"]), member = usd(d["memberMonthlyUsd"]), project = usd(d["projectMonthlyUsd"]), task = usd(d["taskUsd"]);
 if (company === undefined || member === undefined || project === undefined || task === undefined || typeof body["partial"] !== "boolean") throw new Error("not spending limits");
 const lists: Record<string, SpendLimitRow[]> = {}, max: Record<string, number> = {};
 for (const table of SPEND_LIMIT_TABLES) {
  const bound = body["max"][table.listKey];
  if (!whole(bound)) throw new Error("not spending limits");
  lists[table.listKey] = rows(body[table.listKey], SCOPE_ID[table.scope]); max[table.listKey] = bound;
 }
 return { defaults: { companyMonthlyUsd: company, memberMonthlyUsd: member, projectMonthlyUsd: project, taskUsd: task }, lists, partial: body["partial"], max };
}
/** A dollar amount a person typed: 0 to 1,000,000 with at most two decimals ("5", "12.50", "$1,200"). undefined for anything else. */
export function parseUsd(text: string): number | undefined {
 const cleaned = text.trim().replace(/^\$/u, "").replace(/,/gu, "");
 if (!/^\d{1,7}(?:\.\d{1,2})?$/u.test(cleaned)) return undefined;
 const value = Number(cleaned);
 return value >= 0 && value <= 1_000_000 ? value : undefined;
}

/** The company's people as the Members page reads them (`GET /v1/app/org/members`), only as much as naming a person needs. Rows that do not read are left out. */
export const MEMBERS_PATH = "/v1/app/org/members";
export interface PersonName { developerId: string; name: string }
export function readPeopleNames(body: unknown): PersonName[] {
 if (!isRecord(body) || !Array.isArray(body["members"])) throw new Error("not members");
 return body["members"].flatMap(row => {
  if (!isRecord(row) || typeof row["developerId"] !== "string" || !PERSON_ID.test(row["developerId"]) || typeof row["name"] !== "string" || row["name"].trim() === "" || row["name"].length > 200) return [];
  return [{ developerId: row["developerId"], name: row["name"].trim() }];
 });
}
