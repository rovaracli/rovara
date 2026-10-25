// The worker's callbacks reach the broker through API Gateway. `POST /v1/internal/{proxy+}` covers every POST callback, but any other method falls to
// `ANY /{proxy+}`, which wants a user's JWT: the gateway answers {"message":"Unauthorized"} (HTTP 401) before the broker sees the call. So every
// non-POST route the broker serves under /v1/internal needs a route of its own, with no authorizer: the broker authenticates it itself with the
// operation's callback capability (verifyCapability, an `x-agentx-callback-capability` header it signed). Found on staging 0.4.5: GET /v1/internal/agent-tools
// (and GET /v1/internal/agent-skills) had none, so no agent or chain step with tools could run. This test reads the broker's own route table, so a new
// internal GET cannot be added without its gateway route.
import { readFileSync } from "node:fs";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Route = { Type: string; Properties: { RouteKey: string; AuthorizationType?: string; AuthorizerId?: unknown } };

/** Internal routes the broker matches with a pattern rather than a literal path: the gateway route that stands for each (path parameters named as the gateway names them). */
const PATTERN_ROUTES: Record<string, string> = {
  setupArtifact: "GET /v1/internal/project-setups/{setupExecutionId}/execution",
};

/** Every `GET|PUT|PATCH|DELETE|HEAD` route under /v1/internal that packages/broker/src/aws/broker.ts dispatches, as the gateway route key that must exist for it. */
function brokerInternalRouteKeys(): { keys: string[]; unmapped: string[] } {
  const source = readFileSync(new URL("../../packages/broker/src/aws/broker.ts", import.meta.url), "utf8");
  const patternNames = [...source.matchAll(/const (\w+) = \/\^\\\/v1\\\/internal/gu)].map((match) => match[1]!);
  const keys = new Set<string>();
  const unmapped = new Set<string>();
  for (const line of source.split("\n")) {
    const method = /request\.method === "(GET|PUT|PATCH|DELETE|HEAD)"/u.exec(line)?.[1];
    if (method === undefined) continue;
    const literal = /url\.pathname === "(\/v1\/internal\/[^"]+)"/u.exec(line)?.[1];
    if (literal !== undefined) { keys.add(`${method} ${literal}`); continue; }
    for (const name of patternNames) {
      if (!new RegExp(`\\b${name}\\b`, "u").test(line)) continue;
      const route = PATTERN_ROUTES[name];
      if (route === undefined) unmapped.add(`${name}: ${line.trim()}`);
      else keys.add(route);
    }
  }
  return { keys: [...keys].sort(), unmapped: [...unmapped] };
}

describe("every non-POST internal route of the broker has an API Gateway route (named environment)", () => {
  let routes: Route[];

  beforeAll(() => {
    const app = buildAgentXApp({ agentxEnv: "staging" });
    const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane");
    const resources = Template.fromStack(stack!).toJSON().Resources as Record<string, Route>;
    routes = Object.values(resources).filter((resource) => resource.Type === "AWS::ApiGatewayV2::Route");
  }, 240_000);

  it("reads the broker's route table (so this check cannot pass by finding nothing)", () => {
    const { keys, unmapped } = brokerInternalRouteKeys();
    expect(unmapped, "a pattern route with no gateway route named in PATTERN_ROUTES").toEqual([]);
    expect(keys).toEqual(expect.arrayContaining([
      "GET /v1/internal/agent-skills",
      "GET /v1/internal/agent-tools",
      "GET /v1/internal/model-access",
      "GET /v1/internal/project-setups/{setupExecutionId}/execution",
    ]));
  });

  it("has a route with no authorizer for each one, which the broker authenticates with the operation's callback capability", () => {
    for (const key of brokerInternalRouteKeys().keys) {
      const found = routes.filter((route) => route.Properties.RouteKey === key);
      expect(found, `${key} has no API Gateway route: the gateway would answer 401 before the broker is reached`).toHaveLength(1);
      expect(found[0]!.Properties.AuthorizationType, key).toBe("NONE");
      expect(found[0]!.Properties.AuthorizerId, key).toBeUndefined();
    }
  });

  it("keeps the POST callbacks on the one proxy route and does not open any other method under /v1/internal", () => {
    const internal = routes.map((route) => route.Properties.RouteKey).filter((key) => key.includes("/v1/internal/"));
    expect(internal).toContain("POST /v1/internal/{proxy+}");
    const allowed = new Set([...brokerInternalRouteKeys().keys, "POST /v1/internal/{proxy+}"]);
    expect(internal.filter((key) => !allowed.has(key)), "a gateway route under /v1/internal that the broker does not serve").toEqual([]);
  });
});
