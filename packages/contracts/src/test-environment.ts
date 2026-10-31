// The test environment (design proof-test-env, section 4): how a project's code is built and tested, which services are mocked and which are real, which data and accounts a run uses, and
// which tier it runs in. Rovara PROPOSES it from the repositories (detectors first, then a read-only model session), PROVES it by booting the app and running a smoke test, and a maintainer
// approves it once. It is a project setting with its own revision. Browser-safe: nothing here imports a Node module.
//
// What the schema itself guarantees, so no builder has to remember it:
//   - data is synthetic and only synthetic;
//   - video and traces are never on while any account is a long-lived `registered` one (the run-scoped-account gate of section 3.4, checked again at capture time);
//   - a tier has exactly the block it needs (`preview` for tier 2, `shared` for tier 3, neither for the sandbox);
//   - a service's mode has the block it needs (`preprod`, `mock`, or both for `auto`), and a pre-prod address is https;
//   - no secret is ever a value here: a credential is only ever a NAME in the project's secrets.
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import type { DecisionRisk } from "./decision-cards.js";
import { CheckKindSchema, EVIDENCE_SELECTION_METHODS } from "./evidence.js";
import { GitBranchNameSchema } from "./git-branch.js";
import { ProjectCommandSchema, RelativeWorkspacePathSchema } from "./project.js";
import { SetupDraftSchema } from "./rovara-code.js";
import { hostOfUrl, prodDenyMatchesArn, prodDenyMatchesHost, prodDenyMatchesPool } from "./test-environment-prod-deny.js";
import { sha256Hex } from "./web-hash.js";

const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
function line(max: number, min = 1) {
  return z.string().min(min).max(max).regex(NO_HIDDEN, "one plain line");
}
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const IdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const Https = z.string().max(2_048).regex(/^https:\/\/[^\s/?#@]+(?:\/[^\s?#]*)?$/u, "an https address with no credentials, query or fragment");
const AccountId = z.string().regex(/^\d{12}$/);
const Region = z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/u);
const RoleArn = z.string().max(256).regex(/^arn:aws(?:-[a-z]+)*:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,200}$/u, "an IAM role ARN");

export const TEST_ENV_TIERS = ["sandbox", "preview", "shared"] as const;
export const TestEnvTierSchema = z.enum(TEST_ENV_TIERS);
export type TestEnvTier = z.infer<typeof TestEnvTierSchema>;

/** Round budget: the whole check round's time limit, set by the approved environment (was the fixed 30 minutes). */
export const TEST_ENV_ROUND_BUDGET_MIN = { default: 30, min: 30, max: 120 } as const;

export const TEST_ENV_SELECTION_METHODS = EVIDENCE_SELECTION_METHODS;

/** The placeholder a per-check `selectArgs` template holds exactly once: the selected tests are put there, so Rovara never rewrites the customer's own command. */
export const TEST_ENV_SELECT_PLACEHOLDER = "{tests}";

const GlobSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_@%+=:,./*?{}[\]!-]+$/u, "a glob").refine((glob) => !glob.startsWith("/") && !glob.split("/").includes(".."), "a relative glob");

export const TestEnvCheckSchema = z
  .object({
    id: IdSchema,
    label: line(80),
    /** The customer's own command, as the project's checks have it. */
    command: ProjectCommandSchema,
    kind: CheckKindSchema,
    /** Where the check writes its own JUnit XML or vitest/jest JSON report, Cobertura XML or LCOV file, and SARIF file. A check with none has one verdict. */
    reportPath: RelativeWorkspacePathSchema.optional(),
    coveragePath: RelativeWorkspacePathSchema.optional(),
    sarifPath: RelativeWorkspacePathSchema.optional(),
    /** Arguments added after the command to run only the selected tests, with `{tests}` exactly once. Without one, the check always runs in full. */
    selectArgs: z.array(z.string().min(1).max(256)).max(8).optional(),
  })
  .strict()
  .superRefine((check, context) => {
    if (check.selectArgs !== undefined && check.selectArgs.filter((arg) => arg === TEST_ENV_SELECT_PLACEHOLDER).length !== 1) context.addIssue({ code: "custom", path: ["selectArgs"], message: "selectArgs holds {tests} exactly once" });
    if (check.selectArgs !== undefined && check.kind !== "test") context.addIssue({ code: "custom", path: ["selectArgs"], message: "only a test check selects tests" });
  });
