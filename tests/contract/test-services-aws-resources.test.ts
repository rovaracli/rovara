// Slice 2, s2-emulator-run: the AWS resources a plan carries for Rovara local AWS (contracts/src/test-services-aws-resources.ts), and the `aws` facts of the usage record. Names and attribute types only, strict forms.
import { describe, expect, it } from "vitest";
import {
  TASK_AWS_RESOURCES_MAX, TaskAwsResourceSchema, TaskAwsResourcesSchema, TaskDependencyPlanSchema, TestServicesAwsUsageSchema, TestServicesUsageRecordSchema,
} from "../../packages/contracts/src/index.js";

const sha = (letter: string) => letter.repeat(64);
const table = { kind: "table", name: "orders", keySchema: { partitionKey: { name: "orderId", type: "S" }, sortKey: { name: "createdAt", type: "N" } } };
const plan = (over: Record<string, unknown> = {}) => ({
  id: "aws-s3", name: "S3", kind: "object_store", family: "aws:s3", backing: "local", catalogId: "postgres@16", repository: "svc/postgres", digest: sha("b"),
  config: {}, aliases: [], connect: [], seeds: [], reset: "fresh_per_round", ...over,
});

describe("TaskAwsResourcesSchema", () => {
  it("takes tables with their key schema, buckets and queues, and nothing else", () => {
    expect(TaskAwsResourcesSchema.safeParse([table, { kind: "bucket", name: "orders-archive" }, { kind: "queue", name: "events.fifo" }, { kind: "queue", name: "events" }]).success).toBe(true);
    expect(TaskAwsResourceSchema.safeParse({ kind: "topic", name: "events" }).success).toBe(false);
    expect(TaskAwsResourceSchema.safeParse({ kind: "bucket", name: "ok-bucket", region: "us-east-1" }).success).toBe(false);
  });
  it("is bounded, unique, and strict about each service's name rules", () => {
    const buckets = (count: number) => Array.from({ length: count }, (_v, index) => ({ kind: "bucket", name: `bucket-${String(index).padStart(3, "0")}` }));
    expect(TaskAwsResourcesSchema.safeParse(buckets(TASK_AWS_RESOURCES_MAX)).success).toBe(true);
    expect(TaskAwsResourcesSchema.safeParse(buckets(TASK_AWS_RESOURCES_MAX + 1)).success).toBe(false);
    expect(TaskAwsResourcesSchema.safeParse([table, table]).success).toBe(false);
    // the same name as a different kind is allowed (a table and a queue are different things)
    expect(TaskAwsResourcesSchema.safeParse([{ kind: "queue", name: "orders" }, table]).success).toBe(true);
    for (const bad of [
      { kind: "bucket", name: "UPPER" }, { kind: "bucket", name: "ab" }, { kind: "bucket", name: "-start" }, { kind: "bucket", name: "a..b" }, { kind: "bucket", name: "10.0.0.1" }, { kind: "bucket", name: "x".repeat(64) },
      { kind: "queue", name: "" }, { kind: "queue", name: "has space" }, { kind: "queue", name: "x".repeat(81) }, { kind: "queue", name: "name.fifo.fifo" }, { kind: "queue", name: "a.b" },
      { kind: "table", name: "ab", keySchema: table.keySchema }, { kind: "table", name: "bad/name", keySchema: table.keySchema }, { kind: "table", name: "orders" },
      { kind: "table", name: "orders", keySchema: { partitionKey: { name: "id", type: "X" } } }, { kind: "table", name: "orders", keySchema: { partitionKey: { name: "" , type: "S" } } },
    ]) expect(TaskAwsResourcesSchema.safeParse([bad]).success, JSON.stringify(bad)).toBe(false);
    expect(TaskAwsResourcesSchema.safeParse([{ kind: "table", name: "orders", keySchema: { partitionKey: { name: "id", type: "S" }, sortKey: { name: "id", type: "S" } } }]).success).toBe(false);
  });
  it("refuses a name shaped like a secret", () => {
    const key = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
    expect(TaskAwsResourcesSchema.safeParse([{ kind: "queue", name: key }]).success).toBe(false);
    expect(TaskAwsResourcesSchema.safeParse([{ kind: "queue", name: key.toLowerCase() }]).success).toBe(false);
  });
});

describe("the plan's awsResources", () => {
  it("is optional, so a plan without it is slice 1's plan byte for byte", () => {
    const parsed = TaskDependencyPlanSchema.parse(plan());
    expect("awsResources" in parsed).toBe(false);
  });
  it("is accepted on an AWS dependency and round-trips", () => {
    const parsed = TaskDependencyPlanSchema.parse(plan({ awsResources: [table, { kind: "bucket", name: "orders-archive" }] }));
    expect(parsed.awsResources).toEqual([table, { kind: "bucket", name: "orders-archive" }]);
  });
  it("is refused on a dependency that is not an AWS family, with a bad resource, or with duplicates", () => {
    expect(TaskDependencyPlanSchema.safeParse(plan({ family: "postgres", awsResources: [table] })).success).toBe(false);
    expect(TaskDependencyPlanSchema.safeParse(plan({ awsResources: [{ kind: "bucket", name: "BAD" }] })).success).toBe(false);
    expect(TaskDependencyPlanSchema.safeParse(plan({ awsResources: [table, table] })).success).toBe(false);
  });
});

describe("the record's aws facts", () => {
  const record = (aws: unknown) => ({ schemaVersion: 1, dependencies: [], unknownCalls: { domains: [], otherCount: 0 }, ...(aws === undefined ? {} : { aws }) });
  const read = { ledger: "read", services: [{ service: "s3", calls: 6, unsupported: 1 }], unsupportedOperations: [{ service: "s3", operation: "PutBucketReplication", count: 1 }], otherCalls: 0, otherUnsupported: 0 };
  it("is optional (slice 1's record is unchanged) and parses when present", () => {
    expect(TestServicesUsageRecordSchema.safeParse(record(undefined)).success).toBe(true);
    expect(TestServicesUsageRecordSchema.parse(record(read))).toEqual(record(read));
  });
  it("is strict: operation names are camel case words, service keys are keys, a service and an operation are listed once, and an unreadable ledger says nothing", () => {
    const aws = (over: Record<string, unknown>) => TestServicesAwsUsageSchema.safeParse({ ...read, ...over }).success;
    expect(aws({})).toBe(true);
    expect(aws({ unsupportedOperations: [{ service: "s3", operation: "GET /secret", count: 1 }] })).toBe(false);
    expect(aws({ unsupportedOperations: [{ service: "s3", operation: "putObject", count: 1 }] })).toBe(false);
    expect(aws({ services: [{ service: "S3", calls: 1, unsupported: 0 }] })).toBe(false);
    expect(aws({ services: [{ service: "s3", calls: 0, unsupported: 0 }] })).toBe(false);
    expect(aws({ services: [{ service: "s3", calls: 1, unsupported: 0 }, { service: "s3", calls: 2, unsupported: 0 }] })).toBe(false);
    expect(aws({ unsupportedOperations: [read.unsupportedOperations[0], read.unsupportedOperations[0]] })).toBe(false);
    expect(aws({ ledger: "maybe" })).toBe(false);
    expect(aws({ extra: 1 })).toBe(false);
    expect(aws({ ledger: "unreadable", services: [], unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0 })).toBe(true);
    expect(aws({ ledger: "unreadable" })).toBe(false);
  });
});
