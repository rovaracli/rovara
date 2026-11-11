// `agentx audit log | export | verify | open` (Task 14): an organization's owners and admins read, export and check their audit log
// with their own developer sign-in, over `/v1/dev/org/audit/*`. The staff commands (admin/audit.ts) share everything below the
// transport: the export flow, the verification and, above all, how a value from the ledger is shown.
//
// Every value that came from the ledger or the control plane is untrusted text. It is never written to the terminal as it is: a
// control, format, line-separator or surrogate character (an ANSI escape, a C1 introducer, a bidi override, a zero-width character)
// is shown as `[U+XXXX]`, the markers the audit page uses, so a stored value cannot move the cursor, recolor the terminal or
// reorder a line. The same goes for `--json` output, which is read in a terminal too.
import { X509Certificate } from "node:crypto";
import { lstat, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { AUDIT_ERROR_MESSAGES, AUDIT_EXPORT_MAX_RECORDS } from "@agentx/cloud-contracts";
import { AgentXError, agentXError } from "@rovara-code/contracts";
import {
  AUDIT_LIMITS_COPY,
  defaultAnchors,
  parseBundle,
  verifyBundle,
  verifyExtends,
  type AuditBundleV1,
  type BundleCheck,
  type BundleReport,
} from "@rovara/audit-verifier";
import { z } from "zod";
import { ReportedFailure } from "../output.js";
import { developerRequest, withFreshSignIn, type FreshSignIn } from "./commands.js";
import { resolveDeveloperEnvironment } from "./config.js";
import { developerAccessToken, type DeveloperSessionDeps } from "./session.js";

// ---- showing untrusted text -------------------------------------------------------------------------------------------

// Control, format, line and paragraph separators, surrogates, private use, and the invisible fillers that take up room without showing
// anything (combining grapheme joiner, Hangul fillers, braille blank).
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}\u034f\u115f\u1160\u2800\u3164\uffa0]/gu;
const marker = (character: string): string => `[U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}]`;
/** The most characters of one value a terminal line shows. A detail field is at most 500 characters, so nothing the ledger holds is cut. */
const MAX_SHOWN = 500;

/** One line of text for a terminal: line breaks become spaces, every unsafe character becomes its `[U+XXXX]` marker, and a very long value is cut. */
export function terminalSafe(value: unknown): string {
  const characters = [...String(value).replace(/[\r\n\t]+/g, " ")];
  const shown = characters.length > MAX_SHOWN ? characters.slice(0, MAX_SHOWN) : characters;
  return shown.join("").replace(UNSAFE, marker) + (characters.length > MAX_SHOWN ? "...[truncated]" : "");
}

/**
 * Runs a call to the control plane and makes the words of any error it raises safe to print: the control plane's messages are text
 * from outside this computer (the member path only strips C0 controls from them; the staff path not even that).
 */
export async function neutralised<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof AgentXError)) throw error;
    throw agentXError(error.code, terminalSafe(error.message.slice(error.code.length + 2)));
  }
}

/** A value for `--json` output: every string (and key) has its unsafe characters marked; JSON itself escapes the line breaks and tabs. */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === "string") return value.replace(UNSAFE, (character) => (character === "\n" || character === "\r" || character === "\t" ? character : marker(character)));
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [jsonSafe(key) as string, jsonSafe(child)]));
  }
  return value;
}

