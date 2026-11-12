// MODEL-PROXY-TLS (decision 110): the model proxy's internal load balancer serves HTTPS under the install's own name, every caller is given https://<name>, and no
// plain-http proxy address is left in any function, task, parameter or output (docs/architecture/model-proxy-tls.md).
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { BROKER_NAMES } from "@agentx/cloud-contracts";
import { modelProviderAddressProblem } from "@rovara-code/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { MODEL_PROXY_TLS_CONTEXT_KEYS, MODEL_PROXY_TLS_POLICY, modelProxyTlsDeployStatements, parseModelProxyTlsContext } from "../../infra/lib/model-proxy-tls.js";
import { enterpriseAllowDomains } from "../../infra/lib/vpc-endpoints.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const NAME = "model-proxy.staging.example.com";
const ZONE = "Z0123456789ABCDEFGHIJ";
const REGION = "us-west-2";
const BROUGHT = `arn:aws:acm:${REGION}:123456789012:certificate/11111111-2222-3333-4444-555555555555`;
const BASE = { agentxEnv: "staging", agentxCloud: "true", agentxRegion: REGION };

type Resource = { Type: string; Properties: Record<string, unknown>; DependsOn?: string[] };
type Json = { Resources: Record<string, Resource>; Outputs?: Record<string, { Value: unknown }> };

