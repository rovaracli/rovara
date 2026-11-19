// Owner 2026-11-19: Cloud on its own name (app.rovara.com), one name for every company. Two web stack parameters, empty by default:
// set together, CloudFront answers the name with the certificate, Cloud's address becomes it, and CloudFront's own name answers 307
// to it (the server takes writes from its one address only). The first-address stack's import of CloudFront's name is unchanged.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { App, Stack } from "aws-cdk-lib";
import { Code } from "aws-cdk-lib/aws-lambda";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import {
  CLOUD_CUSTOM_CERTIFICATE_PARAMETER,
  CLOUD_CUSTOM_DOMAIN_PARAMETER,
  CLOUD_CUSTOM_DOMAIN_PATTERN,
  CLOUD_CUSTOM_DOMAIN_REDIRECT_CODE,
  CloudWebStack,
} from "../../infra/lib/cloud-web.js";

const built = (() => { const dir = mkdtempSync(join(tmpdir(), "cloud-web-domain-")); mkdirSync(join(dir, "assets")); writeFileSync(join(dir, "index.html"), "<!doctype html>"); return dir; })();
type Json = { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>; Parameters: Record<string, Record<string, unknown>>; Conditions: Record<string, unknown>; Rules: Record<string, unknown>; Outputs: Record<string, { Value: unknown; Export?: { Name: unknown } }> };
const synth = (environmentName = "production"): Json => Template.fromStack(new CloudWebStack(new App(), "RovaraCloudWeb", {
  environmentName, env: { region: "us-east-1" }, appDirectory: built, code: Code.fromInline("export const handler = async () => ({});"),
})).toJSON() as Json;
const ofType = (t: Json, type: string) => Object.entries(t.Resources).filter(([, r]) => r.Type === type);

type Field = { value: string; multiValue?: Array<{ value: string }> };
type Request = { method: string; uri: string; querystring: Record<string, Field>; headers: Record<string, Field> };
/** The function as CloudFront runs it, with ${Target} filled in the way Fn::Sub fills it. */
const handlerFor = (target: string) => runInNewContext(`${CLOUD_CUSTOM_DOMAIN_REDIRECT_CODE.replace("${Target}", target)}\nhandler;`, {}) as (event: { request: Request }) => unknown;
const request = (host: string | undefined, uri = "/app", querystring: Record<string, Field> = {}, method = "GET"): Request => ({ method, uri, querystring, headers: host === undefined ? {} : { host: { value: host } } });

