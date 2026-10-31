// Proof and test environment E1: the project's test environment as a stored setting (propose, record a Prove run, approve as a new revision), and the production deny list.
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema, projectMetaKey, projectPk, testEnvDigest, testEnvProdDenyViolations, type TestEnvironmentBody } from "@agentx/contracts";
import { TEST_ENV_FRESH_SIGN_IN_MS, TEST_ENV_PROPOSAL_TTL_MS, approveTestEnvironment, proposeTestEnvironment, readApprovedTestEnvironment, recordTestEnvProveReport, testEnvRequestId, type TestEnvDeps } from "../../packages/broker/src/org/test-environment.js";
import { capturingAuditDeps, AUDIT_CAPTURE_TABLE } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as const;
const PROJECT = "partner-service";
const sha = (letter: string) => letter.repeat(64);
const cmd = (executable: string, args: string[] = []) => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const sandbox = (over: Record<string, unknown> = {}): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "partner-service", setupCommands: [cmd("pip", ["install", "-e", "."])], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }] }],
  roundBudgetMin: 30,
  selection: { method: "full", alwaysRun: [], fullSuiteOn: ["poetry.lock"] },
  nightly: { enabled: true, cronUtc: "0 6 * * *", branch: "main" },
  services: [{ name: "partner-scorer", kind: "sagemaker_runtime", match: { endpointName: "partner-scorer" }, mode: "mock", mock: { fixtureSetRef: sha("a"), schemaRef: sha("b"), unmatched: "fail" } }],
  data: { seeds: [], generator: "faker_seeded", seed: 7 },
  accounts: [],
  prodDeny: { accountIds: ["111122223333"], hosts: ["*.prod.example.com"], arnPrefixes: ["arn:aws:sagemaker:us-east-1:111122223333:"] },
  capture: { screenshots: "failed", video: false, traces: false },
  ...over,
});
const withPreprod = (arn = "arn:aws:sagemaker:us-west-2:222233334444:endpoint/partner-scorer") => sandbox({
  services: [{ name: "partner-scorer", kind: "sagemaker_runtime", match: { endpointName: "partner-scorer" }, mode: "preprod", preprod: { endpointArn: arn, roleArn: "arn:aws:iam::222233334444:role/rovara-invoke", region: "us-west-2" } }],
});
/** A body that has NOT been through the schema: the schema itself now refuses a production target, and the store must still refuse one handed to it unparsed or with the deny list shortened in the same change. */
const unchecked = (arn: string, prodDeny: TestEnvironmentBody["prodDeny"]): unknown => {
  const base = withPreprod();
  return { ...base, prodDeny, services: [{ ...base.services[0], preprod: { ...base.services[0]!.preprod, endpointArn: arn } }] };
};
const proved = (digest: string, over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, proposalDigest: digest, steps: [{ step: "setup", status: "passed", durationMs: 5 }, { step: "boot", status: "passed", durationMs: 7 }, { step: "smoke", status: "passed", durationMs: 9 }], services: [{ name: "partner-scorer", modeUsed: "mocked" }], finishedAt: "2026-10-30T10:00:00.000Z", ...over,
});

function harness(startMs = Date.UTC(2026, 9, 30, 10, 0, 0)) {
  const db = new FakeDynamoDb();
  const audit = capturingAuditDeps({ db });
  db.set({ ...projectMetaKey(ORG, PROJECT), status: "active" });
  const clock = { now: startMs };
  const deps: TestEnvDeps = { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, audit: audit.audit };
  const proposeAndProve = async (body: TestEnvironmentBody, over: Record<string, unknown> = {}) => {
    const proposal = await proposeTestEnvironment(deps, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body });
    await recordTestEnvProveReport(deps, { orgId: ORG, project: PROJECT, report: proved(proposal.digest, over) });
    return proposal;
  };
  const approve = (digest: string, over: Partial<Parameters<typeof approveTestEnvironment>[1]> = {}) =>
    approveTestEnvironment(deps, { orgId: ORG, project: PROJECT, digest, expectedRevision: 0, requestId: `request-${digest.slice(0, 8)}`, approvedBy: "dev_a", role: "maintainer", ...over });
  return { db, audit, clock, deps, proposeAndProve, approve };
}

