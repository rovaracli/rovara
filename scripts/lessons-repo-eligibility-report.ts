// Lessons in the repo, lane R1: the measurement that gates the file pass (decision 50a.1, "measure first"). A READ-ONLY count, per project and repository, of active lessons that are eligible for that repository's
// `.rovara/lessons.md` and that are not, the top reasons for "not" (fixed codes only), and what share of recent reflections had every input readable by the readers of one repository.
//
//   npx tsx scripts/lessons-repo-eligibility-report.ts (--env <name> | --table <team record table>) --region <region> [--since-days <n>] [--pause-ms <ms>] [--json]
//
// On staging, through the guard (it sets the profile and region and refuses any other account):
//   ~/.local/share/rovara-tools/staging-aws.sh npx tsx scripts/lessons-repo-eligibility-report.ts --env <staging env name> --region us-west-2 --json
// The lessons live in the TEAM RECORD table (`agentx-<env>-team-record`), not the State table. The credentials come from the environment (the guard exports them); there is no --profile and no default region.
//
// It sends Scan and nothing else (`readOnlyClient` refuses every other command, so a write cannot be sent even by mistake), paces itself (400 items a page, a pause between pages, an abort after 5 throttled pages in a row) and calls
// no model. It reads eventually consistent and asks only for the fields the report needs (a projection: the lesson's status, approvals and counters, its three text fields for the @handle and e-mail check, and five provenance fields; no citations, no people, no other provenance); the report keeps no text: counts and fixed reason codes only (see `packages/broker/src/lessons/repo-eligibility-report.ts`), nothing is logged but page counts on stderr.
import { pathToFileURL } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { teamRecordTableName } from "../packages/contracts/src/derived-names.js";
import { repoEligibilityReport, type RepoEligibilityReport, type ReportInput } from "../packages/broker/src/lessons/repo-eligibility-report.js";
import { z } from "zod";
import { LessonProvenanceSchema, LessonSchema } from "../packages/broker/src/lessons/types.js";

const DEFAULT_PAUSE_MS = 200;
const DEFAULT_SINCE_DAYS = 14;
const PAGE_LIMIT = 400;
const MAX_CONSECUTIVE_THROTTLES = 5;
const SDK_MAX_ATTEMPTS = 3;
const DAY = 86_400_000;
const THROTTLE_ERRORS = new Set(["ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded", "ThrottledException"]);

/** The only fields of a lesson head the report needs, and so the only ones the scan asks for (a projection: no citations, no other provenance, no people). */
const ReportItemSchema = z.object({
  workspaceId: LessonSchema.shape.workspaceId, project: LessonSchema.shape.project, status: LessonSchema.shape.status, tier: LessonSchema.shape.tier, trial: LessonSchema.shape.trial, approvals: LessonSchema.shape.approvals,
  reviewRequired: LessonSchema.shape.reviewRequired, retireProposedAt: LessonSchema.shape.retireProposedAt, counters: LessonSchema.shape.counters, citationChecks: LessonSchema.shape.citationChecks, createdAt: LessonSchema.shape.createdAt,
  title: LessonSchema.shape.title, description: LessonSchema.shape.description, body: LessonSchema.shape.body,
  provenance: LessonProvenanceSchema.pick({ audience: true, repoOnly: true, repoBlockCodes: true, sourceScopes: true, reflectorRun: true }),
}).strict();
const PROJECTED_PATHS: readonly (readonly string[])[] = [...Object.keys(ReportItemSchema.shape).filter((name) => name !== "provenance").map((name) => [name]), ...["audience", "repoOnly", "repoBlockCodes", "sourceScopes", "reflectorRun"].map((name) => ["provenance", name])];
/** The scan's projection with every attribute name aliased (some, like `status`, are DynamoDB reserved words). */
function projection(): { ProjectionExpression: string; names: Record<string, string> } {
  const names: Record<string, string> = { "#t": "entityType" };
  const alias = (name: string): string => { const known = Object.entries(names).find(([, value]) => value === name); if (known !== undefined) return known[0]; const key = `#n${Object.keys(names).length}`; names[key] = name; return key; };
  const expression = PROJECTED_PATHS.map((path) => path.map(alias).join(".")).join(", ");
  return { ProjectionExpression: expression, names };
}

