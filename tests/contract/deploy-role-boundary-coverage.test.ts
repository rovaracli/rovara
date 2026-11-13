// MODEL-PROXY-TLS-BOUNDARY-BLOCKER (0.5.17): the deploy (CloudFormation service) role carries the environment's permissions boundary, like every role in the access stack, so a grant
// the boundary does not also allow is implicitly denied at install time. 0.5.15 found that out on staging: ModelProxyTlsDeployPolicy's acm and route53 actions were outside
// agentx-<env>-boundary, and the older checks missed it because they read only the role's inline policies and skipped the custom domain's statements.
//
// The general guard: synthesize the access stack in every shape that changes the deploy role's grants (plain, hosted cloud with its custom domain and the Team record, model proxy
// TLS with a requested or a brought certificate, the one deploy that cleans up a previous TLS name, Enterprise operator access), resolve the template for those parameter values,
// and ask, for every Allow in every policy the deploy role holds (inline, AWS::IAM::Policy and AWS::IAM::ManagedPolicy alike), whether the deployed default boundary lets that
// action through on that resource. The request carries the condition values the grant itself pins (iam:AWSServiceName, aws:RequestTag/..., aws:RequestedRegion), so a boundary
// statement held by a condition is only counted when the grant satisfies it. A grant whose action is a wildcard (`s3:*`) is checked as that literal text, so the boundary must
// hold the same or a wider pattern.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { BOUNDARY_CERTIFICATE_AND_RECORD_ACTIONS, defaultBoundaryArn, defaultBoundaryStatements } from "../../infra/lib/access-policies.js";
import { MODEL_PROXY_TLS_CONTEXT_KEYS as T, MODEL_PROXY_TLS_PREVIOUS_CONTEXT_KEYS as P } from "../../infra/lib/model-proxy-tls.js";
import { evaluate, type CfnContext } from "../support/cfn-evaluate.js";
import { simulateIam, type IamStatement } from "../support/iam-simulate.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Condition?: string; Properties: Record<string, unknown> };
type Json = { Parameters?: Record<string, { Default?: string }>; Conditions?: Record<string, unknown>; Resources: Record<string, Resource> };
type Statement = IamStatement & { Effect: string };

const ACCOUNT = "123456789012";
const REGION = "us-west-2";
const NAME = "model-proxy.staging.example.com";
const ZONE = "Z0123456789ABCDEFGHIJ";
const OLD_ZONE = "Z9876543210ZYXWVUTSRQ";
const BROUGHT = `arn:aws:acm:${REGION}:${ACCOUNT}:certificate/11111111-2222-3333-4444-555555555555`;
const CLOUD = { agentxEnv: "staging", agentxCloud: "true", agentxRegion: REGION };
const DOMAIN = { CustomDomainName: "staging.example.com", CustomDomainHostedZoneId: "Z08286002FKUL2VBSO3MO" };

const SHAPES: Array<{ name: string; context: Record<string, unknown>; parameters?: Record<string, string> }> = [
  { name: "plain", context: { agentxEnv: "staging", agentxRegion: REGION } },
  { name: "hosted cloud, custom domain and Team record on", context: { ...CLOUD, agentxTeamRecord: "enabled" }, parameters: DOMAIN },
  { name: "model proxy TLS, requested certificate", context: { ...CLOUD, [T.name]: NAME, [T.zoneId]: ZONE, [T.legacyHttp]: "keep" } },
  { name: "model proxy TLS, brought certificate", context: { ...CLOUD, [T.name]: NAME, [T.zoneId]: ZONE, [T.certificateArn]: BROUGHT } },
  { name: "model proxy TLS moved to a new zone (the previous name's clean-up deploy)", context: { ...CLOUD, [T.name]: NAME, [T.zoneId]: ZONE, [P.name]: "old.staging.example.com", [P.zoneId]: OLD_ZONE, [P.certificate]: "requested" } },
  { name: "Enterprise with operator access", context: { agentxEnv: "ent", agentxRegion: REGION, rovaraEdition: "enterprise", rovaraEnterpriseEgressCidrs: "10.99.0.0/16", agentxAuditTsa: "off", rovaraOperatorAccess: "enabled", rovaraOperatorPrincipalArn: "arn:aws:iam::210987654321:role/rovara-operators", rovaraOperatorExternalId: "ext-id-held-by-the-customer-0001", rovaraBundleApproverArns: `arn:aws:iam::${ACCOUNT}:role/security-approvers` } },
];

