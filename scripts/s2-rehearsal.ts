// S2 data move, reverse rehearsal on a LOCAL copy (never AWS). Seeds a table shaped like staging on a local DynamoDB-compatible emulator, then runs the same
// commands the controller runs on staging (scripts/cloud-data-move.ts, move `s2-limits-session-markers`): dry run, apply, verify, reverse, verify, apply again.
//
//   DOCKER_HOST=unix:///nonexistent ROVARA_AWS_DEV_OPEN_CONTROL=1 QUARKUS_HTTP_PORT=4577 ~/web/rovara-local-aws/dist/native/rovara-local-aws &
//   npx tsx scripts/s2-rehearsal.ts --endpoint http://127.0.0.1:4577
//
// Refuses any endpoint that is not loopback, and never reads AWS credentials (it passes dummy ones). Prints one JSON summary and exits non-zero when any check fails.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const COMPANY = "org_s2rehearsal00000000a";
const TEAMS = ["T0REHEAR001", "T0REHEAR002", "T0REHEAR003"];
type Row = Record<string, unknown>;

export function parseEndpoint(argv: readonly string[]): string {
  const index = argv.indexOf("--endpoint");
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined) throw new Error("--endpoint <loopback url> is required");
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error(`refusing a non-loopback endpoint: ${url.hostname}`);
  return value;
}

/** Rows shaped like a staging State table: developers' and Slack members' counters (with and without tasks), organization counters (never a set), sessions that park deliveries, core markers, and unrelated rows (some with a list called `tasks`). */
export function fixtureRows(): Row[] {
  const rows: Row[] = [];
  const count = (n: number) => n + 1;
  for (let d = 0; d < 60; d += 1) {
    const dev = `${String(d).padStart(2, "0")}${"d".repeat(62)}`;
    const tasks = Array.from({ length: d % 4 }, (_, i) => `task-${d}-${i}`);
    rows.push({ pk: `DEVELOPER_LIMIT#${dev}`, sk: "MEMBER", entityType: "DEVELOPER_LIMIT", count: count(tasks.length), ...(tasks.length === 0 ? {} : { tasks: new Set(tasks) }) });
    // The core's own markers on the same family (a core task: marker, no set).
    if (d % 7 === 0) rows.push({ pk: `DEVELOPER_LIMIT#${dev}`, sk: `TASK#core-${d}`, entityType: "DEVELOPER_LIMIT_TASK", taskId: `core-${d}`, chargedAt: "2026-11-13T00:00:00.000Z" });
  }
  rows.push({ pk: `ORG#${COMPANY}#DEVELOPER_LIMIT#ORGANIZATION`, sk: "ORGANIZATION", entityType: "DEVELOPER_LIMIT", count: 90 });
  for (const team of TEAMS) {
    const pk = `ORG#${COMPANY}#SLACK_LIMIT#${team}`;
    rows.push({ pk, sk: "ORGANIZATION", entityType: "SLACK_LIMIT", count: 20 });
    for (let u = 0; u < 12; u += 1) {
      const tasks = Array.from({ length: u % 3 }, (_, i) => `slack-${team}-${u}-${i}`);
      rows.push({ pk, sk: `MEMBER#U0${String(u).padStart(8, "0")}`, entityType: "SLACK_LIMIT", count: count(tasks.length), threads: [`${team}/C0A5/1.00000${u}`], ...(tasks.length === 0 ? {} : { tasks: new Set(tasks) }) });
    }
  }
  for (let s = 0; s < 20; s += 1) {
    const waiting = Array.from({ length: s % 4 }, (_, i) => `outbox-${s}-${i}`);
    rows.push({ pk: `WORKSPACE#ws-${s}`, sk: "SESSION", entityType: "SESSION", workspaceId: `ws-${s}`, state: "PROVISIONING", generation: 1, ...(waiting.length === 0 ? {} : { waitingOutboxIds: new Set(waiting) }) });
  }
  for (let i = 0; i < 400; i += 1) rows.push({ pk: `DEVTASK#unrelated-${i}`, sk: "META", entityType: "DEVELOPER_TASK", ...(i % 10 === 0 ? { tasks: [`a-list-${i}`] } : {}), ...(i % 25 === 0 ? { labels: new Set(["a", "b"]) } : {}) });
  return rows;
}

const key = (row: Row): string => `${String(row["pk"])}|${String(row["sk"])}`;
const plain = (row: Row): unknown => JSON.parse(JSON.stringify(row, (_name, value: unknown) => (value instanceof Set ? { set: [...value].sort() } : value)));
const WHEN = new Set(["chargedAt", "parkedAt", "migratedFrom"]);

