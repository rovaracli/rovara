// `node rollback/src/cli.ts guard`            the rollback-mode guard, called by the Release stage's Guard action (exit 0 proceed, 1 refused)
// `node rollback/src/cli.ts request [--execute]`  the explicit rollback to last-good (rollback role), a dry run unless --execute
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RunAws } from "../../canary/src/aws.ts";
import { requestExplicitRollback } from "./explicit.ts";
import { guardRollback } from "./guard.ts";
import { makeRollbackPorts } from "./aws.ts";

const execFileAsync = promisify(execFile);
const run: RunAws = async (args, options) => {
  try {
    const { stdout } = await execFileAsync("aws", [...args], { env: { ...process.env, ...(options?.env ?? {}) }, maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60_000 });
    return stdout;
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown }).stderr === "string" ? (error as { stderr: string }).stderr : "";
    throw new Error(`aws ${args[0] ?? ""} ${args[1] ?? ""} failed: ${stderr.slice(0, 400)}`, { cause: error });
  }
};

const env = (name: string): string => process.env[name] ?? "";
const topic = (name: string): string | null => (env(name) === "" ? null : env(name));
try {
  const outDir = env("OUT_DIR") === "" ? "out" : env("OUT_DIR");
  mkdirSync(outDir, { recursive: true });
  const ports = makeRollbackPorts(
    { runsBucket: env("RUNS_BUCKET"), startFunction: "", statusFunction: "", outDir, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), nowMs: () => Date.now(), pipelineName: env("PIPELINE_NAME") },
    run,
    (name, text) => writeFileSync(join(outDir, name), text),
  );
  const topics = { operator: topic("OPERATOR_ALERTS_TOPIC_ARN"), slack: topic("RELEASE_ALERTS_TOPIC_ARN") };
  const command = process.argv[2];
  if (command === "guard") {
    // The execution type comes from CodePipeline itself, never from a variable.
    const facts = await ports.getExecution(env("EXEC_ID"));
    const ctx = { kind: env("RELEASE_KIND"), executionId: env("EXEC_ID"), executionType: facts.executionType ?? "unknown", parameterPrefix: env("SSM_PREFIX"), topics, s3Path: `s3://${env("RUNS_BUCKET")}/guard/${env("EXEC_ID")}/` };
    let input: unknown = null;
    if (ctx.executionType === "ROLLBACK") {
      try {
        input = JSON.parse(readFileSync(env("ROLLBACK_EVALUATOR_INPUT"), "utf8")) as unknown;
      } catch {
        input = null;
      }
    }
    const result = await guardRollback(ctx, input, ports);
    process.stdout.write(`rollback guard (${result.mode}): ${result.proceed ? "proceed" : `REFUSED: ${result.reasons.join("; ")}`}\n`);
    process.exitCode = result.proceed ? 0 : 1;
  } else if (command === "request") {
    const result = await requestExplicitRollback({ kind: env("RELEASE_KIND"), parameterPrefix: env("SSM_PREFIX"), topics, s3Path: `s3://${env("RUNS_BUCKET")}/` }, ports, { execute: process.argv.includes("--execute") });
    if (result.reasons.length > 0) process.stdout.write(`rollback NOT requested: ${result.reasons.join("; ")}\n`);
    else process.stdout.write(`${result.dryRun ? "dry run: would roll back" : "requested: rolling back"} ${env("RELEASE_KIND")} to last-good ${result.sha ?? "?"} (execution ${result.targetExecutionId ?? "?"})\n`);
    process.exitCode = result.reasons.length > 0 ? 1 : 0;
  } else {
    process.stderr.write("usage: cli.ts guard | request [--execute]\n");
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`rollback tool failed: ${error instanceof Error ? error.message : "unknown"}\n`);
  process.exitCode = 1;
}
