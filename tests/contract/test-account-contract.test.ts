// Test services TS4 (contract): the test-account record (a reference, never a value), the org-tagged secret name, the key-shape table that refuses live-shaped keys, and the production deny-list checks.
// Every key-shaped string below is built at runtime from parts: the public repository's push protection refuses a key-shaped literal.
import { describe, expect, it } from "vitest";
import * as acc from "../../packages/contracts/src/test-account.js";

const ORG = `org_${"a1b2c3d4e5".repeat(2)}`;
const OTHER_ORG = `org_${"z9y8x7w6v5".repeat(2)}`;
const person = (letter: string) => letter.repeat(64);
const approval = (by: string, over: Record<string, unknown> = {}) => ({ by: person(by), at: "2026-11-02T10:00:00.000Z", freshSignIn: true, kind: "approver", ...over });
const ref = (over: { env?: string; org?: string; id?: string; key?: string } = {}) => acc.testAccountSecretRef(over.env ?? "staging", over.org ?? ORG, over.id ?? "payments-test", over.key ?? "apiKey");
const account = (over: Record<string, unknown> = {}) => ({
  id: "payments-test", orgId: ORG, projectIds: ["orders", "billing"], family: "http:api.example-pay.com", label: "Payments test mode", kind: "api_key", secretRef: ref(),
  hosts: ["api.example-pay.com"], envNames: ["PAYMENTS_API_KEY"], limits: { maxRequestsPerRun: 2_000, maxRequestsPerDay: 20_000, maxConcurrentRounds: 2 },
  approvals: [approval("a"), approval("b")], status: "active", expiresAt: "2027-01-30T10:00:00.000Z", ...over,
});
const awsBlock = (over: Record<string, unknown> = {}) => ({
  roleArn: "arn:aws:iam::222233334444:role/rovara-test", externalId: "ext-0123456789", region: "us-west-2", actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
  resources: ["arn:aws:dynamodb:us-west-2:222233334444:table/orders-test"], ...over,
});
const awsAccount = (over: Record<string, unknown> = {}) => account({ id: "orders-dev", family: "aws:dynamodb", label: "Dev AWS (orders)", kind: "aws_role", secretRef: undefined, aws: awsBlock(), hosts: ["dynamodb.us-west-2.amazonaws.com"], envNames: [], ...over });
const ok = (value: unknown) => acc.TestAccountSchema.safeParse(value).success;
const parsed = (value: Record<string, unknown>) => acc.TestAccountSchema.parse(value);
const deny = (over: Partial<{ accountIds: string[]; hosts: string[]; arnPrefixes: string[] }> = {}) => ({ accountIds: [], hosts: [], arnPrefixes: [], ...over });
// Key-shaped values, built here so no literal in this file is one.
const build = (...parts: string[]) => parts.join("");
const rand = (length: number) => "Qk7mP2xR9vLw4NtY8bZc3HdF6gJs1VaUeXoI5".repeat(3).slice(0, length);
const stripeLive = () => build("sk", "_", "live", "_", rand(24));
const stripeTest = () => build("sk", "_", "test", "_", rand(24));
const awsKeyId = (prefix = "AKIA") => build(prefix, "ABCDEFGHIJKLMNOP");

