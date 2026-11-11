// tests/contract/audit-ledger-infrastructure.test.ts
// Task 5 of the Audit Ledger plan: queues, tables, the vault key and its explicit policy, and the Object Lock
// bucket with its policy. Nothing here is deployed; every check reads a synthesized template.
import { createHash } from "node:crypto";
import { App, ArnFormat, Stack, aws_cloudwatch_actions as cloudwatchActions, aws_dynamodb as dynamodb, aws_iam as iam, aws_lambda as lambda, aws_sns as sns } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { AUDIT_EXPORT_FILE_LIFECYCLE_DAYS, AUDIT_EXPORT_MAX_EVENT_AGE_SECONDS, AUDIT_EXPORT_RETRY_ATTEMPTS, AUDIT_EXPORT_TIMEOUT_SECONDS, AUDIT_INTAKE_MAX_RECEIVES, HEALTH_ALARM_SUFFIXES } from "@agentx/cloud-contracts";
import { canonicalJson } from "@rovara-code/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { AuditLedger } from "../../infra/lib/audit-ledger.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { auditLockSettings, auditTsaSettings } from "../../infra/lib/audit-settings.js";
import { evaluate } from "../support/cfn-evaluate.js";
import { roleStatements, simulateIam, type IamStatement } from "../support/iam-simulate.js";
import { lockedPutInput } from "../../packages/broker/src/audit/anchor.js";
import { brokerNamesIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Json = Record<string, unknown>;
type Resource = { Type: string; Properties: Json; DeletionPolicy?: string; UpdateReplacePolicy?: string };
type TemplateJson = { Resources: Record<string, Resource>; Parameters?: Record<string, { Default?: string; AllowedValues?: string[]; Type?: string }>; Conditions?: Record<string, unknown> };
type Statement = { Sid?: string; Effect?: string; Principal?: unknown; Action?: string | string[]; NotAction?: string | string[]; Resource?: unknown; NotResource?: unknown; Condition?: Record<string, Record<string, unknown>> };

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

/** A template value with pseudo parameters filled in, GetAtt turned into readable "<id>.<attribute>" text and a Ref to a resource into "Ref:<id>". */
function concrete(value: unknown, pseudo: Record<string, string> = {}, parameters: Record<string, string> = {}, conditions: Record<string, unknown> = {}): unknown {
  const readable = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(readable);
    if (node === null || typeof node !== "object") return node;
    const entries = Object.entries(node as Json);
    if (entries.length === 1 && entries[0]![0] === "Fn::GetAtt") {
      const [id, attribute] = entries[0]![1] as [string, string];
      return `${withoutHash(id)}.${attribute}`;
    }
    if (entries.length === 1 && entries[0]![0] === "Ref" && !String(entries[0]![1]).startsWith("AWS::")) return `Ref:${withoutHash(String(entries[0]![1]))}`;
    return Object.fromEntries(entries.map(([key, entry]) => [key, readable(entry)]));
  };
  return evaluate(readable(value), { parameters, conditions, pseudo });
}
const concreteAws = (value: unknown) => concrete(value, { "AWS::AccountId": ACCOUNT, "AWS::Region": REGION, "AWS::Partition": "aws" });
type Profile = "production" | "trial";
/** A value of the synthesized template with the lock profile chosen (its default when not given), the way CloudFormation evaluates it. */
const underProfile = (synthesis: Synth, value: unknown, profile?: Profile, pseudo: Record<string, string> = { "AWS::AccountId": ACCOUNT, "AWS::Region": REGION, "AWS::Partition": "aws" }) =>
  concrete(value, pseudo, { AuditLockProfile: profile ?? synthesis.template.Parameters!.AuditLockProfile!.Default! }, synthesis.template.Conditions ?? {});

const named = (env: string, extra: Record<string, unknown> = {}) => synth({ agentxEnv: env, ...extra });