/** The only client this script sends through. */
export interface ReportClient { send(command: ScanCommand): Promise<unknown> }

/** Wraps a client so that anything but a Scan is refused before it leaves the process. */
export function readOnlyClient(inner: ReportClient): ReportClient {
  return {
    send(command) {
      if (command instanceof ScanCommand) return inner.send(command);
      const name = (command as { constructor?: { name?: string } } | undefined)?.constructor?.name ?? typeof command;
      return Promise.reject(new Error(`lessons-repo-eligibility-report is read-only; refusing to send ${name}`));
    },
  };
}

export interface ReportArgs { table: string; region: string; json: boolean; pauseMs: number; sinceDays: number }

export function parseArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = {}): ReportArgs {
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--json") {
      if (json) throw new Error("--json was given twice");
      json = true;
    } else if (["--env", "--table", "--region", "--pause-ms", "--since-days"].includes(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (values.has(argument)) throw new Error(`${argument} was given twice`);
      values.set(argument, value);
      index += 1;
    } else throw new Error(`unknown option ${argument}`);
  }
  if (values.has("--env") === values.has("--table")) throw new Error("give exactly one of --env or --table (there is no default environment)");
  const envName = values.get("--env");
  if (envName !== undefined && !/^[a-z][a-z0-9-]{0,40}$/.test(envName)) throw new Error(`--env ${JSON.stringify(envName)} is not an environment name`);
  const table = values.get("--table") ?? teamRecordTableName(envName!);
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table)) throw new Error(`${JSON.stringify(table)} is not a DynamoDB table name`);
  // No default region: this Mac's default is us-east-1, which staging commands must never touch. The guard exports AWS_REGION.
  const region = values.get("--region") ?? env.AWS_REGION;
  if (region === undefined || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new Error("--region is required (or AWS_REGION, which staging-aws.sh sets)");
  const pause = values.get("--pause-ms");
  if (pause !== undefined && !/^\d{1,6}$/.test(pause)) throw new Error("--pause-ms must be a non-negative whole number of milliseconds");
  const since = values.get("--since-days");
  if (since !== undefined && !/^\d{1,3}$/.test(since)) throw new Error("--since-days must be a whole number of days");
  return { table, region, json, pauseMs: pause === undefined ? DEFAULT_PAUSE_MS : Number(pause), sinceDays: since === undefined ? DEFAULT_SINCE_DAYS : Number(since) };
}

type Item = Record<string, unknown>;
export interface CollectOptions { pauseMs?: number; sleep?: (ms: number) => Promise<void>; progress?: (pages: number, items: number) => void }
const defaultSleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
const isThrottle = (error: unknown): boolean => error instanceof Error && THROTTLE_ERRORS.has(error.name);

