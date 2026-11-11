// Test services TS28: an AWS dev account as a test account (a narrow STS session built from the approved actions and resources, the regional endpoints as the proxy's hosts, production and Rovara's own
// accounts refused), then the probe and the mode used per service (unchanged from proof and test environment E9).
import { describe, expect, it } from "vitest";
import { EvidenceEnvironmentSchema, TestEnvironmentBodySchema, testAccountApprovalDigest, type TestAccount, type TestEnvironmentBody, type TestEnvProdDeny } from "@rovara-code/contracts";
import {
  AWS_TEST_ACCOUNT_CODES, AWS_TEST_ACCOUNT_SESSION_SECONDS, AwsTestAccountError, SESSION_POLICY_MAX_CHARS, awsTestAccountHosts, awsTestAccountMessage, awsTestAccountSessionPolicy, evidenceServices,
  openAwsTestAccountSession, preprodUnreachableNextStep, probePreprod, probeRequestOf, resolveRoundModes, type AssumedCredentials, type AwsTestAccountPort,
} from "../../packages/broker/src/test-env/aws-test-account.js";

const ORG = `org_${"a1b2c3d4e5".repeat(2)}`;
const sha = (letter: string) => letter.repeat(64);
const ARN = "arn:aws:sagemaker:us-west-2:222233334444:endpoint/partner-scorer";
const ROLE = "arn:aws:iam::222233334444:role/rovara-invoke";
const NOW = 1_800_000_000_000;
const service = (over: Record<string, unknown> = {}, preprod: Record<string, unknown> = {}) => ({ name: "scorer", kind: "sagemaker_runtime" as const, match: { endpointName: "partner-scorer" }, mode: "preprod" as const, preprod: { endpointArn: ARN, roleArn: ROLE, region: "us-west-2", ...preprod }, ...over });
const body = (services: unknown[], prodDeny: { accountIds: string[]; hosts: string[]; arnPrefixes: string[] } = { accountIds: ["111122223333"], hosts: [], arnPrefixes: [] }): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "svc", setupCommands: [], checks: [] }], roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
  services, data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny, capture: { screenshots: "failed", video: false, traces: false },
});
const REGION = { StringEquals: { "aws:RequestedRegion": "us-west-2" } };
const DENY: TestEnvProdDeny = { accountIds: ["111122223333"], hosts: [], arnPrefixes: [] };
const person = (letter: string) => letter.repeat(64);
const DYNAMO_ROLE = "arn:aws:iam::222233334444:role/rovara-test";
const DYNAMO_TABLE = "arn:aws:dynamodb:us-west-2:222233334444:table/orders-test";
const awsBlock = (over: Record<string, unknown> = {}) => ({ roleArn: DYNAMO_ROLE, externalId: `rovara-${ORG}-orders-dev`, region: "us-west-2", actions: ["dynamodb:GetItem", "dynamodb:PutItem"], resources: [DYNAMO_TABLE], ...over });
/** An active, approved AWS role account, built the way the contract builds one (approvals stamped with the record's own digest). */
function account(over: Record<string, unknown> = {}): TestAccount {
  const record: Record<string, unknown> = {
    id: "orders-dev", orgId: ORG, projectIds: ["orders"], family: "aws:dynamodb", label: "Dev AWS (orders)", kind: "aws_role", aws: awsBlock(), hosts: ["dynamodb.us-west-2.amazonaws.com"], envNames: [],
    limits: { maxConnectionsPerRun: 2_000, maxConnectionsPerDay: 20_000, maxConcurrentRounds: 2 }, status: "active", expiresAt: new Date(NOW + 30 * 86_400_000).toISOString(), approvals: [], ...over,
  };
  const digest = testAccountApprovalDigest(record as never);
  record.approvals = ["a", "b"].map((letter) => ({ by: person(letter), at: new Date(NOW - 86_400_000).toISOString(), freshSignIn: true, kind: "approver", approvedDigest: digest }));
  return record as unknown as TestAccount;
}
const creds = (over: Partial<AssumedCredentials> = {}): AssumedCredentials => ({ accessKeyId: ["ASIA", "EXAMPLE"].join(""), secretAccessKey: "s3cr3t-example", sessionToken: "token-example", expiration: new Date(NOW + 3_600_000), ...over });
function aws(over: Partial<AwsTestAccountPort> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const port: AwsTestAccountPort = { enabled: () => true, ownAccountId: "999988887777", rovaraAccountIds: ["888800008888"], assumeRole: (input) => { calls.push({ ...input }); return Promise.resolve(creds()); }, ...over };
  return { port, calls };
}
const open = (port: AwsTestAccountPort, over: { orgId?: string; account?: TestAccount; taskId?: string; prodDeny?: TestEnvProdDeny; maxExpiryDays?: number } = {}) =>
  openAwsTestAccountSession(port, { orgId: over.orgId ?? ORG, account: over.account ?? account(), taskId: over.taskId ?? "task-1234abcd-9", prodDeny: over.prodDeny ?? DENY, ...(over.maxExpiryDays === undefined ? {} : { maxExpiryDays: over.maxExpiryDays }), now: () => NOW });
