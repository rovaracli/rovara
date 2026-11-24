/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- the tests read the JSON records the scripts write and edit plain JSON documents, which a typed document would not allow */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PACK, makeWorld, runPack, type World } from "./support/harness.ts";
import { SLACK_URI, WORKER_URI, ACCT, BOOTSTRAP, CS, ASSET_KEY, EXEC_ID, PARTS, PIPE_ENV, ROLE, SHA, changeSetDoc, csId, dirHash, stack, writeChangeSets, writePackage, writeStacks } from "./support/fixtures.ts";

let w: World;
let pkg: string;
let out: string;
const env = (): Record<string, string> => ({ ...PIPE_ENV(w), SYNTH_DIR: pkg, RELEASE_VERSION: "0.5.49" });
const setup = (): void => {
  w = makeWorld();
  pkg = writePackage(join(w.work, "release"));
  out = join(w.work, "out");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "release.sha256"), dirHash(pkg) + "\n");
  writeStacks(w);
  writeChangeSets(w);
};
beforeEach(setup);
afterEach(() => w.cleanup());
const read = (f: string): any => JSON.parse(readFileSync(join(out, f), "utf8"));

describe("preview.sh", () => {
  it("creates one named change set per stack, uploads assets without overwriting, records ids and the package hash, executes nothing", () => {
    const r = runPack(w, "preview.sh", env());
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const calls = w.calls();
    const creates = calls.filter((c) => c.startsWith("cloudformation create-change-set"));
    expect(creates).toHaveLength(6);
    for (const p of PARTS) {
      const c = creates.find((x) => x.includes(`--stack-name ${stack(p)} `));
      expect(c, p).toBeDefined();
      expect(c).toContain(`--change-set-name ${CS}`);
      if (p === "access") expect(c).not.toContain("--role-arn");
      else expect(c).toContain(`--role-arn ${ROLE}`);
    }
    expect(calls.some((c) => c.includes("execute-change-set"))).toBe(false);
    expect(calls.some((c) => /secretsmanager|get-secret-value|--query|--output text/.test(c))).toBe(false);
    // the asset went to the bootstrap bucket under its key, with a conditional write; the templates under a per-execution key
    const putAsset = calls.find((c) => c.startsWith("s3api put-object") && c.includes(`--key ${ASSET_KEY}`));
    expect(putAsset).toContain("--if-none-match *");
    expect(w.s3Has(BOOTSTRAP, ASSET_KEY)).toBe(true);
    expect(w.s3Has(BOOTSTRAP, `rovara-pipeline/${EXEC_ID}/${stack("slack")}.json`)).toBe(true);
    const pv = read("preview.json");
    expect(pv).toMatchObject({ execution: EXEC_ID, sha: SHA, version: "0.5.49", releasePackageSha256: dirHash(pkg), changeSetName: CS, cloudFormationRole: ROLE });
    expect(pv.changeSets).toHaveLength(6);
    expect(pv.changeSets.find((c: any) => c.part === "runtime")).toMatchObject({ changeSetId: csId("runtime"), changeSetName: CS, noChanges: false, status: "CREATE_COMPLETE" });
    expect(pv.assets).toEqual([{ key: ASSET_KEY, sha256: expect.any(String), state: "uploaded" }]);
    expect(readFileSync(join(out, "rows-summary.txt"), "utf8")).toContain("AWS::SSM::Parameter");
    for (const f of ["changeset.json", "template.json", "live-template.json", "params.json", "live-params.json"]) expect(readFileSync(join(out, `${stack("runtime")}.${f}`), "utf8").length).toBeGreaterThan(2);
    expect(read("before-outputs.json").some((o: any) => o.OutputKey === "ApiEndpoint")).toBe(true);
    // the parameters: the image overrides win, the NoEcho key keeps its previous value and is never named
    const rt = read(`${stack("runtime")}.params.json`);
    expect(rt).toContainEqual({ ParameterKey: "WorkerImageUri", ParameterValue: expect.stringContaining("@sha256:") });
    expect(read(`${stack("control-plane")}.params.json`)).toContainEqual({ ParameterKey: "CallbackSigningKey", UsePreviousValue: true });
    // release.sha256 is the stage's own file: untouched
    expect(readFileSync(join(out, "release.sha256"), "utf8").trim()).toBe(dirHash(pkg));
  });

  it("does not rewrite an asset key that already exists", () => {
    w.s3Put(BOOTSTRAP, ASSET_KEY, "something already there");
    const r = runPack(w, "preview.sh", env());
    expect(r.status, r.stderr).toBe(0);
    expect(w.calls().some((c) => c.startsWith("s3api put-object") && c.includes(`--key ${ASSET_KEY}`))).toBe(false);
    expect(w.s3Get(BOOTSTRAP, ASSET_KEY)).toBe("something already there");
    expect(read("preview.json").assets[0].state).toBe("existing");
  });

  it("refuses an asset whose bytes do not match the index", () => {
    writeFileSync(join(pkg, "assets", ASSET_KEY), "tampered");
    writeFileSync(join(out, "release.sha256"), dirHash(pkg) + "\n");
    const r = runPack(w, "preview.sh", env());
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("does not match its recorded sha256");
    expect(w.calls().some((c) => c.startsWith("cloudformation create-change-set"))).toBe(false);
  });

  it("refuses without the stage's release package hash, or with a malformed one", () => {
    writeFileSync(join(out, "release.sha256"), "nope\n");
    expect(runPack(w, "preview.sh", env()).status).toBe(3);
    writeFileSync(join(out, "release.sha256"), "");
    expect(runPack(w, "preview.sh", env()).status).toBe(3);
  });

  it("F7: overrides.json (written by merged code) may name only the two image parameters: a NoEcho secret, another parameter or another part is refused before any change set", () => {
    for (const bad of [{ "control-plane": { CallbackSigningKey: "x" } }, { runtime: { WorkerImageUri: WORKER_URI, SomeSwitch: "on" } }, { slack: { OrchestratorImageUri: SLACK_URI, ExecutorImageUri: "x" } }, { access: { X: "1" } }]) {
      writeFileSync(join(pkg, "overrides.json"), JSON.stringify(bad));
      writeFileSync(join(out, "release.sha256"), dirHash(pkg) + "\n");
      const r = runPack(w, "preview.sh", env());
      expect(r.status, JSON.stringify(bad)).toBe(3);
      expect(r.stderr).toContain("other than the worker and slack image parameters");
    }
    expect(w.calls().some((c) => c.startsWith("cloudformation create-change-set"))).toBe(false);
  });

  it("F7: even past that check, the parameter builder refuses an override of a NoEcho parameter", () => {
    writeFileSync(join(w.work, "o.json"), JSON.stringify({ "control-plane": { CallbackSigningKey: "x" } }));
    const r2 = spawnSync("python3", ["-I", join(PACK, "lib/changeset_tools.py"), "params", join(pkg, "synth/AgentXControlPlane.template.json"), "-", join(w.work, "o.json"), "control-plane", "-", join(w.work, "p.json")], { encoding: "utf8" });
    expect(r2.status).not.toBe(0);
    expect(r2.stderr).toContain("NoEcho");
  });

  it("refuses a package with an override that is a placeholder (a pipeline change set is executed)", () => {
    writeFileSync(join(pkg, "overrides.json"), JSON.stringify({ "control-plane": { CallbackSigningKey: "@random-preview" } }));
    const r = runPack(w, "preview.sh", env());
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("placeholder");
    expect(w.calls().some((c) => c.startsWith("cloudformation create-change-set"))).toBe(false);
  });

  it("refuses an unsettled stack and a change set of its own name that already exists", () => {
    writeStacks(w, { slack: "UPDATE_IN_PROGRESS" });
    expect(runPack(w, "preview.sh", env()).status).toBe(3);
    writeStacks(w);
    w.answer(`cloudformation.list-change-sets.${stack("runtime")}.json`, { Summaries: [{ ChangeSetName: CS }] });
    const r = runPack(w, "preview.sh", env());
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("already has a change set");
  });

  it("refuses a change set that failed for any reason but 'no changes'", () => {
    w.answer(`cloudformation.describe-change-set.${stack("identity")}.${CS}.json`, changeSetDoc("identity", "FAILED", "Parameter validation failed"));
    const r = runPack(w, "preview.sh", env());
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("FAILED");
  });

  it("records a 'no changes' change set as such", () => {
    w.answer(`cloudformation.describe-change-set.${stack("identity")}.${CS}.json`, changeSetDoc("identity", "FAILED", "The submitted information didn't contain changes."));
    const r = runPack(w, "preview.sh", env());
    expect(r.status, r.stderr).toBe(0);
    expect(read("preview.json").changeSets.find((c: any) => c.part === "identity")).toMatchObject({ noChanges: true, status: "FAILED", rows: 0 });
  });

  it("refuses when the access stack names no CloudFormation role of this account", () => {
    w.answer(`cloudformation.describe-stacks.${stack("access")}.json`, { Stacks: [{ StackStatus: "UPDATE_COMPLETE", Parameters: [], Outputs: [{ OutputKey: "CloudFormationRoleArn", OutputValue: "arn:aws:iam::999999999999:role/agentx/staging/agentx-staging-cloudformation" }] }] });
    expect(runPack(w, "preview.sh", env()).status).toBe(3);
  });

  it("refuses the wrong region and a non-staging environment", () => {
    expect(runPack(w, "preview.sh", { ...env(), AWS_REGION: "us-east-1" }).status).toBe(3);
    expect(runPack(w, "preview.sh", { ...env(), ENVIRONMENT: "production" }).status).toBe(3);
  });

  it("stops when a slack parameter would only be known after the control plane deploys (no placeholder reaches a change set)", () => {
    const tpl = JSON.parse(readFileSync(join(pkg, "synth/AgentXSlackOrchestrator.template.json"), "utf8"));
    tpl.Parameters.ChannelRequestQueueUrl = { Type: "String", Default: "" };
    writeFileSync(join(pkg, "synth/AgentXSlackOrchestrator.template.json"), JSON.stringify(tpl));
    const cp = JSON.parse(readFileSync(join(pkg, "synth/AgentXControlPlane.template.json"), "utf8"));
    cp.Outputs = { ChannelRequestQueueUrl: { Value: { Ref: "SomeNewQueue" } } };
    writeFileSync(join(pkg, "synth/AgentXControlPlane.template.json"), JSON.stringify(cp));
    writeFileSync(join(out, "release.sha256"), dirHash(pkg) + "\n");
    const r = runPack(w, "preview.sh", env());
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("needs a hand deploy");
    expect(w.calls().some((c) => c.includes("create-change-set") && c.includes(`--stack-name ${stack("slack")}`))).toBe(false);
  });
});
void ACCT;
