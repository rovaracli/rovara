// DEC 254zzz3(1): the one operator list of exempt (pilot) companies, `-c rovaraModelGatewayRovaraAiExempt`, reaches the gateway (GATEWAY_ROVARA_AI_EXEMPT: what a call does) and
// Cloud's server (CLOUD_ROVARA_AI_EXEMPT: what the settings screen says). No IAM, secret or parameter is added; absent, Cloud's template is what it was; production refuses it.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Code } from "aws-cdk-lib/aws-lambda";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { rovaraAiExemptContext } from "../../infra/lib/app.js";
import { CLOUD_ROVARA_AI_EXEMPT_ENV, CloudWebStack } from "../../infra/lib/cloud-web.js";
import { MODEL_GATEWAY_ENV, MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY } from "../../infra/lib/model-gateway.js";
import { GATEWAY_ENV } from "../../packages/model-gateway/src/deploy.js";

const A = `org_${"a".repeat(20)}`; const B = `org_${"b".repeat(20)}`;
const dir = (() => { const d = mkdtempSync(join(tmpdir(), "rovara-exempt-app-")); mkdirSync(join(d, "assets")); writeFileSync(join(d, "index.html"), "<!doctype html>"); writeFileSync(join(d, "assets", "index-abc.js"), "export {};"); return d; })();
type Resource = { Type: string; Properties: Record<string, unknown> };
const serverEnv = (context: unknown, env = "staging") => {
  const stack = new CloudWebStack(new App(), "RovaraCloudWeb", { environmentName: env, env: { region: "us-east-1" }, appDirectory: dir, code: Code.fromInline("export const handler = async () => ({});"), ...rovaraAiExemptContext(context) });
  const t = Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> };
  const server = Object.entries(t.Resources).find(([id, r]) => r.Type === "AWS::Lambda::Function" && id.startsWith("Server"))![1];
  return { vars: (server.Properties.Environment as { Variables: Record<string, unknown> }).Variables, template: JSON.stringify(t) };
};

describe(`-c ${MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY} on Cloud's server`, () => {
  it("absent or empty: no variable and the same template; set: the ids, in the variable the server reads, named like the gateway's", () => {
    const none = serverEnv(undefined);
    expect(none.vars[CLOUD_ROVARA_AI_EXEMPT_ENV]).toBeUndefined();
    expect(serverEnv("").template).toBe(none.template);
    expect(CLOUD_ROVARA_AI_EXEMPT_ENV).toBe("CLOUD_ROVARA_AI_EXEMPT");
    expect(MODEL_GATEWAY_ENV.rovaraAiExempt).toBe(GATEWAY_ENV.rovaraAiExempt);
    expect(serverEnv(`${A},${B}`).vars[CLOUD_ROVARA_AI_EXEMPT_ENV]).toBe(`${A},${B}`);
  });
  it("adds only that variable: no IAM statement, no secret, no parameter", () => {
    const none = serverEnv(undefined); const some = serverEnv(A);
    expect(some.template.split("AWS::IAM::Policy").length).toBe(none.template.split("AWS::IAM::Policy").length);
    expect(some.template.split("AWS::SecretsManager").length).toBe(none.template.split("AWS::SecretsManager").length);
    expect(some.template.split('"Parameters"').length).toBe(none.template.split('"Parameters"').length);
  });
  it("refuses a malformed list, a list that is too long or repeats, and production", () => {
    for (const bad of ["everyone", `${A},`, `${A},${A}`, "org_short", 1, Array.from({ length: 11 }, (_, i) => `org_${String(i).padStart(20, "a")}`).join(",")]) expect(() => rovaraAiExemptContext(bad)).toThrow(MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY);
    expect(() => serverEnv(A, "production")).toThrow("named test environments");
  });
});