describe("the first approval", () => {
  it("stores revision 1, points to it, and audits the change with counts only", async () => {
    const h = harness();
    const proposal = await h.proposeAndProve(sandbox());
    expect(proposal.risk).toBe("medium");
    expect(proposal.lessSafe).toEqual([]);
    const result = await h.approve(proposal.digest);
    expect(result).toMatchObject({ revision: 1, digest: proposal.digest, lessSafe: [], replayed: false });
    const stored = await readApprovedTestEnvironment(h.deps, ORG, PROJECT);
    expect(stored?.revision).toBe(1);
    expect(testEnvDigest(stored!.environment)).toBe(proposal.digest);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = h.audit.recordedBy("project.test_env_changed");
    expect(events).toHaveLength(1);
    expect(events[0]?.facts).toEqual({ revision: 1, tier: "sandbox", lessSafeCount: 0 });
    expect(JSON.stringify(events[0])).not.toContain("pytest");
  });
  it("is replayable: the same request returns the same revision and writes nothing new", async () => {
    const h = harness();
    const { digest } = await h.proposeAndProve(sandbox());
    await h.approve(digest, { requestId: "request-one-1" });
    const again = await h.approve(digest, { requestId: "request-one-1" });
    expect(again).toMatchObject({ revision: 1, replayed: true });
    expect(h.db.find((item) => String(item.sk).startsWith("TESTENV#REV#"))).toHaveLength(1);
  });
  it("is not replayed for another request id: the same digest again is stale (the newest is already this)", async () => {
    const h = harness();
    const { digest } = await h.proposeAndProve(sandbox());
    await h.approve(digest, { requestId: "request-one-1" });
    await expect(h.approve(digest, { requestId: "request-two-2" })).rejects.toThrow(/someone changed/);
  });
});

describe("what an approval refuses", () => {
  it("a caller who cannot edit settings, for both propose and approve", async () => {
    const h = harness();
    await expect(proposeTestEnvironment(h.deps, { orgId: ORG, project: PROJECT, proposedBy: "dev_b", role: "viewer", body: sandbox() })).rejects.toThrow(/maintainer/);
    const { digest } = await h.proposeAndProve(sandbox());
    await expect(h.approve(digest, { role: "viewer" })).rejects.toThrow(/maintainer/);
    await expect(h.approve(digest, { role: undefined })).rejects.toThrow(/maintainer/);
    expect(await readApprovedTestEnvironment(h.deps, ORG, PROJECT)).toBeUndefined();
  });
  it("a body that does not parse, naming the field and never the value", async () => {
    const h = harness();
    const bad = { ...sandbox(), roundBudgetMin: 5 };
    const error = await proposeTestEnvironment(h.deps, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body: bad }).catch((caught: unknown) => (caught instanceof Error ? caught.message : "not an error"));
    expect(error).toContain("roundBudgetMin");
    expect(error).not.toContain("5");
  });
  it("an approval for a digest nobody proposed, an expired proposal, and one that was never proved", async () => {
    const h = harness();
    await expect(h.approve(sha("9"))).rejects.toThrow(/gone or has expired/);
    const proposal = await proposeTestEnvironment(h.deps, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body: sandbox() });
    await expect(h.approve(proposal.digest)).rejects.toThrow(/prove this environment/);
    h.clock.now += TEST_ENV_PROPOSAL_TTL_MS + 1000;
    await expect(h.approve(proposal.digest)).rejects.toThrow(/gone or has expired/);
  });
  it("a Prove run with a failed step, and a Prove report for some other digest", async () => {
    const h = harness();
    const failing = await h.proposeAndProve(sandbox(), { steps: [{ step: "setup", status: "passed", durationMs: 1 }, { step: "smoke", status: "failed", durationMs: 2, failure: "smoke_failed" }] });
    await expect(h.approve(failing.digest)).rejects.toThrow(/prove this environment/);
    const other = await proposeTestEnvironment(h.deps, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body: sandbox({ data: { seeds: [], generator: "faker_seeded", seed: 8 } }) });
    // A report that names another digest is stored only against that digest, so it never proves this one.
    await recordTestEnvProveReport(h.deps, { orgId: ORG, project: PROJECT, report: proved(failing.digest) });
    await expect(h.approve(other.digest)).rejects.toThrow(/prove this environment/);
  });
  it("a Prove report for a proposal that does not exist", async () => {
    const h = harness();
    await expect(recordTestEnvProveReport(h.deps, { orgId: ORG, project: PROJECT, report: proved(sha("e")) })).rejects.toThrow(/no such proposal/);
    await expect(recordTestEnvProveReport(h.deps, { orgId: ORG, project: PROJECT, report: { nonsense: true } })).rejects.toThrow(/could not be read/);
  });
  it("an archived project", async () => {
    const h = harness();
    const { digest } = await h.proposeAndProve(sandbox());
    h.db.set({ ...projectMetaKey(ORG, PROJECT), status: "archived" });
    await expect(h.approve(digest)).rejects.toThrow(/archived/);
    expect(await readApprovedTestEnvironment(h.deps, ORG, PROJECT)).toBeUndefined();
  });
  it("a revision the person was not looking at", async () => {
    const h = harness();
    const first = await h.proposeAndProve(sandbox());
    await h.approve(first.digest);
    const second = await h.proposeAndProve(sandbox({ data: { seeds: [], generator: "faker_seeded", seed: 9 } }));
    await expect(h.approve(second.digest, { expectedRevision: 0 })).rejects.toThrow(/someone changed/);
    expect((await h.approve(second.digest, { expectedRevision: 1 })).revision).toBe(2);
  });
});

