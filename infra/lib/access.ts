import { Aws, CfnCondition, CfnRule, CfnOutput, CfnParameter, Duration, Fn, RemovalPolicy, Stack, Validations, type StackProps } from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { defaultBoundaryName, defaultBoundaryStatements, environmentRolePath, operatorRoleStatements, serviceRoleStatements, withoutSids } from "./access-policies.js";
import type { AgentXNaming } from "./naming.js";
import { OperatorAccess, type OperatorAccessSettings } from "./operator-access.js";
import { CUSTOM_DOMAIN_NAME_PATTERN, CUSTOM_DOMAIN_ZONE_PATTERN } from "./custom-domain-patterns.js";
import { applyPermissionsBoundaryParameter } from "./permissions-boundary.js";

export interface AccessStackProps extends StackProps {
  naming: AgentXNaming;
  /**
   * The id of Rovara's own AWS Organization, from the `agentxRovaraOrgId` context value, never from source. When set, the default boundary's AssumeOrgRoles
   * statement also excludes every account of that organization; when not, it excludes this account only (the fallback).
   */
  rovaraOrganizationId?: string;
  /**
   * Enterprise installs: the ECR repositories the signed release bundle's images are loaded into (`rovara-bundle/<name>`). They live here, in the stack that is
   * deployed first, so `rovara upgrade --bundle` can load the images before any stack that runs them. Immutable tags, scanned on push, kept when the stack goes.
   */
  bundleImageRepositories?: readonly string[];
  /**
   * Enterprise installs under a managed-VPC agreement (task N6): the standing Rovara operator role, its approval bucket, the alert on every use and the
   * customer's suspend switch. Absent: none of it exists (Public, and every Enterprise install that does not ask for it).
   */
  operatorAccess?: OperatorAccessSettings;
  /**
   * The hosted cloud (agentxCloud context): the stack takes the control plane's custom domain name and hosted zone as parameters (both empty by default), and the deploy
   * role is granted Certificate Manager and Route 53 access for that name and that zone only while they are set. Without the context the stack is unchanged.
   */
  cloud?: boolean;
}

/**
 * The one template a platform team deploys and reviews for an environment: the artifact bucket,
 * the ECR pull-through cache rule, the role CloudFormation assumes to deploy every other stack, and
 * the role operators assume to run `agentx`. The service role cannot deploy its own stack, so these
 * live apart from the rest.
 */
export class AccessStack extends Stack {
  constructor(scope: Construct, id: string, props: AccessStackProps) {
    super(scope, id, props);
    const { naming, rovaraOrganizationId, bundleImageRepositories, operatorAccess, cloud } = props;
    const env = naming.env;
    if (env === undefined) throw new Error("the access stack exists only for named environments");
    const ecsFailureRuleArn = Fn.sub(`arn:${"${AWS::Partition}"}:events:${"${AWS::Region}"}:${"${AWS::AccountId}"}:rule/agentx-${env}-*-service-failures`);

    // The default boundary applies whenever the company gives none, so every AgentX role always has
    // one. It exists only under UseDefaultBoundary; the roles and the Deny statements Ref it inside
    // the Fn::If's else branch, which is valid for a conditional resource (the branch is evaluated
    // only when the resource exists) and makes CloudFormation create the policy before the roles.
    // A DependsOn would not do: DependsOn on a resource whose condition is false fails the stack.
    const { effectiveBoundaryArn } = applyPermissionsBoundaryParameter(this, env, {
      defaultBoundary: (hasPermissionsBoundary) => {
        const useDefaultBoundary = new CfnCondition(this, "UseDefaultBoundary", {
          expression: Fn.conditionNot(hasPermissionsBoundary),
        });
        const policy = new iam.CfnManagedPolicy(this, "DefaultPermissionsBoundary", {
          managedPolicyName: defaultBoundaryName(env),
          path: environmentRolePath(env),
          description: `Default permission boundary for every agentx-${env} role`,
          policyDocument: {
            Version: "2012-10-17",
            Statement: withoutSids(defaultBoundaryStatements({ env, partition: Aws.PARTITION, region: Aws.REGION, account: this.account, cloudFormationRoleName: naming.cloudFormationRoleName, ...(rovaraOrganizationId === undefined ? {} : { rovaraOrganizationId }) })
              // withoutSids: the deployed boundary is capped at 6,144 characters; the tests find statements by Sid in defaultBoundaryStatements.
              .map((statement) => statement.Sid === "EcsFailureEventsRule" ? { ...statement, Resource: ecsFailureRuleArn } : statement)),
          },
        });
        policy.cfnOptions.condition = useDefaultBoundary;
        return policy.ref;
      },
    });
    const operatorPrincipalArn = new CfnParameter(this, "OperatorPrincipalArn", {
      type: "String",
      default: "",
      allowedPattern: "^$|^arn:aws[a-z-]*:iam::[0-9]{12}:(root|role/.+|user/.+)$",
      description: "Optional operator-role principal; empty trusts account root",
    });
    const hasOperatorPrincipal = new CfnCondition(this, "HasOperatorPrincipal", {
      expression: Fn.conditionNot(Fn.conditionEquals(operatorPrincipalArn.valueAsString, "")),
    });

    const bucket = new s3.Bucket(this, "ArtifactBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30) }],
      // Retained: release artifacts must outlive a stack deletion.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    new ecr.CfnPullThroughCacheRule(this, "PullThroughCacheRule", {
      ecrRepositoryPrefix: naming.pullThroughPrefix,
      upstreamRegistryUrl: "public.ecr.aws",
    });