const two = (value: number): string => String(value).padStart(2, "0");
/** `2026-10-20 12:07:09 UTC`; a value that is not a time is shown as text. */
export function timeText(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return terminalSafe(value);
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} UTC`;
}

const GOVERNANCE_SENTENCE = "In governance mode, a privileged administrator could remove the sealed copies.";
const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

// ---- what the control plane answers -----------------------------------------------------------------------------------

const DetailSchema = z.union([
  z.looseObject({ subject: z.string(), erased: z.literal(true) }),
  z.looseObject({ subject: z.string(), fields: z.record(z.string(), z.string()) }),
]);

type Detail = z.infer<typeof DetailSchema>;
/** The fields of an opened detail part; undefined for a part that was erased. */
function fieldsOf(part: Detail): Record<string, string> | undefined {
  return "erased" in part && part.erased === true ? undefined : (part as { fields: Record<string, string> }).fields;
}

const RecordSchema = z.looseObject({
  record: z.looseObject({
    seq: z.number(),
    recordedAt: z.string(),
    action: z.string(),
    actor: z.looseObject({ kind: z.string(), id: z.string() }),
    target: z.looseObject({ kind: z.string(), id: z.string().optional(), name: z.string().optional() }),
    related: z.array(z.string()),
    facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    proof: z.looseObject({ kind: z.string(), method: z.string().optional(), via: z.string().optional(), authTime: z.string().optional() }).optional(),
  }),
  details: z.array(DetailSchema),
});

export const AuditRecordsSchema = z.looseObject({
  headSeq: z.number(),
  sealedThroughSeq: z.number(),
  latestTimestamp: z.string().optional(),
  epochsWithoutTimestamp: z.array(z.string()),
  lockMode: z.string().optional(),
  records: z.array(RecordSchema),
  nextCursor: z.string().optional(),
});
export type AuditRecords = z.infer<typeof AuditRecordsSchema>;

const EXPORT_STATUSES = ["running", "ready", "failed", "expired"] as const;
export const AuditExportStartSchema = z.looseObject({ exportId: z.string(), status: z.enum(EXPORT_STATUSES) });

const SummarySchema = z.looseObject({
  fromSeq: z.number(),
  toSeq: z.number(),
  records: z.number(),
  sealedThroughSeq: z.number(),
  unsealedCount: z.number(),
  timestampedThrough: z.string().optional(),
  epochsWithoutTimestamp: z.array(z.string()),
  coveredEpochs: z.array(z.string()),
  unverifiedAuthorities: z.array(z.string()),
  lockModes: z.array(z.string()),
  bytes: z.number(),
});
export type AuditExportSummary = z.infer<typeof SummarySchema>;

export const AuditExportViewSchema = z.looseObject({
  exportId: z.string(),
  status: z.enum(EXPORT_STATUSES),
  range: z.looseObject({ fromSeq: z.number(), toSeq: z.number() }),
  withDetails: z.boolean(),
  summary: SummarySchema.optional(),
  failure: z.looseObject({ code: z.string(), failedChecks: z.array(z.string()).optional() }).optional(),
  download: z.looseObject({ url: z.string(), expiresInSeconds: z.number() }).optional(),
});
export type AuditExportView = z.infer<typeof AuditExportViewSchema>;

// ---- `audit log` ------------------------------------------------------------------------------------------------------

export interface AuditLogFlags {
  from?: string | undefined;
  to?: string | undefined;
  action?: string | undefined;
  limit?: string | undefined;
  cursor?: string | undefined;
}

const TIME_SHAPE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const rangeInvalid = (): Error => agentXError("AUDIT_RANGE_INVALID", AUDIT_ERROR_MESSAGES.AUDIT_RANGE_INVALID);

/** A whole record number from 1, or a refusal with the range text. */
function recordNumber(text: string): number {
  if (!/^\d{1,15}$/.test(text) || Number(text) < 1) throw rangeInvalid();
  return Number(text);
}

type Bound = { seq: number } | { time: string; at: number };

/** `--from` or `--to` of `audit log`: a record number, or a time such as 2026-10-20T12:00:00Z. */
function logBound(flag: string, text: string): Bound {
  if (/^\d+$/.test(text)) return { seq: recordNumber(text) };
  const at = Date.parse(text);
  if (!TIME_SHAPE.test(text) || Number.isNaN(at)) {
    throw agentXError("CONFIG_INVALID", `${flag} must be a record number or a time such as 2026-10-20T12:00:00Z`);
  }
  return { time: text, at };
}

/** The records query of `audit log` (and of the staff log, which adds its own reason and ticket). The flags are checked here, before any call. */
export function auditLogQuery(flags: AuditLogFlags): URLSearchParams {
  const params = new URLSearchParams();
  const from = flags.from === undefined ? undefined : logBound("--from", flags.from);
  const to = flags.to === undefined ? undefined : logBound("--to", flags.to);
  if (from !== undefined && to !== undefined) {
    const backwards = "seq" in from && "seq" in to ? from.seq > to.seq : "at" in from && "at" in to ? from.at > to.at : false;
    if (backwards) throw rangeInvalid();
  }
  if (from !== undefined) params.set("seq" in from ? "fromSeq" : "from", "seq" in from ? String(from.seq) : from.time);
  if (to !== undefined) params.set("seq" in to ? "toSeq" : "to", "seq" in to ? String(to.seq) : to.time);
  if (flags.action !== undefined) params.set("action", flags.action);
  if (flags.limit !== undefined) {
    if (!/^\d{1,3}$/.test(flags.limit) || Number(flags.limit) < 1 || Number(flags.limit) > 200) throw agentXError("CONFIG_INVALID", "--limit must be a whole number from 1 to 200");
    params.set("limit", flags.limit);
  }
  if (flags.cursor !== undefined) params.set("cursor", flags.cursor);
  return params;
}

const queryText = (params: URLSearchParams): string => (params.size === 0 ? "" : `?${params.toString()}`);

const DEV_AUDIT_PATH = "/v1/dev/org/audit";

export async function fetchAuditRecords(deps: DeveloperSessionDeps, env: string | undefined, params: URLSearchParams): Promise<{ env: string; url: string; records: AuditRecords }> {
  const { env: resolved, url, body } = await neutralised(() => developerRequest(deps, env, `${DEV_AUDIT_PATH}/records${queryText(params)}`, AuditRecordsSchema, { explain: true }));
  return { env: resolved, url, records: body };
}

function statusLines(result: AuditRecords): string[] {
  const unsealed = result.headSeq - result.sealedThroughSeq;
  const lines = [`Sealed through record ${terminalSafe(result.sealedThroughSeq)} of ${terminalSafe(result.headSeq)}.${unsealed > 0 ? ` ${String(unsealed)} newer ${plural(unsealed, "record is", "records are")} not sealed yet.` : ""}`];
  lines.push(result.latestTimestamp === undefined ? "No independent time yet: no timestamp service has signed a sealed batch." : `Latest independent time: ${timeText(result.latestTimestamp)}.`);
  if (result.latestTimestamp !== undefined && result.epochsWithoutTimestamp.length > 0) {
    const count = result.epochsWithoutTimestamp.length;
    lines.push(`${String(count)} sealed ${plural(count, "batch has", "batches have")} no independent time yet, so that date does not cover ${plural(count, "it", "them")}.`);
  }
  if (result.lockMode !== undefined) {
    lines.push(`Sealed copies are locked in ${terminalSafe(result.lockMode)} mode.${result.lockMode === "GOVERNANCE" ? ` ${GOVERNANCE_SENTENCE}` : ""}`);
  }
  return lines;
}

function recordLines(entry: AuditRecords["records"][number]): string[] {
  const { record } = entry;
  const own = entry.details.find((part) => part.subject === record.actor.id);
  const name = own === undefined ? undefined : fieldsOf(own)?.name;
  const target = record.target.id ?? record.target.name ?? "";
  const lines = [
    `#${terminalSafe(record.seq)}  ${timeText(record.recordedAt)}  ${terminalSafe(record.action)}`,
    `    who: ${name === undefined ? "" : `${terminalSafe(name)} `}(${terminalSafe(record.actor.kind)} ${terminalSafe(record.actor.id)})`,
    `    target: ${terminalSafe(record.target.kind)} ${terminalSafe(target)}`,
  ];
  if (record.related.length > 0) lines.push(`    related: ${record.related.map(terminalSafe).join(", ")}`);
  if (record.proof !== undefined) {
    const how = record.proof.method ?? record.proof.via;
    lines.push(`    proof: ${terminalSafe(record.proof.kind)}${how === undefined ? "" : ` (${terminalSafe(how)})`}${record.proof.authTime === undefined ? "" : `, signed in ${timeText(record.proof.authTime)}`}`);
  }
  const facts = Object.entries(record.facts).map(([key, value]) => `${terminalSafe(key)}=${terminalSafe(value)}`);
  if (facts.length > 0) lines.push(`    facts: ${facts.join(", ")}`);
  for (const part of entry.details) {
    const fields = fieldsOf(part);
    lines.push(fields === undefined
      ? `    details: ${terminalSafe(part.subject)}: erased`
      : `    details: ${terminalSafe(part.subject)}: ${Object.entries(fields).map(([key, value]) => `${terminalSafe(key)}=${terminalSafe(value)}`).join("; ")}`);
  }
  return lines;
}

