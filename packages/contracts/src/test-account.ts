// Test services, TS4 (design test-services.md, 4.3 and 6): a TEST ACCOUNT is the customer's own non-production account for a service (a payment provider's test mode, a CRM sandbox, a dev AWS account, a
// pre-prod endpoint). It is used only by sealed check rounds, through a proxy limited to its hosts. This is the contract only: nothing stores, approves or uses an account yet.
//
// What this module guarantees, so no builder has to remember it:
//   - REFERENCE ONLY. A record holds the name of an org-tagged Secrets Manager secret (a `{{resolve:secretsmanager:...}}` reference), never a value. The schema is strict (no `value`, `secret` or `token`
//     member exists), the reference must point at THIS account's own path under THIS org, and a label that looks like a key is refused. The functions here return fixed codes and field names, never the text
//     they checked;
//   - the secret's name is built in one place (`testAccountSecretName`), org-tagged, from parts that cannot climb out of their path;
//   - a value that looks like a live or production key is refused (`checkTestAccountKeyShape`): by the vendor's own live prefix, by a live/prod word, as a long-lived AWS access key (an AWS account is reached
//     by a role, never a stored key) or as a private-key block; and where the vendor has a test shape, only that shape is accepted;
//   - a host is a plain lower-case name (never an address, a wildcard or a port); an AWS account's hosts are the regional endpoints of its region; a vendor's production host is refused where the vendor has a
//     sandbox host (`testAccountHostProblems`);
//   - every host, role and resource is checked against the production deny list, and an account may not be used while the list is empty (`testAccountProdProblems`);
//   - an account is active only with two distinct people's fresh-sign-in approvals, or the sole-owner exception, and then only until an expiry at most a year after the last approval.
// Nothing here imports a Node module.
import { z } from "zod";
import { OrgIdSchema } from "./browser-ids.js";
import { EnvNameSchema, FamilyIdSchema, TestAccountIdSchema, TestEnvRegionSchema, reservedDependencyEnvName } from "./test-env-dependency.js";
import { normalizeDenyHost, prodDenyIsEmpty, prodDenyMatchesArn, prodDenyMatchesHost, type TestEnvProdDeny } from "./test-environment-prod-deny.js";

const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
function line(max: number, min = 1) {
  return z.string().min(min).max(max).regex(NO_HIDDEN, "one plain line");
}

export const TEST_ACCOUNT_KINDS = ["api_key", "oauth_client", "basic", "aws_role", "preprod_endpoint"] as const;
export const TEST_ACCOUNT_STATUSES = ["pending", "active", "suspended", "expired"] as const;
export const TEST_ACCOUNT_APPROVAL_KINDS = ["approver", "sole_owner_exception"] as const;
export const TEST_ACCOUNT_LIMITS = { hosts: 8, envNames: 4, projects: 50, actions: 20, resources: 20, approvals: 10 } as const;
/** Requests per run, per day and rounds at once (11.2): the defaults and the Rovara maximums. The per-day figure is set by the company, so its maximum is only a sanity bound. */
export const TEST_ACCOUNT_LIMIT_DEFAULTS = { maxRequestsPerRun: 2_000, maxRequestsPerDay: 20_000, maxConcurrentRounds: 2 } as const;
export const TEST_ACCOUNT_LIMIT_MAXIMUMS = { maxRequestsPerRun: 20_000, maxRequestsPerDay: 1_000_000, maxConcurrentRounds: 10 } as const;
/** An account expires 90 days after approval by default; a company may allow longer, never past a year. A reminder goes out 14 days before. */
export const TEST_ACCOUNT_EXPIRY_DAYS = { default: 90, max: 365, reminder: 14 } as const;

// ---- the secret: its name, tags and reference (6.2)

/** The tags every test-account secret carries; the role that reads them is allowed only its own org's path (`rovara:org`). */
export const TEST_ACCOUNT_SECRET_TAG_KEYS = { org: "rovara:org", use: "rovara:use" } as const;
export const TEST_ACCOUNT_SECRET_USE = "test-account";
/** The path segment between the install's environment and the org: test-account secrets live apart from connector and hook secrets, so the connector role cannot reach them. */
export const TEST_ACCOUNT_SECRET_SEGMENT = "org-test-accounts";

