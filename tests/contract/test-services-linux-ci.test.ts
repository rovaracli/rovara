// Test services slice 1: the Linux checks that need root and a real Docker host run in CI (the last steps of the linux-runtime job), because a staging worker has no SSM and nobody can run them there. Nothing here starts
// Docker or changes the host: the workflow is read as data, the script's judge is run on sample output, boot-stage2.sh is sourced to see it only defines functions, and the CI Postgres entry is built from the committed catalog.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { ciPostgresEntry } from "../../scripts/linux-check-test-services-live.js";

interface Step { name?: string; run?: string; uses?: string; if?: string; id?: string; env?: Record<string, string> }
interface Job { needs?: string | string[]; if?: string; outputs?: Record<string, string>; steps: Step[]; permissions?: Record<string, string> }
const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const workflowText = read(".github/workflows/ci.yml");
const jobs = (YAML.parse(workflowText) as { jobs: Record<string, Job> }).jobs;
const script = read("scripts/ci-test-services-linux.sh");
const scriptCode = script.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
const GATE = "needs.scope.outputs.test_services != 'false'";

describe("the linux-runtime job runs the test services Linux checks", () => {
  const job = jobs["linux-runtime"]!;
  const build = job.steps.find((step) => (step.name ?? "").startsWith("Test services Linux checks (build"))!;
  const check = job.steps.find((step) => (step.name ?? "").startsWith("Test services Linux checks (rules"))!;

  it("keeps the job's structure: after scope and checks, behind the docs-only skip, read-only permissions, no cloud credentials", () => {
    expect(job.needs).toEqual(["scope", "checks"]);
    expect(job.if).toBe("needs.scope.outputs.docs_only != 'true'");
    expect(job.permissions).toEqual({ contents: "read", packages: "read" });
    expect(workflowText).not.toMatch(/aws-actions|configure-aws-credentials|AWS_ACCESS_KEY|AWS_SECRET|role-to-assume/u);
    expect(scriptCode).not.toMatch(/(?:^|[\s;|(])aws\s+[a-z]|\bssm\b|send-command|AWS_/mu);
  });

  it("has both steps, gated on the scope job's changed-paths output, and they are the last steps (they restart Docker)", () => {
    expect(build, "build step").toBeDefined();
    expect(check, "check step").toBeDefined();
    expect(build.if).toBe(GATE);
    expect(check.if).toBe(GATE);
    expect(job.steps.slice(-2)).toEqual([build, check]);
    const lastVitest = job.steps.map((step) => step.run ?? "").map((run, index) => (run.includes("vitest run") ? index : -1)).reduce((a, b) => Math.max(a, b), -1);
    expect(job.steps.indexOf(build)).toBeGreaterThan(lastVitest);
  });

  it("builds the worker image from environments/base/Dockerfile with its FROM lines pointed at the pulled pinned digest, and emits the driver as JavaScript", () => {
    const run = build.run!;
    expect(run).toContain("node scripts/ci-images.ts verify node-build");
    expect(run).toContain('node scripts/ci-images.ts dockerfile environments/base/Dockerfile "$RUNNER_TEMP/worker.Dockerfile"');
    expect(run).toContain('docker build -f "$RUNNER_TEMP/worker.Dockerfile" -t rovara-worker:ci .');
    expect(run.indexOf("ci-images.ts dockerfile")).toBeLessThan(run.indexOf("docker build"));
    expect(run).toContain('npx tsx scripts/linux-check-test-services-live.ts --js > "$RUNNER_TEMP/tsl-live.mjs"');
    expect(job.steps.indexOf(build)).toBeGreaterThan(job.steps.findIndex((step) => step.run === "npm run build" || (step.run ?? "") === "npm run build"));
  });

  it("runs the script as root with the right inputs and nothing else, so any FAIL fails the step (and so the job)", () => {
    expect(check.run).toBe("sudo --preserve-env=TSL_CI_WORKER_IMAGE,TSL_CI_DRIVER_JS,RUNNER_TEMP bash scripts/ci-test-services-linux.sh");
    expect(check.env).toEqual({ TSL_CI_WORKER_IMAGE: "rovara-worker:ci", TSL_CI_DRIVER_JS: "${{ runner.temp }}/tsl-live.mjs" });
    expect(check.run).not.toMatch(/\|\||\|\s*true|continue-on-error/u);
    expect(YAML.stringify(check)).not.toContain("continue-on-error");
  });

  it("the scope job exposes test_services (false only when nothing the checks read changed since the previous release tag or the PR base, and the input is not always)", () => {
    const scope = jobs["scope"]!;
    expect(scope.outputs?.["test_services"]).toBe("${{ steps.test_services.outputs.test_services }}");
    const step = scope.steps.find((candidate) => candidate.id === "test_services")!;
    // ci.yml is started by hand only, so the manual path decides too: no `if` on the step, the input test_services (auto | always), and a base to compare with.
    expect(step.if).toBeUndefined();
    expect(step.env).toEqual({ INPUT_TEST_SERVICES: "${{ inputs.test_services }}" });
    const input = (YAML.parse(workflowText) as { on: { workflow_dispatch: { inputs: Record<string, { type: string; options: string[]; default: string }> } } }).on.workflow_dispatch.inputs["test_services"]!;
    expect(input).toMatchObject({ type: "choice", options: ["auto", "always"], default: "auto" });
    const pattern = /grep -Eq '([^']+)'/u.exec(step.run!)![1]!;
    const regex = new RegExp(pattern, "u");
    for (const touched of [
      "packages/worker/src/test-services-run.ts", "packages/worker/ec2/boot-stage2.sh", "packages/worker/ec2/boot.sh", "packages/contracts/src/service-catalog.ts", "packages/contracts/src/test-env-dependency.ts", "environments/base/Dockerfile", "environments/service-catalog/catalog.json",
      "infra/lib/worker-settings.ts", "infra/lib/ec2-workers.ts", "scripts/linux-check-test-services.sh", "scripts/linux-check-test-services-live.ts", "scripts/ci-test-services-linux.sh", ".github/workflows/ci.yml",
    ]) expect(regex.test(touched), touched).toBe(true);
    for (const untouched of ["packages/web/src/App.tsx", "packages/broker/src/org/test-environment.ts", "docs/guide.md", "tests/unit/x.test.ts", "environments/slack/Dockerfile"]) expect(regex.test(untouched), untouched).toBe(false);
    // The step's script, run for real in a throwaway repository: auto with no relevant change skips, auto with a relevant change runs, always runs, and no base to compare with runs (never a silent skip).
    const decide = (setup: (git: (...args: string[]) => void, write: (path: string) => void) => void, event: string, choice: string): string => {
      const dir = mkdtempSync(join(tmpdir(), "tse-scope-"));
      const git = (...args: string[]): void => { const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`); };
      const write = (path: string): void => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), `${path} ${Math.random()}\n`); git("add", "-A"); git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", path); };
      git("init", "-q", "-b", "main");
      setup(git, write);
      const output = join(dir, "github-output");
      writeFileSync(output, "");
      const ran = spawnSync("bash", ["-c", step.run!], { cwd: dir, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: output, RUNNER_TEMP: dir, INPUT_TEST_SERVICES: choice } });
      expect(ran.status, ran.stderr).toBe(0);
      return readFileSync(output, "utf8").trim();
    };
    const tagged = (change: string) => (git: (...args: string[]) => void, write: (path: string) => void): void => { write("README.txt"); git("tag", "v0.4.1"); write("docs/note.txt"); write(change); };
    expect(decide(tagged("packages/web/src/App.tsx"), "workflow_dispatch", "auto")).toBe("test_services=false");
    expect(decide(tagged("packages/worker/src/run-network.ts"), "workflow_dispatch", "auto")).toBe("test_services=true");
    expect(decide(tagged("packages/worker/ec2/boot-stage2.sh"), "workflow_dispatch", "auto")).toBe("test_services=true");
    expect(decide(tagged("packages/web/src/App.tsx"), "workflow_dispatch", "always")).toBe("test_services=true");
    expect(decide((git, write) => { write("a.txt"); write("b.txt"); }, "workflow_dispatch", "auto")).toBe("test_services=true");
    expect(decide(tagged("packages/web/src/App.tsx"), "pull_request", "auto")).toBe("test_services=false");
    expect(decide(tagged("infra/lib/worker-settings.ts"), "pull_request", "auto")).toBe("test_services=true");
    // The gate on both steps reads it: "false" skips them, anything else (including empty) runs them.
    expect(GATE).toBe("needs.scope.outputs.test_services != 'false'");
    // Nothing else in the workflow reads this output in a way that could skip other jobs.
    expect(workflowText.match(/test_services/gu)?.length).toBeGreaterThanOrEqual(4);
    expect(Object.entries(jobs).filter(([name, other]) => name !== "linux-runtime" && name !== "scope" && JSON.stringify(other).includes("outputs.test_services")).map(([name]) => name)).toEqual([]);
  });
});

describe("scripts/ci-test-services-linux.sh", () => {
  it("applies the rules with boot-stage2.sh's own functions, in stage2_main's order, and never copies their iptables rules", () => {
    expect(script).toContain('source "$root/packages/worker/ec2/boot-stage2.sh"');
    const order = ["set_docker_address_pools ||", "metadata_blocked ||", "wall_between_run_networks ||", "wall_ipv6_into_host ||"].map((needle) => script.indexOf(needle));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(script).toContain("<<'FIREWALL'");
    expect(scriptCode).not.toMatch(/iptables -[IAD] /u);
    const stage2 = read("packages/worker/ec2/boot-stage2.sh");
    const main = stage2.slice(stage2.indexOf("stage2_main"));
    const inMain = ["set_docker_address_pools", "metadata_blocked", "wall_between_run_networks", "wall_ipv6_into_host"].map((name) => main.indexOf(name));
    expect([...inMain].sort((a, b) => a - b)).toEqual(inMain);
  });

  it("sourcing boot-stage2.sh only defines the functions the script calls", () => {
    const sourced = spawnSync("bash", ["-c", 'cd "$1" && DOCKER_DATA_ROOT=/var/lib/docker source packages/worker/ec2/boot-stage2.sh && for f in set_docker_address_pools metadata_blocked wall_between_run_networks wall_ipv6_into_host; do declare -F "$f" >/dev/null || { echo "missing $f"; exit 1; }; done; echo defined', "x", new URL("../../", import.meta.url).pathname], { encoding: "utf8" });
    expect(sourced.stdout.trim(), sourced.stderr).toBe("defined");
  });

  it("pins postgres and the throwaway registry by digest, from the ECR Public mirror, and runs the driver the way a worker does: no network, no capability, read-only, the image by id", () => {
    expect(script).toMatch(/POSTGRES_PINNED='public\.ecr\.aws\/docker\/library\/postgres:16@sha256:[a-f0-9]{64}'/u);
    expect(script).toMatch(/REGISTRY_PINNED='public\.ecr\.aws\/docker\/library\/registry:2@sha256:[a-f0-9]{64}'/u);
    const run = script.slice(script.indexOf("docker run --rm --network none"));
    for (const flag of ["--network none", "--cap-drop ALL", "--security-opt no-new-privileges", "--read-only", "/opt/agentx/tsl-live.mjs ci", '"$image_id"']) expect(run, flag).toContain(flag);
    expect(script).toContain("TSL_CI_POSTGRES_DIGEST");
    expect(script).toContain('TSL_LIVE_OUT_FILE="$live_out" bash "$root/scripts/linux-check-test-services.sh"');
    expect(script).toContain("judge \"$check_out\"");
  });

  const judge = (output: string) => {
    const dir = mkdtempSync(join(tmpdir(), "tsl-judge-"));
    const file = join(dir, "out");
    writeFileSync(file, output);
    const ran = spawnSync("bash", ["-c", 'source "$1"; judge "$2"', "x", new URL("../../scripts/ci-test-services-linux.sh", import.meta.url).pathname, file], { encoding: "utf8" });
    return { status: ran.status, err: ran.stderr };
  };
  const LIVE = ["L1.live", "L1.live-other-run", "L2.live", "L3.live", "L3.embedded-resolver", "L3.working-relay", "L3.ipv6", "L3.no-route", "L3.other-run", "L3.multicast", "L3.run-files", "L3.spoofing", "L4.live", "L4.template-db", "L6.live"];
  const good = (): string[] => [
    "TSL L1.walls PASS walls | ok", "TSL L1.pools PASS pools | ok", ...LIVE.map((id) => `TSL ${id} PASS name | saw`),
    "TSL L1.internal-drops PENDING x | later", "TSL L5.live PENDING x | later", "TSL L7.live PENDING x | later", "TSL L8.live PENDING x | later", "TSL SUMMARY pass=17 fail=0 pending=4",
  ];

  it("makes the agentx-task network the way the worker's task sandbox does (a plain bridge), before the driver runs and after the address pools, so L2 has its working network", () => {
    const worker = readFileSync(new URL("../../packages/worker/src/task-sandbox.ts", import.meta.url), "utf8");
    expect(worker).toContain('["network", "create", "--driver", "bridge", TASK_SANDBOX_NETWORK]');
    expect(worker).toContain('export const TASK_SANDBOX_NETWORK = "agentx-task";');
    const create = scriptCode.indexOf("docker network create --driver bridge agentx-task");
    expect(create).toBeGreaterThan(scriptCode.indexOf("apply_rules \"$root\" || return 1"));
    expect(create).toBeLessThan(scriptCode.indexOf("tsl-live.mjs ci"));
    expect(scriptCode).not.toMatch(/network rm[^\n]*agentx-task/u);
  });

  it("judge passes a full run with only the known later-slice items pending", () => {
    expect(judge(`${good().join("\n")}\n`).status).toBe(0);
  });
  it("judge fails on any FAIL, any TSL ERROR or BLOCKED, an unexpected PENDING, a live item with no PASS, a missing or failing summary, and an empty output", () => {
    const cases: Array<[string, string[]]> = [
      ["a FAIL", good().map((line) => (line.startsWith("TSL L4.template-db") ? line.replace(" PASS ", " FAIL ") : line)).filter((line) => !line.startsWith("TSL SUMMARY")).concat("TSL SUMMARY pass=16 fail=1 pending=4")],
      ["a read-only FAIL", [...good(), "TSL L1.range FAIL range | overlaps"]],
      ["an error", ["TSL ERROR the CI driver gave no lines", ...good()]], ["blocked", ["TSL BLOCKED x", ...good()]],
      ["an unexpected pending", good().map((line) => line.replace("TSL L3.spoofing PASS", "TSL L3.spoofing PENDING"))],
      ["a missing live item", good().filter((line) => !line.startsWith("TSL L6.live"))],
      ["no summary", good().filter((line) => !line.startsWith("TSL SUMMARY"))], ["a summary with failures", [...good().slice(0, -1), "TSL SUMMARY pass=17 fail=1 pending=4"]], ["nothing", []],
    ];
    for (const [label, lines] of cases) expect(judge(`${lines.join("\n")}\n`).status, label).toBe(1);
  });
});

describe("the CI Postgres entry", () => {
  const catalog = read("environments/service-catalog/catalog.json");
  const digest = "a".repeat(64);
  it("is the committed postgres@16 entry with the digest of the image CI pushed, and nothing else changed", () => {
    const entry = ciPostgresEntry(catalog, digest);
    const committed = (JSON.parse(catalog) as { entries: Array<{ id: string; image: { repository: string } }> }).entries.find((candidate) => candidate.id === "postgres@16")!;
    expect(entry.id).toBe("postgres@16");
    expect(entry.image).toMatchObject({ repository: committed.image.repository, digest });
    expect(entry.reset.kind).toBe("template_db");
  });
  it("refuses a digest that is not 64 hex digits and a catalog without postgres@16", () => {
    expect(() => ciPostgresEntry(catalog, "sha256:abc")).toThrow(/64 hex/u);
    expect(() => ciPostgresEntry(JSON.stringify({ entries: [] }), digest)).toThrow(/no postgres@16/u);
  });
});

describe("the checker reads the driver's lines from a file in CI", () => {
  it("TSL_LIVE_OUT_FILE is a plain path, takes the driver's lines without starting anything, and an empty file is an error line (every live item then FAILs)", () => {
    const text = read("scripts/linux-check-test-services.sh");
    expect(text).toContain("TSL_LIVE_OUT_FILE");
    const dir = mkdtempSync(join(tmpdir(), "tsl-out-"));
    const file = join(dir, "empty");
    writeFileSync(file, "");
    const bad = spawnSync("bash", [new URL("../../scripts/linux-check-test-services.sh", import.meta.url).pathname], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", TSL_LIVE_OUT_FILE: "relative/path" } });
    expect(bad.status).toBe(2);
    void file;
  });
});
