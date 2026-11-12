// Test environment (wire-testenv): the shapes that cross the wire between the broker and the worker, and the answers of the setup routes.
//
//   TestEnvDraftSchema    what a SETUP_DRAFT run reports when the broker asked it to detect (`testEnvDetect`): the detectors' environment with the source of each value. A DRAFT is never approved or run: the broker
//                         reads it again, refuses anything but the safest tier, and only a maintainer's propose / prove / approve makes it a revision.
//   TestEnvTaskPlanSchema what a CHECKS run is sent when the project has an approved environment: which readiness commands are the environment's checks, how to select tests, the round budget and the nightly's inputs.
//   the route answers     what `GET/POST /v1/app/projects/{name}/test-environment*` say.
//
// The feature strings are what a worker advertises on /ping: an older worker is refused the run at dispatch (a strict parse would refuse the field), never mis-run.
import { z } from "zod";
import { CatalogConfigSchema, catalogIdName, CatalogIdSchema, CheckKindSchema, ConnectTemplateSchema, CoverageMapSchema, DnsLabelSchema, EnvNameSchema, FamilyIdSchema, IacSeedRefSchema, ProjectCommandSchema, RelativeWorkspacePathSchema, reservedDependencyEnvName, SeedScriptLockSchema, TASK_DEPENDENCY_PLAN_MAX, TEST_ENV_DEPENDENCY_LIMITS, TEST_ENV_DEPENDENCY_RESETS, TEST_ENV_HELPER_CATALOG_NAMES, TEST_ENV_PLAN_FAILURES_MAX, TEST_ENV_PLAN_MAP_MAX_BYTES, TEST_ENV_RESERVED_ALIASES, TEST_ENV_ROUND_BUDGET_MIN, TEST_ENV_SELECT_PLACEHOLDER, TEST_ENV_SELECTION_METHODS, SEEDED_AWS_SERVICES, TestEnvDependencyIdSchema, TestEnvDependencyKindSchema, TestEnvRegionSchema } from "@rovara-code/contracts";
// Code's own since the vendor pin 0e340c0e (one name, one owner): re-exported, not defined here.
export { TEST_SERVICES_COMPANY_IMAGE_PLAN_FEATURE } from "@rovara-code/contracts";
/**
 * Company-approved extra images (switch `pj`): a worker that lists this reads a plan dependency with `backing: "company"` and its `company` block (an image a company admin approved, by registry, repository and digest) and can
 * start exactly that digest. No worker lists it yet, so the broker never sends such a plan to any worker (`ec2-delivery.ts`); a worker that does not know the backing refuses it by its strict parse, and one that knows it and
 * cannot serve it refuses it by name. In `WORKER_INVOCATION_FEATURES`.
 */

const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
const line = (max: number) => z.string().min(1).max(max).regex(NO_HIDDEN, "one plain line");
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
/** A mirror repository of a company image (company-image-mirror.ts `companyImageRepositoryName`): the saved-environment family, `rovara-env/<env>/o<org hash>/c<image hash>`. Written out here, not imported, so the browser entry that reads plans does not pull the registry names in. */
const MIRROR_REPOSITORY = /^rovara-env\/[a-z][a-z0-9-]{0,19}\/o[a-f0-9]{32}\/c[a-f0-9]{32}$/u;
const Id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);

/**
 * Test services: one dependency of a task's run as the worker starts it. Everything is a pin or a name, never a secret: the catalog entry and image digest the broker chose (the worker checks its own signed catalog agrees
 * on the digest and refuses otherwise), the names the code reaches it by, the connection TEMPLATES (the worker fills `{user}`, `{password}` and the rest at run time; the run's own password never rides here), the seeds
 * and the reset. Slice 1 starts real software from the catalog only (`backing: "local"`); a later slice that starts anything else lists it under a new feature string.
 */
