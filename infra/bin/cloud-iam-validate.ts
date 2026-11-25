#!/usr/bin/env node
/**
 * The Cloud IAM gate's opt-in AWS step: validates every IAM policy the Cloud app synthesizes with IAM Access Analyzer (read-only), and fails on ERROR and
 * SECURITY_WARNING findings and on TYPE_MISMATCH (a wrong operator for a key's type). Without --aws it only writes the documents (no AWS call).
 *
 *   node --import tsx infra/bin/cloud-iam-validate.ts [--aws] [--fail-on A,B] [--out DIR] --account 123456789012 --region us-east-1 (--cdk-out DIR | --context key=value)...
 *
 * --cdk-out DIR   a synthesized app (its manifest.json names the stacks); repeatable.
 * --context k=v   synthesize the app with this context (repeatable; all --context flags make ONE app), for example rovaraCloudReleaseActions=production.
 * The AWS command is `aws` unless CLOUD_IAM_AWS names another (the lane gate sets it to the beta read-only guard: "$HOME/.local/share/rovara-tools/beta-aws.sh aws").
 * The account in the sample ARNs is the one given: it is never written to a committed file (the documents go to --out, default a temp directory).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentXApp } from "../lib/app.js";
import type { CfnTemplate } from "../lib/cloud-boundary-check.js";
import { DEFAULT_BLOCKING, parseFindings, policyFiles, validateAll, validatePolicyArguments, type PolicyFile } from "../lib/cloud-iam-validate.js";

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const values = (name: string): string[] => argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]!] : []));
const one = (name: string): string | undefined => values(name)[0];
const account = one("--account");
const region = one("--region");
if (!/^[0-9]{12}$/u.test(account ?? "") || !/^[a-z]{2}(-[a-z]+)+-[0-9]$/u.test(region ?? "") || (values("--cdk-out").length === 0 && values("--context").length === 0)) {
  process.stderr.write("usage: cloud-iam-validate [--aws] [--fail-on A,B] [--out DIR] --account <12 digits> --region <region> (--cdk-out DIR | --context key=value)...\n");
  process.exit(2);
}
const scope = { partition: region!.startsWith("cn-") ? "aws-cn" : region!.startsWith("us-gov-") ? "aws-us-gov" : "aws", region: region!, account: account! };

const stacks: Array<{ stackName: string; template: CfnTemplate }> = [];
function readCdkOut(dir: string): void {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { artifacts: Record<string, { type: string; properties?: { templateFile: string; stackName?: string } }> };
  for (const [id, a] of Object.entries(manifest.artifacts)) {
    if (a.type === "aws:cloudformation:stack") stacks.push({ stackName: a.properties!.stackName ?? id, template: JSON.parse(readFileSync(join(dir, a.properties!.templateFile), "utf8")) as CfnTemplate });
  }
}
for (const dir of values("--cdk-out")) readCdkOut(dir);
const contexts = values("--context");
if (contexts.length > 0) {
  const context = Object.fromEntries(contexts.map((c) => { const at = c.indexOf("="); return [c.slice(0, at), c.slice(at + 1)]; }));
  // The app writes its assembly to a temp directory of its own (cdk's default outdir): read it back.
  readCdkOut(buildAgentXApp({ agentxRegion: region, ...context }).synth().directory);
}

const files = stacks.flatMap((s) => policyFiles(s.stackName, s.template, scope));
if (files.length === 0) { process.stderr.write(`cloud-iam-validate: FAIL: no IAM policy documents in ${stacks.length} stacks (empty synth, or a mistyped --context / --cdk-out): nothing was checked\n`); process.exit(1); }
const outDir = one("--out") ?? mkdtempSync(join(tmpdir(), "cloud-iam-policies-"));
mkdirSync(outDir, { recursive: true });
const path = (file: PolicyFile): string => join(outDir, `${file.name.replace(/[^A-Za-z0-9._-]/gu, "_")}.json`);
for (const file of files) writeFileSync(path(file), `${JSON.stringify(file.document, null, 1)}\n`);
process.stdout.write(`cloud-iam-validate: ${files.length} policy documents from ${stacks.length} stacks written to ${outDir}\n`);
if (!flag("--aws")) { process.stdout.write("cloud-iam-validate: --aws not given: no AWS call, nothing validated\n"); process.exit(0); }

const [command, ...prefix] = (process.env.CLOUD_IAM_AWS ?? "aws").split(/\s+/u).filter((x) => x !== "");
const blocking = (one("--fail-on") ?? DEFAULT_BLOCKING.join(",")).split(",");
let results: ReturnType<typeof validateAll>;
try {
  results = validateAll(files, (file) => {
    const run = spawnSync(command!, [...prefix, ...validatePolicyArguments(file.kind, path(file))], { encoding: "utf8", env: { ...process.env, AWS_MAX_ATTEMPTS: "1", AWS_PAGER: "" } });
    if (run.status !== 0) throw new Error(`${file.name}: validate-policy failed (exit ${run.status}): ${(run.stderr ?? "").trim().slice(0, 300)}`);
    return parseFindings(run.stdout);
  }, blocking);
} catch (error) { process.stderr.write(`cloud-iam-validate: FAIL: ${(error as Error).message}\n`); process.exit(1); }
let failed = 0;
for (const r of results) {
  process.stdout.write(`${r.blocking.length > 0 ? "FAIL" : "ok  "} ${r.name}: ${r.findings.length} findings, ${r.blocking.length} blocking\n`);
  for (const f of r.findings) process.stdout.write(`       ${r.blocking.includes(f) ? "BLOCKING " : ""}${f.findingType} ${f.issueCode}${f.line === undefined ? "" : ` (line ${f.line})`}: ${f.findingDetails.slice(0, 200)}\n`);
  failed += r.blocking.length;
}
process.stdout.write(`cloud-iam-validate: ${failed === 0 ? "PASS" : `FAIL (${failed} blocking findings)`} (blocking: ${blocking.join(", ")})\n`);
process.exit(failed === 0 ? 0 : 1);
