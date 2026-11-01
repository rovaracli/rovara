// ME-13 (wire lane C): the install's private MCP settings at synth. They arrive as CDK context, only in an Enterprise install, and reach the broker as the environment variables it reads
// (ROVARA_PRIVATE_MCP_CIDRS). Package-run servers stay off: asking for them stops synth with a clear sentence. The MCP host's certificate comes from config, never from a literal.
import { App, Stack, aws_ecs as ecs } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { McpHost } from "../../infra/lib/mcp-host.js";
import { BROKER_ENVIRONMENT_KEYS, PRIVATE_MCP_CONTEXT_KEYS, checkedBrokerEnvironment, mcpHostPropsFromInstall, parsePrivateMcpContext, privateMcpBrokerEnvironment } from "../../infra/lib/private-mcp.js";

const context = (values: Record<string, unknown>) => (key: string): unknown => values[key];
const KEYS = PRIVATE_MCP_CONTEXT_KEYS;
const CERT = "arn:aws:acm:us-east-1:111111111111:certificate/0a1b2c3d-0000-1111-2222-333344445555";

describe("the private MCP context", () => {
  it("is empty, and adds nothing to the broker, when nothing is set (any edition)", () => {
    for (const edition of [undefined, "public", "enterprise"] as const) {
      const install = parsePrivateMcpContext({ edition, get: context({}) });
      expect(install).toEqual({ privateCidrs: [], stdioRequested: false });
      expect(privateMcpBrokerEnvironment(install)).toEqual({});
    }
  });
  it("refuses any of its settings outside an Enterprise install, so Public never carries a private network setting", () => {
    for (const edition of [undefined, "public"] as const) {
      for (const [key, value] of [[KEYS.cidrs, "10.1.0.0/16"], [KEYS.certificateArn, CERT], [KEYS.hostName, "mcp.example.net"], [KEYS.hostedZoneId, "Z0123456789ABCDEFGHIJ"]] as const) {
        expect(() => parsePrivateMcpContext({ edition, get: context({ [key]: value }) }), `${edition} ${key}`).toThrow(/Enterprise/u);
      }
    }
  });
  it("hands the private ranges to the broker as ROVARA_PRIVATE_MCP_CIDRS", () => {
    const install = parsePrivateMcpContext({ edition: "enterprise", get: context({ [KEYS.cidrs]: "10.1.0.0/16, 192.168.4.0/24, 10.1.0.0/16" }) });
    expect(install.privateCidrs).toEqual(["10.1.0.0/16", "192.168.4.0/24"]);
    expect(privateMcpBrokerEnvironment(install)).toEqual({ ROVARA_PRIVATE_MCP_CIDRS: "10.1.0.0/16,192.168.4.0/24", ROVARA_VPC_CIDRS: "10.42.0.0/16" });
  });
  it("refuses a range that is public, too wide, or not a range, naming this setting", () => {
    for (const cidr of ["8.8.8.0/24", "0.0.0.0/0", "10.0.0.0/7", "10.1.0.0/33", "nonsense", "10.1.0.0"]) {
      expect(() => parsePrivateMcpContext({ edition: "enterprise", get: context({ [KEYS.cidrs]: cidr }) }), cidr).toThrow(new RegExp(KEYS.cidrs, "u"));
    }
    expect(() => parsePrivateMcpContext({ edition: "enterprise", get: context({ [KEYS.cidrs]: ["10.1.0.0/16"] }) })).toThrow(/comma-separated string/u);
  });
  it("fix round: refuses a range that overlaps the network Rovara runs in, and tells the broker that network so it refuses the same", () => {
    for (const cidr of ["10.0.0.0/8", "10.42.0.0/16", "10.42.8.0/24", "10.40.0.0/14"]) {
      expect(() => parsePrivateMcpContext({ edition: "enterprise", get: context({ [KEYS.cidrs]: cidr }) }), cidr).toThrow(/overlaps the network Rovara/u);
    }
    // a range elsewhere is fine, and an install whose network is another range is judged against that one
    const install = parsePrivateMcpContext({ edition: "enterprise", get: context({ [KEYS.cidrs]: "10.43.0.0/16" }) });
    expect(privateMcpBrokerEnvironment(install)).toEqual({ ROVARA_PRIVATE_MCP_CIDRS: "10.43.0.0/16", ROVARA_VPC_CIDRS: "10.42.0.0/16" });
    expect(() => parsePrivateMcpContext({ edition: "enterprise", vpcCidrs: ["10.43.0.0/20"], get: context({ [KEYS.cidrs]: "10.43.4.0/24" }) })).toThrow(/overlaps the network Rovara/u);
    expect(parsePrivateMcpContext({ edition: "enterprise", vpcCidrs: ["10.43.0.0/20"], get: context({ [KEYS.cidrs]: "10.42.0.0/16" }) }).privateCidrs).toEqual(["10.42.0.0/16"]);
  });
  it("keeps package-run servers off: they are never in the broker's environment, and asking for them stops synth", () => {
    expect(privateMcpBrokerEnvironment(parsePrivateMcpContext({ edition: "enterprise", get: context({ [KEYS.cidrs]: "10.1.0.0/16" }) }))).not.toHaveProperty("ROVARA_STDIO_MCP_SERVERS");
    for (const value of [true, "true", "1", 1]) {
      expect(() => parsePrivateMcpContext({ edition: "enterprise", get: context({ [KEYS.stdio]: value }) }), String(value)).toThrow(/switched off/u);
    }
    // only a plain "off" is accepted as an explicit answer
    expect(parsePrivateMcpContext({ edition: "enterprise", get: context({ [KEYS.stdio]: false }) }).stdioRequested).toBe(false);
    expect(parsePrivateMcpContext({ edition: "enterprise", get: context({ [KEYS.stdio]: "false" }) }).stdioRequested).toBe(false);
    expect(() => parsePrivateMcpContext({ edition: "enterprise", get: context({ [KEYS.stdio]: "maybe" }) })).toThrow(/true or false/u);
  });
});

