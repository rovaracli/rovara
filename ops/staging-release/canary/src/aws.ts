// The real ports: plain AWS CLI calls (arrays of arguments, never a shell string), through one injectable `run`, so a test sees every command. The canary role's only reach is
// what the stack grants it: ssm pointers and holds, the ledger prefix, the lane's two Lambdas, cloudwatch read, sns publish. There is deliberately NO secretsmanager call here
// (the pipeline holds no canary credential, S6b is dropped) and no codepipeline call.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEDGER_PREFIX } from "./config.ts";
import { isRecord } from "./util.ts";
import type { CanaryPorts, LedgerEntry } from "./types.ts";

export interface RunOptions {
  env?: Record<string, string>;
}
/** Runs `aws <args>`; resolves with stdout, rejects with an Error whose message holds stderr. */
export type RunAws = (args: readonly string[], options?: RunOptions) => Promise<string>;

export interface AwsConfig {
  runsBucket: string;
  startFunction: string;
  statusFunction: string;
  outDir: string;
  sleep: (ms: number) => Promise<void>;
  nowMs: () => number;
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

export function makeAwsPorts(config: AwsConfig, run: RunAws, writeText: (name: string, text: string) => void): CanaryPorts {
  return {
    nowMs: config.nowMs,
    sleep: config.sleep,
    async listLedger(startAfterKey) {
      const args = ["s3api", "list-objects-v2", "--bucket", config.runsBucket, "--prefix", LEDGER_PREFIX, "--output", "json"];
      if (startAfterKey !== null) args.push("--start-after", startAfterKey);
      const text = (await run(args)).trim();
      if (text === "" || text === "null") return [];
      const body = parseJson(text);
      if (!isRecord(body)) throw new Error("the ledger listing is not an object");
      const contents = body.Contents;
      if (contents === undefined || contents === null) return [];
      if (!Array.isArray(contents)) throw new Error("the ledger listing has no Contents array");
      return contents.map((item): LedgerEntry => {
        if (!isRecord(item) || typeof item.Key !== "string" || typeof item.LastModified !== "string" || Number.isNaN(Date.parse(item.LastModified))) throw new Error("a ledger listing entry is malformed");
        return { key: item.Key, lastModifiedMs: Date.parse(item.LastModified) };
      });
    },
    async putLedger(key, body) {
      const dir = mkdtempSync(join(tmpdir(), "canary-ledger-"));
      try {
        const file = join(dir, "claim.json");
        writeFileSync(file, body);
        await run(["s3api", "put-object", "--bucket", config.runsBucket, "--key", key, "--body", file, "--output", "json"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    async getParameter(name) {
      try {
        const out = await run(["ssm", "get-parameter", "--name", name, "--query", "Parameter.Value", "--output", "text"]);
        return out.trim();
      } catch (error) {
        if (messageOf(error).includes("ParameterNotFound")) return null;
        throw error;
      }
    },
    async putPointer(name, value) {
      await run(["ssm", "put-parameter", "--name", name, "--value", value, "--type", "String", "--overwrite"]);
    },
    async putHold(name, value) {
      try {
        // No overwrite: a hold can only be created, never replaced, and only the human approver can delete one.
        await run(["ssm", "put-parameter", "--name", name, "--value", value, "--type", "String", "--no-overwrite"]);
      } catch (error) {
        if (!messageOf(error).includes("ParameterAlreadyExists")) throw error;
      }
    },
    async invokeLane(fn, payload) {
      const dir = mkdtempSync(join(tmpdir(), "canary-lane-"));
      try {
        const out = join(dir, "response.json");
        // AWS_MAX_ATTEMPTS=1 and a read timeout: one approved invoke must never become two paid runs (a CLI retry on a timeout did that once).
        const meta = await run(
          ["lambda", "invoke", "--function-name", fn === "start" ? config.startFunction : config.statusFunction, "--invocation-type", "RequestResponse", "--cli-read-timeout", "60", "--cli-binary-format", "raw-in-base64-out", "--payload", JSON.stringify(payload), out, "--output", "json"],
          { env: { AWS_MAX_ATTEMPTS: "1" } },
        );
        const info = meta.trim() === "" ? {} : parseJson(meta);
        if (isRecord(info) && info.FunctionError !== undefined && info.FunctionError !== null) throw new Error("the lane function reported an error");
        if (isRecord(info) && typeof info.StatusCode === "number" && info.StatusCode !== 200) throw new Error(`the lane function answered ${info.StatusCode}`);
        return parseJson(readFileSync(out, "utf8"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    async lambdaErrors(fromMs, toMs) {
      const iso = (ms: number): string => new Date(ms).toISOString();
      const text = await run(["cloudwatch", "get-metric-statistics", "--namespace", "AWS/Lambda", "--metric-name", "Errors", "--start-time", iso(fromMs), "--end-time", iso(Math.max(toMs, fromMs + 60_000)), "--period", "60", "--statistics", "Sum", "--output", "json"]);
      const body = parseJson(text);
      if (!isRecord(body) || !Array.isArray(body.Datapoints)) return null;
      let sum = 0;
      for (const point of body.Datapoints) {
        if (!isRecord(point) || typeof point.Sum !== "number") return null;
        sum += point.Sum;
      }
      return sum;
    },
    async publish(topicArn, subject, message) {
      await run(["sns", "publish", "--topic-arn", topicArn, "--subject", subject, "--message", message, "--output", "json"]);
    },
    writeFile: writeText,
  };
}
