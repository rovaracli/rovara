import { Aspects, CfnDeletionPolicy, CfnResource, Stack, type IAspect } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { IConstruct } from "constructs";
import { RESOURCE_PREFIX, environmentSettingsPrefix } from "@agentx/contracts";

/**
 * Rovara Cloud's permissions boundary (owner decision 2026-11-17, matching Rovara Code's agentx-<env>-boundary): the most any role a
 * Cloud stack makes can ever do, whatever its own policy says. Every AWS::IAM::Role in a Cloud stack (the server and redirect
 * functions, the gateway's task, execution, events, Vertex and Bedrock broker roles, the release pipeline's roles, and the roles CDK
 * makes for its own custom resources such as BucketDeployment) carries it, set by an aspect, so a role added later carries it too.
 *
 * Each stack holds its own boundary, a customer-managed policy under /rovara-cloud/<env>/ (CloudFormation names it), so a stack never
 * waits on another stack or app for its boundary (the controller deploys each stack on its own, by change set). The statements depend
 * only on the environment and the stack's part (web, app, pipeline, gateway), never on which switches a stack was synthesized with, and
 * each part gets only what its roles use: only the pipeline may assume the CDK bootstrap roles, only the gateway may call Bedrock.
 *
 * Resources are named where Cloud names them (secrets, settings, CodeBuild projects, the bootstrap roles, the broker role), by the
 * stack-name prefix where CloudFormation generates a long-enough name (`<stack name>-<logical id>-<random>`: tables, log groups, the
 * image repository, buckets), and by the environment's role path for roles (CloudFormation shortens a generated role name past 64
 * characters, stack name included, so a role's name is never relied on). KMS keys, task definitions and Bedrock profiles have
 * generated ids: those are held to this account and region; each key's policy names the roles that may use it.
 */

/** The IAM path of the boundary policies: `/rovara-cloud/<env>/`. */
export function cloudRolePath(env: string): string {
  // environmentSettingsPrefix validates the name and gives `/rovara-cloud/<env>/`.
  return environmentSettingsPrefix(env);
}

/**
 * The IAM path of a part's roles (the parts in ROLE_PATH_PARTS): `/rovara-cloud/<env>/<part>/`, one per part, so a part's PassRole and
 * AssumeRole never reach another part's roles (the gateway never the pipeline's, nor the other way round).
 */
export function cloudPartRolePath(env: string, part: CloudStackPart): string {
  return `${cloudRolePath(env)}${part}/`;
}

/** What a Cloud stack is: the suffix of its stack name, rovara-cloud-<env>-<part>. */
export type CloudStackPart = "web" | "app" | "pipeline" | "gateway-images" | "gateway";
export const CLOUD_STACK_PARTS: readonly CloudStackPart[] = ["web", "app", "pipeline", "gateway-images", "gateway"];

/**
 * The parts whose roles live under cloudRolePath. A role's path can't change in place (CloudFormation replaces the role), so the stacks
 * already deployed on staging with roles at "/" (web, app) keep "/". The gateway and pipeline had no live roles when this was made (the
 * staging gateway create rolled back on 2026-11-16 with no role retained; the pipeline is not deployed). Kept at "/" wherever they are:
 * a role with a fixed name (the Bedrock broker, whose ARN every customer's trust policy names), and a role marked with keepRoleAtRoot
 * (the CodeBuild projects' service roles: the template passes their ARN, but cfn-lint E3050 warns that CodeBuild may read a service
 * role with a path wrongly, and nothing assumes or passes them, so "/" costs nothing).
 */
export const ROLE_PATH_PARTS: ReadonlySet<CloudStackPart> = new Set(["pipeline", "gateway", "gateway-images"]);

const atRoot = new WeakSet<IConstruct>();
/** Keeps a role at "/" in a part whose roles are otherwise under the part's path (a service that may not take a role with a path). */
export function keepRoleAtRoot(role: iam.IRole): void {
  atRoot.add(role.node.defaultChild ?? role);
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
  readonly Condition?: Record<string, Record<string, string | string[]>>;
}

/** The CDK bootstrap roles `cdk deploy` assumes from the release pipeline's deploy job: never the CloudFormation execution role. */
export const CDK_BOOTSTRAP_ASSUMED_ROLES = ["deploy-role", "file-publishing-role", "image-publishing-role", "lookup-role"] as const;
export const CDK_BOOTSTRAP_QUALIFIER = "hnb659fds";

