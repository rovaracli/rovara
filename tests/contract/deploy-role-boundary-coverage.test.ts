// MODEL-PROXY-TLS-BOUNDARY-BLOCKER (0.5.17): every role in the access stack carries a permissions boundary, so a grant its boundary does not also allow is implicitly denied at install time.
// 0.5.15 found that out on staging: ModelProxyTlsDeployPolicy's acm and route53 actions were outside agentx-<env>-boundary, and the older checks missed it because they read only the
// roles' inline policies and skipped the custom domain's statements.
//
// The fix (review M-1): the deploy role gets a boundary of its own, agentx-<env>--deploy-boundary (deployRoleBoundaryStatements: the default boundary plus the acm/route53 ceiling and ECR's
// service-linked role), and the default boundary, the ceiling of every role the deploy creates, keeps no acm or route53 action at all.
//
// The general guard: synthesize the access stack in every shape that changes a role's grants (plain, hosted cloud with its custom domain and the Team record, model proxy TLS with a requested
// or a brought certificate, the one deploy that cleans up a previous TLS name, Enterprise operator access), resolve the template for those parameter values, and ask, for every Allow in every
// policy each role holds (inline, AWS::IAM::Policy, AWS::IAM::RolePolicy and AWS::IAM::ManagedPolicy, the role named by Ref or by literal name), whether THAT role's own boundary lets the action
// through on that resource. The request carries the condition values the grant itself pins (iam:AWSServiceName, aws:RequestTag/..., aws:RequestedRegion), so a boundary statement held by a
// condition counts only when the grant satisfies it. A grant whose action is a wildcard (`s3:*`) is checked as that literal text, so the boundary must hold the same or a wider pattern.
import { readFileSync } from "node:fs";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import {
  BOUNDARY_APPSYNC_NAMESPACE_ACTIONS, DEPLOY_ROLE_BOUNDARY_CERTIFICATE_AND_RECORD_ACTIONS, defaultBoundaryArn, defaultBoundaryStatements, deployRoleBoundaryArn, deployRoleBoundaryName, deployRoleBoundaryStatements, serviceRoleStatements as serviceStatementsFor, type PolicyStatementJson,
} from "../../infra/lib/access-policies.js";
import { EnvironmentNameSchema, defaultBoundaryName } from "@rovara-code/contracts";
import { MODEL_PROXY_TLS_CONTEXT_KEYS as T, MODEL_PROXY_TLS_PREVIOUS_CONTEXT_KEYS as P } from "../../infra/lib/model-proxy-tls.js";
import { evaluate, type CfnContext } from "../support/cfn-evaluate.js";
import { simulateIam, type IamStatement } from "../support/iam-simulate.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Condition?: string; Properties: Record<string, unknown> };
type Json = { Parameters?: Record<string, { Default?: string }>; Conditions?: Record<string, unknown>; Resources: Record<string, Resource> };
type Statement = IamStatement & { Effect: string };

/** AWS's action lists for the three services whose boundary patterns this change adds (tests/fixtures/iam-actions-acm-route53-2026-11-12.json). */
const SERVICE_ACTIONS = JSON.parse(readFileSync(new URL("../fixtures/iam-actions-acm-route53-2026-11-12.json", import.meta.url), "utf8")) as { acm: string[]; route53: string[]; appsync: string[] };
const IAM_ACTIONS = (JSON.parse(readFileSync(new URL("../fixtures/iam-actions-2026-11-03.json", import.meta.url), "utf8")) as { actions: string[] }).actions;

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

const list = (value: unknown): string[] => (value === undefined ? [] : [value].flat().map(String));
const glob = (pattern: string, flags: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, flags);

function accessTemplate(context: Record<string, unknown>): { json: Json; env: string } {
  const app = buildAgentXApp(context);
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXAccess");
  if (stack === undefined) throw new Error("no access stack");
  return { json: Template.fromStack(stack).toJSON() as Json, env: String(context.agentxEnv) };
}

