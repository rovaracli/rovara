// Test services slice 1: scripts/staging-test-services-e2e.sh (written, not run against staging). Staging workers are not SSM-managed, so the script must use no SSM at all: the Rovara API, the staging guard for read-only AWS
// calls, and the worker's own self-report lines in CloudWatch Logs. Run here against a FAKE guard that answers `aws logs filter-log-events` with canned worker reports.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = new URL("../../scripts/staging-test-services-e2e.sh", import.meta.url).pathname;
const code = readFileSync(SCRIPT, "utf8").split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");

const FACTS = { metadataBlocked: true, runWalls: true, ipv6Drops: true, prepull: "ok", prepulled: 1, loggedOut: true, dockerVersion: "25.0.5" };
const start = (over: Record<string, unknown> = {}) => ({ component: "worker", event: "test-services.report", phase: "worker_start", outcome: "booted", leftoverContainers: 0, leftoverNetworks: 0, runDirEmpty: true, runDirTmpfs: true, workingSandboxPaused: null, sweptContainers: 0, sweptNetworks: 0, bootFacts: FACTS, ...over });
const end = (over: Record<string, unknown> = {}) => ({ component: "worker", event: "test-services.report", phase: "run_end", outcome: "completed", leftoverContainers: 0, leftoverNetworks: 0, runDirEmpty: true, runDirTmpfs: true, workingSandboxPaused: false, ...over });

function run(events: unknown[], args: string[], extraEnv: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "tse-script-"));
  const recorded = join(directory, "calls");
  const guard = join(directory, "staging-aws.sh");
  writeFileSync(join(directory, "events.json"), JSON.stringify(events.map((event) => JSON.stringify(event))));
  writeFileSync(guard, [
    "#!/bin/bash",
    `echo "$*" >> "${recorded}"`,
    'case "$*" in',
    `  *"logs filter-log-events"*) cat "${directory}/events.json" ;;`,
    "  *) echo 944937319445 ;;",
    "esac",
  ].join("\n"));
  chmodSync(guard, 0o755);
  const token = join(directory, "token");
  writeFileSync(token, "not-a-real-token");
  chmodSync(token, 0o600);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "sleep"), "#!/bin/bash\nexit 0\n");
  chmodSync(join(bin, "sleep"), 0o755);
  const ran = spawnSync("/bin/bash", [SCRIPT, ...args], {
    encoding: "utf8", timeout: 60_000,
    env: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, HOME: directory, TMPDIR: directory, STAGING_AWS: guard, STAGING_E2E_OWNER_GO: "yes", ROVARA_STAGING_URL: "https://staging.example.test", ROVARA_STAGING_TOKEN_FILE: token, ROVARA_STAGING_PROJECT: "sample", ...extraEnv },
  });
  let calls = "";
  try { calls = readFileSync(recorded, "utf8"); } catch { /* none */ }
  return { out: ran.stdout, err: ran.stderr, calls, status: ran.status };
}

