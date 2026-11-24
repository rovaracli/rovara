import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
type FixtureRow = { table: string; item: Record<string, unknown> };
function run(args: string[], replies: Array<{ value?: unknown; error?: string; accessKey?: string }> = [{ value: { Items: [] } }, { value: { Items: [] } }], rows: FixtureRow[] = [], readError = false) {
  const dir = mkdtempSync(join(tmpdir(), "c1-cli-")); directories.push(dir);
  const log = join(dir, "calls.jsonl"), responses = join(dir, "responses.json");
  writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}');
  writeFileSync(responses, JSON.stringify(replies));
  // Keep the real Dynamo marshalling, planner, metadata parser and transactional conditions.
  // Only the wire transport is offline; deny sockets even if a regression bypasses it.
  const state = join(dir, "state.json"), preload = join(dir, "offline.mjs");
  writeFileSync(preload, `
import { writeFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { Dynamo } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "packages/model-gateway/dist/dynamo.js")).href)};
import { WireDynamo } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "tests/unit/model-gateway-wire-dynamo.ts")).href)};
net.Socket.prototype.connect = tls.connect = () => { throw new Error("network forbidden"); };
const wire = new WireDynamo(["companies", "product-keys"]);
const db = new Dynamo({ region: "us-east-1", credentials: async () => ({ accessKeyId: "TEST", secretAccessKey: "not-real" }), transport: wire.transport });
for (const row of ${JSON.stringify(rows)}) await db.put(row.table, row.item);
wire.calls.length = 0;
const get = Dynamo.prototype.get, transact = Dynamo.prototype.transact;
Dynamo.prototype.get = function (...args) {
  if (${String(readError)} && args[0] === "product-keys") throw new Error("private-response-never-echo");
  if (args[0] === "product-keys" && !["doc#_learning", "doc#_company"].includes(args[1].sk)) throw new Error("secret read forbidden");
  return get.apply(db, args);
};
Dynamo.prototype.transact = function (...args) { return transact.apply(db, args); };
process.on("exit", () => writeFileSync(${JSON.stringify(state)}, JSON.stringify({ calls: wire.calls, choices: [...wire.fake.items.values()].filter(row => row.sk === "AGENT_AI") })));
`);
  const executable = join(dir, "aws");
  writeFileSync(executable, `#!${process.execPath}\nconst fs = require("node:fs"); const replies = JSON.parse(fs.readFileSync(${JSON.stringify(responses)}, "utf8")); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n"); const reply = replies.shift(); if (reply?.accessKey && process.env.AWS_ACCESS_KEY_ID !== reply.accessKey) { process.stderr.write("wrong account credentials"); process.exit(1); } fs.writeFileSync(${JSON.stringify(responses)}, JSON.stringify(replies)); if (!reply || reply.error) { process.stderr.write(reply?.error ?? "unexpected AWS call"); process.exit(1); } process.stdout.write(JSON.stringify(reply.value));\n`);
  chmodSync(executable, 0o755);
  const result = spawnSync(process.execPath, ["--import", "tsx", "--import", pathToFileURL(preload).href, "scripts/agent-own-key-backfill.mjs", ...args], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, AWS_ACCESS_KEY_ID: "TEST", AWS_SECRET_ACCESS_KEY: "not-real" }, timeout: 10_000 });
  let calls: string[][] = [];
  try { calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]); } catch { /* Invalid arguments make no calls. */ }
  const offline = JSON.parse(readFileSync(state, "utf8")) as { calls: Array<{ operation: string; keys: Array<{ pk: string; sk: string }> }>; choices: Record<string, unknown>[] };
  return { ...result, calls, offline };
}
const issuer = "https://code.example.test/v1/auth";
const A = `org_${"a".repeat(20)}`, B = `org_${"b".repeat(20)}`;
const scope = ["--region", "us-east-1", "--issuer", issuer, "--company-table", "companies", "--product-table", "product-keys"];
const MARKER = "/rovara-cloud/test/release-checks/agent-own-key-backfill";
const release = ["--region", "us-east-1", "--check", "--release-stack", "cloud-web", "--lookup-role", "arn:aws:iam::123456789012:role/lookup", "--marker", MARKER];
const stack = (codeUrl: unknown = "https://code.example.test") => ({ value: { Stacks: [{ Parameters: [{ ParameterKey: "CodeUrl", ParameterValue: codeUrl }, { ParameterKey: "ProductKeysTableName", ParameterValue: "product-keys" }], Outputs: [{ OutputKey: "CompanyTableName", OutputValue: "companies" }] }] } });
const role = { value: { Credentials: { AccessKeyId: "LOOKUP", SecretAccessKey: "not-real", SessionToken: "not-real" } } };
const empty = { value: { Items: [] } };
function connected(cid: string, provider = "anthropic"): FixtureRow {
  return { table: "product-keys", item: { pk: `CO#${JSON.stringify([issuer, cid])}`, sk: provider === "bedrock" ? "doc#_company" : "doc#_learning", v: 1, f_sources: [{ sourceId: `src_${provider}`, provider, connectedBy: "d".repeat(64), connectedAt: 1, updatedAt: 1, currentVersion: "00000000-0000-4000-8000-000000000001", ...(provider === "bedrock" ? { bedrock: { roleArn: "arn:aws:iam::123456789012:role/RovaraBedrockInvoke-customer", region: "us-east-1", models: { "claude-sonnet-4-5": "us.anthropic.claude-sonnet-4-5-20250929-v1:0" }, allowGlobal: false, checks: {}, checkedAt: 1 } } : {}) }], f_removed: [] } };
}
const identifiers = (rows: FixtureRow[]) => ({ value: { Items: rows.map(({ item }) => ({ pk: { S: item.pk }, sk: { S: item.sk } })) } });
describe("C-1 operator command and required release preflight", () => {
  it("defaults to dry-run and follows every scan page, including an empty filtered page", () => {
    const cursor = { pk: { S: "last" }, sk: { S: "row" } };
    const result = run(scope, [{ value: { Items: [], LastEvaluatedKey: cursor } }, empty, empty]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout) as unknown).toMatchObject({ mode: "dry-run", count: 0, companies: [] });
    expect(result.calls).toHaveLength(3);
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
  it("blocks release when the installed scope cannot be read, including a missing stack", () => {
    for (const error of ["(ValidationError) Stack with id cloud-web does not exist", "AccessDenied"]) {
      const result = run(release, [role, { error }]);
      expect(result.status).toBe(1); expect(result.stdout).not.toContain("PASS");
    }
  });
  // Rovara-cloud#313: the release pipeline's lookup role is denied kms:Decrypt, so the release reads the operator's recorded result.
  const recorded = (over: Record<string, unknown> = {}) => ({ value: { Parameter: { Name: MARKER, Type: "String", Value: JSON.stringify({ decision: "DEC254zzz279", issuer, companyTable: "companies", productTable: "product-keys", scannedCompanies: 3, count: 0, checkedAt: "2026-11-24T12:30:00.000Z", ...over }) } } });
  it("the installed release reads the recorded result through its read-only lookup role, scanning no table", () => {
    const result = run(release, [role, stack(), recorded()]);
    expect(result.status).toBe(0); expect(result.stdout).toContain("C-1 REQUIRED RELEASE STEP PASS (recorded 2026-11-24T12:30:00.000Z, 3 companies checked)");
    expect(result.calls.map((call) => call.slice(0, 2))).toEqual([["sts", "assume-role"], ["cloudformation", "describe-stacks"], ["ssm", "get-parameter"]]);
    expect(result.calls[2]).toContain(MARKER);
    expect(result.offline.calls).toEqual([]);
    expect(result.stdout).not.toContain("LOOKUP");
  });
  it("M-1: cross-account stack discovery and the recorded result use the deploy lookup credentials", () => {
    const result = run(release, [{ ...role, accessKey: "TEST" }, { ...stack(), accessKey: "LOOKUP" }, { ...recorded(), accessKey: "LOOKUP" }]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("C-1 REQUIRED RELEASE STEP PASS");
    expect(result.calls[0]).toContain("arn:aws:iam::123456789012:role/lookup");
  });
  it("blocks release when nothing is recorded, or the record is for another install, is pending, or is malformed", () => {
    const bad = [
      { error: "(ParameterNotFound) private-response-never-echo" },
      recorded({ issuer: "https://other.example.test/v1/auth" }), recorded({ companyTable: "other-companies" }), recorded({ productTable: "other-keys" }),
      recorded({ count: 1 }), recorded({ decision: "other" }), recorded({ checkedAt: "yesterday" }), recorded({ scannedCompanies: -1 }),
      { value: { Parameter: { Value: "not json" } } }, { value: { Parameter: { Value: "[]" } } }, { value: {} },
    ];
    for (const reply of bad) {
      const result = run(release, [role, stack(), reply]);
      expect(result.status, JSON.stringify(reply)).toBe(1);
      expect(result.stdout).not.toContain("PASS");
      expect(result.stderr).not.toContain("private-response-never-echo");
    }
  });
  it("refuses missing or malformed installed issuers instead of checking an empty partition", () => {
    for (const codeUrl of [undefined, "", "http://code.example.test", "https://code.example.test/wrong", "https://code.example.test?wrong", "not-a-url"]) {
      const result = run(release, [role, stack(codeUrl === undefined ? null : codeUrl), recorded()]);
      expect(result.status, String(codeUrl)).toBe(1);
      expect(result.stdout).not.toContain("PASS");
    }
  });
  it("a release check needs the marker, and the marker and record each belong to their own scope", () => {
    const refused = [
      ["--region", "us-east-1", "--check", "--release-stack", "cloud-web", "--lookup-role", "arn:aws:iam::123456789012:role/lookup"],
      [...scope, "--marker", MARKER],
      [...release, "--record", MARKER],
      [...scope, "--record", "/somewhere/else"],
      [...scope, "--record", "/rovara-cloud/test/web/origin"],
    ];
    for (const args of refused) {
      const result = run(args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.calls, args.join(" ")).toEqual([]);
    }
  });
  it("the operator records a zero-candidate result (identifiers and counts only), and never a pending one", () => {
    const rows = [connected(A)];
    const done = run([...scope, "--dry-run", "--record", MARKER], [empty, empty, { value: { Version: 1 } }]);
    expect(done.status).toBe(0);
    expect(done.stdout).toContain(`C-1 RESULT RECORDED in ${MARKER}`);
    const put = done.calls.find(call => call[0] === "ssm")!;
    expect(put.slice(0, 2)).toEqual(["ssm", "put-parameter"]);
    expect(put).toEqual(expect.arrayContaining(["--name", MARKER, "--type", "String", "--overwrite"]));
    const value = JSON.parse(put[put.indexOf("--value") + 1]!) as Record<string, unknown>;
    expect(value).toMatchObject({ decision: "DEC254zzz279", issuer, companyTable: "companies", productTable: "product-keys", scannedCompanies: 0, count: 0 });
    expect(Object.keys(value).sort()).toEqual(["checkedAt", "companyTable", "count", "decision", "issuer", "productTable", "scannedCompanies"]);
    const pending = run([...scope, "--dry-run", "--record", MARKER], [{ value: { Items: [{ pk: { S: `COMPANY#${A}` } }] } }, identifiers(rows)], rows);
    expect(pending.status).toBe(1);
    expect(pending.calls.some(call => call[0] === "ssm")).toBe(false);
    expect(pending.stdout).not.toContain("RECORDED");
  });
  it("discovers metadata-only Anthropic and Bedrock companies on every page for preview, apply and the zero-candidate check", () => {
    const rows = [connected(A), connected(B, "bedrock")];
    const cursor = { pk: { S: "last-metadata" }, sk: { S: "row" } };
    const pages = [empty, { value: { Items: [], LastEvaluatedKey: cursor } }, identifiers(rows)];
    const preview = run([...scope, "--dry-run"], pages, rows);
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout) as unknown).toMatchObject({ scannedCompanies: 2, count: 2, companies: [{ companyId: A, source: "anthropic_key" }, { companyId: B, source: "bedrock_byo" }] });
    expect(preview.offline.choices).toEqual([]);
    expect(preview.offline.calls.every(call => call.operation === "GetItem")).toBe(true);
    const scan = preview.calls[1]!;
    expect(scan[scan.indexOf("--table-name") + 1]).toBe("product-keys");
    expect(scan[scan.indexOf("--projection-expression") + 1]).toBe("#pk, #sk");
    expect(JSON.parse(scan[scan.indexOf("--expression-attribute-values") + 1]!) as unknown).toEqual({ ":prefix": { S: 'CO#["https://code.example.test/v1/auth",' }, ":learning": { S: "doc#_learning" }, ":company": { S: "doc#_company" } });
    expect(scan[scan.indexOf("--filter-expression") + 1]).toBe("begins_with(#pk, :prefix) AND (#sk = :learning OR #sk = :company)");
    expect(preview.calls[2]).toContain("--exclusive-start-key");
    const pending = run([...scope, "--check"], pages, rows);
    expect(pending.status).toBe(1); expect(pending.stdout).toContain('"count":2'); expect(pending.stdout).not.toContain("PASS");
    const applied = run([...scope, "--apply"], pages, rows);
    expect(applied.status).toBe(0); expect(applied.stdout).toContain('"written":2');
    expect(applied.offline.choices).toEqual(expect.arrayContaining([expect.objectContaining({ companyId: A, source: "anthropic_key" }), expect.objectContaining({ companyId: B, source: "bedrock_byo" })]));
    const after = [...rows, ...applied.offline.choices.map(item => ({ table: "companies", item }))];
    const rerun = run([...scope, "--apply"], pages, after);
    expect(rerun.status).toBe(0); expect(rerun.stdout).toContain('"written":0');
    expect(rerun.offline.choices).toEqual(applied.offline.choices);
    expect(rerun.offline.calls.every(call => call.operation === "GetItem")).toBe(true);
    const checked = run([...scope, "--check"], pages, after);
    expect(checked.status).toBe(0); expect(checked.stdout).toContain('"count":0'); expect(checked.stdout).toContain("C-1 REQUIRED RELEASE STEP PASS");
  });
  it("fails closed on unreadable or incomplete metadata discovery in every mode", () => {
    const row = connected(A);
    for (const mode of ["--dry-run", "--apply", "--check"]) {
      for (const page of [{ error: "private-response-never-echo" }, { value: {} }, { value: { Items: [{ pk: { S: "CO#broken" }, sk: { S: "doc#_learning" } }] } }]) {
        const result = run([...scope, mode], [empty, page], [row]);
        expect(result.status).toBe(1); expect(result.stdout).not.toContain("PASS");
        expect(result.offline.choices).toEqual([]); expect(result.stderr).not.toContain("private-response-never-echo");
      }
    }
  });
});