export type TestEnvCheck = z.infer<typeof TestEnvCheckSchema>;

export const TEST_ENV_SERVICE_KINDS = ["sagemaker_runtime", "http", "aws_api"] as const;
export const TEST_ENV_SERVICE_MODES = ["auto", "preprod", "mock"] as const;
/** What a mock does with a request it has no recording for. `fail` (the default) answers 500 and the case fails; `schema_synth` is less safe and is always counted in the evidence. */
export const TEST_ENV_UNMATCHED = ["fail", "schema_synth"] as const;

export const TestEnvServiceSchema = z
  .object({
    name: line(80),
    kind: z.enum(TEST_ENV_SERVICE_KINDS),
    /** Which calls the service is: a host (`http`, `aws_api`) or an endpoint name (`sagemaker_runtime`); exactly one. */
    match: z.object({ host: z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/u).optional(), endpointName: z.string().min(1).max(63).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})$/u).optional() }).strict(),
    mode: z.enum(TEST_ENV_SERVICE_MODES),
    preprod: z
      .object({ url: Https.optional(), endpointArn: z.string().max(256).regex(/^arn:aws(?:-[a-z]+)*:sagemaker:[a-z0-9-]+:\d{12}:endpoint\/[A-Za-z0-9-]{1,63}$/u).optional(), roleArn: RoleArn.optional(), region: Region })
      .strict()
      .optional(),
    mock: z.object({ fixtureSetRef: Sha256Schema, schemaRef: Sha256Schema, unmatched: z.enum(TEST_ENV_UNMATCHED) }).strict().optional(),
  })
  .strict()
  .superRefine((service, context) => {
    const problem = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
    if ((service.match.host === undefined) === (service.match.endpointName === undefined)) problem(["match"], "a service is matched by a host or an endpoint name, one of them");
    if (service.kind === "sagemaker_runtime" && service.match.endpointName === undefined) problem(["match"], "a SageMaker Runtime service is matched by its endpoint name");
    if (service.kind !== "sagemaker_runtime" && service.match.host === undefined) problem(["match"], "this kind of service is matched by its host");
    if ((service.mode === "preprod" || service.mode === "auto") && service.preprod === undefined) problem(["preprod"], "this mode needs the pre-prod block");
    if ((service.mode === "mock" || service.mode === "auto") && service.mock === undefined) problem(["mock"], "this mode needs the mock block");
    if (service.mode === "mock" && service.preprod !== undefined) problem(["preprod"], "a mocked service has no pre-prod block");
    if (service.mode === "preprod" && service.mock !== undefined) problem(["mock"], "a pre-prod service has no mock block");
    if (service.preprod !== undefined && (service.preprod.url === undefined) === (service.preprod.endpointArn === undefined)) problem(["preprod"], "pre-prod is an address or an endpoint ARN, one of them");
  });
export type TestEnvService = z.infer<typeof TestEnvServiceSchema>;

export const TEST_ENV_PROVISIONERS = ["seed_command", "cognito_test_pool", "http_hook", "registered"] as const;
/** Account provisioners that make a fresh account for the round and delete it after (run-scoped): the only ones a video or trace may be kept for. */
export const TEST_ENV_RUN_SCOPED_PROVISIONERS = ["seed_command", "cognito_test_pool", "http_hook"] as const;
export function provisionerIsRunScoped(provisioner: (typeof TEST_ENV_PROVISIONERS)[number]): boolean {
  return provisioner !== "registered";
}

export const TestEnvAccountSchema = z.discriminatedUnion("provisioner", [
  z.object({ profileId: IdSchema, provisioner: z.literal("seed_command"), command: ProjectCommandSchema }).strict(),
  z.object({ profileId: IdSchema, provisioner: z.literal("cognito_test_pool"), userPoolId: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d_[A-Za-z0-9]{1,64}$/u), region: Region, roleArn: RoleArn }).strict(),
  /** The customer's own test-account endpoints (create and delete), called with a short-lived token read from a NAME in the project's secrets. */
  z.object({ profileId: IdSchema, provisioner: z.literal("http_hook"), createUrl: Https, deleteUrl: Https, tokenSecretName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u) }).strict(),
  /** Today's 14-day registry account: not run-scoped. */
  z.object({ profileId: IdSchema, provisioner: z.literal("registered"), registryProfileId: IdSchema }).strict(),
]);
export type TestEnvAccount = z.infer<typeof TestEnvAccountSchema>;

