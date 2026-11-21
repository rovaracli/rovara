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
// Match Cloud and the gateway exactly, without normalizing the stored partition's issuer.
function installedIssuer(codeUrl) {
  if (typeof codeUrl !== "string" || !/^https:\/\/[^/\s?#@]+$/u.test(codeUrl) || !new URL(codeUrl).hostname) throw new Error("unreadable installed issuer");
  return `${codeUrl}/v1/auth`;
}
try {
  if (!values.region || (values.apply && (values.check || values["dry-run"] || values["release-stack"]))) throw new Error("invalid arguments");
  let issuer = values.issuer, companyTable = values["company-table"], productTable = values["product-table"], env = process.env;
  if (values["release-stack"]) {
    if (!values.check || !values["lookup-role"] || issuer || companyTable || productTable) throw new Error("invalid release scope");
    const credentials = aws(["sts", "assume-role", "--role-arn", values["lookup-role"], "--role-session-name", "c1-required-backfill"]).Credentials;
    if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) throw new Error("lookup role unavailable");
    env = { ...process.env, AWS_ACCESS_KEY_ID: credentials.AccessKeyId, AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey, AWS_SESSION_TOKEN: credentials.SessionToken };
    // The stack and its tables live in the deploy account; read all of them through its existing read-only lookup role.
    const stack = aws(["cloudformation", "describe-stacks", "--stack-name", values["release-stack"]], env).Stacks?.[0];
    issuer = installedIssuer(stack?.Parameters?.find(p => p.ParameterKey === "CodeUrl")?.ParameterValue);
    productTable = stack?.Parameters?.find(p => p.ParameterKey === "ProductKeysTableName")?.ParameterValue;
    companyTable = stack?.Outputs?.find(o => o.OutputKey === "CompanyTableName")?.OutputValue;
  } else if (values["lookup-role"]) throw new Error("invalid role scope");
  if (!issuer || !companyTable || !productTable || companyTable === productTable) throw new Error("missing backfill scope");
  if (!issuer.endsWith("/v1/auth") || installedIssuer(issuer.slice(0, -"/v1/auth".length)) !== issuer) throw new Error("invalid issuer scope");
  const companies = new Set();
  // Companies is optional settings, not a credential roster. Include metadata-only companies.
  // Project only identifiers: even the scan response must never contain sealed key contents.
  for (const table of [companyTable, productTable]) {
    const metadata = table === productTable;
    let cursor;
    const seen = new Set();
    do {
      const page = aws(["dynamodb", "scan", "--table-name", table, "--consistent-read", "--no-paginate", "--projection-expression", metadata ? "#pk, #sk" : "#pk", "--filter-expression", metadata ? "begins_with(#pk, :prefix) AND (#sk = :learning OR #sk = :company)" : "begins_with(#pk, :prefix)", "--expression-attribute-names", JSON.stringify(metadata ? { "#pk": "pk", "#sk": "sk" } : { "#pk": "pk" }), "--expression-attribute-values", JSON.stringify(metadata ? { ":prefix": { S: `CO#${JSON.stringify([issuer]).slice(0, -1)},` }, ":learning": { S: "doc#_learning" }, ":company": { S: "doc#_company" } } : { ":prefix": { S: "COMPANY#" } }), ...(cursor ? ["--exclusive-start-key", JSON.stringify(cursor)] : [])], env);
      if (!Array.isArray(page.Items)) throw new Error("unreadable company discovery");
      for (const item of page.Items) {
        const { pk, sk } = unmarshalItem(item);
        if (metadata) {
          if (typeof pk !== "string" || !pk.startsWith("CO#") || (sk !== "doc#_learning" && sk !== "doc#_company")) throw new Error("unreadable metadata identifier");
          const identity = JSON.parse(pk.slice(3));
          if (!Array.isArray(identity) || identity.length !== 2 || identity[0] !== issuer || typeof identity[1] !== "string" || JSON.stringify(identity) !== pk.slice(3)) throw new Error("unreadable metadata identity");
          companies.add(identity[1]);
        } else {
          if (typeof pk !== "string" || !pk.startsWith("COMPANY#")) throw new Error("unreadable company scan");
          companies.add(pk.slice("COMPANY#".length));
        }
      }
      cursor = page.LastEvaluatedKey;
      if (cursor && Object.keys(cursor).length === 0) cursor = undefined;
      if (cursor) { const key = JSON.stringify(cursor); if (seen.has(key)) throw new Error("repeated scan cursor"); seen.add(key); }
    } while (cursor);
  }
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