/** What `audit log` prints: the status, then each record. */
export function auditLogText(result: AuditRecords): string {
  const lines = [...statusLines(result), ""];
  if (result.records.length === 0) lines.push("No records match.");
  else {
    lines.push(`Showing ${String(result.records.length)} ${plural(result.records.length, "record", "records")}:`, "");
    for (const entry of result.records) lines.push(...recordLines(entry));
  }
  if (result.nextCursor !== undefined) lines.push("", `More records follow: run the same command again with --cursor ${terminalSafe(result.nextCursor)}`);
  return `${lines.join("\n")}\n`;
}

// ---- exports ----------------------------------------------------------------------------------------------------------

/** How a command reaches the export routes: the member's or the staff member's. */
export interface AuditExportTransport {
  /** Starts the export; the same `requestId` is the same export. */
  start(request: { requestId: string; fromSeq: number; toSeq: number; withDetails?: boolean }): Promise<z.infer<typeof AuditExportStartSchema>>;
  poll(exportId: string): Promise<AuditExportView>;
  /** How long to wait between polls. A staff poll is itself a recorded read, so theirs is longer. */
  pollMs: number;
  /** Poll less often once the export has taken this long. */
  backoff?: { afterMs: number; pollMs: number };
  /** The organization the export must be of, when the sign-in names it; `verify` fails an export of another. */
  orgId?(): Promise<string | undefined>;
}