function accessTemplate(context: Record<string, unknown>): { json: Json; env: string } {
  const app = buildAgentXApp(context);
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXAccess");
  if (stack === undefined) throw new Error("no access stack");
  return { json: Template.fromStack(stack).toJSON() as Json, env: String(context.agentxEnv) };
}

/** A template value as IAM would receive it: intrinsics resolved for these parameters, references to other resources spelled out as text. */
function resolver(json: Json, env: string, parameters: Record<string, string>) {
  const defaults = Object.fromEntries(Object.entries(json.Parameters ?? {}).map(([key, parameter]) => [key, parameter.Default ?? ""]));
  const references = Object.fromEntries(Object.keys(json.Resources).map((id) => [id, `ref:${id}`]));
  const context: CfnContext = {
    parameters: { ...references, ...defaults, PermissionsBoundaryArn: "", ...parameters, DefaultPermissionsBoundary: defaultBoundaryArn({ env, partition: "aws", account: ACCOUNT }) },
    conditions: json.Conditions ?? {},
    pseudo: { "AWS::Region": REGION, "AWS::AccountId": ACCOUNT },
  };
  const text = (value: unknown): unknown => typeof value === "string" ? value : Array.isArray(value) ? value.map(text) : JSON.stringify(value);
  return (document: unknown): Statement[] => {
    const resolved = evaluate(document, context) as { Statement: unknown };
    return [resolved.Statement].flat().filter((statement) => statement !== undefined).map((statement) => {
      const { Resource, NotResource, ...rest } = statement as Statement;
      return { ...rest, ...(Resource === undefined ? {} : { Resource: text(Resource) }), ...(NotResource === undefined ? {} : { NotResource: text(NotResource) }) };
    });
  };
}

