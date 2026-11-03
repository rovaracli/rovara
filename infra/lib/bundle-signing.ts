// SK-4: the key that signs Enterprise release bundles, and the one role allowed to use it. Off by default and never part of a release: the
// owner turns it on once, by hand, with `-c agentxBundleSigning=enabled` (docs/enterprise/bundle-signing.md). Without that context key nothing
// here is synthesised, so every existing template is unchanged.
//
// Why it exists: kit.json's hashes come from the kit itself, so anyone who can run `release:bundle` with a signing permission can sign an edited
// kit. The only complete answer is that nobody can sign except the release workflow's bundle job, on a version tag:
//   - the role is assumable only through GitHub's OIDC token for that repository's release.yml on refs/tags/v* (sub and job_workflow_ref), for the
//     sts.amazonaws.com audience;
//   - the key policy lets only that role Sign, and explicitly denies Sign to every other principal, the account's administrators included.
// Changing who may sign means replacing the key policy, which is a deliberate, logged act (PutKeyPolicy), not a side effect of an IAM edit.
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_iam as iam,
  aws_kms as kms,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

export const BUNDLE_SIGNING_SWITCH_CONTEXT_KEY = "agentxBundleSigning";
export const BUNDLE_SIGNING_REPOSITORY_CONTEXT_KEY = "agentxBundleSigningRepository";
export const BUNDLE_SIGNING_REPOSITORY_IDS_CONTEXT_KEY = "agentxBundleSigningRepositoryIds";
export const BUNDLE_SIGNING_OIDC_PROVIDER_CONTEXT_KEY = "agentxBundleSigningOidcProviderArn";
export const BUNDLE_SIGNING_ROLE_NAME = "rovara-release-bundle-signing";
export const BUNDLE_SIGNING_KEY_ALIAS = "alias/rovara-release-bundle-signing";
export const BUNDLE_SIGNING_WORKFLOW_FILE = ".github/workflows/release.yml";
export const GITHUB_OIDC_HOST = "token.actions.githubusercontent.com";
export const GITHUB_OIDC_AUDIENCE = "sts.amazonaws.com";
/** The only refs the role trusts: version tags. A branch, a pull request or an environment never matches. */
export const BUNDLE_SIGNING_TAG_REF = "refs/tags/v*";

export interface BundleSigningConfig {
  /** `owner/name`: the repository whose release.yml runs the bundle job. */
  readonly repository: string;
  /** Optional immutable ids (`ownerId/repoId`), for a repository whose OIDC subject is the immutable form (docs/releases.md). */
  readonly repositoryIds?: string;
  /** The account's existing GitHub OIDC provider (an account can hold one per URL, so it is named, not created). */
  readonly oidcProviderArn: string;
}

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u;
const REPOSITORY_IDS = /^[0-9]{1,20}\/[0-9]{1,20}$/u;
const OIDC_PROVIDER_ARN = /^arn:aws(?:-[a-z]+)?:iam::[0-9]{12}:oidc-provider\/token\.actions\.githubusercontent\.com$/u;

/** The one parser for the context keys: unset is "off" (undefined); anything half-set or malformed stops the synth. */
export function parseBundleSigningContext(get: (key: string) => unknown, input: { named: boolean }): BundleSigningConfig | undefined {
  const switchValue = get(BUNDLE_SIGNING_SWITCH_CONTEXT_KEY);
  const others = [BUNDLE_SIGNING_REPOSITORY_CONTEXT_KEY, BUNDLE_SIGNING_REPOSITORY_IDS_CONTEXT_KEY, BUNDLE_SIGNING_OIDC_PROVIDER_CONTEXT_KEY].filter((key) => {
    const value = get(key);
    return value !== undefined && value !== "";
  });
  if (switchValue === undefined || switchValue === "" || switchValue === "off") {
    if (others.length > 0) throw new Error(`${others.join(", ")} set without ${BUNDLE_SIGNING_SWITCH_CONTEXT_KEY}=enabled; the bundle signing stack is off`);
    return undefined;
  }
  if (switchValue !== "enabled") throw new Error(`unsupported ${BUNDLE_SIGNING_SWITCH_CONTEXT_KEY} ${JSON.stringify(switchValue)}; expected enabled, off, or unset`);
  if (input.named) throw new Error("the bundle signing key belongs to the release account, not to a named environment; synthesise it without agentxEnv");
  const repository = get(BUNDLE_SIGNING_REPOSITORY_CONTEXT_KEY);
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) throw new Error(`${BUNDLE_SIGNING_REPOSITORY_CONTEXT_KEY} must be the repository whose release.yml signs bundles, as owner/name`);
  const provider = get(BUNDLE_SIGNING_OIDC_PROVIDER_CONTEXT_KEY);
  if (typeof provider !== "string" || !OIDC_PROVIDER_ARN.test(provider)) throw new Error(`${BUNDLE_SIGNING_OIDC_PROVIDER_CONTEXT_KEY} must be the ARN of this account's ${GITHUB_OIDC_HOST} OIDC provider`);
  const ids = get(BUNDLE_SIGNING_REPOSITORY_IDS_CONTEXT_KEY);
  if (ids !== undefined && ids !== "" && (typeof ids !== "string" || !REPOSITORY_IDS.test(ids))) throw new Error(`${BUNDLE_SIGNING_REPOSITORY_IDS_CONTEXT_KEY} must be ownerId/repositoryId, digits only`);
  return { repository, oidcProviderArn: provider, ...(typeof ids === "string" && ids !== "" ? { repositoryIds: ids } : {}) };
}

