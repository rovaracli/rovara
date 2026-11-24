import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeWorld, runPack, type Run, type World } from "./support/harness.ts";

type Obj = Record<string, unknown>;
const ACCT = "111111111111";
const PARTS = ["access", "control-plane", "runtime", "slack", "foundation", "identity"];
const stackOf = (p: string): string => `agentx-staging-${p}`;
const SHA = "a".repeat(40);

let w: World;
afterEach(() => w?.cleanup());

const metaRow = (id: string, type: string): Obj => ({
  Type: "Resource",
  ResourceChange: { Action: "Modify", LogicalResourceId: id, ResourceType: type, Replacement: "False", Scope: ["Metadata"], Details: [{ Target: { Attribute: "Metadata", Name: null }, ChangeSource: "DirectModification" }] },
});
const lambdaRow = (id: string, pid: string): Obj => ({
  Type: "Resource",
  ResourceChange: { Action: "Modify", LogicalResourceId: id, PhysicalResourceId: pid, ResourceType: "AWS::Lambda::Function", Replacement: "False", Scope: ["Properties"], Details: [{ Target: { Attribute: "Properties", Name: "Code" } }] },
});
const ssmRow = (id: string, pid: string): Obj => ({
  Type: "Resource",
  ResourceChange: { Action: "Modify", LogicalResourceId: id, PhysicalResourceId: pid, ResourceType: "AWS::SSM::Parameter", Replacement: "False", Scope: ["Properties"], Details: [{ Target: { Attribute: "Properties", Name: "Value" } }] },
});
const unknownRow = (): Obj => ({
  Type: "Resource",
  ResourceChange: { Action: "Add", LogicalResourceId: "Mystery", ResourceType: "AWS::Mystery::Thing", Scope: [], Details: [] },
});

interface Fixture {
  extraRows?: Obj[];
  skipFile?: string;
}

/** Six stacks' preview files in <work>/preview, plus the fake CLI answers the gate needs. */
function setup(f: Fixture = {}): string {
  w = makeWorld();
  const dir = join(w.work, "preview");
  mkdirSync(dir, { recursive: true });
  for (const p of PARTS) {
    const s = stackOf(p);
    const changes: Obj[] = [];
    const resources: Obj = {};
    if (p === "control-plane") {
      changes.push(metaRow("Bucket", "AWS::S3::Bucket"), lambdaRow("Broker", "fn-1"), ssmRow("Param", "/agentx/staging/worker-image"), ...(f.extraRows ?? []));
      resources.Broker = {
        Type: "AWS::Lambda::Function",
        Properties: { Role: { "Fn::GetAtt": ["BrokerRole", "Arn"] }, Code: { S3Bucket: { "Fn::Sub": "cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}" }, S3Key: `${"b".repeat(64)}.zip` } },
      };
      resources.BrokerRole = { Type: "AWS::IAM::Role", Properties: {} };
      w.answer(`cloudformation.list-stack-resources.${s}.json`, { StackResourceSummaries: [{ LogicalResourceId: "BrokerRole", PhysicalResourceId: "broker-role", ResourceType: "AWS::IAM::Role" }] });
    } else {
      changes.push(metaRow("Thing", "AWS::SQS::Queue"), { Type: "Resource", ResourceChange: { Action: "Remove", LogicalResourceId: "CDKMetadata", ResourceType: "AWS::CDK::Metadata", Scope: [], Details: [] } });
      w.answer(`cloudformation.list-stack-resources.${s}.json`, { StackResourceSummaries: [] });
    }
    if (f.skipFile !== `${s}.changeset.json`) writeFileSync(join(dir, `${s}.changeset.json`), JSON.stringify({ Status: "CREATE_COMPLETE", Changes: changes, Parameters: [] }));
    writeFileSync(join(dir, `${s}.template.json`), JSON.stringify({ Resources: resources }));
  }
  w.answer("iam.get-role.agentx-staging-cloudformation.json", { Role: { Arn: `arn:aws:iam::${ACCT}:role/agentx-staging-cloudformation`, PermissionsBoundary: { PermissionsBoundaryArn: `arn:aws:iam::${ACCT}:policy/agentx/staging/agentx-staging-boundary` } } });
  w.answer("iam.get-role.broker-role.json", { Role: { Arn: `arn:aws:iam::${ACCT}:role/agentx/staging/broker-role` } });
  return dir;
}