async function snapshot(client: DynamoDBDocumentClient, table: string): Promise<Map<string, Row>> {
  const out = new Map<string, Row>();
  let start: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new ScanCommand({ TableName: table, ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }) }));
    for (const item of page.Items ?? []) out.set(key(item), item);
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return out;
}

/** The counts the controller reads before and after: entries still in sets, markers of each kind. */
function census(rows: Map<string, Row>): { setEntries: number; limitMarkers: number; sessionMarkers: number; rows: number } {
  let setEntries = 0, limitMarkers = 0, sessionMarkers = 0;
  for (const row of rows.values()) {
    const pk = String(row["pk"]), sk = String(row["sk"]);
    const member = (pk.startsWith("DEVELOPER_LIMIT#") && sk === "MEMBER") || (pk.includes("#SLACK_LIMIT#") && sk.startsWith("MEMBER#"));
    if (member && row["tasks"] instanceof Set) setEntries += row["tasks"].size;
    if (pk.startsWith("WORKSPACE#") && sk === "SESSION" && row["waitingOutboxIds"] instanceof Set) setEntries += row["waitingOutboxIds"].size;
    if (row["entityType"] === "DEVELOPER_LIMIT_TASK") limitMarkers += 1;
    if (row["entityType"] === "SESSION_WAITING") sessionMarkers += 1;
  }
  return { setEntries, limitMarkers, sessionMarkers, rows: rows.size };
}

/** Rows compared with the moves' own bookkeeping fields ignored (timestamps and the `migratedFrom` mark differ between two runs by design). */
function same(a: Map<string, Row>, b: Map<string, Row>, ignore: ReadonlySet<string> = WHEN): boolean {
  if (a.size !== b.size) return false;
  for (const [k, row] of a) {
    const other = b.get(k);
    if (other === undefined) return false;
    const strip = (r: Row) => Object.fromEntries(Object.entries(r).filter(([name]) => !ignore.has(name)));
    if (JSON.stringify(plain(strip(row))) !== JSON.stringify(plain(strip(other)))) return false;
  }
  return true;
}

export interface RunSummary { mode: string; direction: string; scanned: number; writes: number; conflicts: number; done: boolean; pages: number }

