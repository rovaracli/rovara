// The real ports against a fake `aws`: every command is an argument array, holds never overwrite, pointers only overwrite by name, no secret read, one invoke attempt.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeAwsPorts, type RunAws } from "../src/aws.ts";
import { emailSubject, fromDecisionAlerts, chatbotBody, emailBody } from "../src/alerts.ts";

const config = { runsBucket: "runs-bucket", startFunction: "lane-start", statusFunction: "lane-status", outDir: "out", sleep: () => Promise.resolve(), nowMs: () => 0 };

function harness(answer: (args: readonly string[]) => string | Error = () => "") {
  const calls: { args: readonly string[]; env: Record<string, string> | undefined }[] = [];
  const files: Record<string, string> = {};
  const run: RunAws = (args, options) => {
    calls.push({ args, env: options?.env });
    const out = answer(args);
    if (out instanceof Error) return Promise.reject(out);
    const i = args.indexOf("lambda");
    if (i === 0 && args[1] === "invoke") writeFileSync(args[args.indexOf("--payload") + 2] as string, JSON.stringify({ runId: "r" }));
    return Promise.resolve(out);
  };
  return { ports: makeAwsPorts(config, run, (name, text) => { files[name] = text; }), calls, files };
}

describe("ssm", () => {
  it("a hold is a no-overwrite put and an existing hold is fine", async () => {
    const h = harness(() => new Error("aws ssm put failed: ParameterAlreadyExists"));
    await h.ports.putHold("/rovara-release/staging/code-hold/x", "{}");
    expect(h.calls[0]?.args).toContain("--no-overwrite");
    expect(h.calls[0]?.args).not.toContain("--overwrite");
  });
  it("a hold failing for any other reason throws", async () => {
    const h = harness(() => new Error("AccessDenied"));
    await expect(h.ports.putHold("/p", "{}")).rejects.toThrow();
  });
  it("a pointer is an overwrite put, a missing parameter reads as null, other errors throw", async () => {
    const h = harness();
    await h.ports.putPointer("/rovara-release/staging/code-last-good", "a".repeat(40));
    expect(h.calls[0]?.args).toContain("--overwrite");
    expect(await harness(() => new Error("ParameterNotFound")).ports.getParameter("/x")).toBeNull();
    await expect(harness(() => new Error("AccessDenied")).ports.getParameter("/x")).rejects.toThrow();
    expect(await harness(() => `${"b".repeat(40)}\n`).ports.getParameter("/x")).toBe("b".repeat(40));
  });
});

describe("the lane Lambda", () => {
  it("is one attempt, a read timeout, the right function, a JSON payload, and its answer is parsed", async () => {
    const h = harness(() => JSON.stringify({ StatusCode: 200 }));
    expect(await h.ports.invokeLane("start", { runId: "r", mode: "real" })).toEqual({ runId: "r" });
    const call = h.calls[0];
    expect(call?.env).toEqual({ AWS_MAX_ATTEMPTS: "1" });
    expect(call?.args.slice(0, 4)).toEqual(["lambda", "invoke", "--function-name", "lane-start"]);
    expect(call?.args).toContain("--cli-read-timeout");
    expect(call?.args[call.args.indexOf("--payload") + 1]).toBe(JSON.stringify({ runId: "r", mode: "real" }));
    await h.ports.invokeLane("status", {});
    expect(h.calls[1]?.args[3]).toBe("lane-status");
  });
  it("a function error or a non-200 is an error", async () => {
    await expect(harness(() => JSON.stringify({ FunctionError: "Unhandled" })).ports.invokeLane("start", {})).rejects.toThrow();
    await expect(harness(() => JSON.stringify({ StatusCode: 500 })).ports.invokeLane("start", {})).rejects.toThrow();
  });
});

