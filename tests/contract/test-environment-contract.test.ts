// Proof and evidence E1 (contract) and E10's report shape: the test environment's schema, its cross-field rules, revisions and digest, the less-safe fields and the approval card's risk, the proposal and the Prove report.
import { describe, expect, it } from "vitest";
import * as env from "@rovara-code/contracts";
import { DecisionCardSchema, decisionFriction } from "@rovara-code/contracts";

const sha = (letter: string) => letter.repeat(64);
const cmd = (executable: string, args: string[] = []) => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const raw = (overrides: Record<string, unknown> = {}) => ({
  tier: "sandbox",
  repos: [{ repositoryId: "partner-service", setupCommands: [cmd("pip", ["install", "-e", "."])], checks: [
    { id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test", reportPath: "reports/junit.xml", coveragePath: "reports/coverage.xml", selectArgs: ["{tests}"] },
    { id: "lint", label: "Lint", command: cmd("ruff", ["check", "."]), kind: "lint", sarifPath: "reports/ruff.sarif" },
  ] }],
  roundBudgetMin: 30,
  selection: { method: "coverage_map", alwaysRun: ["lint"], fullSuiteOn: ["poetry.lock", "**/conftest.py", ".github/**"] },
  nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
  services: [{ name: "partner-scorer", kind: "sagemaker_runtime", match: { endpointName: "partner-scorer" }, mode: "mock", mock: { fixtureSetRef: sha("a"), schemaRef: sha("b"), unmatched: "fail" } }],
  data: { seeds: [{ command: cmd("python", ["seed.py"]) }], generator: "faker_seeded", seed: 42 },
  accounts: [{ profileId: "buyer", provisioner: "seed_command", command: cmd("python", ["make_user.py"]) }],
  prodDeny: { accountIds: ["111122223333"], hosts: ["*.prod.example.com"], arnPrefixes: ["arn:aws:sagemaker:us-east-1:111122223333:"] },
  capture: { screenshots: "all", video: false, traces: false },
  ...overrides,
});
const body = (overrides: Record<string, unknown> = {}): env.TestEnvironmentBody => env.TestEnvironmentBodySchema.parse(raw(overrides));
const parses = (value: unknown) => env.TestEnvironmentBodySchema.safeParse(value).success;
const preprodService = { name: "partner-scorer", kind: "sagemaker_runtime", match: { endpointName: "partner-scorer" }, mode: "preprod", preprod: { endpointArn: "arn:aws:sagemaker:us-west-2:222233334444:endpoint/partner-scorer", roleArn: "arn:aws:iam::222233334444:role/rovara-invoke", region: "us-west-2" } };
const previewBlock = { provider: "cdk", stackTemplate: "infra/app.ts", deployRoleArn: "arn:aws:iam::222233334444:role/rovara-preview", ttlHours: 24, costCapUsdPerDay: 50, fallbackTier: "sandbox" };

describe("TestEnvironment", () => {
  it("accepts the pilot-shaped environment: pytest with coverage, a mocked SageMaker endpoint, seeded data", () => {
    expect(parses(body())).toBe(true);
  });
  it("is strict at every level", () => {
    for (const bad of [raw({ extra: 1 }), raw({ capture: { screenshots: "all", video: false, traces: false, extra: 1 } }), raw({ nightly: { enabled: true, cronUtc: "0 6 * * *", branch: "main", extra: 1 } })]) expect(parses(bad)).toBe(false);
  });
  it("keeps the round budget between 30 and 120 minutes", () => {
    expect(env.TEST_ENV_ROUND_BUDGET_MIN).toEqual({ default: 30, min: 30, max: 120 });
    expect(parses({ ...body(), roundBudgetMin: 29 })).toBe(false);
    expect(parses({ ...body(), roundBudgetMin: 121 })).toBe(false);
    expect(parses({ ...body(), roundBudgetMin: 120 })).toBe(true);
  });
  it("has the tier's own block exactly: preview for tier 2, shared for tier 3, neither for the sandbox", () => {
    expect(parses({ ...body(), tier: "preview" })).toBe(false);
    expect(parses({ ...body(), tier: "preview", preview: previewBlock })).toBe(true);
    expect(parses({ ...body(), preview: previewBlock })).toBe(false);
    expect(parses({ ...body(), tier: "shared" })).toBe(false);
    expect(parses({ ...body(), tier: "shared", shared: { baseUrl: "https://beta.example.com", leaseScope: "env", dataNamespace: "task_prefix" } })).toBe(true);
    expect(parses({ ...body(), shared: { baseUrl: "https://beta.example.com", leaseScope: "env", dataNamespace: "task_prefix" } })).toBe(false);
  });
  it("caps a preview's life at 24 hours and its cost, and takes a deploy role ARN only", () => {
    const withPreview = (over: Record<string, unknown>) => ({ ...body(), tier: "preview", preview: { ...previewBlock, ...over } });
    expect(parses(withPreview({ ttlHours: 25 }))).toBe(false);
    expect(parses(withPreview({ ttlHours: 0 }))).toBe(false);
    expect(parses(withPreview({ costCapUsdPerDay: 0 }))).toBe(false);
    expect(parses(withPreview({ deployRoleArn: "AKIAIOSFODNN7EXAMPLE" }))).toBe(false);
  });
  it("is synthetic data only, with a seeded generator", () => {
    expect(parses({ ...body(), data: { seeds: [], generator: "real_customer_sample", seed: 1 } })).toBe(false);
    expect(parses({ ...body(), data: { seeds: [], generator: "faker_seeded", seed: -1 } })).toBe(false);
  });
  it("needs a mode's own block: mock needs mock, preprod needs preprod, auto needs both, and a mocked service has no pre-prod block", () => {
    const mockOnly = body().services[0];
    expect(parses({ ...body(), services: [{ ...mockOnly, mock: undefined }] })).toBe(false);
    expect(parses({ ...body(), services: [{ ...preprodService, preprod: undefined }] })).toBe(false);
    expect(parses({ ...body(), services: [preprodService] })).toBe(true);
    expect(parses({ ...body(), services: [{ ...preprodService, mode: "auto" }] })).toBe(false);
    expect(parses({ ...body(), services: [{ ...preprodService, mode: "auto", mock: mockOnly?.mock }] })).toBe(true);
    expect(parses({ ...body(), services: [{ ...mockOnly, preprod: preprodService.preprod }] })).toBe(false);
  });
  it("matches a service by a host or an endpoint name, one of them, as its kind says", () => {
    const base = { name: "billing", kind: "http", mode: "mock", mock: { fixtureSetRef: sha("a"), schemaRef: sha("b"), unmatched: "fail" } };
    expect(parses({ ...body(), services: [{ ...base, match: { host: "billing.example.com" } }] })).toBe(true);
    expect(parses({ ...body(), services: [{ ...base, match: { host: "billing.example.com", endpointName: "x" } }] })).toBe(false);
    expect(parses({ ...body(), services: [{ ...base, match: {} }] })).toBe(false);
    expect(parses({ ...body(), services: [{ ...base, match: { endpointName: "x" } }] })).toBe(false);
    expect(parses({ ...body(), services: [{ ...base, kind: "sagemaker_runtime", match: { host: "x.example.com" } }] })).toBe(false);
  });
  it("takes a pre-prod address only as https with no credentials, and an endpoint ARN or an address, not both", () => {
    const http = (preprod: Record<string, unknown>) => ({ name: "billing", kind: "http", match: { host: "billing.example.com" }, mode: "preprod", preprod: { region: "us-west-2", ...preprod } });
    expect(parses({ ...body(), services: [http({ url: "https://billing.beta.example.com/api" })] })).toBe(true);
    for (const url of ["http://billing.beta.example.com", "https://user:pw@billing.beta.example.com", "https://billing.beta.example.com/?token=1", "https://billing.beta.example.com/#x"]) expect(parses({ ...body(), services: [http({ url })] }), url).toBe(false);
    expect(parses({ ...body(), services: [http({ url: "https://b.example.com", endpointArn: preprodService.preprod.endpointArn })] })).toBe(false);
  });
  it("refuses duplicate check ids across repositories, names, profiles and a repeated repository", () => {
    const repo = body().repos[0]!;
    expect(parses({ ...body(), repos: [repo, { ...repo, repositoryId: "other" }] })).toBe(false);
    expect(parses({ ...body(), repos: [repo, { ...repo, checks: [] }] })).toBe(false);
    const service = body().services[0]!;
    expect(parses({ ...body(), services: [service, service] })).toBe(false);
    const account = body().accounts[0]!;
    expect(parses({ ...body(), accounts: [account, account] })).toBe(false);
  });
  it("lets alwaysRun name only checks of this environment, once each, and a declared selection list its globs", () => {
    expect(parses(raw({ selection: { method: "coverage_map", alwaysRun: ["ghost"], fullSuiteOn: [] } }))).toBe(false);
    expect(parses(raw({ selection: { method: "coverage_map", alwaysRun: ["lint", "lint"], fullSuiteOn: [] } }))).toBe(false);
    expect(parses(raw({ selection: { method: "declared", alwaysRun: [], fullSuiteOn: [] } }))).toBe(false);
    expect(parses(raw({ selection: { method: "declared", declared: [{ glob: "src/match/**", tests: ["tests/match/**"] }], alwaysRun: [], fullSuiteOn: [] } }))).toBe(true);
    expect(parses(raw({ selection: { method: "full", alwaysRun: [], fullSuiteOn: ["../../etc/**"] } }))).toBe(false);
  });
  it("takes a selectArgs template only on a test check, with {tests} exactly once", () => {
    const check = (over: Record<string, unknown>) => body({ repos: [{ repositoryId: "r", setupCommands: [], checks: [{ id: "unit", label: "u", command: cmd("pytest"), kind: "test", ...over }] }], selection: { method: "full", alwaysRun: [], fullSuiteOn: [] } });
    expect(env.TestEnvCheckSchema.safeParse({ id: "unit", label: "u", command: cmd("pytest"), kind: "test", selectArgs: ["{tests}"] }).success).toBe(true);
    expect(env.TestEnvCheckSchema.safeParse({ id: "unit", label: "u", command: cmd("pytest"), kind: "test", selectArgs: [] }).success).toBe(false);
    expect(env.TestEnvCheckSchema.safeParse({ id: "unit", label: "u", command: cmd("pytest"), kind: "test", selectArgs: ["{tests}", "{tests}"] }).success).toBe(false);
    expect(env.TestEnvCheckSchema.safeParse({ id: "lint", label: "l", command: cmd("ruff"), kind: "lint", selectArgs: ["{tests}"] }).success).toBe(false);
    expect(check({}).repos).toHaveLength(1);
  });
  it("keeps secrets out: a token is only a NAME, and a role is an ARN", () => {
    const hook = { profileId: "svc", provisioner: "http_hook", createUrl: "https://t.example.com/create", deleteUrl: "https://t.example.com/delete", tokenSecretName: "TEST_ACCOUNT_TOKEN" };
    expect(parses({ ...body(), accounts: [hook] })).toBe(true);
    expect(parses({ ...body(), accounts: [{ ...hook, tokenSecretName: "sk-live-abcdef0123456789 value" }] })).toBe(false);
    expect(parses({ ...body(), accounts: [{ ...hook, token: "abc" }] })).toBe(false);
  });
  it("refuses video and traces while any account is a long-lived registered one, and allows them for run-scoped accounts", () => {
    const registered = { profileId: "old", provisioner: "registered", registryProfileId: "buyer-registry" };
    expect(parses({ ...body(), accounts: [registered], capture: { screenshots: "all", video: true, traces: false } })).toBe(false);
    expect(parses({ ...body(), accounts: [registered], capture: { screenshots: "all", video: false, traces: true } })).toBe(false);
    expect(parses({ ...body(), accounts: [registered], capture: { screenshots: "all", video: false, traces: false } })).toBe(true);
    expect(parses({ ...body(), capture: { screenshots: "all", video: true, traces: true } })).toBe(true);
    expect(env.provisionerIsRunScoped("registered")).toBe(false);
    for (const provisioner of env.TEST_ENV_RUN_SCOPED_PROVISIONERS) expect(env.provisionerIsRunScoped(provisioner)).toBe(true);
  });
  it("lists production by account, host and ARN prefix, bounded", () => {
    expect(parses({ ...body(), prodDeny: { accountIds: ["123"], hosts: [], arnPrefixes: [] } })).toBe(false);
    expect(parses({ ...body(), prodDeny: { accountIds: [], hosts: [], arnPrefixes: ["not-an-arn"] } })).toBe(false);
    expect(parses({ ...body(), prodDeny: { accountIds: Array.from({ length: 51 }, () => "111122223333"), hosts: [], arnPrefixes: [] } })).toBe(false);
  });
  it("is stored at a revision, with the environment inside it", () => {
    const stored = { revision: 1, approvedAt: "2026-10-30T12:00:00.000Z", environment: body() };
    expect(env.TestEnvironmentSchema.safeParse(stored).success).toBe(true);
    expect(env.TestEnvironmentSchema.safeParse({ ...stored, revision: 0 }).success).toBe(false);
    expect(env.TestEnvironmentSchema.safeParse({ revision: 1, approvedAt: stored.approvedAt, ...body() }).success).toBe(false);
  });
});

describe("environment digest", () => {
  it("does not depend on key order, and changes when any value changes", () => {
    const first = body();
    const reverse = (value: unknown): unknown => (Array.isArray(value) ? value.map(reverse) : typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reverse(inner)])) : value);
    expect(env.testEnvDigest(reverse(first) as env.TestEnvironmentBody)).toBe(env.testEnvDigest(first));
    expect(env.testEnvDigest(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(env.testEnvDigest(body({ roundBudgetMin: 31 }))).not.toBe(env.testEnvDigest(first));
    expect(env.testEnvDigest(body({ data: { seeds: [], generator: "faker_seeded", seed: 43 } }))).not.toBe(env.testEnvDigest(first));
  });
});

