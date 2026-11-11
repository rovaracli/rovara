// Setup and test health SH22 (design setup-test-health.md, section 5.2): the registry side of saved project images.
//
// What this creates, in the control plane's stack, for a named environment:
//   - a KMS key for the images' repositories (or the customer's own key, Enterprise: `kmsKeyArn`), with a narrow key policy: administration without use; ECR's creation role may create the grant ECR
//     needs, through ECR only; nobody else may create a grant; only the deploy role may schedule its deletion;
//   - a REPOSITORY CREATION TEMPLATE for the prefix `rovara-env/<env>`: every repository the first push creates has immutable tags, KMS encryption, a lifecycle policy (untagged out after a day, a count BACKSTOP of `keep` plus 3 images: the broker's walk keeps exactly the images its row names; the 30 day age ceiling is the broker's manage walk, SH24: ECR cannot express it next to a count rule) and a repository policy that denies the data actions to every principal but the push and pull roles (so the worker role's broad pull grant cannot read an image);
//   - OPTIONAL, OFF by default: the registry-wide scan-on-push setting (`registryScanning: "basic"`, context `agentxSavedEnvRegistryScan=on`). It is ONE setting for the whole registry and replaces an existing one
//     (an account with Inspector enhanced scanning would lose it), so it is opt-in. Instead the push role may start a basic scan of its one repository (`ecr:StartImageScan`) and the broker does so after each push (SH24);
//   - three roles the broker assumes, each with a SESSION POLICY naming one repository (contracts `savedEnvPushSessionPolicy` and its two siblings): push, pull, and manage (delete). The roles' own
//     policies reach `rovara-env/<env>/*`, so a session that carried no policy would still reach only this environment's images; the session narrows it to ONE project of ONE org;
//   - the role ECR assumes to create a repository from the template (it holds `ecr:CreateRepository` and the grant on the key, nothing else). It has a FIXED name, `agentx-<env>-img-create`, so an Enterprise install
//     can name it in its own key policy;
//   - the broker's right to assume the three roles, and nothing on the repositories itself.
//
// There is NO grant on the worker's instance role (ec2-workers.ts is untouched): a worker pulls and pushes with a token the broker minted from a session, for one repository, for the session lengths in contracts (push 60 minutes, pull 30).
//
// ENTERPRISE NOTES
//   - The key must be DEDICATED to these repositories: the statements this install prints for it let ECR's creation role create a grant, and the Deny on `kms:CreateGrant` for every other principal would break any
//     other use of a shared key. The key must be in this account and region.
//   - The repository policy denies image reads to every principal but the push and pull roles. That includes the Inspector (enhanced scanning) service-linked role, `AWSServiceRoleForAmazonInspector2`: an account that
//     turns on enhanced scanning for these repositories must add an Allow for that role's ARN to the repository policy in `savedEnvRepositoryPolicy` (it is not added here, so Rovara's default stays "nobody else").
//     Basic scanning, which this install uses, is not affected.
//
// Not decided by this file: whether the feature is on (the broker's `sv` setting and the project's `savedEnv.enabled`), who an image belongs to (the repository name is a hash of the org and the project),
// or what is in an image (the worker's build). With the feature off nothing pushes, and the empty template and roles cost nothing.
import { Aws, CfnOutput, Duration, Stack, Token, aws_ecr as ecr, aws_iam as iam, aws_kms as kms } from "aws-cdk-lib";
import { Construct } from "constructs";
import { SAVED_ENV_KEEP_DEFAULT, SAVED_ENV_PUSH_SESSION_SECONDS, savedEnvCreateRoleName, savedEnvLifecyclePolicy, savedEnvManageRoleName, savedEnvPullRoleName, savedEnvPushRoleName, savedEnvRepositoriesArn, savedEnvRepositoryPrefix, SAVED_ENV_MANAGE_ACTIONS, SAVED_ENV_PULL_ACTIONS, SAVED_ENV_PUSH_ACTIONS } from "@rovara-code/contracts";
import { savedEnvRepositoryPolicy } from "@agentx/cloud-contracts";

const KEEP_ON_ROLLBACK_METADATA = "agentx:retain-on-create-rollback";

/** Called by the control plane for a named environment. Nothing here depends on a switch: with the feature off no repository is ever created. */
export function attachSavedEnvImages(scope: Construct, props: SavedEnvImagesProps): SavedEnvImages {
  return new SavedEnvImages(scope, "SavedEnvImages", props);
}

