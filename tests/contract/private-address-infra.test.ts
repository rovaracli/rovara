// Owner decision 123, review H1: the worker security group opens the operator's extra ports (rovaraPrivateAddressPorts) toward an Enterprise install's routed private ranges only, never toward its own VPC; nothing changes
// for any install that does not set them; and the broker is told the routed ranges and the open ports, only on an Enterprise install with routed ranges.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { environmentNaming } from "../../infra/lib/naming.js";
import { AGENTX_PRODUCTION_VPC_CIDR, ProductionFoundationStack, type ProductionFoundationStackProps } from "../../infra/lib/production-foundation.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { PRIVATE_ADDRESS_LAUNCH_ENVIRONMENT, PRIVATE_ADDRESS_PORTS_MAX, parsePrivateAddressPorts, privateAddressBrokerEnvironment } from "../../infra/lib/private-addresses.js";
import { BROKER_ENVIRONMENT_KEYS, checkedBrokerEnvironment } from "../../infra/lib/private-mcp.js";
import { egressCidrsWithVpc } from "../../infra/lib/vpc-endpoints.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();
if (!existsSync("packages/web/dist/app/assets")) mkdirSync("packages/web/dist/app/assets", { recursive: true });
const APPROVED = ["10.99.0.0/16", "10.98.0.0/16"];
type Egress = { CidrIp?: string; FromPort?: number; ToPort?: number; IpProtocol?: string; Description?: string };

function workerEgress(props: Partial<ProductionFoundationStackProps>): Egress[] {
  const template = Template.fromStack(new ProductionFoundationStack(new App(), "TestFoundation", { deploymentRegion: "us-east-1", naming: environmentNaming("ent"), ...props }));
  const groups = Object.values(template.toJSON().Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>).filter((resource) => resource.Type === "AWS::EC2::SecurityGroup");
  const worker = groups.find((group) => String(group.Properties.GroupName).includes("worker") && String(group.Properties.GroupDescription).startsWith("AgentX EC2 workers"));
  return (worker?.Properties.SecurityGroupEgress as Egress[] | undefined) ?? [];
}

describe("the worker security group", () => {
  it("opens each extra port to each routed range, never to the install's VPC or the internet, beside the 443 rules", () => {
    const egress = workerEgress({ edition: "enterprise", enterpriseEgressCidrs: APPROVED, privateAddressPorts: [8081, 8443] });
    const extra = egress.filter((rule) => rule.FromPort !== 443);
    expect(extra.map((rule) => `${String(rule.FromPort)}-${String(rule.ToPort)}>${rule.CidrIp!}`).sort()).toEqual(["8081-8081>10.98.0.0/16", "8081-8081>10.99.0.0/16", "8443-8443>10.98.0.0/16", "8443-8443>10.99.0.0/16"]);
    for (const rule of extra) { expect(rule.IpProtocol).toBe("tcp"); expect(rule.CidrIp).not.toBe(AGENTX_PRODUCTION_VPC_CIDR); expect(rule.CidrIp).not.toBe("0.0.0.0/0"); }
    expect(egress.filter((rule) => rule.FromPort === 443).map((rule) => rule.CidrIp).sort()).toEqual([AGENTX_PRODUCTION_VPC_CIDR, ...APPROVED].sort());
  });

  it("is exactly as before without extra ports, and refuses them off Enterprise", () => {
    expect(workerEgress({ edition: "enterprise", enterpriseEgressCidrs: APPROVED })).toEqual(workerEgress({ edition: "enterprise", enterpriseEgressCidrs: APPROVED, privateAddressPorts: [] }));
    expect(workerEgress({ edition: "enterprise", enterpriseEgressCidrs: APPROVED }).every((rule) => rule.FromPort === 443)).toBe(true);
    expect(() => workerEgress({ privateAddressPorts: [8081] })).toThrow("Enterprise edition setting");
  });
});