describe("the ledger and metrics", () => {
  it("lists with a start-after, parses keys and times, and an empty bucket is an empty list", async () => {
    const h = harness(() => JSON.stringify({ Contents: [{ Key: "canary-ledger/a", LastModified: "2026-11-23T10:00:00+00:00" }] }));
    expect(await h.ports.listLedger("canary-ledger/20261122T000000Z")).toEqual([{ key: "canary-ledger/a", lastModifiedMs: Date.parse("2026-11-23T10:00:00Z") }]);
    expect(h.calls[0]?.args).toEqual(expect.arrayContaining(["--prefix", "canary-ledger/", "--start-after", "canary-ledger/20261122T000000Z"]));
    expect(await harness(() => "").ports.listLedger(null)).toEqual([]);
    await expect(harness(() => JSON.stringify({ Contents: [{ Key: "k" }] })).ports.listLedger(null)).rejects.toThrow();
  });
  it("puts a claim as an object in the runs bucket", async () => {
    const h = harness();
    await h.ports.putLedger("canary-ledger/x", "{}");
    expect(h.calls[0]?.args).toEqual(expect.arrayContaining(["s3api", "put-object", "--bucket", "runs-bucket", "--key", "canary-ledger/x"]));
  });
  it("sums Lambda Errors and refuses a malformed answer", async () => {
    expect(await harness(() => JSON.stringify({ Datapoints: [{ Sum: 1 }, { Sum: 2 }] })).ports.lambdaErrors(0, 600_000)).toBe(3);
    expect(await harness(() => JSON.stringify({ Datapoints: [] })).ports.lambdaErrors(0, 600_000)).toBe(0);
    expect(await harness(() => JSON.stringify({ Datapoints: [{ Average: 1 }] })).ports.lambdaErrors(0, 600_000)).toBeNull();
  });
  it("publishes with the topic, subject and message as separate arguments", async () => {
    const h = harness();
    await h.ports.publish("arn:topic", "subject; rm -rf /", "message $(whoami)");
    expect(h.calls[0]?.args).toEqual(expect.arrayContaining(["sns", "publish", "--topic-arn", "arn:topic", "--subject", "subject; rm -rf /", "--message", "message $(whoami)"]));
  });
});

describe("alerts text", () => {
  const alert = { code: "canary-fail", title: "canary FAIL \u2014 odd", message: "bad \u2014 news\nline", pipeline: "code", sha: "a".repeat(40), executionId: "e".repeat(8), s3Path: "s3://x/y" };
  it("is ASCII with no em dash, and the subject is at most 100 characters", () => {
    for (const text of [emailSubject({ ...alert, title: "t".repeat(300) }), emailBody(alert), chatbotBody(alert)]) expect(text).not.toContain("\u2014");
    expect(emailSubject({ ...alert, title: "t".repeat(300) }).length).toBeLessThanOrEqual(100);
    expect(emailBody(alert)).toMatch(/^[\x20-\x7e\n]+$/);
  });
  it("turns the evaluator's Decision.alerts into alerts", () => {
    const alerts = fromDecisionAlerts([{ rule: "A", code: "audit-backlog-rollback-allowed", message: "5 auto runs are not yet audited" }], { pipeline: "code", sha: "a".repeat(40), executionId: "x" });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.code).toBe("decision-audit-backlog-rollback-allowed");
    expect(alerts[0]?.message).toContain("not yet audited");
  });
});

describe("source scan: what the canary and the rollback tools can never do", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sources = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(dir, f), "utf8").replace(/(^|\s)\/\/.*$/gm, "$1"));
  const all = [...sources(join(here, "../src")), ...sources(join(here, "../../rollback/src"))].join("\n");
  it("reads no secret (S6b is dropped: the lane holds the only credential)", () => {
    expect(all).not.toMatch(/secretsmanager|get-secret-value|GetSecretValue/i);
  });
  it("never deletes a parameter, an object or a hold, and never approves or starts a pipeline", () => {
    expect(all).not.toMatch(/delete-parameter|delete-object|rm-parameter|put-approval-result|start-pipeline-execution/);
  });
  it("calls rollback-stage only with an explicit target", () => {
    const uses = all.match(/rollback-stage/g) ?? [];
    expect(uses.length).toBe(1);
    expect(all).toMatch(/"--target-pipeline-execution-id"/);
  });
  it("overwrites a parameter only for a pointer", () => {
    expect((all.match(/"--overwrite"/g) ?? []).length).toBe(1);
  });
});