export interface SavedEnvImagesProps {
  /** The named environment (`staging`, `prod`). */
  readonly env: string;
  /** The role the broker runs as: the three roles trust it, and it may assume them. */
  readonly brokerRole: iam.IRole;
  /** The name of the role CloudFormation deploys with: the only principal that may schedule the key's deletion. */
  readonly cloudFormationRoleName: string;
  /** Enterprise: the customer's own key, in this account and region. The install prints the statements its key policy must hold. Absent: this construct makes the key. */
  readonly kmsKeyArn?: string;
  /** Images kept per project (the company setting `savedEnv.keep`, 1 to 10). Default 3. */
  readonly keep?: number;
  /**
   * Basic scan on push for the registry (`AWS::ECR::RegistryScanningConfiguration`). It is ONE setting for the whole registry, not for this prefix: it scans every repository on push and replaces
   * an existing registry scanning setting (an account with enhanced scanning would lose it). OFF by default; `agentxSavedEnvRegistryScan=on` turns it on. The broker starts a scan of the one repository after
   * each push either way (SH24).
   * Default "none".
   */
  readonly registryScanning?: "basic" | "none";
  /**
   * The company image mirror's own role (infra/lib/company-image-mirror.ts): the repository policy lets it read, write and delete in the repositories its IAM policy reaches (`o?/c?`, mirror repositories only).
   * The push and manage roles stay the broker's alone.
   */
  readonly mirrorRoleArn?: string;
}

export class SavedEnvImages extends Construct {
  readonly pushRole: iam.Role;
  readonly pullRole: iam.Role;
  readonly manageRole: iam.Role;
  readonly createRole: iam.Role;
  readonly key: kms.Key | undefined;
  readonly kmsKeyArn: string;
  /** The key's id (a token for the stack's own key; read from the ARN for a customer's): the broker is passed this, and builds the ARN from the region and the account. */
  readonly kmsKeyId: string;
  readonly template: ecr.CfnRepositoryCreationTemplate;
  private readonly envName: string;

