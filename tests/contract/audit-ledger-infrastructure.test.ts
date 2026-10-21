// tests/contract/audit-ledger-infrastructure.test.ts
// Task 5 of the Audit Ledger plan: queues, tables, the vault key and its explicit policy, and the Object Lock
// bucket with its policy. Nothing here is deployed; every check reads a synthesized template.
import { createHash } from "node:crypto";
import { App, Stack, aws_iam as iam } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { AUDIT_INTAKE_MAX_RECEIVES, canonicalJson } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { AuditLedger } from "../../infra/lib/audit-ledger.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { auditLockSettings, auditTsaSettings } from "../../infra/lib/audit-settings.js";
import { evaluate } from "../support/cfn-evaluate.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Json = Record<string, unknown>;
type Resource = { Type: string; Properties: Json; DeletionPolicy?: string; UpdateReplacePolicy?: string };
type TemplateJson = { Resources: Record<string, Resource> };
type Statement = { Sid?: string; Effect?: string; Principal?: unknown; Action?: string | string[]; Resource?: unknown; Condition?: Record<string, Record<string, unknown>> };

const ACCOUNT = "123456789012";
const REGION = "us-east-1";
const KEEP = ["Retain", "RetainExceptOnCreate"];

interface Synth { stack: Stack; template: TemplateJson; ledger: AuditLedger; stacks: Stack[] }

function synth(context: Record<string, unknown>): Synth {
  const app = buildAgentXApp(context);
  const stacks = app.node.children.filter((child): child is Stack => Stack.isStack(child));
  const stack = stacks.find((candidate) => candidate.node.tryFindChild("AuditLedger") !== undefined)!;
  return { stack, stacks, template: Template.fromStack(stack).toJSON() as TemplateJson, ledger: stack.node.findChild("AuditLedger") as AuditLedger };
}

const ofType = (template: TemplateJson, type: string) => Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);
/** The one resource of `type` whose logical ID starts with `prefix` (the construct path, then a hash). */
function one(template: TemplateJson, type: string, prefix: string): [string, Resource] {
  const found = ofType(template, type).filter(([id]) => id.startsWith(prefix));
  expect(found.map(([id]) => id), `${type} ${prefix}`).toHaveLength(1);
  return found[0]!;
}
const withoutHash = (logicalId: string) => logicalId.replace(/[0-9A-F]{8}$/, "");

/** A template value with pseudo parameters filled in and GetAtt turned into readable "<id>.<attribute>" text. */
function concrete(value: unknown, pseudo: Record<string, string> = {}): unknown {
  const readable = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(readable);
    if (node === null || typeof node !== "object") return node;
    const entries = Object.entries(node as Json);
    if (entries.length === 1 && entries[0]![0] === "Fn::GetAtt") {
      const [id, attribute] = entries[0]![1] as [string, string];
      return `${withoutHash(id)}.${attribute}`;
    }
    return Object.fromEntries(entries.map(([key, entry]) => [key, readable(entry)]));
  };
  return evaluate(readable(value), { parameters: {}, conditions: {}, pseudo });
}
const concreteAws = (value: unknown) => concrete(value, { "AWS::AccountId": ACCOUNT, "AWS::Region": REGION, "AWS::Partition": "aws" });

const named = (env: string, extra: Record<string, unknown> = {}) => synth({ agentxEnv: env, ...extra });

describe("auditLockSettings", () => {
  const settings = (env: string, context: { lockMode?: unknown; retentionDays?: unknown } = {}) => auditLockSettings(environmentNaming(env), context);

  it("defaults staging, test and dev* to governance for one day, with a governance floor", () => {
    for (const env of ["staging", "test", "dev", "dev-eu"]) {
      expect(settings(env)).toStrictEqual({ mode: "GOVERNANCE", retentionDays: 1, floor: { mode: "GOVERNANCE", days: 1 } });
    }
  });

  it("defaults every other environment to compliance for 1,096 days, with a compliance floor of 365", () => {
    for (const env of ["production", "acme", "ops-team"]) {
      expect(settings(env)).toStrictEqual({ mode: "COMPLIANCE", retentionDays: 1096, floor: { mode: "COMPLIANCE", days: 365 } });
    }
  });

  it("lets the context win above the floor", () => {
    expect(settings("production", { retentionDays: "2000" }).retentionDays).toBe(2000);
    expect(settings("staging", { lockMode: "COMPLIANCE", retentionDays: 30 })).toStrictEqual({ mode: "COMPLIANCE", retentionDays: 30, floor: { mode: "GOVERNANCE", days: 1 } });
  });

  it("throws the floor text below the floor, for the mode and for the days", () => {
    const text = (env: string) => `audit ledger: ${env} needs compliance mode with at least 365 days`;
    expect(() => settings("acme", { lockMode: "GOVERNANCE" })).toThrow(text("acme"));
    expect(() => settings("production", { retentionDays: 100 })).toThrow(text("production"));
    expect(() => settings("production", { retentionDays: "364" })).toThrow(text("production"));
    expect(() => settings("production", { lockMode: "GOVERNANCE", retentionDays: 1096 })).toThrow(text("production"));
    expect(() => settings("staging", { retentionDays: 0 })).toThrow(/audit ledger: staging needs at least 1 day/);
  });

  it("refuses values that are not a mode or a whole number of days", () => {
    expect(() => settings("production", { lockMode: "compliance-ish" })).toThrow(/agentxAuditLockMode/);
    expect(() => settings("production", { retentionDays: "many" })).toThrow(/agentxAuditRetentionDays/);
    expect(() => settings("production", { retentionDays: 400.5 })).toThrow(/agentxAuditRetentionDays/);
  });

  it("is for named environments only", () => {
    expect(() => auditLockSettings({ ...environmentNaming("staging"), env: undefined }, {})).toThrow(/named environments/);
  });
});

