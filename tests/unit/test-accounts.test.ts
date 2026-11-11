// Test services TS26: the lifecycle of a customer test account, against the real Secrets Manager role policy (the fake evaluates it), an in-memory store and the real second-person rule.
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { describe, expect, it } from "vitest";
import { isTestAccountUsableAt, testAccountApprovalDigest, testAccountSecretName, type TestAccount } from "@rovara-code/contracts";
import {
  TEST_ACCOUNTS_MAX_PER_ORG, addTestAccount, approveTestAccount, deleteTestAccount, expireDueAccounts, mintRoundGrants, reenableTestAccount, recordTestAccountUse, remindersDue, resolveAccountsForRound,
  rotateTestAccountSecret, suspendTestAccount, updateTestAccount, type RoundInput, type StoredTestAccount,
} from "../../packages/broker/src/test-env/test-accounts.js";
import { TestAccountSecrets } from "../../packages/broker/src/test-env/test-account-secrets.js";
import { ADMIN_A, ADMIN_B, ADMIN_C, ARN_PREFIX, ORG, OTHER_ORG, ROLE_ARN, T0, apiDraft, awsDraft, harness, person, stripeLive, stripeTest, type Harness } from "../support/test-account-fixtures.js";

const DAY = 86_400_000;
const rejects = async (call: Promise<unknown>): Promise<{ code?: string; message: string; extra: Record<string, unknown> }> => {
  try { await call; } catch (error) { const e = error as { code?: string; message: string }; return { ...(e.code === undefined ? {} : { code: e.code }), message: e.message.replace(/^[A-Z_]+: /u, ""), extra: error as Record<string, unknown> }; }
  throw new Error("expected a refusal");
};

async function added(h: Harness, over: { developer?: string; draft?: Record<string, unknown>; value?: string } = {}): Promise<StoredTestAccount> {
  const draft = (over.draft ?? apiDraft()) as { kind: string };
  return addTestAccount(h.deps, h.caller(over.developer ?? ADMIN_A), { draft: draft as never, ...(draft.kind === "aws_role" ? {} : { secretValue: over.value ?? stripeTest() }) });
}
async function active(h: Harness, over: { draft?: Record<string, unknown>; value?: string } = {}): Promise<StoredTestAccount> {
  const pending = await added(h, over);
  return approveTestAccount(h.deps, h.caller(ADMIN_B), { id: pending.account.id, expectedVersion: pending.version, expectedDigest: testAccountApprovalDigest(pending.account) });
}
const digest = (stored: StoredTestAccount): string => testAccountApprovalDigest(stored.account);

describe("while the ta switch is off", () => {
  it("answers like an unknown path before it touches the store, the secrets or a session", async () => {
    const h = harness({ enabled: false });
    const caller = h.caller(ADMIN_A);
    const calls: Array<() => Promise<unknown>> = [
      () => addTestAccount(h.deps, caller, { draft: apiDraft(), secretValue: stripeTest() }),
      () => approveTestAccount(h.deps, caller, { id: "ta-x", expectedVersion: 1, expectedDigest: "0".repeat(64) }),
      () => updateTestAccount(h.deps, caller, { id: "ta-x", expectedVersion: 1, changes: { label: "x" } }),
      () => rotateTestAccountSecret(h.deps, caller, { id: "ta-x", expectedVersion: 1, secretValue: stripeTest() }),
      () => suspendTestAccount(h.deps, caller, { id: "ta-x", expectedVersion: 1 }),
      () => reenableTestAccount(h.deps, caller, { id: "ta-x", expectedVersion: 1 }),
      () => deleteTestAccount(h.deps, caller, { id: "ta-x", expectedVersion: 1 }),
      () => expireDueAccounts(h.deps, ORG),
      () => resolveAccountsForRound(h.deps, { orgId: ORG, projectId: "orders", place: "sealed_round", accountIds: ["ta-x"] }),
      () => mintRoundGrants(h.deps, { orgId: ORG, projectId: "orders", place: "sealed_round", accountIds: ["ta-x"] }),
      () => recordTestAccountUse(h.deps, { orgId: ORG, accountId: "ta-x", projectId: "orders", rounds: 1, connections: 1, bytes: 0 }),
      // The secrets class has its own gate: nothing is minted, written or scheduled while `ta` is off, even when called directly.
      () => h.secretsClass.put(ORG, "ta-x", "value", "x"),
      () => h.secretsClass.putPending(ORG, "ta-x", "value", "x"),
      () => h.secretsClass.promote(ORG, "ta-x", "v"),
      () => h.secretsClass.currentVersionId(ORG, "ta-x"),
      () => h.secretsClass.discardPending(ORG, "ta-x", "v"),
      () => h.secretsClass.scheduleDelete(ORG, "ta-x"),
      () => h.secretsClass.mintResolveGrant(ORG, "ta-x"),
    ];
    for (const call of calls) {
      const refusal = await rejects(call());
      expect(refusal.code).toBe("NOT_FOUND");
      expect(refusal.message).toBe("Not found");
    }
    expect(h.calls).toEqual([]);
    expect(h.secrets.calls).toEqual([]);
    expect(h.store.rows.size).toBe(0);
  });
});

