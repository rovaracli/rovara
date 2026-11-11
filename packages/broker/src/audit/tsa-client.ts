// Timestamps for the audit epochs (Task 10): the client side. The anchor asks a time-stamping authority (RFC 3161) to sign the hash
// of an epoch's statement and keeps the answer only when the offline verifier (Task 2) accepts it: the right hash, the nonce it
// sent, a signer bound by its signing-certificate attribute, a chain to one of the roots pinned for THAT authority's label.
// A token that would fail the verifier an auditor runs is never stored.
//
// Three kinds of install (the `AUDIT_TSA_KIND` of the function):
//   public  DigiCert and Sectigo, labels `digicert` and `sectigo`, each with its own pinned root (the verifier's defaultAnchors);
//   custom  one or two authorities of the customer's own, labels `custom-1` and `custom-2` in URL order, with the roots read from
//           one SSM parameter at cold start (see `customTsaSettings` for its format);
//   off     no requests at all: epochs are sealed without a token.
import { X509Certificate, randomBytes } from "node:crypto";
import { AUDIT_TSA_ENDPOINTS, AUDIT_TSA_SPACING_MS, AUDIT_TSA_TIMEOUT_MS, TIMESTAMP_SKEW_MS, buildTimeStampRequest, defaultAnchors, parseTimeStampResponse, timestampCoversRecord, verifyTimeStampToken, type TimestampProblem } from "@agentx/cloud-contracts";

export type TsaProblem =
  | TimestampProblem
  /** The authority answered with a status other than granted. */
  | "rejection"
  /** An HTTP status other than 200. */
  | "http"
  /** No answer within the timeout. */
  | "timeout"
  /** The request could not be made or the answer could not be read. */
  | "network"
  /** The roots for a custom authority could not be loaded: no request is made. */
  | "roots_unavailable"
  /** A token already stored under the epoch's key does not verify. */
  | "stored_token_invalid"
  /** The token verifies but its time is wrong: more than 5 minutes before the last record it should cover, or in the future. */
  | "gen_time"
  /** The token's key holds a delete marker or a second version. */
  | "version_drift";

/** Any answer that is not a valid timestamp. `problem` is what the log line says. */
export class TsaError extends Error {
  constructor(readonly label: string, readonly problem: TsaProblem) {
    super(`timestamp authority ${label}: ${problem}`);
    this.name = "TsaError";
  }
}

export interface StampedToken {
  /** The TimeStampToken (DER): what is stored as `<epochId>.<label>.tsr` and what an export carries. */
  token: Uint8Array;
  genTime: string;
  tsa: string;
  serialHex: string;
}

export interface RequestOptions {
  timeoutMs: number;
  nonce: bigint;
  anchors: readonly X509Certificate[];
  /** The latest `recordedAt` among the records the statement covers. A token dated more than 5 minutes before it is refused (see `checkGenTime`). */
  lastRecordedAt?: string;
  /** Milliseconds now, for the upper bound on genTime. Defaults to `Date.now`. */
  clock?: () => number;
}

/**
 * The time a token vouches for must be believable before the anchor keeps it: not more than the bundle check's skew before the
 * last record the statement covers (the very rule `verifyBundle` applies, so a token the anchor keeps never fails an export on its
 * time), not more than that skew ahead of now (only the anchor knows the real time), and, when `notBeforeMs` is given (the moment the
 * request was sent, or for a token found in storage the moment the epoch was closed), not more than the skew before it: a floor that
 * holds for an epoch with no records too. Throws `TsaError(label, "gen_time")`.
 */
export function checkGenTime(label: string, genTime: string, bounds: { lastRecordedAt?: string | undefined; nowMs: number; notBeforeMs?: number | undefined }): void {
  if (bounds.lastRecordedAt !== undefined && !timestampCoversRecord(genTime, bounds.lastRecordedAt)) throw new TsaError(label, "gen_time");
  // A sanity floor that needs no record: the statement existed before it was sent, so a token may not predate that by more than the skew.
  if (bounds.notBeforeMs !== undefined && !(Date.parse(genTime) >= bounds.notBeforeMs - TIMESTAMP_SKEW_MS)) throw new TsaError(label, "gen_time");
  if (!(Date.parse(genTime) <= bounds.nowMs + TIMESTAMP_SKEW_MS)) throw new TsaError(label, "gen_time");
}

/** An answer larger than this is not a time-stamp response (a real one is a few kilobytes). */
const MAX_RESPONSE_BYTES = 1_000_000;

/**
 * The body, read chunk by chunk and counted as it arrives: a body with no Content-Length (chunked, or a lying one) is cut off at the
 * cap, so a hostile or broken authority cannot make the function buffer more than that. Returns undefined when the cap is passed.
 */