describe("production is refused", () => {
  it("names a production resource: refused when proposed and again at approval, by field and fixed words only", async () => {
    const h = harness();
    const prodArn = "arn:aws:sagemaker:us-east-1:111122223333:endpoint/partner-scorer";
    const error = await proposeTestEnvironment(h.deps, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body: unchecked(prodArn, sandbox().prodDeny) }).catch((caught: unknown) => (caught instanceof Error ? caught.message : "not an error"));
    expect(error).toContain("production deny list");
    expect(error).not.toContain("111122223333");
    expect(() => withPreprod(prodArn)).toThrow(/production deny list/);
  });
  it("reaches a real service with no production list at all: list production first", async () => {
    const h = harness();
    const noList = withPreprod();
    const body = { ...noList, prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] } };
    await expect(proposeTestEnvironment(h.deps, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body })).rejects.toThrow(/list it first/);
    // A mock-only sandbox reaches nothing real, so it needs no list.
    await expect(proposeTestEnvironment(h.deps, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body: { ...sandbox(), prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] } } })).resolves.toBeDefined();
  });
  it("matches hosts and accounts the way a company writes them", () => {
    const shared = { ...sandbox(), tier: "shared", shared: { baseUrl: "https://api.PROD.example.com", leaseScope: "env", dataNamespace: "task_prefix" } } as TestEnvironmentBody;
    expect(testEnvProdDenyViolations(shared)).toEqual([{ kind: "prod_host", field: "shared.baseUrl" }]);
    const bare = TestEnvironmentBodySchema.parse({ ...sandbox(), tier: "shared", shared: { baseUrl: "https://prod.example.com", leaseScope: "env", dataNamespace: "task_prefix" } });
    // `*.prod.example.com` does not cover the bare domain: list both to cover both.
    expect(testEnvProdDenyViolations(bare)).toEqual([]);
    const roleInProdAccount = withPreprod("arn:aws:sagemaker:us-west-2:222233334444:endpoint/x");
    const asProd = { ...roleInProdAccount, services: [{ ...roleInProdAccount.services[0]!, preprod: { ...roleInProdAccount.services[0]!.preprod!, roleArn: "arn:aws:iam::111122223333:role/invoke" } }] } as TestEnvironmentBody;
    expect(testEnvProdDenyViolations(asProd)).toEqual([{ kind: "prod_account", field: "services[0].preprod.roleArn" }]);
    // Trailing dots in a host or a listed pattern do not hide production, and a Cognito pool the deny list names is production.
    const dotted = { ...bare, shared: { ...bare.shared!, baseUrl: "https://api.prod.example.com./x" } } as TestEnvironmentBody;
    expect(testEnvProdDenyViolations(dotted)).toEqual([{ kind: "prod_host", field: "shared.baseUrl" }]);
    const pool = { ...sandbox(), prodDeny: { accountIds: [], hosts: [], arnPrefixes: ["arn:aws:cognito-idp:us-east-1:111122223333:userpool/us-east-1_ProdPool1"] }, accounts: [{ profileId: "buyer", provisioner: "cognito_test_pool", userPoolId: "us-east-1_ProdPool1", region: "us-east-1", roleArn: "arn:aws:iam::222233334444:role/pool" }] } as TestEnvironmentBody;
    expect(testEnvProdDenyViolations(pool)).toEqual([{ kind: "prod_arn", field: "accounts[0].userPoolId" }]);
  });
});

