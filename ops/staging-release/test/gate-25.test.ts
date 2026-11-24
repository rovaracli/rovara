import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeWorld, runPack, type World } from "./support/harness.ts";

const EXEC = "0123abcd-0000-4000-8000-000000000000";
const CS = "rovara-pipeline-0123abcd";
const SHA = "a".repeat(40);
const PARTS = ["access", "control-plane", "runtime", "slack", "foundation", "identity"];

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- fixtures are plain CloudFormation JSON

const meta = (id: string, type: string): Obj => ({ Type: "Resource", ResourceChange: { Action: "Modify", LogicalResourceId: id, ResourceType: type, Replacement: "False", Scope: ["Metadata"], Details: [] } });
const lambdaRow = (id: string): Obj => ({ Type: "Resource", ResourceChange: { Action: "Modify", LogicalResourceId: id, ResourceType: "AWS::Lambda::Function", Replacement: "False", Scope: ["Properties"], Details: [{ Target: { Attribute: "Properties", Name: "Code" } }] } });
const cdkMeta: Obj = { Type: "Resource", ResourceChange: { Action: "Remove", LogicalResourceId: "CDKMetadata", ResourceType: "AWS::CDK::Metadata", Scope: [], Details: [] } };
const row = (action: string, id: string, type: string, replacement: string | null = "False"): Obj => ({ Type: "Resource", ResourceChange: { Action: action, LogicalResourceId: id, ResourceType: type, ...(replacement === null ? {} : { Replacement: replacement }), Scope: ["Properties"], Details: [] } });