/** Every lesson head in the table, paged, with the number of items that did not parse (counted, never shown). */
export async function readLessonHeads(rawClient: ReportClient, tableName: string, options: CollectOptions = {}): Promise<{ rows: ReportInput[]; unreadable: number }> {
  const client = readOnlyClient(rawClient);
  const sleep = options.sleep ?? defaultSleep;
  const pauseMs = options.pauseMs ?? 0;
  const rows: ReportInput[] = [];
  const shape = projection();
  let unreadable = 0;
  let startKey: Record<string, unknown> | undefined;
  let pages = 0;
  let items = 0;
  let throttled = 0;
  for (;;) {
    let page: { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    try {
      // Eventually consistent on purpose: a count does not need the doubled cost of a consistent read.
      page = await client.send(new ScanCommand({
        TableName: tableName, Limit: PAGE_LIMIT, ProjectionExpression: shape.ProjectionExpression,
        FilterExpression: "#t = :lesson", ExpressionAttributeNames: shape.names, ExpressionAttributeValues: { ":lesson": "LESSON" },
        ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
      })) as typeof page;
    } catch (error) {
      if (!isThrottle(error)) throw error;
      throttled += 1;
      if (throttled >= MAX_CONSECUTIVE_THROTTLES) throw new Error(`DynamoDB throttled ${MAX_CONSECUTIVE_THROTTLES} times in a row at page ${pages + 1}; aborting so the scan does not compete with the live broker. Nothing was written. Re-run later or with a larger --pause-ms.`, { cause: error });
      await sleep(Math.max(pauseMs, 500) * throttled);
      continue;
    }
    throttled = 0;
    pages += 1;
    for (const item of page.Items ?? []) {
      items += 1;
      const parsed = ReportItemSchema.safeParse(item);
      if (parsed.success) rows.push({ workspaceId: parsed.data.workspaceId, project: parsed.data.project, lesson: parsed.data });
      else unreadable += 1;
    }
    options.progress?.(pages, items);
    const next = page.LastEvaluatedKey;
    if (next === undefined) return { rows, unreadable };
    if (startKey !== undefined && JSON.stringify(next) === JSON.stringify(startKey)) throw new Error("a scan did not advance: it returned the key it was given");
    startKey = next;
    if (pauseMs > 0) await sleep(pauseMs);
  }
}

const pct = (part: number, whole: number): string => (whole === 0 ? "n/a" : `${((100 * part) / whole).toFixed(1)}%`);

export function formatReport(report: RepoEligibilityReport, unreadable: number, label: string): string {
  const lines = [
    `Lessons eligible for a repository's file (${label})`,
    `  lessons read ${report.lessonsRead}, active ${report.active}, eligible for a repository ${report.eligibleForAny} (${pct(report.eligibleForAny, report.active)})`,
    `  reflections in the last ${Math.round((Date.now() - report.sinceMs) / DAY)} days that made a lesson: ${report.recentReflections}, with every input repository-visible: ${report.recentRepoVisible} (${pct(report.recentRepoVisible, report.recentReflections)})`,
    ...(unreadable > 0 ? [`  ${unreadable} lesson item(s) did not parse and are not counted`] : []),
    `  top reasons: ${report.topReasons.map((r) => `${r.reason} ${r.count}`).join(", ") || "none"}`,
  ];
  for (const project of report.projects) {
    lines.push("", `${project.workspace} / ${project.project}: active ${project.active}, eligible ${project.eligibleForAny} (${pct(project.eligibleForAny, project.active)}), reflections ${project.recentReflections}, repository-visible ${project.recentRepoVisible}`);
    for (const repo of project.repos) lines.push(`  ${repo.repo}: active ${repo.active}, eligible ${repo.eligible} (${pct(repo.eligible, repo.active)}); ${repo.topReasons.map((r) => `${r.reason} ${r.count}`).join(", ") || "no reasons"}`);
  }
  lines.push("", ...report.notes.map((note) => `note: ${note}`));
  return lines.join("\n");
}

/** What `main` reaches the outside world through; the tests pass fakes. */
export interface MainDependencies {
  createDocumentClient(config: { region: string; maxAttempts: number }): ReportClient;
  now(): number;
  out(text: string): void;
  err(text: string): void;
  sleep(ms: number): Promise<void>;
  env: Readonly<Record<string, string | undefined>>;
}
const realDependencies: MainDependencies = {
  createDocumentClient: (config) => { const client = DynamoDBDocumentClient.from(new DynamoDBClient(config)); return { send: (command) => client.send(command) }; },
  now: Date.now, out: (text) => console.log(text), err: (text) => console.error(text), sleep: defaultSleep, env: process.env,
};

export async function main(argv: readonly string[], dependencies: MainDependencies = realDependencies): Promise<RepoEligibilityReport> {
  const args = parseArgs(argv, dependencies.env);
  const client = dependencies.createDocumentClient({ region: args.region, maxAttempts: SDK_MAX_ATTEMPTS });
  const { rows, unreadable } = await readLessonHeads(client, args.table, { pauseMs: args.pauseMs, sleep: (ms) => dependencies.sleep(ms), progress: (pages, items) => dependencies.err(`scan page ${pages}: ${items} lesson items so far`) });
  const report = repoEligibilityReport(rows, { sinceMs: dependencies.now() - args.sinceDays * DAY });
  dependencies.out(args.json ? JSON.stringify({ region: args.region, unreadable, ...report }, null, 2) : formatReport(report, unreadable, `${args.table}, ${args.region}`));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