/** The customers' roles the Bedrock broker assumes (packages/model-gateway bedrock-byo.ts; model-gateway.ts holds the two equal). */
const BYO_CUSTOMER_ROLE_PREFIX = "RovaraBedrockInvoke-";
const BYO_BROKER_ROLE_PREFIX = "RovaraBedrockBroker-";
/**
 * The conditions on the broker's grant to assume a customer's Bedrock role, in ONE place: model-gateway.ts puts exactly these on the broker role's own
 * policy and this file puts exactly these on the boundary's ceiling for it (L4-HARD, owner 2026-11-18), so the two can never disagree (a test holds them
 * equal and refuses any other external id scheme). The external id is the ONE Bedrock scheme, `rvb-` + an HMAC of (install, company) under the gateway's
 * KMS key (packages/model-gateway/src/bedrock-byo.ts); the session name is the company id; the role is never one in Rovara's own account.
 */
export const BYO_CUSTOMER_EXTERNAL_ID_PATTERN = "rvb-*";
export const BYO_CUSTOMER_SESSION_NAME_PATTERN = "org_*";
export function byoCustomerAssumeConditions(account: string): { StringLike: Record<string, string>; StringNotEquals: Record<string, string> } {
  return {
    StringLike: { "sts:ExternalId": BYO_CUSTOMER_EXTERNAL_ID_PATTERN, "sts:RoleSessionName": BYO_CUSTOMER_SESSION_NAME_PATTERN },
    StringNotEquals: { "aws:ResourceAccount": account },
  };
}
/**
 * The logical ids of the gateway's provider key secrets (model-gateway.ts, `ProviderKey-<provider>` for each of MODEL_GATEWAY_PROVIDERS;
 * a test holds the two equal). With generated names (model-gateway.ts MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY, the default)
 * CloudFormation names a secret `<logical id>-<random>`, with no stack name or environment in it, so the boundary can only name them
 * by that prefix.
 */
export const GATEWAY_PROVIDER_SECRET_LOGICAL_IDS = ["ProviderKeyanthropic"] as const;

