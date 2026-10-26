import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const METHODS = new Set(["ANY", "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);

/**
 * Why a route key would be refused by an API Gateway HTTP API, or undefined when it is well formed. CloudFormation only finds out at
 * deploy time ("Part of the given route key path is empty", which rolled the 0.4.8 staging deploy back on `GET /app/`), so every route key is checked here at synth.
 * A key is `$default`, or `<METHOD> <path>`; the path starts with `/`, has no empty segment (no `//`, no trailing `/` except the bare root `/`),
 * and each segment is literal text, `{name}`, or a final greedy `{name+}`.
 */
function routeKeyProblem(key: unknown): string | undefined {
  if (typeof key !== "string") return "the route key is not a plain string";
  if (key === "$default") return undefined;
  const parts = key.split(" ");
  if (parts.length !== 2) return "expected exactly `METHOD /path` with one space";
  const [method, path] = parts as [string, string];
  if (!METHODS.has(method)) return `unknown method ${method}`;
  if (!path.startsWith("/")) return "the path must start with /";
  if (path === "/") return undefined;
  const segments = path.slice(1).split("/");
  for (const [index, segment] of segments.entries()) {
    if (segment === "") return "the path has an empty segment (a trailing slash or //)";
    if (/^\{[A-Za-z0-9_.:-]+\+\}$/.test(segment)) { if (index !== segments.length - 1) return "a greedy {name+} segment must be last"; continue; }
    if (/^\{[A-Za-z0-9_.:-]+\}$/.test(segment)) continue;
    if (!/^[A-Za-z0-9._~%!$&'()*+,;=:@-]+$/.test(segment)) return `the segment ${JSON.stringify(segment)} has characters API Gateway does not accept`;
  }
  return undefined;
}

describe("the route key checker", () => {
  it("accepts the shapes an HTTP API takes", () => {
    for (const key of ["$default", "GET /", "ANY /{proxy+}", "GET /app", "GET /app/{proxy+}", "GET /s/{sessionId}", "POST /v1/hooks/{source}/{hookId}"]) expect(routeKeyProblem(key), key).toBeUndefined();
  });
  it("refuses an empty segment and other invalid forms", () => {
    for (const key of ["GET /app/", "GET //app", "GET /a//b", "GET /app/{proxy+}/", "GET /{proxy+}/x", "GET app", "FETCH /app", "GET  /app", "/app", "GET /a b", "GET /{}", "GET /{x+", "", " GET /app"]) expect(routeKeyProblem(key), JSON.stringify(key)).toBeDefined();
  });
});

const contexts: Array<[string, Record<string, unknown>]> = [
  ["the legacy production deployment", {}],
  ["a named environment", { agentxEnv: "staging" }],
  ["a named cloud environment with CloudFront assets", { agentxEnv: "staging", agentxRegion: "us-west-2", agentxCloud: true, agentxWebAssetHosting: "cloudfront" }],
  ["a named cloud environment with cell assets", { agentxEnv: "staging", agentxRegion: "us-west-2", agentxCloud: true, agentxWebAssetHosting: "cell" }],
  ["a released (legacy synthesizer) named cloud environment", { agentxEnv: "staging", agentxRegion: "us-west-2", agentxCloud: true, agentxSynthesizer: "legacy" }],
  ["the optional installer and eval stacks", { agentxEnv: "staging", agentxInstaller: "enabled", agentxEval: "enabled" }],
];

describe("every ApiGatewayV2 route key in every stack", () => {
  for (const [name, context] of contexts) {
    it(`is valid in ${name}`, () => {
      const stacks = buildAgentXApp(context).node.children.filter((child): child is Stack => Stack.isStack(child));
      expect(stacks.length).toBeGreaterThan(0);
      const problems: string[] = [];
      let routes = 0;
      for (const stack of stacks) {
        const found = Template.fromStack(stack).findResources("AWS::ApiGatewayV2::Route");
        for (const [id, resource] of Object.entries(found)) {
          routes += 1;
          const problem = routeKeyProblem((resource.Properties as { RouteKey?: unknown }).RouteKey);
          if (problem !== undefined) problems.push(`${stack.stackName} ${id}: ${JSON.stringify((resource.Properties as { RouteKey?: unknown }).RouteKey)}: ${problem}`);
        }
      }
      expect(routes).toBeGreaterThan(0);
      expect(problems).toEqual([]);
    }, 300_000);
  }
});