describe("adding an account", () => {
  it("stores a pending record that holds a reference, counts the adder's fresh-sign-in approval of the exact record, and audits it without the label or the hosts in a fact", async () => {
    const h = harness();
    const value = stripeTest();
    const stored = await added(h, { value });
    expect(stored.account.status).toBe("pending");
    expect(stored.account.secretRef).toBe(`{{resolve:secretsmanager:${testAccountSecretName("staging", ORG, stored.account.id)}:SecretString:value}}`);
    expect(stored.account.approvals).toEqual([{ by: ADMIN_A, at: new Date(T0).toISOString(), freshSignIn: true, kind: "approver", approvedDigest: digest(stored) }]);
    expect(stored.account.expiresAt).toBeUndefined();
    expect(stored.proposedBy).toBe(ADMIN_A);
    expect(JSON.stringify([...h.store.rows.values()])).not.toContain(value);
    const [event] = h.store.audits;
    expect(event).toMatchObject({ action: "test_account.added", orgId: ORG, target: { kind: "test_account", id: stored.account.id }, actor: { kind: "member", id: ADMIN_A }, proof: { kind: "fresh_sign_in" } });
    expect(event!.facts).toEqual({ kind: "api_key", digest: digest(stored), hostCount: 1, projectScope: "list" });
    expect(JSON.stringify(event!.facts)).not.toContain("Payments");
    expect(JSON.stringify(event)).not.toContain(value);
    expect(event!.details).toEqual([{ subject: "org", fields: { label: "Payments test mode", family: "http:api.stripe.com" } }]);
  });

  it("writes the value once, as a tagged org secret, through a store session that can never read it", async () => {
    const h = harness();
    const value = stripeTest();
    const stored = await added(h, { value });
    const name = testAccountSecretName("staging", ORG, stored.account.id);
    expect(h.secrets.stored(name)?.tags).toEqual({ "rovara:org": ORG, "rovara:use": "test-account" });
    expect(JSON.parse(h.secrets.stored(name)!.value)).toEqual({ value });
    expect(h.secrets.calls.filter((call) => call.service === "secretsmanager").map((call) => call.action)).toEqual(["CreateSecret"]);
    expect(h.secrets.calls.some((call) => call.action === "GetSecretValue")).toBe(false);
    // The role refuses a read by that session whatever the code does.
    const store = await h.secrets.client(ORG, { "rovara:org": ORG, "rovara:purpose": "store" });
    await expect(store.send(new GetSecretValueCommand({ SecretId: name }))).rejects.toMatchObject({ name: "AccessDeniedException" });
  });

  it("derives an AWS role account's hosts from the services it approves, and stores no secret", async () => {
    const h = harness();
    const stored = await addTestAccount(h.deps, h.caller(ADMIN_A), { draft: awsDraft() });
    expect(stored.account.hosts).toEqual(["dynamodb.us-west-2.amazonaws.com"]);
    expect(stored.account.secretRef).toBeUndefined();
    expect(h.secrets.secrets.size).toBe(0);
  });

  it("refuses without a fresh sign-in, without a live admin, and for a session that is another person's or revoked", async () => {
    const h = harness();
    const caller = h.caller(ADMIN_A);
    h.clock.now += 11 * 60_000;
    const stale = await rejects(addTestAccount(h.deps, caller, { draft: apiDraft(), secretValue: stripeTest() }));
    expect(stale.code).toBe("REAUTH_REQUIRED");
    const fresh = harness();
    h.admins.delete(ADMIN_A);
    expect((await rejects(addTestAccount(h.deps, h.caller(ADMIN_A), { draft: apiDraft(), secretValue: stripeTest() }))).code).toBe("FORBIDDEN");
    fresh.sessions.set("session-other", { developerId: ADMIN_B, authTime: new Date(T0).toISOString() });
    expect((await rejects(addTestAccount(fresh.deps, { ...fresh.caller(ADMIN_A), sessionId: "session-other" }, { draft: apiDraft(), secretValue: stripeTest() }))).code).toBe("REAUTH_REQUIRED");
    const revoked = harness();
    const c = revoked.caller(ADMIN_A);
    revoked.sessions.set(c.sessionId, { developerId: ADMIN_A, authTime: new Date(T0).toISOString(), revokedAt: new Date(T0).toISOString() });
    expect((await rejects(addTestAccount(revoked.deps, c, { draft: apiDraft(), secretValue: stripeTest() }))).code).toBe("REAUTH_REQUIRED");
    const noTime = harness();
    const n = noTime.caller(ADMIN_A);
    noTime.sessions.set(n.sessionId, { developerId: ADMIN_A });
    expect((await rejects(addTestAccount(noTime.deps, n, { draft: apiDraft(), secretValue: stripeTest() }))).code).toBe("REAUTH_REQUIRED");
    expect(h.store.rows.size + fresh.store.rows.size + revoked.store.rows.size + noTime.store.rows.size).toBe(0);
  });

  it("refuses a value that looks live or production, naming only a fixed reason, and writes nothing", async () => {
    const h = harness();
    const value = stripeLive();
    const refusal = await rejects(addTestAccount(h.deps, h.caller(ADMIN_A), { draft: apiDraft(), secretValue: value }));
    expect(refusal.code).toBe("CONFIG_INVALID");
    expect(refusal.extra.reason).toBe("live_shaped");
    expect(refusal.message).not.toContain(value);
    expect(JSON.stringify(refusal.extra)).not.toContain(value);
    expect(h.secrets.secrets.size).toBe(0);
    expect(h.store.rows.size).toBe(0);
    for (const bad of ["", "has\nnewline", ["-----BEGIN", "PRIVATE KEY-----"].join(" ")]) expect((await rejects(addTestAccount(h.deps, h.caller(ADMIN_A), { draft: apiDraft(), secretValue: bad }))).code).toBe("CONFIG_INVALID");
  });

  it("refuses a host on the production deny list, a prod-shaped host, an empty deny list and Rovara's own AWS account, naming fields and kinds only", async () => {
    const h = harness();
    const attempt = (draft: unknown, value?: string) => rejects(addTestAccount(h.deps, h.caller(ADMIN_A), { draft: draft as never, ...(value === undefined ? {} : { secretValue: value }) }));
    const prodHost = await attempt(apiDraft({ family: "http:billing.prod.example.com", hosts: ["billing.prod.example.com"] }), "plain-token-value-123");
    expect(prodHost.code).toBe("CONFIG_INVALID");
    expect(prodHost.extra.problems).toEqual([{ kind: "prod_host", field: "hosts[0]" }, { kind: "prod_shaped_host", field: "hosts[0]" }]);
    const sandbox = await attempt(apiDraft({ family: "http:login.salesforce.com", hosts: ["login.salesforce.com"] }), "plain-token-value-123");
    expect((sandbox.extra.problems as Array<{ kind: string }>).map((p) => p.kind)).toEqual(["vendor_production_host"]);
    const own = await attempt(awsDraft({ aws: { ...awsDraft().aws, roleArn: "arn:aws:iam::888800008888:role/x", resources: ["arn:aws:dynamodb:us-west-2:888800008888:table/t"] } }));
    expect((own.extra.problems as Array<{ kind: string }>).map((p) => p.kind)).toContain("rovara_account");
    const listed = await attempt(awsDraft({ aws: { ...awsDraft().aws, roleArn: "arn:aws:iam::999900009999:role/x", resources: ["arn:aws:dynamodb:us-west-2:999900009999:table/t"] } }));
    expect((listed.extra.problems as Array<{ kind: string }>).map((p) => p.kind)).toContain("prod_account");
    h.state.deny = { accountIds: [], hosts: [], arnPrefixes: [] };
    expect(((await attempt(apiDraft(), stripeTest())).extra.problems as Array<{ kind: string }>)[0]!.kind).toBe("prod_deny_missing");
    expect(h.store.rows.size).toBe(0);
    expect(h.secrets.secrets.size).toBe(0);
  });

  it("names the fields of an invalid record, never the values", async () => {
    const h = harness();
    const bad = await rejects(addTestAccount(h.deps, h.caller(ADMIN_A), { draft: apiDraft({ hosts: ["*.example.com"], envNames: ["PATH"] }), secretValue: stripeTest() }));
    expect(bad.code).toBe("CONFIG_INVALID");
    expect(bad.extra.fields).toEqual(expect.arrayContaining(["hosts.0", "envNames.0"]));
    expect(bad.message).not.toContain("*.example.com");
    expect((await rejects(addTestAccount(h.deps, h.caller(ADMIN_A), { draft: apiDraft() }))).extra.fields).toEqual(["secretValue"]);
    expect((await rejects(addTestAccount(h.deps, h.caller(ADMIN_A), { draft: awsDraft(), secretValue: "x" }))).extra.fields).toEqual(["secretValue"]);
    expect((await rejects(addTestAccount(h.deps, h.caller(ADMIN_A), { draft: awsDraft({ aws: undefined }) }))).extra.fields).toEqual(["aws"]);
  });

  it("takes the secret back when the row cannot be written, and does not keep it in the error", async () => {
    const h = harness();
    h.store.failNextCommit = true;
    const value = stripeTest();
    const refusal = await rejects(addTestAccount(h.deps, h.caller(ADMIN_A), { draft: apiDraft(), secretValue: value }));
    expect(refusal.code).toBe("CHANGE_STALE");
    expect(refusal.message).not.toContain(value);
    expect(h.store.rows.size).toBe(0);
    expect(h.secrets.calls.map((call) => call.action)).toContain("DeleteSecret");
    expect([...h.secrets.secrets.values()].every((secret) => secret.deleteAt !== undefined)).toBe(true);
  });

  it("holds at most the company's cap", async () => {
    const h = harness();
    for (let i = 0; i < TEST_ACCOUNTS_MAX_PER_ORG; i += 1) h.store.rows.set(`${ORG}#ta-${i}`, { account: { id: `ta-${i}`, orgId: ORG } as TestAccount, version: 1, proposedBy: ADMIN_A, proposedAt: "" });
    expect((await rejects(added(h))).code).toBe("CONFIG_INVALID");
    expect(h.secrets.secrets.size).toBe(0);
  });
});

