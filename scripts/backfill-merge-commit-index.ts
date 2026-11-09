// SRL-3 release step (optional, idempotent, resumable): indexes the merge commits of Rovara pull requests merged before the index existed, so a revert of one of them is recorded.
//
//   npx tsx scripts/backfill-merge-commit-index.ts --table <state table> [--region <region>] [--profile <aws profile>] [--max-ms <ms>] [--pause-ms <ms>]
//
// Under the release wrapper (it sets the account, region and credentials itself and refuses --profile) leave --profile out; the region then comes from --region or AWS_REGION:
//   ~/.local/share/rovara-tools/staging-aws.sh npx tsx scripts/backfill-merge-commit-index.ts --table <state table>
//
// It reads the track record's outcome samples that already hold a merge commit GitHub gave, checks each against the task, and puts the missing `GITHUB_MERGE#` row with
// `attribute_not_exists` (see `rovara-code/merge-commit-index.ts#backfillMergeCommitIndex`). It sends only Scan, Get and Put to the table, prints counts and nothing else, and can be run
// again: rows that exist are counted, not rewritten. A run stopped by --max-ms prints the key to resume from (--resume '<json>'). Merges whose samples expired or were never scored stay unmatched.
import { pathToFileURL } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { backfillMergeCommitIndex, type BackfillResult } from "../packages/broker/src/rovara-code/merge-commit-index.js";

const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_MAX_MS = 600_000;
const DEFAULT_PAUSE_MS = 200;

export interface BackfillArgs { table: string; profile?: string; region: string; maxMs: number; pauseMs: number; resume?: Record<string, unknown> }

export function parseBackfillArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): BackfillArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index] ?? "";
    const value = argv[index + 1];
    if (!["--table", "--profile", "--region", "--max-ms", "--pause-ms", "--resume"].includes(name)) throw new Error(`unknown option ${name}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (values.has(name)) throw new Error(`${name} was given twice`);
    values.set(name, value);
  }
  const table = values.get("--table");
  if (table === undefined || !/^[A-Za-z0-9_.-]{3,255}$/.test(table)) throw new Error("--table is required and must be a DynamoDB table name (there is no default)");
  // --profile is optional: the release wrapper sets AWS_PROFILE and the credentials itself, and the SDK reads them.
  const profile = values.get("--profile");
  const region = values.get("--region") ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  if (region === undefined || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new Error("--region (or AWS_REGION) is required, for example us-west-2 for staging; there is no default");
  const whole = (name: string, fallback: number): number => {
    const text = values.get(name);
    if (text === undefined) return fallback;
    if (!/^\d{1,9}$/.test(text)) throw new Error(`${name} must be a whole number of milliseconds`);
    return Number(text);
  };
  const resumeText = values.get("--resume");
  const resume = resumeText === undefined ? undefined : (JSON.parse(resumeText) as Record<string, unknown>);
  return { table, region, ...(profile === undefined ? {} : { profile }), maxMs: whole("--max-ms", DEFAULT_MAX_MS), pauseMs: whole("--pause-ms", DEFAULT_PAUSE_MS), ...(resume === undefined ? {} : { resume }) };
}

/** Runs pages until the end or the time given, pausing between pages. */
export async function runBackfill(args: BackfillArgs, client: { send(command: unknown): Promise<unknown> }, now: () => number = Date.now): Promise<BackfillResult> {
  return backfillMergeCommitIndex({ documentClient: client, tableName: args.table, now }, { pageSize: DEFAULT_PAGE_SIZE, maxMs: args.maxMs, pauseMs: args.pauseMs, ...(args.resume === undefined ? {} : { start: args.resume }) });
}

async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2));
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: args.region, ...(args.profile === undefined ? {} : { profile: args.profile }), maxAttempts: 3 }));
  const result = await runBackfill(args, client);
  console.log(JSON.stringify(result.finished ? { ...result, resume: undefined } : result));
  if (!result.finished) console.error("stopped by --max-ms; run again with --resume '<the resume key above>'");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "failed"); process.exitCode = 1; });
}