async function readCapped(response: Response): Promise<Uint8Array | undefined> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader() as { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel: () => Promise<void> };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    const value = next.value;
    if (next.done || value === undefined) break;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * POSTs a time-stamp query for `hashHex` (a SHA-256, lowercase hex) to `url`, aborting at `timeoutMs`, and verifies the answer
 * under `anchors`, the roots of this label alone. Throws a `TsaError` for any answer that is not a valid timestamp; returns the
 * token otherwise.
 */
export async function requestTimestamp(fetchFn: typeof fetch, label: string, url: string, hashHex: string, options: RequestOptions): Promise<StampedToken> {
  const startedAt = (options.clock ?? Date.now)();
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, options.timeoutMs);
  const lost = (): TsaError => new TsaError(label, controller.signal.aborted ? "timeout" : "network");
  let bytes: Uint8Array;
  try {
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/timestamp-query", accept: "application/timestamp-reply" },
        body: buildTimeStampRequest(hashHex, options.nonce),
        signal: controller.signal,
      });
    } catch {
      throw lost();
    }
    if (response.status !== 200) throw new TsaError(label, "http");
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_RESPONSE_BYTES) throw new TsaError(label, "malformed");
    let read: Uint8Array | undefined;
    try {
      read = await readCapped(response);
    } catch {
      throw lost();
    }
    if (read === undefined) {
      controller.abort();
      throw new TsaError(label, "malformed");
    }
    bytes = read;
  } finally {
    clearTimeout(timer);
  }
  let parsed: ReturnType<typeof parseTimeStampResponse>;
  try {
    parsed = parseTimeStampResponse(bytes);
  } catch {
    throw new TsaError(label, "malformed");
  }
  if (parsed.status > 1) throw new TsaError(label, "rejection");
  if (parsed.token === undefined) throw new TsaError(label, "malformed");
  const verdict = verifyTimeStampToken(parsed.token, { hashHex, nonce: options.nonce, anchors: options.anchors });
  if (!verdict.ok) throw new TsaError(label, verdict.problem);
  checkGenTime(label, verdict.genTime, { lastRecordedAt: options.lastRecordedAt, nowMs: (options.clock ?? Date.now)(), notBeforeMs: startedAt });
  return { token: parsed.token, genTime: verdict.genTime, tsa: verdict.tsa, serialHex: verdict.serialHex };
}

// ---- settings ---------------------------------------------------------------------------------------------------

export interface TsaTarget {
  /** `digicert`, `sectigo`, `custom-1` or `custom-2`: the label a bundle names and the verifier binds roots to. */
  label: string;
  url: string;
  /** The roots this label's tokens must chain to. */
  anchors: readonly X509Certificate[];
  /** Set when this authority cannot be used (its roots did not load): the value is the problem, and no request is made. */
  unavailable?: "roots_unavailable";
}

export type TsaSettings =
  | { kind: "off" }
  | { kind: "public" | "custom"; targets: readonly TsaTarget[]; timeoutMs: number; spacingMs: number };

/** What the anchor needs to stamp. Absent from the anchor's dependencies means `off`. */
export interface TsaDeps {
  settings: TsaSettings;
  fetch: typeof fetch;
  /** Waits between two requests to one authority. Defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds now, to measure the spacing. Defaults to `Date.now`. */
  clock?: () => number;
  /** A fresh request nonce. Defaults to 63 random bits. */
  nonce?: () => bigint;
}

export function publicTsaSettings(timeoutMs = AUDIT_TSA_TIMEOUT_MS, spacingMs = AUDIT_TSA_SPACING_MS): TsaSettings {
  const pinned = defaultAnchors();
  return {
    kind: "public",
    timeoutMs,
    spacingMs,
    targets: [
      { label: "digicert", url: AUDIT_TSA_ENDPOINTS.digicert, anchors: pinned.digicert },
      { label: "sectigo", url: AUDIT_TSA_ENDPOINTS.sectigo, anchors: pinned.sectigo },
    ],
  };
}

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

function certificatesOf(text: string, what: string): X509Certificate[] {
  const found = text.match(PEM_CERTIFICATE) ?? [];
  if (found.length === 0) throw new Error(`audit anchor: ${what} holds no PEM certificate`);
  try {
    return found.map((pem) => new X509Certificate(pem));
  } catch {
    throw new Error(`audit anchor: ${what} holds a certificate that cannot be read`);
  }
}

/**
 * The roots of a custom install. The SSM parameter holds either a JSON list of strings, one PEM bundle per URL in the URLs'
 * order (`["-----BEGIN CERTIFICATE-----...", "..."]`), or, for a single URL, the PEM text itself. Labels are `custom-1` and
 * `custom-2` in URL order.
 */