export const TEST_ENV_PREVIEW_PROVIDERS = ["cdk", "cloudformation", "terraform", "script"] as const;
export const TEST_ENV_PREVIEW_TTL_HOURS_MAX = 24;

export const TestEnvironmentBodySchema = z
  .object({
    tier: TestEnvTierSchema,
    repos: z
      .array(z.object({ repositoryId: line(200), setupCommands: z.array(ProjectCommandSchema).max(20), checks: z.array(TestEnvCheckSchema).max(32) }).strict())
      .min(1)
      .max(16),
    roundBudgetMin: z.number().int().min(TEST_ENV_ROUND_BUDGET_MIN.min).max(TEST_ENV_ROUND_BUDGET_MIN.max),
    selection: z
      .object({
        method: z.enum(TEST_ENV_SELECTION_METHODS),
        declared: z.array(z.object({ glob: GlobSchema, tests: z.array(GlobSchema).min(1).max(50) }).strict()).max(100).optional(),
        alwaysRun: z.array(IdSchema).max(32),
        /** Changing any of these runs the whole suite: lockfiles, conftest, build and CI config. */
        fullSuiteOn: z.array(GlobSchema).max(100),
      })
      .strict(),
    nightly: z.object({ enabled: z.boolean(), cronUtc: z.string().regex(/^[0-9*/,-]+(?: [0-9*/,-]+){4}$/u).max(64), branch: GitBranchNameSchema }).strict(),
    services: z.array(TestEnvServiceSchema).max(32),
    /** Synthetic data only: seeded so a run repeats. A seed is a command or a fixture file inside the repository. */
    data: z
      .object({ seeds: z.array(z.union([z.object({ command: ProjectCommandSchema }).strict(), z.object({ fixturePath: RelativeWorkspacePathSchema }).strict()])).max(20), generator: z.literal("faker_seeded"), seed: z.number().int().min(0).max(2_147_483_647) })
      .strict(),
    accounts: z.array(TestEnvAccountSchema).max(16),
    /** What identifies production, so a run refuses to touch it. Enterprise lists its prod accounts at setup; Public has the same field. */
    prodDeny: z.object({ accountIds: z.array(AccountId).max(50), hosts: z.array(z.string().min(1).max(253).regex(/^[a-z0-9.*-]+$/u)).max(100), arnPrefixes: z.array(z.string().min(8).max(256).regex(/^arn:[A-Za-z0-9:*/_.-]+$/u)).max(100) }).strict(),
    preview: z
      .object({
        provider: z.enum(TEST_ENV_PREVIEW_PROVIDERS),
        stackTemplate: RelativeWorkspacePathSchema,
        deployRoleArn: RoleArn,
        ttlHours: z.number().int().min(1).max(TEST_ENV_PREVIEW_TTL_HOURS_MAX),
        costCapUsdPerDay: z.number().positive().max(100_000),
        /** If the preview cannot be made: fall back to the sandbox, or ask. */
        fallbackTier: z.enum(["sandbox", "ask"]),
      })
      .strict()
      .optional(),
    shared: z.object({ baseUrl: Https, leaseScope: z.enum(["env", "account"]), dataNamespace: z.literal("task_prefix") }).strict().optional(),
    capture: z.object({ screenshots: z.enum(["failed", "all"]), video: z.boolean(), traces: z.boolean() }).strict(),
  })
  .strict()
  .superRefine((env, context) => {
    const problem = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
    const unique = (values: readonly string[]) => new Set(values).size === values.length;
    if ((env.tier === "preview") !== (env.preview !== undefined)) problem(["preview"], "the preview block is there exactly for tier 2");
    if ((env.tier === "shared") !== (env.shared !== undefined)) problem(["shared"], "the shared block is there exactly for tier 3");
    const checkIds = env.repos.flatMap((repo) => repo.checks.map((check) => check.id));
    if (!unique(checkIds)) problem(["repos"], "check ids are unique across the repositories");
    if (!unique(env.repos.map((repo) => repo.repositoryId))) problem(["repos"], "a repository appears once");
    if (env.selection.alwaysRun.some((id) => !checkIds.includes(id))) problem(["selection", "alwaysRun"], "alwaysRun names checks of this environment");
    if (!unique(env.selection.alwaysRun)) problem(["selection", "alwaysRun"], "alwaysRun names a check once");
    if (env.selection.method === "declared" && (env.selection.declared === undefined || env.selection.declared.length === 0)) problem(["selection", "declared"], "declared selection lists its globs");
    if (!unique(env.services.map((service) => service.name))) problem(["services"], "service names are unique");
    if (!unique(env.accounts.map((account) => account.profileId))) problem(["accounts"], "account profiles are unique");
    if ((env.capture.video || env.capture.traces) && env.accounts.some((account) => !provisionerIsRunScoped(account.provisioner))) problem(["capture"], "video and traces need every account to be run-scoped");
    // Tier 3 keeps a video or trace only with a provisioner that deletes its accounts: a shared environment with no run-scoped account has nothing to show they were dead.
    if ((env.capture.video || env.capture.traces) && env.tier === "shared" && env.accounts.length === 0) problem(["capture"], "video and traces in a shared environment need a run-scoped account provisioner");
    // Nothing the environment points at may be production: every pre-prod, shared, preview and account target is checked against the deny list.
    for (const target of testEnvTargets(env)) {
      if (targetIsProd(env.prodDeny, target)) problem(target.path, "this target is on the production deny list");
    }
  });
