// Gate: the own-key backfill record check (DEC 254zzz279; Rovara-cloud#313), kept per environment from the old Cloud pipeline's deploy job.
// Reads the operator's recorded result through the account's CDK lookup role; never applies the migration. A tree older than the check has no script: skipped, with the reason.
import { ssmChecksPrefixFor, stackName } from "../config.ts";
import type { Gate } from "../types.ts";

export const gate: Gate = {
  name: "own-key-backfill",
  phases: ["preflight"],
  async run(input) {
    const cloud = input.dirs.cloud;
    if (cloud === null) return { result: "fail", failures: ["no candidate tree to run the check from"] };
    const script = `${cloud}/scripts/agent-own-key-backfill.mjs`;
    if (!input.ports.fs.exists(script)) return { result: "skipped", skippedReason: "this Cloud tree has no scripts/agent-own-key-backfill.mjs (it predates the check)" };
    const account = await input.ports.sts.account();
    const qualifier = input.config.bootstrapQualifier;
    const lookupRole = `arn:aws:iam::${account}:role/cdk-${qualifier}-lookup-role-${account}-${input.region}`;
    const marker = `${ssmChecksPrefixFor(input.config, input.env)}/agent-own-key-backfill`;
    const run = await input.ports.exec("node", [script, "--check", "--release-stack", stackName(input.config, input.env, "web"), "--lookup-role", lookupRole, "--marker", marker, "--region", input.region], { cwd: cloud });
    for (const line of run.stdout.split("\n").filter((l) => l !== "").slice(-5)) input.log(line);
    if (run.code !== 0) return { result: "fail", failures: [`the own-key backfill check exited ${run.code}: ${run.stderr.split("\n").filter((l) => l !== "").slice(-3).join(" / ")}`] };
    return { result: "pass", data: { marker } };
  },
};
