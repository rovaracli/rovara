// Owner decision 123, review H1: the worker security group opens the operator's extra ports (rovaraPrivateAddressPorts) toward an Enterprise install's routed private ranges only, never toward its own VPC; nothing changes
// for any install that does not set them; and the broker is told the routed ranges and the open ports, only on an Enterprise install with routed ranges.
import { existsSync, mkdirSync } from "node:fs";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { environmentNaming } from "../../infra/lib/naming.js";
import { AGENTX_PRODUCTION_VPC_CIDR, ProductionFoundationStack, type ProductionFoundationStackProps } from "../../infra/lib/production-foundation.js";
import { PRIVATE_ADDRESS_PORTS_MAX, parsePrivateAddressPorts, privateAddressBrokerEnvironment } from "../../infra/lib/private-addresses.js";
import { BROKER_ENVIRONMENT_KEYS, checkedBrokerEnvironment } from "../../infra/lib/private-mcp.js";
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
  const install = { enterprise: true, routedCidrs: APPROVED };
  it("is a short list of ports, 443 implied, on Enterprise with routed ranges only", () => {
    expect(parsePrivateAddressPorts(undefined, install)).toEqual([]);
    expect(parsePrivateAddressPorts("8443,8081,443,8081", install)).toEqual([8081, 8443]);
    expect(() => parsePrivateAddressPorts("8081", { enterprise: false, routedCidrs: APPROVED })).toThrow("Enterprise");
    expect(() => parsePrivateAddressPorts("8081", { enterprise: true, routedCidrs: [] })).toThrow("rovaraEnterpriseEgressCidrs");
    for (const bad of ["8081-8090", "0", "65536", "80,x", "*", " 8081"]) expect(() => parsePrivateAddressPorts(bad, install), bad).toThrow();
    expect(() => parsePrivateAddressPorts(Array.from({ length: PRIVATE_ADDRESS_PORTS_MAX + 1 }, (_, index) => String(9000 + index)).join(","), install)).toThrow("at most");
    expect(() => parsePrivateAddressPorts("8081,8082,8083", { enterprise: true, routedCidrs: Array.from({ length: 13 }, (_, index) => `10.${String(index)}.0.0/16`) })).toThrow("would not fit");
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