export type TestEnvironmentBody = z.infer<typeof TestEnvironmentBodySchema>;

/** The stored setting: the environment at a revision (each approved change is a new revision; a task keeps the one it started with). */
export const TestEnvironmentSchema = z.object({ revision: z.number().int().min(1), approvedAt: z.string().datetime(), environment: TestEnvironmentBodySchema }).strict();
export type TestEnvironment = z.infer<typeof TestEnvironmentSchema>;

/** The digest an approval and a Prove run are bound to: the body only, with its keys in a fixed order, so a revision bump alone does not change it. */
export function testEnvDigest(body: TestEnvironmentBody): string {
  return sha256Hex(canonicalJson(TestEnvironmentBodySchema.parse(body)));
}


// ---- targets and the production deny list

type TargetKind = "host" | "arn" | "pool";
interface EnvTarget {
  path: (string | number)[];
  kind: TargetKind;
  value: string;
  region?: string;
}

/** Every address and ARN the environment would call, with where it is in the body. */
function testEnvTargets(env: TestEnvironmentBody): EnvTarget[] {
  const targets: EnvTarget[] = [];
  const host = (path: (string | number)[], url: string | undefined) => {
    if (url === undefined) return;
    // The one host reading the whole product uses (userinfo, port and trailing dot do not hide a host). A URL with no readable host is checked as an empty host, which counts as production.
    targets.push({ path, kind: "host", value: hostOfUrl(url) ?? "" });
  };
  const arn = (path: (string | number)[], value: string | undefined) => {
    if (value !== undefined) targets.push({ path, kind: "arn", value });
  };
  env.services.forEach((service, index) => {
    host(["services", index, "preprod", "url"], service.preprod?.url);
    arn(["services", index, "preprod", "endpointArn"], service.preprod?.endpointArn);
    arn(["services", index, "preprod", "roleArn"], service.preprod?.roleArn);
  });
  host(["shared", "baseUrl"], env.shared?.baseUrl);
  arn(["preview", "deployRoleArn"], env.preview?.deployRoleArn);
  env.accounts.forEach((account, index) => {
    if (account.provisioner === "cognito_test_pool") {
      arn(["accounts", index, "roleArn"], account.roleArn);
      targets.push({ path: ["accounts", index, "userPoolId"], kind: "pool", value: account.userPoolId, region: account.region });
    }
    if (account.provisioner === "http_hook") {
      host(["accounts", index, "createUrl"], account.createUrl);
      host(["accounts", index, "deleteUrl"], account.deleteUrl);
    }
  });
  return targets;
}

