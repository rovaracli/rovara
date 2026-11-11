// Company rules (G-04, owner decision 85): loads the owner-approved first version of a company's standing instructions. For the operator, once per company, after the install that turns `si` on. NOT an API route and NOT run by CI.
//
//   under the release wrapper (it sets the account, region and credentials and refuses --profile):
//   ~/.local/share/rovara-tools/staging-aws.sh npx tsx scripts/seed-company-rules.ts --state-table <state table> --org <org id> --draft <standing-instructions-draft.md> [--apply]
//
// DEFAULT is a dry run: it reads the draft, checks it (the 30 x 600 / 12,000 limits, empty rules, secret-like text), reads the company's head row and prints the rule counts and the digest. It writes nothing. --apply writes version 1 and
// its audit event in ONE transaction, only if the company has no version and no waiting proposal (`seedCompanyRules`). The audit event is left as a pending item and sent on by the broker's drain, so no queue is needed here.
// EXIT CODES: 0 done (or the dry run is clean); 1 the draft is not valid or a store fault; 2 bad option; 3 the company already has versions (nothing was written).
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { OrgIdSchema } from "@agentx/contracts";
import { readNumberedDraft, readRulesFile } from "../packages/broker/src/company-rules/rules.js";
import { seedCompanyRules } from "../packages/broker/src/company-rules/seed.js";
import { dynamoCompanyRulesStore } from "../packages/broker/src/company-rules/store.js";

export interface SeedArgs { stateTable: string; org: string; draft: string; region?: string; apply: boolean }

const VALUE_OPTIONS = ["--state-table", "--org", "--draft", "--region"];
const FLAG_OPTIONS = ["--apply", "--dry-run"];

export function parseSeedArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): SeedArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index] ?? "";
    if (FLAG_OPTIONS.includes(name)) { if (flags.has(name)) throw new Error(`${name} was given twice`); flags.add(name); continue; }
    if (!VALUE_OPTIONS.includes(name)) throw new Error(`unknown option ${name}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (values.has(name)) throw new Error(`${name} was given twice`);
    values.set(name, value);
    index += 1;
  }
  if (flags.has("--apply") && flags.has("--dry-run")) throw new Error("--apply and --dry-run cannot be used together");
  const stateTable = values.get("--state-table") ?? env.STATE_TABLE_NAME;
  const org = values.get("--org");
  const draft = values.get("--draft");
  if (stateTable === undefined || stateTable === "") throw new Error("--state-table is required");
  if (org === undefined || !OrgIdSchema.safeParse(org).success) throw new Error("--org must be a company id (org_...)");
  if (draft === undefined) throw new Error("--draft is required");
  const region = values.get("--region") ?? env.AWS_REGION;
  return { stateTable, org, draft, ...(region === undefined ? {} : { region }), apply: flags.has("--apply") };
}

/** The draft's rules: the numbered draft the owner approved, or a file in the bullet format the file sync reads. */
export function rulesOfDraft(text: string) {
  const numbered = readNumberedDraft(text);
  if (numbered.length > 0) return numbered;
  const bullets = readRulesFile(text);
  if (!bullets.ok) throw new Error(`the draft is not readable: ${bullets.problem}`);
  return bullets.rules;
}

export async function main(argv: readonly string[], log: (line: string) => void = console.log): Promise<number> {
  let args: SeedArgs;
  try { args = parseSeedArgs(argv); } catch (error) { log(error instanceof Error ? error.message : "bad option"); return 2; }
  try {
    const rules = rulesOfDraft(await readFile(args.draft, "utf8"));
    const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ ...(args.region === undefined ? {} : { region: args.region }) }));
    const audit = { sqs: {} as SQSClient, queueUrl: "unused", documentClient, tableName: args.stateTable, now: Date.now, log: () => undefined, pendingOnly: true as const };
    const store = dynamoCompanyRulesStore({ documentClient, tableName: args.stateTable, audit });
    const result = await seedCompanyRules({ store, now: Date.now }, { orgId: OrgIdSchema.parse(args.org), rules, apply: args.apply });
    if (result.status === "already_has_versions") { log("The company already has company rules (or a proposal is waiting). Nothing was written."); return 3; }
    const required = result.version.rules.filter((rule) => rule.priority === "required").length;
    log(`${result.status === "seeded" ? "Seeded" : "Would seed"} version 1: ${String(result.version.rules.length)} rules (${String(required)} Required, ${String(result.version.rules.length - required)} Preferred), digest ${result.version.digest}.`);
    if (result.status === "would_seed") log("Dry run: nothing was written. Add --apply to write it.");
    return 0;
  } catch (error) {
    log(`Failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
