/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- the tests read the JSON records the scripts write and edit plain JSON documents, which a typed document would not allow */
// Decide's input assembly and decide.sh, run for real against a fake CloudFormation/SSM/ECR/S3, a real git bundle, a stub GitHub server and the REAL policy evaluator.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PACK, copyPack, makeWorld, runPack, type World } from "./support/harness.ts";
import { ACCT, BUCKET, CS, EXEC_ID, PARTS, PIPE_ENV, WORKER_URI, SLACK_URI, canonSha, csId, liveParams, stack, writePackage, writeRunRecords } from "./support/fixtures.ts";

const sha256 = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");
let server: ChildProcess;
let ghDir: string;
let ghBase = "";

beforeAll(async () => {
  ghDir = join(makeWorld().work, "..", "gh-" + Date.now());
  mkdirSync(ghDir, { recursive: true });
  const code = `
import http.server, json, os, sys
D = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        p = self.path.split("?")[0].strip("/").replace("/", "_") + ".json"
        f = os.path.join(D, p)
        if os.path.isfile(f):
            b = open(f, "rb").read(); self.send_response(200)
        else:
            b = b'{"message":"Not Found"}'; self.send_response(404)
        self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
s = http.server.HTTPServer(("127.0.0.1", 0), H)
print(s.server_address[1], flush=True)
s.serve_forever()
`;
  server = spawn("python3", ["-I", "-c", code, ghDir], { stdio: ["ignore", "pipe", "ignore"] });
  const port = await new Promise<string>((resolve) => server.stdout?.once("data", (d: Buffer) => resolve(String(d).trim())));
  ghBase = `http://127.0.0.1:${port}`;
});
afterAll(() => server.kill());

// ---- a real repository: installed C1 -> release C2 ----
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_DATE: "2026-11-23T12:00:00Z", GIT_COMMITTER_DATE: "2026-11-23T12:00:00Z", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
interface Repo { dir: string; installed: string; release: string; tree: string; bundle: string }
function makeRepo(root: string, second: Record<string, string>): Repo {
  const dir = join(root, "repo");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  const put = (files: Record<string, string>): void => { for (const [p, c] of Object.entries(files)) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), c); } };
  put({ "packages/a.ts": "export const a = 1;\n", "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {} }) });
  git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "c1");
  const installed = git(dir, "rev-parse", "HEAD");
  put({ "packages/a.ts": "export const a = 2;\n", ...second });
  git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "c2");
  git(dir, "tag", "v0.5.49");
  const release = git(dir, "rev-parse", "HEAD");
  const bundle = join(root, "source.bundle");
  git(dir, "bundle", "create", bundle, "HEAD", "v0.5.49");
  return { dir, installed, release, tree: git(dir, "rev-parse", "HEAD^{tree}"), bundle };
}

// ---- the policy pin: the same recipe as the pipeline's pin command and the evaluator's manifest hash ----
function walkFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir).sort()) { const p = join(dir, n); if (statSync(p).isDirectory()) out.push(...walkFiles(p, base)); else out.push("./" + p.slice(base.length + 1)); }
  return out;
}
const packPin = (root: string): string => sha256(walkFiles(root).sort().map((p) => `${sha256(readFileSync(join(root, p)))}  ${p}\n`).join(""));

let w: World;
let repo: Repo;
let pkg: string;
let root: string;
const worker = { repo: "agentx-staging/worker", digest: `sha256:${"4".repeat(64)}` };
const slack = { repo: "agentx-staging/slack", digest: `sha256:${"5".repeat(64)}` };

function ghRuns(tree: string, over: Record<string, unknown> = {}): void {
  const run = { id: 77, path: ".github/workflows/ci.yml", event: "workflow_dispatch", status: "completed", conclusion: "success", head_sha: "e".repeat(40), head_commit: { tree_id: tree }, repository: { full_name: "rovaracli/rovara" }, head_repository: { full_name: "rovaracli/rovara" }, ...over };
  writeFileSync(join(ghDir, "repos_rovaracli_rovara_actions_workflows_ci.yml_runs.json"), JSON.stringify({ workflow_runs: [run] }));
  writeFileSync(join(ghDir, "repos_rovaracli_rovara_actions_runs_77_jobs.json"), JSON.stringify({ jobs: ["local", "ci-mode (full)"].map((name) => ({ name, status: "completed", conclusion: "success", head_sha: "e".repeat(40) })) }));
  writeFileSync(join(ghDir, `repos_rovaracli_rovara_commits_${"e".repeat(40)}_check-runs.json`), JSON.stringify({ check_runs: ["local", "ci-mode (full)"].map((name) => ({ name, conclusion: "success", app: { slug: "github-actions" } })) }));
}