export interface AuditRuntime {
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  newRequestId(): string;
}

const EXPORT_ID = /^aex_[0-9a-f]{32}$/;
/** The longest a command waits for one export: past the control plane's own limit for a running one. */
const MAX_WAIT_MS = 50 * 60 * 1000;
/** Polls that fail in a row (an outage, or the staff path unable to record) before the command gives up. */
const MAX_POLL_FAILURES = 5;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
/** The most an export file can be: the same bound the verifier uses (records at up to 2 KiB, plus room for seals and timestamps). */
const MAX_EXPORT_BYTES = AUDIT_EXPORT_MAX_RECORDS * 2048 + 16 * 1024 * 1024;

/**
 * Starting an export needs a sign-in from the last ten minutes (owner decision 2026-10-31, like the other high-risk actions). When the control plane says so (REAUTH_REQUIRED), and
 * the command can sign in again (`freshSignIn`), the person signs in once more and the same request is sent once more, with the same request ID so it is the same export. A second refusal,
 * or any other, is shown as it is. Polling and downloading a ready export need no fresh sign-in.
 */
export function developerExportTransport(deps: DeveloperSessionDeps, env: string | undefined, freshSignIn?: FreshSignIn): AuditExportTransport {
  return {
    pollMs: 3000,
    start: async (request) => (await withFreshSignIn(deps, env, undefined, freshSignIn, () => neutralised(() => developerRequest(deps, env, `${DEV_AUDIT_PATH}/exports`, AuditExportStartSchema, { method: "POST", body: request, explain: true })))).body,
    poll: async (exportId) => (await neutralised(() => developerRequest(deps, env, `${DEV_AUDIT_PATH}/exports/${exportId}`, AuditExportViewSchema, { explain: true }))).body,
    orgId: async () => orgOfToken((await neutralised(() => developerAccessToken(deps, env))).accessToken),
  };
}

/** A poll worth trying again: the control plane could not answer just now, or (staff path) could not record the read. */
function isOutage(error: unknown): boolean {
  return error instanceof AgentXError && (error.code === "RUNTIME_UNAVAILABLE" || error.code === "AUDIT_UNAVAILABLE");
}

function failureMessage(view: AuditExportView): string {
  const checks = view.failure?.failedChecks;
  return `The export could not be built (${terminalSafe(view.failure?.code ?? "unknown")}${checks === undefined || checks.length === 0 ? "" : `; failed checks: ${checks.map(terminalSafe).join(", ")}`}). Start a new one.`;
}

/**
 * Downloads the signed link as it is: no sign-in token, https only, and no redirect followed (a redirect could lead to a link
 * that is not https or to another host, and a signed link never needs one). The body is counted as it arrives and stops past `maxBytes`.
 */
