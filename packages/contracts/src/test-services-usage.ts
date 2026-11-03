// Test services, slice 1 T1 (design test-services.md 4.0 and 8.1): what a run's worker reports about the dependencies it started and what the tests called. The broker derives the evidence rows, the PR line and the two
// Prove steps (`dependencies`, `dependency_usage`) from it; the worker's own words never set a label (2.4). It is a RECORD of facts, bounded and in fixed words:
//   - per dependency: whether it started, whether it was healthy, how long the start took, how many times it was reset, and (when it was not healthy) why in a fixed word;
//   - the names the sealed tests asked for that Rovara did not start, as REGISTRABLE DOMAIN + COUNT only (TS-SEAL-1: the sealed DNS helper's record of an unknown name can hold a secret as a label of a name the program
//     tried to reach). A bare name with no dot, an address-shaped name and every name past the list are counted in `otherCount` and never shown.
// Nothing here is a secret, a host the project named, a command's text or an error message. Browser-safe: nothing here imports a Node module.
import { z } from "zod";
import { TestEnvDependencyIdSchema } from "./test-env-dependency.js";
import { TestServiceHostSchema, looksLikeSecretValue } from "./test-services-shared.js";

export const TEST_SERVICES_USAGE_SCHEMA_VERSION = 1;
/** The key under which a candidate check's (a preparation's) usage record rides in its result. */
export const TEST_SERVICES_USAGE_RESULT_KEY = "testServicesUsage";
/** Why a dependency is not healthy, in fixed words (never the runtime's own error text). */
export const TEST_SERVICES_START_FAILURES = ["pull_failed", "start_failed", "not_healthy", "seed_failed", "reset_failed"] as const;
export type TestServicesStartFailure = (typeof TEST_SERVICES_START_FAILURES)[number];
export const TEST_SERVICES_USAGE_LIMITS = { dependencies: 16, unknownDomains: 50, count: 1_000_000_000, startMs: 86_400_000, resets: 100_000 } as const;

const Count = z.number().int().min(0).max(TEST_SERVICES_USAGE_LIMITS.count);

/**
 * A registrable domain (`example-pay.com`): a host of at least two labels that cannot be read as an address, and that does not look like a secret. A DNS name arrives lower-cased, so the secret check also reads it in
 * upper case (a lower-cased access key id would otherwise pass: TS-SEAL-1).
 */
export const RegistrableDomainSchema = TestServiceHostSchema.refine((domain) => !looksLikeSecretValue(domain) && !looksLikeSecretValue(domain.toUpperCase()), { message: "a domain, not a secret" });

export const TestServicesDependencyUsageSchema = z
  .object({
    /** The dependency's id in the plan (`postgres`). */
    id: TestEnvDependencyIdSchema,
    started: z.boolean(),
    healthy: z.boolean(),
    /** Milliseconds from the start request until it answered healthy (or gave up). 0 when it never started. */
    startMs: z.number().int().min(0).max(TEST_SERVICES_USAGE_LIMITS.startMs),
    /** How many times it was reset to a clean state between checks or rounds. */
    resetCount: z.number().int().min(0).max(TEST_SERVICES_USAGE_LIMITS.resets),
    failure: z.enum(TEST_SERVICES_START_FAILURES).optional(),
  })
  .strict()
  .superRefine((usage, context) => {
    const problem = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
    if (usage.healthy && !usage.started) problem("healthy", "only a dependency that started can be healthy");
    if (!usage.started && (usage.startMs !== 0 || usage.resetCount !== 0)) problem("started", "a dependency that never started has no start time and no resets");
    // Fail closed: a dependency that is not healthy says why, so the Prove step names a fixed failure and never an empty one. A healthy one may still have failed its seeds or a reset.
    if (!usage.healthy && usage.failure === undefined) problem("failure", "a dependency that is not healthy names its failure");
    if (usage.healthy && usage.failure !== undefined && usage.failure !== "seed_failed" && usage.failure !== "reset_failed") problem("failure", "a healthy dependency can only have failed its seeds or a reset");
  });
export type TestServicesDependencyUsage = z.infer<typeof TestServicesDependencyUsageSchema>;

/** An AWS service key as the emulator's ledger names it (`s3`, `sqs`, `dynamodb`): a short fixed-looking word. */
export const AwsServiceKeySchema = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/u);
/** An AWS operation name (`PutObject`, `SendMessage`): an upper camel case word. A path, a method or any other text the program chose is not one. */
export const AwsOperationNameSchema = z.string().regex(/^[A-Z][A-Za-z0-9]{2,63}$/u).refine((name) => !looksLikeSecretValue(name) && !looksLikeSecretValue(name.toUpperCase()), { message: "an operation name, not a secret" });
export const TEST_SERVICES_AWS_USAGE_LIMITS = { services: 24, unsupportedOperations: 30 } as const;