describe("approving an account (Q7)", () => {
  it("activates it with a different admin's fresh approval, two distinct people, and an expiry 90 days out, and the usable check agrees", async () => {
    const h = harness();
    const pending = await added(h);
    const result = await approveTestAccount(h.deps, h.caller(ADMIN_B), { id: pending.account.id, expectedVersion: 1, expectedDigest: digest(pending) });
    expect(result.account.status).toBe("active");
    expect(result.account.approvals.map((a) => [a.by, a.kind])).toEqual([[ADMIN_A, "approver"], [ADMIN_B, "approver"]]);
    expect(result.account.expiresAt).toBe(new Date(T0 + 90 * DAY).toISOString());
    expect(isTestAccountUsableAt(result.account, T0 + DAY)).toBe(true);
    expect(isTestAccountUsableAt(result.account, T0 + 90 * DAY)).toBe(false);
    expect(h.store.audits.at(-1)).toMatchObject({ action: "test_account.approved", facts: { digest: digest(result), approvalMode: "second_person", approvals: 2, expiresInDays: 90 } });
    // The second-person evidence fences the commit.
    expect(h.store.conditions.at(-1)).toHaveLength(2);
  });

  it("uses the company's shorter expiry, never a longer one", async () => {
    const h = harness();
    h.state.maxDays = 30;
    const result = await active(h);
    expect(result.account.expiresAt).toBe(new Date(T0 + 30 * DAY).toISOString());
    h.state.maxDays = 120;
    const second = await rejects(active(h));
    expect(second.message).toBeDefined();
  });

  it("does not let the person who made the change approve it, except through the sole-owner exception", async () => {
    const h = harness();
    const pending = await added(h);
    const own = () => approveTestAccount(h.deps, h.caller(ADMIN_A), { id: pending.account.id, expectedVersion: 1, expectedDigest: digest(pending) });
    // Three eligible people: the exception does not apply.
    expect((await rejects(own())).code).toBe("FORBIDDEN");
    // The only eligible person, with nobody lost in 24 hours: allowed, and recorded as the exception.
    h.eligible.ids = [ADMIN_A];
    const done = await own();
    expect(done.account.status).toBe("active");
    expect(done.account.approvals.map((a) => a.kind)).toEqual(["approver", "sole_owner_exception"]);
    expect(h.store.audits.at(-1)!.facts).toMatchObject({ approvalMode: "sole_owner_exception" });
  });

  it("refuses the sole-owner exception when the company turned it off, and during the 24-hour cool-off", async () => {
    const h = harness();
    h.eligible.ids = [ADMIN_A];
    const pending = await added(h);
    h.state.soleOwnerAllowed = false;
    const off = await rejects(approveTestAccount(h.deps, h.caller(ADMIN_A), { id: pending.account.id, expectedVersion: 1, expectedDigest: digest(pending) }));
    expect(off.code).toBe("FORBIDDEN");
    expect((off.extra.soleOwner as { available: boolean }).available).toBe(false);
    h.state.soleOwnerAllowed = true;
    h.eligible.lastLossAt = T0 - 3_600_000;
    const cool = await rejects(approveTestAccount(h.deps, h.caller(ADMIN_A), { id: pending.account.id, expectedVersion: 1, expectedDigest: digest(pending) }));
    expect((cool.extra.soleOwner as { reasonCode: string }).reasonCode).toBe("SOLE_OWNER_COOL_OFF");
    expect(h.store.rows.get(`${ORG}#${pending.account.id}`)!.account.status).toBe("pending");
  });

  it("refuses an approver who is not eligible, without a fresh sign-in, or not an admin", async () => {
    const h = harness();
    const pending = await added(h);
    const approve = (who: string) => approveTestAccount(h.deps, h.caller(who), { id: pending.account.id, expectedVersion: 1, expectedDigest: digest(pending) });
    h.eligible.ids = [ADMIN_A, ADMIN_C];
    expect((await rejects(approve(ADMIN_B))).code).toBe("FORBIDDEN");
    h.admins.delete(ADMIN_C);
    expect((await rejects(approve(ADMIN_C))).code).toBe("FORBIDDEN");
    const stale = h.caller(person("d"));
    h.admins.add(person("d"));
    h.eligible.ids = [ADMIN_A, person("d")];
    h.sessions.set(stale.sessionId, { developerId: person("d"), authTime: new Date(T0 - 11 * 60_000).toISOString() });
    expect((await rejects(approveTestAccount(h.deps, stale, { id: pending.account.id, expectedVersion: 1, expectedDigest: digest(pending) }))).code).toBe("REAUTH_REQUIRED");
  });

  it("is pinned to the version and digest the approver saw, and to a pending account", async () => {
    const h = harness();
    const pending = await added(h);
    const b = h.caller(ADMIN_B);
    expect((await rejects(approveTestAccount(h.deps, b, { id: pending.account.id, expectedVersion: 2, expectedDigest: digest(pending) }))).code).toBe("CHANGE_STALE");
    expect((await rejects(approveTestAccount(h.deps, b, { id: pending.account.id, expectedVersion: 1, expectedDigest: "0".repeat(64) }))).code).toBe("CHANGE_STALE");
    expect((await rejects(approveTestAccount(h.deps, b, { id: "ta-nope", expectedVersion: 1, expectedDigest: digest(pending) }))).code).toBe("NOT_FOUND");
    const done = await approveTestAccount(h.deps, b, { id: pending.account.id, expectedVersion: 1, expectedDigest: digest(pending) });
    expect((await rejects(approveTestAccount(h.deps, h.caller(ADMIN_C), { id: pending.account.id, expectedVersion: done.version, expectedDigest: digest(done) }))).code).toBe("CHANGE_STALE");
  });

  it("refuses when the evidence names other people or carries no fence, or the row changed meanwhile", async () => {
    const h = harness();
    const pending = await added(h);
    const request = { id: pending.account.id, expectedVersion: 1, expectedDigest: digest(pending) };
    const original = h.deps.approvalEvidence.bind(h.deps);
    h.deps.approvalEvidence = async (scope) => { const e = await original(scope); return { ...e, decisionInput: { ...e.decisionInput, approverId: ADMIN_C } }; };
    expect((await rejects(approveTestAccount(h.deps, h.caller(ADMIN_B), request))).code).toBe("CHANGE_STALE");
    h.deps.approvalEvidence = async (scope) => { const e = await original(scope); return { ...e, conditions: [] }; };
    expect((await rejects(approveTestAccount(h.deps, h.caller(ADMIN_B), request))).code).toBe("CHANGE_STALE");
    h.deps.approvalEvidence = original;
    h.store.failNextCommit = true;
    expect((await rejects(approveTestAccount(h.deps, h.caller(ADMIN_B), request))).code).toBe("CHANGE_STALE");
  });

  it("checks the production deny list again at approval", async () => {
    const h = harness();
    const pending = await added(h);
    h.state.deny = { accountIds: [], hosts: ["api.stripe.com"], arnPrefixes: [] };
    const refusal = await rejects(approveTestAccount(h.deps, h.caller(ADMIN_B), { id: pending.account.id, expectedVersion: 1, expectedDigest: digest(pending) }));
    expect(refusal.code).toBe("CONFIG_INVALID");
    expect(h.store.rows.get(`${ORG}#${pending.account.id}`)!.account.status).toBe("pending");
  });

  it("never reads another company's account", async () => {
    const h = harness();
    const pending = await added(h);
    h.store.rows.set(`${OTHER_ORG}#${pending.account.id}`, structuredClone(pending));
    expect((await rejects(approveTestAccount(h.deps, { ...h.caller(ADMIN_B), orgId: OTHER_ORG }, { id: pending.account.id, expectedVersion: 1, expectedDigest: digest(pending) }))).code).toBe("NOT_FOUND");
  });
});

