// The release check around a Cloud deploy (#11): the pipeline's deploy command, run for real in bash with a fake `aws` (the web stack's
// address), a fake `npx` (the deploy) and a local site. Any 5xx or failed connection during the deploy fails the release.
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { afterEach, describe, expect, it } from "vitest";
import { CloudReleasePipelineStack, RELEASE_CHECK_PATHS } from "../../infra/lib/cloud-release-pipeline.js";

const command = (() => {
  const template = Template.fromStack(new CloudReleasePipelineStack(new App(), "P", { environmentName: "production", env: { region: "us-east-1" } }));
  const source = (Object.values(template.findResources("AWS::CodeBuild::Project"))[0]!.Properties as { Source: { BuildSpec: string | { "Fn::Join": [string, unknown[]] } } }).Source.BuildSpec;
  const text = typeof source === "string" ? source : source["Fn::Join"][1].map((part) => (typeof part === "string" ? part : "TOKEN")).join("");
  return (JSON.parse(text) as { phases: { build: { commands: string[] } } }).phases.build.commands[0]!;
})();

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
async function run(address: string, deployExit: number): Promise<{ status: number | null; output: string }> {
  const bin = mkdtempSync(join(tmpdir(), "release-check-"));
  writeFileSync(join(bin, "aws"), `#!/bin/bash\necho "${address}"\n`);
  writeFileSync(join(bin, "npx"), `#!/bin/bash\nsleep 3\nexit ${String(deployExit)}\n`);
  for (const tool of ["aws", "npx"]) chmodSync(join(bin, tool), 0o755);
  const child = spawn("bash", ["-c", command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, STACK_PREFIX: "rovara-cloud-production" } });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { status, output };
}

describe("the release check around a Cloud deploy", () => {
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
