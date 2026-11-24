// The rollback module's AWS CLI ports (arrays of arguments through one injectable `run`). Reads: ssm, codepipeline get-pipeline-execution, the runs bucket. The only write besides
// holds and alerts is `codepipeline rollback-stage` with an explicit target, which only the rollback role may call (the boundary denies it to every other role).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAwsPorts, type AwsConfig, type RunAws } from "../../canary/src/aws.ts";
import { HEX40, UUID, isRecord } from "../../canary/src/util.ts";
import { evaluate } from "../../evaluator/src/index.ts";
import type { ExecutionFacts, RollbackPorts } from "./types.ts";

export const RELEASE_STAGE = "Release";
export const SOURCE_ARTIFACT = "Code";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

export function makeRollbackPorts(config: AwsConfig & { pipelineName: string }, run: RunAws, writeText: (name: string, text: string) => void): RollbackPorts {
  const base = makeAwsPorts(config, run, writeText);
  const getKey = async (key: string): Promise<string | null> => {
    const dir = mkdtempSync(join(tmpdir(), "rollback-get-"));
    try {
      const file = join(dir, "object");
      try {
        await run(["s3api", "get-object", "--bucket", config.runsBucket, "--key", key, file, "--output", "json"]);
      } catch (error) {
        if (messageOf(error).includes("NoSuchKey")) return null;
        throw error;
      }
      return readFileSync(file, "utf8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  /* eslint-disable @typescript-eslint/unbound-method -- the base ports are closures over their config (arrow functions that never read `this`), re-exported as they are */
  return {
    nowMs: base.nowMs,
    getParameter: base.getParameter,
    putHold: base.putHold,
    publish: base.publish,
    writeFile: base.writeFile,
    /* eslint-enable @typescript-eslint/unbound-method */
    async listHolds(dir) {
      const text = await run(["ssm", "get-parameters-by-path", "--path", dir.replace(/\/$/, ""), "--query", "Parameters[].Name", "--output", "json"]);
      const names = JSON.parse(text.trim() === "" || text.trim() === "null" ? "[]" : text) as unknown;
      if (!Array.isArray(names) || !names.every((n) => typeof n === "string")) throw new Error("the hold listing is malformed");
      return names.filter((n): n is string => typeof n === "string");
    },
    async getExecution(executionId): Promise<ExecutionFacts> {
      if (!UUID.test(executionId)) throw new Error("not an execution id");
      const text = await run(["codepipeline", "get-pipeline-execution", "--pipeline-name", config.pipelineName, "--pipeline-execution-id", executionId, "--output", "json"]);
      const body = JSON.parse(text) as unknown;
      const exec = isRecord(body) && isRecord(body.pipelineExecution) ? body.pipelineExecution : null;
      if (exec === null) throw new Error("the execution answer is malformed");
      const meta = isRecord(exec.rollbackMetadata) ? exec.rollbackMetadata : null;
      const revisions: unknown[] = Array.isArray(exec.artifactRevisions) ? exec.artifactRevisions.filter((r) => isRecord(r) && r.name === SOURCE_ARTIFACT) : [];
      const first = revisions[0];
      const sha = revisions.length === 1 && isRecord(first) && typeof first.revisionId === "string" && HEX40.test(first.revisionId) ? first.revisionId : null;
      return {
        executionType: typeof exec.executionType === "string" ? exec.executionType : null,
        status: typeof exec.status === "string" ? exec.status : null,
        rollbackTargetId: meta !== null && typeof meta.rollbackTargetPipelineExecutionId === "string" ? meta.rollbackTargetPipelineExecutionId : null,
        sourceSha: sha,
      };
    },
    async readCanaryResult(executionId) {
      if (!UUID.test(executionId)) throw new Error("not an execution id");
      const text = await getKey(`canary/${executionId}/result.json`);
      return text === null ? null : (JSON.parse(text) as unknown);
    },
    async releasePackagePresent(executionId) {
      if (!UUID.test(executionId)) throw new Error("not an execution id");
      const listing = JSON.parse(await run(["s3api", "list-objects-v2", "--bucket", config.runsBucket, "--prefix", `build/${executionId}/release/`, "--max-items", "1", "--output", "json"])) as unknown;
      const hasPackage = isRecord(listing) && Array.isArray(listing.Contents) && listing.Contents.length > 0;
      const record = await getKey(`preview/${executionId}/release.sha256`);
      return hasPackage && record !== null && record.trim() !== "";
    },
    async rollbackStage(target) {
      if (!UUID.test(target)) throw new Error("not an execution id");
      await run(["codepipeline", "rollback-stage", "--pipeline-name", config.pipelineName, "--stage-name", RELEASE_STAGE, "--target-pipeline-execution-id", target, "--output", "json"]);
    },
    evaluate: (input) => evaluate(input),
  };
}
