// 0.5.7: the optional custom domain in front of the hosted cloud's control plane. Off (both parameters empty) it adds no resource and changes no address; on, it adds
// a DNS-validated certificate, a domain name, a mapping and alias records, and every address people see moves to it while the API's own keeps working.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { evaluate, type CfnContext } from "../support/cfn-evaluate.js";
import { brokerSettingsIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Condition?: string; Properties: Record<string, unknown> };
type Json = { Parameters: Record<string, { Default?: string; AllowedPattern?: string }>; Conditions: Record<string, unknown>; Resources: Record<string, Resource>; Outputs: Record<string, { Value: unknown }>; Rules?: Record<string, unknown> };

const API = "https://abc123.execute-api.us-west-2.amazonaws.com";
const DOMAIN = "staging.rovara.dev";
const ZONE = "Z08286002FKUL2VBSO3MO";

function stack(name: string, context: Record<string, unknown>): Json {
  const app = buildAgentXApp({ agentxEnv: "staging", agentxRegion: "us-west-2", ...context });
  const found = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === `agentx-staging-${name}`);
  if (found === undefined) throw new Error(`no ${name} stack`);
  return Template.fromStack(found).toJSON() as Json;
}

/** The template with the API's attribute replaced by a literal address, so the evaluator (which has no GetAtt) can resolve it. */
function context(json: Json, parameters: Record<string, string>): CfnContext {
  return { parameters, conditions: json.Conditions };
}
const literal = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replaceAll(JSON.stringify({ "Fn::GetAtt": ["HttpApi", "ApiEndpoint"] }), JSON.stringify(API)));
const on = { CustomDomainName: DOMAIN, CustomDomainHostedZoneId: ZONE };
const off = { CustomDomainName: "", CustomDomainHostedZoneId: "" };
const resourcesOf = (json: Json, type: string) => Object.entries(json.Resources).filter(([, resource]) => resource.Type === type);
const functionNamed = (json: Json, prefix: string) => resourcesOf(json, "AWS::Lambda::Function").find(([id]) => id.startsWith(prefix))![1];
const variables = (json: Json, prefix: string) => (functionNamed(json, prefix).Properties.Environment as { Variables: Record<string, unknown> }).Variables;

let control: Json;
let plain: Json;
let access: Json;
let plainAccess: Json;
beforeAll(() => {
  control = stack("control-plane", { agentxCloud: true });
  plain = stack("control-plane", {});
  access = stack("access", { agentxCloud: true });
  plainAccess = stack("access", {});
}, 600_000);

describe("the custom domain's resources", () => {
  it("declares two parameters that default to empty, a condition that needs both, and a rule that refuses one without the other", () => {
    expect(control.Parameters.CustomDomainName?.Default).toBe("");
    expect(control.Parameters.CustomDomainHostedZoneId?.Default).toBe("");
    expect(new RegExp(control.Parameters.CustomDomainName!.AllowedPattern!).test(DOMAIN)).toBe(true);
    expect(new RegExp(control.Parameters.CustomDomainName!.AllowedPattern!).test("Staging.Rovara.dev")).toBe(false);
    expect(new RegExp(control.Parameters.CustomDomainHostedZoneId!.AllowedPattern!).test(ZONE)).toBe(true);
    expect(evaluate({ Condition: "CustomDomainEnabled" }, context(control, on))).toBe(true);
    expect(evaluate({ Condition: "CustomDomainEnabled" }, context(control, off))).toBe(false);
    expect(evaluate({ Condition: "CustomDomainEnabled" }, context(control, { CustomDomainName: DOMAIN, CustomDomainHostedZoneId: "" }))).toBe(false);
    expect(control.Rules).toHaveProperty("CustomDomainNeedsBothOrNeither");
  });

  it("creates a DNS-validated regional certificate, a domain name, one mapping to the default stage and alias A and AAAA records, all under the condition", () => {
    const certificate = resourcesOf(control, "AWS::CertificateManager::Certificate");
    const domainName = resourcesOf(control, "AWS::ApiGatewayV2::DomainName");
    const mapping = resourcesOf(control, "AWS::ApiGatewayV2::ApiMapping");
    const records = resourcesOf(control, "AWS::Route53::RecordSet");
    expect([certificate.length, domainName.length, mapping.length, records.length]).toEqual([1, 1, 1, 2]);
    for (const [, resource] of [...certificate, ...domainName, ...mapping, ...records]) expect(resource.Condition).toBe("CustomDomainEnabled");
    expect(certificate[0]![1].Properties).toMatchObject({ DomainName: { Ref: "CustomDomainName" }, ValidationMethod: "DNS", DomainValidationOptions: [{ DomainName: { Ref: "CustomDomainName" }, HostedZoneId: { Ref: "CustomDomainHostedZoneId" } }] });
    expect(domainName[0]![1].Properties).toMatchObject({ DomainName: { Ref: "CustomDomainName" }, DomainNameConfigurations: [{ CertificateArn: { Ref: certificate[0]![0] }, EndpointType: "REGIONAL", SecurityPolicy: "TLS_1_2" }] });
    expect(mapping[0]![1].Properties).toMatchObject({ DomainName: { Ref: domainName[0]![0] }, Stage: { Ref: "DefaultStage" } });
    expect(records.map(([, record]) => record.Properties.Type).sort()).toEqual(["A", "AAAA"]);
    for (const [, record] of records) {
      expect(record.Properties).toMatchObject({ HostedZoneId: { Ref: "CustomDomainHostedZoneId" }, Name: { Ref: "CustomDomainName" } });
      expect(record.Properties.AliasTarget).toEqual({ DNSName: { "Fn::GetAtt": [domainName[0]![0], "RegionalDomainName"] }, HostedZoneId: { "Fn::GetAtt": [domainName[0]![0], "RegionalHostedZoneId"] }, EvaluateTargetHealth: false });
    }
  });

  it("adds nothing to an environment that is not the hosted cloud: no parameter, condition, resource or output", () => {
    const text = JSON.stringify(plain);
    expect(text).not.toContain("CustomDomain");
    expect(text).not.toContain("DEVELOPER_CUSTOM_DOMAIN");
    expect(text).not.toContain("CANONICAL_ORIGIN");
    expect(Object.keys(plain.Outputs)).not.toContain("PublicUrl");
    expect(JSON.stringify(plainAccess)).not.toContain("CustomDomain");
  });
});

