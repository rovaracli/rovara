/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- the tests read the JSON records the scripts write and edit plain JSON documents, which a typed document would not allow */
// The Build-side scripts (they run beside the repository's code): the asset packager, image reuse/build, the synth step and the answers/package step, against fakes.
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PACK, makeWorld, runPack, type World } from "./support/harness.ts";
import { ACCT, EXEC8, EXEC_ID, PIPE_ENV, SLACK_URI, WORKER_URI, sha256 } from "./support/fixtures.ts";

let w: World;
let repo: string;
let sha: string;
let fakebin: string;
const gitc = (...a: string[]): string => {
  const r = spawnSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
const put = (p: string, body: string): void => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body); };
const script = (name: string, body: string): void => { put(join(fakebin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(fakebin, name), 0o755); };

beforeEach(() => {
  w = makeWorld();
  repo = join(w.work, "checkout");
  mkdirSync(repo, { recursive: true });
  gitc("init", "-q", "-b", "main");
  put(join(repo, "environments/base/Dockerfile"), "FROM scratch\n");
  put(join(repo, "environments/slack/Dockerfile"), "FROM scratch\n");
  gitc("add", "-A"); gitc("commit", "-q", "-m", "c1");
  sha = gitc("rev-parse", "HEAD");
  fakebin = join(w.work, "fakebin");
  mkdirSync(fakebin, { recursive: true });
  // docker: records the call; buildx build writes the metadata file with a digest that depends on the --file
  script("docker", `echo "docker $*" >> "$FAKE_AWS_DIR/docker.log"
if [ "$1" = buildx ]; then meta=""; file=""; while [ $# -gt 0 ]; do case "$1" in --metadata-file) meta="$2";; --file) file="$2";; esac; shift; done
  case "$file" in *slack*) d=sha256:${"5".repeat(64)};; *) d=sha256:${"4".repeat(64)};; esac
  printf '{"containerimage.digest":"%s"}' "$d" > "$meta"; fi
exit 0`);
  script("npm", `echo "npm $*" >> "$FAKE_AWS_DIR/npm.log"; exit $(cat "$FAKE_AWS_DIR/npm.rc" 2>/dev/null || echo 0)`);
  // node: the synth (--import tsx ...) and the agentx CLI (packages/cli/dist/bin.js); anything else is an error
  script("node", `case "$1" in
  --import) env > "$FAKE_AWS_DIR/synth-env.txt"; mkdir -p "$CDK_OUTDIR"; cp "$FAKE_AWS_DIR/synth/"* "$CDK_OUTDIR/" 2>/dev/null; exit 0;;
  packages/cli/dist/bin.js) while [ $# -gt 0 ]; do [ "$1" = --answers-from-deployed ] && out="$2"; shift; done; cp "$FAKE_AWS_DIR/cli-answers.json" "$out"; exit 0;;
esac
echo "fake node: unexpected $*" >&2; exit 9`);
  w.answer("sts.get-caller-identity.json", { Account: ACCT });
});
afterEach(() => w.cleanup());
const out = (): string => join(w.work, "out");
const run = (script: string, extra: Record<string, string> = {}) =>
  runPack(w, script, { ...PIPE_ENV(w), RELEASE_SHA: sha, VERSION: "0.5.49", PATH: `${fakebin}:${w.bin}:${process.env.PATH ?? ""}`, ...extra }, [], repo);
const tree12 = (): string => gitc("rev-parse", "HEAD^{tree}").slice(0, 12);

describe("lib/package_assets.py", () => {
  const cdkOut = (): string => {
    const d = join(w.work, "cdk.out");
    const key = `${"a".repeat(64)}.zip`;
    put(join(d, "manifest.json"), "{}");
    put(join(d, "AgentXControlPlane.template.json"), "{}");
    put(join(d, `asset.${"a".repeat(64)}/index.js`), "console.log(1)");
    put(join(d, `asset.${"a".repeat(64)}/lib/b.js`), "b");
    put(join(d, "AgentXControlPlane.assets.json"), JSON.stringify({ files: {
      one: { source: { path: `asset.${"a".repeat(64)}`, packaging: "zip" }, destinations: { d: { objectKey: key } } },
      tpl: { source: { path: "AgentXControlPlane.template.json", packaging: "file" }, destinations: { d: { objectKey: `${"d".repeat(64)}.json` } } },
    } }));
    return d;
  };
  const pack = (d: string, pkg: string) => spawnSync("python3", ["-I", join(PACK, "lib/package_assets.py"), d, pkg], { encoding: "utf8" });
  it("zips deterministically, indexes sha256 and bytes, skips the template asset, copies the synth", () => {
    const d = cdkOut();
    const a = join(w.work, "pkg-a"), b = join(w.work, "pkg-b");
    expect(pack(d, a).status).toBe(0);
    expect(pack(d, b).status).toBe(0);
    const key = `${"a".repeat(64)}.zip`;
    expect(readFileSync(join(a, "assets", key)).equals(readFileSync(join(b, "assets", key)))).toBe(true);
    const idx = JSON.parse(readFileSync(join(a, "asset-index.json"), "utf8"));
    expect(Object.keys(idx)).toEqual([key]);
    expect(idx[key].sha256).toBe(sha256(readFileSync(join(a, "assets", key))));
    expect(existsSync(join(a, "synth/AgentXControlPlane.template.json"))).toBe(true);
    expect(existsSync(join(a, "assets", `${"d".repeat(64)}.json`))).toBe(false);
  });
  it("refuses a symlink inside an asset, a key that is not <64 hex>.<ext>, and a path outside the synth directory", () => {
    let d = cdkOut();
    symlinkSync("/etc/hosts", join(d, `asset.${"a".repeat(64)}/link`));
    expect(pack(d, join(w.work, "p1")).status).not.toBe(0);
    w.cleanup(); w = makeWorld(); d = cdkOut();
    const f = join(d, "AgentXControlPlane.assets.json");
    const doc = JSON.parse(readFileSync(f, "utf8"));
    doc.files.one.destinations.d.objectKey = "../../escape.zip";
    writeFileSync(f, JSON.stringify(doc));
    expect(pack(d, join(w.work, "p2")).status).not.toBe(0);
    doc.files.one.destinations.d.objectKey = `${"a".repeat(64)}.zip`;
    doc.files.one.source.path = "../elsewhere";
    writeFileSync(f, JSON.stringify(doc));
    expect(pack(d, join(w.work, "p3")).status).not.toBe(0);
  });
});

describe("build-images.sh", () => {
  it("reuses an image that already carries this tree's tag (no docker call), and never reuses the unique tag", () => {
    const aws = (uniqueFound: boolean): void => script("aws", `case "$*" in
  *"ecr describe-images"*"imageTag=pipe-"*) ${uniqueFound ? 'echo \'{"imageDetails":[{"imageDigest":"sha256:' + "9".repeat(64) + '"}]}\'; exit 0' : 'echo "An error occurred (ImageNotFoundException)" >&2; exit 254'};;
  *"ecr describe-images"*"imageTag=tree-"*"agentx-staging/slack"*|*"agentx-staging/slack"*"imageTag=tree-"*) echo '{"imageDetails":[{"imageDigest":"sha256:${"5".repeat(64)}","imageTags":["tree-${tree12()}"]}]}'; exit 0;;
  *"ecr describe-images"*"imageTag=tree-"*) echo '{"imageDetails":[{"imageDigest":"sha256:${"4".repeat(64)}","imageTags":["tree-${tree12()}"]}]}'; exit 0;;
  *"ecr describe-images"*"imageDigest="*) echo '{"imageDetails":[{"imageTags":["tree-${tree12()}"]}]}'; exit 0;;
esac
exec python3 -I "${w.bin}/fake-aws.py" "$@"`);
    aws(false);
    const r = run("build-images.sh");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(w.dir, "docker.log"))).toBe(false);
    expect(JSON.parse(readFileSync(join(out(), "images.json"), "utf8")).map((i: any) => i.source)).toEqual(["reused", "reused"]);
    aws(true);
    const again = run("build-images.sh");
    expect(again.status).toBe(3);
    expect(again.stderr).toContain("already exists");
  });
  it("builds and pushes with new unique tags when the tree has no image, and reads the tags back from ECR", () => {
    const calls = (): string => (existsSync(join(w.dir, "docker.log")) ? readFileSync(join(w.dir, "docker.log"), "utf8") : "");
    // first describe (by tag) fails, the describe by digest succeeds with the tree tag: the fake answers by file, so use an error file for tags and a digest file via a wrapper aws
    script("aws", `case "$*" in
  *"ecr describe-images"*"imageTag="*) echo "An error occurred (ImageNotFoundException)" >&2; exit 254;;
  *"ecr describe-images"*"imageDigest="*) echo '{"imageDetails":[{"imageTags":["tree-${tree12()}","pipe-${EXEC8}-${sha.slice(0, 9)}"]}]}'; exit 0;;
  *"ecr get-login-password"*) echo token; exit 0;;
esac
exec python3 -I "${w.bin}/fake-aws.py" "$@"`);
    const r = run("build-images.sh");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const log = calls();
    expect(log).toContain(`--tag ${ACCT}.dkr.ecr.us-west-2.amazonaws.com/agentx-staging/worker:pipe-${EXEC8}-${sha.slice(0, 9)}`);
    expect(log).toContain(`:tree-${tree12()}`);
    expect(log).toContain("--platform linux/arm64");
    const images = JSON.parse(readFileSync(join(out(), "images.json"), "utf8"));
    expect(images.map((i: any) => [i.key, i.source])).toEqual([["worker", "built"], ["slack", "built"]]);
    expect(readFileSync(join(out(), "image-args.txt"), "utf8")).toContain(`--worker-image ${WORKER_URI}`);
    expect(readFileSync(join(out(), "image-args.txt"), "utf8")).toContain(`--slack-image ${SLACK_URI}`);
  });
  it("survives a docker that exits without reading the ECR login password (a pipe would SIGPIPE the writer: exit 141 under pipefail)", () => {
    // regression for the flaky CI exit 141: the fake `docker` never reads stdin, and `aws ecr get-login-password` writes far more than a pipe buffer (256 KiB), so a
    // `aws ... | docker login --password-stdin` pipe kills the writer deterministically. The token is captured first and handed over without a pipe.
    script("aws", `case "$*" in
  *"ecr describe-images"*"imageTag="*) echo "An error occurred (ImageNotFoundException)" >&2; exit 254;;
  *"ecr describe-images"*"imageDigest="*) echo '{"imageDetails":[{"imageTags":["tree-${tree12()}","pipe-${EXEC8}-${sha.slice(0, 9)}"]}]}'; exit 0;;
  *"ecr get-login-password"*) head -c 262144 /dev/zero | tr '\\0' 'x'; echo; exit 0;;
esac
exec python3 -I "${w.bin}/fake-aws.py" "$@"`);
    for (let i = 0; i < 3; i++) {
      const r = run("build-images.sh");
      expect(r.status, r.stdout + r.stderr).toBe(0);
    }
  });
  it("refuses (exit 3) when the ECR login password cannot be read", () => {
    script("aws", `case "$*" in
  *"ecr describe-images"*"imageTag="*) echo "An error occurred (ImageNotFoundException)" >&2; exit 254;;
  *"ecr get-login-password"*) echo "denied" >&2; exit 255;;
esac
exec python3 -I "${w.bin}/fake-aws.py" "$@"`);
    const r = run("build-images.sh");
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("ECR login password");
  });
  it("refuses when HEAD is not the released commit", () => {
    expect(run("build-images.sh", { RELEASE_SHA: "c".repeat(40) }).status).toBe(3);
  });
});