    for (const repositoryName of bundleImageRepositories ?? []) {
      const repository = new ecr.CfnRepository(this, `BundleImage${repositoryName.replace(/[^A-Za-z0-9]/g, "")}`, {
        repositoryName,
        imageTagMutability: "IMMUTABLE",
        imageScanningConfiguration: { scanOnPush: true },
      });
      repository.applyRemovalPolicy(RemovalPolicy.RETAIN);
    }

    // 0.5.7: the same two parameters the control-plane stack takes (infra/lib/custom-domain.ts), so the deploy role's grants name exactly this domain and zone.
    // The grants exist only while both are set (each statement is an Fn::If below); with the defaults the role has none of them.
    const customDomainParameters = cloud !== true ? undefined : {
      name: new CfnParameter(this, "CustomDomainName", { type: "String", default: "", allowedPattern: CUSTOM_DOMAIN_NAME_PATTERN, maxLength: 64, description: "The control plane's custom domain name; the deploy role may request a certificate for it. Empty: none" }),
      zone: new CfnParameter(this, "CustomDomainHostedZoneId", { type: "String", default: "", allowedPattern: CUSTOM_DOMAIN_ZONE_PATTERN, description: "The Route 53 hosted zone that holds the custom domain's DNS; the deploy role may change records in this zone only. Empty: none" }),
    };
    // One without the other would silently grant nothing (the condition below needs both): refuse it, as the control-plane stack does.
    if (customDomainParameters !== undefined) {
      const { name, zone } = customDomainParameters;
      new CfnRule(this, "CustomDomainNeedsBothOrNeither", {
        assertions: [{
          assert: Fn.conditionOr(
            Fn.conditionAnd(Fn.conditionEquals(name.valueAsString, ""), Fn.conditionEquals(zone.valueAsString, "")),
            Fn.conditionAnd(Fn.conditionNot(Fn.conditionEquals(name.valueAsString, "")), Fn.conditionNot(Fn.conditionEquals(zone.valueAsString, ""))),
          ),
          assertDescription: "CustomDomainName and CustomDomainHostedZoneId go together: set both, or leave both empty",
        }],
      });
    }
    const customDomainSet = customDomainParameters === undefined ? undefined : new CfnCondition(this, "CustomDomainEnabled", {
      expression: Fn.conditionAnd(Fn.conditionNot(Fn.conditionEquals(customDomainParameters.name.valueAsString, "")), Fn.conditionNot(Fn.conditionEquals(customDomainParameters.zone.valueAsString, ""))),
    });
    const customDomain = customDomainParameters === undefined ? undefined : { domainName: customDomainParameters.name.valueAsString, hostedZoneId: customDomainParameters.zone.valueAsString };
    const policyScope = {
      env,
      partition: Aws.PARTITION,
      // Aws.REGION, not this.region: the stack's env pins a region for synthesis, but the released
      // template must deploy into whichever region the operator picks.
      region: Aws.REGION,
      account: this.account,
      artifactBucketArn: bucket.bucketArn,
      pullThroughPrefix: naming.pullThroughPrefix,
      cloudFormationRoleName: naming.cloudFormationRoleName,
      ...(customDomain === undefined ? {} : { customDomain }),
    };
    // The boundary Deny statements always apply and name the effective boundary.
    // The deployed deploy policy carries no Sids, as the deployed boundary does (withoutSids): a role's inline policies are capped at 10,240 characters (non-whitespace) in all, and with a custom domain the Sids
    // (about 1,000 characters) were the difference. Sids are optional and grant nothing; the tests find statements by Sid in serviceRoleStatements and put them back by position (tests/support/deployed-service-role.ts).
    const serviceStatements = serviceRoleStatements({ ...policyScope, permissionsBoundaryArn: effectiveBoundaryArn })
      .map((statement) => statement.Sid === "EcsFailureEventsRule" ? { ...statement, Resource: ecsFailureRuleArn } : statement)
      .map(({ Sid, ...statement }) => customDomainSet !== undefined && Sid.startsWith("CustomDomain") ? Fn.conditionIf(customDomainSet.logicalId, statement, Aws.NO_VALUE) : statement);

