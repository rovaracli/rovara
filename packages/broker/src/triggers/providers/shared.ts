// What the issue providers (Linear, Jira) share when they read a vendor's body (Plan 4 Task 22). Everything a person typed into a ticket is treated as hostile text: it is cleaned
// before it can be a title or a filter value, and a link is believed only when it is a plain https link on the vendor's own host. Nothing here logs.
import { RUN_START_TITLE_MAX } from "@agentx/contracts";

const FIELD_VALUES_MAX = 50;
const FIELD_VALUE_CHARS_MAX = 200;

/** A header's value, whatever the case of its name (the broker lower-cases names; a test or another caller may not). */
export function headerOf(headers: Record<string, string | undefined>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return value;
  return undefined;
}

/** A person's words made fit for a title: control, invisible and white-space runs become one space, cut to what an event may carry; `fallback` when nothing is left. */
export function titleOf(text: unknown, fallback: string): string {
  const clean = typeof text === "string" ? [...text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim()].slice(0, RUN_START_TITLE_MAX).join("") : "";
  return clean === "" ? fallback : clean;
}

/** `link` when it is a plain https link (no user name, password or port) on exactly `host`; nothing otherwise. */
export function httpsLinkOn(link: unknown, host: string): string | undefined {
  if (typeof link !== "string") return undefined;
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.hostname === host && url.port === "" && url.username === "" && url.password === "" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The values a filter may look at: text only, none empty, each cut to 200 characters, at most 50. */
export function valuesOf(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === "string" && value !== "").map((value) => value.slice(0, FIELD_VALUE_CHARS_MAX)).slice(0, FIELD_VALUES_MAX);
}

/** An instant given in milliseconds since 1970 (a number, or a numeral), as an ISO time; nothing for what is not a whole, representable number of them. */
export function isoOfMillis(value: unknown): string | undefined {
  const millis = typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : value;
  if (typeof millis !== "number" || !Number.isSafeInteger(millis) || millis <= 0) return undefined;
  const at = new Date(millis);
  return Number.isFinite(at.getTime()) ? at.toISOString() : undefined;
}