function targetIsProd(deny: TestEnvironmentBody["prodDeny"], target: EnvTarget): boolean {
  if (target.kind === "host") return prodDenyMatchesHost(deny, target.value);
  if (target.kind === "pool") return prodDenyMatchesPool(deny, target.region ?? "", target.value);
  return prodDenyMatchesArn(deny, target.value) !== undefined;
}

/** The signature of what a pre-prod service points at; a different one is a different target even under the same name. */
const preprodSignature = (service: TestEnvService): string | undefined => (service.preprod === undefined ? undefined : JSON.stringify([service.preprod.url ?? null, service.preprod.endpointArn ?? null, service.preprod.roleArn ?? null, service.preprod.region]));
const accountSignature = (account: TestEnvAccount): string | undefined =>
  account.provisioner === "cognito_test_pool" ? JSON.stringify([account.userPoolId, account.region, account.roleArn]) : account.provisioner === "http_hook" ? JSON.stringify([account.createUrl, account.deleteUrl, account.tokenSecretName]) : undefined;

/** Whether the environment's targets include anything on the production deny list (the schema refuses such a body; this is for a caller that holds a body already parsed). */
export function testEnvTouchesProd(env: TestEnvironmentBody): boolean {
  return testEnvTargets(env).some((target) => targetIsProd(env.prodDeny, target));
}

// ---- less-safe fields and the approval card's risk

/** The fields whose change is a less-safe change (a second person and a fresh sign-in, like a less-safe process change). */
export const TEST_ENV_LESS_SAFE_FIELDS = ["preprod", "shared", "preview", "video", "traces", "schema_synth", "round_budget_raised", "preprod_target_changed", "shared_target_changed", "preview_target_changed", "account_target_changed", "prod_deny_reduced", "nightly_enabled", "nightly_more_often", "preview_cost_raised"] as const;
export type TestEnvLessSafeField = (typeof TEST_ENV_LESS_SAFE_FIELDS)[number];

function lessSafeSet(env: TestEnvironmentBody): Set<TestEnvLessSafeField> {
  const set = new Set<TestEnvLessSafeField>();
  if (env.services.some((service) => service.preprod !== undefined)) set.add("preprod");
  if (env.shared !== undefined) set.add("shared");
  if (env.preview !== undefined) set.add("preview");
  if (env.capture.video) set.add("video");
  if (env.capture.traces) set.add("traces");
  if (env.services.some((service) => service.mock?.unmatched === "schema_synth")) set.add("schema_synth");
  // A nightly run is a full run of the suite on a worker, paid for by the project: turning it on is a spending change.
  if (env.nightly.enabled) set.add("nightly_enabled");
  return set;
}

/** How many times a five-field cron fires in a week, roughly (a month is 30 days, a restricted month counts its share). Anything it cannot read counts as unbounded, so an odd cron is never "less often". */
export function cronRunsPerWeek(cron: string): number {
  const fields = cron.trim().split(/\s+/u);
  if (fields.length !== 5) return Number.POSITIVE_INFINITY;
  const count = (field: string, min: number, max: number): number => {
    const seen = new Set<number>();
    for (const part of field.split(",")) {
      const step = /^(\*|\d+(?:-\d+)?)\/(\d+)$/u.exec(part);
      const range = /^(\d+)-(\d+)$/u.exec(part);
      let from: number, to: number, by = 1;
      if (step !== null) {
        by = Number(step[2]);
        if (step[1] === "*") { from = min; to = max; } else { const [a, b] = step[1]!.split("-"); from = Number(a); to = b === undefined ? max : Number(b); }
      } else if (range !== null) { from = Number(range[1]); to = Number(range[2]); } else if (part === "*") { from = min; to = max; } else if (/^\d+$/u.test(part)) { from = Number(part); to = from; } else return Number.POSITIVE_INFINITY;
      if (!Number.isInteger(by) || by < 1 || from < min || to > max || from > to) return Number.POSITIVE_INFINITY;
      for (let value = from; value <= to; value += by) seen.add(value);
    }
    return seen.size;
  };
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const perDay = count(minute, 0, 59) * count(hour, 0, 23);
  const days = dow !== "*" ? count(dow, 0, 7) : dom !== "*" ? (count(dom, 1, 31) * 7) / 30 : 7;
  const months = month === "*" ? 1 : count(month, 1, 12) / 12;
  return perDay * days * months;
}

