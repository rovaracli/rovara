#!/usr/bin/env node
/**
 * Writes, as JSON on stdout, what the controller's read-only boundary simulation needs (briefs/staging-switchover/16-…): for each
 * synthesized CDK output directory (one app each), every stack's resolved role boundary, every (action, resource) its roles' own
 * policies grant, and the local check's verdict (cloud-boundary-check.ts). No AWS call: the controller simulates the cases.
 *
 *   node infra/dist/bin/cloud-boundary-cases.js <env> <account> <region> <cdk.out dir>...
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BOUNDARY_LOGICAL_ID } from "../lib/cloud-boundary.js";
import { boundaryViolations, resolvedBoundaries, roleCases, type CfnTemplate, type StackTemplate } from "../lib/cloud-boundary-check.js";

const [env, account, region, ...dirs] = process.argv.slice(2);
if (env === undefined || !/^[0-9]{12}$/u.test(account ?? "") || !/^[a-z]{2}(-[a-z]+)+-[0-9]$/u.test(region ?? "") || dirs.length === 0) {
  process.stderr.write("usage: cloud-boundary-cases.js <env> <12-digit account> <region> <cdk.out dir>...\n");
  process.exit(2);
}
const scope = { env, account: account!, region: region!, partition: region!.startsWith("cn-") ? "aws-cn" : region!.startsWith("us-gov-") ? "aws-us-gov" : "aws" };

function stacksOf(dir: string): StackTemplate[] {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { artifacts: Record<string, { type: string; properties?: { templateFile: string; stackName?: string } }> };
  return Object.entries(manifest.artifacts)
    .filter(([, a]) => a.type === "aws:cloudformation:stack")
    .map(([id, a]) => ({ stackName: a.properties!.stackName ?? id, template: JSON.parse(readFileSync(join(dir, a.properties!.templateFile), "utf8")) as CfnTemplate }));
}

const out = dirs.map((dir) => {
  const stacks = stacksOf(dir);
  return {
    dir,
    boundaries: resolvedBoundaries(stacks, scope),
    stacksWithoutBoundary: stacks.filter((s) => s.template.Resources[BOUNDARY_LOGICAL_ID]?.Type !== "AWS::IAM::ManagedPolicy").map((s) => s.stackName),
    cases: roleCases(stacks, scope).map((c) => ({ stackName: c.stackName, role: c.role, action: c.action, resource: c.resource })),
    violations: boundaryViolations(stacks, scope),
  };
});
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