const ENV_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u;
const KEY_SEGMENT = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

function assertParts(env: string, orgId: string, accountId: string): void {
  // Fixed message: the values are not echoed, so a wrong one cannot leak into a log.
  if (!ENV_SEGMENT.test(env) || !OrgIdSchema.safeParse(orgId).success || !TestAccountIdSchema.safeParse(accountId).success) throw new RangeError("a test-account secret name needs a valid environment, org and account id");
}

/** `agentx/<env>/org-test-accounts/<orgId>/<accountId>`: where one account's secret lives. Throws on any part that is not a plain segment, so a name can never climb out of its org's path. */
export function testAccountSecretName(env: string, orgId: string, accountId: string): string {
  assertParts(env, orgId, accountId);
  return `agentx/${env}/${TEST_ACCOUNT_SECRET_SEGMENT}/${orgId}/${accountId}`;
}

/** The path an org-tagged role's policy covers: all of one org's test-account secrets and nothing else (ends with a slash). */
export function testAccountSecretPrefix(env: string, orgId: string): string {
  assertParts(env, orgId, "placeholder");
  return `agentx/${env}/${TEST_ACCOUNT_SECRET_SEGMENT}/${orgId}/`;
}

/** The tags a test-account secret is created with. */
export function testAccountSecretTags(orgId: string): Record<string, string> {
  assertParts("env", orgId, "placeholder");
  return { [TEST_ACCOUNT_SECRET_TAG_KEYS.org]: orgId, [TEST_ACCOUNT_SECRET_TAG_KEYS.use]: TEST_ACCOUNT_SECRET_USE };
}

/** `{{resolve:secretsmanager:<name>:SecretString:<key>}}`: the reference an account holds in place of a value. `key` is the JSON key inside the secret. */
export function testAccountSecretRef(env: string, orgId: string, accountId: string, key: string): string {
  if (!KEY_SEGMENT.test(key)) throw new RangeError("a test-account secret key is a plain name");
  return `{{resolve:secretsmanager:${testAccountSecretName(env, orgId, accountId)}:SecretString:${key}}}`;
}

export interface TestAccountSecretRefParts { env: string; orgId: string; accountId: string; key: string }

/** The parts of a reference, or undefined when the text is not exactly one test-account reference (another path, another service, extra segments and traversal are all not). */
export function parseTestAccountSecretRef(ref: string): TestAccountSecretRefParts | undefined {
  const match = /^\{\{resolve:secretsmanager:agentx\/([^/:{}]+)\/org-test-accounts\/([^/:{}]+)\/([^/:{}]+):SecretString:([^/:{}]+)\}\}$/u.exec(ref);
  if (match === null) return undefined;
  const [, env, orgId, accountId, key] = match as unknown as [string, string, string, string, string];
  if (!ENV_SEGMENT.test(env) || !OrgIdSchema.safeParse(orgId).success || !TestAccountIdSchema.safeParse(accountId).success || !KEY_SEGMENT.test(key)) return undefined;
  return { env, orgId, accountId, key };
}

// ---- the key-shape table (6.3): refuse values that look live or production

export type KeyShapeCode = "empty" | "too_long" | "not_one_line" | "private_key_block" | "long_lived_aws_key" | "live_shaped" | "not_test_shaped";
export type KeyShapeVerdict = { ok: true } | { ok: false; code: KeyShapeCode };

interface VendorKeyRule {
  /** The families (their host) this rule applies to. */
  hosts: readonly RegExp[];
  /** A value matching any of these is the vendor's live shape. */
  live: readonly RegExp[];
  /** Where the vendor has a test shape, the value must match one of these. */
  test: readonly RegExp[];
}

/** Per-vendor rules. Small on purpose: it grows with use, each row with its own test. Live is checked before test, so a value cannot match both. */
export const TEST_ACCOUNT_VENDOR_KEY_RULES: readonly VendorKeyRule[] = [
  // A payment provider whose keys carry the mode in their prefix: live keys refused, only test keys accepted.
  { hosts: [/^api\.stripe\.com$/u], live: [/(?:^|[^A-Za-z0-9])(?:sk|rk|pk)_live_/u], test: [/^(?:sk|rk|pk)_test_[A-Za-z0-9]{8,}$/u] },
];