describe("TestAccount record", () => {
  it("accepts an active API-key account and round-trips it", () => {
    expect(acc.TestAccountSchema.parse(account())).toEqual(account());
  });
  it("is strict: no member can hold a value", () => {
    for (const key of ["value", "secret", "token", "apiKey", "password", "secretValue", "credentials", "key"]) expect(ok({ ...account(), [key]: "x" }), key).toBe(false);
    expect(ok({ ...account(), aws: awsBlock() })).toBe(false);
    expect(ok(awsAccount({ aws: { ...awsBlock(), secretAccessKey: "x" } }))).toBe(false);
    expect(ok(account({ limits: { maxRequestsPerRun: 1, maxRequestsPerDay: 1, maxConcurrentRounds: 1, extra: 1 } }))).toBe(false);
    expect(ok(account({ approvals: [{ ...approval("a"), extra: 1 }, approval("b")] }))).toBe(false);
  });
  it("needs the secret reference for an API key, an OAuth client and a basic account, but not for a pre-prod endpoint", () => {
    for (const kind of ["api_key", "oauth_client", "basic"]) {
      expect(ok(account({ kind })), kind).toBe(true);
      expect(ok(account({ kind, secretRef: undefined })), kind).toBe(false);
    }
    expect(ok(account({ kind: "preprod_endpoint", secretRef: undefined, envNames: [] }))).toBe(true);
  });

  describe("secret reference", () => {
    it("must be a test-account reference at all", () => {
      for (const secretRef of ["", "plain-value", stripeTest(), "{{resolve:secretsmanager:agentx/staging/org-connectors/" + ORG + "/payments-test:SecretString:apiKey}}", "{{resolve:ssm:/x}}", "agentx/staging/org-test-accounts/x/y"]) expect(ok(account({ secretRef })), secretRef.slice(0, 20)).toBe(false);
    });
    it("must point at this org's own path", () => {
      expect(ok(account({ secretRef: ref({ org: OTHER_ORG }) }))).toBe(false);
    });
    it("must point at this account's own secret", () => {
      expect(ok(account({ secretRef: ref({ id: "someone-elses" }) }))).toBe(false);
    });
    it("is refused with extra segments or traversal", () => {
      const base = `{{resolve:secretsmanager:agentx/staging/org-test-accounts/${ORG}/payments-test:SecretString:apiKey}}`;
      expect(ok(account({ secretRef: base }))).toBe(true);
      for (const bad of [base.replace("payments-test", "payments-test/../x"), base.replace("/payments-test", "/a/payments-test"), base.replace("apiKey", "api/Key"), base.replace(":SecretString:apiKey", ""), `${base} `, ` ${base}`, base.replace("}}", ":v1}}"), base.replace("staging", "../staging")]) expect(ok(account({ secretRef: bad })), bad).toBe(false);
    });
    it("is refused on an AWS role account, which stores no secret", () => {
      expect(ok(awsAccount({ secretRef: ref({ id: "orders-dev" }) }))).toBe(false);
    });
  });

  describe("kinds, families and the AWS block", () => {
    it("accepts an AWS role account and needs the block exactly for that kind", () => {
      expect(ok(awsAccount())).toBe(true);
      expect(ok(awsAccount({ aws: undefined }))).toBe(false);
      expect(ok(account({ aws: awsBlock() }))).toBe(false);
    });
    it("keeps AWS families to AWS accounts and http families to the others", () => {
      expect(ok(account({ family: "aws:dynamodb" }))).toBe(false);
      expect(ok(awsAccount({ family: "http:api.example-pay.com" }))).toBe(false);
      expect(ok(account({ family: "postgres" }))).toBe(false);
      // The account's own host listed and its action approved is not enough: an AWS role account is for an AWS family.
      expect(ok(awsAccount({ family: "http:dynamodb.us-west-2.amazonaws.com" }))).toBe(false);
    });
    it("lists the account's own host for an http family, and its own service's action for an AWS family", () => {
      expect(ok(account({ hosts: ["other.example-pay.com"] }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ actions: ["s3:GetObject"] }) }))).toBe(false);
      expect(ok(awsAccount({ family: "aws:sagemaker-runtime", aws: awsBlock({ actions: ["sagemaker:InvokeEndpoint"], resources: ["arn:aws:sagemaker:us-west-2:222233334444:endpoint/scorer"] }), hosts: ["runtime.sagemaker.us-west-2.amazonaws.com"] }))).toBe(true);
    });
    it("has explicit actions only: no wildcard, no access-granting service", () => {
      for (const action of ["*", "dynamodb:*", "dynamodb:Get*", "dynamodb", "dynamodb:Get Item", "DynamoDB:GetItem:x"]) expect(ok(awsAccount({ aws: awsBlock({ actions: [action, "dynamodb:GetItem"] }) })), action).toBe(false);
      for (const action of ["iam:PassRole", "sts:AssumeRole", "organizations:ListAccounts", "account:GetContactInformation", "sso:ListInstances", "identitystore:ListUsers"]) expect(ok(awsAccount({ aws: awsBlock({ actions: ["dynamodb:GetItem", action] }) })), action).toBe(false);
    });
    it("names its resources: in the role's own account, never a whole service", () => {
      expect(ok(awsAccount({ aws: awsBlock({ resources: ["arn:aws:s3:::orders-test-bucket/*"] }), family: "aws:s3", hosts: ["s3.us-west-2.amazonaws.com"] }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ resources: ["arn:aws:dynamodb:us-west-2:999988887777:table/orders-test"] }) }))).toBe(false);
      for (const resource of ["*", "arn:aws:dynamodb:us-west-2:222233334444:*", "arn:aws:dynamodb:*:*:*"]) expect(ok(awsAccount({ aws: awsBlock({ resources: [resource] }) })), resource).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ resources: ["arn:aws:dynamodb:us-west-2:222233334444:table/orders-*"] }) }))).toBe(true);
    });
    it("takes a role ARN, an external id and a region in their shapes, each list once and bounded", () => {
      expect(ok(awsAccount({ aws: awsBlock({ roleArn: "arn:aws:iam::222233334444:user/x" }) }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ externalId: "short" }) }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ externalId: "has space in it" }) }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ region: "US_WEST" }) }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ actions: ["dynamodb:GetItem", "dynamodb:GetItem"] }) }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ resources: ["arn:aws:dynamodb:us-west-2:222233334444:table/t1", "arn:aws:dynamodb:us-west-2:222233334444:table/t1"] }) }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ actions: [] }) }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ resources: [] }) }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ actions: Array.from({ length: 21 }, (_, n) => `dynamodb:Op${String(n)}`) }) }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ resources: Array.from({ length: 21 }, (_, n) => `arn:aws:dynamodb:us-west-2:222233334444:table/t${String(n)}`) }) }))).toBe(false);
    });
    it("reaches only the regional endpoints of its own region, and has no variable of its own", () => {
      for (const host of ["dynamodb.us-east-1.amazonaws.com", "dynamodb.amazonaws.com", "api.example-pay.com", "evil-dynamodb.us-west-2.amazonaws.com.example.net"]) expect(ok(awsAccount({ hosts: [host] })), host).toBe(false);
      expect(ok(awsAccount({ hosts: ["dynamodb.us-west-2.amazonaws.com", "s3.us-west-2.amazonaws.com"] }))).toBe(true);
      expect(ok(awsAccount({ hosts: ["dynamodb.us-west-2.amazonaws.com", "evil.example.dynamodb.us-west-2.amazonaws.com"] }))).toBe(false);
      expect(ok(awsAccount({ hosts: [] }))).toBe(false);
      expect(ok(awsAccount({ envNames: ["ORDERS_KEY"] }))).toBe(false);
    });
  });

  describe("hosts", () => {
    it("are plain lower-case names: no address, wildcard, port, path, credentials or trailing dot", () => {
      for (const host of ["10.0.0.1", "192.168.1.5", "*.example-pay.com", "api.example-pay.com:443", "api.example-pay.com/v1", "user@api.example-pay.com", "api.example-pay.com.", "API.example-pay.com", "localhost", "https://api.example-pay.com", "a b.example.com", "-a.example.com", `${"a".repeat(64)}.example.com`]) expect(ok(account({ family: "http:api.example-pay.com", hosts: ["api.example-pay.com", host] })), host).toBe(false);
    });
    it("are at most 253 characters long", () => {
      const long = `${Array.from({ length: 4 }, () => "a".repeat(63)).join(".")}.com`;
      expect(long.length).toBeGreaterThan(253);
      expect(ok(account({ hosts: ["api.example-pay.com", long] }))).toBe(false);
    });
    it("are one to eight, each once", () => {
      expect(ok(account({ hosts: [] }))).toBe(false);
      expect(ok(account({ hosts: ["api.example-pay.com", "api.example-pay.com"] }))).toBe(false);
      expect(ok(account({ hosts: ["api.example-pay.com", ...Array.from({ length: 8 }, (_, n) => `h${String(n)}.example-pay.com`)] }))).toBe(false);
      expect(ok(account({ hosts: ["api.example-pay.com", ...Array.from({ length: 7 }, (_, n) => `h${String(n)}.example-pay.com`)] }))).toBe(true);
    });
  });

  describe("variables", () => {
    it("are names the test reads, not ones Rovara or the system owns, listed once, at most four", () => {
      for (const name of ["AWS_SECRET_ACCESS_KEY", "PATH", "HTTPS_PROXY", "NODE_OPTIONS", "LD_PRELOAD", "lower_case", ""]) expect(ok(account({ envNames: [name] })), name).toBe(false);
      expect(ok(account({ envNames: ["PAYMENTS_API_KEY", "PAYMENTS_API_KEY"] }))).toBe(false);
      expect(ok(account({ envNames: ["A", "B", "C", "D", "E"] }))).toBe(false);
      expect(ok(account({ envNames: [] }))).toBe(true);
    });
  });

  describe("limits", () => {
    it("have defaults and Rovara maximums", () => {
      expect(acc.TEST_ACCOUNT_LIMIT_DEFAULTS).toEqual({ maxRequestsPerRun: 2_000, maxRequestsPerDay: 20_000, maxConcurrentRounds: 2 });
      expect(acc.TEST_ACCOUNT_LIMIT_MAXIMUMS).toMatchObject({ maxRequestsPerRun: 20_000, maxConcurrentRounds: 10 });
      expect(ok(account({ limits: acc.TEST_ACCOUNT_LIMIT_DEFAULTS }))).toBe(true);
    });
    it("stop at the maximums and at 1", () => {
      expect(ok(account({ limits: { maxRequestsPerRun: 20_000, maxRequestsPerDay: 20_000, maxConcurrentRounds: 10 } }))).toBe(true);
      expect(ok(account({ limits: { maxRequestsPerRun: 20_001, maxRequestsPerDay: 100_000, maxConcurrentRounds: 2 } }))).toBe(false);
      expect(ok(account({ limits: { maxRequestsPerRun: 100, maxRequestsPerDay: 1_000, maxConcurrentRounds: 11 } }))).toBe(false);
      expect(ok(account({ limits: { maxRequestsPerRun: 0, maxRequestsPerDay: 1_000, maxConcurrentRounds: 2 } }))).toBe(false);
      expect(ok(account({ limits: { maxRequestsPerRun: 100, maxRequestsPerDay: 1_000, maxConcurrentRounds: 0 } }))).toBe(false);
      expect(ok(account({ limits: { maxRequestsPerRun: 100, maxRequestsPerDay: 1_000_001, maxConcurrentRounds: 2 } }))).toBe(false);
      expect(ok(account({ limits: { maxRequestsPerRun: 1.5, maxRequestsPerDay: 1_000, maxConcurrentRounds: 2 } }))).toBe(false);
    });
    it("keep a run's requests inside the day's", () => {
      expect(ok(account({ limits: { maxRequestsPerRun: 5_000, maxRequestsPerDay: 4_999, maxConcurrentRounds: 2 } }))).toBe(false);
      expect(ok(account({ limits: { maxRequestsPerRun: 5_000, maxRequestsPerDay: 5_000, maxConcurrentRounds: 2 } }))).toBe(true);
    });
  });

  describe("projects", () => {
    it("are all of them, or one to fifty named ones, each once", () => {
      expect(ok(account({ projectIds: "all" }))).toBe(true);
      expect(ok(account({ projectIds: [] }))).toBe(false);
      expect(ok(account({ projectIds: ["orders", "orders"] }))).toBe(false);
      expect(ok(account({ projectIds: Array.from({ length: 51 }, (_, n) => `p${String(n)}`) }))).toBe(false);
      expect(ok(account({ projectIds: Array.from({ length: 50 }, (_, n) => `p${String(n)}`) }))).toBe(true);
      expect(ok(account({ projectIds: ["Bad Name"] }))).toBe(false);
      expect(ok(account({ projectIds: "some" }))).toBe(false);
    });
  });

  describe("approval and expiry", () => {
    it("makes an account active only with two different people's approvals", () => {
      expect(ok(account({ approvals: [approval("a")] }))).toBe(false);
      expect(ok(account({ approvals: [approval("a"), approval("a")] }))).toBe(false);
      expect(ok(account({ approvals: [] }))).toBe(false);
      expect(ok(account({ approvals: [approval("a"), approval("b")] }))).toBe(true);
    });
    it("allows the sole-owner exception with one person", () => {
      expect(ok(account({ approvals: [approval("a", { kind: "sole_owner_exception" })] }))).toBe(true);
      expect(acc.testAccountApprovalsSatisfied([approval("a") as never])).toBe(false);
      expect(acc.testAccountApprovalsSatisfied([approval("a", { kind: "sole_owner_exception" }) as never])).toBe(true);
      expect(acc.testAccountApprovalsSatisfied([approval("a") as never, approval("b") as never])).toBe(true);
      expect(acc.testAccountApprovalsSatisfied([])).toBe(false);
    });
    it("needs every approval to carry a fresh sign-in", () => {
      expect(ok(account({ approvals: [approval("a"), approval("b", { freshSignIn: false })] }))).toBe(false);
      expect(ok(account({ approvals: [approval("a"), { by: person("b"), at: "2026-11-02T10:00:00.000Z", kind: "approver" }] }))).toBe(false);
      expect(ok(account({ approvals: [approval("a"), approval("b", { by: "short" })] }))).toBe(false);
      expect(ok(account({ approvals: Array.from({ length: 11 }, (_, n) => approval(String(n % 10), {})) }))).toBe(false);
    });
    it("lets a pending, suspended or expired account lack approvals", () => {
      for (const status of ["pending", "suspended", "expired"]) expect(ok(account({ status, approvals: [], expiresAt: undefined })), status).toBe(true);
      expect(ok(account({ status: "pending", approvals: [approval("a")], expiresAt: undefined }))).toBe(true);
      expect(ok(account({ status: "frozen" }))).toBe(false);
    });
    it("expires an active account, after its last approval and within a year of it", () => {
      expect(ok(account({ expiresAt: undefined }))).toBe(false);
      expect(ok(account({ expiresAt: "2026-11-02T10:00:00.000Z" }))).toBe(false);
      expect(ok(account({ expiresAt: "2026-11-01T10:00:00.000Z" }))).toBe(false);
      expect(ok(account({ expiresAt: "2026-11-02T10:00:01.000Z" }))).toBe(true);
      expect(ok(account({ expiresAt: "2027-11-02T10:00:00.000Z" }))).toBe(true);
      expect(ok(account({ expiresAt: "2027-11-02T10:00:01.000Z" }))).toBe(false);
      expect(acc.TEST_ACCOUNT_EXPIRY_DAYS).toEqual({ default: 90, max: 365, reminder: 14 });
    });
    it("measures the year from the LATEST approval", () => {
      const later = approval("b", { at: "2026-12-02T10:00:00.000Z" });
      expect(ok(account({ approvals: [approval("a"), later], expiresAt: "2027-12-02T10:00:00.000Z" }))).toBe(true);
      expect(ok(account({ approvals: [later, approval("a")], expiresAt: "2027-12-02T10:00:01.000Z" }))).toBe(false);
      expect(ok(account({ approvals: [approval("a"), later], expiresAt: "2026-12-02T10:00:00.000Z" }))).toBe(false);
    });
    it("takes dates as dates", () => {
      expect(ok(account({ expiresAt: "next year" }))).toBe(false);
      expect(ok(account({ rotatedAt: "2026-11-03T00:00:00.000Z", lastUsedAt: "2026-11-04T00:00:00.000Z" }))).toBe(true);
      expect(ok(account({ rotatedAt: "yesterday" }))).toBe(false);
    });
  });

  describe("label", () => {
    it("is one plain line of at most 80 characters", () => {
      expect(ok(account({ label: "" }))).toBe(false);
      expect(ok(account({ label: "x".repeat(81) }))).toBe(false);
      expect(ok(account({ label: "two\nlines" }))).toBe(false);
    });
    it("is never the place for a key: any key shape, live or test, is refused", () => {
      for (const label of [`Key ${stripeLive()}`, `Key ${stripeTest()}`, `Key ${awsKeyId()}`, `Key ${awsKeyId("ASIA")}`, `tok ${build("gh", "p_", rand(30))}`, `tok ${build("xox", "b-", rand(20))}`, `jwt ${build("ey", "J", rand(20), ".", rand(20), ".", rand(20))}`, `pem ${build("-----", "BEGIN")} x`, `long ${rand(40)}`]) expect(ok(account({ label })), label.slice(0, 10)).toBe(false);
      expect(ok(account({ label: "Payments sandbox for the orders service" }))).toBe(true);
    });
  });
});