describe("less-safe fields", () => {
  const preprod = { ...preprodService };
  it("lists each less-safe field that a change turns on", () => {
    expect(env.testEnvLessSafeChanges(undefined, body())).toEqual([]);
    expect(env.testEnvLessSafeChanges(undefined, body({ services: [preprod] }))).toEqual(["preprod"]);
    expect(env.testEnvLessSafeChanges(body(), body({ capture: { screenshots: "all", video: true, traces: true } }))).toEqual(["video", "traces"]);
    expect(env.testEnvLessSafeChanges(body(), body({ tier: "preview", preview: previewBlock }))).toEqual(["preview"]);
    expect(env.testEnvLessSafeChanges(body(), body({ tier: "shared", shared: { baseUrl: "https://beta.example.com", leaseScope: "env", dataNamespace: "task_prefix" } }))).toEqual(["shared"]);
    const synth = body().services[0]!;
    expect(env.testEnvLessSafeChanges(body(), body({ services: [{ ...synth, mock: { ...synth.mock, unmatched: "schema_synth" } }] }))).toEqual(["schema_synth"]);
  });
  it("counts the nightly run being turned on or run more often, and a raised preview cost, as changes (money)", () => {
    const nightly = (over: Record<string, unknown>) => body({ nightly: { enabled: true, cronUtc: "0 6 * * *", branch: "main", ...over } });
    expect(env.testEnvLessSafeChanges(undefined, nightly({}))).toEqual(["nightly_enabled"]);
    expect(env.testEnvLessSafeChanges(body(), nightly({}))).toEqual(["nightly_enabled"]);
    expect(env.testEnvLessSafeChanges(nightly({}), nightly({ cronUtc: "0 */4 * * *" }))).toEqual(["nightly_more_often"]);
    expect(env.testEnvLessSafeChanges(nightly({ cronUtc: "0 */4 * * *" }), nightly({}))).toEqual([]);
    expect(env.testEnvLessSafeChanges(nightly({}), body())).toEqual([]);
    const preview = (over: Record<string, unknown>) => body({ tier: "preview", preview: { ...previewBlock, ...over } });
    expect(env.testEnvLessSafeChanges(preview({}), preview({ costCapUsdPerDay: 500 }))).toEqual(["preview_cost_raised"]);
    expect(env.testEnvLessSafeChanges(preview({ ttlHours: 6 }), preview({ ttlHours: 12 }))).toEqual(["preview_cost_raised"]);
  });
  it("counts a raised round budget as a change and a lowered one as none", () => {
    expect(env.testEnvLessSafeChanges(body(), body({ roundBudgetMin: 60 }))).toEqual(["round_budget_raised"]);
    expect(env.testEnvLessSafeChanges(body({ roundBudgetMin: 60 }), body({ roundBudgetMin: 30 }))).toEqual([]);
  });
  it("does not count a less-safe field that was already on and did not change", () => {
    expect(env.testEnvLessSafeChanges(body({ services: [preprod] }), body({ services: [preprod], roundBudgetMin: 30 }))).toEqual([]);
    expect(env.testEnvLessSafeChanges(body({ capture: { screenshots: "all", video: true, traces: false } }), body({ capture: { screenshots: "all", video: true, traces: true } }))).toEqual(["traces"]);
  });
});