/**
 * The less-safe fields this change turns on, against the approved environment before it (none: the first proposal, where every less-safe field it has is a change). A field already on and unchanged is
 * not a change; a raised round budget is. Pure and deterministic, so the card and the server agree.
 */
export function testEnvLessSafeChanges(previous: TestEnvironmentBody | undefined, next: TestEnvironmentBody): TestEnvLessSafeField[] {
  const before = previous === undefined ? new Set<TestEnvLessSafeField>() : lessSafeSet(previous);
  const changed = [...lessSafeSet(next)].filter((field) => !before.has(field));
  if (previous !== undefined && next.roundBudgetMin > previous.roundBudgetMin) changed.push("round_budget_raised");
  if (previous !== undefined) {
    // A target that already existed and was moved, or one more target added next to an old one, is as risky as turning pre-prod on: compared by value, per service, never by "was it already on".
    const before = new Map(previous.services.map((service) => [service.name, preprodSignature(service)] as const));
    if (next.services.some((service) => preprodSignature(service) !== undefined && before.get(service.name) !== preprodSignature(service))) changed.push("preprod_target_changed");
    if (previous.shared !== undefined && next.shared !== undefined && previous.shared.baseUrl !== next.shared.baseUrl) changed.push("shared_target_changed");
    if (previous.preview !== undefined && next.preview !== undefined && (previous.preview.deployRoleArn !== next.preview.deployRoleArn || previous.preview.stackTemplate !== next.preview.stackTemplate || previous.preview.provider !== next.preview.provider)) changed.push("preview_target_changed");
    const accountsBefore = new Map(previous.accounts.map((account) => [account.profileId, accountSignature(account)] as const));
    if (next.accounts.some((account) => accountSignature(account) !== undefined && accountsBefore.get(account.profileId) !== accountSignature(account))) changed.push("account_target_changed");
    const missing = (was: readonly string[], now: readonly string[]) => was.some((entry) => !now.includes(entry));
    if (cronRunsPerWeek(next.nightly.cronUtc) > cronRunsPerWeek(previous.nightly.cronUtc) && next.nightly.enabled) changed.push("nightly_more_often");
    if (previous.preview !== undefined && next.preview !== undefined && (next.preview.costCapUsdPerDay > previous.preview.costCapUsdPerDay || next.preview.ttlHours > previous.preview.ttlHours)) changed.push("preview_cost_raised");
    if (missing(previous.prodDeny.accountIds, next.prodDeny.accountIds) || missing(previous.prodDeny.hosts, next.prodDeny.hosts) || missing(previous.prodDeny.arnPrefixes, next.prodDeny.arnPrefixes)) changed.push("prod_deny_reduced");
  }
  return changed.sort((a, b) => TEST_ENV_LESS_SAFE_FIELDS.indexOf(a) - TEST_ENV_LESS_SAFE_FIELDS.indexOf(b));
}

/** The risk of the `approve_test_env` card: medium; high when the environment adds pre-prod access, a shared environment, tier 2, or video or traces. Deterministic: no model output sets it. */
export function testEnvApprovalRisk(env: TestEnvironmentBody): DecisionRisk {
  const set = lessSafeSet(env);
  return set.has("preprod") || set.has("shared") || set.has("preview") || set.has("video") || set.has("traces") || env.tier !== "sandbox" ? "high" : "medium";
}

// ---- the proposal and the Prove run

/** Where a proposed value came from: a file and line, a code detector, or the setup agent's own reading. */
export const TestEnvValueSourceSchema = z.union([z.object({ path: line(500), line: z.number().int().min(1).max(10_000_000) }).strict(), z.literal("model"), z.string().regex(/^detector:[a-z0-9_-]{1,40}$/u)]);
export type TestEnvValueSource = z.infer<typeof TestEnvValueSourceSchema>;