describe("secret name, tags and reference", () => {
  it("builds the org-tagged path", () => {
    expect(acc.testAccountSecretName("staging", ORG, "payments-test")).toBe(`agentx/staging/org-test-accounts/${ORG}/payments-test`);
    expect(acc.testAccountSecretPrefix("staging", ORG)).toBe(`agentx/staging/org-test-accounts/${ORG}/`);
    expect(acc.testAccountSecretName("staging", ORG, "payments-test").startsWith(acc.testAccountSecretPrefix("staging", ORG))).toBe(true);
  });
  it("keeps test-account secrets apart from connector and hook secrets", () => {
    expect(acc.testAccountSecretName("staging", ORG, "x1")).not.toContain("org-connectors");
    expect(acc.testAccountSecretName("staging", ORG, "x1")).not.toContain("org-hooks");
    expect(acc.TEST_ACCOUNT_SECRET_SEGMENT).toBe("org-test-accounts");
  });
  it("tags the secret with its org and its use", () => {
    expect(acc.testAccountSecretTags(ORG)).toEqual({ "rovara:org": ORG, "rovara:use": "test-account" });
    expect(() => acc.testAccountSecretTags("org_short")).toThrow(RangeError);
  });
  it("refuses any part that is not a plain segment, and never echoes it", () => {
    const bad: Array<[string, string, string]> = [["../x", ORG, "a1"], ["staging/x", ORG, "a1"], ["", ORG, "a1"], ["staging", "org_short", "a1"], ["staging", `${ORG}/..`, "a1"], ["staging", ORG, "../a1"], ["staging", ORG, "a/b"], ["staging", ORG, ""], ["staging", ORG, "A1"], ["staging", ORG, "a1\n"], ["staging", ORG, "a".repeat(65)], ["x".repeat(33), ORG, "a1"], ["st aging", ORG, "a1"]];
    for (const [env, org, id] of bad) {
      expect(() => acc.testAccountSecretName(env, org, id), `${env}|${org}|${id}`).toThrow(RangeError);
      try {
        acc.testAccountSecretName(env, org, id);
      } catch (error) {
        expect(String(error)).not.toContain("..");
        expect(String(error)).not.toContain(org === ORG ? "org_a1" : "\u0000never");
      }
    }
    expect(() => acc.testAccountSecretPrefix("staging", "org_short")).toThrow(RangeError);
    expect(() => acc.testAccountSecretPrefix("../x", ORG)).toThrow(RangeError);
  });
  it("builds a resolve reference and reads it back", () => {
    const reference = acc.testAccountSecretRef("staging", ORG, "payments-test", "apiKey");
    expect(reference).toBe(`{{resolve:secretsmanager:agentx/staging/org-test-accounts/${ORG}/payments-test:SecretString:apiKey}}`);
    expect(acc.parseTestAccountSecretRef(reference)).toEqual({ env: "staging", orgId: ORG, accountId: "payments-test", key: "apiKey" });
  });
  it("takes a plain JSON key", () => {
    for (const key of ["", "a/b", "a:b", "1abc", "a b", "a}}", "x".repeat(65)]) expect(() => acc.testAccountSecretRef("staging", ORG, "payments-test", key), key).toThrow(RangeError);
    expect(() => acc.testAccountSecretRef("staging", ORG, "payments-test", "client_secret-2")).not.toThrow();
  });
  it("reads back only an exact test-account reference", () => {
    expect(acc.parseTestAccountSecretRef(`{{resolve:secretsmanager:agentx/staging/org-connectors/${ORG}/payments-test:SecretString:apiKey}}`)).toBeUndefined();
    expect(acc.parseTestAccountSecretRef(`agentx/staging/org-test-accounts/${ORG}/payments-test`)).toBeUndefined();
    expect(acc.parseTestAccountSecretRef(`prefix {{resolve:secretsmanager:agentx/staging/org-test-accounts/${ORG}/payments-test:SecretString:apiKey}}`)).toBeUndefined();
    expect(acc.parseTestAccountSecretRef(`{{resolve:secretsmanager:agentx/staging/org-test-accounts/org_short/payments-test:SecretString:apiKey}}`)).toBeUndefined();
    expect(acc.parseTestAccountSecretRef(`{{resolve:secretsmanager:agentx/staging/org-test-accounts/${ORG}/payments-test:SecretString:apiKey}}{{x}}`)).toBeUndefined();
    expect(acc.parseTestAccountSecretRef("")).toBeUndefined();
  });
});

