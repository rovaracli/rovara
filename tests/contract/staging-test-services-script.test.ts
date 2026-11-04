// Test services slice 1: scripts/staging-test-services-e2e.sh (written, not run against staging). Staging workers are not SSM-managed, so the script must use no SSM at all: the Rovara API, the staging guard for read-only AWS
// calls, and the worker's own self-report lines in CloudWatch Logs. It is run here END TO END against fakes: a fake curl that serves canned Rovara API answers (with the real answer shapes: TestEnvironmentState for
// propose/check/prove, `{ task }` for the dev task routes), a fake staging guard, and canned CloudWatch lines. One run drives the success path through every step; then each step is broken in each way it can fail, and must say FAIL
// (or, where only a person can supply the input, OPERATOR). Nothing passes on a missing field, an empty answer, a timeout or an error.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_SERVICES_AWS_USAGE_PROBLEMS, TEST_SERVICES_AWS_USAGE_WORDS } from "@agentx/contracts";

const SCRIPT = new URL("../../scripts/staging-test-services-e2e.sh", import.meta.url).pathname;
const code = readFileSync(SCRIPT, "utf8").split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");

const PROJECT = "sample";
const BASE = `/v1/app/projects/${PROJECT}/test-environment`;
const DIGEST = "a".repeat(64);
const TASK = "11111111-2222-4333-8444-555555555555";
const CANCEL_TASK = "99999999-2222-4333-8444-555555555555";
const PIN = `sha256:${"b".repeat(64)}`;
const PIN_AWS = `sha256:${"d".repeat(64)}`;
const FACTS = { metadataBlocked: true, runWalls: true, ipv6Drops: true, prepull: "ok", prepulled: 1, loggedOut: true, dockerVersion: "25.0.5" };
const start = (over: Record<string, unknown> = {}) => ({ component: "worker", event: "test-services.report", phase: "worker_start", outcome: "booted", leftoverContainers: 0, leftoverNetworks: 0, runDirEmpty: true, runDirTmpfs: true, workingSandboxPaused: null, sweptContainers: 0, sweptNetworks: 0, bootFacts: FACTS, ...over });
const end = (over: Record<string, unknown> = {}) => ({ component: "worker", event: "test-services.report", phase: "run_end", outcome: "completed", leftoverContainers: 0, leftoverNetworks: 0, runDirEmpty: true, runDirTmpfs: true, workingSandboxPaused: false, ...over });

/** The check entries of the escape project's five tests, as the evidence lists them. */
const TESTS = ["internet", "ipv6", "neighbours", "planted-state", "relay"];
const entries = (over: Record<string, string> = {}) => TESTS.map((name) => ({ id: `readiness:${name}`, label: `node --test tests/${name}.test.js`, source: "project", before: "passed", after: over[name] ?? "passed", output: "" }));
const evidence = (over: { checks?: unknown[]; pr?: string; blocked?: string } = {}) => JSON.stringify({
  checks: over.checks ?? entries(),
  pullRequestLines: [over.pr ?? "Integration tests ran against: Postgres (real)."],
  environment: { blocked: over.blocked ?? "Blocked by environment: 3 calls to names no dependency answers: example.com (2), example.net (1)" },
});

/** An event with a moment: `ageMs` before now (default: just after the script starts, so inside every window), shown only after the cancel call when `afterCancel`. */
const timed = (event: unknown, options: { ageMs?: number; afterCancel?: boolean } = {}) => ({ __timed: true, event, ...options });
interface Reply { status: number; body?: unknown; curlFails?: boolean }
const state = (proposal: Record<string, unknown> | undefined) => ({ draft: { status: "ready", notes: [], questions: [], pendingServices: [] }, ...(proposal === undefined ? {} : { proposal }) });
const dependency = { id: "postgres-main", name: "Postgres", kind: "database", family: "postgres", found: [{ kind: "detector", file: "package.json", line: 3 }], usedBy: ["working", "task_check"], backing: { kind: "local", catalogId: "postgres@16" }, connect: { env: [], hostAliases: ["postgres"] }, seeds: [], reset: "between_checks" };
const proposal = (over: Record<string, unknown> = {}) => ({ digest: DIGEST, source: "setup", risk: "low", environment: { dependencies: [dependency] }, proved: false, proveSteps: [], check: { status: "unchecked" }, ...over });
const proved = (steps: Array<{ step: string; status: string }>, check: Record<string, unknown> = { status: "ready" }) => state(proposal({ proveSteps: steps, check, proved: true }));
const PASSED_STEPS = [{ step: "install", status: "passed" }, { step: "dependencies", status: "passed" }, { step: "dependency_usage", status: "passed" }];
const view = (status: string, id = TASK) => ({ task: { taskId: id, status, title: "t", project: "escape", createdAt: new Date(Date.now() - 5 * 60_000).toISOString() } });

interface Scenario {
  routes: Record<string, Reply[]>;
  events: unknown[];
  /** What the guard prints for each call (a string), or makes fail (an Error message). */
  account: string;
  digests: string;
  /** What the guard prints for the local-aws repository (slice 2). */
  awsDigests?: string;
  guardFailsLogs?: string;
  logsText?: string;
  catalogPin?: string | null;
  awsCatalogPin?: string | null;
}
const scenario = (): Scenario => ({
  routes: {
    [`POST ${BASE}/propose`]: [{ status: 200, body: state(proposal()) }],
    [`POST ${BASE}/check`]: [{ status: 202, body: state(proposal({ check: { status: "checking" } })) }],
    [`POST ${BASE}/prove`]: [{ status: 200, body: state(proposal({ check: { status: "checking" } })) }, { status: 200, body: proved(PASSED_STEPS) }],
    "POST /v1/dev/tasks": [{ status: 201, body: { task: { taskId: TASK, status: "STARTING" } } }, { status: 201, body: { task: { taskId: CANCEL_TASK, status: "STARTING" } } }],
    [`GET /v1/dev/tasks/${TASK}`]: [{ status: 200, body: view("RUNNING") }, { status: 200, body: view("SUCCEEDED") }],
    [`GET /v1/dev/tasks/${CANCEL_TASK}`]: [{ status: 200, body: view("RUNNING", CANCEL_TASK) }, { status: 200, body: view("CANCELLED", CANCEL_TASK) }],
    [`POST /v1/dev/tasks/${CANCEL_TASK}/cancel`]: [{ status: 200, body: view("CANCELLED", CANCEL_TASK) }],
  },
  events: [start({ sweptContainers: 2, sweptNetworks: 1 }), end(), timed(end({ outcome: "cancelled" }), { afterCancel: true })],
  account: "944937319445",
  digests: PIN,
  catalogPin: PIN,
});

