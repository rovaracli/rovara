/**
 * How big a synthesized Lambda function's environment is once CloudFormation has filled it in. Lambda refuses a function whose
 * variables, keys and values together, as the JSON of the map, come to more than 4,096 bytes ("Lambda was unable to configure your
 * environment variables because the environment variables you have provided exceeded the 4KB limit"), and only the deploy
 * says so. This resolves every intrinsic with the worst length CloudFormation can give it, so a test can say so first:
 *  - a name CloudFormation generates is `<stack name>-<logical id>-<13 random characters>`, cut at the resource type's limit
 *    (64 for a function or a role, 80 for a queue, 63 for a bucket, 255 for a table);
 *  - a queue's Ref is its URL, a role's ARN carries its path, a key's id is a UUID, a key's ARN is 75 characters;
 *  - a parameter is given what `parameterValues` says, else its longest allowed value, else its default, else `PARAMETER_FALLBACK`;
 *  - Fn::If takes the longer branch.
 * The region is the longest one there is (14 characters), the account is 12 digits.
 */

type Json = Record<string, unknown>;
interface Resource { Type: string; Properties?: Json }
export interface Template { Resources: Record<string, Resource>; Parameters?: Record<string, { Default?: unknown; Type?: string; AllowedValues?: string[] }> }

export const LAMBDA_ENVIRONMENT_LIMIT_BYTES = 4096;
const REGION = "ap-southeast-4";
const ACCOUNT = "123456789012";
/** What a stand-in AppSync Events API's Dns.Http and Dns.Realtime hosts start with (26 characters, like the real ones); the stand-in ApiId is different. */
export const APPSYNC_DNS_PREFIX = "zyxwvutsrqponmlkjihgfedcba";
export const APPSYNC_API_ID = "abcdefghijklmnopqrstuvwxyz";
export const LAMBDA_RESOLVER_REGION = REGION;
const PARAMETER_FALLBACK = "p".repeat(64);

