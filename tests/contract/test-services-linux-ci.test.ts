// Test services slice 1: the Linux checks that need root and a real Docker host run in CI (the last steps of the linux-runtime job), because a staging worker has no SSM and nobody can run them there. Nothing here starts
// Docker or changes the host: the workflow is read as data, the script's judge is run on sample output, boot-stage2.sh is sourced to see it only defines functions, and the CI Postgres entry is built from the committed catalog.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { ciPostgresEntry } from "../../scripts/linux-check-test-services-live.js";

interface Step { "timeout-minutes"?: number; name?: string; run?: string; uses?: string; if?: string; id?: string; env?: Record<string, string> }
interface Job { "timeout-minutes"?: number; needs?: string | string[]; if?: string; outputs?: Record<string, string>; steps: Step[]; permissions?: Record<string, string> }
const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const workflowText = read(".github/workflows/ci.yml");
const jobs = (YAML.parse(workflowText) as { jobs: Record<string, Job> }).jobs;
const script = read("scripts/ci-test-services-linux.sh");
const scriptCode = script.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
const GATE = "needs.scope.outputs.test_services != 'false'";
const engineScript = read("scripts/ci-docker25-engine.sh");
const engineCode = engineScript.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
// The Docker the workers run (TS-SEAL-6). 25.0.5 is the newest 25.0.x that Docker publishes as a static build, and the first release with the CVE-2024-29018 fix (GHSA-mq39-4gv4-mvpx).
const DOCKER25 = "25.0.5";
const egressScript = read("scripts/ci-egress-capture.sh");
const egressCode = egressScript.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");

