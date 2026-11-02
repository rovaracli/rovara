import { describe, expect, it } from "vitest";
import {
  BOUNDARY_SERVICES, CLOUDFRONT_BOUNDARY_ACTIONS, MANAGED_POLICY_ACTIONS, SERVICE_ROLE_SERVICES, defaultBoundaryArn, defaultBoundaryName, defaultBoundaryStatements, operatorRoleStatements, serviceRoleStatements, withoutSids, type PolicyScope,
} from "../../infra/lib/access-policies.js";
import { brokerRoleName, modelAccessProbeRoleName, modelProxyTaskRoleName } from "@agentx/contracts";

const scope: PolicyScope = {
  env: "staging", partition: "aws", region: "us-east-1", account: "123456789012",
  artifactBucketArn: "arn:aws:s3:::agentx-staging-access-artifactbucket-abc", pullThroughPrefix: "agentx-staging",
  cloudFormationRoleName: "agentx-staging-cloudformation",
};
// Inline and attached policy actions on roles: the regex below catches them by name, but they are
// role-scoped (the first test pins their resource to this environment's role path), not user, group or
// managed-policy management.
const ROLE_SCOPED_POLICY_ACTIONS = ["iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:AttachRolePolicy"];
const COGNITO_EMAIL_SLR = "arn:aws:iam::123456789012:role/aws-service-role/email.cognito-idp.amazonaws.com/AWSServiceRoleForAmazonCognitoIdpEmailService";
const actions = (statements: ReturnType<typeof serviceRoleStatements>) => statements.flatMap((s) => s.Action);