  constructor(scope: Construct, id: string, props: SavedEnvImagesProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const { env } = props;
    this.envName = env;
    const prefix = savedEnvRepositoryPrefix(env);
    const scopeOf = { partition: Aws.PARTITION, region: Aws.REGION, account: Aws.ACCOUNT_ID };
    const repositories = savedEnvRepositoriesArn(scopeOf, env);
    const brokerPrincipal = new iam.ArnPrincipal(props.brokerRole.roleArn);

    const sessionRole = (logicalId: string, roleName: string, description: string, actions: readonly string[], withToken: boolean): iam.Role => {
      const role = new iam.Role(this, logicalId, {
        roleName,
        description,
        assumedBy: brokerPrincipal,
        // The longest session any of them is minted for is the push's 3,600 seconds (the chained-role maximum); the session policy and the duration the broker asks for narrow it.
        maxSessionDuration: Duration.seconds(SAVED_ENV_PUSH_SESSION_SECONDS),
      });
      if (withToken) role.addToPolicy(new iam.PolicyStatement({ sid: "RegistryToken", actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }));
      role.addToPolicy(new iam.PolicyStatement({ sid: "ThisEnvironmentsImages", actions: [...actions], resources: [repositories] }));
      return role;
    };
    this.pushRole = sessionRole("PushRole", savedEnvPushRoleName(env), "Rovara saved environment images: the broker assumes this with a one-repository session policy to push an image", SAVED_ENV_PUSH_ACTIONS, true);
    this.pullRole = sessionRole("PullRole", savedEnvPullRoleName(env), "Rovara saved environment images: the broker assumes this with a one-repository session policy to pull an image", SAVED_ENV_PULL_ACTIONS, true);
    this.manageRole = sessionRole("ManageRole", savedEnvManageRoleName(env), "Rovara saved environment images: the broker assumes this with a one-repository session policy to list and delete images", SAVED_ENV_MANAGE_ACTIONS, false);

    // The role ECR assumes to create a repository from the template. Only ECR may assume it; it may create repositories under the prefix and apply the policy, lifecycle and tags the template carries.
    this.createRole = new iam.Role(this, "CreateRole", {
      roleName: savedEnvCreateRoleName(env),
      // The root path, not the environment's: the template's CustomRoleArn must match ^arn:aws[-a-z0-9]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,-.@_]*$, which has no room for a path
      // (staging, 2026-11-03: "CustomRoleArn: failed validation constraint for keyword [pattern]"). EnvironmentRolePath leaves a role that asks for "/" where it is, and the deploy role
      // and the boundary name this one ARN (rootPathRoles in access-policies).
      path: "/",
      description: "Rovara saved environment images: ECR assumes this to create a repository from the creation template",
      assumedBy: new iam.ServicePrincipal("ecr.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID } } }),
    });
    this.createRole.addToPolicy(new iam.PolicyStatement({
      sid: "CreateUnderThePrefix",
      actions: ["ecr:CreateRepository", "ecr:TagResource", "ecr:SetRepositoryPolicy", "ecr:PutLifecyclePolicy", "ecr:PutImageTagMutability"],
      resources: [repositories],
    }));

    // ---- the key
    if (props.kmsKeyArn !== undefined) {
      const parsed = /^arn:aws[a-z-]*:kms:([a-z0-9-]+):(\d{12}):key\/(?:mrk-[0-9a-f]{32}|[0-9a-f-]{36})$/u.exec(props.kmsKeyArn);
      if (parsed === null) throw new Error("saved environment images: kmsKeyArn must be a KMS key ARN (not an alias)");
      // The key must be in this account and region (checked when they are concrete; the control plane's own stack may leave them to deploy time).
      if ((!Token.isUnresolved(stack.region) && parsed[1] !== stack.region) || (!Token.isUnresolved(stack.account) && parsed[2] !== stack.account)) throw new Error("saved environment images: kmsKeyArn must be a key in this install's own account and region");
      this.key = undefined;
      this.kmsKeyArn = props.kmsKeyArn;
      this.kmsKeyId = props.kmsKeyArn.slice(props.kmsKeyArn.lastIndexOf("/") + 1);
      // The role may use the customer's key through ECR to create the grant. Its identity policy carries the right; the key policy (the statements printed below) opens the key to the account's IAM policies for
      // this one role, and works before the role exists (a named principal that does not exist yet is refused by KMS; a condition on aws:PrincipalArn is not).
      // Two statements (SV-2): the grant-only condition key GrantIsForAWSResource never matches a DescribeKey request.
      this.createRole.addToPolicy(new iam.PolicyStatement({
        sid: "CustomerKeyGrantForEcr", actions: ["kms:CreateGrant"], resources: [props.kmsKeyArn],
        conditions: { StringEquals: { "kms:ViaService": `ecr.${Aws.REGION}.amazonaws.com` }, Bool: { "kms:GrantIsForAWSResource": "true" } },
      }));
      this.createRole.addToPolicy(new iam.PolicyStatement({
        sid: "CustomerKeyDescribeForEcr", actions: ["kms:DescribeKey"], resources: [props.kmsKeyArn],
        conditions: { StringEquals: { "kms:ViaService": `ecr.${Aws.REGION}.amazonaws.com` } },
      }));
      new CfnOutput(this, "KmsKeyPolicyStatements", {
        description: "Add these statements to the DEDICATED saved environment images key policy (the key must be used for nothing else): ECR's creation role may create the grant ECR uses, only through ECR, and no other principal may create a grant.",
        value: stack.toJsonString(this.createRoleKeyStatements(this.createRoleArn, true)),
      });
    } else {
      const key = new kms.Key(this, "ImagesKey", {
        description: "Rovara saved environment images: encrypts the repositories under the creation template",
        enableKeyRotation: true,
        policy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              // Administration without use: no Decrypt, Encrypt or GenerateDataKey, and `kms:CreateAlias` instead of `kms:Create*` (that would include kms:CreateGrant).
              sid: "AdminWithoutUse",
              principals: [new iam.AccountRootPrincipal()],
              actions: ["kms:CreateAlias", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*", "kms:Update*", "kms:Revoke*", "kms:Get*", "kms:TagResource", "kms:UntagResource", "kms:CancelKeyDeletion"],
              resources: ["*"],
            }),
            new iam.PolicyStatement({
              sid: "DenyDestroy",
              effect: iam.Effect.DENY,
              principals: [new iam.AnyPrincipal()],
              actions: ["kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:PutKeyPolicy"],
              resources: ["*"],
              // The deploy role lives at the root path (the access stack's roles do).
              conditions: { ArnNotEquals: { "aws:PrincipalArn": `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/${props.cloudFormationRoleName}` } },
            }),
            ...this.createRoleKeyStatements(this.createRole.roleArn, false).map((statement) => iam.PolicyStatement.fromJson(statement)),
          ],
        }),
      });
      // The key policy lets nobody but the deploy role schedule a deletion: a rolled-back first create keeps the key (the audit ledger's precedent).
      (key.node.defaultChild as kms.CfnKey).addMetadata(KEEP_ON_ROLLBACK_METADATA, true);
      this.key = key;
      this.kmsKeyArn = key.keyArn;
      this.kmsKeyId = key.keyId;
    }

    // ---- the creation template
    // The roles' real ARNs (the push, pull and manage roles carry the environment's path, wherever the aspect puts them), so the policy names exactly the roles created here.
    const policy = savedEnvRepositoryPolicy({ pushRoleArn: this.pushRole.roleArn, pullRoleArn: this.pullRole.roleArn, manageRoleArn: this.manageRole.roleArn, ...(props.mirrorRoleArn === undefined ? {} : { mirrorRoleArn: props.mirrorRoleArn }) });
    this.template = new ecr.CfnRepositoryCreationTemplate(this, "CreationTemplate", {
      prefix,
      appliedFor: ["CREATE_ON_PUSH"],
      description: "Rovara saved environment images: immutable tags, KMS, keep the newest images, data actions for the push and pull roles only",
      imageTagMutability: "IMMUTABLE",
      encryptionConfiguration: { encryptionType: "KMS", kmsKey: this.kmsKeyArn },
      lifecyclePolicy: JSON.stringify(savedEnvLifecyclePolicy(props.keep ?? SAVED_ENV_KEEP_DEFAULT)),
      repositoryPolicy: stack.toJsonString(policy),
      customRoleArn: this.createRole.roleArn,
      resourceTags: [{ key: "agentx:env", value: env }, { key: "rovara:purpose", value: "saved-environment-image" }],
    });
    // The repository policy names the roles by ARN, and the template must not be created before they exist.
    this.template.node.addDependency(this.pushRole, this.pullRole, this.manageRole, this.createRole);

    if (props.registryScanning === "basic") {
      new ecr.CfnRegistryScanningConfiguration(this, "ScanOnPush", {
        scanType: "BASIC",
        rules: [{ scanFrequency: "SCAN_ON_PUSH", repositoryFilters: [{ filter: "*", filterType: "WILDCARD" }] }],
      });
    }

    // ---- the broker: assume the three roles, and nothing on the repositories itself
    props.brokerRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: "AssumeSavedEnvImageRoles",
      actions: ["sts:AssumeRole"],
      resources: [this.pushRole.roleArn, this.pullRole.roleArn, this.manageRole.roleArn],
    }));
  }

  /** The creation role's ARN from its fixed name (it sits at the root path), known before the role exists. */
  private get createRoleArn(): string {
    return `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/${savedEnvCreateRoleName(this.envName)}`;
  }

  /**
   * The key statements for ECR's creation role: it may create the one grant ECR uses and describe the key, both only through ECR, and nobody else may create any grant.
   * Two allow statements, not one (SV-2): kms:GrantIsForAWSResource is a condition key of the grant actions only (CreateGrant, ListGrants, RevokeGrant); a DescribeKey request does not carry it,
   * so a Bool condition on it never matches DescribeKey. Each action gets exactly the conditions that apply to it.
   */
  private createRoleKeyStatements(createRoleArn: string, beforeTheRoleExists: boolean): Array<Record<string, unknown>> {
    const viaEcr = { "kms:ViaService": `ecr.${Aws.REGION}.amazonaws.com` };
    // Before the role exists the principal is the account root narrowed by aws:PrincipalArn (KMS refuses a named principal that does not exist yet); after, the role itself.
    const who = beforeTheRoleExists
      ? { principal: { AWS: `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:root` }, only: { ArnEquals: { "aws:PrincipalArn": createRoleArn } } }
      : { principal: { AWS: createRoleArn }, only: {} };
    return [
      {
        Sid: "CreationRoleGrantForEcr", Effect: "Allow", Principal: who.principal, Action: ["kms:CreateGrant"], Resource: "*",
        Condition: { StringEquals: viaEcr, Bool: { "kms:GrantIsForAWSResource": "true" }, ...who.only },
      },
      {
        Sid: "CreationRoleDescribeForEcr", Effect: "Allow", Principal: who.principal, Action: ["kms:DescribeKey"], Resource: "*",
        Condition: { StringEquals: viaEcr, ...who.only },
      },
      {
        Sid: "DenyOtherGrants", Effect: "Deny", Principal: "*", Action: ["kms:CreateGrant"], Resource: "*",
        Condition: { ArnNotEquals: { "aws:PrincipalArn": createRoleArn } },
      },
    ];
  }
}
