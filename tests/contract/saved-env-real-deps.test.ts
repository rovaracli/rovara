// Saved project images (SV wiring): the registry's real bindings. Built only while sv is on and the install can run the registry; the approved environment, its Prove report and the default branch heads come from the
// broker's own stores and code host; the key and the build inputs come from readers the install gives, and without them the registry queues nothing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestEnvironmentBodySchema, orgPk, testEnvDigest } from "@agentx/contracts";
import { brokerDependencies } from "../../packages/broker/src/aws/broker/dependency-wiring.js";
import { expectedEnvironmentKey } from "../../packages/broker/src/test-env/saved-env-key.js";
import { realSavedEnvDeps, savedEnvConfigOf, savedEnvDefaultHeads, savedEnvSecretNames } from "../../packages/broker/src/aws/broker/saved-env-real.js";
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

  const HEAD = "c".repeat(40);
  const heads = new Map([["web", HEAD]]);
  const github = (entries: Array<{ path: string; mode: string; type: string; sha: string }>, truncated = false) => ({
    reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(), getRepositoryIdentity: vi.fn(), getFileAtCommit: vi.fn(async () => undefined),
    getDefaultBranchHead: vi.fn(async () => HEAD), listTreeAtCommit: vi.fn(async () => ({ truncated, entries })),
  });
  const LISTING = [{ path: "package.json", mode: "100644", type: "blob", sha: "1".repeat(40) }, { path: "src", mode: "040000", type: "tree", sha: "2".repeat(40) }];
  const DIGEST = `sha256:${"b".repeat(64)}`;

  it("works the environment key out from the code host's listing of the heads it is given, the approved environment and the base image the install says", async () => {
    const withBase = (listing = LISTING, truncated = false) => bound({ githubPullRequests: github(listing, truncated), savedEnvBaseImageDigest: async () => DIGEST });
    const first = await withBase();
    await first.t.approveFirst();
    const key = await first.deps.currentKey(TEST_ORG, NAME, heads);
    expect(key).toMatch(/^[a-f0-9]{64}$/u);
    // the same inputs, the same key; the listing is read for the commit it is given
    expect(await first.deps.currentKey(TEST_ORG, NAME, heads)).toBe(key);
    expect(first.dependencies.githubPullRequests.listTreeAtCommit).toHaveBeenCalledWith("https://github.com/acme/web.git", HEAD, expect.anything());
    // another lockfile, another key
    const changed = await withBase([{ ...LISTING[0]!, sha: "3".repeat(40) }, LISTING[1]!]);
    await changed.t.approveFirst();
    expect(await changed.deps.currentKey(TEST_ORG, NAME, heads)).not.toBe(key);
    // a listing that was cut, no heads, or no approved environment is no key
    const cut = await withBase(LISTING, true);
    await cut.t.approveFirst();
    expect(await cut.deps.currentKey(TEST_ORG, NAME, heads)).toBeUndefined();
    expect(await first.deps.currentKey(TEST_ORG, NAME, undefined)).toBeUndefined();
    const unapproved = await withBase();
    expect(await unapproved.deps.currentKey(TEST_ORG, NAME, heads)).toBeUndefined();
  });

  it("has no environment key without a base image digest from the install, or with one that is not a digest, and from a host that cannot list", async () => {
    const none = await bound({ githubPullRequests: github(LISTING) });
    await none.t.approveFirst();
    expect(await none.deps.currentKey(TEST_ORG, NAME, heads)).toBeUndefined();
    const bad = await bound({ githubPullRequests: github(LISTING), savedEnvBaseImageDigest: async () => "latest" });
    await bad.t.approveFirst();
    expect(await bad.deps.currentKey(TEST_ORG, NAME, heads)).toBeUndefined();
    const { listTreeAtCommit: _gone, ...withoutListing } = github(LISTING);
    void _gone;
    const unable = await bound({ githubPullRequests: withoutListing, savedEnvBaseImageDigest: async () => DIGEST });
    await unable.t.approveFirst();
    expect(await unable.deps.currentKey(TEST_ORG, NAME, heads)).toBeUndefined();
  });

  it("puts the approved environment's secret names and detector globs into the key, exactly as the key function takes them", async () => {
    const hooked = await bound({ githubPullRequests: github(LISTING), savedEnvBaseImageDigest: async () => DIGEST });
    await hooked.t.approveFirst();
    // the approved revision's record, with an account that reads a secret and detector globs of its own
    const [record] = hooked.t.db.find((item) => item.environment !== undefined && item.approvedAt !== undefined && typeof item.digest === "string");
    const edited = TestEnvironmentBodySchema.parse({
      ...(record!.environment as Record<string, unknown>),
      accounts: [{ profileId: "p1", provisioner: "http_hook", createUrl: "https://accounts.example.com/create", deleteUrl: "https://accounts.example.com/delete", tokenSecretName: "HOOK_TOKEN" }],
      selection: { method: "full", alwaysRun: [], fullSuiteOn: ["package.json", "extra/**"] },
    });
    hooked.t.db.set({ ...record!, environment: edited, digest: testEnvDigest(edited) });
    const key = await hooked.deps.currentKey(TEST_ORG, NAME, heads);
    const same = await expectedEnvironmentKey(
      { listTree: async () => ({ truncated: false, entries: LISTING }), readText: async () => undefined },
      { repositories: [{ name: "web", url: "https://github.com/acme/web.git" }], commits: heads, detectorGlobs: ["package.json", "extra/**"], testEnvRevision: 1, secretNames: ["HOOK_TOKEN"], baseImageDigest: DIGEST },
    );
    expect(key).toBe(same);
    const otherSecret = await expectedEnvironmentKey(
      { listTree: async () => ({ truncated: false, entries: LISTING }), readText: async () => undefined },
      { repositories: [{ name: "web", url: "https://github.com/acme/web.git" }], commits: heads, detectorGlobs: ["package.json", "extra/**"], testEnvRevision: 1, secretNames: [], baseImageDigest: DIGEST },
    );
    expect(key).not.toBe(otherSecret);
  });

  it("names the secrets an approved environment reads, and nothing else", () => {
    const account = (provisioner: string, extra: Record<string, unknown> = {}) => ({ profileId: "p", provisioner, ...extra });
    const environment = { accounts: [account("http_hook", { tokenSecretName: "HOOK_TOKEN" }), account("http_hook", { tokenSecretName: "HOOK_TOKEN" }), account("cognito_test_pool", { userPoolId: "x" })] } as never;
    expect(savedEnvSecretNames(environment)).toEqual(["HOOK_TOKEN"]);
  });

  it("writes through the DynamoDB store in the company's partition, and takes the defaults for the company settings", async () => {
    const { t, deps } = await bound();
    expect(await deps.keep(TEST_ORG)).toBe(3);
    expect(await deps.lightAfterIdleDays?.(TEST_ORG, NAME)).toBe(7);
    expect(await deps.store.commit({ orgId: TEST_ORG, projectId: NAME, version: 1, enabled: true, images: [], health: "never_proved" }, null, { action: "activity", orgId: TEST_ORG, projectId: NAME, at: new Date().toISOString() })).toBe(true);
    expect(t.db.get(orgPk(TEST_ORG), `SAVED_ENV#${NAME}`)).toMatchObject({ entityType: "SAVED_ENV", version: 1 });
    expect(deps.session.config).toEqual({ enabled: true, env: "staging", scope: { partition: "aws", region: "us-west-2", account: "111122223333" }, kmsKeyArn: KEY_ARN });
  });

  it("queues a job only when the key can be worked out, and starts it with the inputs the key was worked out from", async () => {
    const { checkRebuild } = await import("../../packages/broker/src/test-env/saved-env.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    // no base image from the install: nothing is queued
    const none = await bound({ githubPullRequests: github(LISTING) });
    await none.t.approveFirst();
    expect(await checkRebuild(none.deps, { orgId: TEST_ORG, projectId: NAME }, "poll")).toMatchObject({ ok: true, queued: false, why: "no_key" });
    // with it: queued, started as a pinned preparation carrying the key, and the key is the one the worker is told to expect
    const ready = await bound({ githubPullRequests: github(LISTING), savedEnvBaseImageDigest: async () => DIGEST });
    await ready.t.approveFirst();
    const queued = await checkRebuild(ready.deps, { orgId: TEST_ORG, projectId: NAME }, "poll");
    expect(queued).toMatchObject({ ok: true, queued: true });
    const operation = ready.t.db.find((item) => item.entityType === "OPERATION" && item.savedEnvJobId !== undefined)[0] as { id: string; workspaceId: string };
    const invocation = (ready.t.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operation.id)[0] as { invocation: { payload: { savedEnvBuild: Record<string, unknown>; pins: unknown } } }).invocation;
    const row = await ready.deps.store.get(TEST_ORG, NAME);
    expect(invocation.payload.savedEnvBuild).toMatchObject({ expectedKey: row?.job?.expectedKey, baseImageDigest: DIGEST, secretNames: [], detectorGlobs: [".github/**"] });
    expect(invocation.payload.pins).toEqual([{ repository: "web", commit: HEAD }]);
  });
});
