// L3 (DECISIONS 140): the release check is read-only, computes the same index names as the broker, and fails on an old index or an old-spec row. It runs against a fake `aws` here; nothing touches AWS.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEAM_RECORD_EMBEDDER, teamRecordVectorIndexName } from "@agentx/cloud-contracts";

const SCRIPT = new URL("../../../environments/embedder/tools/check_record_release.py", import.meta.url).pathname;
const ORG_1 = "org_aaaaaaaaaaaaaaaaaaaa";
const ORG_2 = "org_bbbbbbbbbbbbbbbbbbbb";
const QWEN = "0b0a5b868995d4ee";
const python = (() => { try { return execFileSync("python3", ["-I", "--version"], { encoding: "utf8" }).startsWith("Python 3") ? "python3" : undefined; } catch { return undefined; } })();
const required = process.env.CI === "true" || process.env.REQUIRE_PYTHON_TESTS === "1";

/** A fake `aws`: answers from a JSON world file, records every call, and refuses anything that is not a read. */
function fakeAws(world: { orgs: string[]; buckets: string[]; indexes: Record<string, string[]>; oldRows: number; failOn?: string }): { cmd: string; calls: () => string[][] } {
  const dir = mkdtempSync(join(tmpdir(), "check-release-"));
  writeFileSync(join(dir, "world.json"), JSON.stringify(world));
  writeFileSync(join(dir, "aws.py"), `#!/usr/bin/env python3
import json, sys
args = sys.argv[1:]
world = json.load(open(${JSON.stringify(join(dir, "world.json"))}))
open(${JSON.stringify(join(dir, "calls.jsonl"))}, "a").write(json.dumps(args) + "\\n")
sub = args[:2]
if world.get("failOn") == " ".join(sub):
    sys.stderr.write("AccessDenied"); sys.exit(255)
if sub == ["dynamodb", "query"]:
    items = [{"pk": {"S": "TEAM_RECORD_ORGS"}, "sk": {"S": org}} for org in world["orgs"]] + [{"pk": {"S": "TEAM_RECORD_ORGS"}, "sk": {"S": "REEMBED#" + world["orgs"][0]}}]
    print(json.dumps({"Items": items}))
elif sub == ["s3vectors", "list-vector-buckets"]:
    print(json.dumps({"vectorBuckets": [{"vectorBucketName": b} for b in world["buckets"]]}))
elif sub == ["s3vectors", "list-indexes"]:
    bucket = args[args.index("--vector-bucket-name") + 1]
    print(json.dumps({"indexes": [{"indexName": n} for n in world["indexes"].get(bucket, [])]}))
elif sub == ["dynamodb", "scan"]:
    assert "COUNT" in args
    print(json.dumps({"Count": world["oldRows"]}))
else:
    sys.stderr.write("refused: not a read " + " ".join(args)); sys.exit(97)
`);
  chmodSync(join(dir, "aws.py"), 0o755);
  return { cmd: `${python} ${join(dir, "aws.py")}`, calls: () => readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) };
}
const runCheck = (cmd: string, extra: string[] = []) => spawnSync("python3", ["-I", SCRIPT, "--env", "staging", "--aws-cmd", cmd, ...extra], { encoding: "utf8" });
const current = (org: string): string => teamRecordVectorIndexName(org);
const BUCKET = "agentx-staging-record-vectors";

describe.skipIf(python === undefined && !required)("the L3 release check (read-only)", () => {
  it("computes the broker's index names", () => {
    const names = execFileSync("python3", ["-I", "-c", `import importlib.util,sys;s=importlib.util.spec_from_file_location('c',${JSON.stringify(SCRIPT)});m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(m.index_name('${ORG_1}','${TEAM_RECORD_EMBEDDER.spec}'),m.index_name('${ORG_2}','${QWEN}'))`], { encoding: "utf8" }).trim().split(" ");
    expect(names).toEqual([teamRecordVectorIndexName(ORG_1, TEAM_RECORD_EMBEDDER.spec), teamRecordVectorIndexName(ORG_2, QWEN)]);
  });

  it("passes when every index is a current index and no row names the old spec", () => {
    const aws = fakeAws({ orgs: [ORG_1, ORG_2], buckets: [BUCKET], indexes: { [BUCKET]: [current(ORG_1), current(ORG_2)] }, oldRows: 0 });
    const result = runCheck(aws.cmd);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS");
  });

  it("fails on a leftover Qwen3 index, on a Titan-era index and on an index of no workspace", () => {
    const qwen = teamRecordVectorIndexName(ORG_1, QWEN);
    const aws = fakeAws({ orgs: [ORG_1], buckets: [BUCKET], indexes: { [BUCKET]: [current(ORG_1), qwen, "ws-00000000000000000000000000000000"] }, oldRows: 0 });
    const result = runCheck(aws.cmd);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(qwen);
    expect(result.stdout).toContain("ws-00000000000000000000000000000000");
    expect(result.stdout).not.toContain(`index ${current(ORG_1)} `);
  });

  it("fails when a bucket holds any index but the table lists no workspace, and checks every bucket", () => {
    const second = `${BUCKET}-2`;
    const aws = fakeAws({ orgs: [ORG_1], buckets: [BUCKET, second], indexes: { [BUCKET]: [current(ORG_1)], [second]: [teamRecordVectorIndexName(ORG_2)] }, oldRows: 0 });
    const result = runCheck(aws.cmd);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`in ${second}`);
  });

  it("fails when any row still says it was embedded with the old model", () => {
    const aws = fakeAws({ orgs: [ORG_1], buckets: [BUCKET], indexes: { [BUCKET]: [current(ORG_1)] }, oldRows: 3 });
    const result = runCheck(aws.cmd);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("3 table row(s) still have embeddingSpec = 0b0a5b868995d4ee");
  });

  it("is not a pass when a command fails (exit 2), finds no bucket (exit 2), and only ever calls reads", () => {
    const denied = fakeAws({ orgs: [ORG_1], buckets: [BUCKET], indexes: {}, oldRows: 0, failOn: "s3vectors list-indexes" });
    expect(runCheck(denied.cmd).status).toBe(2);
    const none = fakeAws({ orgs: [ORG_1], buckets: [], indexes: {}, oldRows: 0 });
    expect(runCheck(none.cmd).status).toBe(2);
    const ok = fakeAws({ orgs: [ORG_1], buckets: [BUCKET], indexes: { [BUCKET]: [current(ORG_1)] }, oldRows: 0 });
    runCheck(ok.cmd);
    const verbs = ok.calls().map((call) => call.slice(0, 2).join(" "));
    expect(new Set(verbs)).toEqual(new Set(["dynamodb query", "s3vectors list-vector-buckets", "s3vectors list-indexes", "dynamodb scan"]));
    for (const call of ok.calls()) expect(call.join(" ")).not.toMatch(/\b(put|delete|update|invoke|create|batch-write|write)\b/i);
  });

  it("the current spec comes from the image's lock, not from this file", () => {
    expect(readFileSync(SCRIPT, "utf8")).not.toContain(TEAM_RECORD_EMBEDDER.spec);
  });
});
