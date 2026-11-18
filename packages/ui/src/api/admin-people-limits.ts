// People and limits (cost report slice A6, decision D2): Cloud's `GET /v1/app/org/people-limits`. Company owners and admins only. Each current member's spend this
// month against their limit, in whole cents, in name order. There is no merged count, task count, speed, quality, rank or total here: the server sends none, and this
// reader keeps none. The reader is total over untrusted data: anything that is not the shape is unreadable (the page draws no number it did not read).
export const PEOPLE_LIMITS_PATH = "/v1/app/org/people-limits";
const PERSON_ID = /^[a-f0-9]{64}$/u;
const PROJECT_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/u;
export type LimitSource = "own" | "company_default" | "none";
export interface PersonLimitRow { developerId: string; name: string; spentCents: number; limitCents: number | null; limitSource: LimitSource }
export interface PeopleLimitsRead {
 /** "YYYY-MM", UTC. */
 month: string;
 /** The projects the filter offers, and the one in force (absent: everyone). */
 projects: string[]; project?: string;
 /** In the order the server sent: by name. Never re-sorted here. */
 people: PersonLimitRow[];
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cents = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const SOURCES: readonly string[] = ["own", "company_default", "none"];
/** The path with the project filter: the name goes in only when it is a project name. */
export const peopleLimitsPath = (project: string | undefined) => (project !== undefined && PROJECT_NAME.test(project) ? `${PEOPLE_LIMITS_PATH}?project=${encodeURIComponent(project)}` : PEOPLE_LIMITS_PATH);
export function readPeopleLimits(body: unknown): PeopleLimitsRead {
 if (!isRecord(body) || typeof body["month"] !== "string" || !MONTH.test(body["month"]) || !Array.isArray(body["projects"]) || !Array.isArray(body["people"])) throw new Error("not people and limits");
 const projects = body["projects"].map(name => { if (typeof name !== "string" || !PROJECT_NAME.test(name)) throw new Error("not people and limits"); return name; });
 const project = body["project"];
 if (project !== undefined && (typeof project !== "string" || !PROJECT_NAME.test(project))) throw new Error("not people and limits");
 const people = body["people"].map((row): PersonLimitRow => {
  if (!isRecord(row) || typeof row["developerId"] !== "string" || !PERSON_ID.test(row["developerId"]) || typeof row["name"] !== "string" || row["name"] === "" || Array.from(row["name"]).length > 200
   || !cents(row["spentCents"]) || !(row["limitCents"] === null || cents(row["limitCents"])) || typeof row["limitSource"] !== "string" || !SOURCES.includes(row["limitSource"])) throw new Error("not people and limits");
  const limitCents = row["limitCents"], source = row["limitSource"] as LimitSource;
  // A limit and where it came from agree: none means no limit, anything else means one.
  if ((source === "none") !== (limitCents === null)) throw new Error("not people and limits");
  return { developerId: row["developerId"], name: row["name"], spentCents: row["spentCents"], limitCents, limitSource: source };
 });
 return { month: body["month"], projects, ...(project === undefined ? {} : { project }), people };
}
/** Where a person stands against their limit, in words (no chart, no score). Whole cents on both sides. */
export type LimitStanding = "none" | "within" | "close" | "over";
/** "Close" from 90 percent of the limit. A limit of zero with any spend is over; with none spent it is at its limit. */
export function standing(row: Pick<PersonLimitRow, "spentCents" | "limitCents">): LimitStanding {
 if (row.limitCents === null) return "none";
 if (row.spentCents > row.limitCents) return "over";
 if (row.spentCents * 10 >= row.limitCents * 9) return "close";
 return "within";
}
/** The link to this person's limit on the Spending limits page (B1's route): the page opens its add form on the person. */
export const changeLimitPath = (developerId: string) => `/app/admin/money/limits?person=${developerId}`;
