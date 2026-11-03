// Saved project images (SV wiring): the registry's real bindings. Built only while sv is on and the install can run the registry; the approved environment, its Prove report and the default branch heads come from the
// broker's own stores and code host; the key and the build inputs come from readers the install gives, and without them the registry queues nothing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { orgPk } from "@agentx/contracts";
import { brokerDependencies } from "../../packages/broker/src/aws/broker/dependency-wiring.js";
import { realSavedEnvDeps, savedEnvConfigOf, savedEnvDefaultHeads } from "../../packages/broker/src/aws/broker/saved-env-real.js";
import type { SavedEnvAwsClients } from "../../packages/broker/src/aws/broker/saved-env-aws.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { NAME, setupWizardBench } from "../support/setup-wizard-testenv.js";
import { TEST_ORG } from "../support/orgs.js";

const KEY_ARN = "arn:aws:kms:us-west-2:111122223333:key/11111111-2222-3333-4444-555555555555";
const ENV = { SAVED_ENV_ENABLED: "1", AGENTX_ENV: "staging", AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "111122223333", SAVED_ENV_KMS_KEY_ARN: KEY_ARN } as const;
const CLIENTS: SavedEnvAwsClients = { sts: { send: async () => { throw new Error("no AWS in this test"); } }, ecr: () => ({ send: async () => { throw new Error("no AWS in this test"); } }) };

afterEach(() => { vi.restoreAllMocks(); for (const name of Object.keys(ENV)) delete process.env[name]; delete process.env.TEST_ENVIRONMENT_ENABLED; });
const setEnv = () => { Object.assign(process.env, ENV); process.env.TEST_ENVIRONMENT_ENABLED = "1"; };

describe("the config", () => {
  it("is the install's environment name, region, account and the key the template encrypts with", () => {
    expect(savedEnvConfigOf(ENV)).toEqual({ env: "staging", scope: { partition: "aws", region: "us-west-2", account: "111122223333" }, kmsKeyArn: KEY_ARN });
    expect(savedEnvConfigOf({ ...ENV, AWS_REGION: "cn-north-1" })?.scope.partition).toBe("aws-cn");
  });

  it("accepts a multi-region key, and refuses a key id that is neither", () => {
    const multiRegion = "arn:aws:kms:us-west-2:111122223333:key/mrk-" + "a".repeat(32);
    expect(savedEnvConfigOf({ ...ENV, SAVED_ENV_KMS_KEY_ARN: multiRegion })?.kmsKeyArn).toBe(multiRegion);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    for (const bad of ["arn:aws:kms:us-west-2:111122223333:key/mrk-short", "arn:aws:kms:us-west-2:111122223333:key/mrk-" + "g".repeat(32), "arn:aws:kms:us-west-2:111122223333:alias/x"]) {
      expect(savedEnvConfigOf({ ...ENV, SAVED_ENV_KMS_KEY_ARN: bad }), bad).toBeUndefined();
    }
  });

  it("is nothing when any of them is missing or malformed, and the log names the variable and never a value", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    for (const [name, value] of [["AGENTX_ENV", ""], ["AWS_REGION", undefined], ["AGENTX_ACCOUNT_ID", "12"], ["SAVED_ENV_KMS_KEY_ARN", "alias/x"], ["SAVED_ENV_KMS_KEY_ARN", undefined]] as const) {
      expect(savedEnvConfigOf({ ...ENV, [name]: value }), `${name}=${String(value)}`).toBeUndefined();
    }
    expect(log.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("111122223333");
    expect(String(log.mock.calls[0]![0])).toContain("AGENTX_ENV");
  });
});

describe("the dependencies the broker is built with", () => {
  it("has the registry and its hooks only while sv is on and the install can run it", async () => {
    setEnv();
    const t = await setupWizardBench();
    const on = brokerDependencies(t.brokerInput as never);
    expect(on.savedEnvDeps).toBeDefined();
    expect(on.savedEnvPrepare).toBeDefined();
    expect(on.savedEnvLogin).toBeDefined();
    delete process.env.SAVED_ENV_ENABLED;
    const off = brokerDependencies(t.brokerInput as never);
    expect(off.savedEnvDeps).toBeUndefined();
    expect(off.savedEnvPrepare).toBeUndefined();
    process.env.SAVED_ENV_ENABLED = "1";
    delete process.env.SAVED_ENV_KMS_KEY_ARN;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const noKey = brokerDependencies(t.brokerInput as never);
    expect(noKey.savedEnvDeps).toBeUndefined();
    expect(noKey.savedEnvPrepare).toBeUndefined();
  });

  it("keeps a registry the caller supplied", async () => {
    setEnv();
    const supplied = { marker: "mine" } as never;
    const t = await setupWizardBench({ brokerExtra: { savedEnvDeps: supplied } });
    expect(brokerDependencies(t.brokerInput as never).savedEnvDeps).toBe(supplied);
  });
});

