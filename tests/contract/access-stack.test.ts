import { Stack, type App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { APPSYNC_EVENTS_ACTIONS, APPSYNC_EVENTS_UNSCOPED_ACTIONS, CLOUDFRONT_BOUNDARY_ACTIONS, CLOUDFRONT_DISTRIBUTION_ACTIONS, CLOUDFRONT_DISTRIBUTION_CREATE_ACTIONS, CLOUDFRONT_DISTRIBUTION_TAG_ACTIONS, CLOUDFRONT_ORIGIN_ACCESS_CONTROL_ACTIONS, CLOUDFRONT_RESPONSE_HEADERS_POLICY_ACTIONS, CLOUDFRONT_UNSCOPED_ACTIONS } from "@agentx/cloud-contracts";
import { ENVIRONMENT_PLACEHOLDER } from "@rovara-code/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { SERVICE_LINKED_ROLE_SERVICES, SERVICE_ROLE_SERVICES, TEAM_RECORD_BOUNDARY_SERVICES, defaultBoundaryStatements, serviceRoleStatements } from "../../infra/lib/access-policies.js";
import { boundaryWithSids } from "../support/deployed-boundary.js";
import { serviceRoleWithSids } from "../support/deployed-service-role.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const stacksOf = (app: App) => app.node.children.filter((c): c is Stack => Stack.isStack(c));
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown };
type Resource = { Type: string; Condition?: string; Properties: Record<string, unknown> };
const resourcesOf = (stack: Stack) => Template.fromStack(stack).toJSON().Resources as Record<string, Resource>;
/** Every statement granted to a role: the role's own Policies, each AWS::IAM::Policy, and the broker's named managed grant policies (ruling M2). */
function roleStatements(resources: Record<string, Resource>): Statement[] {
  /** A statement the hosted cloud's access stack grants only while the custom domain is set is an Fn::If; the check reads the statement it grants. */
  const granted = (statement: Statement | { "Fn::If": [string, Statement, unknown] }): Statement => ("Fn::If" in statement ? statement["Fn::If"][1] : statement);
  return Object.entries(resources).flatMap(([id, r]) => {
    // The access stack's deploy policy carries no Sids when deployed (infra/lib/access.ts); they are put back here by position.
    if (r.Type === "AWS::IAM::Role") return ((r.Properties.Policies ?? []) as { PolicyName?: string; PolicyDocument: { Statement: Statement[] } }[]).flatMap((p) => (id === "CloudFormationServiceRole" && p.PolicyName === "deploy" ? serviceRoleWithSids(p.PolicyDocument.Statement) : p.PolicyDocument.Statement).map(granted));
    if (r.Type === "AWS::IAM::Policy") return (r.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
    if (r.Type === "AWS::IAM::ManagedPolicy" && /^agentx-.+-broker-/.test((typeof r.Properties.ManagedPolicyName === "string" ? r.Properties.ManagedPolicyName : ""))) return (r.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
    return [];
  });
}

/** IAM's action wildcard: `*` matches any run of characters, case-insensitively. */
const globMatches = (pattern: string, action: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i").test(action);
/** The custom domain's grants (0.5.7) are by name, in their own statements, and exist only while a domain is set: the resource types they create are not "needed" in the wildcard sense. */
const CUSTOM_DOMAIN_SERVICES: ReadonlySet<string> = new Set(["certificatemanager", "route53"]);
const CLOUDFRONT_ALL_ACTIONS = [...new Set([...CLOUDFRONT_DISTRIBUTION_CREATE_ACTIONS, ...CLOUDFRONT_DISTRIBUTION_TAG_ACTIONS, ...CLOUDFRONT_DISTRIBUTION_ACTIONS, ...CLOUDFRONT_ORIGIN_ACCESS_CONTROL_ACTIONS, ...CLOUDFRONT_RESPONSE_HEADERS_POLICY_ACTIONS, ...CLOUDFRONT_UNSCOPED_ACTIONS])];

describe("access stack", () => {
  const app = buildAgentXApp({ agentxEnv: "staging" });
  const access = stacksOf(app).find((s) => s.stackName === "agentx-staging-access")!;
  const template = Template.fromStack(access);

  // The hosted-cloud app adds resource types the plain one lacks (Route 53 Resolver DNS firewall and
  // query logging, Cognito identity provider and managed login branding), so every "what the service
  // role and boundary must cover" check reads both apps: a cloud-only resource type without
  // permissions fails the deploy of `agentxCloud=true` and must fail here first.
  const cloudApp = buildAgentXApp({ agentxEnv: "staging", agentxCloud: true });
  const resourcesInApp = (a: App) => stacksOf(a).map((stack) => ({ stack, resources: resourcesOf(stack) }));
  // TR-SWITCH-B1/B2: and the hosted cloud with the Team record switched on, whose S3 Vectors, S3 Tables and Athena resources and role statements the boundary and the service role must cover
  // (tests/contract/team-record-iam-coverage.test.ts checks them in detail).
  const recordApp = buildAgentXApp({ agentxEnv: "staging", agentxCloud: true, agentxTeamRecord: "enabled" });
  const environmentResources = () => [app, cloudApp, recordApp].flatMap(resourcesInApp);
  /** The AWS service each resource type in the non-access templates is created through. */
  const resourceTypeServices = () => {
    const serviceOf = (type: string) => type.split("::")[1]!.toLowerCase().replace("apigatewayv2", "apigateway").replace("cognito", "cognito-idp").replace("applicationautoscaling", "application-autoscaling").replace("elasticloadbalancingv2", "elasticloadbalancing").replace("stepfunctions", "states");
    const types = new Set(environmentResources().filter(({ stack }) => stack.stackName !== "agentx-staging-access").flatMap(({ resources }) => Object.values(resources).map((r) => r.Type)));
    // AWS::CDK::Metadata is a CDK pseudo-resource, not an AWS service call. Custom resources are
    // backed by Lambda, so they need the lambda service. Roles, policies and instance profiles are
    // IAM, checked by action. AWS::Budgets::Budget (spec 015 phase 15d2, FR-047) is also checked by
    // action: the service role's scoped "Budget" Sid, never a budgets:* wildcard (SERVICE_ROLE_SERVICES
    // deliberately excludes "budgets"; only the permission boundary's ceiling still wildcards it).
    return new Set([...types].filter((t) => !["AWS::CDK::Metadata", "AWS::IAM::Role", "AWS::IAM::Policy", "AWS::IAM::InstanceProfile", "AWS::Budgets::Budget"].includes(t))
      .map((t) => (t.startsWith("Custom::") || t === "AWS::CloudFormation::CustomResource" ? "lambda" : serviceOf(t))));
  };
  /**
   * Every action of every role's inline statements in every environment template, except the service
   * role's own `Services` wildcards: those are derived from what the templates need (as are the CloudFront statements), so counting them
   * as a need would make the "nothing unused" checks circular.
   */
  const usedActions = () => new Set(environmentResources().flatMap(({ stack, resources }) => roleStatements(resources)
    .filter((st) => !(stack.stackName === "agentx-staging-access" && (st.Sid === "Services" || st.Sid?.startsWith("CloudFront") || st.Sid?.startsWith("CustomDomain"))))
    .flatMap((st) => [st.Action].flat())));

  it("exists only for named environments, first in the app", () => {
    expect(access).toBeDefined();
    expect(stacksOf(buildAgentXApp()).some((s) => s.stackName.toLowerCase().includes("access"))).toBe(false);
  });

  it("creates a private, encrypted, versioned artifact bucket kept on delete", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      VersioningConfiguration: { Status: "Enabled" },
    });
    // Kept on delete and on replacement; a failed first create removes it (named-retention.test.ts).
    template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "RetainExceptOnCreate", UpdateReplacePolicy: "Retain" });
  });

  it("creates the pull-through cache rule for ECR Public", () => {
    template.hasResourceProperties("AWS::ECR::PullThroughCacheRule", { EcrRepositoryPrefix: "agentx-staging", UpstreamRegistryUrl: "public.ecr.aws" });
  });

  it("creates the CloudFormation service role and the operator role with fixed names", () => {
    template.hasResourceProperties("AWS::IAM::Role", { RoleName: "agentx-staging-cloudformation",
      AssumeRolePolicyDocument: Match.objectLike({ Statement: Match.arrayWith([Match.objectLike({ Principal: { Service: "cloudformation.amazonaws.com" } })]) }) });
    template.hasResourceProperties("AWS::IAM::Role", { RoleName: "agentx-staging-operator", MaxSessionDuration: 3600 });
  });

  it("outputs what later deploys need", () => {
    expect(Object.keys(template.toJSON().Outputs as object).sort()).toEqual(["ArtifactBucketName", "CloudFormationRoleArn", "EffectiveBoundaryArn", "OperatorRoleArn", "PullThroughPrefix"]);
  });

  it("declares both parameters with their exact allowed patterns", () => {
    template.hasParameter("PermissionsBoundaryArn", { Type: "String", Default: "", AllowedPattern: "^$|^arn:aws[a-z-]*:iam::[0-9]{12}:policy/.+$" });
    template.hasParameter("OperatorPrincipalArn", { Type: "String", Default: "", AllowedPattern: "^$|^arn:aws[a-z-]*:iam::[0-9]{12}:(root|role/.+|user/.+)$" });
  });

  const boundaryPolicies = Object.entries(template.findResources("AWS::IAM::ManagedPolicy") as Record<string, Resource>);
  const boundaryId = boundaryPolicies[0]?.[0] ?? "missing";
  const effectiveBoundary = { "Fn::If": ["HasPermissionsBoundary", { Ref: "PermissionsBoundaryArn" }, { Ref: boundaryId }] };

  it("creates the default boundary under the environment path only when no boundary is given", () => {
    expect(boundaryPolicies).toHaveLength(1);
    const [, policy] = boundaryPolicies[0]!;
    expect(policy.Condition).toBe("UseDefaultBoundary");
    expect((template.toJSON() as { Conditions: Record<string, unknown> }).Conditions.UseDefaultBoundary).toEqual({ "Fn::Not": [{ Condition: "HasPermissionsBoundary" }] });
    // Name and path make its ARN arn:<partition>:iam::<account>:policy/agentx/staging/agentx-staging-boundary,
    // the ARN every other stack names.
    expect(policy.Properties.ManagedPolicyName).toBe("agentx-staging-boundary");
    expect(policy.Properties.Path).toBe("/agentx/staging/");
    const statements = (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
    // The deployed boundary carries no Sids (its 6,144-character cap), but the same statements in the same order.
    expect(statements.every((st) => st.Sid === undefined)).toBe(true);
    expect(boundaryWithSids(statements).map((st) => st.Sid)).toEqual(defaultBoundaryStatements({ env: "staging", partition: "aws", region: "us-east-1", account: "1", cloudFormationRoleName: "x" }).map((st) => st.Sid));
  });

  it("always applies a boundary to both access roles: the given one, else the default", () => {
    template.hasResourceProperties("AWS::IAM::Role", { RoleName: "agentx-staging-cloudformation", PermissionsBoundary: effectiveBoundary });
    template.hasResourceProperties("AWS::IAM::Role", { RoleName: "agentx-staging-operator", PermissionsBoundary: effectiveBoundary });
    template.hasOutput("EffectiveBoundaryArn", { Value: effectiveBoundary });
  });

  it("always emits both boundary Deny statements, naming the effective boundary", () => {
    const roles = Object.values(template.findResources("AWS::IAM::Role", { Properties: { RoleName: "agentx-staging-cloudformation" } }));
    expect(roles).toHaveLength(1);
    const statements = serviceRoleWithSids((roles[0] as { Properties: { Policies: { PolicyDocument: { Statement: Record<string, unknown>[] } }[] } }).Properties.Policies[0]!.PolicyDocument.Statement);
    expect(statements.filter((st) => "Fn::If" in st)).toEqual([]);
    const require = statements.find((st) => st.Sid === "IamRequireBoundary")!;
    expect(require.Effect).toBe("Deny");
    expect(require.Condition).toEqual({ StringNotEquals: { "iam:PermissionsBoundary": effectiveBoundary } });
    expect(statements.find((st) => st.Sid === "IamKeepBoundary")!.Effect).toBe("Deny");
  });

  it("lets the default boundary allow every action AgentX's roles use", () => {
    // AWS-managed policies attached through ManagedPolicyArns, with the service prefixes of the
    // actions in their current default versions (docs.aws.amazon.com/aws-managed-policy/latest/reference/).
    const MANAGED_POLICY_SERVICES: Record<string, string[]> = {
      AWSLambdaBasicExecutionRole: ["logs"],
      AWSLambdaVPCAccessExecutionRole: ["ec2", "logs"],
    };
    const all = environmentResources().map(({ resources }) => resources);
    const actions = usedActions();
    const managed = new Set(all.flatMap((resources) => Object.values(resources).filter((r) => r.Type === "AWS::IAM::Role")
      .flatMap((r) => (r.Properties.ManagedPolicyArns ?? []) as unknown[]).map((arn) => JSON.stringify(arn).match(/policy\/(?:service-role\/)?([A-Za-z0-9]+)/)![1]!)));
    expect([...managed].sort()).toEqual(Object.keys(MANAGED_POLICY_SERVICES).sort());

    const boundary = boundaryWithSids((boundaryPolicies[0]![1].Properties.PolicyDocument as { Statement: Statement[] }).Statement).filter((st) => st.Effect === "Allow");
    const allowed = new Set(boundary.flatMap((st) => [st.Action].flat()));
    const allowedServices = new Set([...allowed].filter((a) => a.endsWith(":*")).map((a) => a.split(":")[0]));
    expect(allowedServices.has("iam")).toBe(false);
    // The service role creates resources of these services, and the roles call them.
    // IAM is allowed by name only (roles, instance profiles and, ruling M2, agentx-* managed policies), never by wildcard.
    const neededServices = new Set([...resourceTypeServices(), ...Object.values(MANAGED_POLICY_SERVICES).flat()].filter((s) => s !== "iam"));
    // AppSync is allowed by name (Events APIs and their namespaces only, Plan 5 Task 8), never by wildcard.
    expect(allowedServices.has("appsync")).toBe(false);
    // 0.5.17: by name or by pattern (the four channel namespace actions are BOUNDARY_APPSYNC_NAMESPACE_ACTIONS in the boundary).
    expect([...APPSYNC_EVENTS_ACTIONS, ...APPSYNC_EVENTS_UNSCOPED_ACTIONS].filter((action) => ![...allowed].some((pattern) => globMatches(pattern, action)))).toEqual([]);
    // CloudFront is allowed by name too (distributions by environment tag, the rest by ARN), never `cloudfront:*`.
    expect(allowedServices.has("cloudfront")).toBe(false);
    expect([...CLOUDFRONT_ALL_ACTIONS].filter((action) => !CLOUDFRONT_BOUNDARY_ACTIONS.some((pattern) => globMatches(pattern, action)))).toEqual([]);
    expect([...neededServices].filter((service) => !allowedServices.has(service) && !(service === "events" && allowed.has("events:*")) && service !== "appsync" && service !== "cloudfront" && !CUSTOM_DOMAIN_SERVICES.has(service))).toEqual([]);
    // Every action a role uses is allowed by its service's wildcard or by name (IAM, STS and
    // Service Quotas only by name: servicequotas:GetServiceQuota is the operator's one scoped
    // quota read, never servicequotas:*).
    const namedActions = [...actions];
    expect(namedActions.length).toBeGreaterThan(0);
    // The service role's own boundary Deny actions (DeleteRolePermissionsBoundary, and the IamKeepBoundaryPolicy actions of ruling
    // M2's review) are never needed as allows.
    const denyOnly = new Set(["iam:DeleteRolePermissionsBoundary", "iam:SetDefaultPolicyVersion"]);
    // 2026-11-03: the boundary names the instance profile actions with one pattern (`iam:*InstanceProfile`), so "allowed" is by name or by pattern.
    expect(namedActions.filter((a) => !denyOnly.has(a) && ![...allowed].some((pattern) => globMatches(pattern, a)) && !allowedServices.has(a.split(":")[0]))).toEqual([]);
    // Nothing the roles never use: every wildcard service is a resource type's service or used by an action.
    const used = new Set([...neededServices, ...[...actions].map((a) => a.split(":")[0]!)]);
    expect([...allowedServices].filter((service) => !used.has(service!))).toEqual([]);
  }, 240_000);

  it("lets the service role and the boundary manage the EC2 workers' instance profile, by name and path", () => {
    const hasProfile = environmentResources().some(({ resources }) => Object.values(resources).some((r) => r.Type === "AWS::IAM::InstanceProfile"));
    expect(hasProfile).toBe(true);
    const profileStatement = (statements: Statement[]) => statements.find((st) => st.Sid === "IamInstanceProfiles");
    const service = profileStatement(roleStatements(template.toJSON().Resources as Record<string, Resource>))!;
    const boundary = profileStatement(boundaryWithSids((boundaryPolicies[0]![1].Properties.PolicyDocument as { Statement: Statement[] }).Statement))!;
    // 2026-11-03: the boundary's one pattern covers the actions the service role names (tests/contract/access-policies.test.ts pins it to exactly the seven INSTANCE_PROFILE_ACTIONS).
    const permitted = (statement: Statement, action: string) => [statement.Action].flat().some((pattern) => globMatches(pattern, action));
    for (const statement of [service, boundary]) {
      for (const action of ["iam:CreateInstanceProfile", "iam:AddRoleToInstanceProfile", "iam:DeleteInstanceProfile"]) expect(permitted(statement, action), action).toBe(true);
      expect(JSON.stringify(statement.Resource)).toContain("instance-profile/agentx/staging/*");
    }
    for (const action of [service.Action].flat()) expect(permitted(boundary, action), `boundary allows ${action}`).toBe(true);
  }, 240_000);

  it("gives the CloudFormation service role and the boundary no cloudfront:*", () => {
    const serviceStatements = roleStatements(template.toJSON().Resources as Record<string, Resource>).filter((st) => st.Sid !== undefined);
    const boundaryStatements = boundaryWithSids((boundaryPolicies[0]![1].Properties.PolicyDocument as { Statement: Statement[] }).Statement);
    for (const [name, statements] of [["service role", serviceStatements], ["boundary", boundaryStatements]] as const) {
      const actions = statements.flatMap((st) => [st.Action].flat());
      expect(actions, name).not.toContain("cloudfront:*");
      expect(actions.filter((action) => /^cloudfront:\*?$/.test(action) || action === "*"), name).toEqual([]);
    }
    // The service role names each CloudFront action: distributions by this environment's tag, the rest by ARN, and only the resource-less ones on "*".
    const cloudfront = serviceStatements.filter((st) => st.Effect === "Allow" && [st.Action].flat().some((action) => action.startsWith("cloudfront:")));
    expect([...new Set(cloudfront.flatMap((st) => [st.Action].flat()))].sort()).toEqual([...CLOUDFRONT_ALL_ACTIONS].sort());
    const onStar = cloudfront.filter((st) => st.Resource === "*");
    expect(onStar.map((st) => st.Sid).sort()).toEqual(["CloudFrontDistributionCreate", "CloudFrontDistributionTag", "CloudFrontUnscoped"]);
    expect(onStar.find((st) => st.Sid === "CloudFrontDistributionCreate")!.Condition).toEqual({ StringEquals: { "aws:RequestTag/agentx:env": "staging" } });
    expect(cloudfront.find((st) => st.Sid === "CloudFrontDistributions")!.Condition).toEqual({ StringEquals: { "aws:ResourceTag/agentx:env": "staging" } });
    // TagResource on "*" only with this environment's request tag (the create path); on an own-tagged distribution it is in CloudFrontDistributions (a tag-only update).
    expect(onStar.find((st) => st.Sid === "CloudFrontDistributionTag")!.Condition).toEqual({ StringEquals: { "aws:RequestTag/agentx:env": "staging" } });
    expect([cloudfront.find((st) => st.Sid === "CloudFrontDistributions")!.Action].flat()).toContain("cloudfront:TagResource");
    const scoped = JSON.stringify(cloudfront.filter((st) => st.Resource !== "*").map((st) => st.Resource));
    expect(scoped).toContain(":cloudfront::");
    for (const type of ["distribution", "origin-access-control", "response-headers-policy"]) expect(scoped).toContain(`:${type}/*`);
    for (const sid of ["CloudFrontKeepEnvironmentTag", "CloudFrontOnlyOwnEnvironmentTag"]) {
      const deny = serviceStatements.find((st) => st.Sid === sid)!;
      expect(deny.Effect).toBe("Deny");
      expect(deny.Action).toEqual(["cloudfront:TagResource"]);
    }
    // The boundary is the ceiling: CloudFront action families on its Services statement, nothing for any other CloudFront action.
    const ceiling = boundaryStatements.find((st) => st.Sid === "Services")!;
    expect([ceiling.Action].flat().filter((action) => action.startsWith("cloudfront:"))).toEqual([...CLOUDFRONT_BOUNDARY_ACTIONS]);
    expect(boundaryStatements.some((st) => String(st.Sid).startsWith("CloudFront"))).toBe(false);
  });

  it("lets only CloudFormation in this account assume the service role", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "agentx-staging-cloudformation",
      AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{
        Effect: "Allow", Principal: { Service: "cloudformation.amazonaws.com" }, Action: "sts:AssumeRole",
        Condition: { StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } } },
      }] },
    });
  });

  it("trusts the given operator principal, or the account root when none is given", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "agentx-staging-operator",
      AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{
        Effect: "Allow", Action: "sts:AssumeRole",
        Principal: { AWS: { "Fn::If": ["HasOperatorPrincipal", { Ref: "OperatorPrincipalArn" },
          { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::", { Ref: "AWS::AccountId" }, ":root"]] }] } },
      }] },
    });
  });

  it("keeps the access roles at the root path", () => {
    for (const role of Object.values(template.findResources("AWS::IAM::Role"))) {
      expect((role as { Properties: Record<string, unknown> }).Properties.Path).toBeUndefined();
    }
  });

  it("names no literal region in the released access template, so it deploys in any region", () => {
    const released = buildAgentXApp({ agentxEnv: ENVIRONMENT_PLACEHOLDER, agentxSynthesizer: "legacy" }).synth();
    const text = JSON.stringify(released.getStackByName(`agentx-${ENVIRONMENT_PLACEHOLDER}-access`).template);
    expect(text).not.toContain("us-east-1");
    expect(text).toContain('"Ref":"AWS::Region"');
  }, 240_000);

  it("lets the service role create every resource type the environment templates contain, and nothing unused", () => {
    const needed = resourceTypeServices();
    // IAM resource types (roles, instance profiles, and the broker's agentx-* managed policies, ruling M2) are created through
    // the service role's by-name IAM statements, never an iam:* wildcard.
    // The Team record's three storage services are named by action on the environment's own resources (TEAM_RECORD_*_DEPLOY_ACTIONS), never a wildcard.
    expect([...needed].filter((service) => !SERVICE_ROLE_SERVICES.includes(service) && service !== "events" && service !== "iam" && service !== "appsync" && service !== "cloudfront" && !CUSTOM_DOMAIN_SERVICES.has(service) && !TEAM_RECORD_BOUNDARY_SERVICES.includes(service))).toEqual([]);
    for (const service of TEAM_RECORD_BOUNDARY_SERVICES) expect(SERVICE_ROLE_SERVICES).not.toContain(service);
    // AppSync (Events APIs and namespaces, Plan 5 Task 8) is created through its named actions, never `appsync:*`.
    const created = roleStatements(template.toJSON().Resources as Record<string, Resource>).find((st) => st.Sid === "AppSyncEvents")!;
    expect([...(created.Action as string[])].sort()).toEqual([...APPSYNC_EVENTS_ACTIONS].sort());
    // CreateApi and ListApis take no resource type: their own statement, "*" held to the deploy region.
    const createApi = roleStatements(template.toJSON().Resources as Record<string, Resource>).find((st) => st.Sid === "AppSyncEventsCreate")!;
    expect([...(createApi.Action as string[])].sort()).toEqual([...APPSYNC_EVENTS_UNSCOPED_ACTIONS].sort());
    expect(createApi.Resource).toBe("*");
    expect(JSON.stringify(createApi.Condition)).toContain("aws:RequestedRegion");
    expect(SERVICE_ROLE_SERVICES).not.toContain("appsync");
    expect(SERVICE_ROLE_SERVICES).not.toContain("cloudfront");
    // The reverse: every wildcard service is created by some resource type or called by some role.
    const used = new Set([...needed, ...[...usedActions()].map((a) => a.split(":")[0]!)]);
    expect(SERVICE_ROLE_SERVICES.filter((service) => !used.has(service))).toEqual([]);
  }, 240_000);

  it("covers the resource types only the hosted cloud creates", () => {
    const typesOf = (a: App) => resourcesInApp(a).flatMap(({ resources }) => Object.values(resources).map((r) => r.Type));
    const plainTypes = new Set(typesOf(app));
    const cloudOnly = typesOf(cloudApp).filter((type) => !plainTypes.has(type));
    // Guards the premise: the cloud app really adds DNS firewall, query logging and Cognito types.
    expect(cloudOnly).toEqual(expect.arrayContaining([
      "AWS::Route53Resolver::FirewallDomainList", "AWS::Route53Resolver::FirewallRuleGroup", "AWS::Route53Resolver::FirewallRuleGroupAssociation",
      "AWS::Route53Resolver::ResolverQueryLoggingConfig", "AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation",
      "AWS::Cognito::UserPoolIdentityProvider", "AWS::Cognito::ManagedLoginBranding",
    ]));
  });

  it("lets the service role and the boundary create the Route 53 Resolver service-linked role the query logging association makes", () => {
    // Blind spot of the generic checks above: service-linked roles are created implicitly by the
    // service, so no resource type or role action in the templates ever names them.
    const hasAssociation = resourcesInApp(cloudApp).some(({ resources }) => Object.values(resources).some((r) => r.Type === "AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation"));
    expect(hasAssociation).toBe(true);
    expect(SERVICE_LINKED_ROLE_SERVICES).toContain("route53resolver.amazonaws.com");
    const scope = { env: "staging", partition: "aws", region: "us-east-1", account: "123456789012", artifactBucketArn: "arn:aws:s3:::b", pullThroughPrefix: "agentx-staging", cloudFormationRoleName: "agentx-staging-cloudformation" };
    for (const statements of [serviceRoleStatements(scope), defaultBoundaryStatements(scope)]) {
      const linked = statements.find((st) => st.Sid === "ServiceLinkedRoles")!;
      const names = (linked.Condition as { StringLike: { "iam:AWSServiceName": string[] } }).StringLike["iam:AWSServiceName"];
      expect(names).toContain("route53resolver.amazonaws.com");
    }
  });
});
