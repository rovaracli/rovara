import { Aspects, CfnResource, Stack, type IAspect } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { IConstruct } from "constructs";
import { RESOURCE_PREFIX, environmentSettingsPrefix } from "@agentx/contracts";

/**
 * Rovara Cloud's permissions boundary (owner decision 2026-11-17, matching Rovara Code's agentx-<env>-boundary): the most any role a
 * Cloud stack makes can ever do, whatever its own policy says. Every AWS::IAM::Role in a Cloud stack (the server and redirect
 * functions, the gateway's task, execution, events, Vertex and Bedrock broker roles, the release pipeline's roles, and the roles CDK
 * makes for its own custom resources such as BucketDeployment) carries it, set by an aspect, so a role added later carries it too.
 *
 * One boundary per environment: the statements depend only on the environment (and the account, region and partition), never on which
 * switches a stack was synthesized with. Each stack holds its own copy as a customer-managed policy, named per stack, so a stack never
 * waits on another stack or app for its boundary (the controller deploys each stack on its own, by change set) and two apps never fight
 * over one policy.
 *
 * Resources are named where Cloud names them (secrets, settings, CodeBuild projects, the bootstrap roles, the broker role) and by the
 * stack-name prefix where CloudFormation generates the name (`<stack name>-<logical id>-<random>`: tables, buckets, log groups,
 * functions, the image repository). KMS keys, task definitions and Bedrock profiles have generated ids: those are held to this
 * account and region (KMS key policies are the real gate for the keys).
 */

/** The IAM path of the boundary policies, and of the gateway's roles (see ROLE_PATH_PARTS). */
export function cloudRolePath(env: string): string {
  // environmentSettingsPrefix validates the name and gives `/rovara-cloud/<env>/`.
  return environmentSettingsPrefix(env);
}

/** What a Cloud stack is: the suffix of its stack name, rovara-cloud-<env>-<part>. */
export type CloudStackPart = "web" | "app" | "pipeline" | "gateway-images" | "gateway";
export const CLOUD_STACK_PARTS: readonly CloudStackPart[] = ["web", "app", "pipeline", "gateway-images", "gateway"];

/**
 * The parts whose roles live under cloudRolePath. A role's path can't change in place (CloudFormation replaces the role), so the stacks
 * already deployed on staging with roles at "/" (web, app) keep "/". The gateway had no live roles when this was made (the staging
 * gateway create rolled back on 2026-11-16 with no role retained). The pipeline keeps "/" too: CDK names its CodeBuild projects'
 * service role by name (Ref), which CodeBuild reads as a role at "/" (cfn-lint E3050). A role with a fixed name (the Bedrock broker,
 * whose ARN every customer's trust policy names) keeps "/" wherever it is.
 */
export const ROLE_PATH_PARTS: ReadonlySet<CloudStackPart> = new Set(["gateway", "gateway-images"]);

export function cloudBoundaryName(env: string, part: CloudStackPart): string {
  return `${RESOURCE_PREFIX}-${env}-${part}-boundary`;
}

export interface BoundaryScope {
  readonly env: string;
  readonly partition: string;
  readonly region: string;
  readonly account: string;
}

export interface BoundaryStatement {
  readonly Sid: string;
  readonly Effect: "Allow" | "Deny";
  readonly Action: string[];
  readonly Resource: string[];
}

/** The CDK bootstrap roles `cdk deploy` assumes from the release pipeline's deploy job: never the CloudFormation execution role. */
export const CDK_BOOTSTRAP_ASSUMED_ROLES = ["deploy-role", "file-publishing-role", "image-publishing-role", "lookup-role"] as const;
export const CDK_BOOTSTRAP_QUALIFIER = "hnb659fds";

/** The customers' roles the Bedrock broker assumes (packages/model-gateway bedrock-byo.ts; model-gateway.ts holds the two equal). */
const BYO_CUSTOMER_ROLE_PREFIX = "RovaraBedrockInvoke-";
const BYO_BROKER_ROLE_PREFIX = "RovaraBedrockBroker-";

