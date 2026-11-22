import type { LessonBecame } from "@agentx/contracts/code-contract-v0";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): value is string => typeof value === "string";
const n = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
/** What a lesson became, read for the retired list: only a link this build can read, with an unknown kind as `other`. */
export function readBecame(raw: unknown): LessonBecame | undefined {
  if (!isRecord(raw)) return undefined;
  const kind = raw["kind"] === "rule" || raw["kind"] === "check" || raw["kind"] === "skill" ? raw["kind"] : "other";
  // A time a date cannot hold reads as no time.
  return { kind, ref: str(raw["ref"]) ? raw["ref"] : "", at: n(raw["at"]) <= 8.64e15 ? n(raw["at"]) : 0 };
}