describe("rovaraPrivateAddressPorts", () => {
  const install = { enterprise: true, routedCidrs: APPROVED, vpcCidrs: [AGENTX_PRODUCTION_VPC_CIDR] };
  it("is a short list of ports, 443 implied, on Enterprise with routed ranges only", () => {
    expect(parsePrivateAddressPorts(undefined, install)).toEqual([]);
    expect(parsePrivateAddressPorts("8443,8081,443,8081", install)).toEqual([8081, 8443]);
    expect(() => parsePrivateAddressPorts("8081", { ...install, enterprise: false })).toThrow("Enterprise");
    expect(() => parsePrivateAddressPorts("8081", { ...install, routedCidrs: [] })).toThrow("rovaraEnterpriseEgressCidrs");
    for (const bad of ["8081-8090", "0", "65536", "80,x", "*", " 8081"]) expect(() => parsePrivateAddressPorts(bad, install), bad).toThrow();
    expect(() => parsePrivateAddressPorts(Array.from({ length: PRIVATE_ADDRESS_PORTS_MAX + 1 }, (_, index) => String(9000 + index)).join(","), install)).toThrow("at most");
    expect(() => parsePrivateAddressPorts("8081,8082,8083", { ...install, routedCidrs: Array.from({ length: 13 }, (_, index) => `10.${String(index + 50)}.0.0/16`) })).toThrow("would not fit");
  });

  it("tells the broker the routed ranges and the open ports, on Enterprise with routed ranges only, through the allowed settings", () => {
    const environment = privateAddressBrokerEnvironment({ enterprise: true, routedCidrs: APPROVED, ports: [8081] });
    expect(environment).toEqual({ ROVARA_PRIVATE_ADDRESS_CIDRS: "10.99.0.0/16,10.98.0.0/16", ROVARA_PRIVATE_ADDRESS_PORTS: "443,8081" });
    expect(checkedBrokerEnvironment(environment)).toEqual(environment);
    expect(BROKER_ENVIRONMENT_KEYS).toEqual(expect.arrayContaining(["ROVARA_PRIVATE_ADDRESS_CIDRS", "ROVARA_PRIVATE_ADDRESS_PORTS"]));
    expect(privateAddressBrokerEnvironment({ enterprise: true, routedCidrs: [], ports: [] })).toEqual({});
    expect(privateAddressBrokerEnvironment({ enterprise: false, routedCidrs: APPROVED, ports: [] })).toEqual({});
  });
});