describe("targets that move, and the production deny list", () => {
  const moved = { ...preprodService, preprod: { ...preprodService.preprod, endpointArn: "arn:aws:sagemaker:us-west-2:222233334444:endpoint/other-scorer" } };
  const sharedBlock = (baseUrl: string) => ({ baseUrl, leaseScope: "env", dataNamespace: "task_prefix" });
  it("counts pointing an already-on pre-prod service at another endpoint, URL or role as a less-safe change", () => {
    expect(env.testEnvLessSafeChanges(body({ services: [preprodService] }), body({ services: [moved] }))).toEqual(["preprod_target_changed"]);
    const otherRole = { ...preprodService, preprod: { ...preprodService.preprod, roleArn: "arn:aws:iam::222233334444:role/wider" } };
    expect(env.testEnvLessSafeChanges(body({ services: [preprodService] }), body({ services: [otherRole] }))).toEqual(["preprod_target_changed"]);
    const http = (url: string) => ({ name: "billing", kind: "http", match: { host: "billing.example.com" }, mode: "preprod", preprod: { url, region: "us-west-2" } });
    expect(env.testEnvLessSafeChanges(body({ services: [http("https://a.beta.example.com")] }), body({ services: [http("https://b.beta.example.com")] }))).toEqual(["preprod_target_changed"]);
  });
  it("counts one more pre-prod service next to an old one, but not the same target again", () => {
    const second = { ...preprodService, name: "second", match: { endpointName: "second" } };
    expect(env.testEnvLessSafeChanges(body({ services: [preprodService] }), body({ services: [preprodService, second] }))).toEqual(["preprod_target_changed"]);
    expect(env.testEnvLessSafeChanges(body({ services: [preprodService] }), body({ services: [preprodService], roundBudgetMin: 30 }))).toEqual([]);
  });
  it("counts a changed shared base URL, preview role and account target, and not an unchanged one", () => {
    const sharedEnv = (url: string) => body({ tier: "shared", shared: sharedBlock(url) });
    expect(env.testEnvLessSafeChanges(sharedEnv("https://beta.example.com"), sharedEnv("https://gamma.example.com"))).toEqual(["shared_target_changed"]);
    expect(env.testEnvLessSafeChanges(sharedEnv("https://beta.example.com"), sharedEnv("https://beta.example.com"))).toEqual([]);
    const previewEnv = (role: string) => body({ tier: "preview", preview: { ...previewBlock, deployRoleArn: role } });
    expect(env.testEnvLessSafeChanges(previewEnv("arn:aws:iam::222233334444:role/a"), previewEnv("arn:aws:iam::222233334444:role/b"))).toEqual(["preview_target_changed"]);
    const hook = (createUrl: string) => ({ profileId: "svc", provisioner: "http_hook", createUrl, deleteUrl: "https://t.example.com/delete", tokenSecretName: "TEST_TOKEN" });
    expect(env.testEnvLessSafeChanges(body({ accounts: [hook("https://t.example.com/create")] }), body({ accounts: [hook("https://other.example.com/create")] }))).toEqual(["account_target_changed"]);
    expect(env.testEnvLessSafeChanges(body({ accounts: [hook("https://t.example.com/create")] }), body({ accounts: [hook("https://t.example.com/create")] }))).toEqual([]);
  });
  it("counts removing anything from the production deny list, and not adding to it", () => {
    const deny = (over: Record<string, unknown>) => body({ prodDeny: { accountIds: ["111122223333"], hosts: ["*.prod.example.com"], arnPrefixes: ["arn:aws:sagemaker:us-east-1:111122223333:"], ...over } });
    expect(env.testEnvLessSafeChanges(deny({}), deny({ accountIds: [] }))).toEqual(["prod_deny_reduced"]);
    expect(env.testEnvLessSafeChanges(deny({}), deny({ hosts: ["*.other.example.com"] }))).toEqual(["prod_deny_reduced"]);
    expect(env.testEnvLessSafeChanges(deny({}), deny({ arnPrefixes: [] }))).toEqual(["prod_deny_reduced"]);
    expect(env.testEnvLessSafeChanges(deny({}), deny({ accountIds: ["111122223333", "999900001111"] }))).toEqual([]);
  });
  it("refuses a body whose pre-prod, shared, preview or account target is on the deny list, by account, ARN prefix or host glob", () => {
    const prodArn = "arn:aws:sagemaker:us-east-1:111122223333:endpoint/partner-scorer";
    const inProd = (service: Record<string, unknown>) => parses(raw({ services: [{ ...preprodService, preprod: { ...preprodService.preprod, ...service } }] }));
    expect(inProd({ endpointArn: prodArn })).toBe(false);
    expect(inProd({ endpointArn: "arn:aws:sagemaker:eu-west-1:111122223333:endpoint/x" })).toBe(false);
    expect(inProd({ roleArn: "arn:aws:iam::111122223333:role/x" })).toBe(false);
    expect(inProd({ endpointArn: "arn:aws:sagemaker:us-west-2:222233334444:endpoint/ok" })).toBe(true);
    const http = (url: string) => raw({ services: [{ name: "billing", kind: "http", match: { host: "billing.example.com" }, mode: "preprod", preprod: { url, region: "us-west-2" } }] });
    expect(parses(http("https://billing.prod.example.com/api"))).toBe(false);
    expect(parses(http("https://BILLING.PROD.EXAMPLE.COM/api"))).toBe(false);
    expect(parses(http("https://billing.beta.example.com/api"))).toBe(true);
    expect(parses(http("https://prodxexample.com/api"))).toBe(true);
    expect(parses(raw({ tier: "shared", shared: sharedBlock("https://app.prod.example.com") }))).toBe(false);
    expect(parses(raw({ tier: "preview", preview: { ...previewBlock, deployRoleArn: "arn:aws:iam::111122223333:role/deploy" } }))).toBe(false);
    expect(parses(raw({ accounts: [{ profileId: "p", provisioner: "cognito_test_pool", userPoolId: "us-west-2_abc", region: "us-west-2", roleArn: "arn:aws:iam::111122223333:role/x" }] }))).toBe(false);
    expect(parses(raw({ accounts: [{ profileId: "p", provisioner: "http_hook", createUrl: "https://x.prod.example.com/c", deleteUrl: "https://t.example.com/d", tokenSecretName: "T" }] }))).toBe(false);
    expect(env.testEnvTouchesProd(body())).toBe(false);
  });
  it("needs a run-scoped account for video or traces in a shared environment", () => {
    const sharedEnv = (accounts: unknown[]) => raw({ tier: "shared", shared: sharedBlock("https://beta.example.com"), accounts, capture: { screenshots: "all", video: true, traces: false } });
    expect(parses(sharedEnv([]))).toBe(false);
    expect(parses(sharedEnv([{ profileId: "buyer", provisioner: "seed_command", command: cmd("python", ["x.py"]) }]))).toBe(true);
    expect(parses(raw({ accounts: [], capture: { screenshots: "all", video: true, traces: true } }))).toBe(true);
  });
});