function csDoc(changes: Obj[], extra: Obj = {}): Obj {
  return { ChangeSetName: CS, Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE", Changes: changes, Parameters: [], ...extra };
}
const lifecycle = { Resources: { Artifacts82DD59A1: { Properties: { LifecycleConfiguration: { Rules: [{ Id: "expire", Status: "Enabled", Prefix: "x/", ExpirationInDays: 30 }] } } } } };

function writePreview(dir: string, over: Record<string, Obj> = {}): void {
  mkdirSync(dir, { recursive: true });
  for (const p of PARTS) {
    const base = join(dir, `agentx-staging-${p}`);
    const changes = p === "control-plane" ? [lambdaRow("Broker"), meta("State1C20CC9A", "AWS::DynamoDB::Table"), cdkMeta] : [meta("Thing", "AWS::SSM::Parameter"), cdkMeta];
    const files: Record<string, Obj | unknown[]> = {
      changeset: csDoc(changes),
      template: p === "control-plane" ? lifecycle : { Resources: {} },
      "live-template": p === "control-plane" ? lifecycle : { Resources: {} },
      params: [{ ParameterKey: "CallbackSigningKey", UsePreviousValue: true }],
      "live-params": [{ ParameterKey: "CoreLessons", ParameterValue: "on" }],
    };
    if (p === "control-plane") files.changeset = csDoc(changes, { Parameters: [{ ParameterKey: "CoreLessons", UsePreviousValue: true, ResolvedValue: "on" }] });
    for (const [suffix, doc] of Object.entries(files)) writeFileSync(`${base}.${suffix}.json`, JSON.stringify(over[`${p}.${suffix}`] ?? doc));
  }
}

let w: World;
afterEach(() => w?.cleanup());

function run(over: Record<string, Obj> = {}, drop: string[] = []): { status: number | null; out: string; results: string } {
  w = makeWorld();
  const dir = join(w.work, "preview");
  writePreview(dir, over);
  for (const f of drop) writeFileSync(join(dir, f), "{ not json");
  const r = runPack(w, "gates/25-change-set-gates.sh", { PREVIEW_DIR: dir, EXEC_ID: EXEC, RELEASE_SHA: SHA });
  let results = "";
  try { results = readFileSync(join(w.work, "out/gates/25-change-set-gates/results.txt"), "utf8"); } catch { /* none */ }
  return { status: r.status, out: r.stdout + r.stderr, results };
}

describe("gate 25: the change-set scan", () => {
  it("passes a routine release (Lambda code, metadata rows, the CDKMetadata Remove)", () => {
    const r = run();
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("25- PASS");
    expect(r.results).toContain("G0");
    expect(r.out).not.toContain("[FAIL]");
  });
  it("G5: an Add row fails", () => {
    const r = run({ "slack.changeset": csDoc([row("Add", "NewTable", "AWS::DynamoDB::Table", null), cdkMeta]) });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/\[FAIL\] G5/);
  });
  it("G5: a Remove other than CDKMetadata fails", () => {
    const r = run({ "runtime.changeset": csDoc([row("Remove", "Old", "AWS::SQS::Queue", null)]) });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/\[FAIL\] G5/);
  });
  it("G1: a protected resource that is replaced fails", () => {
    const r = run({ "control-plane.changeset": csDoc([row("Modify", "State1C20CC9A", "AWS::DynamoDB::Table", "True")]) });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/\[FAIL\] G1/);
  });
  it("G1: a protected resource that is removed fails", () => {
    const r = run({ "identity.changeset": csDoc([row("Remove", "UserPool6BA7E5F2", "AWS::Cognito::UserPool", null)]) });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/\[FAIL\] G1/);
  });
  it("G0: a change set with another name fails", () => {
    const r = run({ "runtime.changeset": csDoc([meta("Thing", "AWS::SSM::Parameter")], { ChangeSetName: "rovara-switchover-preview" }) });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/\[FAIL\] G0/);
  });
  it("G0: a change set that is not CREATE_COMPLETE fails, and the no-changes answer passes", () => {
    expect(run({ "runtime.changeset": csDoc([], { Status: "FAILED", StatusReason: "boom" }) }).status).toBe(1);
    const ok = run({ "runtime.changeset": csDoc([], { Status: "FAILED", StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set.", ExecutionStatus: "UNAVAILABLE" }) });
    expect(ok.status, ok.out).toBe(0);
  });
  it("G2: a DNS firewall row that is replaced fails", () => {
    const r = run({ "foundation.changeset": csDoc([row("Modify", "AgentDnsFirewallAllowList8DD5FFDF", "AWS::Route53Resolver::FirewallDomainList", "True")]) });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/\[FAIL\] G2/);
  });
  it("G3: a shortened lifecycle expiration fails", () => {
    const shorter = { Resources: { Artifacts82DD59A1: { Properties: { LifecycleConfiguration: { Rules: [{ Id: "expire", Status: "Enabled", Prefix: "x/", ExpirationInDays: 1 }] } } } } };
    const r = run({ "control-plane.template": shorter });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/\[FAIL\] G3/);
  });
  it("G4: an added broker managed policy fails", () => {
    const r = run({ "control-plane.changeset": csDoc([row("Add", "BrokerServiceRoleX", "AWS::IAM::ManagedPolicy", null)]) });
    expect(r.out).toMatch(/\[FAIL\] G4/);
    expect(r.status).toBe(1);
  });
  it("G6U: the access stack replacing something fails", () => {
    const r = run({ "access.changeset": csDoc([row("Modify", "ArtifactBucket", "AWS::S3::Bucket", "True")]) });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/\[FAIL\] G6U/);
  });
  it("G7: a Core* parameter that differs from live fails; CoreEngine still passed fails", () => {
    const base = csDoc([lambdaRow("Broker")], { Parameters: [{ ParameterKey: "CoreLessons", ParameterValue: "off" }] });
    expect(run({ "control-plane.changeset": base }).out).toMatch(/\[FAIL\] G7/);
    const engine = csDoc([lambdaRow("Broker")], { Parameters: [{ ParameterKey: "CoreLessons", UsePreviousValue: true }, { ParameterKey: "CoreEngine", ParameterValue: "on" }] });
    expect(run({ "control-plane.changeset": engine }).status).toBe(1);
  });
  it("G8: replacing the sign-in token key fails", () => {
    const r = run({ "control-plane.changeset": csDoc([row("Modify", "DeveloperSignInTokenKey1", "AWS::KMS::Key", "True")]) });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/\[FAIL\] G8/);
  });
  it("G9 FAILS (the params files are uploaded) on a value for CallbackSigningKey or any NoEcho parameter, and passes on UsePreviousValue or the masked ****", () => {
    let r = run({ "slack.params": [{ ParameterKey: "CallbackSigningKey", ParameterValue: "x" }] });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/\[FAIL\] G9/);
    r = run({ "slack.params": [{ ParameterKey: "CallbackSigningKey", UsePreviousValue: true }] });
    expect(r.out).not.toMatch(/\[FAIL\] G9/);
    r = run({ "slack.params": [{ ParameterKey: "CallbackSigningKey", ParameterValue: "****" }] });
    expect(r.out).not.toMatch(/\[FAIL\] G9/);
  });
  it("G10: a half-moved batch 12 location fails", () => {
    const half = { Resources: { ...lifecycle.Resources, KeySecret: { Type: "AWS::SecretsManager::Secret", DeletionPolicy: "Retain", Properties: { Name: "agentx/staging/callback-key" } } } };
    const r = run({ "control-plane.template": half });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/\[FAIL\] G10/);
  });
  it("fails closed on a missing or unreadable input file", () => {
    w = makeWorld();
    const dir = join(w.work, "preview");
    writePreview(dir);
    writeFileSync(join(dir, "agentx-staging-slack.changeset.json"), "{ not json");
    const bad = runPack(w, "gates/25-change-set-gates.sh", { PREVIEW_DIR: dir, EXEC_ID: EXEC, RELEASE_SHA: SHA });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toMatch(/\[FAIL\] G0/);
    const missing = runPack(w, "gates/25-change-set-gates.sh", { PREVIEW_DIR: join(w.work, "nowhere"), EXEC_ID: EXEC, RELEASE_SHA: SHA });
    expect(missing.status).toBe(3);
    const w2 = makeWorld();
    const d2 = join(w2.work, "preview");
    writePreview(d2);
    // remove one file entirely
    writeFileSync(join(d2, "agentx-staging-identity.live-template.json"), "");
    const empty = runPack(w2, "gates/25-change-set-gates.sh", { PREVIEW_DIR: d2, EXEC_ID: EXEC, RELEASE_SHA: SHA });
    w2.cleanup();
    expect(empty.status).toBe(1);
  });
  it("never calls AWS", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(w.calls()).toEqual([]);
  });
});