/** What a deploy gives the parameters that have no default, at a realistic worst length (the control plane's inputs from the other stacks, and the operator's). */
export const DEPLOY_PARAMETER_VALUES: Record<string, string> = {
  OidcIssuer: `https://cognito-idp.${REGION}.amazonaws.com/${REGION}_AbCdEfGhI`,
  OidcAudience: "1234567890abcdefghijklmnop",
  CallbackSigningKey: "k".repeat(64),
  GitHubAppPrivateKeySecretArn: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:agentx/github-app-private-key-AbCdEf`,
  ProjectAllowListId: "rslvr-fdl-0123456789abcdef",
  VpcId: "vpc-0123456789abcdef0",
  Ec2WorkerSubnets: [`${REGION}a=subnet-0123456789abcdef0`, `${REGION}b=subnet-0123456789abcdef0`, `${REGION}c=subnet-0123456789abcdef0`].join(","),
  Ec2WorkerSecurityGroupId: "sg-0123456789abcdef0",
  Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0",
  // The optional parameters, set (an install that uses them: their defaults are empty, and the worst case is not).
  // A Slack team id is [TE][A-Z0-9]{2,31} (the parameter's AllowedPattern): 32 characters at most.
  SlackTeamId: `T${"0123456789ABCDEFGHIJKLMNOPQRSTUV".slice(0, 31)}`,
  DeveloperOidcIssuer: "https://login.example-company.okta.com/oauth2/default",
  DeveloperOidcClientId: "0oa1b2c3d4e5f6g7h8i9",
  DeveloperOidcRequiredClaim: "groups",
  GitHubAppId: "1234567",
  GitHubClientId: "Iv1.0123456789abcdef",
  // The settings packed into the broker's AGENTX_SETTINGS, at their realistic maxima (ENV-ROOM review): an epoch-seconds parameter allows 12 digits (its default is "0"), and the
  // workspace limits are small counts (their defaults are 3 and 20; six digits is generous). A parameter with an AllowedValues list takes its longest value (see Resolver.ref).
  DeveloperSignInSlackSince: "999999999999",
  DeveloperOidcSince: "999999999999",
  SlackMemberWorkspaceLimit: "999999",
  SlackOrganizationWorkspaceLimit: "999999",
  // B2-m2: `dp` (the design review's project list) is packed into AGENTX_SETTINGS and holds up to its 20 characters (its default is empty, which is not the worst case).
  DesignReviewProjects: `${"a".repeat(9)}:${"b".repeat(10)}`,
  CloudSignInEmailFrom: "Rovara <no-reply@mail.example-company.com>",
  CloudSignInEmailSourceArn: "arn:aws:ses:us-east-1:123456789012:identity/mail.example-company.com",
};
const RANDOM = "A1B2C3D4E5F6G";
const UUID = "12345678-1234-1234-1234-123456789012";

/** The explicit-name property of a resource type, where a fixed name replaces the generated one. */
const NAME_PROPERTY: Record<string, string> = {
  "AWS::Lambda::Function": "FunctionName",
  "AWS::SQS::Queue": "QueueName",
  "AWS::DynamoDB::Table": "TableName",
  "AWS::S3::Bucket": "BucketName",
  "AWS::IAM::Role": "RoleName",
  "AWS::SNS::Topic": "TopicName",
  "AWS::SSM::Parameter": "Name",
  "AWS::Events::Rule": "Name",
  "AWS::SecretsManager::Secret": "Name",
  "AWS::Logs::LogGroup": "LogGroupName",
  "AWS::StepFunctions::StateMachine": "StateMachineName",
};
const NAME_LIMIT: Record<string, number> = {
  "AWS::Lambda::Function": 64,
  "AWS::SQS::Queue": 80,
  "AWS::DynamoDB::Table": 255,
  "AWS::S3::Bucket": 63,
  "AWS::IAM::Role": 64,
  "AWS::SNS::Topic": 256,
  "AWS::Events::Rule": 64,
  "AWS::StepFunctions::StateMachine": 80,
};

export interface SizeOptions {
  /** The environment name, which sits in the stack name and in every role path. */
  env: string;
  stackName: string;
  /** Values for parameters that have no default, by parameter name. */
  parameterValues?: Record<string, string>;
}

class Resolver {
  constructor(private readonly template: Template, private readonly options: SizeOptions) {}

  private generatedName(logicalId: string, type: string): string {
    const name = `${this.options.stackName}-${logicalId}-${RANDOM}`;
    return name.slice(0, NAME_LIMIT[type] ?? 255);
  }

  private nameOf(logicalId: string): string {
    const resource = this.template.Resources[logicalId];
    if (resource === undefined) return `${this.options.stackName}-${logicalId}-${RANDOM}`;
    const property = NAME_PROPERTY[resource.Type];
    const fixed = property === undefined ? undefined : resource.Properties?.[property];
    return fixed === undefined ? this.generatedName(logicalId, resource.Type) : this.text(fixed);
  }

  private ref(key: string): string {
    switch (key) {
      case "AWS::Region": return REGION;
      case "AWS::AccountId": return ACCOUNT;
      case "AWS::Partition": return "aws";
      case "AWS::URLSuffix": return "amazonaws.com";
      case "AWS::StackName": return this.options.stackName;
      case "AWS::StackId": return `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${this.options.stackName}/${UUID}`;
      default: break;
    }
    const parameter = this.template.Parameters?.[key];
    if (parameter !== undefined) {
      const given = this.options.parameterValues?.[key];
      if (given !== undefined) return given;
      if (parameter.AllowedValues !== undefined && parameter.AllowedValues.length > 0) return [...parameter.AllowedValues].sort((a, b) => b.length - a.length)[0]!;
      return parameter.Default === undefined ? PARAMETER_FALLBACK : typeof parameter.Default === "string" ? parameter.Default : JSON.stringify(parameter.Default);
    }
    const resource = this.template.Resources[key];
    if (resource === undefined) throw new Error(`Ref to ${key}, which is neither a parameter nor a resource`);
    switch (resource.Type) {
      case "AWS::SQS::Queue": return `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/${this.nameOf(key)}`;
      case "AWS::KMS::Key": return UUID;
      case "AWS::SNS::Topic": return `arn:aws:sns:${REGION}:${ACCOUNT}:${this.nameOf(key)}`;
      case "AWS::StepFunctions::StateMachine": return `arn:aws:states:${REGION}:${ACCOUNT}:stateMachine:${this.nameOf(key)}`;
      case "AWS::ApiGatewayV2::Api": return "abcdefghij";
      case "AWS::Cognito::UserPool": return `${REGION}_AbCdEfGhI`;
      case "AWS::Cognito::UserPoolClient": return "1234567890abcdefghijklmnop";
      case "AWS::ElasticLoadBalancingV2::LoadBalancer": return `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/${"n".repeat(32)}/0123456789abcdef`;
      default: return this.nameOf(key);
    }
  }

  private getAtt(logicalId: string, attribute: string): string {
    const resource = this.template.Resources[logicalId];
    if (resource === undefined) throw new Error(`GetAtt on ${logicalId}, which is not a resource`);
    const name = this.nameOf(logicalId);
    switch (`${resource.Type}.${attribute}`) {
      case "AWS::IAM::Role.Arn": return `arn:aws:iam::${ACCOUNT}:role/agentx/${this.options.env}/${name}`;
      case "AWS::Lambda::Function.Arn": return `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${name}`;
      case "AWS::SQS::Queue.Arn": return `arn:aws:sqs:${REGION}:${ACCOUNT}:${name}`;
      case "AWS::SQS::Queue.QueueName": return name;
      case "AWS::SQS::Queue.QueueUrl": return this.ref(logicalId);
      case "AWS::DynamoDB::Table.Arn": return `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${name}`;
      case "AWS::DynamoDB::Table.StreamArn": return `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${name}/stream/2026-10-22T00:00:00.000`;
      case "AWS::S3::Bucket.Arn": return `arn:aws:s3:::${name}`;
      case "AWS::KMS::Key.Arn": return `arn:aws:kms:${REGION}:${ACCOUNT}:key/${UUID}`;
      case "AWS::ElasticLoadBalancingV2::LoadBalancer.DNSName": return `internal-${"n".repeat(32)}-1234567890.${REGION}.elb.amazonaws.com`;
      case "AWS::Cognito::UserPool.Arn": return `arn:aws:cognito-idp:${REGION}:${ACCOUNT}:userpool/${REGION}_AbCdEfGhI`;
      // An AppSync Events API's id is 26 lowercase letters and digits (Plan 5 Task 8).
      case "AWS::AppSync::Api.ApiId": return APPSYNC_API_ID;
      // The Events API's DNS prefix is not its id (staging 0.4.3: the id's host does not exist), so the stand-in differs from ApiId: a name built from the id cannot pass for one built from the DNS.
      case "AWS::AppSync::Api.Dns.Http": return `${APPSYNC_DNS_PREFIX}.appsync-api.${REGION}.amazonaws.com`;
      case "AWS::AppSync::Api.Dns.Realtime": return `${APPSYNC_DNS_PREFIX}.appsync-realtime-api.${REGION}.amazonaws.com`;
      case "AWS::ApiGatewayV2::Api.ApiEndpoint": return `https://abcdefghij.execute-api.${REGION}.amazonaws.com`;
      default: break;
    }
    if (attribute.endsWith("Arn")) return `arn:aws:service:${REGION}:${ACCOUNT}:${name}`;
    return name;
  }

  /** A resolved value as text; what a variable's value is once CloudFormation has put its parts together. */
  text(value: unknown): string {
    const resolved = this.resolve(value);
    return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
  }

  resolve(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((entry) => this.resolve(entry));
    if (value === null || typeof value !== "object") return value;
    const entries = Object.entries(value as Json);
    if (entries.length === 1) {
      const [name, argument] = entries[0]!;
      switch (name) {
        case "Ref": return this.ref(String(argument));
        case "Fn::GetAtt": {
          const [id, attribute] = Array.isArray(argument) ? (argument as [string, string]) : String(argument).split(".", 2) as [string, string];
          return this.getAtt(id, attribute);
        }
        case "Fn::Join": {
          const [delimiter, list] = argument as [string, unknown[]];
          return (this.resolve(list) as unknown[]).map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join(delimiter);
        }
        case "Fn::Select": {
          const [index, list] = argument as [unknown, unknown[]];
          return (this.resolve(list) as unknown[])[Number(this.resolve(index))];
        }
        case "Fn::Split": {
          const [delimiter, text] = argument as [string, unknown];
          return this.text(text).split(delimiter);
        }
        case "Fn::If": {
          const [, yes, no] = argument as [string, unknown, unknown];
          const left = this.resolve(yes);
          const right = this.resolve(no);
          return JSON.stringify(left).length >= JSON.stringify(right).length ? left : right;
        }
        case "Fn::Sub": {
          const [template, variables] = Array.isArray(argument) ? (argument as [string, Json]) : [String(argument), {} as Json];
          return template.replace(/\$\{([^}]+)\}/g, (_match, key: string) => (key in variables ? this.text(variables[key]) : key.includes(".") ? this.getAtt(...(key.split(".", 2) as [string, string])) : this.ref(key)));
        }
        case "Fn::ToJsonString": return JSON.stringify(this.resolve(argument));
        case "Fn::ImportValue": return "i".repeat(80);
        case "Fn::GetAZs": return [`${REGION}a`, `${REGION}b`, `${REGION}c`];
        default: break;
      }
    }
    return Object.fromEntries(entries.map(([key, entry]) => [key, this.resolve(entry)]));
  }
}

export interface LambdaEnvironment { logicalId: string; variables: Record<string, string>; bytes: number }

/** The compact JSON of a variable map: the number Lambda holds to 4,096. */
export const environmentBytes = (variables: Record<string, string>): number => Buffer.byteLength(JSON.stringify(variables), "utf8");

/** Every Lambda function of a template with an environment, resolved at worst-case lengths. */
export function lambdaEnvironments(template: Template, options: SizeOptions): LambdaEnvironment[] {
  const resolver = new Resolver(template, options);
  const found: LambdaEnvironment[] = [];
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (resource.Type !== "AWS::Lambda::Function") continue;
    const raw = (resource.Properties?.Environment as { Variables?: Json } | undefined)?.Variables;
    if (raw === undefined) continue;
    const variables = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, resolver.text(value)]));
    found.push({ logicalId, variables, bytes: environmentBytes(variables) });
  }
  return found;
}