/** Every policy the deploy role holds: its inline policies, each AWS::IAM::Policy and each AWS::IAM::ManagedPolicy that lists it. */
function deployPolicies(json: Json): Array<{ name: string; document: unknown }> {
  const role = json.Resources.CloudFormationServiceRole;
  if (role === undefined) throw new Error("no deploy role");
  expect(role.Properties.ManagedPolicyArns ?? [], "the deploy role has no AWS-managed or by-ARN policies (they could not be read here)").toEqual([]);
  const holds = (resource: Resource) => ((resource.Properties.Roles ?? []) as Array<{ Ref?: string }>).some((entry) => entry.Ref === "CloudFormationServiceRole");
  return [
    ...((role.Properties.Policies ?? []) as Array<{ PolicyName: string; PolicyDocument: unknown }>).map((policy) => ({ name: `inline ${policy.PolicyName}`, document: policy.PolicyDocument })),
    ...Object.entries(json.Resources).filter(([, resource]) => (resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy") && holds(resource)).map(([id, resource]) => ({ name: id, document: resource.Properties.PolicyDocument })),
  ];
}

/**
 * The condition values a grant pins, as request contexts: a grant that only allows a request carrying them can only be used with them. Null and negated checks pin nothing.
 * A multi-valued key (ForAllValues:/ForAnyValue:) is one context value; a single-valued key given several values (StringLike on iam:AWSServiceName) is one request per value.
 */
function pinnedContexts(statement: Statement): Array<Record<string, string | string[]>> {
  let contexts: Array<Record<string, string | string[]>> = [{}];
  for (const [operator, keys] of Object.entries(statement.Condition ?? {})) {
    if (operator === "Null" || operator.includes("Not")) continue;
    const multi = operator.startsWith("ForAllValues:") || operator.startsWith("ForAnyValue:");
    for (const [key, value] of Object.entries(keys)) {
      const values = [value].flat().map(String);
      contexts = multi ? contexts.map((context) => ({ ...context, [key]: values })) : contexts.flatMap((context) => values.map((one) => ({ ...context, [key]: one })));
    }
  }
  return contexts;
}

/** Every (policy, action, resource) the deploy role is granted that the boundary refuses, with the boundary's reason. */
function refusals(boundary: Statement[], policies: Array<{ name: string; statements: Statement[] }>): string[] {
  const out: string[] = [];
  for (const { name, statements } of policies) {
    for (const statement of statements.filter((entry) => entry.Effect === "Allow")) {
      expect(statement.NotAction, `${name}: a grant by NotAction cannot be checked here`).toBeUndefined();
      const resources = [statement.Resource ?? "*"].flat().map(String);
      for (const action of [statement.Action].flat().map(String)) {
        for (const resource of resources) {
          for (const context of pinnedContexts(statement)) {
            const decision = simulateIam(boundary, { action, resource, context });
            if (!decision.allowed) out.push(`${name} ${statement.Sid ?? ""}: ${action} on ${resource} ${Object.keys(context).length === 0 ? "" : ` with ${JSON.stringify(context)}`} (${decision.reason})`.replace("  ", " "));
          }
        }
      }
    }
  }
  return out;
}

function shapeOf(shape: (typeof SHAPES)[number]) {
  const { json, env } = accessTemplate(shape.context);
  const read = resolver(json, env, shape.parameters ?? {});
  const boundaryResource = json.Resources.DefaultPermissionsBoundary;
  if (boundaryResource === undefined) throw new Error("no default boundary");
  const boundary = read(boundaryResource.Properties.PolicyDocument);
  const policies = deployPolicies(json).map(({ name, document }) => ({ name, statements: read(document) }));
  return { json, env, boundary, policies };
}

describe("every action of every deploy-role policy is inside the deployed default boundary", () => {
  for (const shape of SHAPES) {
    it(`${shape.name}`, () => {
      const { boundary, policies } = shapeOf(shape);
      // Positive control: the policies really were read, and the one under test is among them.
      expect(policies.flatMap(({ statements }) => statements).length).toBeGreaterThan(10);
      if (shape.name.startsWith("model proxy TLS")) expect(policies.map(({ name }) => name).some((name) => name.startsWith("ModelProxyTlsDeployPolicy"))).toBe(true);
      expect(refusals(boundary, policies)).toEqual([]);
    }, 400_000);
  }

  it("the check fails on the pre-0.5.17 boundary: ModelProxyTlsDeployPolicy's certificate and record actions were refused", () => {
    const { boundary, policies } = shapeOf(SHAPES[2]!);
    const before = boundary.map((statement) => ({ ...statement, Action: [statement.Action].flat().map(String).filter((action) => !BOUNDARY_CERTIFICATE_AND_RECORD_ACTIONS.includes(action)) }));
    const refused = refusals(before, policies);
    for (const action of ["acm:RequestCertificate", "acm:AddTagsToCertificate", "acm:DescribeCertificate", "acm:DeleteCertificate", "acm:ListTagsForCertificate", "acm:RemoveTagsFromCertificate", "route53:ChangeResourceRecordSets", "route53:GetChange", "route53:GetHostedZone", "route53:ListResourceRecordSets", "route53:ListHostedZones"]) {
      expect(refused.some((line) => line.startsWith("ModelProxyTlsDeployPolicy") && line.includes(`: ${action} on `)), action).toBe(true);
    }
  }, 400_000);
});

describe("the boundary's certificate and record ceiling (BOUNDARY_CERTIFICATE_AND_RECORD_ACTIONS)", () => {
  const statements = defaultBoundaryStatements({ env: "staging", partition: "aws", region: REGION, account: ACCOUNT, cloudFormationRoleName: "agentx-staging-cloudformation" });
  const allowed = (action: string, resource = "*") => simulateIam(statements, { action, resource }).allowed;
  const certificate = `arn:aws:acm:${REGION}:${ACCOUNT}:certificate/x`;
  const zone = `arn:aws:route53:::hostedzone/${ZONE}`;

  it("allows exactly the eleven actions the deploy role's grants use", () => {
    for (const action of ["acm:RequestCertificate"]) expect(allowed(action), action).toBe(true);
    for (const action of ["acm:AddTagsToCertificate", "acm:DescribeCertificate", "acm:DeleteCertificate", "acm:ListTagsForCertificate", "acm:RemoveTagsFromCertificate"]) expect(allowed(action, certificate), action).toBe(true);
    for (const action of ["route53:ChangeResourceRecordSets", "route53:GetHostedZone", "route53:ListResourceRecordSets"]) expect(allowed(action, zone), action).toBe(true);
    expect(allowed("route53:GetChange", "arn:aws:route53:::change/C1")).toBe(true);
    expect(allowed("route53:ListHostedZones")).toBe(true);
  });

  it("and no other Certificate Manager or Route 53 action (the patterns match only the actions named)", () => {
    // Every other action of the two services in AWS's service authorization reference (acm and route53, 2026-11-12).
    const acm = ["ExportCertificate", "GetAccountConfiguration", "GetCertificate", "ImportCertificate", "ListCertificates", "PutAccountConfiguration", "RenewCertificate", "ResendValidationEmail", "RevokeCertificate", "UpdateCertificateOptions", "SearchCertificates"];
    const route53 = [
      "ActivateKeySigningKey", "AssociateVPCWithHostedZone", "ChangeCidrCollection", "ChangeTagsForResource", "CreateCidrCollection", "CreateHealthCheck", "CreateHostedZone", "CreateKeySigningKey", "CreateQueryLoggingConfig",
      "CreateReusableDelegationSet", "CreateTrafficPolicy", "CreateTrafficPolicyInstance", "CreateTrafficPolicyVersion", "CreateVPCAssociationAuthorization", "DeactivateKeySigningKey", "DeleteCidrCollection", "DeleteHealthCheck",
      "DeleteHostedZone", "DeleteKeySigningKey", "DeleteQueryLoggingConfig", "DeleteReusableDelegationSet", "DeleteTrafficPolicy", "DeleteTrafficPolicyInstance", "DeleteVPCAssociationAuthorization", "DisableHostedZoneDNSSEC",
      "DisassociateVPCFromHostedZone", "EnableHostedZoneDNSSEC", "GetAccountLimit", "GetCheckerIpRanges", "GetDNSSEC", "GetGeoLocation", "GetHealthCheck", "GetHealthCheckCount", "GetHealthCheckLastFailureReason",
      "GetHealthCheckStatus", "GetHostedZoneCount", "GetHostedZoneLimit", "GetQueryLoggingConfig", "GetReusableDelegationSet", "GetReusableDelegationSetLimit", "GetTrafficPolicy", "GetTrafficPolicyInstance",
      "GetTrafficPolicyInstanceCount", "ListCidrBlocks", "ListCidrCollections", "ListCidrLocations", "ListGeoLocations", "ListHealthChecks", "ListHostedZonesByName", "ListHostedZonesByVPC", "ListQueryLoggingConfigs",
      "ListReusableDelegationSets", "ListTagsForResource", "ListTagsForResources", "ListTrafficPolicies", "ListTrafficPolicyInstances", "ListTrafficPolicyInstancesByHostedZone", "ListTrafficPolicyInstancesByPolicy",
      "ListTrafficPolicyVersions", "ListVPCAssociationAuthorizations", "TestDNSAnswer", "UpdateHealthCheck", "UpdateHostedZoneComment", "UpdateTrafficPolicyComment", "UpdateTrafficPolicyInstance",
    ];
    for (const action of acm.map((name) => `acm:${name}`)) expect(allowed(action, certificate) || allowed(action), action).toBe(false);
    for (const action of route53.map((name) => `route53:${name}`)) expect(allowed(action, zone) || allowed(action), action).toBe(false);
  });

  it("is granted to no bounded role but the deploy role: no other role in any environment template holds an acm or route53 action", () => {
    for (const shape of [SHAPES[1]!, SHAPES[2]!]) {
      const app = buildAgentXApp(shape.context);
      for (const stack of app.node.children.filter((child): child is Stack => Stack.isStack(child))) {
        const json = Template.fromStack(stack).toJSON() as Json;
        for (const [id, resource] of Object.entries(json.Resources)) {
          const documents = resource.Type === "AWS::IAM::Role" ? ((resource.Properties.Policies ?? []) as Array<{ PolicyDocument: unknown }>).map((policy) => policy.PolicyDocument)
            : resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy" ? [resource.Properties.PolicyDocument] : [];
          if (documents.length === 0 || (stack.node.id === "AgentXAccess" && (id === "CloudFormationServiceRole" || id.startsWith("ModelProxyTlsDeployPolicy") || id === "DefaultPermissionsBoundary"))) continue;
          expect(JSON.stringify(documents), `${stack.node.id}/${id}`).not.toMatch(/"(acm|route53):/u);
        }
      }
    }
  }, 400_000);
});
