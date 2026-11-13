// 0.5.18 (Slack merged identity) backfill: hands every OPEN task still held by a merged-away sign-in on to the merge's survivor, with the merge mover's own step. 0.5.18x: also every OPEN task
// still held by a Slack id whose Slack account is LINKED (active, verified link, read at run time) to a web account, made while that link stood, each hand-on fenced on the link. See
// packages/broker/src/developer/merged-owner-backfill.ts for what it reads and writes, and why a task's developerId and ownerKey are left as they are.
//
// DEFAULT IS A DRY RUN: it reads only, and prints counts and the ids of the tasks it WOULD hand on. --apply writes. Idempotent: a second --apply changes nothing.
// Never run against staging or production without the owner's go. Under the release wrapper (it sets the account, region and credentials):
//   ~/.local/share/rovara-tools/staging-aws.sh npx tsx scripts/backfill-merged-task-owners.ts --state-table <state table> --signin-table <sign-in table> [--apply]
//
// EXIT CODES: 0 finished; 1 a read or write failed (the error name is printed, never a value); 2 bad option.
import { pathToFileURL } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { backfillMergedTaskOwners } from "../packages/broker/src/developer/merged-owner-backfill.js";

export interface MergedOwnerBackfillArgs { stateTable: string; signInTable: string; region: string; apply: boolean }

const TABLE = /^[A-Za-z0-9_.-]{3,255}$/;

export function parseMergedOwnerBackfillArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): MergedOwnerBackfillArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index] ?? "";
    if (name === "--apply" || name === "--dry-run") {
      if (flags.has(name)) throw new Error(`${name} was given twice`);
      flags.add(name);
      continue;
    }
    if (!["--state-table", "--signin-table", "--region"].includes(name)) throw new Error(`unknown option ${name}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (values.has(name)) throw new Error(`${name} was given twice`);
    values.set(name, value);
    index += 1;
  }
  if (flags.has("--apply") && flags.has("--dry-run")) throw new Error("give --apply or --dry-run, not both (the default is a dry run)");
  const stateTable = values.get("--state-table") ?? env.STATE_TABLE_NAME;
  const signInTable = values.get("--signin-table") ?? env.DEVELOPER_SIGNIN_TABLE_NAME;
  if (stateTable === undefined || !TABLE.test(stateTable)) throw new Error("--state-table (or STATE_TABLE_NAME) is required");
  if (signInTable === undefined || !TABLE.test(signInTable)) throw new Error("--signin-table (or DEVELOPER_SIGNIN_TABLE_NAME) is required");
  const region = values.get("--region") ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  if (region === undefined || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new Error("--region (or AWS_REGION) is required; there is no default");
  return { stateTable, signInTable, region, apply: flags.has("--apply") };
}

async function main(): Promise<number> {
  let args: MergedOwnerBackfillArgs;
  try {
    args = parseMergedOwnerBackfillArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: args.region }));
  try {
    const summary = await backfillMergedTaskOwners({ documentClient, stateTable: args.stateTable, signInTable: args.signInTable, now: Date.now }, { apply: args.apply });
    console.log(JSON.stringify({ mode: args.apply ? "apply" : "dry-run", ...summary }, null, 2));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ failed: error instanceof Error ? error.name : "unknown" }));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main();
