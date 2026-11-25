// A fake aws, docker, crane and npx on the PATH for the L6 tests (the image step and the price gate), driven by a JSON scenario. Every call is logged as one JSON line
// (tool, profile, access key, DOCKER_CONFIG, args, stdin) so tests can pin the exact command shapes. No AWS, no network, no registry.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealPorts } from "../../ops/pipeline/ports.ts";
import type { Ports } from "../../ops/pipeline/types.ts";
import { config, FAKE_ACCOUNT, sha } from "./pipeline-stage-fakes.ts";

export const BETA_ACCOUNT = String(Number(FAKE_ACCOUNT) + 7);
export const BETA_PROFILE = "rovara-cloud-beta";
export const REGION = "us-east-1";
export const BETA_REPO = "rovara-cloud-beta-gateway-images-images2d38c313-aaaaaaaaaaaa";
export const PROD_REPO = "rovara-cloud-production-gateway-images-images2d38c313-bbbbbbbbbbbb";
export const registryOf = (account: string): string => `${account}.dkr.ecr.${REGION}.amazonaws.com`;
export const PASSWORD = "very-secret-registry-password";
export const T0 = Date.UTC(2026, 10, 24, 12, 0, 0);

export interface Scenario {
  /** account by AWS_PROFILE ("" = no profile) */
  accounts: Record<string, string>;
  stacks: Record<string, { status?: string; parameters?: Record<string, string>; outputs?: Record<string, string> }>;
  resources: Array<{ LogicalResourceId: string; ResourceType: string; PhysicalResourceId: string }>;
  /** repository name -> tag -> digest */
  ecr: Record<string, Record<string, string>>;
  /** repository name -> digests present without a tag */
  ecrDigests: Record<string, string[]>;
  pushDigest: string;
  /** What `model-gateway-image.ts context` reports as the build-context hash. */
  contextSha256: string;
  /** `context` prints its JSON line and then exits with this code. */
  contextExit: number;
  /** `context` prints a JSON line without a hash, and a plain-text line, BEFORE its real answer. */
  contextNoise: boolean;
  /** What `build` prints as its context hash line: the same hash, another one, or none. */
  buildHash: "same" | "other" | "none";
  /** What `git rev-parse HEAD` answers in the candidate tree, and what `git status --porcelain` lists there. */
  head: string;
  dirty: string;
  /** What `git status --porcelain --ignored` lists under the gateway source. */
  ignored: string;
  pushReportsDigest: string | null;
  pushFails: boolean;
  buildExit: number;
  platform: string;
  craneCopyExit: number;
  craneCopyDigest: string | null;
  craneDigestOverride: string | null;
  logEvents: number[];
  eventsAfterRunTask: number[];
  targets: unknown;
  runTask: unknown;
  describeTasks: unknown[];
}

export const emptyScenario = (): Scenario => ({
  accounts: { "": FAKE_ACCOUNT, [BETA_PROFILE]: BETA_ACCOUNT }, stacks: {}, resources: [], ecr: {}, ecrDigests: {}, pushDigest: `sha256:${"c".repeat(64)}`, contextSha256: "a".repeat(64), contextExit: 0, contextNoise: false, buildHash: "same", head: sha("4"), dirty: "", ignored: "", pushReportsDigest: null, pushFails: false,
  buildExit: 0, platform: "linux/arm64", craneCopyExit: 0, craneCopyDigest: null, craneDigestOverride: null, logEvents: [], eventsAfterRunTask: [], targets: null, runTask: null, describeTasks: [],
});