// A long-lived AWS access key id (and the ids of other long-lived principals). An AWS account is reached by assuming a role, so no stored AWS key is ever a test account's value.
const AWS_KEY_ID = /(?:^|[^A-Za-z0-9])(?:AKIA|ASIA|AIDA|AROA|ABIA|ACCA)[A-Z2-7]{16}(?:[^A-Za-z0-9]|$)/u;
// A word that says the value is live: delimited by anything that is not a letter or digit.
const LIVE_WORD = /(?:^|[^A-Za-z0-9])(?:live|prod|production|prd)(?:[^A-Za-z0-9]|$)/iu;
const VALUE_MAX = 4_096;

function hostOfFamily(family: string): string | undefined {
  return family.startsWith("http:") ? family.slice(5) : undefined;
}

/**
 * Whether a value that is about to be saved as a test account's secret looks acceptable: the verdict is a fixed code, never the value. Checked at save, per vendor family, failing closed:
 * private keys, long-lived AWS keys and anything live-shaped are refused, and where the vendor has a test shape only that shape passes. A family with no row is checked by the generic rules only.
 */
export function checkTestAccountKeyShape(family: string, value: string): KeyShapeVerdict {
  if (value.length === 0) return { ok: false, code: "empty" };
  if (value.length > VALUE_MAX) return { ok: false, code: "too_long" };
  if (value.includes("-----BEGIN")) return { ok: false, code: "private_key_block" };
  if (/[\p{Cc}\p{Cf}]/u.test(value)) return { ok: false, code: "not_one_line" };
  if (AWS_KEY_ID.test(value)) return { ok: false, code: "long_lived_aws_key" };
  const host = hostOfFamily(family);
  const rules = host === undefined ? [] : TEST_ACCOUNT_VENDOR_KEY_RULES.filter((rule) => rule.hosts.some((pattern) => pattern.test(host)));
  if (rules.some((rule) => rule.live.some((pattern) => pattern.test(value)))) return { ok: false, code: "live_shaped" };
  if (LIVE_WORD.test(value)) return { ok: false, code: "live_shaped" };
  if (rules.some((rule) => rule.test.length > 0 && !rule.test.some((pattern) => pattern.test(value)))) return { ok: false, code: "not_test_shaped" };
  return { ok: true };
}

