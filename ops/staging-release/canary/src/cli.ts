// The Canary action's entry: `node canary/src/cli.ts`. Reads its context from the stage's environment, runs the canary, prints one line, and exits with the verdict's code
// (0 PASS / SKIPPED-CAP / INCONCLUSIVE, 1 FAIL, 4 a required HOLD could not be written or the process itself crashed). A crash is never exit 1: a FAIL is only ever a verdict.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { makeAwsPorts, type RunAws } from "./aws.ts";
import { runCanary } from "./canary.ts";

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

try {
  const env = (name: string): string => process.env[name] ?? "";
  const outDir = env("OUT_DIR") === "" ? "out" : env("OUT_DIR");
  mkdirSync(outDir, { recursive: true });
  const ports = makeAwsPorts(
    { runsBucket: env("RUNS_BUCKET"), startFunction: env("CANARY_START_FUNCTION"), statusFunction: env("CANARY_STATUS_FUNCTION"), outDir, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), nowMs: () => Date.now() },
    run,
    (name, text) => writeFileSync(join(outDir, name), text),
  );
  const result = await runCanary(
    {
      kind: env("RELEASE_KIND"),
      executionId: env("EXEC_ID"),
      executionType: env("EXEC_TYPE"),
      sha: env("RELEASE_SHA"),
      parameterPrefix: env("SSM_PREFIX"),
      topics: { operator: env("OPERATOR_ALERTS_TOPIC_ARN") === "" ? null : env("OPERATOR_ALERTS_TOPIC_ARN"), slack: env("RELEASE_ALERTS_TOPIC_ARN") === "" ? null : env("RELEASE_ALERTS_TOPIC_ARN") },
      s3Path: `s3://${env("RUNS_BUCKET")}/canary/${env("EXEC_ID")}/`,
    },
    ports,
  );
  process.stdout.write(`canary ${result.outcome}: ${result.reason}\n`);
  process.exitCode = result.exitCode;
} catch (error) {
  process.stderr.write(`canary crashed: ${error instanceof Error ? error.message : "unknown"}\n`);
  process.exitCode = 4;
}