function setup(second: Record<string, string> = { "docs/release-notes/0.5.49.md": "Fixes a small thing.\n" }): void {
  w = makeWorld();
  root = join(w.work, "r");
  mkdirSync(root, { recursive: true });
  repo = makeRepo(root, second);
  pkg = writePackage(join(w.work, "release"));
  const rec = writeRunRecords(w, pkg, { verdict: "AUTO", sha: repo.release, installed: repo.installed });
  void rec;
  // Preview's records with the real sha
  const gates = ["25-gate", "15-gate", "45-gate", "46-gate", "gate-gateway-deployed", "gate-gateway-runprice", "50-dry-run"];
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  for (const g of gates) w.s3Put(BUCKET, `gates/${EXEC_ID}/gates/${g}.json`, JSON.stringify({ name: g, sha: repo.release, writtenAt: now, result: g === "46-gate" ? "skipped" : "pass", failures: [], ...(g === "46-gate" ? { skippedReason: "DEC 254zzz397" } : {}) }));
  w.s3Put(BUCKET, `build/${EXEC_ID}/source.bundle`, readFileSync(repo.bundle));
  // CloudFormation: six change sets with no rows, live == new, parameters equal live (images already current)
  for (const p of PARTS) {
    const tpl = { Resources: { A: { Type: "AWS::SSM::Parameter", Properties: { Value: p } } } };
    const params = liveParams(p).map((x) => (x.ParameterKey === "WorkerImageUri" ? { ...x, ParameterValue: WORKER_URI } : x.ParameterKey === "OrchestratorImageUri" ? { ...x, ParameterValue: SLACK_URI } : x));
    w.answer(`cloudformation.describe-stacks.${stack(p)}.json`, { Stacks: [{ StackName: stack(p), StackStatus: "UPDATE_COMPLETE", Parameters: params, Outputs: [] }] });
    w.answer(`cloudformation.describe-change-set.${stack(p)}.${CS}.json`, { ChangeSetName: CS, ChangeSetId: csId(p), StackName: stack(p), Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE", Capabilities: ["CAPABILITY_IAM"], Parameters: params.map((x) => ({ ParameterKey: x.ParameterKey, ParameterValue: x.ParameterValue })), Changes: [] });
    w.answer(`cloudformation.get-template.${stack(p)}.${CS}.json`, { TemplateBody: tpl });
    w.answer(`cloudformation.get-template.${stack(p)}.json`, { TemplateBody: tpl });
  }
  // the preview record must hold the template hashes Decide will compute
  const pv = JSON.parse(readFileSync(join(w.dir, "s3", BUCKET, `preview/${EXEC_ID}/preview.json`), "utf8"));
  pv.sha = repo.release;
  writeFileSync(join(w.dir, "s3", BUCKET, `preview/${EXEC_ID}/preview.json`), JSON.stringify(pv));
  w.answer("sts.get-caller-identity.json", { Account: ACCT });
  w.answer("ssm.get-parameter._rovara-release_staging_code-installed.json", { Parameter: { Value: repo.installed } });
  w.answer("ssm.get-parameter._rovara-release_staging_policy-pin.json", { Parameter: { Value: packPin(PACK) } });
  const last = "11111111-1111-4111-8111-111111111111";
  w.answer("ssm.get-parameter._rovara-release_staging_code-last-good-execution.json", { Parameter: { Value: last } });
  w.s3Put(BUCKET, `build/${last}/release/answers.json`, readFileSync(join(pkg, "answers.json")));
  w.answer("ssm.get-parameters-by-path.json", { Parameters: [] });
  w.answer("codepipeline.get-pipeline-execution.rovara-staging-code-release.json", { pipelineExecution: { executionType: "STANDARD", trigger: { triggerType: "WebhookV2" }, variables: [] } });
  w.s3Put(BUCKET, `build/${last}/release/overrides.json`, readFileSync(join(pkg, "overrides.json")));
  for (const img of [worker, slack]) w.answer(`ecr.describe-images.${img.repo.replace("/", "_")}.json`, { imageDetails: [{ imageDigest: img.digest, imageTags: [`tree-${repo.tree.slice(0, 12)}`, "pipe-x"] }] });
  w.answer("s3api.list-objects-v2.json", { Contents: [] });
  ghRuns(repo.tree);
}
const env = (extra: Record<string, string> = {}): Record<string, string> => ({ ...PIPE_ENV(w), RELEASE_SHA: repo.release, WORK: join(w.work, "decide-work"), GITHUB_API: ghBase, CI_WAIT_MINUTES: "0", CI_POLL_SECONDS: "0", ...extra });
const decide = (extra: Record<string, string> = {}, packRoot = PACK) => runPack(w, "evaluator/decide.sh", env(extra), [], w.work, packRoot);
const decision = (): any => JSON.parse(readFileSync(join(w.work, "out/decision.json"), "utf8"));
const input = (): any => JSON.parse(readFileSync(join(w.work, "decide-work/input.json"), "utf8"));

beforeEach(() => setup());
afterEach(() => w.cleanup());

describe("decide.sh: the assembly and the real evaluator together", () => {
  it("a routine release comes out AUTO, with the record Deploy re-checks", () => {
    const r = decide();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const d = decision();
    expect(d.reasons, JSON.stringify(d.reasons)).toEqual([]);
    expect(d.verdict).toBe("AUTO");
    expect(d.policy_hash).toBe(packPin(PACK));
    expect(d.record).toMatchObject({ execution: EXEC_ID, sha: repo.release, tree: repo.tree });
    expect(d.record.changeSets).toHaveLength(6);
    expect(d.record.changeSets.find((c: any) => c.stack === stack("runtime"))).toMatchObject({ changeSetName: CS, changeSetId: csId("runtime"), noChanges: false, templateSha256: canonSha({ Resources: { A: { Type: "AWS::SSM::Parameter", Properties: { Value: "runtime" } } } }) });
    expect(d.record.releasePackageSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("assembles the git facts from the bundle: tree, ancestry, changed paths, release notes", () => {
    decide();
    const i = input();
    expect(i).toMatchObject({ pipeline: "code", sha: repo.release, previousInstalledSha: repo.installed, tree: repo.tree, checkMode: "auto-eligible", unauditedAutoRuns: 0, holdParameters: [], trigger: { kind: "push", variables: {}, rollback: null }, ancestry: { installedIsAncestorOfSha: true } });
    expect(i.environment).toEqual({ accountId: ACCT, region: "us-west-2" });
    expect([...i.changedPaths].sort()).toEqual(["docs/release-notes/0.5.49.md", "packages/a.ts"]);
    expect(i.releaseNotes).toEqual([{ path: "docs/release-notes/0.5.49.md", text: "Fixes a small thing.\n" }]);
    expect(i.lock).toBeUndefined();
    expect(i.policyManifest.every((m: any) => m.path.startsWith("./"))).toBe(true);
    expect(i.policyManifest.map((m: any) => m.path)).toContain("./policy/auto-approve-policy.json");
    expect(i.policyPin).toBe(packPin(PACK));
  });

  it("a requires marker in the release notes makes it MANUAL", () => {
    w.cleanup();
    setup({ "docs/release-notes/0.5.49.md": "requires: run the backfill\n" });
    decide();
    const d = decision();
    expect(d.verdict).toBe("MANUAL");
    expect(JSON.stringify(d.reasons)).toContain("requires-marker");
  });

  it("a lockfile change brings both lock texts and the npm ci dry run", () => {
    w.cleanup();
    setup({ "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/x": { version: "1", resolved: "https://registry.npmjs.org/x/-/x-1.tgz", integrity: `sha512-${"A".repeat(86)}==` } } }) });
    decide();
    const i = input();
    expect(JSON.parse(i.lock.old).packages).toEqual({});
    expect(Object.keys(JSON.parse(i.lock.new).packages)).toEqual(["node_modules/x"]);
    expect(i.npmCiDryRun).toEqual({ ok: true, exitCode: 0 });
  });

  it("the pack's policy pin must match: a pack with one changed file is MANUAL", () => {
    const copy = copyPack(w);
    writeFileSync(join(copy, "policy/manual-paths.txt"), readFileSync(join(copy, "policy/manual-paths.txt"), "utf8") + "# edited\n");
    const r = decide({}, copy);
    expect(r.status).toBe(0);
    const d = decision();
    expect(d.verdict).toBe("MANUAL");
    expect(JSON.stringify(d.reasons)).toContain("pin-mismatch");
  });

  it("a symlink in the pack is refused (MANUAL, never AUTO)", () => {
    const copy = copyPack(w);
    symlinkSync("/etc/hosts", join(copy, "sneaky.sh"));
    decide({}, copy);
    const d = decision();
    expect(d.verdict).toBe("MANUAL");
    expect(JSON.stringify(d.reasons)).toMatch(/symlink|non-regular/);
  });

  it("MANUAL-ONLY pin, a HOLD, an older installed sha and a non-push trigger are each MANUAL", () => {
    w.answer("ssm.get-parameter._rovara-release_staging_policy-pin.json", { Parameter: { Value: "MANUAL-ONLY" } });
    decide();
    expect(decision().verdict).toBe("MANUAL");
    w.answer("ssm.get-parameter._rovara-release_staging_policy-pin.json", { Parameter: { Value: packPin(PACK) } });
    w.answer("ssm.get-parameters-by-path.json", { Parameters: [{ Name: "/rovara-release/staging/code-hold/x" }] });
    decide();
    expect(JSON.stringify(decision().reasons)).toContain('"code":"hold"');
    w.answer("ssm.get-parameters-by-path.json", { Parameters: [] });
    w.answer("codepipeline.get-pipeline-execution.rovara-staging-code-release.json", { pipelineExecution: { executionType: "STANDARD", trigger: { triggerType: "StartPipelineExecution" }, variables: [] } });
    decide();
    expect(JSON.stringify(decision().reasons)).toContain("trigger-kind");
    // an unreadable execution (no codepipeline read) is MANUAL too
    w.answer("codepipeline.get-pipeline-execution.rovara-staging-code-release.json", { __error: "AccessDeniedException", message: "no" });
    decide();
    expect(decision().verdict).toBe("MANUAL");
    // a non-default variable is MANUAL
    w.answer("codepipeline.get-pipeline-execution.rovara-staging-code-release.json", { pipelineExecution: { executionType: "STANDARD", trigger: { triggerType: "WebhookV2" }, variables: [{ name: "ONLY_PARTS", resolvedValue: "slack" }] } });
    decide();
    expect(JSON.stringify(decision().reasons)).toContain("variables-set");
  });

  it("CI evidence is matched by git tree: a green run on another tree, a fork, or a failed job is MANUAL; an API error is MANUAL", () => {
    ghRuns("0".repeat(40));
    decide();
    expect(JSON.stringify(decision().reasons)).toContain("ci-missing");
    ghRuns(repo.tree, { head_repository: { full_name: "evil/fork" } });
    decide();
    expect(JSON.stringify(decision().reasons)).toContain("ci-not-green");
    ghRuns(repo.tree);
    decide({ GITHUB_API: "http://127.0.0.1:1" });
    expect(JSON.stringify(decision().reasons)).toContain("ci-api-error");
  });

  it("refuses a release package that differs from the hash Preview recorded, and a bundle that is not the released commit", () => {
    w.s3Put(BUCKET, `build/${EXEC_ID}/release/answers.json`, JSON.stringify({ tampered: 1 }));
    decide();
    let d = decision();
    expect(d.verdict).toBe("MANUAL");
    expect(JSON.stringify(d.reasons)).toContain("differs from the one Preview recorded");
    w.cleanup();
    setup();
    const other = join(w.work, "other");
    mkdirSync(other, { recursive: true });
    const r2 = makeRepo(other, { "packages/b.ts": "x\n" });
    w.s3Put(BUCKET, `build/${EXEC_ID}/source.bundle`, readFileSync(r2.bundle));
    decide();
    d = decision();
    expect(d.verdict).toBe("MANUAL");
    expect(JSON.stringify(d.reasons)).toContain("not the released commit");
  });

  it("reads the change sets from CloudFormation: one that is not the recorded one is MANUAL", () => {
    w.answer(`cloudformation.describe-change-set.${stack("slack")}.${CS}.json`, { ChangeSetName: CS, ChangeSetId: csId("other"), Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE", Changes: [] });
    decide();
    const d = decision();
    expect(d.verdict).toBe("MANUAL");
    expect(JSON.stringify(d.reasons)).toContain("not the one Preview recorded");
  });

  it("counts unaudited AUTO runs from the run records and goes MANUAL past the limit", () => {
    const execs = ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000003", "aaaaaaaa-0000-4000-8000-000000000004", "aaaaaaaa-0000-4000-8000-000000000005"];
    for (const e of execs) { w.s3Put(BUCKET, `decide/${e}/decision.json`, JSON.stringify({ verdict: "AUTO" })); w.s3Put(BUCKET, `release/${e}/deploy.json`, "{}"); }
    w.s3Put(BUCKET, `89/${execs[0]}/audit-RESULT.md`, "AUDIT PASS");
    w.answer("s3api.list-objects-v2.json", "");
    decide();
    // the fake lists the real files under <bucket>/<prefix>: 5 AUTO executions deployed, 1 audited, so 4 are unaudited (> 3)
    const d = decision();
    expect(input().unauditedAutoRuns).toBe(4);
    expect(d.verdict).toBe("MANUAL");
    expect(JSON.stringify(d.reasons)).toContain("audit-backlog");
  });

  it("any failure to assemble is MANUAL with the reason, exit 0 (fail closed)", () => {
    w.answer("ssm.get-parameter._rovara-release_staging_code-installed.json", { __error: "ParameterNotFound", message: "x" });
    const r = decide();
    expect(r.status).toBe(0);
    const d = decision();
    expect(d.verdict).toBe("MANUAL");
    expect(JSON.stringify(d.reasons)).toContain("installed");
    expect(d.policy_hash).toBeNull();
  });
});
void [SLACK_URI];
