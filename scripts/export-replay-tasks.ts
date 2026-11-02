// Setup and test health VX-3 (owner, 2026-11-02): the task exporter that feeds scripts/replay-results.ts. The replay check (owner decision 5) needs real tasks from staging; this turns stored task records into the snapshot
// format that script reads. READ-ONLY, and it makes NO AWS call: its input is a JSON file that an operator exports separately; its output is one JSON file per task in a folder.
//
// Usage (from the repository root):
//   npx tsx scripts/export-replay-tasks.ts --input <items.json> --out <folder> [--now <ISO time>] [--salt <text>] [--limit <n>] [--marshalled]
//   npx tsx scripts/replay-results.ts --dir <folder>
//
// THE INPUT FILE is either a JSON array of items or { "items": [...], "evidencePacks": { "<taskId>": <pack> }, "facts": { "<taskId>": <facts> } }. The items are the staging State table's items, UNMARSHALLED (plain JSON; with
// --marshalled the items may be DynamoDB JSON, `{"S": ...}`, and are unmarshalled here). For each recent task the operator exports:
//   - the task's own partition:   pk = DEVTASK#<taskId>          (the META item holds the workflow; MERGE_TRACKING# items name the branches its pull requests target)
//   - its project's partition:    pk = the project partition key of the task's company and project (`projectPk(orgId, project)`): the sk prefixes REV# (the repositories' default branch), TESTENV#BASELINE#LATEST (the
//                                 last nightly), TESTENV#KNOWNFAILING (the marks), FULLRUN (the follow-up full runs)
//   - the evidence pack, which is NOT in the table but in the artifact bucket (key private/<owner>/<workspace>/evidence-pack/<taskId>/<candidateDigest>.json); it goes under "evidencePacks".
//   - the auto-fix facts (`checkOriginal` and the like) are not stored anywhere readable; "facts" may carry them when the operator has them. Without them a failed-before check is judged on the stored fields alone.
// EVERY STAGING AWS COMMAND must go through ~/.local/share/rovara-tools/staging-aws.sh (account 944937319445, us-west-2; it refuses anything else), for example (the operator runs these, never this script):
//   ~/.local/share/rovara-tools/staging-aws.sh aws dynamodb query --table-name <state table> --key-condition-expression 'pk = :pk' --expression-attribute-values '{":pk":{"S":"DEVTASK#<taskId>"}}' --output json
//   ~/.local/share/rovara-tools/staging-aws.sh aws dynamodb query --table-name <state table> --key-condition-expression 'pk = :pk AND begins_with(sk, :p)' --expression-attribute-values '{":pk":{"S":"<project pk>"},":p":{"S":"TESTENV#"}}' --output json
//   ~/.local/share/rovara-tools/staging-aws.sh aws s3 cp s3://<artifact bucket>/<evidence pack key> -
// and the "Items" of each answer go into the input file's "items" (run with --marshalled for the CLI's typed JSON).
//
// WHAT IS KEPT. Only what the result rules and the replay oracle read, and no repository content: every test name (in the evidence, the nightly baseline and the marks) becomes a stable hash (a salted sha256, so the same
// name is the same hash everywhere in one export and cannot be looked up); check labels and commands, folders, executables, arguments, titles, texts, messages, paths, branches and artifact keys are replaced with fixed
// words or hashes; the evidence pack is rebuilt from its counts, outcomes and hashed test names alone (no output tail, finding, coverage line, URL or sample). A final check refuses any snapshot that still holds a string
// that is not a fixed word, an id, a time or a hash: that task is skipped and counted, never written.
//
// The snapshot also carries the RAW nightly baseline, marks and branches (hashed) under "known", so the replay oracle can judge "already failing" from the data itself, without the broker's own rules.
// Output on the terminal is counts and task ids only.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
  AUTO_FIX_BLOCK_CAUSES, EvidencePackSchema, WORKFLOW_BLOCK_REASONS, WorkflowSnapshotSchema, workflowApplicationEvidenceCodes,
  type EvidencePack, type OrgId,
} from "@agentx/contracts";
import type { DeveloperTaskRecord } from "../packages/broker/src/developer/task-records.js";
import { fullSuiteOf } from "../packages/broker/src/aws/developer-tasks/testing-view.js";
import { alreadyFailingForResults, readKnownFailingRow } from "../packages/broker/src/test-env/known-failing.js";
import { nightlyOptionsFor, projectBaseBranch } from "../packages/broker/src/test-env/nightly-usable.js";
import { readNightlyBaseline } from "../packages/broker/src/test-env/nightly.js";
import { ReplaySnapshotSchema, type ReplaySnapshot } from "./replay-results.js";

