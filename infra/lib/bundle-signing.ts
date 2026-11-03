// SK-4: the key that signs Enterprise release bundles, and the one role meant to use it. Off by default and never part of a release: the owner turns it on once, by hand, with
// `-c agentxBundleSigning=enabled` (docs/enterprise/bundle-signing.md). Without that context key nothing here is synthesised, so every existing template is unchanged.
//
// Why it exists: kit.json's hashes come from the kit itself, so anyone who can run `release:bundle` with a signing permission can sign an edited kit. The answer is that the signing permission is held by
// one job only, the release workflow's `sign` job, which builds nothing:
//   - the role is assumable only through GitHub's OIDC token for that repository (by name and by immutable id), for release.yml on a version tag, in the one GitHub environment that only the sign job
//     uses (so the images and npm jobs, which also have id-token, cannot assume it), for the sts.amazonaws.com audience;
//   - the key policy allows kms:Sign only for that role, and explicitly denies Sign to every other principal.
//
// What this does NOT do: in a shared AWS account, anyone who can edit IAM or the key policy can still re-open the role (UpdateAssumeRolePolicy, delete and re-create the role under the same name,
// PutKeyPolicy). The Deny stops direct signing by an administrator, not that. The real boundary is a dedicated signing account whose organisation SCP denies those calls (docs/enterprise/bundle-signing.md),
// which is why the account id is a required setting and the staging/install account is refused unless the owner says otherwise.
import {
  Annotations,
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
export const BUNDLE_SIGNING_ACCOUNT_CONTEXT_KEY = "agentxBundleSigningAccountId";
export const BUNDLE_SIGNING_ENVIRONMENT_CONTEXT_KEY = "agentxBundleSigningEnvironment";
export const BUNDLE_SIGNING_SHARED_ACCOUNT_CONTEXT_KEY = "agentxBundleSigningAllowSharedAccount";
export const BUNDLE_SIGNING_ROLE_NAME = "rovara-release-bundle-signing";
export const BUNDLE_SIGNING_KEY_ALIAS = "alias/rovara-release-bundle-signing";
export const BUNDLE_SIGNING_WORKFLOW_FILE = ".github/workflows/release.yml";
/** The GitHub environment of the release workflow's sign job (required reviewers, tags only). Only that job runs in it, so only its tokens carry this environment. */
export const BUNDLE_SIGNING_DEFAULT_ENVIRONMENT = "release-signing";
/** The staging/install account. A signing key here shares an account with roles that can edit IAM; allowed only with an explicit override and a synth warning. */
export const STAGING_ACCOUNT_ID = "944937319445";
export const GITHUB_OIDC_HOST = "token.actions.githubusercontent.com";
export const GITHUB_OIDC_AUDIENCE = "sts.amazonaws.com";
/**
 * The release workflow triggers on `v[0-9]+.[0-9]+.[0-9]+`. IAM StringLike has only `*` and `?`, so this is as close as it gets: `v`, something, `.`, something, `.`, something. It still matches a
 * name like `vx.y.z` or `v1.2.3-rc`; the residual is closed by the tag ruleset (who may create v* tags) and the sign job's environment reviewers, not by this pattern.
 */
export const BUNDLE_SIGNING_TAG_PATTERN = "v?*.?*.?*";
export const BUNDLE_SIGNING_TAG_REF = `refs/tags/${BUNDLE_SIGNING_TAG_PATTERN}`;

export interface BundleSigningConfig {
  /** `owner/name`: the repository whose release.yml runs the sign job. */
  readonly repository: string;
  /** `ownerId/repoId`: GitHub's immutable ids for that repository (`gh api repos/<owner>/<repo>` gives id and owner.id). Required: names can be renamed or reclaimed. */
  readonly repositoryIds: string;
  /** The account's existing GitHub OIDC provider (an account can hold one per URL, so it is named, not created). It lives in `accountId`. */
  readonly oidcProviderArn: string;
  /** The AWS account that holds the key and the role. Should be a dedicated signing account. */
  readonly accountId: string;
  /** The GitHub environment of the sign job. */
  readonly environment: string;
  /** True only when the owner overrode the dedicated-account check for the staging/install account. */
  readonly sharedAccountOverride: boolean;
}

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u;
const REPOSITORY_IDS = /^[0-9]{1,20}\/[0-9]{1,20}$/u;
const ACCOUNT_ID = /^[0-9]{12}$/u;
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const OIDC_PROVIDER_ARN = /^arn:aws(?:-[a-z]+)?:iam::([0-9]{12}):oidc-provider\/token\.actions\.githubusercontent\.com$/u;

/** The one parser for the context keys: unset is "off" (undefined); anything half-set or malformed stops the synth. */
export function parseBundleSigningContext(get: (key: string) => unknown, input: { named: boolean }): BundleSigningConfig | undefined {
  const switchValue = get(BUNDLE_SIGNING_SWITCH_CONTEXT_KEY);
  const others = [
    BUNDLE_SIGNING_REPOSITORY_CONTEXT_KEY, BUNDLE_SIGNING_REPOSITORY_IDS_CONTEXT_KEY, BUNDLE_SIGNING_OIDC_PROVIDER_CONTEXT_KEY, BUNDLE_SIGNING_ACCOUNT_CONTEXT_KEY,
    BUNDLE_SIGNING_ENVIRONMENT_CONTEXT_KEY, BUNDLE_SIGNING_SHARED_ACCOUNT_CONTEXT_KEY,
  ].filter((key) => {
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
  const ids = get(BUNDLE_SIGNING_REPOSITORY_IDS_CONTEXT_KEY);
  if (typeof ids !== "string" || !REPOSITORY_IDS.test(ids)) throw new Error(`${BUNDLE_SIGNING_REPOSITORY_IDS_CONTEXT_KEY} must be ownerId/repositoryId, digits only (GitHub's immutable ids; the role trusts them, not just the names)`);
  const accountId = get(BUNDLE_SIGNING_ACCOUNT_CONTEXT_KEY);
  if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)) throw new Error(`${BUNDLE_SIGNING_ACCOUNT_CONTEXT_KEY} must be the 12-digit id of the AWS account that holds the signing key (a dedicated signing account)`);
  const override = get(BUNDLE_SIGNING_SHARED_ACCOUNT_CONTEXT_KEY);
  if (override !== undefined && override !== "" && override !== "true" && override !== "false") throw new Error(`${BUNDLE_SIGNING_SHARED_ACCOUNT_CONTEXT_KEY} must be true or false`);
  if (accountId === STAGING_ACCOUNT_ID && override !== "true") {
    throw new Error(`${BUNDLE_SIGNING_ACCOUNT_CONTEXT_KEY} is the staging/install account (${STAGING_ACCOUNT_ID}): roles there can edit IAM and the key policy, so they could re-open the signing role. Use a dedicated signing account, or set ${BUNDLE_SIGNING_SHARED_ACCOUNT_CONTEXT_KEY}=true to accept that`);
  }
  const provider = get(BUNDLE_SIGNING_OIDC_PROVIDER_CONTEXT_KEY);
  const providerAccount = typeof provider === "string" ? OIDC_PROVIDER_ARN.exec(provider)?.[1] : undefined;
  if (typeof provider !== "string" || providerAccount === undefined) throw new Error(`${BUNDLE_SIGNING_OIDC_PROVIDER_CONTEXT_KEY} must be the ARN of this account's ${GITHUB_OIDC_HOST} OIDC provider`);
  if (providerAccount !== accountId) throw new Error(`${BUNDLE_SIGNING_OIDC_PROVIDER_CONTEXT_KEY} is in account ${providerAccount}, not in the signing account ${accountId}`);
  const rawEnvironment = get(BUNDLE_SIGNING_ENVIRONMENT_CONTEXT_KEY);
  const environment = rawEnvironment === undefined || rawEnvironment === "" ? BUNDLE_SIGNING_DEFAULT_ENVIRONMENT : rawEnvironment;
  if (typeof environment !== "string" || !ENVIRONMENT.test(environment)) throw new Error(`${BUNDLE_SIGNING_ENVIRONMENT_CONTEXT_KEY} must be a plain GitHub environment name (letters, digits, . _ -)`);
  return { repository, repositoryIds: ids, oidcProviderArn: provider, accountId, environment, sharedAccountOverride: accountId === STAGING_ACCOUNT_ID };
}

/** The claim patterns the role trusts. Exported so the tests (and the docs) read the same strings the template holds. */
export function bundleSigningTrustPatterns(config: BundleSigningConfig): { sub: string[]; jobWorkflowRef: string; ref: string; environment: string; repositoryId: string; repositoryOwnerId: string } {
  const [owner, name] = config.repository.split("/") as [string, string];
  const [ownerId, repositoryId] = config.repositoryIds.split("/") as [string, string];
  return {
    // A job in an environment has the environment in its subject. Both subject formats are accepted, by name and by immutable id; the id conditions below are what pin the repository.
    sub: [`repo:${owner}/${name}:environment:${config.environment}`, `repo:*@${ownerId}/*@${repositoryId}:environment:${config.environment}`],
    jobWorkflowRef: `${owner}/${name}/${BUNDLE_SIGNING_WORKFLOW_FILE}@${BUNDLE_SIGNING_TAG_REF}`,
    ref: BUNDLE_SIGNING_TAG_REF,
    environment: config.environment,
    repositoryId,
    repositoryOwnerId: ownerId,
  };
}

// Administration of the key. Deliberately without Sign, Verify, any data-key or encrypt action, or CreateGrant. It does include PutKeyPolicy (a key nobody can fix is worse), which is exactly why the
// dedicated account's SCP, not this list, is the boundary.
const KEY_ADMIN_ACTIONS = [
  "kms:CreateAlias", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:PutKeyPolicy", "kms:Update*", "kms:Revoke*", "kms:Disable*", "kms:Get*", "kms:Delete*",
  "kms:TagResource", "kms:UntagResource", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion",
];

export interface BundleSigningStackProps extends StackProps {
  readonly config: BundleSigningConfig;
}

export class BundleSigningStack extends Stack {
  constructor(scope: Construct, id: string, props: BundleSigningStackProps) {
    super(scope, id, props);
    const patterns = bundleSigningTrustPatterns(props.config);
    if (props.config.sharedAccountOverride) {
      Annotations.of(this).addWarning(`The bundle signing key is in the staging/install account (${STAGING_ACCOUNT_ID}) by override: any role there that can edit IAM or the key policy can re-open the signing role. Use a dedicated signing account (docs/enterprise/bundle-signing.md).`);
    }
    // Built from the fixed role name, not the role construct, so the key policy and the role never depend on each other (and the key policy never names a principal that does not exist yet).
    const roleArn = `arn:${this.partition}:iam::${this.account}:role/${BUNDLE_SIGNING_ROLE_NAME}`;

    const key = new kms.Key(this, "BundleSigningKey", {
      description: "Signs Rovara Enterprise release bundles (bundle.json). Only the release workflow's sign job role can use it.",
      keySpec: kms.KeySpec.ECC_NIST_P256,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      alias: BUNDLE_SIGNING_KEY_ALIAS,
      // A signing key that is deleted cannot be replaced: every installer pins its public half.
      removalPolicy: RemovalPolicy.RETAIN,
      pendingWindow: Duration.days(30),
      policy: new iam.PolicyDocument({
        statements: [
          // Administration without any cryptographic use or grant. An administrator cannot Sign directly, and cannot create a grant; they CAN replace this policy (PutKeyPolicy): see the header.
          new iam.PolicyStatement({ sid: "KeyAdministrationWithoutUse", principals: [new iam.AccountRootPrincipal()], actions: KEY_ADMIN_ACTIONS, resources: ["*"] }),
          // The one use the key has: the bundle job's role reads the public key and signs. The role's own identity policy must also allow it.
          new iam.PolicyStatement({
            sid: "OnlyTheReleaseRoleSignsAndReadsThePublicKey",
            principals: [new iam.AccountRootPrincipal()],
            actions: ["kms:Sign", "kms:GetPublicKey"],
            resources: ["*"],
            conditions: { StringEquals: { "aws:PrincipalArn": roleArn } },
          }),
          // Belt and braces: whatever an IAM policy or a grant says, no other principal signs directly (the Deny applies to grants too). It does not stop someone who can replace this policy or the role.
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
      description: "Assumed only by release.yml's sign job (its GitHub environment, a version tag), through GitHub OIDC; may Sign with the bundle key and nothing else",
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(props.config.oidcProviderArn, {
        StringEquals: {
          [`${GITHUB_OIDC_HOST}:aud`]: GITHUB_OIDC_AUDIENCE,
          [`${GITHUB_OIDC_HOST}:repository_id`]: patterns.repositoryId,
          [`${GITHUB_OIDC_HOST}:repository_owner_id`]: patterns.repositoryOwnerId,
          [`${GITHUB_OIDC_HOST}:environment`]: patterns.environment,
        },
        StringLike: {
          [`${GITHUB_OIDC_HOST}:sub`]: patterns.sub,
          [`${GITHUB_OIDC_HOST}:job_workflow_ref`]: patterns.jobWorkflowRef,
          [`${GITHUB_OIDC_HOST}:ref`]: patterns.ref,
        },
      }),
    });
    role.addToPolicy(new iam.PolicyStatement({ sid: "SignBundleManifest", actions: ["kms:Sign", "kms:GetPublicKey"], resources: [key.keyArn] }));

    new CfnOutput(this, "BundleSigningKeyArn", { value: key.keyArn, description: "Set as the repository variable AGENTX_BUNDLE_KMS_KEY" });
    new CfnOutput(this, "BundleSigningRoleArn", { value: role.roleArn, description: "Set as the repository variable AGENTX_BUNDLE_SIGNING_ROLE_ARN" });
  }
}