describe("key-shape table", () => {
  const family = "http:api.stripe.com";
  const verdict = (value: string, fam = family) => acc.checkTestAccountKeyShape(fam, value);
  it("accepts a vendor's test key and refuses its live key", () => {
    expect(verdict(stripeTest())).toEqual({ ok: true });
    expect(verdict(stripeLive())).toEqual({ ok: false, code: "live_shaped" });
    for (const prefix of ["rk", "pk"]) {
      expect(verdict(build(prefix, "_test_", rand(24)))).toEqual({ ok: true });
      expect(verdict(build(prefix, "_live_", rand(24)))).toEqual({ ok: false, code: "live_shaped" });
    }
  });
  it("accepts only the test shape where the vendor has one", () => {
    expect(verdict("totally-plain-token-12345678")).toEqual({ ok: false, code: "not_test_shaped" });
    expect(verdict(build("sk", "_test_", "short"))).toEqual({ ok: false, code: "not_test_shaped" });
    expect(verdict(` ${stripeTest()}`)).toEqual({ ok: false, code: "not_test_shaped" });
    expect(verdict(build("xx", stripeTest()))).toEqual({ ok: false, code: "not_test_shaped" });
  });
  it("refuses a live key whatever it is embedded in", () => {
    expect(verdict(`Bearer ${stripeLive()}`)).toEqual({ ok: false, code: "live_shaped" });
    expect(verdict(`${stripeTest()} ${stripeLive()}`)).toEqual({ ok: false, code: "live_shaped" });
    expect(verdict(`key=${stripeLive()}`)).toEqual({ ok: false, code: "live_shaped" });
  });
  it("applies the vendor row by the family's host only", () => {
    expect(verdict(stripeTest(), "http:api.example-pay.com")).toEqual({ ok: true });
    expect(verdict("totally-plain-token-12345678", "http:api.example-pay.com")).toEqual({ ok: true });
    expect(verdict("totally-plain-token-12345678", "http:api.stripe.com.example.net")).toEqual({ ok: true });
    expect(verdict("totally-plain-token-12345678", "aws:dynamodb")).toEqual({ ok: true });
  });
  it("refuses a live word in any family", () => {
    for (const value of ["live_abc123def456", "abc-live-abc123", "my.prod.token", "PROD-key-1", "token_production_x", "key:PRD:1", "x live"]) expect(verdict(value, "http:api.example-pay.com"), value).toEqual({ ok: false, code: "live_shaped" });
    for (const value of ["alive123", "delivery-key", "product-7", "olive_oil_9", "prodigy"]) expect(verdict(value, "http:api.example-pay.com"), value).toEqual({ ok: true });
  });
  it("refuses a long-lived AWS key id in any family, and a session key id too", () => {
    for (const prefix of ["AKIA", "ASIA", "AIDA", "AROA", "ABIA", "ACCA"]) expect(verdict(awsKeyId(prefix), "http:api.example-pay.com"), prefix).toEqual({ ok: false, code: "long_lived_aws_key" });
    expect(verdict(`id=${awsKeyId()};x`, "aws:dynamodb")).toEqual({ ok: false, code: "long_lived_aws_key" });
    expect(verdict(build("AKIA", "SHORT"), "http:api.example-pay.com")).toEqual({ ok: true });
  });
  it("refuses a private key block, an empty value, an oversized one and a multi-line one", () => {
    expect(verdict(`${build("-----", "BEGIN RSA PRIVATE KEY", "-----")}\nabc`, "http:api.example-pay.com")).toEqual({ ok: false, code: "private_key_block" });
    expect(verdict("", "http:api.example-pay.com")).toEqual({ ok: false, code: "empty" });
    expect(verdict("a".repeat(4_097), "http:api.example-pay.com")).toEqual({ ok: false, code: "too_long" });
    expect(verdict("a".repeat(4_096), "http:api.example-pay.com")).toEqual({ ok: true });
    expect(verdict("abc\ndef", "http:api.example-pay.com")).toEqual({ ok: false, code: "not_one_line" });
    expect(verdict("abc​def", "http:api.example-pay.com")).toEqual({ ok: false, code: "not_one_line" });
  });
  it("never puts the value in the verdict", () => {
    for (const value of [stripeLive(), stripeTest().slice(0, 12), awsKeyId(), "plain-live-token"]) {
      const text = JSON.stringify(verdict(value));
      expect(text).not.toContain(value);
      expect(text).not.toContain(rand(10));
    }
  });
  it("lists the vendor rows it has, so a new row is a visible change", () => {
    expect(acc.TEST_ACCOUNT_VENDOR_KEY_RULES.length).toBe(1);
  });
});