/**
 * Slice 2: what Rovara local AWS's request ledger said about a run (`GET /_rovara/ledger/summary`): calls per AWS service, and the operations the emulator does not offer. Present only when an emulator ran. Counts follow the
 * record's bucketing rule (`bucketCount`: 1, 2 to 5, 6 to 20, 21 or more, each shown as its lower bound), and a name is shown only when it is a service key or an operation name the program could not have used to carry a
 * value (the worker's `reduceAwsUsage`); every other call is counted in `otherCalls` and `otherUnsupported` and named nowhere. Never fed back to the agent or a model.
 */
export const TestServicesAwsUsageSchema = z
  .object({
    /** `unreadable`: the ledger could not be read (fail closed: the lists below are empty then and say nothing, not "no calls"). */
    ledger: z.enum(["read", "unreadable"]),
    services: z.array(z.object({ service: AwsServiceKeySchema, calls: z.number().int().min(1).max(TEST_SERVICES_USAGE_LIMITS.count), unsupported: Count }).strict()).max(TEST_SERVICES_AWS_USAGE_LIMITS.services),
    unsupportedOperations: z.array(z.object({ service: AwsServiceKeySchema, operation: AwsOperationNameSchema, count: z.number().int().min(1).max(TEST_SERVICES_USAGE_LIMITS.count) }).strict()).max(TEST_SERVICES_AWS_USAGE_LIMITS.unsupportedOperations),
    /** Calls to a service that is not shown (an unknown key, or past the list). */
    otherCalls: Count,
    /** Unsupported calls whose service or operation is not shown. */
    otherUnsupported: Count,
  })
  .strict()
  .superRefine((usage, context) => {
    if (usage.ledger === "unreadable" && (usage.services.length > 0 || usage.unsupportedOperations.length > 0 || usage.otherCalls > 0 || usage.otherUnsupported > 0)) context.addIssue({ code: "custom", path: ["ledger"], message: "an unreadable ledger says nothing" });
    if (new Set(usage.services.map((entry) => entry.service)).size !== usage.services.length) context.addIssue({ code: "custom", path: ["services"], message: "a service is listed once" });
    if (new Set(usage.unsupportedOperations.map((entry) => `${entry.service}\0${entry.operation}`)).size !== usage.unsupportedOperations.length) context.addIssue({ code: "custom", path: ["unsupportedOperations"], message: "an operation is listed once" });
  });
export type TestServicesAwsUsage = z.infer<typeof TestServicesAwsUsageSchema>;

export const TestServicesUsageRecordSchema = z
  .object({
    schemaVersion: z.literal(TEST_SERVICES_USAGE_SCHEMA_VERSION),
    dependencies: z.array(TestServicesDependencyUsageSchema).max(TEST_SERVICES_USAGE_LIMITS.dependencies),
    /** Names the sealed tests asked for that no dependency of the run answers (an "unknown call": "Blocked by environment"). */
    unknownCalls: z
      .object({
        /** At most 50, each with how many times it was asked for. */
        domains: z.array(z.object({ domain: RegistrableDomainSchema, count: z.number().int().min(1).max(TEST_SERVICES_USAGE_LIMITS.count) }).strict()).max(TEST_SERVICES_USAGE_LIMITS.unknownDomains),
        /** Calls whose name is not shown: a bare name, an address-shaped name, and every name past the list. */
        otherCount: Count,
      })
      .strict(),
    /** Slice 2: the emulator's ledger as a record of facts (see `TestServicesAwsUsageSchema`). Absent when no emulator ran, so a record without one is slice 1's record byte for byte. */
    aws: TestServicesAwsUsageSchema.optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (new Set(record.dependencies.map((entry) => entry.id)).size !== record.dependencies.length) context.addIssue({ code: "custom", path: ["dependencies"], message: "a dependency is listed once" });
    if (new Set(record.unknownCalls.domains.map((entry) => entry.domain)).size !== record.unknownCalls.domains.length) context.addIssue({ code: "custom", path: ["unknownCalls", "domains"], message: "a domain is listed once" });
  });
export type TestServicesUsageRecord = z.infer<typeof TestServicesUsageRecordSchema>;

/** How many calls went to a name no dependency of the run answers (shown names and hidden ones together). */
export function testServicesUnknownCallCount(record: TestServicesUsageRecord): number {
  return record.unknownCalls.domains.reduce((total, entry) => total + entry.count, record.unknownCalls.otherCount);
}

/** The ids of the dependencies that did not start healthy: what the Prove step "start dependencies" fails on. */
export function testServicesUnhealthy(record: TestServicesUsageRecord): string[] {
  return record.dependencies.filter((entry) => !entry.healthy).map((entry) => entry.id);
}
