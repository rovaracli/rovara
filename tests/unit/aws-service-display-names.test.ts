// The names people read for the AWS services Rovara local AWS serves (cards, evidence, the pull request line): every service of the generated table has one, and it is a name, not the raw id.
import { describe, expect, it } from "vitest";
import { AWS_EMULATOR_SERVICES } from "@rovara-code/contracts";
import { AWS_SERVICE_DISPLAY_NAMES, awsFamilyDisplayName, awsServiceDisplayName } from "@agentx/cloud-contracts";
import { dependencyLines } from "../../packages/broker/src/rovara-code/dependency-lines.js";

describe("the display names of the AWS services", () => {
  it("has a name for every service of the emulator's table, and none for a service that is not in it", () => {
    const keys = AWS_EMULATOR_SERVICES.map((row) => row.key);
    expect(keys.length).toBeGreaterThanOrEqual(436);
    const missing = keys.filter((key) => !Object.hasOwn(AWS_SERVICE_DISPLAY_NAMES, key) || (AWS_SERVICE_DISPLAY_NAMES[key] ?? "").trim() === "");
    expect(missing, `services without a display name (add them to packages/cloud-contracts/src/aws-service-display-names.ts): ${missing.join(", ")}`).toEqual([]);
    const stale = Object.keys(AWS_SERVICE_DISPLAY_NAMES).filter((key) => !keys.includes(key));
    expect(stale, `display names for services the table no longer has: ${stale.join(", ")}`).toEqual([]);
  });

  it("is a name, not the raw id: not the key, not `aws:<key>`, not all lower case, no key spelling in its place", () => {
    for (const row of AWS_EMULATOR_SERVICES) {
      const name = awsServiceDisplayName(row.key);
      expect(name, row.key).toBeDefined();
      expect(name, row.key).not.toBe(row.key);
      expect(name, row.key).not.toBe(`aws:${row.key}`);
      expect(name, row.key).not.toMatch(/^aws:/u);
      expect(name, row.key).not.toBe(name!.toLowerCase());
      expect(name!.trim(), row.key).toBe(name);
      expect(name!.length, row.key).toBeGreaterThan(1);
      // The key's own words: `step-functions` as a name would still be a raw id.
      expect(name, row.key).not.toMatch(/[_]|--|^-|-$/u);
    }
  });

  it("gives every service its own name, so two rows of one list never read the same", () => {
    const byName = new Map<string, string[]>();
    for (const row of AWS_EMULATOR_SERVICES) byName.set(awsServiceDisplayName(row.key)!, [...(byName.get(awsServiceDisplayName(row.key)!) ?? []), row.key]);
    expect([...byName].filter(([, keys]) => keys.length > 1)).toEqual([]);
  });

  it("holds nothing the pull request line would drop or escape: every name stays itself in the line, at the full-length level", () => {
    for (const row of AWS_EMULATOR_SERVICES) {
      const name = awsServiceDisplayName(row.key)!;
      const { lines } = dependencyLines([{ name, label: "rovara_local_aws", backing: "emulated" }], 0);
      expect(lines, row.key).toEqual([`Integration tests ran against: ${name} (Rovara local AWS).`]);
    }
  });

  it("names the services people know the way AWS does", () => {
    expect(["s3", "sqs", "dynamodb", "sns", "eventbridge", "sfn", "bedrock-runtime", "secrets-manager", "lambda", "cognito-identity-provider"].map((key) => awsServiceDisplayName(key)))
      .toEqual(["S3", "SQS", "DynamoDB", "SNS", "EventBridge", "Step Functions", "Bedrock Runtime", "Secrets Manager", "Lambda", "Cognito Identity Provider"]);
  });

  it("reads a family and a legacy spelling, and says nothing about what it does not know", () => {
    expect(awsFamilyDisplayName("aws:sns")).toBe("SNS");
    expect(awsFamilyDisplayName("aws:secretsmanager")).toBe("Secrets Manager");
    expect(awsFamilyDisplayName("aws:cognito-idp")).toBe("Cognito Identity Provider");
    expect(awsServiceDisplayName("events")).toBe("EventBridge");
    expect(awsFamilyDisplayName("postgres")).toBeUndefined();
    expect(awsFamilyDisplayName("aws:nosuchservice")).toBeUndefined();
    expect(awsServiceDisplayName("constructor")).toBeUndefined();
    expect(awsServiceDisplayName("")).toBeUndefined();
  });
});
