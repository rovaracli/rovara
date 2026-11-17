// B7's Cloud stack side: with -c rovaraModelGatewayProductAi=on (named test environments only) the server may write the gateway's
// product key table by company keys and seal keys (GenerateDataKey, GenerateMac), never Decrypt. Off, the Cloud web template is
// byte for byte what it was, for production and for staging.
import { createHash } from "node:crypto";
import { withoutRoleBoundary } from "../support/without-role-boundary.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Code } from "aws-cdk-lib/aws-lambda";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { BEDROCK_TEMPLATE_URL_PATTERN, CLOUD_BEDROCK_TEMPLATE_URL_ENV, CLOUD_PRODUCT_AI_ENV, CloudWebStack } from "../../infra/lib/cloud-web.js";
import { validTemplateUrl } from "../../packages/model-gateway/src/bedrock-byo.js";
import { MODEL_GATEWAY_PRODUCT_CONTEXT_KEY } from "../../infra/lib/model-gateway.js";

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown };
const built = (() => { const dir = mkdtempSync(join(tmpdir(), "cloud-web-app-")); mkdirSync(join(dir, "assets")); writeFileSync(join(dir, "index.html"), "<!doctype html>"); writeFileSync(join(dir, "assets", "index-abc.js"), "export {};"); return dir; })();
const synth = (environmentName: string, productAi?: boolean) => Template.fromStack(new CloudWebStack(new App(), "RovaraCloudWeb", {
  environmentName, env: { region: "us-east-1" }, appDirectory: built, code: Code.fromInline("export const handler = async () => ({});"), ...(productAi === undefined ? {} : { productAi }),
})).toJSON() as { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>; Parameters: Record<string, unknown>; Outputs: Record<string, unknown> };
/** The Cloud web templates at cloud/next d7d1edbb8, before this change (same stand-in app and code): SHA-256 of their JSON. */
// 2026-11-17 (role boundary): the one other change is the BucketDeployment function's own log group (AppFilesLogs, cloud-web.ts):
// with that line removed these were f01b90f0... (production) and bfcde946... (staging), the hashes from d7d1edbb8.
const BEFORE = { production: "db67fcbbc888b0f1d83f7fa6f6fd9796c1dd0f0ab90452a75121897886898dbf", staging: "2520e7cd7500cad24785df29bfcb000c1a1839f9fbf9d75574dbab9b44cbed85" };
// Less the role boundary (2026-11-17), which every template now carries (tests/contract/cloud-role-boundary.test.ts).
const sha = (value: Parameters<typeof withoutRoleBoundary>[0]) => createHash("sha256").update(JSON.stringify(withoutRoleBoundary(value))).digest("hex");
/**
 * DEC 253z removed exactly two things from the web template: the CompanyId parameter and the server's CLOUD_COMPANY_ID setting. Put back as
 * they were (same place, same words), the template must hash to BEFORE: so nothing else moved.
 */
function withOldCompanySetting(template: ReturnType<typeof synth>): ReturnType<typeof synth> {
  const parameters: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(template.Parameters)) {
    parameters[key] = value;
    if (key === "CodeUrl") parameters["CompanyId"] = { Type: "String", Default: "", AllowedPattern: "^(org_[0-9a-z]{20})?$", ConstraintDescription: "empty, or a company id: org_ and 20 lower-case letters or digits", Description: "The one company of a single-company Rovara Code, used only when Code's access check names none. Empty: such a Code gets no company routes." };
  }
  const resources: Record<string, unknown> = {};
  for (const [id, resource] of Object.entries(template.Resources)) {
    const variables = (resource.Properties.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables;
    if (resource.Type !== "AWS::Lambda::Function" || variables === undefined || !("COMPANY_TABLE" in variables)) { resources[id] = resource; continue; }
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(variables)) { next[key] = value; if (key === "COMPANY_TABLE") next["CLOUD_COMPANY_ID"] = { Ref: "CompanyId" }; }
    resources[id] = { ...resource, Properties: { ...resource.Properties, Environment: { ...(resource.Properties.Environment as object), Variables: next } } };
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(template)) out[key] = key === "Parameters" ? parameters : key === "Resources" ? resources : value;
  return out as ReturnType<typeof synth>;
}

