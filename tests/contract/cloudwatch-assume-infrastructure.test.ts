// Plan 4 Task 16: the broker role's grant to assume a customer's role for the CloudWatch connector, and the permissions boundary that must also allow it.
// The grant is exact: one action, a role in another account only, and only with an external id that names a Rovara org. It exists on the hosted cloud
// (named environment with agentxCloud) and nowhere else, and lives in the broker's orchestration managed policy (the group an sts action falls in).
import { webFeatureNames } from "@agentx/cloud-contracts";
import { automationsEnabled } from "../../packages/broker/src/chains/automations-gate.js";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { brokerRoleName } from "@agentx/cloud-contracts";
import { brokerNamesIn, brokerSettingsIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource?: unknown; Condition?: unknown };
type Policy = { Properties: { ManagedPolicyName?: string; PolicyDocument: { Statement: Statement[] }; Roles: Array<{ Ref?: string }> } };

const stack = (props: { cloud?: boolean; env?: string } = {}) => Template.fromStack(new ControlPlaneStack(new App(), `AssumeCw${props.cloud === true ? "Cloud" : "Plain"}`, {
  naming: environmentNaming(props.env ?? "staging"), ...(props.cloud === true ? { cloud: true } : {}),
}));

const brokerPolicies = (template: Template): Array<{ name: string; statements: Statement[] }> =>
  (Object.values({ ...template.findResources("AWS::IAM::ManagedPolicy"), ...template.findResources("AWS::IAM::Policy") }) as Policy[])
    .filter((policy) => policy.Properties.Roles.some((role) => role.Ref?.startsWith("BrokerServiceRole")))
    .map((policy) => ({ name: policy.Properties.ManagedPolicyName ?? "inline", statements: policy.Properties.PolicyDocument.Statement }));

const assumesOf = (template: Template) => brokerPolicies(template).flatMap((policy) => policy.statements.map((statement) => ({ policy: policy.name, statement })))
  .filter(({ statement }) => [statement.Action].flat().includes("sts:AssumeRole") && statement.Sid === "AssumeCustomerCloudWatchRoles");

