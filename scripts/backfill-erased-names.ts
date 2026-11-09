// 0.5.11 REQUIRED release step (owner decision 22, ERASED-REJOIN-NAME; idempotent, bounded, resumable): erases the name people CHOSE, and the name their sign-in record holds,
// for everyone erased before 0.5.11. Run it once per install, after the upgrade and before people are told the name feature is on. Without it an erased person who signs in again gets their
// chosen name back into their own "me" name and into invite and SSO emails.
//
//   under the release wrapper (it sets the account, region and credentials and refuses --profile):
//   ~/.local/share/rovara-tools/staging-aws.sh npx tsx scripts/backfill-erased-names.ts --keys-table <audit keys table> --state-table <state table> --identity-function <sign-in function> [--apply]
//
// WHO is erased. The audit ledger keeps one tombstone per erased person (`ORG#<org>` / `SUBJECT#<developer id>` with `erasedAt` in the audit KEYS table, audit/erase.ts). That is the only record
// that still names the person's developer id (the Team record keeps a one-way hash). The script Scans that table (a filter, Limit pages, a pause between pages) and reads only the tombstones.
// WHAT it does for each person: `nameEraserOf(...).erase(developerId)` from the broker (developer/erase-name.ts): the State item `DEVELOPER_NAME#<id>` becomes a tombstone with no name, and the
// sign-in function clears the record's name. It reads the name items first with the broker's own `readNameItems` and leaves two kinds alone:
//   - already erased (a tombstone with no name): counted, nothing written, so a second --apply changes nothing;
//   - erased and then rejoined with a NEW name (ERASED-REJOIN-NAME): that name belongs to the new membership and is kept.
// A person erased before the name feature existed, or whose erase did not finish, is erased now. A person who rejoined and chose a name BEFORE this backfill ran has no tombstone and is erased
// again (the name is lost and they choose again): that is why this runs first (register: ERASE-REJOIN-ASK).
//
// DEFAULT is a dry run: Scan and BatchGet/Get only; it prints counts and short hashes of ids, never a name, an email or a raw id. --apply writes. A person whose erase fails is counted and the run
// goes on. EXIT CODES: 0 finished clean; 1 an erase failed or a read failed (the summary says which, with codes); 2 bad option; 3 the run stopped at --max-pages or --max-ms before the end
// (a required step is NOT done until a run exits 0).
// A person whose name item is already a tombstone has the SIGN-IN erase repeated (the broker's own port; it sets the same placeholder again and changes nothing the second time), because the
// tombstone is written BEFORE the sign-in record is cleared and an erase that failed in between leaves the tombstone alone. The name item is not touched again.
// KNOWN GAP: when a company is closed and its audit details shredded, its ledger tombstones are deleted, so people erased only there cannot be found. The summary counts `shreddedOrgs` so the
// operator knows to look at them by hand.
// --cursor-file keeps where a bounded run (--max-pages, --max-ms) stopped. It holds developer ids and company ids: keep it in a private directory (mode 0600 is set) and delete it afterwards. It is
// removed when the run finishes. A cursor of a dry run is refused by an --apply run and the other way round.
import { createHash } from "node:crypto";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { EraseDeveloperNameRequest, EraseDeveloperNameResponse } from "@agentx/contracts";
import { eraseDeveloperNameThroughLambda } from "../packages/broker/src/aws/developer-routes/identity-lambda.js";
import { chosenNameKey, readNameItems, rejoinedOf, type ChosenNameClient, type ChosenNameItem } from "../packages/broker/src/developer/chosen-name.js";
import { nameEraserOf } from "../packages/broker/src/developer/erase-name.js";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_MS = 600_000;
const DEFAULT_PAUSE_MS = 200;
/** A developer id as the sign-in function takes it (EraseDeveloperNameRequestSchema). */
const DEVELOPER_ID = /^[a-f0-9]{64}$/;
/** How many hashed ids a summary lists per group. */
const LISTED = 500;
const THROTTLE_ERRORS = new Set(["ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded", "ThrottledException", "TooManyRequestsException", "LimitExceededException", "InternalServerError", "ServiceUnavailable"]);
const THROTTLE_TRIES = 6;

