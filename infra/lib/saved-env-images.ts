// Setup and test health SH22 (design setup-test-health.md, section 5.2): the registry side of saved project images.
//
// What this creates, in the control plane's stack, for a named environment:
//   - a KMS key for the images' repositories (or the customer's own key, Enterprise: `kmsKeyArn`), with a narrow key policy: administration without use; ECR's creation role may create the grant ECR
//     needs, through ECR only; nobody else may create a grant; only the deploy role may schedule its deletion;
//   - a REPOSITORY CREATION TEMPLATE for the prefix `rovara-env/<env>`: every repository the first push creates has immutable tags, KMS encryption, a lifecycle policy (untagged out after a day, the newest
//     `keep` kept, nothing past 30 days) and a repository policy that denies the data actions to every principal but the push and pull roles (so the worker role's broad pull grant cannot read an image);
//   - the registry's scan-on-push setting (basic scanning), unless the install turns it off: see `registryScanning`;
//   - three roles the broker assumes, each with a SESSION POLICY naming one repository (contracts `savedEnvPushSessionPolicy` and its two siblings): push, pull, and manage (delete). The roles' own
//     policies reach `rovara-env/<env>/*`, so a session that carried no policy would still reach only this environment's images; the session narrows it to ONE project of ONE org;
//   - the role ECR assumes to create a repository from the template (it holds `ecr:CreateRepository` and the grant on the key, nothing else);
//   - the broker's right to assume the three roles, and nothing on the repositories itself.
//
// There is NO grant on the worker's instance role (ec2-workers.ts is untouched): a worker pulls and pushes with a token the broker minted from a session, for one repository, for 15 minutes.
//
// Not decided by this file: whether the feature is on (the broker's `sv` setting and the project's `savedEnv.enabled`), who an image belongs to (the repository name is a hash of the org and the project),
// or what is in an image (the worker's build). With the feature off nothing pushes, and the empty template and roles cost nothing.
import { Aws, CfnOutput, Stack, aws_ecr as ecr, aws_iam as iam, aws_kms as kms } from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  SAVED_ENV_KEEP_DEFAULT,
  savedEnvLifecyclePolicy,
  savedEnvManageRoleName,
  savedEnvPullRoleName,
  savedEnvPushRoleName,
  savedEnvRepositoriesArn,
  savedEnvRepositoryPolicy,
  savedEnvRepositoryPrefix,
  SAVED_ENV_MANAGE_ACTIONS,
  SAVED_ENV_PULL_ACTIONS,
  SAVED_ENV_PUSH_ACTIONS,
} from "@agentx/contracts";

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
   * an existing registry scanning setting, so an install that has enhanced scanning (Inspector) turns it off with `agentxSavedEnvRegistryScan=off` and scans the `rovara-env/` prefix itself.
   * Default "basic".
   */
  readonly registryScanning?: "basic" | "none";
}

export class SavedEnvImages extends Construct {
  readonly pushRole: iam.Role;
  readonly pullRole: iam.Role;
  readonly manageRole: iam.Role;
  readonly createRole: iam.Role;
  readonly key: kms.Key | undefined;
  readonly kmsKeyArn: string;
  readonly template: ecr.CfnRepositoryCreationTemplate;

  constructor(scope: Construct, id: string, props: SavedEnvImagesProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const { env } = props;
    const prefix = savedEnvRepositoryPrefix(env);
    const scopeOf = { partition: Aws.PARTITION, region: Aws.REGION, account: Aws.ACCOUNT_ID };
    const repositories = savedEnvRepositoriesArn(scopeOf, env);
    const brokerPrincipal = new iam.ArnPrincipal(props.brokerRole.roleArn);

    const sessionRole = (logicalId: string, roleName: string, description: string, actions: readonly string[], withToken: boolean): iam.Role => {
      const role = new iam.Role(this, logicalId, {
        roleName,
        description,
        assumedBy: brokerPrincipal,
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
      if (!/^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{36}$/u.test(props.kmsKeyArn)) throw new Error("saved environment images: kmsKeyArn must be a KMS key ARN (not an alias)");
      this.key = undefined;
      this.kmsKeyArn = props.kmsKeyArn;
      new CfnOutput(this, "KmsKeyPolicyStatements", {
        description: "Add these statements to the saved environment images key policy: ECR's creation role may create the grant ECR uses, and only through ECR.",
        value: stack.toJsonString(this.createRoleKeyStatements(this.createRole.roleArn)),
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
            ...this.createRoleKeyStatements(this.createRole.roleArn).map((statement) => iam.PolicyStatement.fromJson(statement)),
          ],
        }),
      });
      // The key policy lets nobody but the deploy role schedule a deletion: a rolled-back first create keeps the key (the audit ledger's precedent).
      (key.node.defaultChild as kms.CfnKey).addMetadata(KEEP_ON_ROLLBACK_METADATA, true);
      this.key = key;
      this.kmsKeyArn = key.keyArn;
    }

    // ---- the creation template
    // The roles' real ARNs (with the environment's path, wherever the aspect puts them), so the policy names exactly the roles created here.
    const policy = savedEnvRepositoryPolicy({ pushRoleArn: this.pushRole.roleArn, pullRoleArn: this.pullRole.roleArn, manageRoleArn: this.manageRole.roleArn });
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

    if ((props.registryScanning ?? "basic") === "basic") {
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

  /** The key statements for ECR's creation role: it may create the one grant ECR uses, through ECR, and nobody else may create any grant. */
  private createRoleKeyStatements(createRoleArn: string): Array<Record<string, unknown>> {
    return [
      {
        Sid: "CreationRoleGrantForEcr", Effect: "Allow", Principal: { AWS: createRoleArn },
        Action: ["kms:CreateGrant", "kms:DescribeKey"], Resource: "*",
        Condition: { StringEquals: { "kms:ViaService": `ecr.${Aws.REGION}.amazonaws.com` }, Bool: { "kms:GrantIsForAWSResource": "true" } },
      },
      {
        Sid: "DenyOtherGrants", Effect: "Deny", Principal: "*", Action: ["kms:CreateGrant"], Resource: "*",
        Condition: { ArnNotEquals: { "aws:PrincipalArn": createRoleArn } },
      },
    ];
  }
}