// Review M1: an extra port is opened toward every routed range, and a rule cannot leave part of a range out, so a routed range that overlaps the install's own network (10.42.0.0/16) would open the port inside the install.
// The choice: the extra ports are refused at synth while any routed range equals, lies inside or contains the network; the ranges stay valid without extra ports (443 to the network is allowed anyway).
describe("a routed range that overlaps the install's network (review M1)", () => {
  const OVERLAPPING = ["10.0.0.0/8", "10.40.0.0/14", AGENTX_PRODUCTION_VPC_CIDR, "10.42.8.0/24", "10.42.0.1/32"];
  const vpcCidrs = [AGENTX_PRODUCTION_VPC_CIDR];

  it("refuses the extra ports, with a clear error naming the range and the network, for a range that contains, equals or lies inside it", () => {
    for (const cidr of OVERLAPPING) {
      const message = `entry ${JSON.stringify(cidr)} overlaps the network Rovara itself runs in (${AGENTX_PRODUCTION_VPC_CIDR})`;
      expect(() => parsePrivateAddressPorts("5432,8081", { enterprise: true, routedCidrs: ["10.99.0.0/16", cidr], vpcCidrs }), cidr).toThrow(message);
      // The stack refuses it too (a stack built without the app's parse never opens the port).
      expect(() => workerEgress({ edition: "enterprise", enterpriseEgressCidrs: [cidr, "10.99.0.0/16"], privateAddressPorts: [5432, 8081] }), cidr).toThrow(message);
    }
    // The whole app, as an operator runs it: 10/8 and the VPC range, ports 5432 and 8081.
    expect(() => buildAgentXApp({ agentxEnv: "ent", rovaraEdition: "enterprise", rovaraEnterpriseEgressCidrs: "10.0.0.0/8,10.42.0.0/16", rovaraPrivateAddressPorts: "5432,8081", agentxAuditTsa: "off" })).toThrow("overlaps the network Rovara itself runs in");
    expect(() => parsePrivateAddressPorts("5432", { enterprise: true, routedCidrs: ["10.0.0.0/8"], vpcCidrs })).toThrow("remove rovaraPrivateAddressPorts");
  });

  it("opens no extra port toward the network for any accepted setting: the same stack with a non-overlapping range has the extra rules for it alone", () => {
    const egress = workerEgress({ edition: "enterprise", enterpriseEgressCidrs: ["10.99.0.0/16"], privateAddressPorts: [5432, 8081] });
    const extra = egress.filter((rule) => rule.FromPort !== 443).map((rule) => `${String(rule.FromPort)}>${rule.CidrIp!}`).sort();
    expect(extra).toEqual(["5432>10.99.0.0/16", "8081>10.99.0.0/16"]);
    // A range next to the network (10.43/16) is not an overlap.
    expect(parsePrivateAddressPorts("5432", { enterprise: true, routedCidrs: ["10.43.0.0/16", "10.41.255.0/24"], vpcCidrs })).toEqual([5432]);
  });

  it("keeps such ranges valid without extra ports (443 only), exactly as before, and port 443 alone is no extra port", () => {
    for (const cidr of OVERLAPPING) {
      expect(parsePrivateAddressPorts(undefined, { enterprise: true, routedCidrs: [cidr], vpcCidrs })).toEqual([]);
      expect(parsePrivateAddressPorts("443", { enterprise: true, routedCidrs: [cidr], vpcCidrs })).toEqual([]);
      const egress = workerEgress({ edition: "enterprise", enterpriseEgressCidrs: [cidr] });
      expect(egress.every((rule) => rule.FromPort === 443 && rule.ToPort === 443)).toBe(true);
    }
  });

  it("lists the network's range once on 443 when a listed range equals it (no duplicate rule)", () => {
    expect(egressCidrsWithVpc(AGENTX_PRODUCTION_VPC_CIDR, [AGENTX_PRODUCTION_VPC_CIDR, "10.99.0.0/16", "10.99.0.0/16"])).toEqual([AGENTX_PRODUCTION_VPC_CIDR, "10.99.0.0/16"]);
    for (const listed of [[AGENTX_PRODUCTION_VPC_CIDR, "10.99.0.0/16"], ["10.0.0.0/8", AGENTX_PRODUCTION_VPC_CIDR]]) {
      const rules = workerEgress({ edition: "enterprise", enterpriseEgressCidrs: listed }).filter((rule) => rule.FromPort === 443).map((rule) => rule.CidrIp!);
      expect(rules.filter((cidr) => cidr === AGENTX_PRODUCTION_VPC_CIDR)).toHaveLength(1);
      expect(new Set(rules).size).toBe(rules.length);
      expect(rules.sort()).toEqual([...new Set([AGENTX_PRODUCTION_VPC_CIDR, ...listed])].sort());
    }
  });
});

// Information finding: DNS is never a port workers open toward a routed range, in the list or in an entry.
describe("port 53 (DNS)", () => {
  it("is refused in the port list at synth, alone or among others, with words that say why", () => {
    const install = { enterprise: true, routedCidrs: APPROVED, vpcCidrs: [AGENTX_PRODUCTION_VPC_CIDR] };
    expect(() => parsePrivateAddressPorts("53", install)).toThrow("port 53 is DNS");
    expect(() => parsePrivateAddressPorts("8081,53,8443", install)).toThrow("port 53 is DNS");
    expect(parsePrivateAddressPorts("8081,5353", install)).toEqual([5353, 8081]);
  });
});

