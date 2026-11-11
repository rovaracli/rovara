// Stdio MCP host redesign (T11): the CI job `mcp-runner-linux` is shaped as promised. The job is run by a person at a checkpoint (never from here), so this reads the workflow: the runner,
// the image it builds, what it runs, that it cleans up, that a change outside the runner's paths costs a minute, and that the gate waits for it.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { needsVerdict } from "../../scripts/ci-gate.js";

interface Step { name?: string; run?: string; uses?: string; if?: string; id?: string; env?: Record<string, string> }
interface Job { needs?: string | string[]; if?: string; "runs-on"?: string; "timeout-minutes"?: number; permissions?: Record<string, string>; steps: Step[] }
const workflow = async () => YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as { jobs: Record<string, Job> };
const job = async (): Promise<Job> => (await workflow()).jobs["mcp-runner-linux"]!;

describe("the mcp-runner-linux CI job", () => {
  it("runs on the ARM64 Linux runner (the runner image is ARM64 like the Fargate tasks), after scope, behind the Markdown-only skip, with a small timeout and read-only permissions", async () => {
    const j = await job();
    expect(j["runs-on"]).toBe("ubuntu-24.04-arm");
    expect(j.needs).toEqual(["scope", "checks"]);
    expect(j.if).toBe("needs.scope.outputs.docs_only != 'true'");
    expect(j["timeout-minutes"]).toBeLessThanOrEqual(30);
    expect(j.permissions).toEqual({ contents: "read", packages: "read" });
  });
  it("builds the runner image from the Dockerfile with its FROM lines pointed at the pulled copy of the pinned digest, and pulls only the node image", async () => {
    const run = (await job()).steps.map((step) => step.run ?? "").join("\n");
    expect(run).toContain("node scripts/ci-images.ts pull --github-env node-build");
    expect(run).toContain('node scripts/ci-images.ts dockerfile environments/mcp-runner/Dockerfile "$RUNNER_TEMP/mcp-runner.Dockerfile"');
    expect(run).toContain('docker build -f "$RUNNER_TEMP/mcp-runner.Dockerfile" -t rovara-mcp-runner:ci .');
    expect(run.indexOf("ci-images.ts dockerfile")).toBeLessThan(run.indexOf("docker build"));
  });
  it("checks the image's listing, then runs the Linux tests against it, and removes what a failed run left whatever happened", async () => {
    const steps = (await job()).steps;
    const order = steps.map((step) => step.run ?? "");
    const check = order.findIndex((run) => run === "sh environments/mcp-runner/check-image.sh rovara-mcp-runner:ci");
    const tests = steps.findIndex((step) => step.run === "npx vitest run tests/linux/mcp-runner");
    const clean = steps.findIndex((step) => (step.run ?? "").includes("label=rovara.mcp-ci"));
    expect(check).toBeGreaterThan(order.findIndex((run) => run.includes("docker build")));
    expect(tests).toBeGreaterThan(check);
    expect(steps[tests]!.env).toEqual({ ROVARA_MCP_RUNNER_IMAGE: "rovara-mcp-runner:ci" });
    expect(clean).toBeGreaterThan(tests);
    expect(steps[clean]!.if).toBe("always() && steps.paths.outputs.run == 'true'");
    expect(steps[clean]!.run).toContain("docker rm -f");
    expect(steps[clean]!.run).toContain("docker volume rm -f");
  });
  it("builds the packages the tests import before it runs them, and installs before it builds", async () => {
    const order = (await job()).steps.map((step) => step.run ?? "");
    expect(order.indexOf("npm ci")).toBeGreaterThan(-1);
    expect(order.indexOf("npm ci")).toBeLessThan(order.indexOf("npx tsc -b packages/cloud-contracts packages/gateway packages/broker"));
    expect(order.indexOf("npx tsc -b packages/cloud-contracts packages/gateway packages/broker")).toBeLessThan(order.indexOf("npx vitest run tests/linux/mcp-runner"));
  });
  it("does nothing costly unless a file of the runner changed (a pull request), and always runs on a manual run or a push", async () => {
    const steps = (await job()).steps;
    const paths = steps.find((step) => step.id === "paths")!;
    expect(paths.run).toContain('if [ "$GITHUB_EVENT_NAME" != "pull_request" ]; then echo "run=true"');
    // every step after the decision waits for it, except the checkout it needs and nothing else
    const after = steps.slice(steps.indexOf(paths) + 1);
    for (const step of after) expect(step.if, step.name ?? step.run).toMatch(/steps\.paths\.outputs\.run == 'true'/u);
    // the paths: the runner's image, programs, controller and tests count; an unrelated file does not
    const pattern = new RegExp(/grep -Eq '([^']+)'/u.exec(paths.run!)![1]!, "u");
    for (const path of ["environments/mcp-runner/Dockerfile", "packages/gateway/src/mcp-runner/bridge.ts", "packages/gateway/src/mcp-controller.ts", "packages/broker/src/mcp-runner/serve-main.ts", "packages/broker/src/mcp-host/main.ts", "tests/linux/mcp-runner/mcp-runner-linux.test.ts", "tests/support/fixture-npm-registry.ts", ".github/workflows/ci.yml"]) {
      expect(path, path).toMatch(pattern);
    }
    for (const path of ["packages/ui/src/routes.tsx", "environments/e2e-executor/Dockerfile", "packages/gateway/src/mcp-controller-x.ts.bak", "README.md", "packages/broker/src/aws/broker.ts"]) expect(path, path).not.toMatch(pattern);
  });
  it("uses no privileged container, no added capability and no host network of its own (the tests start containers with the ECS flags themselves)", async () => {
    const run = (await job()).steps.map((step) => step.run ?? "").join("\n");
    expect(run).not.toMatch(/--privileged|--cap-add|seccomp=unconfined|--network host/u);
  });
  it("is one of the jobs the pull request gate waits for, and a skipped or failed run fails the gate", async () => {
    const { jobs } = await workflow();
    expect(jobs.local!.needs).toContain("mcp-runner-linux");
    const results = (mcp: string) => JSON.stringify({ scope: { result: "success", outputs: { docs_only: "false" } }, checks: { result: "success" }, test: { result: "success" }, release: { result: "success" }, "linux-runtime": { result: "success" }, "mcp-runner-linux": { result: mcp }, "web-e2e": { result: "success" } });
    expect(needsVerdict(results("success"), ["web-e2e"]).ok).toBe(true);
    expect(needsVerdict(results("failure"), ["web-e2e"]).ok).toBe(false);
    expect(needsVerdict(results("skipped"), ["web-e2e"]).ok).toBe(false);
  });
  it("is kept out of the generic Linux step by an environment variable only that job sets", async () => {
    const { jobs } = await workflow();
    const generic = jobs["linux-runtime"]!.steps.find((step) => (step.run ?? "").startsWith("npx vitest run tests/linux"))!;
    // the generic step runs the whole folder; the runner tests skip unless ROVARA_MCP_RUNNER_IMAGE is set
    expect(generic.env?.ROVARA_MCP_RUNNER_IMAGE).toBeUndefined();
    expect(jobs["linux-runtime"]!.steps.some((step) => step.env?.ROVARA_MCP_RUNNER_IMAGE !== undefined)).toBe(false);
    expect(await readFile("tests/linux/mcp-runner/mcp-runner-linux.test.ts", "utf8")).toContain('describe.runIf(process.platform === "linux" && IMAGE !== undefined)');
  });
});