/** The boundary's statements for one environment. Pure: tests and the controller's simulation call it with plain strings. */
export function cloudBoundaryStatements(scope: BoundaryScope): BoundaryStatement[] {
  const { env, partition: p, region: r, account: a } = scope;
  const path = cloudRolePath(env);
  const stack = (part: string) => `${RESOURCE_PREFIX}-${env}-${part}`;
  // Generated names start with the stack name; one entry per stack, never `rovara-cloud-<env>-*` (that would match an environment
  // named <env>-eu as well).
  const generated = (prefix: (stackName: string) => string, parts: readonly string[]) => parts.map((part) => prefix(stack(part)));
  const projects = ["deploy", "check"].map((what) => `${RESOURCE_PREFIX}-${env}-${what}`);
  return [
    {
      Sid: "Logs", Effect: "Allow",
      Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      Resource: [
        ...generated((s) => `arn:${p}:logs:${r}:${a}:log-group:${s}-*`, ["web", "app", "pipeline", "gateway"]),
        // CDK's BucketDeployment function logs to its default group; Cloud's own functions name theirs.
        `arn:${p}:logs:${r}:${a}:log-group:/aws/lambda/${stack("web")}-*`,
        // The group and its streams (`<group>:*`).
        ...projects.map((name) => `arn:${p}:logs:${r}:${a}:log-group:/aws/codebuild/${name}*`),
      ],
    },
    {
      // Item reads and writes only: no Scan, no batch actions, no table changes, no streams.
      Sid: "TableItems", Effect: "Allow",
      Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem", "dynamodb:Query"],
      Resource: generated((s) => `arn:${p}:dynamodb:${r}:${a}:table/${s}-*`, ["web", "gateway"]),
    },
    { Sid: "OwnSecrets", Effect: "Allow", Action: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"], Resource: [`arn:${p}:secretsmanager:${r}:${a}:secret:${path.slice(1)}*`] },
    { Sid: "OwnSettings", Effect: "Allow", Action: ["ssm:GetParameter"], Resource: [`arn:${p}:ssm:${r}:${a}:parameter${path}*`] },
    // Use of keys, never their management: each key's policy names the one role that may use it.
    { Sid: "KeyUse", Effect: "Allow", Action: ["kms:Decrypt", "kms:GenerateDataKey", "kms:GenerateMac", "kms:VerifyMac"], Resource: [`arn:${p}:kms:${r}:${a}:key/*`] },
    {
      Sid: "ModelCalls", Effect: "Allow",
      Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      // A system inference profile sends calls to foundation models in other Regions of its geography.
      Resource: [`arn:${p}:bedrock:*::foundation-model/*`, `arn:${p}:bedrock:${r}:${a}:inference-profile/*`],
    },
    {
      // The web app's files (BucketDeployment reads the CDK asset bucket) and the pipeline's artifacts.
      Sid: "OwnBuckets", Effect: "Allow",
      Action: [
        // Objects only (PutObject* is the object, its ACL, tags, retention and legal hold): never a bucket's policy or settings.
        "s3:GetObject*", "s3:GetBucket*", "s3:List*", "s3:DeleteObject*", "s3:PutObject*", "s3:Abort*",
      ],
      Resource: [
        ...generated((s) => `arn:${p}:s3:::${s}-*`, ["web", "pipeline"]),
        `arn:${p}:s3:::cdk-${CDK_BOOTSTRAP_QUALIFIER}-assets-${a}-${r}`, `arn:${p}:s3:::cdk-${CDK_BOOTSTRAP_QUALIFIER}-assets-${a}-${r}/*`,
      ],
    },
    { Sid: "ImageToken", Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: ["*"] },
    {
      Sid: "ImagePull", Effect: "Allow",
      Action: ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"],
      Resource: [`arn:${p}:ecr:${r}:${a}:repository/${stack("gateway-images")}-*`],
    },
    {
      // The daily price fetch (EventBridge runs one task in the gateway's cluster).
      Sid: "PriceFetchTask", Effect: "Allow", Action: ["ecs:RunTask", "ecs:TagResource"],
      Resource: [`arn:${p}:ecs:${r}:${a}:task-definition/*`, `arn:${p}:ecs:${r}:*:task/${stack("gateway")}-*`],
    },
    // Only this environment's own roles (under its path), to ECS or Lambda.
    { Sid: "PassOwnRoles", Effect: "Allow", Action: ["iam:PassRole"], Resource: [`arn:${p}:iam::${a}:role${path}*`] },
    {
      // The pipeline assumes its action roles and cdk deploy's bootstrap roles; the gateway assumes its Vertex role and the broker; the
      // broker assumes customers' Bedrock roles (in their accounts: its own policy refuses this account).
      Sid: "AssumeOwnRoles", Effect: "Allow", Action: ["sts:AssumeRole"],
      Resource: [
        `arn:${p}:iam::${a}:role${path}*`,
        `arn:${p}:iam::${a}:role/${stack("pipeline")}-*`,
        `arn:${p}:iam::${a}:role/${BYO_BROKER_ROLE_PREFIX}${env}`,
        `arn:${p}:iam::*:role/${BYO_CUSTOMER_ROLE_PREFIX}*`,
        ...CDK_BOOTSTRAP_ASSUMED_ROLES.map((role) => `arn:${p}:iam::${a}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-${role}-${a}-${r}`),
      ],
    },
    {
      Sid: "PipelineBuilds", Effect: "Allow",
      Action: ["codebuild:BatchGetBuilds", "codebuild:StartBuild", "codebuild:StopBuild", "codebuild:CreateReport*", "codebuild:UpdateReport", "codebuild:BatchPut*"],
      Resource: [...projects.map((name) => `arn:${p}:codebuild:${r}:${a}:project/${name}`), ...projects.map((name) => `arn:${p}:codebuild:${r}:${a}:report-group/${name}-*`)],
    },
    {
      Sid: "PipelineSource", Effect: "Allow",
      Action: ["codeconnections:UseConnection", "codeconnections:GetConnectionToken", "codestar-connections:UseConnection", "codestar-connections:GetConnectionToken"],
      Resource: [`arn:${p}:codeconnections:*:${a}:connection/*`, `arn:${p}:codestar-connections:*:${a}:connection/*`],
    },
    { Sid: "ReleaseCheckReadsWebStack", Effect: "Allow", Action: ["cloudformation:DescribeStacks"], Resource: [`arn:${p}:cloudformation:${r}:${a}:stack/${stack("web")}/*`] },
    // The Deny statements hold even if a later change widens an Allow above.
    {
      Sid: "DenyIamChanges", Effect: "Deny",
      Action: ["iam:Create*", "iam:Delete*", "iam:Put*", "iam:Attach*", "iam:Detach*", "iam:Update*", "iam:Add*", "iam:Remove*", "iam:Set*", "iam:Tag*", "iam:Untag*", "iam:Upload*", "iam:Change*", "iam:Reset*", "iam:Enable*", "iam:Deactivate*"],
      Resource: ["*"],
    },
    { Sid: "DenyAccountChanges", Effect: "Deny", Action: ["organizations:*", "account:*"], Resource: ["*"] },
    { Sid: "DenyKeyManagement", Effect: "Deny", Action: ["kms:PutKeyPolicy", "kms:CreateGrant", "kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:Delete*"], Resource: ["*"] },
    // The bootstrap's CloudFormation execution role is the account's administrator: no Cloud role may reach it.
    { Sid: "DenyDeployExecutionRole", Effect: "Deny", Action: ["sts:AssumeRole", "iam:PassRole"], Resource: [`arn:${p}:iam::${a}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-cfn-exec-role-*`] },
  ];
}

/** True for any construct whose CloudFormation resource is AWS::IAM::Role: an iam.CfnRole, or a plain CfnResource (custom-resource providers). */
export function isIamRole(node: IConstruct): node is CfnResource {
  return CfnResource.isCfnResource(node) && node.cfnResourceType === "AWS::IAM::Role";
}

/** Reads a plain CfnResource's raw (PascalCase) properties: an aws-cdk-lib internal field, guarded by a test. */
function rawProperties(node: CfnResource): Record<string, unknown> | undefined {
  return (node as unknown as { _cfnProperties?: Record<string, unknown> })._cfnProperties;
}

class CloudBoundaryAspect implements IAspect {
  constructor(private readonly boundaryArn: string, private readonly path: string | undefined, private readonly stack: Stack) {}

  visit(node: IConstruct): void {
    if (!isIamRole(node) || Stack.of(node) !== this.stack) return;
    if (node instanceof iam.CfnRole) {
      if (node.permissionsBoundary !== undefined) throw new Error(`${node.node.path} already has a permissions boundary`);
      node.permissionsBoundary = this.boundaryArn;
      // L2 roles pass a lazy physical name that resolves to nothing when CloudFormation names the role.
      if (this.path !== undefined && this.stack.resolve(node.roleName) === undefined) {
        if (node.path !== undefined && node.path !== this.path) throw new Error(`${node.node.path} already has the path ${node.path}`);
        node.path = this.path;
      }
      return;
    }
    const properties = rawProperties(node);
    if (properties?.PermissionsBoundary !== undefined) throw new Error(`${node.node.path} already has a permissions boundary`);
    node.addPropertyOverride("PermissionsBoundary", this.boundaryArn);
    if (this.path !== undefined && properties?.RoleName === undefined) {
      if (properties?.Path !== undefined && properties.Path !== this.path) throw new Error(`${node.node.path} already has the path ${JSON.stringify(properties.Path)}`);
      node.addPropertyOverride("Path", this.path);
    }
  }
}

const bounded = new WeakMap<Stack, iam.CfnManagedPolicy>();

/**
 * Makes the stack's copy of the environment's boundary and the aspect that puts it on every role the stack makes (and the environment's
 * role path on the parts in ROLE_PATH_PARTS). Called once by each Cloud stack's constructor; a second call throws.
 */
export function applyCloudBoundary(stack: Stack, env: string, part: CloudStackPart): iam.CfnManagedPolicy {
  if (bounded.has(stack)) throw new Error(`${stack.node.path} already has its boundary`);
  const policy = new iam.CfnManagedPolicy(stack, "RoleBoundary", {
    managedPolicyName: cloudBoundaryName(env, part),
    path: cloudRolePath(env),
    description: `Rovara Cloud ${env} (${part}): the permissions boundary of every role this stack makes`,
    policyDocument: { Version: "2012-10-17", Statement: cloudBoundaryStatements({ env, partition: stack.partition, region: stack.region, account: stack.account }) },
  });
  bounded.set(stack, policy);
  Aspects.of(stack).add(new CloudBoundaryAspect(policy.ref, ROLE_PATH_PARTS.has(part) ? cloudRolePath(env) : undefined, stack));
  return policy;
}

/** The app-wide guard: a role in a stack that never called applyCloudBoundary fails the synth (a new stack class can't forget it). */
export class RequireCloudBoundary implements IAspect {
  visit(node: IConstruct): void {
    if (isIamRole(node) && !bounded.has(Stack.of(node))) throw new Error(`${node.node.path} is a role in a stack with no Rovara Cloud boundary (call applyCloudBoundary)`);
  }
}