type Item = Record<string, unknown>;
export const SKIP_REASONS = ["no_workflow", "not_version_1_1", "no_candidate", "unreadable_workflow", "unreadable_evidence", "no_company_or_project", "full_run_failed", "block_reason_unknown", "facts_invalid", "content_left", "unreadable_snapshot"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
export interface ExportInput { items: readonly unknown[]; evidencePacks?: Readonly<Record<string, unknown>> | undefined; facts?: Readonly<Record<string, unknown>> | undefined }
export interface ExportOptions {
  /** The clock the broker's rules would have read (the age of a nightly): the time of the export. */
  now: number;
  /** Salts the hashes of names. A fresh random salt per export unless given (a repeat export with the same salt gives the same hashes). */
  salt: string;
  /** The most tasks exported (newest first by the task's `createdAt`, when it has one). */
  limit?: number | undefined;
}
export interface ExportResult { snapshots: ReplaySnapshot[]; skipped: Array<{ taskId: string; reason: SkipReason }>; /** Items in the input that were not recognised (counted, never read). */ ignoredItems: number }

// ---- the stored items, as the broker's own readers see them

/** An in-memory stand-in for the State table over the exported items: the three commands the readers use (a get, and a query by partition and sort-key prefix, newest first with a limit). No network. */
function tableOver(items: readonly Item[]) {
  const byKey = new Map<string, Item>();
  for (const item of items) if (typeof item["pk"] === "string" && typeof item["sk"] === "string") byKey.set(`${item["pk"]}\u0000${item["sk"]}`, item);
  return {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof GetCommand) {
        const key = command.input.Key as { pk: string; sk: string };
        return { Item: byKey.get(`${key.pk}\u0000${key.sk}`) };
      }
      if (command instanceof QueryCommand) {
        const values = command.input.ExpressionAttributeValues as Record<string, string>;
        const found = [...byKey.values()].filter((item) => item["pk"] === values[":pk"] && (values[":prefix"] === undefined || (item["sk"] as string).startsWith(values[":prefix"])));
        found.sort((a, b) => ((a["sk"] as string) < (b["sk"] as string) ? 1 : -1));
        return { Items: command.input.ScanIndexForward === false ? found.slice(0, command.input.Limit ?? found.length) : found.reverse() };
      }
      throw new Error("the exported table answers reads only");
    },
  };
}

// ---- hashing and redaction

/** A test name or other identifier that must not leave as itself: a salted hash, the same everywhere in one export. */
export const nameHash = (salt: string, value: string): string => `h${createHash("sha256").update(`${salt}\u0000${value}`).digest("hex").slice(0, 31)}`;

/** Keys whose string (or list of strings) is repository, person or project content in a stored workflow. */
export const CONTENT_KEYS: ReadonlySet<string> = new Set([
  "label", "title", "text", "permalink", "author", "summary", "message", "body", "description", "path", "file", "url", "uri", "href", "key", "name", "cwd", "executable", "args", "note", "notes", "comment", "comments", "rationale", "detail", "details",
  "diff", "patch", "output", "error", "content", "question", "answer", "prompt", "heading", "branch", "repository", "command", "stdout", "stderr", "reply", "feedback", "instruction", "instructions", "scenario", "claim",
]);