describe("looksLikeSecretValue", () => {
  it("finds each specific shape even when it is too short for the generic long-token rule", () => {
    for (const text of [build("sk", "_", "live", "_", rand(10)), build("sk", "_", "test", "_", rand(10)), build("gh", "o_", rand(20)), build("github", "_pat_", rand(20)), build("xox", "a-", rand(10)), build("ey", "J", rand(10), ".", rand(10), ".", rand(10))]) {
      // No run of token characters reaches 32 (dots break the JWT's runs), so only the specific rule can find it.
      expect(Math.max(...text.split(".").map((part) => part.length)), text.slice(0, 8)).toBeLessThan(32);
      expect(acc.looksLikeSecretValue(`note ${text}`), text.slice(0, 8)).toBe(true);
    }
  });
  it("finds every known shape, live or test", () => {
    for (const text of [stripeLive(), stripeTest(), awsKeyId(), awsKeyId("ASIA"), build("gh", "p_", rand(30)), build("gh", "s_", rand(30)), build("github", "_pat_", rand(30)), build("xox", "p-", rand(20)), build("ey", "J", rand(20), ".", rand(20), ".", rand(20)), build("-----", "BEGIN PRIVATE KEY"), rand(40)]) expect(acc.looksLikeSecretValue(`note: ${text}`), text.slice(0, 8)).toBe(true);
  });
  it("leaves ordinary words alone", () => {
    for (const text of ["Payments test mode", "Dev AWS (orders)", "CRM sandbox for the orders-service", "ABC-123", "a".repeat(31)]) expect(acc.looksLikeSecretValue(text), text).toBe(false);
  });
});