export const TaskDependencyPlanSchema = z
  .object({
    id: TestEnvDependencyIdSchema,
    name: line(80),
    kind: TestEnvDependencyKindSchema,
    family: FamilyIdSchema,
    /**
     * `local`: real software from the catalog. `emulated` (slice 2): Rovara local AWS, with the `aws` block below; every emulated entry of one plan names the same image, and all of them share one helper.
     * `fake` (slice 3): the fake server, from the worker's own image, serving the approved fixture set the `fake` block names.
     */
    backing: z.enum(["local", "emulated", "fake", "company"]),
    catalogId: CatalogIdSchema,
    /** The repository under the install's registry (`svc/postgres`); the registry host is the install's. */
    repository: z.string().regex(/^svc\/[a-z0-9][a-z0-9._-]{0,62}$/u),
    /** The image digest the catalog pinned: required, because an unpinned image is never started. A fake has none: its server is the worker's own image (the catalog marks it a worker-image helper). */
    digest: Sha256.optional(),
    /**
     * Only on a `fake` entry: the digest of the approved fixture set the fake serves, and what it does with a request nothing in the set matches. NOT a URL: a 15-minute read address would expire before the round, so the
     * worker asks the broker for a fresh one at the start of each phase (the `fixture-set` callback), and holds the downloaded set to this digest. `fail` is the only policy this slice carries: a request with no
     * recording is answered with an error and counted (a made-up answer is not available yet).
     */
    fake: z.object({ fixtureSetRef: Sha256, unmatched: z.literal("fail") }).strict().optional(),
    /**
     * Only on a `company` entry (switch `pj`): the image a company admin approved, so a company image is never dressed as one of Rovara's catalog images. `imageId` is the approval's id (it names the digest), `registry` and
     * `repository` say where the image comes from, and `digest` is the approved digest (equal to the plan's `digest`). `catalogId` is then only the catalog entry whose RUN PROFILE the image runs with (user, memory, ports,
     * health check, reset), never the source of the image. `digest` is the digest of the image's linux/arm64 manifest (company-image-mirror.ts: the pin is the platform digest). `mirror` is where the worker pulls it from:
     * a repository of the install's own registry (never the source registry) holding exactly that digest.
     */
    company: z.object({ imageId: z.string().regex(/^img_[a-f0-9]{20}$/u), registry: z.string().min(4).max(253), repository: z.string().min(1).max(250), digest: Sha256, mirror: z.object({ repository: z.string().regex(MIRROR_REPOSITORY), digest: Sha256 }).strict() }).strict().optional(),
    /** Names and files carried over from the project (database, user, extensions, init files); no password. */
    config: CatalogConfigSchema,
    aliases: z.array(DnsLabelSchema).max(TEST_ENV_DEPENDENCY_LIMITS.hostAliases),
    connect: z.array(z.object({ name: EnvNameSchema, template: ConnectTemplateSchema }).strict()).max(TEST_ENV_DEPENDENCY_LIMITS.connectEnv),
    /**
     * The dependency's seeds. Review I3 (owner decision 12, SEED-FILE-LOCK): a file seed of a plan made from an APPROVED environment names the sha256 the approval bound, and the worker refuses a file whose content
     * differs. A candidate check's plan names none (it loads the file and reports the sha256 it loaded, which the approval binds). SEED-RISK-1: a command seed may carry the broker's `lock` (seed-script-lock.ts); the
     * worker re-hashes it from its checkout before every run and refuses on a difference.
     */
    seeds: z.array(z.union([z.object({ command: ProjectCommandSchema, lock: SeedScriptLockSchema.optional() }).strict(), z.object({ fixturePath: RelativeWorkspacePathSchema, sha256: Sha256.optional() }).strict()])).max(TEST_ENV_DEPENDENCY_LIMITS.seeds),
    reset: z.enum(TEST_ENV_DEPENDENCY_RESETS),
    /** Only on an `emulated` entry: the AWS services this dependency needs from Rovara local AWS, the region the code is told, and where the project declares its resources (a file, never read by the broker). */
    aws: z.object({ services: z.array(z.enum(SEEDED_AWS_SERVICES)).min(1).max(SEEDED_AWS_SERVICES.length), region: TestEnvRegionSchema, resources: IacSeedRefSchema.optional() }).strict().optional(),
  })
  .strict()
  .superRefine((plan, context) => {
    const problem = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
    if (plan.backing === "local" && (TEST_ENV_HELPER_CATALOG_NAMES as readonly string[]).includes(catalogIdName(plan.catalogId))) problem(["catalogId"], "a local dependency is real software from the catalog, not one of Rovara's helpers");
    if (plan.backing === "local" && plan.aws !== undefined) problem(["aws"], "only an emulated dependency has AWS services");
    if (plan.backing === "company") {
      if ((TEST_ENV_HELPER_CATALOG_NAMES as readonly string[]).includes(catalogIdName(plan.catalogId))) problem(["catalogId"], "a company image runs with the profile of real software from the catalog, not of one of Rovara's helpers");
      if (plan.company === undefined) problem(["company"], "a company image names the approval it runs");
      else if (plan.company.digest !== plan.digest) problem(["company", "digest"], "a company image runs exactly the digest that was approved");
      else if (plan.company.mirror.digest !== plan.digest) problem(["company", "mirror", "digest"], "the mirrored copy is exactly the digest that was approved");
      if (plan.aws !== undefined) problem(["aws"], "only an emulated dependency has AWS services");
    } else if (plan.company !== undefined) problem(["company"], "only a company image names an approval");
    if (plan.backing === "fake") {
      if (catalogIdName(plan.catalogId) !== "fake-server") problem(["catalogId"], "a fake dependency runs the fake server");
      if (plan.fake === undefined) problem(["fake"], "a fake dependency names its fixture set");
      if (plan.digest !== undefined) problem(["digest"], "the fake server is the worker's own image: it has no image digest");
      if (plan.aws !== undefined) problem(["aws"], "only an emulated dependency has AWS services");
    } else {
      if (plan.digest === undefined) problem(["digest"], "an image that is started is pinned by digest");
      if (plan.fake !== undefined) problem(["fake"], "only a fake dependency has a fixture set");
    }
    if (plan.backing === "emulated") {
      if (catalogIdName(plan.catalogId) !== "local-aws") problem(["catalogId"], "an emulated dependency runs Rovara local AWS");
      if (!plan.family.startsWith("aws:")) problem(["family"], "Rovara local AWS backs AWS families only");
      if (plan.aws === undefined) problem(["aws"], "an emulated dependency names its AWS services");
      else {
        if (new Set(plan.aws.services).size !== plan.aws.services.length) problem(["aws", "services"], "a service is listed once");
        if (plan.family.startsWith("aws:") && !(plan.aws.services as readonly string[]).includes(plan.family.slice(4))) problem(["aws", "services"], "the services include the family's own service");
      }
    }
    if (new Set(plan.aliases).size !== plan.aliases.length) problem(["aliases"], "an alias is listed once");
    plan.aliases.forEach((alias, index) => {
      if ((TEST_ENV_RESERVED_ALIASES as readonly string[]).includes(alias)) problem(["aliases", index], "this name belongs to a Rovara helper");
    });
    if (new Set(plan.connect.map((entry) => entry.name)).size !== plan.connect.length) problem(["connect"], "a variable is set once");
    plan.connect.forEach((entry, index) => {
      if (reservedDependencyEnvName(entry.name)) problem(["connect", index, "name"], "this variable is set by Rovara or the system, not by a dependency");
    });
  });