describe("narrowing and widening (DC-TS-2)", () => {
  it("applies a pure narrowing at once: the approvals are re-stamped, the account stays active and usable, and it is audited", async () => {
    const h = harness();
    const before = await active(h);
    const after = await updateTestAccount(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version, changes: { projectIds: ["orders"], envNames: [] } });
    expect(after.account.status).toBe("active");
    expect(after.account.expiresAt).toBe(before.account.expiresAt);
    expect(after.account.approvals.map((a) => a.by)).toEqual([ADMIN_A, ADMIN_B]);
    expect(after.account.approvals.every((a) => a.approvedDigest === digest(after))).toBe(true);
    expect(digest(after)).not.toBe(digest(before));
    expect(isTestAccountUsableAt(after.account, T0 + DAY)).toBe(true);
    expect(h.store.audits.at(-1)).toMatchObject({ action: "test_account.narrowed", facts: { digest: digest(after), fromDigest: digest(before) } });
  });

  it("makes a widening wait: the account is pending, unusable, carries only the editor's approval, and has no expiry until a second person approves", async () => {
    const h = harness();
    const before = await active(h);
    const widened = await updateTestAccount(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version, changes: { projectIds: "all" } });
    expect(widened.account.status).toBe("pending");
    expect(widened.account.expiresAt).toBeUndefined();
    expect(widened.account.approvals.map((a) => a.by)).toEqual([ADMIN_C]);
    expect(widened.proposedBy).toBe(ADMIN_C);
    expect(isTestAccountUsableAt(widened.account, T0 + 1)).toBe(false);
    expect(h.store.audits.at(-1)).toMatchObject({ action: "test_account.widened" });
    // The old approvals do not carry over: the previous approver alone is not enough, and the editor cannot approve their own widening.
    expect((await rejects(approveTestAccount(h.deps, h.caller(ADMIN_C), { id: widened.account.id, expectedVersion: widened.version, expectedDigest: digest(widened) }))).code).toBe("FORBIDDEN");
    const again = await approveTestAccount(h.deps, h.caller(ADMIN_A), { id: widened.account.id, expectedVersion: widened.version, expectedDigest: digest(widened) });
    expect(again.account.status).toBe("active");
    expect(again.account.approvals.map((a) => a.by)).toEqual([ADMIN_C, ADMIN_A]);
  });

  it("treats a narrowing mixed with a widening, a higher limit, a new host or a new variable as a widening", async () => {
    for (const changes of [
      { projectIds: ["web"] }, { limits: { maxConnectionsPerRun: 2_001 } }, { envNames: ["PAYMENTS_API_KEY", "ANOTHER_NAME"] }, { hosts: ["api.stripe.com", "files.stripe.com"] },
      { projectIds: ["orders"], limits: { maxConcurrentRounds: 3 } },
    ]) {
      const h = harness();
      const before = await active(h);
      const after = await updateTestAccount(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version, changes: changes });
      expect(after.account.status, JSON.stringify(changes)).toBe("pending");
    }
  });

  it("keeps an AWS account's narrowing and widening apart: fewer actions narrow, a new resource widens", async () => {
    const h = harness();
    const before = await active(h, { draft: awsDraft() });
    const narrow = await updateTestAccount(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version, changes: { aws: { ...before.account.aws!, actions: ["dynamodb:GetItem"] } } });
    expect(narrow.account.status).toBe("active");
    expect(narrow.account.hosts).toEqual(["dynamodb.us-west-2.amazonaws.com"]);
    const wide = await updateTestAccount(h.deps, h.caller(ADMIN_C), { id: narrow.account.id, expectedVersion: narrow.version, changes: { aws: { ...narrow.account.aws!, resources: [...narrow.account.aws!.resources, "arn:aws:dynamodb:us-west-2:222233334444:table/other"] } } });
    expect(wide.account.status).toBe("pending");
  });

  it("stores a new label without an audit event and without touching the approvals", async () => {
    const h = harness();
    const before = await active(h);
    const events = h.store.audits.length;
    const after = await updateTestAccount(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version, changes: { label: "Renamed" } });
    expect(after.account.label).toBe("Renamed");
    expect(after.account.status).toBe("active");
    expect(after.account.approvals).toEqual(before.account.approvals);
    expect(h.store.audits.length).toBe(events);
  });

  it("refuses a change to a record that names production, a stale version, and a caller without a fresh sign-in", async () => {
    const h = harness();
    const before = await active(h);
    expect((await rejects(updateTestAccount(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: 99, changes: { label: "x" } }))).code).toBe("CHANGE_STALE");
    expect((await rejects(updateTestAccount(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version, changes: { hosts: ["billing.prod.example.com"] } }))).code).toBe("CONFIG_INVALID");
    const late = h.caller(ADMIN_C);
    h.clock.now += 11 * 60_000;
    expect((await rejects(updateTestAccount(h.deps, late, { id: before.account.id, expectedVersion: before.version, changes: { label: "x" } }))).code).toBe("REAUTH_REQUIRED");
  });
});

describe("rotate, suspend, re-enable, delete, expire", () => {
  it("rotates the value under the same reference with the key-shape check, leaves approvals alone, and audits without the value", async () => {
    const h = harness();
    const before = await active(h);
    const next = stripeTest().replace(/.$/u, "Z");
    const after = await rotateTestAccountSecret(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version, secretValue: next });
    expect(after.account.rotatedAt).toBe(new Date(T0).toISOString());
    expect(after.account.approvals).toEqual(before.account.approvals);
    expect(after.account.status).toBe("active");
    expect(JSON.parse(h.secrets.stored(testAccountSecretName("staging", ORG, before.account.id))!.value)).toEqual({ value: next });
    expect(JSON.stringify(h.store.audits)).not.toContain(next);
    expect(h.store.audits.at(-1)).toMatchObject({ action: "test_account.rotated" });
    const live = await rejects(rotateTestAccountSecret(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: after.version, secretValue: stripeLive() }));
    expect(live.extra.reason).toBe("live_shaped");
    const aws = await active(h, { draft: awsDraft() });
    expect((await rejects(rotateTestAccountSecret(h.deps, h.caller(ADMIN_C), { id: aws.account.id, expectedVersion: aws.version, secretValue: "x" }))).code).toBe("CONFIG_INVALID");
  });

  it("suspends at once with a live admin and no second person, and the account is unusable from then", async () => {
    const h = harness();
    const before = await active(h);
    h.clock.now += 11 * 60_000; // no fresh sign-in needed to suspend
    const after = await suspendTestAccount(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version });
    expect(after.account.status).toBe("suspended");
    expect(after.account.expiresAt).toBeUndefined();
    expect(isTestAccountUsableAt(after.account, T0 + 1)).toBe(false);
    expect(h.store.audits.at(-1)).toMatchObject({ action: "test_account.suspended", facts: { cause: "manual" } });
    h.admins.delete(ADMIN_C);
    expect((await rejects(suspendTestAccount(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: after.version }))).code).toBe("FORBIDDEN");
  });

  it("makes re-enabling a suspended or expired account wait for a second person, and old approvals do not count", async () => {
    const h = harness();
    const before = await active(h);
    const suspended = await suspendTestAccount(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version });
    const again = await reenableTestAccount(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: suspended.version });
    expect(again.account.status).toBe("pending");
    expect(again.account.approvals.map((a) => a.by)).toEqual([ADMIN_C]);
    expect(h.store.audits.at(-1)).toMatchObject({ action: "test_account.reenable_requested", facts: { fromStatus: "suspended" } });
    expect((await rejects(reenableTestAccount(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: again.version }))).code).toBe("CHANGE_STALE");
    const done = await approveTestAccount(h.deps, h.caller(ADMIN_A), { id: again.account.id, expectedVersion: again.version, expectedDigest: digest(again) });
    expect(done.account.status).toBe("active");
    expect(done.account.expiresAt).toBe(new Date(T0 + 90 * DAY).toISOString());
  });

  it("deletes the secret (with the recovery window) before the row, and the audit names the kind only", async () => {
    const h = harness();
    const before = await active(h);
    await deleteTestAccount(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version });
    expect(h.store.rows.size).toBe(0);
    const secret = h.secrets.stored(testAccountSecretName("staging", ORG, before.account.id));
    expect(secret?.deleteAt).toBe(T0 + 7 * DAY);
    expect(h.store.audits.at(-1)).toMatchObject({ action: "test_account.deleted", facts: { kind: "api_key", cause: "manual" } });
    // An AWS account has no secret to delete.
    const aws = await active(h, { draft: awsDraft() });
    const calls = h.secrets.calls.length;
    await deleteTestAccount(h.deps, h.caller(ADMIN_C), { id: aws.account.id, expectedVersion: aws.version });
    expect(h.secrets.calls.length).toBe(calls);
  });

  it("ends accounts past their expiry, leaves the others, and lists the ones to remind 14 days ahead once", async () => {
    const h = harness();
    const a = await active(h);
    h.clock.now += 80 * DAY;
    const b = await active(h);
    h.clock.now = T0 + 89 * DAY;
    const all = await h.store.list(ORG, 10);
    expect(remindersDue(all, new Date(h.clock.now)).map((s) => s.account.id)).toEqual([a.account.id]);
    expect(remindersDue(all.map((s) => ({ ...s, reminderSentFor: s.account.expiresAt! })), new Date(h.clock.now))).toEqual([]);
    expect(remindersDue(all, new Date(T0 + 10 * DAY))).toEqual([]);
    h.clock.now = T0 + 91 * DAY;
    expect(await expireDueAccounts(h.deps, ORG)).toBe(1);
    expect(h.store.rows.get(`${ORG}#${a.account.id}`)!.account.status).toBe("expired");
    expect(h.store.rows.get(`${ORG}#${b.account.id}`)!.account.status).toBe("active");
    expect(h.store.audits.at(-1)).toMatchObject({ action: "test_account.expired", actor: { kind: "system", id: "rovara" } });
    const expired = h.store.rows.get(`${ORG}#${a.account.id}`)!;
    expect(isTestAccountUsableAt(expired.account, h.clock.now)).toBe(false);
    // Re-enabling an expired account asks for a second person too.
    h.clock.now = T0 + 91 * DAY;
    const reasked = await reenableTestAccount(h.deps, h.caller(ADMIN_C), { id: a.account.id, expectedVersion: expired.version });
    expect(reasked.account.status).toBe("pending");
  });
});