export async function downloadExport(runtime: AuditRuntime, link: string, maxBytes = MAX_EXPORT_BYTES): Promise<Buffer> {
  if (!/^https:\/\//i.test(link)) throw agentXError("RUNTIME_UNAVAILABLE", "AgentX gave a download link that is not secure, so nothing was downloaded; try again");
  const tooBig = () => agentXError("RUNTIME_UNAVAILABLE", "the export is larger than an export can be, so it was not downloaded");
  const cutOff = () => agentXError("RUNTIME_UNAVAILABLE", "the download was cut off before it finished; run the command again");
  let response: Response;
  try {
    response = await runtime.fetch(link, { redirect: "manual", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", "could not download the export; check your connection and run the command again");
  }
  if (response.status >= 300 && response.status < 400) {
    throw agentXError("RUNTIME_UNAVAILABLE", "the download link redirected, and this CLI follows no redirects; run the command again to get a new link");
  }
  if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `the download link did not work (HTTP ${String(response.status)}); run the command again`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooBig();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
    for (;;) {
      const next = await reader?.read();
      if (next === undefined || next.done) break;
      total += next.value.length;
      if (total > maxBytes) {
        await reader?.cancel().catch(() => undefined);
        throw tooBig();
      }
      chunks.push(next.value);
    }
  } catch (error) {
    throw error instanceof AgentXError ? error : cutOff();
  }
  return Buffer.concat(chunks);
}

/**
 * Asks for the export, waits for it, and downloads the file. Stops polling the moment the export is ready, failed or expired.
 * Each run makes one request ID, so a run that retries a poll never starts a second export.
 */
export async function fetchAuditExport(
  transport: AuditExportTransport,
  runtime: AuditRuntime,
  request: { fromSeq: number; toSeq: number; withDetails: boolean },
): Promise<{ view: AuditExportView; bytes: Buffer }> {
  const started = await transport.start({
    requestId: runtime.newRequestId(),
    fromSeq: request.fromSeq,
    toSeq: request.toSeq,
    ...(request.withDetails ? { withDetails: true } : {}),
  });
  if (!EXPORT_ID.test(started.exportId)) throw agentXError("RUNTIME_UNAVAILABLE", "AgentX answered with something unexpected; try again, or upgrade the CLI");
  let waited = 0;
  let failures = 0;
  let status: string = started.status;
  for (;;) {
    if (status === "running") {
      if (waited >= MAX_WAIT_MS) throw agentXError("RUNTIME_UNAVAILABLE", "the export is still being prepared after a long wait; run the command again later");
      const wait = transport.backoff !== undefined && waited >= transport.backoff.afterMs ? transport.backoff.pollMs : transport.pollMs;
      await runtime.sleep(wait);
      waited += wait;
    }
    let view: AuditExportView;
    try {
      view = await transport.poll(started.exportId);
      failures = 0;
    } catch (error) {
      failures += 1;
      if (!isOutage(error) || failures >= MAX_POLL_FAILURES) throw error;
      status = "running";
      continue;
    }
    if (view.exportId !== started.exportId) throw agentXError("RUNTIME_UNAVAILABLE", "AgentX answered for another export than the one started; try again");
    status = view.status;
    if (view.status === "running") continue;
    if (view.status === "failed") throw agentXError("RUNTIME_UNAVAILABLE", failureMessage(view));
    if (view.status === "expired") throw agentXError("NOT_FOUND", "That export has expired. Start a new one.");
    if (view.download === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "AgentX said the export is ready but gave no download link; try again");
    const bytes = await downloadExport(runtime, view.download.url);
    if (view.summary !== undefined && bytes.length !== view.summary.bytes) {
      throw agentXError("RUNTIME_UNAVAILABLE", `the download was ${String(bytes.length)} bytes but the export is ${String(view.summary.bytes)} bytes, so it was cut short or replaced; run the command again`);
    }
    return { view, bytes };
  }
}

/** The range of `audit export` and `audit verify`: whole record numbers from 1, `from` not after `to`, at most 200,000 records. */
export function exportRange(from: string | undefined, to: string | undefined): { fromSeq: number; toSeq: number } {
  if (from === undefined || to === undefined) throw agentXError("CONFIG_INVALID", "name the records to export: --from <record number> --to <record number>");
  const fromSeq = recordNumber(from);
  const toSeq = recordNumber(to);
  if (fromSeq > toSeq || toSeq - fromSeq + 1 > AUDIT_EXPORT_MAX_RECORDS) throw rangeInvalid();
  return { fromSeq, toSeq };
}

/** Before anything is requested: an export file is never written over, and its folder must be there. */
export async function assertNewFile(path: string): Promise<void> {
  // lstat: a symlink at the path (even a dangling one) counts as a file that is there, and is never followed.
  const exists = await lstat(path).then(() => true, () => false);
  if (exists) throw agentXError("CONFIG_INVALID", `${path} already exists; choose another --out, so an export you kept is never overwritten`);
  const folder = await stat(dirname(path)).then((info) => info, () => undefined);
  if (folder === undefined || !folder.isDirectory()) throw agentXError("CONFIG_INVALID", `the folder for ${path} does not exist`);
}

/** Writes the file for its owner only. It is created, never overwritten, and a failed write leaves nothing behind. */
export async function saveExportFile(path: string, bytes: Buffer): Promise<void> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    const exists = (error as NodeJS.ErrnoException).code === "EEXIST";
    throw agentXError("CONFIG_INVALID", exists ? `${path} already exists; choose another --out` : `cannot write ${path}`);
  }
  try {
    await handle.writeFile(bytes);
  } catch {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true });
    throw agentXError("CONFIG_INVALID", `cannot write ${path}`);
  }
  await handle.close();
}