describe("the bindings", () => {
  async function bound(extra: Record<string, unknown> = {}) {
    setEnv();
    const audit = capturingAuditDeps();
    const t = await setupWizardBench({ audit, brokerExtra: extra });
    const dependencies = brokerDependencies(t.brokerInput as never);
    const deps = realSavedEnvDeps(dependencies, () => dependencies, ENV, CLIENTS)!;
    return { t, deps, dependencies };
  }

  it("reads the project's newest approved environment as a revision and a digest, and the Prove report recorded for that digest", async () => {
    const { t, deps } = await bound();
    expect(await deps.approved(TEST_ORG, NAME)).toBeUndefined();
    const digest = await t.approveFirst();
    expect(await deps.approved(TEST_ORG, NAME)).toEqual({ revision: 1, digest });
    expect(await deps.session.ports.readApproved(TEST_ORG, NAME)).toEqual({ revision: 1, digest });
    expect(await deps.session.ports.proveHolds(TEST_ORG, NAME, digest)).toBe(true);
    expect(await deps.session.ports.proveHolds(TEST_ORG, NAME, "9".repeat(64))).toBe(false);
    expect(await deps.approved(TEST_ORG, "no-such-project")).toBeUndefined();
  });

  it("reads each repository's default branch head from the code host, and nothing when any cannot be read", async () => {
    const { t, deps, dependencies } = await bound();
    expect(await deps.defaultHeads(TEST_ORG, NAME)).toEqual(new Map([["web", "c".repeat(40)]]));
    t.githubHead.mockRejectedValueOnce(new Error("down"));
    expect(await deps.defaultHeads(TEST_ORG, NAME)).toBeUndefined();
    t.githubHead.mockResolvedValueOnce("not-a-sha");
    expect(await deps.defaultHeads(TEST_ORG, NAME)).toBeUndefined();
    expect(await savedEnvDefaultHeads(dependencies, TEST_ORG, "no-such-project")).toBeUndefined();
  });

  it("reads no head from a host that cannot answer one", async () => {
    const { deps } = await bound({ githubPullRequests: { reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(), getRepositoryIdentity: vi.fn() } });
    expect(await deps.defaultHeads(TEST_ORG, NAME)).toBeUndefined();
  });

  it("has no environment key unless the install gives a reader, and uses the reader's answer when it does", async () => {
    const none = await bound();
    expect(await none.deps.currentKey(TEST_ORG, NAME)).toBeUndefined();
    const keyed = await bound({ savedEnvKey: async (orgId: string, project: string) => `${"k".repeat(60)}${orgId.length > 0 && project.length > 0 ? "abcd" : ""}` });
    expect(await keyed.deps.currentKey(TEST_ORG, NAME)).toBe(`${"k".repeat(60)}abcd`);
  });

  it("writes through the DynamoDB store in the company's partition, and takes the defaults for the company settings", async () => {
    const { t, deps } = await bound();
    expect(await deps.keep(TEST_ORG)).toBe(3);
    expect(await deps.lightAfterIdleDays?.(TEST_ORG, NAME)).toBe(7);
    expect(await deps.store.commit({ orgId: TEST_ORG, projectId: NAME, version: 1, enabled: true, images: [], health: "never_proved" }, null, { action: "activity", orgId: TEST_ORG, projectId: NAME, at: new Date().toISOString() })).toBe(true);
    expect(t.db.get(orgPk(TEST_ORG), `SAVED_ENV#${NAME}`)).toMatchObject({ entityType: "SAVED_ENV", version: 1 });
    expect(deps.session.config).toEqual({ enabled: true, env: "staging", scope: { partition: "aws", region: "us-west-2", account: "111122223333" }, kmsKeyArn: KEY_ARN });
  });

  it("starts a queued job through the broker's start, and a job that cannot be started (no build inputs) is ended", async () => {
    const { t, deps } = await bound();
    await t.approveFirst();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { checkRebuild } = await import("../../packages/broker/src/test-env/saved-env.js");
    // no reader for the key: nothing is queued
    expect(await checkRebuild(deps, { orgId: TEST_ORG, projectId: NAME }, "poll")).toMatchObject({ ok: true, queued: false, why: "no_key" });
    const withKey = await bound({ savedEnvKey: async () => "c".repeat(64) });
    await withKey.t.approveFirst();
    const queued = await checkRebuild(withKey.deps, { orgId: TEST_ORG, projectId: NAME }, "poll");
    expect(queued).toMatchObject({ ok: true, queued: true });
    // no build inputs from the install: the start refuses and the job is ended with its word
    const row = await withKey.deps.store.get(TEST_ORG, NAME);
    expect(row).toMatchObject({ health: "needs_repair", lastFailure: "no_build_inputs" });
    expect(row?.job).toBeUndefined();
  });
});