describe("Cloud web: product AI settings grants (B7)", () => {
  it("off: production and staging templates are byte for byte what they were (less the company setting DEC 253z removed)", () => {
    expect(sha(withOldCompanySetting(synth("production")))).toBe(BEFORE.production);
    expect(sha(withOldCompanySetting(synth("staging")))).toBe(BEFORE.staging);
    expect(sha(withOldCompanySetting(synth("staging", false)))).toBe(BEFORE.staging);
    expect(Object.keys(synth("staging").Parameters)).not.toContain("CompanyId");
  });
  it("is refused for production, and by the app only when the switch is exactly on", () => {
    expect(() => synth("production", true)).toThrow(/named test environments/u);
    expect(() => buildAgentXApp({ rovaraCloudApp: "staging", [MODEL_GATEWAY_PRODUCT_CONTEXT_KEY]: "maybe" })).toThrow(/must be "on" or absent/u);
  });
  it("on (staging): exactly the table by company keys, GenerateDataKey for this install's sealed rows and GenerateMac; never Decrypt", () => {
    const t = synth("staging", true);
    const statements = Object.values(t.Resources).filter((r) => r.Type === "AWS::IAM::Policy").flatMap((r) => (r.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
    const bySid = Object.fromEntries(statements.filter((s) => s.Sid !== undefined).map((s) => [s.Sid!, s]));
    expect(bySid.ProductKeysCompanyKeys).toEqual({
      Sid: "ProductKeysCompanyKeys", Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"],
      Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":dynamodb:us-east-1:", { Ref: "AWS::AccountId" }, ":table/", { Ref: "ProductKeysTableName" }]] },
      Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CO#*"] }, Null: { "dynamodb:LeadingKeys": "false" } },
    });
    expect(bySid.SealProductKeys).toEqual({ Sid: "SealProductKeys", Effect: "Allow", Action: "kms:GenerateDataKey", Resource: { Ref: "ProductKeysKeyArn" }, Condition: { StringEquals: { "kms:EncryptionContext:purpose": "rovara-product-ai-key", "kms:EncryptionContext:install": { "Fn::Join": ["", [{ Ref: "CodeUrl" }, "/v1/auth"]] } } } });
    expect(bySid.FingerprintProductKeys).toEqual({ Sid: "FingerprintProductKeys", Effect: "Allow", Action: "kms:GenerateMac", Resource: { Ref: "ProductKeysMacKeyArn" } });
    const all = JSON.stringify(statements);
    expect(all).not.toMatch(/"kms:Decrypt"[^}]*ProductKeys|"kms:Encrypt"|"kms:ReEncrypt/u);
    for (const s of statements.filter((x) => JSON.stringify(x.Resource).includes("ProductKeys"))) expect(["ProductKeysCompanyKeys", "SealProductKeys", "FingerprintProductKeys"]).toContain(s.Sid);
    const fn = Object.values(t.Resources).find((r) => r.Type === "AWS::Lambda::Function" && JSON.stringify(r.Properties).includes("CLOUD_TABLE"))!;
    const env = (fn.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(env[CLOUD_PRODUCT_AI_ENV.keysTable]).toEqual({ Ref: "ProductKeysTableName" });
    expect(env[CLOUD_PRODUCT_AI_ENV.keysKey]).toEqual({ Ref: "ProductKeysKeyArn" });
    expect(env[CLOUD_PRODUCT_AI_ENV.macKey]).toEqual({ Ref: "ProductKeysMacKeyArn" });
    expect(Object.keys(t.Outputs)).toContain("ServerRoleArn");
    // PRODUCT-VERTEX-CLOUD-CONNECT: the gateway's address for its Vertex test (optional, empty by default: a pipeline deploy that
    // passes no new parameter still works), and no new grant (the call is signed with the GenerateMac above).
    expect(env[CLOUD_PRODUCT_AI_ENV.gatewayUrl]).toEqual({ Ref: "ModelGatewayUrl" });
    const gateway = t.Parameters.ModelGatewayUrl as { Default: string; AllowedPattern: string };
    expect(gateway.Default).toBe("");
    const pattern = new RegExp(gateway.AllowedPattern, "u");
    for (const good of ["", "https://gateway.staging.rovara.example"]) expect(pattern.test(good)).toBe(true);
    for (const bad of ["http://gateway.example", "https://gateway.example/v1", "https://a b"]) expect(pattern.test(bad)).toBe(false);
    expect(Object.keys(bySid).sort()).toEqual(expect.not.arrayContaining(["VerifyCloudCalls"]));
  });

  // BYO Bedrock (DEC 238): the role template's docs-site address, optional, passed to the server only when set.
  it("BedrockTemplateUrl: optional; the variable is set only when the parameter is non-empty; the pattern is validTemplateUrl's rule", () => {
    const t = synth("staging", true) as ReturnType<typeof synth> & { Conditions: Record<string, unknown>; Rules: Record<string, unknown> };
    const parameter = t.Parameters.BedrockTemplateUrl as { Default: string; AllowedPattern: string };
    expect(parameter.Default).toBe("");
    expect(parameter.AllowedPattern).toBe(BEDROCK_TEMPLATE_URL_PATTERN);
    expect(t.Conditions.BedrockTemplateUrlSet).toEqual({ "Fn::Not": [{ "Fn::Equals": [{ Ref: "BedrockTemplateUrl" }, ""] }] });
    const fn = Object.values(t.Resources).find((r) => r.Type === "AWS::Lambda::Function" && JSON.stringify(r.Properties).includes("CLOUD_TABLE"))!;
    const env = (fn.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    // Set: the address; empty: AWS::NoValue, so CloudFormation leaves the variable out (the routes answer 501).
    expect(env[CLOUD_BEDROCK_TEMPLATE_URL_ENV]).toEqual({ "Fn::If": ["BedrockTemplateUrlSet", { Ref: "BedrockTemplateUrl" }, { Ref: "AWS::NoValue" }] });
    expect(JSON.stringify(t.Rules)).toContain("BedrockTemplateUrl needs ModelGatewayUrl");
    // The pattern accepts and refuses what validTemplateUrl does (Java regex lookaheads and JS agree on this syntax).
    const pattern = new RegExp(BEDROCK_TEMPLATE_URL_PATTERN, "u");
    expect(pattern.test("")).toBe(true);
    const sha = "a".repeat(40);
    const urls = [
      `https://raw.githubusercontent.com/PrepLabsAI/Rovara/${sha}/docs/bedrock/rovara-bedrock-role.json`, "https://docs.rovara.example/bedrock/rovara-bedrock-role.json",
      "http://docs.rovara.example/t.json", "https://docs.rovara.example/t.yaml", "https://docs.rovara.example/t.json?x=1", "https://docs.rovara.example/", "https://docs.rovara.example",
      "https://my-bucket.s3.us-west-2.amazonaws.com/t.json", "https://s3.us-west-2.amazonaws.com/b/t.json", "https://s3-us-west-2.amazonaws.com/b/t.json", "https://s3.amazonaws.com/b/t.json",
      "https://x.cloudfront.net/t.yaml", "https://x.cloudfront.net/t.json", "https://x.amazonaws.com/t.json", "https://bucket.s3.example.com/t.json", "https://s3-bucket.example.com/t.json",
      "https://s3bucket.example.com/t.json", "https://docs.s3x.example.com/t.json", "https://a b/t.json", "ftp://docs/t.json", "https://docs.example.com/a b.json", "https://DOCS.example.com/t.json",
      "https://x..s3.example.com/t.json", "https://.s3.example.com/t.json", "https://a.b..s3-x.com/t.json",
    ];
    for (const url of urls) expect(pattern.test(url), url).toBe(validTemplateUrl(url));
    expect(pattern.test(urls[0]!)).toBe(true);
    expect(pattern.test(urls[7]!)).toBe(false);
  });
  it("BedrockTemplateUrl exists only with the product AI settings: the off templates stay byte for byte (see the first test)", () => {
    expect(synth("staging", false).Parameters.BedrockTemplateUrl).toBeUndefined();
    expect(synth("production").Parameters.BedrockTemplateUrl).toBeUndefined();
  });
});