describe("use in a sealed round (Q3, Q8)", () => {
  const round = (over: Partial<RoundInput> & { accountIds: readonly string[] }): RoundInput => ({ orgId: ORG, projectId: "orders", place: "sealed_round", ...over });

  it("lets a sealed round use an active account of its project and refuses every other place, with a fixed reason", async () => {
    const h = harness();
    const account = await active(h);
    const ok = await resolveAccountsForRound(h.deps, round({ accountIds: [account.account.id] }));
    const stsBefore = h.secrets.calls.filter((call) => call.service === "sts").length;
    expect(ok).toEqual([{ id: account.account.id, ok: true, account: account.account }]);
    for (const place of ["setup_run", "working_sandbox", "team_runner"] as const) {
      expect(await resolveAccountsForRound(h.deps, round({ place, accountIds: [account.account.id] }))).toEqual([{ id: account.account.id, ok: false, refusal: "not_sealed" }]);
      const minted = await mintRoundGrants(h.deps, round({ place, accountIds: [account.account.id] }));
      expect(minted.grants).toEqual([]);
    }
    // Nothing was minted for the refused places: one session served the add and the approval, and one the sealed round's grant would use, none for these.
    expect(h.secrets.calls.filter((call) => call.service === "sts")).toHaveLength(stsBefore);
  });

  it("refuses by status, expiry, project, production deny list and day cap, and an unknown or another company's id", async () => {
    const h = harness();
    const a = await active(h);
    const id = a.account.id;
    const reason = async (over: Record<string, unknown> = {}): Promise<unknown> => { const [r] = await resolveAccountsForRound(h.deps, round({ accountIds: [id], ...over })); return r!.ok ? "ok" : r!.refusal; };
    expect(await reason({ projectId: "web" })).toBe("project_not_allowed");
    expect(await reason({ accountIds: ["ta-unknown"] })).toBe("not_found");
    expect(await reason({ orgId: OTHER_ORG })).toBe("not_found");
    h.state.deny = { accountIds: [], hosts: ["api.stripe.com"], arnPrefixes: [] };
    expect(await reason()).toBe("production");
    h.state.deny = { accountIds: [], hosts: [], arnPrefixes: [] };
    expect(await reason()).toBe("production");
    h.state.deny = { accountIds: ["999900009999"], hosts: ["*.prod.example.com"], arnPrefixes: [] };
    h.store.usage.set(`${ORG}#${id}#${new Date(T0).toISOString().slice(0, 10)}`, { rounds: 5, bytes: 0, connections: a.account.limits.maxConnectionsPerDay });
    expect(await reason()).toBe("day_cap");
    h.store.usage.clear();
    h.clock.now = T0 + 91 * DAY;
    expect(await reason()).toBe("expired");
    h.clock.now = T0;
    await suspendTestAccount(h.deps, h.caller(ADMIN_C), { id, expectedVersion: a.version });
    expect(await reason()).toBe("not_active");
  });

  it("does not trust a store that hands back another company's record", async () => {
    const h = harness();
    const a = await active(h);
    const row = h.store.rows.get(`${ORG}#${a.account.id}`)!;
    h.store.rows.set(`${ORG}#${a.account.id}`, { ...row, account: { ...row.account, orgId: OTHER_ORG } });
    expect((await resolveAccountsForRound(h.deps, round({ accountIds: [a.account.id] })))[0]).toEqual({ id: a.account.id, ok: false, refusal: "not_found" });
    expect((await rejects(approveTestAccount(h.deps, h.caller(ADMIN_C), { id: a.account.id, expectedVersion: row.version, expectedDigest: digest(a) }))).code).toBe("NOT_FOUND");
  });

  it("refuses a pending account, and an active record whose approvals no longer cover it", async () => {
    const h = harness();
    const pending = await added(h);
    expect((await resolveAccountsForRound(h.deps, round({ accountIds: [pending.account.id] })))[0]).toMatchObject({ ok: false, refusal: "not_active" });
    const a = await active(h);
    const row = h.store.rows.get(`${ORG}#${a.account.id}`)!;
    row.account = { ...row.account, hosts: [...row.account.hosts, "extra.stripe.com"] };
    expect((await resolveAccountsForRound(h.deps, round({ accountIds: [a.account.id] })))[0]).toMatchObject({ ok: false, refusal: "not_active" });
  });

  it("mints a grant for the worker: a resolve session for the one secret, never read by the broker, and the grant matches the contract", async () => {
    const h = harness();
    const a = await active(h);
    const { grants } = await mintRoundGrants(h.deps, round({ accountIds: [a.account.id] }));
    expect(grants).toHaveLength(1);
    const grant = grants[0]!;
    expect(grant).toMatchObject({ orgId: ORG, accountId: a.account.id, secretName: testAccountSecretName("staging", ORG, a.account.id), key: "value", region: "us-west-2", envNames: ["PAYMENTS_API_KEY"], family: "http:api.stripe.com" });
    expect(Date.parse(grant.expiresAt)).toBe(T0 + 15 * 60_000);
    expect(h.secrets.calls.some((call) => call.action === "GetSecretValue")).toBe(false);
    // What the grant holds can read that one secret and nothing else.
    const worker = h.secrets.secretsFor({ accessKeyId: grant.credentials.accessKeyId, secretAccessKey: grant.credentials.secretAccessKey, sessionToken: grant.credentials.sessionToken, expiration: new Date(T0 + 900_000) });
    const read = await worker.send(new GetSecretValueCommand({ SecretId: grant.secretName, VersionStage: "AWSCURRENT" }));
    expect(JSON.parse(read.SecretString!)).toHaveProperty("value");
    // Only the AWSCURRENT stage, named in the request.
    await expect(worker.send(new GetSecretValueCommand({ SecretId: grant.secretName }))).rejects.toMatchObject({ name: "AccessDeniedException" });
    await expect(worker.send(new GetSecretValueCommand({ SecretId: grant.secretName, VersionStage: "AWSPENDING" }))).rejects.toMatchObject({ name: "AccessDeniedException" });
    const other = await active(h);
    await expect(worker.send(new GetSecretValueCommand({ SecretId: testAccountSecretName("staging", ORG, other.account.id), VersionStage: "AWSCURRENT" }))).rejects.toMatchObject({ name: "AccessDeniedException" });
    // Expired when its 15 minutes are over.
    h.clock.now = T0 + 16 * 60_000;
    await expect(worker.send(new GetSecretValueCommand({ SecretId: grant.secretName, VersionStage: "AWSCURRENT" }))).rejects.toMatchObject({ name: "ExpiredTokenException" });
  });

  it("mints nothing for an AWS role account, an account with no variables, or one the round may not use", async () => {
    const h = harness();
    const aws = await active(h, { draft: awsDraft() });
    const nameless = await active(h, { draft: apiDraft({ envNames: [] }) });
    const wrongProject = await active(h);
    const result = await mintRoundGrants(h.deps, round({ projectId: "web", accountIds: [aws.account.id, nameless.account.id, wrongProject.account.id] }));
    expect(result.grants).toEqual([]);
    const some = await mintRoundGrants(h.deps, round({ projectId: "orders", accountIds: [aws.account.id, nameless.account.id, wrongProject.account.id] }));
    expect(some.grants.map((g) => g.accountId)).toEqual([wrongProject.account.id]);
  });

  it("adds a round's use to the day and audits the roll-up with counts only", async () => {
    const h = harness();
    const a = await active(h);
    const totals = await recordTestAccountUse(h.deps, { orgId: ORG, accountId: a.account.id, projectId: "orders", rounds: 1, connections: 120, bytes: 0 });
    expect(totals).toEqual({ rounds: 1, connections: 120, bytes: 0 });
    expect(await recordTestAccountUse(h.deps, { orgId: ORG, accountId: a.account.id, projectId: "orders", rounds: 2, connections: 30, bytes: 0 })).toEqual({ rounds: 3, connections: 150, bytes: 0 });
    expect(h.store.audits.at(-1)).toMatchObject({ action: "test_account.used", facts: { day: "2026-11-02", rounds: 2, connections: 30, bytes: 0 } });
    expect((await rejects(recordTestAccountUse(h.deps, { orgId: ORG, accountId: a.account.id, projectId: "orders", rounds: -1, connections: 0, bytes: 0 }))).code).toBe("CONFIG_INVALID");
    expect((await rejects(recordTestAccountUse(h.deps, { orgId: OTHER_ORG, accountId: a.account.id, projectId: "orders", rounds: 1, connections: 1, bytes: 0 }))).code).toBe("NOT_FOUND");
  });
});

