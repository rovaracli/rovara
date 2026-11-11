// N8: the install's settings for a company's own model endpoint, at synth. Enterprise only, off by default. When on, the broker gets the switch (and the private ranges), and the
// model access function (and only it) may read secrets named under rovara/model-endpoints/.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { SYNTH_CONTEXT_KEYS } from "@agentx/cloud-contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { MODEL_ENDPOINT_CONTEXT_KEYS, modelEndpointBrokerEnvironment, parseModelEndpointContext } from "../../infra/lib/model-endpoints.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const context = (values: Record<string, unknown>) => (key: string): unknown => values[key];
const KEYS = MODEL_ENDPOINT_CONTEXT_KEYS;

describe("the model endpoint context", () => {
  it("is off, and adds nothing to the broker, when nothing is set (any edition)", () => {
    for (const edition of [undefined, "public", "enterprise"] as const) {
      const install = parseModelEndpointContext({ edition, get: context({}) });
      expect(install.enabled).toBe(false);
      expect(modelEndpointBrokerEnvironment(install)).toEqual({});
    }
  });

  it("refuses its settings outside an Enterprise install, so Public never carries a custom endpoint setting", () => {
    for (const edition of [undefined, "public"] as const) {
      expect(() => parseModelEndpointContext({ edition, get: context({ [KEYS.enable]: "true" }) }), String(edition)).toThrow(/Enterprise/u);
      expect(() => parseModelEndpointContext({ edition, get: context({ [KEYS.enable]: true, [KEYS.cidrs]: "10.1.0.0/16" }) }), String(edition)).toThrow(/Enterprise/u);
    }
  });

  it("hands the switch, and the private ranges with Rovara's own network, to the broker", () => {
    const on = parseModelEndpointContext({ edition: "enterprise", get: context({ [KEYS.enable]: "true" }) });
    expect(modelEndpointBrokerEnvironment(on)).toEqual({ ROVARA_CUSTOM_MODEL_ENDPOINTS: "1" });
    const withRanges = parseModelEndpointContext({ edition: "enterprise", get: context({ [KEYS.enable]: true, [KEYS.cidrs]: "10.1.0.0/16, 192.168.4.0/24, 10.1.0.0/16" }) });
    expect(modelEndpointBrokerEnvironment(withRanges)).toEqual({ ROVARA_CUSTOM_MODEL_ENDPOINTS: "1", ROVARA_MODEL_ENDPOINT_CIDRS: "10.1.0.0/16,192.168.4.0/24", ROVARA_VPC_CIDRS: "10.42.0.0/16" });
  });

  it("refuses ranges without the switch, a public or too wide range, an overlap with Rovara's network, and a switch that is not a switch", () => {
    const enterprise = (values: Record<string, unknown>) => () => parseModelEndpointContext({ edition: "enterprise", get: context(values) });
    expect(enterprise({ [KEYS.cidrs]: "10.1.0.0/16" })).toThrow(new RegExp(`${KEYS.cidrs} needs ${KEYS.enable}`, "u"));
    expect(enterprise({ [KEYS.enable]: "true", [KEYS.cidrs]: "8.8.8.0/24" })).toThrow(new RegExp(KEYS.cidrs, "u"));
    expect(enterprise({ [KEYS.enable]: "true", [KEYS.cidrs]: "10.0.0.0/8" })).toThrow(new RegExp(KEYS.cidrs, "u"));
    expect(enterprise({ [KEYS.enable]: "true", [KEYS.cidrs]: "10.42.1.0/24" })).toThrow(/overlaps the network Rovara/u);
    expect(enterprise({ [KEYS.enable]: "maybe" })).toThrow(new RegExp(KEYS.enable, "u"));
    expect(enterprise({ [KEYS.enable]: "false" })()).toMatchObject({ enabled: false });
  });

  it("is part of what a build at approval takes from the install's recorded settings", () => {
    expect(SYNTH_CONTEXT_KEYS).toEqual(expect.arrayContaining([KEYS.enable, KEYS.cidrs]));
  });
});

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown };
type Resources = Record<string, { Type: string; Properties: { PolicyDocument?: { Statement: Statement[] }; Roles?: Array<{ Ref?: string }>; Role?: { "Fn::GetAtt"?: [string] }; Environment?: { Variables?: Record<string, unknown> } } }>;
const ENTERPRISE = { agentxEnv: "ent", rovaraEdition: "enterprise", rovaraEnterpriseEgressCidrs: "10.0.0.0/16", agentxAuditTsa: "off" } as const;

