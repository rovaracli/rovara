// Customer test AWS account, lane TA2: auto-detection from the repo and the account (alias, Region, existing resources, production alias).
import { describe, expect, it } from "vitest";
import { DETECT_MAX_FILES, DETECT_MAX_REFERENCES, detectRegion, isProdAlias, referencedNames, sanitizeAlias, suggestExisting } from "../../packages/broker/src/test-access/detect.js";

const SUPPORTED = ["us-east-1", "us-west-2", "eu-west-1"];

describe("the Region", () => {
  it("reads CDK, Terraform, SAM, serverless and cdk.json, and takes one Region as the answer", () => {
    for (const text of ["new Stack(app, 'S', { env: { account: '1', region: 'us-west-2' } })", 'provider "aws" {\n  region = "us-west-2"\n}', 'region = "us-west-2"', "provider:\n  region: us-west-2", '{"context": {"region": "us-west-2"}}']) {
      expect(detectRegion([{ path: "f", text }], SUPPORTED), text).toEqual({ region: "us-west-2", candidates: ["us-west-2"], ambiguous: false });
    }
  });

  it("with two Regions it is ambiguous and preselects nothing; with none, or an unsupported one, it says nothing; a comment does not count", () => {
    expect(detectRegion([{ path: "a", text: "region: us-west-2" }, { path: "b", text: "region: eu-west-1" }], SUPPORTED)).toEqual({ region: undefined, candidates: ["eu-west-1", "us-west-2"], ambiguous: true });
    expect(detectRegion([{ path: "a", text: "nothing here" }], SUPPORTED)).toEqual({ region: undefined, candidates: [], ambiguous: false });
    expect(detectRegion([{ path: "a", text: "region: ap-south-1" }], SUPPORTED).candidates).toEqual([]);
    expect(detectRegion([{ path: "a", text: "# region: us-west-2\n// region: eu-west-1\n * region: us-east-1" }], SUPPORTED).candidates).toEqual([]);
  });

  it("is bounded in files and file size", () => {
    const many = Array.from({ length: DETECT_MAX_FILES + 5 }, (_, index) => ({ path: String(index), text: index >= DETECT_MAX_FILES ? "region: us-west-2" : "" }));
    expect(detectRegion(many, SUPPORTED).candidates).toEqual([]);
    expect(detectRegion([{ path: "big", text: `${"x".repeat(300 * 1024)}\nregion: us-west-2` }], SUPPORTED).candidates).toEqual([]);
  });
});

describe("existing resources", () => {
  const cdk = "const t = Table.fromTableName(this, 'T', 'beta-orders'); const b = s3.Bucket.fromBucketName(this, 'B', 'beta-config'); Queue.fromQueueName(this, 'Q', 'beta-jobs'); Topic.fromTopicName(this, 'X', 'beta-events');";
  const terraform = 'data "aws_dynamodb_table" "orders" {\n  name = "tf-orders"\n}\ndata "aws_s3_bucket" "c" {\n  bucket = "tf-config"\n}';

  it("finds the names a repo's IaC references, only plain names, deduplicated", () => {
    expect(referencedNames([{ path: "a.ts", text: cdk }, { path: "m.tf", text: terraform }, { path: "dup.ts", text: cdk }])).toEqual([
      { service: "dynamodb", name: "beta-orders" }, { service: "dynamodb", name: "tf-orders" }, { service: "s3", name: "beta-config" }, { service: "s3", name: "tf-config" }, { service: "sns", name: "beta-events" }, { service: "sqs", name: "beta-jobs" },
    ]);
    expect(referencedNames([{ path: "x", text: "Table.fromTableName(this, 'T', 'a b; rm -rf /')" }, { path: "y", text: "Table.fromTableName(this, 'T', '../x')" }, { path: "z", text: 'data "aws_s3_bucket" "c" { bucket = "${var.name}" }' }])).toEqual([]);
  });

  it("is bounded", () => {
    const text = Array.from({ length: 500 }, (_, index) => `Table.fromTableName(this, 'T', 'name-${index}');`).join("\n");
    expect(referencedNames([{ path: "x", text }]).length).toBe(DETECT_MAX_REFERENCES);
  });

  it("suggests only names the account really has, with one list call per service, and nothing for a refused list", async () => {
    const asked: string[] = [];
    const references = referencedNames([{ path: "a.ts", text: cdk }, { path: "m.tf", text: terraform }]);
    const found = await suggestExisting({ listNames: (service) => { asked.push(service); return Promise.resolve(service === "dynamodb" ? ["beta-orders", "other"] : service === "s3" ? undefined : ["beta-jobs"]); } }, references);
    expect(found).toEqual([{ service: "dynamodb", name: "beta-orders" }, { service: "sqs", name: "beta-jobs" }]);
    expect(asked.sort()).toEqual(["dynamodb", "s3", "sns", "sqs"]);
  });
});

describe("the alias", () => {
  it("is cleaned to what AWS allows, and a production-looking one is flagged", () => {
    expect(sanitizeAlias("Beta-Shared")).toBe("beta-shared");
    expect(sanitizeAlias("<script>alert(1)</script>")).toBe("scriptalert1script");
    expect(sanitizeAlias("a")).toBeUndefined();
    expect(sanitizeAlias(undefined)).toBeUndefined();
    expect(sanitizeAlias("x".repeat(100))!.length).toBe(63);
    for (const alias of ["acme-prod", "prod", "prod-eu", "acme-production-1", "prd-main"]) expect(isProdAlias(alias), alias).toBe(true);
    for (const alias of ["beta-shared", "product-lab", "reprod", "proddy", undefined]) expect(isProdAlias(alias), String(alias)).toBe(false);
  });
});
