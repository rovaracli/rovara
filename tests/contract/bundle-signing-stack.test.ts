// SK-4: the bundle signing key and the one role meant to use it. Nothing here reaches AWS; the stack is only synthesised.
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import {
  BUNDLE_SIGNING_ACCOUNT_CONTEXT_KEY,
  BUNDLE_SIGNING_ENVIRONMENT_CONTEXT_KEY,
  BUNDLE_SIGNING_OIDC_PROVIDER_CONTEXT_KEY,
  BUNDLE_SIGNING_REPOSITORY_CONTEXT_KEY,
  BUNDLE_SIGNING_REPOSITORY_IDS_CONTEXT_KEY,
  BUNDLE_SIGNING_ROLE_NAME,
  BUNDLE_SIGNING_SHARED_ACCOUNT_CONTEXT_KEY,
  BUNDLE_SIGNING_SWITCH_CONTEXT_KEY,
  BundleSigningStack,
  STAGING_ACCOUNT_ID,
  bundleSigningTrustPatterns,
  parseBundleSigningContext,
} from "../../infra/lib/bundle-signing.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const SIGNING_ACCOUNT = "111122223333";
const PROVIDER = `arn:aws:iam::${SIGNING_ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;
const ENABLED = {
  [BUNDLE_SIGNING_SWITCH_CONTEXT_KEY]: "enabled",
  [BUNDLE_SIGNING_REPOSITORY_CONTEXT_KEY]: "PrepLabsAI/Rovara",
  [BUNDLE_SIGNING_REPOSITORY_IDS_CONTEXT_KEY]: "272978771/1307121896",
  [BUNDLE_SIGNING_ACCOUNT_CONTEXT_KEY]: SIGNING_ACCOUNT,
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
const resourcesOf = (template: Template) => template.toJSON().Resources as Resources;
const trustOf = (template: Template): Statement => statements(Object.values(resourcesOf(template)).find((resource) => resource.Type === "AWS::IAM::Role")!.Properties.AssumeRolePolicyDocument)[0]!;

/** IAM's StringEquals / StringLike over the token's claims (`*` and `?` only), as AssumeRoleWithWebIdentity evaluates the trust policy's conditions: every key must hold, a list means any of its values. */
function assumable(trust: Statement, claims: Record<string, string>): boolean {
  const like = (pattern: string, value: string): boolean => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".")}$`, "u").test(value);
  for (const [operator, keys] of Object.entries(trust.Condition ?? {})) {
    for (const [key, expected] of Object.entries(keys)) {
      const claim = claims[key.replace("token.actions.githubusercontent.com:", "")];
      if (claim === undefined) return false;
      const values = [expected].flat() as string[];
      const ok = operator === "StringEquals" ? values.includes(claim) : operator === "StringLike" ? values.some((pattern) => like(pattern, claim)) : false;
      if (!ok) return false;
    }
  }
  return true;
}

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
    expect(parse({ ...ENABLED, [BUNDLE_SIGNING_REPOSITORY_IDS_CONTEXT_KEY]: undefined }), "the immutable ids are required").toThrow(/immutable ids/u);
    expect(parse({ ...ENABLED, [BUNDLE_SIGNING_REPOSITORY_IDS_CONTEXT_KEY]: "272978771/*" })).toThrow(/digits only/u);
    expect(parse({ ...ENABLED, [BUNDLE_SIGNING_ACCOUNT_CONTEXT_KEY]: undefined })).toThrow(/12-digit/u);
    expect(parse({ ...ENABLED, [BUNDLE_SIGNING_ACCOUNT_CONTEXT_KEY]: "12345" })).toThrow(/12-digit/u);
    expect(parse({ ...ENABLED, [BUNDLE_SIGNING_OIDC_PROVIDER_CONTEXT_KEY]: undefined })).toThrow(/OIDC provider/u);
    expect(parse({ ...ENABLED, [BUNDLE_SIGNING_OIDC_PROVIDER_CONTEXT_KEY]: `arn:aws:iam::${SIGNING_ACCOUNT}:oidc-provider/accounts.google.com` })).toThrow(/OIDC provider/u);
    expect(parse({ ...ENABLED, [BUNDLE_SIGNING_OIDC_PROVIDER_CONTEXT_KEY]: "arn:aws:iam::999999999999:oidc-provider/token.actions.githubusercontent.com" }), "the provider must be in the signing account").toThrow(/not in the signing account/u);
    expect(parse({ ...ENABLED, [BUNDLE_SIGNING_ENVIRONMENT_CONTEXT_KEY]: "prod*" })).toThrow(/environment name/u);
    expect(parse(ENABLED, true)).toThrow(/release account/u);
    expect(parse(ENABLED)()).toEqual({
      repository: "PrepLabsAI/Rovara", repositoryIds: "272978771/1307121896", oidcProviderArn: PROVIDER, accountId: SIGNING_ACCOUNT, environment: "release-signing", sharedAccountOverride: false,
    });
  });

  it("refuses the staging/install account unless the owner overrides it, and warns when they do", () => {
    const shared = { ...ENABLED, [BUNDLE_SIGNING_ACCOUNT_CONTEXT_KEY]: STAGING_ACCOUNT_ID, [BUNDLE_SIGNING_OIDC_PROVIDER_CONTEXT_KEY]: `arn:aws:iam::${STAGING_ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com` };
    expect(() => buildAgentXApp({ agentxRegion: "us-east-1", ...shared })).toThrow(/staging\/install account.*dedicated signing account/u);
    expect(() => buildAgentXApp({ agentxRegion: "us-east-1", ...shared, [BUNDLE_SIGNING_SHARED_ACCOUNT_CONTEXT_KEY]: "false" })).toThrow(/dedicated signing account/u);
    const app = buildAgentXApp({ agentxRegion: "us-east-1", ...shared, [BUNDLE_SIGNING_SHARED_ACCOUNT_CONTEXT_KEY]: "true" });
    const stack = app.node.tryFindChild("AgentXBundleSigning") as BundleSigningStack;
    const warnings = stack.node.metadata.filter((entry) => entry.type === "aws:cdk:warning").map((entry) => String(entry.data));
    expect(warnings.join("\n")).toMatch(/staging\/install account.*dedicated signing account/u);
    // A dedicated account gets no such warning.
    const dedicated = (buildAgentXApp({ agentxRegion: "us-east-1", ...ENABLED }).node.tryFindChild("AgentXBundleSigning") as BundleSigningStack).node.metadata.filter((entry) => entry.type === "aws:cdk:warning");
    expect(dedicated).toEqual([]);
  });

  it("builds the stack in the signing account", () => {
    const stack = buildAgentXApp({ agentxRegion: "us-east-1", ...ENABLED }).node.tryFindChild("AgentXBundleSigning") as BundleSigningStack;
    expect(stack.account).toBe(SIGNING_ACCOUNT);
    expect(stack.region).toBe("us-east-1");
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
    const keys = Object.values(resourcesOf(template)).filter((resource) => resource.Type === "AWS::KMS::Key");
    expect(keys[0]?.DeletionPolicy).toBe("Retain");
    expect(keys[0]?.Properties.EnableKeyRotation).not.toBe(true);
  });

  it("lets only the release role sign or read the public key, denies Sign to every other principal, and gives administrators neither use nor grants", () => {
    const key = Object.values(resourcesOf(signingTemplate())).find((resource) => resource.Type === "AWS::KMS::Key")!;
    const list = statements(key.Properties.KeyPolicy);
    const roleArn = { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:iam::${SIGNING_ACCOUNT}:role/${BUNDLE_SIGNING_ROLE_NAME}`]] };
    const allowing = list.filter((statement) => statement.Effect === "Allow");
    const useful = allowing.filter((statement) => [statement.Action].flat().some((action) => action === "kms:Sign" || action === "kms:*" || action === "kms:GetPublicKey"));
    // Exactly one allow can reach Sign, and it is pinned to the role.
    expect(useful).toHaveLength(1);
    expect(useful[0]!.Condition).toEqual({ StringEquals: { "aws:PrincipalArn": roleArn } });
    // No other allow grants cryptographic use, a grant or a wildcard (CreateGrant included: kms:Create* is not used).
    for (const statement of allowing.filter((candidate) => candidate !== useful[0])) {
      for (const action of [statement.Action].flat()) {
        expect(action, statement.Sid).not.toMatch(/^kms:(?:\*|Create\*|CreateGrant|Sign|Verify|Encrypt|Decrypt|ReEncrypt\*|GenerateData.*)$/u);
      }
    }
    const deny = list.find((statement) => statement.Effect === "Deny");
    expect(deny).toMatchObject({ Principal: { AWS: "*" }, Action: "kms:Sign", Resource: "*", Condition: { StringNotEquals: { "aws:PrincipalArn": roleArn } } });
  });
});

describe("the role", () => {
  it("is assumable only through GitHub OIDC, for sts.amazonaws.com, by repository id and owner id, in the sign job's environment, from release.yml on a version tag", () => {
    const template = signingTemplate();
    template.resourceCountIs("AWS::IAM::Role", 1);
    const role = Object.values(resourcesOf(template)).find((resource) => resource.Type === "AWS::IAM::Role")!;
    expect(role.Properties.RoleName).toBe(BUNDLE_SIGNING_ROLE_NAME);
    expect(role.Properties.MaxSessionDuration).toBe(3600);
    const trust = statements(role.Properties.AssumeRolePolicyDocument);
    expect(trust).toEqual([
      {
        Effect: "Allow",
        Action: "sts:AssumeRoleWithWebIdentity",
        Principal: { Federated: PROVIDER },
        Condition: {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:repository_id": "1307121896",
            "token.actions.githubusercontent.com:repository_owner_id": "272978771",
            "token.actions.githubusercontent.com:environment": "release-signing",
          },
          StringLike: {
            "token.actions.githubusercontent.com:sub": ["repo:PrepLabsAI/Rovara:environment:release-signing", "repo:*@272978771/*@1307121896:environment:release-signing"],
            "token.actions.githubusercontent.com:job_workflow_ref": "PrepLabsAI/Rovara/.github/workflows/release.yml@refs/tags/v?*.?*.?*",
            "token.actions.githubusercontent.com:ref": "refs/tags/v?*.?*.?*",
          },
        },
      },
    ]);
    // Never a branch, a pull request or a bare wildcard.
    expect(JSON.stringify(trust)).not.toMatch(/refs\/heads|pull_request|:sub":"\*"|"\*"/u);
  });

  describe("evaluated against sample tokens (the trust policy's conditions, as IAM reads them)", () => {
    const trust = trustOf(signingTemplate());
    const good = {
      aud: "sts.amazonaws.com",
      sub: "repo:PrepLabsAI@272978771/Rovara@1307121896:environment:release-signing",
      job_workflow_ref: "PrepLabsAI/Rovara/.github/workflows/release.yml@refs/tags/v1.4.0",
      ref: "refs/tags/v1.4.0",
      repository_id: "1307121896",
      repository_owner_id: "272978771",
      environment: "release-signing",
    };
    it("assumes with the id-based subject (the format GitHub uses for this repository), and with the name-based one", () => {
      expect(assumable(trust, good)).toBe(true);
      expect(assumable(trust, { ...good, sub: "repo:PrepLabsAI/Rovara:environment:release-signing" })).toBe(true);
    });
    it.each([
      ["a branch run", { ref: "refs/heads/mainline", job_workflow_ref: "PrepLabsAI/Rovara/.github/workflows/release.yml@refs/heads/mainline" }],
      ["a tag that is not a version", { ref: "refs/tags/latest", job_workflow_ref: "PrepLabsAI/Rovara/.github/workflows/release.yml@refs/tags/latest" }],
      ["a job outside the environment (the images or npm job, which also hold id-token)", { sub: "repo:PrepLabsAI@272978771/Rovara@1307121896:ref:refs/tags/v1.4.0", environment: "" }],
      ["another environment", { sub: "repo:PrepLabsAI@272978771/Rovara@1307121896:environment:staging", environment: "staging" }],
      ["another workflow of the repository", { job_workflow_ref: "PrepLabsAI/Rovara/.github/workflows/ci.yml@refs/tags/v1.4.0" }],
      ["a reusable workflow from another repository", { job_workflow_ref: "Evil/Rovara/.github/workflows/release.yml@refs/tags/v1.4.0" }],
      ["another repository id (a renamed or reclaimed name)", { repository_id: "42", sub: "repo:PrepLabsAI@272978771/Rovara@42:environment:release-signing" }],
      ["another owner id", { repository_owner_id: "42", sub: "repo:PrepLabsAI@42/Rovara@1307121896:environment:release-signing" }],
      ["another audience", { aud: "sts.example.com" }],
    ])("refuses %s", (_name, change) => {
      expect(assumable(trust, { ...good, ...change })).toBe(false);
    });
    it("refuses a token that lacks any one claim", () => {
      for (const claim of Object.keys(good)) {
        const { [claim]: _removed, ...rest } = good as Record<string, string>;
        void _removed;
        expect(assumable(trust, rest), claim).toBe(false);
      }
    });
  });

  it("may only Sign and read the public key of the bundle key", () => {
    const template = signingTemplate();
    const policy = Object.values(resourcesOf(template)).find((resource) => resource.Type === "AWS::IAM::Policy")!;
    const list = statements(policy.Properties.PolicyDocument);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ Effect: "Allow", Action: ["kms:Sign", "kms:GetPublicKey"] });
    expect(JSON.stringify(list[0]!.Resource)).toContain("BundleSigningKey");
    template.resourceCountIs("AWS::IAM::Policy", 1);
    template.resourceCountIs("AWS::IAM::ManagedPolicy", 0);
  });

  it("takes the environment from the context when it is not the default", () => {
    const patterns = bundleSigningTrustPatterns({ repository: "PrepLabsAI/Rovara", repositoryIds: "272978771/1307121896", oidcProviderArn: PROVIDER, accountId: SIGNING_ACCOUNT, environment: "sign-prod", sharedAccountOverride: false });
    expect(patterns.sub).toEqual(["repo:PrepLabsAI/Rovara:environment:sign-prod", "repo:*@272978771/*@1307121896:environment:sign-prod"]);
    expect(patterns.environment).toBe("sign-prod");
  });

  it("outputs the two values the owner copies into repository variables", () => {
    const outputs = signingTemplate().toJSON().Outputs as Record<string, { Description: string }>;
    expect(Object.keys(outputs).sort()).toEqual(["BundleSigningKeyArn", "BundleSigningRoleArn"]);
    expect(outputs.BundleSigningKeyArn?.Description).toContain("AGENTX_BUNDLE_KMS_KEY");
    expect(outputs.BundleSigningRoleArn?.Description).toContain("AGENTX_BUNDLE_SIGNING_ROLE_ARN");
  });
});
