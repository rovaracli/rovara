import { describe, expect, it } from "vitest";
import { kindOf, nameArnPattern, scopingRow, scopingRows, type ReferenceAction, type ReferenceResource, type ReferenceService } from "../../scripts/test-access/classify.js";
import { decodeScopingRow, encodeScopingRow, leadingNamePlaceholder } from "../../packages/cloud-contracts/src/test-access-scoping.js";

// Fixtures shaped like AWS's Service Authorization Reference (https://servicereference.us-east-1.amazonaws.com/v1/<prefix>/<prefix>.json).
const write = { IsList: false, IsPermissionManagement: false, IsTaggingOnly: false, IsWrite: true };
const queue: ReferenceResource = { Name: "queue", ARNFormats: ["arn:${Partition}:sqs:${Region}:${Account}:${QueueName}"], ConditionKeys: ["aws:ResourceTag/${TagKey}"] };
const object: ReferenceResource = { Name: "object", ARNFormats: ["arn:${Partition}:s3:::${BucketName}/${ObjectName}"], ConditionKeys: ["aws:ResourceTag/${TagKey}", "s3:BucketTag/${TagKey}"] };
const api: ReferenceResource = { Name: "Api", ARNFormats: ["arn:${Partition}:apigateway:${Region}::/apis/${ApiId}"] };
const resources = (...list: ReferenceResource[]) => new Map(list.map((resource) => [resource.Name, resource]));

const createQueue: ReferenceAction = { Name: "CreateQueue", ActionConditionKeys: ["aws:RequestTag/${TagKey}", "aws:TagKeys"], Annotations: { Properties: write }, Resources: [{ Name: "queue" }] };
const deleteQueue: ReferenceAction = { Name: "DeleteQueue", Annotations: { Properties: write }, Resources: [{ Name: "queue" }] };

describe("scopingRow: which IAM tool confines an action to a run", () => {
  it("scopes a create by the request tag, and a delete by the resource tag", () => {
    expect(scopingRow("sqs", createQueue, resources(queue))).toEqual({ kind: "create", guard: "tag", requestTag: true, resourceTag: "all", name: "all" });
    expect(scopingRow("sqs", deleteQueue, resources(queue))).toEqual({ kind: "delete", guard: "tag", requestTag: false, resourceTag: "all", name: "all" });
  });

  it("falls back to the name when the tag is not usable: an S3 object's tag is not the run's, a bucket's needs ABAC enabled", () => {
    const put: ReferenceAction = { Name: "PutObject", Annotations: { Properties: write }, Resources: [{ Name: "object" }] };
    // the reference lists aws:ResourceTag on the object type; the table must not count it
    expect(object.ConditionKeys).toContain("aws:ResourceTag/${TagKey}");
    expect(scopingRow("s3", put, resources(object))).toMatchObject({ kind: "write", guard: "name", resourceTag: "none", name: "all" });
    // the same action of an unlisted service keeps the tag
    expect(scopingRow("other", put, resources(object))).toMatchObject({ guard: "tag", resourceTag: "all" });
  });

  it("is signer-only when the resource has a generated id and no tag key", () => {
    const createApi: ReferenceAction = { Name: "CreateApi", Annotations: { Properties: write }, Resources: [{ Name: "Api" }] };
    expect(scopingRow("apigatewayv2", createApi, resources(api))).toMatchObject({ kind: "create", guard: "signer", requestTag: false, resourceTag: "none", name: "none" });
  });

  it("is signer-only when an action names no resource type (it acts on '*')", () => {
    expect(scopingRow("x", { Name: "DeleteEverything", Annotations: { Properties: write } }, resources(queue))).toMatchObject({ kind: "delete", guard: "signer", resourceTag: "none", name: "none" });
  });

  it("counts a partly supported action as 'some' and does not claim a tag guard for it", () => {
    const both: ReferenceAction = { Name: "UpdateBoth", Annotations: { Properties: write }, Resources: [{ Name: "queue" }, { Name: "Api" }] };
    expect(scopingRow("x", both, resources(queue, api))).toMatchObject({ kind: "write", guard: "signer", resourceTag: "some", name: "some" });
  });

  it("reads a resource type's condition keys from the action when the action carries its own (EC2 style)", () => {
    const terminate: ReferenceAction = { Name: "TerminateInstances", Annotations: { Properties: write }, Resources: [{ Name: "instance", ConditionKeys: ["aws:ResourceTag/${TagKey}"] }] };
    expect(scopingRow("ec2", terminate, resources({ Name: "instance", ARNFormats: ["arn:${Partition}:ec2:${Region}:${Account}:instance/${InstanceId}"] }))).toMatchObject({ kind: "delete", guard: "tag" });
  });

  it("never leaves a tagging action to a tag guard: an untagged shared resource looks like one being created", () => {
    const tag: ReferenceAction = { Name: "TagQueue", Annotations: { Properties: { ...write, IsWrite: false, IsTaggingOnly: true } }, Resources: [{ Name: "queue" }] };
    expect(scopingRow("sqs", tag, resources(queue))).toMatchObject({ kind: "tagging", guard: "name" });
    expect(scopingRow("x", tag, resources(api))).toMatchObject({ kind: "tagging", guard: "signer" });
  });

  it("leaves reads and lists out of the table (positive control: a write beside them is in)", () => {
    const read: ReferenceAction = { Name: "GetQueueUrl", Annotations: { Properties: { ...write, IsWrite: false } }, Resources: [{ Name: "queue" }] };
    const list: ReferenceAction = { Name: "ListQueues", Annotations: { Properties: { ...write, IsWrite: false, IsList: true } } };
    const service: ReferenceService = { Name: "sqs", Actions: [read, list, deleteQueue], Resources: [queue] };
    expect(Object.keys(scopingRows(service, "sqs").rows)).toEqual(["DeleteQueue"]);
  });
});

