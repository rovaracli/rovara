// 0.5.7: the optional custom domain in front of the hosted cloud's control plane. Off (both parameters empty) it adds no resource and changes no address; on, it adds
// a DNS-validated certificate, a domain name, a mapping and alias records, and every address people see moves to it while the API's own keeps working.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { evaluate, type CfnContext } from "../support/cfn-evaluate.js";
import { brokerSettingsIn } from "../support/broker-names-template.js";
import { customDomainDeployOrder } from "../../packages/cli/src/deploy/deploy-environment.js";
import { serviceRoleWithSids } from "../support/deployed-service-role.js";
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
    return serviceRoleWithSids((role.Properties.Policies as Array<{ PolicyDocument: { Statement: Array<Record<string, unknown>> } }>)[0]!.PolicyDocument.Statement);
  };
  /** The custom domain's statements as the role has them for these parameter values: since 0.5.18, the managed policy CustomDomainDeployPolicy, which exists only under CustomDomainEnabled. */
  const granted = (json: Json, parameters: Record<string, string>) => {
    const policy = json.Resources.CustomDomainDeployPolicy;
    if (policy === undefined || !(evaluate({ Condition: policy.Condition }, { parameters, conditions: json.Conditions }) as boolean)) return [];
    return (evaluate(literal((policy.Properties.PolicyDocument as { Statement: unknown }).Statement), { parameters, conditions: json.Conditions, pseudo: { "AWS::Partition": "aws", "AWS::Region": "us-west-2", "AWS::AccountId": "944937319445" } }) as unknown[])
      .filter((statement) => statement !== undefined) as Array<{ Sid: string; Action: string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> }>;
  };

  it("grants nothing for it by default, and nothing at all to an environment that is not the hosted cloud", () => {
    expect(granted(access, off)).toEqual([]);
    // 0.5.18: the six statements (seven before 0.5.17 merged GetChange into the zone list) are the managed policy CustomDomainDeployPolicy, behind the condition and attached to the deploy role alone;
    // the role's inline policy has none of them. The cloud access stack carries the policy, and the plain one does not.
    const policy = access.Resources.CustomDomainDeployPolicy!;
    expect(policy.Condition).toBe("CustomDomainEnabled");
    expect(policy.Properties.Roles).toEqual([{ Ref: "CloudFormationServiceRole" }]);
    expect((policy.Properties.PolicyDocument as { Statement: unknown[] }).Statement).toHaveLength(6);
    expect(JSON.stringify(statements(access))).not.toMatch(/"(acm|route53):|CustomDomain/u);
    expect(plainAccess.Resources.CustomDomainDeployPolicy).toBeUndefined();
    expect(JSON.stringify(statements(plainAccess))).not.toContain("acm:");
    expect(JSON.stringify(statements(plainAccess))).not.toContain("route53:");
  });

  it("takes the same both-or-neither rule as the control plane", () => {
    expect(access.Rules).toHaveProperty("CustomDomainNeedsBothOrNeither");
    expect(access.Parameters.CustomDomainName?.Default).toBe("");
    expect(access.Parameters.CustomDomainHostedZoneId?.Default).toBe("");
  });

  it("grants certificate and record changes for that name and that one hosted zone only, never the apex", () => {
    const all = granted(access, on);
    expect(all.map((statement) => statement.Sid)).toEqual(["CustomDomainCertificateRequest", "CustomDomainCertificateTag", "CustomDomainCertificates", "CustomDomainRecords", "CustomDomainZoneReads", "CustomDomainZoneList"]);
    const bySid = Object.fromEntries(all.map((statement) => [statement.Sid, statement]));
    // The certificate: this region, this one name (and it must name one), tagged as this environment's.
    expect(bySid.CustomDomainCertificateRequest).toMatchObject({ Action: ["acm:RequestCertificate"], Resource: "*", Condition: {
      StringEquals: { "aws:RequestedRegion": "us-west-2", "aws:RequestTag/agentx:env": "staging" }, "ForAllValues:StringEquals": { "acm:DomainNames": [DOMAIN] }, Null: { "acm:DomainNames": "false" } } });
    // Tagging needs the tag on the request AND on the certificate, so the role cannot tag a certificate that is not its own and then delete it.
    expect(bySid.CustomDomainCertificateTag).toMatchObject({ Action: ["acm:AddTagsToCertificate"], Condition: { StringEquals: { "aws:RequestTag/agentx:env": "staging", "aws:ResourceTag/agentx:env": "staging" } } });
    for (const sid of ["CustomDomainCertificateTag", "CustomDomainCertificates"]) expect(JSON.stringify(bySid[sid]!.Condition), sid).toContain("aws:ResourceTag/agentx:env");
    expect(bySid.CustomDomainCertificates).toMatchObject({ Resource: "arn:aws:acm:us-west-2:944937319445:certificate/*", Condition: { StringEquals: { "aws:ResourceTag/agentx:env": "staging" } } });
    expect([bySid.CustomDomainCertificates!.Action].flat().sort()).toEqual(["acm:DeleteCertificate", "acm:DescribeCertificate", "acm:ListTagsForCertificate", "acm:RemoveTagsFromCertificate"]);
    // The records: the domain's own name and its `_<hash>.<domain>` validation name, A, AAAA and CNAME, in that one zone. The apex is not among the names.
    expect(bySid.CustomDomainRecords).toMatchObject({ Action: ["route53:ChangeResourceRecordSets"], Resource: `arn:aws:route53:::hostedzone/${ZONE}`, Condition: {
      "ForAllValues:StringLike": { "route53:ChangeResourceRecordSetsNormalizedRecordNames": [DOMAIN, `_*.${DOMAIN}`] },
      "ForAllValues:StringEquals": { "route53:ChangeResourceRecordSetsRecordTypes": ["A", "AAAA", "CNAME"] },
      Null: { "route53:ChangeResourceRecordSetsNormalizedRecordNames": "false", "route53:ChangeResourceRecordSetsRecordTypes": "false" } } });
    const names = bySid.CustomDomainRecords!.Condition!["ForAllValues:StringLike"]!["route53:ChangeResourceRecordSetsNormalizedRecordNames"] as string[];
    const matches = (pattern: string, name: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(name);
    for (const allowed of [DOMAIN, `_0a1b2c.${DOMAIN}`]) expect(names.some((pattern) => matches(pattern, allowed)), allowed).toBe(true);
    for (const refused of ["rovara.dev", "www.rovara.dev", `x.${DOMAIN}`, "evil-staging.rovara.dev", "_0a1b2c.rovara.dev"]) expect(names.some((pattern) => matches(pattern, refused)), refused).toBe(false);
    // The reads CloudFormation's record handler makes, and the one action that takes no resource.
    expect(bySid.CustomDomainZoneReads).toMatchObject({ Action: ["route53:GetHostedZone", "route53:ListResourceRecordSets"], Resource: `arn:aws:route53:::hostedzone/${ZONE}` });
    // 0.5.17: GetChange shares ListHostedZones's "*" (its only resource type is change, so it reaches exactly the changes change/* did), for room in the inline policy.
    expect(bySid.CustomDomainZoneList).toMatchObject({ Action: ["route53:ListHostedZones", "route53:GetChange"], Resource: "*" });
    // 0.5.17 review L-2: never an exportable certificate.
    expect(bySid.CustomDomainCertificateRequest!.Condition).toMatchObject({ StringEqualsIfExists: { "acm:Export": "DISABLED" } });
    const actions = all.flatMap((statement) => statement.Action);
    expect(actions.filter((action) => action.endsWith("*"))).toEqual([]);
    expect(actions.sort()).toEqual(["acm:AddTagsToCertificate", "acm:DeleteCertificate", "acm:DescribeCertificate", "acm:ListTagsForCertificate", "acm:RemoveTagsFromCertificate", "acm:RequestCertificate",
      "route53:ChangeResourceRecordSets", "route53:GetChange", "route53:GetHostedZone", "route53:ListHostedZones", "route53:ListResourceRecordSets"]);
  });

  it("tags the certificate as this environment's, the tag the grants are limited to", () => {
    const [, certificate] = resourcesOf(control, "AWS::CertificateManager::Certificate")[0]!;
    expect(certificate.Properties.Tags).toEqual([{ Key: "agentx:env", Value: "staging" }]);
  });
});