export function customTsaSettings(urls: readonly string[], rootsText: string, timeoutMs = AUDIT_TSA_TIMEOUT_MS, spacingMs = AUDIT_TSA_SPACING_MS): TsaSettings {
  if (urls.length < 1 || urls.length > 2) throw new Error("audit anchor: a custom timestamp authority takes one or two URLs");
  const trimmed = rootsText.trim();
  let bundles: string[];
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("audit anchor: the timestamp roots parameter is not valid JSON");
    }
    if (!Array.isArray(parsed) || !parsed.every((entry): entry is string => typeof entry === "string")) throw new Error("audit anchor: the timestamp roots parameter must be a list of PEM texts");
    bundles = parsed;
  } else {
    bundles = [trimmed];
  }
  if (bundles.length !== urls.length) throw new Error("audit anchor: the timestamp roots parameter needs one PEM bundle per URL, in the URLs' order");
  return {
    kind: "custom",
    timeoutMs,
    spacingMs,
    targets: urls.map((url, index) => ({ label: `custom-${String(index + 1)}`, url, anchors: certificatesOf(bundles[index] as string, `roots bundle ${String(index + 1)}`) })),
  };
}

function variable(environment: Record<string, string | undefined>, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim() === "") throw new Error(`audit anchor: ${name} is missing`);
  return value.trim();
}

function wholeNumber(environment: Record<string, string | undefined>, name: string): number {
  const value = variable(environment, name);
  if (!/^[1-9]\d{0,8}$/.test(value)) throw new Error(`audit anchor: ${name} must be a whole number of milliseconds`);
  return Number(value);
}

export interface TsaEnvironmentDeps {
  /** SSM GetParameter on the configured roots parameter, and on nothing else. */
  readParameter: (name: string) => Promise<string>;
  fetch: typeof fetch;
  log: (entry: Record<string, unknown>) => void;
}

/**
 * The anchor's timestamp dependencies from the function's environment: `AUDIT_TSA_KIND` (public, custom or off), for custom
 * `AUDIT_TSA_URLS` (comma-separated) and `AUDIT_TSA_ROOTS_PARAMETER`, and the timeout and spacing. A malformed or missing value
 * stops the function from starting, as a missing lock setting does. A custom install whose roots cannot be read does NOT stop it:
 * timestamps never block sealing, so every authority is marked unavailable, the failure is logged, and the epochs wait.
 */
export async function loadTsaDeps(environment: Record<string, string | undefined>, deps: TsaEnvironmentDeps): Promise<TsaDeps> {
  const kind = variable(environment, "AUDIT_TSA_KIND");
  if (kind !== "public" && kind !== "custom" && kind !== "off") throw new Error("audit anchor: AUDIT_TSA_KIND must be public, custom or off");
  // Enterprise foundations E2: an Enterprise install sends nothing to Rovara or to public services by default, and the public authorities are two outside hosts
  // (the synth refuses this too; this is the same check at start, for a function deployed from another source). Any stamp that is not exactly "enterprise" or
  // "public" is refused as well, so a misspelt edition cannot slip past this check.
  const edition = environment.ROVARA_EDITION;
  if (edition !== undefined && edition !== "enterprise" && edition !== "public") throw new Error("audit anchor: ROVARA_EDITION must be enterprise or public");
  if (edition === "enterprise" && kind === "public") throw new Error("audit anchor: an Enterprise install must not use the public timestamp authorities (set AUDIT_TSA_KIND to custom or off)");
  const timeoutMs = wholeNumber(environment, "AUDIT_TSA_TIMEOUT_MS");
  const spacingMs = wholeNumber(environment, "AUDIT_TSA_SPACING_MS");
  if (kind === "off") return { settings: { kind: "off" }, fetch: deps.fetch };
  if (kind === "public") return { settings: publicTsaSettings(timeoutMs, spacingMs), fetch: deps.fetch };
  const urls = variable(environment, "AUDIT_TSA_URLS").split(",").map((url) => url.trim()).filter((url) => url !== "");
  if (urls.length < 1 || urls.length > 2 || !urls.every((url) => /^https?:\/\/[^\s/]+/.test(url))) throw new Error("audit anchor: AUDIT_TSA_URLS must be one or two http(s) URLs");
  const parameter = variable(environment, "AUDIT_TSA_ROOTS_PARAMETER");
  try {
    return { settings: customTsaSettings(urls, await deps.readParameter(parameter), timeoutMs, spacingMs), fetch: deps.fetch };
  } catch (error) {
    deps.log({ event: "audit.timestamp_failed", level: "error", label: "all", problem: "roots_unavailable", error: error instanceof Error ? error.name : "unknown" });
    return {
      settings: {
        kind: "custom",
        timeoutMs,
        spacingMs,
        targets: urls.map((url, index) => ({ label: `custom-${String(index + 1)}`, url, anchors: [], unavailable: "roots_unavailable" as const })),
      },
      fetch: deps.fetch,
    };
  }
}

/** A request nonce: 63 random bits, positive, inside the 64 bits the request allows. */
export function randomNonce(): bigint {
  return (BigInt(`0x${randomBytes(8).toString("hex")}`) & ((1n << 63n) - 1n)) + 1n;
}