const FAKE_CURL = `#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
out = method = data = url = header = None
i = 0
while i < len(a):
    if a[i] == "-o": out = a[i + 1]; i += 2
    elif a[i] == "-w": i += 2
    elif a[i] == "-X": method = a[i + 1]; i += 2
    elif a[i] == "-H":
        if a[i + 1].startswith("@"): header = open(a[i + 1][1:]).read()
        i += 2
    elif a[i] == "--data": data = a[i + 1]; i += 2
    elif a[i] == "--max-time": i += 2
    elif a[i].startswith("-"): i += 1
    else: url = a[i]; i += 1
d = os.environ["FAKE_DIR"]
path = "/" + url.split("//", 1)[1].split("/", 1)[1]
key = method + " " + path
open(d + "/curl.log", "a").write(json.dumps({"key": key, "data": data, "bearer": bool(header and header.startswith("Authorization: Bearer ")), "argv": a}) + "\\n")
routes = json.load(open(d + "/routes.json"))
if key not in routes:
    sys.stderr.write("fake curl: no route " + key + "\\n"); print("404"); open(out, "w").write(json.dumps({"error": "no route"})); sys.exit(0)
counter = d + "/count-" + key.replace("/", "_").replace(" ", "_")
n = int(open(counter).read()) if os.path.exists(counter) else 0
open(counter, "w").write(str(n + 1))
replies = routes[key]
reply = replies[min(n, len(replies) - 1)]
if reply.get("curlFails"): sys.stderr.write("curl: (7) failed to connect\\n"); sys.exit(7)
open(out, "w").write(json.dumps(reply["body"]) if "body" in reply and reply["body"] is not None else "")
print(reply["status"])
`;

function run(s: Scenario, args: string[], env: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "tse-script-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(join(directory, "routes.json"), JSON.stringify(s.routes));
  const normalised = s.events.map((entry) => {
    const wrapped = typeof entry === "object" && entry !== null && "__timed" in entry ? entry as unknown as { event: unknown; ageMs?: number; afterCancel?: boolean } : { event: entry };
    return { message: JSON.stringify(wrapped.event), at: Date.now() - (wrapped.ageMs ?? -60_000), afterCancel: wrapped.afterCancel === true };
  });
  writeFileSync(join(directory, "events.json"), JSON.stringify(normalised));
  if (s.logsText !== undefined) writeFileSync(join(directory, "logs.raw"), s.logsText);
  writeFileSync(join(bin, "curl"), FAKE_CURL);
  writeFileSync(join(bin, "sleep"), "#!/bin/bash\nexit 0\n");
  const guard = join(directory, "staging-aws.sh");
  writeFileSync(join(directory, "logs.py"), [
    "import glob, json, os, sys",
    "d = os.environ['FAKE_DIR']",
    "a = sys.argv[1:]",
    "since = int(a[a.index('--start-time') + 1])",
    "if os.path.exists(d + '/logs.raw'): sys.stdout.write(open(d + '/logs.raw').read()); sys.exit(0)",
    "cancelled = bool(glob.glob(d + '/count-POST__v1_dev_tasks_*_cancel'))",
    "print(json.dumps([e['message'] for e in json.load(open(d + '/events.json')) if e['at'] >= since and (cancelled or not e['afterCancel'])]))",
  ].join("\n"));
  writeFileSync(guard, [
    "#!/bin/bash",
    `echo "$*" >> "${directory}/guard.log"`,
    'case "$*" in',
    ...(s.guardFailsLogs === undefined ? [] : [`  *"logs filter-log-events"*) echo "${s.guardFailsLogs}" >&2; exit 254 ;;`]),
    `  *"logs filter-log-events"*) python3 "${directory}/logs.py" "$@" ;;`,
    `  *"sts get-caller-identity"*) echo ${s.account} ;;`,
    `  *"ecr describe-images"*"svc/local-aws"*) echo "${s.awsDigests ?? PIN_AWS}" ;;`,
    `  *"ecr describe-images"*) echo "${s.digests}" ;;`,
    "  *) echo unexpected >&2; exit 9 ;;",
    "esac",
  ].join("\n"));
  for (const file of [join(bin, "curl"), join(bin, "sleep"), guard]) chmodSync(file, 0o755);
  const token = join(directory, "token");
  writeFileSync(token, "not-a-real-token-value");
  chmodSync(token, 0o600);
  const catalog = join(directory, "catalog.json");
  writeFileSync(catalog, JSON.stringify({ entries: [{ id: "postgres@16", image: s.catalogPin === null ? { repository: "svc/postgres" } : { repository: "svc/postgres", digest: s.catalogPin ?? PIN } }, { id: "local-aws@r1", image: s.awsCatalogPin === null ? { repository: "svc/local-aws" } : { repository: "svc/local-aws", digest: s.awsCatalogPin ?? PIN_AWS } }] }));
  const ran = spawnSync("/bin/bash", [SCRIPT, ...args], {
    encoding: "utf8", timeout: 90_000,
    env: {
      PATH: `${bin}:${process.env["PATH"] ?? ""}`, HOME: directory, TMPDIR: directory, FAKE_DIR: directory, STAGING_AWS: guard, STAGING_E2E_OWNER_GO: "yes", ROVARA_STAGING_URL: "https://api.staging.example.test",
      ROVARA_STAGING_HOST_REGEX: "^api\\.staging\\.example\\.test$", ROVARA_STAGING_TOKEN_FILE: token, ROVARA_STAGING_PROJECT: PROJECT, TSE_CATALOG_FILE: catalog,
      TSE_POLL_PROVE: "4", TSE_POLL_TASK: "4", TSE_POLL_REPORTS: "2", TSE_POLL_RUNNING: "3", ...env,
    },
  });
  const read = (name: string) => { try { return readFileSync(join(directory, name), "utf8"); } catch { return ""; } };
  const evidenceFile = join(directory, "evidence.json");
  return { out: ran.stdout, err: ran.stderr, status: ran.status, curl: read("curl.log").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { key: string; data: string | null; bearer: boolean; argv: string[] }), guard: read("guard.log"), directory, evidenceFile };
}
/** Runs with an evidence file written next to the fakes. */
function runWith(s: Scenario, evidenceText: string | undefined, args: string[], env: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "tse-evidence-"));
  const file = join(directory, "evidence.json");
  if (evidenceText !== undefined) writeFileSync(file, evidenceText);
  return run(s, evidenceText === undefined ? args : [...args, "--evidence", file], env);
}
const line = (out: string, step: string) => out.split("\n").find((entry) => entry.startsWith(`TSE ${step} `)) ?? "";
const verdictOf = (out: string, step: string) => /^TSE \S+ (PASS|FAIL|OPERATOR)/u.exec(line(out, step))?.[1] ?? "none";