describe("the secrets class refuses a session it did not ask for", () => {
  const credentials = (expiration: Date | undefined, parts: Record<string, string | undefined> = {}) => ({
    Credentials: { AccessKeyId: parts.id ?? "ASIAFAKE00000001", SecretAccessKey: parts.secret ?? "fake-secret", SessionToken: parts.token ?? "fake-token", ...(expiration === undefined ? {} : { Expiration: expiration }) },
  });
  const secretsWith = (response: unknown) => new TestAccountSecrets({
    env: "staging", roleArn: ROLE_ARN, secretArnPrefix: ARN_PREFIX, region: "us-west-2", now: () => T0,
    sts: { send: () => Promise.resolve(response as never) }, storeClientFor: () => { throw new Error("not used"); }, enabled: () => true,
  });
  it("hands a worker a grant of at most the 15 minutes it asked for", async () => {
    await expect(secretsWith(credentials(new Date(T0 + 15 * 60_000))).mintResolveGrant(ORG, "ta-0000000000000001")).resolves.toMatchObject({ region: "us-west-2", expiresAt: new Date(T0 + 15 * 60_000).toISOString() });
    for (const bad of [credentials(new Date(T0 + 3_600_000)), credentials(new Date(T0 - 1)), credentials(new Date(T0)), credentials(new Date("nope")), credentials(undefined), {}, { Credentials: {} }]) {
      expect((await rejects(secretsWith(bad).mintResolveGrant(ORG, "ta-0000000000000001"))).code).toBe("RUNTIME_UNAVAILABLE");
    }
  });
  it("names only a well-formed org and account", async () => {
    const secrets = secretsWith(credentials(new Date(T0 + 900_000)));
    for (const [org, account] of [["org_short", "ta-1"], [ORG, "../x"], [ORG, "Ta-1"], [ORG, ""], ["", "ta-1"]] as const) {
      expect((await rejects(secrets.mintResolveGrant(org, account))).code, `${org} ${account}`).toBe("FORBIDDEN");
      expect((await rejects(secrets.put(org, account, "value", "x"))).code, `${org} ${account}`).toBe("FORBIDDEN");
      expect((await rejects(secrets.scheduleDelete(org, account))).code, `${org} ${account}`).toBe("FORBIDDEN");
    }
    expect((await rejects(secrets.put(ORG, "ta-1", "bad key", "x"))).code).toBe("CONFIG_INVALID");
    expect((await rejects(secrets.put(ORG, "ta-1", "value", ""))).code).toBe("CONFIG_INVALID");
  });
});


// ---- the review fixes (Opus review of bc5719055)

/** The harness's secrets port with some methods replaced, to fail one step. */
function secretsWith(h: Harness, over: Partial<Record<"put" | "putPending" | "promote" | "currentVersionId" | "discardPending" | "scheduleDelete" | "mintResolveGrant", (...args: never[]) => Promise<unknown>>>): void {
  const real = h.deps.secrets;
  h.deps.secrets = {
    put: real.put.bind(real), putPending: real.putPending.bind(real), promote: real.promote.bind(real), currentVersionId: real.currentVersionId.bind(real), discardPending: real.discardPending.bind(real),
    scheduleDelete: real.scheduleDelete.bind(real), mintResolveGrant: real.mintResolveGrant.bind(real), ...over,
  } as never;
}
const secretOf = (h: Harness, account: StoredTestAccount) => h.secrets.stored(testAccountSecretName("staging", ORG, account.account.id))!;
const stageOf = (h: Harness, account: StoredTestAccount, label: string): string | undefined => Object.entries(secretOf(h, account).stages).find(([, labels]) => labels.includes(label))?.[0];
const valueOf = (h: Harness, account: StoredTestAccount): string => (JSON.parse(secretOf(h, account).value) as { value: string }).value;

describe("H1: the AWS external id is Rovara's, never the customer's", () => {
  it("is derived from the company and the account, shown in the record, and a customer's own value is refused", async () => {
    const h = harness();
    const stored = await added(h, { draft: awsDraft() });
    expect(stored.account.aws?.externalId).toBe(`rovara-${ORG}-${stored.account.id}`);
    expect(stored.account.aws?.externalId.startsWith("rovara-org_")).toBe(true);
    for (const own of ["ext-0123456789", `rovara-${OTHER_ORG}-${stored.account.id}`, "rovara-org_", `rovara-${ORG}-someone-elses`]) {
      const fresh = harness();
      const refused = await rejects(addTestAccount(fresh.deps, fresh.caller(ADMIN_A), { draft: awsDraft({ aws: { ...awsDraft().aws, externalId: own } }) }));
      expect(refused.code, own).toBe("CONFIG_INVALID");
    }
    // The id the first add would have is the same text, so it is accepted when it is exactly that.
    const h2 = harness();
    const exact = await addTestAccount(h2.deps, h2.caller(ADMIN_A), { draft: awsDraft({ aws: { ...awsDraft().aws, externalId: `rovara-${ORG}-ta-0000000000000001` } }) });
    expect(exact.account.aws?.externalId).toBe(`rovara-${ORG}-ta-0000000000000001`);
  });

  it("is kept on an update, and an update cannot set another", async () => {
    const h = harness();
    const before = await active(h, { draft: awsDraft() });
    const narrowed = await updateTestAccount(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version, changes: { aws: { ...awsDraft().aws, actions: ["dynamodb:GetItem"] } } });
    expect(narrowed.account.aws?.externalId).toBe(`rovara-${ORG}-${before.account.id}`);
    const foreign = await rejects(updateTestAccount(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: narrowed.version, changes: { aws: { ...awsDraft().aws, externalId: `rovara-${OTHER_ORG}-${before.account.id}` } } }));
    expect(foreign.code).toBe("CONFIG_INVALID");
    // A stored record that already carries a foreign id (a bug elsewhere) cannot be changed into a valid one by an unrelated edit.
    const row = h.store.rows.get(`${ORG}#${before.account.id}`)!;
    h.store.rows.set(`${ORG}#${before.account.id}`, { ...row, account: { ...row.account, aws: { ...row.account.aws!, externalId: `rovara-${OTHER_ORG}-${before.account.id}` } } });
    expect((await rejects(updateTestAccount(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: row.version, changes: { label: "renamed" } }))).code).toBe("CONFIG_INVALID");
  });
});