// Review L3: the Steps function (a worker launch) is given the same install settings as the route, named environments only, and only the ones the install sets.
describe("the launch's install settings", () => {
  const stepsEnvironment = (context: Record<string, unknown>): Record<string, unknown> => {
    const app = buildAgentXApp(context);
    const control = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane")!;
    const resources = Template.fromStack(control).toJSON().Resources as Record<string, { Type: string; Properties: { Environment?: { Variables?: Record<string, unknown> } } }>;
    const steps = Object.values(resources).filter((resource) => resource.Type === "AWS::Lambda::Function" && resource.Properties.Environment?.Variables?.WORKER_SETTINGS_PREFIX !== undefined && resource.Properties.Environment.Variables.WORKER_LOG_GROUP_NAME !== undefined);
    expect(steps).toHaveLength(1);
    return steps[0]!.Properties.Environment!.Variables!;
  };

  it("gives the Steps function the routed ranges, the open ports and the install's network on an Enterprise install that routes, as it gives the broker", () => {
    const environment = stepsEnvironment({ agentxEnv: "ent", rovaraEdition: "enterprise", rovaraEnterpriseEgressCidrs: "10.99.0.0/16,10.98.0.0/16", rovaraPrivateAddressPorts: "8081", agentxAuditTsa: "off" });
    expect(environment).toMatchObject({ ROVARA_PRIVATE_ADDRESS_CIDRS: "10.99.0.0/16,10.98.0.0/16", ROVARA_PRIVATE_ADDRESS_PORTS: "443,8081" });
    expect(PRIVATE_ADDRESS_LAUNCH_ENVIRONMENT).toEqual(["ROVARA_VPC_CIDRS", "ROVARA_PRIVATE_MCP_CIDRS", "ROVARA_MODEL_ENDPOINT_CIDRS", "ROVARA_PRIVATE_ADDRESS_CIDRS", "ROVARA_PRIVATE_ADDRESS_PORTS"]);
  }, 240_000);

  it("gives it none on an Enterprise install without routed ranges, a hosted install and the legacy deployment", () => {
    for (const context of [{ agentxEnv: "ent", rovaraEdition: "enterprise", rovaraEnterpriseInternetEgress: "nat", agentxAuditTsa: "off" }, { agentxEnv: "staging", agentxCloud: true }, {}]) {
      const environment = stepsEnvironment(context);
      for (const name of PRIVATE_ADDRESS_LAUNCH_ENVIRONMENT) expect(environment[name], `${JSON.stringify(context)} ${name}`).toBeUndefined();
    }
  }, 240_000);
});

// Review L4: the reaper error alarm also counts what the reaper could not check against a removed address (named environments); the legacy deployment's alarm is as it was.
describe("the reaper error alarm", () => {
  type Alarm = { Properties: Record<string, unknown> };
  const reaperAlarm = (context: Record<string, unknown>): Alarm => {
    const app = buildAgentXApp(context);
    const control = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane")!;
    const alarms = Object.values(Template.fromStack(control).toJSON().Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>).filter((resource) => resource.Type === "AWS::CloudWatch::Alarm" && String(resource.Properties.AlarmName).endsWith("SessionReaperErrors"));
    expect(alarms).toHaveLength(1);
    return alarms[0]!;
  };

  it("adds the reaper's unchecked-workers count to the Lambda errors in a named environment, and the metric is the one the reaper emits", () => {
    const alarm = reaperAlarm({ agentxEnv: "staging", agentxCloud: true });
    expect(alarm.Properties).toMatchObject({ Threshold: 1, EvaluationPeriods: 3, ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching" });
    expect(JSON.stringify(alarm.Properties.AlarmActions)).toContain("OperatorAlerts");
    const metrics = alarm.Properties.Metrics as Array<{ Expression?: string; Id: string; ReturnData?: boolean; MetricStat?: { Metric: { MetricName: string; Namespace: string }; Period: number; Stat: string } }>;
    expect(metrics.find((metric) => metric.Expression !== undefined)).toMatchObject({ Expression: "FILL(errors, 0) + FILL(unchecked, 0)" });
    expect(metrics.find((metric) => metric.Id === "errors")?.MetricStat).toMatchObject({ Metric: { MetricName: "Errors", Namespace: "AWS/Lambda" }, Period: 300, Stat: "Sum" });
    expect(metrics.find((metric) => metric.Id === "unchecked")?.MetricStat).toMatchObject({ Metric: { MetricName: "SessionsPrivateAddressRecycleErrors", Namespace: environmentNaming("staging").metricsNamespace }, Period: 300, Stat: "Sum" });
    expect(String(alarm.Properties.AlarmDescription)).toContain("removed internal address");
    expect(readFileSync(new URL("../../packages/broker/src/aws/session-reaper.ts", import.meta.url), "utf8")).toContain("SessionsPrivateAddressRecycleErrors:");
  }, 240_000);

  it("is unchanged in the legacy deployment: the Lambda errors alone", () => {
    const alarm = reaperAlarm({});
    expect(alarm.Properties).toMatchObject({ MetricName: "Errors", Namespace: "AWS/Lambda", Threshold: 1, EvaluationPeriods: 3 });
    expect(alarm.Properties.Metrics).toBeUndefined();
    expect(String(alarm.Properties.AlarmDescription)).not.toContain("internal address");
  }, 240_000);
});
