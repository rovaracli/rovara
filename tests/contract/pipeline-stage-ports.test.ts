import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealPorts } from "../../ops/pipeline/ports.ts";
import { canonicalSha256 } from "../../ops/pipeline/lib/hash.ts";
import { FAKE_ACCOUNT, config } from "./pipeline-stage-fakes.ts";

const root = mkdtempSync(join(tmpdir(), "stage-ports-"));
const logFile = join(root, "aws.log");
const oldPath = process.env.PATH;

// A fake `aws` on the PATH: logs "<profile>|<access key>|<args>" and answers from canned JSON by sub-command.
beforeAll(() => {
  mkdirSync(join(root, "bin"));
  const script = `#!/bin/bash
echo "\${AWS_PROFILE:-}|\${AWS_ACCESS_KEY_ID:-}|$*" >> "${logFile}"
case "$1 $2" in
  "sts get-caller-identity") echo '{"Account":"${FAKE_ACCOUNT}"}' ;;
  "sts assume-role") echo '{"Credentials":{"AccessKeyId":"AKIATEST","SecretAccessKey":"s","SessionToken":"t"}}' ;;
  "cloudformation describe-stacks")
    case "$*" in *missing*) echo "An error occurred (ValidationError): Stack with id missing does not exist" >&2; exit 254 ;; esac
    echo '{"Stacks":[{"StackStatus":"UPDATE_COMPLETE","Parameters":[{"ParameterKey":"ImageDigest","ParameterValue":"sha256:x"}],"Outputs":[{"OutputKey":"CloudUrl","OutputValue":"https://c.example.test/app"}]}]}' ;;
  "cloudformation describe-change-set")
    case "$*" in *nochangeset*) echo "An error occurred (ChangeSetNotFound): ChangeSet [nochangeset] does not exist" >&2; exit 254 ;; esac
    case "$*" in *nostack*) echo "An error occurred (ValidationError) when calling the DescribeChangeSet operation: Stack [nostack] does not exist" >&2; exit 254 ;; esac
    echo '{"ChangeSetId":"cs-1","Status":"CREATE_COMPLETE","ExecutionStatus":"AVAILABLE","Changes":[{"ResourceChange":{"Action":"Modify","LogicalResourceId":"Fn","PhysicalResourceId":"fn-1","ResourceType":"AWS::Lambda::Function","Replacement":"False","Details":[{"Target":{"Attribute":"Properties","Name":"Environment","RequiresRecreation":"Never"}},{"Target":{"Attribute":"Properties","Name":"Environment"}},{"Target":{"Attribute":"Tags"}}]}},{"ResourceChange":{"Action":"Modify","LogicalResourceId":"Bare","ResourceType":"AWS::SQS::Queue","Replacement":"False"}}]}' ;;
  "cloudformation get-template") echo '{"TemplateBody":{"b":1,"a":{"d":2,"c":3}}}' ;;
  "cloudformation list-change-sets") echo '{"Summaries":[{"ChangeSetName":"rovara-pipeline-aaaaaaaa"}]}' ;;
  "ssm get-parameter")
    case "$*" in *absent*) echo "An error occurred (ParameterNotFound)" >&2; exit 254 ;; esac
    echo '{"Parameter":{"Value":"{\\"schema\\":1}"}}' ;;
  *) echo 'null' ;;
esac
`;
  writeFileSync(join(root, "bin", "aws"), script);
  chmodSync(join(root, "bin", "aws"), 0o755);
  process.env.PATH = `${join(root, "bin")}:${oldPath}`;
});
afterAll(() => { process.env.PATH = oldPath; });

const log = (): string[] => { try { return readFileSync(logFile, "utf8").split("\n").filter((l) => l !== ""); } catch { return []; } };
const ports = (profile: string | null = "rovara-cloud-beta") => createRealPorts({ config, env: "beta", region: "us-east-1", exec8: "1a2b3c4d", profile, cwd: root });