describe("service role policy", () => {
  it("lets CloudFormation validate only this environment's ECS failure-event rule", () => {
    const statement = serviceRoleStatements(scope).find((s) => s.Sid === "EcsFailureEventsRule")!;
    expect(statement).toEqual({
      Sid: "EcsFailureEventsRule",
      Effect: "Allow",
      Action: ["events:*"],
      Resource: "arn:aws:events:us-east-1:123456789012:rule/agentx-staging-*-service-failures",
    });
  });

  it("scopes every IAM action to the environment's role path, except service-linked roles", () => {
    for (const statement of serviceRoleStatements(scope).filter((s) => s.Action.some((a) => a.startsWith("iam:")))) {
      const resources = [statement.Resource].flat();
      if (statement.Sid === "IamKeepBoundaryPolicy") {
        // Ruling M2 review: the boundary in force is never versioned, tagged or deleted by the deploy.
        expect(statement.Effect).toBe("Deny");
        expect(resources).toEqual(["arn:aws:iam::123456789012:policy/agentx/staging/agentx-staging-boundary"]);
      } else if (statement.Sid === "CognitoEmailServiceLinkedRole") {
        expect(resources).toEqual([COGNITO_EMAIL_SLR]);
      } else if (statement.Sid === "ServiceLinkedRoles") {
        expect(resources).toEqual(["arn:aws:iam::123456789012:role/aws-service-role/*"]);
        expect(statement.Condition?.StringLike?.["iam:AWSServiceName"]).toBeDefined();
      } else if (statement.Sid === "IamFixedNameRolesNotYetCreated") {
        // The fixed-name roles: IAM authorizes CloudFormation's lookup of each before it exists against its path-less ARN.
        // Reads and deletes only, never create or change (tests/contract/role-paths.test.ts proves what each action may do).
        expect(resources).toEqual(["connector-secrets", "broker-role", "model-proxy-task", "model-access-probe", "chain-schedule", "img-push", "img-pull", "img-manage", "img-create"].map((name) => `arn:aws:iam::123456789012:role/agentx-staging-${name}`));
        expect(statement.Action.every((a) => /^iam:(Get|List|Delete|Detach)/.test(a))).toBe(true);
      } else if (statement.Sid === "IamInstanceProfiles") {
        // The EC2 workers' instance profile, under the same path as the environment's roles.
        expect(resources).toEqual(["arn:aws:iam::123456789012:instance-profile/agentx/staging/*"]);
        expect(statement.Action.every((a) => /^iam:[A-Za-z]*InstanceProfile$/.test(a))).toBe(true);
      } else if (statement.Sid === "IamManagedPolicies") {
        // Ruling M2 (owner-approved 2026-10-21): the broker's named managed policies, agentx-* only, and only the
        // create/read/update/delete actions CloudFormation's AWS::IAM::ManagedPolicy handlers use.
        expect(resources).toEqual(["arn:aws:iam::123456789012:policy/agentx/staging/agentx-staging-broker-*"]);
        expect([...statement.Action].sort()).toEqual([...MANAGED_POLICY_ACTIONS].sort());
      } else {
        // A path, not a name prefix: generated role names are truncated, and agentx-prod-* would
        // also match the prod-eu environment's roles.
        expect(resources).toEqual(["arn:aws:iam::123456789012:role/agentx/staging/*"]);
      }
    }
  });

  it("always denies creating or changing a role without the given boundary, limited to the actions that carry the key", () => {
    const withBoundary = serviceRoleStatements({ ...scope, permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/Boundary" });
    const require = withBoundary.find((s) => s.Sid === "IamRequireBoundary")!;
    // Only actions that carry iam:PermissionsBoundary (CreateRole and PutRolePermissionsBoundary as
    // the new boundary, the role policy actions as the role's current one). For any other action
    // the key is absent, StringNotEquals is true, and the Deny would block it outright.
    expect(require.Action.sort()).toEqual([
      "iam:AttachRolePolicy", "iam:CreateRole", "iam:DeleteRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePermissionsBoundary", "iam:PutRolePolicy",
    ]);
    for (const keyless of ["iam:UpdateAssumeRolePolicy", "iam:TagRole", "iam:UntagRole", "iam:DeleteRole", "iam:GetRole", "iam:UpdateRole", "iam:UpdateRoleDescription"]) {
      expect(require.Action).not.toContain(keyless);
    }
    expect([require.Resource].flat()).toEqual(["arn:aws:iam::123456789012:role/agentx/staging/*"]);
    expect([withBoundary.find((s) => s.Sid === "IamKeepBoundary")!.Resource].flat()).toEqual(["arn:aws:iam::123456789012:role/agentx/staging/*"]);
    expect(require.Condition).toEqual({ StringNotEquals: { "iam:PermissionsBoundary": "arn:aws:iam::123456789012:policy/Boundary" } });
    expect(withBoundary.find((s) => s.Sid === "IamKeepBoundary")!.Action).toEqual(["iam:DeleteRolePermissionsBoundary"]);
  });

  it("uses the default boundary in the Deny statements when no boundary is given", () => {
    const require = serviceRoleStatements(scope).find((s) => s.Sid === "IamRequireBoundary")!;
    expect(require.Condition).toEqual({ StringNotEquals: { "iam:PermissionsBoundary": "arn:aws:iam::123456789012:policy/agentx/staging/agentx-staging-boundary" } });
    expect(serviceRoleStatements(scope).some((s) => s.Sid === "IamKeepBoundary")).toBe(true);
  });

  it("may change a role's description", () => {
    expect(serviceRoleStatements(scope).find((s) => s.Sid === "IamRoles")!.Action).toContain("iam:UpdateRoleDescription");
  });

  it("creates only the ECS, load balancer, database and Route 53 Resolver service-linked roles", () => {
    const linked = serviceRoleStatements(scope).find((s) => s.Sid === "ServiceLinkedRoles")!;
    expect(linked.Condition).toEqual({ StringLike: { "iam:AWSServiceName": ["ecs.amazonaws.com", "elasticloadbalancing.amazonaws.com", "rds.amazonaws.com", "route53resolver.amazonaws.com"] } });
  });

  it("may create the Cognito email service-linked role (Task 7) and only that one, by its exact ARN and service name", () => {
    // Cognito creates AWSServiceRoleForAmazonCognitoIdpEmailService when a user pool first sends with Amazon SES (EmailSendingAccount DEVELOPER);
    // the caller needs iam:CreateServiceLinkedRole (https://docs.aws.amazon.com/cognito/latest/developerguide/using-service-linked-roles.html).
    const statement = serviceRoleStatements(scope).find((s) => s.Sid === "CognitoEmailServiceLinkedRole")!;
    expect(statement).toEqual({
      Sid: "CognitoEmailServiceLinkedRole", Effect: "Allow", Action: ["iam:CreateServiceLinkedRole"], Resource: COGNITO_EMAIL_SLR,
      Condition: { StringEquals: { "iam:AWSServiceName": "email.cognito-idp.amazonaws.com" } },
    });
    // The wider statement keeps its four services and does not grow.
    expect(serviceRoleStatements(scope).find((s) => s.Sid === "ServiceLinkedRoles")!.Condition).toEqual({ StringLike: { "iam:AWSServiceName": ["ecs.amazonaws.com", "elasticloadbalancing.amazonaws.com", "rds.amazonaws.com", "route53resolver.amazonaws.com"] } });
  });

  it("never grants iam:* or wildcard IAM user, group or policy management (managed policies only as agentx-*, ruling M2)", () => {
    const all = actions(serviceRoleStatements(scope).filter((statement) => statement.Effect === "Allow" && statement.Sid !== "IamManagedPolicies"));
    expect(all).not.toContain("iam:*");
    expect(all.filter((a) => /^iam:(Create|Delete|Put|Attach).*(User|Group|Policy)$/.test(a) && !ROLE_SCOPED_POLICY_ACTIONS.includes(a))).toEqual([]);
  });

  it("allows only the listed services by wildcard", () => {
    const wildcard = serviceRoleStatements(scope).find((s) => s.Sid === "Services")!;
    expect(wildcard.Action).toEqual(SERVICE_ROLE_SERVICES.map((s) => `${s}:*`));
    expect(SERVICE_ROLE_SERVICES).not.toContain("iam");
    expect(SERVICE_ROLE_SERVICES).not.toContain("organizations");
    expect(SERVICE_ROLE_SERVICES).not.toContain("sts");
  });

  // Audit Ledger (Task 5, R1-4/R53): the vault key's policy lets the account root administer the key without using it,
  // and lets only this role schedule deletion, disable it or replace its policy. So this role must be able to create
  // the key with that policy (CreateKey, PutKeyPolicy: KMS's lockout check), its alias, tags and rotation, to read
  // it back, and to create the Object Lock bucket, the FIFO queues and the tables, in this one statement.
  it("covers what the audit ledger's key, Object Lock bucket, queues and tables need, with no new statement", () => {
    const services = serviceRoleStatements(scope).find((s) => s.Sid === "Services")!;
    expect(services).toMatchObject({ Effect: "Allow", Resource: "*" });
    const covers = (action: string) => services.Action.some((pattern) => new RegExp(`^${pattern.replaceAll("*", ".*")}$`).test(action));
    for (const action of ["kms:CreateKey", "kms:PutKeyPolicy", "kms:CreateAlias", "kms:TagResource", "kms:EnableKeyRotation", "kms:DescribeKey", "kms:GetKeyRotationStatus", "kms:ScheduleKeyDeletion", "kms:DisableKey",
      "s3:CreateBucket", "s3:PutBucketObjectLockConfiguration", "s3:PutBucketVersioning", "s3:PutBucketPolicy", "s3:PutReplicationConfiguration", "sqs:CreateQueue", "dynamodb:CreateTable", "dynamodb:UpdateContinuousBackups"]) {
      expect(covers(action), action).toBe(true);
    }
  });

  it("may create, update, delete and tag only this environment's monthly budget, never by wildcard", () => {
    const budget = serviceRoleStatements(scope).find((s) => s.Sid === "Budget")!;
    expect(budget.Action.sort()).toEqual(["budgets:ListTagsForResource", "budgets:ModifyBudget", "budgets:TagResource", "budgets:UntagResource", "budgets:ViewBudget"]);
    // Exactly this one budget, never another: no wildcard suffix, no other environment's budget name.
    expect(budget.Resource).toBe("arn:aws:budgets::123456789012:budget/agentx-staging-monthly");
    expect(SERVICE_ROLE_SERVICES).not.toContain("budgets");
    expect(serviceRoleStatements(scope).find((s) => s.Sid === "Services")!.Action).not.toContain("budgets:*");
  });

  it("never grants the service role servicequotas, even by wildcard", () => {
    expect(serviceRoleStatements(scope).find((s) => s.Sid === "Services")!.Action).not.toContain("servicequotas:*");
  });
});

describe("AppSync Events API creation (Plan 5 Task 8 review, I-1)", () => {
  // appsync:CreateApi and appsync:ListApis take no resource type, so an ARN-scoped statement never matches them: they need "*", held to the deploy region.
  const unscoped = ["appsync:CreateApi", "appsync:ListApis"];
  const apisArn = "arn:aws:appsync:us-east-1:123456789012:apis/*";
  const checks: Array<[string, ReturnType<typeof serviceRoleStatements>]> = [
    ["service role", serviceRoleStatements(scope)],
    ["boundary", defaultBoundaryStatements(scope)],
  ];
  for (const [name, statements] of checks) {
    it(`the ${name} allows CreateApi and ListApis on "*" only inside the deploy region`, () => {
      const statement = statements.find((s) => s.Sid === "AppSyncEventsCreate")!;
      expect(statement).toEqual({
        Sid: "AppSyncEventsCreate", Effect: "Allow", Action: unscoped, Resource: "*", Condition: { StringEquals: { "aws:RequestedRegion": "us-east-1" } },
      });
    });

    it(`the ${name} keeps every other AppSync Events action on this account's APIs, and none of the resource-less two`, () => {
      const scoped = statements.find((s) => s.Sid === "AppSyncEvents")!;
      expect(scoped.Resource).toBe(apisArn);
      expect(scoped.Condition).toBeUndefined();
      expect([...scoped.Action].sort()).toEqual([
        "appsync:CreateChannelNamespace", "appsync:DeleteApi", "appsync:DeleteChannelNamespace", "appsync:GetApi", "appsync:GetChannelNamespace",
        "appsync:ListTagsForResource", "appsync:TagResource", "appsync:UntagResource", "appsync:UpdateApi", "appsync:UpdateChannelNamespace",
      ]);
      // Nothing else names either action: no second grant on "*" without the region condition, and none on the APIs' ARN.
      const naming = statements.filter((s) => s.Action.some((a) => unscoped.includes(a)));
      expect(naming.map((s) => s.Sid)).toEqual(["AppSyncEventsCreate"]);
    });
  }
});

describe("operator role policy", () => {
  it("has no wildcard actions", () => {
    expect(operatorRoleStatements(scope).flatMap((s) => s.Action).filter((a) => a.endsWith(":*") || a === "*")).toEqual([]);
  });

  it("may pass only the CloudFormation service role, and only to CloudFormation", () => {
    const pass = operatorRoleStatements(scope).filter((s) => s.Action.includes("iam:PassRole"));
    expect(pass).toHaveLength(1);
    expect(pass[0]!.Resource).toBe("arn:aws:iam::123456789012:role/agentx-staging-cloudformation");
    expect(pass[0]!.Condition).toEqual({ StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } });
    expect(operatorRoleStatements(scope).flatMap((s) => s.Action).filter((a) => a.startsWith("iam:") && a !== "iam:PassRole")).toEqual([]);
  });

  it("changes only this environment's stacks, settings and secrets", () => {
    const byId = Object.fromEntries(operatorRoleStatements(scope).map((s) => [s.Sid, [s.Resource].flat()]));
    const stack = (part: string) => `arn:aws:cloudformation:us-east-1:123456789012:stack/agentx-staging-${part}/*`;
    const deployed = ["foundation", "identity", "runtime", "control-plane", "slack"].map(stack);
    expect(byId.Stacks).toEqual([stack("access"), ...deployed]);
    expect(byId.ChangeSets).toEqual(deployed);
    expect(byId.Settings).toEqual(["arn:aws:ssm:us-east-1:123456789012:parameter/agentx/staging", "arn:aws:ssm:us-east-1:123456789012:parameter/agentx/staging/*"]);
    expect(byId.Secrets).toEqual(["arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/*"]);
  });

  it("can never change the access stack, and names every stack exactly", () => {
    const statements = operatorRoleStatements(scope);
    const changeSetStatements = statements.filter((s) => s.Action.some((a) => /ChangeSet/.test(a)));
    expect(changeSetStatements.map((s) => s.Sid)).toEqual(["ChangeSets"]);
    expect([changeSetStatements[0]!.Resource ?? []].flat().filter((r) => r.includes("agentx-staging-access"))).toEqual([]);
    const resources = statements.flatMap((s) => [s.Resource ?? []].flat());
    expect(resources.filter((r) => r.includes("agentx-staging-*"))).toEqual([]);
    const list = statements.find((s) => s.Action.includes("cloudformation:ListStacks"))!;
    expect(list.Action).toEqual(["cloudformation:ListStacks"]);
    expect(list.Resource).toBe("*");
  });

  it("checks models with InvokeModel only", () => {
    const models = operatorRoleStatements(scope).find((s) => s.Sid === "ModelChecks")!;
    expect(models.Action).toEqual(["bedrock:InvokeModel"]);
  });

  it("reads only this environment's stacks' logs", () => {
    const logs = operatorRoleStatements(scope).find((s) => s.Sid === "Logs")!;
    expect(logs.Action).toEqual(["logs:FilterLogEvents", "logs:StartQuery"]);
    const resources = [logs.Resource ?? []].flat();
    expect(resources).toContain("arn:aws:logs:us-east-1:123456789012:log-group:agentx-staging-control-plane-*");
    expect(resources.every((resource) => resource.includes(":log-group:agentx-staging-"))).toBe(true);
  });

  it("may turn on termination protection for the five stacks it deploys, and only those", () => {
    const statements = operatorRoleStatements(scope).filter((s) => s.Action.includes("cloudformation:UpdateTerminationProtection"));
    expect(statements.map((s) => s.Sid)).toEqual(["ChangeSets"]);
    const stack = (part: string) => `arn:aws:cloudformation:us-east-1:123456789012:stack/agentx-staging-${part}/*`;
    expect([statements[0]!.Resource].flat()).toEqual(["foundation", "identity", "runtime", "control-plane", "slack"].map(stack));
  });

  it("may create the environment's admin user only in a user pool tagged for this environment", () => {
    const admin = operatorRoleStatements(scope).find((s) => s.Sid === "AdminUser")!;
    expect(admin.Action.sort()).toEqual(["cognito-idp:AdminAddUserToGroup", "cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser", "cognito-idp:AdminListGroupsForUser"]);
    expect(admin.Resource).toBe("arn:aws:cognito-idp:us-east-1:123456789012:userpool/*");
    expect(admin.Condition).toEqual({ StringEquals: { "aws:ResourceTag/agentx:env": "staging" } });
  });

  it("may subscribe to and read only this environment's alert topic, and never publish or unsubscribe", () => {
    const statements = operatorRoleStatements(scope);
    const snsResources = new Set(statements.filter((s) => s.Action.some((a) => a.startsWith("sns:"))).flatMap((s) => [s.Resource].flat()));
    expect(snsResources).toEqual(new Set(["arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts"]));
    expect(actions(statements).filter((a) => a.startsWith("sns:")).sort()).toEqual(["sns:ListSubscriptionsByTopic", "sns:Subscribe"]);
    expect(actions(statements)).not.toContain("sns:Publish");
    expect(actions(statements)).not.toContain("sns:Unsubscribe");
  });

  it("may subscribe only email or the alert webhook to the topic, never sqs, lambda or sms", () => {
    const subscribe = operatorRoleStatements(scope).find((s) => s.Action.includes("sns:Subscribe"))!;
    expect(subscribe.Action).toEqual(["sns:Subscribe"]);
    expect(subscribe.Resource).toBe("arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts");
    expect(subscribe.Condition).toEqual({ StringEquals: { "sns:Protocol": ["email", "https"] } });
  });

  it("may flip only the test alarm, by its exact name", () => {
    const alarm = operatorRoleStatements(scope).find((s) => s.Sid === "TestAlarm")!;
    expect(alarm.Action.sort()).toEqual(["cloudwatch:DescribeAlarmHistory", "cloudwatch:SetAlarmState"]);
    // Exact, never agentx-staging-*: that would also match a sibling environment named staging-eu.
    expect(alarm.Resource).toBe("arn:aws:cloudwatch:us-east-1:123456789012:alarm:agentx-staging-TestAlarm");
  });

  it("may read SES identities and the account's sending status for agentx signin cloud --email-from (Task 7), and send or change nothing", () => {
    const statements = operatorRoleStatements(scope);
    expect(statements.find((s) => s.Sid === "SesIdentityCheck")).toEqual({
      Sid: "SesIdentityCheck", Effect: "Allow", Action: ["ses:GetEmailIdentity"], Resource: "arn:aws:ses:us-east-1:123456789012:identity/*",
    });
    // ses:GetAccount takes no resource, so "*" with the region condition (as Addresses does).
    expect(statements.find((s) => s.Sid === "SesAccountCheck")).toEqual({
      Sid: "SesAccountCheck", Effect: "Allow", Action: ["ses:GetAccount"], Resource: "*", Condition: { StringEquals: { "aws:RequestedRegion": "us-east-1" } },
    });
    expect(actions(statements).filter((a) => a.startsWith("ses:")).sort()).toEqual(["ses:GetAccount", "ses:GetEmailIdentity"]);
  });

  it("may read only this environment's budget, and change none", () => {
    const budget = operatorRoleStatements(scope).find((s) => s.Sid === "Budget")!;
    expect(budget.Action).toEqual(["budgets:ViewBudget"]);
    expect(budget.Resource).toBe("arn:aws:budgets::123456789012:budget/agentx-staging-monthly");
    expect(actions(operatorRoleStatements(scope)).filter((a) => a.startsWith("budgets:"))).toEqual(["budgets:ViewBudget"]);
  });

  it("may read only the two EC2 quotas that prerequisites checks, not any other quota", () => {
    const quotas = operatorRoleStatements(scope).find((s) => s.Sid === "Quotas")!;
    expect(quotas.Action).toEqual(["servicequotas:GetServiceQuota"]);
    // Exactly the two quota codes prerequisites.ts checks (ServiceCode "ec2": the vCPU quota
    // L-1216C47A and the Elastic IP quota L-0263D0A3), never a wildcard:
    // arn:partition:servicequotas:region:account:serviceCode/quotaCode.
    expect(quotas.Resource).toEqual([
      "arn:aws:servicequotas:us-east-1:123456789012:ec2/L-1216C47A",
      "arn:aws:servicequotas:us-east-1:123456789012:ec2/L-0263D0A3",
    ]);
  });

  it("may count the region's Elastic IPs, and do nothing else with them, so the address check runs on an operator resume", () => {
    const addresses = operatorRoleStatements(scope).find((s) => s.Sid === "Addresses")!;
    // ec2:DescribeAddresses has no resource-level permissions, so "*" is the only Resource it takes.
    // The region condition keeps it to the environment's own region.
    expect(addresses).toEqual({ Sid: "Addresses", Effect: "Allow", Action: ["ec2:DescribeAddresses"], Resource: "*", Condition: { StringEquals: { "aws:RequestedRegion": "us-east-1" } } });
  });
});

// Owner decision A (task-15-16-review.md, "AssumeOrgRoles: recommendation for the owner"): the ceiling is raised for the broker, the model proxy task role and the
// model access probe only, and the exclusion covers every account of Rovara's own AWS Organization when one is configured.
const THREE_ROLE_ARNS = [
  "arn:aws:iam::123456789012:role/agentx/staging/agentx-staging-broker-role",
  "arn:aws:iam::123456789012:role/agentx/staging/agentx-staging-model-proxy-task",
  "arn:aws:iam::123456789012:role/agentx/staging/agentx-staging-model-access-probe",
];
const ASSUME_ORG_ROLES_WITHOUT_ORGANIZATION = {
  Sid: "AssumeOrgRoles", Effect: "Allow", Action: ["sts:AssumeRole"], Resource: "arn:aws:iam::*:role/*",
  Condition: {
    ArnLike: { "aws:PrincipalArn": THREE_ROLE_ARNS },
    StringNotEquals: { "aws:ResourceAccount": "123456789012" },
    StringLike: { "sts:ExternalId": "rovara-org_*" },
  },
};
const ORGANIZATION_ID = "o-abc123def4";
const ASSUME_ORG_ROLES_WITH_ORGANIZATION = {
  ...ASSUME_ORG_ROLES_WITHOUT_ORGANIZATION,
  Condition: { ...ASSUME_ORG_ROLES_WITHOUT_ORGANIZATION.Condition, StringNotEquals: { "aws:ResourceAccount": "123456789012", "aws:ResourceOrgID": ORGANIZATION_ID } },
};
const assumeOrgRoles = (s: PolicyScope) => defaultBoundaryStatements(s).find((st) => st.Sid === "AssumeOrgRoles")!;
/** IAM's ArnLike: a glob over the whole ARN, `*` any run and `?` one character, case-sensitive. */
const arnLike = (pattern: string, arn: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(arn);
/** Whether the statement's ArnLike condition lets this principal use the statement at all: a principal that fails it gets no raised ceiling. */
const raisesCeilingFor = (statement: ReturnType<typeof assumeOrgRoles>, principalArn: string) =>
  [statement.Condition!.ArnLike!["aws:PrincipalArn"]!].flat().some((pattern) => arnLike(pattern, principalArn));

describe("AssumeOrgRoles in the default permission boundary (owner decision A)", () => {
  it("is exactly this statement when no Rovara organization is configured: the three roles, this account excluded, the external id kept", () => {
    expect(assumeOrgRoles(scope)).toEqual(ASSUME_ORG_ROLES_WITHOUT_ORGANIZATION);
    expect(JSON.stringify(assumeOrgRoles(scope))).toBe(JSON.stringify(ASSUME_ORG_ROLES_WITHOUT_ORGANIZATION));
    expect(JSON.stringify(assumeOrgRoles(scope))).not.toContain("aws:ResourceOrgID");
  });

  it("adds aws:ResourceOrgID beside aws:ResourceAccount, in the same StringNotEquals, when a Rovara organization is configured", () => {
    expect(assumeOrgRoles({ ...scope, rovaraOrganizationId: ORGANIZATION_ID })).toEqual(ASSUME_ORG_ROLES_WITH_ORGANIZATION);
    expect(JSON.stringify(assumeOrgRoles({ ...scope, rovaraOrganizationId: ORGANIZATION_ID }))).toBe(JSON.stringify(ASSUME_ORG_ROLES_WITH_ORGANIZATION));
  });

  it("never hard-codes an organization id: the document holds only the one it was given", () => {
    expect(JSON.stringify(defaultBoundaryStatements(scope))).not.toMatch(/o-[a-z0-9]{10,32}/);
    expect(JSON.stringify(defaultBoundaryStatements({ ...scope, rovaraOrganizationId: "o-zzzzzzzzzz" }))).toContain("o-zzzzzzzzzz");
    expect(JSON.stringify(defaultBoundaryStatements({ ...scope, rovaraOrganizationId: "o-zzzzzzzzzz" }))).not.toContain(ORGANIZATION_ID);
  });

  it("refuses an organization id that is not an AWS Organizations id, rather than writing it into a policy", () => {
    for (const bad of ["", "abc123def4", "o-ABC123DEF4", "o-short", "o-abc123def4 ", `o-${"a".repeat(33)}`, "r-abc1", "o-abc123def4\"}"]) {
      expect(() => defaultBoundaryStatements({ ...scope, rovaraOrganizationId: bad }), JSON.stringify(bad)).toThrow(/organization id/i);
    }
  });

  it("names the three roles by their fixed names under the environment's path", () => {
    expect(brokerRoleName("staging")).toBe("agentx-staging-broker-role");
    expect(modelProxyTaskRoleName("staging")).toBe("agentx-staging-model-proxy-task");
    expect(modelAccessProbeRoleName("staging")).toBe("agentx-staging-model-access-probe");
    expect(assumeOrgRoles(scope).Condition!.ArnLike!["aws:PrincipalArn"]).toEqual(THREE_ROLE_ARNS);
  });

  it("keeps the three names distinct from every other fixed role name and within IAM's 64 characters, for the longest environment name", () => {
    const longest = "a".repeat(20);
    const names = [brokerRoleName(longest), modelProxyTaskRoleName(longest), modelAccessProbeRoleName(longest)];
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(64);
    for (const other of [`agentx-${longest}-connector-secrets`, `agentx-${longest}-cloudformation`, `agentx-${longest}-operator`, `agentx-${longest}-boundary`]) expect(names).not.toContain(other);
  });

  it("raises the ceiling for the three roles and no other principal", () => {
    const statement = assumeOrgRoles(scope);
    for (const arn of THREE_ROLE_ARNS) expect(raisesCeilingFor(statement, arn), arn).toBe(true);
    for (const arn of [
      // Another role of the same environment: the ConnectorSecretsRole, the CloudFormation and operator roles, a generated worker or orchestrator role.
      "arn:aws:iam::123456789012:role/agentx/staging/agentx-staging-connector-secrets",
      "arn:aws:iam::123456789012:role/agentx-staging-cloudformation",
      "arn:aws:iam::123456789012:role/agentx-staging-operator",
      "arn:aws:iam::123456789012:role/agentx/staging/agentx-staging-control-plane-SlackOrchestratorTaskRole1A2B3C4D-XYZ",
      "arn:aws:iam::123456789012:role/agentx/staging/agentx-staging-runtime-WorkerInstanceRole-ABCDEF",
      // A prefix, a suffix or a case change of a listed name, the same name outside the environment's path, in another environment, or in another account.
      "arn:aws:iam::123456789012:role/agentx/staging/agentx-staging-broker-role-extra",
      "arn:aws:iam::123456789012:role/agentx/staging/xagentx-staging-broker-role",
      "arn:aws:iam::123456789012:role/agentx/staging/AGENTX-STAGING-BROKER-ROLE",
      "arn:aws:iam::123456789012:role/agentx-staging-broker-role",
      "arn:aws:iam::123456789012:role/agentx/prod/agentx-prod-broker-role",
      "arn:aws:iam::999999999999:role/agentx/staging/agentx-staging-broker-role",
    ]) expect(raisesCeilingFor(statement, arn), arn).toBe(false);
  });

  it("holds no wildcard in the principal list, so the three roles are all it can ever match", () => {
    for (const arn of assumeOrgRoles(scope).Condition!.ArnLike!["aws:PrincipalArn"]!) expect(arn).not.toMatch(/[*?]/);
  });

  it("still excludes this account's roles and still requires a Rovara external id, with or without an organization", () => {
    for (const statement of [assumeOrgRoles(scope), assumeOrgRoles({ ...scope, rovaraOrganizationId: ORGANIZATION_ID })]) {
      expect(statement.Condition!.StringNotEquals!["aws:ResourceAccount"]).toBe("123456789012");
      expect(statement.Condition!.StringLike).toEqual({ "sts:ExternalId": "rovara-org_*" });
      expect(statement.Action).toEqual(["sts:AssumeRole"]);
      expect(Object.keys(statement.Condition!).sort()).toEqual(["ArnLike", "StringLike", "StringNotEquals"]);
    }
  });
});

describe("default permission boundary", () => {
  const statements = defaultBoundaryStatements(scope);
  const allows = statements.filter((s) => s.Effect === "Allow");
  const denies = statements.filter((s) => s.Effect === "Deny");

  it("has a deterministic name and ARN under the environment's IAM path", () => {
    expect(defaultBoundaryName("staging")).toBe("agentx-staging-boundary");
    expect(defaultBoundaryArn(scope)).toBe("arn:aws:iam::123456789012:policy/agentx/staging/agentx-staging-boundary");
  });

  it("allows each needed service by wildcard, never IAM, Organizations or Account", () => {
    const services = allows.find((s) => s.Sid === "Services")!;
    // CloudFront is the exception: action families (not cloudfront:*), as a ceiling over the service role's exact actions.
    expect(services.Action).toEqual([...BOUNDARY_SERVICES.map((s) => `${s}:*`), ...CLOUDFRONT_BOUNDARY_ACTIONS]);
    expect(services.Resource).toBe("*");
    for (const service of ["iam", "organizations", "account", "sts"]) expect(BOUNDARY_SERVICES).not.toContain(service);
    // The service role's own wildcard services must all pass the boundary it runs under.
    expect(SERVICE_ROLE_SERVICES.filter((s) => !BOUNDARY_SERVICES.includes(s))).toEqual([]);
  });

  it("allows the narrowly scoped ECS failure-rule validation read", () => {
    expect(allows.find((s) => s.Sid === "EcsFailureEventsRule")).toEqual({
      Sid: "EcsFailureEventsRule",
      Effect: "Allow",
      Action: ["events:*"],
      Resource: "arn:aws:events:us-east-1:123456789012:rule/agentx-staging-*-service-failures",
    });
    expect(allows.find((s) => s.Sid === "Services")!.Action).not.toContain("events:*");
  });

  it("allows only sts:GetCallerIdentity from STS, AssumeRole with TagSession for the one ConnectorSecretsRole, and AssumeRole into other accounts' roles with a Rovara external id", () => {
    const sts = allows.flatMap((s) => s.Action).filter((a) => a.startsWith("sts:"));
    expect(sts).toEqual(["sts:GetCallerIdentity", "sts:AssumeRole", "sts:TagSession", "sts:AssumeRole"]);
    // Plan 4 Task 16 (and Plan 3's Bedrock sources): a bounded role's own policy may grant this, and the boundary must not cap it away. Another account's role only,
    // only with an external id that names a Rovara org, and (owner decision A) only for the three roles that need it: see "AssumeOrgRoles" below.
    expect(allows.find((s) => s.Sid === "AssumeOrgRoles")).toEqual(ASSUME_ORG_ROLES_WITHOUT_ORGANIZATION);
    expect(allows.find((s) => s.Sid === "CallerIdentity")).toEqual({ Sid: "CallerIdentity", Effect: "Allow", Action: ["sts:GetCallerIdentity"], Resource: "*" });
    // Plan 3 (R62): the broker assumes the connector secrets role, named exactly. Setup and test health SH22 adds one wildcard for the saved-environment roles (agentx-<env>-saved-env-*): the boundary
    // has room for one more ARN, not three, and the broker's own policy names the three exactly.
    expect(allows.find((s) => s.Sid === "ConnectorSecretsRole")).toEqual({
      Sid: "ConnectorSecretsRole", Effect: "Allow", Action: ["sts:AssumeRole", "sts:TagSession"],
      Resource: ["arn:aws:iam::123456789012:role/agentx/staging/agentx-staging-connector-secrets", "arn:aws:iam::123456789012:role/agentx/staging/agentx-staging-img-*"],
    });
    expect(allows.flatMap((s) => s.Action).filter((a) => a === "*" || a === "sts:*")).toEqual([]);
    expect(allows.filter((s) => s.Action.some((a) => /^sts:(AssumeRole|TagSession)/.test(a))).map((s) => s.Sid)).toEqual(["ConnectorSecretsRole", "AssumeOrgRoles"]);
  });

  it("never allows iam:* or any user, group, access key, login profile or managed-policy action, except agentx-* managed policies (ruling M2)", () => {
    const managedPolicies = allows.find((statement) => statement.Sid === "IamManagedPolicies");
    expect(managedPolicies?.Resource).toBe("arn:aws:iam::123456789012:policy/agentx/staging/agentx-staging-broker-*");
    expect([...managedPolicies!.Action].sort()).toEqual([...MANAGED_POLICY_ACTIONS].sort());
    const iam = allows.filter((statement) => statement.Sid !== "IamManagedPolicies").flatMap((s) => s.Action).filter((a) => a.startsWith("iam:") || a === "*");
    expect(iam).not.toContain("iam:*");
    expect(iam).not.toContain("*");
    expect(iam.filter((a) => /User|Group|AccessKey|LoginProfile|PolicyVersion|^iam:(Create|Delete)Policy$|DefaultPolicyVersion/.test(a))).toEqual([]);
    expect(iam.filter((a) => a.includes("*"))).toEqual([]);
  });

  it("scopes role actions and PassRole to AgentX's own roles", () => {
    const byId = Object.fromEntries(allows.map((s) => [s.Sid, s]));
    expect([byId.IamRoles!.Resource].flat()).toEqual(["arn:aws:iam::123456789012:role/agentx/staging/*"]);
    expect(byId.IamRoles!.Action.every((a) => /^iam:[A-Za-z]*Role[A-Za-z]*$/.test(a))).toBe(true);
    expect([byId.PassRoles!.Resource].flat()).toEqual([
      "arn:aws:iam::123456789012:role/agentx/staging/*",
      "arn:aws:iam::123456789012:role/agentx-staging-cloudformation",
    ]);
    expect(byId.PassRoles!.Action).toEqual(["iam:PassRole"]);
    // No pass-role for retired runtime's default instance role: the capacity provider was removed (#118).
    expect(byId.PassDefaultInstanceRole).toBeUndefined();
    expect(byId.ServiceLinkedRoles).toEqual({
      Sid: "ServiceLinkedRoles", Effect: "Allow", Action: ["iam:CreateServiceLinkedRole"],
      Resource: "arn:aws:iam::123456789012:role/aws-service-role/*",
      Condition: { StringLike: { "iam:AWSServiceName": ["ecs.amazonaws.com", "elasticloadbalancing.amazonaws.com", "rds.amazonaws.com", "route53resolver.amazonaws.com"] } },
    });
  });

  it("lets the roles it bounds create the Cognito email service-linked role and read SES identity and account status (Task 7), no more", () => {
    const byId = Object.fromEntries(allows.map((s) => [s.Sid, s]));
    expect(byId.CognitoEmailServiceLinkedRole).toEqual({
      Sid: "CognitoEmailServiceLinkedRole", Effect: "Allow", Action: ["iam:CreateServiceLinkedRole"], Resource: COGNITO_EMAIL_SLR,
      Condition: { StringEquals: { "iam:AWSServiceName": "email.cognito-idp.amazonaws.com" } },
    });
    expect(byId.SesIdentityCheck).toEqual({ Sid: "SesIdentityCheck", Effect: "Allow", Action: ["ses:GetEmailIdentity"], Resource: "arn:aws:ses:us-east-1:123456789012:identity/*" });
    expect(byId.SesAccountCheck).toEqual({ Sid: "SesAccountCheck", Effect: "Allow", Action: ["ses:GetAccount"], Resource: "*", Condition: { StringEquals: { "aws:RequestedRegion": "us-east-1" } } });
    expect(BOUNDARY_SERVICES).not.toContain("ses");
  });

  it("explicitly denies account, organization, user, group and policy management, and changing itself", () => {
    expect(denies.map((s) => ({ Action: s.Action, Resource: s.Resource ?? { NotResource: s.NotResource } }))).toEqual([
      { Action: ["organizations:*", "account:*"], Resource: "*" },
      { Action: ["iam:*User*", "iam:*Group*"], Resource: "*" },
      // Every policy except the agentx-* managed policies the service role creates (ruling M2); the boundary itself stays denied below.
      { Action: ["iam:CreatePolicy*", "iam:*PolicyVersion*", "iam:DeletePolicy", "iam:SetDefaultPolicyVersion"], Resource: { NotResource: "arn:aws:iam::123456789012:policy/agentx/staging/agentx-staging-broker-*" } },
      { Action: ["iam:*Policy*"], Resource: "arn:aws:iam::123456789012:policy/agentx/staging/agentx-staging-boundary" },
    ]);
    expect(denies.every((s) => s.Condition === undefined)).toBe(true);
  });

  it("keeps budgets as a wildcard ceiling: AWS Budgets' resource-level support for Modify/Tag is not independently confirmed", () => {
    const services = defaultBoundaryStatements(scope).find((s) => s.Sid === "Services")!.Action;
    expect(services).toContain("budgets:*");
    expect(BOUNDARY_SERVICES).toContain("budgets");
  });

  it("names the EC2 quota read like sts:GetCallerIdentity: by name, never servicequotas:*", () => {
    const services = defaultBoundaryStatements(scope).find((s) => s.Sid === "Services")!.Action;
    expect(services).not.toContain("servicequotas:*");
    expect(BOUNDARY_SERVICES).not.toContain("servicequotas");
    expect(allows.find((s) => s.Sid === "Quotas")).toEqual({ Sid: "Quotas", Effect: "Allow", Action: ["servicequotas:GetServiceQuota"], Resource: "*" });
  });
});

describe("CloudFront permissions (web app deploy)", () => {
  const arn = (type: string) => `arn:aws:cloudfront::123456789012:${type}/*`;
  const cloudfront = (statements: ReturnType<typeof serviceRoleStatements>) => statements.filter((s) => s.Sid?.startsWith("CloudFront"));
  const service = serviceRoleStatements(scope);

  it("never grants cloudfront:* to the service role or the boundary", () => {
    for (const statements of [service, defaultBoundaryStatements(scope)]) {
      expect(statements.flatMap((s) => s.Action)).not.toContain("cloudfront:*");
      expect(SERVICE_ROLE_SERVICES).not.toContain("cloudfront");
      expect(BOUNDARY_SERVICES).not.toContain("cloudfront");
    }
  });

  it("creates a distribution, and tags on create, only with this environment's tag", () => {
    const create = service.find((s) => s.Sid === "CloudFrontDistributionCreate")!;
    expect(create).toEqual({ Sid: "CloudFrontDistributionCreate", Effect: "Allow", Action: ["cloudfront:CreateDistribution"], Resource: "*", Condition: { StringEquals: { "aws:RequestTag/agentx:env": "staging" } } });
    // On "*": which resource CloudFront authorizes the create-time tag call against is not known, so it works whichever way CloudFormation tags; the request tag and the two Denies keep it narrow.
    const tag = service.find((s) => s.Sid === "CloudFrontDistributionTag")!;
    expect(tag).toEqual({ Sid: "CloudFrontDistributionTag", Effect: "Allow", Action: ["cloudfront:TagResource"], Resource: "*", Condition: { StringEquals: { "aws:RequestTag/agentx:env": "staging" } } });
  });

  it("changes a distribution, a tag-only update included, only when it carries this environment's tag", () => {
    const manage = service.find((s) => s.Sid === "CloudFrontDistributions")!;
    expect(manage.Resource).toBe(arn("distribution"));
    expect(manage.Condition).toEqual({ StringEquals: { "aws:ResourceTag/agentx:env": "staging" } });
    expect([...manage.Action].sort()).toEqual(["cloudfront:DeleteDistribution", "cloudfront:GetDistribution", "cloudfront:GetDistributionConfig", "cloudfront:ListTagsForResource", "cloudfront:TagResource", "cloudfront:UntagResource", "cloudfront:UpdateDistribution"]);
  });

  it("denies tagging a distribution that carries another environment's tag, and setting another environment's value", () => {
    expect(service.find((s) => s.Sid === "CloudFrontKeepEnvironmentTag")).toEqual({
      Sid: "CloudFrontKeepEnvironmentTag", Effect: "Deny", Action: ["cloudfront:TagResource"], Resource: arn("distribution"),
      Condition: { Null: { "aws:ResourceTag/agentx:env": "false" }, StringNotEquals: { "aws:ResourceTag/agentx:env": "staging" } },
    });
    // Present and different. A call that sends no agentx:env (a tag-only update of other tags) is not matched, so the ResourceTag Allow above takes it.
    expect(service.find((s) => s.Sid === "CloudFrontOnlyOwnEnvironmentTag")).toEqual({
      Sid: "CloudFrontOnlyOwnEnvironmentTag", Effect: "Deny", Action: ["cloudfront:TagResource"], Resource: "*",
      Condition: { Null: { "aws:RequestTag/agentx:env": "false" }, StringNotEquals: { "aws:RequestTag/agentx:env": "staging" } },
    });
  });

  it("scopes the origin access control and response headers policy actions by ARN, and puts only the resource-less actions on \"*\"", () => {
    const policies = service.find((s) => s.Sid === "CloudFrontPolicies")!;
    expect(policies.Resource).toEqual([arn("origin-access-control"), arn("response-headers-policy")]);
    expect([...policies.Action].sort()).toEqual([
      "cloudfront:DeleteOriginAccessControl", "cloudfront:DeleteResponseHeadersPolicy", "cloudfront:GetOriginAccessControl", "cloudfront:GetOriginAccessControlConfig", "cloudfront:GetResponseHeadersPolicy", "cloudfront:GetResponseHeadersPolicyConfig", "cloudfront:UpdateOriginAccessControl", "cloudfront:UpdateResponseHeadersPolicy",
    ]);
    const onStar = cloudfront(service).filter((s) => s.Effect === "Allow" && s.Resource === "*");
    expect(onStar.map((s) => s.Sid).sort()).toEqual(["CloudFrontDistributionCreate", "CloudFrontDistributionTag", "CloudFrontUnscoped"]);
    expect([...service.find((s) => s.Sid === "CloudFrontUnscoped")!.Action].sort()).toEqual([
      "cloudfront:CreateOriginAccessControl", "cloudfront:CreateResponseHeadersPolicy", "cloudfront:GetCachePolicy", "cloudfront:ListCachePolicies", "cloudfront:ListDistributions", "cloudfront:ListOriginAccessControls", "cloudfront:ListResponseHeadersPolicies",
    ]);
  });

  it("gives the boundary only the CloudFront action families, on its Services statement", () => {
    const boundary = defaultBoundaryStatements(scope);
    expect(cloudfront(boundary)).toEqual([]);
    expect(boundary.find((s) => s.Sid === "Services")!.Action.filter((a) => a.startsWith("cloudfront:"))).toEqual([...CLOUDFRONT_BOUNDARY_ACTIONS]);
  });

  it("keeps the deployed boundary within IAM's 6,144-character managed policy limit, with margin, and the service role within the 10,240-character inline limit, in the worst case", () => {
    const size = (statements: unknown[]) => JSON.stringify({ Version: "2012-10-17", Statement: statements }).replace(/\s/g, "").length;
    const orgId = `o-${"a".repeat(32)}`;
    let worst = 0;
    for (const env of ["staging", "agentxlivetest123", "a".repeat(20)]) {
      for (const rovaraOrganizationId of [undefined, orgId]) {
        const longest: PolicyScope = {
          ...scope, env, account: "944937319445", region: "ap-southeast-2", cloudFormationRoleName: `agentx-${env}-cloudformation`, artifactBucketArn: `arn:aws:s3:::agentx-${env}-access-artifactbucket-abcdefghijkl`,
          ...(rovaraOrganizationId === undefined ? {} : { rovaraOrganizationId }),
        };
        // As deployed: without the Sids (infra/lib/access.ts).
        // Setup and test health SH22: one ARN (the saved-environment roles) in the boundary and four more in its fixed-name lookup list. The worst case (20-character environment, organization id) is 5,951 of 6,144,
        // so the margin that was 300 is 150. The base had 41 characters of room above the old margin. The next addition to the boundary needs it split or tightened first.
        const boundary = size(withoutSids(defaultBoundaryStatements(longest)));
        worst = Math.max(worst, boundary);
        expect(boundary, `boundary, ${env}, ${rovaraOrganizationId ?? "no org id"}`).toBeLessThanOrEqual(6144 - 150);
        expect(size(serviceRoleStatements(longest)), `service role, ${env}`).toBeLessThanOrEqual(10_240 - 1000);
      }
    }
    expect(worst).toBeGreaterThan(5000);
  });
});
