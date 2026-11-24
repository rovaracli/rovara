// Slice 2, s2-emulator-run: the AWS resources the worker reads from the project's infrastructure code for Rovara local AWS (contracts/src/test-services-aws-resources.ts), and the `aws` facts of the usage record. Names and attribute types only, strict forms.
import { describe, expect, it } from "vitest";
import { TestServicesAwsUsageSchema, TestServicesUsageRecordSchema } from "../../packages/contracts/src/index.js";

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