const refusalOf = async (call: Promise<unknown>): Promise<AwsTestAccountError> => {
  const error = await call.then(() => { throw new Error("expected a refusal"); }, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(AwsTestAccountError);
  return error as AwsTestAccountError;
};

describe("the session", () => {
  it("assumes the customer's role for an hour with the account's own external id, a policy of exactly the approved actions and resources, and a task session name", async () => {
    const { port, calls } = aws();
    const session = await open(port);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ RoleArn: DYNAMO_ROLE, DurationSeconds: 3_600, RoleSessionName: "rovara-task1234abcd9-orders-dev", ExternalId: `rovara-${ORG}-orders-dev` });
    expect(calls[0]).not.toHaveProperty("SourceIdentity");
    expect(JSON.parse(calls[0]!["Policy"] as string)).toEqual({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:PutItem"], Resource: DYNAMO_TABLE, Condition: { StringEquals: { "aws:RequestedRegion": "us-west-2" } } }] });
    expect(AWS_TEST_ACCOUNT_SESSION_SECONDS).toBe(3_600);
    expect(session.credentials.accessKeyId).toBe(["ASIA", "EXAMPLE"].join(""));
    expect(session.expiresAtMs).toBe(NOW + 3_600_000);
    expect(session.hosts).toEqual(["dynamodb.us-west-2.amazonaws.com"]);
    expect(session.region).toBe("us-west-2");
  });

  it("refuses before any AWS call: Rovara's own account (the deployment's, or any listed), production in any field, a record that is not an AWS role account, and one that is not usable", async () => {
    const cases: Array<[string, AwsTestAccountPort | undefined, TestAccount | undefined, TestEnvProdDeny | undefined]> = [
      ["own_account", undefined, account({ aws: awsBlock({ roleArn: "arn:aws:iam::999988887777:role/x", resources: ["arn:aws:dynamodb:us-west-2:999988887777:table/t"] }) }), undefined],
      ["own_account", undefined, account({ aws: awsBlock({ roleArn: "arn:aws:iam::888800008888:role/x", resources: ["arn:aws:dynamodb:us-west-2:888800008888:table/t"] }) }), undefined],
      ["own_account", aws({ ownAccountId: undefined }).port, undefined, undefined],
      ["production", undefined, account({ aws: awsBlock({ roleArn: "arn:aws:iam::111122223333:role/x", resources: ["arn:aws:dynamodb:us-west-2:111122223333:table/t"] }) }), undefined],
      ["production", undefined, undefined, { accountIds: [], hosts: [], arnPrefixes: ["arn:aws:dynamodb:us-west-2:222233334444:table/orders-*"] }],
      ["production", undefined, undefined, { accountIds: [], hosts: ["dynamodb.us-west-2.amazonaws.com"], arnPrefixes: [] }],
      ["production", undefined, undefined, { accountIds: [], hosts: [], arnPrefixes: [] }],
      ["not_aws_account", undefined, account({ kind: "api_key", aws: undefined, family: "http:api.example-pay.com", hosts: ["api.example-pay.com"] }), undefined],
      ["not_usable", undefined, account({ status: "suspended" }), undefined],
      ["not_usable", undefined, account({ status: "pending" }), undefined],
      ["not_usable", undefined, account({ expiresAt: new Date(NOW - 1).toISOString() }), undefined],
      ["not_usable", undefined, { ...account(), approvals: account().approvals.slice(0, 1) }, undefined],
      ["not_usable", undefined, { ...account(), aws: awsBlock({ actions: ["dynamodb:GetItem", "dynamodb:Scan"] }) }, undefined],
    ];
    for (const [code, port, record, prodDeny] of cases) {
      const fake = aws();
      const error = await refusalOf(open(port ?? fake.port, { ...(record === undefined ? {} : { account: record }), ...(prodDeny === undefined ? {} : { prodDeny }) }));
      expect(error.code, `${code} ${JSON.stringify(record?.aws?.roleArn)}`).toBe(code);
      expect(fake.calls, code).toHaveLength(0);
      for (const word of ["222233334444", "999988887777", "111122223333", "arn:"]) expect(error.message).not.toContain(word);
    }
  });

  it("is off with the ta switch: nothing is checked, opened or sent to AWS", async () => {
    const fake = aws({ enabled: () => false });
    const error = await open(fake.port).then(() => undefined, (caught: unknown) => caught as { code?: string; message: string });
    expect(error).toMatchObject({ code: "NOT_FOUND" });
    expect(error?.message).toContain("Not found");
    expect(fake.calls).toHaveLength(0);
    // Evaluated at every call, not once.
    let on = true;
    const flipping = aws({ enabled: () => on });
    await open(flipping.port);
    on = false;
    await expect(open(flipping.port)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(flipping.calls).toHaveLength(1);
  });

  it("H1: always sends the external id derived from the request's company and the account, and one company can never cause another's", async () => {
    const OTHER = `org_${"z9y8x7w6v5".repeat(2)}`;
    // The same account under the right company: the derived id, exactly.
    const own = aws();
    await open(own.port);
    expect(own.calls.map((call) => call["ExternalId"])).toEqual([`rovara-${ORG}-orders-dev`]);
    // Company A asking for company B's account: refused before anything is sent.
    const foreignAccount = account({ orgId: OTHER, aws: awsBlock({ externalId: `rovara-${OTHER}-orders-dev` }) });
    const cross = aws();
    expect((await refusalOf(open(cross.port, { orgId: ORG, account: foreignAccount }))).code).toBe("bad_role");
    expect(cross.calls).toHaveLength(0);
    // Company B asking for its own account carries B's id and nobody else's.
    const second = aws();
    await open(second.port, { orgId: OTHER, account: foreignAccount });
    expect(second.calls.map((call) => call["ExternalId"])).toEqual([`rovara-${OTHER}-orders-dev`]);
    // A record that holds another company's id, a customer-chosen id or another account's id is refused, however it got there.
    for (const externalId of [`rovara-${OTHER}-orders-dev`, "ext-0123456789", `rovara-${ORG}-orders-files`, "rovara-org_", ""]) {
      const tampered = aws();
      // Stamped with the id it holds (so the approvals still cover the record): only the id itself is wrong.
      const stampedWithIt = account({ aws: awsBlock({ externalId }) });
      expect((await refusalOf(open(tampered.port, { account: stampedWithIt }))).code, externalId).toBe("external_id");
      // The same record with its stamp left behind is not usable either.
      const stale = { ...account(), aws: awsBlock({ externalId }) } as unknown as TestAccount;
      expect(["external_id", "not_usable"], externalId).toContain((await refusalOf(open(tampered.port, { account: stale }))).code);
      expect(tampered.calls, externalId).toHaveLength(0);
    }
    // The record that really is in the store, only its external id changed after the approval stamped it: the stamp no longer matches, and the id would not either.
    const stamped = account();
    const swapped = { ...stamped, aws: { ...stamped.aws!, externalId: `rovara-${OTHER}-orders-dev` } } as TestAccount;
    const swappedPort = aws();
    await refusalOf(open(swappedPort.port, { account: swapped }));
    expect(swappedPort.calls).toHaveLength(0);
    // Every id that is ever sent starts with what the broker's grant requires (`sts:ExternalId` like `rovara-org_*`).
    for (const call of [...own.calls, ...second.calls]) expect(String(call["ExternalId"])).toMatch(/^rovara-org_[a-z0-9]{20}-[a-z0-9_-]+$/u);
  });

  it("names the session by a fixed shape of the task and the account, with nothing a person typed and no source identity", async () => {
    const fake = aws();
    await open(fake.port, { taskId: "TASK 12/34\n; drop table" });
    const name = String(fake.calls[0]!["RoleSessionName"]);
    expect(name).toBe("rovara-TASK1234droptabl-orders-dev");
    expect(name).toMatch(/^[\w+=,.@-]{2,64}$/u);
    expect(fake.calls[0]).not.toHaveProperty("SourceIdentity");
    const long = aws();
    await open(long.port, { taskId: "x".repeat(200) });
    expect(String(long.calls[0]!["RoleSessionName"]).length).toBeLessThanOrEqual(64);
    const empty = aws();
    await open(empty.port, { taskId: "!!!" });
    expect(String(empty.calls[0]!["RoleSessionName"])).toBe("rovara-task-orders-dev");
  });

  it("L7: limits each statement to the account's region, and the policy of a real account still fits", async () => {
    const policy = JSON.parse(awsTestAccountSessionPolicy(awsBlock({ region: "eu-central-1", resources: ["arn:aws:dynamodb:eu-central-1:222233334444:table/t"] }))) as { Statement: Array<{ Condition: unknown }> };
    expect(policy.Statement.every((statement) => JSON.stringify(statement.Condition) === JSON.stringify({ StringEquals: { "aws:RequestedRegion": "eu-central-1" } }))).toBe(true);
    const four = awsBlock({
      actions: ["dynamodb:GetItem", "dynamodb:PutItem", "s3:GetObject", "s3:ListBucket", "sqs:SendMessage", "sqs:ReceiveMessage", "sns:Publish"],
      resources: [DYNAMO_TABLE, "arn:aws:s3:::orders-test-bucket", "arn:aws:s3:::orders-test-bucket/*", "arn:aws:sqs:us-west-2:222233334444:orders-queue", "arn:aws:sns:us-west-2:222233334444:orders-topic"],
    });
    const text = awsTestAccountSessionPolicy(four);
    expect((JSON.parse(text) as { Statement: unknown[] }).Statement).toHaveLength(4);
    expect(text.length).toBeLessThanOrEqual(SESSION_POLICY_MAX_CHARS);
  });

  it("refuses any kind but an AWS role account, even when the record carries an AWS block", async () => {
    const fake = aws();
    const odd = { ...account(), kind: "api_key" } as unknown as TestAccount;
    expect((await refusalOf(open(fake.port, { account: odd }))).code).toBe("not_aws_account");
    expect(fake.calls).toHaveLength(0);
  });

  it("uses the company's shorter expiry window when it has one", async () => {
    const { port } = aws();
    // Approved a day ago, expiring in 30 days: 31 days from its last approval. A 7-day company window refuses it.
    expect((await refusalOf(open(port, { maxExpiryDays: 7 }))).code).toBe("not_usable");
    await expect(open(port, { maxExpiryDays: 90 })).resolves.toBeDefined();
  });

  it("refuses an AWS block the contract refuses, a host that is not a regional endpoint of an approved service, and an action with no resource of its service", async () => {
    const wildcard = account({ aws: awsBlock({ resources: ["arn:aws:dynamodb:us-west-2:222233334444:table/*"] }) });
    const offList = account({ aws: awsBlock({ actions: ["dynamodb:DeleteTable"] }) });
    const wildAction = account({ aws: awsBlock({ actions: ["dynamodb:*"] }) });
    const anyHost = account({ hosts: ["dynamodb.us-west-2.amazonaws.com", "evil.example.com"] });
    const otherRegion = account({ hosts: ["dynamodb.us-east-1.amazonaws.com"] });
    for (const record of [wildcard, offList, wildAction, anyHost, otherRegion]) {
      const fake = aws();
      expect((await refusalOf(open(fake.port, { account: record }))).code).toBe("bad_role");
      expect(fake.calls).toHaveLength(0);
    }
    // The same checks stand on their own, for a record that did not come through the schema (usable is not asked).
    expect(() => awsTestAccountSessionPolicy(awsBlock({ actions: ["dynamodb:DeleteTable"] }) as never)).toThrow(AwsTestAccountError);
    expect(() => awsTestAccountSessionPolicy(awsBlock({ actions: ["dynamodb:GetItem", "sqs:SendMessage"] }) as never)).toThrow(AwsTestAccountError);
    expect(() => awsTestAccountHosts({ hosts: ["dynamodb.us-west-2.amazonaws.com", "evil.example.com"], aws: awsBlock() })).toThrow(AwsTestAccountError);
    expect(() => awsTestAccountHosts({ hosts: ["*.amazonaws.com"], aws: awsBlock() })).toThrow(AwsTestAccountError);
    expect(() => awsTestAccountHosts({ hosts: [], aws: awsBlock() })).toThrow(AwsTestAccountError);
    expect(() => awsTestAccountHosts({ hosts: ["dynamodb.us-west-2.amazonaws.com"], aws: undefined })).toThrow(AwsTestAccountError);
  });

  it("answers AWS's refusal and an outage in fixed words that hold no ARN, message or credential", async () => {
    const denied = await refusalOf(open(aws({ assumeRole: () => Promise.reject(Object.assign(new Error(`not authorized for ${DYNAMO_ROLE}`), { name: "AccessDenied" })) }).port));
    expect(denied.code).toBe("refused");
    expect(denied.retryable).toBe(false);
    expect(denied.message).not.toContain("222233334444");
    const malformed = await refusalOf(open(aws({ assumeRole: () => Promise.reject(Object.assign(new Error("policy"), { name: "MalformedPolicyDocument" })) }).port));
    expect(malformed.code).toBe("refused");
    const outage = await refusalOf(open(aws({ assumeRole: () => Promise.reject(new Error("socket hang up")) }).port));
    expect(outage).toMatchObject({ code: "unreachable", retryable: true });
  });

  it("does not use a session that is empty, already over, or longer than asked", async () => {
    for (const bad of [creds({ sessionToken: "" }), creds({ accessKeyId: "" }), creds({ secretAccessKey: "" }), creds({ expiration: new Date(NOW - 1) }), creds({ expiration: new Date(NOW) }), creds({ expiration: new Date(NOW + 12 * 3_600_000) }), creds({ expiration: new Date("nope") }), {} as AssumedCredentials]) {
      const error = await refusalOf(open(aws({ assumeRole: () => Promise.resolve(bad) }).port));
      expect(error.code).toBe("bad_session");
      expect(error.retryable).toBe(false);
    }
  });

  it("has a fixed message for every code, and none holds an ARN", () => {
    for (const code of AWS_TEST_ACCOUNT_CODES) expect(new AwsTestAccountError(code).message).not.toMatch(/arn:|\d{12}/u);
    expect(awsTestAccountMessage(new AwsTestAccountError("production"))).toMatch(/production/u);
    expect(awsTestAccountMessage(new Error("anything"))).toBe(new AwsTestAccountError("unreachable").message);
  });
});

describe("the session policy", () => {
  const two = awsBlock({
    actions: ["dynamodb:PutItem", "s3:GetObject", "dynamodb:GetItem", "s3:ListBucket"],
    resources: ["arn:aws:s3:::orders-test-bucket/*", "arn:aws:s3:::orders-test-bucket", DYNAMO_TABLE, "arn:aws:dynamodb:us-west-2:222233334444:table/orders-test/index/*"],
  });
  it("gives each service only its own actions on its own resources, sorted, with no wildcard action and nothing the record does not hold", () => {
    expect(JSON.parse(awsTestAccountSessionPolicy(two as never))).toEqual({
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:PutItem"], Resource: [DYNAMO_TABLE, "arn:aws:dynamodb:us-west-2:222233334444:table/orders-test/index/*"], Condition: REGION },
        { Effect: "Allow", Action: ["s3:GetObject", "s3:ListBucket"], Resource: ["arn:aws:s3:::orders-test-bucket", "arn:aws:s3:::orders-test-bucket/*"], Condition: REGION },
      ],
    });
    const text = awsTestAccountSessionPolicy(two);
    expect(text).not.toContain('"Action":"*"');
    expect(text).not.toMatch(/"[a-z0-9]+:\*"/u);
    expect(text).not.toContain("NotAction");
    expect(text).not.toContain("Deny");
  });
  it("is the same text for the same record whatever the order of its lists", () => {
    const reordered = awsBlock({ actions: [...(two.actions)].reverse(), resources: [...(two.resources)].reverse() });
    expect(awsTestAccountSessionPolicy(reordered as never)).toBe(awsTestAccountSessionPolicy(two as never));
  });
  it("refuses a policy that does not fit STS's limit instead of cutting it", () => {
    const many = awsBlock({
      actions: ["s3:GetObject"],
      resources: Array.from({ length: 20 }, (_, i) => `arn:aws:s3:::orders-test-bucket-${"x".repeat(40)}-${String(i)}/${"reports/".repeat(8)}*`),
    });
    expect(() => awsTestAccountSessionPolicy(many as never)).toThrow(expect.objectContaining({ code: "too_large" }));
    expect(SESSION_POLICY_MAX_CHARS).toBe(2_048);
    expect(awsTestAccountSessionPolicy(awsBlock() as never).length).toBeLessThan(SESSION_POLICY_MAX_CHARS);
  });
  it("covers the other services of the allow-list the same way", () => {
    const sqs = awsBlock({ actions: ["sqs:SendMessage", "sqs:ReceiveMessage"], resources: ["arn:aws:sqs:us-west-2:222233334444:orders-queue"] });
    expect((JSON.parse(awsTestAccountSessionPolicy(sqs as never)) as { Statement: unknown[] }).Statement).toEqual([{ Effect: "Allow", Action: ["sqs:ReceiveMessage", "sqs:SendMessage"], Resource: "arn:aws:sqs:us-west-2:222233334444:orders-queue", Condition: REGION }]);
    const sagemaker = awsBlock({ actions: ["sagemaker:InvokeEndpoint"], resources: ["arn:aws:sagemaker:us-west-2:222233334444:endpoint/partner-scorer"] });
    expect((JSON.parse(awsTestAccountSessionPolicy(sagemaker as never)) as { Statement: Array<{ Action: string[] }> }).Statement[0]!.Action).toEqual(["sagemaker:InvokeEndpoint"]);
  });
});

describe("the proxy's hosts", () => {
  it("are the regional endpoints of exactly the approved services, one for each", () => {
    const record = account({
      family: "aws:s3", aws: awsBlock({ actions: ["s3:GetObject", "dynamodb:GetItem"], resources: ["arn:aws:s3:::orders-test-bucket/*", DYNAMO_TABLE] }),
      hosts: ["dynamodb.us-west-2.amazonaws.com", "s3.us-west-2.amazonaws.com"],
    });
    expect(awsTestAccountHosts(record).sort()).toEqual(["dynamodb.us-west-2.amazonaws.com", "s3.us-west-2.amazonaws.com"]);
    expect(awsTestAccountHosts(account({ aws: awsBlock({ region: "us-west-2" }), hosts: ["dynamodb.us-west-2.amazonaws.com"] }))).toEqual(["dynamodb.us-west-2.amazonaws.com"]);
  });
  it("never include a service the account does not approve, another region, or a wildcard", () => {
    for (const hosts of [["sqs.us-west-2.amazonaws.com"], ["dynamodb.us-east-1.amazonaws.com"], ["*.amazonaws.com"], ["amazonaws.com"], ["bucket.s3.us-west-2.amazonaws.com"], ["dynamodb.us-west-2.amazonaws.com.evil.com"]]) {
      expect(() => awsTestAccountHosts({ hosts, aws: awsBlock() }), JSON.stringify(hosts)).toThrow(AwsTestAccountError);
    }
  });
});

describe("the probe", () => {
  it("is ok for a 2xx answer and fails with a fixed reason for an error status, a throw, or a hang", async () => {
    expect(await probePreprod(() => Promise.resolve({ status: 200 }))).toEqual({ ok: true });
    expect(await probePreprod(() => Promise.resolve({ status: 503 }))).toEqual({ ok: false, reason: "error_status" });
    expect(await probePreprod(() => Promise.reject(new Error("ECONNREFUSED 10.0.0.1")))).toEqual({ ok: false, reason: "unreachable" });
    expect(await probePreprod((signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))), 20)).toEqual({ ok: false, reason: "timeout" });
  });
  it("uses the first recorded request as its canned payload, and has none without a recording", () => {
    expect(probeRequestOf({ entries: [{ requestHash: sha("a"), request: { contentType: "application/json", body: '{"partner":"p1"}' }, response: { status: 200, contentType: "application/json", body: "{}", latencyMs: 0 } }] })).toEqual({ contentType: "application/json", body: '{"partner":"p1"}' });
    expect(probeRequestOf({ entries: [] })).toBeUndefined();
  });
});

describe("modes", () => {
  const mock = { mock: { fixtureSetRef: sha("a"), schemaRef: sha("b"), unmatched: "fail" } };
  const services = body([
    { ...service({ name: "a-preprod" }) },
    { name: "b-auto", kind: "sagemaker_runtime", match: { endpointName: "b" }, mode: "auto", preprod: { endpointArn: "arn:aws:sagemaker:us-west-2:222233334444:endpoint/b", roleArn: ROLE, region: "us-west-2" }, ...mock },
    { name: "c-mock", kind: "sagemaker_runtime", match: { endpointName: "c" }, mode: "mock", ...mock },
  ]).services;
  it("preprod uses pre-prod, auto follows its probe, mock never looks", () => {
    const ok = resolveRoundModes(services, new Map([["a-preprod", { ok: true as const }], ["b-auto", { ok: true as const }]]));
    expect(ok).toEqual({ ok: true, modes: [{ name: "a-preprod", mode: "preprod", reason: "configured_preprod" }, { name: "b-auto", mode: "preprod", reason: "probe_ok" }, { name: "c-mock", mode: "mocked", reason: "configured_mock" }] });
    const fallback = resolveRoundModes(services, new Map([["a-preprod", { ok: true as const }], ["b-auto", { ok: false as const, reason: "timeout" as const }]]));
    expect(fallback).toMatchObject({ ok: true, modes: [{}, { name: "b-auto", mode: "mocked", reason: "probe_failed_fell_back" }, {}] });
  });
  it("a preprod service that cannot be reached fails the round, and a service with no probe counts as unreachable", () => {
    expect(resolveRoundModes(services, new Map([["a-preprod", { ok: false as const, reason: "unreachable" as const }]]))).toEqual({ ok: false, code: "preprod_unreachable", service: "a-preprod" });
    expect(resolveRoundModes(services, new Map())).toEqual({ ok: false, code: "preprod_unreachable", service: "a-preprod" });
    const auto = resolveRoundModes(services.slice(1), new Map());
    expect(auto).toMatchObject({ ok: true, modes: [{ mode: "mocked", reason: "probe_failed_fell_back" }, { mode: "mocked" }] });
  });
  it("retries a failed round once, then asks a person", () => {
    expect([preprodUnreachableNextStep(0), preprodUnreachableNextStep(1), preprodUnreachableNextStep(5)]).toEqual(["retry", "ask_card", "ask_card"]);
  });
  it("the evidence shows the mode USED, the fixture revision of a mocked service only, and the unrecorded answers it gave", () => {
    const decisions = [{ name: "a-preprod", mode: "preprod" as const, reason: "configured_preprod" as const }, { name: "b-auto", mode: "mocked" as const, reason: "probe_failed_fell_back" as const }];
    const entries = evidenceServices(decisions, new Map([["a-preprod", { revision: 9, recordedAt: "2026-10-01T00:00:00.000Z" }], ["b-auto", { revision: 2, recordedAt: "2026-11-02T00:00:00.000Z" }]]), new Map([["b-auto", 3], ["a-preprod", 4]]));
    expect(entries).toEqual([{ name: "a-preprod", mode: "preprod" }, { name: "b-auto", mode: "mocked", fixtureRevision: 2, recordedAt: "2026-11-02T00:00:00.000Z", unrecordedAnswered: 3 }]);
    expect(EvidenceEnvironmentSchema.safeParse({ tier: "sandbox", envRevision: 1, services: entries, data: "synthetic", accounts: [] }).success).toBe(true);
  });
  it("lists the task's new mock answers with the digest the broker pinned them by (owner Q9), for a mocked service only", () => {
    const decisions = [{ name: "a-preprod", mode: "preprod" as const, reason: "configured_preprod" as const }, { name: "b-auto", mode: "mocked" as const, reason: "probe_failed_fell_back" as const }];
    const additions = new Map([["a-preprod", { count: 2, digest: sha("d") }], ["b-auto", { count: 3, digest: sha("e") }]]);
    const entries = evidenceServices(decisions, new Map(), new Map(), additions);
    expect(entries).toEqual([{ name: "a-preprod", mode: "preprod" }, { name: "b-auto", mode: "mocked", newAnswers: 3, newAnswersDigest: sha("e") }]);
    expect(EvidenceEnvironmentSchema.safeParse({ tier: "sandbox", envRevision: 1, services: entries, data: "synthetic", accounts: [] }).success).toBe(true);
    expect(evidenceServices(decisions, new Map(), new Map())[1]).toEqual({ name: "b-auto", mode: "mocked" });
  });
});
