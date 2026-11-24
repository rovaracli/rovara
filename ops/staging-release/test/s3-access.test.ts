/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- the tests read JSON records */
// F2: derive, from the scripts themselves, which runs-bucket objects each pipeline stage reads, lists and writes, and keep the answer in s3-access.json (the shape the Code P1
// contract test reads: stages.<stage>.{read,list,write} as <stage>/<exec>/... paths). The derivation RUNS each stage script against the fake CLI and reads the fake's call log, so it
// follows helpers and scripts called from scripts (the Gates stage's dry run of deploy.sh counts as the Gates stage's reads). What a stage writes = the files it leaves in RUN_DIR
// (the buildspec uploads them to <stage>/<exec>/) plus any direct `s3 cp` upload. A recursive `s3 cp` also LISTS (list entry) and reads everything under it (`<prefix>*`).
// Regenerate after a script's S3 use changes:  UPDATE_S3_ACCESS=1 vitest run ops/staging-release/test/s3-access.test.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PACK, copyPack, makeWorld, runPack, type World } from "./support/harness.ts";
import { BUCKET, EXEC_ID, PIPE_ENV, SHA, SLACK_URI, WORKER_URI, dirHash, liveParams, stack, writeChangeSets, writePackage, writePointers, writeRunRecords, writeStacks } from "./support/fixtures.ts";

const FILE = join(PACK, "s3-access.json");
interface Access { read: string[]; list: string[]; write: string[] }
const uniq = (a: string[]): string[] => [...new Set(a)].sort();
const norm = (k: string): string => k.split(EXEC_ID).join("<exec>").replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<prior-exec>").replace(/^ci-cache\/.*$/, "ci-cache/<key>.json");

function files(dir: string, base = dir): string[] {
  try {
    return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n), base) : [join(dir, n).slice(base.length + 1)]));
  } catch { return []; }
}