describe("a less-safe change", () => {
  const preprodAsSecond = (h: ReturnType<typeof harness>, over: Partial<Parameters<typeof approveTestEnvironment>[1]> = {}) =>
    h.approve(over.digest ?? "", { approval: { mode: "second_person", approverId: "dev_b", signedInAtMs: h.clock.now - 60_000 }, ...over });
  it("needs a second person who signed in just now; the risk of the card is high", async () => {
    const h = harness();
    const proposal = await h.proposeAndProve(withPreprod());
    expect(proposal.risk).toBe("high");
    expect(proposal.lessSafe).toEqual(["preprod"]);
    await expect(h.approve(proposal.digest)).rejects.toThrow(/second person/);
    await expect(h.approve(proposal.digest, { approval: { mode: "second_person", approverId: "dev_a", signedInAtMs: h.clock.now } })).rejects.toThrow(/second person/);
    await expect(h.approve(proposal.digest, { approval: { mode: "second_person", approverId: "dev_b", signedInAtMs: h.clock.now - TEST_ENV_FRESH_SIGN_IN_MS - 1 } })).rejects.toThrow(/sign in again/);
    await expect(h.approve(proposal.digest, { approval: { mode: "second_person", approverId: "dev_b", signedInAtMs: h.clock.now + 5_000 } })).rejects.toThrow(/sign in again/);
    expect(await readApprovedTestEnvironment(h.deps, ORG, PROJECT)).toBeUndefined();
    const done = await preprodAsSecond(h, { digest: proposal.digest });
    expect(done.lessSafe).toEqual(["preprod"]);
    expect(h.audit.recordedBy("project.test_env_changed")[0]?.facts).toMatchObject({ lessSafeCount: 1, tier: "sandbox" });
  });
  it("a sole owner's exception is the same person signing in again, and a different person under that mode is refused", async () => {
    const h = harness();
    const { digest } = await h.proposeAndProve(withPreprod());
    await expect(h.approve(digest, { approval: { mode: "sole_owner_exception", approverId: "dev_b", signedInAtMs: h.clock.now } })).rejects.toThrow(/second person/);
    expect((await h.approve(digest, { approval: { mode: "sole_owner_exception", approverId: "dev_a", signedInAtMs: h.clock.now } })).revision).toBe(1);
  });
  it("a field already on and unchanged is not a change, but a raised round budget is", async () => {
    const h = harness();
    const first = await h.proposeAndProve(withPreprod());
    await preprodAsSecond(h, { digest: first.digest });
    const same = await h.proposeAndProve({ ...withPreprod(), data: { seeds: [], generator: "faker_seeded", seed: 2 } });
    expect(same.lessSafe).toEqual([]);
    expect((await h.approve(same.digest, { expectedRevision: 1 })).revision).toBe(2);
    const raised = await h.proposeAndProve({ ...withPreprod(), data: { seeds: [], generator: "faker_seeded", seed: 2 }, roundBudgetMin: 60 });
    expect(raised.lessSafe).toEqual(["round_budget_raised"]);
    await expect(h.approve(raised.digest, { expectedRevision: 2 })).rejects.toThrow(/second person/);
  });
});