describe("hosts that look like production", () => {
  const problems = (...hosts: string[]) => acc.testAccountHostProblems(hosts);
  it("refuses a vendor's production host where the vendor has a sandbox", () => {
    expect(problems("login.salesforce.com", "acme.my.salesforce.com", "api-m.paypal.com", "production.plaid.com", "api.plaid.com")).toEqual([0, 1, 2, 3, 4].map((index) => ({ index, code: "vendor_production_host" })));
  });
  it("accepts the vendor's sandbox hosts", () => {
    expect(problems("test.salesforce.com", "acme--uat.sandbox.my.salesforce.com", "acme.scratch.my.salesforce.com", "api-m.sandbox.paypal.com", "sandbox.paypal.com", "sandbox.plaid.com")).toEqual([]);
  });
  it("does not take a look-alike for the vendor, or the vendor for a look-alike", () => {
    expect(problems("salesforce.com.example.net", "notsalesforce.com", "paypal.com.evil.example")).toEqual([]);
    expect(problems("salesforce.com")).toEqual([{ index: 0, code: "vendor_production_host" }]);
    expect(problems("PayPal.com")).toEqual([{ index: 0, code: "vendor_production_host" }]);
  });
  it("refuses a name with a prod or live label", () => {
    expect(problems("api.prod.example.com", "prod.example.com", "live.example.com", "api.production.example.com", "api.prd.example.com", "api.example.com.prod")).toEqual([0, 1, 2, 3, 4, 5].map((index) => ({ index, code: "prod_shaped_host" })));
    expect(problems("api.product.example.com", "api.delivery.example.com", "api.example-prod.com", "api.alive.example.com", "api.sandbox.example.com")).toEqual([]);
  });
  it("returns positions and codes only", () => {
    expect(JSON.stringify(problems("ok.example.com", "login.salesforce.com"))).toBe('[{"index":1,"code":"vendor_production_host"}]');
  });
});