describe("the staging done-check script uses no SSM", () => {
  it("has no ssm command, no commands=[...] shorthand and no root command on a worker; every AWS call goes through the staging guard and is a read", () => {
    expect(code).not.toMatch(/\bssm\b|send-command|get-command-invocation|AWS-RunShellScript|commands=\[/iu);
    expect(code).not.toMatch(/docker (ps|network|images|exec)|iptables/u);
    const awsCalls = [...code.matchAll(/\$STAGING"? aws ([a-z0-9-]+ [a-z0-9-]+)/gu)].map((match) => match[1]);
    expect(new Set(awsCalls)).toEqual(new Set(["sts get-caller-identity", "ecr describe-images", "logs filter-log-events"]));
    expect(code.match(/(?<![\w-])aws(?![\w-])/gu)?.length).toBe(awsCalls.length);
  });

  it("refuses to start without the owner's go, a mode-600 token file and an https URL", () => {
    expect(run([], [], { STAGING_E2E_OWNER_GO: "" }).status).toBe(3);
    expect(run([], [], { ROVARA_STAGING_URL: "http://insecure.example.test" }).status).toBe(3);
  });
});

describe("the worker's reports are read from CloudWatch Logs", () => {
  const read = (events: unknown[], args: string[]) => run(events, ["--only", ...args]);

  it("P4: boot facts all true, pre-pull ok and logged out, nothing left, the run directory empty and a tmpfs: PASS; any one wrong: FAIL naming it", () => {
    const good = read([start()], ["P4"]);
    expect(good.out).toMatch(/TSE P4 PASS/u);
    expect(good.calls).toContain("logs filter-log-events --log-group-name /agentx/staging/worker");
    expect(good.calls).toContain('--filter-pattern "test-services.report"'.replace(/"/gu, '"'));
    for (const [change, words] of [
      [{ bootFacts: { ...FACTS, metadataBlocked: false } }, "metadataBlocked"], [{ bootFacts: { ...FACTS, runWalls: false } }, "runWalls"], [{ bootFacts: { ...FACTS, ipv6Drops: false } }, "ipv6Drops"],
      [{ bootFacts: { ...FACTS, loggedOut: false } }, "loggedOut"], [{ bootFacts: { ...FACTS, prepull: "failed" } }, "prepull failed"], [{ bootFacts: { ...FACTS, prepulled: 0 } }, "nothing pre-pulled"],
      [{ bootFacts: "absent" }, "boot facts"], [{ leftoverContainers: 1 }, "leftover"], [{ leftoverNetworks: 2 }, "leftover"], [{ runDirEmpty: false }, "run directory not empty"], [{ runDirTmpfs: false }, "not a tmpfs"],
    ] as const) {
      const r = read([start(change)], ["P4"]);
      expect(r.out, JSON.stringify(change)).toMatch(/TSE P4 FAIL/u);
      expect(r.out, JSON.stringify(change)).toContain(words);
    }
    expect(read([], ["P4"]).out).toMatch(/TSE P4 FAIL.*no worker_start report/u);
  });

  it("7: run_end reports with nothing left, an empty run directory and a sandbox not paused pass; leftovers, a non-empty directory or a paused sandbox fail", () => {
    expect(read([end(), end({ outcome: "failed" })], ["7"]).out).toMatch(/TSE 7 PASS.*completed,failed/u);
    expect(read([end({ leftoverNetworks: 1 })], ["7"]).out).toMatch(/TSE 7 FAIL.*leftover objects/u);
    expect(read([end({ runDirEmpty: false })], ["7"]).out).toMatch(/TSE 7 FAIL.*run directory not empty/u);
    expect(read([end({ workingSandboxPaused: true })], ["7"]).out).toMatch(/TSE 7 FAIL.*left paused/u);
    expect(read([end()], ["7", "--expect-outcome", "cancelled"]).out).toMatch(/TSE 7 FAIL.*no cancelled run reported/u);
    expect(read([end({ outcome: "cancelled" })], ["7", "--expect-outcome", "cancelled"]).out).toMatch(/TSE 7 PASS/u);
    expect(read([], ["7"]).out).toMatch(/TSE 7 OPERATOR/u);
  });

  it("7: a restarted worker's start report shows what the sweep removed and that nothing is left", () => {
    expect(read([start({ sweptContainers: 2, sweptNetworks: 1 })], ["7", "--expect-swept"]).out).toMatch(/TSE 7 PASS killed worker is swept.*removed 3/u);
    expect(read([start()], ["7", "--expect-swept"]).out).toMatch(/TSE 7 FAIL killed worker is swept/u);
    expect(read([start({ sweptContainers: 1, leftoverContainers: 1 })], ["7", "--expect-swept"]).out).toMatch(/TSE 7 FAIL killed worker is swept/u);
  });
});

describe("the verdicts read from a task's evidence text", () => {
  it("5 and 6: the PR line and the blocked-calls line, by domain and count only", () => {
    const directory = mkdtempSync(join(tmpdir(), "tse-evidence-"));
    const file = join(directory, "evidence.txt");
    writeFileSync(file, 'Integration tests ran against: Postgres (real).\n"after":"passed"\nBlocked by environment: 3 calls to names no dependency answers: example-pay.com (3)\n');
    const good = run([], ["--only", "4,5,6", "--evidence", file]);
    expect(good.out).toMatch(/TSE 4 PASS/u);
    expect(good.out).toMatch(/TSE 5 PASS/u);
    expect(good.out).toMatch(/TSE 6 PASS/u);
    writeFileSync(file, `"after":"failed"\nBlocked by environment: 1 call: ${"a".repeat(40)}.com (1)\n`);
    const bad = run([], ["--only", "4,5,6", "--evidence", file]);
    expect(bad.out).toMatch(/TSE 4 FAIL/u);
    expect(bad.out).toMatch(/TSE 5 FAIL/u);
    expect(bad.out).toMatch(/TSE 6 FAIL.*token-like/u);
  });
});