describe("synth-diffs.sh", () => {
  it("synthesizes with no AWS credentials and the live gateway host as context; records the npm ci dry run", () => {
    mkdirSync(join(w.dir, "synth"), { recursive: true });
    writeFileSync(join(w.dir, "synth/manifest.json"), JSON.stringify({ artifacts: {} }));
    for (const c of ["AgentXAccess", "AgentXProductionFoundation", "AgentXIdentity", "AgentXProductionRuntime", "AgentXControlPlane", "AgentXSlackOrchestrator"]) writeFileSync(join(w.dir, "synth", `${c}.template.json`), JSON.stringify({ Resources: {} }));
    writeFileSync(join(w.dir, "synth/manifest.json"), JSON.stringify({ artifacts: Object.fromEntries(["AgentXAccess", "AgentXProductionFoundation", "AgentXIdentity", "AgentXProductionRuntime", "AgentXControlPlane", "AgentXSlackOrchestrator"].map((c) => [c, { properties: { templateFile: `${c}.template.json` } }])) }));
    for (const p of ["access", "foundation", "identity", "runtime", "control-plane", "slack"]) {
      w.answer(`cloudformation.describe-stacks.agentx-staging-${p}.json`, { Stacks: [{ Parameters: p === "control-plane" ? [{ ParameterKey: "CoreModelGatewayHost", ParameterValue: "gateway.example.test" }] : [] }] });
      w.answer(`cloudformation.get-template.agentx-staging-${p}.json`, { TemplateBody: { Resources: { A: { Type: "X" } } } });
    }
    writeFileSync(join(w.dir, "npm.rc"), "1");
    const r = run("synth-diffs.sh", { AWS_ACCESS_KEY_ID: ["AKIA", "FAKEFAKEFAKE0000"].join(""), AWS_SECRET_ACCESS_KEY: "x" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const env = readFileSync(join(w.dir, "synth-env.txt"), "utf8");
    expect(env).not.toMatch(/^AWS_ACCESS_KEY_ID=|^AWS_SECRET_ACCESS_KEY=|^AWS_REGION=|^AWS_PROFILE=/m);
    expect(env).toContain("AWS_EC2_METADATA_DISABLED=true");
    expect(JSON.parse(/^CDK_CONTEXT_JSON=(.*)$/m.exec(env)![1]!)).toEqual({ agentxEnv: "staging", agentxRegion: "us-west-2", CoreModelGatewayHost: "gateway.example.test" });
    expect(JSON.parse(readFileSync(join(out(), "npm-ci-dry-run.json"), "utf8"))).toEqual({ ok: false, exitCode: 1 });
    expect(readFileSync(join(w.dir, "npm.log"), "utf8")).toContain("npm ci --dry-run --ignore-scripts");
  });
});

describe("answers-from-deployed.sh", () => {
  const prep = (answers: object): void => {
    mkdirSync(join(out(), "release"), { recursive: true });
    mkdirSync(join(out(), "synth"), { recursive: true });
    writeFileSync(join(out(), "release/release.json"), "{}");
    writeFileSync(join(out(), "synth/manifest.json"), "{}");
    writeFileSync(join(out(), "npm-ci-dry-run.json"), JSON.stringify({ ok: true, exitCode: 0 }));
    writeFileSync(join(out(), "images.json"), JSON.stringify([{ repo: "agentx-staging/worker", digest: `sha256:${"4".repeat(64)}`, source: "built", key: "worker", uri: WORKER_URI }, { repo: "agentx-staging/slack", digest: `sha256:${"5".repeat(64)}`, source: "built", key: "slack", uri: SLACK_URI }]));
    writeFileSync(join(w.dir, "cli-answers.json"), JSON.stringify(answers));
  };
  it("writes answers and an overrides artifact that holds only the two image parameters, and assembles the package", () => {
    prep({ env: "staging", region: "us-west-2", account: ACCT, images: { worker: WORKER_URI } });
    const r = run("answers-from-deployed.sh");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(out(), "overrides.json"), "utf8"))).toEqual({ runtime: { WorkerImageUri: WORKER_URI }, slack: { OrchestratorImageUri: SLACK_URI } });
    for (const f of ["answers.json", "overrides.json", "images.json", "npm-ci-dry-run.json", "asset-index.json", "release.json"]) expect(existsSync(join(out(), "release", f)), f).toBe(true);
  });
  it("refuses answers for another account or region, and answers that hold something credential-shaped", () => {
    prep({ env: "staging", region: "us-west-2", account: "999999999999" });
    expect(run("answers-from-deployed.sh").status).toBe(3);
    prep({ env: "staging", region: "us-west-2", account: ACCT, github: { token: "ghp_" + "a".repeat(30) } });
    const r = run("answers-from-deployed.sh");
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("credential");
  });
});
void [sha256, EXEC_ID];