function summaryLines(summary: AuditExportSummary): string[] {
  const lines = [`Records ${String(summary.fromSeq)} to ${String(summary.toSeq)} (${String(summary.records)} ${plural(summary.records, "record", "records")}).`];
  lines.push(summary.sealedThroughSeq === 0
    ? "No records in this export are sealed yet."
    : `Sealed through record ${String(summary.sealedThroughSeq)}. ${String(summary.unsealedCount)} newer ${plural(summary.unsealedCount, "record is", "records are")} not sealed yet.`);
  if (summary.timestampedThrough !== undefined) lines.push(`Independent time: no later than ${timeText(summary.timestampedThrough)}.`);
  if (summary.epochsWithoutTimestamp.length > 0) {
    lines.push(`No independent timestamp for: ${summary.epochsWithoutTimestamp.map(terminalSafe).join(", ")}${summary.timestampedThrough === undefined ? "" : " (the time above does not cover them)"}.`);
  }
  for (const mode of summary.lockModes) {
    lines.push(`Sealed copies are locked in ${terminalSafe(mode).toLowerCase()} mode.`);
    if (mode === "GOVERNANCE") lines.push(GOVERNANCE_SENTENCE);
  }
  for (const label of summary.unverifiedAuthorities) {
    lines.push(`Tokens from ${terminalSafe(label)} are in the export but cannot be checked without that authority's root certificate (verify with --trust ${terminalSafe(label)}=<pem file>).`);
  }
  return lines;
}

/** `audit export`: waits for the export, saves it to `out`, and says what is in it. */
export async function exportAuditFile(
  transport: AuditExportTransport,
  runtime: AuditRuntime,
  input: { fromSeq: number; toSeq: number; withDetails: boolean; out: string; json: boolean },
): Promise<string> {
  await assertNewFile(input.out);
  const { view, bytes } = await fetchAuditExport(transport, runtime, input);
  // Only a file that reads as an audit export is saved and called saved.
  const parsed = parseExportBytes(bytes);
  if ("problem" in parsed) throw agentXError("RUNTIME_UNAVAILABLE", `the downloaded file is not a readable audit export (${parsed.problem}), so it was not saved; run the command again`);
  await saveExportFile(input.out, bytes);
  if (input.json) {
    return `${JSON.stringify({ ok: true, data: jsonSafe({ file: input.out, bytes: bytes.length, exportId: view.exportId, range: view.range, withDetails: view.withDetails, summary: view.summary, limits: AUDIT_LIMITS_COPY }) })}\n`;
  }
  const lines = [
    `Saved the export to ${terminalSafe(input.out)} (${String(bytes.length)} bytes, readable only by you).`,
    ...(view.summary === undefined ? [] : summaryLines(view.summary)),
    "",
    `To check it without trusting this CLI, run: rovara-audit-verify ${terminalSafe(input.out)}`,
    "Keep every export you take: a later export checked with --extends shows if history was rewritten in between.",
    "",
    AUDIT_LIMITS_COPY,
  ];
  return `${lines.join("\n")}\n`;
}

// ---- `audit verify` ---------------------------------------------------------------------------------------------------

const LABEL = /^[A-Za-z0-9_.-]{1,64}$/;

/** `--trust <label>=<pem file>` flags into the roots to trust, added to the pinned ones. */
export async function loadAnchors(trust: readonly string[]): Promise<Record<string, X509Certificate[]>> {
  const merged = new Map<string, X509Certificate[]>(Object.entries(defaultAnchors()));
  for (const spec of trust) {
    const at = spec.indexOf("=");
    const label = at < 0 ? "" : spec.slice(0, at);
    const path = at < 0 ? "" : spec.slice(at + 1);
    if (!LABEL.test(label) || path === "") throw agentXError("CONFIG_INVALID", "--trust takes <label>=<pem file>");
    const text = await readFile(path, "utf8").catch(() => {
      throw agentXError("CONFIG_INVALID", `cannot read ${path}`);
    });
    const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    if (blocks.length === 0) throw agentXError("CONFIG_INVALID", `${path} holds no PEM certificate`);
    const certificates = blocks.map((block) => {
      try {
        return new X509Certificate(block);
      } catch {
        throw agentXError("CONFIG_INVALID", `${path} holds a certificate that cannot be read`);
      }
    });
    merged.set(label, [...(merged.get(label) ?? []), ...certificates]);
  }
  // fromEntries defines own properties even for a label such as "__proto__".
  return Object.fromEntries(merged);
}

/** An export file's bundle, plain or gzipped, or why it is not one. `maxBytes` bounds the unpacked JSON. */
export function parseExportBytes(bytes: Buffer, maxBytes = MAX_EXPORT_BYTES): { bundle: AuditBundleV1 } | { problem: string } {
  let json: Buffer;
  try {
    json = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: maxBytes }) : bytes;
  } catch (error) {
    const tooBig = (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE";
    return { problem: tooBig ? "it is larger than an export can be when unpacked" : "it is not a readable gzip file" };
  }
  let value: unknown;
  try {
    value = JSON.parse(json.toString("utf8"));
  } catch {
    return { problem: "it is not JSON" };
  }
  try {
    return { bundle: parseBundle(value) };
  } catch {
    return { problem: "it is not a version 1 audit export" };
  }
}