/** Whether a piece of text looks like a secret value (a key, a token or a private key) and so must not sit in a label or any other plain field of a record. Any known shape, live or test. */
export function looksLikeSecretValue(text: string): boolean {
  return (
    /(?:^|[^A-Za-z0-9])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/u.test(text) ||
    AWS_KEY_ID.test(text) ||
    text.includes("-----BEGIN") ||
    /(?:^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u.test(text) ||
    /(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/u.test(text) ||
    /(?:^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/u.test(text) ||
    /(?:^|[^A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/u.test(text) ||
    /(?:^|[^A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{32,}(?:[^A-Za-z0-9+/=_-]|$)/u.test(text)
  );
}

// ---- hosts (4.3, 6.3)

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
/** A plain lower-case host name of at least two labels: not an address, a wildcard, a port or a name with a trailing dot. The proxy's allow-list holds exactly these. */
export const TestAccountHostSchema = z
  .string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u, "a lower-case host name")
  .refine((host) => !IPV4_LITERAL.test(host), "a name, not an address");

interface SandboxHostRule {
  /** Every host of the vendor. */
  domain: RegExp;
  /** The vendor's sandbox hosts: any other host of the vendor is production. */
  sandbox: readonly RegExp[];
}

/** Vendors that keep production and sandbox on different hosts: only the sandbox ones may be a test account's. */
export const TEST_ACCOUNT_SANDBOX_HOST_RULES: readonly SandboxHostRule[] = [
  // A CRM: production logins and org hosts are refused; only its test login and sandbox org hosts pass.
  { domain: /(?:^|\.)salesforce\.com$/u, sandbox: [/^test\.salesforce\.com$/u, /\.sandbox\.my\.salesforce\.com$/u, /\.scratch\.my\.salesforce\.com$/u] },
  // A payments platform: live and sandbox API hosts differ by a label.
  { domain: /(?:^|\.)paypal\.com$/u, sandbox: [/(?:^|\.)sandbox\.paypal\.com$/u] },
  // A banking-data API: sandbox host only.
  { domain: /(?:^|\.)plaid\.com$/u, sandbox: [/^sandbox\.plaid\.com$/u] },
];

/** A label that says the host is live, anywhere in the name. */
const PROD_LABEL = /(?:^|\.)(?:prod|production|prd|live)(?:\.|$)/u;

export type TestAccountHostCode = "vendor_production_host" | "prod_shaped_host";

/** The hosts (by position) that look like production: a vendor's production host where the vendor has a sandbox, or a name with a prod/live label. Codes and positions only. */
export function testAccountHostProblems(hosts: readonly string[]): Array<{ index: number; code: TestAccountHostCode }> {
  const found: Array<{ index: number; code: TestAccountHostCode }> = [];
  hosts.forEach((raw, index) => {
    const host = normalizeDenyHost(raw) ?? "";
    if (TEST_ACCOUNT_SANDBOX_HOST_RULES.some((rule) => rule.domain.test(host) && !rule.sandbox.some((pattern) => pattern.test(host)))) found.push({ index, code: "vendor_production_host" });
    else if (PROD_LABEL.test(host)) found.push({ index, code: "prod_shaped_host" });
  });
  return found;
}

// ---- the record

const Arn = z.string().max(512).regex(/^arn:aws(?:-[a-z]+)*:[a-z0-9-]+:[a-z0-9-]*:(?:\d{12})?:[A-Za-z0-9+=,.@_/:*?-]{1,400}$/u, "an ARN");
const RoleArn = z.string().max(256).regex(/^arn:aws(?:-[a-z]+)*:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,200}$/u, "an IAM role ARN");
/** An explicit action, `service:Action`: no wildcard, so the session policy is exactly what was approved. */
const IamAction = z.string().max(128).regex(/^[a-z0-9-]+:[A-Za-z0-9]+$/u, "an explicit IAM action");
/** AWS services whose actions grant or change access: never part of a test account's session policy. */
export const TEST_ACCOUNT_REFUSED_AWS_SERVICES = ["iam", "sts", "organizations", "account", "sso", "sso-directory", "identitystore"] as const;

const arnAccount = (arn: string): string | undefined => {
  const account = arn.split(":")[4];
  return account === undefined || account === "" ? undefined : account;
};

export const TestAccountAwsSchema = z
  .object({
    roleArn: RoleArn,
    /** The external id of the trust policy (a confused-deputy guard, not a secret). */
    externalId: z.string().regex(/^[A-Za-z0-9+=,.@:/-]{8,128}$/u, "an external id"),
    region: TestEnvRegionSchema,
    actions: z.array(IamAction).min(1).max(TEST_ACCOUNT_LIMITS.actions),
    resources: z.array(Arn).min(1).max(TEST_ACCOUNT_LIMITS.resources),
  })
  .strict()
  .superRefine((aws, context) => {
    const problem = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
    if (new Set(aws.actions).size !== aws.actions.length) problem(["actions"], "an action is listed once");
    if (new Set(aws.resources).size !== aws.resources.length) problem(["resources"], "a resource is listed once");
    aws.actions.forEach((action, index) => {
      if ((TEST_ACCOUNT_REFUSED_AWS_SERVICES as readonly string[]).includes(action.slice(0, action.indexOf(":")))) problem(["actions", index], "an action that grants or changes access is never part of a test account");
    });
    const account = arnAccount(aws.roleArn);
    aws.resources.forEach((resource, index) => {
      const own = arnAccount(resource);
      if (own !== undefined && own !== account) problem(["resources", index], "a resource is in the role's own account");
      // A resource of `*` after the account would be every resource of the service: the session policy names what it covers.
      if (/^arn:[^:]*:[^:]*:[^:]*:[^:]*:\*$/u.test(resource)) problem(["resources", index], "a resource names what it covers");
    });
  });
export type TestAccountAws = z.infer<typeof TestAccountAwsSchema>;

const SecretRefSchema = z.string().max(400).refine((ref) => parseTestAccountSecretRef(ref) !== undefined, "a test-account secret reference");

const DeveloperId = z.string().regex(/^[a-f0-9]{64}$/u);
export const TestAccountApprovalSchema = z.object({ by: DeveloperId, at: z.string().datetime(), freshSignIn: z.literal(true), kind: z.enum(TEST_ACCOUNT_APPROVAL_KINDS) }).strict();
export type TestAccountApproval = z.infer<typeof TestAccountApprovalSchema>;

/** Whether the approvals are enough for an account to be active: two different people, each with a fresh sign-in, or the sole-owner exception (company switch and eligibility are the approver's, checked where it is recorded). */
export function testAccountApprovalsSatisfied(approvals: readonly TestAccountApproval[]): boolean {
  return new Set(approvals.map((approval) => approval.by)).size >= 2 || approvals.some((approval) => approval.kind === "sole_owner_exception");
}

const DAY_MS = 86_400_000;

export const TestAccountSchema = z
  .object({
    id: TestAccountIdSchema,
    orgId: OrgIdSchema,
    projectIds: z.union([z.literal("all"), z.array(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u)).min(1).max(TEST_ACCOUNT_LIMITS.projects)]),
    /** `http:<host>` for an outside API, `aws:<service>` for an AWS account. */
    family: FamilyIdSchema,
    label: line(80),
    kind: z.enum(TEST_ACCOUNT_KINDS),
    /** The reference to the secret, never its value. */
    secretRef: SecretRefSchema.optional(),
    aws: TestAccountAwsSchema.optional(),
    /** The proxy's allow-list for this account. */
    hosts: z.array(TestAccountHostSchema).min(1).max(TEST_ACCOUNT_LIMITS.hosts),
    /** The variables the test reads its secret from (`PAYMENTS_API_KEY`). */
    envNames: z.array(EnvNameSchema).max(TEST_ACCOUNT_LIMITS.envNames),
    limits: z
      .object({
        maxRequestsPerRun: z.number().int().min(1).max(TEST_ACCOUNT_LIMIT_MAXIMUMS.maxRequestsPerRun),
        maxRequestsPerDay: z.number().int().min(1).max(TEST_ACCOUNT_LIMIT_MAXIMUMS.maxRequestsPerDay),
        maxConcurrentRounds: z.number().int().min(1).max(TEST_ACCOUNT_LIMIT_MAXIMUMS.maxConcurrentRounds),
      })
      .strict(),
    approvals: z.array(TestAccountApprovalSchema).max(TEST_ACCOUNT_LIMITS.approvals),
    status: z.enum(TEST_ACCOUNT_STATUSES),
    expiresAt: z.string().datetime().optional(),
    rotatedAt: z.string().datetime().optional(),
    lastUsedAt: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((account, context) => {
    const problem = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
    const isAws = account.kind === "aws_role";
    if (isAws !== (account.aws !== undefined)) problem(["aws"], "an AWS role account has the AWS block, and no other account does");
    if (isAws && account.secretRef !== undefined) problem(["secretRef"], "an AWS role account stores no secret");
    if (isAws && account.envNames.length > 0) problem(["envNames"], "an AWS role account is reached by a role, not a variable");
    if (!isAws && (account.kind === "api_key" || account.kind === "oauth_client" || account.kind === "basic") && account.secretRef === undefined) problem(["secretRef"], "this kind of account needs its secret reference");
    if (!account.family.startsWith("http:") && !account.family.startsWith("aws:")) problem(["family"], "a test account is for an outside API (http:<host>) or an AWS service (aws:<service>)");
    if (!isAws && account.family.startsWith("aws:")) problem(["family"], "only an AWS role account is for an AWS family");
    if (isAws && !account.family.startsWith("aws:")) problem(["family"], "an AWS role account is for an AWS family");
    if (account.family.startsWith("http:") && !account.hosts.includes(account.family.slice(5))) problem(["hosts"], "the account's own host is one of its hosts");
    if (account.family.startsWith("aws:") && account.aws !== undefined && !account.aws.actions.some((action) => action.startsWith(`${account.family.slice(4).replace(/-runtime$/u, "")}:`))) problem(["aws", "actions"], "the account approves an action of its own service");
    if (account.secretRef !== undefined) {
      const parts = parseTestAccountSecretRef(account.secretRef);
      if (parts !== undefined && (parts.orgId !== account.orgId || parts.accountId !== account.id)) problem(["secretRef"], "the reference points at this account's own secret in its own org");
    }
    if (new Set(account.hosts).size !== account.hosts.length) problem(["hosts"], "a host is listed once");
    if (account.aws !== undefined) {
      const regional = new RegExp(`^[a-z0-9-]+(?:\\.[a-z0-9-]+)?\\.${account.aws.region}\\.amazonaws\\.com$`, "u");
      account.hosts.forEach((host, index) => {
        if (!regional.test(host)) problem(["hosts", index], "an AWS account reaches the regional endpoints of its own region");
      });
    }
    if (new Set(account.envNames).size !== account.envNames.length) problem(["envNames"], "a variable is listed once");
    account.envNames.forEach((name, index) => {
      if (reservedDependencyEnvName(name)) problem(["envNames", index], "this variable is set by Rovara or the system");
    });
    if (account.projectIds !== "all" && new Set(account.projectIds).size !== account.projectIds.length) problem(["projectIds"], "a project is listed once");
    if (account.limits.maxRequestsPerRun > account.limits.maxRequestsPerDay) problem(["limits", "maxRequestsPerRun"], "a run's requests fit inside the day's");
    if (looksLikeSecretValue(account.label)) problem(["label"], "a label is not the place for a key");
    const latest = Math.max(0, ...account.approvals.map((approval) => Date.parse(approval.at)));
    if (account.status === "active") {
      if (!testAccountApprovalsSatisfied(account.approvals)) problem(["approvals"], "an active account is approved by two people with a fresh sign-in, or by the sole-owner exception");
      if (account.expiresAt === undefined) problem(["expiresAt"], "an active account expires");
    }
    if (account.expiresAt !== undefined && account.approvals.length > 0) {
      const expires = Date.parse(account.expiresAt);
      if (expires <= latest) problem(["expiresAt"], "an account expires after its last approval");
      if (expires - latest > TEST_ACCOUNT_EXPIRY_DAYS.max * DAY_MS) problem(["expiresAt"], "an account expires within a year of its last approval");
    }
  });
export type TestAccount = z.infer<typeof TestAccountSchema>;

// ---- the production deny list (6.3: at save and at every run)

export type TestAccountProdProblem = { kind: "prod_host" | "prod_arn" | "prod_account" | "prod_deny_missing" | "prod_shaped_host" | "vendor_production_host" | "rovara_account"; field: string };

/**
 * Everything in the account that names production, as fixed codes with the field they were found in: a host on the deny list or one that looks like production, a role or resource on it, an account
 * that is Rovara's own, or `prod_deny_missing` when the company has listed nothing at all (an account reaches a real remote, so the list must exist first). Empty: nothing found. `alsoDeny` is the list
 * the approved environment had, so removing an entry in the same change that points at it hides nothing.
 */
export function testAccountProdProblems(account: TestAccount, deny: TestEnvProdDeny, options: { alsoDeny?: TestEnvProdDeny; rovaraAccountIds?: readonly string[] } = {}): TestAccountProdProblem[] {
  const lists = options.alsoDeny === undefined ? [deny] : [deny, options.alsoDeny];
  if (lists.every((list) => prodDenyIsEmpty(list))) return [{ kind: "prod_deny_missing", field: "prodDeny" }];
  const found: TestAccountProdProblem[] = [];
  account.hosts.forEach((host, index) => {
    if (lists.some((list) => prodDenyMatchesHost(list, host))) found.push({ kind: "prod_host", field: `hosts[${String(index)}]` });
  });
  for (const problem of testAccountHostProblems(account.hosts)) found.push({ kind: problem.code, field: `hosts[${String(problem.index)}]` });
  const arns: Array<{ field: string; arn: string }> = [];
  if (account.aws !== undefined) {
    arns.push({ field: "aws.roleArn", arn: account.aws.roleArn });
    account.aws.resources.forEach((arn, index) => arns.push({ field: `aws.resources[${String(index)}]`, arn }));
  }
  for (const { field, arn } of arns) {
    const kind = lists.map((list) => prodDenyMatchesArn(list, arn)).find((match) => match !== undefined);
    if (kind !== undefined) found.push({ kind, field });
  }
  if (account.aws !== undefined) {
    const own = arnAccount(account.aws.roleArn);
    if (own !== undefined && (options.rovaraAccountIds ?? []).includes(own)) found.push({ kind: "rovara_account", field: "aws.roleArn" });
  }
  return found;
}
