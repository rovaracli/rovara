import { KINDS, type Kind } from "./config.ts";

export const HEX40 = /^[0-9a-f]{40}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isKind(value: unknown): value is Kind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

/** The first 8 characters of an execution id: the suffix of hold names, run names and change set names. */
export function exec8(executionId: string): string {
  return executionId.slice(0, 8);
}

/** Printable ASCII only (no em dashes, no control characters, no secrets-by-accident from odd bytes), one bounded string. */
export function plain(text: unknown, max = 600): string {
  const raw = typeof text === "string" ? text : String(text);
  const cleaned = raw.replace(/[^\x20-\x7e\n]/g, "?");
  return cleaned.length > max ? `${cleaned.slice(0, max - 3)}...` : cleaned;
}

export function errorText(error: unknown): string {
  return plain(error instanceof Error ? `${error.name}: ${error.message}` : "unknown error", 300);
}

export function compactIso(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