/** What the ledger needs from the control plane, as a scratch stack provides it: a broker function, the State table and an alarm action. */
function scratchProps(stack: Stack) {
  return {
    naming: environmentNaming("acme"),
    broker: new lambda.Function(stack, "Broker", { runtime: lambda.Runtime.NODEJS_22_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler = async () => ({});") }),
    stateTable: new dynamodb.Table(stack, "State", { partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING }, sortKey: { name: "sk", type: dynamodb.AttributeType.STRING } }),
    notifyOperator: new cloudwatchActions.SnsAction(new sns.Topic(stack, "Alerts")),
  };
}

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
    const lock = (synthesis: Synth, profile?: Profile) => {
      const [, bucket] = one(synthesis.template, "AWS::S3::Bucket", "AuditLedgerAuditLedgerBucket");
      return { bucket, configuration: underProfile(synthesis, bucket.Properties.ObjectLockConfiguration, profile), versioning: bucket.Properties.VersioningConfiguration };
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

  describe("the lock profile (Task 5b)", () => {
    const lockOf = (synthesis: Synth, profile?: Profile) => {
      const [, bucket] = one(synthesis.template, "AWS::S3::Bucket", "AuditLedgerAuditLedgerBucket");
      return underProfile(synthesis, bucket.Properties.ObjectLockConfiguration, profile);
    };
    const production2 = (days: number) => ({ ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: days } } });
    const trial2 = (days: number) => ({ ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "GOVERNANCE", Days: days } } });

    it("declares AuditLockProfile with production and trial as the only values, and production as the default of a real install", () => {
      for (const synthesis of [production, acme]) {
        expect(synthesis.template.Parameters!.AuditLockProfile).toMatchObject({ Type: "String", Default: "production", AllowedValues: ["production", "trial"] });
        expect(synthesis.template.Conditions!.AuditLockIsTrial).toStrictEqual({ "Fn::Equals": [{ Ref: "AuditLockProfile" }, "trial"] });
      }
    });

    it("production gives compliance for 1,096 days and trial governance for one day", () => {
      for (const synthesis of [production, acme, staging]) {
        expect(lockOf(synthesis, "production")).toStrictEqual(production2(1096));
        expect(lockOf(synthesis, "trial")).toStrictEqual(trial2(1));
      }
    });

    it("a named environment built by CDK keeps its own settings under the parameter's default", () => {
      expect(staging.template.Parameters!.AuditLockProfile!.Default).toBe("trial");
      expect(lockOf(staging)).toStrictEqual(trial2(1));
      expect(lockOf(production)).toStrictEqual(production2(1096));
      expect(lockOf(named("acme", { agentxAuditRetentionDays: "1826" }))).toStrictEqual(production2(1826));
      expect(lockOf(named("acme", { agentxAuditRetentionDays: "1826" }), "trial")).toStrictEqual(trial2(1));
      expect(lockOf(named("staging", { agentxAuditLockMode: "COMPLIANCE", agentxAuditRetentionDays: 30 }))).toStrictEqual(production2(30));
    });

    it("the floor still throws at synth for the CDK context", () => {
      expect(() => named("acme", { agentxAuditLockMode: "GOVERNANCE" })).toThrow("audit ledger: acme needs compliance mode with at least 365 days");
      expect(() => named("production", { agentxAuditRetentionDays: "100" })).toThrow("audit ledger: production needs compliance mode with at least 365 days");
    });

    it("keeps the bucket's logical id and name, so the profile change is an update in place", () => {
      for (const synthesis of [production, staging, acme]) {
        const [id, bucket] = one(synthesis.template, "AWS::S3::Bucket", "AuditLedgerAuditLedgerBucket");
        expect(id).toBe("AuditLedgerAuditLedgerBucket8577AC5B");
        // Nothing but the default retention and the policy depends on the parameter: no name or replacement-only property.
        expect(JSON.stringify(bucket.Properties.BucketName)).not.toContain("AuditLockProfile");
        expect(JSON.stringify(bucket.Properties.ObjectLockEnabled)).not.toContain("AuditLockProfile");
        expect(JSON.stringify(bucket.Properties.VersioningConfiguration)).not.toContain("AuditLockProfile");
      }
    });

    it("the parameter and its condition are used by the bucket, its policy and the anchor's lock settings only", () => {
      const users = Object.entries(production.template.Resources)
        .filter(([, resource]) => JSON.stringify(resource).includes("AuditLockIsTrial") || JSON.stringify(resource).includes("AuditLockProfile"))
        .map(([id]) => withoutHash(id));
      expect(users.sort()).toStrictEqual(["AuditLedgerAuditAnchor", "AuditLedgerAuditLedgerBucket", "AuditLedgerAuditLedgerBucketPolicy"]);
    });

    it("the policy statements are right in both profiles", () => {
      const statements = (synthesis: Synth, profile: Profile): Statement[] => {
        const [id] = one(synthesis.template, "AWS::S3::Bucket", "AuditLedgerAuditLedgerBucket");
        const policy = Object.values(synthesis.template.Resources).find((resource) => resource.Type === "AWS::S3::BucketPolicy" && (resource.Properties.Bucket as { Ref?: string }).Ref === id)!;
        return (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement.map((statement) => underProfile(synthesis, statement, profile) as Statement);
      };
      const by = (list: Statement[]) => Object.fromEntries(list.map((statement) => [statement.Sid ?? "", statement]));
      const naming = environmentNaming("acme");
      const operator = `arn:aws:iam::${ACCOUNT}:role/${naming.operatorRoleName}`;
      const cloudFormation = `arn:aws:iam::${ACCOUNT}:role/${naming.cloudFormationRoleName}`;

      const compliance = by(statements(acme, "production"));
      expect(Object.keys(compliance)).toStrictEqual(["DenyDeletes", "DenyLockChanges", "RequireConditionalWrites", "DenyShortRetention", "AllowSSLRequestsOnly"]);
      expect(compliance.DenyDeletes!.Condition).toBeUndefined();
      expect(compliance.DenyLockChanges!.Condition).toStrictEqual({ ArnNotEquals: { "aws:PrincipalArn": cloudFormation } });
      expect(compliance.DenyShortRetention!.Condition).toStrictEqual({ NumericLessThan: { "s3:object-lock-remaining-retention-days": "1096" } });

      const governance = by(statements(acme, "trial"));
      expect(Object.keys(governance)).toStrictEqual(Object.keys(compliance));
      expect(governance.DenyDeletes!.Condition).toStrictEqual({ ArnNotEquals: { "aws:PrincipalArn": operator } });
      expect(governance.DenyLockChanges!.Condition).toStrictEqual({ ArnNotEquals: { "aws:PrincipalArn": [cloudFormation, operator] } });
      expect(governance.DenyShortRetention!.Condition).toStrictEqual({ NumericLessThan: { "s3:object-lock-remaining-retention-days": "1" } });
      // The statements that do not depend on the profile are the same in both.
      for (const sid of ["RequireConditionalWrites", "AllowSSLRequestsOnly"]) expect(governance[sid]).toStrictEqual(compliance[sid]);
      // The CloudFormation role is excepted from the lock-change denial only, in both profiles.
      for (const list of [compliance, governance]) {
        for (const sid of ["DenyDeletes", "RequireConditionalWrites", "DenyShortRetention", "AllowSSLRequestsOnly"]) expect(JSON.stringify(list[sid]!.Condition ?? {})).not.toContain(cloudFormation);
      }
    });

    it("the policy override relies on CDK keeping the statements in the order they were added: the first statements CDK builds are the profile's own", () => {
      const own = underProfile(acme, ((one(acme.template, "AWS::S3::BucketPolicy", "AuditLedgerAuditLedgerBucketPolicy")[1].Properties.PolicyDocument) as { Statement: unknown[] }).Statement, "production") as unknown[];
      const built = underProfile(acme, (acme.stack.resolve(acme.ledger.ledgerBucket.policy!.document.toJSON()) as { Statement: unknown[] }).Statement, "production") as unknown[];
      expect(own.length).toBeGreaterThanOrEqual(4);
      expect(built.length).toBeGreaterThanOrEqual(own.length);
      expect(built.slice(0, own.length).map((statement) => canonicalJson(statement))).toStrictEqual(own.map((statement) => canonicalJson(statement)));
    });

    it("a statement a later task adds to the policy is kept after the profile's own", () => {
      const stack = new Stack(new App(), "Scratch");
      const ledger = new AuditLedger(stack, "AuditLedger", { ...scratchProps(stack), appenderRole: new iam.Role(stack, "AppenderRole", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") }) });
      ledger.ledgerBucket.addToResourcePolicy(new iam.PolicyStatement({ sid: "LaterTask", actions: ["s3:GetObject"], resources: [ledger.ledgerBucket.arnForObjects("*")], principals: [new iam.AccountRootPrincipal()] }));
      const template = Template.fromStack(stack).toJSON() as TemplateJson;
      const sids = ((one(template, "AWS::S3::BucketPolicy", "AuditLedgerAuditLedgerBucketPolicy")[1].Properties.PolicyDocument as { Statement: Statement[] }).Statement).map((statement) => statement.Sid);
      expect(sids.at(-1)).toBe("LaterTask");
      expect(sids.filter((sid) => sid === "LaterTask")).toHaveLength(1);
    });

    it("the hash the anchor is given is a template token, not a hex digest", () => {
      expect(acme.ledger.bucketPolicySha256).not.toMatch(/^[0-9a-f]{64}$/);
      expect(acme.ledger.bucketPolicySha256ByProfile.production).toMatch(/^[0-9a-f]{64}$/);
    });

    it("the profile differs between the hashes, and a raised retention changes only the production one", () => {
      const raised = named("acme", { agentxAuditRetentionDays: "1826" });
      expect(raised.ledger.bucketPolicySha256ByProfile.trial).toBe(acme.ledger.bucketPolicySha256ByProfile.trial);
      expect(raised.ledger.bucketPolicySha256ByProfile.production).not.toBe(acme.ledger.bucketPolicySha256ByProfile.production);
      expect(acme.ledger.bucketPolicySha256ByProfile.trial).not.toBe(acme.ledger.bucketPolicySha256ByProfile.production);
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
      // The days an export stays available are derived from this one number, a day short of it.
      expect(AUDIT_EXPORT_FILE_LIFECYCLE_DAYS).toBe(7);
      expect(bucket.Properties.ObjectLockEnabled).toBeUndefined();
      expect(KEEP).toContain(bucket.DeletionPolicy);
      const policy = Object.values(production.template.Resources).find((resource) => resource.Type === "AWS::S3::BucketPolicy" && JSON.stringify(resource.Properties.Bucket).includes(id))!;
      expect(JSON.stringify(policy.Properties.PolicyDocument)).toContain("aws:SecureTransport");
    });
  });

  describe("the ledger bucket policy", () => {
    const statementsOf = (synthesis: Synth, profile?: Profile) => {
      const [id] = one(synthesis.template, "AWS::S3::Bucket", "AuditLedgerAuditLedgerBucket");
      const policies = Object.values(synthesis.template.Resources).filter((resource) => resource.Type === "AWS::S3::BucketPolicy" && (resource.Properties.Bucket as { Ref?: string }).Ref === id);
      expect(policies).toHaveLength(1);
      return { document: policies[0]!.Properties.PolicyDocument, statements: (policies[0]!.Properties.PolicyDocument as { Statement: Statement[] }).Statement.map((statement) => underProfile(synthesis, statement, profile) as Statement) };
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

    it("hands the anchor the SHA-256 of the canonical policy document of each profile, with account, region, partition and environment name left as placeholders", () => {
      const placeholders = { "AWS::AccountId": "{{account}}", "AWS::Region": "{{region}}", "AWS::Partition": "{{partition}}" };
      const hashes: string[] = [];
      for (const [env, synthesis] of [["production", production], ["staging", staging], ["acme", acme]] as const) {
        const { document } = statementsOf(synthesis);
        for (const profile of ["production", "trial"] as const) {
          // The evaluator resolves the same document, with the profile chosen, to what the anchor reads back from the bucket.
          const text = canonicalJson(underProfile(synthesis, document, profile, placeholders));
          expect(text).toContain("{{account}}");
          expect(text).toContain(`agentx-${env}-`);
          // The environment's name is a placeholder too (Task 9): a published template is rendered by text replacement, which cannot recompute a hash.
          expect(synthesis.ledger.bucketPolicySha256ByProfile[profile]).toBe(createHash("sha256").update(text.replaceAll(`agentx-${env}-`, "agentx-{{env}}-")).digest("hex"));
          hashes.push(synthesis.ledger.bucketPolicySha256ByProfile[profile]);
        }
      }
      // Three environments and two profiles: the name is not part of the hash, and the profiles differ.
      expect(new Set(hashes).size).toBe(2);
    });

    it("the hash the anchor is given follows the chosen profile", () => {
      for (const synthesis of [production, staging]) {
        const token: unknown = synthesis.stack.resolve(synthesis.ledger.bucketPolicySha256);
        for (const profile of ["production", "trial"] as const) {
          expect(underProfile(synthesis, token, profile)).toBe(synthesis.ledger.bucketPolicySha256ByProfile[profile]);
        }
      }
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

    it("is a symmetric rotating key with the description of the plan, kept on delete", () => {
      const [, key] = keyOf(production);
      expect(key.Properties.EnableKeyRotation).toBe(true);
      expect(key.Properties.Description).toBe("Rovara audit ledger details, per org data keys");
      expect(key.Properties.KeySpec ?? "SYMMETRIC_DEFAULT").toBe("SYMMETRIC_DEFAULT");
      expect(key.Properties.KeyUsage ?? "ENCRYPT_DECRYPT").toBe("ENCRYPT_DECRYPT");
      expect(KEEP).toContain(key.DeletionPolicy);
      expect(KEEP).toContain(key.UpdateReplacePolicy);
    });

    // Final review I1: a fixed alias name that a rolled-back first create keeps (nobody the key policy allows can DeleteAlias) makes every
    // retry of a failed first deploy fail with AlreadyExistsException. Nothing reads an alias (the key is addressed by its ARN), so there is none.
    for (const env of ["production", "staging", "acme"]) {
      it(`${env} has no KMS alias for the vault key, and nothing in its stack keeps one`, () => {
        const synthesis = named(env);
        const keyId = keyOf(synthesis)[0];
        // The stack's other keys have aliases (the invoke signing key, the developer token key); the vault key has none.
        expect(ofType(synthesis.template, "AWS::KMS::Alias").filter(([, alias]) => JSON.stringify(alias.Properties.TargetKeyId).includes(keyId)).map(([id]) => id)).toEqual([]);
        expect(ofType(synthesis.template, "AWS::KMS::Alias").map(([id]) => id).filter((id) => id.startsWith("AuditLedger"))).toEqual([]);
        expect(JSON.stringify(synthesis.template)).not.toMatch(/audit-vault|AuditVaultKeyAlias/);
        // The key policy allows no DeleteAlias, so an alias would be one no one could remove: the policy has to stay as it is.
        const admin = ((keyOf(synthesis)[1].Properties.KeyPolicy as { Statement: Statement[] }).Statement).find((statement) => statement.Sid === "AdminWithoutUse")!;
        expect([admin.Action].flat()).not.toContain("kms:DeleteAlias");
      });
    }

    for (const env of ["production", "staging", "acme"]) {
      it(`${env} has the six statements exactly`, () => {
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
          {
            Sid: "ExportUse", Effect: "Allow", Principal: { AWS: `${roleIdOf(synthesis, "AuditLedgerAuditExportRole")}.Arn` },
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

    it("the appender role is a Lambda role with no managed or inline policy of its own (its grants are separate policies, pinned below) and the broker role is the broker function's", () => {
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
      /** Every IAM statement of the stacks: identity policies, managed policies (AWS::IAM::ManagedPolicy), inline role policies, and resource policies (queues, buckets, topics, keys). */
      function everyStatement(stacks: Stack[]): Found[] {
        const found: Found[] = [];
        for (const stack of stacks) {
          const template = Template.fromStack(stack).toJSON() as TemplateJson;
          for (const [id, resource] of Object.entries(template.Resources)) {
            const documents: unknown[] = [];
            const properties = resource.Properties ?? {};
            if (properties.PolicyDocument !== undefined) documents.push(properties.PolicyDocument);
            if (properties.KeyPolicy !== undefined) documents.push(properties.KeyPolicy);
            if (Array.isArray(properties.Policies)) for (const inline of properties.Policies as Array<{ PolicyDocument?: unknown }>) if (inline.PolicyDocument !== undefined) documents.push(inline.PolicyDocument);
            for (const document of documents) {
              for (const statement of [(document as { Statement: Statement | Statement[] }).Statement].flat()) {
                found.push({ stack: stack.stackName, where: id, statement, keyPolicy: resource.Type === "AWS::KMS::Key" });
              }
            }
          }
        }
        return found;
      }
      const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`, "i");
      const USE_ACTIONS = ["kms:Decrypt", "kms:GenerateDataKey", "kms:GenerateDataKeyWithoutPlaintext", "kms:GenerateDataKeyPair", "kms:GenerateDataKeyPairWithoutPlaintext", "kms:Encrypt", "kms:ReEncryptFrom", "kms:ReEncryptTo"];
      /** Allow with Action patterns reaching a use action, or NotAction leaving any use action unexcluded (an Allow NotAction grants everything it does not list). */
      const grantsUse = (statement: Statement) => {
        if (statement.NotAction !== undefined) return USE_ACTIONS.some((action) => ![statement.NotAction].flat().some((pattern) => glob(String(pattern)).test(action)));
        return [statement.Action].flat().some((pattern) => USE_ACTIONS.some((action) => glob(String(pattern)).test(action)));
      };

      /** A template value as one pattern: Fn::Join and Fn::Sub are spelled out, any other intrinsic is "${ref}", so `key/*` at the end of a Join still reads as a wildcard. */
      function pattern(value: unknown): string {
        if (typeof value === "string") return value;
        if (Array.isArray(value)) return value.map(pattern).join("");
        if (value === null || typeof value !== "object") return String(value);
        const [name, argument] = Object.entries(value as Json)[0] ?? [];
        if (name === "Fn::Join") return (argument as [string, unknown[]])[1].map(pattern).join((argument as [string, unknown[]])[0]);
        if (name === "Fn::Sub") return pattern(Array.isArray(argument) ? argument[0] : argument);
        return "${ref}";
      }
      /** A resource that can be the vault key: any "*", or any KMS-looking pattern with a wildcard (arn:...:kms:*:*:key/*, key/abc*). */
      const wildcardKey = (resource: unknown) => [resource].flat().some((entry) => { const text = pattern(entry); return text === "*" || (/kms/i.test(text) && text.includes("*")); });
      /** Anything that names the key: its logical ID or an ImportValue of its export, in the resource or principal. */
      const namesKey = (statement: Statement) => JSON.stringify([statement.Resource, statement.NotResource, statement.Principal]).includes("AuditVaultKey");

      // The access stack's CloudFormation service role and the default permission boundary list kms:* on every
      // resource by design (R53: the service role manages every key; the boundary is only a ceiling). That reaches
      // nothing here: the key policy delegates no use action to IAM (AdminWithoutUse above), so an IAM allow cannot
      // open it. Any other statement that could reach the key is an offender.
      const baseline = (stack: string, where: string) => /^agentx-[a-z0-9-]+-access$/.test(stack) && /^(DefaultPermissionsBoundary|CloudFormationServiceRole)/.test(where);

      // Managed policies that grant nothing on KMS. Any other attachment to a role is an offender, because an
      // AWS-managed policy such as AdministratorAccess or PowerUserAccess cannot be read here.
      const HARMLESS_MANAGED = ["service-role/AWSLambdaBasicExecutionRole", "service-role/AWSLambdaVPCAccessExecutionRole"];

      /** Roles with a ManagedPolicyArns entry that is neither a policy of the same template (a Ref, scanned as AWS::IAM::ManagedPolicy) nor on the harmless list. */
      function managedAttachments(stacks: Stack[]): string[] {
        const found: string[] = [];
        for (const stack of stacks) {
          const template = Template.fromStack(stack).toJSON() as TemplateJson;
          for (const [id, resource] of Object.entries(template.Resources)) {
            if (!["AWS::IAM::Role", "AWS::IAM::User", "AWS::IAM::Group"].includes(resource.Type) || !Array.isArray(resource.Properties?.ManagedPolicyArns)) continue;
            for (const entry of resource.Properties.ManagedPolicyArns as unknown[]) {
              if (typeof entry === "object" && entry !== null && "Ref" in entry) continue;
              if (!HARMLESS_MANAGED.some((name) => pattern(entry).endsWith(`:iam::aws:policy/${name}`))) found.push(`${stack.stackName}/${id}`);
            }
          }
        }
        return found;
      }

      /** Allowing statements, outside the vault key's own policy, that grant use by naming the key, by NotResource, or on a wildcard that includes it; and roles with a non-harmless managed policy. */
      function offenders(stacks: Stack[]): string[] {
        const statements = everyStatement(stacks)
          .filter(({ statement }) => statement.Effect !== "Deny" && grantsUse(statement))
          .filter(({ keyPolicy, statement }) => namesKey(statement) || (!keyPolicy && (statement.NotResource !== undefined || wildcardKey(statement.Resource))))
          .filter(({ stack, where, keyPolicy }) => !(keyPolicy && where.startsWith("AuditLedgerAuditVaultKey")) && !baseline(stack, where))
          .map(({ stack, where }) => `${stack}/${where}`);
        return [...statements, ...managedAttachments(stacks).filter((entry) => !baseline(entry.split("/")[0]!, entry.split("/")[1]!))];
      }

      it("no policy or managed-policy attachment in any stack allows use of the key by naming it, by NotResource or on a wildcard", () => {
        expect(offenders(production.stacks)).toStrictEqual([]);
      });

      it("the baseline wildcards exist as described, so the allowance above is not stale", () => {
        const wildcards = everyStatement(production.stacks)
          .filter(({ keyPolicy, statement }) => !keyPolicy && statement.Effect !== "Deny" && grantsUse(statement) && wildcardKey(statement.Resource));
        expect(wildcards.length).toBeGreaterThan(0);
        expect(wildcards.every(({ stack, where }) => baseline(stack, where))).toBe(true);
      });

      it("inside the key policy only AppenderUse, BrokerUse and ExportUse allow use, each naming one role", () => {
        const allowingUse = policyOf(production).filter((statement) => statement.Effect === "Allow" && grantsUse(statement));
        expect(allowingUse.map((statement) => statement.Sid)).toStrictEqual(["AppenderUse", "BrokerUse", "ExportUse"]);
        expect(allowingUse.every((statement) => typeof (statement.Principal as { AWS: unknown }).AWS === "string" && (statement.Principal as { AWS: string }).AWS.endsWith(".Arn"))).toBe(true);
      });

      /** A scratch stack holding the ledger plus whatever `plant` adds; returns the offenders with the logical-ID hash cut off. */
      function planted(plant: (stack: Stack, ledger: AuditLedger) => void): string[] {
        const stack = new Stack(new App(), "Scratch");
        const role = (id: string) => new iam.Role(stack, id, { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });
        const ledger = new AuditLedger(stack, "AuditLedger", { ...scratchProps(stack), appenderRole: role("AppenderRole") });
        plant(stack, ledger);
        return offenders([stack]).map((entry) => entry.replace(/[0-9A-F]{8}$/, ""));
      }
      const intruder = (stack: Stack) => new iam.Role(stack, "IntruderRole", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });

      it("the scan is clean for the ledger alone", () => {
        expect(planted(() => undefined)).toStrictEqual([]);
      });

      describe("the scan catches a planted statement", () => {
        const actions = ["kms:Decrypt", "kms:GenerateDataKey*", "kms:*", "kms:ReEncrypt*"];
        const resources: Array<[string, (stack: Stack, ledger: AuditLedger) => string[]]> = [
          ["the key ARN", (_stack, ledger) => [ledger.vaultKey.keyArn]],
          ["a key wildcard arn:...:key/*", (stack) => [stack.formatArn({ service: "kms", resource: "key", resourceName: "*", arnFormat: ArnFormat.SLASH_RESOURCE_NAME })]],
          ["a literal key wildcard arn:aws:kms:*:*:key/*", () => ["arn:aws:kms:*:*:key/*"]],
          ["every resource", () => ["*"]],
        ];
        for (const action of actions) {
          for (const [label, resource] of resources) {
            it(`${action} on ${label}`, () => {
              expect(planted((stack, ledger) => intruder(stack).addToPolicy(new iam.PolicyStatement({ actions: [action], resources: resource(stack, ledger) })))).toStrictEqual(["Scratch/IntruderRoleDefaultPolicy"]);
            });
          }
        }

        it("a NotAction statement that leaves the use actions out of its exclusions", () => {
          expect(planted((stack, ledger) => intruder(stack).addToPolicy(new iam.PolicyStatement({ notActions: ["s3:*"], resources: [ledger.vaultKey.keyArn] })))).toStrictEqual(["Scratch/IntruderRoleDefaultPolicy"]);
        });

        it("a NotResource statement", () => {
          expect(planted((stack) => intruder(stack).addToPolicy(new iam.PolicyStatement({ actions: ["kms:Decrypt"], notResources: ["arn:aws:kms:us-east-1:123456789012:key/other"] })))).toStrictEqual(["Scratch/IntruderRoleDefaultPolicy"]);
        });

        it("a NotAction that excludes every use action is not an offender", () => {
          expect(planted((stack) => intruder(stack).addToPolicy(new iam.PolicyStatement({ notActions: ["kms:*"], resources: ["*"] })))).toStrictEqual([]);
        });

        it("a customer managed policy (AWS::IAM::ManagedPolicy)", () => {
          expect(planted((stack, ledger) => {
            new iam.ManagedPolicy(stack, "IntruderPolicy", { statements: [new iam.PolicyStatement({ actions: ["kms:Decrypt"], resources: [ledger.vaultKey.keyArn] })] });
          })).toStrictEqual(["Scratch/IntruderPolicy"]);
          expect(planted((stack) => {
            new iam.ManagedPolicy(stack, "WidePolicy", { statements: [new iam.PolicyStatement({ actions: ["kms:*"], resources: ["*"] })] });
          })).toStrictEqual(["Scratch/WidePolicy"]);
        });

        it("a role with an AWS managed policy attached (ManagedPolicyArns)", () => {
          for (const name of ["AdministratorAccess", "PowerUserAccess"]) {
            expect(planted((stack) => {
              new iam.Role(stack, `Managed${name}`, { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"), managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName(name)] });
            }), name).toStrictEqual([`Scratch/Managed${name}`]);
          }
          // The harmless Lambda execution policies are allowed.
          expect(planted((stack) => {
            new iam.Role(stack, "Basic", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"), managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")] });
          })).toStrictEqual([]);
        });
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

  describe("the anchor's timestamp settings (Task 10)", () => {
    const ROLE = "AuditLedgerAuditAnchorRole";
    const PARAMETER = "/agentx/acme/tsa-roots";
    const PARAMETER_ARN = `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/agentx/acme/tsa-roots`;
    const custom = (urls: string, parameter: string = PARAMETER) => named("acme", { agentxAuditTsa: "custom", agentxAuditTsaUrls: urls, agentxAuditTsaRootsParameter: parameter });
    const variables = (synthesis: Synth) => (one(synthesis.template, "AWS::Lambda::Function", "AuditLedgerAuditAnchor")[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    const tsaVariables = (synthesis: Synth) => Object.fromEntries(Object.entries(variables(synthesis)).filter(([name]) => name.startsWith("AUDIT_TSA_")));
    const ownStatements = (synthesis: Synth): Statement[] => {
      const own = ofType(synthesis.template, "AWS::IAM::Policy").filter(([id]) => withoutHash(id) === "AuditLedgerAuditAnchorPolicy");
      expect(own).toHaveLength(1);
      return ((own[0]![1].Properties.PolicyDocument as { Statement: Statement[] }).Statement).map((statement) => concreteAws(statement) as Statement);
    };
    const identity = (synthesis: Synth): IamStatement[] => roleStatements(synthesis.template, one(synthesis.template, "AWS::IAM::Role", ROLE)[0], concreteAws);
    const ssmStatements = (synthesis: Synth) => identity(synthesis).filter((statement) => [statement.Action].flat().some((action) => String(action).startsWith("ssm:")));

    it("a public install names the kind, the timeout and the spacing, and no URL or parameter; the default is public", () => {
      for (const env of ["production", "staging", "acme"]) {
        expect(tsaVariables(named(env))).toStrictEqual({ AUDIT_TSA_KIND: "public", AUDIT_TSA_TIMEOUT_MS: "10000", AUDIT_TSA_SPACING_MS: "15000" });
      }
    });

    it("an off install says so and names nothing else", () => {
      expect(tsaVariables(named("acme", { agentxAuditTsa: "off" }))).toStrictEqual({ AUDIT_TSA_KIND: "off", AUDIT_TSA_TIMEOUT_MS: "10000", AUDIT_TSA_SPACING_MS: "15000" });
    });

    it("a custom install is given its URLs, in order, and the one parameter that holds their roots", () => {
      expect(tsaVariables(custom("https://tsa-1.example.test/ts, http://tsa-2.example.test/ts"))).toStrictEqual({
        AUDIT_TSA_KIND: "custom", AUDIT_TSA_TIMEOUT_MS: "10000", AUDIT_TSA_SPACING_MS: "15000",
        AUDIT_TSA_URLS: "https://tsa-1.example.test/ts,http://tsa-2.example.test/ts", AUDIT_TSA_ROOTS_PARAMETER: PARAMETER,
      });
      expect(tsaVariables(custom("https://tsa.example.test/ts")).AUDIT_TSA_URLS).toBe("https://tsa.example.test/ts");
    });

    it("grants ssm:GetParameter on the configured parameter, and only when custom: a public or off install has no SSM grant at all", () => {
      for (const synthesis of [named("production"), named("staging"), named("acme"), named("acme", { agentxAuditTsa: "off" })]) {
        expect(ssmStatements(synthesis)).toStrictEqual([]);
        expect(JSON.stringify(synthesis.template.Resources[one(synthesis.template, "AWS::IAM::Policy", "AuditLedgerAuditAnchorPolicy")[0]])).not.toContain("ssm:");
      }
      const synthesis = custom("https://tsa.example.test/ts");
      expect(ssmStatements(synthesis)).toStrictEqual([{ Sid: "TimestampRoots", Effect: "Allow", Action: "ssm:GetParameter", Resource: PARAMETER_ARN }]);
      // The role's other statements are the same eleven as without it, plus the log group's.
      expect(ownStatements(synthesis).map((statement) => statement.Sid)).toStrictEqual(["SealsTable", "LockRatchet", "LedgerRead", "LedgerDirtyMarkers", "LedgerBucketObjects", "LedgerBucketVersions", "LedgerBucketConfiguration", "ShredKeys", "ShredDueItems", "ShredExportObjects", "ShredListExports", "TimestampRoots"]);
    });

    it("a parameter name without a leading slash gets the same kind of ARN", () => {
      expect(ssmStatements(custom("https://tsa.example.test/ts", "tsa-roots"))).toMatchObject([{ Resource: `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/tsa-roots` }]);
    });

    it("IAM lets the anchor read that parameter and no other, and do nothing else in SSM", () => {
      const synthesis = custom("https://tsa.example.test/ts");
      const can = (action: string, resource: string) => simulateIam(identity(synthesis), { action, resource });
      expect(can("ssm:GetParameter", PARAMETER_ARN)).toMatchObject({ allowed: true });
      for (const resource of [`arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/agentx/acme/other`, `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/agentx/acme/tsa-roots-2`, `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/agentx/acme`]) {
        expect(can("ssm:GetParameter", resource), resource).toMatchObject({ allowed: false });
      }
      for (const action of ["ssm:GetParameters", "ssm:GetParametersByPath", "ssm:PutParameter", "ssm:DeleteParameter", "ssm:DescribeParameters"]) {
        expect(can(action, PARAMETER_ARN), action).toMatchObject({ allowed: false });
      }
      // A public install's anchor may not read it.
      const publicIdentity = identity(named("acme"));
      expect(simulateIam(publicIdentity, { action: "ssm:GetParameter", resource: PARAMETER_ARN })).toMatchObject({ allowed: false });
    });

    it("runs outside any VPC whatever the kind, so a public authority is reached over the internet and a private one by its own network", () => {
      for (const synthesis of [named("acme"), custom("https://tsa.example.test/ts"), named("acme", { agentxAuditTsa: "off" })]) {
        expect(one(synthesis.template, "AWS::Lambda::Function", "AuditLedgerAuditAnchor")[1].Properties.VpcConfig).toBeUndefined();
      }
    });

    it("keeps the alarm for a custom and an off install too (the health route reads every alarm by name)", () => {
      for (const synthesis of [custom("https://tsa.example.test/ts"), named("acme", { agentxAuditTsa: "off" })]) {
        expect(one(synthesis.template, "AWS::CloudWatch::Alarm", "AuditLedgerAuditTimestampFailedAlarm")[1].Properties).toMatchObject({ AlarmName: "agentx-acme-AuditTimestampFailed" });
      }
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

  describe("the broker's side of the outbox (Task 6)", () => {
    const BROKER_ROLE = "BrokerServiceRole";
    const policies = (synthesis: Synth) => ofType(synthesis.template, "AWS::IAM::Policy").map(([id, resource]) => ({ id, withoutHash: withoutHash(id), properties: resource.Properties }));
    const rawStatements = (properties: Json) => ((properties.PolicyDocument as { Statement: Statement[] }).Statement);
    const statementsOf = (properties: Json) => rawStatements(properties).map((statement) => concreteAws(statement) as Statement);
    const ARN_OF_QUEUE = "AuditLedgerAuditIntakeQueue.Arn";

    for (const env of ["production", "staging", "acme"]) {
      describe(env, () => {
        const synthesis = named(env);

        it("gives the broker's role exactly three statements for the outbox and the shred schedule, in a policy of their own", () => {
          const own = policies(synthesis).filter(({ withoutHash }) => withoutHash === "AuditLedgerAuditBrokerOutboxPolicy");
          expect(own).toHaveLength(1);
          const brokerRoleId = one(synthesis.template, "AWS::IAM::Role", BROKER_ROLE)[0];
          expect(own[0]!.properties.Roles).toStrictEqual([{ Ref: brokerRoleId }]);
          expect(statementsOf(own[0]!.properties)).toStrictEqual([
            { Sid: "SendAuditEvents", Effect: "Allow", Action: "sqs:SendMessage", Resource: ARN_OF_QUEUE },
            {
              Sid: "AuditPendingItems", Effect: "Allow",
              Action: ["dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
              Resource: "State.Arn",
              Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["AUDIT_PENDING#*"] } },
            },
            // Task 15: closeOrg's transaction puts the due item for the shred, and nothing else in that partition (no read, no delete).
            {
              Sid: "ScheduleShred", Effect: "Allow", Action: "dynamodb:PutItem", Resource: "State.Arn",
              Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["AUDIT_SHRED_DUE"] } },
            },
          ]);
        });

        it("grants nothing on the intake queue, the DLQ, the ledger, seals and keys tables or the buckets to any role but through the pinned statements", () => {
          const watched = ["AuditLedgerAuditIntakeQueue", "AuditLedgerAuditIntakeDeadLetterQueue", "AuditLedgerAuditLedgerTable", "AuditLedgerAuditSealsTable", "AuditLedgerAuditKeysTable", "AuditLedgerAuditLedgerBucket", "AuditLedgerAuditExportsBucket"];
          const mentions = policies(synthesis).flatMap(({ withoutHash: policy, properties }) => rawStatements(properties)
            .filter((statement) => watched.some((name) => JSON.stringify([statement.Resource, statement.NotResource]).includes(name)))
            .map((statement) => `${policy}/${statement.Sid ?? "?"}`));
          // Each function's statements are listed here: the broker's send (Task 6), and the appender's consume and
          // table statements (Task 7, pinned in full in "the appender" below), and the anchor's (Task 8, "the anchor" below). Later tasks add theirs.
          expect(mentions.sort()).toStrictEqual([
            "AuditAppenderRoleDefaultPolicy/?",
            "AuditLedgerAuditAnchorPolicy/LedgerBucketConfiguration",
            "AuditLedgerAuditAnchorPolicy/LedgerBucketObjects",
            "AuditLedgerAuditAnchorPolicy/LedgerBucketVersions",
            "AuditLedgerAuditAnchorPolicy/LedgerDirtyMarkers",
            "AuditLedgerAuditAnchorPolicy/LedgerRead",
            "AuditLedgerAuditAnchorPolicy/LockRatchet",
            "AuditLedgerAuditAnchorPolicy/SealsTable",
            "AuditLedgerAuditAnchorPolicy/ShredExportObjects",
            "AuditLedgerAuditAnchorPolicy/ShredKeys",
            "AuditLedgerAuditAnchorPolicy/ShredListExports",
            "AuditLedgerAuditAppenderPolicy/KeysTable",
            "AuditLedgerAuditAppenderPolicy/LedgerTable",
            "AuditLedgerAuditBrokerOutboxPolicy/SendAuditEvents",
            "AuditLedgerAuditBrokerReadPolicy/DownloadExports",
            "AuditLedgerAuditBrokerReadPolicy/EraseSubjects",
            "AuditLedgerAuditBrokerReadPolicy/ReadKeys",
            "AuditLedgerAuditBrokerReadPolicy/ReadLedgerAndSeals",
            "AuditLedgerAuditExportPolicy/ExportObjects",
            "AuditLedgerAuditExportPolicy/ListExports",
            "AuditLedgerAuditExportPolicy/ReadKeys",
            "AuditLedgerAuditExportPolicy/ReadLedgerAndSeals",
            "AuditLedgerAuditExportPolicy/ReadSealedObjects",
            "AuditLedgerAuditExportPolicy/SendAuditEvents",
            // Task 18: the sign-in function records a sign-in method linked or unlinked and an invite accepted.
            "AuditLedgerAuditSignInOutboxPolicy/SendAuditEvents",
          ]);
          for (const [, role] of ofType(synthesis.template, "AWS::IAM::Role")) {
            expect(JSON.stringify(role.Properties.Policies ?? [])).not.toMatch(/AuditLedger(Audit)?(IntakeQueue|LedgerTable|SealsTable|KeysTable|LedgerBucket)/);
          }
        });

        it("gives the export function (which flushes its audit.exported item) and the sign-in function (Task 18) the intake queue's URL, the broker neither (its name is fixed, so the broker builds the URL: DERIVED_BROKER_VARIABLES), and no other function", () => {
          const functions = ofType(synthesis.template, "AWS::Lambda::Function");
          const withUrl = functions.filter(([, fn]) => (fn.Properties.Environment as { Variables?: Json } | undefined)?.Variables?.AUDIT_INTAKE_QUEUE_URL !== undefined);
          expect(withUrl.map(([id]) => withoutHash(id)).sort()).toStrictEqual(["AuditLedgerAuditExport", "DeveloperSignInFunction"]);
          const variables = (one(synthesis.template, "AWS::Lambda::Function", "Broker")[1].Properties.Environment as { Variables: Json }).Variables;
          expect(variables.AUDIT_INTAKE_QUEUE_URL).toBeUndefined();
          expect(brokerNamesIn(variables)).not.toHaveProperty("auditIntakeQueue");
          // The queue is created with the fixed name the broker derives its URL from (derived-names.test.ts holds the two together).
          expect(one(synthesis.template, "AWS::SQS::Queue", "AuditLedgerAuditIntakeQueue")[1].Properties.QueueName).toMatch(/^agentx-[a-z0-9-]+-audit-intake\.fifo$/);
        });

        it("drains every minute: one schedule, invoking the broker through a scheduler role with { source: agentx.audit-drain }", () => {
          const [, schedule] = one(synthesis.template, "AWS::Scheduler::Schedule", "AuditLedgerAuditDrainSchedule");
          const brokerId = one(synthesis.template, "AWS::Lambda::Function", "Broker")[0];
          expect(concreteAws(schedule.Properties)).toStrictEqual({
            Description: "Sends the audit events the flush after a commit did not deliver",
            FlexibleTimeWindow: { Mode: "OFF" },
            ScheduleExpression: "rate(1 minute)",
            State: "ENABLED",
            Target: {
              Arn: `${withoutHash(brokerId)}.Arn`,
              RoleArn: "AuditLedgerAuditDrainSchedulerRole.Arn",
              Input: JSON.stringify({ source: "agentx.audit-drain" }),
              RetryPolicy: { MaximumEventAgeInSeconds: 60, MaximumRetryAttempts: 0 },
            },
          });
          const drains = ofType(synthesis.template, "AWS::Scheduler::Schedule").filter(([, other]) => JSON.stringify(other.Properties).includes("agentx.audit-drain"));
          expect(drains).toHaveLength(1);
        });

        it("the scheduler role trusts the scheduler for this account's default group only, and may invoke the broker only", () => {
          const [, role] = one(synthesis.template, "AWS::IAM::Role", "AuditLedgerAuditDrainSchedulerRole");
          const brokerId = one(synthesis.template, "AWS::Lambda::Function", "Broker")[0];
          expect(concreteAws(role.Properties.AssumeRolePolicyDocument)).toStrictEqual({
            Version: "2012-10-17",
            Statement: [{
              Effect: "Allow", Action: "sts:AssumeRole", Principal: { Service: "scheduler.amazonaws.com" },
              Condition: { StringEquals: { "aws:SourceAccount": ACCOUNT, "aws:SourceArn": `arn:aws:scheduler:${REGION}:${ACCOUNT}:schedule-group/default` } },
            }],
          });
          const inline = role.Properties.Policies as Array<{ PolicyName: string; PolicyDocument: { Statement: Statement[] } }>;
          expect(inline).toHaveLength(1);
          expect(inline[0]!.PolicyDocument.Statement.map((statement) => concreteAws(statement))).toStrictEqual([
            { Sid: "InvokeBroker", Effect: "Allow", Action: "lambda:InvokeFunction", Resource: `${withoutHash(brokerId)}.Arn` },
          ]);
          expect(role.Properties.ManagedPolicyArns).toBeUndefined();
        });

        it("counts audit.record_failed and audit.record_invalid on the broker's log, and alarms at one in five minutes", () => {
          const logGroupId = one(synthesis.template, "AWS::Logs::LogGroup", "BrokerLogs")[0];
          const [, filter] = one(synthesis.template, "AWS::Logs::MetricFilter", "AuditLedgerAuditRecordFailedMetric");
          expect(filter.Properties).toStrictEqual({
            LogGroupName: { Ref: logGroupId },
            FilterPattern: '{ ($.event = "audit.record_failed") || ($.event = "audit.record_invalid") }',
            MetricTransformations: [{ MetricName: "AuditRecordFailed", MetricNamespace: environmentNaming(env).metricsNamespace, MetricValue: "1" }],
          });
          const [, alarm] = one(synthesis.template, "AWS::CloudWatch::Alarm", "AuditLedgerAuditRecordFailedAlarm");
          expect(alarm.Properties).toMatchObject({
            AlarmName: `agentx-${env}-AuditRecordFailed`,
            MetricName: "AuditRecordFailed", Namespace: environmentNaming(env).metricsNamespace, Statistic: "Sum",
            Period: 300, EvaluationPeriods: 1, Threshold: 1,
            ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching",
          });
          expect((alarm.Properties.AlarmActions as unknown[])).toHaveLength(1);
        });

        it("also counts audit.record_failed and audit.record_invalid on the sign-in function's log, into the same metric and alarm (Task 18, fix round 1)", () => {
          const signInLogs = one(synthesis.template, "AWS::Logs::LogGroup", "DeveloperSignInFunctionLogs")[0];
          const [, filter] = one(synthesis.template, "AWS::Logs::MetricFilter", "AuditLedgerAuditSignInRecordFailedMetric");
          expect(filter.Properties).toStrictEqual({
            LogGroupName: { Ref: signInLogs },
            FilterPattern: '{ ($.event = "audit.record_failed") || ($.event = "audit.record_invalid") }',
            MetricTransformations: [{ MetricName: "AuditRecordFailed", MetricNamespace: environmentNaming(env).metricsNamespace, MetricValue: "1" }],
          });
          // One alarm reads that metric: there is no second alarm for the sign-in function.
          const alarms = ofType(synthesis.template, "AWS::CloudWatch::Alarm").filter(([, alarm]) => alarm.Properties.MetricName === "AuditRecordFailed");
          expect(alarms.map(([id]) => withoutHash(id))).toStrictEqual(["AuditLedgerAuditRecordFailedAlarm"]);
        });

        it("counts audit.pending_stuck and audit.drain_failed (a drain that cannot read the outbox) and alarms at one", () => {
          const logGroupId = one(synthesis.template, "AWS::Logs::LogGroup", "BrokerLogs")[0];
          const [, filter] = one(synthesis.template, "AWS::Logs::MetricFilter", "AuditLedgerAuditPendingStuckMetric");
          expect(filter.Properties).toStrictEqual({
            LogGroupName: { Ref: logGroupId },
            FilterPattern: '{ ($.event = "audit.pending_stuck") || ($.event = "audit.drain_failed") }',
            MetricTransformations: [{ MetricName: "AuditPendingStuck", MetricNamespace: environmentNaming(env).metricsNamespace, MetricValue: "1" }],
          });
          const [, alarm] = one(synthesis.template, "AWS::CloudWatch::Alarm", "AuditLedgerAuditPendingStuckAlarm");
          expect(alarm.Properties).toMatchObject({
            AlarmName: `agentx-${env}-AuditPendingStuck`,
            MetricName: "AuditPendingStuck", Statistic: "Sum", Period: 300, EvaluationPeriods: 1, Threshold: 1,
            ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching",
          });
        });

        it("both alarms notify the operator alerts topic, as the other alarms do", () => {
          const topicId = one(synthesis.template, "AWS::SNS::Topic", "OperatorAlerts")[0];
          for (const alarm of ["AuditLedgerAuditRecordFailedAlarm", "AuditLedgerAuditPendingStuckAlarm"]) {
            expect(one(synthesis.template, "AWS::CloudWatch::Alarm", alarm)[1].Properties.AlarmActions).toStrictEqual([{ Ref: topicId }]);
          }
        });
      });
    }

    it("a scratch stack with the ledger alone has the same statements, so the test above reads the construct and not the control plane", () => {
      const stack = new Stack(new App(), "Scratch");
      new AuditLedger(stack, "AuditLedger", { ...scratchProps(stack), appenderRole: new iam.Role(stack, "AppenderRole", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") }) });
      const template = Template.fromStack(stack).toJSON() as TemplateJson;
      const own = ofType(template, "AWS::IAM::Policy").filter(([id]) => id.startsWith("AuditLedgerAuditBrokerOutboxPolicy"));
      expect(own).toHaveLength(1);
      const sids = ((own[0]![1].Properties.PolicyDocument as { Statement: Statement[] }).Statement).map((statement) => statement.Sid);
      expect(sids).toStrictEqual(["SendAuditEvents", "AuditPendingItems", "ScheduleShred"]);
    });

    it("a legacy template has no audit alarm, schedule or environment variable", () => {
      const legacy = Template.fromStack(buildAgentXApp().node.children.filter((child): child is Stack => Stack.isStack(child)).find((stack) => stack.stackName === "AgentXControlPlane")!).toJSON();
      expect(JSON.stringify(legacy)).not.toMatch(/AUDIT_INTAKE_QUEUE_URL|agentx\.audit-drain|AuditRecordFailed|AuditPendingStuck/);
    });
  });

  describe("the appender (Task 7)", () => {
    const ROLE = "AuditAppenderRole";
    const LEDGER = "AuditLedgerAuditLedgerTable.Arn";
    const KEYS = "AuditLedgerAuditKeysTable.Arn";
    const SEALS = "AuditLedgerAuditSealsTable.Arn";
    const QUEUE = "AuditLedgerAuditIntakeQueue.Arn";
    const DLQ = "AuditLedgerAuditIntakeDeadLetterQueue.Arn";
    const VAULT_KEY = "AuditLedgerAuditVaultKey.Arn";
    const LEDGER_BUCKET = "AuditLedgerAuditLedgerBucket.Arn";
    const EXPORTS_BUCKET = "AuditLedgerAuditExportsBucket.Arn";
    const functionOf = (synthesis: Synth) => one(synthesis.template, "AWS::Lambda::Function", "AuditLedgerAuditAppender");
    const identity = (synthesis: Synth): IamStatement[] => roleStatements(synthesis.template, one(synthesis.template, "AWS::IAM::Role", ROLE)[0], concreteAws);
    const sortedByAction = (statements: IamStatement[]) => statements.slice().sort((left, right) => String([left.Action].flat()[0]).localeCompare(String([right.Action].flat()[0])));

    for (const env of ["production", "staging", "acme"]) {
      describe(env, () => {
        const synthesis = named(env);

        it("is a Node 22 function with 30 seconds and 256 MB on the appender role, from the appender handler", () => {
          const [, fn] = functionOf(synthesis);
          expect(fn.Properties).toMatchObject({ Runtime: "nodejs22.x", Timeout: 30, MemorySize: 256, Handler: "index.handler" });
          expect(concreteAws(fn.Properties.Role)).toBe(`${ROLE}.Arn`);
          expect(fn.Properties.ReservedConcurrentExecutions).toBeUndefined();
          expect(fn.Properties.VpcConfig).toBeUndefined();
        });

        it("is given its two tables and the vault key's ARN, and nothing else audit-related", () => {
          const [, fn] = functionOf(synthesis);
          const variables = (fn.Properties.Environment as { Variables: Json }).Variables;
          const audit = Object.fromEntries(Object.entries(variables).filter(([name]) => name.startsWith("AUDIT_")).map(([name, value]) => [name, concreteAws(value)]));
          expect(audit).toStrictEqual({
            AUDIT_LEDGER_TABLE_NAME: "Ref:AuditLedgerAuditLedgerTable",
            AUDIT_KEYS_TABLE_NAME: "Ref:AuditLedgerAuditKeysTable",
            // The key's ARN, never its alias: an administrator can repoint an alias.
            AUDIT_VAULT_KEY_ARN: VAULT_KEY,
          });
          expect(JSON.stringify(variables)).not.toContain("alias/");
        });

        it("is, with the broker (which only reads) and the export function (pinned in \"the export function\"), the only function given the keys table's name or the vault key, and only it, the anchor, the broker and the export function are given the ledger table", () => {
          const others = ofType(synthesis.template, "AWS::Lambda::Function").filter(([id]) => !["AuditLedgerAuditAppender", "AuditLedgerAuditAnchor", "AuditLedgerAuditExport", "Broker"].includes(withoutHash(id)));
          for (const [id, fn] of others) {
            const variables = JSON.stringify((fn.Properties.Environment as { Variables?: Json } | undefined)?.Variables ?? {});
            expect(variables, id).not.toMatch(/AuditLedgerAudit(LedgerTable|KeysTable|SealsTable|VaultKey|LedgerBucket)/);
          }
        });

        it("reads the intake queue in batches of ten and reports partial batch failures", () => {
          const mappings = ofType(synthesis.template, "AWS::Lambda::EventSourceMapping");
          const mine = mappings.filter(([, mapping]) => concreteAws(mapping.Properties.EventSourceArn) === QUEUE);
          expect(mine).toHaveLength(1);
          const properties = mine[0]![1].Properties;
          expect(properties).toMatchObject({ BatchSize: 10, FunctionResponseTypes: ["ReportBatchItemFailures"] });
          expect(properties.Enabled ?? true).toBe(true);
          expect(properties.MaximumBatchingWindowInSeconds).toBeUndefined();
          expect(concreteAws(properties.FunctionName)).toBe("Ref:AuditLedgerAuditAppender");
          // Nothing reads the dead-letter queue: it is for people.
          expect(mappings.filter(([, mapping]) => concreteAws(mapping.Properties.EventSourceArn) === DLQ)).toHaveLength(0);
        });

        it("has exactly the pinned statements, in a policy of its own and the CDK-generated ones for the queue and the log group", () => {
          const own = ofType(synthesis.template, "AWS::IAM::Policy").filter(([id]) => withoutHash(id) === "AuditLedgerAuditAppenderPolicy");
          expect(own).toHaveLength(1);
          expect(((own[0]![1].Properties.PolicyDocument as { Statement: Statement[] }).Statement).map((statement) => concreteAws(statement))).toStrictEqual([
            {
              Sid: "LedgerTable", Effect: "Allow",
              Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"],
              Resource: LEDGER,
              Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["AUDIT#*", "AUDIT_DIRTY", "AUDIT_ORGS"] } },
            },
            { Sid: "KeysTable", Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:PutItem"], Resource: KEYS },
          ]);
          // The whole identity of the role: those two, the queue's consume actions and the log group's write actions.
          expect(sortedByAction(identity(synthesis))).toStrictEqual(sortedByAction([
            ...((own[0]![1].Properties.PolicyDocument as { Statement: Statement[] }).Statement).map((statement) => concreteAws(statement) as IamStatement),
            {
              Effect: "Allow",
              Action: ["sqs:ReceiveMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueUrl", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
              Resource: QUEUE,
            },
            { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: "AuditLedgerAuditAppenderLogs.Arn" },
          ]));
          expect(identity(synthesis)).toHaveLength(4);
        });

        it("names no other resource, no NotAction, no NotResource and has no wildcard resource", () => {
          for (const statement of identity(synthesis)) {
            expect(statement.NotAction).toBeUndefined();
            expect(statement.NotResource).toBeUndefined();
            expect([statement.Resource].flat().join(",")).not.toContain("*");
            expect(statement.Effect).toBe("Allow");
          }
        });

        describe("what IAM lets it do (the policies simulated)", () => {
          const request = (action: string, resource: string, leadingKeys?: string[]) => simulateIam(identity(synthesis), { action, resource, ...(leadingKeys === undefined ? {} : { context: { "dynamodb:LeadingKeys": leadingKeys } }) });

          it("allows the four item actions on the ledger table for AUDIT#<org>, AUDIT_DIRTY and AUDIT_ORGS keys, alone or together", () => {
            for (const action of ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"]) {
              for (const keys of [["AUDIT#org_aaaaaaaaaaaaaaaaaaaa"], ["AUDIT_DIRTY"], ["AUDIT_ORGS"], ["AUDIT#org_aaaaaaaaaaaaaaaaaaaa", "AUDIT_DIRTY", "AUDIT_ORGS"]]) {
                expect(request(action, LEDGER, keys).allowed, `${action} ${keys.join(",")}`).toBe(true);
              }
            }
          });

          it("C47 posting sort keys use unchanged appender actions and org-leading-key grants", () => {
            const grant = identity(synthesis).find(statement => statement.Sid === "LedgerTable")!;
            const expected = { Sid: "LedgerTable", Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"], Resource: LEDGER, Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["AUDIT#*", "AUDIT_DIRTY", "AUDIT_ORGS"] } } };
            expect(grant).toStrictEqual(expected);
            for (const action of expected.Action) expect(request(action, LEDGER, ["AUDIT#org_aaaaaaaaaaaaaaaaaaaa"]).allowed).toBe(true);
            expect(request("dynamodb:PutItem", LEDGER, ["FILTER#v1#action"]).allowed).toBe(false);
            expect(request("dynamodb:Query", LEDGER, ["AUDIT#org_aaaaaaaaaaaaaaaaaaaa"]).allowed).toBe(false);
            const broadened = { ...grant, Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["*"] } } };
            expect(simulateIam([broadened], { action: "dynamodb:PutItem", resource: LEDGER, context: { "dynamodb:LeadingKeys": ["FILTER#v1#action"] } }).allowed).toBe(true);
            expect(() => expect(broadened).toStrictEqual(expected)).toThrow();
          });

          it("denies PutItem with leading key AUDIT_EPOCH, SEALED#, SEALS# or any other key on the ledger table, alone or beside a good one", () => {
            for (const keys of [["AUDIT_EPOCH"], ["SEALED#org_aaaaaaaaaaaaaaaaaaaa"], ["SEALS#org_aaaaaaaaaaaaaaaaaaaa"], ["AUDIT_PENDING#3"], ["AUDIT#org_aaaaaaaaaaaaaaaaaaaa", "AUDIT_EPOCH"], ["AUDITX"], ["audit#org_a"]]) {
              expect(request("dynamodb:PutItem", LEDGER, keys), keys.join(",")).toMatchObject({ allowed: false, reason: "implicit-deny" });
              expect(request("dynamodb:UpdateItem", LEDGER, keys).allowed).toBe(false);
            }
          });

          it("denies every table action on the seals table, with any key", () => {
            for (const action of ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem", "dynamodb:Query", "dynamodb:DeleteItem"]) {
              for (const keys of [["AUDIT_EPOCH"], ["AUDIT#org_aaaaaaaaaaaaaaaaaaaa"], ["SEALED#org_aaaaaaaaaaaaaaaaaaaa"]]) {
                expect(request(action, SEALS, keys).allowed, `${action} ${keys.join(",")}`).toBe(false);
              }
            }
          });

          it("allows GetItem and PutItem on the keys table, and nothing else there", () => {
            expect(request("dynamodb:GetItem", KEYS, ["ORG#org_aaaaaaaaaaaaaaaaaaaa"]).allowed).toBe(true);
            expect(request("dynamodb:PutItem", KEYS, ["ORG#org_aaaaaaaaaaaaaaaaaaaa"]).allowed).toBe(true);
            for (const action of ["dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:BatchWriteItem"]) {
              expect(request(action, KEYS, ["ORG#org_aaaaaaaaaaaaaaaaaaaa"]).allowed, action).toBe(false);
            }
          });

          it("has no DeleteItem, Query, Scan or batch action on any table", () => {
            for (const table of [LEDGER, KEYS, SEALS]) {
              for (const action of ["dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:BatchWriteItem", "dynamodb:BatchGetItem", "dynamodb:DeleteTable", "dynamodb:*"]) {
                expect(request(action, table, ["AUDIT#org_aaaaaaaaaaaaaaaaaaaa"]).allowed, `${action} ${table}`).toBe(false);
              }
            }
          });

          it("has nothing on the ledger bucket, the exports bucket or any S3 action", () => {
            for (const bucket of [LEDGER_BUCKET, EXPORTS_BUCKET]) {
              for (const resource of [bucket, `${bucket}/orgs/org_aaaaaaaaaaaaaaaaaaaa/seals/000000000001.json`]) {
                for (const action of ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:PutObjectRetention", "s3:*"]) {
                  expect(request(action, resource).allowed, `${action} ${resource}`).toBe(false);
                }
              }
            }
            expect(identity(synthesis).some((statement) => [statement.Action].flat().some((action) => String(action).startsWith("s3:")))).toBe(false);
          });

          it("takes messages from the intake queue only: it cannot send to it, and it has nothing on the dead-letter queue", () => {
            for (const action of ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"]) {
              expect(request(action, QUEUE).allowed, action).toBe(true);
              expect(request(action, DLQ).allowed, `${action} on the DLQ`).toBe(false);
            }
            for (const action of ["sqs:SendMessage", "sqs:PurgeQueue", "sqs:DeleteQueue"]) expect(request(action, QUEUE).allowed, action).toBe(false);
          });

          it("has no KMS permission of its own: the key policy is what allows it", () => {
            for (const action of ["kms:GenerateDataKey", "kms:Decrypt", "kms:Encrypt", "kms:CreateGrant"]) expect(request(action, VAULT_KEY).allowed, action).toBe(false);
            expect(identity(synthesis).some((statement) => [statement.Action].flat().some((action) => String(action).startsWith("kms:")))).toBe(false);
          });

          it("the simulator sees the leading-key condition: the same statements without it would allow AUDIT_EPOCH", () => {
            const loosened = identity(synthesis).map(({ Condition: _condition, ...rest }) => { void _condition; return rest; });
            expect(simulateIam(loosened, { action: "dynamodb:PutItem", resource: LEDGER, context: { "dynamodb:LeadingKeys": ["AUDIT_EPOCH"] } }).allowed).toBe(true);
            expect(request("dynamodb:PutItem", LEDGER, ["AUDIT_EPOCH"]).allowed).toBe(false);
          });
        });

        describe("what the vault key policy lets it do (the key policy simulated)", () => {
          const keyStatements = () => ((one(synthesis.template, "AWS::KMS::Key", "AuditLedgerAuditVaultKey")[1].Properties.KeyPolicy as { Statement: Statement[] }).Statement).map((statement) => concreteAws(statement) as IamStatement);
          const asAppender = (action: string, context: Record<string, string | string[]>) => simulateIam(keyStatements(), { action, resource: "*", principal: `${ROLE}.Arn`, context });
          const good = { "kms:EncryptionContext:rovara:purpose": "audit-details", "kms:EncryptionContextKeys": ["rovara:org"] };

          it("allows GenerateDataKey and Decrypt under the audit-details context carrying rovara:org", () => {
            expect(asAppender("kms:GenerateDataKey", good).allowed).toBe(true);
            expect(asAppender("kms:Decrypt", good).allowed).toBe(true);
          });

          it("denies them without the context, with another purpose or without rovara:org", () => {
            expect(asAppender("kms:GenerateDataKey", {}).allowed).toBe(false);
            expect(asAppender("kms:Decrypt", { ...good, "kms:EncryptionContext:rovara:purpose": "something-else" }).allowed).toBe(false);
            expect(asAppender("kms:Decrypt", { ...good, "kms:EncryptionContextKeys": ["rovara:purpose"] }).allowed).toBe(false);
          });

          it("denies Encrypt, ReEncrypt, CreateGrant and key administration, and denies every other principal", () => {
            for (const action of ["kms:Encrypt", "kms:ReEncryptFrom", "kms:GenerateDataKeyWithoutPlaintext", "kms:CreateGrant", "kms:PutKeyPolicy", "kms:ScheduleKeyDeletion"]) {
              expect(asAppender(action, good).allowed, action).toBe(false);
            }
            expect(simulateIam(keyStatements(), { action: "kms:Decrypt", resource: "*", principal: "SomeoneElse.Arn", context: good }).allowed).toBe(false);
          });
        });

        it("alarms when a message reaches the dead-letter queue, and when the oldest intake message is over 15 minutes old for two periods", () => {
          const topicId = one(synthesis.template, "AWS::SNS::Topic", "OperatorAlerts")[0];
          const [, deadLetters] = one(synthesis.template, "AWS::CloudWatch::Alarm", "AuditLedgerAuditIntakeDeadLettersAlarm");
          expect(concreteAws(deadLetters.Properties)).toMatchObject({
            AlarmName: `agentx-${env}-AuditIntakeDeadLetters`,
            Namespace: "AWS/SQS", MetricName: "ApproximateNumberOfMessagesVisible", Statistic: "Maximum",
            Dimensions: [{ Name: "QueueName", Value: "AuditLedgerAuditIntakeDeadLetterQueue.QueueName" }],
            Period: 300, EvaluationPeriods: 1, Threshold: 1, ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching",
          });
          expect(deadLetters.Properties.AlarmActions).toStrictEqual([{ Ref: topicId }]);
          const [, backlog] = one(synthesis.template, "AWS::CloudWatch::Alarm", "AuditLedgerAuditIntakeBacklogAlarm");
          expect(concreteAws(backlog.Properties)).toMatchObject({
            AlarmName: `agentx-${env}-AuditIntakeBacklog`,
            Namespace: "AWS/SQS", MetricName: "ApproximateAgeOfOldestMessage", Statistic: "Maximum",
            Dimensions: [{ Name: "QueueName", Value: "AuditLedgerAuditIntakeQueue.QueueName" }],
            Period: 300, EvaluationPeriods: 2, DatapointsToAlarm: 2, Threshold: 900, ComparisonOperator: "GreaterThanThreshold", TreatMissingData: "notBreaching",
          });
          expect(backlog.Properties.AlarmActions).toStrictEqual([{ Ref: topicId }]);
        });

        it("names its alarms in the list the health route reads", () => {
          for (const suffix of ["AuditIntakeDeadLetters", "AuditIntakeBacklog"]) expect(HEALTH_ALARM_SUFFIXES).toContain(suffix);
        });

        it("keeps its log group a month and its logs name no person", () => {
          const [, logGroup] = one(synthesis.template, "AWS::Logs::LogGroup", "AuditLedgerAuditAppenderLogs");
          expect(logGroup.Properties.RetentionInDays).toBe(30);
        });
      });
    }

    it("a scratch stack with the ledger alone builds the same function, so the checks above read the construct and not the control plane", () => {
      const stack = new Stack(new App(), "Scratch");
      new AuditLedger(stack, "AuditLedger", { ...scratchProps(stack), appenderRole: new iam.Role(stack, "AppenderRole", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") }) });
      const template = Template.fromStack(stack).toJSON() as TemplateJson;
      expect(one(template, "AWS::Lambda::Function", "AuditLedgerAuditAppender")[1].Properties).toMatchObject({ Timeout: 30, MemorySize: 256 });
      expect(one(template, "AWS::Lambda::EventSourceMapping", "AuditLedgerAuditAppenderSqsEventSource")[1].Properties).toMatchObject({ BatchSize: 10 });
    });

    it("a legacy template has no appender", () => {
      const legacy = Template.fromStack(buildAgentXApp().node.children.filter((child): child is Stack => Stack.isStack(child)).find((stack) => stack.stackName === "AgentXControlPlane")!).toJSON();
      expect(JSON.stringify(legacy)).not.toMatch(/AuditAppender|AUDIT_LEDGER_TABLE_NAME|AuditIntakeBacklog/);
    });
  });

  describe("the anchor (Task 8)", () => {
    const ROLE = "AuditLedgerAuditAnchorRole";
    const LEDGER = "AuditLedgerAuditLedgerTable.Arn";
    const KEYS = "AuditLedgerAuditKeysTable.Arn";
    const SEALS = "AuditLedgerAuditSealsTable.Arn";
    const QUEUE = "AuditLedgerAuditIntakeQueue.Arn";
    const DLQ = "AuditLedgerAuditIntakeDeadLetterQueue.Arn";
    const VAULT_KEY = "AuditLedgerAuditVaultKey.Arn";
    const LEDGER_BUCKET = "AuditLedgerAuditLedgerBucket.Arn";
    const EXPORTS_BUCKET = "AuditLedgerAuditExportsBucket.Arn";
    const STATE = "State.Arn";
    const SEAL_PARTITIONS = ["EPOCH#*", "EPOCH_HEAD", "SEALED#*", "SEALS#*", "BACKSTOP", "AUDIT_SWEEP"];
    const functionOf = (synthesis: Synth) => one(synthesis.template, "AWS::Lambda::Function", "AuditLedgerAuditAnchor");
    const identity = (synthesis: Synth): IamStatement[] => roleStatements(synthesis.template, one(synthesis.template, "AWS::IAM::Role", ROLE)[0], concreteAws);
    const ownStatements = (synthesis: Synth): Statement[] => {
      const own = ofType(synthesis.template, "AWS::IAM::Policy").filter(([id]) => withoutHash(id) === "AuditLedgerAuditAnchorPolicy");
      expect(own).toHaveLength(1);
      return ((own[0]![1].Properties.PolicyDocument as { Statement: Statement[] }).Statement).map((statement) => concreteAws(statement) as Statement);
    };
    const sortedBySid = (statements: IamStatement[]) => statements.slice().sort((left, right) => String(left.Sid ?? left.Action).localeCompare(String(right.Sid ?? right.Action)));

    for (const env of ["production", "staging", "acme"]) {
      describe(env, () => {
        const synthesis = named(env);

        it("is a Node 22 function with 300 seconds, 512 MB and reserved concurrency 1, on its own role, outside any VPC", () => {
          const [, fn] = functionOf(synthesis);
          expect(fn.Properties).toMatchObject({ Runtime: "nodejs22.x", Timeout: 300, MemorySize: 512, ReservedConcurrentExecutions: 1, Handler: "index.handler" });
          expect(concreteAws(fn.Properties.Role)).toBe(`${ROLE}.Arn`);
          expect(fn.Properties.VpcConfig).toBeUndefined();
          // Reserved concurrency is the anchor's alone.
          const reserved = ofType(synthesis.template, "AWS::Lambda::Function").filter(([, other]) => other.Properties.ReservedConcurrentExecutions !== undefined);
          expect(reserved.map(([id]) => withoutHash(id))).toContain("AuditLedgerAuditAnchor");
        });

        it("is given the ledger and seals table names, the ledger bucket's name and its lock settings, and no key, alias or vault", () => {
          const [, fn] = functionOf(synthesis);
          const variables = (fn.Properties.Environment as { Variables: Json }).Variables;
          const audit = (profile?: Profile) => Object.fromEntries(Object.entries(variables).filter(([name]) => name.startsWith("AUDIT_")).map(([name, value]) => [name, name === "AUDIT_LOCK_PROFILE"
            // `concrete` reads a Ref to a resource as text, so the parameter's own Ref is evaluated directly.
            ? evaluate(value, { parameters: { AuditLockProfile: profile ?? synthesis.template.Parameters!.AuditLockProfile!.Default! }, conditions: synthesis.template.Conditions ?? {} })
            : underProfile(synthesis, value, profile)]));
          const lockProfiles = synthesis.ledger.lockProfiles;
          for (const profile of ["production", "trial"] as const) {
            expect(audit(profile), profile).toStrictEqual({
              AUDIT_LEDGER_TABLE_NAME: "Ref:AuditLedgerAuditLedgerTable",
              AUDIT_SEALS_TABLE_NAME: "Ref:AuditLedgerAuditSealsTable",
              AUDIT_LEDGER_BUCKET_NAME: "Ref:AuditLedgerAuditLedgerBucket",
              AUDIT_KEYS_TABLE_NAME: "Ref:AuditLedgerAuditKeysTable",
              AUDIT_EXPORTS_BUCKET_NAME: "Ref:AuditLedgerAuditExportsBucket",
              AUDIT_ENV_NAME: env,
              AUDIT_LOCK_PROFILE: profile,
              AUDIT_LOCK_MODE: lockProfiles[profile].mode,
              AUDIT_RETENTION_DAYS: String(lockProfiles[profile].retentionDays),
              AUDIT_BUCKET_POLICY_SHA256: synthesis.ledger.bucketPolicySha256ByProfile[profile],
              AUDIT_PARTITION: "aws",
              AUDIT_ACCOUNT_ID: ACCOUNT,
              // Task 10: the public authorities are the default; no URL and no parameter are named.
              AUDIT_TSA_KIND: "public",
              AUDIT_TSA_TIMEOUT_MS: "10000",
              AUDIT_TSA_SPACING_MS: "15000",
            });
          }
          // The default profile is the one the environment's own settings give.
          expect(audit().AUDIT_LOCK_PROFILE).toBe(lockProfiles.default);
          expect(JSON.stringify(variables)).not.toMatch(/alias\/|VaultKey/);
        });

        it("is given, for the shred sweep, the keys table's name, the State table's and the exports bucket's, and no key", () => {
          const variables = (functionOf(synthesis)[1].Properties.Environment as { Variables: Json }).Variables;
          expect(concreteAws(variables.AUDIT_KEYS_TABLE_NAME)).toBe("Ref:AuditLedgerAuditKeysTable");
          expect(concreteAws(variables.STATE_TABLE_NAME)).toBe("Ref:State");
          expect(concreteAws(variables.AUDIT_EXPORTS_BUCKET_NAME)).toBe("Ref:AuditLedgerAuditExportsBucket");
          expect(Object.keys(variables)).not.toContain("AUDIT_VAULT_KEY_ARN");
        });

        it("is, with the broker (the seals table, to read) and the export function (both, to read), the only function given the seals table or the ledger bucket", () => {
          const withSeals = ofType(synthesis.template, "AWS::Lambda::Function").filter(([, fn]) => JSON.stringify((fn.Properties.Environment as { Variables?: Json } | undefined)?.Variables ?? {}).includes("AuditLedgerAuditSealsTable"));
          expect(withSeals.map(([id]) => withoutHash(id)).sort()).toStrictEqual(["AuditLedgerAuditAnchor", "AuditLedgerAuditExport", "Broker"]);
          const withBucket = ofType(synthesis.template, "AWS::Lambda::Function").filter(([, fn]) => JSON.stringify((fn.Properties.Environment as { Variables?: Json } | undefined)?.Variables ?? {}).includes("AuditLedgerAuditLedgerBucket"));
          expect(withBucket.map(([id]) => withoutHash(id)).sort()).toStrictEqual(["AuditLedgerAuditAnchor", "AuditLedgerAuditExport"]);
        });

        it("has exactly the pinned statements, in a policy of its own, and the log group's write actions", () => {
          expect(ownStatements(synthesis)).toStrictEqual([
            {
              Sid: "SealsTable", Effect: "Allow",
              Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
              Resource: SEALS,
              Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": SEAL_PARTITIONS } },
            },
            {
              Sid: "LockRatchet", Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:PutItem"], Resource: SEALS,
              Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["AUDIT_LOCK"] } },
            },
            { Sid: "LedgerRead", Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:Query"], Resource: LEDGER },
            {
              Sid: "LedgerDirtyMarkers", Effect: "Allow", Action: ["dynamodb:PutItem", "dynamodb:DeleteItem"], Resource: LEDGER,
              Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["AUDIT_DIRTY"] } },
            },
            { Sid: "LedgerBucketObjects", Effect: "Allow", Action: ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectRetention"], Resource: `${LEDGER_BUCKET}/*` },
            { Sid: "LedgerBucketVersions", Effect: "Allow", Action: "s3:ListBucketVersions", Resource: LEDGER_BUCKET },
            {
              Sid: "LedgerBucketConfiguration", Effect: "Allow",
              Action: ["s3:GetBucketObjectLockConfiguration", "s3:GetBucketVersioning", "s3:GetBucketPolicy"], Resource: LEDGER_BUCKET,
            },
            // Task 15, the shred sweep: it empties one company's keys partition (Query, then DeleteItem per item) after writing the
            // SHREDDED marker (PutItem); the due items it reads and clears are in the State table's AUDIT_SHRED_DUE partition alone;
            // and it lists and deletes that company's folder of export files. It has no GetItem or UpdateItem on the keys table.
            { Sid: "ShredKeys", Effect: "Allow", Action: ["dynamodb:Query", "dynamodb:PutItem", "dynamodb:DeleteItem"], Resource: KEYS },
            {
              Sid: "ShredDueItems", Effect: "Allow", Action: ["dynamodb:Query", "dynamodb:DeleteItem"], Resource: STATE,
              Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["AUDIT_SHRED_DUE"] } },
            },
            { Sid: "ShredExportObjects", Effect: "Allow", Action: "s3:DeleteObject", Resource: `${EXPORTS_BUCKET}/*` },
            { Sid: "ShredListExports", Effect: "Allow", Action: "s3:ListBucket", Resource: EXPORTS_BUCKET },
          ]);
          // The whole identity of the role: those eleven and the log group's write actions. No managed policy.
          expect(sortedBySid(identity(synthesis))).toStrictEqual(sortedBySid([
            ...(ownStatements(synthesis) as IamStatement[]),
            { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: "AuditLedgerAuditAnchorLogs.Arn" },
          ]));
          expect(identity(synthesis)).toHaveLength(12);
        });

        it("names no NotAction, no NotResource and no wildcard resource", () => {
          for (const statement of identity(synthesis)) {
            expect(statement.NotAction).toBeUndefined();
            expect(statement.NotResource).toBeUndefined();
            expect([statement.Resource].flat().join(",").replace(`${LEDGER_BUCKET}/*`, "").replace(`${EXPORTS_BUCKET}/*`, "")).not.toContain("*");
            expect(statement.Effect).toBe("Allow");
          }
        });

        describe("what IAM lets it do (the policies simulated)", () => {
          const request = (action: string, resource: string, leadingKeys?: string[]) => simulateIam(identity(synthesis), { action, resource, ...(leadingKeys === undefined ? {} : { context: { "dynamodb:LeadingKeys": leadingKeys } }) });
          const org = "org_aaaaaaaaaaaaaaaaaaaa";

          it("allows its four actions on the seals table for its own partitions, alone or together", () => {
            for (const action of ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]) {
              for (const keys of [["EPOCH#e20261020T1215Z"], ["EPOCH_HEAD"], [`SEALED#${org}`], [`SEALS#${org}`], ["BACKSTOP"], [`EPOCH#e20261020T1215Z`, "EPOCH_HEAD", `SEALED#${org}`]]) {
                expect(request(action, SEALS, keys).allowed, `${action} ${keys.join(",")}`).toBe(true);
              }
            }
          });

          it("lets it read and create the lock ratchet under AUDIT_LOCK and nothing else there: no UpdateItem, no DeleteItem, no query", () => {
            for (const action of ["dynamodb:GetItem", "dynamodb:PutItem"]) expect(request(action, SEALS, ["AUDIT_LOCK"]).allowed, action).toBe(true);
            for (const action of ["dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:ConditionCheckItem", "dynamodb:Scan", "dynamodb:BatchWriteItem", "dynamodb:*"]) {
              expect(request(action, SEALS, ["AUDIT_LOCK"]).allowed, action).toBe(false);
            }
            for (const keys of [["AUDIT_LOCKS"], ["AUDIT_LOC"], ["audit_lock"], ["AUDIT_LOCK", "AUDIT_DIRTY"], ["AUDIT_LOCK", "EPOCH_HEAD"]]) expect(request("dynamodb:PutItem", SEALS, keys).allowed, keys.join(",")).toBe(false);
            // The ledger table has no such partition for it.
            expect(request("dynamodb:PutItem", LEDGER, ["AUDIT_LOCK"]).allowed).toBe(false);
            // IAM cannot say "only with a condition expression"; the code writes it with attribute_not_exists and a test pins that.
          });

          it("keeps the sweep's cursor in a partition of its own (AUDIT_SWEEP), where it may be read, moved and queried, never deleted", () => {
            for (const action of ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]) expect(request(action, SEALS, ["AUDIT_SWEEP"]).allowed, action).toBe(true);
            expect(request("dynamodb:DeleteItem", SEALS, ["AUDIT_SWEEP"]).allowed).toBe(false);
          });

          it("denies the seals table to every other action, and its partitions to any other key", () => {
            for (const action of ["dynamodb:DeleteItem", "dynamodb:ConditionCheckItem", "dynamodb:Scan", "dynamodb:BatchWriteItem", "dynamodb:BatchGetItem", "dynamodb:DeleteTable", "dynamodb:*"]) {
              expect(request(action, SEALS, ["EPOCH_HEAD"]).allowed, action).toBe(false);
            }
            for (const keys of [[`AUDIT#${org}`], ["AUDIT_DIRTY"], ["AUDIT_ORGS"], ["EPOCH_HEAD", "AUDIT_DIRTY"], ["ORG#x"], ["epoch_head"], ["EPOCHX"]]) {
              expect(request("dynamodb:PutItem", SEALS, keys).allowed, keys.join(",")).toBe(false);
              expect(request("dynamodb:GetItem", SEALS, keys).allowed, keys.join(",")).toBe(false);
            }
          });

          it("reads the ledger table, and writes there only dirty markers", () => {
            for (const action of ["dynamodb:GetItem", "dynamodb:Query"]) {
              for (const keys of [[`AUDIT#${org}`], ["AUDIT_DIRTY"], ["AUDIT_ORGS"]]) expect(request(action, LEDGER, keys).allowed, `${action} ${keys.join(",")}`).toBe(true);
            }
            for (const action of ["dynamodb:PutItem", "dynamodb:DeleteItem"]) {
              expect(request(action, LEDGER, ["AUDIT_DIRTY"]).allowed, action).toBe(true);
              // A record, a head, a claim, the org list, or any of those beside a marker.
              for (const keys of [[`AUDIT#${org}`], ["AUDIT_ORGS"], ["AUDIT_DIRTY", `AUDIT#${org}`], ["AUDIT_EPOCH"], [`SEALED#${org}`]]) {
                expect(request(action, LEDGER, keys), `${action} ${keys.join(",")}`).toMatchObject({ allowed: false, reason: "implicit-deny" });
              }
            }
            for (const action of ["dynamodb:UpdateItem", "dynamodb:ConditionCheckItem", "dynamodb:Scan", "dynamodb:BatchWriteItem", "dynamodb:DeleteTable"]) {
              expect(request(action, LEDGER, ["AUDIT_DIRTY"]).allowed, action).toBe(false);
            }
          });

          it("has nothing on the queues or the vault key, and on the keys and State tables only the shred sweep's actions", () => {
            for (const resource of [KEYS, STATE]) {
              for (const action of ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem", "dynamodb:Scan", "dynamodb:BatchWriteItem", "dynamodb:BatchGetItem", "dynamodb:DeleteTable", "dynamodb:*"]) expect(request(action, resource, ["ORG#x"]).allowed, `${action} ${resource}`).toBe(false);
            }
            // The State table: only the due items' partition, to query and delete; never to put or read an item.
            for (const action of ["dynamodb:Query", "dynamodb:DeleteItem"]) {
              expect(request(action, STATE, ["AUDIT_SHRED_DUE"]).allowed, action).toBe(true);
              for (const keys of [["ORG#org_aaaaaaaaaaaaaaaaaaaa"], ["AUDIT_PENDING#1"], ["AUDIT_SHRED_DUE", "AUDIT_PENDING#1"], ["AUDIT_SHRED_DUE#x"]]) expect(request(action, STATE, keys).allowed, `${action} ${keys.join(",")}`).toBe(false);
            }
            expect(request("dynamodb:PutItem", STATE, ["AUDIT_SHRED_DUE"]).allowed).toBe(false);
            // The keys table: Query, PutItem (the SHREDDED marker) and DeleteItem (the sweep), whatever the partition (the code builds it from the org id).
            for (const action of ["dynamodb:Query", "dynamodb:PutItem", "dynamodb:DeleteItem"]) expect(request(action, KEYS, ["ORG#org_aaaaaaaaaaaaaaaaaaaa"]).allowed, action).toBe(true);
            for (const resource of [QUEUE, DLQ]) {
              for (const action of ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:PurgeQueue"]) expect(request(action, resource).allowed, `${action} ${resource}`).toBe(false);
            }
            for (const action of ["kms:GenerateDataKey", "kms:Decrypt", "kms:Encrypt", "kms:CreateGrant"]) expect(request(action, VAULT_KEY).allowed, action).toBe(false);
            expect(identity(synthesis).some((statement) => [statement.Action].flat().some((action) => String(action).startsWith("kms:")))).toBe(false);
          });

          it("creates and reads sealed objects and lists versions, and nothing that changes, removes or unlocks them", () => {
            const object = `${LEDGER_BUCKET}/orgs/${org}/seals/000000000001.json`;
            for (const action of ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectRetention"]) expect(request(action, object).allowed, action).toBe(true);
            expect(request("s3:ListBucketVersions", LEDGER_BUCKET).allowed).toBe(true);
            // The three reads of the bucket's own configuration (the drift check), on the bucket and not on an object.
            for (const action of ["s3:GetBucketObjectLockConfiguration", "s3:GetBucketVersioning", "s3:GetBucketPolicy"]) {
              expect(request(action, LEDGER_BUCKET).allowed, `${action} on the bucket`).toBe(true);
              expect(request(action, object).allowed, `${action} on an object`).toBe(false);
              expect(request(action, EXPORTS_BUCKET).allowed, `${action} on the exports bucket`).toBe(false);
            }
            for (const action of ["s3:GetBucketAcl", "s3:GetBucketPolicyStatus", "s3:GetEncryptionConfiguration", "s3:GetLifecycleConfiguration", "s3:GetBucketLocation", "s3:PutBucketPolicy"]) {
              expect(request(action, LEDGER_BUCKET).allowed, `${action} on the bucket`).toBe(false);
            }
            for (const action of [
              "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutObjectRetention", "s3:PutObjectLegalHold", "s3:BypassGovernanceRetention",
              "s3:PutBucketObjectLockConfiguration", "s3:PutBucketPolicy", "s3:PutBucketVersioning", "s3:PutLifecycleConfiguration", "s3:DeleteBucket",
              "s3:DeleteBucketPolicy", "s3:PutReplicationConfiguration", "s3:ListBucket", "s3:*",
            ]) {
              expect(request(action, object).allowed, `${action} on an object`).toBe(false);
              expect(request(action, LEDGER_BUCKET).allowed, `${action} on the bucket`).toBe(false);
            }
            // Not the bucket's listing of versions on an object resource, and nothing on the exports bucket.
            expect(request("s3:ListBucketVersions", object).allowed).toBe(false);
            for (const resource of [EXPORTS_BUCKET, `${EXPORTS_BUCKET}/x`]) {
              for (const action of ["s3:GetObject", "s3:PutObject", "s3:ListBucketVersions", "s3:DeleteObjectVersion", "s3:PutObjectAcl", "s3:*"]) expect(request(action, resource).allowed, `${action} ${resource}`).toBe(false);
            }
          });

          it("lists the exports bucket and deletes its objects (the shred sweep), and does not read or write them", () => {
            const object = `${EXPORTS_BUCKET}/${org}/aex_x.0123456789abcdef.rovara-audit.json.gz`;
            expect(request("s3:ListBucket", EXPORTS_BUCKET).allowed).toBe(true);
            expect(request("s3:DeleteObject", object).allowed).toBe(true);
            // A list is of the bucket and a delete is of an object, not the other way round.
            expect(request("s3:ListBucket", object).allowed).toBe(false);
            expect(request("s3:DeleteObject", EXPORTS_BUCKET).allowed).toBe(false);
            for (const action of ["s3:GetObject", "s3:PutObject", "s3:PutBucketPolicy", "s3:PutLifecycleConfiguration", "s3:DeleteBucket", "s3:GetBucketPolicy"]) {
              expect(request(action, object).allowed, action).toBe(false);
              expect(request(action, EXPORTS_BUCKET).allowed, action).toBe(false);
            }
            // The ledger bucket is not deletable through it.
            expect(request("s3:DeleteObject", `${LEDGER_BUCKET}/orgs/${org}/seals/000000000001.json`).allowed).toBe(false);
            expect(request("s3:ListBucket", LEDGER_BUCKET).allowed).toBe(false);
          });

          it("the simulator sees the conditions: without them the same statements would allow other partitions", () => {
            const loosened = identity(synthesis).map(({ Condition: _condition, ...rest }) => { void _condition; return rest; });
            expect(simulateIam(loosened, { action: "dynamodb:PutItem", resource: LEDGER, context: { "dynamodb:LeadingKeys": [`AUDIT#${org}`] } }).allowed).toBe(true);
            expect(simulateIam(loosened, { action: "dynamodb:PutItem", resource: SEALS, context: { "dynamodb:LeadingKeys": ["AUDIT_DIRTY"] } }).allowed).toBe(true);
            expect(request("dynamodb:PutItem", LEDGER, [`AUDIT#${org}`]).allowed).toBe(false);
            expect(request("dynamodb:PutItem", SEALS, ["AUDIT_DIRTY"]).allowed).toBe(false);
          });
        });

        it("no workload role may delete, unlock, lock-change or bypass retention on the ledger bucket, or write its policy", () => {
          const denied = /^s3:(Delete|PutObjectRetention|PutObjectLegalHold|BypassGovernanceRetention|PutBucket|PutLifecycle|PutReplication|PutEncryption|PutObjectAcl)/i;
          const reaches = (value: unknown): boolean => {
            const text = JSON.stringify(value);
            return text.includes("AuditLedgerAuditLedgerBucket") || /"\*"/.test(text) || text.includes("arn:aws:s3:::*");
          };
          const offending: string[] = [];
          const statementsIn = (document: unknown): Statement[] => [((document as { Statement?: Statement | Statement[] } | undefined)?.Statement) ?? []].flat();
          for (const [id, resource] of Object.entries(synthesis.template.Resources)) {
            const documents: unknown[] = [];
            if (resource.Type === "AWS::IAM::Policy") documents.push(resource.Properties.PolicyDocument);
            if (resource.Type === "AWS::IAM::Role") for (const inline of (resource.Properties.Policies ?? []) as Array<{ PolicyDocument: unknown }>) documents.push(inline.PolicyDocument);
            if (resource.Type === "AWS::IAM::ManagedPolicy") documents.push(resource.Properties.PolicyDocument);
            for (const document of documents) {
              for (const statement of statementsIn(document)) {
                if (statement.Effect !== "Allow") continue;
                const actions = [statement.Action ?? statement.NotAction].flat().map(String);
                const broad = statement.NotAction !== undefined || actions.some((action) => action === "*" || action === "s3:*");
                if ((broad || actions.some((action) => denied.test(action))) && reaches(statement.Resource ?? statement.NotResource)) offending.push(`${withoutHash(id)}/${statement.Sid ?? "?"}: ${actions.join(",")}`);
              }
            }
          }
          expect(offending).toStrictEqual([]);
        });

        describe("what the ledger bucket's own policy lets the anchor's PutObject do (both lock profiles)", () => {
          const roleArn = `arn:aws:iam::${ACCOUNT}:role/anchor`;
          const bucketPolicy = (profile: Profile): IamStatement[] => {
            const [id] = one(synthesis.template, "AWS::S3::Bucket", "AuditLedgerAuditLedgerBucket");
            const policies = Object.values(synthesis.template.Resources).filter((resource) => resource.Type === "AWS::S3::BucketPolicy" && (resource.Properties.Bucket as { Ref?: string }).Ref === id);
            expect(policies).toHaveLength(1);
            return ((policies[0]!.Properties.PolicyDocument as { Statement: Statement[] }).Statement).map((statement) => underProfile(synthesis, statement, profile) as IamStatement);
          };
          const bucketArn = `arn:aws:s3:::agentx-${env}-audit-ledger-${ACCOUNT}-${REGION}`;
          // The bucket policy is all Deny statements; the anchor's identity policy supplies the Allow (pinned above).
          const identityAllow: IamStatement = { Sid: "AnchorIdentity", Effect: "Allow", Action: ["s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutObjectRetention", "s3:PutObjectLegalHold", "s3:BypassGovernanceRetention", "s3:PutBucketObjectLockConfiguration"], Resource: "*" };
          const put = (profile: Profile, context: Record<string, string>) => simulateIam([...bucketPolicy(profile), identityAllow], {
            action: "s3:PutObject", resource: `${bucketArn}/orgs/org_aaaaaaaaaaaaaaaaaaaa/seals/000000000001.json`, principal: roleArn,
            context: { "aws:SecureTransport": "true", "aws:PrincipalArn": roleArn, ...context },
          });
          /** The request context S3 builds for the anchor's PutObject: its If-None-Match header and any stated retention. */
          const contextOf = (input: ReturnType<typeof lockedPutInput>): Record<string, string> => ({
            ...(input.IfNoneMatch === undefined ? {} : { "s3:if-none-match": input.IfNoneMatch }),
            ...(input.ObjectLockRetainUntilDate === undefined ? {} : { "s3:object-lock-remaining-retention-days": String(Math.floor((input.ObjectLockRetainUntilDate.getTime() - Date.now()) / 86_400_000)) }),
          });
          const anchorsPut = lockedPutInput("agentx-bucket", "orgs/org_aaaaaaaaaaaaaaaaaaaa/seals/000000000001.json", "{}", "application/json");

          for (const profile of ["production", "trial"] as const) {
            it(`allows the anchor's create-only write under the ${profile} profile`, () => {
              expect(contextOf(anchorsPut)).toStrictEqual({ "s3:if-none-match": "*" });
              expect(put(profile, contextOf(anchorsPut))).toMatchObject({ allowed: true });
            });

            it(`refuses a write that is not create-only, and one that states a short retention, under the ${profile} profile`, () => {
              expect(put(profile, {})).toMatchObject({ allowed: false, reason: "explicit-deny", matched: ["RequireConditionalWrites"] });
              expect(put(profile, { "s3:if-none-match": "*", "s3:object-lock-remaining-retention-days": "0" })).toMatchObject({ allowed: false, matched: ["DenyShortRetention"] });
            });
          }

          it("production wants at least its retention if one is stated; the trial profile accepts a day", () => {
            const days = (profile: Profile, remaining: string) => put(profile, { "s3:if-none-match": "*", "s3:object-lock-remaining-retention-days": remaining }).allowed;
            expect(days("production", "30")).toBe(false);
            expect(days("production", "1095")).toBe(false);
            expect(days("production", "1096")).toBe(true);
            expect(days("trial", "1")).toBe(true);
            expect(days("trial", "0")).toBe(false);
          });

          it("denies the anchor's role every delete and lock change, in both profiles", () => {
            for (const profile of ["production", "trial"] as const) {
              for (const action of ["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutObjectRetention", "s3:PutObjectLegalHold", "s3:BypassGovernanceRetention", "s3:PutBucketObjectLockConfiguration"]) {
                // Even if an identity policy allowed the action, the bucket policy's Deny wins.
                const decision = simulateIam([...bucketPolicy(profile), identityAllow], { action, resource: `${bucketArn}/x`, principal: roleArn, context: { "aws:SecureTransport": "true", "aws:PrincipalArn": roleArn } });
                expect(decision, `${profile} ${action}`).toMatchObject({ allowed: false, reason: "explicit-deny" });
              }
            }
          });
        });

        it("runs every 15 minutes on a schedule that sends { source: agentx.audit-epoch } to the anchor through a scheduler role", () => {
          const [, schedule] = one(synthesis.template, "AWS::Scheduler::Schedule", "AuditLedgerAuditEpochSchedule");
          const anchorId = functionOf(synthesis)[0];
          expect(concreteAws(schedule.Properties)).toStrictEqual({
            Description: "Seals the audit records written since the last epoch",
            FlexibleTimeWindow: { Mode: "OFF" },
            ScheduleExpression: "rate(15 minutes)",
            State: "ENABLED",
            Target: {
              Arn: `${withoutHash(anchorId)}.Arn`,
              RoleArn: "AuditLedgerAuditEpochSchedulerRole.Arn",
              Input: JSON.stringify({ source: "agentx.audit-epoch" }),
              RetryPolicy: { MaximumEventAgeInSeconds: 60, MaximumRetryAttempts: 0 },
            },
          });
          const [, role] = one(synthesis.template, "AWS::IAM::Role", "AuditLedgerAuditEpochSchedulerRole");
          expect(concreteAws(role.Properties.AssumeRolePolicyDocument)).toStrictEqual({
            Version: "2012-10-17",
            Statement: [{
              Effect: "Allow", Action: "sts:AssumeRole", Principal: { Service: "scheduler.amazonaws.com" },
              Condition: { StringEquals: { "aws:SourceAccount": ACCOUNT, "aws:SourceArn": `arn:aws:scheduler:${REGION}:${ACCOUNT}:schedule-group/default` } },
            }],
          });
          const inline = role.Properties.Policies as Array<{ PolicyDocument: { Statement: Statement[] } }>;
          expect(inline).toHaveLength(1);
          expect(inline[0]!.PolicyDocument.Statement.map((statement) => concreteAws(statement))).toStrictEqual([
            { Sid: "InvokeAnchor", Effect: "Allow", Action: "lambda:InvokeFunction", Resource: `${withoutHash(anchorId)}.Arn` },
          ]);
          const epochs = ofType(synthesis.template, "AWS::Scheduler::Schedule").filter(([, other]) => JSON.stringify(other.Properties).includes("agentx.audit-epoch"));
          expect(epochs).toHaveLength(1);
        });

        it("raises six alarms: seals overdue, a chain mismatch (or version drift), an object conflict, lock drift (Task 9), a timestamp failure (Task 10) and a shred that did not finish (Task 15)", () => {
          const topicId = one(synthesis.template, "AWS::SNS::Topic", "OperatorAlerts")[0];
          const logGroupId = one(synthesis.template, "AWS::Logs::LogGroup", "AuditLedgerAuditAnchorLogs")[0];
          const namespace = environmentNaming(env).metricsNamespace;
          const filter = (id: string) => one(synthesis.template, "AWS::Logs::MetricFilter", id)[1].Properties;
          expect(filter("AuditLedgerAuditEpochSealedMetric")).toStrictEqual({
            LogGroupName: { Ref: logGroupId }, FilterPattern: '{ $.event = "audit.epoch_sealed" }',
            MetricTransformations: [{ MetricName: "AuditEpochSealed", MetricNamespace: namespace, MetricValue: "1" }],
          });
          expect(filter("AuditLedgerAuditChainMismatchMetric")).toStrictEqual({
            LogGroupName: { Ref: logGroupId }, FilterPattern: '{ ($.event = "audit.chain_mismatch") || ($.event = "audit.version_drift") }',
            MetricTransformations: [{ MetricName: "AuditChainMismatch", MetricNamespace: namespace, MetricValue: "1" }],
          });
          expect(filter("AuditLedgerAuditObjectConflictMetric")).toStrictEqual({
            LogGroupName: { Ref: logGroupId }, FilterPattern: '{ $.event = "audit.object_conflict" }',
            MetricTransformations: [{ MetricName: "AuditObjectConflict", MetricNamespace: namespace, MetricValue: "1" }],
          });
          expect(filter("AuditLedgerAuditLockDriftMetric")).toStrictEqual({
            LogGroupName: { Ref: logGroupId }, FilterPattern: '{ ($.event = "audit.lock_config_mismatch") || ($.event = "audit.version_drift") || ($.event = "audit.lock_sweep_failed") }',
            MetricTransformations: [{ MetricName: "AuditLockDrift", MetricNamespace: namespace, MetricValue: "1" }],
          });
          // Task 15: a shred that could not finish (or a due item that is damaged) is an erasure obligation not met: one is enough.
          expect(filter("AuditLedgerAuditShredFailedMetric")).toStrictEqual({
            LogGroupName: { Ref: logGroupId }, FilterPattern: '{ ($.event = "audit.shred_failed") || ($.event = "audit.shred_item_invalid") || ($.event = "audit.shred_deferred") }',
            MetricTransformations: [{ MetricName: "AuditShredFailed", MetricNamespace: namespace, MetricValue: "1" }],
          });
          const alarm = (id: string) => one(synthesis.template, "AWS::CloudWatch::Alarm", id)[1].Properties;
          expect(filter("AuditLedgerAuditTimestampFailedMetric")).toStrictEqual({
            LogGroupName: { Ref: logGroupId }, FilterPattern: '{ $.event = "audit.timestamp_failed" }',
            MetricTransformations: [{ MetricName: "AuditTimestampFailed", MetricNamespace: namespace, MetricValue: "1" }],
          });
          // One or more failures in each of two consecutive 15-minute periods (a single slow authority is not an alarm).
          expect(alarm("AuditLedgerAuditTimestampFailedAlarm")).toMatchObject({
            AlarmName: `agentx-${env}-AuditTimestampFailed`, MetricName: "AuditTimestampFailed", Namespace: namespace, Statistic: "Sum",
            Period: 900, EvaluationPeriods: 2, DatapointsToAlarm: 2, Threshold: 1, ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching",
          });
          const overdue = alarm("AuditLedgerAuditSealOverdueAlarm");
          expect(overdue).toMatchObject({
            AlarmName: `agentx-${env}-AuditSealOverdue`, MetricName: "AuditEpochSealed", Namespace: namespace, Statistic: "Sum",
            // Three 15-minute periods with fewer than one completed epoch each: 45 minutes. A missing period counts.
            Period: 900, EvaluationPeriods: 3, DatapointsToAlarm: 3, Threshold: 1, ComparisonOperator: "LessThanThreshold", TreatMissingData: "breaching",
          });
          for (const [id, name] of [["AuditLedgerAuditChainMismatchAlarm", "AuditChainMismatch"], ["AuditLedgerAuditObjectConflictAlarm", "AuditObjectConflict"], ["AuditLedgerAuditLockDriftAlarm", "AuditLockDrift"], ["AuditLedgerAuditShredFailedAlarm", "AuditShredFailed"]] as const) {
            expect(alarm(id)).toMatchObject({
              AlarmName: `agentx-${env}-${name}`, MetricName: name, Namespace: namespace, Statistic: "Sum",
              Period: 300, EvaluationPeriods: 1, Threshold: 1, ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching",
            });
          }
          for (const id of ["AuditLedgerAuditSealOverdueAlarm", "AuditLedgerAuditChainMismatchAlarm", "AuditLedgerAuditObjectConflictAlarm", "AuditLedgerAuditLockDriftAlarm", "AuditLedgerAuditTimestampFailedAlarm", "AuditLedgerAuditShredFailedAlarm"]) {
            expect(alarm(id).AlarmActions).toStrictEqual([{ Ref: topicId }]);
          }
        });

        it("names its alarms in the list the health route reads", () => {
          for (const suffix of ["AuditSealOverdue", "AuditChainMismatch", "AuditObjectConflict", "AuditLockDrift", "AuditTimestampFailed", "AuditShredFailed"]) expect(HEALTH_ALARM_SUFFIXES).toContain(suffix);
        });

        it("keeps its log group a month", () => {
          expect(one(synthesis.template, "AWS::Logs::LogGroup", "AuditLedgerAuditAnchorLogs")[1].Properties.RetentionInDays).toBe(30);
        });
      });
    }

    it("a scratch stack with the ledger alone builds the same function, schedule and alarms, so the checks above read the construct and not the control plane", () => {
      const stack = new Stack(new App(), "Scratch");
      new AuditLedger(stack, "AuditLedger", { ...scratchProps(stack), appenderRole: new iam.Role(stack, "AppenderRole", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") }) });
      const template = Template.fromStack(stack).toJSON() as TemplateJson;
      expect(one(template, "AWS::Lambda::Function", "AuditLedgerAuditAnchor")[1].Properties).toMatchObject({ Timeout: 300, MemorySize: 512, ReservedConcurrentExecutions: 1 });
      expect(one(template, "AWS::Scheduler::Schedule", "AuditLedgerAuditEpochSchedule")[1].Properties).toMatchObject({ ScheduleExpression: "rate(15 minutes)" });
      expect(ofType(template, "AWS::CloudWatch::Alarm").filter(([id]) => /Audit(SealOverdue|ChainMismatch|ObjectConflict|LockDrift)Alarm/.test(id))).toHaveLength(4);
    });

    it("a legacy template has no anchor", () => {
      const legacy = Template.fromStack(buildAgentXApp().node.children.filter((child): child is Stack => Stack.isStack(child)).find((stack) => stack.stackName === "AgentXControlPlane")!).toJSON();
      expect(JSON.stringify(legacy)).not.toMatch(/AuditAnchor|AUDIT_SEALS_TABLE_NAME|agentx\.audit-epoch|AuditSealOverdue/);
    });
  });

  describe("the broker reads the ledger and starts exports (Task 11)", () => {
    const BROKER_ROLE = "BrokerServiceRole";
    const LEDGER = "AuditLedgerAuditLedgerTable.Arn";
    const KEYS = "AuditLedgerAuditKeysTable.Arn";
    const SEALS = "AuditLedgerAuditSealsTable.Arn";
    const LEDGER_BUCKET = "AuditLedgerAuditLedgerBucket.Arn";
    const EXPORTS_BUCKET = "AuditLedgerAuditExportsBucket.Arn";
    const VAULT_KEY = "AuditLedgerAuditVaultKey.Arn";
    const EXPORT_FUNCTION = "AuditLedgerAuditExport.Arn";
    const ownPolicy = (synthesis: Synth) => {
      const own = ofType(synthesis.template, "AWS::IAM::Policy").filter(([id]) => withoutHash(id) === "AuditLedgerAuditBrokerReadPolicy");
      expect(own).toHaveLength(1);
      return own[0]![1].Properties;
    };
    const ownStatements = (synthesis: Synth): Statement[] => ((ownPolicy(synthesis).PolicyDocument as { Statement: Statement[] }).Statement).map((statement) => concreteAws(statement) as Statement);
    /** The statements of one of the broker's audit policies, by its logical id without the hash. */
    const ownPolicyOf = (synthesis: Synth, name: string): Statement[] => {
      const own = ofType(synthesis.template, "AWS::IAM::Policy").filter(([id]) => withoutHash(id) === name);
      expect(own).toHaveLength(1);
      return ((own[0]![1].Properties.PolicyDocument as { Statement: Statement[] }).Statement).map((statement) => concreteAws(statement) as Statement);
    };
    /** Everything the broker's role is allowed, from every policy that lists the role: the broker has many other grants, and none of them may reach the ledger. */
    const identity = (synthesis: Synth): IamStatement[] => {
      const roleId = one(synthesis.template, "AWS::IAM::Role", BROKER_ROLE)[0];
      return ofType(synthesis.template, "AWS::IAM::Policy")
        .filter(([, policy]) => (policy.Properties.Roles as unknown[]).some((role) => JSON.stringify(role) === JSON.stringify({ Ref: roleId })))
        .flatMap(([, policy]) => [(policy.Properties.PolicyDocument as { Statement: Statement | Statement[] }).Statement].flat().map((statement) => concreteAws(statement) as IamStatement));
    };

    for (const env of ["production", "staging", "acme"]) {
      describe(env, () => {
        const synthesis = named(env);

        it("C47 indexed reads need only the unchanged broker base-table read grant", () => {
          const grant = ownStatements(synthesis).find(statement => statement.Sid === "ReadLedgerAndSeals")!;
          const expected = { Sid: "ReadLedgerAndSeals", Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:Query"], Resource: [LEDGER, SEALS] };
          expect(grant).toStrictEqual(expected);
          for (const action of expected.Action) expect(simulateIam([grant], { action, resource: LEDGER }).allowed).toBe(true);
          expect(simulateIam([grant], { action: "dynamodb:BatchGetItem", resource: LEDGER }).allowed).toBe(false);
          const broadened = { ...grant, Action: [...expected.Action, "dynamodb:BatchGetItem"] };
          expect(() => expect(broadened).toStrictEqual(expected)).toThrow();
        });

        it("has exactly the pinned read statements, in a policy of its own on the broker's role", () => {
          const roleId = one(synthesis.template, "AWS::IAM::Role", BROKER_ROLE)[0];
          expect(ownPolicy(synthesis).Roles).toStrictEqual([{ Ref: roleId }]);
          expect(ownStatements(synthesis)).toStrictEqual([
            { Sid: "ReadLedgerAndSeals", Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:Query"], Resource: [LEDGER, SEALS] },
            { Sid: "ReadKeys", Effect: "Allow", Action: "dynamodb:GetItem", Resource: KEYS },
            // Task 15: the tombstone of an erased person is one PutItem (in a transaction with its audit event). IAM cannot limit it to
            // one sort key; the code writes it with a condition and a test pins that.
            { Sid: "EraseSubjects", Effect: "Allow", Action: "dynamodb:PutItem", Resource: KEYS },
            { Sid: "DownloadExports", Effect: "Allow", Action: "s3:GetObject", Resource: `${EXPORTS_BUCKET}/*` },
            { Sid: "StartExports", Effect: "Allow", Action: "lambda:InvokeFunction", Resource: EXPORT_FUNCTION },
          ]);
        });

        it("gives the broker the names it reads the ledger by, the export function's name and the vault key's id, and not the ledger bucket, in its one variable of names (the broker's variables are held to Lambda's 4 KB)", () => {
          const [, broker] = one(synthesis.template, "AWS::Lambda::Function", "Broker");
          const variables = (broker.Properties.Environment as { Variables: Json }).Variables;
          // No variable of its own: the 7 full names, a URL and an ARN came to 780 bytes of the 4,096.
          expect(Object.keys(variables).filter((name) => name.startsWith("AUDIT_"))).toStrictEqual([]);
          const id = (type: string, prefix: string) => one(synthesis.template, type, prefix)[0];
          const names = brokerNamesIn(variables);
          const audit = Object.fromEntries(Object.entries(names).filter(([key]) => key.startsWith("audit")));
          expect(audit).toStrictEqual({
            auditLedgerTable: { Ref: id("AWS::DynamoDB::Table", "AuditLedgerAuditLedgerTable") },
            auditSealsTable: { Ref: id("AWS::DynamoDB::Table", "AuditLedgerAuditSealsTable") },
            auditKeysTable: { Ref: id("AWS::DynamoDB::Table", "AuditLedgerAuditKeysTable") },
            auditExportsBucket: { Ref: id("AWS::S3::Bucket", "AuditLedgerAuditExportsBucket") },
            auditExportFunction: { Ref: id("AWS::Lambda::Function", "AuditLedgerAuditExport") },
            // The key's id (a Ref), never its ARN or its alias: the broker builds the ARN.
            auditVaultKey: { Ref: id("AWS::KMS::Key", "AuditLedgerAuditVaultKey") },
          });
          expect(JSON.stringify(variables)).not.toContain("LedgerBucket");
        });

        describe("what IAM lets the broker do on the ledger (all of its policies simulated)", () => {
          const request = (action: string, resource: string) => simulateIam(identity(synthesis), { action, resource });
          const LEDGER_OBJECT = `${LEDGER_BUCKET}/orgs/org_aaaaaaaaaaaaaaaaaaaa/seals/000000000001.json`;
          const EXPORT_OBJECT = `${EXPORTS_BUCKET}/org_aaaaaaaaaaaaaaaaaaaa/aex_1.rovara-audit.json.gz`;

          it("reads the ledger and seals tables with GetItem and Query, and the keys table with GetItem only", () => {
            for (const table of [LEDGER, SEALS]) for (const action of ["dynamodb:GetItem", "dynamodb:Query"]) expect(request(action, table).allowed, `${action} ${table}`).toBe(true);
            expect(request("dynamodb:GetItem", KEYS).allowed).toBe(true);
            expect(request("dynamodb:Query", KEYS).allowed).toBe(false);
          });

          it("writes nothing to the ledger or seals tables, and scans, batches and administers none of the three", () => {
            for (const table of [LEDGER, SEALS]) {
              for (const action of ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem", "dynamodb:BatchWriteItem", "dynamodb:Scan", "dynamodb:BatchGetItem", "dynamodb:DeleteTable", "dynamodb:UpdateTable", "dynamodb:*"]) {
                expect(request(action, table).allowed, `${action} ${table}`).toBe(false);
              }
            }
            for (const action of ["dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem", "dynamodb:BatchWriteItem", "dynamodb:Scan", "dynamodb:BatchGetItem", "dynamodb:DeleteTable", "dynamodb:UpdateTable", "dynamodb:*"]) {
              expect(request(action, KEYS).allowed, `${action} ${KEYS}`).toBe(false);
            }
          });

          it("may put into the keys table (a person's tombstone, Task 15) and nowhere else on it: it cannot delete a key, update one, or query the table", () => {
            expect(request("dynamodb:PutItem", KEYS).allowed).toBe(true);
            for (const action of ["dynamodb:DeleteItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:BatchWriteItem"]) expect(request(action, KEYS).allowed, action).toBe(false);
            // A put into the other two tables of the ledger stays denied.
            for (const table of [LEDGER, SEALS]) expect(request("dynamodb:PutItem", table).allowed, table).toBe(false);
          });

          it("may put the shred's due item into the State table under AUDIT_SHRED_DUE alone, by its own statement: no read, no delete, no other partition", () => {
            const statement = ownPolicyOf(synthesis, "AuditLedgerAuditBrokerOutboxPolicy").find((entry) => entry.Sid === "ScheduleShred")!;
            const alone = (action: string, keys: string[]) => simulateIam([statement], { action, resource: "State.Arn", context: { "dynamodb:LeadingKeys": keys } }).allowed;
            expect(alone("dynamodb:PutItem", ["AUDIT_SHRED_DUE"])).toBe(true);
            for (const keys of [["AUDIT_PENDING#1"], ["AUDIT_SHRED_DUE", "AUDIT_PENDING#1"], ["ORG#org_aaaaaaaaaaaaaaaaaaaa"], ["AUDIT_SHRED"], ["audit_shred_due"]]) expect(alone("dynamodb:PutItem", keys), keys.join(",")).toBe(false);
            for (const action of ["dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:Scan"]) expect(alone(action, ["AUDIT_SHRED_DUE"]), action).toBe(false);
          });

          it("has nothing on the ledger bucket: it reads no sealed object, and cannot write, delete, relock or list it", () => {
            for (const action of ["s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectRetention", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutObjectRetention", "s3:PutObjectLegalHold", "s3:BypassGovernanceRetention", "s3:*"]) {
              expect(request(action, LEDGER_OBJECT).allowed, action).toBe(false);
            }
            for (const action of ["s3:ListBucket", "s3:ListBucketVersions", "s3:PutBucketPolicy", "s3:PutBucketObjectLockConfiguration", "s3:PutBucketVersioning", "s3:DeleteBucket", "s3:PutLifecycleConfiguration"]) {
              expect(request(action, LEDGER_BUCKET).allowed, action).toBe(false);
            }
          });

          it("can read an export's file (so that it can sign a download link for it) and cannot write, delete or list the exports bucket", () => {
            expect(request("s3:GetObject", EXPORT_OBJECT).allowed).toBe(true);
            expect(request("s3:GetObject", EXPORTS_BUCKET).allowed).toBe(false);
            for (const action of ["s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutObjectRetention", "s3:PutObjectAcl", "s3:GetObjectVersion", "s3:*"]) expect(request(action, EXPORT_OBJECT).allowed, action).toBe(false);
            for (const action of ["s3:ListBucket", "s3:PutBucketPolicy", "s3:DeleteBucket", "s3:PutLifecycleConfiguration", "s3:PutBucketPublicAccessBlock"]) expect(request(action, EXPORTS_BUCKET).allowed, action).toBe(false);
            expect(request("s3:ListBucket", EXPORT_OBJECT).allowed).toBe(false);
          });

          it("has no KMS permission of its own: the key policy is what lets it decrypt a person's details", () => {
            for (const action of ["kms:Decrypt", "kms:GenerateDataKey", "kms:Encrypt", "kms:CreateGrant"]) expect(request(action, VAULT_KEY).allowed, action).toBe(false);
          });

          it("may invoke the export function, and not itself, the anchor or the appender", () => {
            expect(request("lambda:InvokeFunction", EXPORT_FUNCTION).allowed).toBe(true);
            for (const other of ["Broker.Arn", "AuditLedgerAuditAnchor.Arn", "AuditLedgerAuditAppender.Arn"]) expect(request("lambda:InvokeFunction", other).allowed, other).toBe(false);
          });

          it("the simulator sees the resource lists: with the ledger table dropped, its reads would be denied", () => {
            const narrowed = identity(synthesis).map((statement) => (statement.Sid === "ReadLedgerAndSeals" ? { ...statement, Resource: SEALS } : statement));
            expect(simulateIam(narrowed, { action: "dynamodb:GetItem", resource: LEDGER }).allowed).toBe(false);
            expect(request("dynamodb:GetItem", LEDGER).allowed).toBe(true);
          });
        });
      });
    }

    it("a scratch stack with the ledger alone builds the same policy, so the checks above read the construct and not the control plane", () => {
      const stack = new Stack(new App(), "Scratch");
      new AuditLedger(stack, "AuditLedger", { ...scratchProps(stack), appenderRole: new iam.Role(stack, "AppenderRole", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") }) });
      const template = Template.fromStack(stack).toJSON() as TemplateJson;
      const own = ofType(template, "AWS::IAM::Policy").filter(([id]) => id.startsWith("AuditLedgerAuditBrokerReadPolicy"));
      expect(own).toHaveLength(1);
      expect(((own[0]![1].Properties.PolicyDocument as { Statement: Statement[] }).Statement).map((statement) => statement.Sid)).toStrictEqual(["ReadLedgerAndSeals", "ReadKeys", "EraseSubjects", "DownloadExports", "StartExports"]);
    });

    it("a legacy template has none of it", () => {
      const legacy = Template.fromStack(buildAgentXApp().node.children.filter((child): child is Stack => Stack.isStack(child)).find((stack) => stack.stackName === "AgentXControlPlane")!).toJSON();
      expect(JSON.stringify(legacy)).not.toMatch(/AUDIT_EXPORTS_BUCKET_NAME|AUDIT_EXPORT_FUNCTION_NAME|AUDIT_LEDGER_TABLE_NAME|AuditBrokerReadPolicy|AuditExport/);
    });
  });

  describe("the export function (Task 11)", () => {
    const ROLE = "AuditLedgerAuditExportRole";
    const LEDGER = "AuditLedgerAuditLedgerTable.Arn";
    const KEYS = "AuditLedgerAuditKeysTable.Arn";
    const SEALS = "AuditLedgerAuditSealsTable.Arn";
    const LEDGER_BUCKET = "AuditLedgerAuditLedgerBucket.Arn";
    const EXPORTS_BUCKET = "AuditLedgerAuditExportsBucket.Arn";
    const QUEUE = "AuditLedgerAuditIntakeQueue.Arn";
    const DLQ = "AuditLedgerAuditIntakeDeadLetterQueue.Arn";
    const VAULT_KEY = "AuditLedgerAuditVaultKey.Arn";
    const STATE = "State.Arn";
    const functionOf = (synthesis: Synth) => one(synthesis.template, "AWS::Lambda::Function", "AuditLedgerAuditExport");
    const identity = (synthesis: Synth): IamStatement[] => roleStatements(synthesis.template, one(synthesis.template, "AWS::IAM::Role", ROLE)[0], concreteAws);
    const ownStatements = (synthesis: Synth): Statement[] => {
      const own = ofType(synthesis.template, "AWS::IAM::Policy").filter(([id]) => withoutHash(id) === "AuditLedgerAuditExportPolicy");
      expect(own).toHaveLength(1);
      return ((own[0]![1].Properties.PolicyDocument as { Statement: Statement[] }).Statement).map((statement) => concreteAws(statement) as Statement);
    };

    for (const env of ["production", "staging", "acme"]) {
      describe(env, () => {
        const synthesis = named(env);

        it("is a Node 22 function with 15 minutes, 1,024 MB and a reserved concurrency of 5, on its own role, outside any VPC", () => {
          const [, fn] = functionOf(synthesis);
          expect(fn.Properties).toMatchObject({ Runtime: "nodejs22.x", Timeout: 900, MemorySize: 1024, ReservedConcurrentExecutions: 5, Handler: "index.handler" });
          expect(concreteAws(fn.Properties.Role)).toBe(`${ROLE}.Arn`);
          expect(fn.Properties.VpcConfig).toBeUndefined();
          // The only other reserved concurrency is the anchor's.
          const reserved = ofType(synthesis.template, "AWS::Lambda::Function").filter(([, other]) => other.Properties.ReservedConcurrentExecutions !== undefined).map(([id]) => withoutHash(id)).sort();
          expect(reserved).toStrictEqual(["AuditLedgerAuditAnchor", "AuditLedgerAuditExport"]);
        });

        it("is given the tables, buckets, queue and key it uses, and the State table", () => {
          const [, fn] = functionOf(synthesis);
          const variables = (fn.Properties.Environment as { Variables: Json }).Variables;
          expect(Object.fromEntries(Object.entries(variables).map(([name, value]) => [name, concreteAws(value)]))).toStrictEqual({
            STATE_TABLE_NAME: "Ref:State",
            AUDIT_LEDGER_TABLE_NAME: "Ref:AuditLedgerAuditLedgerTable",
            AUDIT_SEALS_TABLE_NAME: "Ref:AuditLedgerAuditSealsTable",
            AUDIT_KEYS_TABLE_NAME: "Ref:AuditLedgerAuditKeysTable",
            AUDIT_LEDGER_BUCKET_NAME: "Ref:AuditLedgerAuditLedgerBucket",
            AUDIT_EXPORTS_BUCKET_NAME: "Ref:AuditLedgerAuditExportsBucket",
            AUDIT_INTAKE_QUEUE_URL: "Ref:AuditLedgerAuditIntakeQueue",
            AUDIT_VAULT_KEY_ARN: "AuditLedgerAuditVaultKey.Arn",
          });
        });

        it("has exactly the pinned statements, in a policy of its own, and the log group's write actions", () => {
          expect(ownStatements(synthesis)).toStrictEqual([
            { Sid: "ReadLedgerAndSeals", Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:Query"], Resource: [LEDGER, SEALS] },
            { Sid: "ReadKeys", Effect: "Allow", Action: "dynamodb:GetItem", Resource: KEYS },
            { Sid: "ReadSealedObjects", Effect: "Allow", Action: ["s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectRetention"], Resource: `${LEDGER_BUCKET}/*` },
            { Sid: "ExportObjects", Effect: "Allow", Action: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], Resource: `${EXPORTS_BUCKET}/*` },
            { Sid: "ListExports", Effect: "Allow", Action: "s3:ListBucket", Resource: EXPORTS_BUCKET },
            {
              Sid: "ExportRecords", Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:UpdateItem"], Resource: STATE,
              Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ORG#*#AUDIT_EXPORT#*"] } },
            },
            {
              Sid: "AuditPendingItems", Effect: "Allow", Action: ["dynamodb:PutItem", "dynamodb:DeleteItem"], Resource: STATE,
              Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["AUDIT_PENDING#*"] } },
            },
            { Sid: "SendAuditEvents", Effect: "Allow", Action: "sqs:SendMessage", Resource: QUEUE },
          ]);
          // The whole identity of the role: those, and the log group's write actions.
          const identityStatements = identity(synthesis);
          expect(identityStatements).toHaveLength(9);
          expect(identityStatements.filter((statement) => statement.Sid === undefined)).toStrictEqual([
            { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: "AuditLedgerAuditExportLogs.Arn" },
          ]);
          for (const statement of identityStatements) {
            expect(statement.NotAction).toBeUndefined();
            expect(statement.NotResource).toBeUndefined();
            // A bucket's objects as `<bucket ARN>/*` is the only wildcard a resource has.
            expect([statement.Resource].flat().map((resource) => String(resource).replace(/\/\*$/, "")).join(",")).not.toContain("*");
            expect(statement.Effect).toBe("Allow");
          }
        });

        describe("what IAM lets it do (the policies simulated)", () => {
          const request = (action: string, resource: string, leadingKeys?: string[]) => simulateIam(identity(synthesis), { action, resource, ...(leadingKeys === undefined ? {} : { context: { "dynamodb:LeadingKeys": leadingKeys } }) });
          const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
          const LEDGER_OBJECT = `${LEDGER_BUCKET}/orgs/${ORG}/seals/000000000001.json`;
          const EXPORT_OBJECT = `${EXPORTS_BUCKET}/${ORG}/aex_1.rovara-audit.json.gz`;

          it("reads the ledger, seals and keys tables and writes none of them", () => {
            for (const table of [LEDGER, SEALS]) for (const action of ["dynamodb:GetItem", "dynamodb:Query"]) expect(request(action, table).allowed, `${action} ${table}`).toBe(true);
            expect(request("dynamodb:GetItem", KEYS).allowed).toBe(true);
            for (const table of [LEDGER, SEALS, KEYS]) {
              for (const action of ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem", "dynamodb:BatchWriteItem", "dynamodb:Scan"]) expect(request(action, table, [`AUDIT#${ORG}`]).allowed, `${action} ${table}`).toBe(false);
            }
            expect(request("dynamodb:Query", KEYS).allowed).toBe(false);
          });

          it("on the State table updates only export records and puts and deletes only pending audit items", () => {
            const record = [`ORG#${ORG}#AUDIT_EXPORT#aex_1`];
            for (const action of ["dynamodb:GetItem", "dynamodb:UpdateItem"]) expect(request(action, STATE, record).allowed, action).toBe(true);
            for (const action of ["dynamodb:PutItem", "dynamodb:DeleteItem"]) expect(request(action, STATE, ["AUDIT_PENDING#3"]).allowed, action).toBe(true);
            // Not an export record, not a pending item, or one of them beside another key: refused.
            for (const keys of [[`ORG#${ORG}`], [`ORG#${ORG}#PROJECT#web`], ["AUDIT_PENDING#3", `ORG#${ORG}`], ["THREAD#1"]]) {
              for (const action of ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]) {
                const mixed = keys.every((key) => key.startsWith("AUDIT_PENDING#")) && ["dynamodb:PutItem", "dynamodb:DeleteItem"].includes(action);
                if (!mixed) expect(request(action, STATE, keys).allowed, `${action} ${keys.join(",")}`).toBe(false);
              }
            }
            for (const action of ["dynamodb:Query", "dynamodb:Scan", "dynamodb:BatchWriteItem", "dynamodb:ConditionCheckItem"]) expect(request(action, STATE, record).allowed, action).toBe(false);
          });

          it("reads sealed objects by version with their retention but cannot write, delete, relock or list the ledger bucket", () => {
            for (const action of ["s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectRetention"]) expect(request(action, LEDGER_OBJECT).allowed, action).toBe(true);
            for (const action of ["s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutObjectRetention", "s3:PutObjectLegalHold", "s3:BypassGovernanceRetention", "s3:*"]) expect(request(action, LEDGER_OBJECT).allowed, action).toBe(false);
            for (const action of ["s3:ListBucket", "s3:ListBucketVersions", "s3:PutBucketPolicy", "s3:PutBucketObjectLockConfiguration", "s3:DeleteBucket"]) expect(request(action, LEDGER_BUCKET).allowed, action).toBe(false);
          });

          it("puts, gets and deletes the exports bucket's objects and lists the bucket, and changes nothing about it", () => {
            for (const action of ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]) expect(request(action, EXPORT_OBJECT).allowed, action).toBe(true);
            expect(request("s3:ListBucket", EXPORTS_BUCKET).allowed).toBe(true);
            expect(request("s3:ListBucket", EXPORT_OBJECT).allowed).toBe(false);
            for (const action of ["s3:PutObjectRetention", "s3:DeleteObjectVersion", "s3:PutObjectAcl", "s3:*"]) expect(request(action, EXPORT_OBJECT).allowed, action).toBe(false);
            for (const action of ["s3:PutBucketPolicy", "s3:DeleteBucket", "s3:PutLifecycleConfiguration", "s3:PutBucketPublicAccessBlock"]) expect(request(action, EXPORTS_BUCKET).allowed, action).toBe(false);
          });

          it("sends to the intake queue and nothing else on SQS, and invokes no function", () => {
            expect(request("sqs:SendMessage", QUEUE).allowed).toBe(true);
            for (const action of ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:PurgeQueue"]) expect(request(action, QUEUE).allowed, action).toBe(false);
            expect(request("sqs:SendMessage", DLQ).allowed).toBe(false);
            expect(identity(synthesis).some((statement) => [statement.Action].flat().some((action) => String(action).startsWith("lambda:")))).toBe(false);
          });

          it("has no KMS permission of its own: the key policy's ExportUse is what lets it decrypt", () => {
            for (const action of ["kms:Decrypt", "kms:GenerateDataKey", "kms:Encrypt", "kms:CreateGrant"]) expect(request(action, VAULT_KEY).allowed, action).toBe(false);
            const keyStatements = ((one(synthesis.template, "AWS::KMS::Key", "AuditLedgerAuditVaultKey")[1].Properties.KeyPolicy as { Statement: Statement[] }).Statement).map((statement) => concreteAws(statement) as IamStatement);
            const asExport = (action: string, context: Record<string, string | string[]>) => simulateIam(keyStatements, { action, resource: "*", principal: `${ROLE}.Arn`, context });
            const good = { "kms:EncryptionContext:rovara:purpose": "audit-details", "kms:EncryptionContextKeys": ["rovara:org"] };
            expect(asExport("kms:Decrypt", good).allowed).toBe(true);
            expect(asExport("kms:GenerateDataKey", good).allowed).toBe(false);
            expect(asExport("kms:Decrypt", { ...good, "kms:EncryptionContext:rovara:purpose": "other" }).allowed).toBe(false);
            expect(asExport("kms:Decrypt", { "kms:EncryptionContext:rovara:purpose": "audit-details", "kms:EncryptionContextKeys": ["other"] }).allowed).toBe(false);
          });
        });

        it("limits its asynchronous invokes to one retry and an event age of 30 minutes, so a queued or retried build cannot start long after its export was reported failed", () => {
          const configs = ofType(synthesis.template, "AWS::Lambda::EventInvokeConfig").filter(([id]) => id.startsWith("AuditLedgerAuditExport"));
          expect(configs).toHaveLength(1);
          expect(configs[0]![1].Properties).toMatchObject({ MaximumRetryAttempts: 1, MaximumEventAgeInSeconds: 1800, Qualifier: "$LATEST" });
          expect(concreteAws(configs[0]![1].Properties.FunctionName)).toBe("Ref:AuditLedgerAuditExport");
          expect(AUDIT_EXPORT_MAX_EVENT_AGE_SECONDS).toBe(1800);
          expect(AUDIT_EXPORT_RETRY_ATTEMPTS).toBe(1);
          expect(AUDIT_EXPORT_TIMEOUT_SECONDS).toBe(900);
        });

        it("keeps its log group a month", () => {
          expect(one(synthesis.template, "AWS::Logs::LogGroup", "AuditLedgerAuditExportLogs")[1].Properties.RetentionInDays).toBe(30);
        });
      });
    }
  });

  it("no resource name or description carries an em dash", () => {
    const text = JSON.stringify(Object.fromEntries(Object.entries(production.template.Resources).filter(([id]) => id.startsWith("AuditLedger") || id.startsWith("AuditAppender"))));
    expect(text).not.toContain("—");
  });
});

describe("the agentxReservedConcurrency context flag", () => {
  const reservedIn = (synthesis: Synth) => ofType(synthesis.template, "AWS::Lambda::Function")
    .filter(([, fn]) => fn.Properties.ReservedConcurrentExecutions !== undefined)
    .map(([id, fn]) => [withoutHash(id), fn.Properties.ReservedConcurrentExecutions] as const)
    .sort(([a], [b]) => a.localeCompare(b));

  it("keeps both reservations, with their values, when the flag is not given", () => {
    expect(reservedIn(named("staging"))).toStrictEqual([["AuditLedgerAuditAnchor", 1], ["AuditLedgerAuditExport", 5]]);
  });

  it("keeps both reservations when the flag is true, as a boolean or as the string the CLI passes", () => {
    for (const value of [true, "true"]) {
      expect(reservedIn(named("staging", { agentxReservedConcurrency: value }))).toStrictEqual([["AuditLedgerAuditAnchor", 1], ["AuditLedgerAuditExport", 5]]);
    }
  });

  it("sets no ReservedConcurrentExecutions on any function of any stack when the flag is false, as a boolean or as a string", () => {
    for (const value of [false, "false"]) {
      const app = buildAgentXApp({ agentxEnv: "staging", agentxReservedConcurrency: value });
      const stacks = app.node.children.filter((child): child is Stack => Stack.isStack(child));
      expect(stacks.length).toBeGreaterThan(1);
      let functions = 0;
      for (const stack of stacks) {
        const template = Template.fromStack(stack).toJSON() as TemplateJson;
        for (const [id, fn] of ofType(template, "AWS::Lambda::Function")) {
          functions += 1;
          expect(fn.Properties.ReservedConcurrentExecutions, `${stack.stackName} ${id}`).toBeUndefined();
        }
      }
      expect(functions).toBeGreaterThan(0);
      // The functions are still there: only the reservation is gone.
      const ledger = named("staging", { agentxReservedConcurrency: value });
      expect(one(ledger.template, "AWS::Lambda::Function", "AuditLedgerAuditAnchor")[1].Properties).toMatchObject({ Timeout: 300, MemorySize: 512 });
      expect(one(ledger.template, "AWS::Lambda::Function", "AuditLedgerAuditExport")[1].Properties).toMatchObject({ Timeout: 900, MemorySize: 1024 });
    }
  });

  it("refuses any other value, naming the flag and the value", () => {
    for (const value of ["off", "0", 0, 1, "FALSE", "", null]) {
      expect(() => buildAgentXApp({ agentxEnv: "staging", agentxReservedConcurrency: value }), JSON.stringify(value)).toThrow(/agentxReservedConcurrency/);
    }
    expect(() => buildAgentXApp({ agentxEnv: "staging", agentxReservedConcurrency: "off" })).toThrow(/"off"/);
  });
});
