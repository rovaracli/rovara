// Live switches check 2026-11-18: Cloud's web server read ROVARA_ANSWERS_ENABLED (scripts/cloud-lambda.ts) but nothing in infra set it, so the Ask boxes said "not available" on every hosted Cloud.
// Every web stack, including production, sets it from AnswersEnabled ("1" by default, DEC 254zzz215; ANSWERS-ON-PROD).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Code } from "aws-cdk-lib/aws-lambda";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ANSWERS_ROUTES } from "../../packages/cloud-server/src/answers-routes.js";
import { ROUTES } from "../../packages/cloud-server/src/routes.js";
import { CLOUD_ANSWERS_ENABLED_DEFAULT, CLOUD_ANSWERS_ENABLED_ENV, CLOUD_ANSWERS_ENABLED_PARAMETER, CLOUD_ANSWERS_ENABLED_VALUES, CloudWebStack } from "../../infra/lib/cloud-web.js";

const built = (() => { const dir = mkdtempSync(join(tmpdir(), "cloud-web-answers-")); mkdirSync(join(dir, "assets")); writeFileSync(join(dir, "index.html"), "<!doctype html>"); return dir; })();
type Json = { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>; Parameters: Record<string, Record<string, unknown>> };
const synth = (environmentName: string, productAi?: boolean): Json => Template.fromStack(new CloudWebStack(new App(), "RovaraCloudWeb", {
  environmentName, env: { region: "us-east-1" }, appDirectory: built, code: Code.fromInline("export const handler = async () => ({});"), ...(productAi === undefined ? {} : { productAi }),
})).toJSON() as Json;
const serverVariables = (t: Json): Record<string, unknown> => {
  const servers = Object.values(t.Resources).filter((r) => r.Type === "AWS::Lambda::Function" && "COMPANY_TABLE" in ((r.Properties.Environment as { Variables?: object } | undefined)?.Variables ?? {}));
  expect(servers).toHaveLength(1);
  return (servers[0]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
};

describe("Cloud web: the Ask boxes' switch (ROVARA_ANSWERS_ENABLED)", () => {
  it.each([["staging", undefined], ["staging", true], ["test", undefined], ["production", undefined], ["production", true]] as const)("%s (productAi %s): the server gets it from the AnswersEnabled parameter, on by default, 1 or 0 only", (env, productAi) => {
    const t = synth(env, productAi);
    const { Description: description, ...parameter } = t.Parameters[CLOUD_ANSWERS_ENABLED_PARAMETER] ?? {};
    expect(parameter).toEqual({ Type: "String", Default: "1", AllowedValues: ["1", "0"] });
    expect(String(description)).toContain("Just answer");
    expect(serverVariables(t)[CLOUD_ANSWERS_ENABLED_ENV]).toEqual({ Ref: CLOUD_ANSWERS_ENABLED_PARAMETER });
  });

  it("production: the deployed server enables the registered answers route by default", () => {
    const t = synth("production");
    expect(t.Parameters.AnswersEnabled?.Default).toBe("1");
    expect(serverVariables(t).ROVARA_ANSWERS_ENABLED).toEqual({ Ref: "AnswersEnabled" });
    const matches = ROUTES.filter((route) => route.method === "POST" && route.path.test("/projects/demo/answers"));
    expect(matches).toHaveLength(1);
    expect(ANSWERS_ROUTES).toContain(matches[0]);
  });

  it("reaches the reader: the variable is the one scripts/cloud-lambda.ts reads, and the default is the one value it reads as on", () => {
    expect(CLOUD_ANSWERS_ENABLED_ENV).toBe("ROVARA_ANSWERS_ENABLED");
    const source = readFileSync(join(process.cwd(), "scripts/cloud-lambda.ts"), "utf8");
    const reads = [...source.matchAll(/process\.env\.ROVARA_ANSWERS_ENABLED === "([^"]*)" \? \{ answersEnabled: true \}/gu)].map((m) => m[1]);
    expect(reads).toEqual([CLOUD_ANSWERS_ENABLED_DEFAULT]);
    expect(CLOUD_ANSWERS_ENABLED_VALUES[0]).toBe(CLOUD_ANSWERS_ENABLED_DEFAULT);
    // "0" is the only other value, and the reader reads it as off.
    expect(CLOUD_ANSWERS_ENABLED_VALUES.filter((v) => v !== CLOUD_ANSWERS_ENABLED_DEFAULT)).toEqual(["0"]);
  });
});