describe("weakening changes (Opus review of the contracts)", () => {
  const second = (h: ReturnType<typeof harness>) => ({ approval: { mode: "second_person" as const, approverId: "dev_b", signedInAtMs: h.clock.now - 1000 } });
  it("moving a pre-prod target to another endpoint is a less-safe change even though pre-prod was already on", async () => {
    const h = harness();
    const first = await h.proposeAndProve(withPreprod());
    await h.approve(first.digest, second(h));
    const moved = await h.proposeAndProve(withPreprod("arn:aws:sagemaker:us-west-2:222233334444:endpoint/other-scorer"));
    expect(moved.lessSafe).toEqual(["preprod_target_changed"]);
    expect(moved.risk).toBe("high");
    await expect(h.approve(moved.digest, { expectedRevision: 1 })).rejects.toThrow(/second person/);
    expect((await h.approve(moved.digest, { expectedRevision: 1, ...second(h) })).lessSafe).toEqual(["preprod_target_changed"]);
  });
  it("moving the shared environment, or a test-account hook, needs a second person", async () => {
    const h = harness();
    const shared = (baseUrl: string) => sandbox({ tier: "shared", shared: { baseUrl, leaseScope: "env", dataNamespace: "task_prefix" } });
    const first = await h.proposeAndProve(shared("https://beta.example.com"));
    await h.approve(first.digest, second(h));
    const moved = await h.proposeAndProve(shared("https://beta2.example.com"));
    expect(moved.lessSafe).toContain("shared_target_changed");
    await expect(h.approve(moved.digest, { expectedRevision: 1 })).rejects.toThrow(/second person/);
    const hook = (createUrl: string) => sandbox({ accounts: [{ profileId: "buyer", provisioner: "http_hook", createUrl, deleteUrl: "https://tests.example.com/delete", tokenSecretName: "HOOK_TOKEN" }] });
    const h2 = harness();
    const a = await h2.proposeAndProve(hook("https://tests.example.com/create"));
    await h2.approve(a.digest, second(h2));
    const b = await h2.proposeAndProve(hook("https://tests.example.com/create2"));
    expect(b.lessSafe).toEqual(["account_target_changed"]);
  });
  it("removing an entry from the production list is a less-safe change", async () => {
    const h = harness();
    const first = await h.proposeAndProve(withPreprod());
    await h.approve(first.digest, second(h));
    const shorter = await h.proposeAndProve({ ...withPreprod(), prodDeny: { accountIds: ["111122223333"], hosts: [], arnPrefixes: ["arn:aws:sagemaker:us-east-1:111122223333:"] } });
    expect(shorter.lessSafe).toEqual(["prod_deny_reduced"]);
    await expect(h.approve(shorter.digest, { expectedRevision: 1 })).rejects.toThrow(/second person/);
  });
  it("pointing at production while removing it from the list in the same change is still refused", async () => {
    const h = harness();
    const first = await h.proposeAndProve(withPreprod());
    await h.approve(first.digest, second(h));
    // The schema alone would accept this (the shortened list no longer names the account); the approved list still does.
    const sneaky = unchecked("arn:aws:sagemaker:us-east-1:111122223333:endpoint/partner-scorer", { accountIds: [], hosts: ["x.example.com"], arnPrefixes: [] });
    await expect(proposeTestEnvironment(h.deps, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body: sneaky })).rejects.toThrow(/production/);
  });
  it("a Prove run with every step skipped proves nothing", async () => {
    const h = harness();
    const skipped = await h.proposeAndProve(sandbox(), { steps: [{ step: "setup", status: "skipped", durationMs: 0 }, { step: "smoke", status: "skipped", durationMs: 0 }] });
    expect((await recordTestEnvProveReport(h.deps, { orgId: ORG, project: PROJECT, report: proved(skipped.digest, { steps: [{ step: "setup", status: "skipped", durationMs: 0 }] }) })).proved).toBe(false);
    await expect(h.approve(skipped.digest)).rejects.toThrow(/prove this environment/);
  });
});

describe("reading", () => {
  it("a task can read the revision it started with, and a missing one is undefined", async () => {
    const h = harness();
    const first = await h.proposeAndProve(sandbox());
    await h.approve(first.digest);
    const second = await h.proposeAndProve(sandbox({ data: { seeds: [], generator: "faker_seeded", seed: 9 } }));
    await h.approve(second.digest, { expectedRevision: 1 });
    expect(testEnvDigest((await readApprovedTestEnvironment(h.deps, ORG, PROJECT, 1))!.environment)).toBe(first.digest);
    expect(testEnvDigest((await readApprovedTestEnvironment(h.deps, ORG, PROJECT))!.environment)).toBe(second.digest);
    expect(await readApprovedTestEnvironment(h.deps, ORG, PROJECT, 3)).toBeUndefined();
  });
  it("a damaged stored revision is an error, never 'no environment'", async () => {
    const h = harness();
    const { digest } = await h.proposeAndProve(sandbox());
    await h.approve(digest);
    const key = { pk: projectPk(ORG, PROJECT), sk: "TESTENV#REV#00000001" };
    const item = h.db.get(key)!;
    h.db.set({ ...item, environment: { ...(item.environment as object), roundBudgetMin: 90 } });
    await expect(readApprovedTestEnvironment(h.deps, ORG, PROJECT)).rejects.toThrow(/could not be read/);
    h.db.set({ ...item, environment: "garbage" });
    await expect(readApprovedTestEnvironment(h.deps, ORG, PROJECT)).rejects.toThrow(/could not be read/);
  });
  it("one project's environment is never another's", async () => {
    const h = harness();
    const { digest } = await h.proposeAndProve(sandbox());
    await h.approve(digest);
    expect(await readApprovedTestEnvironment(h.deps, ORG, "other-project")).toBeUndefined();
    expect(await readApprovedTestEnvironment(h.deps, "org_bbbbbbbbbbbbbbbbbbbb", PROJECT)).toBeUndefined();
  });
  it("a card's approve button gets a stable request id per digest, revision and person", () => {
    expect(testEnvRequestId(sha("a"), 1, "dev_a")).toBe(testEnvRequestId(sha("a"), 1, "dev_a"));
    expect(testEnvRequestId(sha("a"), 1, "dev_a")).not.toBe(testEnvRequestId(sha("a"), 2, "dev_a"));
    expect(testEnvRequestId(sha("a"), 1, "dev_a")).not.toBe(testEnvRequestId(sha("a"), 1, "dev_b"));
  });
});
