// SLACK-IMAGE-NOT-IN-CI: CI builds the Slack orchestrator image, so a Dockerfile that cannot build (the 0.5.14 break: slack-service imported @agentx/cloud-contracts, which the image never copied) fails the run.
// The job is run by a person at a checkpoint (never from here), so this reads the workflow: the build commands, that nothing is pushed, that a change outside the image's inputs costs a minute, and that the gate waits for it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { needsVerdict } from "../../scripts/ci-gate.js";

interface Step { name?: string; run?: string; uses?: string; if?: string; id?: string }
interface Job { needs?: string | string[]; if?: string; "runs-on"?: string; "timeout-minutes"?: number; permissions?: Record<string, string>; steps: Step[] }
const workflow = YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8")) as { jobs: Record<string, Job> };
const job = workflow.jobs["slack-image-linux"]!;
const runs = job.steps.map((step) => step.run ?? "");

describe("the slack-image-linux CI job", () => {
  it("exists, runs on the ARM64 Linux runner (the image is linux/arm64), after scope and checks, behind the Markdown-only skip, with read-only permissions", () => {
    expect(job).toBeDefined();
    expect(job["runs-on"]).toBe("ubuntu-24.04-arm");
    expect(job.needs).toEqual(["scope", "checks"]);
    expect(job.if).toBe("needs.scope.outputs.docs_only != 'true'");
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(30);
    expect(job.permissions).toEqual({ contents: "read", packages: "read" });
  });

  it("builds the image from environments/slack/Dockerfile through the pinned-image rewrite, after pulling only the node image, in that order", () => {
    const text = runs.join("\n");
    expect(text).toContain("node scripts/ci-images.ts pull --github-env node-build");
    expect(text).toContain("node scripts/ci-images.ts verify node-build");
    expect(text).toContain('node scripts/ci-images.ts dockerfile environments/slack/Dockerfile "$RUNNER_TEMP/slack.Dockerfile"');
    expect(text).toContain('docker build -f "$RUNNER_TEMP/slack.Dockerfile" -t rovara-slack:ci .');
    expect(text.indexOf("pull --github-env")).toBeLessThan(text.indexOf("ci-images.ts verify"));
    expect(text.indexOf("ci-images.ts verify")).toBeLessThan(text.indexOf("ci-images.ts dockerfile"));
    expect(text.indexOf("ci-images.ts dockerfile")).toBeLessThan(text.indexOf("docker build"));
  });

  it("only builds: it never pushes, tags for a registry, or holds cloud credentials", () => {
    const text = runs.join("\n") + JSON.stringify(job.steps.map((step) => step.uses ?? ""));
    expect(text).not.toMatch(/docker push|--push|buildx imagetools|aws-actions|configure-aws-credentials|ecr/iu);
  });

  it("does nothing costly unless a file of the image changed (a pull request), and always builds on a manual run or a push; every later step waits for that decision", () => {
    const paths = job.steps.find((step) => step.id === "paths")!;
    expect(paths.run).toContain('if [ "$GITHUB_EVENT_NAME" != "pull_request" ]; then echo "run=true"');
    for (const step of job.steps.slice(job.steps.indexOf(paths) + 1)) expect(step.if, step.name ?? step.run).toBe("steps.paths.outputs.run == 'true'");
  });

  it("watches every path the Dockerfile copies into the build, so a change to any of them rebuilds the image", () => {
    const paths = job.steps.find((step) => step.id === "paths")!;
    const pattern = new RegExp(/grep -Eq '([^']+)'/u.exec(paths.run!)![1]!, "u");
    const copied = [...readFileSync("environments/slack/Dockerfile", "utf8").matchAll(/^COPY\s+(?!--from)(\S+)\s+\S+/gmu)].map((match) => match[1]!);
    expect(copied.length).toBeGreaterThan(10);
    for (const source of copied) {
      // a directory is watched through a file inside it; a file as itself
      const sample = /\.[a-z]+$/u.test(source) ? source : `${source.replace(/\/$/u, "")}/src/index.ts`;
      expect(sample, `COPY ${source}`).toMatch(pattern);
    }
    for (const path of ["environments/slack/Dockerfile", "packages/slack-service/src/main.ts", "packages/cloud-contracts/src/index.ts", "vendor/rovara-code/packages/contracts/src/index.ts", ".github/workflows/ci.yml", "package-lock.json"]) expect(path, path).toMatch(pattern);
    for (const path of ["packages/ui/src/routes.tsx", "environments/e2e-executor/Dockerfile", "README.md", "packages/broker/src/aws/broker.ts"]) expect(path, path).not.toMatch(pattern);
  });

  it("is one of the jobs the pull request gate waits for, and a skipped or failed run fails the gate", () => {
    expect(workflow.jobs.local!.needs).toContain("slack-image-linux");
    const results = (slack: string) => JSON.stringify({ scope: { result: "success", outputs: { docs_only: "false" } }, checks: { result: "success" }, "slack-image-linux": { result: slack } });
    expect(needsVerdict(results("success"), ["slack-image-linux"]).ok).toBe(true);
    expect(needsVerdict(results("failure"), ["slack-image-linux"]).ok).toBe(false);
    expect(needsVerdict(results("skipped"), ["slack-image-linux"]).ok).toBe(false);
  });
});
