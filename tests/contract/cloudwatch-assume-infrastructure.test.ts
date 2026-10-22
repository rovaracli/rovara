// Plan 4 Task 16: the broker role's grant to assume a customer's role for the CloudWatch connector, and the permissions boundary that must also allow it.
// The grant is exact: one action, a role in another account only, and only with an external id that names a Rovara org. It exists on the hosted cloud
// (named environment with agentxCloud) and nowhere else, and lives in the broker's orchestration managed policy (the group an sts action falls in).
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
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
    expect(sts.map((statement) => statement.Sid).sort()).toEqual(["AssumeConnectorSecretsRole", "AssumeCustomerCloudWatchRoles"]);
    expect(sts.find((statement) => statement.Sid === "AssumeConnectorSecretsRole")!.Action).toEqual(["sts:AssumeRole", "sts:TagSession"]);
  });

  it("gives the broker function its own role's ARN, which the customer's trust policy names as the principal", () => {
    const roleId = Object.keys(cloud.findResources("AWS::IAM::Role")).find((id) => id.startsWith("BrokerServiceRole"))!;
    const broker = Object.entries(cloud.findResources("AWS::Lambda::Function") as Record<string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }>)
      .find(([id]) => /^Broker[0-9A-F]{8}$/.test(id))!;
    expect(broker[1].Properties.Environment?.Variables?.["BROKER_ROLE_ARN"]).toEqual({ "Fn::GetAtt": [roleId, "Arn"] });
  });

  it("does not exist on a named environment without the cloud, nor on the legacy install", () => {
    for (const template of [stack({ cloud: false }), Template.fromStack(new ControlPlaneStack(new App(), "AssumeCwLegacy"))]) {
      expect(assumesOf(template)).toEqual([]);
      expect(JSON.stringify(template.toJSON())).not.toContain("BROKER_ROLE_ARN");
      expect(JSON.stringify(template.toJSON())).not.toContain("AssumeCustomerCloudWatchRoles");
    }
  });
});
