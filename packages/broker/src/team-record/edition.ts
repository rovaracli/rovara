// E1: what differs between the Enterprise and Public editions, and what a company lock may fix (design learning-v2-team-record.md
// 1.3, 4.3, 4.9.2). Pure functions, so the broker, the settings API and the tests share one answer.
// W6's real edition switch is not in the code yet: `readEdition` reads one stub variable (ROVARA_EDITION) and fails closed to Public.
import type { RetentionMode } from "./shared-types.js";

export type TeamRecordEdition = "enterprise" | "public";
export type LearningMode = "off" | "collect" | "suggest" | "on";
export type RecordSourceKind = "slack" | "github" | "codehost" | "linear" | "jira" | "mcp" | "rovara";

export const LEARNING_MODES: readonly LearningMode[] = ["off", "collect", "suggest", "on"];
const RETENTION_ORDER: readonly RetentionMode[] = ["A", "B", "C", "D"];
const SOURCES: readonly RecordSourceKind[] = ["slack", "github", "codehost", "linear", "jira", "mcp", "rovara"];

/** Stub for W6's edition switch. Unset means Public (the stricter Slack rules). An unknown value is an error, never a guess. */
export function readEdition(env: Record<string, string | undefined>): TeamRecordEdition {
  const value = env.ROVARA_EDITION;
  if (value === undefined || value === "") return "public";
  if (value === "enterprise" || value === "public") return value;
  throw new Error("team-record: ROVARA_EDITION must be enterprise or public");
}

const rank = (mode: RetentionMode): number => RETENTION_ORDER.indexOf(mode);

/** Retention modes the edition offers for a source. Public Slack: A or B only (Slack's API terms, design 4.3). */
export function allowedRetention(edition: TeamRecordEdition, source: RecordSourceKind): RetentionMode[] {
  if (edition === "public" && source === "slack") return ["A", "B"];
  return [...RETENTION_ORDER];
}

/**
 * The default retention of a source. Enterprise: C for every source. Public: D, except Slack, which reads live only (A) until counsel
 * reviews notes-with-links (owner decision Q4: B is an opt-in).
 */
export function defaultRetention(edition: TeamRecordEdition, source: RecordSourceKind): RetentionMode {
  if (edition === "enterprise") return "C";
  return source === "slack" ? "A" : "D";
}

export interface CompanyLocks {
  /** When set, this learning mode applies to every project of the company. */
  learningMode?: LearningMode;
  /** The most a company lets any source keep. `default` covers sources not named. */
  retentionCeiling?: Partial<Record<RecordSourceKind | "default", RetentionMode>>;
}

/** A ceiling that is not a retention mode is treated as `A` (keep nothing): fail closed (review M-3). */
function ceilingFor(locks: CompanyLocks | undefined, source: RecordSourceKind): RetentionMode | undefined {
  const raw = locks?.retentionCeiling?.[source] ?? locks?.retentionCeiling?.default;
  if (raw === undefined) return undefined;
  return (RETENTION_ORDER as readonly string[]).includes(raw) ? raw : "A";
}

/** A lock fixes the mode. An unknown stored value counts as `off` (fail closed). */
export function effectiveLearningMode(projectMode: string | undefined, locks?: CompanyLocks): LearningMode {
  const candidate = locks?.learningMode ?? projectMode;
  return (LEARNING_MODES as readonly string[]).includes(candidate ?? "") ? (candidate as LearningMode) : "off";
}

/**
 * The retention that applies to a source right now: the stored value, lowered to what the edition offers and what the company ceiling allows.
 * It never raises. A stored value that is missing or not a mode gives the edition's default, also capped.
 */
export function effectiveRetention(edition: TeamRecordEdition, source: RecordSourceKind, stored: string | undefined, locks?: CompanyLocks): RetentionMode {
  const offered = allowedRetention(edition, source);
  const base: RetentionMode = (RETENTION_ORDER as readonly string[]).includes(stored ?? "") ? (stored as RetentionMode) : defaultRetention(edition, source);
  let result = base;
  const ceiling = ceilingFor(locks, source);
  if (ceiling !== undefined && rank(result) > rank(ceiling)) result = ceiling;
  const highestOffered = offered[offered.length - 1]!;
  if (rank(result) > rank(highestOffered)) result = highestOffered;
  return result;
}

export type RetentionRefusal = "RETENTION_NOT_OFFERED" | "RETENTION_ABOVE_COMPANY_CEILING" | "SOURCE_UNKNOWN";

export type RetentionCheck = { ok: true; widens: boolean } | { ok: false; refusal: RetentionRefusal };

/**
 * Checks a request to set a source's retention. Raising retention (for example A to B, B to C, or C to D), in either edition, `widens` what is kept: the change applies at once and the audit event
 * says so (owner decision 2026-11-04: no second person for any source change; this replaces design 4.2's "a less-safe change needs a second person").
 */
export function checkRetentionChange(input: { edition: TeamRecordEdition; source: string; stored: string | undefined; to: string; locks?: CompanyLocks }): RetentionCheck {
  if (!(SOURCES as readonly string[]).includes(input.source)) return { ok: false, refusal: "SOURCE_UNKNOWN" };
  const source = input.source as RecordSourceKind;
  if (!(allowedRetention(input.edition, source) as string[]).includes(input.to)) return { ok: false, refusal: "RETENTION_NOT_OFFERED" };
  const to = input.to as RetentionMode;
  const ceiling = ceilingFor(input.locks, source);
  if (ceiling !== undefined && rank(to) > rank(ceiling)) return { ok: false, refusal: "RETENTION_ABOVE_COMPANY_CEILING" };
  // The starting point is derived from the stored row, never taken from the caller (review M-4).
  const from = effectiveRetention(input.edition, source, input.stored, input.locks);
  return { ok: true, widens: rank(to) > rank(from) };
}

export type SlackScope = "public_channel" | "private_channel" | "dm" | "mpim" | "slack_connect";

/**
 * Which Slack places may be a source (design 4.4.1). Slack Connect: never. DMs and group DMs: Enterprise only, and only added explicitly.
 * Private channels: only added explicitly, in either edition. Adding a private channel, DM or group DM `widens` what is kept, in either edition (a DM is refused in Public, so it never gets that far): it applies at once and the
 * audit event says so (owner decision 2026-11-04: no second person for any source change; lead ruling: `widened` in both editions).
 */
export function slackScopeAllowed(edition: TeamRecordEdition, scope: SlackScope): { allowed: boolean; explicitOnly: boolean; widens: boolean } {
  switch (scope) {
    case "public_channel":
      return { allowed: true, explicitOnly: false, widens: false };
    case "private_channel":
      return { allowed: true, explicitOnly: true, widens: true };
    case "dm":
    case "mpim":
      return { allowed: edition === "enterprise", explicitOnly: true, widens: true };
    case "slack_connect":
      return { allowed: false, explicitOnly: true, widens: false };
  }
}

/** Public customers never get SQL access to the lake; only Enterprise admins may be given their own Athena rights (design 1.3). */
export function customerSqlAllowed(edition: TeamRecordEdition): boolean {
  return edition === "enterprise";
}

/** The Auditor reads the record and lesson audit events, read-only (design 4.9.2). Matches the `record.*` and `lesson.*` audit actions of R1. */
export const AUDITOR_AUDIT_PREFIXES = ["record.", "lesson."] as const;

export function auditorMayRead(action: string): boolean {
  return AUDITOR_AUDIT_PREFIXES.some((prefix) => action.startsWith(prefix) && action.length > prefix.length);
}