function controlPlane(values: Record<string, unknown>) {
  const app = buildAgentXApp(values);
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane")!;
  const resources = Template.fromStack(stack).toJSON().Resources as Resources;
  const functions = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::Lambda::Function");
  const access = functions.find(([id]) => id.startsWith("ModelAccessFunction"))!;
  const roleId = access[1].Properties.Role!["Fn::GetAtt"]![0];
  const statements = Object.values(resources)
    .filter((resource) => (resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy") && (resource.Properties.Roles ?? []).some((role) => role.Ref === roleId))
    .flatMap((resource) => resource.Properties.PolicyDocument!.Statement);
  const broker = functions.find(([, fn]) => fn.Properties.Environment?.Variables?.CALLBACK_SIGNING_KEY !== undefined)!;
  const groups = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::EC2::SecurityGroup") as Array<[string, { Properties: { SecurityGroupEgress?: Array<{ CidrIp?: string; FromPort?: number }> } }]>;
  const groupsReaching = (cidr: string) => groups.filter(([, group]) => (group.Properties.SecurityGroupEgress ?? []).some((rule) => rule.CidrIp === cidr && rule.FromPort === 443)).map(([id]) => id);
  return { statements, brokerEnvironment: broker[1].Properties.Environment?.Variables ?? {}, accessEnvironment: access[1].Properties.Environment?.Variables ?? {}, groupsReaching };
}

describe("the app, built as `rovara deploy` builds it", () => {
  it("gives the model access function one more grant, the model-endpoint secret prefix, and the broker the switch, only when the install turns endpoints on", () => {
    const off = controlPlane(ENTERPRISE);
    expect(off.statements.find((statement) => statement.Sid === "ReadModelEndpointSecrets")).toBeUndefined();
    expect(off.brokerEnvironment).not.toHaveProperty("ROVARA_CUSTOM_MODEL_ENDPOINTS");

    const on = controlPlane({ ...ENTERPRISE, [KEYS.enable]: "true", [KEYS.cidrs]: "10.1.0.0/16" });
    const grant = on.statements.find((statement) => statement.Sid === "ReadModelEndpointSecrets")!;
    expect(grant).toMatchObject({ Effect: "Allow", Action: "secretsmanager:GetSecretValue" });
    // Only the prefix: the resource names the model-endpoint secrets and ends in a wildcard of that prefix alone.
    expect(JSON.stringify(grant.Resource)).toContain(":secret:rovara/model-endpoints/*");
    expect(JSON.stringify(grant.Resource)).not.toContain(":secret:*");
    // No grant to create or change a secret anywhere on the function.
    const writes = on.statements.filter((statement) => [statement.Action].flat().some((action) => /secretsmanager:(Create|Put|Update|Delete|Rotate)/u.test(action)));
    expect(writes).toEqual([]);
    expect(on.brokerEnvironment).toMatchObject({ ROVARA_CUSTOM_MODEL_ENDPOINTS: "1", ROVARA_MODEL_ENDPOINT_CIDRS: "10.1.0.0/16", ROVARA_VPC_CIDRS: "10.42.0.0/16" });
    // Two whole-app synths with real Lambda bundling skipped, but the app is large: the timeout of the other synth tests.
  }, 240_000);

  it("lets the model proxy (and only it) reach the endpoint ranges over HTTPS, and gives the access function the settings it judges addresses with (S4)", () => {
    const off = controlPlane(ENTERPRISE);
    expect(off.groupsReaching("10.1.0.0/16")).toEqual([]);
    expect(off.accessEnvironment).not.toHaveProperty("ROVARA_CUSTOM_MODEL_ENDPOINTS");
    const on = controlPlane({ ...ENTERPRISE, [KEYS.enable]: "true", [KEYS.cidrs]: "10.1.0.0/16" });
    const reaching = on.groupsReaching("10.1.0.0/16");
    expect(reaching, "one security group reaches the range").toHaveLength(1);
    expect(reaching[0]).toMatch(/^ModelProxy/u);
    expect(on.accessEnvironment).toMatchObject({ ROVARA_CUSTOM_MODEL_ENDPOINTS: "1", ROVARA_MODEL_ENDPOINT_CIDRS: "10.1.0.0/16", ROVARA_VPC_CIDRS: "10.42.0.0/16" });
    // The switch alone adds no range anywhere.
    const switchOnly = controlPlane({ ...ENTERPRISE, [KEYS.enable]: "true" });
    expect(switchOnly.groupsReaching("10.1.0.0/16")).toEqual([]);
    expect(switchOnly.accessEnvironment).toMatchObject({ ROVARA_CUSTOM_MODEL_ENDPOINTS: "1" });
  }, 240_000);

  it("stops synth for a wrong setting and for any setting outside Enterprise", () => {
    expect(() => buildAgentXApp({ ...ENTERPRISE, [KEYS.cidrs]: "10.1.0.0/16" })).toThrow(new RegExp(`${KEYS.cidrs} needs`, "u"));
    expect(() => buildAgentXApp({ ...ENTERPRISE, [KEYS.enable]: "true", [KEYS.cidrs]: "8.8.8.0/24" })).toThrow(new RegExp(KEYS.cidrs, "u"));
    expect(() => buildAgentXApp({ agentxEnv: "staging", agentxCloud: true, [KEYS.enable]: "true" })).toThrow(/Enterprise/u);
    expect(() => buildAgentXApp({ agentxEnv: "staging", [KEYS.enable]: "true" })).toThrow(/Enterprise/u);
  }, 240_000);
});