describe("approve_test_env card risk", () => {
  it("is medium for a plain sandbox and high for pre-prod, a shared env, tier 2, video or traces", () => {
    expect(env.testEnvApprovalRisk(body())).toBe("medium");
    expect(env.testEnvApprovalRisk(body({ services: [preprodService] }))).toBe("high");
    expect(env.testEnvApprovalRisk(body({ tier: "preview", preview: previewBlock }))).toBe("high");
    expect(env.testEnvApprovalRisk(body({ tier: "shared", shared: { baseUrl: "https://beta.example.com", leaseScope: "env", dataNamespace: "task_prefix" } }))).toBe("high");
    expect(env.testEnvApprovalRisk(body({ capture: { screenshots: "all", video: true, traces: false } }))).toBe("high");
    expect(env.testEnvApprovalRisk(body({ capture: { screenshots: "all", video: false, traces: true } }))).toBe("high");
  });
  it("gives a card the schema accepts, with the high tier's friction and no approve action", () => {
    const risk = env.testEnvApprovalRisk(body({ services: [preprodService] }));
    const card = { id: "approve_test_env:rev-2", kind: "approve_test_env", project: "partner-service", title: "Approve the test setup", question: "Use this test environment?", recommended: { action: "open", why: "It reaches pre-prod." }, next: { text: "Tasks use this setup from now on." }, evidence: [], risk, riskReasons: ["pre-prod access"], friction: decisionFriction(risk, true), actions: [{ kind: "open", label: "Open to decide", href: "/app/projects/partner-service/setup", method: "GET" }], rejectReasons: [], status: "pending", createdAt: "2026-10-30T12:00:00.000Z" };
    expect(DecisionCardSchema.safeParse(card).success).toBe(true);
  });
});