export type TaskDependencyPlan = z.infer<typeof TaskDependencyPlanSchema>;

export const TestEnvTaskPlanSchema = z
  .object({
    revision: z.number().int().min(1),
    /** The approved environment's digest (`testEnvDigest`): the worker echoes it into the evidence, the broker compares it. */
    digest: Sha256,
    roundBudgetMin: z.number().int().min(TEST_ENV_ROUND_BUDGET_MIN.min).max(TEST_ENV_ROUND_BUDGET_MIN.max),
    selection: z
      .object({
        method: z.enum(TEST_ENV_SELECTION_METHODS),
        declared: z.array(z.object({ glob: z.string().min(1).max(256), tests: z.array(z.string().min(1).max(256)).min(1).max(50) }).strict()).max(100).optional(),
        alwaysRun: z.array(Id).max(32),
        fullSuiteOn: z.array(z.string().min(1).max(256)).max(100),
      })
      .strict(),
    /** Readiness command `i` of the run is the environment's check `checks[i]`, for `i < checks.length`: the run's first commands are the environment's checks, in order. */
    checks: z.array(z.object({ id: Id, kind: CheckKindSchema, coveragePath: RelativeWorkspacePathSchema.optional(), selectArgs: z.array(z.string().min(1).max(256)).max(8).optional() }).strict()
      .superRefine((check, context) => {
        if (check.selectArgs !== undefined && check.selectArgs.filter((arg) => arg === TEST_ENV_SELECT_PLACEHOLDER).length !== 1) context.addIssue({ code: "custom", path: ["selectArgs"], message: "selectArgs holds {tests} exactly once" });
      })).min(1).max(32),
    /** The tests that failed in the last nightly: they always run. */
    lastNightlyFailures: z.array(z.string().min(1).max(500)).max(TEST_ENV_PLAN_FAILURES_MAX).optional(),
    /** The nightly's coverage map, only when it fits (`TEST_ENV_PLAN_MAP_MAX_BYTES`); without it a coverage-map selection runs the whole check, with its reason. */
    coverageMap: CoverageMapSchema.optional(),
    /**
     * Test services: the dependencies this run starts, pinned. Present only when the switch `tx` is on, the project's approved environment has dependencies and the plan could pin every one of them (otherwise the run is
     * refused before dispatch, never sent half a plan); absent otherwise, so a plan without test services is today's plan byte for byte. Sent only to a worker whose /ping lists `TEST_SERVICES_PLAN_FEATURE`. Never empty.
     */
    dependencies: z.array(TaskDependencyPlanSchema).min(1).max(TASK_DEPENDENCY_PLAN_MAX).optional(),
  })
  .strict()
  .refine((plan) => plan.coverageMap === undefined || JSON.stringify(plan.coverageMap).length <= TEST_ENV_PLAN_MAP_MAX_BYTES, { message: "an inline coverage map is at most 256 KiB", path: ["coverageMap"] })
  .superRefine((plan, context) => {
    const dependencies = plan.dependencies ?? [];
    const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;
    if (!unique(dependencies.map((dependency) => dependency.id))) context.addIssue({ code: "custom", path: ["dependencies"], message: "dependency ids are unique" });
    if (!unique(dependencies.flatMap((dependency) => dependency.connect.map((entry) => entry.name)))) context.addIssue({ code: "custom", path: ["dependencies"], message: "two dependencies set the same variable" });
    if (!unique(dependencies.flatMap((dependency) => dependency.aliases))) context.addIssue({ code: "custom", path: ["dependencies"], message: "two dependencies use the same alias" });
  });
export type TestEnvTaskPlan = z.infer<typeof TestEnvTaskPlanSchema>;
