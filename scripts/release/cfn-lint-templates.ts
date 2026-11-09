// Before a release: synthesize the control-plane stacks with the Team record off and on (Public cloud and Enterprise), and run cfn-lint on every template.
// cfn-lint ships the CloudFormation resource schemas offline, so it catches what CloudFormation's early validation would refuse at deploy (a wrong enum spelling, an unknown property),
// which the CDK types and the contract tests do not. Python, so it is not in CI: install it in a throwaway venv, then
//   CFN_LINT=<venv>/bin/cfn-lint npx tsx scripts/release/cfn-lint-templates.ts
// Exit 0 only when every template is free of E-coded findings. Lambda bundling is skipped (the code does not change a template's shape).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { buildAgentXApp } from "../../infra/lib/app.js";

// The web app construct reads packages/web/dist/app/assets when it synthesizes; an empty folder is enough for a template (dist is not tracked).
mkdirSync("packages/web/dist/app/assets", { recursive: true });
process.env.CDK_CONTEXT_JSON = JSON.stringify({ "aws:cdk:bundling-stacks": [] });

const PUBLIC = { agentxEnv: "staging", agentxCloud: true } as const;
const ENTERPRISE = { agentxEnv: "ent", rovaraEdition: "enterprise", rovaraEnterpriseEgressCidrs: "10.99.0.0/16", agentxAuditTsa: "off" } as const;
const CASES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["public-record-off", PUBLIC],
  ["public-record-on", { ...PUBLIC, agentxTeamRecord: "enabled" }],
  ["enterprise-record-off", ENTERPRISE],
  ["enterprise-record-on", { ...ENTERPRISE, agentxTeamRecord: "enabled", agentxTeamRecordEnterpriseWorkspaceId: "w1", agentxTeamRecordKmsKeyArn: "arn:aws:kms:us-west-2:111122223333:key/11111111-2222-3333-4444-555555555555" }],
];

const outDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), "rovara-cfn-lint-"));
mkdirSync(outDir, { recursive: true });
const linter = process.env.CFN_LINT ?? "cfn-lint";
let failed = false;
for (const [name, context] of CASES) {
  const app = buildAgentXApp(context);
  const stacks = app.node.children.filter((child): child is Stack => Stack.isStack(child));
  for (const stack of stacks) {
    const file = join(outDir, `${name}.${stack.node.id}.template.json`);
    writeFileSync(file, JSON.stringify(Template.fromStack(stack).toJSON()));
    const run = spawnSync(linter, ["--format", "parseable", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const lines = `${run.stdout}${run.stderr}`.split("\n").filter((line) => line.trim() !== "");
    const errors = lines.filter((line) => /:E\d{4}:/.test(line));
    console.log(`${name} / ${stack.node.id}: ${errors.length} errors, ${lines.length - errors.length} other findings`);
    for (const line of lines) console.log(`  ${line}`);
    if (run.error !== undefined) console.log(`  could not run ${linter}: ${run.error.message}`);
    // cfn-lint exits with bits: 2 errors, 4 warnings, 8 informational; 1 means the tool itself failed (a crash prints no E line).
    if (errors.length > 0 || run.status === null || (run.status & 1) !== 0) failed = true;
  }
}
console.log(`templates are in ${outDir} (${readdirSync(outDir).length} files)`);
process.exit(failed ? 1 : 0);
