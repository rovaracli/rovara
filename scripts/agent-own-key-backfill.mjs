// Operator-only C-1 migration. Default is read-only; --apply always prints a complete preview first.
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { credentialsFromEnvironment } from "../packages/model-gateway/dist/aws.js";
import { Dynamo, unmarshalItem } from "../packages/model-gateway/dist/dynamo.js";
import { applyAgentOwnKeyBackfill, planAgentOwnKeyBackfill } from "../packages/model-gateway/dist/agent-own-key-backfill.js";

const { values } = parseArgs({ options: {
  region: { type: "string" }, issuer: { type: "string" }, "company-table": { type: "string" }, "product-table": { type: "string" },
  "release-stack": { type: "string" }, "lookup-role": { type: "string" }, apply: { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false }, check: { type: "boolean", default: false },
} });
const aws = (args, env = process.env) => JSON.parse(execFileSync("aws", [...args, "--region", values.region, "--output", "json", "--no-cli-pager"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env, maxBuffer: 16 * 1024 * 1024 }));
try {
  if (!values.region || (values.apply && (values.check || values["dry-run"] || values["release-stack"]))) throw new Error("invalid arguments");
  let issuer = values.issuer, companyTable = values["company-table"], productTable = values["product-table"], env = process.env;
  if (values["release-stack"]) {
    if (!values.check || !values["lookup-role"] || issuer || companyTable || productTable) throw new Error("invalid release scope");
    // DescribeStacks and AssumeRole are already allowed to the release job. The standard CDK lookup role is read-only.
    let stack;
    try { stack = aws(["cloudformation", "describe-stacks", "--stack-name", values["release-stack"]]).Stacks?.[0]; }
    catch (error) {
      const detail = error.stderr?.toString() ?? "";
      if (detail.includes("(ValidationError)") && detail.includes(`Stack with id ${values["release-stack"]} does not exist`)) {
        console.log("C-1 REQUIRED RELEASE STEP PASS: first install, no existing company table");
        process.exit(0);
      }
      throw new Error("stack unavailable", { cause: error });
    }
    issuer = stack?.Parameters?.find(p => p.ParameterKey === "CodeUrl")?.ParameterValue;
    productTable = stack?.Parameters?.find(p => p.ParameterKey === "ProductKeysTableName")?.ParameterValue;
    companyTable = stack?.Outputs?.find(o => o.OutputKey === "CompanyTableName")?.OutputValue;
    const credentials = aws(["sts", "assume-role", "--role-arn", values["lookup-role"], "--role-session-name", "c1-required-backfill"]).Credentials;
    if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) throw new Error("lookup role unavailable");
    env = { ...process.env, AWS_ACCESS_KEY_ID: credentials.AccessKeyId, AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey, AWS_SESSION_TOKEN: credentials.SessionToken };
  } else if (values["lookup-role"]) throw new Error("invalid role scope");
  if (!issuer || !companyTable || !productTable || companyTable === productTable) throw new Error("missing backfill scope");
  const companies = new Set();
  let cursor;
  const seen = new Set();
  do {
    const page = aws(["dynamodb", "scan", "--table-name", companyTable, "--consistent-read", "--no-paginate", "--projection-expression", "#pk", "--filter-expression", "begins_with(#pk, :prefix)", "--expression-attribute-names", JSON.stringify({ "#pk": "pk" }), "--expression-attribute-values", JSON.stringify({ ":prefix": { S: "COMPANY#" } }), ...(cursor ? ["--exclusive-start-key", JSON.stringify(cursor)] : [])], env);
    if (!Array.isArray(page.Items)) throw new Error("unreadable company scan");
    for (const item of page.Items) {
      const { pk } = unmarshalItem(item);
      if (typeof pk !== "string" || !pk.startsWith("COMPANY#")) throw new Error("unreadable company scan");
      companies.add(pk.slice("COMPANY#".length));
    }
    cursor = page.LastEvaluatedKey;
    if (cursor && Object.keys(cursor).length === 0) cursor = undefined;
    if (cursor) { const key = JSON.stringify(cursor); if (seen.has(key)) throw new Error("repeated scan cursor"); seen.add(key); }
  } while (cursor);
  const db = new Dynamo({ region: values.region, credentials: credentialsFromEnvironment(env) });
  const input = { db, companyTable, productTable, issuer, companies: [...companies] };
  const plan = await planAgentOwnKeyBackfill(input);
  // Only company ids and source names, never credential metadata or secret material.
  console.log(JSON.stringify({ decision: "DEC254zzz279", mode: "dry-run", issuer, companyTable, productTable, scannedCompanies: companies.size, count: plan.candidates.length, companies: plan.candidates.map(({ companyId, source }) => ({ companyId, source })) }));
  if (values.check && plan.candidates.length !== 0) throw new Error("required own-key backfill is pending");
  if (values.apply) {
    const result = await applyAgentOwnKeyBackfill(input, plan);
    console.log(JSON.stringify({ mode: "apply", ...result }));
    if (result.conflicted !== 0) throw new Error("backfill changed during preview; rerun dry-run");
    const remaining = await planAgentOwnKeyBackfill(input);
    if (remaining.candidates.length !== 0) throw new Error("required own-key backfill is pending");
    console.log("C-1 BACKFILL PASS: re-run has zero candidates");
  } else if (values.check) console.log("C-1 REQUIRED RELEASE STEP PASS");
} catch {
  // AWS/metadata errors may contain customer details. Never echo their causes.
  console.error("C-1 backfill refused or incomplete. Check scope, permissions and the dry-run; release is blocked.");
  process.exitCode = 1;
}