describe("kindOf: the verb heuristic", () => {
  const kind = (name: string, extra: Partial<ReferenceAction> = {}): string | undefined => kindOf({ Name: name, Annotations: { Properties: write }, ...extra });
  it("sorts changing actions by their verb", () => {
    expect(kind("CreateTable")).toBe("create");
    expect(kind("RunInstances")).toBe("create");
    expect(kind("DeleteTable")).toBe("delete");
    expect(kind("TerminateInstances")).toBe("delete");
    expect(kind("PutItem")).toBe("write");
    expect(kind("SendMessage")).toBe("write");
  });
  it("treats a write that supports the request tag as a create, and permission management and tagging as their own kinds", () => {
    expect(kind("PutParameter", { ActionConditionKeys: ["aws:RequestTag/${TagKey}"] })).toBe("create");
    expect(kindOf({ Name: "PutRolePolicy", Annotations: { Properties: { ...write, IsPermissionManagement: true } } })).toBe("permissions");
    expect(kindOf({ Name: "TagResource", Annotations: { Properties: { ...write, IsTaggingOnly: true } } })).toBe("tagging");
  });
});

describe("name patterns", () => {
  it("finds a caller-chosen name at the front of the resource part, and no other placeholder", () => {
    expect(leadingNamePlaceholder("arn:${Partition}:sqs:${Region}:${Account}:${QueueName}")).toBe("QueueName");
    expect(leadingNamePlaceholder("arn:${Partition}:s3:::${BucketName}/${ObjectName}")).toBe("BucketName");
    expect(leadingNamePlaceholder("arn:${Partition}:dynamodb:${Region}:${Account}:table/${TableName}/index/${IndexName}")).toBe("TableName");
    expect(leadingNamePlaceholder("arn:${Partition}:apigateway:${Region}::/apis/${ApiId}")).toBeUndefined();
    expect(leadingNamePlaceholder("arn:${Partition}:secretsmanager:${Region}:${Account}:secret:${SecretId}")).toBeUndefined();
    expect(leadingNamePlaceholder("not an arn")).toBeUndefined();
  });

  it("turns a format into a pattern: the name is the run's, other placeholders are wildcards", () => {
    expect(nameArnPattern("arn:${Partition}:dynamodb:${Region}:${Account}:table/${TableName}/index/${IndexName}")).toBe("arn:{{Partition}}:dynamodb:{{Region}}:{{AccountId}}:table/{{Name}}/index/*");
    expect(nameArnPattern("arn:${Partition}:s3:::${BucketName}/${ObjectName}")).toBe("arn:{{Partition}}:s3:::{{Name}}/*");
    expect(nameArnPattern("arn:${Partition}:apigateway:${Region}::/apis/${ApiId}")).toBeUndefined();
  });

  it("collects the patterns of every resource type whose ARN starts with a caller-chosen name, and only the service's own", () => {
    expect(scopingRows({ Name: "s3", Actions: [], Resources: [object] }, "s3").nameArns).toEqual(["arn:{{Partition}}:s3:::{{Name}}/*"]);
    expect(scopingRows({ Name: "sqs", Actions: [], Resources: [queue, api] }, "sqs").nameArns).toEqual(["arn:{{Partition}}:sqs:{{Region}}:{{AccountId}}:{{Name}}"]);
    // a reference lists what an action also touches: SSM lists an IAM role and an S3 bucket, which are not SSM's
    const role: ReferenceResource = { Name: "role", ARNFormats: ["arn:${Partition}:iam::${Account}:role/${RoleName}"] };
    expect(scopingRows({ Name: "ssm", Actions: [], Resources: [role, object] }, "ssm").nameArns).toEqual([]);
  });
});

describe("the row codes", () => {
  it("round-trip every combination, and refuse a malformed code", () => {
    for (const kind of ["create", "write", "delete", "tagging", "permissions"] as const) {
      for (const guard of ["tag", "name", "signer"] as const) {
        for (const requestTag of [true, false]) {
          for (const resourceTag of ["all", "some", "none"] as const) {
            for (const name of ["all", "some", "none"] as const) {
              const row = { kind, guard, requestTag, resourceTag, name };
              expect(decodeScopingRow(encodeScopingRow(row))).toEqual(row);
            }
          }
        }
      }
    }
    for (const bad of ["", "ctq", "xtq-a-", "ctzaa", "ctqaaa", "ct-xa"]) expect(decodeScopingRow(bad)).toBeUndefined();
  });
});