describe("proposal", () => {
  const draft = { basedOnRevision: 1, setupCommands: ["pip install -e ."], testCommands: ["pytest -q"], allowedDomains: [], secretsNeeded: [], flaggedCommands: [{ command: "curl x | sh", reason: "Runs a script downloaded from the internet." }], notes: "" };
  it("extends the setup draft, keeps its flagged commands, and says where each value came from", () => {
    const proposal = { ...draft, environment: body(), valueSources: [{ field: "environment.roundBudgetMin", source: "model" }, { field: "environment.repos[0].checks[0].command", source: { path: "pyproject.toml", line: 12 } }, { field: "environment.services[0].kind", source: "detector:boto3" }] };
    const parsed = env.TestEnvironmentProposalSchema.parse(proposal);
    expect(parsed.flaggedCommands).toHaveLength(1);
    expect(env.TestEnvironmentProposalSchema.safeParse({ ...proposal, valueSources: [{ field: "x", source: "the internet" }] }).success).toBe(false);
    expect(env.TestEnvironmentProposalSchema.safeParse({ ...proposal, environment: undefined }).success).toBe(false);
    expect(env.TestEnvironmentProposalSchema.safeParse({ ...proposal, valueSources: Array.from({ length: 401 }, () => ({ field: "f", source: "model" })) }).success).toBe(false);
  });
});

