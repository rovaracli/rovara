// Convergence D3 / owner decision 60 item S2: the one-time move of Cloud's string sets to marker rows (workspace-limit `tasks`, session `waitingOutboxIds`),
// and its reverse. Owner gate G-DATA: the controller runs it, with the owner's go, after the release that reads both forms is installed. Never run by a lane.
//
//   Dry run (the default; reads only, prints counts):
//     ~/.local/share/rovara-tools/staging-aws.sh npx tsx scripts/migrate-s2-marker-rows.ts --table <state table> --direction forward
//   Apply (when no task is starting; take a point-in-time restore point of the table first):
//     ~/.local/share/rovara-tools/staging-aws.sh npx tsx scripts/migrate-s2-marker-rows.ts --table <state table> --direction forward --apply yes
//   Reverse (before rolling back to the release before the switch, which reads only the sets):
//     ~/.local/share/rovara-tools/staging-aws.sh npx tsx scripts/migrate-s2-marker-rows.ts --table <state table> --direction reverse [--apply yes]
//
// Options: --region (or AWS_REGION; no default), --profile (not under the release wrapper), --max-ms, --pause-ms, --page-size, --resume-file <path> (default
// s2-migration-resume.<direction>.<apply|dry-run>.json in the working directory). A run stopped by --max-ms writes the scan key it stopped at to that file (mode 600; the key is a
// table key and can name a person, so it is never printed); the next run with the same file goes on from it, and a run that finishes deletes it. Sends only Scan,
// Get and TransactWrite. Idempotent: run it again until a dry run shows nothing left to move. It prints counts and nothing else (no ids, no keys).
// Rollback: docs/runbooks/s2-marker-rows-migration.md. See packages/broker/src/migrations/s2-marker-rows.ts for what moves and how.
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { migrateS2MarkerRows, type S2Result } from "../packages/broker/src/migrations/s2-marker-rows.js";

const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_MAX_MS = 600_000;
const DEFAULT_PAUSE_MS = 200;
const OPTIONS = ["--table", "--profile", "--region", "--direction", "--apply", "--max-ms", "--pause-ms", "--page-size", "--resume-file"];

export interface S2Args {
  table: string;
  profile?: string;
  region: string;
  direction: "forward" | "reverse";
  apply: boolean;
  maxMs: number;
  pauseMs: number;
  pageSize: number;
  /** Where a stopped run keeps the key to go on from, and a later run reads it. */
  resumeFile: string;
}

export function parseS2Args(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): S2Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index] ?? "";
    const value = argv[index + 1];
    if (!OPTIONS.includes(name)) throw new Error(`unknown option ${name}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (values.has(name)) throw new Error(`${name} was given twice`);
    values.set(name, value);
  }
  const table = values.get("--table");
  if (table === undefined || !/^[A-Za-z0-9_.-]{3,255}$/.test(table)) throw new Error("--table is required and must be a DynamoDB table name (there is no default)");
  const region = values.get("--region") ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  if (region === undefined || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new Error("--region (or AWS_REGION) is required, for example us-west-2 for staging; there is no default");
  const direction = values.get("--direction");
  if (direction !== "forward" && direction !== "reverse") throw new Error("--direction is required: forward (sets to markers) or reverse (markers back to sets)");
  const apply = values.get("--apply");
  if (apply !== undefined && apply !== "yes") throw new Error("--apply takes only the word yes; leave it out for a dry run");
  const whole = (name: string, fallback: number, max: number): number => {
    const text = values.get(name);
    if (text === undefined) return fallback;
    if (!/^\d{1,9}$/.test(text) || Number(text) > max) throw new Error(`${name} must be a whole number up to ${max}`);
    return Number(text);
  };
  // A dry run and an applying run never share a place to go on from: an apply that resumed where a dry run stopped would skip what the dry run only read.
  const resumeFile = values.get("--resume-file") ?? `s2-migration-resume.${direction}.${apply === "yes" ? "apply" : "dry-run"}.json`;
  const profile = values.get("--profile");
  return {
    table, region, direction, apply: apply === "yes",
    ...(profile === undefined ? {} : { profile }),
    maxMs: whole("--max-ms", DEFAULT_MAX_MS, 3_600_000), pauseMs: whole("--pause-ms", DEFAULT_PAUSE_MS, 60_000), pageSize: whole("--page-size", DEFAULT_PAGE_SIZE, 1_000),
    resumeFile,
  };
}

/** The key a stopped run left in the resume file, or undefined when there is none (a fresh run). */
export function readResumeKey(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("the resume file does not hold a scan key; delete it to start from the beginning");
  return parsed as Record<string, unknown>;
}

/** Keeps the key a stopped run goes on from: written only for the owner to read (mode 600), never printed. A finished run deletes the file. */
export function keepResumeKey(path: string, key: Record<string, unknown> | undefined): void {
  if (key === undefined) { rmSync(path, { force: true }); return; }
  writeFileSync(path, JSON.stringify(key), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Runs the migration from where the resume file says (or the start), keeps or clears the resume file, and answers the result without its key. */
export async function runS2Migration(args: S2Args, client: { send(command: unknown): Promise<unknown> }, now: () => number = Date.now): Promise<Omit<S2Result, "resume">> {
  const start = readResumeKey(args.resumeFile);
  const { resume, ...result } = await migrateS2MarkerRows({ documentClient: client, tableName: args.table, now }, {
    direction: args.direction, apply: args.apply, pageSize: args.pageSize, maxMs: args.maxMs, pauseMs: args.pauseMs, ...(start === undefined ? {} : { start }),
  });
  keepResumeKey(args.resumeFile, result.finished ? undefined : resume);
  return result;
}

async function main(): Promise<void> {
  const args = parseS2Args(process.argv.slice(2));
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: args.region, ...(args.profile === undefined ? {} : { profile: args.profile }), maxAttempts: 3 }));
  const result = await runS2Migration(args, client);
  console.log(JSON.stringify(result));
  if (!args.apply) console.error("dry run: nothing was written; add --apply yes to write");
  if (!result.finished) console.error(`stopped by --max-ms; the place to go on from is in ${args.resumeFile} (mode 600): run the same command again`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "failed"); process.exitCode = 1; });
}