describe("the broker's grant to assume a customer's CloudWatch role", () => {
  const cloud = stack({ cloud: true });

  it("is one statement: sts:AssumeRole on roles in other accounts, with an external id that names a Rovara org, and nothing else", () => {
    const found = assumesOf(cloud);
    expect(found).toHaveLength(1);
    expect(found[0]!.statement).toEqual({
      Sid: "AssumeCustomerCloudWatchRoles",
      Effect: "Allow",
      Action: "sts:AssumeRole",
      Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::*:role/*"]] },
      Condition: {
        StringNotEquals: { "aws:ResourceAccount": { Ref: "AWS::AccountId" } },
        StringLike: { "sts:ExternalId": "rovara-org_*" },
      },
    });
  });

  it("lives in the broker's orchestration managed policy, the group an sts action belongs to", () => {
    expect(assumesOf(cloud)[0]!.policy).toBe("agentx-staging-broker-orchestration");
  });

  it("adds no other sts action to the broker, and keeps the ConnectorSecretsRole's assume as it was", () => {
    const sts = brokerPolicies(cloud).flatMap((policy) => policy.statements).filter((statement) => [statement.Action].flat().some((action) => action.startsWith("sts:")));
    expect(sts.map((statement) => statement.Sid).sort()).toEqual(["AssumeConnectorSecretsRole", "AssumeCustomerCloudWatchRoles", "AssumeSavedEnvImageRoles", "AssumeTestAccountSecretsRole"]);
    expect(sts.find((statement) => statement.Sid === "AssumeConnectorSecretsRole")!.Action).toEqual(["sts:AssumeRole", "sts:TagSession"]);
  });

  it("gives the broker function its own role's name, from which it builds the ARN the customer's trust policy names as the principal", () => {
    const broker = Object.entries(cloud.findResources("AWS::Lambda::Function") as Record<string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }>)
      .find(([id]) => /^Broker[0-9A-F]{8}$/.test(id))!;
    const variables = broker[1].Properties.Environment?.Variables;
    // Neither a variable of its own nor in AGENTX_NAMES: the broker's environment is held under Lambda's 4 KB (lambda-environment-size), and the role's name is fixed, so the broker
    // builds the ARN from AGENTX_ENV where AGENTX_CLOUD is set (broker-environment.test.ts).
    expect(variables?.["BROKER_ROLE_ARN"]).toBeUndefined();
    expect(JSON.stringify(brokerNamesIn(variables))).not.toContain(brokerRoleName("staging"));
    expect(brokerNamesIn(variables)).toHaveProperty("cloudUserPool");
    const role = Object.values(cloud.findResources("AWS::IAM::Role")).find((entry) => (entry as { Properties: { RoleName?: string } }).Properties.RoleName === brokerRoleName("staging"));
    expect(role).toBeDefined();
  });

  it("passes the broker the cloud flag exactly where the grant exists (one condition for both: the cloud and a named environment)", () => {
    const flagOf = (template: Template) => {
      const broker = Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }>)
        .find(([id]) => /^Broker[0-9A-F]{8}$/.test(id))!;
      return broker[1].Properties.Environment?.Variables?.["AGENTX_CLOUD"];
    };
    expect(assumesOf(cloud)).toHaveLength(1);
    expect(flagOf(cloud)).toBe("true");
    for (const template of [stack({ cloud: false }), Template.fromStack(new ControlPlaneStack(new App(), "AssumeCwFlagLegacy"))]) {
      expect(assumesOf(template)).toEqual([]);
      expect(flagOf(template)).toBeUndefined();
    }
  });

  it("turns on the company admin console and automations in the web app for a cloud environment only, and no placeholder page", () => {
    const variablesOf = (template: Template) => Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }>)
      .find(([id]) => /^Broker[0-9A-F]{8}$/.test(id))![1].Properties.Environment?.Variables;
    // WEB_FEATURES is one of the broker's packed settings (ENV-ROOM), never a variable of its own in a named environment.
    expect(variablesOf(cloud)?.["WEB_FEATURES"]).toBeUndefined();
    // Owner decision 149: automations (`chains`) are on by default, beside the admin console; the placeholder pages (usage, describe) stay off.
    expect(brokerSettingsIn(variablesOf(cloud) as Parameters<typeof brokerSettingsIn>[0]).webFeatures).toBe("admin-chains");
    for (const template of [stack({ cloud: false }), Template.fromStack(new ControlPlaneStack(new App(), "WebFeaturesLegacy"))]) {
      expect(brokerSettingsIn(variablesOf(template) as Parameters<typeof brokerSettingsIn>[0]).webFeatures).toBeUndefined();
      expect(variablesOf(template)?.["WEB_FEATURES"]).toBeUndefined();
    }
  });

  it("a fresh cloud install and an existing one with no explicit value both have automations on (owner decision 149)", () => {
    const featuresOf = (template: Template) => brokerSettingsIn(Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }>)
      .find(([id]) => /^Broker[0-9A-F]{8}$/.test(id))![1].Properties.Environment?.Variables).webFeatures;
    // The list is a constant of the stack: a new install and an upgrade synthesize the same value, and the engine's own reader (the one the routes and the sweep use) reads it as on.
    const fresh = featuresOf(stack({ cloud: true }));
    const upgraded = featuresOf(stack({ cloud: true }));
    expect(fresh).toBe(upgraded);
    expect(automationsEnabled({ WEB_FEATURES: fresh })).toBe(true);
    expect(webFeatureNames(fresh)).toEqual(["admin", "chains"]);
    // The off state is still the stack's absence of the list: a legacy or non-cloud install never had the console or automations.
    expect(automationsEnabled({ WEB_FEATURES: featuresOf(stack({ cloud: false })) })).toBe(false);
  });

  it("does not exist on a named environment without the cloud, nor on the legacy install", () => {
    for (const template of [stack({ cloud: false }), Template.fromStack(new ControlPlaneStack(new App(), "AssumeCwLegacy"))]) {
      expect(assumesOf(template)).toEqual([]);
      expect(JSON.stringify(template.toJSON())).not.toContain("BROKER_ROLE_ARN");
      expect(JSON.stringify(template.toJSON())).not.toContain("AssumeCustomerCloudWatchRoles");
    }
  });
});