describe("M1: a rotation serves the new value only after its row is committed", () => {
  it("stages the value as pending, commits the row and audit, then promotes it; the old value serves until then", async () => {
    const h = harness();
    const before = await active(h);
    const oldValue = valueOf(h, before);
    const oldVersion = stageOf(h, before, "AWSCURRENT");
    const seenAtCommit: Array<{ current: string; pending: string | undefined; rowVersionId: string | undefined }> = [];
    const commit = h.store.commit.bind(h.store);
    h.store.commit = (next, expected, audit, conditions) => {
      seenAtCommit.push({ current: valueOf(h, before), pending: stageOf(h, before, "AWSPENDING"), rowVersionId: next.secretVersionId });
      return commit(next, expected, audit, conditions);
    };
    const next = stripeTest().replace(/.$/u, "Q");
    const after = await rotateTestAccountSecret(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version, secretValue: next });
    expect(seenAtCommit).toHaveLength(1);
    expect(seenAtCommit[0]!.current).toBe(oldValue);
    expect(seenAtCommit[0]!.pending).toBeDefined();
    expect(seenAtCommit[0]!.rowVersionId).toBe(seenAtCommit[0]!.pending);
    expect(valueOf(h, before)).toBe(next);
    expect(stageOf(h, before, "AWSCURRENT")).toBe(after.secretVersionId);
    expect(stageOf(h, before, "AWSPREVIOUS")).toBe(oldVersion);
    expect(stageOf(h, before, "AWSPENDING")).toBeUndefined();
    expect(h.store.audits.at(-1)).toMatchObject({ action: "test_account.rotated" });
  });

  it("changes nothing when the new value cannot be put", async () => {
    const h = harness();
    const before = await active(h);
    const oldValue = valueOf(h, before);
    secretsWith(h, { putPending: () => Promise.reject(agentXFailure()) });
    const auditsBefore = h.store.audits.length;
    expect((await rejects(rotateTestAccountSecret(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version, secretValue: stripeTest() }))).code).toBe("RUNTIME_UNAVAILABLE");
    expect(valueOf(h, before)).toBe(oldValue);
    expect(h.store.rows.get(`${ORG}#${before.account.id}`)!.version).toBe(before.version);
    expect(h.store.audits).toHaveLength(auditsBefore);
  });

  it("leaves the old value serving, and takes the pending label off, when the row loses its race", async () => {
    const h = harness();
    const before = await active(h);
    const oldValue = valueOf(h, before);
    h.store.failNextCommit = true;
    expect((await rejects(rotateTestAccountSecret(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version, secretValue: stripeTest() }))).code).toBe("CHANGE_STALE");
    expect(valueOf(h, before)).toBe(oldValue);
    expect(stageOf(h, before, "AWSPENDING")).toBeUndefined();
    expect(h.store.rows.get(`${ORG}#${before.account.id}`)!.version).toBe(before.version);
  });

  it("leaves the old value serving when the commit throws, and still answers with the commit's own error even if the cleanup fails", async () => {
    const h = harness();
    const before = await active(h);
    const oldValue = valueOf(h, before);
    h.store.commit = () => Promise.reject(Object.assign(new Error("store down"), { name: "StoreDown" }));
    secretsWith(h, { discardPending: () => Promise.reject(agentXFailure()) });
    await expect(rotateTestAccountSecret(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version, secretValue: stripeTest() })).rejects.toMatchObject({ name: "StoreDown" });
    expect(valueOf(h, before)).toBe(oldValue);
    expect(stageOf(h, before, "AWSCURRENT")).toBe(before.secretVersionId);
  });

  it("keeps the old value when the promotion fails, takes the pending label off, puts the row back and audits the failed rotation", async () => {
    const h = harness();
    const before = await active(h);
    const oldValue = valueOf(h, before);
    secretsWith(h, { promote: () => Promise.reject(agentXFailure()) });
    const failed = await rejects(rotateTestAccountSecret(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version, secretValue: stripeTest() }));
    expect(failed.code).toBe("RUNTIME_UNAVAILABLE");
    expect(valueOf(h, before)).toBe(oldValue);
    expect(stageOf(h, before, "AWSPENDING")).toBeUndefined();
    const row = h.store.rows.get(`${ORG}#${before.account.id}`)!;
    expect(row.secretVersionId).toBe(before.secretVersionId);
    expect(row.account.rotatedAt).toBe(before.account.rotatedAt);
    expect(row.version).toBe(before.version + 2);
    expect(h.store.audits.at(-1)).toMatchObject({ action: "test_account.rotation_failed", facts: { cause: "promote" } });
    expect(JSON.stringify(h.store.audits)).not.toContain("Qk7mP2xR9v");
  });

  it("double fault, lost answer: when the promotion's call fails but AWSCURRENT already points at the new version, the rotation is done and nothing is reverted", async () => {
    const h = harness();
    const before = await active(h);
    const real = h.deps.secrets;
    secretsWith(h, { promote: async (orgId: string, accountId: string, versionId: string) => { await real.promote(orgId, accountId, versionId); throw agentXFailure(); } });
    const next = stripeTest().replace(/.$/u, "L");
    const after = await rotateTestAccountSecret(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version, secretValue: next });
    expect(valueOf(h, before)).toBe(next);
    expect(stageOf(h, before, "AWSCURRENT")).toBe(after.secretVersionId);
    expect(stageOf(h, before, "AWSPENDING")).toBeUndefined();
    const row = h.store.rows.get(`${ORG}#${before.account.id}`)!;
    expect(row.version).toBe(after.version);
    expect(row.secretVersionId).toBe(after.secretVersionId);
    expect(row.account.status).toBe("active");
    expect(h.store.audits.map((audit) => audit.action)).not.toContain("test_account.rotation_failed");
    expect(h.store.audits.at(-1)).toMatchObject({ action: "test_account.rotated" });
  });

  it("double fault, no answer about the stages: treated as a failed promotion and put back", async () => {
    const h = harness();
    const before = await active(h);
    const oldValue = valueOf(h, before);
    secretsWith(h, { promote: () => Promise.reject(agentXFailure()), currentVersionId: () => Promise.reject(agentXFailure()) });
    expect((await rejects(rotateTestAccountSecret(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version, secretValue: stripeTest() }))).code).toBe("RUNTIME_UNAVAILABLE");
    expect(valueOf(h, before)).toBe(oldValue);
    const row = h.store.rows.get(`${ORG}#${before.account.id}`)!;
    expect(row.account.status).toBe("active");
    expect(row.secretVersionId).toBe(before.secretVersionId);
    expect(h.store.audits.at(-1)).toMatchObject({ action: "test_account.rotation_failed", facts: { cause: "promote" } });
  });

  it("double fault, the row cannot be put back: the account is suspended and the failure audited with a fixed reason", async () => {
    for (const how of ["lost", "throws"] as const) {
      const h = harness();
      const before = await active(h);
      const oldValue = valueOf(h, before);
      secretsWith(h, { promote: () => Promise.reject(agentXFailure()) });
      const commit = h.store.commit.bind(h.store);
      let calls = 0;
      h.store.commit = (next, expected, audit, conditions) => {
        calls += 1;
        if (calls === 2) return how === "lost" ? Promise.resolve(false) : Promise.reject(new Error("store down"));
        return commit(next, expected, audit, conditions);
      };
      const failed = await rejects(rotateTestAccountSecret(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version, secretValue: stripeTest() }));
      expect(failed.code, how).toBe("RUNTIME_UNAVAILABLE");
      expect(valueOf(h, before), how).toBe(oldValue);
      const row = h.store.rows.get(`${ORG}#${before.account.id}`)!;
      expect(row.account.status, how).toBe("suspended");
      expect(row.account.expiresAt, how).toBeUndefined();
      expect(isTestAccountUsableAt(row.account, T0 + 1), how).toBe(false);
      expect(h.store.audits.at(-1), how).toMatchObject({ action: "test_account.rotation_failed", facts: { cause: "revert_failed" } });
      expect((await resolveAccountsForRound(h.deps, { orgId: ORG, projectId: "orders", place: "sealed_round", accountIds: [before.account.id] }))[0], how).toMatchObject({ ok: false });
    }
  });

  it("double fault, nothing can be written: the original failure is still the answer", async () => {
    const h = harness();
    const before = await active(h);
    secretsWith(h, { promote: () => Promise.reject(agentXFailure()) });
    const commit = h.store.commit.bind(h.store);
    let calls = 0;
    h.store.commit = (next, expected, audit, conditions) => { calls += 1; return calls === 1 ? commit(next, expected, audit, conditions) : Promise.reject(new Error("store down")); };
    expect((await rejects(rotateTestAccountSecret(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version, secretValue: stripeTest() }))).code).toBe("RUNTIME_UNAVAILABLE");
    expect(calls).toBe(3);
  });

  it("refuses to promote a version that is not the pending one", async () => {
    const h = harness();
    const before = await active(h);
    const current = stageOf(h, before, "AWSCURRENT")!;
    expect((await rejects(h.secretsClass.promote(ORG, before.account.id, current))).code).toBe("CHANGE_STALE");
    expect((await rejects(h.secretsClass.promote(ORG, before.account.id, "00000000-0000-4000-8000-ffffffffffff"))).code).toBe("CHANGE_STALE");
  });

  it("does not rotate an account that is being deleted", async () => {
    const h = harness();
    const before = await active(h);
    secretsWith(h, { scheduleDelete: () => Promise.reject(agentXFailure()) });
    await rejects(deleteTestAccount(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version }));
    const row = h.store.rows.get(`${ORG}#${before.account.id}`)!;
    expect((await rejects(rotateTestAccountSecret(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: row.version, secretValue: stripeTest() }))).code).toBe("CHANGE_STALE");
  });
});

