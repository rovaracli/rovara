// Opus review (L2): the real cdk port's argument vector, with a fake npx on the PATH (no shell, values with spaces/quotes stay one argument).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealPorts } from "../../ops/pipeline/ports.ts";
import { config } from "./pipeline-stage-fakes.ts";

const root = mkdtempSync(join(tmpdir(), "stage-review-"));
const logFile = join(root, "npx.log");
const oldPath = process.env.PATH;
beforeAll(() => {
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "npx"), `#!/bin/bash\necho "\${AWS_PROFILE:-}|$PWD" >> "${logFile}"\nfor a in "$@"; do printf '%s\\n' "[$a]" >> "${logFile}"; done\n`);
  chmodSync(join(root, "bin", "npx"), 0o755);
  process.env.PATH = `${join(root, "bin")}:${oldPath}`;
});
afterAll(() => { process.env.PATH = oldPath; });

describe("review: cdk deploy --no-execute argument vector", () => {
  it("passes stacks, app, no-execute, approval, change set name, each context and parameter as single arguments, in the candidate dir with the profile", async () => {
    const dir = join(root, "cand");
    mkdirSync(dir);
    const p = createRealPorts({ config, env: "beta", region: "us-east-1", exec8: "1a2b3c4d", profile: "rovara-cloud-beta", cwd: root });
    await p.cdk.deployNoExecute({ dir, stacks: [{ stackId: "RovaraCloudApp", stackName: "rovara-cloud-beta-app", parameters: { CodeUrl: "https://code.example.test" } }, { stackId: "RovaraCloudWeb", stackName: "rovara-cloud-beta-web", parameters: { CodeUrl: "https://code.example.test" } }], changeSetName: "rovara-pipeline-1a2b3c4d", context: { rovaraCloudApp: "beta", odd: "a b'$(x)" } });
    const lines = readFileSync(logFile, "utf8").split("\n").filter((l) => l !== "");
    expect(lines[0]).toMatch(/^rovara-cloud-beta\|.*\/cand$/u);
    expect(lines.slice(1)).toEqual(["[--no-install]", "[cdk]", "[deploy]", "[RovaraCloudApp]", "[RovaraCloudWeb]", "[--exclusively]", "[--app]", "[node infra/dist/bin/agentx.js]", "[--no-execute]", "[--require-approval]", "[never]", "[--change-set-name]", "[rovara-pipeline-1a2b3c4d]", "[--progress]", "[events]", "[-c]", "[rovaraCloudApp=beta]", "[-c]", "[odd=a b'$(x)]", "[--parameters]", "[rovara-cloud-beta-app:CodeUrl=https://code.example.test]", "[--parameters]", "[rovara-cloud-beta-web:CodeUrl=https://code.example.test]"]);
  });

  it("the gateway call selects ONLY the gateway stack (--exclusively) and prefixes ImageDigest with that stack's name", async () => {
    const dir = join(root, "cand-gw");
    mkdirSync(dir);
    writeFileSync(logFile, "");
    const p = createRealPorts({ config, env: "beta", region: "us-east-1", exec8: "1a2b3c4d", profile: "rovara-cloud-beta", cwd: root });
    await p.cdk.deployNoExecute({ dir, stacks: [{ stackId: "RovaraModelGateway", stackName: "rovara-cloud-beta-gateway", parameters: { ImageDigest: "sha256:abc" } }], changeSetName: "rovara-pipeline-1a2b3c4d", context: { rovaraModelGateway: "beta" } });
    const lines = readFileSync(logFile, "utf8").split("\n").filter((l) => l !== "");
    expect(lines.slice(1)).toEqual(["[--no-install]", "[cdk]", "[deploy]", "[RovaraModelGateway]", "[--exclusively]", "[--app]", "[node infra/dist/bin/agentx.js]", "[--no-execute]", "[--require-approval]", "[never]", "[--change-set-name]", "[rovara-pipeline-1a2b3c4d]", "[--progress]", "[events]", "[-c]", "[rovaraModelGateway=beta]", "[--parameters]", "[rovara-cloud-beta-gateway:ImageDigest=sha256:abc]"]);
  });

  it("refuses a stack name or parameter name that cannot be prefixed (nothing runs)", async () => {
    const p = createRealPorts({ config, env: "beta", region: "us-east-1", exec8: "1a2b3c4d", profile: "rovara-cloud-beta", cwd: root });
    writeFileSync(logFile, "");
    await expect(p.cdk.deployNoExecute({ dir: root, stacks: [{ stackId: "X", stackName: "a:b", parameters: {} }], changeSetName: "n", context: {} })).rejects.toMatchObject({ exitName: "USAGE" });
    await expect(p.cdk.deployNoExecute({ dir: root, stacks: [{ stackId: "X", stackName: "a", parameters: { "k:v": "1" } }], changeSetName: "n", context: {} })).rejects.toMatchObject({ exitName: "USAGE" });
    expect(readFileSync(logFile, "utf8")).toBe("");
  });
});
