import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Code } from "aws-cdk-lib/aws-lambda";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { CloudAppStack } from "../../infra/lib/cloud-app.js";
import { CloudWebStack } from "../../infra/lib/cloud-web.js";
import { CLOUD_PIPELINE_CONTEXT_KEY } from "../../infra/lib/cloud-release-pipeline.js";
import { MODEL_GATEWAY_CONTEXT_KEY, MODEL_GATEWAY_PRODUCT_CONTEXT_KEY } from "../../infra/lib/model-gateway.js";

// EC2 refuses a security group or rule description with any other character ("Invalid rule description", 2026-11-16: an
// apostrophe stopped the staging gateway deploy). CloudFormation's template checks do not catch it; only the deploy does.
const EC2_DESCRIPTION = /^[a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]{0,255}$/;

type Resource = { Type: string; Properties?: Record<string, unknown> };
type Rule = { Description?: unknown };

// The web stack bundles its function and page shell at synth, so (as cloud-web.test.ts) these stand in for the built app.
const built = mkdtempSync(join(tmpdir(), "sg-descriptions-app-"));
mkdirSync(join(built, "assets"));
writeFileSync(join(built, "index.html"), "<!doctype html>");
writeFileSync(join(built, "assets", "index-abc.js"), "export {};");
const cloudApp = (productAi: boolean): App => {
  const app = new App();
  const web = new CloudWebStack(app, "RovaraCloudWeb", { environmentName: "staging", env: { region: "us-west-2" }, appDirectory: built, code: Code.fromInline("export const handler = async () => ({});"), ...(productAi ? { productAi } : {}) });
  new CloudAppStack(app, "RovaraCloudApp", { environmentName: "staging", env: { region: "us-west-2" }, movedTo: web.origin });
  return app;
};

// Every shape the stacks are made in: Cloud (plain and with Rovara's AI on), its pipeline, the gateway (plain, product AI, Bedrock BYO).
const APPS: Array<[string, () => App]> = ([
  ["web and app", () => cloudApp(false)],
  ["web and app, product AI on", () => cloudApp(true)],
] as Array<[string, () => App]>).concat((<Array<[string, Record<string, unknown>]>>[
  ["release pipeline", { [CLOUD_PIPELINE_CONTEXT_KEY]: "production", agentxRegion: "us-west-2" }],
  ["gateway and images", { [MODEL_GATEWAY_CONTEXT_KEY]: "staging", agentxRegion: "us-west-2" }],
  ["gateway, product AI on", { [MODEL_GATEWAY_CONTEXT_KEY]: "staging", agentxRegion: "us-west-2", [MODEL_GATEWAY_PRODUCT_CONTEXT_KEY]: "on" }],
  ["gateway, product AI on (with the Bedrock broker)", { [MODEL_GATEWAY_CONTEXT_KEY]: "staging", agentxRegion: "us-west-2", [MODEL_GATEWAY_PRODUCT_CONTEXT_KEY]: "on" }],
]).map(([name, context]): [string, () => App] => [name, () => buildAgentXApp(context)]));

/** Every EC2 security group description and rule description in one template, as [where, value]. */
function descriptionsIn(stackName: string, resources: Record<string, Resource>): Array<[string, unknown]> {
  const found: Array<[string, unknown]> = [];
  for (const [id, resource] of Object.entries(resources)) {
    const properties = resource.Properties ?? {};
    const where = `${stackName}/${id}`;
    if (resource.Type === "AWS::EC2::SecurityGroup") {
      found.push([`${where} GroupDescription`, properties.GroupDescription]);
      for (const key of ["SecurityGroupIngress", "SecurityGroupEgress"] as const) {
        ((properties[key] as Rule[] | undefined) ?? []).forEach((rule, index) => {
          if (rule.Description !== undefined) found.push([`${where} ${key}[${index}]`, rule.Description]);
        });
      }
    }
    if (resource.Type === "AWS::EC2::SecurityGroupIngress" || resource.Type === "AWS::EC2::SecurityGroupEgress") {
      if (properties.Description !== undefined) found.push([`${where} Description`, properties.Description]);
    }
  }
  return found;
}

/** The literal text of a value: a string as is; for an intrinsic (Fn::Join and the like), every string inside it. */
function literals(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(literals);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(literals);
  return [];
}

describe("EC2 security group descriptions use only the characters EC2 accepts", () => {
  it("matches EC2's own character set", () => {
    expect(EC2_DESCRIPTION.test("workers call the gateway over TLS")).toBe(true);
    expect(EC2_DESCRIPTION.test("providers, JWKS from Code, AWS APIs: a-z.A_Z-0/9 (#@[]+=&;{}!$*)")).toBe(true);
    for (const bad of ["Code's JWKS", 'say "hi"', "a — b", "a > b", "a | b", "100%", "café", "a".repeat(256)]) expect(EC2_DESCRIPTION.test(bad), bad).toBe(false);
  });

  for (const [name, makeApp] of APPS) {
    it(`${name}: every security group and rule description is valid`, () => {
      const app = makeApp();
      const stacks = app.node.children.filter((child): child is Stack => child instanceof Stack);
      expect(stacks.length).toBeGreaterThan(0);
      const checked: Array<[string, unknown]> = stacks.flatMap((stack) => descriptionsIn(stack.node.id, (Template.fromStack(stack).toJSON().Resources ?? {}) as Record<string, Resource>));
      for (const [where, value] of checked) {
        for (const text of literals(value)) expect(text, where).toMatch(EC2_DESCRIPTION);
      }
      // Group descriptions are required, so a stack with security groups proves the scan reached them.
      if (name.startsWith("gateway")) expect(checked.length).toBeGreaterThanOrEqual(8);
    });
  }
});
