import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeWorld, runPack, type World } from "./support/harness.ts";

const EXEC = "0123abcd-0000-4000-8000-000000000000";
const CS = "rovara-pipeline-0123abcd";
const SHA = "a".repeat(40);
const STACKS = ["access", "control-plane", "runtime", "slack", "foundation", "identity"].map((p) => `agentx-staging-${p}`);

const settings = { naming: "environment", env: "staging", account: "111111111111", region: "us-west-2", identity: { mode: "cognito" }, engine: "cdk", version: "0.5.47", stacks: { access: {}, foundation: {}, identity: {}, runtime: {}, "control-plane": {}, slack: {} } };

let w: World;
afterEach(() => w?.cleanup());

function world(over: { status?: Record<string, string>; changeSets?: Record<string, string[]>; settings?: unknown; brokerType?: string; assocStatus?: string } = {}): void {
  w = makeWorld();
  for (const s of STACKS) {
    w.answer(`cloudformation.describe-stacks.${s}.json`, { Stacks: [{ StackName: s, StackStatus: over.status?.[s] ?? "UPDATE_COMPLETE", Parameters: [] }] });
    w.answer(`cloudformation.list-change-sets.${s}.json`, { Summaries: (over.changeSets?.[s] ?? [CS]).map((n) => ({ ChangeSetName: n })) });
  }
  w.answer("ssm.get-parameter._agentx_staging_settings.json", { Parameter: { Value: JSON.stringify(over.settings ?? settings) } });
  w.answer("ssm.get-parameter._agentx_staging_broker-names.json", { Parameter: { Type: over.brokerType ?? "String", Version: 3 } });
  w.answer("cloudformation.list-stack-resources.agentx-staging-foundation.json", {
    StackResourceSummaries: [
      { LogicalResourceId: "AgentDnsFirewallAssociation4753647C", PhysicalResourceId: "rslvr-frgassoc-1" },
      { LogicalResourceId: "AgentDnsFirewallAllowList8DD5FFDF", PhysicalResourceId: "rslvr-fdl-a" },
      { LogicalResourceId: "AgentDnsFirewallProjectAllowList1C0C2230", PhysicalResourceId: "rslvr-fdl-b" },
      { LogicalResourceId: "AgentDnsFirewallBlockAllListBD1ED948", PhysicalResourceId: "rslvr-fdl-c" },
    ],
  });
  w.answer("route53resolver.get-firewall-rule-group-association.rslvr-frgassoc-1.json", { FirewallRuleGroupAssociation: { Status: over.assocStatus ?? "COMPLETE" } });
  for (const id of ["a", "b", "c"]) w.answer(`route53resolver.get-firewall-domain-list.rslvr-fdl-${id}.json`, { FirewallDomainList: { Status: "COMPLETE" } });
}

function run(): { status: number | null; out: string } {
  const r = runPack(w, "gates/45-checks.sh", { EXEC_ID: EXEC, RELEASE_SHA: SHA });
  return { status: r.status, out: r.stdout + r.stderr };
}

describe("gate 45: pre-checks", () => {
  it("passes on a healthy settled environment with only this run's change sets", () => {
    world();
    const r = run();
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("45- PASS");
    expect(readFileSync(join(w.work, "out/gates/45-checks/results.txt"), "utf8")).toContain("45- PASS");
    expect(r.out).not.toContain("[FAIL]");
  });
  it("fails when a stack is in UPDATE_ROLLBACK_IN_PROGRESS", () => {
    world({ status: { "agentx-staging-runtime": "UPDATE_ROLLBACK_IN_PROGRESS" } });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/\[FAIL\] agentx-staging-runtime is 'UPDATE_ROLLBACK_IN_PROGRESS'/);
  });
  it("fails when a stack has a change set that is not this run's", () => {
    world({ changeSets: { "agentx-staging-slack": [CS, "rovara-switchover-preview"] } });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/\[FAIL\] agentx-staging-slack has a change set that is not this run's/);
  });
  it("fails when a stack carries another run's change set and not its own", () => {
    world({ changeSets: { "agentx-staging-identity": ["rovara-pipeline-deadbeef"] } });
    expect(run().status).toBe(1);
  });
  it("fails on bad settings (legacy naming, wrong region, missing)", () => {
    world({ settings: { ...settings, naming: "legacy" } });
    expect(run().out).toMatch(/\[FAIL\] naming/);
    world({ settings: { ...settings, region: "us-east-1" } });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/\[FAIL\] env\/account\/region differ/);
    world();
    w.answer("ssm.get-parameter._agentx_staging_settings.json", { __error: "ParameterNotFound", message: "x" });
    expect(run().status).toBe(1);
  });
  it("fails when the broker-names parameter is not a String", () => {
    world({ brokerType: "SecureString" });
    expect(run().status).toBe(1);
  });
  it("fails when the DNS firewall association is not COMPLETE", () => {
    world({ assocStatus: "UPDATING" });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/\[FAIL\] association/);
  });
  it("is read-only: every call is a describe, list or get", () => {
    world();
    run();
    for (const c of w.calls()) expect(c, c).toMatch(/^(sts get-caller-identity|\S+ (describe|list|get)-)/);
  });
});