describe("pipeline stage CLI: real ports (a fake aws on the PATH, a real git repository)", () => {
  it("asks STS with the profile, then drives CloudFormation as the bootstrap deploy role with no profile, in the named region", async () => {
    writeFileSync(logFile, "");
    const p = ports();
    expect(await p.sts.account()).toBe(FAKE_ACCOUNT);
    const stack = await p.cfn.describeStack("rovara-cloud-beta-web");
    expect(stack).toEqual({ status: "UPDATE_COMPLETE", parameters: { ImageDigest: "sha256:x" }, outputs: { CloudUrl: "https://c.example.test/app" } });
    const lines = log();
    expect(lines[0]).toBe("rovara-cloud-beta||sts get-caller-identity --region us-east-1 --output json");
    expect(lines[1]).toBe(`rovara-cloud-beta||sts assume-role --role-arn arn:aws:iam::${FAKE_ACCOUNT}:role/cdk-hnb659fds-deploy-role-${FAKE_ACCOUNT}-us-east-1 --role-session-name rovara-pipeline-1a2b3c4d --region us-east-1 --output json`);
    expect(lines[2]).toBe("|AKIATEST|cloudformation describe-stacks --stack-name rovara-cloud-beta-web --region us-east-1 --output json");
  });

  it("maps 'does not exist' and ChangeSetNotFound to null, parses property names (never values) from the details, leaves a row without details bare, and hashes templates by content", async () => {
    const p = ports();
    expect(await p.cfn.describeStack("missing")).toBeNull();
    expect(await p.cfn.describeChangeSet("s", "nochangeset")).toBeNull();
    const cs = await p.cfn.describeChangeSet("s", "x");
    expect(cs).toEqual({ id: "cs-1", status: "CREATE_COMPLETE", executionStatus: "AVAILABLE", statusReason: null, rows: [{ action: "Modify", logicalId: "Fn", physicalId: "fn-1", resourceType: "AWS::Lambda::Function", replacement: "False", changedProperties: ["Properties:Environment", "Tags"] }, { action: "Modify", logicalId: "Bare", physicalId: null, resourceType: "AWS::SQS::Queue", replacement: "False" }] });
    expect(await p.cfn.templateSha256("s", "x")).toBe(canonicalSha256({ a: { c: 3, d: 2 }, b: 1 }));
    expect(await p.cfn.listChangeSetNames("s")).toEqual(["rovara-pipeline-aaaaaaaa"]);
  });

  it("reads a change set of a stack that does not exist as no change set (the cleanup after a failed first call must not fail)", async () => {
    expect(await ports().cfn.describeChangeSet("nostack", "x")).toBeNull();
  });

  it("every CloudFormation read names the region, asks for json, and runs as the deploy role with no profile", async () => {
    writeFileSync(logFile, "");
    const p = ports();
    await p.cfn.describeChangeSet("s", "rovara-pipeline-1a2b3c4d");
    await p.cfn.templateSha256("s", "rovara-pipeline-1a2b3c4d");
    await p.cfn.liveTemplateSha256("s");
    await p.cfn.listChangeSetNames("s");
    const lines = log().filter((l) => l.split("|")[2]!.startsWith("cloudformation "));
    expect(lines.map((l) => l.split("|")[2])).toEqual([
      "cloudformation describe-change-set --stack-name s --change-set-name rovara-pipeline-1a2b3c4d --region us-east-1 --output json",
      "cloudformation get-template --stack-name s --change-set-name rovara-pipeline-1a2b3c4d --template-stage Original --region us-east-1 --output json",
      "cloudformation get-template --stack-name s --template-stage Original --region us-east-1 --output json",
      "cloudformation list-change-sets --stack-name s --region us-east-1 --output json",
    ]);
    expect(lines.every((l) => l.startsWith("|AKIATEST|"))).toBe(true);
  });

  it("executes and deletes change sets by name through the deploy role", async () => {
    writeFileSync(logFile, "");
    const p = ports();
    await p.cfn.executeChangeSet("s", "rovara-pipeline-1a2b3c4d");
    await p.cfn.deleteChangeSet("s", "rovara-pipeline-1a2b3c4d");
    const lines = log().filter((l) => l.includes("change-set --stack-name"));
    expect(lines.map((l) => l.split("|")[2]!.split(" --region")[0])).toEqual(["cloudformation execute-change-set --stack-name s --change-set-name rovara-pipeline-1a2b3c4d", "cloudformation delete-change-set --stack-name s --change-set-name rovara-pipeline-1a2b3c4d"]);
    expect(lines.every((l) => l.startsWith("|AKIATEST|"))).toBe(true);
  });

  it("reads and writes SSM as a plain String, never with decryption", async () => {
    writeFileSync(logFile, "");
    const p = ports();
    expect(await p.ssm.get("/x/absent")).toBeNull();
    expect(await p.ssm.get("/x/there")).toBe('{"schema":1}');
    await p.ssm.put("/rovara-cloud/beta/release/last-good", "{}");
    const lines = log().join("\n");
    expect(lines).toContain("ssm put-parameter --name /rovara-cloud/beta/release/last-good --value {} --type String --overwrite");
    expect(lines).not.toMatch(/with-decryption|get-secret-value|batch-get-secret-value/u);
  });

  it("runs commands without throwing on a non-zero exit, and reports a missing program as 127", async () => {
    const p = ports();
    expect((await p.exec("bash", ["-c", "echo out; echo err >&2; exit 3"]))).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
    expect((await p.exec("definitely-not-a-program-xyz", [])).code).toBe(127);
  });

  describe("git", () => {
    const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } }).trim();
    const origin = join(root, "origin.git");
    const clone = join(root, "clone");
    let first = "", second = "";

    beforeAll(() => {
      mkdirSync(origin);
      git(origin, "init", "--bare", "--initial-branch=cloud/next");
      mkdirSync(clone);
      git(clone, "init", "--initial-branch=cloud/next");
      git(clone, "remote", "add", "origin", origin);
      writeFileSync(join(clone, "a.txt"), "1");
      git(clone, "add", "a.txt"); git(clone, "commit", "-m", "one");
      first = git(clone, "rev-parse", "HEAD");
      git(clone, "tag", "v0.1.0");
      writeFileSync(join(clone, "a.txt"), "2");
      git(clone, "commit", "-am", "two");
      second = git(clone, "rev-parse", "HEAD");
      git(clone, "tag", "v0.1.1");
      git(clone, "push", "origin", "cloud/next", "--tags");
      git(clone, "tag", "-d", "v0.1.0");
    });

    it("fetches tags and branches, resolves tags to commits, compares ancestry, and adds a detached worktree", async () => {
      const p = createRealPorts({ config, env: "beta", region: "us-east-1", exec8: "1a2b3c4d", profile: null, cwd: clone });
      await p.git.fetchTags();
      expect((await p.git.tags()).sort()).toEqual(["v0.1.0", "v0.1.1"]);
      expect(await p.git.fetchBranch("cloud/next")).toBe(true);
      expect(await p.git.fetchBranch("mainline")).toBe(false);
      expect(await p.git.revParse("refs/tags/v0.1.0^{commit}")).toBe(first);
      await expect(p.git.revParse("refs/tags/nope^{commit}")).rejects.toMatchObject({ exitName: "REF_FAILED" });
      expect(await p.git.isAncestor(first, "origin/cloud/next")).toBe(true);
      expect(await p.git.isAncestor(second, first)).toBe(false);
      await expect(p.git.isAncestor("0".repeat(40), "origin/cloud/next")).rejects.toMatchObject({ exitName: "REF_FAILED" });
      const dir = join(root, "wt");
      await p.git.worktree(first, dir);
      expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("1");
      await expect(p.git.worktree(first, dir)).rejects.toMatchObject({ exitName: "FAILED" });
    });
  });
});
