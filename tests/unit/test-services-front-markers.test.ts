// Test services, wide AWS plans (decisions 109 and 115): what the front records without seeing a request (heavy Lambda functions, engine limits, templates and targets it could not read) travels from the emulator's ledger
// through the worker's usage record to the broker's evidence in FIXED words: the worker writes a known marker as an upper camel case word (the record's operation-name rule), the broker words it ("Lambda function was not
// run locally (native code); the function runner is not available yet", "ran longer than the local limit", "not checked: <reason>"), and the verdict is asked of the record without the markers.
import { TestServicesAwsUsageSchema, TestServicesUsageRecordSchema, awsEmulatorEvidenceLine } from "@rovara-code/contracts";
import { describe, expect, it } from "vitest";
import { FRONT_CLOUDFORMATION_REASONS, FRONT_HEAVY_FUNCTION_REASONS, FRONT_LIMIT_KINDS, FRONT_TARGET_REASONS, FRONT_TARGET_SOURCES, describeFrontMarker, frontMarkerOfLedger, frontMarkerOfWord, frontMarkerWord } from "@agentx/cloud-contracts";
import { AwsOperationNameSchema } from "@rovara-code/contracts";
import { type EmulatorLedger, type LedgerService } from "../../packages/worker/src/emulator-ledger.js";
import { newLocalAwsCredentials } from "../../packages/worker/src/service-helpers.js";
import { createServiceRedactor, helperSecretValues } from "../../packages/worker/src/service-env.js";
import { mergeAwsUsage, reduceAwsUsage } from "../../packages/worker/src/service-usage-record.js";
import { AWS_FIDELITY_ITEM_PREFIX, AWS_USAGE_ITEM_ID, dependencyEvidenceOf, type PinnedDependency, type RawUsage } from "../../packages/broker/src/rovara-code/dependency-evidence.js";
import { evidenceNotTestedLines } from "../../packages/broker/src/rovara-code/evidence-lines.js";

const redactor = createServiceRedactor(helperSecretValues([{ credentials: newLocalAwsCredentials() }]));
const counts = (calls: number, unsupported = 0, errors = 0) => ({ calls, unsupported, errors });
const service = (key: string, calls: number, unsupported: number, operations: Record<string, [number, number]> = {}, outOfPlan?: number): LedgerService => ({
  service: key, ...counts(calls, unsupported), ...(outOfPlan === undefined ? {} : { outOfPlan }), operations: Object.entries(operations).map(([operation, [c, u]]) => ({ operation, ...counts(c, u) })),
});
const ledgerOf = (...services: LedgerService[]): EmulatorLedger => ({ services });