/** The older export of `--extends`, read before anything is requested. */
async function olderBundle(path: string): Promise<AuditBundleV1> {
  const size = await stat(path).then((info) => info.size, () => {
    throw agentXError("CONFIG_INVALID", `cannot read ${path}`);
  });
  if (size > MAX_EXPORT_BYTES) throw agentXError("CONFIG_INVALID", `${path} is larger than an export can be`);
  const parsed = parseExportBytes(await readFile(path).catch(() => {
    throw agentXError("CONFIG_INVALID", `cannot read ${path}`);
  }));
  if ("problem" in parsed) throw agentXError("CONFIG_INVALID", `${path} is not a readable version 1 audit export (${parsed.problem})`);
  return parsed.bundle;
}

function checkLine(entry: BundleCheck): string {
  return `${entry.ok ? "ok  " : "FAIL"} ${terminalSafe(entry.name)}: ${terminalSafe(entry.detail)}`;
}

function reportLines(report: BundleReport, ok: boolean, checks: readonly BundleCheck[]): string[] {
  const lines = checks.map(checkLine);
  if (!ok) return [...lines, "", `This export did not pass: ${checks.filter((entry) => !entry.ok).map((entry) => terminalSafe(entry.name)).join(", ")}.`];
  lines.push("", report.sealedThroughSeq === 0 ? "No records in this export are sealed yet." : `Sealed and checked through record ${String(report.sealedThroughSeq)}.`);
  lines.push(`${String(report.unsealedCount)} newer ${plural(report.unsealedCount, "record is", "records are")} not sealed yet.`);
  if (report.epochsWithoutTimestamp.length > 0) lines.push(`No independent timestamp for: ${report.epochsWithoutTimestamp.map(terminalSafe).join(", ")}.`);
  else if (report.timestampedThrough !== undefined) lines.push(`Independent time: no later than ${terminalSafe(report.timestampedThrough)}.`);
  for (const mode of report.lockModes) {
    lines.push(`Sealed copies are locked in ${terminalSafe(mode).toLowerCase()} mode.`);
    if (mode === "GOVERNANCE") lines.push(GOVERNANCE_SENTENCE);
  }
  return lines;
}

/**
 * Does the export cover the records that were asked for? The control plane widens a range to whole seals, so it may start earlier
 * or end later than asked; it may not start later, end earlier, or hold nothing. (An export asked to go past the end of a log that
 * is not that long yet ends at its last record and fails here, which the detail says.)
 */
function rangeCheck(bundle: AuditBundleV1, fromSeq: number, toSeq: number): BundleCheck {
  const first = bundle.records[0] ?? bundle.unsealed[0];
  const last = bundle.unsealed.at(-1) ?? bundle.records.at(-1);
  const asked = `${String(fromSeq)} to ${String(toSeq)}`;
  if (first === undefined || last === undefined) return { name: "range", ok: false, detail: `the export holds no records, but records ${asked} were asked for` };
  if (first.seq > fromSeq) return { name: "range", ok: false, detail: `the export starts at record ${String(first.seq)}, after the first record asked for (${String(fromSeq)})` };
  if (last.seq < toSeq) {
    return { name: "range", ok: false, detail: `the export ends at record ${String(last.seq)}, before the last record asked for (${String(toSeq)}); the log may not be that long yet` };
  }
  return { name: "range", ok: true, detail: `the export holds records ${String(first.seq)} to ${String(last.seq)}, which cover the ${asked} asked for` };
}

/** Authority labels that have a token in these exports. */
function tokenLabels(bundles: readonly AuditBundleV1[]): Set<string> {
  const labels = new Set<string>();
  for (const bundle of bundles) {
    for (const entry of bundle.seals) {
      for (const stamp of entry.timestamps) labels.add(stamp.tsa);
      for (const stamp of entry.coveredBy?.timestamps ?? []) labels.add(stamp.tsa);
    }
  }
  return labels;
}

/** A `--trust` label that no token in the export (or the older one) carries trusts nothing: most likely a typo, so it fails. */
function trustLabelCheck(trust: readonly string[], bundles: readonly AuditBundleV1[]): BundleCheck | undefined {
  const used = tokenLabels(bundles);
  const unused = trust.map((spec) => spec.slice(0, spec.indexOf("="))).filter((label) => !used.has(label));
  if (unused.length === 0) return undefined;
  const present = [...used].map(terminalSafe).join(", ");
  return {
    name: "trust",
    ok: false,
    detail: `--trust ${[...new Set(unused)].map(terminalSafe).join(", ")} matches no timestamp in the export (it has tokens from: ${present === "" ? "no authority" : present})`,
  };
}

