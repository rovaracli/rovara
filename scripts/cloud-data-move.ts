// Convergence data moves (decision 129: staging runs pre-approved; production and customer runs need the owner). One command for every move in
// packages/broker/src/cloud/migrations (the framework: dry run, apply, resume file, reverse, conflict report).
//
//   npx tsx scripts/cloud-data-move.ts --list
//   ~/.local/share/rovara-tools/staging-aws.sh npx tsx scripts/cloud-data-move.ts --move <id> --table <state table> --company <org id>
//       [--direction reverse] [--apply yes] [--resume <file>] [--max-pages <n>]
//
// A dry run is the default and writes nothing. `--apply yes` writes (one conditional transaction per item); give `--resume <file>` so a stopped run carries
// on. Re-run the dry run until it reports 0 writes and 0 conflicts. Prints the report as JSON (keys and counts, never item contents).
// TABLE-WIDE moves: `s2-limits-session-markers` scans every row of the table and ignores --company (the option is required by every move; an install has one company, R3).
// Region and credentials come from the environment (the staging wrapper sets them); there is no default table and no default company.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { DynamoDBClient, ScanCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { createDynamoStoreFromSettings } from "@rovara-code/aws-adapters/dynamodb";
import { OrgIdSchema, WORKFLOW_DISPATCH_DUE_INDEX, type StoredDocument } from "@rovara-code/contracts";
import { TASK_FLOW_INDEXES } from "@rovara-code/broker/core/task-flow";
import { cloudDataMoves, runDataMove, type MoveContext, type MovePage, type ResumeState, type ResumeStore } from "../packages/broker/src/cloud/migrations/index.js";

export interface MoveArgs { list: boolean; move?: string; table?: string; company?: string; direction: "forward" | "reverse"; apply: boolean; resume?: string; maxPages?: number }