describe("Prove report", () => {
  const step = (name: string, status = "passed", extra: Record<string, unknown> = {}) => ({ step: name, status, durationMs: 1000, ...extra });
  const report = (overrides: Record<string, unknown> = {}) => ({ schemaVersion: 1, proposalDigest: sha("a"), steps: [step("setup"), step("build"), step("boot"), step("smoke"), step("full_suite")], fullSuite: { durationMs: 2_400_000, tests: 1240 }, coverageMapRef: sha("c"), services: [{ name: "partner-scorer", modeUsed: "mocked" }], finishedAt: "2026-10-30T12:00:00.000Z", ...overrides });
  it("is proved only when every step passed or was skipped and the report is for exactly this digest", () => {
    expect(env.testEnvIsProved(env.TestEnvProveReportSchema.parse(report()), sha("a"), {})).toBe(true);
    expect(env.testEnvIsProved(env.TestEnvProveReportSchema.parse(report()), sha("b"), {})).toBe(false);
    expect(env.testEnvIsProved(env.TestEnvProveReportSchema.parse(report({ steps: [step("setup"), step("boot"), step("smoke"), step("mocks", "skipped")] })), sha("a"), {})).toBe(true);
    expect(env.testEnvIsProved(env.TestEnvProveReportSchema.parse(report({ steps: [step("setup"), step("boot", "failed", { failure: "boot_failed" })] })), sha("a"), {})).toBe(false);
  });
  it("is not proved when everything was skipped, when neither the smoke check nor the full suite passed, or when a service never booted", () => {
    const proved = (over: Record<string, unknown>) => env.testEnvIsProved(env.TestEnvProveReportSchema.parse(report(over)), sha("a"), {});
    expect(proved({ steps: [step("setup", "skipped"), step("build", "skipped"), step("boot", "skipped"), step("smoke", "skipped"), step("full_suite", "skipped")] })).toBe(false);
    expect(proved({ steps: [step("setup"), step("build"), step("boot")] })).toBe(false);
    expect(proved({ steps: [step("setup"), step("boot", "skipped"), step("smoke")] })).toBe(false);
    expect(proved({ steps: [step("setup"), step("smoke")], services: [] })).toBe(true);
    expect(proved({ steps: [step("setup"), step("boot"), step("full_suite")] })).toBe(true);
    expect(proved({ steps: [step("setup"), step("boot"), step("smoke", "skipped"), step("full_suite")] })).toBe(true);
  });
  it("never reads a missing or empty report as proved", () => {
    expect(env.testEnvIsProved(undefined, sha("a"), {})).toBe(false);
    expect(env.testEnvIsProved(env.TestEnvProveReportSchema.parse(report({ steps: [] })), sha("a"), {})).toBe(false);
  });
  it("names a failure for a failed step with a fixed code, and for no other step", () => {
    expect(env.TestEnvProveReportSchema.safeParse(report({ steps: [step("boot", "failed")] })).success).toBe(false);
    expect(env.TestEnvProveReportSchema.safeParse(report({ steps: [step("boot", "passed", { failure: "boot_failed" })] })).success).toBe(false);
    expect(env.TestEnvProveReportSchema.safeParse(report({ steps: [step("boot", "failed", { failure: "it exploded" })] })).success).toBe(false);
    expect(env.TestEnvProveReportSchema.safeParse(report({ steps: [step("boot", "failed", { failure: "health_timeout", outputTail: "x".repeat(4097) })] })).success).toBe(false);
  });
  it("lists a step once and the services' modes as used", () => {
    expect(env.TestEnvProveReportSchema.safeParse(report({ steps: [step("boot"), step("boot")] })).success).toBe(false);
    expect(env.TestEnvProveReportSchema.safeParse(report({ services: [{ name: "s", modeUsed: "auto" }] })).success).toBe(false);
  });
});

describe("synthetic-data guard report", () => {
  it("is ok exactly when it has no findings, and keeps codes and positions only", () => {
    expect(env.DataGuardReportSchema.safeParse({ ok: true, findings: [] }).success).toBe(true);
    expect(env.DataGuardReportSchema.safeParse({ ok: false, findings: [{ kind: "card_number", source: "fixture", path: "entries[3].response.body" }] }).success).toBe(true);
    expect(env.DataGuardReportSchema.safeParse({ ok: true, findings: [{ kind: "email", source: "seed", path: "x" }] }).success).toBe(false);
    expect(env.DataGuardReportSchema.safeParse({ ok: false, findings: [] }).success).toBe(false);
    expect(env.DataGuardReportSchema.safeParse({ ok: false, findings: [{ kind: "email", source: "seed", path: "x", match: "a@b.co" }] }).success).toBe(false);
  });
});