/** A string that is only a fixed word, an id, a time or a hash: what a snapshot may hold. No spaces, no slashes, no dots (so no sentence, path or file name). */
const SAFE_SHAPES: readonly RegExp[] = [
  /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/u,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  /^[0-9a-f]{32,64}$/u,
  /^\d+\.\d+\.\d+$/u,
  /^[A-Za-z][A-Za-z0-9_:-]{0,79}$/u,
  /^https:\/\/redacted\.invalid\/[0-9a-f]{12}$/u,
];
const isSafeString = (value: string): boolean => value === "" || SAFE_SHAPES.some((shape) => shape.test(value));
const KNOWN_BLOCK_REASONS: ReadonlySet<string> = new Set(Object.values(WORKFLOW_BLOCK_REASONS));

/** Every string in a value that is not a safe shape (a count of them is the answer; the strings themselves are never reported). */
export function unsafeStrings(value: unknown, allowed: ReadonlySet<string> = new Set()): number {
  if (typeof value === "string") return isSafeString(value) || allowed.has(value) ? 0 : 1;
  if (Array.isArray(value)) return value.reduce<number>((sum, entry) => sum + unsafeStrings(entry, allowed), 0);
  if (value !== null && typeof value === "object") return Object.entries(value).reduce<number>((sum, [key, entry]) => sum + unsafeStrings(key, allowed) + unsafeStrings(entry, allowed), 0);
  return 0;
}

/** The only values of `path` that are product words. */
const WORKFLOW_PATH_WORDS: ReadonlySet<string> = new Set(["QUICK", "FULL"]);
/** Keys whose string is an address; the workflow schema wants each to stay a URL. */
const URL_KEYS: ReadonlySet<string> = new Set(["url", "uri", "href", "permalink"]);
/** A pull request's address, which the workflow schema wants to be a URL: a placeholder that is one and names nothing. */
const redactedUrl = (salt: string, value: string): string => `https://redacted.invalid/${nameHash(salt, value).slice(1, 13)}`;

/** The stored workflow with every content field replaced; the structure the rules read (state, stage, revision, candidate, verification results, the check list's ids and kinds, reviews, pull requests) stays. */
export function scrubWorkflow(value: unknown, salt: string, key?: string): unknown {
  if (key !== undefined && CONTENT_KEYS.has(key)) {
    if (typeof value === "string" && URL_KEYS.has(key)) return redactedUrl(salt, value);
    // The one fixed-word exemption: a workflow `path` is QUICK or FULL. Any other upper-case word (a repository's PAYMENTS, LEDGER, PYTEST) is content.
    if (typeof value === "string") return key === "path" && WORKFLOW_PATH_WORDS.has(value) ? value : nameHash(salt, value);
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return [];
    if (value === null || typeof value !== "object") return value;
    // A nested object under a content key (a command): its own content keys are replaced below.
  }
  if (Array.isArray(value)) return value.map((entry) => scrubWorkflow(entry, salt));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, scrubWorkflow(entry, salt, name)]));
  return value;
}

