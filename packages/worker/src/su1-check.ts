// Root's one-shot staging check has a separate event, never a worker_start field.
// Accept only fixed words and checked identity values; no script evidence survives.
export const SU1_CHECK_RESULT_ENVIRONMENT = "AGENTX_SU1_CHECK_RESULT";
export const SU1_CHECK_STATES = ["ran", "refused", "incomplete", "unusable"] as const;
export const SU1_CHECK_STATUSES = ["pass", "fail", "pending", "incomplete"] as const;
export const SU1_CHECK_REASONS = ["ok", "not_named", "not_staging", "wrong_account", "not_staging_image", "no_time", "budget", "docker_unavailable", "walls_failed", "bundle_missing", "snapshot_failed", "cleanup_failed", "check_failed", "no_result", "needs_model_run", "timeout_unavailable"] as const;

export interface Su1CheckResult {
  v: 1;
  state: (typeof SU1_CHECK_STATES)[number];
  reason: (typeof SU1_CHECK_REASONS)[number];
  ami: string;
  boot2: string;
  docker: string;
  instance: string;
  secs: number;
  items: string[];
}
const KEYS = ["v", "state", "reason", "ami", "boot2", "docker", "instance", "secs", "items"];
const oneOf = <T extends string>(words: readonly T[], value: unknown): value is T => typeof value === "string" && (words as readonly string[]).includes(value);
const identity = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && (value === "unknown" || pattern.test(value));

export function parseSu1Check(text: string | undefined): Su1CheckResult | "absent" | "unreadable" {
  if (text === undefined || text === "") return "absent";
  if (text.length > 3_000) return "unreadable";
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return "unreadable"; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "unreadable";
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).length !== KEYS.length || !KEYS.every(key => Object.hasOwn(value, key))) return "unreadable";
  if (value.v !== 1 || !oneOf(SU1_CHECK_STATES, value.state) || !oneOf(SU1_CHECK_REASONS, value.reason)) return "unreadable";
  if (!identity(value.ami, /^ami-[0-9a-f]{8,17}$/u) || !identity(value.boot2, /^[a-f0-9]{64}$/u) || !identity(value.instance, /^i-[0-9a-f]{8,17}$/u) || !identity(value.docker, /^[0-9]{1,3}(?:\.[0-9]{1,3}){0,3}(?:-[a-z0-9.]{1,12})?$/u)) return "unreadable";
  if (typeof value.secs !== "number" || !Number.isInteger(value.secs) || value.secs < 0 || value.secs > 9_999) return "unreadable";
  if (!Array.isArray(value.items) || value.items.length !== 11) return "unreadable";
  const items: string[] = [];
  for (let i = 0; i < 11; i += 1) {
    const row: unknown = value.items[i];
    if (typeof row !== "string") return "unreadable";
    const [id, status, reason, extra] = row.split(":");
    if (id !== String(i + 1) || extra !== undefined || !oneOf(SU1_CHECK_STATUSES, status) || !oneOf(SU1_CHECK_REASONS, reason)) return "unreadable";
    if ((status === "pass") !== (reason === "ok")) return "unreadable";
    if ((i === 8 || i === 9) && (status !== "pending" || reason !== "needs_model_run")) return "unreadable";
    items.push(row);
  }
  return { v: 1, state: value.state, reason: value.reason, ami: value.ami, boot2: value.boot2, docker: value.docker, instance: value.instance, secs: value.secs, items };
}

/** Absent means no event; malformed input gets a fixed failure, never silence. */
export function su1CheckEvent(text: string | undefined): Record<string, unknown> | undefined {
  const parsed = parseSu1Check(text);
  if (parsed === "absent") return undefined;
  return parsed === "unreadable"
    ? { event: "su1_check", v: 1, state: "unusable", reason: "no_result" }
    : { event: "su1_check", ...parsed };
}
