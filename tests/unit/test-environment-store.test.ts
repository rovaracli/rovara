// Proof and test environment E1: the project's test environment as a stored setting (propose, record a Prove run, approve as a new revision), and the production deny list.
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema, cronRunsPerWeek, developerOrgKey, hostOfUrl, orgMemberKey, orgMetaKey, projectMetaKey, projectPk, prodDenyMatchesArn, prodDenyMatchesHost, testEnvDigest, testEnvLessSafeChanges, testEnvProdDenyViolations, type TestEnvironmentBody } from "@agentx/contracts";
import { TEST_ENV_FRESH_SIGN_IN_MS, TEST_ENV_PROPOSAL_TTL_MS, approveTestEnvironment, proposeTestEnvironment, readApprovedTestEnvironment, recordTestEnvProveReport, secondPersonFromRecords, testEnvRequestId, type TestEnvDeps, type SecondPersonPort } from "../../packages/broker/src/org/test-environment.js";
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
  nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
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
  // The company's records, as the second-person check reads them: who is eligible, and whether the company has one owner only.
  const records = { eligible: new Set(["dev_a", "dev_b"]), soleOwner: false, asked: [] as Array<{ proposerId: string; approverId: string }> };
  const secondPerson: SecondPersonPort = (scope) => {
    records.asked.push({ proposerId: scope.proposerId, approverId: scope.approverId });
    if (!records.eligible.has(scope.approverId) || !records.eligible.has(scope.proposerId)) return Promise.reject(new Error("not eligible"));
    if (scope.approverId === scope.proposerId) return records.soleOwner ? Promise.resolve({ mode: "sole_owner_exception" as const, membershipVersion: 4, conditions: [] }) : Promise.reject(new Error("second person required"));
    return Promise.resolve({ mode: "second_person" as const, membershipVersion: 4, conditions: [] });
  };
  const deps: TestEnvDeps = { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, audit: audit.audit, secondPerson };
  const proposeAndProve = async (body: TestEnvironmentBody, over: Record<string, unknown> = {}) => {
    const proposal = await proposeTestEnvironment(deps, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body });
    await recordTestEnvProveReport(deps, { orgId: ORG, project: PROJECT, report: proved(proposal.digest, over) });
    return proposal;
  };
  const approve = (digest: string, over: Partial<Omit<Parameters<typeof approveTestEnvironment>[1], "approvedBySignedInAtMs">> & { approvedBySignedInAtMs?: number | undefined } = {}) =>
    approveTestEnvironment(deps, { orgId: ORG, project: PROJECT, digest, expectedRevision: 0, requestId: `request-${digest.slice(0, 8)}`, approvedBy: "dev_a", role: "maintainer", approvedBySignedInAtMs: clock.now - 30_000, ...over } as Parameters<typeof approveTestEnvironment>[1]);
  return { db, audit, clock, deps, records, proposeAndProve, approve };
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
  const preprodAsSecond = (h: ReturnType<typeof harness>, over: Partial<Omit<Parameters<typeof approveTestEnvironment>[1], "approvedBySignedInAtMs">> & { approvedBySignedInAtMs?: number | undefined } = {}) =>
    h.approve(over.digest ?? "", { approval: { approverId: "dev_b", signedInAtMs: h.clock.now - 60_000, sessionRef: sha("5") }, ...over });
  it("needs a second person who signed in just now; the risk of the card is high", async () => {
    const h = harness();
    const proposal = await h.proposeAndProve(withPreprod());
    expect(proposal.risk).toBe("high");
    expect(proposal.lessSafe).toEqual(["preprod"]);
    await expect(h.approve(proposal.digest)).rejects.toThrow(/second person/);
    await expect(h.approve(proposal.digest, { approval: { approverId: "dev_a", signedInAtMs: h.clock.now, sessionRef: sha("5") } })).rejects.toThrow(/second person/);
    await expect(h.approve(proposal.digest, { approval: { approverId: "dev_b", signedInAtMs: h.clock.now - TEST_ENV_FRESH_SIGN_IN_MS - 1, sessionRef: sha("5") } })).rejects.toThrow(/sign in again/);
    await expect(h.approve(proposal.digest, { approval: { approverId: "dev_b", signedInAtMs: h.clock.now + 5_000, sessionRef: sha("5") } })).rejects.toThrow(/sign in again/);
    expect(await readApprovedTestEnvironment(h.deps, ORG, PROJECT)).toBeUndefined();
    const done = await preprodAsSecond(h, { digest: proposal.digest });
    expect(done.lessSafe).toEqual(["preprod"]);
    expect(h.audit.recordedBy("project.test_env_changed")[0]?.facts).toMatchObject({ lessSafeCount: 1, tier: "sandbox" });
  });
  it("the sole-owner exception is allowed only when the company's RECORDS say there is one owner, whatever the caller claims", async () => {
    const h = harness();
    const { digest } = await h.proposeAndProve(withPreprod());
    const same = { approverId: "dev_a", signedInAtMs: h.clock.now - 1000, sessionRef: sha("5") };
    await expect(h.approve(digest, { approval: same })).rejects.toThrow(/second person/);
    h.records.soleOwner = true;
    const done = await h.approve(digest, { approval: same });
    expect(done.revision).toBe(1);
    expect(h.db.get({ pk: projectPk(ORG, PROJECT), sk: "TESTENV#REV#00000001" })?.secondApprover).toMatchObject({ id: "dev_a", mode: "sole_owner_exception", membershipVersion: 4 });
  });
  it("the second person's role is read from the records: someone who is not eligible is refused, and the caller's word is not asked", async () => {
    const h = harness();
    const { digest } = await h.proposeAndProve(withPreprod());
    await expect(h.approve(digest, { approval: { approverId: "dev_z", signedInAtMs: h.clock.now - 1000, sessionRef: sha("5") } })).rejects.toThrow(/second person/);
    expect(h.records.asked).toEqual([{ proposerId: "dev_a", approverId: "dev_z" }]);
    expect(await readApprovedTestEnvironment(h.deps, ORG, PROJECT)).toBeUndefined();
  });
  it("refuses a check whose mode contradicts the people named (a buggy port cannot make a person their own second)", async () => {
    const h = harness();
    const { digest } = await h.proposeAndProve(withPreprod());
    const approve = (secondPerson: SecondPersonPort, approverId: string) => approveTestEnvironment({ ...h.deps, secondPerson }, { orgId: ORG, project: PROJECT, digest, expectedRevision: 0, requestId: "request-mode-1", approvedBy: "dev_a", role: "maintainer", approvedBySignedInAtMs: h.clock.now, approval: { approverId, signedInAtMs: h.clock.now, sessionRef: sha("5") } });
    await expect(approve(() => Promise.resolve({ mode: "second_person", membershipVersion: 1, conditions: [] }), "dev_a")).rejects.toThrow(/second person/);
    await expect(approve(() => Promise.resolve({ mode: "sole_owner_exception", membershipVersion: 1, conditions: [] }), "dev_b")).rejects.toThrow(/second person/);
  });
  it("without the server-side check wired, a less-safe change is refused (fail closed)", async () => {
    const h = harness();
    const { digest } = await h.proposeAndProve(withPreprod());
    const bare: TestEnvDeps = { ...h.deps };
    delete bare.secondPerson;
    await expect(approveTestEnvironment(bare, { orgId: ORG, project: PROJECT, digest, expectedRevision: 0, requestId: "request-bare-1", approvedBy: "dev_a", role: "maintainer", approvedBySignedInAtMs: h.clock.now, approval: { approverId: "dev_b", signedInAtMs: h.clock.now, sessionRef: sha("5") } })).rejects.toThrow(/second person/);
  });
  it("records who the second person was on the revision and in the audit event, with their sign-in as the proof", async () => {
    const h = harness();
    const { digest } = await h.proposeAndProve(withPreprod());
    await preprodAsSecond(h, { digest });
    expect(h.db.get({ pk: projectPk(ORG, PROJECT), sk: "TESTENV#REV#00000001" })?.secondApprover).toEqual({ id: "dev_b", mode: "second_person", signedInAt: new Date(h.clock.now - 60_000).toISOString(), membershipVersion: 4 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const event = h.audit.recordedBy("project.test_env_changed")[0]!;
    expect(event.actor).toEqual({ kind: "member", id: "dev_a" });
    expect(event.related).toEqual(["dev_b"]);
    expect(event.proof).toEqual({ kind: "fresh_sign_in", method: "email_code", authTime: new Date(h.clock.now - 60_000).toISOString(), sessionRef: sha("5") });
  });
  it("needs the person pressing approve to have signed in just now too, on any high-risk card", async () => {
    const h = harness();
    const { digest } = await h.proposeAndProve(withPreprod());
    const second = { approverId: "dev_b", signedInAtMs: h.clock.now - 1000, sessionRef: sha("5") };
    await expect(h.approve(digest, { approval: second, approvedBySignedInAtMs: undefined })).rejects.toThrow(/sign in again/);
    await expect(h.approve(digest, { approval: second, approvedBySignedInAtMs: h.clock.now - TEST_ENV_FRESH_SIGN_IN_MS - 1 })).rejects.toThrow(/sign in again/);
    expect((await h.approve(digest, { approval: second })).revision).toBe(1);
  });
  it("a malformed session reference is refused", async () => {
    const h = harness();
    const { digest } = await h.proposeAndProve(withPreprod());
    await expect(h.approve(digest, { approval: { approverId: "dev_b", signedInAtMs: h.clock.now - 1000, sessionRef: "nope" } })).rejects.toThrow(/second person/);
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
  const second = (h: ReturnType<typeof harness>) => ({ approval: { approverId: "dev_b", signedInAtMs: h.clock.now - 1000, sessionRef: sha("5") } });
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

describe("spending changes are less-safe (review I5)", () => {
  const second = (h: ReturnType<typeof harness>) => ({ approval: { approverId: "dev_b", signedInAtMs: h.clock.now - 1000, sessionRef: sha("5") } });
  const nightly = (over: Partial<TestEnvironmentBody["nightly"]>) => sandbox({ nightly: { enabled: true, cronUtc: "0 6 * * *", branch: "main", ...over } });
  it("turning the nightly run on is a change that needs a second person, on a first proposal and later", async () => {
    const h = harness();
    const first = await h.proposeAndProve(nightly({}));
    expect(first.lessSafe).toEqual(["nightly_enabled"]);
    await expect(h.approve(first.digest)).rejects.toThrow(/second person/);
    await h.approve(first.digest, second(h));
    const h2 = harness();
    const off = await h2.proposeAndProve(sandbox());
    await h2.approve(off.digest);
    const on = await h2.proposeAndProve(nightly({}));
    expect(on.lessSafe).toEqual(["nightly_enabled"]);
  });
  it("running it more often is a change; the same or less often is not", async () => {
    const h = harness();
    const first = await h.proposeAndProve(nightly({}));
    await h.approve(first.digest, second(h));
    const more = await h.proposeAndProve(nightly({ cronUtc: "0 */6 * * *" }));
    expect(more.lessSafe).toEqual(["nightly_more_often"]);
    const weekly = await h.proposeAndProve(nightly({ cronUtc: "0 6 * * 1" }));
    expect(weekly.lessSafe).toEqual([]);
    const sameLater = await h.proposeAndProve(nightly({ cronUtc: "30 2 * * *" }));
    expect(sameLater.lessSafe).toEqual([]);
    expect(cronRunsPerWeek("0 6 * * *")).toBe(7);
    expect(cronRunsPerWeek("* * * * *")).toBe(7 * 24 * 60);
    expect(cronRunsPerWeek("0 6 * * 1-5")).toBe(5);
    expect(cronRunsPerWeek("not a cron")).toBe(Number.POSITIVE_INFINITY);
    expect(cronRunsPerWeek("0 6 * * 9")).toBe(Number.POSITIVE_INFINITY);
  });
  it("raising a preview's cost cap or life is a change", () => {
    const preview = (over: Record<string, unknown>) => sandbox({ tier: "preview", preview: { provider: "cdk", stackTemplate: "infra/app.ts", deployRoleArn: "arn:aws:iam::222233334444:role/rovara-preview", ttlHours: 12, costCapUsdPerDay: 50, fallbackTier: "sandbox", ...over } });
    expect(testEnvLessSafeChanges(preview({}), preview({ costCapUsdPerDay: 80 }))).toEqual(["preview_cost_raised"]);
    expect(testEnvLessSafeChanges(preview({}), preview({ ttlHours: 24 }))).toEqual(["preview_cost_raised"]);
    expect(testEnvLessSafeChanges(preview({}), preview({ ttlHours: 6, costCapUsdPerDay: 10 }))).toEqual([]);
  });
});

describe("one deny-list matcher everywhere (review I3)", () => {
  const deny = (over: Partial<TestEnvironmentBody["prodDeny"]>) => ({ accountIds: [], hosts: [], arnPrefixes: [], ...over });
  it("wildcards in ARN entries really match, case-insensitively", () => {
    const prefixes = ["arn:aws:iam::*:role/prod-", "arn:aws:sagemaker:*:222233334444:endpoint/*"];
    expect(prodDenyMatchesArn(deny({ arnPrefixes: prefixes }), "arn:aws:iam::999988887777:role/prod-deploy")).toBe("prod_arn");
    expect(prodDenyMatchesArn(deny({ arnPrefixes: prefixes }), "ARN:AWS:IAM::999988887777:ROLE/PROD-deploy")).toBe("prod_arn");
    expect(prodDenyMatchesArn(deny({ arnPrefixes: prefixes }), "arn:aws:sagemaker:eu-west-1:222233334444:endpoint/x")).toBe("prod_arn");
    expect(prodDenyMatchesArn(deny({ arnPrefixes: prefixes }), "arn:aws:iam::999988887777:role/test-deploy")).toBeUndefined();
  });
  it("a wildcard-ARN production target is refused by the schema, the store and the verifier's data guard path alike", async () => {
    const wild = { ...sandbox().prodDeny, arnPrefixes: ["arn:aws:sagemaker:*:222233334444:endpoint/*"] };
    expect(() => TestEnvironmentBodySchema.parse({ ...withPreprod(), prodDeny: wild })).toThrow(/production deny list/);
    const h = harness();
    await expect(proposeTestEnvironment(h.deps, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body: { ...withPreprod(), prodDeny: wild } })).rejects.toThrow(/production/);
  });
  it("userinfo, a port, a trailing dot and upper case do not hide a host, in the schema and in the helper", () => {
    const hosts = deny({ hosts: ["*.prod.example.com", "billing.corp.net."] });
    for (const url of ["https://user@api.prod.example.com./x", "https://API.PROD.example.com:8443/x", "https://billing.corp.net/x", "https://u:p@billing.corp.net.:443/"]) {
      expect(prodDenyMatchesHost(hosts, hostOfUrl(url) ?? "")).toBe(true);
      expect(() => TestEnvironmentBodySchema.parse({ ...sandbox({ prodDeny: { ...sandbox().prodDeny, hosts: hosts.hosts } }), tier: "shared", shared: { baseUrl: url, leaseScope: "env", dataNamespace: "task_prefix" } }), url).toThrow(/production deny list/);
    }
    expect(prodDenyMatchesHost(hosts, "prod.example.com")).toBe(false);
    expect(prodDenyMatchesHost(hosts, "")).toBe(true);
    expect(prodDenyMatchesHost(hosts, "bad host")).toBe(true);
  });
  it("a Cognito pool is production when the list names its region or account", () => {
    const pool = (prodDeny: TestEnvironmentBody["prodDeny"]) => ({ ...sandbox({ prodDeny }), accounts: [{ profileId: "buyer", provisioner: "cognito_test_pool", userPoolId: "us-east-1_Abc123", region: "us-east-1", roleArn: "arn:aws:iam::222233334444:role/pool" }] });
    for (const arnPrefixes of [["arn:aws:cognito-idp:us-east-1:111122223333:"], ["arn:aws:cognito-idp:*:*:userpool/"], ["arn:aws:cognito-idp:us-east-1:*:userpool/us-east-1_Abc"]]) {
      expect(() => TestEnvironmentBodySchema.parse(pool(deny({ accountIds: ["111122223333"], arnPrefixes }))), arnPrefixes[0]).toThrow(/production deny list/);
    }
    expect(() => TestEnvironmentBodySchema.parse(pool(deny({ accountIds: ["111122223333"], arnPrefixes: ["arn:aws:cognito-idp:eu-west-1:111122223333:"] })))).not.toThrow();
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

describe("the real second-person check over the company's records (review I4)", () => {
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  const C = "c".repeat(64);
  function seeded(roles: Record<string, "owner" | "admin" | "member">, meta: Record<string, unknown> = { approvalMembershipVersion: 3 }) {
    const h = harness();
    h.db.set({ ...orgMetaKey(ORG), ...meta });
    for (const [id, role] of Object.entries(roles)) {
      h.db.set({ ...orgMemberKey(ORG, id), orgId: ORG, developerId: id, role });
      h.db.set({ ...developerOrgKey(id), orgId: ORG, role });
      h.db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id });
    }
    const deps: TestEnvDeps = { ...h.deps, secondPerson: secondPersonFromRecords({ documentClient: h.db, tableName: AUDIT_CAPTURE_TABLE, signInTableName: "signin", now: () => h.clock.now }) };
    const approve = async (digest: string, approverId: string, approvedBy = A) => approveTestEnvironment(deps, { orgId: ORG, project: PROJECT, digest, expectedRevision: 0, requestId: "request-real-1", approvedBy, role: "maintainer", approvedBySignedInAtMs: h.clock.now, approval: { approverId, signedInAtMs: h.clock.now - 1000, sessionRef: sha("5") } });
    return { h, deps, approve };
  }
  it("two live owners approve; the transaction carries the company's membership version and both people's records", async () => {
    const { h, approve } = seeded({ [A]: "owner", [B]: "owner" });
    const { digest } = await h.proposeAndProve(withPreprod());
    const done = await approve(digest, B);
    expect(done.revision).toBe(1);
    expect(h.db.get({ pk: projectPk(ORG, PROJECT), sk: "TESTENV#REV#00000001" })?.secondApprover).toMatchObject({ id: B, mode: "second_person", membershipVersion: 3 });
    const transaction = h.db.transactions().at(-1)!;
    expect(transaction.some((entry) => JSON.stringify(entry).includes("approvalMembershipVersion"))).toBe(true);
  });
  it("someone who is not in the company, or is only a member with no project grant, is refused", async () => {
    const outsider = seeded({ [A]: "owner", [B]: "owner" });
    const { digest } = await outsider.h.proposeAndProve(withPreprod());
    await expect(outsider.approve(digest, C)).rejects.toThrow(/second person/);
    const plain = seeded({ [A]: "owner", [C]: "member" });
    const second = await plain.h.proposeAndProve(withPreprod());
    await expect(plain.approve(second.digest, C)).rejects.toThrow(/second person/);
    expect(await readApprovedTestEnvironment(plain.deps, ORG, PROJECT)).toBeUndefined();
  });
  it("the same person is refused when the company has a second eligible owner", async () => {
    const { h, approve } = seeded({ [A]: "owner", [B]: "owner" });
    const { digest } = await h.proposeAndProve(withPreprod());
    await expect(approve(digest, A)).rejects.toThrow(/second person/);
  });
});