describe("the front's marker names", () => {
  it("turns every listed reason into a word the usage record accepts, and back, only under the service the front records it under", () => {
    const ledgerNames: Array<[string, string]> = [
      ...FRONT_HEAVY_FUNCTION_REASONS.map((reason): [string, string] => ["lambda", `heavy-function:${reason}`]),
      ...FRONT_LIMIT_KINDS.map((limit): [string, string] => ["lambda", `lambda-limit:${limit}`]),
      ...FRONT_CLOUDFORMATION_REASONS.map((reason): [string, string] => ["cloudformation-unchecked", `cloudformation:${reason}`]),
      ...FRONT_TARGET_SOURCES.flatMap((source) => FRONT_TARGET_REASONS.map((reason): [string, string] => ["targets-unchecked", `${source}:${reason}`])),
    ];
    const words = new Set<string>();
    for (const [svc, operation] of ledgerNames) {
      const marker = frontMarkerOfLedger(svc, operation);
      expect(marker, `${svc} ${operation}`).toBeDefined();
      const word = frontMarkerWord(marker!);
      expect(AwsOperationNameSchema.safeParse(word).success, word).toBe(true);
      expect(frontMarkerOfWord(svc, word)).toEqual(marker);
      expect(frontMarkerOfWord("s3", word), "a marker word under another service is not a marker").toBeUndefined();
      words.add(word);
    }
    expect(words.size).toBe(ledgerNames.length);
  });
  it("reads a reason it does not list as the family's `other`, and an ordinary operation, a made-up limit and a spoofed shape as nothing", () => {
    expect(frontMarkerOfLedger("lambda", "heavy-function:something-new")).toEqual({ kind: "heavy_function", reason: "other" });
    expect(frontMarkerOfLedger("targets-unchecked", "stepfunctions:brand-new")).toEqual({ kind: "targets_unchecked", source: "stepfunctions", reason: "other" });
    expect(frontMarkerOfLedger("targets-unchecked", "no-colon-at-all")).toEqual({ kind: "targets_unchecked", source: "other", reason: "other" });
    expect(frontMarkerOfLedger("cloudformation-unchecked", "cloudformation:weird")).toEqual({ kind: "cloudformation_unchecked", reason: "other" });
    expect(frontMarkerOfLedger("lambda", "lambda-limit:5s")).toBeUndefined();
    expect(frontMarkerOfLedger("lambda", "Invoke")).toBeUndefined();
    expect(frontMarkerOfLedger("s3", "heavy-function:image")).toBeUndefined();
    expect(frontMarkerOfWord("lambda", "Invoke")).toBeUndefined();
  });
  it("words each marker in fixed sentences of the length the pull request shows", () => {
    expect(describeFrontMarker({ kind: "heavy_function", reason: "native-code" })).toEqual({ id: "lambda-heavy-native-code", text: "Lambda function was not run locally (native code)", reason: "the function runner is not available yet" });
    expect(describeFrontMarker({ kind: "lambda_limit", limit: "30s" })).toEqual({ id: "lambda-limit-30s", text: "Lambda function ran longer than the local limit (30 s)", reason: "not tested locally" });
    expect(describeFrontMarker({ kind: "lambda_limit", limit: "sfn-10s" }).text).toBe("Lambda function ran longer than the local limit (10 s under Step Functions)");
    expect(describeFrontMarker({ kind: "cloudformation_unchecked", reason: "nested" })).toEqual({ id: "not-checked-cloudformation-nested", text: "Resources a CloudFormation template creates", reason: "not checked: nested stacks" });
    expect(describeFrontMarker({ kind: "targets_unchecked", source: "stepfunctions", reason: "intrinsic" })).toEqual({ id: "not-checked-stepfunctions-intrinsic", text: "AWS calls made through Step Functions", reason: "not checked: a definition built with functions" });
    for (const reason of [...FRONT_HEAVY_FUNCTION_REASONS, "other"] as const) expect(describeFrontMarker({ kind: "heavy_function", reason }).text.length).toBeLessThanOrEqual(80);
    for (const source of [...FRONT_TARGET_SOURCES, "other"] as const) for (const reason of [...FRONT_TARGET_REASONS, "other"] as const) {
      const words = describeFrontMarker({ kind: "targets_unchecked", source, reason });
      expect(words.text.length).toBeLessThanOrEqual(80);
      expect(words.reason.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("the worker's usage record", () => {
  const ledger = ledgerOf(
    service("lambda", 5, 3, { Invoke: [2, 0], "heavy-function:native-code": [2, 2], "lambda-limit:30s": [1, 1] }),
    service("cloudformation-unchecked", 1, 0, { "cloudformation:nested": [1, 0] }, 1),
    service("targets-unchecked", 2, 0, { "stepfunctions:intrinsic": [2, 0] }, 2),
    service("s3", 4, 0, { PutObject: [4, 0] }),
  );
  it("writes the markers as fixed words with their exact counts, takes them out of the services' own counts, and drops the services the front uses only for unchecked things", () => {
    const aws = reduceAwsUsage(ledger, redactor, { wide: true });
    expect([...aws.services].sort((a, b) => a.service.localeCompare(b.service))).toEqual([{ service: "lambda", calls: 2, unsupported: 0 }, { service: "s3", calls: 2, unsupported: 0 }]);
    expect(aws.unsupportedOperations).toEqual(expect.arrayContaining([
      { service: "lambda", operation: "HeavyFunctionNativeCode", count: 2 }, { service: "lambda", operation: "LambdaLimit30s", count: 1 },
      { service: "cloudformation-unchecked", operation: "CfnUncheckedNested", count: 1 }, { service: "targets-unchecked", operation: "UncheckedSfnIntrinsic", count: 2 },
    ]));
    expect(aws.unsupportedOperations).toHaveLength(4);
    expect(aws.otherCalls).toBe(0);
    expect(aws.otherUnsupported).toBe(0);
    expect(TestServicesAwsUsageSchema.parse(aws)).toEqual(aws);
    // Positive control: without the tables' names the same calls would be hidden counts, not words.
    const spoof = reduceAwsUsage(ledgerOf(service("lambda", 2, 2, { "heavy-function:image": [1, 1], "heavy-function:x‮": [1, 1] })), redactor, { wide: true });
    expect(spoof.unsupportedOperations).toEqual([{ service: "lambda", operation: "HeavyFunctionImage", count: 1 }, { service: "lambda", operation: "HeavyFunctionOther", count: 1 }]);
  });
  it("keeps an unsupported call of the code as it was, and sums the markers across rounds", () => {
    const aws = reduceAwsUsage(ledgerOf(service("lambda", 3, 2, { CreateEventSourceMapping: [1, 1], "heavy-function:image": [1, 1] })), redactor, { wide: true });
    expect(aws.services).toEqual([{ service: "lambda", calls: 2, unsupported: 1 }]);
    expect(aws.unsupportedOperations.map((row) => row.operation).sort()).toEqual(["CreateEventSourceMapping", "HeavyFunctionImage"]);
    const merged = mergeAwsUsage(aws, aws, true)!;
    expect(merged.unsupportedOperations.find((row) => row.operation === "HeavyFunctionImage")?.count).toBe(2);
  });
  it("is unchanged for a ledger with no marker", () => {
    expect(reduceAwsUsage(ledgerOf(service("s3", 2, 0, { PutObject: [2, 0] })), redactor, { wide: true })).toEqual({ ledger: "read", services: [{ service: "s3", calls: 2, unsupported: 0 }], unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0 });
  });
  it("round-trips through the whole record", () => {
    const aws = reduceAwsUsage(ledger, redactor, { wide: true });
    const record = TestServicesUsageRecordSchema.parse({ schemaVersion: 1, dependencies: [], unknownCalls: { domains: [], otherCount: 0 }, aws });
    expect(record.aws?.unsupportedOperations).toHaveLength(4);
  });
});

describe("the broker's evidence", () => {
  const pinned: PinnedDependency[] = [{ id: "aws", name: "AWS", backing: "emulated", awsServices: ["s3", "lambda"] }];
  const usage = (aws: Partial<NonNullable<RawUsage>["aws"]> & object): RawUsage => ({
    schemaVersion: 1, dependencies: [{ id: "aws", started: true, healthy: true, startMs: 900, resetCount: 0 }], unknownCalls: { domains: [], otherCount: 0 },
    aws: { ledger: "read", services: [{ service: "s3", calls: 2, unsupported: 0 }], unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0, ...aws },
  });
  const fromLedger = (l: EmulatorLedger): RawUsage => usage(reduceAwsUsage(l, redactor, { wide: true }));
  const ledger = ledgerOf(
    service("lambda", 3, 2, { "heavy-function:native-code": [1, 1], "lambda-limit:sfn-10s": [1, 1] }), service("s3", 2, 0, { PutObject: [2, 0] }),
    service("cloudformation-unchecked", 1, 0, { "cloudformation:nested": [1, 0] }, 1), service("targets-unchecked", 1, 0, { "stepfunctions:resource": [1, 0] }, 1),
  );

  it("words a heavy function, a limit hit and what was not checked, before the per-service lines, and never as 'services outside the plan' or 'operations the emulator lacks'", () => {
    const { notTested } = dependencyEvidenceOf(pinned, fromLedger(ledger));
    const texts = notTested.map((item) => `${item.text} (${item.reason})`);
    expect(texts).toEqual(expect.arrayContaining([
      "Lambda function was not run locally (native code) (the function runner is not available yet)",
      "Lambda function ran longer than the local limit (10 s under Step Functions) (not tested locally)",
      "Resources a CloudFormation template creates (not checked: nested stacks)",
      "AWS calls made through Step Functions (not checked: a task resource that could not be read)",
    ]));
    expect(notTested.some((item) => item.id === AWS_USAGE_ITEM_ID)).toBe(false);
    expect(JSON.stringify(notTested)).not.toMatch(/cloudformation-unchecked|targets-unchecked|not in the plan|does not support/u);
    // Order: the markers come before the per-service fidelity lines, which the pull request cuts at ten.
    const firstFidelity = notTested.findIndex((item) => item.id.startsWith(AWS_FIDELITY_ITEM_PREFIX));
    const lastMarker = notTested.map((item) => item.id).lastIndexOf("not-checked-stepfunctions-resource");
    expect(firstFidelity).toBeGreaterThan(lastMarker);
    expect(notTested.filter((item) => item.id.startsWith(AWS_FIDELITY_ITEM_PREFIX)).map((item) => item.text)).toEqual(["s3", "lambda"].map((key) => awsEmulatorEvidenceLine(key)));
  });
  it("shows them in the pull request's not-tested lines in the fixed words", () => {
    const { notTested } = dependencyEvidenceOf(pinned, fromLedger(ledger));
    const lines = evidenceNotTestedLines({ notTested } as never, 0);
    expect(lines).toContain("- Detail Lambda function was not run locally (native code) (the function runner is not available yet)");
    expect(lines).toContain("- Detail Lambda function ran longer than the local limit (10 s under Step Functions) (not tested locally)");
  });
  it("still flags the code's own unsupported calls and its calls outside the plan", () => {
    const { notTested } = dependencyEvidenceOf(pinned, fromLedger(ledgerOf(
      service("lambda", 2, 1, { CreateEventSourceMapping: [1, 1], "heavy-function:image": [1, 0] }), service("kinesis", 2, 0, { PutRecord: [2, 0] }, 2), service("s3", 1, 0, { PutObject: [1, 0] }),
    )));
    const item = notTested.find((entry) => entry.id === AWS_USAGE_ITEM_ID);
    expect(item?.text).toBe("The code called AWS services that are not in the plan: kinesis");
    const onlyUnsupported = dependencyEvidenceOf(pinned, fromLedger(ledgerOf(service("lambda", 2, 1, { CreateEventSourceMapping: [1, 1], "heavy-function:image": [1, 0] }), service("s3", 1, 0, { PutObject: [1, 0] }))));
    expect(onlyUnsupported.notTested.find((entry) => entry.id === AWS_USAGE_ITEM_ID)?.text).toMatch(/operations that Rovara local AWS does not support/u);
    expect(onlyUnsupported.notTested.some((entry) => entry.id === "lambda-heavy-image")).toBe(true);
  });
  it("is the same as before for a record with no marker, and lists at most six marker items and one more", () => {
    const clean = dependencyEvidenceOf(pinned, usage({}));
    expect(clean.notTested.map((item) => item.id).filter((id) => /^(lambda-|not-checked-)/u.test(id))).toEqual([]);
    const many = ledgerOf(service("targets-unchecked", 8, 0, Object.fromEntries([...FRONT_TARGET_SOURCES.map((source): [string, [number, number]] => [`${source}:resource`, [1, 0]]), ["stepfunctions:dynamic", [1, 0]], ["stepfunctions:arn", [1, 0]], ["eventbridge:script", [1, 0]]] as Array<[string, [number, number]]>), 8), service("s3", 1, 0));
    const ids = dependencyEvidenceOf(pinned, fromLedger(many)).notTested.map((item) => item.id);
    expect(ids.filter((id) => id.startsWith("not-checked-"))).toHaveLength(6);
    expect(ids).toContain("aws-front-markers-more");
  });
});