const SCRIPT = `#!/usr/bin/env node
const fs = require("fs");
const dir = process.env.FAKE_DIR;
const tool = require("path").basename(process.argv[1]);
const args = process.argv.slice(2);
const sc = JSON.parse(fs.readFileSync(dir + "/scenario.json", "utf8"));
const save = () => fs.writeFileSync(dir + "/scenario.json", JSON.stringify(sc));
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch {}
const profile = process.env.AWS_PROFILE || "";
fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify({ tool, profile, key: process.env.AWS_ACCESS_KEY_ID || "", dockerConfig: process.env.DOCKER_CONFIG || "", cwd: process.cwd(), args, stdin }) + "\\n");
const out = (o) => { process.stdout.write(typeof o === "string" ? o : JSON.stringify(o)); process.exit(0); };
const fail = (msg, code = 254) => { process.stderr.write(msg + "\\n"); process.exit(code); };
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const notFound = () => fail("An error occurred (ImageNotFoundException) when calling the DescribeImages operation: image not found");
const repoTag = (ref) => { const rest = ref.slice(ref.indexOf("/") + 1); const i = rest.lastIndexOf(":"); return [rest.slice(0, i), rest.slice(i + 1)]; };
if (tool === "aws") {
  const cmd = args[0] + " " + args[1];
  if (cmd === "sts get-caller-identity") out({ Account: sc.accounts[profile] ?? sc.accounts[""] });
  if (cmd === "sts assume-role") out({ Credentials: { AccessKeyId: "AKIAFAKE", SecretAccessKey: "s", SessionToken: "t" } });
  if (cmd === "cloudformation describe-stacks") {
    const s = sc.stacks[flag("--stack-name")];
    if (!s) fail("An error occurred (ValidationError): Stack with id x does not exist");
    out({ Stacks: [{ StackStatus: s.status || "UPDATE_COMPLETE", Parameters: Object.entries(s.parameters || {}).map(([k, v]) => ({ ParameterKey: k, ParameterValue: v })), Outputs: Object.entries(s.outputs || {}).map(([k, v]) => ({ OutputKey: k, OutputValue: v })) }] });
  }
  if (cmd === "cloudformation list-stack-resources") out({ StackResourceSummaries: sc.resources });
  if (cmd === "ecr get-authorization-token") { const a = sc.accounts[profile] ?? sc.accounts[""]; out({ authorizationData: [{ authorizationToken: Buffer.from("AWS:" + ${JSON.stringify("PASSWORD_PLACEHOLDER")}).toString("base64"), proxyEndpoint: "https://" + a + ".dkr.ecr.${REGION}.amazonaws.com" }] }); }
  if (cmd === "ecr describe-images") {
    const repo = flag("--repository-name"); const id = flag("--image-ids");
    const tags = sc.ecr[repo] || {};
    if (id.startsWith("imageTag=")) { const d = tags[id.slice(9)]; if (!d) notFound(); out({ imageDetails: [{ imageDigest: d, imagePushedAt: "2026-11-20T12:00:00+00:00", imageTags: Object.entries(tags).filter(([, v]) => v === d).map(([k]) => k) }] }); }
    const d = id.slice(12);
    if (!Object.values(tags).includes(d) && !(sc.ecrDigests[repo] || []).includes(d)) notFound();
    out({ imageDetails: [{ imageDigest: d, imageTags: Object.entries(tags).filter(([, v]) => v === d).map(([k]) => k) }] });
  }
  if (cmd === "logs filter-log-events") { const start = Number(flag("--start-time")); out({ events: sc.logEvents.filter((t) => t >= start).map((t) => ({ timestamp: t, message: "{}" })) }); }
  if (cmd === "events list-targets-by-rule") out(sc.targets);
  if (cmd === "ecs run-task") { if (sc.runTask && sc.runTask.tasks) { sc.logEvents.push(...sc.eventsAfterRunTask); save(); } out(sc.runTask); }
  if (cmd === "ecs describe-tasks") { const r = sc.describeTasks.length > 1 ? sc.describeTasks.shift() : sc.describeTasks[0]; save(); out(r); }
  fail("fake aws: unhandled " + args.join(" "), 1);
}
if (tool === "docker") {
  if (args[0] === "login") out("Login Succeeded\\n");
  if (args[0] === "image") out(sc.platform + "\\n");
  if (args[0] === "tag") out("");
  if (args[0] === "push") {
    if (sc.pushFails) fail("tag invalid: The image tag already exists in the repository and cannot be overwritten because the repository is immutable", 1);
    const [repo, tag] = repoTag(args[1]);
    sc.ecr[repo] = sc.ecr[repo] || {}; sc.ecr[repo][tag] = sc.pushDigest; save();
    out(tag + ": digest: " + (sc.pushReportsDigest || sc.pushDigest) + " size: 1\\n");
  }
}
if (tool === "crane") {
  if (args[0] === "auth") out("logged in\\n");
  if (args[0] === "copy") {
    if (sc.craneCopyExit !== 0) fail("copy failed", sc.craneCopyExit);
    const [repo, tag] = repoTag(args[2]); sc.ecr[repo] = sc.ecr[repo] || {}; sc.ecr[repo][tag] = sc.craneCopyDigest || args[1].slice(args[1].indexOf("@") + 1); save(); out("copied\\n");
  }
  if (args[0] === "digest") { const [repo, tag] = repoTag(args[1]); out((sc.craneDigestOverride || (sc.ecr[repo] || {})[tag]) + "\\n"); }
}
if (tool === "git") {
  if (args[0] === "rev-parse" && args[1] === "HEAD") out(sc.head + "\\n");
  if (args[0] === "status") out(args.includes("--ignored") ? sc.ignored : sc.dirty);
}
if (tool === "npx") {
  if (args.includes("context")) {
    const o = flag("--out");
    // as assembleContext does: a directory that is not empty is refused; otherwise the context is written there
    if (fs.existsSync(o) && fs.readdirSync(o).length > 0) fail("the output directory is not empty", 1);
    fs.mkdirSync(o, { recursive: true }); fs.writeFileSync(o + "/Dockerfile", "x");
    if (sc.contextNoise) process.stdout.write('{"warn":"a banner that is JSON but has no hash"}\\nsome plain text line\\n');
    process.stdout.write(JSON.stringify({ out: o, files: 3, totalBytes: 10, contextSha256: sc.contextSha256, entryPresent: true }) + "\\n");
    process.exit(sc.contextExit);
  }
  if (sc.buildExit !== 0) fail("tsc: build error", sc.buildExit);
  if (sc.buildHash !== "none") process.stdout.write(JSON.stringify({ contextSha256: sc.buildHash === "same" ? sc.contextSha256 : "b".repeat(64), files: 3 }) + "\\n");
  out("built\\n");
}
fail("fake " + tool + ": unhandled " + args.join(" "), 1);
`.replace('"PASSWORD_PLACEHOLDER"', JSON.stringify(PASSWORD)).replace(/\$\{REGION\}/gu, REGION);

