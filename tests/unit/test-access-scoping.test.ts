import { describe, expect, it } from "vitest";
import { TEST_ACCESS_SCOPING, TEST_ACCESS_SCOPING_NAME_ARNS, TEST_ACCESS_SCOPING_SERVICE_KEYS, TEST_ACCESS_SCOPING_SOURCE, TEST_ACCESS_SCOPING_UNMAPPED } from "../../packages/cloud-contracts/src/generated/test-access-scoping.js";
import { decodeScopingRow, iamPrefixOfServiceKey, nameArnPatternsOf, scopedActionsOf, scopingOfAction, TEST_ACCESS_SCOPING_SERVICES } from "../../packages/cloud-contracts/src/test-access-scoping.js";

// The table is generated from AWS's Service Authorization Reference by scripts/test-access/gen-action-scoping.ts. The reference's own pages:
//   Amazon SQS      https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonsqs.html
//   Amazon S3       https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazons3.html
//   AWS Lambda      https://docs.aws.amazon.com/service-authorization/latest/reference/list_awslambda.html
//   Amazon DynamoDB https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazondynamodb.html
//   S3 ABAC is off until a bucket enables it: https://docs.aws.amazon.com/AmazonS3/latest/userguide/buckets-tagging-enable-abac.html
describe("the generated per-action scoping table", () => {
  it("records where it came from", () => {
    expect(TEST_ACCESS_SCOPING_SOURCE.reference).toBe("https://servicereference.us-east-1.amazonaws.com/");
    expect(TEST_ACCESS_SCOPING_SOURCE.serviceTable).toMatch(/^aws-emulator@\d+\.\d+\.\d+$/u);
    expect(TEST_ACCESS_SCOPING_SOURCE.referenceVersions.length).toBeGreaterThan(0);
  });

  it("maps every service Rovara local AWS serves to an IAM prefix, or lists it as unmapped (nothing is lost)", () => {
    const keys = Object.keys(TEST_ACCESS_SCOPING_SERVICE_KEYS);
    expect(keys.length).toBeGreaterThan(400);
    expect(keys.length + TEST_ACCESS_SCOPING_UNMAPPED.length).toBe(436);
    for (const key of keys) expect(TEST_ACCESS_SCOPING_SERVICES).toContain(iamPrefixOfServiceKey(key));
    for (const key of TEST_ACCESS_SCOPING_UNMAPPED) expect(iamPrefixOfServiceKey(key)).toBeUndefined();
    expect(iamPrefixOfServiceKey("api-gateway")).toBe("apigateway");
    expect(iamPrefixOfServiceKey("no-such-service")).toBeUndefined();
  });

  it("holds only decodable codes, each action once per service, and never a read or a list", () => {
    let actions = 0;
    for (const [service, grouped] of Object.entries(TEST_ACCESS_SCOPING)) {
      const seen = new Set<string>();
      for (const [code, names] of Object.entries(grouped)) {
        expect(decodeScopingRow(code), `${service} ${code}`).toBeDefined();
        for (const name of names) {
          expect(seen.has(name), `${service}:${name} twice`).toBe(false);
          seen.add(name);
          actions += 1;
        }
      }
      expect(seen.has("ListQueues") || seen.has("GetObject") || seen.has("DescribeTable")).toBe(false);
    }
    expect(actions).toBeGreaterThan(10_000);
  });

  it("agrees with the reference on the services the boundary allows by default (facts from the pages above)", () => {
    // SQS: queues take aws:RequestTag on create and aws:ResourceTag after, and the ARN ends in the queue name.
    expect(scopingOfAction("sqs", "CreateQueue")).toMatchObject({ kind: "create", guard: "tag", requestTag: true });
    expect(scopingOfAction("sqs", "DeleteQueue")).toMatchObject({ kind: "delete", guard: "tag", resourceTag: "all", name: "all" });
    // DynamoDB: tables take both tag keys.
    expect(scopingOfAction("dynamodb", "CreateTable")).toMatchObject({ kind: "create", guard: "tag", requestTag: true });
    expect(scopingOfAction("dynamodb", "PutItem")).toMatchObject({ kind: "write", guard: "tag", resourceTag: "all" });
    // Lambda: functions take both.
    expect(scopingOfAction("lambda", "CreateFunction")).toMatchObject({ kind: "create", guard: "tag", requestTag: true });
    expect(scopingOfAction("lambda", "DeleteFunction")).toMatchObject({ kind: "delete", guard: "tag" });
    // S3: object calls have no run tag; the bucket name carries the scope (and bucket tags need ABAC enabled per bucket).
    expect(scopingOfAction("s3", "PutObject")).toMatchObject({ kind: "write", guard: "name", resourceTag: "none", name: "all" });
    expect(scopingOfAction("s3", "DeleteBucket")).toMatchObject({ kind: "delete", guard: "name" });
    expect(scopingOfAction("s3", "CreateBucket")).toMatchObject({ kind: "create", requestTag: true });
    // Secrets Manager names carry a generated suffix in the ARN, so no name scoping; it has the tag keys.
    expect(scopingOfAction("secretsmanager", "CreateSecret")).toMatchObject({ kind: "create", guard: "tag", name: "none" });
    // IAM: a role is confined by tag, and the template adds the name rule.
    expect(scopingOfAction("iam", "CreateRole")).toMatchObject({ kind: "create", guard: "tag" });
  });

  it("marks what IAM cannot confine, so the signer guards it (positive control: such actions exist, and so do the others)", () => {
    const signerOnly = TEST_ACCESS_SCOPING_SERVICES.flatMap((service) => scopedActionsOf(service).filter((action) => action.guard === "signer"));
    expect(signerOnly.length).toBeGreaterThan(1_000);
    const confinable = (action: (typeof signerOnly)[number]): boolean => {
      if (action.kind === "create") return action.requestTag || action.name === "all";
      if (action.kind === "tagging") return action.name === "all";
      return action.resourceTag === "all" || action.name === "all";
    };
    expect(signerOnly.some(confinable)).toBe(false);
    expect(TEST_ACCESS_SCOPING_SERVICES.flatMap((service) => scopedActionsOf(service).filter((action) => action.guard === "tag")).length).toBeGreaterThan(5_000);
    // an unknown action is not in the table: a caller must treat it as signer-only
    expect(scopingOfAction("sqs", "NoSuchAction")).toBeUndefined();
    expect(scopingOfAction("no-such-service", "CreateQueue")).toBeUndefined();
    expect(scopedActionsOf("no-such-service")).toEqual([]);
  });

  it("gives every name-guarded service its ARN patterns, with the run's name where the caller's name goes", () => {
    for (const service of Object.keys(TEST_ACCESS_SCOPING_NAME_ARNS)) {
      for (const pattern of nameArnPatternsOf(service)) {
        expect(pattern.startsWith("arn:{{Partition}}:")).toBe(true);
        expect(pattern).toContain("{{Name}}");
        expect(pattern).not.toMatch(/\$\{/u);
      }
    }
    expect(nameArnPatternsOf("s3")).toEqual(expect.arrayContaining(["arn:{{Partition}}:s3:::{{Name}}", "arn:{{Partition}}:s3:::{{Name}}/*"]));
    expect(nameArnPatternsOf("no-such-service")).toEqual([]);
  });
});
