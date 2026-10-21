// tests/contract/iam-simulate.test.ts
// The IAM evaluator the infrastructure tests use (tests/support/iam-simulate.ts): it must be right about the few rules the
// audit ledger's grants depend on, and refuse what it does not know instead of guessing.
import { describe, expect, it } from "vitest";
import { roleStatements, simulateIam, type IamStatement } from "../support/iam-simulate.js";

const allow = (extra: Partial<IamStatement>): IamStatement => ({ Effect: "Allow", Action: "dynamodb:PutItem", Resource: "table", ...extra });

describe("simulateIam", () => {
  it("denies what no statement allows, and allows what one does", () => {
    expect(simulateIam([], { action: "dynamodb:PutItem", resource: "table" })).toStrictEqual({ allowed: false, reason: "implicit-deny", matched: [] });
    expect(simulateIam([allow({ Sid: "A" })], { action: "dynamodb:PutItem", resource: "table" })).toStrictEqual({ allowed: true, reason: "allow", matched: ["A"] });
    expect(simulateIam([allow({})], { action: "dynamodb:GetItem", resource: "table" }).allowed).toBe(false);
    expect(simulateIam([allow({})], { action: "dynamodb:PutItem", resource: "other" }).allowed).toBe(false);
  });

  it("keeps a bucket's ARN and its objects' ARNs apart: ListBucket is for the bucket and GetObject for the objects", () => {
    const bucket = "arn:aws:s3:::exports";
    const grants: IamStatement[] = [
      { Effect: "Allow", Action: "s3:ListBucket", Resource: bucket },
      { Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject"], Resource: `${bucket}/*` },
    ];
    expect(simulateIam(grants, { action: "s3:ListBucket", resource: bucket }).allowed).toBe(true);
    expect(simulateIam(grants, { action: "s3:ListBucket", resource: `${bucket}/org/key.gz` }).allowed).toBe(false);
    expect(simulateIam(grants, { action: "s3:GetObject", resource: `${bucket}/org/key.gz` }).allowed).toBe(true);
    expect(simulateIam(grants, { action: "s3:GetObject", resource: bucket }).allowed).toBe(false);
    // A statement listing several resources covers each of them, and only them.
    const tables: IamStatement[] = [{ Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:Query"], Resource: ["arn:t:ledger", "arn:t:seals"] }];
    expect(simulateIam(tables, { action: "dynamodb:Query", resource: "arn:t:seals" }).allowed).toBe(true);
    expect(simulateIam(tables, { action: "dynamodb:Query", resource: "arn:t:keys" }).allowed).toBe(false);
    expect(simulateIam(tables, { action: "dynamodb:PutItem", resource: "arn:t:ledger" }).allowed).toBe(false);
  });

  it("lets an explicit Deny beat an Allow", () => {
    const result = simulateIam([allow({ Action: "dynamodb:*", Sid: "A" }), { Sid: "D", Effect: "Deny", Action: "dynamodb:DeleteItem", Resource: "*" }], { action: "dynamodb:DeleteItem", resource: "table" });
    expect(result).toStrictEqual({ allowed: false, reason: "explicit-deny", matched: ["D"] });
  });

  it("matches wildcards in actions (any case) and resources", () => {
    expect(simulateIam([allow({ Action: "DynamoDB:Get*", Resource: "arn:aws:dynamodb:*:*:table/x*" })], { action: "dynamodb:GetItem", resource: "arn:aws:dynamodb:us-east-1:1:table/xy" }).allowed).toBe(true);
    expect(simulateIam([allow({ Action: "dynamodb:Get*" })], { action: "dynamodb:PutItem", resource: "table" }).allowed).toBe(false);
  });

  it("reads NotAction and NotResource as everything else", () => {
    expect(simulateIam([{ Effect: "Allow", NotAction: "s3:*", Resource: "*" }], { action: "dynamodb:PutItem", resource: "x" }).allowed).toBe(true);
    expect(simulateIam([{ Effect: "Allow", NotAction: "s3:*", Resource: "*" }], { action: "s3:GetObject", resource: "x" }).allowed).toBe(false);
    expect(simulateIam([{ Effect: "Allow", Action: "*", NotResource: "secret*" }], { action: "s3:GetObject", resource: "secret-1" }).allowed).toBe(false);
  });

  describe("conditions", () => {
    const leading = (values: string[]) => ({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": values } });
    const put = (keys?: string[]) => simulateIam([allow({ Condition: leading(["AUDIT#*", "AUDIT_DIRTY"]) })], { action: "dynamodb:PutItem", resource: "table", ...(keys === undefined ? {} : { context: { "dynamodb:LeadingKeys": keys } }) });

    it("ForAllValues: every supplied value must match some pattern", () => {
      expect(put(["AUDIT#org_a"]).allowed).toBe(true);
      expect(put(["AUDIT#org_a", "AUDIT_DIRTY"]).allowed).toBe(true);
      expect(put(["AUDIT_EPOCH"]).allowed).toBe(false);
      expect(put(["AUDIT#org_a", "AUDIT_EPOCH"]).allowed).toBe(false);
    });

    it("ForAllValues passes when the request carries no value, as IAM does", () => {
      expect(put(undefined).allowed).toBe(true);
    });

    it("ForAnyValue needs one match and fails on none supplied", () => {
      const statement = allow({ Condition: { "ForAnyValue:StringEquals": { "kms:EncryptionContextKeys": ["rovara:org"] } } });
      expect(simulateIam([statement], { action: "dynamodb:PutItem", resource: "table", context: { "kms:EncryptionContextKeys": ["rovara:org", "x"] } }).allowed).toBe(true);
      expect(simulateIam([statement], { action: "dynamodb:PutItem", resource: "table", context: { "kms:EncryptionContextKeys": ["x"] } }).allowed).toBe(false);
      expect(simulateIam([statement], { action: "dynamodb:PutItem", resource: "table" }).allowed).toBe(false);
    });

    it("StringEquals fails on a missing key; the negated operators pass on it", () => {
      const equals = allow({ Condition: { StringEquals: { "k:purpose": "audit-details" } } });
      expect(simulateIam([equals], { action: "dynamodb:PutItem", resource: "table", context: { "k:purpose": "audit-details" } }).allowed).toBe(true);
      expect(simulateIam([equals], { action: "dynamodb:PutItem", resource: "table", context: { "k:purpose": "other" } }).allowed).toBe(false);
      expect(simulateIam([equals], { action: "dynamodb:PutItem", resource: "table" }).allowed).toBe(false);
      const notEquals = allow({ Condition: { ArnNotEquals: { "aws:PrincipalArn": "arn:x" } } });
      expect(simulateIam([notEquals], { action: "dynamodb:PutItem", resource: "table" }).allowed).toBe(true);
      expect(simulateIam([notEquals], { action: "dynamodb:PutItem", resource: "table", context: { "aws:PrincipalArn": "arn:x" } }).allowed).toBe(false);
    });

    it("Null and Bool", () => {
      const absent = allow({ Condition: { Null: { "s3:if-none-match": "false" } } });
      expect(simulateIam([absent], { action: "dynamodb:PutItem", resource: "table" }).allowed).toBe(false);
      expect(simulateIam([absent], { action: "dynamodb:PutItem", resource: "table", context: { "s3:if-none-match": "*" } }).allowed).toBe(true);
      const tls = { Sid: "D", Effect: "Deny", Action: "*", Resource: "*", Condition: { Bool: { "aws:SecureTransport": "false" } } };
      expect(simulateIam([allow({}), tls], { action: "dynamodb:PutItem", resource: "table", context: { "aws:SecureTransport": "false" } }).allowed).toBe(false);
      expect(simulateIam([allow({}), tls], { action: "dynamodb:PutItem", resource: "table", context: { "aws:SecureTransport": "true" } }).allowed).toBe(true);
    });

    it("compares numbers: a key that is absent matches no positive numeric operator, and NumericNotEquals is satisfied by an absent key", () => {
      const deny = (operator: string, value: string): IamStatement => ({ Sid: "D", Effect: "Deny", Action: "*", Resource: "*", Condition: { [operator]: { "s3:object-lock-remaining-retention-days": value } } });
      const days = (statements: IamStatement[], remaining?: string) => simulateIam([allow({ Action: "*", Resource: "*" }), ...statements], { action: "s3:PutObject", resource: "x", ...(remaining === undefined ? {} : { context: { "s3:object-lock-remaining-retention-days": remaining } }) }).allowed;
      // DenyShortRetention: refuses a stated retention shorter than the floor, and says nothing about a request that states none.
      expect(days([deny("NumericLessThan", "1096")], "30")).toBe(false);
      expect(days([deny("NumericLessThan", "1096")], "1096")).toBe(true);
      expect(days([deny("NumericLessThan", "1096")], "2000")).toBe(true);
      expect(days([deny("NumericLessThan", "1096")])).toBe(true);
      expect(days([deny("NumericLessThanEquals", "5")], "5")).toBe(false);
      expect(days([deny("NumericGreaterThan", "5")], "6")).toBe(false);
      expect(days([deny("NumericGreaterThanEquals", "5")], "5")).toBe(false);
      expect(days([deny("NumericEquals", "5")], "5")).toBe(false);
      expect(days([deny("NumericEquals", "5")], "6")).toBe(true);
      expect(days([deny("NumericNotEquals", "5")], "6")).toBe(false);
      expect(days([deny("NumericNotEquals", "5")], "5")).toBe(true);
      expect(days([deny("NumericNotEquals", "5")])).toBe(false);
      expect(days([deny("NumericEquals", "5")])).toBe(true);
    });

    it("refuses an operator it does not know, and several values given to a single-valued operator", () => {
      expect(() => simulateIam([allow({ Condition: { DateLessThan: { "s3:x": "1" } } })], { action: "dynamodb:PutItem", resource: "table" })).toThrow(/unsupported condition operator/);
      expect(() => simulateIam([allow({ Condition: { StringEquals: { "dynamodb:LeadingKeys": "a" } } })], { action: "dynamodb:PutItem", resource: "table", context: { "dynamodb:LeadingKeys": ["a", "b"] } })).toThrow(/ForAllValues or ForAnyValue/);
    });
  });

  describe("principals (resource policies)", () => {
    const keyPolicy: IamStatement[] = [{ Sid: "Use", Effect: "Allow", Principal: { AWS: "role.Arn" }, Action: "kms:Decrypt", Resource: "*" }];
    it("matches the named principal only", () => {
      expect(simulateIam(keyPolicy, { action: "kms:Decrypt", resource: "*", principal: "role.Arn" }).allowed).toBe(true);
      expect(simulateIam(keyPolicy, { action: "kms:Decrypt", resource: "*", principal: "other.Arn" }).allowed).toBe(false);
    });
    it("refuses to evaluate a resource policy without a principal", () => {
      expect(() => simulateIam(keyPolicy, { action: "kms:Decrypt", resource: "*" })).toThrow(/principal/);
    });
    it('treats Principal "*" and { AWS: "*" } as anyone', () => {
      const deny: IamStatement = { Effect: "Deny", Principal: { AWS: "*" }, Action: "kms:CreateGrant", Resource: "*" };
      expect(simulateIam([deny], { action: "kms:CreateGrant", resource: "*", principal: "anyone" }).reason).toBe("explicit-deny");
    });
  });
});

describe("roleStatements", () => {
  const readable = (value: unknown) => value;
  const template = {
    Resources: {
      Role1: { Type: "AWS::IAM::Role", Properties: { Policies: [{ PolicyName: "inline", PolicyDocument: { Statement: [{ Effect: "Allow", Action: "a:b", Resource: "*" }] } }] } },
      Policy1: { Type: "AWS::IAM::Policy", Properties: { Roles: [{ Ref: "Role1" }], PolicyDocument: { Statement: { Effect: "Allow", Action: "c:d", Resource: "*" } } } },
      Policy2: { Type: "AWS::IAM::Policy", Properties: { Roles: [{ Ref: "Role2" }], PolicyDocument: { Statement: [{ Effect: "Allow", Action: "e:f", Resource: "*" }] } } },
      Role2: { Type: "AWS::IAM::Role", Properties: { ManagedPolicyArns: ["arn:aws:iam::aws:policy/AdministratorAccess"] } },
    },
  };

  it("collects a role's inline policies and the policies that list it, and no one else's", () => {
    expect(roleStatements(template, "Role1", readable).map((statement) => statement.Action)).toStrictEqual(["a:b", "c:d"]);
  });

  it("refuses a role with a managed policy it cannot read, and an unknown role", () => {
    expect(() => roleStatements(template, "Role2", readable)).toThrow(/managed policies/);
    expect(() => roleStatements(template, "Nope", readable)).toThrow(/no role/);
  });
});
