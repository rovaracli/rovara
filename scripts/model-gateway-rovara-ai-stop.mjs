// Operator-only, no HTTP route. Uses explicit local operator credentials, never the serving role.
// Build first: npx tsc -b packages/cloud-server
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { writeInstallRovaraAi } from "../packages/cloud-server/dist/rovara-ai-stop-operator.js";
const { values } = parseArgs({ options: Object.fromEntries(["region", "companies-table", "audit-table", "state"].map(key => [key, { type: "string" }])) });
if (Object.values(values).length !== 4 || Object.values(values).some(value => !value) || !["enabled", "paused"].includes(values.state)) throw new Error("Required: --region --companies-table --audit-table --state enabled|paused");
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Operator toggle requires an interactive terminal");
if (process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) throw new Error("Export local operator credentials first");
const identity = JSON.parse(execFileSync("aws", ["sts", "get-caller-identity", "--region", values.region, "--output", "json", "--no-cli-pager"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: process.env, timeout: 10000 }));
const terminal = createInterface({ input: process.stdin, output: process.stdout });
try {
  const phrase = `Set install Rovara AI ${values.state}`;
  process.stdout.write(`${JSON.stringify({ region: values.region, companies: values["companies-table"], audit: values["audit-table"], operator: identity.Arn, state: values.state })}\n`);
  if (await terminal.question(`Type exactly: ${phrase}\n> `) === phrase) {
    const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: values.region, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}) } }));
    await writeInstallRovaraAi(db, { companies: values["companies-table"], audit: values["audit-table"] }, { key: { pk: "INSTALL#ROVARA_AI", sk: "SETTING" }, enabled: values.state === "enabled", operatorArn: identity.Arn });
    process.stdout.write("Install setting saved and audited; gateway caches expire within 60 seconds.\n");
  } else process.stdout.write("No change.\n");
} finally { terminal.close(); }