function derive(upload: string, calls: string[], outDir: string, extraReads: string[] = [], extraLists: string[] = []): Access {
  const read: string[] = [...extraReads], list: string[] = [...extraLists], write: string[] = [];
  const keyOf = (u: string): string => u.replace(/^s3:\/\/[^/]+\//, "");
  for (const line of calls) {
    const parts = line.split(" ");
    if (line.startsWith("s3 cp")) {
      const urls = parts.filter((x) => x.startsWith("s3://") && !x.includes("cdk-hnb659fds-assets-"));
      const fromS3 = !parts[parts.length - 1]!.startsWith("s3://") && !parts[parts.length - 1]!.startsWith("--");
      const dest = parts.filter((x) => !x.startsWith("--"));
      const download = fromS3 && dest.length >= 4 && !dest[dest.length - 1]!.startsWith("s3://");
      for (const u of urls) {
        const k = norm(keyOf(u));
        if (download) { if (line.includes("--recursive")) { const dir = k.replace(/\/?$/, "/"); list.push(dir); read.push(`${dir}*`); } else read.push(k); } else write.push(k);
      }
    } else if (line.startsWith("s3api list-objects-v2") && !line.includes("cdk-hnb659fds-assets-")) {
      list.push(norm(/ --prefix (\S+)/.exec(line)?.[1] ?? ""));
    }
  }
  for (const rel of files(outDir)) write.push(`${upload}/<exec>/${rel}`);
  return { read: uniq(read), list: uniq(list), write: uniq(write) };
}

let w: World;
afterEach(() => w?.cleanup());
const env = (extra: Record<string, string> = {}): Record<string, string> => ({ ...PIPE_ENV(w), ...extra });
const sh = (script: string, e: Record<string, string>, root: string = PACK) => runPack(w, script, e, [], w.work, root);
const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const outDir = (): string => join(w.work, "out");

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function scenarios(): Record<string, Access> {
  const out: Record<string, Access> = {};
  // check and build: P1's own inline stages (not pack scripts); their S3 use is fixed by the buildspec
  out.check = { read: [], list: [], write: ["check/<exec>/check.json", "check/<exec>/version.txt"] };
  out.build = { read: ["check/<exec>/version.txt"], list: [], write: ["build/<exec>/release/answers.json", "build/<exec>/release/overrides.json", "build/<exec>/release/images.json", "build/<exec>/source.bundle"] };
  // preview (P1's packStage also downloads the release package recursively and, for Preview, the source bundle and version.txt)
  {
    w = makeWorld();
    const pkg = writePackage(join(w.work, "release"));
    writeStacks(w); writeChangeSets(w);
    mkdirSync(outDir(), { recursive: true });
    writeFileSync(join(outDir(), "release.sha256"), dirHash(pkg) + "\n");
    const r = sh("preview.sh", env({ SYNTH_DIR: pkg }));
    expect(r.status, r.stderr).toBe(0);
    out.preview = derive("preview", w.calls(), outDir(), ["build/<exec>/source.bundle", "check/<exec>/version.txt", "build/<exec>/release/*"], ["build/<exec>/release/"]);
    out.preview.write = uniq(out.preview.write.filter((p) => p !== "preview/<exec>/tmp"));
    w.cleanup();
  }
  // gates (stub gates; the real dry run of deploy.sh)
  {
    w = makeWorld();
    const pkg = writePackage(join(w.work, "release"));
    writeStacks(w); writeChangeSets(w); writePointers(w); writeRunRecords(w, pkg);
    for (const f of ["decide/decision.json", "guard/guard.json", "gates/gates/15-gate.json", "gates/gates/25-gate.json", "gates/gates/45-gate.json", "gates/gates/46-gate.json", "89/RESULT.md"]) rmSync(join(w.dir, "s3", BUCKET, f.split("/")[0]!, EXEC_ID, ...f.split("/").slice(1)));
    const root = copyPack(w);
    for (const n of ["15-role-sim.sh", "25-change-set-gates.sh", "45-checks.sh", "gate-gateway-deployed.sh"]) writeFileSync(join(root, "gates", n), "#!/usr/bin/env bash\nexit 0\n");
    writeFileSync(join(w.dir, "curl.code"), "200");
    writeFileSync(join(w.dir, "curl.body"), JSON.stringify({ ok: true, runPrice: { version: 1, admissionVersion: 1, snapshotVersion: 9 } }));
    w.answer("cloudformation.describe-stacks.agentx-staging-control-plane.json", { Stacks: [{ StackStatus: "UPDATE_COMPLETE", Parameters: [], Outputs: [] }] });
    const r = sh("gates.sh", env({ GATEWAY_HEALTHZ_URL: "https://gateway.example.test/healthz" }), root);
    expect(r.status, r.stderr).toBe(0);
    out.gates = derive("gates", w.calls(), outDir());
    w.cleanup();
  }
  // guard (a MANUAL decision reads the 89 RESULT), then a real deploy
  {
    w = makeWorld();
    const pkg = writePackage(join(w.work, "release"));
    writeStacks(w); writeChangeSets(w); writeRunRecords(w, pkg); writePointers(w);
    const result = readFileSync(join(w.dir, "s3", BUCKET, "89", EXEC_ID, "RESULT.md"));
    w.answer("codepipeline.get-pipeline-execution.rovara-staging-code-release.json", { pipelineExecution: { executionType: "STANDARD" } });
    w.answer("codepipeline.list-action-executions.rovara-staging-code-release.json", { actionExecutionDetails: [{ stageName: "Approve", actionName: "ApproveDeploy", status: "Succeeded", updatedBy: "arn:aws:sts::111111111111:assumed-role/rovara-staging-code-rel-approver/c", output: { executionResult: { externalExecutionSummary: `READY ${SHA} sha256=${sha256(result)}` } } }] });
    const g = sh("guard.sh", env());
    expect(g.status, g.stderr).toBe(0);
    // P1's packStage (synth "verify") also downloads preview/<exec>/release.sha256 before guard.sh and deploy.sh run
    out.guard = derive("guard", w.calls(), outDir(), ["build/<exec>/release/*", "preview/<exec>/release.sha256"], ["build/<exec>/release/"]);
    rmSync(outDir(), { recursive: true });
    const before = w.calls().length;
    const d = sh("deploy.sh", env({ SYNTH_DIR: pkg }));
    expect(d.status, d.stdout + d.stderr).toBe(0);
    out.deploy = derive("release", w.calls().slice(before), outDir(), ["build/<exec>/release/*", "preview/<exec>/release.sha256"], ["build/<exec>/release/"]);
    // settings-record.sh runs in the same Deploy stage after deploy.sh and leaves settings-record.json in the same RUN_DIR (it reads no S3)
    out.deploy.write = uniq([...out.deploy.write, "release/<exec>/settings-record.json"]);
    w.cleanup();
  }
  // postcheck
  {
    w = makeWorld();
    const pkg = writePackage(join(w.work, "release"));
    writeRunRecords(w, pkg);
    w.s3Put(BUCKET, `release/${EXEC_ID}/deploy.json`, JSON.stringify({ ok: true, sha: SHA, execution: EXEC_ID, finishedAt: "2026-11-23T12:00:00Z" }));
    writeStacks(w);
    for (const [part, key, uri] of [["runtime", "WorkerImageUri", WORKER_URI], ["slack", "OrchestratorImageUri", SLACK_URI]] as const) w.answer(`cloudformation.describe-stacks.${stack(part)}.json`, { Stacks: [{ StackStatus: "UPDATE_COMPLETE", Parameters: liveParams(part).map((p) => (p.ParameterKey === key ? { ...p, ParameterValue: uri } : p)), Outputs: [] }] });
    w.answer(`cloudformation.list-stack-resources.${stack("control-plane")}.json`, { StackResourceSummaries: [{ ResourceType: "AWS::Lambda::Function", PhysicalResourceId: "fn" }] });
    w.answer("lambda.get-function-configuration.fn.json", { State: "Active", LastUpdateStatus: "Successful" });
    w.answer("cloudwatch.get-metric-statistics.json", { Datapoints: [] });
    w.answer(`cloudformation.list-stack-resources.${stack("slack")}.json`, { StackResourceSummaries: [{ ResourceType: "AWS::ECS::Service", PhysicalResourceId: "svc" }, { ResourceType: "AWS::ECS::Cluster", PhysicalResourceId: "cl" }] });
    w.answer("ecs.describe-services.json", { services: [{ status: "ACTIVE", desiredCount: 1, runningCount: 1, deployments: [{ rolloutState: "COMPLETED" }] }] });
    w.answer("cloudformation.describe-stack-events.json", { StackEvents: [] });
    writePointers(w);
    writeFileSync(join(w.dir, "curl.code"), "200");
    const r = sh("postcheck.sh", env({ POSTCHECK_WATCH_MINUTES: "0", POSTCHECK_SLEEP_SECONDS: "0", SLACK_ROLLOUT_WAIT_SECONDS: "0", JWKS_URL: "https://api.example.test/jwks" }));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    out.postcheck = derive("release", w.calls(), outDir());
    w.cleanup();
  }
  // decide: a real run with a real bundle; CI is unreachable (CI_WAIT_MINUTES=0), which does not change which S3 objects are touched
  {
    w = makeWorld();
    const root = join(w.work, "r");
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.ts"), "1\n"); git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "c1");
    const installed = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "a.ts"), "2\n"); git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "c2");
    git(repo, "tag", "v0.5.49");
    const release = git(repo, "rev-parse", "HEAD");
    git(repo, "bundle", "create", join(root, "source.bundle"), "HEAD", "v0.5.49");
    const pkg = writePackage(join(w.work, "release"));
    writeRunRecords(w, pkg, { verdict: "AUTO", sha: release, installed });
    w.s3Put(BUCKET, `build/${EXEC_ID}/source.bundle`, readFileSync(join(root, "source.bundle")));
    const pv = JSON.parse(readFileSync(join(w.dir, "s3", BUCKET, `preview/${EXEC_ID}/preview.json`), "utf8"));
    pv.sha = release; writeFileSync(join(w.dir, "s3", BUCKET, `preview/${EXEC_ID}/preview.json`), JSON.stringify(pv));
    w.s3Put(BUCKET, `gates/${EXEC_ID}/gates/25-gate.json`, JSON.stringify({ name: "25-gate", sha: release, writtenAt: "2026-11-23T12:00:00Z", result: "pass", failures: [] }));
    writeStacks(w); writeChangeSets(w); writePointers(w, installed);
    w.answer("ssm.get-parameter._rovara-release_staging_code-last-good-execution.json", { Parameter: { Value: "11111111-1111-4111-8111-111111111111" } });
    w.s3Put(BUCKET, "build/11111111-1111-4111-8111-111111111111/release/answers.json", "{}");
    w.s3Put(BUCKET, "build/11111111-1111-4111-8111-111111111111/release/overrides.json", "{}");
    w.s3Put(BUCKET, "decide/22222222-2222-4222-8222-222222222222/decision.json", JSON.stringify({ verdict: "AUTO" }));
    w.s3Put(BUCKET, "release/22222222-2222-4222-8222-222222222222/deploy.json", "{}");
    // 2222 is deployed and unaudited (its decision is READ to count it); 3333 is audited (skipped)
    w.s3Put(BUCKET, "decide/33333333-3333-4333-8333-333333333333/decision.json", JSON.stringify({ verdict: "AUTO" }));
    w.s3Put(BUCKET, "release/33333333-3333-4333-8333-333333333333/deploy.json", "{}");
    w.s3Put(BUCKET, "89/33333333-3333-4333-8333-333333333333/audit-RESULT.md", "x");
    w.answer("ecr.describe-images.json", { imageDetails: [{ imageDigest: "sha256:" + "4".repeat(64), imageTags: ["x"] }] });
    w.answer("codepipeline.get-pipeline-execution.rovara-staging-code-release.json", { pipelineExecution: { executionType: "STANDARD", trigger: { triggerType: "WebhookV2" } } });
    const r = sh("evaluator/decide.sh", env({ RELEASE_SHA: release, WORK: join(w.work, "dw"), GITHUB_API: "http://127.0.0.1:1", CI_WAIT_MINUTES: "0", CI_POLL_SECONDS: "0" }));
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(outDir(), "decision.json"), "utf8")).record.changeSets.length, "the assembly must get as far as the change sets").toBeGreaterThan(0);
    out.decide = derive("decide", w.calls(), outDir());
    // the cache object is written only when CI is green (not reached here): its path is fixed by the assembly's cache key
    out.decide.read = uniq([...out.decide.read, "ci-cache/<key>.json"]);
    out.decide.write = uniq([...out.decide.write.filter((p) => !p.startsWith("decide/<exec>/evaluator-input")), "ci-cache/<key>.json"]);
    w.cleanup();
  }
  // P9's canary and rollback run as node programs (canary/ and rollback/), not through the shell shim, so their S3 use is read from their source (checked below): the canary lists the
  // ledger and puts one claim object per canary and uploads result.json/summary.txt; the rollback guard / explicit rollback read a TARGET execution's canary result and package record.
  out.canary = { read: [], list: ["canary-ledger/"], write: ["canary-ledger/*", "canary/<exec>/result.json", "canary/<exec>/summary.txt"] };
  out.rollback = { read: ["canary/<prior-exec>/result.json", "preview/<prior-exec>/release.sha256"], list: ["build/<prior-exec>/release/"], write: [] };
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