const run = (dir: string, env: Record<string, string> = {}): Run => runPack(w, "gates/15-role-sim.sh", { PREVIEW_DIR: dir, RELEASE_SHA: SHA, WORK: w.work, ...env });
const results = (): string => readFileSync(join(w.work, "out/gates/15-role-sim/results.txt"), "utf8");

describe("gate 15: the live deploy role simulation", () => {
  it("passes a routine release (metadata rows skipped, a Lambda code row, an SSM row, the IAM probe)", () => {
    const r = run(setup());
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain("[FAIL]");
    expect(results()).toContain("lambda:UpdateFunctionCode");
    expect(results()).toContain("ssm:PutParameter");
    expect(results()).toContain("iam:PassRole");
    expect(results()).toContain("not allowed: 0; unmapped rows: 0");
    // the Lambda code asset on the bootstrap bucket was simulated, the metadata-only S3 row was not
    expect(results()).toContain("s3:GetObject");
    expect(results()).not.toContain("s3:PutObject");
  });
  it("simulates the role by its real ARN with the real boundary and never writes", () => {
    const r = run(setup());
    expect(r.status).toBe(0);
    const calls = w.calls();
    expect(calls.some((c) => c.startsWith("iam simulate-principal-policy --policy-source-arn arn:aws:iam::111111111111:role/agentx-staging-cloudformation"))).toBe(true);
    expect(calls.some((c) => c.includes("bootstrap") || c.includes("put-") || c.includes("create-") || c.includes("delete-"))).toBe(false);
    expect(calls.some((c) => c.includes("--query") || c.includes("get-secret-value"))).toBe(false);
  });
  it("fails on an implicitDeny", () => {
    const dir = setup();
    w.answer("sim-decisions.json", { "lambda:UpdateFunctionCode": "implicitDeny" });
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/\[FAIL\] DENY\s+implicitDeny\s+lambda:UpdateFunctionCode/);
  });
  it("fails on an explicitDeny (the boundary)", () => {
    const dir = setup();
    w.answer("sim-decisions.json", { "iam:CreateRole": "explicitDeny" });
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/\[FAIL\].*explicitDeny\s+iam:CreateRole/);
  });
  it("fails when the simulation leaves an action unanswered", () => {
    const dir = setup();
    w.answer("sim-omit.json", ["ssm:PutParameter"]);
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/\[FAIL\].*NO-ANSWER\s+ssm:PutParameter/);
  });
  it("fails on a row with no action map (UNMAPPED), never skipping it", () => {
    const r = run(setup({ extraRows: [unknownRow()] }));
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/\[FAIL\] UNMAPPED control-plane\/Mystery Add AWS::Mystery::Thing/);
  });
  it("fails when the simulation call itself errors", () => {
    const dir = setup();
    w.answer("iam.simulate-principal-policy.json", { __error: "AccessDenied", message: "no" });
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("ERROR");
  });
  it("fails closed when a preview file is missing", () => {
    const r = run(setup({ skipFile: "agentx-staging-slack.changeset.json" }));
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("missing");
  });
  it("fails closed when the deploy role cannot be read", () => {
    const dir = setup();
    w.answer("iam.get-role.agentx-staging-cloudformation.json", { __error: "NoSuchEntity", message: "gone" });
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("STOP: cannot read role");
  });
  it("refuses a wrong region or a non-staging environment", () => {
    const dir = setup();
    expect(run(dir, { AWS_REGION: "us-east-1" }).status).toBe(3);
    expect(run(dir, { ENVIRONMENT: "production" }).status).toBe(3);
    expect(w.calls().filter((c) => c.startsWith("iam simulate"))).toEqual([]);
  });
  it("has no account id, home path or staging-aws guard in its source", () => {
    for (const f of ["gates/15-role-sim.sh", "gates/lib/role_sim.py"]) {
      const text = readFileSync(join(__dirname, "..", f), "utf8");
      expect(text, f).not.toMatch(/\b\d{12}\b/);
      expect(text, f).not.toMatch(/\/Users\/|staging-aws|get-secret-value/);
    }
  });
});
