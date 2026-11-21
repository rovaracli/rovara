// The release check around a Cloud deploy (#11): the pipeline's deploy command, run for real in bash with a fake `aws` (the web stack's
// address), a fake `npx` (the deploy) and a local site. Any 5xx or failed connection during the deploy fails the release.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { afterEach, describe, expect, it } from "vitest";
import { CloudReleasePipelineStack, FIND_RELEASE_TAG, RELEASE_CHECK_PATHS, RELEASE_TAG_ON_BRANCH } from "../../infra/lib/cloud-release-pipeline.js";

const command = (() => {
  const template = Template.fromStack(new CloudReleasePipelineStack(new App(), "P", { environmentName: "production", env: { region: "us-east-1" } }));
  const source = (Object.values(template.findResources("AWS::CodeBuild::Project"))[0]!.Properties as { Source: { BuildSpec: string | { "Fn::Join": [string, unknown[]] } } }).Source.BuildSpec;
  const text = typeof source === "string" ? source : source["Fn::Join"][1].map((part) => (typeof part === "string" ? part : "TOKEN")).join("");
  return (JSON.parse(text) as { phases: { build: { commands: string[] } } }).phases.build.commands[0]!;
})();

function spawnSyncGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

/** Runs the commands in one bash, as CodeBuild runs a phase's commands one after another (a failing `exit 1` ends it). */
function spawnSyncBash(cwd: string, script: string): { status: number | null; output: string } {
  const result = spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const servers: Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

/** A site answering the paths the check asks for; `broken` answers 503 on /app. */
async function site(broken: boolean): Promise<number> {
  const server = createServer((request, response) => { response.statusCode = broken && request.url === "/app" ? 503 : request.url === "/app" ? 200 : 401; response.end(); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

/** Runs the deploy command with fake tools; `address` is what the web stack's CloudUrl output says ("None": no stack yet). Not spawnSync: the site answers from this process. */
async function run(address: string, deployExit: number, backfillExit = 0): Promise<{ status: number | null; output: string }> {
  const bin = mkdtempSync(join(tmpdir(), "release-check-"));
  writeFileSync(join(bin, "aws"), `#!/bin/bash\necho "${address}"\n`);
  writeFileSync(join(bin, "npx"), `#!/bin/bash\nsleep 3\nexit ${String(deployExit)}\n`);
  writeFileSync(join(bin, "node"), `#!/bin/bash\necho "C-1 required release preflight"\nexit ${String(backfillExit)}\n`);
  for (const tool of ["aws", "npx", "node"]) chmodSync(join(bin, tool), 0o755);
  const child = spawn("bash", ["-c", command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, STACK_PREFIX: "rovara-cloud-production" } });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { status, output };
}

describe("the release check around a Cloud deploy", () => {
  it("blocks deployment when the required own-key backfill check fails", async () => {
    const { status, output } = await run("None", 0, 1);
    expect(status).toBe(1);
    expect(output).toContain("C-1 required release preflight");
    expect(output).not.toContain("release check: no live address yet");
  });

  it("asks for the page shell and the API", () => {
    expect(RELEASE_CHECK_PATHS).toEqual(["/app", "/v1/web/me"]);
  });

  it("passes a deploy during which the live address answered without a 5xx", async () => {
    const port = await site(false);
    const { status, output } = await run(`http://127.0.0.1:${String(port)}/app`, 0);
    expect(output).toContain("release check: no errors");
    expect(status).toBe(0);
  });

  it("fails a deploy that succeeded but during which the live address answered 503", async () => {
    const port = await site(true);
    const { status, output } = await run(`http://127.0.0.1:${String(port)}/app`, 0);
    expect(output).toMatch(/the release check saw errors on http:\/\/127\.0\.0\.1:\d+ during the deploy:\n\d\d:\d\d:\d\d \/app 503/u);
    expect(output).not.toContain("while :;");
    expect(status).toBe(1);
  });

  it("fails when nothing answers at all", async () => {
    expect((await run("http://127.0.0.1:9/app", 0)).status).toBe(1);
  });

  it("still fails a failed deploy, and checks nothing before the web stack has an address", async () => {
    const port = await site(false);
    expect((await run(`http://127.0.0.1:${String(port)}/app`, 1)).status).toBe(1);
    const first = await run("None", 0);
    expect(first.output).toContain("no live address yet");
    expect(first.status).toBe(0);
  });
});

describe("the check that a release tag is on cloud/next", () => {
  /** A repository with cloud/next and another branch, each tagged; runs the Check stage's commands at `tag`, with `origin` a bare copy. */
  function checkAt(tag: string): { status: number | null; output: string } {
    const root = mkdtempSync(join(tmpdir(), "release-tag-"));
    const git = (cwd: string, ...args: string[]) => spawnSyncGit(cwd, args);
    const work = join(root, "work"), origin = join(root, "origin.git"), clone = join(root, "clone");
    git(root, "init", "-q", "-b", "cloud/next", work);
    const settings: Array<[string, string]> = [["user.email", "test@example.test"], ["user.name", "Test"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"]];
    for (const [name, value] of settings) git(work, "config", name, value);
    git(work, "commit", "-q", "--allow-empty", "-m", "cloud/next");
    git(work, "tag", "v1.0.0");
    git(work, "checkout", "-q", "-b", "integ/0519");
    git(work, "commit", "-q", "--allow-empty", "-m", "staging line");
    git(work, "tag", "v0.5.19");
    git(work, "checkout", "-q", "cloud/next");
    git(root, "clone", "-q", "--bare", work, origin);
    git(root, "clone", "-q", origin, clone);
    git(clone, "checkout", "-q", "--detach", tag);
    const script = [...FIND_RELEASE_TAG, ...RELEASE_TAG_ON_BRANCH].join("\n");
    const result = spawnSyncBash(clone, script);
    return result;
  }

  it("passes a vX.Y.Z tag on cloud/next", () => {
    const { status, output } = checkAt("v1.0.0");
    expect(output).toContain("v1.0.0 is on cloud/next");
    expect(status).toBe(0);
  });

  it("fails a tag cut on another branch (a staging release), before anyone is asked to approve it", () => {
    const { status, output } = checkAt("v0.5.19");
    expect(output).toMatch(/v0\.5\.19 \([0-9a-f]+\) is not on cloud\/next: this pipeline deploys only release tags cut from cloud\/next/u);
    expect(status).toBe(1);
  });
});