describe("s3-access.json: what each stage's scripts read, list and write in the runs bucket", () => {
  it("is exactly what the scripts do (regenerate with UPDATE_S3_ACCESS=1 when a script's S3 use changes; the Code P1 contract test asserts its role grants against this file)", () => {
    const doc = { version: 1, note: "Derived by ops/staging-release/test/s3-access.test.ts from the pack's scripts run against the fake CLI: the paths each stage reads, lists and writes in the runs bucket, as <stage>/<exec>/... (a recursive cp lists and reads everything under its prefix: `<prefix>*`). The Code P1 contract test compares the CodeBuild roles' grants with it.", stages: scenarios() };
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    if (process.env.UPDATE_S3_ACCESS === "1") writeFileSync(FILE, text);
    expect(readFileSync(FILE, "utf8")).toBe(text);
  });

  it("the P9 entries (canary, rollback) match what P9's source does: the paths are still in canary/ and rollback/", () => {
    const rb = readFileSync(join(PACK, "rollback/src/aws.ts"), "utf8");
    expect(rb).toContain("`canary/${executionId}/result.json`");
    expect(rb).toContain("`preview/${executionId}/release.sha256`");
    expect(rb).toContain("`build/${executionId}/release/`");
    expect(readFileSync(join(PACK, "canary/src/config.ts"), "utf8")).toContain('LEDGER_PREFIX = "canary-ledger/"');
    const cn = readFileSync(join(PACK, "canary/src/aws.ts"), "utf8");
    expect(cn).toContain("list-objects-v2");
    expect(cn).toContain("put-object");
    // and nothing else in the two programs touches S3 (a new s3api call must be added to the file above)
    const calls = new Set<string>();
    for (const f of ["canary/src/aws.ts", "rollback/src/aws.ts"]) for (const m of readFileSync(join(PACK, f), "utf8").matchAll(/"s3api", "([a-z0-9-]+)"/g)) calls.add(m[1]!);
    expect([...calls].sort()).toEqual(["get-object", "list-objects-v2", "put-object"]);
  });

  it("covers the facts the review found missing at P1 aced7bebf", () => {
    const { stages } = JSON.parse(readFileSync(FILE, "utf8")) as { stages: Record<string, Access> };
    const stagesRead = (r: string): string[] => uniq(stages[r]!.read.map((p) => p.split("/")[0]!));
    expect(stagesRead("deploy")).toEqual(expect.arrayContaining(["guard", "89", "gates", "decide", "preview", "check", "build"]));
    expect(stages.deploy!.list).toEqual(expect.arrayContaining(["gates/<exec>/gates/", "build/<exec>/release/"]));
    expect(stagesRead("gates")).toEqual(expect.arrayContaining(["check", "preview", "build"]));
    expect(stages.gates!.list).toEqual(expect.arrayContaining(["preview/<exec>/", "build/<exec>/release/"]));
    expect(stagesRead("postcheck")).toEqual(expect.arrayContaining(["check", "release", "build", "preview"]));
    expect(stagesRead("guard")).toEqual(expect.arrayContaining(["89", "decide", "check"]));
    expect(stages.guard!.read).toContain("preview/<exec>/release.sha256");
    // Decide reads OTHER runs' decisions to count unaudited AUTO runs: without this grant it would silently undercount
    expect(stages.decide!.read).toContain("decide/<prior-exec>/decision.json");
    expect(stages.decide!.list).toEqual(expect.arrayContaining(["release/", "89/", "decide/"]));
  });
});