describe("the script uses no SSM and nothing but reads on AWS", () => {
  it("has no ssm command, no commands=[...] shorthand and no root command on a worker; every AWS call goes through the staging guard and is a read; the token is never in an argument", () => {
    expect(code).not.toMatch(/\bssm\b|send-command|get-command-invocation|AWS-RunShellScript|commands=\[/iu);
    expect(code).not.toMatch(/docker (ps|network|images|exec)|iptables/u);
    const awsCalls = [...code.matchAll(/\$STAGING"? aws ([a-z0-9-]+ [a-z0-9-]+)/gu)].map((match) => match[1]);
    expect(new Set(awsCalls)).toEqual(new Set(["sts get-caller-identity", "ecr describe-images", "logs filter-log-events"]));
    // (The embedded Python helper is not shell: its strings are not AWS calls.)
    const shell = code.replace(/<<'PY'[\s\S]*?\nPY\n/u, "");
    expect(shell.match(/(?<![\w-])aws(?![\w-])/gu)?.length).toBe(awsCalls.length);
    expect(code).not.toMatch(/--data[^\n]*(token|Bearer)/iu);
  });

  it("refuses to start without the owner's go, an https URL naming the staging API, a mode-600 token file, and the staging host pattern; an unknown --only step exits non-zero", () => {
    const s = scenario();
    expect(run(s, [], { STAGING_E2E_OWNER_GO: "" }).status).toBe(3);
    expect(run(s, [], { ROVARA_STAGING_URL: "http://api.staging.example.test" }).status).toBe(3);
    expect(run(s, [], { ROVARA_STAGING_URL: "https://api.prod.example.test" }).status).toBe(3);
    expect(run(s, [], { ROVARA_STAGING_URL: "https://10.0.0.1" }).status).toBe(3);
    expect(run(s, [], { ROVARA_STAGING_HOST_REGEX: "" }).status).toBe(3);
    const unknown = run(s, ["--only", "P1,99"]);
    expect(unknown.status).toBe(2);
    expect(unknown.out).not.toContain("PASS");
    expect(run(s, ["--only", "nope"]).status).toBe(2);
    expect(run(s, ["--cancel-test"]).status).toBe(2);
    expect(run(s, ["--require-heartbeat"]).status).toBe(2);
  });
});

describe("the success path, end to end", () => {
  it("drives every step through the fake API, guard and reports and says PASS for each; only the person's steps are left", () => {
    const s = scenario();
    const r = runWith(s, evidence(), ["--escape-project", "escape", "--expect-outcome", "completed", "--cancel-test", "--expect-swept"]);
    for (const step of ["P0", "P1", "P2", "P3", "P4", "1", "2", "3", "4", "5", "6", "L3", "7", "7c", "7k"]) expect(verdictOf(r.out, step), `${step}\n${r.out}\n${r.err}`).toBe("PASS");
    expect(verdictOf(r.out, "8")).toBe("OPERATOR");
    expect(verdictOf(r.out, "9")).toBe("OPERATOR");
    expect(r.out).toContain("TSE SUMMARY pass=15 fail=0 operator=2");
    expect(r.status).toBe(1);
    // The steps really called the API in order, with the digest from the proposal, and the bearer header came from a file.
    const keys = r.curl.map((call) => call.key);
    expect(keys.slice(0, 3)).toEqual([`POST ${BASE}/propose`, `POST ${BASE}/check`, `POST ${BASE}/prove`]);
    expect(r.curl.find((call) => call.key === `POST ${BASE}/check`)?.data).toContain(DIGEST);
    expect(r.curl.find((call) => call.key === `POST ${BASE}/prove`)?.data).toContain(DIGEST);
    expect(keys).toContain("POST /v1/dev/tasks");
    expect(keys).toContain(`GET /v1/dev/tasks/${TASK}`);
    expect(keys).toContain(`POST /v1/dev/tasks/${CANCEL_TASK}/cancel`);
    expect(r.curl.every((call) => call.bearer)).toBe(true);
    expect(JSON.stringify(r.curl)).not.toContain("not-a-real-token-value");
    // The task prompt makes the working phase plant and start the heartbeat.
    const startBody = JSON.parse(r.curl.find((call) => call.key === "POST /v1/dev/tasks")!.data!) as { instructions: string; project: string };
    expect(startBody.project).toBe("escape");
    expect(startBody.instructions).toContain("npm run plant");
    expect(startBody.instructions).toContain("npm run setup");
    // AWS: only reads, and P4 looked back further than this script's start while the run reports did not.
    expect(r.guard).toContain("sts get-caller-identity");
    expect(r.guard).toContain("ecr describe-images --repository-name rovara-catalog/staging/svc/postgres");
    expect(r.guard).not.toMatch(/ssm|send-command/u);
    const starts = [...r.guard.matchAll(/--start-time (\d+)/gu)].map((match) => Number(match[1]));
    expect(Math.min(...starts)).toBeLessThan(Date.now() - 24 * 3600 * 1000);
  });

  it("the old subshell bug cannot return: API_STATUS is read in the shell that made the call (the success path would die on an unbound variable otherwise)", () => {
    expect(code).not.toMatch(/=\$\(api /u);
    const r = runWith(scenario(), evidence(), ["--only", "1,2"]);
    expect(r.err).not.toMatch(/unbound variable/u);
    expect(verdictOf(r.out, "1")).toBe("PASS");
    expect(verdictOf(r.out, "2")).toBe("PASS");
  });
});

describe("P0-P4 preconditions", () => {
  it("P1 fails for another account or a guard that fails; P2 for no image or a guard error; P3 for a pin the repository lacks or no pin at all", () => {
    expect(verdictOf(run({ ...scenario(), account: "123456789012" }, ["--only", "P1"]).out, "P1")).toBe("FAIL");
    expect(verdictOf(run({ ...scenario(), account: "" }, ["--only", "P1"]).out, "P1")).toBe("FAIL");
    expect(verdictOf(run({ ...scenario(), digests: "" }, ["--only", "P2,P3"]).out, "P2")).toBe("FAIL");
    expect(verdictOf(run({ ...scenario(), digests: "" }, ["--only", "P2,P3"]).out, "P3")).toBe("FAIL");
    expect(verdictOf(run({ ...scenario(), digests: `sha256:${"c".repeat(64)}` }, ["--only", "P3"]).out, "P3")).toBe("FAIL");
    expect(verdictOf(run({ ...scenario(), catalogPin: null }, ["--only", "P3"]).out, "P3")).toBe("FAIL");
    expect(verdictOf(run(scenario(), ["--only", "P1,P2,P3"]).out, "P3")).toBe("PASS");
  });

  it("P4: boot facts all true, pre-pull ok and logged out, nothing left, the run directory empty and a tmpfs: PASS; any one wrong, no report at all, a Docker that could not be asked, an unreadable log: FAIL", () => {
    const read = (events: unknown[]) => run({ ...scenario(), events }, ["--only", "P4"]);
    expect(read([start()]).out).toMatch(/TSE P4 PASS/u);
    // The window reaches back: a worker that started an hour (or two days) ago is still seen; one older than the window is not.
    expect(read([timed(start(), { ageMs: 3_600_000 })]).out).toMatch(/TSE P4 PASS/u);
    expect(read([timed(start(), { ageMs: 48 * 3_600_000 })]).out).toMatch(/TSE P4 PASS/u);
    expect(read([timed(start(), { ageMs: 100 * 3_600_000 })]).out).toMatch(/TSE P4 FAIL.*no worker_start report/u);
    for (const [change, words] of [
      [{ bootFacts: { ...FACTS, metadataBlocked: false } }, "metadataBlocked"], [{ bootFacts: { ...FACTS, runWalls: false } }, "runWalls"], [{ bootFacts: { ...FACTS, ipv6Drops: false } }, "ipv6Drops"],
      [{ bootFacts: { ...FACTS, loggedOut: false } }, "loggedOut"], [{ bootFacts: { ...FACTS, prepull: "failed" } }, "prepull failed"], [{ bootFacts: { ...FACTS, prepull: "none" } }, "prepull none"], [{ bootFacts: { ...FACTS, prepulled: 0 } }, "nothing pre-pulled"],
      [{ bootFacts: "absent" }, "boot facts"], [{ bootFacts: "unreadable" }, "boot facts"], [{ leftoverContainers: 1 }, "leftover"], [{ leftoverNetworks: 2 }, "leftover"], [{ leftoverContainers: null }, "leftover"], [{ runDirEmpty: false }, "run directory not empty"],
      [{ runDirTmpfs: false }, "not a tmpfs"], [{ runDirTmpfs: null }, "not a tmpfs"],
    ] as const) {
      const r = read([start(change)]);
      expect(r.out, JSON.stringify(change)).toMatch(/TSE P4 FAIL/u);
      expect(r.out, JSON.stringify(change)).toContain(words);
    }
    expect(read([]).out).toMatch(/TSE P4 FAIL.*no worker_start report/u);
    expect(read([end()]).out).toMatch(/TSE P4 FAIL.*no worker_start report/u);
    expect(run({ ...scenario(), guardFailsLogs: "AccessDenied" }, ["--only", "P4"]).out).toMatch(/TSE P4 FAIL.*(log read failed|AccessDenied)/u);
    expect(run({ ...scenario(), logsText: "this is not json" }, ["--only", "P4"]).out).toMatch(/TSE P4 FAIL/u);
    expect(run({ ...scenario(), logsText: JSON.stringify(["not a json line", "{}"]) }, ["--only", "P4"]).out).toMatch(/TSE P4 FAIL.*no worker_start report/u);
  });
});

describe("1 and 2: the proposal and Prove, read from TestEnvironmentState", () => {
  const one = (replies: Reply[]) => { const s = scenario(); s.routes[`POST ${BASE}/propose`] = replies; return run(s, ["--only", "1"]); };

  it("1: PASS reads proposal.digest and proposal.environment.dependencies; a missing digest, the old top-level shape, no Postgres, a Postgres without a source line, a non-local backing, a 500, a curl failure: FAIL", () => {
    expect(verdictOf(one([{ status: 200, body: state(proposal()) }]).out, "1")).toBe("PASS");
    const bad: Array<[string, Reply]> = [
      ["no digest", { status: 200, body: state(proposal({ digest: undefined })) }], ["no proposal", { status: 200, body: state(undefined) }],
      ["the old top-level shape", { status: 200, body: { digest: DIGEST, dependencies: [dependency] } }], ["no dependencies key", { status: 200, body: state(proposal({ environment: {} })) }],
      ["no postgres", { status: 200, body: state(proposal({ environment: { dependencies: [{ ...dependency, family: "redis" }] } })) }],
      ["no source line", { status: 200, body: state(proposal({ environment: { dependencies: [{ ...dependency, found: [] }] } })) }],
      ["a non-local backing", { status: 200, body: state(proposal({ environment: { dependencies: [{ ...dependency, backing: { kind: "fake" } }] } })) }],
      ["an empty answer", { status: 200 }], ["a 500", { status: 500, body: { error: "x" } }], ["a 401", { status: 401, body: {} }], ["curl failing", { status: 0, curlFails: true }],
    ];
    for (const [label, reply] of bad) expect(verdictOf(one([reply]).out, "1"), label).toBe("FAIL");
    expect(verdictOf(one([{ status: 404, body: {} }]).out, "1")).toBe("OPERATOR");
  });

  it("2: needs step 1's digest in the same run; a check that is refused, a failed check, a missing or failed step, an error and a Prove that never finishes are FAILs", () => {
    const two = (mutate: (routes: Scenario["routes"]) => void, args = ["--only", "1,2"]) => { const s = scenario(); mutate(s.routes); return run(s, args); };
    expect(verdictOf(run(scenario(), ["--only", "2"]).out, "2")).toBe("FAIL");
    expect(verdictOf(two(() => undefined).out, "2")).toBe("PASS");
    const prove = (reply: Reply[]) => (routes: Scenario["routes"]) => { routes[`POST ${BASE}/prove`] = reply; };
    const cases: Array<[string, (routes: Scenario["routes"]) => void]> = [
      ["the check is refused", (routes) => { routes[`POST ${BASE}/check`] = [{ status: 409, body: {} }]; }],
      ["the check failed", prove([{ status: 200, body: proved(PASSED_STEPS, { status: "failed", failedStep: "start dependencies" }) }])],
      ["dependency_usage missing", prove([{ status: 200, body: proved([{ step: "dependencies", status: "passed" }]) }])],
      ["dependency_usage failed", prove([{ status: 200, body: proved([{ step: "dependencies", status: "passed" }, { step: "dependency_usage", status: "failed" }]) }])],
      ["dependencies skipped", prove([{ status: 200, body: proved([{ step: "dependencies", status: "skipped" }, { step: "dependency_usage", status: "passed" }]) }])],
      ["ready with no steps", prove([{ status: 200, body: state(proposal({ check: { status: "ready" } })) }])],
      ["never finishes", prove([{ status: 200, body: state(proposal({ check: { status: "checking" } })) }])],
      ["a 500 every time", prove([{ status: 500, body: {} }])],
      ["an unreadable answer", prove([{ status: 200, body: "nope" }])],
      ["curl failing", prove([{ status: 0, curlFails: true }])],
    ];
    for (const [label, change] of cases) expect(verdictOf(two(change).out, "2"), label).toBe("FAIL");
  });
});

describe("3: a task on the escape project", () => {
  const three = (mutate: (routes: Scenario["routes"]) => void, args = ["--escape-project", "escape", "--only", "3"]) => { const s = scenario(); mutate(s.routes); return run(s, args); };

  it("PASS when the task ends SUCCEEDED; FAIL for FAILED, CANCELLED, INTERRUPTED, CLOSED, a timeout, a status the contract does not have, an HTTP error, a start that answers no task id or an error; OPERATOR with no project and no task", () => {
    expect(verdictOf(three(() => undefined).out, "3")).toBe("PASS");
    const get = (replies: Reply[]) => (routes: Scenario["routes"]) => { routes[`GET /v1/dev/tasks/${TASK}`] = replies; };
    for (const status of ["FAILED", "CANCELLED", "INTERRUPTED", "CLOSED"]) expect(verdictOf(three(get([{ status: 200, body: view(status) }])).out, "3"), status).toBe("FAIL");
    expect(verdictOf(three(get([{ status: 200, body: view("RUNNING") }])).out, "3")).toBe("FAIL");
    expect(three(get([{ status: 200, body: view("RUNNING") }])).out).toMatch(/TSE 3 FAIL.*did not end/u);
    for (const reply of [{ status: 200, body: view("COMPLETED") }, { status: 200, body: view("READY_FOR_REVIEW") }, { status: 500, body: {} }, { status: 200, body: { task: {} } }, { status: 0, curlFails: true }] as Reply[]) {
      expect(verdictOf(three(get([reply])).out, "3"), JSON.stringify(reply)).toBe("FAIL");
    }
    expect(verdictOf(three((routes) => { routes["POST /v1/dev/tasks"] = [{ status: 500, body: {} }]; }).out, "3")).toBe("FAIL");
    expect(verdictOf(three((routes) => { routes["POST /v1/dev/tasks"] = [{ status: 201, body: { task: {} } }]; }).out, "3")).toBe("FAIL");
    expect(verdictOf(three((routes) => { routes["POST /v1/dev/tasks"] = [{ status: 201, body: {} }]; }).out, "3")).toBe("FAIL");
    expect(verdictOf(three(() => undefined, ["--only", "3"]).out, "3")).toBe("OPERATOR");
  });
});

describe("4, 5, 6 and L3: the escape tests by name, the PR line, the blocked-calls line", () => {
  const verdicts = (evidenceText: string | undefined, over: Partial<Scenario> = {}, args: string[] = []) => runWith({ ...scenario(), ...over }, evidenceText, ["--task", TASK, "--only", "4,5,6,L3", ...args]);

  it("all five tests passed by name and the run_end is completed: PASS for 4, 5, 6 and L3", () => {
    const r = verdicts(evidence());
    for (const step of ["4", "5", "6", "L3"]) expect(verdictOf(r.out, step), r.out).toBe("PASS");
  });

  it("4: a test with no entry, a failed or skipped entry, and entries that are all failed are FAILs naming the test; entries with the wrong labels are a FAIL, not a pass; no entries at all is an OPERATOR line", () => {
    for (const name of TESTS) {
      const missing = verdicts(evidence({ checks: entries().filter((entry) => !entry.label.includes(name)) }));
      expect(verdictOf(missing.out, "4")).toBe("FAIL");
      expect(line(missing.out, "4")).toContain(`tests/${name}.test.js`);
      expect(verdictOf(verdicts(evidence({ checks: entries({ [name]: "failed" }) })).out, "4"), name).toBe("FAIL");
      expect(verdictOf(verdicts(evidence({ checks: entries({ [name]: "skipped" }) })).out, "4"), name).toBe("FAIL");
      expect(verdictOf(verdicts(evidence({ checks: entries({ [name]: "timed_out" }) })).out, "4"), name).toBe("FAIL");
    }
    expect(verdictOf(verdicts(evidence({ checks: [{ id: "x", label: "npm test", after: "passed" }] })).out, "4")).toBe("FAIL");
    expect(verdictOf(verdicts(evidence({ checks: [] })).out, "4")).toBe("OPERATOR");
    expect(verdictOf(verdicts("not json at all").out, "4")).toBe("OPERATOR");
    expect(verdictOf(runWith(scenario(), undefined, ["--only", "4"]).out, "4")).toBe("OPERATOR");
  });

  it("4: every check passed but the worker's run_end says checks_failed, failed or cancelled, or there is none, or the log cannot be read: FAIL", () => {
    for (const outcome of ["checks_failed", "failed", "cancelled"]) expect(verdictOf(verdicts(evidence(), { events: [end({ outcome })] }).out, "4"), outcome).toBe("FAIL");
    expect(verdictOf(verdicts(evidence(), { events: [] }).out, "4")).toBe("FAIL");
    expect(verdictOf(verdicts(evidence(), { events: [start()] }).out, "4")).toBe("FAIL");
    expect(verdictOf(verdicts(evidence(), { guardFailsLogs: "ThrottlingException" }).out, "4")).toBe("FAIL");
  });

  it("5: the PR line must be there; 6: the blocked line must be there, with a count, example.com and example.net, no full lookup name and no token-like word", () => {
    expect(verdictOf(verdicts(evidence({ pr: "Integration tests ran against: nothing." })).out, "5")).toBe("FAIL");
    expect(verdictOf(verdicts(evidence({ pr: "Integration tests ran against: Postgres (real)" })).out, "5")).toBe("FAIL");
    expect(verdictOf(verdicts(evidence({ blocked: "nothing was blocked" })).out, "6")).toBe("FAIL");
    expect(verdictOf(verdicts(evidence({ blocked: "Blocked by environment: 3 calls to names no dependency answers: example.com (2), unknown-ab12cd34.example.net (1)" })).out, "6")).toBe("FAIL");
    expect(verdictOf(verdicts(evidence({ blocked: "Blocked by environment: 1 call: example.com (1)" })).out, "6")).toBe("FAIL");
    expect(verdictOf(verdicts(evidence({ blocked: "Blocked by environment: example.com, example.net" })).out, "6")).toBe("FAIL");
    expect(verdictOf(verdicts(evidence({ blocked: `Blocked by environment: 2 calls: example.com (1), example.net (1) ${"a".repeat(30)}` })).out, "6")).toBe("FAIL");
    // A task view that holds neither line (no evidence file) is a FAIL for both, not a pass.
    const bare = verdicts(undefined);
    expect(verdictOf(bare.out, "5")).toBe("FAIL");
    expect(verdictOf(bare.out, "6")).toBe("FAIL");
  });

  it("L3: the relay check missing, failed or skipped is a FAIL (it cannot skip)", () => {
    expect(verdictOf(verdicts(evidence({ checks: entries({ relay: "skipped" }) })).out, "L3")).toBe("FAIL");
    expect(verdictOf(verdicts(evidence({ checks: entries({ relay: "failed" }) })).out, "L3")).toBe("FAIL");
    expect(verdictOf(verdicts(evidence({ checks: entries().filter((entry) => !entry.label.includes("relay")) })).out, "L3")).toBe("FAIL");
  });
});

describe("7: teardown, from the worker's run_end reports", () => {
  const seven = (events: unknown[], args: string[] = [], over: Partial<Scenario> = {}) => run({ ...scenario(), events, ...over }, ["--task", TASK, "--only", "7", ...args]);

  it("run_end reports with nothing left, an empty tmpfs run directory and a sandbox not paused pass; every other shape fails", () => {
    expect(seven([end(), end({ outcome: "failed" }), end({ outcome: "checks_failed" })]).out).toMatch(/TSE 7 PASS.*completed,failed,checks_failed/u);
    for (const [change, words] of [
      [{ leftoverNetworks: 1 }, "leftover objects"], [{ leftoverContainers: null }, "leftover objects"], [{ runDirEmpty: false }, "run directory not empty"], [{ runDirEmpty: null }, "run directory not empty"],
      [{ runDirTmpfs: false }, "not a tmpfs"], [{ runDirTmpfs: null }, "not a tmpfs"], [{ workingSandboxPaused: true }, "left paused"], [{ workingSandboxPaused: null }, "left paused or unknown"], [{ outcome: "weird" }, "unknown outcome"],
    ] as const) {
      const r = seven([end(change)]);
      expect(r.out, JSON.stringify(change)).toMatch(/TSE 7 FAIL/u);
      expect(r.out, JSON.stringify(change)).toContain(words);
    }
    expect(seven([end()], ["--expect-outcome", "cancelled"]).out).toMatch(/TSE 7 FAIL.*no cancelled run reported/u);
    expect(seven([end({ outcome: "cancelled" })], ["--expect-outcome", "cancelled"]).out).toMatch(/TSE 7 PASS/u);
  });

  it("no report after polling, a log that cannot be read, or one that is not JSON: FAIL (for a task already run), and OPERATOR only before any task was run", () => {
    expect(seven([]).out).toMatch(/TSE 7 FAIL.*no run_end report/u);
    expect(seven([start()]).out).toMatch(/TSE 7 FAIL/u);
    expect(seven([], [], { guardFailsLogs: "AccessDenied" }).out).toMatch(/TSE 7 FAIL.*log read failed/u);
    expect(seven([], [], { logsText: "garbage" }).out).toMatch(/TSE 7 FAIL/u);
    expect(run({ ...scenario(), events: [] }, ["--only", "7"]).out).toMatch(/TSE 7 OPERATOR/u);
    const window = seven([end()]);
    const fromTask = Number(/--start-time (\d+)/u.exec(window.guard)![1]);
    expect(fromTask).toBeLessThan(Date.now() - 4 * 60_000);
  });

  it("7k: a restarted worker's start report shows what the sweep removed and that nothing is left; nothing swept, something left, or no report fail", () => {
    const k = (events: unknown[]) => run({ ...scenario(), events }, ["--only", "7k", "--expect-swept"]);
    expect(k([start({ sweptContainers: 2, sweptNetworks: 1 })]).out).toMatch(/TSE 7k PASS killed worker is swept.*removed 3/u);
    expect(k([start()]).out).toMatch(/TSE 7k FAIL/u);
    expect(k([start({ sweptContainers: 1, leftoverContainers: 1 })]).out).toMatch(/TSE 7k FAIL/u);
    expect(k([start({ sweptContainers: 1, leftoverContainers: null })]).out).toMatch(/TSE 7k FAIL/u);
    expect(k([]).out).toMatch(/TSE 7k FAIL/u);
    expect(run(scenario(), ["--only", "7k"]).out).toMatch(/TSE 7k OPERATOR/u);
  });
});

describe("7c: the cancel test through the API", () => {
  const cancelRun = (mutate: (s: Scenario) => void = () => undefined) => {
    const s = scenario();
    s.routes["POST /v1/dev/tasks"] = [{ status: 201, body: { task: { taskId: CANCEL_TASK, status: "STARTING" } } }];
    s.routes[`GET /v1/dev/tasks/${CANCEL_TASK}`] = [{ status: 200, body: view("RUNNING", CANCEL_TASK) }, { status: 200, body: view("CANCELLED", CANCEL_TASK) }];
    mutate(s);
    return run(s, ["--escape-project", "escape", "--cancel-test", "--only", "7c"]);
  };

  it("PASS: starts a task, waits for RUNNING, cancels it, requires CANCELLED, then a clean cancelled run_end", () => {
    const r = cancelRun();
    expect(verdictOf(r.out, "7c"), r.out).toBe("PASS");
    expect(r.curl.map((call) => call.key)).toContain(`POST /v1/dev/tasks/${CANCEL_TASK}/cancel`);
    const body = JSON.parse(r.curl.find((call) => call.key === "POST /v1/dev/tasks")!.data!) as { instructions: string };
    expect(body.instructions).toContain("sleep 600");
  });

  it("FAIL: the task never runs, the cancel is refused, the task ends something other than CANCELLED, no cancelled run_end is reported, or the cancelled run left something", () => {
    expect(verdictOf(cancelRun((s) => { s.routes[`GET /v1/dev/tasks/${CANCEL_TASK}`] = [{ status: 200, body: view("STARTING", CANCEL_TASK) }]; }).out, "7c")).toBe("FAIL");
    expect(verdictOf(cancelRun((s) => { s.routes[`POST /v1/dev/tasks/${CANCEL_TASK}/cancel`] = [{ status: 409, body: {} }]; }).out, "7c")).toBe("FAIL");
    expect(verdictOf(cancelRun((s) => { s.routes[`GET /v1/dev/tasks/${CANCEL_TASK}`] = [{ status: 200, body: view("RUNNING", CANCEL_TASK) }, { status: 200, body: view("SUCCEEDED", CANCEL_TASK) }]; }).out, "7c")).toBe("FAIL");
    expect(verdictOf(cancelRun((s) => { s.events = [end()]; }).out, "7c")).toBe("FAIL");
    expect(verdictOf(cancelRun((s) => { s.events = []; }).out, "7c")).toBe("FAIL");
    expect(verdictOf(cancelRun((s) => { s.events = [end({ outcome: "cancelled", leftoverNetworks: 1 })]; }).out, "7c")).toBe("FAIL");
    expect(verdictOf(cancelRun((s) => { s.events = [end({ outcome: "cancelled", workingSandboxPaused: true })]; }).out, "7c")).toBe("FAIL");
    expect(verdictOf(cancelRun((s) => { s.routes["POST /v1/dev/tasks"] = [{ status: 500, body: {} }]; }).out, "7c")).toBe("FAIL");
  });

  it("without --cancel-test the cancel step is left to the operator, never silently passed", () => {
    expect(verdictOf(run(scenario(), ["--only", "7c"]).out, "7c")).toBe("OPERATOR");
  });
});

describe("the operator-only items stay operator items", () => {
  it("8 and 9 are OPERATOR lines and make the exit status non-zero", () => {
    const r = run(scenario(), ["--only", "8,9"]);
    expect(verdictOf(r.out, "8")).toBe("OPERATOR");
    expect(verdictOf(r.out, "9")).toBe("OPERATOR");
    expect(r.status).toBe(1);
  });
});


// ---- slice 2: --aws -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("slice 2 (--aws): Postgres plus S3, SQS and DynamoDB on Rovara local AWS", () => {
  const FLAG_TASK = "77777777-2222-4333-8444-555555555555";
  const awsDependency = (service: string, over: Record<string, unknown> = {}, backing: Record<string, unknown> = {}) => ({
    id: `aws-${service}`, name: service, kind: "object_store", family: `aws:${service}`, found: [{ path: "template.yaml", line: 3 }], usedBy: ["working", "task_check"],
    backing: { kind: "emulated", catalogId: "local-aws@r1", awsServices: [service], region: "us-east-1", resources: { provider: "cloudformation", path: "template.yaml" }, ...backing }, connect: { env: [], hostAliases: [] }, seeds: [], reset: "fresh_per_round", ...over,
  });
  const fourDependencies = (change: (list: Array<Record<string, unknown>>) => void = () => undefined) => { const list: Array<Record<string, unknown>> = [dependency, awsDependency("s3"), awsDependency("sqs"), awsDependency("dynamodb")]; change(list); return list; };
  const AWS_TESTS = [...TESTS.map((name) => `tests/${name}.test.js`), "tests/aws-positive.test.js", "tests/aws-control.test.js"];
  const awsEntries = (over: Record<string, string> = {}, omit: string[] = []) => AWS_TESTS.filter((file) => !omit.includes(file)).map((file) => ({ id: `readiness:${file}`, label: `node --test ${file}`, source: "project", before: "passed", after: over[file] ?? "passed", output: "" }));
  const IAM = "AWS permissions (IAM) were not checked: Rovara local AWS does not enforce IAM";
  const PR_AWS = "Integration tests ran against: Postgres (real), S3, SQS and DynamoDB (Rovara local AWS).";
  const awsEvidence = (over: { checks?: unknown[]; pr?: string; iam?: boolean } = {}) => JSON.stringify({
    checks: over.checks ?? awsEntries(),
    pullRequestLines: [over.pr ?? PR_AWS, ...(over.iam === false ? [] : [`- ${IAM}`])],
    environment: { blocked: "Blocked by environment: 3 calls to names no dependency answers: example.com (2), example.net (1)" },
  });
  const flagView = (over: { entry?: string; flagged?: string | null; status?: string } = {}) => ({
    task: { taskId: FLAG_TASK, status: over.status ?? "SUCCEEDED", title: "t", project: "flag", createdAt: new Date(Date.now() - 5 * 60_000).toISOString() },
    checks: [{ id: "readiness:oop", label: "node --test tests/aws-out-of-plan.test.js", source: "project", before: "passed", after: over.entry ?? "passed", output: "" }],
    notTested: over.flagged === null ? [] : [over.flagged ?? "The code called AWS services that are not in the plan: sns"],
  });
  const awsScenario = (change: (s: Scenario) => void = () => undefined): Scenario => {
    const s = scenario();
    s.routes[`POST ${BASE}/propose`] = [{ status: 200, body: state(proposal({ environment: { dependencies: fourDependencies() } })) }];
    s.routes["POST /v1/dev/tasks"] = [{ status: 201, body: { task: { taskId: TASK, status: "STARTING" } } }, { status: 201, body: { task: { taskId: FLAG_TASK, status: "STARTING" } } }];
    s.routes[`GET /v1/dev/tasks/${FLAG_TASK}`] = [{ status: 200, body: flagView() }];
    s.events = [start({ bootFacts: { ...FACTS, prepulled: 2 }, sweptContainers: 2, sweptNetworks: 1 }), end(), timed(end({ outcome: "cancelled" }), { afterCancel: true })];
    change(s);
    return s;
  };
  const ARGS = ["--aws", "--escape-project", "escape", "--aws-flag-project", "flag", "--expect-outcome", "completed"];
  const verdicts = (r: { out: string }, ids: string[]) => Object.fromEntries(ids.map((id) => [id, verdictOf(r.out, id)]));

  it("drives every slice-2 step and says PASS: the repository pin, four dependencies, the AWS tests by name, the PR line, the IAM line, the control paths, the flagged SNS call", () => {
    const r = runWith(awsScenario(), awsEvidence(), ARGS);
    for (const step of ["P0", "P1", "P2", "P3", "PA", "P4", "1", "2", "3", "4", "5", "6", "L3", "A2", "A3", "A4", "7"]) expect(verdictOf(r.out, step), `${step}\n${r.out}\n${r.err}`).toBe("PASS");
    expect(line(r.out, "5")).toContain(PR_AWS);
    expect(r.guard).toContain("ecr describe-images --repository-name rovara-catalog/staging/svc/local-aws");
    expect(r.guard).not.toMatch(/ssm|send-command/u);
    // The flag task was started on the flag project, after the main task.
    const starts = r.curl.filter((call) => call.key === "POST /v1/dev/tasks").map((call) => (JSON.parse(call.data!) as { project: string }).project);
    expect(starts).toEqual(["escape", "flag"]);
    expect(r.curl.map((call) => call.key)).toContain(`GET /v1/dev/tasks/${FLAG_TASK}`);
  });

  it("without --aws nothing of slice 2 runs: no AWS step is printed, no local-aws repository is read, and the flag options are refused", () => {
    const r = runWith(awsScenario(), evidence(), ["--escape-project", "escape", "--expect-outcome", "completed"]);
    for (const step of ["PA", "A2", "A3", "A4"]) expect(line(r.out, step), step).toBe("");
    expect(r.guard).not.toContain("local-aws");
    expect(run(scenario(), ["--aws-flag-project", "flag"]).status).toBe(2);
    expect(run(scenario(), ["--aws-flag-task", FLAG_TASK]).status).toBe(2);
    expect(run(scenario(), ["--aws", "--aws-flag-project", "bad name"]).status).toBe(3);
  });

  it("PA fails when the repository is empty, holds another digest, the guard fails, or the catalog has no pin", () => {
    const only = ["--aws", "--only", "PA"];
    expect(verdictOf(run(awsScenario(), only).out, "PA")).toBe("PASS");
    expect(verdictOf(run(awsScenario((s) => { s.awsDigests = ""; }), only).out, "PA")).toBe("FAIL");
    expect(verdictOf(run(awsScenario((s) => { s.awsDigests = `sha256:${"e".repeat(64)}`; }), only).out, "PA")).toBe("FAIL");
    expect(verdictOf(run(awsScenario((s) => { s.awsCatalogPin = null; }), only).out, "PA")).toBe("FAIL");
  });

  it("P4 needs at least two images pre-pulled in slice 2 (and one is enough without --aws)", () => {
    const one = awsScenario((s) => { s.events = [start({ bootFacts: { ...FACTS, prepulled: 1 } })]; });
    expect(verdictOf(run(one, ["--aws", "--only", "P4"]).out, "P4")).toBe("FAIL");
    expect(run(one, ["--aws", "--only", "P4"]).out).toContain("fewer than 2 images pre-pulled");
    expect(verdictOf(run(one, ["--only", "P4"]).out, "P4")).toBe("PASS");
  });

  it("step 1 fails when any of S3, SQS, DynamoDB is missing, is not emulated on local-aws@r1, has no source line or has no resource pointer", () => {
    const propose = (change: (list: Array<Record<string, unknown>>) => void) => run(awsScenario((s) => { s.routes[`POST ${BASE}/propose`] = [{ status: 200, body: state(proposal({ environment: { dependencies: fourDependencies(change) } })) }]; }), ["--aws", "--only", "1"]);
    for (const service of ["s3", "sqs", "dynamodb"]) {
      const missing = propose((list) => { list.splice(list.findIndex((item) => item["id"] === `aws-${service}`), 1); });
      expect(verdictOf(missing.out, "1"), service).toBe("FAIL");
      expect(missing.out).toContain(service);
    }
    expect(verdictOf(propose((list) => { list[1] = awsDependency("s3", {}, { kind: "local" }); }).out, "1")).toBe("FAIL");
    expect(verdictOf(propose((list) => { list[2] = awsDependency("sqs", {}, { catalogId: "local-aws@r2" }); }).out, "1")).toBe("FAIL");
    expect(verdictOf(propose((list) => { list[3] = awsDependency("dynamodb", { found: [] }); }).out, "1")).toBe("FAIL");
    expect(verdictOf(propose((list) => { list[1] = awsDependency("s3", {}, { resources: undefined }); }).out, "1")).toBe("FAIL");
    expect(verdictOf(propose(() => undefined).out, "1")).toBe("PASS");
    // Postgres alone is slice 1's list, and slice 2 refuses it.
    expect(verdictOf(run(awsScenario((s) => { s.routes[`POST ${BASE}/propose`] = [{ status: 200, body: state(proposal()) }]; }), ["--aws", "--only", "1"]).out, "1")).toBe("FAIL");
  });

  it("step 4 needs aws-positive as well as the five escape tests; a failed or missing one is a FAIL, and the control test is its own step", () => {
    const four = (checks: unknown[]) => runWith(awsScenario(), awsEvidence({ checks }), ["--aws", "--task", TASK, "--only", "4,A3", "--expect-outcome", "completed"]);
    expect(verdictOf(four(awsEntries()).out, "4")).toBe("PASS");
    expect(verdictOf(four(awsEntries({ "tests/aws-positive.test.js": "failed" })).out, "4")).toBe("FAIL");
    expect(verdictOf(four(awsEntries({}, ["tests/aws-positive.test.js"])).out, "4")).toBe("FAIL");
    expect(verdictOf(four(entries()).out, "4")).toBe("FAIL");
    expect(verdictOf(four(awsEntries({ "tests/aws-control.test.js": "failed" })).out, "A3")).toBe("FAIL");
    expect(verdictOf(four(awsEntries({}, ["tests/aws-control.test.js"])).out, "A3")).toBe("FAIL");
    expect(verdictOf(four(awsEntries()).out, "A3")).toBe("PASS");
    expect(verdictOf(run(awsScenario(), ["--aws", "--only", "A3"]).out, "A3")).toBe("OPERATOR");
  });

  it("step 5 needs Postgres (real) and all of S3, SQS and DynamoDB (Rovara local AWS) in one line; Postgres alone, a missing service or a different label is a FAIL; A2 needs the IAM line", () => {
    const five = (over: { pr?: string; iam?: boolean }) => runWith(awsScenario(), awsEvidence(over), ["--aws", "--task", TASK, "--only", "5,A2"]);
    expect(verdictOf(five({}).out, "5")).toBe("PASS");
    expect(verdictOf(five({ pr: "Integration tests ran against: Postgres (real), DynamoDB, S3 and SQS (Rovara local AWS)." }).out, "5")).toBe("PASS");
    for (const pr of ["Integration tests ran against: Postgres (real).", "Integration tests ran against: Postgres (real), S3 and SQS (Rovara local AWS).", "Integration tests ran against: Postgres (real), S3, SQS and DynamoDB (real).", "Integration tests ran against: S3, SQS and DynamoDB (Rovara local AWS)."]) {
      expect(verdictOf(five({ pr }).out, "5"), pr).toBe("FAIL");
    }
    expect(verdictOf(five({}).out, "A2")).toBe("PASS");
    expect(verdictOf(five({ iam: false }).out, "A2")).toBe("FAIL");
    expect(verdictOf(run(awsScenario(), ["--aws", "--only", "5,A2"]).out, "5")).toBe("OPERATOR");
    expect(verdictOf(run(awsScenario(), ["--aws", "--only", "5,A2"]).out, "A2")).toBe("OPERATOR");
  });

  it("A4: the SNS call is refused and flagged: PASS. No flag project or task: FAIL (it is required). Each way it can fail is a FAIL", () => {
    const a4 = (change: (s: Scenario) => void, args = ["--aws", "--aws-flag-task", FLAG_TASK, "--only", "A4"]) => run(awsScenario(change), args);
    expect(verdictOf(a4(() => undefined).out, "A4")).toBe("PASS");
    // A4 is REQUIRED under --aws: no flag project or task is a FAIL, never an OPERATOR line.
    expect(verdictOf(run(awsScenario(), ["--aws", "--only", "A4"]).out, "A4")).toBe("FAIL");
    expect(run(awsScenario(), ["--aws", "--only", "A4"]).out).toMatch(/TSE A4 FAIL.*required under --aws/u);
    // The refusal test did not pass, or has no entry, or the evidence does not flag the service (or names another).
    expect(verdictOf(a4((s) => { s.routes[`GET /v1/dev/tasks/${FLAG_TASK}`] = [{ status: 200, body: flagView({ entry: "failed" }) }]; }).out, "A4")).toBe("FAIL");
    expect(verdictOf(a4((s) => { s.routes[`GET /v1/dev/tasks/${FLAG_TASK}`] = [{ status: 200, body: { ...flagView(), checks: [] } }]; }).out, "A4")).toBe("FAIL");
    expect(verdictOf(a4((s) => { s.routes[`GET /v1/dev/tasks/${FLAG_TASK}`] = [{ status: 200, body: flagView({ flagged: null }) }]; }).out, "A4")).toBe("FAIL");
    expect(verdictOf(a4((s) => { s.routes[`GET /v1/dev/tasks/${FLAG_TASK}`] = [{ status: 200, body: flagView({ flagged: "The code called AWS services that are not in the plan: kinesis" }) }]; }).out, "A4")).toBe("FAIL");
    expect(verdictOf(a4((s) => { s.routes[`GET /v1/dev/tasks/${FLAG_TASK}`] = [{ status: 200, body: flagView({ flagged: "AWS usage could not be checked" }) }]; }).out, "A4")).toBe("FAIL");
    // A view that never answers, a task start that fails, and a dirty teardown are FAILs.
    expect(verdictOf(a4((s) => { s.routes[`GET /v1/dev/tasks/${FLAG_TASK}`] = [{ status: 500 }]; }).out, "A4")).toBe("FAIL");
    expect(verdictOf(a4((s) => { s.routes["POST /v1/dev/tasks"] = [{ status: 500 }]; }, ["--aws", "--aws-flag-project", "flag", "--only", "A4"]).out, "A4")).toBe("FAIL");
    expect(verdictOf(a4((s) => { s.events = [start({ bootFacts: { ...FACTS, prepulled: 2 } }), end({ leftoverContainers: 1 })]; }).out, "A4")).toBe("FAIL");
    expect(verdictOf(a4((s) => { s.events = [start({ bootFacts: { ...FACTS, prepulled: 2 } })]; }).out, "A4")).toBe("FAIL");
  });

  it("steps 4 and 5 FAIL whenever the main task's evidence holds any AWS usage sentence, and the script's list is the contracts' list", () => {
    expect([...TEST_SERVICES_AWS_USAGE_PROBLEMS].map((problem) => TEST_SERVICES_AWS_USAGE_WORDS[problem]).sort()).toEqual([
      "AWS usage could not be checked", "AWS usage could not be checked: the code made too many different AWS calls", "The code called AWS operations that Rovara local AWS does not support", "The code called AWS services that are not in the plan",
    ]);
    // Each sentence, as the pack writes it (with the service key where there is one), planted in the main evidence next to otherwise perfect checks.
    for (const sentence of [...Object.values(TEST_SERVICES_AWS_USAGE_WORDS), `${TEST_SERVICES_AWS_USAGE_WORDS.out_of_plan}: sns`]) {
      const text = JSON.stringify({ checks: awsEntries(), pullRequestLines: [PR_AWS, `- ${IAM}`], notTested: [sentence], environment: { blocked: "Blocked by environment: 3 calls to names no dependency answers: example.com (2), example.net (1)" } });
      const r = runWith(awsScenario(), text, ["--aws", "--task", TASK, "--only", "4,5", "--expect-outcome", "completed"]);
      expect(verdictOf(r.out, "4"), sentence).toBe("FAIL");
      expect(r.out, sentence).toMatch(/TSE 4 FAIL.*the evidence says/u);
      expect(verdictOf(r.out, "5"), sentence).toBe("FAIL");
    }
    // The same evidence without the sentence passes both; and the sentence in the FLAG task's view (where it belongs) does not fail the main task's steps.
    const clean = runWith(awsScenario(), awsEvidence(), ["--aws", "--task", TASK, "--only", "4,5", "--expect-outcome", "completed"]);
    expect(verdictOf(clean.out, "4")).toBe("PASS");
    expect(verdictOf(clean.out, "5")).toBe("PASS");
    const full = runWith(awsScenario(), awsEvidence(), ARGS);
    expect(verdictOf(full.out, "4")).toBe("PASS");
    expect(verdictOf(full.out, "A4")).toBe("PASS");
    // Without --aws nothing changes: slice 1's evidence with such a sentence still passes step 5's slice-1 check.
    expect(verdictOf(runWith(scenario(), evidence({ pr: "Integration tests ran against: Postgres (real). AWS usage could not be checked" }), ["--task", TASK, "--only", "5"]).out, "5")).toBe("PASS");
  });

  it("every slice-2 step is a named step (--only accepts it) and the summary counts them", () => {
    const r = runWith(awsScenario(), awsEvidence(), ARGS);
    expect(r.out).toMatch(/TSE SUMMARY pass=17 fail=0 operator=4/u);
    expect(verdicts(r, ["8", "9"])).toEqual({ "8": "OPERATOR", "9": "OPERATOR" });
    expect(run(awsScenario(), ["--aws", "--only", "A5"]).status).toBe(2);
  });
});