describe("Cloud web: its own name (CustomDomainName)", () => {
  const t = synth();

  it("has two parameters, empty by default, set together or not at all", () => {
    expect(t.Parameters[CLOUD_CUSTOM_DOMAIN_PARAMETER]).toMatchObject({ Type: "String", Default: "", AllowedPattern: CLOUD_CUSTOM_DOMAIN_PATTERN });
    expect(t.Parameters[CLOUD_CUSTOM_CERTIFICATE_PARAMETER]).toMatchObject({ Type: "String", Default: "" });
    expect(JSON.stringify(t.Rules.CustomDomainNeedsCertificate)).toContain("set together or both left empty");
    expect(t.Conditions.CustomDomainSet).toEqual({ "Fn::Not": [{ "Fn::Equals": [{ Ref: CLOUD_CUSTOM_DOMAIN_PARAMETER }, ""] }] });
  });

  it("takes a lower-case name and a us-east-1 certificate only", () => {
    const name = new RegExp(CLOUD_CUSTOM_DOMAIN_PATTERN, "u");
    for (const good of ["", "app.rovara.com", "a-b.c1.example.io"]) expect(name.test(good), good).toBe(true);
    for (const bad of ["https://app.rovara.com", "app.rovara.com/", "App.Rovara.com", "app", "app.rovara.com.", "-x.rovara.com", "app.rovara.com:443"]) expect(name.test(bad), bad).toBe(false);
    const certificate = new RegExp(String(t.Parameters[CLOUD_CUSTOM_CERTIFICATE_PARAMETER]!.AllowedPattern), "u");
    expect(certificate.test("arn:aws:acm:us-east-1:944937319445:certificate/27fb667c-e65f-4316-9503-39aeb395e01e")).toBe(true);
    expect(certificate.test("")).toBe(true);
    expect(certificate.test("arn:aws:acm:us-west-2:944937319445:certificate/27fb667c-e65f-4316-9503-39aeb395e01e")).toBe(false);
  });

  it("answers the name with the certificate when set, CloudFront's own certificate otherwise", () => {
    const [[, distribution]] = ofType(t, "AWS::CloudFront::Distribution") as unknown as [[string, { Properties: { DistributionConfig: Record<string, unknown> } }]];
    expect(distribution.Properties.DistributionConfig.Aliases).toEqual({ "Fn::If": ["CustomDomainSet", [{ Ref: CLOUD_CUSTOM_DOMAIN_PARAMETER }], { Ref: "AWS::NoValue" }] });
    expect(distribution.Properties.DistributionConfig.ViewerCertificate).toEqual({ "Fn::If": ["CustomDomainSet",
      { AcmCertificateArn: { Ref: CLOUD_CUSTOM_CERTIFICATE_PARAMETER }, SslSupportMethod: "sni-only", MinimumProtocolVersion: "TLSv1.2_2021" },
      { CloudFrontDefaultCertificate: true }] });
  });

  it("runs the redirect on every request, the server's and the app files'", () => {
    const [[functionId, fn]] = ofType(t, "AWS::CloudFront::Function") as unknown as [[string, { Properties: Record<string, unknown> }]];
    expect(fn.Properties.AutoPublish).toBe(true);
    expect((fn.Properties.FunctionConfig as { Runtime: string }).Runtime).toBe("cloudfront-js-2.0");
    expect(fn.Properties.FunctionCode).toEqual({ "Fn::Sub": [CLOUD_CUSTOM_DOMAIN_REDIRECT_CODE, { Target: { Ref: CLOUD_CUSTOM_DOMAIN_PARAMETER } }] });
    const [[, distribution]] = ofType(t, "AWS::CloudFront::Distribution") as unknown as [[string, { Properties: { DistributionConfig: { DefaultCacheBehavior: Record<string, unknown>; CacheBehaviors: Array<Record<string, unknown>> } } }]];
    const config = distribution.Properties.DistributionConfig;
    for (const behavior of [config.DefaultCacheBehavior, ...config.CacheBehaviors]) {
      expect(behavior.FunctionAssociations).toEqual([{ EventType: "viewer-request", FunctionARN: { "Fn::GetAtt": [functionId, "FunctionARN"] } }]);
    }
  });

  it("makes Cloud's address the name when set: the server's parameter and the sign-in outputs", () => {
    const chosen = { "Fn::If": ["CustomDomainSet", { "Fn::Join": ["", ["https://", { Ref: CLOUD_CUSTOM_DOMAIN_PARAMETER }]] }, expect.anything()] };
    const parameters = ofType(t, "AWS::SSM::Parameter");
    expect(parameters).toHaveLength(1);
    expect(parameters[0]![1].Properties.Value).toEqual(chosen);
    expect(t.Outputs.CloudUrl!.Value).toEqual({ "Fn::Join": ["", [chosen, "/app"]] });
    expect(t.Outputs.CallbackUrl!.Value).toEqual({ "Fn::Join": ["", [chosen, "/callback"]] });
    expect(JSON.stringify(t.Outputs.RegisterWithCode!.Value)).toContain(JSON.stringify({ Ref: CLOUD_CUSTOM_DOMAIN_PARAMETER }));
  });

  it("keeps the first-address stack's import: the web stack still exports CloudFront's own name, nothing else", () => {
    const app = buildAgentXApp({ rovaraCloudApp: "production", agentxRegion: "us-east-1" });
    const web = app.node.children.find((each) => each instanceof Stack && each.stackName === "rovara-cloud-production-web") as Stack;
    const outputs = (Template.fromStack(web).toJSON() as Json).Outputs;
    const exported = Object.values(outputs).filter((output) => output.Export !== undefined);
    expect(exported).toHaveLength(1);
    expect(exported[0]!.Value).toEqual({ "Fn::GetAtt": [expect.stringMatching(/^Distribution/u), "DomainName"] });
    // The name prod's first-address stack imports today (rovara-cloud-production-web exports, 2026-11-19).
    expect(exported[0]!.Export!.Name).toBe("rovara-cloud-production-web:ExportsOutputFnGetAttDistribution830FAC52DomainNameBEB09E30");
  });
});

describe("Cloud web: the redirect function", () => {
  it("has exactly one Fn::Sub variable, so nothing else in the code is substituted", () => {
    expect(CLOUD_CUSTOM_DOMAIN_REDIRECT_CODE.match(/\$\{/gu)).toHaveLength(1);
    expect(CLOUD_CUSTOM_DOMAIN_REDIRECT_CODE).toContain("${Target}");
  });

  it("lets every request through while there is no name", () => {
    const req = request("d5hwoqksa23xv.cloudfront.net", "/api/x", { a: { value: "1" } }, "POST");
    expect(handlerFor("")({ request: req })).toBe(req);
  });

  it("lets requests on the name through", () => {
    const req = request("app.rovara.com", "/app");
    expect(handlerFor("app.rovara.com")({ request: req })).toBe(req);
  });

  it("sends other names to the name with 307 (method kept, not cached), path and query kept", () => {
    const handler = handlerFor("app.rovara.com");
    expect(handler({ request: request("d5hwoqksa23xv.cloudfront.net", "/app") })).toEqual({
      statusCode: 307, statusDescription: "Temporary Redirect",
      headers: { location: { value: "https://app.rovara.com/app" }, "cache-control": { value: "no-store" } },
    });
    const many = { session: { value: "s%20one" }, tag: { value: "a", multiValue: [{ value: "a" }, { value: "b" }] }, empty: { value: "" } };
    expect(handler({ request: request("d5hwoqksa23xv.cloudfront.net", "/app/sessions/9", many, "POST") })).toMatchObject({
      statusCode: 307, headers: { location: { value: "https://app.rovara.com/app/sessions/9?session=s%20one&tag=a&tag=b&empty=" } },
    });
    expect(handler({ request: request(undefined, "/") })).toMatchObject({ statusCode: 307, headers: { location: { value: "https://app.rovara.com/" } } });
  });
});