    // Built before the deploy role, which gains the one statement it needs to read the templates the customer approved.
    const operatorAccessConstruct = operatorAccess === undefined ? undefined : new OperatorAccess(this, "RovaraOperatorAccess", { naming, settings: operatorAccess });

    const serviceRole = new iam.CfnRole(this, "CloudFormationServiceRole", {
      roleName: naming.cloudFormationRoleName,
      description: `CloudFormation deployment role for ${env}`,
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "cloudformation.amazonaws.com" },
            Action: "sts:AssumeRole",
            Condition: { StringEquals: { "aws:SourceAccount": this.account } },
          },
        ],
      },
      policies: [
        { policyName: "deploy", policyDocument: { Version: "2012-10-17", Statement: serviceStatements } },
        ...(operatorAccessConstruct === undefined ? [] : [operatorAccessConstruct.deployRoleReadPolicy]),
      ],
    });

    const operatorRole = new iam.CfnRole(this, "OperatorRole", {
      roleName: naming.operatorRoleName,
      description: `AgentX operator role for ${env}`,
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: {
              AWS: Fn.conditionIf(
                hasOperatorPrincipal.logicalId,
                operatorPrincipalArn.valueAsString,
                `arn:${Aws.PARTITION}:iam::${this.account}:root`,
              ),
            },
            Action: "sts:AssumeRole",
          },
        ],
      },
      maxSessionDuration: 3600,
      policies: [{ policyName: "operate", policyDocument: { Version: "2012-10-17", Statement: operatorRoleStatements(policyScope) } }],
    });

    new CfnOutput(this, "ArtifactBucketName", { value: bucket.bucketName });
    new CfnOutput(this, "CloudFormationRoleArn", { value: serviceRole.attrArn });
    new CfnOutput(this, "OperatorRoleArn", { value: operatorRole.attrArn });
    const effectiveBoundaryOutput = new CfnOutput(this, "EffectiveBoundaryArn", { value: effectiveBoundaryArn });
    // The validator does not see that the Fn::If takes the Ref branch only under UseDefaultBoundary.
    Validations.of(effectiveBoundaryOutput).acknowledge({
      id: "CloudFormation-Validate::W1001",
      reason: "The Ref to DefaultPermissionsBoundary is in the Fn::If branch taken only when UseDefaultBoundary holds",
    });
    new CfnOutput(this, "PullThroughPrefix", { value: naming.pullThroughPrefix });
  }
}
