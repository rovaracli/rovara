// L3 + L5 against the REAL stacks: synthesizes web, app, gateway and the images stack with the contexts the pipeline itself passes (ops/pipeline/switches.json, both rows),
// so ops/pipeline/protected.json can never drift from the infra: every listed logical id exists with the listed type, every stateful resource is listed, the five image rows
// are exactly what they say, and the pipeline's own outputs (DeployedCloudSha, ServiceArn) appear only when the context names the commit. Needs `npm run build:web` first (like the
// other Cloud synth tests). No AWS.
import { readFileSync } from "node:fs";
import type { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { parseProtected } from "../../ops/pipeline/lib/protected.ts";
import { contextArgs } from "../../ops/pipeline/switches.ts";

type Resource = { Type: string };
type Doc = { Resources: Record<string, Resource>; Outputs?: Record<string, unknown> };
const list = parseProtected(readFileSync(new URL("../../ops/pipeline/protected.json", import.meta.url), "utf8"));
const account = { resolved: "123456789012", expected: "123456789012" };
const SHA = "a".repeat(40);

const web = (env: "beta" | "production", extra: Record<string, string> = {}): Record<string, Doc> => {
  const app = buildAgentXApp({ ...contextArgs(env, "web", undefined, account), ...extra });
  return { web: Template.fromStack(app.node.findChild("RovaraCloudWeb") as Stack).toJSON() as Doc, app: Template.fromStack(app.node.findChild("RovaraCloudApp") as Stack).toJSON() as Doc };
};
const gateway = (env: "beta" | "production", extra: Record<string, string> = {}): Record<string, Doc> => {
  const app = buildAgentXApp({ ...contextArgs(env, "gateway", undefined, account), ...extra });
  return { gateway: Template.fromStack(app.node.findChild("RovaraModelGateway") as Stack).toJSON() as Doc, gatewayImages: Template.fromStack(app.node.findChild("RovaraModelGatewayImages") as Stack).toJSON() as Doc };
};

// Both rows, plus a gateway with bring-your-own Bedrock on (its key and broker role exist only then).
const variants: Array<[string, Record<string, Doc>]> = [
  ["beta", { ...web("beta"), ...gateway("beta") }],
  ["production", { ...web("production"), ...gateway("production") }],
  ["beta with bring-your-own Bedrock", gateway("beta", { rovaraModelGatewayBedrockByo: "on" })],
];

describe("protected.json against the synthesized stacks", () => {
  it("every listed logical id exists with the listed type in at least one variant, and never with another type", () => {
    for (const [part, ids] of Object.entries(list.parts)) {
      for (const [id, type] of Object.entries(ids)) {
        const seen = variants.map(([, docs]) => docs[part]?.Resources[id]?.Type).filter((t): t is string => t !== undefined);
        expect(seen.length, `${part}/${id} is in no synthesized template`).toBeGreaterThan(0);
        expect(new Set(seen), `${part}/${id}`).toEqual(new Set([type]));
      }
    }
  });

  it("every resource of a stateful type is on the list (the type backstop is a safety net, not the plan)", () => {
    for (const [name, docs] of variants) {
      for (const [part, doc] of Object.entries(docs)) {
        for (const [id, resource] of Object.entries(doc.Resources)) {
          if (list.statefulTypes.includes(resource.Type)) expect(Object.hasOwn(list.parts[part] ?? {}, id), `${name}: ${part}/${id} (${resource.Type}) is stateful but not on the list`).toBe(true);
        }
      }
    }
  });

  it("the C9 additions are all there: what another stack holds as a hand-set parameter", () => {
    expect(Object.keys(list.parts.web!)).toContain("ServerServiceRole3DA1B1D6"); // gateway CloudSettingsRoleArn
    for (const id of ["ProductKeys518BAD1E", "ProductKeysKey3D2EA306", "ProductKeysMacKey82416FCB", "MeterFF56B2C9", "LoadBalancerHttps0C5C99D2", "VertexFederationRoleF5D9F2D9"]) expect(Object.keys(list.parts.gateway!), id).toContain(id);
    expect(Object.keys(list.parts.web!)).toEqual(expect.arrayContaining(["State1C20CC9A", "CompaniesAF68172A", "Assets9A31D427", "Distribution830FAC52", "SignInKey10D719B2"]));
    expect(Object.keys(list.parts.app!)).toEqual(["CodeClientSecretE7B5CF94"]);
    expect(Object.keys(list.parts.gatewayImages!)).toEqual(["Images2D38C313"]);
  });

  it("the five image rows each match exactly one gateway resource of the right type, and nothing else matches", () => {
    for (const [name, docs] of variants.filter(([, d]) => d.gateway !== undefined)) {
      const resources = Object.entries(docs.gateway!.Resources);
      for (const rule of list.imageRows) {
        const hits = resources.filter(([id, r]) => r.Type === rule.resourceType && new RegExp(rule.logicalIdPattern, "u").test(id));
        expect(hits, `${name}: ${rule.resourceType} ${rule.logicalIdPattern}`).toHaveLength(1);
      }
      const matched = resources.filter(([id, r]) => list.imageRows.some((rule) => rule.resourceType === r.Type && new RegExp(rule.logicalIdPattern, "u").test(id)));
      expect(matched).toHaveLength(list.imageRows.length);
    }
  });
});

describe("the pipeline's own outputs on the stacks (L5)", () => {
  it("absent without the context: a hand deploy and every pinned template are unchanged", () => {
    for (const docs of [web("beta"), gateway("beta")]) for (const doc of Object.values(docs)) {
      expect(Object.keys(doc.Outputs ?? {})).not.toContain("DeployedCloudSha");
      expect(Object.keys(doc.Outputs ?? {})).not.toContain("ServiceArn");
    }
  });

  it("DeployedCloudSha on web and gateway, ServiceArn on the gateway, with the context; the app and images stacks carry neither", () => {
    const w = web("beta", { rovaraCloudSha: SHA });
    const g = gateway("beta", { rovaraCloudSha: SHA });
    expect(w.web!.Outputs).toHaveProperty("DeployedCloudSha.Value", SHA);
    expect(g.gateway!.Outputs).toHaveProperty("DeployedCloudSha.Value", SHA);
    expect(Object.keys(g.gateway!.Outputs!)).toContain("ServiceArn");
    expect(Object.keys(w.app!.Outputs ?? {})).not.toContain("DeployedCloudSha");
    expect(Object.keys(g.gatewayImages!.Outputs ?? {})).not.toContain("DeployedCloudSha");
    // An output adds no resource row: the resources are the same with and without it.
    expect(Object.keys(w.web!.Resources)).toEqual(Object.keys(web("beta").web!.Resources));
    expect(Object.keys(g.gateway!.Resources)).toEqual(Object.keys(gateway("beta").gateway!.Resources));
  });

  it("refuses a context that is not a 40-hex sha", () => {
    for (const bad of ["main", "ABCDEF", "a".repeat(39), "g".repeat(40)]) expect(() => web("beta", { rovaraCloudSha: bad }), bad).toThrow(/40-character lowercase hex/);
  });
});