export interface EraseBackfillArgs {
  keysTable: string;
  stateTable: string;
  region: string;
  /** Absent only with --no-sign-in (an install with no sign-in function keeps no sign-in record). */
  identityFunction?: string;
  profile?: string;
  apply: boolean;
  pageSize: number;
  /** Stop after this many Scan pages (0: no limit). */
  maxPages: number;
  maxMs: number;
  pauseMs: number;
  cursorFile?: string;
}

const VALUE_OPTIONS = ["--keys-table", "--state-table", "--region", "--identity-function", "--profile", "--page-size", "--max-pages", "--max-ms", "--pause-ms", "--cursor-file"];
const FLAG_OPTIONS = ["--apply", "--dry-run", "--no-sign-in"];

/** The options, with the table names, the region and the sign-in function also taken from the environment the release wrapper and the broker use. `--profile` is optional: the wrapper sets AWS_PROFILE itself. */
export function parseEraseBackfillArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): EraseBackfillArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index] ?? "";
    if (FLAG_OPTIONS.includes(name)) {
      if (flags.has(name)) throw new Error(`${name} was given twice`);
      flags.add(name);
      continue;
    }
    if (!VALUE_OPTIONS.includes(name)) throw new Error(`unknown option ${name}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (values.has(name)) throw new Error(`${name} was given twice`);
    values.set(name, value);
    index += 1;
  }
  if (flags.has("--apply") && flags.has("--dry-run")) throw new Error("give --apply or --dry-run, not both (the default is a dry run)");
  const tableOf = (option: string, variable: string, what: string): string => {
    const table = values.get(option) ?? env[variable];
    if (table === undefined || !/^[A-Za-z0-9_.-]{3,255}$/.test(table)) throw new Error(`${option} (or ${variable}) is required and must be the ${what} table name`);
    return table;
  };
  const keysTable = tableOf("--keys-table", "AUDIT_KEYS_TABLE_NAME", "audit keys");
  const stateTable = tableOf("--state-table", "STATE_TABLE_NAME", "state");
  const region = values.get("--region") ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  if (region === undefined || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new Error("--region (or AWS_REGION) is required, for example us-west-2 for staging; there is no default");
  const identityFunction = values.get("--identity-function") ?? env.DEVELOPER_IDENTITY_FUNCTION_NAME;
  const noSignIn = flags.has("--no-sign-in");
  if (noSignIn && values.has("--identity-function")) throw new Error("give --identity-function or --no-sign-in, not both");
  if (!noSignIn && (identityFunction === undefined || !/^[A-Za-z0-9_:.\-/]{1,300}$/.test(identityFunction))) {
    throw new Error("--identity-function (or DEVELOPER_IDENTITY_FUNCTION_NAME) is required: the sign-in function clears the name on the sign-in record (use --no-sign-in only for an install with no sign-in function)");
  }
  const whole = (name: string, fallback: number, minimum: number): number => {
    const text = values.get(name);
    if (text === undefined) return fallback;
    if (!/^\d{1,9}$/.test(text) || Number(text) < minimum) throw new Error(`${name} must be a whole number of at least ${String(minimum)}`);
    return Number(text);
  };
  const profile = values.get("--profile");
  const cursorFile = values.get("--cursor-file");
  return {
    keysTable, stateTable, region, apply: flags.has("--apply"),
    pageSize: Math.min(whole("--page-size", DEFAULT_PAGE_SIZE, 1), 1000), maxPages: whole("--max-pages", 0, 0), maxMs: whole("--max-ms", DEFAULT_MAX_MS, 1), pauseMs: whole("--pause-ms", DEFAULT_PAUSE_MS, 0),
    ...(noSignIn || identityFunction === undefined ? {} : { identityFunction }),
    ...(profile === undefined ? {} : { profile }),
    ...(cursorFile === undefined ? {} : { cursorFile }),
  };
}

/** A short stable hash of a developer id, for a summary line. Not reversible in practice; never the id. */
export function shortHash(developerId: string): string {
  return `p-${createHash("sha256").update(`erase-name-backfill:${developerId}`).digest("hex").slice(0, 12)}`;
}

export interface EraseBackfillSummary {
  mode: "dry-run" | "apply";
  /** Erase tombstones read from the ledger. */
  tombstones: number;
  /** Distinct people with a valid developer id. */
  people: number;
  /** Tombstones whose id the sign-in function would refuse (not 64 hex characters): left alone. */
  invalidIds: number;
  /** People whose name item is already a tombstone with no name (nothing to do). */
  alreadyErased: number;
  /** Already-erased people whose sign-in erase was repeated (apply only). */
  signInConfirmed: number;
  /** Companies whose audit details were shredded: the people erased only there cannot be found. */
  shreddedOrgs: number;
  /** People who were erased and then chose a new name for a new membership (kept). */
  rejoinedKept: number;
  /** People the run would erase (dry run) or tried to erase (apply). */
  toErase: number;
  erased: number;
  failed: number;
  /** Failures by fixed code (an AWS error name or an erase_name_sign_in_* code), never free text. */
  failureCodes: Record<string, number>;
  pages: number;
  finished: boolean;
  /** The first hashed ids of each group (at most 500). */
  toEraseIds: string[];
  failedIds: string[];
  /** Set when a read or the cursor write stopped the run: the fixed code. The counts above are what was done before it. */
  abortedBy?: string;
  message: string;
}

export interface EraseBackfillPorts {
  documentClient: ChosenNameClient;
  /** The sign-in function's erase of the record's name (the broker's `eraseDeveloperNameThroughLambda`). Absent with --no-sign-in. */
  eraseSignInName?: (request: EraseDeveloperNameRequest) => Promise<EraseDeveloperNameResponse>;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Cursor { mode: "dry-run" | "apply"; start: Record<string, unknown> }

/** An error whose text the backfill wrote itself (never data): the command may print it. */
class BackfillError extends Error {}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Codes only: an AWS error name or an erase code, so nothing the error carried (a key, a name) reaches the output. */
export function failureCodeOf(error: unknown): string {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  const message = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof message === "string" && /^erase_name_sign_in_[a-z_]{1,40}$/.test(message)) return message;
  return typeof name === "string" && /^[A-Za-z]{1,80}$/.test(name) ? name : "unknown_error";
}

async function readCursor(args: EraseBackfillArgs): Promise<Cursor | undefined> {
  if (args.cursorFile === undefined) return undefined;
  let text: string;
  try {
    text = await readFile(args.cursorFile, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw new BackfillError("the cursor file could not be read");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new BackfillError("the cursor file is not readable; remove it to start from the beginning"); }
  const cursor = parsed as Partial<Cursor> | null;
  if (cursor === null || (cursor.mode !== "dry-run" && cursor.mode !== "apply") || typeof cursor.start !== "object" || cursor.start === null) throw new BackfillError("the cursor file is not readable; remove it to start from the beginning");
  if (cursor.mode !== (args.apply ? "apply" : "dry-run")) throw new BackfillError(`the cursor file belongs to a ${cursor.mode} run; use a file of its own for this run, or remove it`);
  return { mode: cursor.mode, start: cursor.start };
}

async function writeCursor(args: EraseBackfillArgs, cursor: Cursor): Promise<void> {
  if (args.cursorFile === undefined) return;
  await writeFile(args.cursorFile, JSON.stringify(cursor), { mode: 0o600 });
  await chmod(args.cursorFile, 0o600);
}

/** Runs the backfill. Throws only when it cannot go on at all (a Scan that keeps failing, an unreadable cursor); a person's failed erase is counted. */
export async function runEraseBackfill(args: EraseBackfillArgs, ports: EraseBackfillPorts): Promise<EraseBackfillSummary> {
  const sleep = ports.sleep ?? defaultSleep;
  const summary: EraseBackfillSummary = {
    mode: args.apply ? "apply" : "dry-run", tombstones: 0, people: 0, invalidIds: 0, alreadyErased: 0, signInConfirmed: 0, shreddedOrgs: 0, rejoinedKept: 0, toErase: 0, erased: 0, failed: 0, failureCodes: {},
    pages: 0, finished: false, toEraseIds: [], failedIds: [], message: "",
  };
  const retrying = async <T>(work: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (attempt >= THROTTLE_TRIES || !THROTTLE_ERRORS.has(failureCodeOf(error))) throw error;
        await sleep(Math.min(200 * 2 ** attempt, 5_000));
      }
    }
  };
  // The broker's own eraser, over the same State table and sign-in function.
  const eraser = nameEraserOf({ documentClient: ports.documentClient, stateTable: args.stateTable, ...(ports.eraseSignInName === undefined ? {} : { eraseSignInName: ports.eraseSignInName }), now: ports.now });
  const deadline = ports.now() + args.maxMs;
  const seen = new Set<string>();
  let start = (await readCursor(args))?.start;
  /** The name item as it is now, read consistently (the BatchGet may leave keys unprocessed, and "absent" must be a confirmed answer before anything is erased). */
  const itemOf = async (developerId: string, batch: Map<string, ChosenNameItem>): Promise<ChosenNameItem | undefined> => {
    const known = batch.get(developerId);
    if (known !== undefined) return known;
    const found = await retrying(() => ports.documentClient.send(new GetCommand({ TableName: args.stateTable, Key: chosenNameKey(developerId), ConsistentRead: true }))) as { Item?: ChosenNameItem };
    return found.Item;
  };
  const fail = (developerId: string, error: unknown): void => {
    summary.failed += 1;
    const code = failureCodeOf(error);
    summary.failureCodes[code] = (summary.failureCodes[code] ?? 0) + 1;
    if (summary.failedIds.length < LISTED) summary.failedIds.push(shortHash(developerId));
  };
  try {
    for (;;) {
      const page = await retrying(() => ports.documentClient.send(new ScanCommand({
        TableName: args.keysTable,
        FilterExpression: "(begins_with(sk, :subject) AND attribute_exists(erasedAt)) OR sk = :shredded",
        ExpressionAttributeValues: { ":subject": "SUBJECT#", ":shredded": "SHREDDED" },
        ProjectionExpression: "pk, sk, erasedAt",
        ConsistentRead: true,
        Limit: args.pageSize,
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      }))) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
      summary.pages += 1;
      const ids: string[] = [];
      for (const item of page.Items ?? []) {
        if (item.sk === "SHREDDED") { summary.shreddedOrgs += 1; continue; }
        if (typeof item.sk !== "string" || !item.sk.startsWith("SUBJECT#") || typeof item.erasedAt !== "string") continue;
        summary.tombstones += 1;
        const developerId = item.sk.slice("SUBJECT#".length);
        if (!DEVELOPER_ID.test(developerId)) { summary.invalidIds += 1; continue; }
        if (seen.has(developerId)) continue;
        seen.add(developerId);
        summary.people += 1;
        ids.push(developerId);
      }
      let batch: Map<string, ChosenNameItem> = new Map();
      if (ids.length > 0) batch = await retrying(() => readNameItems(ports.documentClient, args.stateTable, ids));
      for (const developerId of ids) {
        let item: ChosenNameItem | undefined;
        try {
          item = await itemOf(developerId, batch);
        } catch (error) {
          // Not read: not erased, not skipped. Counted as a failure and left for the next run.
          fail(developerId, error);
          continue;
        }
        if (item?.erased === true && rejoinedOf(item, developerId) !== undefined) { summary.rejoinedKept += 1; continue; }
        const bareTombstone = item?.erased === true && item.name === undefined;
        if (bareTombstone) summary.alreadyErased += 1;
        else {
          summary.toErase += 1;
          if (summary.toEraseIds.length < LISTED) summary.toEraseIds.push(shortHash(developerId));
        }
        if (!args.apply) continue;
        try {
          if (!bareTombstone) {
            await retrying(() => eraser.erase(developerId));
            summary.erased += 1;
          } else if (ports.eraseSignInName !== undefined) {
            const answer = await retrying(() => ports.eraseSignInName!({ kind: "erase-developer-name", developerId, at: new Date(ports.now()).toISOString() }));
            // Not found is an answer: the person never signed in.
            if (!answer.ok && answer.error !== "not_found") throw new Error(`erase_name_sign_in_${answer.error}`);
            summary.signInConfirmed += 1;
          }
        } catch (error) {
          fail(developerId, error);
        }
      }
      start = page.LastEvaluatedKey;
      if (start === undefined) { summary.finished = true; break; }
      await writeCursor(args, { mode: summary.mode, start });
      if ((args.maxPages > 0 && summary.pages >= args.maxPages) || ports.now() >= deadline) break;
      if (args.pauseMs > 0) await sleep(args.pauseMs);
    }
  } catch (error) {
    // A read or the cursor write could not go on: what was done before it is still reported.
    summary.abortedBy = failureCodeOf(error);
  }
  if (summary.finished && args.cursorFile !== undefined) await rm(args.cursorFile, { force: true });
  summary.message = messageOf(summary);
  return summary;
}

function messageOf(summary: EraseBackfillSummary): string {
  const notes = `${summary.invalidIds > 0 ? ` ${String(summary.invalidIds)} ledger ids were not developer ids and were skipped.` : ""}${summary.shreddedOrgs > 0 ? ` ${String(summary.shreddedOrgs)} companies were shredded: people erased only there cannot be found (check them by hand).` : ""}`;
  if (summary.abortedBy !== undefined) return `The run stopped (${summary.abortedBy}) after ${String(summary.pages)} pages; the counts are what was done before it. Run it again.${notes}`;
  const where = summary.finished ? "" : " The run stopped at its limit and is NOT done: run it again with the same --cursor-file to continue.";
  if (summary.failed > 0) return `${String(summary.failed)} erases failed (${Object.keys(summary.failureCodes).join(", ")}); run it again.${where}${notes}`;
  if (summary.mode === "dry-run") return (summary.toErase === 0 ? "Nothing to erase: no name would change. Dry run, nothing was written." : `Dry run, nothing was written: ${String(summary.toErase)} people would be erased. Run again with --apply.`) + where + notes;
  return (summary.erased === 0 ? "Nothing to change: every erased person was already done." : `Erased ${String(summary.erased)} people.`) + where + notes;
}

/** Exit code: 0 finished clean, 1 any erase or read failed, 3 stopped at a limit before the end (not done). */
export function exitCodeOf(summary: EraseBackfillSummary): number {
  if (summary.failed > 0 || summary.abortedBy !== undefined) return 1;
  return summary.finished ? 0 : 3;
}

/** The whole command: parse, run, print one JSON summary on stdout and a sentence on stderr. Returns the exit code; never prints an error's text beyond a code. */
export async function runEraseBackfillCommand(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, build: (args: EraseBackfillArgs) => EraseBackfillPorts, out: (line: string) => void = console.log, err: (line: string) => void = console.error): Promise<number> {
  let args: EraseBackfillArgs;
  try {
    args = parseEraseBackfillArgs(argv, env);
  } catch (error) {
    err(error instanceof Error ? error.message : "bad options");
    return 2;
  }
  try {
    const summary = await runEraseBackfill(args, build(args));
    out(JSON.stringify(summary));
    err(summary.message);
    return exitCodeOf(summary);
  } catch (error) {
    if (error instanceof BackfillError) { err(error.message); return 1; }
    err(`the backfill stopped (${failureCodeOf(error)}): nothing was left half-written that a second run cannot finish`);
    return 1;
  }
}

function clientsOf(args: EraseBackfillArgs): EraseBackfillPorts {
  // The credentials and region come from the environment (the release wrapper sets them); --profile is only for a run outside it.
  const config = { region: args.region, maxAttempts: 8, ...(args.profile === undefined ? {} : { profile: args.profile }) };
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(config));
  const functionName = args.identityFunction;
  const lambda = functionName === undefined ? undefined : new LambdaClient(config);
  return {
    documentClient,
    now: Date.now,
    ...(lambda === undefined || functionName === undefined ? {} : { eraseSignInName: eraseDeveloperNameThroughLambda((payload) => lambda.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))) }),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The broker's own functions log to console.log; stdout carries the one summary line only.
  const print = console.log.bind(console);
  console.log = console.error;
  void runEraseBackfillCommand(process.argv.slice(2), process.env, clientsOf, print).then((code) => { process.exitCode = code; });
}