/** The `org` claim of a developer access token: the person's own token, read here only to compare an export with their organization. */
function orgOfToken(accessToken: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { org?: unknown };
    return typeof payload.org === "string" ? payload.org : undefined;
  } catch {
    return undefined;
  }
}

export interface AuditVerifyResult {
  /** What the command prints. */
  text: string;
  ok: boolean;
}

/**
 * `audit verify`: exports the range without details, then checks it here with the verifier's own `verifyBundle` and, with
 * `--extends`, `verifyExtends` against an older export. The older export and the `--trust` roots are read first, so a mistake
 * there costs no export.
 */
export async function verifyAuditExport(
  transport: AuditExportTransport,
  runtime: AuditRuntime,
  input: { fromSeq: number; toSeq: number; trust: readonly string[]; extendsPath?: string | undefined; out?: string | undefined; json: boolean },
): Promise<AuditVerifyResult> {
  const anchors = await loadAnchors(input.trust);
  const older = input.extendsPath === undefined ? undefined : await olderBundle(input.extendsPath);
  if (input.out !== undefined) await assertNewFile(input.out);
  const { bytes } = await fetchAuditExport(transport, runtime, { fromSeq: input.fromSeq, toSeq: input.toSeq, withDetails: false });
  if (input.out !== undefined) await saveExportFile(input.out, bytes);
  const parsed = parseExportBytes(bytes);
  if ("problem" in parsed) {
    throw new ReportedFailure("VERIFICATION_FAILED", `The downloaded file is not a readable audit export (${parsed.problem}), so nothing was verified.${input.out === undefined ? "" : ` It was saved to ${terminalSafe(input.out)}.`}`);
  }
  const bundle = parsed.bundle;
  const report = verifyBundle(bundle, { anchors });
  const checks: BundleCheck[] = [...report.checks, rangeCheck(bundle, input.fromSeq, input.toSeq)];
  const expectedOrg = await transport.orgId?.().catch(() => undefined);
  if (expectedOrg !== undefined) {
    checks.push({
      name: "organization",
      ok: bundle.orgId === expectedOrg,
      detail: bundle.orgId === expectedOrg ? "the export is of your organization" : "the export is of another organization than the one you are signed in to",
    });
  }
  if (older !== undefined) {
    const olderReport = verifyBundle(older, { anchors });
    checks.push({
      name: "olderExport",
      ok: olderReport.ok,
      detail: olderReport.ok
        ? `the older export passes its own checks (sealed through record ${String(olderReport.sealedThroughSeq)})`
        : `the older export fails its own checks: ${olderReport.checks.filter((entry) => !entry.ok).map((entry) => entry.name).join(", ")}`,
    });
    const result = verifyExtends(bundle, older);
    checks.push({ name: "extends", ok: result.ok, detail: result.detail });
  }
  const unusedLabel = trustLabelCheck(input.trust, older === undefined ? [bundle] : [bundle, older]);
  if (unusedLabel !== undefined) checks.push(unusedLabel);
  const ok = checks.every((entry) => entry.ok);
  if (input.json) {
    return { ok, text: `${JSON.stringify({ ok, data: jsonSafe({ ...report, ok, checks, limits: AUDIT_LIMITS_COPY }) })}\n` };
  }
  const lines = reportLines(report, ok, checks);
  for (const label of report.unverifiedAuthorities) {
    lines.push(`Tokens from ${terminalSafe(label)} were not checked: pass --trust ${terminalSafe(label)}=<pem file> with that authority's root certificate.`);
  }
  lines.push("", input.out === undefined
    ? "Add --out <file> to keep the export you checked: you need it to check a later export with --extends."
    : `Saved the export to ${terminalSafe(input.out)}.`);
  lines.push("For a check that doesn't trust this CLI, run rovara-audit-verify on the exported file.", "", AUDIT_LIMITS_COPY);
  return { ok, text: `${lines.join("\n")}\n` };
}

// ---- `audit open` -----------------------------------------------------------------------------------------------------

/** The audit page of the signed-in cell. The page signs in with the browser's own session, not this computer's token. */
export async function auditPageUrl(deps: Pick<DeveloperSessionDeps, "home">, env: string | undefined): Promise<string> {
  const { entry } = await resolveDeveloperEnvironment(deps.home, env);
  return `${entry.url}/v1/app/audit/view`;
}