describe("the MCP host's certificate", () => {
  const full = { [KEYS.certificateArn]: CERT, [KEYS.hostName]: "mcp-host.example.net", [KEYS.hostedZoneId]: "Z0123456789ABCDEFGHIJ" };
  it("comes from the install's config: a host with a missing, partial or malformed one stops synth, naming the setting", () => {
    expect(mcpHostPropsFromInstall(parsePrivateMcpContext({ edition: "enterprise", get: context(full) }))).toEqual({ certificateArn: CERT, hostName: "mcp-host.example.net", hostedZoneId: "Z0123456789ABCDEFGHIJ" });
    expect(() => mcpHostPropsFromInstall(parsePrivateMcpContext({ edition: "enterprise", get: context({}) }))).toThrow(new RegExp(KEYS.certificateArn, "u"));
    for (const key of Object.keys(full)) {
      const { [key]: _removed, ...rest } = full as Record<string, string>; // eslint-disable-line @typescript-eslint/no-unused-vars -- the one setting left out
      expect(() => mcpHostPropsFromInstall(parsePrivateMcpContext({ edition: "enterprise", get: context(rest) })), key).toThrow(new RegExp(key, "u"));
    }
    for (const bad of ["", "not-an-arn", "arn:aws:iam::111111111111:role/x", "arn:aws:acm:us-east-1:111111111111:certificate/", "arn:aws:acm:us-east-1:abc:certificate/x"]) {
      expect(() => parsePrivateMcpContext({ edition: "enterprise", get: context({ ...full, [KEYS.certificateArn]: bad }) }), bad).toThrow(new RegExp(KEYS.certificateArn, "u"));
    }
    for (const bad of ["h", "elb.amazonaws.com", "x.eu-west-1.elb.amazonaws.com", "10.0.0.1", "a b.example.net"]) {
      expect(() => parsePrivateMcpContext({ edition: "enterprise", get: context({ ...full, [KEYS.hostName]: bad }) }), bad).toThrow(new RegExp(KEYS.hostName, "u"));
    }
    expect(() => parsePrivateMcpContext({ edition: "enterprise", get: context({ ...full, [KEYS.hostedZoneId]: "zone one" }) })).toThrow(new RegExp(KEYS.hostedZoneId, "u"));
  });
  it("is what McpHost is built from, and McpHost itself refuses a certificate that is not an ACM one", () => {
    const props = mcpHostPropsFromInstall(parsePrivateMcpContext({ edition: "enterprise", get: context(full) }));
    const build = (certificateArn: string) => new McpHost(new Stack(new App(), "S", { env: { account: "111111111111", region: "us-east-1" } }), "H", {
      vpcId: "vpc-0123456789abcdef0", availabilityZones: ["us-east-1a"], subnetIds: ["subnet-0aaaaaaaaaaaaaaaa"], image: ecs.ContainerImage.fromRegistry("x"), clientSecurityGroupIds: [],
      stateTableArn: "arn:aws:dynamodb:us-east-1:111111111111:table/s", stateTableName: "s", orgId: "org_aaaaaaaaaaaaaaaaaaaa", privateEgressCidrs: ["10.0.0.0/16"], ...props, certificateArn,
    });
    expect(build(props.certificateArn).url).toBe("https://mcp-host.example.net");
    expect(() => build("not-an-arn")).toThrow(/ACM certificate/u);
    expect(() => build("arn:aws:iam::111111111111:server-certificate/x")).toThrow(/ACM certificate/u);
  });
});

