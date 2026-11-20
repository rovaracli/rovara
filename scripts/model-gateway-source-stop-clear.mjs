// Operator-only, deliberately absent from the serving process and its HTTP routes.
// Build first: npx tsc -b packages/model-gateway
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { credentialsFromEnvironment } from "../packages/model-gateway/dist/aws.js";
import { Dynamo } from "../packages/model-gateway/dist/dynamo.js";
import { DynamoMeter } from "../packages/model-gateway/dist/dynamo-meter.js";
import { runOperatorClear } from "../packages/model-gateway/dist/source-stop-cli.js";
const { values } = parseArgs({ options: Object.fromEntries(["issuer", "company", "source", "reason", "region", "meter-table", "ledger-table"].map(key => [key, { type: "string" }])) });
if (Object.values(values).length !== 7 || Object.values(values).some(value => !value)) throw new Error("Required: --issuer --company --source --reason --region --meter-table --ledger-table");
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Operator clear requires an interactive terminal");
// Explicit local operator credentials only: never fetch or accept the gateway's ECS task role.
if (process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) throw new Error("Export local operator credentials first");
const db = new Dynamo({ region: values.region, credentials: credentialsFromEnvironment(process.env) });
const meter = new DynamoMeter({ db, tables: { meter: values["meter-table"], ledger: values["ledger-table"], markers: "unused-by-clear" } });
const terminal = createInterface({ input: process.stdin, output: process.stdout });
try {
  const cleared = await runOperatorClear({ iss: values.issuer, cid: values.company, source: values.source, reason: values.reason }, {
    meter, interactive: true,
    identity: async () => {
      const result = JSON.parse(execFileSync("aws", ["sts", "get-caller-identity", "--region", values.region, "--output", "json", "--no-cli-pager"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: process.env, timeout: 10000 }));
      return result.Arn;
    },
    preview: value => process.stdout.write(`${JSON.stringify({ meterTable: values["meter-table"], auditTable: values["ledger-table"], ...value }, null, 2)}\n`),
    confirm: async phrase => (await terminal.question(`Type exactly: ${phrase}\n> `)) === phrase,
  });
  process.stdout.write(cleared ? "Source stop cleared and audited.\n" : "No change: declined, no stopped source, live call, or preview became stale.\n");
} finally { terminal.close(); }