/** The setup agent's proposal: today's `SetupDraft` (and its flagged commands, which stay flagged) plus the test environment it proposes and the source of each value. A proposal, nothing more. */
export const TestEnvironmentProposalSchema = SetupDraftSchema.extend({
  environment: TestEnvironmentBodySchema,
  /** One entry per proposed value, named by a path into `environment` (`services[0].mode`); a value with none reads as `model`. */
  valueSources: z.array(z.object({ field: line(200), source: TestEnvValueSourceSchema }).strict()).max(400),
});
export type TestEnvironmentProposal = z.infer<typeof TestEnvironmentProposalSchema>;

export const TEST_ENV_PROVE_STEPS = ["setup", "build", "boot", "smoke", "full_suite", "mocks", "preprod_probe"] as const;
/** Why a Prove step failed, in fixed words (never the command's own text; the redacted tail is separate). */
export const TEST_ENV_PROVE_FAILURES = ["setup_failed", "build_failed", "boot_failed", "health_timeout", "smoke_failed", "tests_failed", "round_budget_exceeded", "mock_unmatched", "preprod_unreachable", "coverage_unreadable", "infrastructure"] as const;

export const TestEnvProveReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** The `testEnvDigest` of the proposal that was proved: a report for any other digest is ignored. */
    proposalDigest: Sha256Schema,
    steps: z
      .array(
        z
          .object({
            step: z.enum(TEST_ENV_PROVE_STEPS),
            status: z.enum(["passed", "failed", "skipped"]),
            durationMs: z.number().int().min(0),
            failure: z.enum(TEST_ENV_PROVE_FAILURES).optional(),
            /** A redacted tail of the failing step's output; plain text. */
            outputTail: z.string().max(4_096).optional(),
          })
          .strict()
          .refine((step) => (step.status === "failed") === (step.failure !== undefined), { message: "a failed step names its failure, and no other does", path: ["failure"] }),
      )
      .max(TEST_ENV_PROVE_STEPS.length),
    /** The first full run, timed: how long the whole suite takes and how many tests it ran. */
    fullSuite: z.object({ durationMs: z.number().int().min(0), tests: z.number().int().min(0).max(100_000_000) }).strict().optional(),
    /** The coverage map the full run recorded (a stored artifact's digest), when coverage contexts were on. */
    coverageMapRef: Sha256Schema.optional(),
    services: z.array(z.object({ name: line(80), modeUsed: z.enum(["preprod", "mocked"]) }).strict()).max(32),
    finishedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((report, context) => {
    if (new Set(report.steps.map((step) => step.step)).size !== report.steps.length) context.addIssue({ code: "custom", path: ["steps"], message: "a step appears once" });
  });
export type TestEnvProveReport = z.infer<typeof TestEnvProveReportSchema>;

/** Whether a Prove run passed for this proposal: every step passed or was skipped, and the report is for exactly this digest. A missing or unreadable report is never "proved". */
export function testEnvIsProved(report: TestEnvProveReport | undefined, proposalDigest: string): boolean {
  if (report === undefined || report.proposalDigest !== proposalDigest || report.steps.length === 0 || report.steps.some((step) => step.status === "failed")) return false;
  // Skipped is not proved: something must have actually passed that exercises the code (the smoke check or the full suite), and an app that is a service must have booted.
  const passed = (name: (typeof TEST_ENV_PROVE_STEPS)[number]) => report.steps.some((step) => step.step === name && step.status === "passed");
  return (passed("smoke") || passed("full_suite")) && (report.services.length === 0 || passed("boot"));
}

// ---- the synthetic-data guard

/** What the guard can find (a fixture, a seed or an API sample): personal data patterns, or something that names production. */
export const DATA_GUARD_FINDING_KINDS = ["email", "phone", "government_id", "card_number", "secret", "prod_host", "prod_arn", "prod_account"] as const;
export const DATA_GUARD_SOURCES = ["fixture", "seed", "api_sample"] as const;
export const DataGuardReportSchema = z
  .object({
    ok: z.boolean(),
    /** Fixed codes and positions only: the matched text is never kept. */
    findings: z.array(z.object({ kind: z.enum(DATA_GUARD_FINDING_KINDS), source: z.enum(DATA_GUARD_SOURCES), path: line(300) }).strict()).max(100),
  })
  .strict()
  .refine((report) => report.ok === (report.findings.length === 0), { message: "ok exactly when there are no findings", path: ["ok"] });
export type DataGuardReport = z.infer<typeof DataGuardReportSchema>;