/** The app as `rovara deploy` builds it: the control plane's broker function is the one that holds the callback signing key. */
function brokerEnvironment(context: Record<string, unknown>): Record<string, unknown> {
  const app = buildAgentXApp(context);
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane")!;
  const functions = Object.values(Template.fromStack(stack).findResources("AWS::Lambda::Function")) as Array<{ Properties: { Environment?: { Variables?: Record<string, unknown> } } }>;
  const broker = functions.find((fn) => fn.Properties.Environment?.Variables?.CALLBACK_SIGNING_KEY !== undefined);
  return broker?.Properties.Environment?.Variables ?? {};
}
const ENTERPRISE = { agentxEnv: "ent", rovaraEdition: "enterprise", rovaraEnterpriseEgressCidrs: "10.0.0.0/16", agentxAuditTsa: "off" } as const;

describe("the app, built as `rovara deploy` builds it", () => {
  it("gives the broker the private ranges in an Enterprise install, and nothing private-network by default", () => {
    const withRanges = brokerEnvironment({ ...ENTERPRISE, [KEYS.cidrs]: "10.1.0.0/16,192.168.4.0/24" });
    expect(withRanges.ROVARA_PRIVATE_MCP_CIDRS).toBe("10.1.0.0/16,192.168.4.0/24");
    expect(withRanges.ROVARA_VPC_CIDRS).toBe("10.42.0.0/16");
    const plain = brokerEnvironment(ENTERPRISE);
    expect(plain).not.toHaveProperty("ROVARA_PRIVATE_MCP_CIDRS");
    expect(plain).not.toHaveProperty("ROVARA_STDIO_MCP_SERVERS");
    expect(plain).not.toHaveProperty("MCP_HOST_URL");
    // Two whole-app synths with real Lambda bundling: about 20 s here and over 60 s on the 2 vCPU runner, so it takes the timeout of the other synth tests.
  }, 240_000);
  it("stops synth for a wrong setting, for package-run servers, and for any setting outside Enterprise", () => {
    expect(() => buildAgentXApp({ ...ENTERPRISE, [KEYS.cidrs]: "8.8.8.0/24" })).toThrow(new RegExp(KEYS.cidrs, "u"));
    expect(() => buildAgentXApp({ ...ENTERPRISE, [KEYS.cidrs]: "10.42.0.0/24" })).toThrow(/overlaps the network Rovara/u);
    expect(() => buildAgentXApp({ ...ENTERPRISE, [KEYS.stdio]: "true" })).toThrow(/switched off/u);
    expect(() => buildAgentXApp({ ...ENTERPRISE, [KEYS.certificateArn]: "nope" })).toThrow(new RegExp(KEYS.certificateArn, "u"));
    expect(() => buildAgentXApp({ agentxEnv: "staging", agentxCloud: true, [KEYS.cidrs]: "10.1.0.0/16" })).toThrow(/Enterprise/u);
    expect(() => buildAgentXApp({ agentxEnv: "staging", [KEYS.certificateArn]: CERT })).toThrow(/Enterprise/u);
  });
});

describe("the broker's added environment (fix round)", () => {
  it("accepts only the private MCP variables and refuses any other name, a reserved one above all", () => {
    expect([...BROKER_ENVIRONMENT_KEYS]).toEqual(["ROVARA_PRIVATE_MCP_CIDRS", "ROVARA_VPC_CIDRS"]);
    expect(checkedBrokerEnvironment({ ROVARA_PRIVATE_MCP_CIDRS: "10.1.0.0/16", ROVARA_VPC_CIDRS: "10.42.0.0/16" })).toEqual({ ROVARA_PRIVATE_MCP_CIDRS: "10.1.0.0/16", ROVARA_VPC_CIDRS: "10.42.0.0/16" });
    expect(checkedBrokerEnvironment(undefined)).toEqual({});
    for (const name of ["CALLBACK_SIGNING_KEY", "STATE_TABLE_NAME", "OIDC_ISSUER", "ROVARA_EDITION", "ROVARA_STDIO_MCP_SERVERS", "MCP_HOST_URL"]) {
      expect(() => checkedBrokerEnvironment({ [name]: "x" }), name).toThrow(/not one an install setting may add/u);
    }
  });
  it("stops the control plane from being built with a reserved variable, and never overwrites the signing key", () => {
    const build = (brokerEnvironment: Record<string, string>) => new ControlPlaneStack(new App(), "ControlPlane", { brokerEnvironment });
    expect(() => build({ CALLBACK_SIGNING_KEY: "attacker-chosen" })).toThrow(/CALLBACK_SIGNING_KEY/u);
    expect(() => build({ ROVARA_PRIVATE_MCP_CIDRS: "10.1.0.0/16" })).not.toThrow();
  });
});
