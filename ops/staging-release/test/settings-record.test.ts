/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- the tests read JSON records */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeWorld, runPack, type World } from "./support/harness.ts";
import { ACCT, PIPE_ENV, stack, writePackage } from "./support/fixtures.ts";

let w: World;
let pkg: string;
const SETTINGS = "ssm.get-parameter._agentx_staging_settings.json";
const existing = {
  schemaVersion: 1, env: "staging", account: ACCT, region: "us-west-2", engine: "cdk", version: "0.5.47", naming: "environment",
  stacks: { access: stack("access"), foundation: stack("foundation"), identity: stack("identity"), runtime: stack("runtime"), "control-plane": stack("control-plane"), slack: stack("slack") },
  controlPlaneUrl: "https://old.example.test", identity: { mode: "cognito", issuer: "https://cognito-idp.us-west-2.amazonaws.com/old", audience: "old", clientId: "old" },
  models: { orchestrator: "m-o", classifier: "m-c", worker: "m-w" }, alertAddress: "ops@example.test",
  access: { artifactBucket: "old-bucket", cloudFormationRoleArn: `arn:aws:iam::${ACCT}:role/agentx-staging-cloudformation`, operatorRoleArn: `arn:aws:iam::${ACCT}:role/agentx-staging-operator`, pullThroughPrefix: "agentx-staging", permissionsBoundaryArn: `arn:aws:iam::${ACCT}:policy/agentx/staging/b` },
  cloud: { legacy: true }, updatedAt: "2026-11-23T20:28:10.615Z",
};
const outputs = (o: Record<string, string>): object => ({ Stacks: [{ StackStatus: "UPDATE_COMPLETE", Outputs: Object.entries(o).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }] });
const env = (extra: Record<string, string> = {}): Record<string, string> => ({ ...PIPE_ENV(w), SYNTH_DIR: pkg, RELEASE_VERSION: "0.5.49", SETTINGS_PARAMETER: "/agentx/staging/settings", ...extra });
const written = (): any => JSON.parse(readFileSync(join(w.dir, "ssm-put._agentx_staging_settings.json"), "utf8"));
const puts = (): string[] => w.calls().filter((c) => c.startsWith("ssm put-parameter"));

beforeEach(() => {
  w = makeWorld();
  pkg = writePackage(join(w.work, "release"));
  writeFileSync(join(pkg, "answers.json"), JSON.stringify({ env: "staging", region: "us-west-2", account: ACCT, models: { orchestrator: "new-o", classifier: "new-c", worker: "new-w" } }));
  w.answer(SETTINGS, { Parameter: { Name: "/agentx/staging/settings", Value: JSON.stringify(existing) } });
  w.answer(`cloudformation.describe-stacks.${stack("control-plane")}.json`, outputs({ ApiEndpoint: "https://api.example.test" }));
  w.answer(`cloudformation.describe-stacks.${stack("access")}.json`, outputs({ ArtifactBucketName: "new-bucket", CloudFormationRoleArn: `arn:aws:iam::${ACCT}:role/agentx-staging-cloudformation`, OperatorRoleArn: `arn:aws:iam::${ACCT}:role/agentx-staging-operator`, PullThroughPrefix: "agentx-staging" }));
  w.answer(`cloudformation.describe-stacks.${stack("identity")}.json`, outputs({ Issuer: "https://cognito-idp.us-west-2.amazonaws.com/new", Audience: "aud", ClientId: "cid" }));
});
afterEach(() => w.cleanup());