/** The block reason as a fixed sentence the rules compare, or the codes of an incomplete application round with the group names replaced; anything else cannot be told apart from text and is refused (undefined). */
function scrubBlockReason(reason: unknown): { ok: true; value: string | undefined } | { ok: false } {
  if (reason === undefined) return { ok: true, value: undefined };
  if (typeof reason !== "string") return { ok: false };
  if (KNOWN_BLOCK_REASONS.has(reason)) return { ok: true, value: reason };
  const codes = workflowApplicationEvidenceCodes(reason);
  if (codes === undefined || !codes.every((code) => /^[a-z][a-z0-9-]{0,63}$/u.test(code))) return { ok: false };
  const prefix = reason.slice(0, reason.indexOf(" ("));
  return KNOWN_BLOCK_REASONS.has(prefix) || /^[A-Za-z0-9 ,'.-]{1,200}$/u.test(prefix) ? { ok: true, value: `${prefix} (${codes.map((code, index) => `g${String(index)}: ${code}`).join("; ")})` } : { ok: false };
}

/** The evidence pack rebuilt from counts, outcomes and hashed test names only. */
export function redactPack(pack: EvidencePack, salt: string): EvidencePack {
  const hash = (value: string) => nameHash(salt, value);
  return EvidencePackSchema.parse({
    schemaVersion: 1,
    candidateDigest: pack.candidateDigest,
    environment: { tier: pack.environment.tier, envRevision: pack.environment.envRevision, services: [], data: "synthetic", accounts: [] },
    checks: pack.checks.map((check) => ({
      checkId: check.checkId, kind: check.kind, label: check.checkId, before: check.before, after: check.after, class: check.class, durationMs: check.durationMs,
      ...(check.tests === undefined ? {} : {
        tests: {
          total: check.tests.total, passed: check.tests.passed, failed: check.tests.failed, skipped: check.tests.skipped, errored: check.tests.errored,
          names: check.tests.names.map((test) => ({ name: hash(test.name), status: test.status })), newTests: check.tests.newTests.map(hash),
        },
      }),
    })),
    selection: { method: pack.selection.method, selected: pack.selection.selected, total: pack.selection.total, ...(pack.selection.fallbackReason === undefined ? {} : { fallbackReason: pack.selection.fallbackReason }) },
    api: [], browser: [],
    notTested: pack.notTested.map((entry) => ({ kind: entry.kind, id: hash(entry.id), text: "", reason: "redacted" })),
  });
}

const ORIGINAL_RESULTS: readonly unknown[] = ["passed", "failed", "cannot-run"];
const GROUP_RESULTS: readonly unknown[] = [...ORIGINAL_RESULTS, "skipped", "pending", "not-run"];
const BOOLEAN_FACTS = ["providerOutage", "runnerBusy", "setupFailedInTask", "hostBlocked", "buildHostOffline", "ownerCancelled"] as const;
const ID_LIST_FACTS = ["checkExpectsPass", "newFailingChecks"] as const;
const isIdList = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 64 && value.every((entry) => typeof entry === "string" && isSafeString(entry));
/**
 * The auto-fix facts a replay reads (`AutoFixFacts`), each checked against its type: booleans are booleans, the block cause and each result are one of their words, and lists hold check ids. Any other key is dropped; a
 * value of the wrong type makes the whole set invalid (the task is skipped), never a guess. Group names are hashed.
 */
function redactFacts(facts: unknown, salt: string): { ok: true; value: Record<string, unknown> | undefined } | { ok: false } {
  if (facts === undefined) return { ok: true, value: undefined };
  if (!isRecord(facts)) return { ok: false };
  const out: Record<string, unknown> = {};
  for (const key of BOOLEAN_FACTS) {
    if (facts[key] === undefined) continue;
    if (typeof facts[key] !== "boolean") return { ok: false };
    out[key] = facts[key];
  }
  for (const key of ID_LIST_FACTS) {
    if (facts[key] === undefined) continue;
    if (!isIdList(facts[key])) return { ok: false };
    out[key] = facts[key];
  }
  if (facts["blockCause"] !== undefined) {
    if (!(AUTO_FIX_BLOCK_CAUSES as readonly unknown[]).includes(facts["blockCause"])) return { ok: false };
    out["blockCause"] = facts["blockCause"];
  }
  const original = facts["checkOriginal"];
  if (original !== undefined) {
    if (!isRecord(original) || !Object.entries(original).every(([id, result]) => isSafeString(id) && ORIGINAL_RESULTS.includes(result))) return { ok: false };
    out["checkOriginal"] = original;
  }
  const groups = facts["e2eUnknownGroups"];
  if (groups !== undefined) {
    if (!isRecord(groups) || !Object.values(groups).every((result) => GROUP_RESULTS.includes(result))) return { ok: false };
    out["e2eUnknownGroups"] = Object.fromEntries(Object.entries(groups).map(([group, result]) => [nameHash(salt, group), result]));
  }
  return { ok: true, value: Object.keys(out).length === 0 ? undefined : out };
}

// ---- the export

const createdOf = (item: Item): string => (typeof item["createdAt"] === "string" ? item["createdAt"] : "");
const isRecord = (value: unknown): value is Item => value !== null && typeof value === "object" && !Array.isArray(value);

export async function exportReplayTasks(input: ExportInput, options: ExportOptions): Promise<ExportResult> {
  const items = input.items.filter(isRecord);
  const table = tableOver(items);
  const store = { documentClient: table, tableName: "exported", now: () => options.now };
  const hash = (value: string) => nameHash(options.salt, value);
  const tasks = items.filter((item) => item["entityType"] === "DEVELOPER_TASK" && typeof item["taskId"] === "string")
    .sort((a, b) => createdOf(b).localeCompare(createdOf(a)) || String(a["taskId"]).localeCompare(String(b["taskId"])));
  const snapshots: ReplaySnapshot[] = [], skipped: ExportResult["skipped"] = [];
  const skip = (taskId: string, reason: SkipReason) => { skipped.push({ taskId, reason }); };
  for (const record of tasks.slice(0, options.limit ?? tasks.length)) {
    const taskId = record["taskId"] as string;
    if (record["workflow"] === undefined) { skip(taskId, "no_workflow"); continue; }
    const workflow = WorkflowSnapshotSchema.safeParse(record["workflow"]);
    if (!workflow.success) { skip(taskId, "unreadable_workflow"); continue; }
    if (workflow.data.definitionVersion !== "1.1.0") { skip(taskId, "not_version_1_1"); continue; }
    const digest = workflow.data.candidate?.digest;
    if (digest === undefined) { skip(taskId, "no_candidate"); continue; }
    const orgValue = record["orgId"], project = record["project"];
    if (typeof orgValue !== "string" || typeof project !== "string") { skip(taskId, "no_company_or_project"); continue; }
    const orgId: OrgId = orgValue;
    const rawPack = input.evidencePacks?.[taskId];
    const pack = rawPack === undefined ? undefined : EvidencePackSchema.safeParse(rawPack);
    if (pack !== undefined && !pack.success) { skip(taskId, "unreadable_evidence"); continue; }
    const evidence = pack?.data;
    const fullSuite = await fullSuiteOf({ documentClient: table, tableName: "exported", now: store.now }, record as unknown as DeveloperTaskRecord, evidence, digest);
    if (fullSuite === "failed") { skip(taskId, "full_run_failed"); continue; }
    const reason = scrubBlockReason(workflow.data.blockReason);
    if (!reason.ok) { skip(taskId, "block_reason_unknown"); continue; }

    // What the broker's own rules would have been given as "already failing" for this task, and the raw data they came from (read as data only).
    const options2 = await nightlyOptionsFor(store, { taskId, orgId, project }, undefined);
    const alreadyFailing = await alreadyFailingForResults(store, orgId, project, options2).catch(() => [] as string[]);
    const baseline = await readNightlyBaseline(store, orgId, project).catch(() => undefined);
    const marks = (await readKnownFailingRow(store, orgId, project))?.marks ?? [];
    const projectBranch = await projectBaseBranch(store, orgId, project);
    const branches = (options2.taskBranches ?? []).length > 0 ? [...(options2.taskBranches ?? [])] : projectBranch === undefined ? [] : [projectBranch];

    const scrubbed = scrubWorkflow(workflow.data, options.salt) as Record<string, unknown>;
    if (reason.value === undefined) delete scrubbed["blockReason"]; else scrubbed["blockReason"] = reason.value;
    const factsOut = redactFacts(input.facts?.[taskId], options.salt);
    if (!factsOut.ok) { skip(taskId, "facts_invalid"); continue; }
    const facts = factsOut.value;
    const snapshot = {
      taskId, workflow: scrubbed, ...(facts === undefined ? {} : { facts }), ...(evidence === undefined ? {} : { evidence: redactPack(evidence, options.salt) }),
      alreadyFailing: alreadyFailing.map((entry) => (typeof entry === "string" ? hash(entry) : { name: hash(entry.name), checkId: entry.checkId })),
      planned: { fullSuite },
      known: {
        now: new Date(options.now).toISOString(), branches: branches.map(hash),
        ...(baseline === undefined ? {} : { nightly: { branch: hash(baseline.branch), finishedAt: baseline.finishedAt, failedCount: baseline.tests.failed, failed: baseline.failed.map(hash), flaky: baseline.flaky.map(hash) } }),
        marks: marks.map((mark) => ({ name: hash(mark.name), checkId: mark.checkId })),
      },
    };
    const checked = ReplaySnapshotSchema.safeParse(snapshot);
    if (!checked.success || !WorkflowSnapshotSchema.safeParse(checked.data.workflow).success) { skip(taskId, "unreadable_snapshot"); continue; }
    // The last guard: no free text survives anywhere. The product's own fixed block-reason sentences are words, not content.
    if (unsafeStrings(checked.data, new Set([...KNOWN_BLOCK_REASONS, ...(reason.value === undefined ? [] : [reason.value])])) > 0) { skip(taskId, "content_left"); continue; }
    snapshots.push(checked.data);
  }
  return { snapshots, skipped, ignoredItems: input.items.length - items.length };
}

// ---- the command line

/** Reads the input file: an array of items, or { items, evidencePacks, facts }. */
export function readInputFile(file: string, marshalled: boolean): ExportInput {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const body = Array.isArray(parsed) ? { items: parsed } : isRecord(parsed) ? parsed : { items: [] };
  const raw = Array.isArray(body["items"]) ? (body["items"] as unknown[]) : [];
  return {
    items: marshalled ? raw.map((item) => (isRecord(item) ? unmarshall(item as never) : item)) : raw,
    evidencePacks: isRecord(body["evidencePacks"]) ? body["evidencePacks"] : undefined,
    facts: isRecord(body["facts"]) ? body["facts"] : undefined,
  };
}

/** One file per task, named by the task id (an id, not content). */
export function writeSnapshots(directory: string, snapshots: readonly ReplaySnapshot[]): void {
  mkdirSync(directory, { recursive: true });
  for (const snapshot of snapshots) writeFileSync(path.join(directory, `${snapshot.taskId}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
}

/** The report as text: counts and task ids, never a name, command or path. */
export function exportText(result: ExportResult, directory: string): string {
  const byReason = new Map<SkipReason, string[]>();
  for (const entry of result.skipped) byReason.set(entry.reason, [...(byReason.get(entry.reason) ?? []), entry.taskId]);
  return [
    `Exported ${String(result.snapshots.length)} task${result.snapshots.length === 1 ? "" : "s"} to ${directory}; skipped ${String(result.skipped.length)}${result.ignoredItems > 0 ? `; ${String(result.ignoredItems)} input entries were not items` : ""}.`,
    ...[...byReason.entries()].map(([reason, ids]) => `SKIPPED ${reason}: ${ids.join(", ")}`),
  ].join("\n");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name: string) => { const at = process.argv.indexOf(name); return at === -1 ? undefined : process.argv[at + 1]; };
  const inputFile = arg("--input"), out = arg("--out");
  if (inputFile === undefined || out === undefined) { console.error("Usage: export-replay-tasks.ts --input <items.json> --out <folder> [--now <ISO time>] [--salt <text>] [--limit <n>] [--marshalled]"); process.exit(2); }
  const now = arg("--now") === undefined ? Date.now() : Date.parse(arg("--now")!);
  if (!Number.isFinite(now)) { console.error("--now is not a time"); process.exit(2); }
  const limit = arg("--limit") === undefined ? undefined : Number(arg("--limit"));
  const result = await exportReplayTasks(readInputFile(inputFile, process.argv.includes("--marshalled")), { now, salt: arg("--salt") ?? randomBytes(16).toString("hex"), limit });
  writeSnapshots(out, result.snapshots);
  console.log(exportText(result, out));
  process.exit(result.snapshots.length > 0 ? 0 : 1);
}
