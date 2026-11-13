// The worker's opt-in TS-L SELF-TEST result (boot-stage2.sh `run_tsl_selftest`), as the worker reports it in its `worker_start` line (key `selfTest`). The release gate's conditions (session 89) for the shape:
//   - fixed item ids, each with one fixed status and one fixed reason code: no free text, no address, no host name, no command output;
//   - the four identity values (AMI id, boot-stage2 SHA-256, Docker version, instance id) each only in its one written form, else the word `unknown`;
//   - small enough for the one log event the worker_start line is (SELFTEST_MAX_CHARS);
//   - the item ids are the CI TS-L ids (scripts/linux-check-test-services.sh), so a staging result and a CI result compare line by line.
// Root writes it as ONE environment value (AGENTX_TEST_SERVICES_SELFTEST) before the worker unit starts, only when the launch opted in on a staging environment. Nothing is written otherwise, and the report then has no `selfTest` key at all.
// The lists below are held equal to boot-stage2.sh's by tests/contract/ec2-boot-tsl-selftest.test.ts.

export const TEST_SERVICES_SELFTEST_ENVIRONMENT = "AGENTX_TEST_SERVICES_SELFTEST";
export const SELFTEST_MAX_CHARS = 3_000;
export const SELFTEST_STATES = ["ran", "refused", "incomplete", "unusable"] as const;
export const SELFTEST_STATUSES = ["pass", "fail", "pending", "incomplete"] as const;
export const SELFTEST_REASONS = [
  "ok", "not_named", "not_staging", "budget", "docker_unavailable", "bundle_missing", "snapshot_failed", "cleanup_failed", "too_large",
  "check_failed", "later_slice", "no_run_network", "no_pull_grant", "no_pin", "no_capture", "live_not_run", "no_result", "catalog_untrusted", "driver_error",
] as const;
/** The ids scripts/linux-check-test-services.sh prints (CI's TS-L items), in the script's order. */
export const SELFTEST_CI_ITEM_IDS = [
  "L1.walls", "L1.isolation", "L1.docker-version", "L1.iptables-backend", "L1.internal-drops", "L1.live", "L1.live-other-run", "L1.range", "L1.pools",
  "L2.egress-network", "L2.live",
  "L3.live", "L3.embedded-resolver", "L3.embedded-resolver-blocked", "L3.working-relay", "L3.ipv6", "L3.no-route", "L3.other-run", "L3.multicast", "L3.run-files", "L3.spoofing",
  "L4.live", "L4.template-db", "L5.walls", "L5.live", "L6.no-leftovers", "L6.live", "L7.host", "L7.live", "L8.no-socket", "L8.live",
] as const;
/** Always pending on a worker: the egress capture needs tcpdump on the host (CI only), and TS-RUN-3's Redis flush and http_reset have no live driver case (and no pinned Redis image). */
export const SELFTEST_ALWAYS_PENDING_IDS = ["L3.egress-capture", "RUN3.redis-flush", "RUN3.http-reset"] as const;
export const SELFTEST_ITEM_IDS: readonly string[] = [...SELFTEST_CI_ITEM_IDS, ...SELFTEST_ALWAYS_PENDING_IDS];

export type SelfTestState = (typeof SELFTEST_STATES)[number];
export type SelfTestStatus = (typeof SELFTEST_STATUSES)[number];
export type SelfTestReason = (typeof SELFTEST_REASONS)[number];

export interface SelfTestItem { id: string; status: SelfTestStatus; reason: SelfTestReason }
export interface SelfTestResult {
  v: 1;
  state: SelfTestState;
  reason: SelfTestReason;
  /** `ami-<hex>` or `unknown`. */
  ami: string;
  /** The boot-stage2.sh SHA-256 the launch carried (64 lower-case hex digits) or `unknown`. */
  boot2: string;
  /** Docker Engine's version or `unknown`. */
  docker: string;
  /** `i-<hex>` or `unknown`. */
  instance: string;
  /** Seconds the self-test took. */
  secs: number;
  items: SelfTestItem[];
}

const KEYS = ["v", "state", "reason", "ami", "boot2", "docker", "instance", "secs", "items"];
const orUnknown = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && (value === "unknown" || pattern.test(value));
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);

/** The self-test result in `text`, "absent" when there is none (the self-test is off, the normal case) and "unreadable" when it is not exactly the expected shape. */
export function parseSelfTest(text: string | undefined): SelfTestResult | "absent" | "unreadable" {
  if (text === undefined || text === "") return "absent";
  if (text.length > SELFTEST_MAX_CHARS) return "unreadable";
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return "unreadable"; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "unreadable";
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== KEYS.length || !KEYS.every((key) => keys.includes(key))) return "unreadable";
  if (value["v"] !== 1 || !oneOf(SELFTEST_STATES, value["state"]) || !oneOf(SELFTEST_REASONS, value["reason"])) return "unreadable";
  if (!orUnknown(value["ami"], /^ami-[0-9a-f]{8,17}$/u) || !orUnknown(value["boot2"], /^[a-f0-9]{64}$/u) || !orUnknown(value["instance"], /^i-[0-9a-f]{8,17}$/u)) return "unreadable";
  if (!orUnknown(value["docker"], /^[0-9]{1,3}(?:\.[0-9]{1,3}){0,3}(?:-[a-z0-9.]{1,12})?$/u)) return "unreadable";
  const secs = value["secs"];
  if (typeof secs !== "number" || !Number.isInteger(secs) || secs < 0 || secs > 9_999) return "unreadable";
  const rows = value["items"];
  if (!Array.isArray(rows) || rows.length > SELFTEST_ITEM_IDS.length) return "unreadable";
  const items: SelfTestItem[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const match = typeof row === "string" ? /^([A-Za-z0-9.-]{1,40}):([a-z]{1,12}):([a-z_]{1,24})$/u.exec(row) : null;
    const id = match?.[1];
    const status = match?.[2];
    const reason = match?.[3];
    if (id === undefined || !SELFTEST_ITEM_IDS.includes(id) || seen.has(id) || !oneOf(SELFTEST_STATUSES, status) || !oneOf(SELFTEST_REASONS, reason)) return "unreadable";
    seen.add(id);
    items.push({ id, status, reason });
  }
  // An item that passed has the reason `ok` and only a pass does.
  if (items.some((item) => (item.status === "pass") !== (item.reason === "ok"))) return "unreadable";
  // A run that finished has every item; a refusal or a start that did not happen has none.
  if (value["state"] === "ran" && items.length !== SELFTEST_ITEM_IDS.length) return "unreadable";
  if (value["state"] === "refused" && items.length !== 0) return "unreadable";
  return { v: 1, state: value["state"], reason: value["reason"], ami: value["ami"], boot2: value["boot2"], docker: value["docker"], instance: value["instance"], secs, items };
}

/** True when `value` is exactly a parsed result (what `parseSelfTest` returns): the report is checked with this before it is written. */
export function isSelfTestResult(value: unknown): value is SelfTestResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  const items = result["items"];
  if (!Array.isArray(items)) return false;
  const wire = items.map((item: unknown) => {
    if (typeof item !== "object" || item === null) return item;
    const entry = item as Record<string, unknown>;
    return Object.keys(entry).length === 3 ? `${String(entry["id"])}:${String(entry["status"])}:${String(entry["reason"])}` : item;
  });
  const parsed = parseSelfTest(JSON.stringify({ ...result, items: wire }));
  return typeof parsed === "object";
}
