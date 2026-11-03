import { readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { gateVerdict, needsVerdict } from "../../scripts/ci-gate.js";
import { CLOUD_REPOSITORY, PUBLIC_REPOSITORY, conditionFor, timeoutFor } from "../support/workflow-expression.js";

interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  "timeout-minutes"?: number | string;
  strategy?: { "fail-fast"?: boolean; matrix?: { shard?: number[] } };
  steps: Array<{ id?: string; name?: string; if?: string; run?: string; uses?: string; env?: Record<string, string> }>;
}
interface Workflow {
  on?: unknown;
  concurrency?: { group?: string; "cancel-in-progress"?: string | boolean };
  jobs: Record<string, Job>;
}

const workflow = async () => YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as Workflow;

describe("CI runs its checks side by side (a Markdown-only change skips them all)", () => {
  it("splits the tests across shards that each run on their own machine, and a failing shard does not hide the others", async () => {
    const test = (await workflow()).jobs.test!;
    expect(test.strategy?.["fail-fast"]).toBe(false);
    expect(test.strategy?.matrix?.shard).toEqual([1, 2, 3, 4, 5, 6]);
    expect(test.steps.some((step) => step.run === "npm test -- --shard=${{ matrix.shard }}/${{ strategy.job-total }}")).toBe(true);
  });

  it("keeps checks, lint, tests, the release check and the Linux runtime check in jobs of their own", async () => {
    const { jobs } = await workflow();
    expect(jobs.checks!.needs).toBe("scope");
    for (const name of ["lint", "test", "release", "linux-runtime", "mcp-runner-linux", "web-e2e"]) expect(jobs[name], name).toBeDefined();
  });

  it("downloads the browsers in the browser job only, from a cache keyed on the Playwright version, and pins the cache action by commit", async () => {
    const { jobs } = await workflow();
    const e2e = jobs["web-e2e"]!.steps;
    const cache = e2e.find((step) => step.uses?.startsWith("actions/cache@"));
    expect(cache?.uses).toMatch(/^actions\/cache@[0-9a-f]{40}( #.*)?$/);
    // The install is skipped on a hit and runs in full on a miss; neither can be the only install a job without the cache has.
    const installs = e2e.filter((step) => /playwright install/.test(step.run ?? ""));
    expect(installs.map((step) => step.if)).toEqual([`steps.${cache?.id}.outputs.cache-hit != 'true'`, `steps.${cache?.id}.outputs.cache-hit == 'true'`]);
    for (const [name, job] of Object.entries(jobs)) if (name !== "web-e2e") expect(job.steps.some((step) => /playwright install/.test(step.run ?? "") || step.uses?.startsWith("actions/cache@")), name).toBe(false);
  });

  // Owner decision "CI cost" (2026-11-02): lint and type checks first, the expensive jobs only if they pass. `checks` is the type check alone (a few minutes), so the shards are not held back
  // by the 16-minute lint; the lint waits for `checks` too and then runs beside the shards.
  it("starts the lint, the test shards, the release check, the Linux runtime check, the MCP runner check and the browser tests only after the type checks pass", async () => {
    const { jobs } = await workflow();
    for (const name of ["lint", "test", "release", "linux-runtime", "mcp-runner-linux", "web-e2e"]) expect(jobs[name]!.needs, name).toEqual(["scope", "checks"]);
  });

  it("keeps the full-repository lint out of the job that gates the others, and the type checks in it", async () => {
    const { jobs } = await workflow();
    const run = (name: string) => jobs[name]!.steps.map((step) => step.run ?? "");
    expect(run("checks")).toEqual(expect.arrayContaining(["npm run typecheck", "npm run typecheck:all"]));
    expect(run("checks")).not.toContain("npm run lint");
    // The lint programs read the declarations that tsc -b leaves, so its job builds them itself, before it lints.
    expect(run("lint").indexOf("npm run typecheck")).toBeGreaterThan(run("lint").indexOf("npm ci"));
    expect(run("lint").indexOf("npm run lint")).toBeGreaterThan(run("lint").indexOf("npm run typecheck"));
  });

  it("frees runner disk before the test shards and the Linux runtime check install anything, and shows the free space before and after", async () => {
    const { jobs } = await workflow();
    for (const name of ["test", "linux-runtime"]) {
      const steps = jobs[name]!.steps;
      const free = steps.findIndex((step) => step.name === "Free runner disk space");
      expect(free, name).toBeGreaterThan(0);
      expect(steps.findIndex((step) => step.run === "npm ci"), name).toBeGreaterThan(free);
      const run = steps[free]!.run!;
      expect(run).toContain("sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /opt/hostedtoolcache/CodeQL");
      const lines = run.split("\n").map((line) => line.trim());
      expect(lines.indexOf("df -h /")).toBeLessThan(lines.findIndex((line) => line.startsWith("sudo rm -rf")));
      expect(lines.lastIndexOf("df -h /")).toBeGreaterThan(lines.findIndex((line) => line.startsWith("sudo rm -rf")));
    }
  });

  it("runs the Linux runtime check on an ARM64 runner, behind the same Markdown-only skip as the other heavy jobs", async () => {
    const job = (await workflow()).jobs["linux-runtime"] as Job & { "runs-on"?: string };
    expect(job["runs-on"]).toBe("ubuntu-24.04-arm");
    expect(job.if).toBe("needs.scope.outputs.docs_only != 'true'");
    const run = job.steps.map((step) => step.run ?? "").join("\n");
    // The job installs the firewall by running the heredoc inside boot.sh as it is (never a copy of the rules), before anything builds or runs a container.
    const firewall = job.steps.map((step) => step.run ?? "").find((text) => text.includes("<<'FIREWALL'"))!;
    expect(firewall).toContain("packages/worker/ec2/boot.sh");
    expect(firewall).toContain("sudo bash");
    expect(firewall).not.toContain("iptables -I");
    expect(run.indexOf("<<'FIREWALL'")).toBeGreaterThanOrEqual(0);
    expect(run.indexOf("<<'FIREWALL'")).toBeLessThan(run.indexOf('docker build -f "$RUNNER_TEMP/e2e-executor.Dockerfile" -t rovara-e2e-executor:ci .'));
    // The Dockerfile it builds is the e2e-executor one with its FROM lines pointed at the pulled copy of the same digest (tests/contract/ci-images.test.ts).
    expect(run).toContain('node scripts/ci-images.ts dockerfile environments/e2e-executor/Dockerfile "$RUNNER_TEMP/e2e-executor.Dockerfile"');
    // The smoke check is the shared definition in scripts/executor-smoke.ts (the one the release path and test-deploy use), never a copy of its flags: it runs after
    // `npm ci` and `npm run build`, which the script needs, and before the Linux tests.
    const smoke = run.split("\n").find((line) => line.includes("executor-smoke.ts"))!;
    expect(smoke.trim()).toBe("npx tsx scripts/executor-smoke.ts rovara-e2e-executor:ci");
    expect(run).not.toMatch(/executor\/smoke\.js|seccomp=|--cap-drop|--read-only/);
    expect(run.indexOf("npm ci")).toBeLessThan(run.indexOf("executor-smoke.ts"));
    expect(run.indexOf("npm run build")).toBeLessThan(run.indexOf("executor-smoke.ts"));
    expect(run.indexOf("executor-smoke.ts")).toBeLessThan(run.indexOf("npx vitest run tests/linux"));
    expect(run).not.toMatch(/seccomp=unconfined|--privileged|--cap-add|--no-sandbox/);
    expect(run).toContain("npx vitest run tests/linux");
  });

  it("runs the Docker 25 DNS regression test once, in its own step under the same gate as the other Linux tests, and keeps it out of the generic step", async () => {
    const job = (await workflow()).jobs["linux-runtime"] as Job & { steps: { name?: string; run?: string; env?: Record<string, string> }[] };
    const generic = job.steps.find((step) => (step.run ?? "").startsWith("npx vitest run tests/linux"))!;
    expect(generic.run).toContain("--exclude tests/linux/e2e-docker25-dns.test.ts");
    // Task 4.3a: the model channel test has a step of its own too (it builds a derived executor image), so the generic step does not run it a second time.
    expect(generic.run).toContain("--exclude tests/linux/e2e-model-channel.test.ts");
    // Task 4.3b: the agent step tests (twenty real runs of one case among them) have a step of their own, so the generic step does not run them a second time.
    expect(generic.run).toContain("--exclude tests/linux/e2e-agent.test.ts");
    // Task 4.5: the three agent qualification probes (real runs of the scripted model behind the production probe runner) have a step of their own as well.
    expect(generic.run).toContain("--exclude tests/linux/e2e-agent-probes.test.ts");
    const agentProbes = job.steps.find((candidate) => (candidate.run ?? "").includes("tests/linux/e2e-agent-probes.test.ts") && candidate !== generic)!;
    expect(agentProbes.run).toBe("npx vitest run tests/linux/e2e-agent-probes.test.ts");
    expect(agentProbes.name).toMatch(/Agent qualification probes/);
    expect(agentProbes.env).toEqual({ ROVARA_DOCKER: "1", ROVARA_EXECUTOR_IMAGE: "rovara-e2e-executor:ci" });
    const agent = job.steps.find((candidate) => (candidate.run ?? "").includes("tests/linux/e2e-agent.test.ts") && candidate !== generic)!;
    expect(agent.run).toBe("npx vitest run tests/linux/e2e-agent.test.ts");
    expect(agent.name).toMatch(/Agent steps/);
    expect(agent.env).toEqual({ ROVARA_DOCKER: "1", ROVARA_EXECUTOR_IMAGE: "rovara-e2e-executor:ci" });
    const journeys = job.steps.find((candidate) => (candidate.run ?? "").includes("tests/e2e/m1-4-journeys.test.ts"))!;
    expect(journeys.run).toBe("npx vitest run --config vitest.native-p0.config.ts tests/e2e/m1-4-journeys.test.ts");
    expect(journeys.env).toEqual({ ROVARA_DOCKER: "1", ROVARA_EXECUTOR_IMAGE: "rovara-e2e-executor:ci" });
    const model = job.steps.find((candidate) => (candidate.run ?? "").includes("tests/linux/e2e-model-channel.test.ts") && candidate !== generic)!;
    expect(model.run).toBe("npx vitest run tests/linux/e2e-model-channel.test.ts");
    expect(model.name).toMatch(/Model channel/);
    expect(model.env).toEqual({ ROVARA_DOCKER: "1", ROVARA_EXECUTOR_IMAGE: "rovara-e2e-executor:ci" });
    const order = job.steps.map((candidate) => candidate.run ?? "");
    expect(order.indexOf(model.run!)).toBeGreaterThan(order.indexOf(generic.run!));
    const step = job.steps.find((candidate) => (candidate.run ?? "").includes("tests/linux/e2e-docker25-dns.test.ts") && candidate !== generic)!;
    expect(step.run).toBe("npx vitest run tests/linux/e2e-docker25-dns.test.ts");
    expect(step.name).toMatch(/Docker 25/);
    expect(step.env).toEqual({ ROVARA_DOCKER: "1", ROVARA_EXECUTOR_IMAGE: "rovara-e2e-executor:ci" });
    const steps = job.steps.map((candidate) => candidate.run ?? "");
    expect(steps.indexOf(step.run!)).toBeGreaterThan(steps.indexOf(generic.run!));
    // It starts its own Docker 25 (Docker in Docker); the runner's daemon, iptables and sysctls are what the other steps set up and are not touched by it.
    const test = readFileSync("tests/linux/e2e-docker25-dns.test.ts", "utf8");
    expect(readFileSync("tests/support/linux-dind.ts", "utf8")).toMatch(/"public\.ecr\.aws\/docker\/library\/docker:25\.0\.5-dind@sha256:[0-9a-f]{64}"/);
    expect(test).toContain('describe.runIf(process.env.ROVARA_DOCKER === "1")');
  });

  it("smoke-tests the executor image from CI and from the release path through one definition, with the production sandbox flags", async () => {
    const shared = readFileSync("scripts/executor-smoke.ts", "utf8");
    // The smoke command takes its sandbox and limit flags from the verifier's executor definition (what the Docker host builds its executor command from) and
    // checks the profile with the host's own verification; it adds only the network and the run-and-remove flags.
    expect(shared).toContain("executorContainerArgs(verifyExecutorSeccompProfile(profilePath))");
    expect(shared).toContain('"--network", "none"');
    expect(shared).not.toMatch(/--cap-drop|seccomp=|--read-only/);
    const container = readFileSync("packages/verifier/src/host/executor-container.ts", "utf8");
    for (const flag of ["--init", "--cap-drop=ALL", "no-new-privileges", "seccomp=${seccompProfile}", "--read-only", "--tmpfs", "--memory", "--pids-limit", "--cpus"]) expect(container, flag).toContain(flag);
    expect(readFileSync("packages/verifier/src/host/docker-application-host.ts", "utf8")).toContain("...executorContainerArgs(seccompProfile)");
    // The release path (and so test-deploy, which takes smokeTestExecutor from it) builds its command from that definition and spells no flags of its own.
    const release = readFileSync("scripts/release-common.ts", "utf8");
    const body = release.slice(release.indexOf("export async function smokeTestExecutor"), release.indexOf("export async function smokeTestWorker"));
    expect(body).toContain("executorSmokeDockerArgs(image)");
    expect(body).not.toMatch(/--network|--cap-drop|seccomp|smoke\.js/);
    expect(readFileSync("scripts/test-deploy.ts", "utf8")).toContain("smokeTest: smokeTestExecutor");
  });

  it("lets the Ubuntu runner create unprivileged user namespaces for Chromium's sandbox before it builds or runs a container, and says production does not need that", async () => {
    const job = (await workflow()).jobs["linux-runtime"] as Job;
    const step = job.steps.find((candidate) => (candidate.run ?? "").includes("apparmor_restrict_unprivileged_userns"))!;
    expect(step.run).toContain("sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0");
    expect(step.run).toContain("Amazon Linux 2023");
    const run = job.steps.map((candidate) => candidate.run ?? "").join("\n");
    expect(run.indexOf("apparmor_restrict_unprivileged_userns")).toBeLessThan(run.indexOf("docker build -f"));
  });

  it("gives every job but the manual live-AWS one a time limit, on either repository, so a hung runner fails in minutes and not after six hours", async () => {
    const { jobs } = await workflow();
    for (const [name, job] of Object.entries(jobs)) {
      if (name === "live-aws") continue;
      // Cloud's slower runners may get a longer limit than the public ones (an expression on github.repository), but each repository sees a real limit.
      for (const repository of [PUBLIC_REPOSITORY, CLOUD_REPOSITORY]) {
        expect(timeoutFor(job["timeout-minutes"], repository), `${name} on ${repository}`).toBeGreaterThan(0);
      }
    }
  });

  it("gives the slower Cloud runners at least as long as the public ones, and the Cloud test shards an hour", async () => {
    const { jobs } = await workflow();
    for (const [name, job] of Object.entries(jobs)) {
      if (name === "live-aws") continue;
      expect(timeoutFor(job["timeout-minutes"], CLOUD_REPOSITORY), name).toBeGreaterThanOrEqual(timeoutFor(job["timeout-minutes"], PUBLIC_REPOSITORY));
    }
    // Shard 1 of 4 needs 46 to 50 minutes on a 2 vCPU Cloud runner (CI run 40594341894); the 40 minutes it had cancelled it.
    expect(timeoutFor(jobs.test!["timeout-minutes"], CLOUD_REPOSITORY)).toBeGreaterThanOrEqual(60);
  });

  // The public copy of this file runs on pull requests and by hand. The Cloud copy is manual-only (owner decision 2026-10-27, to protect the Actions budget), and
  // narrows what a stray event can start inside `scope` and `local`, because a trigger cannot carry an `if`.
  it("runs on pull requests and by hand only, never on a push to mainline, and skips a draft until it is ready; the Cloud copy runs by hand only", async () => {
    const parsed = await workflow();
    const pullRequest = { types: ["opened", "synchronize", "reopened", "ready_for_review"] };
    const manualOnly = !(parsed.on !== null && typeof parsed.on === "object" && "pull_request" in parsed.on);
    if (manualOnly) {
      // Cloud: no push, no pull_request trigger at all, so an event other than a manual run starts nothing...
      expect(parsed.on).toEqual({ workflow_dispatch: null });
      // ...and should a trigger come back, the public repository still skips a push, and Cloud takes only a pull request into cloud/integration or a release branch.
      expect(conditionFor(parsed.jobs.scope!.if, PUBLIC_REPOSITORY)).toBe("github.event.pull_request.draft != true && github.event_name != 'push'");
      expect(conditionFor(parsed.jobs.scope!.if, CLOUD_REPOSITORY)).toBe(
        "github.event.pull_request.draft != true && (github.event_name != 'pull_request' || github.base_ref == 'cloud/integration' || startsWith(github.base_ref, 'release/'))",
      );
    } else {
      expect(parsed.on).toEqual({ workflow_dispatch: null, pull_request: pullRequest });
      expect(conditionFor(parsed.jobs.scope!.if, PUBLIC_REPOSITORY)).toBe("github.event.pull_request.draft != true");
    }
  });

  // Owner decision "CI cost" (2026-11-02): a newer run on the same ref cancels the one in progress, a manual run included.
  it("cancels a run in progress when a newer run starts on the same ref", async () => {
    const { concurrency } = await workflow();
    expect(concurrency?.group).toBe("ci-${{ github.ref }}");
    expect(concurrency?.["cancel-in-progress"]).toBe(true);
  });

  it("is a workflow no other workflow waits for, so cancelling its runs strands nothing", () => {
    for (const name of readdirSync(".github/workflows").filter((file) => /\.ya?ml$/.test(file))) {
      const text = readFileSync(`.github/workflows/${name}`, "utf8");
      expect(text, name).not.toMatch(/workflow_run:|uses:\s*\.\/\.github\/workflows\/ci\.yml/);
    }
  });

  it("reports one check called local that waits for every other job, so it cannot go green while one is missing", async () => {
    const { jobs } = await workflow();
    const gate = jobs.local!;
    expect(gate.name).toBeUndefined();
    // The public repository never starts the gate for a push; Cloud only for a manual run or a pull request into cloud/integration or a release branch (the Cloud copy
    // of this file; the public copy has no repository guard).
    const publicGate = conditionFor(gate.if, PUBLIC_REPOSITORY);
    if (gate.if!.includes("github.repository")) {
      expect(publicGate).toBe("always() && github.event.pull_request.draft != true && github.event_name != 'push'");
      expect(conditionFor(gate.if, CLOUD_REPOSITORY)).toBe(
        "always() && github.event.pull_request.draft != true && (github.event_name != 'pull_request' || github.base_ref == 'cloud/integration' || startsWith(github.base_ref, 'release/'))",
      );
    } else {
      expect(publicGate).toBe("always() && github.event.pull_request.draft != true");
    }
    const others = Object.keys(jobs).filter((name) => name !== "local" && name !== "live-aws").sort();
    expect([...(gate.needs as string[])].sort()).toEqual(others);
    const run = gate.steps.map((step) => step.run ?? "").join("\n");
    expect(run).toContain("node scripts/ci-gate.ts");
    expect(gate.steps.some((step) => step.env?.NEEDS === "${{ toJSON(needs) }}")).toBe(true);
  });
});

describe("the gate behind the local check", () => {
  const ran = { scope: "success", checks: "success", "test": "success", release: "success" };

  it("passes when every job succeeded", () => {
    expect(gateVerdict({ docsOnly: false, results: ran }).ok).toBe(true);
  });

  it("fails when any job failed, was cancelled or was skipped", () => {
    for (const result of ["failure", "cancelled", "skipped"]) {
      const verdict = gateVerdict({ docsOnly: false, results: { ...ran, test: result } });
      expect(verdict, result).toEqual({ ok: false, reason: `test was ${result}, not success` });
    }
  });

  it("fails when the scope job did not succeed, even though every job it feeds was skipped", () => {
    const skipped = { scope: "failure", checks: "skipped", test: "skipped", release: "skipped" };
    expect(gateVerdict({ docsOnly: false, results: skipped })).toEqual({ ok: false, reason: "scope was failure, not success" });
    expect(gateVerdict({ docsOnly: true, results: skipped }).ok).toBe(false);
  });

  it("passes a Markdown-only change only when every heavy job was skipped", () => {
    const skipped = { scope: "success", checks: "skipped", test: "skipped", release: "skipped" };
    expect(gateVerdict({ docsOnly: true, results: skipped }).ok).toBe(true);
    expect(gateVerdict({ docsOnly: true, results: { ...skipped, test: "success" } })).toEqual({ ok: false, reason: "test was success, not skipped" });
    expect(gateVerdict({ docsOnly: true, results: { ...skipped, release: "failure" } }).ok).toBe(false);
  });

  it("fails a gate that was given no jobs to judge", () => {
    expect(gateVerdict({ docsOnly: false, results: { scope: "success" } }).ok).toBe(false);
    expect(gateVerdict({ docsOnly: false, results: {} }).ok).toBe(false);
  });

  it("reads the needs context GitHub provides", () => {
    const needs = JSON.stringify({
      scope: { result: "success", outputs: { docs_only: "false" } },
      checks: { result: "success", outputs: {} },
      test: { result: "success", outputs: {} },
      release: { result: "success", outputs: {} },
    });
    expect(needsVerdict(needs).ok).toBe(true);
    const manualRun = JSON.stringify({
      scope: { result: "success", outputs: {} },
      checks: { result: "success", outputs: {} },
    });
    expect(needsVerdict(manualRun).ok).toBe(true);
    expect(needsVerdict("not json").ok).toBe(false);
    expect(needsVerdict(JSON.stringify({ checks: { result: "success", outputs: {} } })).ok).toBe(false);
  });
});