/** The boundary of one part of one environment. Pure: tests and the controller's simulation call it with plain strings. */
export function cloudBoundaryStatements(scope: BoundaryScope, part: CloudStackPart): BoundaryStatement[] {
  const { env, partition: p, region: r, account: a } = scope;
  const path = cloudRolePath(env);
  const rolesOf = (which: CloudStackPart) => `arn:${p}:iam::${a}:role${cloudPartRolePath(env, which)}*`;
  // Generated names start with the stack name; never `rovara-cloud-<env>-*` (that would match an environment named <env>-eu too).
  const stack = (which: string) => `${RESOURCE_PREFIX}-${env}-${which}`;
  const logs = (groups: string[]): BoundaryStatement => ({
    Sid: "Logs", Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
    Resource: groups.map((group) => `arn:${p}:logs:${r}:${a}:log-group:${group}`),
  });
  const tables = (stacks: string[]): BoundaryStatement => ({
    // Item reads and writes only: no Scan, no batch actions, no table changes, no streams.
    Sid: "TableItems", Effect: "Allow",
    Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem", "dynamodb:Query"],
    Resource: stacks.map((s) => `arn:${p}:dynamodb:${r}:${a}:table/${stack(s)}-*`),
  });
  const secrets: BoundaryStatement = { Sid: "OwnSecrets", Effect: "Allow", Action: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"], Resource: [`arn:${p}:secretsmanager:${r}:${a}:secret:${path.slice(1)}*`] };
  const keys = (actions: string[]): BoundaryStatement => ({ Sid: "KeyUse", Effect: "Allow", Action: actions, Resource: [`arn:${p}:kms:${r}:${a}:key/*`] });
  const projects = ["deploy", "check"].map((what) => `${RESOURCE_PREFIX}-${env}-${what}`);
  const objects = ["s3:GetObject*", "s3:GetBucket*", "s3:List*", "s3:DeleteObject*", "s3:PutObject*", "s3:Abort*"];
  const allows: Record<CloudStackPart, BoundaryStatement[]> = {
    web: [
      // The server logs to its own group; CDK's BucketDeployment function too (cloud-web.ts gives it one).
      logs([`${stack("web")}-*`]),
      // Its State and Companies tables, and (product AI) the gateway's product key table.
      tables(["web", "gateway"]),
      secrets,
      { Sid: "OwnSettings", Effect: "Allow", Action: ["ssm:GetParameter"], Resource: [`arn:${p}:ssm:${r}:${a}:parameter${path}*`] },
      keys(["kms:Decrypt", "kms:GenerateDataKey", "kms:GenerateMac"]),
      // The web app's files: written to its own bucket, read from the CDK asset bucket (never written: other stacks deploy from it).
      { Sid: "OwnBuckets", Effect: "Allow", Action: objects, Resource: [`arn:${p}:s3:::${stack("web")}-*`] },
      { Sid: "ReadDeployAssets", Effect: "Allow", Action: ["s3:GetObject*", "s3:GetBucket*", "s3:List*"], Resource: [`arn:${p}:s3:::cdk-${CDK_BOOTSTRAP_QUALIFIER}-assets-${a}-${r}`, `arn:${p}:s3:::cdk-${CDK_BOOTSTRAP_QUALIFIER}-assets-${a}-${r}/*`] },
    ],
    app: [logs([`${stack("app")}-*`])],
    pipeline: [
      logs([`${stack("pipeline")}-*`, ...projects.map((name) => `/aws/codebuild/${name}*`)]),
      { Sid: "OwnBuckets", Effect: "Allow", Action: objects, Resource: [`arn:${p}:s3:::${stack("pipeline")}-*`] },
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
      {
        // The pipeline assumes its own action roles (under the path) and the bootstrap roles cdk deploy uses. Only this part may.
        Sid: "AssumeDeployRoles", Effect: "Allow", Action: ["sts:AssumeRole"],
        Resource: [rolesOf("pipeline"), ...CDK_BOOTSTRAP_ASSUMED_ROLES.map((role) => `arn:${p}:iam::${a}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-${role}-${a}-${r}`)],
      },
    ],
    "gateway-images": [],
    gateway: [
      logs([`${stack("gateway")}-*`]),
      // Its meter, ledger, markers, prices and product tables, and the web stack's Companies table (budgets, read only by its policy).
      tables(["gateway", "web"]),
      // Its provider key secrets under either naming (model-gateway.ts MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY): the fixed names
      // sit under the environment's prefix; a generated name is `<logical id>-<random>` and carries no environment, so another
      // environment's generated provider secret in the same account and Region also matches. That is a ceiling only: the serving role's
      // own policy names its secrets' exact ARNs, and each environment's secrets are encrypted with that environment's key, whose policy
      // lets only that environment's serving role decrypt (model-gateway.ts OnlyGatewayReads).
      { ...secrets, Resource: [...secrets.Resource, ...GATEWAY_PROVIDER_SECRET_LOGICAL_IDS.map((id) => `arn:${p}:secretsmanager:${r}:${a}:secret:${id}-*`)] },
      keys(["kms:Decrypt", "kms:GenerateMac", "kms:VerifyMac"]),
      {
        Sid: "ModelCalls", Effect: "Allow", Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        // A system inference profile sends calls to foundation models in other Regions of its geography.
        Resource: [`arn:${p}:bedrock:*::foundation-model/*`, `arn:${p}:bedrock:${r}:${a}:inference-profile/*`],
      },
      { Sid: "ImageToken", Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: ["*"] },
      { Sid: "ImagePull", Effect: "Allow", Action: ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"], Resource: [`arn:${p}:ecr:${r}:${a}:repository/${stack("gateway-images")}-*`] },
      // The daily price fetch: EventBridge runs one task in the gateway's cluster, passing the gateway's own roles.
      { Sid: "PriceFetchTask", Effect: "Allow", Action: ["ecs:RunTask", "ecs:TagResource"], Resource: [`arn:${p}:ecs:${r}:${a}:task-definition/*`, `arn:${p}:ecs:${r}:*:task/${stack("gateway")}-*`] },
      { Sid: "PassOwnRoles", Effect: "Allow", Action: ["iam:PassRole"], Resource: [rolesOf("gateway")] },
      {
        // The serving role assumes its Vertex role (under the path) and the broker.
        Sid: "AssumeGatewayRoles", Effect: "Allow", Action: ["sts:AssumeRole"],
        Resource: [rolesOf("gateway"), `arn:${p}:iam::${a}:role/${BYO_BROKER_ROLE_PREFIX}${env}`],
      },
      {
        // The broker assumes customers' Bedrock roles, in OTHER accounts only, with the company's rvb- external id and its org_ session name: the same
        // conditions its own grant carries (byoCustomerAssumeConditions), so the ceiling is exactly the grant (before L4-HARD it had no conditions).
        Sid: "AssumeCustomerBedrockRoles", Effect: "Allow", Action: ["sts:AssumeRole"],
        Resource: [`arn:${p}:iam::*:role/${BYO_CUSTOMER_ROLE_PREFIX}*`],
        Condition: byoCustomerAssumeConditions(a),
      },
    ],
  };
  return [
    ...allows[part],
    // The Deny statements hold even if a later change widens an Allow above.
    {
      Sid: "DenyIamChanges", Effect: "Deny",
      Action: ["iam:Create*", "iam:Delete*", "iam:Put*", "iam:Attach*", "iam:Detach*", "iam:Update*", "iam:Add*", "iam:Remove*", "iam:Set*", "iam:Tag*", "iam:Untag*", "iam:Upload*", "iam:Change*", "iam:Reset*", "iam:Enable*", "iam:Deactivate*"],
      Resource: ["*"],
    },
    { Sid: "DenyAccountChanges", Effect: "Deny", Action: ["organizations:*", "account:*"], Resource: ["*"] },
    { Sid: "DenyKeyManagement", Effect: "Deny", Action: ["kms:PutKeyPolicy", "kms:CreateGrant", "kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:Delete*"], Resource: ["*"] },
    // The bootstrap's CloudFormation execution role is the account's administrator: no Cloud role may reach it. (A customer's Bedrock
    // role in this account is refused by the broker's own policy, aws:ResourceAccount: a Deny here would also cover other accounts.)
    { Sid: "DenyAdminRoles", Effect: "Deny", Action: ["sts:AssumeRole", "iam:PassRole"], Resource: [`arn:${p}:iam::${a}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-cfn-exec-role-*`] },
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
    const path = atRoot.has(node) ? undefined : this.path;
    if (node instanceof iam.CfnRole) {
      if (node.permissionsBoundary !== undefined) throw new Error(`${node.node.path} already has a permissions boundary`);
      node.permissionsBoundary = this.boundaryArn;
      // L2 roles pass a lazy physical name that resolves to nothing when CloudFormation names the role.
      if (path !== undefined && this.stack.resolve(node.roleName) === undefined) {
        if (node.path !== undefined && node.path !== path) throw new Error(`${node.node.path} already has the path ${node.path}`);
        node.path = path;
      }
      return;
    }
    const properties = rawProperties(node);
    if (properties?.PermissionsBoundary !== undefined) throw new Error(`${node.node.path} already has a permissions boundary`);
    node.addPropertyOverride("PermissionsBoundary", this.boundaryArn);
    if (path !== undefined && properties?.RoleName === undefined) {
      if (properties?.Path !== undefined && properties.Path !== path) throw new Error(`${node.node.path} already has the path ${JSON.stringify(properties.Path)}`);
      node.addPropertyOverride("Path", path);
    }
  }
}

/** The boundary policy's logical id in every Cloud stack (the checker and the controller's simulation find it by this id). */
export const BOUNDARY_LOGICAL_ID = "RoleBoundary";
const bounded = new WeakMap<Stack, iam.CfnManagedPolicy>();

/**
 * Makes the stack's boundary and the aspect that puts it on every role the stack makes (and the environment's role path on the parts
 * in ROLE_PATH_PARTS). The web stack also supplies its meter table ARN for the narrowly conditioned batch reads (the other table
 * actions above already fit). Called once, last, by each Cloud stack's constructor; a second call throws. The gateway's boundary is retained:
 * its Bedrock broker role is retained, and a policy still in use as a role's boundary can't be deleted.
 */
export function applyCloudBoundary(stack: Stack, env: string, part: CloudStackPart, gatewayMeterTableArn?: string): iam.CfnManagedPolicy {
  if (bounded.has(stack)) throw new Error(`${stack.node.path} already has its boundary`);
  // Only the web stack's approved meter reads extend the boundary, on the same exact ARN and company keys as its identity policy.
  const meterReads = part === "web" && gatewayMeterTableArn !== undefined ? [new iam.PolicyStatement({
    sid: "GatewayMeterCompanyReads", actions: ["dynamodb:GetItem", "dynamodb:BatchGetItem"], resources: [gatewayMeterTableArn],
    conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CO#*"] }, Null: { "dynamodb:LeadingKeys": "false" } },
  }).toStatementJson() as Record<string, unknown>] : [];
  const policy = new iam.CfnManagedPolicy(stack, BOUNDARY_LOGICAL_ID, {
    path: cloudRolePath(env),
    description: `Rovara Cloud ${env} (${part}): the permissions boundary of every role this stack makes`,
    policyDocument: { Version: "2012-10-17", Statement: [...cloudBoundaryStatements({ env, partition: stack.partition, region: stack.region, account: stack.account }, part), ...meterReads] },
  });
  if (part === "gateway") {
    policy.cfnOptions.deletionPolicy = CfnDeletionPolicy.RETAIN;
    policy.cfnOptions.updateReplacePolicy = CfnDeletionPolicy.RETAIN;
  }
  bounded.set(stack, policy);
  Aspects.of(stack).add(new CloudBoundaryAspect(policy.ref, ROLE_PATH_PARTS.has(part) ? cloudPartRolePath(env, part) : undefined, stack));
  return policy;
}

/** The app-wide guard: a role in a stack that never called applyCloudBoundary fails the synth (a new stack class can't forget it). */
export class RequireCloudBoundary implements IAspect {
  visit(node: IConstruct): void {
    if (isIamRole(node) && !bounded.has(Stack.of(node))) throw new Error(`${node.node.path} is a role in a stack with no Rovara Cloud boundary (call applyCloudBoundary)`);
  }
}