describe("auditTsaSettings", () => {
  it("defaults to public", () => {
    expect(auditTsaSettings({})).toStrictEqual({ kind: "public" });
    expect(auditTsaSettings({ tsa: "off" })).toStrictEqual({ kind: "off" });
  });

  it("takes one or two http(s) URLs and a roots parameter for custom", () => {
    expect(auditTsaSettings({ tsa: "custom", tsaUrls: "https://tsa.example.com/ts", tsaRootsParameter: "/agentx/acme/tsa-roots" }))
      .toStrictEqual({ kind: "custom", urls: ["https://tsa.example.com/ts"], rootsParameter: "/agentx/acme/tsa-roots" });
    expect(auditTsaSettings({ tsa: "custom", tsaUrls: "http://a.example.com, https://b.example.com", tsaRootsParameter: "/r" }))
      .toStrictEqual({ kind: "custom", urls: ["http://a.example.com", "https://b.example.com"], rootsParameter: "/r" });
  });

  it("throws the exact text without URLs, without roots, with three URLs or with a non-http URL", () => {
    const text = "audit ledger: a custom timestamp authority needs its URL and root certificates";
    expect(() => auditTsaSettings({ tsa: "custom", tsaUrls: "https://tsa.example.com" })).toThrow(text);
    expect(() => auditTsaSettings({ tsa: "custom", tsaRootsParameter: "/r" })).toThrow(text);
    expect(() => auditTsaSettings({ tsa: "custom", tsaUrls: "https://a.example,https://b.example,https://c.example", tsaRootsParameter: "/r" })).toThrow(text);
    expect(() => auditTsaSettings({ tsa: "custom", tsaUrls: "ftp://tsa.example.com", tsaRootsParameter: "/r" })).toThrow(text);
    expect(() => auditTsaSettings({ tsa: "custom", tsaUrls: "not a url", tsaRootsParameter: "/r" })).toThrow(text);
  });

  it("refuses an unknown kind", () => {
    expect(() => auditTsaSettings({ tsa: "freetsa" })).toThrow(/agentxAuditTsa/);
  });
});