describe("settings-record.sh", () => {
  it("writes exactly the CLI's fields (and no others), from the stack outputs, the answers and the existing record", () => {
    const r = runPack(w, "settings-record.sh", env());
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const rec = written();
    expect(Object.keys(rec).sort()).toEqual(["access", "account", "alertAddress", "controlPlaneUrl", "engine", "env", "identity", "models", "naming", "region", "schemaVersion", "stacks", "updatedAt", "version"]);
    expect(rec).toMatchObject({
      schemaVersion: 1, env: "staging", account: ACCT, region: "us-west-2", engine: "cdk", version: "0.5.49", naming: "environment", controlPlaneUrl: "https://api.example.test", alertAddress: "ops@example.test",
      stacks: existing.stacks,
      identity: { mode: "cognito", issuer: "https://cognito-idp.us-west-2.amazonaws.com/new", audience: "aud", clientId: "cid" },
      models: { orchestrator: "new-o", classifier: "new-c", worker: "new-w" },
      access: { artifactBucket: "new-bucket", cloudFormationRoleArn: existing.access.cloudFormationRoleArn, operatorRoleArn: existing.access.operatorRoleArn, pullThroughPrefix: "agentx-staging", permissionsBoundaryArn: existing.access.permissionsBoundaryArn },
    });
    expect(Object.keys(rec.access).sort()).toEqual(["artifactBucket", "cloudFormationRoleArn", "operatorRoleArn", "permissionsBoundaryArn", "pullThroughPrefix"]);
    expect(Object.keys(rec.identity).sort()).toEqual(["audience", "clientId", "issuer", "mode"]);
    expect(rec.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(rec.cloud, "legacy keys are dropped, as the CLI's write drops them").toBeUndefined();
    expect(puts()).toHaveLength(1);
    expect(puts()[0]).toContain("--name /agentx/staging/settings");
    expect(puts()[0]).toContain("--type String");
    expect(puts()[0]).toContain("--overwrite");
  });
  it("keeps the existing models when the answers carry none, and omits alertAddress / permissionsBoundaryArn when the existing record has none", () => {
    writeFileSync(join(pkg, "answers.json"), JSON.stringify({ env: "staging" }));
    const bare = { ...existing, alertAddress: undefined, access: { ...existing.access, permissionsBoundaryArn: undefined } };
    w.answer(SETTINGS, { Parameter: { Value: JSON.stringify(bare) } });
    expect(runPack(w, "settings-record.sh", env()).status).toBe(0);
    const rec = written();
    expect(rec.models).toEqual(existing.models);
    expect(rec.alertAddress).toBeUndefined();
    expect(rec.access.permissionsBoundaryArn).toBeUndefined();
  });
  it("an own-OIDC environment keeps its identity block", () => {
    const oidc = { ...existing, identity: { mode: "oidc", issuer: "https://idp.example.test", audience: "a", clientId: "c" } };
    w.answer(SETTINGS, { Parameter: { Value: JSON.stringify(oidc) } });
    expect(runPack(w, "settings-record.sh", env()).status).toBe(0);
    expect(written().identity).toEqual(oidc.identity);
  });
  it("refuses on missing or malformed inputs, writing nothing", () => {
    const refused = (extra: Record<string, string>, why: RegExp): void => {
      const r = runPack(w, "settings-record.sh", env(extra));
      expect(r.status, r.stdout).toBe(3);
      expect(r.stderr).toMatch(why);
    };
    refused({ RELEASE_VERSION: "" }, /RELEASE_VERSION/);
    refused({ RELEASE_VERSION: "0.5" }, /x\.y\.z/);
    refused({ SETTINGS_PARAMETER: "/agentx/production/settings" }, /must be \/agentx\/staging\/settings/);
    refused({ SETTINGS_PARAMETER: "" }, /SETTINGS_PARAMETER/);
    w.answer(`cloudformation.describe-stacks.${stack("control-plane")}.json`, outputs({}));
    refused({}, /ApiEndpoint/);
    w.answer(`cloudformation.describe-stacks.${stack("control-plane")}.json`, outputs({ ApiEndpoint: "https://api.example.test" }));
    w.answer(`cloudformation.describe-stacks.${stack("access")}.json`, outputs({ ArtifactBucketName: "b" }));
    refused({}, /access stack has no/);
    w.answer(`cloudformation.describe-stacks.${stack("access")}.json`, outputs({ ArtifactBucketName: "b", CloudFormationRoleArn: "r", OperatorRoleArn: "o", PullThroughPrefix: "p" }));
    w.answer(`cloudformation.describe-stacks.${stack("identity")}.json`, outputs({ Issuer: "i" }));
    refused({}, /identity stack has no/);
    expect(puts()).toHaveLength(0);
  });
  it("validates models from answers.json against the CLI's strict schema (refuses anything else, writes nothing); a full valid shape passes", () => {
    const arn = `arn:aws:secretsmanager:us-west-2:${ACCT}:secret:openrouter-key-AbCdEf`;
    const base = { orchestrator: "o", classifier: "c", worker: "w" };
    const answers = (models: unknown): void => writeFileSync(join(pkg, "answers.json"), JSON.stringify({ env: "staging", models }));
    for (const bad of ["a string", { ...base, worker: "" }, { orchestrator: "o", classifier: "c" }, { ...base, extra: 1 }, { ...base, providers: { worker: "not-a-provider" } }, { ...base, providers: { other: "openrouter" } },
      { ...base, openRouter: { secretArn: "not-an-arn" } }, { ...base, openRouter: { secretArn: arn, providers: [] } }, { ...base, openRouter: { secretArn: arn, providers: ["Bad Slug"] } }, { ...base, anthropic: { secretArn: arn, key: "x" } }, { ...base, openai: { secretArn: "nope" } }, { ...base, openRouter: { providers: ["a"] } }]) {
      answers(bad);
      const r = runPack(w, "settings-record.sh", env());
      expect(r.status, JSON.stringify(bad)).toBe(3);
      expect(r.stderr).toContain("models schema");
    }
    expect(puts()).toHaveLength(0);
    answers({ ...base, providers: { orchestrator: "amazon-bedrock", worker: "openrouter" }, openRouter: { secretArn: arn, providers: ["anthropic", "openai/gpt"] }, anthropic: { secretArn: arn }, openai: { secretArn: arn } });
    const ok = runPack(w, "settings-record.sh", env());
    expect(ok.status, ok.stderr).toBe(0);
    expect(written().models.openRouter.secretArn).toBe(arn);
  });
  it("refuses with no existing record, a record for another account, and an unreadable record (throttled)", () => {
    w.answer(SETTINGS, { __error: "ParameterNotFound", message: "x" });
    expect(runPack(w, "settings-record.sh", env()).status).toBe(3);
    w.answer(SETTINGS, { Parameter: { Value: JSON.stringify({ ...existing, account: "999999999999" }) } });
    expect(runPack(w, "settings-record.sh", env()).status).toBe(3);
    w.answer(SETTINGS, { __error: "ThrottlingException", message: "x" });
    expect(runPack(w, "settings-record.sh", env()).status).not.toBe(0);
    expect(puts()).toHaveLength(0);
  });
  it("refuses the wrong environment and region", () => {
    expect(runPack(w, "settings-record.sh", env({ ENVIRONMENT: "production" })).status).toBe(3);
    expect(runPack(w, "settings-record.sh", env({ AWS_REGION: "us-east-1" })).status).toBe(3);
  });
});