export interface Call { tool: string; profile: string; key: string; dockerConfig: string; cwd: string; args: string[]; stdin: string }

export interface Harness {
  dir: string;
  scenario: Scenario;
  write(): void;
  reset(): void;
  calls(): Call[];
  /** One line per call: `tool arg arg` (the aws region/output tail is dropped). */
  lines(): string[];
  ports(env: "beta" | "production"): Ports;
  restorePath(): void;
}

/** Real ports over fake binaries, with a fake clock so no test sleeps. */
export function makeHarness(): Harness {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "l6-fake-")));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "cloud"));
  for (const name of ["aws", "docker", "crane", "npx", "git"]) { writeFileSync(join(dir, "bin", name), SCRIPT); chmodSync(join(dir, "bin", name), 0o755); }
  writeFileSync(join(dir, "calls.jsonl"), "");
  const oldPath = process.env.PATH;
  process.env.PATH = `${join(dir, "bin")}:${oldPath}`;
  process.env.FAKE_DIR = dir;
  const oldProfile = process.env.AWS_PROFILE;
  delete process.env.AWS_PROFILE;
  const h: Harness = {
    dir,
    scenario: emptyScenario(),
    write: () => { writeFileSync(join(dir, "scenario.json"), JSON.stringify(h.scenario)); },
    reset: () => { writeFileSync(join(dir, "calls.jsonl"), ""); },
    calls: () => readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Call),
    lines: () => h.calls().map((c) => `${c.tool} ${c.args.join(" ").replace(/ --region [^ ]+ --output json$/u, "")}`),
    ports: (env) => {
      const real = createRealPorts({ config, env, region: REGION, exec8: "1a2b3c4d", profile: env === "beta" ? BETA_PROFILE : null, cwd: dir });
      let now = T0;
      return { ...real, clock: { now: () => new Date(now), sleep: (ms) => { now += ms; return Promise.resolve(); } } };
    },
    restorePath: () => { process.env.PATH = oldPath; delete process.env.FAKE_DIR; if (oldProfile !== undefined) process.env.AWS_PROFILE = oldProfile; },
  };
  h.write();
  return h;
}