describe("the audit ledger in templates", () => {
  const production = named("production");
  const staging = named("staging");
  const acme = named("acme");

  it("is for named environments only: a legacy template holds nothing of it", () => {
    const legacy = Template.fromStack(buildAgentXApp().node.children.filter((child): child is Stack => Stack.isStack(child)).find((stack) => stack.stackName === "AgentXControlPlane")!).toJSON() as TemplateJson;
    expect(Object.keys(legacy.Resources).filter((id) => id.includes("Audit"))).toStrictEqual([]);
    expect(JSON.stringify(legacy)).not.toContain("audit-vault");
  });

  describe("Object Lock (Review Focus 4)", () => {
    const lock = (synthesis: Synth) => {
      const [, bucket] = one(synthesis.template, "AWS::S3::Bucket", "AuditLedgerAuditLedgerBucket");
      return { bucket, configuration: bucket.Properties.ObjectLockConfiguration, versioning: bucket.Properties.VersioningConfiguration };
    };

    it("production is compliance for 1,096 days with versioning enabled", () => {
      const { bucket, configuration, versioning } = lock(production);
      expect(bucket.Properties.ObjectLockEnabled).toBe(true);
      expect(configuration).toStrictEqual({ ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: 1096 } } });
      expect(versioning).toStrictEqual({ Status: "Enabled" });
    });

    it("staging is governance for one day", () => {
      expect(lock(staging).configuration).toStrictEqual({ ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "GOVERNANCE", Days: 1 } } });
    });

    it("a private install (acme) is compliance", () => {
      expect(lock(acme).configuration).toStrictEqual({ ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: 1096 } } });
      expect(acme.ledger.lock).toStrictEqual({ mode: "COMPLIANCE", retentionDays: 1096, floor: { mode: "COMPLIANCE", days: 365 } });
    });

    it("acme with agentxAuditLockMode=GOVERNANCE throws the floor text at synth", () => {
      expect(() => named("acme", { agentxAuditLockMode: "GOVERNANCE" })).toThrow("audit ledger: acme needs compliance mode with at least 365 days");
    });

    it("production with 100 days throws the floor text at synth", () => {
      expect(() => named("production", { agentxAuditRetentionDays: "100" })).toThrow("audit ledger: production needs compliance mode with at least 365 days");
      expect(() => named("production", { agentxAuditRetentionDays: 100 })).toThrow("audit ledger: production needs compliance mode with at least 365 days");
    });

    it("a private install may raise the retention", () => {
      expect(lock(named("acme", { agentxAuditRetentionDays: "1826" })).configuration).toStrictEqual({ ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: 1826 } } });
    });
  });

  describe("the buckets", () => {
    it("the ledger bucket is named by environment, account and region, blocked, encrypted, owner-enforced and never expires anything", () => {
      const [id, bucket] = one(production.template, "AWS::S3::Bucket", "AuditLedgerAuditLedgerBucket");
      expect(concreteAws(bucket.Properties.BucketName)).toBe(`agentx-production-audit-ledger-${ACCOUNT}-${REGION}`);
      expect(bucket.Properties.PublicAccessBlockConfiguration).toStrictEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
      expect(bucket.Properties.BucketEncryption).toStrictEqual({ ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] });
      expect(bucket.Properties.OwnershipControls).toStrictEqual({ Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] });
      expect(bucket.Properties.LifecycleConfiguration).toBeUndefined();
      expect(KEEP).toContain(bucket.DeletionPolicy);
      expect(KEEP).toContain(bucket.UpdateReplacePolicy);
      expect(id).toMatch(/^AuditLedgerAuditLedgerBucket/);
    });

    it("the exports bucket is blocked, encrypted, SSL-only and expires after seven days", () => {
      const [id, bucket] = one(production.template, "AWS::S3::Bucket", "AuditLedgerAuditExportsBucket");
      expect(bucket.Properties.PublicAccessBlockConfiguration).toStrictEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
      expect(bucket.Properties.BucketEncryption).toStrictEqual({ ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] });
      expect(bucket.Properties.LifecycleConfiguration).toStrictEqual({ Rules: [{ ExpirationInDays: 7, Status: "Enabled" }] });
      expect(bucket.Properties.ObjectLockEnabled).toBeUndefined();
      expect(KEEP).toContain(bucket.DeletionPolicy);
      const policy = Object.values(production.template.Resources).find((resource) => resource.Type === "AWS::S3::BucketPolicy" && JSON.stringify(resource.Properties.Bucket).includes(id))!;
      expect(JSON.stringify(policy.Properties.PolicyDocument)).toContain("aws:SecureTransport");
    });
  });

  describe("the ledger bucket policy", () => {
    const statementsOf = (synthesis: Synth) => {
      const [id] = one(synthesis.template, "AWS::S3::Bucket", "AuditLedgerAuditLedgerBucket");
      const policies = Object.values(synthesis.template.Resources).filter((resource) => resource.Type === "AWS::S3::BucketPolicy" && (resource.Properties.Bucket as { Ref?: string }).Ref === id);
      expect(policies).toHaveLength(1);
      return { document: policies[0]!.Properties.PolicyDocument, statements: (policies[0]!.Properties.PolicyDocument as { Statement: Statement[] }).Statement.map((statement) => concreteAws(statement) as Statement) };
    };
    const bucketArn = (env: string) => `arn:aws:s3:::agentx-${env}-audit-ledger-${ACCOUNT}-${REGION}`;
    const roleArn = (name: string) => `arn:aws:iam::${ACCOUNT}:role/${name}`;
    const expected = (env: string, mode: "COMPLIANCE" | "GOVERNANCE", days: number): Statement[] => {
      const naming = environmentNaming(env);
      const operator = roleArn(naming.operatorRoleName);
      const cloudFormation = roleArn(naming.cloudFormationRoleName);
      const objects = `${bucketArn(env)}/*`;
      const governance = mode === "GOVERNANCE";
      return [
        {
          Sid: "DenyDeletes", Effect: "Deny", Principal: { AWS: "*" }, Action: ["s3:DeleteObject", "s3:DeleteObjectVersion"], Resource: objects,
          ...(governance ? { Condition: { ArnNotEquals: { "aws:PrincipalArn": operator } } } : {}),
        },
        {
          Sid: "DenyLockChanges", Effect: "Deny", Principal: { AWS: "*" },
          Action: ["s3:PutBucketObjectLockConfiguration", "s3:PutObjectRetention", "s3:PutObjectLegalHold", "s3:BypassGovernanceRetention"],
          Resource: [bucketArn(env), objects],
          Condition: { ArnNotEquals: { "aws:PrincipalArn": governance ? [cloudFormation, operator] : cloudFormation } },
        },
        { Sid: "RequireConditionalWrites", Effect: "Deny", Principal: { AWS: "*" }, Action: "s3:PutObject", Resource: objects, Condition: { Null: { "s3:if-none-match": "true" } } },
        { Sid: "DenyShortRetention", Effect: "Deny", Principal: { AWS: "*" }, Action: "s3:PutObject", Resource: objects, Condition: { NumericLessThan: { "s3:object-lock-remaining-retention-days": String(days) } } },
        { Sid: "AllowSSLRequestsOnly", Effect: "Deny", Principal: { AWS: "*" }, Action: "s3:*", Resource: [bucketArn(env), objects], Condition: { Bool: { "aws:SecureTransport": "false" } } },
      ];
    };

    it("production has the four statements and the SSL rule exactly, with no operator exception", () => {
      expect(statementsOf(production).statements).toStrictEqual(expected("production", "COMPLIANCE", 1096));
    });

    it("a private install has no operator exception either", () => {
      expect(statementsOf(acme).statements).toStrictEqual(expected("acme", "COMPLIANCE", 1096));
    });

    it("staging excepts the operator role, and only the CloudFormation role besides, from the lock changes", () => {
      expect(statementsOf(staging).statements).toStrictEqual(expected("staging", "GOVERNANCE", 1));
    });

    it("the retention statement follows a raised retention", () => {
      const raised = named("acme", { agentxAuditRetentionDays: "1826" });
      expect(statementsOf(raised).statements).toStrictEqual(expected("acme", "COMPLIANCE", 1826));
    });

    it("excepts no one from the delete denial in compliance, and the CloudFormation role only from the lock denial", () => {
      for (const { statements } of [statementsOf(production), statementsOf(acme)]) {
        const byId: Record<string, Statement> = Object.fromEntries(statements.map((statement) => [statement.Sid ?? "", statement]));
        expect(byId.DenyDeletes!.Condition).toBeUndefined();
        expect(JSON.stringify(byId.DenyLockChanges!.Condition)).not.toContain("operator");
        for (const sid of ["RequireConditionalWrites", "DenyShortRetention"]) expect(JSON.stringify(byId[sid]!.Condition)).not.toContain("aws:PrincipalArn");
      }
    });

    it("hands the anchor the SHA-256 of the canonical policy document, with account, region and partition left as placeholders", () => {
      const placeholders = { "AWS::AccountId": "{{account}}", "AWS::Region": "{{region}}", "AWS::Partition": "{{partition}}" };
      for (const synthesis of [production, staging, acme]) {
        const { document } = statementsOf(synthesis);
        const text = canonicalJson(concrete(document, placeholders));
        expect(text).toContain("{{account}}");
        expect(synthesis.ledger.bucketPolicySha256).toBe(createHash("sha256").update(text).digest("hex"));
      }
      expect(new Set([production, staging, acme].map((synthesis) => synthesis.ledger.bucketPolicySha256)).size).toBe(3);
    });
  });

  describe("the vault key policy (I12)", () => {
    const keyOf = (synthesis: Synth) => one(synthesis.template, "AWS::KMS::Key", "AuditLedgerAuditVaultKey");
    const policyOf = (synthesis: Synth) => ((keyOf(synthesis)[1].Properties.KeyPolicy as { Statement: Statement[] }).Statement).map((statement) => concreteAws(statement) as Statement);
    const roleIdOf = (synthesis: Synth, prefix: string) => withoutHash(one(synthesis.template, "AWS::IAM::Role", prefix)[0]);
    const contextConditions = {
      StringEquals: { "kms:EncryptionContext:rovara:purpose": "audit-details" },
      "ForAnyValue:StringEquals": { "kms:EncryptionContextKeys": ["rovara:org"] },
    };

    it("is a symmetric rotating key with the alias and description of the plan, kept on delete", () => {
      const [, key] = keyOf(production);
      expect(key.Properties.EnableKeyRotation).toBe(true);
      expect(key.Properties.Description).toBe("Rovara audit ledger details, per org data keys");
      expect(key.Properties.KeySpec ?? "SYMMETRIC_DEFAULT").toBe("SYMMETRIC_DEFAULT");
      expect(key.Properties.KeyUsage ?? "ENCRYPT_DECRYPT").toBe("ENCRYPT_DECRYPT");
      expect(KEEP).toContain(key.DeletionPolicy);
      expect(KEEP).toContain(key.UpdateReplacePolicy);
      const [, alias] = one(production.template, "AWS::KMS::Alias", "AuditLedgerAuditVaultKey");
      expect(alias.Properties.AliasName).toBe("alias/agentx/production/audit-vault");
      expect(KEEP).toContain(alias.DeletionPolicy);
    });

    for (const env of ["production", "staging", "acme"]) {
      it(`${env} has the five statements exactly`, () => {
        const synthesis = named(env);
        const cloudFormation = `arn:aws:iam::${ACCOUNT}:role/${environmentNaming(env).cloudFormationRoleName}`;
        expect(policyOf(synthesis)).toStrictEqual([
          {
            Sid: "AdminWithoutUse", Effect: "Allow", Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` },
            Action: [
              "kms:CreateAlias", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*", "kms:Update*", "kms:Revoke*", "kms:Get*",
              "kms:TagResource", "kms:UntagResource", "kms:CancelKeyDeletion",
            ],
            Resource: "*",
          },
          {
            Sid: "DenyDestroy", Effect: "Deny", Principal: { AWS: "*" }, Action: ["kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:PutKeyPolicy"], Resource: "*",
            Condition: { ArnNotEquals: { "aws:PrincipalArn": cloudFormation } },
          },
          { Sid: "DenyGrants", Effect: "Deny", Principal: { AWS: "*" }, Action: "kms:CreateGrant", Resource: "*" },
          {
            Sid: "AppenderUse", Effect: "Allow", Principal: { AWS: `${roleIdOf(synthesis, "AuditAppenderRole")}.Arn` },
            Action: ["kms:GenerateDataKey", "kms:Decrypt"], Resource: "*", Condition: contextConditions,
          },
          {
            Sid: "BrokerUse", Effect: "Allow", Principal: { AWS: `${roleIdOf(synthesis, "BrokerServiceRole")}.Arn` },
            Action: "kms:Decrypt", Resource: "*", Condition: contextConditions,
          },
        ]);
      });
    }

    it("the administrator statement has no kms:Create*, no use of the key and no wildcard that reaches either", () => {
      const admin = policyOf(production).find((statement) => statement.Sid === "AdminWithoutUse")!;
      const actions = [admin.Action].flat() as string[];
      expect(actions).not.toContain("kms:Create*");
      expect(actions).toContain("kms:CreateAlias");
      const reaches = (action: string) => actions.some((pattern) => new RegExp(`^${pattern.replaceAll("*", ".*")}$`, "i").test(action));
      for (const forbidden of ["kms:CreateGrant", "kms:CreateKey", "kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:GenerateDataKeyWithoutPlaintext", "kms:ReEncryptFrom", "kms:ReEncryptTo", "kms:ScheduleKeyDeletion", "kms:DisableKey"]) {
        expect(reaches(forbidden), forbidden).toBe(false);
      }
      expect(reaches("kms:PutKeyPolicy")).toBe(true);
    });

    it("the appender role is a bare Lambda role and the broker role is the broker function's", () => {
      const appender = one(production.template, "AWS::IAM::Role", "AuditAppenderRole")[1];
      expect(JSON.stringify(appender.Properties.AssumeRolePolicyDocument)).toContain("lambda.amazonaws.com");
      expect(appender.Properties.ManagedPolicyArns).toBeUndefined();
      expect(appender.Properties.Policies).toBeUndefined();
      const brokerRoleId = one(production.template, "AWS::IAM::Role", "BrokerServiceRole")[0];
      const broker = one(production.template, "AWS::Lambda::Function", "Broker")[1];
      expect((broker.Properties.Role as { "Fn::GetAtt": string[] })["Fn::GetAtt"][0]).toBe(brokerRoleId);
    });

    describe("least privilege: nothing but the key policy grants use of the key", () => {
      type Found = { stack: string; where: string; statement: Statement; keyPolicy: boolean };
      /** Every IAM statement of the stacks: identity policies, managed policies, inline role policies, and resource policies (queues, buckets, topics, keys). */
      function everyStatement(stacks: Stack[]): Found[] {
        const found: Found[] = [];
        for (const stack of stacks) {
          const template = Template.fromStack(stack).toJSON() as TemplateJson;
          for (const [id, resource] of Object.entries(template.Resources)) {
            const documents: unknown[] = [];
            const properties = resource.Properties;
            if (properties.PolicyDocument !== undefined) documents.push(properties.PolicyDocument);
            if (properties.KeyPolicy !== undefined) documents.push(properties.KeyPolicy);
            if (Array.isArray(properties.Policies)) for (const inline of properties.Policies as Array<{ PolicyDocument?: unknown }>) if (inline.PolicyDocument !== undefined) documents.push(inline.PolicyDocument);
            for (const document of documents) {
              for (const statement of (document as { Statement: Statement[] }).Statement) {
                found.push({ stack: stack.stackName, where: id, statement, keyPolicy: resource.Type === "AWS::KMS::Key" });
              }
            }
          }
        }
        return found;
      }
      const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`, "i");
      const USE_ACTIONS = ["kms:Decrypt", "kms:GenerateDataKey", "kms:GenerateDataKeyWithoutPlaintext", "kms:GenerateDataKeyPair", "kms:GenerateDataKeyPairWithoutPlaintext", "kms:Encrypt", "kms:ReEncryptFrom", "kms:ReEncryptTo"];
      const grantsUse = (statement: Statement) => [statement.Action].flat().some((pattern) => USE_ACTIONS.some((action) => glob(String(pattern)).test(action)));

      // The access stack's CloudFormation service role and the default permission boundary list kms:* on every
      // resource by design (R53: the service role manages every key; the boundary is only a ceiling). That reaches
      // nothing here: the key policy delegates no use action to IAM (AdminWithoutUse above), so an IAM allow cannot
      // open it. Any other statement that could reach the key is an offender.
      const baseline = (stack: string, where: string) => /^agentx-[a-z0-9-]+-access$/.test(stack) && /^(DefaultPermissionsBoundary|CloudFormationServiceRole)/.test(where);

      /** Allowing statements, outside the vault key's own policy, that grant use by naming the key or on every resource. */
      function offenders(stacks: Stack[]): string[] {
        return everyStatement(stacks)
          .filter(({ statement }) => statement.Effect !== "Deny" && grantsUse(statement))
          .filter(({ keyPolicy, statement }) => JSON.stringify([statement.Resource, statement.Principal]).includes("AuditLedgerAuditVaultKey") || (!keyPolicy && [statement.Resource].flat().includes("*")))
          .filter(({ stack, where, keyPolicy }) => !(keyPolicy && where.startsWith("AuditLedgerAuditVaultKey")) && !baseline(stack, where))
          .map(({ stack, where }) => `${stack}/${where}`);
      }

      it("no policy in any stack allows use of the key by naming it or on every resource", () => {
        expect(offenders(production.stacks)).toStrictEqual([]);
      });

      it("the baseline wildcards exist as described, so the allowance above is not stale", () => {
        const wildcards = everyStatement(production.stacks)
          .filter(({ keyPolicy, statement }) => !keyPolicy && statement.Effect !== "Deny" && grantsUse(statement) && [statement.Resource].flat().includes("*"));
        expect(wildcards.length).toBeGreaterThan(0);
        expect(wildcards.every(({ stack, where }) => baseline(stack, where))).toBe(true);
      });

      it("inside the key policy only AppenderUse and BrokerUse allow use, each naming one role", () => {
        const allowingUse = policyOf(production).filter((statement) => statement.Effect === "Allow" && grantsUse(statement));
        expect(allowingUse.map((statement) => statement.Sid)).toStrictEqual(["AppenderUse", "BrokerUse"]);
        expect(allowingUse.every((statement) => typeof (statement.Principal as { AWS: unknown }).AWS === "string" && (statement.Principal as { AWS: string }).AWS.endsWith(".Arn"))).toBe(true);
      });

      it("the scan catches a violation: a role granted Decrypt on the key, and a policy on every resource", () => {
        const scratch = (violate: boolean): Stack => {
          const stack = new Stack(new App(), "Scratch");
          const role = (id: string) => new iam.Role(stack, id, { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });
          const ledger = new AuditLedger(stack, "AuditLedger", { naming: environmentNaming("acme"), brokerRole: role("BrokerRole"), appenderRole: role("AppenderRole") });
          if (violate) {
            role("IntruderRole").addToPolicy(new iam.PolicyStatement({ actions: ["kms:Decrypt"], resources: [ledger.vaultKey.keyArn] }));
            role("WideRole").addToPolicy(new iam.PolicyStatement({ actions: ["kms:GenerateDataKey*"], resources: ["*"] }));
          }
          return stack;
        };
        expect(offenders([scratch(false)])).toStrictEqual([]);
        expect(offenders([scratch(true)]).map((entry) => entry.replace(/[0-9A-F]{8}$/, ""))).toStrictEqual(["Scratch/IntruderRoleDefaultPolicy", "Scratch/WideRoleDefaultPolicy"]);
      });
    });
  });

  describe("the intake queue and its dead-letter queue", () => {
    const queues = (synthesis: Synth) => {
      const [intakeId, intake] = one(synthesis.template, "AWS::SQS::Queue", "AuditLedgerAuditIntakeQueue");
      const [dlqId, dlq] = one(synthesis.template, "AWS::SQS::Queue", "AuditLedgerAuditIntakeDeadLetterQueue");
      return { intakeId, intake, dlqId, dlq };
    };

    it("is FIFO, per message group, with 180 s of visibility, 14 days, SQS-managed encryption and a dead-letter queue", () => {
      const { intake, dlqId } = queues(production);
      const { Tags: tags, ...properties } = intake.Properties;
      expect(tags).toStrictEqual([{ Key: "agentx:env", Value: "production" }]);
      expect(properties).toStrictEqual({
        QueueName: "agentx-production-audit-intake.fifo",
        FifoQueue: true,
        ContentBasedDeduplication: false,
        DeduplicationScope: "messageGroup",
        FifoThroughputLimit: "perMessageGroupId",
        VisibilityTimeout: 180,
        MessageRetentionPeriod: 1209600,
        SqsManagedSseEnabled: true,
        RedrivePolicy: { deadLetterTargetArn: { "Fn::GetAtt": [dlqId, "Arn"] }, maxReceiveCount: AUDIT_INTAKE_MAX_RECEIVES },
      });
      expect(AUDIT_INTAKE_MAX_RECEIVES).toBe(5);
    });

    it("has a FIFO dead-letter queue that keeps messages 14 days", () => {
      const { dlq } = queues(production);
      expect(dlq.Properties).toMatchObject({ QueueName: "agentx-production-audit-intake-dlq.fifo", FifoQueue: true, MessageRetentionPeriod: 1209600, SqsManagedSseEnabled: true });
    });

    it("refuses plain HTTP on both, and keeps both on delete", () => {
      const { intakeId, intake, dlqId, dlq } = queues(production);
      for (const id of [intakeId, dlqId]) {
        const policy = Object.values(production.template.Resources).find((resource) => resource.Type === "AWS::SQS::QueuePolicy" && JSON.stringify(resource.Properties.Queues).includes(id));
        expect(JSON.stringify(policy?.Properties.PolicyDocument), id).toContain("aws:SecureTransport");
      }
      for (const queue of [intake, dlq]) {
        expect(KEEP).toContain(queue.DeletionPolicy);
        expect(KEEP).toContain(queue.UpdateReplacePolicy);
      }
    });

    it("is named by environment", () => {
      expect(queues(staging).intake.Properties.QueueName).toBe("agentx-staging-audit-intake.fifo");
      expect(queues(acme).dlq.Properties.QueueName).toBe("agentx-acme-audit-intake-dlq.fifo");
    });
  });

  describe("the tables", () => {
    const table = (synthesis: Synth, name: string) => one(synthesis.template, "AWS::DynamoDB::Table", `AuditLedger${name}`)[1];

    it("the ledger and seals tables are on demand, keyed pk and sk, with point-in-time recovery", () => {
      for (const name of ["AuditLedgerTable", "AuditSealsTable"]) {
        const properties = table(production, name).Properties;
        expect(properties.KeySchema, name).toStrictEqual([{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }]);
        expect(properties.BillingMode, name).toBe("PAY_PER_REQUEST");
        expect(properties.PointInTimeRecoverySpecification, name).toStrictEqual({ PointInTimeRecoveryEnabled: true });
      }
    });

    it("the keys table has no point-in-time recovery (design decision 6)", () => {
      const properties = table(production, "AuditKeysTable").Properties;
      expect(properties.KeySchema).toStrictEqual([{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }]);
      expect(properties.BillingMode).toBe("PAY_PER_REQUEST");
      const recovery = properties.PointInTimeRecoverySpecification as { PointInTimeRecoveryEnabled?: boolean } | undefined;
      expect(recovery?.PointInTimeRecoveryEnabled ?? false).toBe(false);
    });

    it("all three have deletion protection, the same encryption as the State table and are kept on delete", () => {
      for (const name of ["AuditLedgerTable", "AuditSealsTable", "AuditKeysTable"]) {
        const resource = table(production, name);
        expect(resource.Properties.DeletionProtectionEnabled, name).toBe(true);
        expect(resource.Properties.SSESpecification, name).toStrictEqual({ SSEEnabled: true });
        expect(KEEP).toContain(resource.DeletionPolicy);
        expect(KEEP).toContain(resource.UpdateReplacePolicy);
      }
    });

    it("exactly these three tables are new, beside the existing ones", () => {
      const audit = ofType(production.template, "AWS::DynamoDB::Table").filter(([id]) => id.startsWith("AuditLedger"));
      expect(audit).toHaveLength(3);
    });
  });

  describe("the replica", () => {
    const replication = (synthesis: Synth) => one(synthesis.template, "AWS::S3::Bucket", "AuditLedgerAuditLedgerBucket")[1].Properties.ReplicationConfiguration as { Role: unknown; Rules: Array<Record<string, unknown>> } | undefined;
    const ARN = "arn:aws:s3:::acme-audit-replica-bucket";

    it("adds no rule and no role by default", () => {
      expect(replication(production)).toBeUndefined();
      expect(Object.keys(production.template.Resources).filter((id) => id.startsWith("AuditLedgerAuditReplication"))).toStrictEqual([]);
    });

    it("the ARN alone throws", () => {
      expect(() => named("acme", { agentxAuditReplicaBucketArn: ARN })).toThrow(/agentxAuditReplicaLockConfirmed/);
      expect(() => named("acme", { agentxAuditReplicaBucketArn: ARN, agentxAuditReplicaLockConfirmed: false })).toThrow(/agentxAuditReplicaLockConfirmed/);
      expect(() => named("acme", { agentxAuditReplicaBucketArn: ARN, agentxAuditReplicaLockConfirmed: "no" })).toThrow(/agentxAuditReplicaLockConfirmed/);
    });

    it("the confirmation alone adds nothing", () => {
      expect(replication(named("acme", { agentxAuditReplicaLockConfirmed: true }))).toBeUndefined();
    });

    it("both values add the replication rule and a role that may replicate to that bucket only", () => {
      for (const confirmed of [true, "true"]) {
        const synthesis = named("acme", { agentxAuditReplicaBucketArn: ARN, agentxAuditReplicaLockConfirmed: confirmed });
        const configuration = replication(synthesis)!;
        expect(configuration.Rules).toHaveLength(1);
        expect(configuration.Rules[0]).toMatchObject({ Status: "Enabled", Destination: { Bucket: ARN }, DeleteMarkerReplication: { Status: "Disabled" } });
        const [roleId] = one(synthesis.template, "AWS::IAM::Role", "AuditLedgerAuditReplicationRole");
        expect(configuration.Role).toStrictEqual({ "Fn::GetAtt": [roleId, "Arn"] });
        const policies = ofType(synthesis.template, "AWS::IAM::Policy").filter(([id]) => id.startsWith("AuditLedgerAuditReplicationRole"));
        const statements = policies.flatMap(([, policy]) => (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
        const replicates = statements.filter((statement) => [statement.Action].flat().some((action) => /Replicate/.test(String(action))));
        expect(replicates).toStrictEqual([{ Effect: "Allow", Action: ["s3:ReplicateObject", "s3:ReplicateTags"], Resource: `${ARN}/*` }]);
        // Nothing else writes: every other action reads the source bucket.
        expect(statements.flatMap((statement) => [statement.Action].flat()).filter((action) => !/Replicate/.test(String(action)) && !/^s3:(Get|List)/.test(String(action)))).toStrictEqual([]);
      }
    });

    it("refuses something that is not a bucket ARN", () => {
      expect(() => named("acme", { agentxAuditReplicaBucketArn: "acme-bucket", agentxAuditReplicaLockConfirmed: true })).toThrow(/agentxAuditReplicaBucketArn/);
    });
  });

  describe("the timestamp authority context", () => {
    it("custom without roots throws the exact text at synth", () => {
      expect(() => named("acme", { agentxAuditTsa: "custom", agentxAuditTsaUrls: "https://tsa.example.com" })).toThrow("audit ledger: a custom timestamp authority needs its URL and root certificates");
    });

    it("custom with both is accepted and held on the construct", () => {
      const synthesis = named("acme", { agentxAuditTsa: "custom", agentxAuditTsaUrls: "https://tsa.example.com", agentxAuditTsaRootsParameter: "/agentx/acme/tsa-roots" });
      expect(synthesis.ledger.tsa).toStrictEqual({ kind: "custom", urls: ["https://tsa.example.com"], rootsParameter: "/agentx/acme/tsa-roots" });
      expect(production.ledger.tsa).toStrictEqual({ kind: "public" });
    });
  });

  it("no resource name or description carries an em dash", () => {
    const text = JSON.stringify(Object.fromEntries(Object.entries(production.template.Resources).filter(([id]) => id.startsWith("AuditLedger") || id.startsWith("AuditAppender"))));
    expect(text).not.toContain("—");
  });
});