function stacks(context: Record<string, unknown>): Record<string, Json> {
  const app = buildAgentXApp(context);
  const out: Record<string, Json> = {};
  for (const child of app.node.children) if (Stack.isStack(child)) out[child.node.id] = Template.fromStack(child).toJSON() as Json;
  return out;
}
const ofType = (json: Json, type: string) => Object.entries(json.Resources).filter(([, resource]) => resource.Type === type);
/** The model proxy's own resources of a type (the hosted cloud's optional custom domain has a certificate and records of its own). */
const proxyOfType = (json: Json, type: string) => ofType(json, type).filter(([id]) => id.startsWith("ModelProxy"));
const listeners = (json: Json) => ofType(json, "AWS::ElasticLoadBalancingV2::Listener").map(([id, resource]): Record<string, unknown> & { id: string } => ({ id, ...resource.Properties }));
/** Every string literal in a template, intrinsic or not. */
const strings = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : value !== null && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
const ingressPorts = (json: Json, type: string) => ofType(json, type).map(([id, resource]) => [id, resource.Properties.FromPort] as const);
/** The broker's AGENTX_NAMES text (it is an Fn::Join of literal and generated parts). */
const brokerNames = (json: Json) => {
  const broker = ofType(json, "AWS::Lambda::Function").find(([id]) => id.startsWith("Broker") && JSON.stringify(json.Resources[id]!.Properties).includes("AGENTX_NAMES"));
  return JSON.stringify((broker![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables.AGENTX_NAMES);
};

describe("the TLS settings (CDK context)", () => {
  const parse = (values: Record<string, unknown>) => parseModelProxyTlsContext({ get: (key) => values[key], env: "staging", region: REGION });
  const K = MODEL_PROXY_TLS_CONTEXT_KEYS;

  it("unset is today's plain-http proxy; a zone or certificate without the name is refused", () => {
    expect(parse({})).toBeUndefined();
    expect(() => parse({ [K.zoneId]: ZONE })).toThrow(K.name);
    expect(() => parse({ [K.legacyHttp]: "keep" })).toThrow(K.name);
  });

  it("takes a name with exactly one certificate source", () => {
    expect(parse({ [K.name]: NAME, [K.zoneId]: ZONE })).toEqual({ name: NAME, zoneId: ZONE, legacyHttp: false });
    expect(parse({ [K.name]: NAME, [K.certificateArn]: BROUGHT, [K.legacyHttp]: "keep" })).toEqual({ name: NAME, certificateArn: BROUGHT, legacyHttp: true });
    expect(() => parse({ [K.name]: NAME })).toThrow("exactly one");
    expect(() => parse({ [K.name]: NAME, [K.zoneId]: ZONE, [K.certificateArn]: BROUGHT })).toThrow("exactly one");
  });

  it("refuses names that are not the install's own, bad zones, certificates from another region and unknown switch values", () => {
    for (const bad of ["Model-Proxy.example.com", "*.example.com", "proxy", "internal-x.us-west-2.elb.amazonaws.com", "10.0.0.1", `${"a".repeat(60)}.example.com`]) {
      expect(() => parse({ [K.name]: bad, [K.zoneId]: ZONE }), bad).toThrow(K.name);
    }
    expect(() => parse({ [K.name]: NAME, [K.zoneId]: "not-a-zone" })).toThrow(K.zoneId);
    expect(() => parse({ [K.name]: NAME, [K.certificateArn]: BROUGHT.replace(REGION, "eu-west-1") })).toThrow("install's region");
    expect(() => parse({ [K.name]: NAME, [K.zoneId]: ZONE, [K.legacyHttp]: "yes" })).toThrow(K.legacyHttp);
    expect(() => parseModelProxyTlsContext({ get: (key) => ({ [K.name]: NAME, [K.zoneId]: ZONE } as Record<string, unknown>)[key], env: undefined, region: REGION })).toThrow("named environment");
  });
});

describe("with TLS (a certificate made in the install's public zone, no legacy listeners)", () => {
  let all: Record<string, Json>;
  let controlPlane: Json;
  beforeAll(() => {
    all = stacks({ ...BASE, [MODEL_PROXY_TLS_CONTEXT_KEYS.name]: NAME, [MODEL_PROXY_TLS_CONTEXT_KEYS.zoneId]: ZONE });
    controlPlane = all.AgentXControlPlane!;
  }, 400_000);

  it("serves inference on 443 and management on 8443 over HTTPS with a TLS 1.2+ policy, and has no plain-http listener", () => {
    const found = listeners(controlPlane);
    expect(found.map((listener) => [listener.id.replace(/[0-9A-F]{8}$/u, ""), listener.Protocol, listener.Port]).sort()).toEqual([
      ["ModelProxyTlsListener", "HTTPS", 443], ["ModelProxyTlsManagementListener", "HTTPS", 8443],
    ]);
    for (const listener of found) {
      expect(listener.SslPolicy).toBe(MODEL_PROXY_TLS_POLICY);
      expect(MODEL_PROXY_TLS_POLICY).toMatch(/^ELBSecurityPolicy-TLS13-1-2-/u);
      const certificate = proxyOfType(controlPlane, "AWS::CertificateManager::Certificate")[0]![0];
      expect(listener.Certificates).toEqual([{ CertificateArn: { Ref: certificate } }]);
    }
    // R48 still holds on the HTTPS inference listener: a 403 by default, POST to the inference paths only.
    const inference = found.find((listener) => listener.Port === 443)!;
    expect(JSON.stringify(inference.DefaultActions)).toContain("403");
    const rules = ofType(controlPlane, "AWS::ElasticLoadBalancingV2::ListenerRule");
    expect(rules).toHaveLength(1);
    expect(rules[0]![1].Properties.ListenerArn).toEqual({ Ref: inference.id });
  });

  it("makes a public ACM certificate for the name, validated by DNS in the given zone and tagged with the environment", () => {
    const certificates = proxyOfType(controlPlane, "AWS::CertificateManager::Certificate");
    expect(certificates).toHaveLength(1);
    expect(certificates[0]![1].Properties).toMatchObject({
      DomainName: NAME, ValidationMethod: "DNS", DomainValidationOptions: [{ DomainName: NAME, HostedZoneId: ZONE }],
    });
    expect(certificates[0]![1].Properties.Tags).toContainEqual({ Key: "agentx:env", Value: "staging" });
  });

  it("resolves the name only inside the VPC: a private zone of exactly that name with an alias A record to the load balancer", () => {
    const zones = proxyOfType(controlPlane, "AWS::Route53::HostedZone");
    expect(zones).toHaveLength(1);
    expect(zones[0]![1].Properties).toMatchObject({ Name: NAME, VPCs: [{ VPCId: { Ref: "VpcId" }, VPCRegion: { Ref: "AWS::Region" } }] });
    const records = proxyOfType(controlPlane, "AWS::Route53::RecordSet");
    expect(records).toHaveLength(1);
    expect(records[0]![1].Properties).toMatchObject({ Name: NAME, Type: "A", HostedZoneId: { "Fn::GetAtt": [zones[0]![0], "Id"] } });
    expect(JSON.stringify(records[0]![1].Properties.AliasTarget)).toContain("CanonicalHostedZoneID");
  });

  it("gives every caller https://<name>: workers (SSM), the broker (AGENTX_NAMES mh), the model access function and the Slack orchestrator (the output)", () => {
    const parameter = ofType(controlPlane, "AWS::SSM::Parameter").find(([id]) => id.startsWith("ModelProxyUrlParameter"))!;
    expect(parameter[1].Properties.Value).toBe(`https://${NAME}`);
    expect(brokerNames(controlPlane)).toContain(`${BROKER_NAMES.modelProxyHost.code}=${NAME}`);
    expect(brokerNames(controlPlane)).not.toContain(`${BROKER_NAMES.modelProxy.code}=`);
    const access = ofType(controlPlane, "AWS::Lambda::Function").find(([id]) => id.startsWith("ModelAccessFunction"))!;
    expect((access[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables.MODEL_PROXY_URL).toBe(`https://${NAME}:8443`);
    expect(controlPlane.Outputs!.ModelProxyUrl!.Value).toBe(`https://${NAME}`);
  });

  it("leaves no plain-http model proxy address anywhere in any stack", () => {
    for (const [id, json] of Object.entries(all)) {
      const plain = strings(json).filter((text) => /^http:\/\//u.test(text) && (text.includes("elb") || text.includes(NAME) || /:400[01]\b/u.test(text)));
      expect(plain, id).toEqual([]);
      // The LB's DNS name is never joined after "http://" either.
      expect(JSON.stringify(json), id).not.toMatch(/"http:\/\/",\s*\{\s*"Fn::GetAtt":\s*\["ModelProxyLoadBalancer/u);
    }
  });

  it("does not hand out the https URL before the listeners and the name exist", () => {
    const tlsIds = ofType(controlPlane, "AWS::ElasticLoadBalancingV2::Listener").map(([id]) => id);
    const record = proxyOfType(controlPlane, "AWS::Route53::RecordSet")[0]![0];
    const parameter = ofType(controlPlane, "AWS::SSM::Parameter").find(([id]) => id.startsWith("ModelProxyUrlParameter"))![1];
    const access = ofType(controlPlane, "AWS::Lambda::Function").find(([id]) => id.startsWith("ModelAccessFunction"))![1];
    for (const resource of [parameter, access]) expect(resource.DependsOn).toEqual(expect.arrayContaining([...tlsIds, record]));
  });

  it("opens 443 (clients) and 8443 (model access) on the load balancer and closes 4000 and 4001", () => {
    const ports = ingressPorts(controlPlane, "AWS::EC2::SecurityGroupIngress").filter(([id]) => /^ModelProxyClientIngress|^ModelAccessProxyIngress/u.test(id)).map(([, port]) => port).sort();
    expect(ports).toEqual([443, 8443]);
    const slack = ingressPorts(all.AgentXSlackOrchestrator!, "AWS::EC2::SecurityGroupIngress").map(([, port]) => port);
    expect(slack).toEqual([443]);
    // Unchanged descriptions: a changed one would replace the load balancer's and the model access function's groups on upgrade.
    const groups = ofType(controlPlane, "AWS::EC2::SecurityGroup").map(([, resource]) => resource.Properties.GroupDescription as string);
    expect(groups.some((text) => text.startsWith("AgentX model proxy load balancer: port 4000 (inference)"))).toBe(true);
  });

  it("lets the name through the DNS firewall", () => {
    const lists = ofType(all.AgentXProductionFoundation!, "AWS::Route53Resolver::FirewallDomainList").map(([, resource]) => resource.Properties.Domains as string[] | undefined);
    expect(lists.some((domains) => domains?.includes(NAME))).toBe(true);
  });

  it("gives the deploy role a managed policy of its own for the certificate, the private zone and the records", () => {
    const access = all.AgentXAccess!;
    const policies = ofType(access, "AWS::IAM::ManagedPolicy").filter(([id]) => id.startsWith("ModelProxyTlsDeployPolicy"));
    expect(policies).toHaveLength(1);
    expect(policies[0]![1].Properties.Roles).toEqual([{ Ref: "CloudFormationServiceRole" }]);
    const text = JSON.stringify(policies[0]![1].Properties.PolicyDocument);
    expect(text).toContain("acm:RequestCertificate");
    expect(text).toContain(`hostedzone/${ZONE}`);
    expect(text.replace(/\s/gu, "").length).toBeLessThan(6_144);
  });
});

describe("with TLS and a brought certificate, keeping the legacy listeners for one release", () => {
  let all: Record<string, Json>;
  beforeAll(() => {
    all = stacks({ ...BASE, [MODEL_PROXY_TLS_CONTEXT_KEYS.name]: NAME, [MODEL_PROXY_TLS_CONTEXT_KEYS.certificateArn]: BROUGHT, [MODEL_PROXY_TLS_CONTEXT_KEYS.legacyHttp]: "keep" });
  }, 400_000);

  it("runs the HTTPS listeners beside the old plain-http ones, which keep their logical ids, and makes no certificate", () => {
    const controlPlane = all.AgentXControlPlane!;
    const found = listeners(controlPlane);
    expect(found.map((listener) => [listener.Protocol, listener.Port]).sort()).toEqual([["HTTP", 4000], ["HTTP", 4001], ["HTTPS", 443], ["HTTPS", 8443]]);
    expect(found.filter((listener) => listener.Protocol === "HTTP").map((listener) => listener.id.replace(/[0-9A-F]{8}$/u, "")).sort()).toEqual(["ModelProxyListener", "ModelProxyManagementListener"]);
    for (const listener of found.filter((each) => each.Protocol === "HTTPS")) expect(listener.Certificates).toEqual([{ CertificateArn: BROUGHT }]);
    expect(proxyOfType(controlPlane, "AWS::CertificateManager::Certificate")).toHaveLength(0);
    // New callers still get https only.
    expect(controlPlane.Outputs!.ModelProxyUrl!.Value).toBe(`https://${NAME}`);
    const ports = ingressPorts(controlPlane, "AWS::EC2::SecurityGroupIngress").filter(([id]) => /^ModelProxyClientIngress|^ModelAccessProxyIngress/u.test(id)).map(([, port]) => port).sort((a, b) => Number(a) - Number(b));
    expect(ports).toEqual([443, 4000, 4001, 8443]);
    expect(ingressPorts(all.AgentXSlackOrchestrator!, "AWS::EC2::SecurityGroupIngress").map(([, port]) => port).sort()).toEqual([4000, 443].sort());
  });

  it("grants the deploy role only DescribeCertificate on the brought certificate, no certificate request", () => {
    const statements = modelProxyTlsDeployStatements({ env: "staging", partition: "aws", region: REGION, account: "123456789012" }, { name: NAME, certificateArn: BROUGHT, legacyHttp: true });
    const actions = statements.flatMap((statement) => statement.Action);
    expect(actions).not.toContain("acm:RequestCertificate");
    expect(statements.find((statement) => statement.Sid === "ModelProxyTlsBroughtCertificate")).toMatchObject({ Action: ["acm:DescribeCertificate"], Resource: BROUGHT });
  });
});

describe("the broker builds https://<name> from mh", () => {
  it("builds the https URL and refuses a bare label", () => {
    const env: MutableEnvironment = { AWS_REGION: REGION, AGENTX_ACCOUNT_ID: "123456789012", AGENTX_ENV: "staging", AGENTX_NAMES: `mh=${NAME}` };
    hydrateBrokerEnvironment(env);
    expect(env.MODEL_PROXY_URL).toBe(`https://${NAME}`);
    expect(() => hydrateBrokerEnvironment({ AWS_REGION: REGION, AGENTX_ACCOUNT_ID: "123456789012", AGENTX_ENV: "staging", AGENTX_NAMES: "mh=proxy" })).toThrow("not a DNS name");
  });
});

describe("the A3 rule: Code's model provider address check (no private-address exception)", () => {
  it("accepts the TLS proxy address and refuses the old plain-http one", () => {
    expect(modelProviderAddressProblem(`https://${NAME}`)).toBeUndefined();
    expect(modelProviderAddressProblem(`https://${NAME}/v1`)).toBeUndefined();
    expect(modelProviderAddressProblem("http://internal-agentx-Model-AbCd-123.us-west-2.elb.amazonaws.com:4000")).toMatch(/https/u);
    expect(modelProviderAddressProblem(`http://${NAME}`)).toMatch(/https/u);
    expect(modelProviderAddressProblem("http://10.42.1.20:4000")).toMatch(/https/u);
  });
});

describe("ENTERPRISE-ELB-RDS-ALLOW-BUG", () => {
  it("allows internal ALB and Aurora names in the region, not the NLB-only pattern", () => {
    const domains = enterpriseAllowDomains(REGION);
    expect(domains).toContain(`*.${REGION}.elb.amazonaws.com`);
    expect(domains).toContain(`*.${REGION}.rds.amazonaws.com`);
    expect(domains).not.toContain(`*.elb.${REGION}.amazonaws.com`);
    // The model proxy's real name shape matches the allowed pattern.
    const matches = (pattern: string, host: string) => host.endsWith(pattern.slice(1));
    expect(domains.some((pattern) => pattern.startsWith("*.") && matches(pattern, `internal-agentx-Model-EvVrXUBwCcbN-1617407204.${REGION}.elb.amazonaws.com`))).toBe(true);
    expect(domains.some((pattern) => pattern.startsWith("*.") && matches(pattern, `agentx-db.cluster-abcdefghijkl.${REGION}.rds.amazonaws.com`))).toBe(true);
  });
});
