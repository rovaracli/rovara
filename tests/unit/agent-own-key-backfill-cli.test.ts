import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function run(args: string[], replies: Array<{ value?: unknown; error?: string }> = [{ value: { Items: [] } }]) {
  const dir = mkdtempSync(join(tmpdir(), "c1-cli-")); directories.push(dir);
  const log = join(dir, "calls.jsonl"), responses = join(dir, "responses.json");
  writeFileSync(responses, JSON.stringify(replies));
  const executable = join(dir, "aws");
  writeFileSync(executable, `#!${process.execPath}\nconst fs = require("node:fs"); const replies = JSON.parse(fs.readFileSync(${JSON.stringify(responses)}, "utf8")); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n"); const reply = replies.shift(); fs.writeFileSync(${JSON.stringify(responses)}, JSON.stringify(replies)); if (!reply || reply.error) { process.stderr.write(reply?.error ?? "unexpected AWS call"); process.exit(1); } process.stdout.write(JSON.stringify(reply.value));\n`);
  chmodSync(executable, 0o755);
  const result = spawnSync(process.execPath, ["scripts/agent-own-key-backfill.mjs", ...args], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, AWS_ACCESS_KEY_ID: "TEST", AWS_SECRET_ACCESS_KEY: "not-real" }, timeout: 10_000 });
  let calls: string[][] = [];
  try { calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]); } catch { /* Invalid arguments make no calls. */ }
  return { ...result, calls };
}
const scope = ["--region", "us-east-1", "--issuer", "https://code.example.test", "--company-table", "companies", "--product-table", "product-keys"];
describe("C-1 operator command and required release preflight", () => {
  it("defaults to dry-run and follows every scan page, including an empty filtered page", () => {
    const cursor = { pk: { S: "last" }, sk: { S: "row" } };
    const result = run(scope, [{ value: { Items: [], LastEvaluatedKey: cursor } }, { value: { Items: [] } }]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout) as unknown).toMatchObject({ mode: "dry-run", count: 0, companies: [] });
    expect(result.calls).toHaveLength(2);
    expect(result.calls[1]).toContain("--exclusive-start-key");
    expect(result.calls.every((call) => call[0] === "dynamodb" && call[1] === "scan" && call.includes("--consistent-read"))).toBe(true);
  });
  it("an empty apply re-runs the plan and reports zero writes", () => {
    const result = run([...scope, "--apply"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"written":0');
    expect(result.stdout).toContain("re-run has zero candidates");
    expect(result.calls.every((call) => call[1] === "scan")).toBe(true);
  });
  it("rejects contradictory modes before any AWS call", () => {
    const result = run([...scope, "--apply", "--dry-run"]);
    expect(result.status).toBe(1); expect(result.calls).toEqual([]);
  });
  it("fails closed on a broken scan, without leaking AWS error content", () => {
    const result = run(scope, [{ error: "private-response-never-echo" }]);
    expect(result.status).toBe(1); expect(result.stderr).not.toContain("private-response-never-echo");
  });
  it("permits a verified first installation; an access failure still blocks release", () => {
    const args = ["--region", "us-east-1", "--check", "--release-stack", "cloud-web", "--lookup-role", "arn:aws:iam::123456789012:role/lookup"];
    expect(run(args, [{ error: "(ValidationError) Stack with id cloud-web does not exist" }]).status).toBe(0);
    expect(run(args, [{ error: "AccessDenied" }]).status).toBe(1);
  });
  it("the installed release checks the stack's own tables and issuer through its read-only lookup role", () => {
    const result = run(["--region", "us-east-1", "--check", "--release-stack", "cloud-web", "--lookup-role", "arn:aws:iam::123456789012:role/lookup"], [
      { value: { Stacks: [{ Parameters: [{ ParameterKey: "CodeUrl", ParameterValue: "https://code.example.test" }, { ParameterKey: "ProductKeysTableName", ParameterValue: "product-keys" }], Outputs: [{ OutputKey: "CompanyTableName", OutputValue: "companies" }] }] } },
      { value: { Credentials: { AccessKeyId: "LOOKUP", SecretAccessKey: "not-real", SessionToken: "not-real" } } },
      { value: { Items: [] } },
    ]);
    expect(result.status).toBe(0); expect(result.stdout).toContain("C-1 REQUIRED RELEASE STEP PASS");
    expect(result.calls.map((call) => call.slice(0, 2))).toEqual([["cloudformation", "describe-stacks"], ["sts", "assume-role"], ["dynamodb", "scan"]]);
    expect(result.stdout).not.toContain("LOOKUP");
  });
});