function move(endpoint: string, table: string, direction: "forward" | "reverse", apply: boolean, extra: string[] = []): RunSummary {
  const args = ["tsx", "scripts/cloud-data-move.ts", "--move", "s2-limit-markers-placeholder", "--table", table, "--company", COMPANY, "--direction", direction, ...(apply ? ["--apply", "yes"] : []), ...extra];
  args[args.indexOf("s2-limit-markers-placeholder")] = "s2-limits-session-markers";
  let text: string;
  try {
    text = execFileSync("npx", args, { encoding: "utf8", env: { ...process.env, AWS_ENDPOINT_URL: endpoint, AWS_REGION: "us-west-2", AWS_ACCESS_KEY_ID: "x".repeat(16), AWS_SECRET_ACCESS_KEY: "y".repeat(24), AWS_EC2_METADATA_DISABLED: "true", AWS_PROFILE: "" }, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    // Exit 3 is "conflicts found": the report is still on stdout.
    const failed = error as { status?: number; stdout?: string };
    if (failed.status !== 3 || failed.stdout === undefined) throw error;
    text = failed.stdout;
  }
  const report = JSON.parse(text) as RunSummary;
  return { mode: report.mode, direction: report.direction, scanned: report.scanned, writes: report.writes, conflicts: report.conflicts, done: report.done, pages: report.pages };
}

async function main(): Promise<number> {
  const endpoint = parseEndpoint(process.argv.slice(2));
  const raw = new DynamoDBClient({ region: "us-west-2", endpoint, credentials: { accessKeyId: "x".repeat(16), secretAccessKey: "y".repeat(24) } });
  const client = DynamoDBDocumentClient.from(raw);
  const table = `s2-rehearsal-${Date.now()}`;
  await raw.send(new CreateTableCommand({ TableName: table, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }] }));
  const checks: Record<string, boolean> = {};
  const summary: Record<string, unknown> = { endpoint, table };
  try {
    for (const row of fixtureRows()) await client.send(new PutCommand({ TableName: table, Item: row }));
    const original = await snapshot(client, table);
    summary["before"] = census(original);

    const dry1 = move(endpoint, table, "forward", false);
    checks["dry run wrote nothing"] = same(original, await snapshot(client, table));
    summary["forwardDryRun"] = dry1;

    const resumeDir = mkdtempSync(join(tmpdir(), "s2-rehearsal-"));
    const resumeFile = join(resumeDir, "resume.json");
    // A run stopped after one page, then resumed (the resume file is the framework's).
    const partial = move(endpoint, table, "forward", true, ["--max-pages", "1", "--resume", resumeFile]);
    const rest = move(endpoint, table, "forward", true, ["--resume", resumeFile]);
    rmSync(resumeDir, { recursive: true, force: true });
    const forward1 = await snapshot(client, table);
    summary["forwardApply"] = { stoppedAfterOnePage: partial, resumed: rest, writes: partial.writes + rest.writes };
    summary["afterForward"] = census(forward1);
    checks["forward moved every entry"] = census(forward1).setEntries === 0 && partial.writes + rest.writes === dry1.writes;
    checks["forward kept every count"] = [...original].every(([k, row]) => row["count"] === undefined || forward1.get(k)?.["count"] === row["count"]);
    const forwardAgain = move(endpoint, table, "forward", false);
    summary["forwardDryRunAfter"] = forwardAgain;
    checks["a dry run after the move finds nothing"] = forwardAgain.writes === 0 && forwardAgain.conflicts === 0;

    const reverseDry = move(endpoint, table, "reverse", false);
    summary["reverseDryRun"] = reverseDry;
    const reverse = move(endpoint, table, "reverse", true);
    const reversed = await snapshot(client, table);
    summary["reverseApply"] = reverse;
    summary["afterReverse"] = census(reversed);
    // The core's own markers have no set to go back to before the move, so a reverse also puts them in their counter's set: compare with those accounted for.
    const coreMarkers = [...original.values()].filter((row) => row["entityType"] === "DEVELOPER_LIMIT_TASK").length;
    checks["reverse left no marker"] = census(reversed).limitMarkers === 0 && census(reversed).sessionMarkers === 0;
    checks["reverse moved every marker back"] = reverse.writes === reverseDry.writes && reverse.writes === dry1.writes + coreMarkers && reverse.conflicts === 0;
    checks["reverse restored every set the move took out"] = [...original].filter(([, row]) => row["entityType"] !== "DEVELOPER_LIMIT_TASK").every(([k, row]) => {
      const back = reversed.get(k);
      if (back === undefined) return false;
      const wantTasks = row["tasks"] instanceof Set ? row["tasks"] : new Set<string>();
      const gotTasks = back["tasks"] instanceof Set ? back["tasks"] : new Set<string>();
      const coreOnly = [...gotTasks].filter((id) => !wantTasks.has(id)).every((id) => String(id).startsWith("core-"));
      return [...wantTasks].every((id) => gotTasks.has(id)) && coreOnly && JSON.stringify(plain({ ...back, tasks: undefined })) === JSON.stringify(plain({ ...row, tasks: undefined }));
    });
    const reverseAgain = move(endpoint, table, "reverse", false);
    summary["reverseDryRunAfter"] = reverseAgain;
    checks["a reverse dry run after the reverse finds nothing"] = reverseAgain.writes === 0 && reverseAgain.conflicts === 0;

    const forward2 = move(endpoint, table, "forward", true);
    const forward2Rows = await snapshot(client, table);
    summary["forwardApplyAgain"] = forward2;
    summary["afterForwardAgain"] = census(forward2Rows);
    checks["the second forward moved the same entries as the first plus the core markers the reverse set back"] = forward2.writes === dry1.writes + coreMarkers && forward2.conflicts === 0;
    // A core marker had no `memberSk` before the move and has one after it (the move names the counter), so that field is the one difference allowed.
    checks["the second forward ends in the first forward's rows"] = same(forward1, forward2Rows, new Set([...WHEN, "memberSk"]));
    checks["reverse restored the original rows exactly (core markers included as sets)"] = checks["reverse left no marker"] === true && checks["reverse restored every set the move took out"] === true;
  } finally {
    await raw.send(new DeleteTableCommand({ TableName: table })).catch(() => undefined);
  }
  summary["checks"] = checks;
  console.log(JSON.stringify(summary, null, 2));
  return Object.values(checks).every(Boolean) ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then((code) => { process.exitCode = code; }, (error: unknown) => { console.error(error instanceof Error ? error.message : "failed"); process.exitCode = 1; });
}