/** A template value as IAM would receive it: intrinsics resolved for these parameters, the two boundaries' Refs as their ARNs, other resources' references spelled out as text. */
function resolver(json: Json, env: string, parameters: Record<string, string>) {
  const defaults = Object.fromEntries(Object.entries(json.Parameters ?? {}).map(([key, parameter]) => [key, parameter.Default ?? ""]));
  const references = Object.fromEntries(Object.keys(json.Resources).map((id) => [id, `ref:${id}`]));
  const scope = { env, partition: "aws", account: ACCOUNT };
  const context: CfnContext = {
    parameters: { ...references, ...defaults, PermissionsBoundaryArn: "", ...parameters, DefaultPermissionsBoundary: defaultBoundaryArn(scope), DeployRolePermissionsBoundary: deployRoleBoundaryArn(scope) },
    conditions: json.Conditions ?? {},
    pseudo: { "AWS::Region": REGION, "AWS::AccountId": ACCOUNT },
  };
  const text = (value: unknown): unknown => typeof value === "string" ? value : Array.isArray(value) ? value.map(text) : JSON.stringify(value);
  return {
    value: (value: unknown) => evaluate(value, context),
    statements: (document: unknown): Statement[] => {
      const resolved = evaluate(document, context) as { Statement: unknown };
      return [resolved.Statement].flat().filter((statement) => statement !== undefined).map((statement) => {
        const { Resource, NotResource, ...rest } = statement as Statement;
        return { ...rest, ...(Resource === undefined ? {} : { Resource: text(Resource) }), ...(NotResource === undefined ? {} : { NotResource: text(NotResource) }) };
      });
    },
  };
}

/** Every role of the stack with its boundary's ARN and every policy it holds: inline, AWS::IAM::Policy, AWS::IAM::RolePolicy and AWS::IAM::ManagedPolicy, the role named by Ref or by its literal name. */
function rolesOf(json: Json, read: ReturnType<typeof resolver>) {
  const roles = Object.entries(json.Resources).filter(([, resource]) => resource.Type === "AWS::IAM::Role");
  return roles.map(([id, role]) => {
    const roleName = read.value(role.Properties.RoleName);
    const isThis = (entry: unknown) => (typeof entry === "object" && entry !== null && (entry as { Ref?: string }).Ref === id) || (roleName !== undefined && read.value(entry) === roleName);
    expect(role.Properties.ManagedPolicyArns ?? [], `${id}: no policy attached by ARN (it could not be read here)`).toEqual([]);
    const policies = [
      ...((role.Properties.Policies ?? []) as Array<{ PolicyName: string; PolicyDocument: unknown }>).map((policy) => ({ name: `${id} inline ${policy.PolicyName}`, document: policy.PolicyDocument })),
      ...Object.entries(json.Resources).filter(([, resource]) => {
        if (resource.Type === "AWS::IAM::RolePolicy") return isThis(resource.Properties.RoleName);
        if (resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy") return ((resource.Properties.Roles ?? []) as unknown[]).some(isThis);
        return false;
      }).map(([policyId, resource]) => ({ name: policyId, document: resource.Properties.PolicyDocument })),
    ];
    return { id, boundary: String(read.value(role.Properties.PermissionsBoundary)), policies: policies.map(({ name, document }) => ({ name, statements: read.statements(document) })) };
  });
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
      const values = list(value);
      contexts = multi ? contexts.map((context) => ({ ...context, [key]: values })) : contexts.flatMap((context) => values.map((one) => ({ ...context, [key]: one })));
    }
  }
  return contexts;
}