export function parseMoveArgs(argv: readonly string[]): MoveArgs {
  if (argv.length === 1 && argv[0] === "--list") return { list: true, direction: "forward", apply: false };
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index] ?? "";
    const value = argv[index + 1];
    if (!["--move", "--table", "--company", "--direction", "--apply", "--resume", "--max-pages"].includes(name)) throw new Error(`unknown option ${name}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (values.has(name)) throw new Error(`${name} was given twice`);
    values.set(name, value);
  }
  const move = values.get("--move");
  const table = values.get("--table");
  const company = values.get("--company");
  if (move === undefined) throw new Error("--move is required (--list names them)");
  if (table === undefined || !/^[A-Za-z0-9_.-]{3,255}$/.test(table)) throw new Error("--table is required (there is no default)");
  if (company === undefined || !OrgIdSchema.safeParse(company).success) throw new Error("--company is required and must be an org id");
  const direction = values.get("--direction") ?? "forward";
  if (direction !== "forward" && direction !== "reverse") throw new Error("--direction is forward or reverse");
  const apply = values.get("--apply");
  if (apply !== undefined && apply !== "yes") throw new Error("--apply takes exactly yes");
  const pages = values.get("--max-pages");
  if (pages !== undefined && !/^\d{1,6}$/.test(pages)) throw new Error("--max-pages is a whole number");
  const resume = values.get("--resume");
  return { list: false, move, table, company, direction, apply: apply === "yes", ...(resume === undefined ? {} : { resume }), ...(pages === undefined ? {} : { maxPages: Number(pages) }) };
}

export function fileResume(path: string): ResumeStore {
  return {
    async read() {
      try { return JSON.parse(await readFile(path, "utf8")) as ResumeState; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    },
    async write(state) { await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); },
  };
}

/** A DynamoDB Scan page with a filter, as a move source (cursor: the last evaluated key, base64url JSON). */
function scanSource(client: DynamoDBClient, table: string, filter: { expression: string; names: Record<string, string>; values?: Record<string, AttributeValue> }) {
  return async (_context: MoveContext, cursor: string | undefined): Promise<MovePage> => {
    const answer = await client.send(new ScanCommand({
      TableName: table, Limit: 200, FilterExpression: filter.expression, ExpressionAttributeNames: filter.names, ...(filter.values === undefined ? {} : { ExpressionAttributeValues: filter.values }),
      ...(cursor === undefined ? {} : { ExclusiveStartKey: JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, AttributeValue> }),
    }));
    const next = answer.LastEvaluatedKey === undefined ? undefined : Buffer.from(JSON.stringify(answer.LastEvaluatedKey), "utf8").toString("base64url");
    return { items: (answer.Items ?? []).map((item) => unmarshall(item) as StoredDocument), ...(next === undefined ? {} : { cursor: next }) };
  };
}

/** Every row that holds a `tasks` or `waitingOutboxIds` string set, and (reverse) every S2 marker row (`s2-limits-session-markers`). Read with unmarshall, so a set arrives as a Set. */
const S2_SET_FILTER = { expression: "attribute_exists(#tasks) OR attribute_exists(#waiting)", names: { "#tasks": "tasks", "#waiting": "waitingOutboxIds" } };
const S2_MARKER_FILTER = { expression: "#type = :limit OR #type = :waiting", names: { "#type": "entityType" }, values: { ":limit": { S: "DEVELOPER_LIMIT_TASK" }, ":waiting": { S: "SESSION_WAITING" } } };

async function main(argv: readonly string[]): Promise<number> {
  const args = parseMoveArgs(argv);
  const client = new DynamoDBClient({});
  const table = args.table ?? "unused";
  const moves = cloudDataMoves({
    companies: () => (args.company === undefined ? [] : [args.company]),
    scanPrefix: (prefix) => scanSource(client, table, { expression: "begins_with(#pk, :prefix)", names: { "#pk": "pk" }, values: { ":prefix": { S: prefix } } }),
    scanBindings: scanSource(client, table, { expression: "begins_with(#pk, :prefix) AND contains(#pk, :binding) AND begins_with(#sk, :channel)", names: { "#pk": "pk", "#sk": "sk" }, values: { ":prefix": { S: "ORG#" }, ":binding": { S: "#SLACK_BINDING#" }, ":channel": { S: "CHANNEL#" } } }),
    s2: { client: DynamoDBDocumentClient.from(client), tableName: table, scanSets: scanSource(client, table, S2_SET_FILTER), scanMarkers: scanSource(client, table, S2_MARKER_FILTER) },
    scanHolding: (attribute) => scanSource(client, table, { expression: "attribute_exists(#a)", names: { "#a": attribute } }),
  });
  if (args.list) {
    for (const move of moves) console.log(JSON.stringify({ id: move.id, status: move.status, title: move.title, ...(move.heldBecause === undefined ? {} : { heldBecause: move.heldBecause }), directions: Object.keys(move.source) }));
    return 0;
  }
  const move = moves.find((entry) => entry.id === args.move);
  if (move === undefined) throw new Error(`no move named ${String(args.move)} (--list names them)`);
  const indexes = [...TASK_FLOW_INDEXES.filter((index) => index.name !== WORKFLOW_DISPATCH_DUE_INDEX.name), { name: WORKFLOW_DISPATCH_DUE_INDEX.name, partitionAttribute: WORKFLOW_DISPATCH_DUE_INDEX.partitionKey, sortAttribute: WORKFLOW_DISPATCH_DUE_INDEX.sortKey }];
  const store = createDynamoStoreFromSettings({ tableName: table, ttlAttribute: "indexExpiresAt", indexes: JSON.parse(JSON.stringify(indexes)) as never }, client);
  const report = await runDataMove(move, { store, now: () => new Date(), log: () => undefined }, { direction: args.direction, apply: args.apply, ...(args.resume === undefined ? {} : { resume: fileResume(args.resume) }), ...(args.maxPages === undefined ? {} : { maxPages: args.maxPages }) });
  console.log(JSON.stringify(report, null, 2));
  return report.conflicts === 0 ? 0 : 3;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => { console.error(error instanceof Error ? error.message : "failed"); process.exitCode = 1; });
}