describe("the linux-runtime job runs the test services Linux checks", () => {
  const job = jobs["linux-runtime"]!;
  const build = job.steps.find((step) => (step.name ?? "").startsWith("Test services Linux checks (build"))!;
  const check = job.steps.find((step) => (step.name ?? "").startsWith("Test services Linux checks (rules"))!;
  const swap = job.steps.find((step) => (step.name ?? "").startsWith("Test services Linux checks on Docker 25.0.5 (swap"))!;
  const check25 = job.steps.find((step) => (step.name ?? "").startsWith("Test services Linux checks on Docker 25.0.5 (rules"))!;

  it("keeps the job's structure: after scope and checks, behind the docs-only skip, read-only permissions, no cloud credentials", () => {
    expect(job.needs).toEqual(["scope", "checks"]);
    expect(job.if).toBe("needs.scope.outputs.docs_only != 'true'");
    expect(job.permissions).toEqual({ contents: "read", packages: "read" });
    expect(workflowText).not.toMatch(/aws-actions|configure-aws-credentials|AWS_ACCESS_KEY|AWS_SECRET|role-to-assume/u);
    expect(scriptCode).not.toMatch(/(?:^|[\s;|(])aws\s+[a-z]|\bssm\b|send-command|AWS_/mu);
  });

  it("has the build and check steps, gated on the scope job's changed-paths output, and with the Docker 25 steps they are the last steps (they restart Docker)", () => {
    expect(build, "build step").toBeDefined();
    expect(check, "check step").toBeDefined();
    expect(build.if).toBe(GATE);
    expect(check.if).toBe(GATE);
    expect(job.steps.slice(-4)).toEqual([build, check, swap, check25]);
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

  it("TS-SEAL-6: runs the same checks again on the pinned Docker 25.0.5 the workers run, in the same job (no second copy of the suite), asserting the version it ran on", () => {
    expect(swap, "swap step").toBeDefined();
    expect(check25, "Docker 25 check step").toBeDefined();
    expect(swap.if).toBe(GATE);
    expect(check25.if).toBe(GATE);
    // After the checks on the runner's own Docker (the swap replaces that Docker), and nothing else runs after them.
    expect(job.steps.indexOf(swap)).toBe(job.steps.indexOf(check) + 1);
    expect(job.steps.indexOf(check25)).toBe(job.steps.indexOf(swap) + 1);
    expect(swap.run).toBe("sudo --preserve-env=TSL_DOCKER25_WORKER_IMAGE,RUNNER_TEMP bash scripts/ci-docker25-engine.sh");
    expect(swap.env).toEqual({ TSL_DOCKER25_WORKER_IMAGE: "rovara-worker:ci" });
    // The same script, the same worker image and driver (not rebuilt), and the exact version it must run on.
    expect(check25.run).toBe("sudo --preserve-env=TSL_CI_WORKER_IMAGE,TSL_CI_DRIVER_JS,TSL_EXPECT_DOCKER_VERSION,TSL_EGRESS_CAPTURE,RUNNER_TEMP bash scripts/ci-test-services-linux.sh");
    expect(check25.env).toEqual({ TSL_CI_WORKER_IMAGE: "rovara-worker:ci", TSL_CI_DRIVER_JS: "${{ runner.temp }}/tsl-live.mjs", TSL_EXPECT_DOCKER_VERSION: DOCKER25, TSL_EGRESS_CAPTURE: "1" });
    for (const step of [swap, check25]) {
      expect(YAML.stringify(step)).not.toMatch(/continue-on-error|\|\|\s*true/u);
      expect(step.uses).toBeUndefined();
    }
    // Bounded: the swap may take 10 minutes and the second check 45, and the job's limit leaves room for both on top of the 75 it had.
    expect(swap["timeout-minutes"]).toBe(10);
    expect(check25["timeout-minutes"]).toBe(45);
    expect(build["timeout-minutes"]).toBe(20);
    expect(check["timeout-minutes"]).toBe(45);
    // Each step has its own cap, so a hang fails at its step; the job limit stays at 120 (CI budget), not the sum of the caps.
    const caps = [build, check, swap, check25].map((step) => step["timeout-minutes"]!).reduce((a, b) => a + b, 0);
    expect(caps).toBe(120);
    expect(job["timeout-minutes"]).toBe(120);
    // Cheap: one job, one image build, one checkout. The Docker 25 steps add no other job, no build and no checkout.
    expect(job.steps.filter((step) => (step.run ?? "").includes("docker build"))).toHaveLength(2);
    expect(Object.keys(jobs).filter((name) => name.includes("docker25") || name.includes("docker-25"))).toEqual([]);
    // Changing the engine script re-runs these checks.
    const scope = jobs["scope"]!.steps.find((candidate) => candidate.id === "test_services")!;
    expect(new RegExp(/grep -Eq '([^']+)'/u.exec(scope.run!)![1]!, "u").test("scripts/ci-docker25-engine.sh")).toBe(true);
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
      "packages/worker/src/test-services-run.ts", "packages/worker/ec2/boot-stage2.sh", "packages/worker/ec2/boot.sh", "vendor/rovara-code/packages/contracts/src/service-catalog.ts", "vendor/rovara-code/packages/contracts/src/test-env-dependency.ts", "environments/base/Dockerfile", "environments/service-catalog/catalog.json",
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

describe("scripts/ci-docker25-engine.sh", () => {
  it("is valid bash that only runs when executed, and needs root", () => {
    expect(spawnSync("bash", ["-n"], { input: engineScript, encoding: "utf8" }).status).toBe(0);
    expect(engineScript).toContain('if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi');
    expect(engineCode).toContain("[[ $(id -u) -eq 0 ]]");
    expect(engineCode).not.toMatch(/(?:^|[\s;|(])aws\s+[a-z]|\bssm\b|AWS_/mu);
  });

  it("pins the exact version, downloads it from download.docker.com by that version, and verifies a SHA-256 for each CPU before unpacking", () => {
    expect(engineScript).toContain(`readonly DOCKER25_VERSION=${DOCKER25}`);
    expect(engineScript).toMatch(/^readonly DOCKER25_SHA256_AARCH64=[a-f0-9]{64}$/mu);
    expect(engineScript).toMatch(/^readonly DOCKER25_SHA256_X86_64=[a-f0-9]{64}$/mu);
    expect(engineCode).toContain('url="https://download.docker.com/linux/static/stable/$arch/docker-$DOCKER25_VERSION.tgz"');
    expect(engineCode).not.toMatch(/\blatest\b|get\.docker\.com|apt-get|apt install|yum|dnf/u);
    const verify = engineCode.indexOf("sha256sum -c");
    expect(verify).toBeGreaterThan(engineCode.indexOf("curl "));
    expect(verify).toBeLessThan(engineCode.indexOf("tar -xzf"));
    expect(engineCode).toMatch(/sha256sum -c - >&2 \|\| die/u);
  });

  it("requires the server AND the client to report exactly the pinned version, a separate data root, and the same worker image id after the load", () => {
    expect(engineCode).toContain('[[ "$server" == "$DOCKER25_VERSION" ]]');
    expect(engineCode).toContain('[[ "$client" == "$DOCKER25_VERSION" ]]');
    expect(engineCode).toContain("{{.DockerRootDir}}");
    // The image is compared by tag and layers, not by id (a runner on the containerd image store gives another id).
    expect(engineCode).toContain('[[ "$after_layers" == "$before_layers" ]]');
    expect(engineCode).not.toMatch(/== "\$id" \]\]/u);
    // The image is saved on the old engine before the swap and loaded after it; the old engine's data root is never opened by Docker 25.
    expect(engineCode.indexOf("docker save")).toBeLessThan(engineCode.indexOf("systemctl stop docker.service"));
    expect(engineCode.indexOf("systemctl stop docker.service")).toBeLessThan(engineCode.indexOf("docker load"));
    expect(engineScript).toContain("readonly DOCKER25_DATA_ROOT=/var/lib/docker25");
  });

  it("frees the old engine's disk after the save, removes its iptables chains, jumps and docker0 before the new engine starts, and keeps DOCKER-USER", () => {
    expect(engineCode.indexOf("docker save")).toBeLessThan(engineCode.indexOf("docker system prune -af"));
    expect(engineCode.indexOf("docker system prune -af")).toBeLessThan(engineCode.indexOf("systemctl stop docker.service"));
    expect(engineCode.indexOf("systemctl stop docker.service")).toBeLessThan(engineCode.indexOf("remove_docker_leftovers\n"));
    expect(engineCode.indexOf("remove_docker_leftovers\n")).toBeLessThan(engineCode.indexOf("systemctl restart docker.socket"));
    for (const chain of ["DOCKER-FORWARD", "DOCKER-CT", "DOCKER-BRIDGE", "DOCKER-INTERNAL", "DOCKER-ISOLATION-STAGE-1", "DOCKER-ISOLATION-STAGE-2"]) expect(engineCode, chain).toContain(chain);
    expect(engineCode).toContain("ip link delete docker0");
    expect(engineCode).not.toMatch(/DOCKER-USER/u);
    for (const state of ["iptables -S;", "iptables -t nat -S;", "ip link;", "df -h /;"]) expect(engineCode, state).toContain(state);
    // The rules step the second run applies never flushes DOCKER-USER: check-then-insert only.
    const stage2 = read("packages/worker/ec2/boot-stage2.sh");
    const firewall = read("packages/worker/ec2/boot.sh");
    expect(stage2 + firewall).not.toMatch(/iptables -F DOCKER-USER|iptables --flush DOCKER-USER/u);
  });

  describe("the clean-up of the old engine's kernel state, run for real against a stub iptables that keeps its state in a file", () => {
    const rules = (...entries: string[]): string[] => entries;
    // What Docker 28 leaves behind, plus the boot firewall's walls (DOCKER-USER and INPUT), as `iptables -S` would list them.
    const DOCKER28 = {
      filter: {
        INPUT: rules("-i rvb+ -j DROP", "-i rvi+ -j DROP"),
        FORWARD: rules("-j DOCKER-USER", "-j DOCKER-FORWARD"),
        "DOCKER-USER": rules("-d 169.254.169.254/32 -j DROP", "-i rvi+ ! -o rvi+ -j DROP", "-i rvi+ -o rvi+ -m physdev ! --physdev-is-bridged -j DROP"),
        "DOCKER-FORWARD": rules("-j DOCKER-CT", "-j DOCKER-ISOLATION-STAGE-1", "-j DOCKER-BRIDGE", "-j DOCKER-INTERNAL", "-i docker0 -j ACCEPT"),
        "DOCKER-CT": rules("-o docker0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT"),
        "DOCKER-BRIDGE": rules("-o docker0 -j DOCKER"),
        "DOCKER-INTERNAL": rules(),
        DOCKER: rules("! -i docker0 -o docker0 -j DROP"),
        "DOCKER-ISOLATION-STAGE-1": rules("-i docker0 ! -o docker0 -j DOCKER-ISOLATION-STAGE-2", "-j RETURN"),
        "DOCKER-ISOLATION-STAGE-2": rules("-o docker0 -j DROP", "-j RETURN"),
      },
      nat: {
        PREROUTING: rules("-m addrtype --dst-type LOCAL -j DOCKER"),
        OUTPUT: rules("! -d 127.0.0.0/8 -m addrtype --dst-type LOCAL -j DOCKER"),
        POSTROUTING: rules("-s 172.17.0.0/16 ! -o docker0 -j MASQUERADE"),
        DOCKER: rules("-i docker0 -j RETURN"),
      },
    };
    const BUILTIN = new Set(["INPUT", "FORWARD", "OUTPUT", "PREROUTING", "POSTROUTING"]);
    // A small iptables: -S, -D, -F, -X with the kernel's refusals (a chain that is not empty or is still jumped to cannot be deleted).
    const STUB = `#!${process.execPath}
const fs = require("node:fs");
const [state, log] = [process.env.STUB_STATE, process.env.STUB_LOG];
const tables = JSON.parse(fs.readFileSync(state, "utf8"));
let args = process.argv.slice(2);
fs.appendFileSync(log, "iptables " + args.join(" ") + "\\n");
let table = "filter";
if (args[0] === "-t") { table = args[1]; args = args.slice(2); }
const chains = tables[table] || (tables[table] = {});
const save = () => fs.writeFileSync(state, JSON.stringify(tables));
const fail = (m) => { process.stderr.write(m + "\\n"); process.exit(1); };
if (args[0] === "-S") {
  for (const [c, rs] of Object.entries(chains)) { console.log(${JSON.stringify("")} + (["INPUT","FORWARD","OUTPUT","PREROUTING","POSTROUTING"].includes(c) ? "-P " + c + " ACCEPT" : "-N " + c)); }
  for (const [c, rs] of Object.entries(chains)) for (const r of rs) console.log("-A " + c + " " + r);
} else if (args[0] === "-D") {
  const [c, ...rest] = args.slice(1); const rs = chains[c]; const i = rs ? rs.indexOf(rest.join(" ")) : -1;
  if (i < 0) fail("Bad rule (does a matching rule exist in that chain?)"); rs.splice(i, 1); save();
} else if (args[0] === "-F") {
  if (!chains[args[1]]) fail("No chain/target/match by that name"); chains[args[1]] = []; save();
} else if (args[0] === "-X") {
  const c = args[1]; if (!chains[c]) fail("No chain/target/match by that name");
  if (chains[c].length) fail("Directory not empty");
  for (const rs of Object.values(chains)) if (rs.some((r) => r.endsWith(" -j " + c) || r === "-j " + c)) fail("Too many links");
  delete chains[c]; save();
} else fail("unsupported: " + args.join(" "));
`;
    const run = (twice = false) => {
      const dir = mkdtempSync(join(tmpdir(), "docker25-clean-"));
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const state = join(dir, "state.json");
      const log = join(dir, "calls.log");
      writeFileSync(state, JSON.stringify(DOCKER28));
      writeFileSync(join(bin, "iptables"), STUB, { mode: 0o755 });
      writeFileSync(join(bin, "ip"), `#!/bin/bash\necho "ip $*" >> "${log}"\n`, { mode: 0o755 });
      const call = twice ? "remove_docker_leftovers; remove_docker_leftovers" : "remove_docker_leftovers";
      const ran = spawnSync("/bin/bash", ["-c", `source "$1"; set +e; ${call}; echo done`, "x", new URL("../../scripts/ci-docker25-engine.sh", import.meta.url).pathname], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, STUB_STATE: state, STUB_LOG: log } });
      const after = JSON.parse(readFileSync(state, "utf8")) as typeof DOCKER28;
      return { ran, after, calls: readFileSync(log, "utf8") };
    };

    it("removes every Docker 28 chain and every jump to it, the docker0 MASQUERADE and the docker0 link, and keeps DOCKER-USER and the INPUT walls as they were", () => {
      const { ran, after, calls } = run();
      expect(ran.stdout.trim(), ran.stderr).toBe("done");
      // The walls are untouched.
      expect(after.filter["DOCKER-USER"]).toEqual(DOCKER28.filter["DOCKER-USER"]);
      expect(after.filter["INPUT"]).toEqual(DOCKER28.filter["INPUT"]);
      // The jump into DOCKER-USER stays; the jump to Docker 28's chain is gone.
      expect(after.filter["FORWARD"]).toEqual(["-j DOCKER-USER"]);
      // No Docker 28 chain is left, in either table.
      expect(Object.keys(after.filter).sort()).toEqual(["DOCKER-USER", "FORWARD", "INPUT"]);
      expect(Object.keys(after.nat).sort()).toEqual(["OUTPUT", "POSTROUTING", "PREROUTING"]);
      expect(after.nat["PREROUTING"]).toEqual([]);
      expect(after.nat["OUTPUT"]).toEqual([]);
      expect(after.nat["POSTROUTING"]).toEqual([]);
      expect(calls).toContain("ip link delete docker0");
      // DOCKER-USER and INPUT were never flushed or deleted.
      expect(calls).not.toMatch(/-[FX] (DOCKER-USER|INPUT)\b/u);
    });

    it("is harmless to run again on the cleaned state (chains that are not there are tolerated)", () => {
      const { ran, after } = run(true);
      expect(ran.stdout.trim(), ran.stderr).toBe("done");
      expect(after.filter["DOCKER-USER"]).toEqual(DOCKER28.filter["DOCKER-USER"]);
    });

    it("positive control: the stub refuses to delete a chain that is still jumped to or not empty (so deleting in the wrong order would have shown)", () => {
      const dir = mkdtempSync(join(tmpdir(), "docker25-stub-"));
      const state = join(dir, "state.json");
      const log = join(dir, "log");
      writeFileSync(state, JSON.stringify(DOCKER28));
      writeFileSync(join(dir, "iptables"), STUB, { mode: 0o755 });
      const env = { PATH: "/usr/bin:/bin", STUB_STATE: state, STUB_LOG: log };
      expect(spawnSync(join(dir, "iptables"), ["-X", "DOCKER-FORWARD"], { env, encoding: "utf8" }).status).not.toBe(0);
      expect(spawnSync(join(dir, "iptables"), ["-t", "nat", "-X", "DOCKER"], { env, encoding: "utf8" }).status).not.toBe(0);
      expect(BUILTIN.has("INPUT")).toBe(true);
    });
  });

  describe("the checksum path, run for real with stubbed curl, sha256sum, tar and docker", () => {
    const run = (checksumOk: boolean) => {
      const dir = mkdtempSync(join(tmpdir(), "docker25-engine-"));
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const stub = (name: string, body: string): void => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 }); };
      const log = join(dir, "calls.log");
      stub("id", "echo 0");
      stub("sleep", "exit 0");
      stub("curl", `echo "curl $*" >> "${log}"; while [ $# -gt 0 ]; do [ "$1" = -o ] && { printf 'not really docker' > "$2"; }; shift; done; exit 0`);
      stub("sha256sum", `echo "sha256sum $* <$(cat)>" >> "${log}"; exit ${checksumOk ? 0 : 1}`);
      stub("tar", `echo "tar $*" >> "${log}"; exit 1`);
      stub("docker", [
        `echo "docker $*" >> "${log}"`,
        `case "$*" in`,
        `  "image inspect --format {{.Id}} rovara-worker:ci") echo sha256:${"a".repeat(64)} ;;`,
        `  "image inspect --format {{json .RepoTags}} rovara-worker:ci") echo '["rovara-worker:ci"]' ;;`,
        `  "image inspect --format {{json .RootFS.Layers}} rovara-worker:ci") echo '["sha256:${"b".repeat(64)}"]' ;;`,
        `  save*) touch "$3" ;;`,
        `  version*) echo 28.0.4 ;;`,
        `esac`, `exit 0`,
      ].join("\n"));
      // The unpack directory is pointed into the throwaway directory, so nothing on this machine is touched even if the path went further.
      const text = engineScript.replace("readonly DOCKER25_DIR=/opt/docker-25.0.5", `readonly DOCKER25_DIR=${join(dir, "opt-docker")}`);
      expect(text).not.toBe(engineScript);
      const file = join(dir, "engine.sh");
      writeFileSync(file, text);
      const ran = spawnSync("/bin/bash", [file], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, RUNNER_TEMP: dir, TSL_DOCKER25_WORKER_IMAGE: "rovara-worker:ci" } });
      let calls = "";
      try { calls = readFileSync(log, "utf8"); } catch { /* no call was made */ }
      return { status: ran.status, stderr: ran.stderr, calls };
    };

    it("a download that does not match the pinned checksum exits non-zero and tar never runs", () => {
      const r = run(false);
      expect(r.status, r.stderr).not.toBe(0);
      expect(r.stderr).toContain("does not match the pinned SHA-256");
      expect(r.calls).toMatch(/sha256sum -c - <[a-f0-9]{64} {2}.*docker\.tgz>/u);
      expect(r.calls).toContain("curl ");
      expect(r.calls).not.toMatch(/^tar /mu);
      // Nothing was stopped or swapped before the check.
      expect(r.calls).not.toMatch(/systemctl/u);
    });

    it("positive control: a matching checksum does reach tar (so the test would see it)", () => {
      const r = run(true);
      expect(r.calls).toMatch(/^tar -xzf /mu);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("could not unpack");
    });
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

  const judge = (output: string, expectedVersion = "", egress = "") => {
    const dir = mkdtempSync(join(tmpdir(), "tsl-judge-"));
    const file = join(dir, "out");
    writeFileSync(file, output);
    const ran = spawnSync("bash", ["-c", 'source "$1"; judge "$2" "$3" "$4"', "x", new URL("../../scripts/ci-test-services-linux.sh", import.meta.url).pathname, file, expectedVersion, egress], { encoding: "utf8" });
    return { status: ran.status, err: ran.stderr };
  };
  const LIVE = ["L1.live", "L1.live-other-run", "L2.live", "L3.live", "L3.embedded-resolver", "L3.embedded-resolver-blocked", "L3.working-relay", "L3.ipv6", "L3.no-route", "L3.other-run", "L3.multicast", "L3.run-files", "L3.spoofing", "L4.live", "L4.template-db", "L6.live"];
  const good = (): string[] => [
    "TSL L1.walls PASS walls | ok", "TSL L1.pools PASS pools | ok", ...LIVE.map((id) => `TSL ${id} PASS name | saw`),
    "TSL L1.internal-drops PENDING x | later", "TSL L5.live PENDING x | later", "TSL L7.live PENDING x | later", "TSL L8.live PENDING x | later", "TSL SUMMARY pass=18 fail=0 pending=4",
  ];

  it("makes the agentx-task network the way the worker's task sandbox does (a bridge with the walled rvbtask interface), before the driver runs and after the address pools, so L2 has its working network", () => {
    const worker = readFileSync(new URL("../../packages/worker/src/task-network.ts", import.meta.url), "utf8");
    expect(worker).toContain('return ["network", "create", "--driver", "bridge", "--opt", `com.docker.network.bridge.name=${TASK_SANDBOX_BRIDGE}`, TASK_SANDBOX_NETWORK];');
    expect(worker).toContain('export const TASK_SANDBOX_NETWORK = "agentx-task";');
    expect(worker).toContain('export const TASK_SANDBOX_BRIDGE = "rvbtask";');
    const create = scriptCode.indexOf("docker network create --driver bridge --opt com.docker.network.bridge.name=rvbtask agentx-task");
    expect(create).toBeGreaterThan(scriptCode.indexOf("apply_rules \"$root\" || return 1"));
    expect(create).toBeLessThan(scriptCode.indexOf("tsl-live.mjs ci"));
    expect(scriptCode).not.toMatch(/network rm[^\n]*agentx-task/u);
  });

  it("TS-SEAL-6: with an expected Docker version the judge also needs the L1.docker-version PASS line to name exactly that version", () => {
    const withVersion = (version: string, status = "PASS"): string => `TSL L1.docker-version ${status} docker-has-the-CVE-2024-29018-fix | Docker Engine ${version}\n${good().join("\n")}\n`;
    expect(judge(withVersion(DOCKER25), DOCKER25).status).toBe(0);
    // Without an expectation (the runner's own Docker) the judge does not look at the version.
    expect(judge(withVersion("28.0.4")).status).toBe(0);
    for (const [label, output] of [["another version", withVersion("28.0.4")], ["a longer version", withVersion("25.0.55")], ["a version that only starts the same", withVersion("125.0.5")], ["a failed version line", withVersion(DOCKER25, "FAIL")], ["no version line", `${good().join("\n")}\n`]] as const) {
      expect(judge(output, DOCKER25).status, label).toBe(1);
    }
    // The script itself refuses to start on a daemon that is not the expected version, and reads the expectation from the environment.
    expect(scriptCode).toContain('judge "$check_out" "${TSL_EXPECT_DOCKER_VERSION:-}"');
    expect(scriptCode).toContain('[[ "$running" == "$TSL_EXPECT_DOCKER_VERSION" ]]');
  });

  it("judge passes a full run with only the known later-slice items pending", () => {
    expect(judge(`${good().join("\n")}\n`).status).toBe(0);
  });
  it("judge fails on any FAIL, any TSL ERROR or BLOCKED, an unexpected PENDING, a live item with no PASS, a missing or failing summary, and an empty output", () => {
    const cases: Array<[string, string[]]> = [
      ["a FAIL", good().map((line) => (line.startsWith("TSL L4.template-db") ? line.replace(" PASS ", " FAIL ") : line)).filter((line) => !line.startsWith("TSL SUMMARY")).concat("TSL SUMMARY pass=17 fail=1 pending=4")],
      ["a read-only FAIL", [...good(), "TSL L1.range FAIL range | overlaps"]],
      ["an error", ["TSL ERROR the CI driver gave no lines", ...good()]], ["blocked", ["TSL BLOCKED x", ...good()]],
      ["an unexpected pending", good().map((line) => line.replace("TSL L3.spoofing PASS", "TSL L3.spoofing PENDING"))],
      ["a missing live item", good().filter((line) => !line.startsWith("TSL L6.live"))],
      ["the resolver guard item missing", good().filter((line) => !line.startsWith("TSL L3.embedded-resolver-blocked"))],
      ["the resolver guard item failing", good().map((line) => line.replace("TSL L3.embedded-resolver-blocked PASS", "TSL L3.embedded-resolver-blocked FAIL"))],
      ["no summary", good().filter((line) => !line.startsWith("TSL SUMMARY"))], ["a summary with failures", [...good().slice(0, -1), "TSL SUMMARY pass=17 fail=1 pending=4"]], ["nothing", []],
    ];
    for (const [label, lines] of cases) expect(judge(`${lines.join("\n")}\n`).status, label).toBe(1);
  });
});

describe("TS-SEAL egress capture (scripts/ci-egress-capture.sh) on the Docker 25 leg", () => {
  const job = jobs["linux-runtime"]!;
  const check25 = job.steps.find((step) => (step.name ?? "").startsWith("Test services Linux checks on Docker 25.0.5 (rules"))!;
  const check28 = job.steps.find((step) => (step.name ?? "").startsWith("Test services Linux checks (rules"))!;

  it("is switched on for the Docker 25 check only, kept through sudo, and the job uploads nothing (the pcap is never an artifact)", () => {
    expect(check25.env?.["TSL_EGRESS_CAPTURE"]).toBe("1");
    expect(check25.run).toContain("TSL_EGRESS_CAPTURE");
    expect(check28.env?.["TSL_EGRESS_CAPTURE"]).toBeUndefined();
    expect(JSON.stringify(job)).not.toMatch(/upload-artifact/u);
    expect(egressCode).not.toMatch(/upload|curl|aws /u);
    expect(script).toContain('rm -f "$EG_DIR/all.pcap"');
    // Changing the capture re-runs the checks.
    const scope = jobs["scope"]!.steps.find((candidate) => candidate.id === "test_services")!;
    expect(new RegExp(/grep -Eq '([^']+)'/u.exec(scope.run!)![1]!, "u").test("scripts/ci-egress-capture.sh")).toBe(true);
  });

  it("starts tcpdump before the probes and the driver, stops it after the checker, and puts the verdict in the checker's output before the judge", () => {
    const at = (needle: string): number => scriptCode.indexOf(needle);
    expect(at("eg_prepare")).toBeGreaterThan(at("apply_rules \"$root\" || return 1"));
    expect(at("eg_capture_start")).toBeLessThan(at("eg_probes"));
    expect(at("eg_probes")).toBeLessThan(at("tsl-live.mjs ci"));
    expect(at("linux-check-test-services.sh")).toBeLessThan(at("eg_capture_stop"));
    expect(at("eg_capture_stop")).toBeLessThan(at('eg_verdict "$EG_DIR/all.txt"'));
    expect(at('eg_verdict "$EG_DIR/all.txt"')).toBeLessThan(at('judge "$check_out"'));
    expect(scriptCode).toContain('>> "$check_out"');
    expect(scriptCode).toContain("{ log \"FAIL: the egress capture could not be set up\"; return 1; }");
    expect(scriptCode).toContain("trap 'cleanup_labelled; eg_cleanup' EXIT");
  });

  it("captures every interface with a bounded size, probes with the sealed sandbox's flags and no DNS option, and queries 127.0.0.11 directly", () => {
    // As root (tcpdump would drop to its own user before opening a file in a root-owned directory), for the capture and for the render.
    expect(egressCode).toMatch(/tcpdump -Z root -i any -nn -e -s "\$EG_SNAPLEN" -U -c "\$EG_CAPTURE_MAX_PACKETS" -w /u);
    expect(egressCode).toContain('tcpdump -Z root -nn -e -r "$EG_DIR/all.pcap"');
    expect(egressCode).toContain('chmod 0755 "$EG_DIR"');
    expect(egressCode).toContain("DEBIAN_FRONTEND=noninteractive apt-get install");
    expect(egressCode).toContain("--internal");
    expect(egressCode).toContain("com.docker.network.bridge.name=$EG_BRIDGE");
    expect(egressCode).toMatch(/EG_BRIDGE=rvi\$\(/u);
    for (const flag of ["--cap-drop ALL", "--security-opt no-new-privileges", "--read-only", "--user 1000:1000", "--pids-limit 4096"]) expect(egressCode, flag).toContain(flag);
    expect(egressCode).not.toMatch(/--dns|--cap-add|--privileged|--network host/u);
    expect(egressCode).toContain('["127.0.0.11"]');
    expect(egressCode).toContain('"$EG_TOKEN-sealed.example"');
    expect(egressCode).toContain('name + "-control.example", null');
    expect(egressCode).toContain('name + "-direct.example", ["1.1.1.1"]');
    // The probe containers are named and removed on exit; the pcap is deleted on exit.
    expect(egressCode).toContain('--name "$EG_SEALED_CONTAINER"');
    expect(egressCode).toContain('--name "$EG_OPEN_CONTAINER"');
    expect(egressCode).toMatch(/eg_cleanup\(\) \{[\s\S]*?docker rm -f "\$EG_SEALED_CONTAINER" "\$EG_OPEN_CONTAINER"[\s\S]*?rm -f "\$EG_DIR\/all\.pcap"/u);
    // The control runs on a network that is NOT internal.
    const open = egressCode.slice(egressCode.indexOf('docker network create --driver bridge "$EG_OPEN_NETWORK"'));
    expect(open.split("\n")[0]).not.toContain("--internal");
    // Both probes' networks are removed again before the driver starts and on exit.
    expect(egressCode.match(/docker network rm "\$EG_SEALED_NETWORK" "\$EG_OPEN_NETWORK"/gu)!.length).toBeGreaterThanOrEqual(3);
    // Re-sourcing the library (which declares readonly constants) is harmless.
    expect(spawnSync("bash", ["-c", 'source "$1"; source "$1"; echo twice', "x", new URL("../../scripts/ci-egress-capture.sh", import.meta.url).pathname], { encoding: "utf8" }).stdout.trim()).toBe("twice");
    // The embedded resolver's per-round neutraliser (the other lane) is not assumed: the check holds with or without it.
    expect(egressScript).toContain("with or without a per-round DROP of 127.0.0.11");
  });

  describe("the verdict", () => {
    const TOKEN = "egress0a1b2c3d4e5f";
    const BRIDGE = "rvi0a1b2c3d";
    const line = (iface: string, from: string, to: string, extra = "UDP, length 1", direction = "Out"): string =>
      `12:00:00.000001 ${iface} ${direction} ifindex 2 aa:bb:cc:dd:ee:ff ethertype IPv4 (0x0800), length 90: ${from} > ${to}: ${extra}`;
    const line6 = (iface: string, from: string, to: string, direction = "Out"): string =>
      `12:00:00.000002 ${iface} ${direction} ifindex 9 aa:bb:cc:dd:ee:ff ethertype IPv6 (0x86dd), length 90: ${from} > ${to}: ICMP6, neighbor solicitation`;
    const GOOD = [
      line("eth0", "10.1.0.4.40000", "168.63.129.16.53", `12345+ A? ${TOKEN}-control.example. (50)`),
      line("eth0", "10.1.0.4.40002", "1.1.1.1.53", `12346+ A? ${TOKEN}-direct.example. (50)`),
      line("eth0", "10.1.0.4.40001", "168.63.129.16.53", `4321+ A? registry.example.com. (40)`),
      line(BRIDGE, "172.30.254.4.5000", "172.30.254.1.9", "UDP, length 1", "In"),
      "12:00:00.000009 rvi0a1b2c3d In  ifindex 9 aa:bb:cc:dd:ee:ff ethertype ARP (0x0806), length 28: Request who-has 172.30.254.1 tell 172.30.254.4, length 28",
      line6("eth0", "fe80::1", "ff02::2"),
      line6(BRIDGE, "fe80::4", "ff02::1:ff00:1"),
    ];
    const OK_PROBE = '{"embedded":"ETIMEOUT","gateway":"sent","public":"ENETUNREACH"}';
    const verdict = (lines: string[], extra: { probe?: string | null; packets?: string; uplinkIps?: string; alive?: string; ifindex?: string } = {}): { status: number | null; out: string; lines: string[] } => {
      const dir = mkdtempSync(join(tmpdir(), "eg-verdict-"));
      writeFileSync(join(dir, "all.txt"), `${lines.join("\n")}\n`);
      if (extra.probe !== null) writeFileSync(join(dir, "probe-sealed.json"), extra.probe ?? OK_PROBE);
      const ran = spawnSync("bash", ["-c", 'source "$1"; EG_DIR=$2 EG_TOKEN=$3 EG_UPLINK=eth0 EG_UPLINK_IPS="$4" EG_BRIDGE=$5 EG_PACKETS=$6 EG_TCPDUMP_ALIVE=$7 EG_BRIDGE_IFINDEX=$8; eg_verdict "$2/all.txt"', "x", new URL("../../scripts/ci-egress-capture.sh", import.meta.url).pathname, dir, TOKEN, extra.uplinkIps ?? "10.1.0.4 ", BRIDGE, extra.packets ?? "500", extra.alive ?? "1", extra.ifindex ?? "9"], { encoding: "utf8" });
      return { status: ran.status, out: ran.stdout.trim(), lines: ran.stdout.trim().split("\n") };
    };

    it("PASS when both control lookups are on the uplink, the sealed token is nowhere, no container address leaves, and the bridge stays inside its /24", () => {
      const r = verdict(GOOD);
      expect(r.out, r.out).toMatch(/^TSL L3\.egress-capture PASS no-sealed-token-or-container-source-leak-seen \| /u);
      expect(r.lines).toHaveLength(1);
      expect(r.status).toBe(0);
    });

    it("sees the bridge from the probe's ARP alone (CI run 42090076679: the gateway packet was queued behind ARP), but never from anything that is not the probe", () => {
      const arpOnly = GOOD.filter((entry) => !(entry.includes(BRIDGE) && entry.includes("ethertype IPv4")));
      const r = verdict(arpOnly);
      expect(r.out, r.out).toMatch(/^TSL L3\.egress-capture PASS /u);
      const ipv4Only = GOOD.filter((entry) => !(entry.includes(BRIDGE) && entry.includes("ARP")));
      expect(verdict(ipv4Only).out).toMatch(/^TSL L3\.egress-capture PASS /u);
      // Another address on the bridge (not the probe's .4), or the probe's address on another interface, is still blind.
      const otherAddress = GOOD.map((entry) => (entry.includes(BRIDGE) ? entry.replaceAll("172.30.254.4", "172.30.254.9") : entry));
      expect(verdict(otherAddress).out).toMatch(/FAIL .*capture-blind-nothing-seen-on-the-rvi-bridge/u);
      const otherInterface = GOOD.map((entry) => (entry.includes("172.30.254.4") ? entry.replace(BRIDGE, "veth1234567") : entry));
      expect(verdict(otherInterface).out).toMatch(/FAIL .*capture-blind-nothing-seen-on-the-rvi-bridge/u);
      // A line that only mentions the address elsewhere (say as a destination) does not count either.
      const asDestination = GOOD.filter((entry) => !entry.includes(BRIDGE) || entry.includes("IPv6")).concat(line(BRIDGE, "172.30.254.1.9", "172.30.254.4.5000", "UDP, length 1", "Out"));
      expect(verdict(asDestination).out).toMatch(/FAIL .*capture-blind-nothing-seen-on-the-rvi-bridge/u);
    });

    it("matches the probe bridge by its ifindex when it was deleted before the render and prints as '?' (CI run 42104894037), and never counts any other '?' line", () => {
      // The real shape: the bridge is gone when tcpdump -r runs, so its lines carry "?" and only the ifindex says which interface they were.
      const probeLines = (index: string): string[] => [
        `12:00:00.000001 ? In ifindex ${index} aa:bb:cc:dd:ee:ff ethertype IPv4 (0x0800), length 90: 172.30.254.4.5000 > 172.30.254.1.9: UDP, length 1`,
        `12:00:00.000009 ? B ifindex ${index} aa:bb:cc:dd:ee:ff ethertype ARP (0x0806), length 28: Request who-has 172.30.254.1 tell 172.30.254.4, length 28`,
      ];
      const withoutBridge = GOOD.filter((entry) => !entry.includes(BRIDGE) || entry.includes("IPv6"));
      expect(withoutBridge.some((entry) => entry.includes("172.30.254.4"))).toBe(false);
      const ok = verdict([...withoutBridge, ...probeLines("9")], { ifindex: "9" });
      expect(ok.out, ok.out).toMatch(/^TSL L3\.egress-capture PASS /u);
      // Another "?" interface, or no recorded ifindex, is blind.
      expect(verdict([...withoutBridge, ...probeLines("11")], { ifindex: "9" }).out).toMatch(/FAIL .*capture-blind-nothing-seen-on-the-rvi-bridge/u);
      expect(verdict([...withoutBridge, ...probeLines("9")], { ifindex: "" }).out).toMatch(/FAIL .*capture-blind-nothing-seen-on-the-rvi-bridge/u);
      // The bridge rules apply to the matched "?" lines: a packet to outside the /24 is a leak.
      const leak = verdict([...GOOD, "12:00:00.000010 ? Out ifindex 9 aa:bb:cc:dd:ee:ff ethertype IPv4 (0x0800), length 90: 172.30.254.4.5000 > 8.8.8.8.53: UDP, length 1"], { ifindex: "9" });
      expect(leak.out).toMatch(/FAIL .*rvi-bridge-packets-to-outside-the-run-subnet-1/u);
      // Non-link-local IPv6 on any deleted interface fails (it could have been a run bridge).
      expect(verdict([...GOOD, line6("?", "2001:db8::4", "2001:4860:4860::8888")], { ifindex: "9" }).out).toMatch(/FAIL .*rvi-bridge-non-link-local-ipv6-1-packets/u);
      // The blind evidence names the ifindex of each "?" interface and the probe bridge's own.
      const blind = verdict([...withoutBridge, ...probeLines("14")], { ifindex: "9" });
      expect(blind.out).toMatch(/egress-evidence: lines-per-interface: \?\(ifindex 14\) 2/u);
      expect(blind.out).toMatch(/egress-evidence: probe-bridge: rvi0a1b2c3d ifindex 9/u);
    });

    it("reads the probe bridge's ifindex when it makes the bridge", () => {
      expect(egressScript).toMatch(/EG_BRIDGE_IFINDEX=\$\(cat "\/sys\/class\/net\/\$EG_BRIDGE\/ifindex"/u);
    });

    it("a blind bridge prints what each interface carried, so the next failure can be diagnosed", () => {
      const r = verdict(GOOD.filter((entry) => !entry.includes(BRIDGE) || entry.includes("IPv6")).concat(line("veth1234567", "172.30.254.4.5000", "172.30.254.1.9")));
      expect(r.out).toMatch(/FAIL .*capture-blind-nothing-seen-on-the-rvi-bridge/u);
      expect(r.out).toMatch(/egress-evidence: lines-per-interface: eth0 \d+/u);
      expect(r.out).toMatch(/egress-evidence: rvi-or-veth-line: .*veth1234567/u);
    });

    it("the sealed probe waits for ARP before it moves on, and sends to the gateway twice", () => {
      expect(egressScript).toMatch(/send\("gateway", gateway, 9, \(\) => later\(1500, \(\) => send\("gateway2", gateway, 9/u);
    });

    it("the PASS name says what was checked and does not claim that nothing at all left the host", () => {
      expect(verdict(GOOD).out).not.toMatch(/no-packet-left-the-host/u);
      expect(egressScript).toMatch(/masquerade/iu);
      expect(egressScript).toMatch(/internal network has no masquerade/iu);
    });

    it("FAIL, never a pass, when the capture is blind or incomplete", () => {
      const noSystem = GOOD.filter((entry) => !entry.includes("-control"));
      const noDirect = GOOD.filter((entry) => !entry.includes("-direct"));
      const onlyDirectOnUplink = GOOD.map((entry) => entry.replace(`${TOKEN}-control`, `${TOKEN}-other`));
      const controlElsewhere = GOOD.map((entry) => entry.replace("eth0 Out ifindex 2 aa:bb:cc:dd:ee:ff ethertype IPv4 (0x0800), length 90: 10.1.0.4.40000", "docker0 Out ifindex 3 aa:bb:cc:dd:ee:ff ethertype IPv4 (0x0800), length 90: 10.1.0.4.40000"));
      const noBridge = GOOD.filter((entry) => !entry.includes(BRIDGE) || entry.includes("IPv6"));
      for (const [label, result, reason] of [
        ["no system lookup", verdict(noSystem), /capture-blind-system-lookup-not-seen-on-the-uplink/u],
        ["only the direct query", verdict(onlyDirectOnUplink), /capture-blind-system-lookup-not-seen-on-the-uplink/u],
        ["no direct query", verdict(noDirect), /capture-blind-direct-query-not-seen-on-the-uplink/u],
        ["control on another interface", verdict(controlElsewhere), /capture-blind-system-lookup-not-seen-on-the-uplink/u],
        ["nothing on the bridge", verdict(noBridge), /capture-blind-nothing-seen-on-the-rvi-bridge/u],
        ["empty capture", verdict([]), /capture-empty/u],
        ["no sealed probe result", verdict(GOOD, { probe: null }), /sealed-probe-gave-no-result/u],
        ["a truncated capture", verdict(GOOD, { packets: "1000000" }), /capture-truncated/u],
        ["tcpdump gone before the end", verdict(GOOD, { alive: "0" }), /tcpdump-was-not-running-at-the-end/u],
        ["no packet count", verdict(GOOD, { packets: "" }), /capture-packet-count-unreadable/u],
        ["a packet count that is not a number", verdict(GOOD, { packets: "lots" }), /capture-packet-count-unreadable/u],
      ] as const) {
        expect(result.lines[0], label).toMatch(/^TSL L3\.egress-capture FAIL /u);
        expect(result.out, label).toMatch(reason);
        expect(result.status, label).toBe(1);
      }
    });

    it("the sealed probe must prove the query was sent and got no answer", () => {
      const probe = (embedded: string, gateway = '"sent"', publicAddress = '"ENETUNREACH"'): string => `{"embedded":${embedded},"gateway":${gateway},"public":${publicAddress}}`;
      for (const answer of ['"ETIMEOUT"', '"ESERVFAIL"', '"ENOTFOUND"', '"ENODATA"', '"EREFUSED"']) expect(verdict(GOOD, { probe: probe(answer) }).status, answer).toBe(0);
      for (const [label, text, reason] of [
        ["ECONNREFUSED", probe('"ECONNREFUSED"'), /sealed-probe-embedded-query-not-sent-or-answered/u],
        ["ENETUNREACH on the embedded query", probe('"ENETUNREACH"'), /sealed-probe-embedded-query-not-sent-or-answered/u],
        ["an address came back", probe("1"), /sealed-probe-embedded-query-not-sent-or-answered/u],
        ["no embedded key", '{"gateway":"sent","public":"ENETUNREACH"}', /sealed-probe-embedded-query-not-sent-or-answered/u],
        ["the gateway packet was not sent", probe('"ETIMEOUT"', '"EPERM"'), /sealed-probe-gateway-packet-not-sent/u],
        ["8.8.8.8 had a route", probe('"ETIMEOUT"', '"sent"', '"sent"'), /sealed-probe-public-address-had-a-route/u],
      ] as const) {
        const r = verdict(GOOD, { probe: text });
        expect(r.lines[0], label).toMatch(/^TSL L3\.egress-capture FAIL /u);
        expect(r.out, label).toMatch(reason);
      }
    });

    it("FAIL when the sealed token is seen on any interface, in any case, with the lines printed as evidence", () => {
      for (const where of ["eth0", BRIDGE, "lo", "docker0"]) {
        const r = verdict([...GOOD, line(where, "172.30.254.4.53000", "127.0.0.11.53", `99+ A? ${TOKEN}-sealed.example. (50)`)]);
        expect(r.out, where).toMatch(/FAIL .*sealed-token-seen-1-times/u);
        expect(r.out, where).toContain("egress-evidence: sealed-token-line:");
      }
      expect(verdict([...GOOD, line("eth0", "10.1.0.4.1", "10.1.0.2.53", `99+ A? ${TOKEN.toUpperCase()}-SEALED.EXAMPLE. (50)`)]).status).toBe(1);
    });

    it("FAIL for a container address as the source of an OUTGOING packet on the uplink, except the uplink's own address; incoming packets are not counted", () => {
      for (const source of ["172.17.0.2.5000", "172.30.5.4.1", "192.168.5.4.1"]) {
        expect(verdict([...GOOD, line("eth0", source, "8.8.8.8.53")]).out, source).toMatch(/FAIL .*container-address-as-source-on-the-uplink-1-packets/u);
      }
      expect(verdict([...GOOD, line("eth0", "172.17.0.2.5000", "8.8.8.8.53")]).out).toContain("egress-evidence: uplink-container-source: eth0 Out 172.17.0.2 8.8.8.8");
      expect(verdict([...GOOD, line("eth0", "172.31.9.9.443", "8.8.8.8.443")], { uplinkIps: "10.1.0.4 172.31.9.9 " }).status).toBe(0);
      expect(verdict([...GOOD, line("docker0", "172.17.0.2.5000", "172.17.0.1.53")]).status).toBe(0);
      expect(verdict([...GOOD, line("eth0", "172.20.0.9.443", "10.1.0.4.443", "UDP", "In")]).status).toBe(0);
    });

    it("reads every direction tcpdump prints (In, Out, B, M, P) and exempts multicast, broadcast and 0.0.0.0 on the bridge", () => {
      for (const direction of ["In", "Out", "B", "M", "P"]) {
        const lines = [GOOD[0]!, GOOD[1]!, line(BRIDGE, "172.30.254.4.5000", "172.30.254.1.9", "UDP, length 1", direction)];
        expect(verdict(lines).status, `bridge packet, direction ${direction}`).toBe(0);
        // A packet to the outside is seen whatever the direction field says.
        expect(verdict([...GOOD, line(BRIDGE, "172.30.254.4.5000", "8.8.8.8.53", "UDP, length 1", direction)]).out, direction).toMatch(/FAIL .*rvi-bridge-packets-to-outside-the-run-subnet-1/u);
      }
      for (const destination of ["224.0.0.251.5353", "239.255.255.250.1900", "255.255.255.255.67", "0.0.0.0.68"]) {
        expect(verdict([...GOOD, line(BRIDGE, "172.30.254.4.5000", destination, "UDP, length 1", "M")]).status, destination).toBe(0);
      }
    });

    it("FAIL for an IPv4 packet on the rvi bridge to a destination outside the run's /24 (8.8.8.8, the metadata address, another run's /24); ARP is ignored; the evidence is bounded", () => {
      for (const destination of ["8.8.8.8.53", "169.254.169.254.80", "172.30.253.4.80", "10.0.0.1.80"]) {
        expect(verdict([...GOOD, line(BRIDGE, "172.30.254.4.5000", destination)]).out, destination).toMatch(/FAIL .*rvi-bridge-packets-to-outside-the-run-subnet-1/u);
      }
      const many = verdict([...GOOD, ...Array.from({ length: 100 }, (_, index) => line(BRIDGE, "172.30.254.4.5000", `8.8.8.${index}.53`))]);
      expect(many.out).toMatch(/rvi-bridge-packets-to-outside-the-run-subnet-100/u);
      expect(many.lines.filter((entry) => entry.startsWith("egress-evidence: rvi-outside-subnet:"))).toHaveLength(40);
    });

    it("FAIL for non-link-local IPv6 on ANY rvi bridge (not only the probe's); link-local, ff02 and :: are fine", () => {
      for (const bridge of [BRIDGE, "rvi99999999"]) {
        const r = verdict([...GOOD, line6(bridge, "fe80::4", "2001:4860:4860::8888")]);
        expect(r.out, bridge).toMatch(/FAIL .*rvi-bridge-non-link-local-ipv6-1-packets/u);
        expect(r.out, bridge).toContain("egress-evidence: rvi-ipv6:");
        expect(verdict([...GOOD, line6(bridge, "2001:db8::4", "ff02::1")]).out, bridge).toMatch(/non-link-local-ipv6-1/u);
      }
      expect(verdict([...GOOD, line6("rvi99999999", "::", "ff02::16"), line6("rvi99999999", "febf::1", "fe80::2")]).status).toBe(0);
      // IPv6 on the uplink is not this check's business.
      expect(verdict([...GOOD, line6("eth0", "2600:1f13::4", "2606:4700::1111")]).status).toBe(0);
    });

    it("on FAIL prints the evidence (lines starting egress-evidence:, never a payload), on PASS prints none", () => {
      const r = verdict([...GOOD, line("eth0", "172.17.0.2.5000", "8.8.8.8.53", "secret-looking payload")]);
      expect(r.lines[0]).toMatch(/^TSL /u);
      expect(r.lines.slice(1).every((entry) => entry.startsWith("egress-evidence: "))).toBe(true);
      expect(r.out).not.toContain("secret-looking");
      expect(verdict(GOOD).lines).toHaveLength(1);
    });
  });

  it("the job's judge requires the egress line to be PASS when the capture was on, and ignores it when it was off", () => {
    const base = (): string[] => [
      "TSL L1.walls PASS walls | ok", ...["L1.live", "L1.live-other-run", "L2.live", "L3.live", "L3.embedded-resolver", "L3.embedded-resolver-blocked", "L3.working-relay", "L3.ipv6", "L3.no-route", "L3.other-run", "L3.multicast", "L3.run-files", "L3.spoofing", "L4.live", "L4.template-db", "L6.live"].map((id) => `TSL ${id} PASS name | saw`),
      "TSL L1.internal-drops PENDING x | later", "TSL L5.live PENDING x | later", "TSL L7.live PENDING x | later", "TSL L8.live PENDING x | later", "TSL SUMMARY pass=18 fail=0 pending=4",
    ];
    const run = (lines: string[], egress: string): number | null => {
      const dir = mkdtempSync(join(tmpdir(), "tsl-judge-eg-"));
      const file = join(dir, "out");
      writeFileSync(file, `${lines.join("\n")}\n`);
      return spawnSync("bash", ["-c", 'source "$1"; judge "$2" "" "$3"', "x", new URL("../../scripts/ci-test-services-linux.sh", import.meta.url).pathname, file, egress], { encoding: "utf8" }).status;
    };
    const pass = "TSL L3.egress-capture PASS no-sealed-token-or-container-source-leak-seen | control seen";
    expect(run([...base(), pass], "1")).toBe(0);
    expect(run(base(), "1")).toBe(1);
    expect(run([...base(), "TSL L3.egress-capture FAIL no-sealed-token-or-container-source-leak-seen | capture-blind-system-lookup-not-seen-on-the-uplink"], "1")).toBe(1);
    expect(run([...base(), "TSL L3.egress-capture PASS-ish"], "1")).toBe(1);
    expect(run(base(), "0")).toBe(0);
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