/** Every (policy, action, resource) granted that the boundary refuses, with the boundary's reason. */
function refusals(boundary: Statement[], policies: Array<{ name: string; statements: Statement[] }>): string[] {
  const out: string[] = [];
  for (const { name, statements } of policies) {
    for (const statement of statements.filter((entry) => entry.Effect === "Allow")) {
      expect(statement.NotAction, `${name}: a grant by NotAction cannot be checked here`).toBeUndefined();
      for (const action of list(statement.Action)) {
        for (const resource of list(statement.Resource ?? "*")) {
          for (const context of pinnedContexts(statement)) {
            const decision = simulateIam(boundary, { action, resource, context });
            if (!decision.allowed) out.push(`${name} ${statement.Sid ?? ""}: ${action} on ${resource}${Object.keys(context).length === 0 ? "" : ` with ${JSON.stringify(context)}`} (${decision.reason})`.replace("  ", " "));
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
  const boundaryOf = (id: string) => {
    const resource = json.Resources[id];
    if (resource === undefined) throw new Error(`no ${id}`);
    return read.statements(resource.Properties.PolicyDocument);
  };
  const scope = { env, partition: "aws", account: ACCOUNT };
  const boundaries: Record<string, Statement[]> = { [defaultBoundaryArn(scope)]: boundaryOf("DefaultPermissionsBoundary"), [deployRoleBoundaryArn(scope)]: boundaryOf("DeployRolePermissionsBoundary") };
  return { env, boundaries, roles: rolesOf(json, read), scope };
}

describe("every action of every policy an access-stack role holds is inside that role's own boundary", () => {
  for (const shape of SHAPES) {
    it(`${shape.name}`, () => {
      const { boundaries, roles, scope } = shapeOf(shape);
      // The deploy role carries its own boundary; every other role (the operator role, operator access's roles) the default one.
      expect(roles.find((role) => role.id === "CloudFormationServiceRole")?.boundary).toBe(deployRoleBoundaryArn(scope));
      for (const role of roles.filter((entry) => entry.id !== "CloudFormationServiceRole")) expect(role.boundary, role.id).toBe(defaultBoundaryArn(scope));
      expect(roles.length).toBeGreaterThanOrEqual(shape.name.startsWith("Enterprise") ? 3 : 2);
      // Positive control: the policies really were read, and the one under test is among them.
      const deploy = roles.find((role) => role.id === "CloudFormationServiceRole")!;
      expect(deploy.policies.flatMap(({ statements }) => statements).length).toBeGreaterThan(10);
      if (shape.name.startsWith("model proxy TLS")) expect(deploy.policies.some(({ name }) => name.startsWith("ModelProxyTlsDeployPolicy"))).toBe(true);
      expect(roles.flatMap((role) => refusals(boundaries[role.boundary]!, role.policies))).toEqual([]);
    }, 400_000);
  }

  it("the check fails against the default boundary: ModelProxyTlsDeployPolicy's certificate and record actions were refused there (the 0.5.15 blocker), and ECR's service-linked role", () => {
    const { boundaries, roles, scope } = shapeOf(SHAPES[2]!);
    const refused = refusals(boundaries[defaultBoundaryArn(scope)]!, roles.find((role) => role.id === "CloudFormationServiceRole")!.policies);
    for (const action of ["acm:RequestCertificate", "acm:AddTagsToCertificate", "acm:DescribeCertificate", "acm:DeleteCertificate", "acm:ListTagsForCertificate", "acm:RemoveTagsFromCertificate", "route53:ChangeResourceRecordSets", "route53:GetChange", "route53:GetHostedZone", "route53:ListResourceRecordSets", "route53:ListHostedZones"]) {
      expect(refused.some((line) => line.startsWith("ModelProxyTlsDeployPolicy") && line.includes(`: ${action} on `)), action).toBe(true);
    }
    expect(refused.some((line) => line.includes("iam:CreateServiceLinkedRole") && line.includes("ecr.amazonaws.com"))).toBe(true);
  }, 400_000);
});

describe("the default boundary (every role the deploy creates) allows no Certificate Manager or Route 53 action", () => {
  const scope = { env: "staging", partition: "aws", region: REGION, account: ACCOUNT, cloudFormationRoleName: "agentx-staging-cloudformation" };
  const roleUnderPath = `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-some-template-role`;

  it("a role created under /agentx/<env>/ with the default boundary and a policy allowing acm:* and route53:* on * cannot rewrite a zone's records or delete a certificate", () => {
    // The deploy role may create such a role only with the default boundary (IamRequireBoundary pins iam:PermissionsBoundary to it; checked below).
    const boundary = defaultBoundaryStatements(scope) as Statement[];
    const identity: Statement[] = [{ Effect: "Allow", Action: ["acm:*", "route53:*"], Resource: "*" }];
    const both = (action: string, resource: string) => simulateIam(identity, { action, resource }).allowed && simulateIam(boundary, { action, resource }).allowed;
    expect(simulateIam(identity, { action: "route53:ChangeResourceRecordSets", resource: `arn:aws:route53:::hostedzone/${ZONE}` }).allowed).toBe(true);
    expect(both("route53:ChangeResourceRecordSets", `arn:aws:route53:::hostedzone/${ZONE}`), roleUnderPath).toBe(false);
    expect(both("acm:DeleteCertificate", `arn:aws:acm:${REGION}:${ACCOUNT}:certificate/x`), roleUnderPath).toBe(false);
    // And none of the two services' other actions, on any resource either boundary names.
    for (const action of [...SERVICE_ACTIONS.acm, ...SERVICE_ACTIONS.route53]) {
      for (const resource of ["*", `arn:aws:route53:::hostedzone/${ZONE}`, "arn:aws:route53:::change/C1", `arn:aws:acm:${REGION}:${ACCOUNT}:certificate/x`]) expect(simulateIam(boundary, { action, resource }).allowed, `${action} on ${resource}`).toBe(false);
    }
  });
});

describe("the deploy role's boundary is the default boundary plus exactly the 0.5.17 additions", () => {
  for (const env of ["staging", "a".repeat(20)]) {
    const scope = { env, partition: "aws", region: REGION, account: ACCOUNT, cloudFormationRoleName: `agentx-${env}-cloudformation` };
    const before = defaultBoundaryStatements(scope);
    const after = deployRoleBoundaryStatements(scope);

    it(`${env}: the IamRequireBoundary pin still names the default boundary, never the deploy role's`, () => {
      const pin = serviceStatementsFor({ ...scope, artifactBucketArn: "arn:aws:s3:::b", pullThroughPrefix: `agentx-${env}` }).find((statement) => statement.Sid === "IamRequireBoundary")!;
      expect(pin.Condition).toEqual({ StringNotEquals: { "iam:PermissionsBoundary": defaultBoundaryArn(scope) } });
    });

    it(`${env}: conditional statements, one action at a time, are the default's plus ecr.amazonaws.com in ServiceLinkedRoles`, () => {
      const perAction = (statements: readonly PolicyStatementJson[]) => statements.filter((statement) => statement.Condition !== undefined)
        .flatMap((statement) => list(statement.Action).map((action) => JSON.stringify({ ...statement, Sid: undefined, Action: [action] }))).sort();
      const expected = before.map((statement) => statement.Sid === "ServiceLinkedRoles"
        ? { ...statement, Condition: { StringLike: { "iam:AWSServiceName": [...list((statement.Condition as { StringLike: Record<string, unknown> }).StringLike["iam:AWSServiceName"]), "ecr.amazonaws.com"] } } } : statement);
      expect(perAction(after)).toEqual(perAction(expected));
      // The merge is sound only because the two merged statements had the same Resource and Condition.
      const ses = before.find((statement) => statement.Sid === "SesAccountCheck")!;
      const create = before.find((statement) => statement.Sid === "AppSyncEventsCreate")!;
      expect([ses.Resource, ses.Condition]).toEqual([create.Resource, create.Condition]);
    });

    it(`${env}: unconditional statements permit the same (action, resource) pairs, except the acm and route53 ceiling, and deny changes to both boundaries`, () => {
      const covers = (statement: PolicyStatementJson, action: string, resource: string) => list(statement.Action).some((pattern) => glob(pattern, "i").test(action))
        && (statement.NotResource !== undefined ? !list(statement.NotResource).some((pattern) => glob(pattern, "").test(resource)) : list(statement.Resource).some((pattern) => glob(pattern, "").test(resource)));
      const permits = (statements: readonly PolicyStatementJson[], action: string, resource: string) => {
        const plain = statements.filter((statement) => statement.Condition === undefined);
        return !plain.some((statement) => statement.Effect === "Deny" && covers(statement, action, resource)) && plain.some((statement) => statement.Effect === "Allow" && covers(statement, action, resource));
      };
      const arns = [...before, ...after].flatMap((statement) => [...list(statement.Resource), ...list(statement.NotResource)]);
      const resources = [...new Set(["*", deployRoleBoundaryArn(scope), ...arns.flatMap((arn) => arn.includes("*") ? [arn.replace(/\*/g, "x"), arn.replace(/\*/g, "")] : [arn, `${arn}-other`])])];
      const actions = [...new Set([...IAM_ACTIONS, ...SERVICE_ACTIONS.appsync, ...SERVICE_ACTIONS.acm, ...SERVICE_ACTIONS.route53, ...[...before, ...after].flatMap((statement) => list(statement.Action)).filter((action) => !action.includes("*"))])];
      const added = (action: string) => DEPLOY_ROLE_BOUNDARY_CERTIFICATE_AND_RECORD_ACTIONS.some((pattern) => glob(pattern, "i").test(action));
      const differences: string[] = [];
      let permitted = 0;
      for (const action of actions) {
        for (const resource of resources) {
          const was = permits(before, action, resource);
          const is = permits(after, action, resource);
          if (was) permitted += 1;
          // The deploy boundary itself: the default boundary did not name it, so a policy action on it was not denied there; the deploy boundary denies them (DenyBoundaryChanges).
          if (resource === deployRoleBoundaryArn(scope) && /^iam:.*Policy/i.test(action) && was && !is) continue;
          if (was !== is && !(added(action) && is)) differences.push(`${action} on ${resource}: was ${was}, is ${is}`);
        }
      }
      expect(differences.slice(0, 20)).toEqual([]);
      expect(permitted).toBeGreaterThan(500);
      for (const action of ["iam:CreatePolicyVersion", "iam:SetDefaultPolicyVersion", "iam:DeletePolicy", "iam:TagPolicy"]) {
        for (const arn of [defaultBoundaryArn(scope), deployRoleBoundaryArn(scope)]) expect(after.some((statement) => statement.Effect === "Deny" && covers(statement, action, arn)), `${action} on ${arn}`).toBe(true);
      }
    });
  }
});

describe("the boundary action patterns match exactly what they say, against AWS's action lists", () => {
  const matches = (pattern: string, actions: string[]) => actions.filter((action) => glob(pattern, "i").test(action)).sort();

  it("acm:*Tags* and acm:De*Certificate", () => {
    expect(matches("acm:*Tags*", SERVICE_ACTIONS.acm)).toEqual(["acm:AddTagsToCertificate", "acm:ListTagsForCertificate", "acm:ListTagsForResource", "acm:RemoveTagsFromCertificate"]);
    expect(matches("acm:De*Certificate", SERVICE_ACTIONS.acm)).toEqual(["acm:DeleteCertificate", "acm:DescribeCertificate"]);
  });

  it("every pattern of the deploy role's ceiling, and the AppSync namespace pattern", () => {
    const all = [...SERVICE_ACTIONS.acm, ...SERVICE_ACTIONS.route53];
    expect(DEPLOY_ROLE_BOUNDARY_CERTIFICATE_AND_RECORD_ACTIONS.flatMap((pattern) => matches(pattern, all)).sort()).toEqual([
      "acm:AddTagsToCertificate", "acm:DeleteCertificate", "acm:DescribeCertificate", "acm:ListTagsForCertificate", "acm:ListTagsForResource", "acm:RemoveTagsFromCertificate", "acm:RequestCertificate",
      "route53:ChangeResourceRecordSets", "route53:GetChange", "route53:GetHostedZone", "route53:ListHostedZones", "route53:ListResourceRecordSets",
    ]);
    expect(matches(BOUNDARY_APPSYNC_NAMESPACE_ACTIONS, SERVICE_ACTIONS.appsync)).toEqual(["appsync:CreateChannelNamespace", "appsync:DeleteChannelNamespace", "appsync:GetChannelNamespace", "appsync:UpdateChannelNamespace"]);
    // Every named action is a real one.
    for (const action of DEPLOY_ROLE_BOUNDARY_CERTIFICATE_AND_RECORD_ACTIONS.filter((pattern) => !pattern.includes("*"))) expect(all, action).toContain(action);
  });

  it("no ACM import, export, private-key read, renewal, revocation, ACME or account configuration; no zone creation, deletion, association, DNSSEC, health check or tag change", () => {
    const allowed = new Set(DEPLOY_ROLE_BOUNDARY_CERTIFICATE_AND_RECORD_ACTIONS.flatMap((pattern) => matches(pattern, [...SERVICE_ACTIONS.acm, ...SERVICE_ACTIONS.route53])));
    for (const action of ["acm:ImportCertificate", "acm:ExportCertificate", "acm:GetCertificate", "acm:RenewCertificate", "acm:RevokeCertificate", "acm:CreateAcmeEndpoint", "acm:PutAccountConfiguration", "acm:TagResource", "acm:UpdateCertificate",
      "route53:CreateHostedZone", "route53:DeleteHostedZone", "route53:AssociateVPCWithHostedZone", "route53:EnableHostedZoneDNSSEC", "route53:CreateHealthCheck", "route53:ChangeTagsForResource", "route53:ListHostedZonesByName"]) {
      expect(allowed.has(action), action).toBe(false);
    }
  });
});

describe("only the deploy role is granted any acm or route53 action", () => {
  it("no other role in any environment template holds one", () => {
    for (const shape of [SHAPES[1]!, SHAPES[2]!]) {
      const app = buildAgentXApp(shape.context);
      for (const stack of app.node.children.filter((child): child is Stack => Stack.isStack(child))) {
        const json = Template.fromStack(stack).toJSON() as Json;
        for (const [id, resource] of Object.entries(json.Resources)) {
          const documents = resource.Type === "AWS::IAM::Role" ? ((resource.Properties.Policies ?? []) as Array<{ PolicyDocument: unknown }>).map((policy) => policy.PolicyDocument)
            : ["AWS::IAM::Policy", "AWS::IAM::ManagedPolicy", "AWS::IAM::RolePolicy"].includes(resource.Type) ? [resource.Properties.PolicyDocument] : [];
          if (documents.length === 0 || (stack.node.id === "AgentXAccess" && (id === "CloudFormationServiceRole" || id.startsWith("ModelProxyTlsDeployPolicy") || id === "DeployRolePermissionsBoundary"))) continue;
          expect(JSON.stringify(documents), `${stack.node.id}/${id}`).not.toMatch(/"(acm|route53):/u);
        }
      }
    }
  }, 400_000);
});

describe("the deploy role's boundary name can never be another environment's default boundary name (re-review L1)", () => {
  // IAM managed policy names are unique per account whatever the path, so agentx-x-deploy-boundary would clash with the default boundary of an environment named x-deploy.
  it("is agentx-<env>--deploy-boundary, and the only environment whose default boundary would carry that name is refused", () => {
    expect(deployRoleBoundaryName("staging")).toBe("agentx-staging--deploy-boundary");
    for (const env of ["staging", "production", "x", "agentxlivetest123", "a".repeat(20), "x-deploy", "deploy"]) {
      expect(EnvironmentNameSchema.safeParse(env).success, env).toBe(true);
      const name = deployRoleBoundaryName(env);
      // The default boundary is agentx-<other>-boundary: the one <other> that would produce this name.
      const other = name.slice("agentx-".length, -"-boundary".length);
      expect(defaultBoundaryName(other)).toBe(name);
      expect(EnvironmentNameSchema.safeParse(other).success, `${other} must not be an environment name`).toBe(false);
      // And no valid environment's default boundary equals it, the tricky neighbours included.
      for (const neighbour of [env, `${env}-deploy`, `${env}-d`, "deploy"]) {
        if (EnvironmentNameSchema.safeParse(neighbour).success) expect(defaultBoundaryName(neighbour), neighbour).not.toBe(name);
      }
    }
    // The clash the old name had: x's deploy boundary was x-deploy's default boundary.
    expect(defaultBoundaryName("x-deploy")).toBe("agentx-x-deploy-boundary");
    expect(deployRoleBoundaryName("x")).not.toBe("agentx-x-deploy-boundary");
  });
});
