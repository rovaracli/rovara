// Dates and people on the Company rules page. Names, logins and notes come from the server or from a code host: plain text, control characters shown.
import type { CompanyRulesPerson } from "@agentx/contracts/web";
import { VisibleText } from "../../../design/VisibleText.js";
export function formatDay(value: string): string {
 const date = new Date(value);
 return Number.isFinite(date.getTime()) ? date.toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }) + " UTC" : "a date that could not be read";
}
export function formatWhen(value: string): string {
 const date = new Date(value);
 return Number.isFinite(date.getTime()) ? date.toLocaleString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " UTC" : "a time that could not be read";
}
/** "Ada Admin", or "Company repository (edited by a-login)" for a proposal that came from the file. */
export function personText(person: CompanyRulesPerson): string { return person.login === undefined ? person.name : `${person.name} (${person.login})`; }
export function Person({ person }: { person: CompanyRulesPerson }) { return <VisibleText text={personText(person)} />; }