describe("production deny list", () => {
  const problemsOf = (value: Record<string, unknown>, list = deny({ hosts: ["*.prod.example.com"] }), options?: Parameters<typeof acc.testAccountProdProblems>[2]) => acc.testAccountProdProblems(parsed(value), list, options);
  it("finds nothing for a clean account", () => {
    expect(problemsOf(account())).toEqual([]);
    expect(problemsOf(awsAccount(), deny({ accountIds: ["111122223333"] }))).toEqual([]);
  });
  it("refuses an account while the company has listed nothing as production", () => {
    expect(problemsOf(account(), deny())).toEqual([{ kind: "prod_deny_missing", field: "prodDeny" }]);
    expect(problemsOf(awsAccount(), deny())).toEqual([{ kind: "prod_deny_missing", field: "prodDeny" }]);
  });
  it("finds a host on the list, exact or by wildcard, with its position", () => {
    expect(problemsOf(account({ hosts: ["api.example-pay.com", "billing.internal.example.com"] }), deny({ hosts: ["*.internal.example.com"] }))).toEqual([{ kind: "prod_host", field: "hosts[1]" }]);
    expect(problemsOf(account({ hosts: ["api.example-pay.com", "billing.prod.example.com"] }))).toEqual([{ kind: "prod_host", field: "hosts[1]" }, { kind: "prod_shaped_host", field: "hosts[1]" }]);
    expect(problemsOf(account(), deny({ hosts: ["api.example-pay.com"] }))).toEqual([{ kind: "prod_host", field: "hosts[0]" }]);
    expect(problemsOf(account(), deny({ hosts: ["API.EXAMPLE-PAY.COM"] }))).toEqual([{ kind: "prod_host", field: "hosts[0]" }]);
  });
  it("finds a host that looks like production although the list does not name it", () => {
    expect(problemsOf(account({ family: "http:login.salesforce.com", hosts: ["login.salesforce.com"] }))).toEqual([{ kind: "vendor_production_host", field: "hosts[0]" }]);
    expect(problemsOf(account({ family: "http:api.prod.shop.example.org", hosts: ["api.prod.shop.example.org"] }))).toEqual([{ kind: "prod_shaped_host", field: "hosts[0]" }]);
  });
  it("finds a role and resources on the list by ARN prefix, and by account", () => {
    expect(problemsOf(awsAccount(), deny({ arnPrefixes: ["arn:aws:iam::222233334444:role/rovara-"] }))).toEqual([{ kind: "prod_arn", field: "aws.roleArn" }]);
    expect(problemsOf(awsAccount(), deny({ accountIds: ["222233334444"] }))).toEqual([{ kind: "prod_account", field: "aws.roleArn" }, { kind: "prod_account", field: "aws.resources[0]" }]);
    expect(problemsOf(awsAccount(), deny({ arnPrefixes: ["arn:aws:dynamodb:*:222233334444:table/orders-"] }))).toEqual([{ kind: "prod_arn", field: "aws.resources[0]" }]);
  });
  it("finds Rovara's own account", () => {
    expect(problemsOf(awsAccount(), deny({ accountIds: ["111122223333"] }), { rovaraAccountIds: ["222233334444"] })).toEqual([{ kind: "rovara_account", field: "aws.roleArn" }]);
    expect(problemsOf(awsAccount(), deny({ accountIds: ["111122223333"] }), { rovaraAccountIds: ["999988887777"] })).toEqual([]);
  });
  it("also reads the list the approved environment had, so removing an entry hides nothing", () => {
    const now = deny({ hosts: ["other.example.com"] });
    const before = deny({ hosts: ["api.example-pay.com"] });
    expect(problemsOf(account(), now)).toEqual([]);
    expect(problemsOf(account(), now, { alsoDeny: before })).toEqual([{ kind: "prod_host", field: "hosts[0]" }]);
    expect(problemsOf(account(), deny(), { alsoDeny: before })).toEqual([{ kind: "prod_host", field: "hosts[0]" }]);
    expect(problemsOf(account(), deny(), { alsoDeny: deny() })).toEqual([{ kind: "prod_deny_missing", field: "prodDeny" }]);
  });
  it("returns kinds and fields only, never the host or ARN", () => {
    const text = JSON.stringify(problemsOf(awsAccount({ hosts: ["dynamodb.us-west-2.amazonaws.com"] }), deny({ accountIds: ["222233334444"], hosts: ["dynamodb.us-west-2.amazonaws.com"] })));
    expect(text).not.toContain("222233334444");
    expect(text).not.toContain("amazonaws");
  });
});
