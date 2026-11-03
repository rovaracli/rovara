// SK-4: the bundle signing key and the one role that can use it. Nothing here reaches AWS; the stack is only synthesised.
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import {
  BUNDLE_SIGNING_OIDC_PROVIDER_CONTEXT_KEY,
  BUNDLE_SIGNING_REPOSITORY_CONTEXT_KEY,
  BUNDLE_SIGNING_REPOSITORY_IDS_CONTEXT_KEY,
  BUNDLE_SIGNING_ROLE_NAME,
  BUNDLE_SIGNING_SWITCH_CONTEXT_KEY,
  BundleSigningStack,
  bundleSigningTrustPatterns,
  parseBundleSigningContext,
} from "../../infra/lib/bundle-signing.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const PROVIDER = "arn:aws:iam::944937319445:oidc-provider/token.actions.githubusercontent.com";
const ENABLED = {
  [BUNDLE_SIGNING_SWITCH_CONTEXT_KEY]: "enabled",
  [BUNDLE_SIGNING_REPOSITORY_CONTEXT_KEY]: "PrepLabsAI/Rovara-cloud",
  [BUNDLE_SIGNING_OIDC_PROVIDER_CONTEXT_KEY]: PROVIDER,
};

type Statement = { Sid?: string; Effect: string; Principal?: unknown; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
type Resources = Record<string, { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string }>;

function signingTemplate(context: Record<string, unknown> = ENABLED) {
  const app = buildAgentXApp({ agentxRegion: "us-east-1", ...context });
  const stack = app.node.tryFindChild("AgentXBundleSigning");
  expect(stack).toBeInstanceOf(BundleSigningStack);
  return Template.fromStack(stack as BundleSigningStack);
}

const statements = (document: unknown): Statement[] => (document as { Statement: Statement[] }).Statement;

describe("the bundle signing stack is off unless asked for", () => {
  it("is not synthesised without the switch, and the switch alone does nothing else", () => {
    expect(buildAgentXApp({}).node.tryFindChild("AgentXBundleSigning")).toBeUndefined();
    expect(buildAgentXApp({ [BUNDLE_SIGNING_SWITCH_CONTEXT_KEY]: "off" }).node.tryFindChild("AgentXBundleSigning")).toBeUndefined();
  });

  it("refuses half-set or malformed context, so a typo never silently leaves the key out or builds it wrong", () => {
    const get = (context: Record<string, unknown>) => (key: string): unknown => context[key];
    const parse = (context: Record<string, unknown>, named = false) => () => parseBundleSigningContext(get(context), { named });
    expect(parse({ [BUNDLE_SIGNING_REPOSITORY_CONTEXT_KEY]: "PrepLabsAI/Rovara" })).toThrow(/without agentxBundleSigning=enabled/u);
    expect(parse({ [BUNDLE_SIGNING_SWITCH_CONTEXT_KEY]: "yes" })).toThrow(/unsupported/u);
    expect(parse({ [BUNDLE_SIGNING_SWITCH_CONTEXT_KEY]: "enabled" })).toThrow(/owner\/name/u);
    expect(parse({ ...ENABLED, [BUNDLE_SIGNING_REPOSITORY_CONTEXT_KEY]: "PrepLabsAI/*" })).toThrow(/owner\/name/u);
    expect(parse({ ...ENABLED, [BUNDLE_SIGNING_REPOSITORY_CONTEXT_KEY]: "PrepLabsAI/Rovara cloud" })).toThrow(/owner\/name/u);
    expect(parse({ ...ENABLED, [BUNDLE_SIGNING_OIDC_PROVIDER_CONTEXT_KEY]: undefined })).toThrow(/OIDC provider/u);
    expect(parse({ ...ENABLED, [BUNDLE_SIGNING_OIDC_PROVIDER_CONTEXT_KEY]: "arn:aws:iam::944937319445:oidc-provider/accounts.google.com" })).toThrow(/OIDC provider/u);
    expect(parse({ ...ENABLED, [BUNDLE_SIGNING_REPOSITORY_IDS_CONTEXT_KEY]: "272978771/*" })).toThrow(/digits only/u);
    expect(parse(ENABLED, true)).toThrow(/release account/u);
    expect(parse(ENABLED)()).toEqual({ repository: "PrepLabsAI/Rovara-cloud", oidcProviderArn: PROVIDER });
  });

  it("changes no other stack's template when switched on", () => {
    const render = (context: Record<string, unknown>) => {
      const app = buildAgentXApp({ agentxRegion: "us-east-1", ...context });
      const out: Record<string, unknown> = {};
      for (const child of app.node.children) {
        if (child.node.id === "AgentXBundleSigning") continue;
        const stack = child as unknown as { templateOptions?: unknown };
        if (stack.templateOptions === undefined) continue;
        out[child.node.id] = Template.fromStack(child as never).toJSON();
      }
      return out;
    };
    const off = render({});
    expect(Object.keys(off).length).toBeGreaterThan(3);
    expect(render(ENABLED)).toEqual(off);
  });
});

describe("the key", () => {
  it("is an ECC P-256 signing key that is kept if the stack goes", () => {
    const template = signingTemplate();
    template.hasResourceProperties("AWS::KMS::Key", { KeySpec: "ECC_NIST_P256", KeyUsage: "SIGN_VERIFY", PendingWindowInDays: 30 });
    template.resourceCountIs("AWS::KMS::Key", 1);
    const keys = Object.values(template.toJSON().Resources as Resources).filter((resource) => resource.Type === "AWS::KMS::Key");
    expect(keys[0]?.DeletionPolicy).toBe("Retain");
    expect(keys[0]?.Properties.EnableKeyRotation).not.toBe(true);
  });

  it("lets only the release role sign or read the public key, denies Sign to every other principal, and gives administrators no use of it", () => {
    const key = Object.values(signingTemplate().toJSON().Resources as Resources).find((resource) => resource.Type === "AWS::KMS::Key")!;
    const list = statements(key.Properties.KeyPolicy);
    const roleArn = { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::", { Ref: "AWS::AccountId" }, `:role/${BUNDLE_SIGNING_ROLE_NAME}`]] };
    const allowing = list.filter((statement) => statement.Effect === "Allow");
    const useful = allowing.filter((statement) => [statement.Action].flat().some((action) => action === "kms:Sign" || action === "kms:*" || action === "kms:GetPublicKey"));
    // Exactly one allow can reach Sign, and it is pinned to the role.
    expect(useful).toHaveLength(1);
    expect(useful[0]!.Condition).toEqual({ StringEquals: { "aws:PrincipalArn": roleArn } });
    // No allow grants cryptographic use, grants or wildcards to anyone else.
    for (const statement of allowing.filter((candidate) => candidate !== useful[0])) {
      for (const action of [statement.Action].flat()) {
        expect(action, statement.Sid).not.toMatch(/^kms:(?:\*|Sign|Verify|Encrypt|Decrypt|ReEncrypt\*|GenerateData.*|CreateGrant)$/u);
      }
    }
    const deny = list.find((statement) => statement.Effect === "Deny");
    expect(deny).toMatchObject({ Principal: { AWS: "*" }, Action: "kms:Sign", Resource: "*", Condition: { StringNotEquals: { "aws:PrincipalArn": roleArn } } });
  });
});

describe("the role", () => {
  it("is assumable only through GitHub OIDC, for sts.amazonaws.com, from release.yml on a version tag of the named repository", () => {
    const template = signingTemplate();
    template.resourceCountIs("AWS::IAM::Role", 1);
    const role = Object.values(template.toJSON().Resources as Resources).find((resource) => resource.Type === "AWS::IAM::Role")!;
    expect(role.Properties.RoleName).toBe(BUNDLE_SIGNING_ROLE_NAME);
    expect(role.Properties.MaxSessionDuration).toBe(3600);
    const trust = statements(role.Properties.AssumeRolePolicyDocument);
    expect(trust).toEqual([
      {
        Effect: "Allow",
        Action: "sts:AssumeRoleWithWebIdentity",
        Principal: { Federated: PROVIDER },
        Condition: {
          StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
          StringLike: {
            "token.actions.githubusercontent.com:sub": "repo:PrepLabsAI/Rovara-cloud:ref:refs/tags/v*",
            "token.actions.githubusercontent.com:job_workflow_ref": "PrepLabsAI/Rovara-cloud/.github/workflows/release.yml@refs/tags/v*",
          },
        },
      },
    ]);
    // Never a branch, a pull request or a bare wildcard.
    expect(JSON.stringify(trust)).not.toMatch(/refs\/heads|pull_request|:sub":"\*"|"\*"/u);
  });

  it("may only Sign and read the public key of the bundle key", () => {
    const template = signingTemplate();
    const policy = Object.values(template.toJSON().Resources as Resources).find((resource) => resource.Type === "AWS::IAM::Policy")!;
    const list = statements(policy.Properties.PolicyDocument);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ Effect: "Allow", Action: ["kms:Sign", "kms:GetPublicKey"] });
    expect(JSON.stringify(list[0]!.Resource)).toContain("BundleSigningKey");
    template.resourceCountIs("AWS::IAM::Policy", 1);
    template.resourceCountIs("AWS::IAM::ManagedPolicy", 0);
  });

  it("uses the immutable-id subject when the repository's OIDC subject is the immutable form (docs/releases.md)", () => {
    const patterns = bundleSigningTrustPatterns({ repository: "PrepLabsAI/Rovara", repositoryIds: "272978771/1307121896", oidcProviderArn: PROVIDER });
    expect(patterns).toEqual({ sub: "repo:*@272978771/*@1307121896:ref:refs/tags/v*", jobWorkflowRef: "PrepLabsAI/Rovara/.github/workflows/release.yml@refs/tags/v*" });
  });

  it("outputs the two values the owner copies into repository variables", () => {
    const outputs = signingTemplate().toJSON().Outputs as Record<string, { Description: string }>;
    expect(Object.keys(outputs).sort()).toEqual(["BundleSigningKeyArn", "BundleSigningRoleArn"]);
    expect(outputs.BundleSigningKeyArn?.Description).toContain("AGENTX_BUNDLE_KMS_KEY");
    expect(outputs.BundleSigningRoleArn?.Description).toContain("AGENTX_BUNDLE_SIGNING_ROLE_ARN");
  });
});