function agentXFailure(): Error {
  return Object.assign(new Error("RUNTIME_UNAVAILABLE: down"), { name: "AgentXError", code: "RUNTIME_UNAVAILABLE" });
}

describe("M2: an admin who joined within 24 hours is not the second person", () => {
  it("refuses a second person whose role is under a day old, or whose start is unknown, and accepts one at exactly a day", async () => {
    const h = harness();
    const pending = await added(h);
    const request = { id: pending.account.id, expectedVersion: pending.version, expectedDigest: digest(pending) };
    h.adminSince.set(ADMIN_B, new Date(T0 - DAY + 1).toISOString());
    const young = await rejects(approveTestAccount(h.deps, h.caller(ADMIN_B), request));
    expect(young.code).toBe("FORBIDDEN");
    expect(young.extra.availableAt).toBe(new Date(T0 + 1).toISOString());
    h.adminSince.delete(ADMIN_B);
    expect((await rejects(approveTestAccount(h.deps, h.caller(ADMIN_B), request))).code).toBe("FORBIDDEN");
    h.adminSince.set(ADMIN_B, "not a date");
    expect((await rejects(approveTestAccount(h.deps, h.caller(ADMIN_B), request))).code).toBe("FORBIDDEN");
    h.adminSince.set(ADMIN_B, new Date(T0 + 60_000).toISOString());
    expect((await rejects(approveTestAccount(h.deps, h.caller(ADMIN_B), request))).code).toBe("FORBIDDEN");
    expect(h.store.rows.get(`${ORG}#${pending.account.id}`)!.account.status).toBe("pending");
    h.adminSince.set(ADMIN_B, new Date(T0 - DAY).toISOString());
    expect((await approveTestAccount(h.deps, h.caller(ADMIN_B), request)).account.status).toBe("active");
  });

  it("does not hold the sole owner's own exception to the day (it has its own cool-off)", async () => {
    const h = harness();
    h.eligible.ids = [ADMIN_A];
    const pending = await added(h);
    h.adminSince.delete(ADMIN_A);
    const done = await approveTestAccount(h.deps, h.caller(ADMIN_A), { id: pending.account.id, expectedVersion: pending.version, expectedDigest: digest(pending) });
    expect(done.account.approvals.at(-1)?.kind).toBe("sole_owner_exception");
  });
});

describe("L4: deleting is committed before the secret is scheduled", () => {
  it("writes an audited, unusable deleting row first, then schedules the secret, then removes the row", async () => {
    const h = harness();
    const before = await active(h);
    const timeline: string[] = [];
    const real = h.deps.secrets;
    secretsWith(h, { scheduleDelete: async (orgId: string, accountId: string) => { timeline.push(`schedule:${h.store.rows.get(`${ORG}#${before.account.id}`)!.account.status}`); await real.scheduleDelete(orgId, accountId); } });
    await deleteTestAccount(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version });
    expect(timeline).toEqual(["schedule:deleting"]);
    expect(h.store.audits.slice(-2).map((audit) => audit.action)).toEqual(["test_account.deleting", "test_account.deleted"]);
    expect(h.store.rows.size).toBe(0);
  });

  it("leaves a deleting row that nothing can use when the scheduling fails, and a second delete finishes it", async () => {
    const h = harness();
    const before = await active(h);
    secretsWith(h, { scheduleDelete: () => Promise.reject(agentXFailure()) });
    await rejects(deleteTestAccount(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: before.version }));
    const row = h.store.rows.get(`${ORG}#${before.account.id}`)!;
    expect(row.account.status).toBe("deleting");
    expect(row.account.expiresAt).toBeUndefined();
    expect(isTestAccountUsableAt(row.account, T0 + 1)).toBe(false);
    expect((await resolveAccountsForRound(h.deps, { orgId: ORG, projectId: "orders", place: "sealed_round", accountIds: [before.account.id] }))[0]).toMatchObject({ ok: false });
    expect((await rejects(updateTestAccount(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: row.version, changes: { label: "x" } }))).code).toBe("CHANGE_STALE");
    expect((await rejects(suspendTestAccount(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: row.version }))).code).toBe("CHANGE_STALE");
    expect((await rejects(approveTestAccount(h.deps, h.caller(ADMIN_B), { id: before.account.id, expectedVersion: row.version, expectedDigest: digest(row) }))).code).toBe("CHANGE_STALE");
    h.deps.secrets = h.secretsClass;
    await deleteTestAccount(h.deps, h.caller(ADMIN_C), { id: before.account.id, expectedVersion: row.version });
    expect(h.store.rows.size).toBe(0);
    expect(secretOf(h, before).deleteAt).toBe(T0 + 7 * DAY);
  });

  it("deletes an AWS account, which has no secret, in one step", async () => {
    const h = harness();
    const aws = await active(h, { draft: awsDraft() });
    await deleteTestAccount(h.deps, h.caller(ADMIN_C), { id: aws.account.id, expectedVersion: aws.version });
    expect(h.store.audits.map((audit) => audit.action)).not.toContain("test_account.deleting");
    expect(h.store.rows.size).toBe(0);
  });
});

describe("L5: the sole-owner setting is fenced in the approval's transaction", () => {
  it("commits the setting's condition with the evidence conditions, for a second person and for the exception alike", async () => {
    const h = harness();
    const pending = await added(h);
    await approveTestAccount(h.deps, h.caller(ADMIN_B), { id: pending.account.id, expectedVersion: pending.version, expectedDigest: digest(pending) });
    const keys = h.store.conditions.at(-1)!.map((item) => JSON.stringify(item));
    expect(keys.some((key) => key.includes("SETTING#sole-owner-exception"))).toBe(true);
    expect(keys.some((key) => key.includes('"sk":"META"'))).toBe(true);
    const solo = harness();
    solo.eligible.ids = [ADMIN_A];
    const lone = await added(solo);
    await approveTestAccount(solo.deps, solo.caller(ADMIN_A), { id: lone.account.id, expectedVersion: lone.version, expectedDigest: digest(lone) });
    expect(solo.store.conditions.at(-1)!.some((item) => JSON.stringify(item).includes("SETTING#sole-owner-exception"))).toBe(true);
  });
});