describe("what moves to the custom domain, and what stays on the API's own address", () => {
  it("puts the custom name in the broker's packed settings and the sign-in function's environment, and leaves DEVELOPER_TOKEN_ISSUER the API's own", () => {
    expect(brokerSettingsIn(variables(control, "Broker") as Parameters<typeof brokerSettingsIn>[0]).customDomain).toEqual({ Ref: "CustomDomainName" });
    const signIn = variables(control, "DeveloperSignInFunction");
    expect(signIn.DEVELOPER_CUSTOM_DOMAIN).toEqual({ Ref: "CustomDomainName" });
    expect(evaluate(literal(signIn.DEVELOPER_TOKEN_ISSUER), context(control, off))).toBe(`${API}/v1/auth`);
  });

  it("publishes PublicUrl as the custom origin when set and the API's own otherwise, and keeps ApiEndpoint the API's own", () => {
    const publicUrl = literal(control.Outputs.PublicUrl!.Value);
    expect(evaluate(publicUrl, context(control, on))).toBe(`https://${DOMAIN}`);
    expect(evaluate(publicUrl, context(control, off))).toBe(API);
    expect(control.Outputs.ApiEndpoint!.Value).toEqual({ "Fn::GetAtt": ["HttpApi", "ApiEndpoint"] });
    const issuer = literal(control.Outputs.DeveloperSignInIssuer!.Value);
    expect(evaluate(issuer, context(control, on))).toBe(`https://${DOMAIN}/v1/auth`);
    expect(evaluate(issuer, context(control, off))).toBe(`${API}/v1/auth`);
    // Machine addresses are not moved: the Slack and GitHub apps keep calling the API's own.
    for (const name of ["SlackEventsUrl", "GithubWebhookUrl", "SlackInteractivityUrl"]) expect(JSON.stringify(control.Outputs[name]!.Value)).toContain("ApiEndpoint");
  });

  it("registers the cloud callback on both addresses with the domain, and on the API's own alone without", () => {
    const [, client] = resourcesOf(control, "AWS::Cognito::UserPoolClient")[0]!;
    const callbacks = literal(client.Properties.CallbackURLs);
    expect(evaluate(callbacks, context(control, on))).toEqual([`https://${DOMAIN}/v1/auth/callback/cloud`, `${API}/v1/auth/callback/cloud`]);
    expect(evaluate(callbacks, context(control, off))).toEqual([`${API}/v1/auth/callback/cloud`]);
    const github = literal(control.Outputs.CloudIdentityGitHubCallbackUrl!.Value);
    expect(evaluate(github, context(control, on))).toBe(`https://${DOMAIN}/v1/auth/callback/github`);
    expect(evaluate(github, context(control, off))).toBe(`${API}/v1/auth/callback/github`);
  });

  it("allows both origins in the asset CDN's CORS list with the domain, and the API's own alone without", () => {
    const [, policy] = resourcesOf(control, "AWS::CloudFront::ResponseHeadersPolicy")[0]!;
    const origins = literal((policy.Properties.ResponseHeadersPolicyConfig as { CorsConfig: { AccessControlAllowOrigins: { Items: unknown } } }).CorsConfig.AccessControlAllowOrigins.Items);
    expect(evaluate(origins, context(control, on))).toEqual([`https://${DOMAIN}`, API]);
    expect(evaluate(origins, context(control, off))).toEqual([API]);
  });

  it("tells the web function which origin is canonical (empty without the domain), and links notices to it", () => {
    const web = variables(control, "WebAppFunction");
    const canonical = literal(web.CANONICAL_ORIGIN);
    expect(evaluate(canonical, context(control, on))).toBe(`https://${DOMAIN}`);
    expect(evaluate(canonical, context(control, off))).toBe("");
    const notifier = literal(variables(control, "DeveloperTaskNotifier").CONTROL_PLANE_URL);
    expect(evaluate(notifier, context(control, on))).toBe(`https://${DOMAIN}`);
    expect(evaluate(notifier, context(control, off))).toBe(API);
  });

  it("leaves the services' own control plane address on the API's own: they call it over the VPC endpoint and the egress walls", () => {
    for (const [id, resource] of resourcesOf(control, "AWS::Lambda::Function")) {
      const url = (resource.Properties.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables?.CONTROL_PLANE_URL;
      if (url === undefined || id.startsWith("DeveloperTaskNotifier")) continue;
      expect(JSON.stringify(url), id).toContain("ApiEndpoint");
      expect(JSON.stringify(url), id).not.toContain("CustomDomain");
    }
  });
});

describe("the deploy role's grants for the custom domain (access stack)", () => {
  const statements = (json: Json) => {
    const role = resourcesOf(json, "AWS::IAM::Role").find(([id]) => id === "CloudFormationServiceRole")![1];
    return (role.Properties.Policies as Array<{ PolicyDocument: { Statement: unknown[] } }>)[0]!.PolicyDocument.Statement;
  };
  /** The custom domain's statements as the role has them for these parameter values (an Fn::If that holds NoValue grants nothing). */
  const granted = (json: Json, parameters: Record<string, string>) => statements(json)
    .filter((statement) => JSON.stringify(statement).includes("CustomDomainEnabled"))
    .map((statement) => evaluate(literal(statement), { parameters, conditions: json.Conditions, pseudo: { "AWS::Partition": "aws", "AWS::Region": "us-west-2", "AWS::AccountId": "944937319445" } }))
    .filter((statement) => statement !== undefined) as Array<{ Sid: string; Action: string[]; Resource: unknown; Condition?: unknown }>;

  it("grants nothing for it by default, and nothing at all to an environment that is not the hosted cloud", () => {
    expect(granted(access, off)).toEqual([]);
    // Four statements exist in the template, each behind the condition: the cloud access stack carries them, and the plain one does not.
    expect(statements(access).filter((statement) => JSON.stringify(statement).includes("CustomDomainEnabled"))).toHaveLength(4);
    expect(JSON.stringify(statements(plainAccess))).not.toContain("acm:");
    expect(JSON.stringify(statements(plainAccess))).not.toContain("route53:");
  });

  it("grants certificate and record changes for that name and that one hosted zone only", () => {
    const all = granted(access, on);
    expect(all.map((statement) => statement.Sid)).toEqual(["CustomDomainCertificateRequest", "CustomDomainCertificates", "CustomDomainRecords", "CustomDomainChanges"]);
    const bySid = Object.fromEntries(all.map((statement) => [statement.Sid, statement]));
    expect(bySid.CustomDomainCertificateRequest).toMatchObject({ Action: ["acm:RequestCertificate"], Resource: "*", Condition: { StringEquals: { "aws:RequestedRegion": "us-west-2" }, "ForAllValues:StringEquals": { "acm:DomainNames": [DOMAIN] } } });
    expect(bySid.CustomDomainCertificates).toMatchObject({ Resource: "arn:aws:acm:us-west-2:944937319445:certificate/*" });
    expect(bySid.CustomDomainRecords).toMatchObject({ Action: ["route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets"], Resource: `arn:aws:route53:::hostedzone/${ZONE}` });
    expect(bySid.CustomDomainChanges).toMatchObject({ Action: ["route53:GetChange"], Resource: "arn:aws:route53:::change/*" });
    // Nothing wider: no wildcard action, no hosted-zone wildcard, and no zone or certificate action beyond these.
    const actions = all.flatMap((statement) => statement.Action);
    expect(actions.filter((action) => action.endsWith("*"))).toEqual([]);
    expect(actions.sort()).toEqual(["acm:AddTagsToCertificate", "acm:DeleteCertificate", "acm:DescribeCertificate", "acm:ListTagsForCertificate", "acm:RemoveTagsFromCertificate", "acm:RequestCertificate", "route53:ChangeResourceRecordSets", "route53:GetChange", "route53:ListResourceRecordSets"]);
  });
});
