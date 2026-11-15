// B7's Cloud stack side: with -c rovaraModelGatewayProductAi=on (named test environments only) the server may write the gateway's
// product key table by company keys and seal keys (GenerateDataKey, GenerateMac), never Decrypt. Off, the Cloud web template is
// byte for byte what it was, for production and for staging.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Code } from "aws-cdk-lib/aws-lambda";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { CLOUD_PRODUCT_AI_ENV, CloudWebStack } from "../../infra/lib/cloud-web.js";
import { MODEL_GATEWAY_PRODUCT_CONTEXT_KEY } from "../../infra/lib/model-gateway.js";

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown };
const built = (() => { const dir = mkdtempSync(join(tmpdir(), "cloud-web-app-")); mkdirSync(join(dir, "assets")); writeFileSync(join(dir, "index.html"), "<!doctype html>"); writeFileSync(join(dir, "assets", "index-abc.js"), "export {};"); return dir; })();
const synth = (environmentName: string, productAi?: boolean) => Template.fromStack(new CloudWebStack(new App(), "RovaraCloudWeb", {
  environmentName, env: { region: "us-east-1" }, appDirectory: built, code: Code.fromInline("export const handler = async () => ({});"), ...(productAi === undefined ? {} : { productAi }),
})).toJSON() as { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>; Parameters: Record<string, unknown>; Outputs: Record<string, unknown> };
/** The Cloud web templates at cloud/next d7d1edbb8, before this change (same stand-in app and code): SHA-256 of their JSON. */
const BEFORE = { production: "f01b90f030e1bb81390cc84d2c0625cc48dae5f5ea57e474fc3093690eb85cc8", staging: "bfcde9467235f2f910ad3eef8fd68b5d7eca7a6d843b4f1b228d466688967737" };
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("Cloud web: product AI settings grants (B7)", () => {
  it("off: production and staging templates are byte for byte what they were", () => {
    expect(sha(synth("production"))).toBe(BEFORE.production);
    expect(sha(synth("staging"))).toBe(BEFORE.staging);
    expect(sha(synth("staging", false))).toBe(BEFORE.staging);
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
});