/** The `sub` pattern and the `job_workflow_ref` pattern the role trusts. Exported so the tests (and the docs) read the same strings the template holds. */
export function bundleSigningTrustPatterns(config: BundleSigningConfig): { sub: string; jobWorkflowRef: string } {
  const [owner, name] = config.repository.split("/") as [string, string];
  const ids = config.repositoryIds?.split("/");
  const sub = ids === undefined ? `repo:${owner}/${name}:ref:${BUNDLE_SIGNING_TAG_REF}` : `repo:*@${ids[0]}/*@${ids[1]}:ref:${BUNDLE_SIGNING_TAG_REF}`;
  return { sub, jobWorkflowRef: `${owner}/${name}/${BUNDLE_SIGNING_WORKFLOW_FILE}@${BUNDLE_SIGNING_TAG_REF}` };
}

const KEY_ADMIN_ACTIONS = [
  "kms:Create*", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*", "kms:Update*", "kms:Revoke*", "kms:Disable*", "kms:Get*", "kms:Delete*",
  "kms:TagResource", "kms:UntagResource", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion",
];

export interface BundleSigningStackProps extends StackProps {
  readonly config: BundleSigningConfig;
}

export class BundleSigningStack extends Stack {
  constructor(scope: Construct, id: string, props: BundleSigningStackProps) {
    super(scope, id, props);
    const patterns = bundleSigningTrustPatterns(props.config);
    // Built from the fixed role name, not the role construct, so the key policy and the role never depend on each other (and the key policy never names a principal that does not exist yet).
    const roleArn = `arn:${this.partition}:iam::${this.account}:role/${BUNDLE_SIGNING_ROLE_NAME}`;

    const key = new kms.Key(this, "BundleSigningKey", {
      description: "Signs Rovara Enterprise release bundles (bundle.json). Only the release workflow's bundle job can use it.",
      keySpec: kms.KeySpec.ECC_NIST_P256,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      alias: BUNDLE_SIGNING_KEY_ALIAS,
      // A signing key that is deleted cannot be replaced: every installer pins its public half.
      removalPolicy: RemovalPolicy.RETAIN,
      pendingWindow: Duration.days(30),
      policy: new iam.PolicyDocument({
        statements: [
          // Administration without any cryptographic use or grant: an account administrator can manage the key but cannot Sign or hand out a grant.
          new iam.PolicyStatement({ sid: "KeyAdministrationWithoutUse", principals: [new iam.AccountRootPrincipal()], actions: KEY_ADMIN_ACTIONS, resources: ["*"] }),
          // The one use the key has: the bundle job's role reads the public key and signs. The role's own identity policy must also allow it.
          new iam.PolicyStatement({
            sid: "OnlyTheReleaseRoleSignsAndReadsThePublicKey",
            principals: [new iam.AccountRootPrincipal()],
            actions: ["kms:Sign", "kms:GetPublicKey"],
            resources: ["*"],
            conditions: { StringEquals: { "aws:PrincipalArn": roleArn } },
          }),
          // Belt and braces: whatever an IAM policy or a grant says, no other principal signs.
          new iam.PolicyStatement({
            sid: "DenySignToEveryoneElse",
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ["kms:Sign"],
            resources: ["*"],
            conditions: { StringNotEquals: { "aws:PrincipalArn": roleArn } },
          }),
        ],
      }),
    });

    const role = new iam.Role(this, "BundleSigningRole", {
      roleName: BUNDLE_SIGNING_ROLE_NAME,
      description: "Assumed only by release.yml's bundle job on a version tag, through GitHub OIDC; may Sign with the bundle key and nothing else",
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(props.config.oidcProviderArn, {
        StringEquals: { [`${GITHUB_OIDC_HOST}:aud`]: GITHUB_OIDC_AUDIENCE },
        StringLike: {
          [`${GITHUB_OIDC_HOST}:sub`]: patterns.sub,
          [`${GITHUB_OIDC_HOST}:job_workflow_ref`]: patterns.jobWorkflowRef,
        },
      }),
    });
    role.addToPolicy(new iam.PolicyStatement({ sid: "SignBundleManifest", actions: ["kms:Sign", "kms:GetPublicKey"], resources: [key.keyArn] }));

    new CfnOutput(this, "BundleSigningKeyArn", { value: key.keyArn, description: "Set as the repository variable AGENTX_BUNDLE_KMS_KEY" });
    new CfnOutput(this, "BundleSigningRoleArn", { value: role.roleArn, description: "Set as the repository variable AGENTX_BUNDLE_SIGNING_ROLE_ARN" });
  }
}
