// ME-13 (wire lane C): the install's private MCP settings at synth. They arrive as CDK context, only in an Enterprise install, and reach the broker as the environment variables it reads
// (ROVARA_PRIVATE_MCP_CIDRS). Package-run servers stay off: asking for them stops synth with a clear sentence. The MCP host's certificate comes from config, never from a literal.
import { App, Stack, aws_ecs as ecs } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { McpHost } from "../../infra/lib/mcp-host.js";
import { editionPolicy, featureEnabled, SYNTH_CONTEXT_KEYS, SYNTH_EXCLUDED_KEYS } from "@agentx/cloud-contracts";
import { stdioAvailable } from "../../packages/broker/src/context-sources/mcp-servers.js";
import {
  BROKER_ENVIRONMENT_KEYS, PRIVATE_MCP_CONTEXT_KEYS, STDIO_BROKER_ENVIRONMENT_KEYS, STDIO_MCP_HOST_STACK_BUILT, STDIO_MCP_RELEASED, assertStdioHostStackBuilt, checkedBrokerEnvironment, mcpHostPropsFromInstall, parsePrivateMcpContext, privateMcpBrokerEnvironment,
} from "../../infra/lib/private-mcp.js";

const context = (values: Record<string, unknown>) => (key: string): unknown => values[key];
const KEYS = PRIVATE_MCP_CONTEXT_KEYS;
const CERT = "arn:aws:acm:us-east-1:111111111111:certificate/0a1b2c3d-0000-1111-2222-333344445555";
const TLS_SECRET = "arn:aws:secretsmanager:us-east-1:111111111111:secret:agentx/ent/mcp-controller-tls-AbCdEf";

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
      for (const [key, value] of [[KEYS.cidrs, "10.1.0.0/16"], [KEYS.certificateArn, CERT], [KEYS.hostName, "mcp.example.net"], [KEYS.hostedZoneId, "Z0123456789ABCDEFGHIJ"], [KEYS.npmRegistry, "https://registry.corp.example.net/npm/"]] as const) {
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

describe("the MCP host's settings", () => {
  const full: Record<string, string> = {
    [KEYS.certificateArn]: CERT, [KEYS.hostName]: "mcp-host.example.net", [KEYS.hostedZoneId]: "Z0123456789ABCDEFGHIJ", [KEYS.npmRegistry]: "https://registry.corp.example.net/npm/",
    [KEYS.runnerSubnetCidrs]: "10.42.160.0/22, 10.42.164.0/22", [KEYS.registryCidrs]: "10.60.0.0/24", [KEYS.controllerTlsSecretArn]: TLS_SECRET, [KEYS.controllerDnsNamespace]: "mcp.rovara.internal", [KEYS.cidrs]: "10.60.0.0/16",
  };
  const toHost = (values: Record<string, unknown>) => mcpHostPropsFromInstall(parsePrivateMcpContext({ edition: "enterprise", get: context(values) }));
  it("come from the install's config: a host with a missing, partial or malformed one stops synth, naming the setting", () => {
    expect(toHost(full)).toEqual({
      certificateArn: CERT, hostName: "mcp-host.example.net", hostedZoneId: "Z0123456789ABCDEFGHIJ", npmRegistry: "https://registry.corp.example.net/npm/", runnerSubnetCidrs: ["10.42.160.0/22", "10.42.164.0/22"],
      registryEgressCidrs: ["10.60.0.0/24"], controllerTlsSecretArn: TLS_SECRET, controllerDnsNamespace: "mcp.rovara.internal", privateMcpCidrs: ["10.60.0.0/16"], vpcCidrs: ["10.42.0.0/16"],
    });
    expect(() => toHost({})).toThrow(new RegExp(KEYS.certificateArn, "u"));
    for (const key of Object.keys(full)) {
      const { [key]: _removed, ...rest } = full; // eslint-disable-line @typescript-eslint/no-unused-vars -- the one setting left out
      expect(() => toHost(rest), key).toThrow(new RegExp(key, "u"));
    }
    for (const bad of ["", "not-an-arn", "arn:aws:iam::111111111111:role/x", "arn:aws:acm:us-east-1:111111111111:certificate/", "arn:aws:acm:us-east-1:abc:certificate/x"]) {
      expect(() => parsePrivateMcpContext({ edition: "enterprise", get: context({ ...full, [KEYS.certificateArn]: bad }) }), bad).toThrow(new RegExp(KEYS.certificateArn, "u"));
    }
    for (const bad of ["h", "elb.amazonaws.com", "x.eu-west-1.elb.amazonaws.com", "10.0.0.1", "a b.example.net"]) {
      expect(() => parsePrivateMcpContext({ edition: "enterprise", get: context({ ...full, [KEYS.hostName]: bad }) }), bad).toThrow(new RegExp(KEYS.hostName, "u"));
    }
    expect(() => parsePrivateMcpContext({ edition: "enterprise", get: context({ ...full, [KEYS.hostedZoneId]: "zone one" }) })).toThrow(new RegExp(KEYS.hostedZoneId, "u"));
  });
  it("takes the package registry as an https address only: no http, credentials, query, fragment, bare address or non-string (T8)", () => {
    for (const bad of ["", "http://registry.corp.example.net/", "https://u:p@registry.corp.example.net/", "https://registry.corp.example.net/?t=1", "https://registry.corp.example.net/#x", "https://10.0.0.5/npm/", "registry.corp.example.net", 5, ["https://registry.corp.example.net/"]]) {
      expect(() => parsePrivateMcpContext({ edition: "enterprise", get: context({ [KEYS.npmRegistry]: bad }) }), String(bad)).toThrow(new RegExp(KEYS.npmRegistry, "u"));
    }
    expect(parsePrivateMcpContext({ edition: "enterprise", get: context({ [KEYS.npmRegistry]: "https://registry.corp.example.net/npm" }) }).npmRegistry).toBe("https://registry.corp.example.net/npm");
  });
  it("T12: take the runner network, the registry's ranges and the controller's certificate only in the right shape", () => {
    const bad = (key: string, value: unknown) => expect(() => parsePrivateMcpContext({ edition: "enterprise", get: context({ [key]: value }) }), `${key}=${String(value)}`).toThrow(new RegExp(key, "u"));
    for (const value of ["", "10.42.160.0/27", "10.42.160.0/8", "10.42.160.0/22,10.42.164.0/22,10.42.168.0/22", "nonsense", "10.42.300.0/22", 5]) bad(KEYS.runnerSubnetCidrs, value);
    for (const value of ["0.0.0.0/0", "8.8.8.0/24", "10.0.0.0/7", "nonsense"]) bad(KEYS.registryCidrs, value);
    for (const value of ["", "not-an-arn", "arn:aws:iam::111111111111:role/x", 5]) bad(KEYS.controllerTlsSecretArn, value);
    for (const value of ["", "internal", "x.amazonaws.com", "10.0.0.1", "a b.internal", 5]) bad(KEYS.controllerDnsNamespace, value);
    for (const value of ["", "not a certificate", "-----BEGIN PRIVATE KEY-----\nabc", `-----BEGIN CERTIFICATE-----\n${"A".repeat(7_100)}`, "-----BEGIN CERTIFICATE-----\nx\n-----BEGIN RSA PRIVATE KEY-----", 5]) bad(KEYS.controllerCa, value);
    const ok = parsePrivateMcpContext({ edition: "enterprise", get: context({ ...full, [KEYS.controllerCa]: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n" }) });
    expect(ok.runnerSubnetCidrs).toEqual(["10.42.160.0/22", "10.42.164.0/22"]);
    expect(ok.controllerCa).toContain("BEGIN CERTIFICATE");
    expect(mcpHostPropsFromInstall(ok).controllerCaPem).toBe(ok.controllerCa);
    // outside Enterprise none of them is accepted
    for (const key of [KEYS.runnerSubnetCidrs, KEYS.registryCidrs, KEYS.controllerTlsSecretArn, KEYS.controllerDnsNamespace, KEYS.controllerCa]) expect(() => parsePrivateMcpContext({ edition: "public", get: context({ [key]: full[key] ?? "x" }) }), key).toThrow(/Enterprise/u);
  });
  it("fix round 1 S1: take the routes to the customer's networks as <range>=<tgw or pcx id>, at most 8, and no other shape", () => {
    const ok = parsePrivateMcpContext({ edition: "enterprise", get: context({ ...full, [KEYS.runnerRoutes]: "10.60.0.0/16=tgw-0123456789abcdef0, 192.168.8.0/24=pcx-0123456789abcdef0" }) });
    expect(ok.runnerRoutes).toEqual([{ cidr: "10.60.0.0/16", transitGatewayId: "tgw-0123456789abcdef0" }, { cidr: "192.168.8.0/24", vpcPeeringConnectionId: "pcx-0123456789abcdef0" }]);
    expect(mcpHostPropsFromInstall(ok).runnerRoutes).toEqual(ok.runnerRoutes);
    expect(mcpHostPropsFromInstall(parsePrivateMcpContext({ edition: "enterprise", get: context(full) }))).not.toHaveProperty("runnerRoutes");
    for (const bad of ["", "10.60.0.0/16", "10.60.0.0/16=igw-0123456789abcdef0", "0.0.0.0/0=tgw-0123456789abcdef0", "10.60.0.0/16=tgw-xyz", 5, Array.from({ length: 9 }, (_, i) => `10.${60 + i}.0.0/16=tgw-0123456789abcdef0`).join(",")]) {
      expect(() => parsePrivateMcpContext({ edition: "enterprise", get: context({ [KEYS.runnerRoutes]: bad }) }), String(bad)).toThrow(new RegExp(KEYS.runnerRoutes, "u"));
    }
    expect(() => parsePrivateMcpContext({ edition: "public", get: context({ [KEYS.runnerRoutes]: "10.60.0.0/16=tgw-0123456789abcdef0" }) })).toThrow(/Enterprise/u);
  });
  it("fix round 2: public npm is an explicit Enterprise setting, off by default; with it no registry ranges are given and the registry is public npm unless one is named", () => {
    const { [KEYS.registryCidrs]: _ranges, [KEYS.npmRegistry]: _registry, ...base } = full; // eslint-disable-line @typescript-eslint/no-unused-vars -- the customer's registry settings, left out
    const parse = (extra: Record<string, unknown>) => parsePrivateMcpContext({ edition: "enterprise", get: context({ ...base, ...extra }) });
    // default: nothing public, and the customer's registry and its ranges are required
    expect(mcpHostPropsFromInstall(parsePrivateMcpContext({ edition: "enterprise", get: context(full) }))).not.toHaveProperty("publicNpm");
    for (const off of [undefined, "false", false, "0", ""]) expect(() => mcpHostPropsFromInstall(parse({ [KEYS.publicNpm]: off })), String(off)).toThrow(new RegExp(KEYS.npmRegistry, "u"));
    // on: no registry settings needed, and the registry defaults to public npm
    for (const on of ["true", true, "1", 1]) {
      const host = mcpHostPropsFromInstall(parse({ [KEYS.publicNpm]: on }));
      expect(host, String(on)).toMatchObject({ publicNpm: true, npmRegistry: "https://registry.npmjs.org/", registryEgressCidrs: [] });
    }
    // a registry may still be named (a public one that is not npm's); ranges beside public npm are two ways to install and are refused
    expect(mcpHostPropsFromInstall(parse({ [KEYS.publicNpm]: "true", [KEYS.npmRegistry]: "https://npm.pkg.example.org/" })).npmRegistry).toBe("https://npm.pkg.example.org/");
    expect(() => mcpHostPropsFromInstall(parse({ [KEYS.publicNpm]: "true", [KEYS.registryCidrs]: "10.60.0.0/24" }))).toThrow(/two ways/u);
    for (const bad of ["maybe", "yes", 2, {}]) expect(() => parse({ [KEYS.publicNpm]: bad }), JSON.stringify(bad)).toThrow(new RegExp(KEYS.publicNpm, "u"));
    expect(() => parsePrivateMcpContext({ edition: "public", get: context({ [KEYS.publicNpm]: "true" }) })).toThrow(/Enterprise/u);
    expect((SYNTH_CONTEXT_KEYS as readonly string[]).includes(KEYS.publicNpm)).toBe(true);
  });
  it("are what McpHost is built from, and McpHost itself refuses a certificate that is not an ACM one", () => {
    const props = toHost(full);
    const build = (certificateArn: string) => new McpHost(new Stack(new App(), "S", { env: { account: "111111111111", region: "us-east-1" } }), "H", {
      vpcId: "vpc-0123456789abcdef0", vpcCidr: "10.42.0.0/16", availabilityZones: ["us-east-1a", "us-east-1b"], subnetIds: ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"], region: "us-east-1",
      image: ecs.ContainerImage.fromRegistry("x"), runnerImage: `111111111111.dkr.ecr.us-east-1.amazonaws.com/rovara/mcp-runner@sha256:${"a".repeat(64)}`, clientSecurityGroupIds: [],
      endpointSecurityGroupId: "sg-0endpoints000000000", stateTableArn: "arn:aws:dynamodb:us-east-1:111111111111:table/s", stateTableName: "s", orgId: "org_aaaaaaaaaaaaaaaaaaaa", agentxEnv: "ent", ...props, certificateArn,
    });
    expect(build(props.certificateArn).url).toBe("https://mcp-host.example.net");
    expect(() => build("not-an-arn")).toThrow(/ACM certificate/u);
    expect(() => build("arn:aws:iam::111111111111:server-certificate/x")).toThrow(/ACM certificate/u);
  });
});

describe("T12: the release flag for package-run servers", () => {
  const ENT = { edition: "enterprise" as const };
  const asked: Record<string, string> = { ...Object.fromEntries(Object.entries({
    [KEYS.certificateArn]: CERT, [KEYS.hostName]: "mcp-host.example.net", [KEYS.hostedZoneId]: "Z0123456789ABCDEFGHIJ", [KEYS.npmRegistry]: "https://registry.corp.example.net/npm/",
    [KEYS.runnerSubnetCidrs]: "10.42.160.0/22", [KEYS.registryCidrs]: "10.60.0.0/24", [KEYS.controllerTlsSecretArn]: TLS_SECRET, [KEYS.controllerDnsNamespace]: "mcp.rovara.internal", [KEYS.cidrs]: "10.60.0.0/16",
  })), [KEYS.stdio]: "true" };
  it("is OFF in this release: the flag, the host stack, the edition feature, and the synth kit's key list all say so", () => {
    expect(STDIO_MCP_RELEASED).toBe(false);
    expect(STDIO_MCP_HOST_STACK_BUILT).toBe(false);
    // the edition table says Enterprise MAY have them; the install switch (ROVARA_STDIO_MCP_SERVERS=1, set by the synth only past the flag) is what turns them on
    expect(featureEnabled(editionPolicy("enterprise"), "stdioMcpServers")).toBe(true);
    expect(featureEnabled(editionPolicy("public"), "stdioMcpServers")).toBe(false);
    expect(stdioAvailable({ edition: "enterprise" })).toBe(false);
    expect(stdioAvailable({ edition: "enterprise", stdioEnabled: false })).toBe(false);
    expect(stdioAvailable({ edition: "public", stdioEnabled: true })).toBe(false);
    expect(privateMcpBrokerEnvironment(parsePrivateMcpContext({ edition: "enterprise", get: context({ [KEYS.cidrs]: "10.60.0.0/16" }) }))).not.toHaveProperty("ROVARA_STDIO_MCP_SERVERS");
    // the synth kit (what `bundle approve` builds with) takes the key only past the flag
    expect((SYNTH_CONTEXT_KEYS as readonly string[]).includes(KEYS.stdio)).toBe(STDIO_MCP_RELEASED);
    expect(Object.keys(SYNTH_EXCLUDED_KEYS).includes(KEYS.stdio)).toBe(!STDIO_MCP_RELEASED);
  });
  it("still refuses a request for package-run servers while the flag is off, in every spelling of yes, with every other setting right", () => {
    for (const value of [true, "true", "1", 1]) {
      expect(() => parsePrivateMcpContext({ ...ENT, get: context({ ...asked, [KEYS.stdio]: value }) }), String(value)).toThrow(/switched off/u);
      expect(() => parsePrivateMcpContext({ ...ENT, stdioReleased: false, get: context({ ...asked, [KEYS.stdio]: value }) }), String(value)).toThrow(/switched off/u);
    }
    expect(() => buildAgentXApp({ ...ENTERPRISE, ...asked })).toThrow(/switched off/u);
  });
  it("past the flag, accepts the request with every setting, names the one that is missing, and still refuses outside Enterprise", () => {
    const install = parsePrivateMcpContext({ ...ENT, stdioReleased: true, get: context(asked) });
    expect(install.stdioRequested).toBe(true);
    for (const key of Object.keys(asked).filter((name) => name !== KEYS.stdio)) {
      const { [key]: _removed, ...rest } = asked; // eslint-disable-line @typescript-eslint/no-unused-vars -- the one setting left out
      expect(() => parsePrivateMcpContext({ ...ENT, stdioReleased: true, get: context(rest) }), key).toThrow(new RegExp(key, "u"));
    }
    expect(() => parsePrivateMcpContext({ edition: "public", stdioReleased: true, get: context(asked) })).toThrow(/Enterprise/u);
    expect(() => parsePrivateMcpContext({ edition: undefined, stdioReleased: true, get: context({ [KEYS.stdio]: "true" }) })).toThrow(/Enterprise/u);
    for (const off of [false, "false", 0, "0", ""]) expect(parsePrivateMcpContext({ ...ENT, stdioReleased: true, get: context({ ...asked, [KEYS.stdio]: off }) }).stdioRequested, String(off)).toBe(false);
    expect(parsePrivateMcpContext({ ...ENT, stdioReleased: true, get: context({}) }).stdioRequested).toBe(false);
    expect(() => parsePrivateMcpContext({ ...ENT, stdioReleased: true, get: context({ ...asked, [KEYS.stdio]: "maybe" }) })).toThrow(/true or false/u);
  });
  it("adds the two broker variables only for a released request, and the broker's environment check admits them only past the flag", () => {
    const released = parsePrivateMcpContext({ ...ENT, stdioReleased: true, get: context(asked) });
    expect(privateMcpBrokerEnvironment(released)).toEqual({ ROVARA_PRIVATE_MCP_CIDRS: "10.60.0.0/16", ROVARA_VPC_CIDRS: "10.42.0.0/16", ROVARA_STDIO_MCP_SERVERS: "1", MCP_HOST_URL: "https://mcp-host.example.net" });
    const notAsked = parsePrivateMcpContext({ ...ENT, stdioReleased: true, get: context({ ...asked, [KEYS.stdio]: "false" }) });
    expect(privateMcpBrokerEnvironment(notAsked)).not.toHaveProperty("ROVARA_STDIO_MCP_SERVERS");
    expect(privateMcpBrokerEnvironment(notAsked)).not.toHaveProperty("MCP_HOST_URL");
    expect([...STDIO_BROKER_ENVIRONMENT_KEYS]).toEqual(["ROVARA_STDIO_MCP_SERVERS", "MCP_HOST_URL"]);
    const environment = privateMcpBrokerEnvironment(released);
    expect(() => checkedBrokerEnvironment(environment)).toThrow(/not one an install setting may add/u);
    expect(() => checkedBrokerEnvironment(environment, false)).toThrow(/not one an install setting may add/u);
    expect(checkedBrokerEnvironment(environment, true)).toEqual(environment);
    // past the flag nothing else is admitted either
    for (const name of ["CALLBACK_SIGNING_KEY", "STATE_TABLE_NAME", "MCP_HOST_TOKEN", "ROVARA_EDITION"]) expect(() => checkedBrokerEnvironment({ [name]: "x" }, true), name).toThrow(/not one an install setting may add/u);
  });
  it("keeps the second lock in the app: the stack check runs right after the settings are read, before any stack is built", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("infra/lib/app.ts", "utf8");
    const parse = source.indexOf("const privateMcp = parsePrivateMcpContext(");
    const lock = source.indexOf("assertStdioHostStackBuilt(privateMcp);");
    expect(parse).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(parse);
    expect(lock).toBeLessThan(source.indexOf('new ControlPlaneStack(app, "AgentXControlPlane"'));
  });
  it("review M6: the app gives the foundation the host's DNS names only when package-run servers are requested, after the lock, and builds them from the install's own settings", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("infra/lib/app.ts", "utf8");
    const lock = source.indexOf("assertStdioHostStackBuilt(privateMcp);");
    const props = source.indexOf("const mcpHostProps = privateMcp.stdioRequested ? mcpHostPropsFromInstall(privateMcp) : undefined;");
    expect(props).toBeGreaterThan(lock);
    expect(props).toBeLessThan(source.indexOf('new ProductionFoundationStack(app, "AgentXProductionFoundation"'));
    expect(source).toContain("mcpHostProps === undefined ? {} : { stdioMcpAllowDomains: mcpHostAllowDomains({ controllerDnsNamespace: mcpHostProps.controllerDnsNamespace, npmRegistry: mcpHostProps.npmRegistry,");
  });
  it("past the flag, a build without the host's stack still stops synth, rather than point the broker at a host that does not exist", () => {
    const released = parsePrivateMcpContext({ ...ENT, stdioReleased: true, get: context(asked) });
    expect(() => assertStdioHostStackBuilt(released)).toThrow(/does not yet contain the MCP host's stack/u);
    expect(() => assertStdioHostStackBuilt(released, false)).toThrow(/turn-on checklist/u);
    expect(() => assertStdioHostStackBuilt(released, true)).not.toThrow();
    expect(() => assertStdioHostStackBuilt(parsePrivateMcpContext({ ...ENT, get: context({}) }))).not.toThrow();
  });
});

/** The app as `rovara deploy` builds it: the control plane's broker function is the one that holds the callback signing key. */
function brokerEnvironment(context: Record<string, unknown>): Record<string, unknown> {
  const app = buildAgentXApp(context);
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane")!;
  const functions = Object.entries(Template.fromStack(stack).findResources("AWS::Lambda::Function")) as Array<[string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }]>;
  // The broker by its logical id (0.5.15: no Lambda carries CALLBACK_SIGNING_KEY any more in a named environment).
  const broker = functions.find(([id]) => /^Broker[0-9A-F]{8}$/u.test(id));
  return broker?.[1].Properties.Environment?.Variables ?? {};
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
    expect([...BROKER_ENVIRONMENT_KEYS]).toEqual(["ROVARA_PRIVATE_MCP_CIDRS", "ROVARA_VPC_CIDRS", "ROVARA_CUSTOM_MODEL_ENDPOINTS", "ROVARA_MODEL_ENDPOINT_CIDRS"]);
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