describe("adding, removing and re-adding the domain never leaves a resource without the grants to change it", () => {
  const POSITIONS = { on: { name: DOMAIN, zone: ZONE }, off: { name: "", zone: "" } } as const;
  type Place = keyof typeof POSITIONS;
  /** How many custom-domain statements the deploy role holds with these parameters: CustomDomainDeployPolicy's, when it exists (0.5.18). */
  const accessGrants = (place: Place) => {
    const policy = access.Resources.CustomDomainDeployPolicy!;
    const parameters = { CustomDomainName: POSITIONS[place].name, CustomDomainHostedZoneId: POSITIONS[place].zone };
    return evaluate({ Condition: policy.Condition }, { parameters, conditions: access.Conditions }) ? (policy.Properties.PolicyDocument as { Statement: unknown[] }).Statement.length : 0;
  };
  /** The custom domain's resources the control plane has with these parameters (conditions evaluated on the template's own definition). */
  const controlResources = (place: Place) => Object.entries(control.Resources).filter(([, resource]) => resource.Condition === "CustomDomainEnabled"
    && evaluate({ Condition: "CustomDomainEnabled" }, context(control, { CustomDomainName: POSITIONS[place].name, CustomDomainHostedZoneId: POSITIONS[place].zone }))).length;

  /** Deploys the stacks in `order`, from `from` to `to`; returns every control plane deploy that touched domain resources while the role had no grants. */
  function run(order: string[], from: Place, to: Place): string[] {
    const state = { access: from, "control-plane": from };
    const unprotected: string[] = [];
    for (const part of order) {
      if (part !== "access" && part !== "control-plane") continue;
      if (part === "control-plane" && (controlResources(state["control-plane"]) > 0 || controlResources(to) > 0) && accessGrants(state.access) === 0) unprotected.push(`control-plane ${state["control-plane"]} -> ${to} with access ${state.access}`);
      state[part] = to;
    }
    return unprotected;
  }

  it("has the resources and the grants together exactly when the domain is set", () => {
    expect([controlResources("on"), controlResources("off")]).toEqual([5, 0]);
    expect([accessGrants("on"), accessGrants("off")]).toEqual([6, 0]);
  });

  it("adding: access first, so the grants exist before the control plane creates the certificate and records", () => {
    expect(run(customDomainDeployOrder(["access", "control-plane"], { deployed: "", wanted: DOMAIN }), "off", "on")).toEqual([]);
  });

  it("removing: the control plane first, so the grants are still there when it deletes the certificate and records; access last", () => {
    const order = customDomainDeployOrder(["access", "control-plane"], { deployed: DOMAIN, wanted: undefined });
    expect(order).toEqual(["control-plane", "access"]);
    expect(run(order, "on", "off")).toEqual([]);
  });

  it("the usual order on removal would have orphaned them (the bug this order fixes)", () => {
    expect(run(["access", "control-plane"], "on", "off")).toEqual(["control-plane on -> off with access off"]);
  });

  it("removal followed by re-adding works, and so does a second removal", () => {
    for (const [from, to, deployed, wanted] of [["off", "on", "", DOMAIN], ["on", "off", DOMAIN, undefined], ["off", "on", "", DOMAIN], ["on", "off", DOMAIN, undefined]] as const) {
      expect(run(customDomainDeployOrder(["access", "control-plane"], { deployed, wanted }), from, to), `${from} -> ${to}`).toEqual([]);
    }
  });

  it("refuses to remove the domain in the same run as a version change, and removes it at the same version", () => {
    expect(() => customDomainDeployOrder(["access", "control-plane"], { deployed: DOMAIN, wanted: undefined, versionChange: true })).toThrow(/remove it at the version the environment runs now/);
    expect(customDomainDeployOrder(["access", "control-plane"], { deployed: DOMAIN, wanted: undefined, versionChange: false })).toEqual(["control-plane", "access"]);
    // Adding or keeping it may come with a version change: the usual order.
    expect(customDomainDeployOrder(["access", "control-plane"], { deployed: "", wanted: DOMAIN, versionChange: true })).toEqual(["access", "control-plane"]);
    expect(customDomainDeployOrder(["access", "control-plane"], { deployed: DOMAIN, wanted: DOMAIN, versionChange: true })).toEqual(["access", "control-plane"]);
  });

  it("refuses to change the domain to another name in one step, and keeps the usual order when nothing changes", () => {
    expect(() => customDomainDeployOrder(["access", "control-plane"], { deployed: DOMAIN, wanted: "other.rovara.dev" })).toThrow(/two steps/);
    expect(customDomainDeployOrder(["access", "control-plane"], { deployed: DOMAIN, wanted: DOMAIN })).toEqual(["access", "control-plane"]);
    expect(customDomainDeployOrder(["access", "control-plane"], { deployed: "", wanted: undefined })).toEqual(["access", "control-plane"]);
    expect(customDomainDeployOrder(["access", "control-plane"], { deployed: undefined, wanted: undefined })).toEqual(["access", "control-plane"]);
  });
});
