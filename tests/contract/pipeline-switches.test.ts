// Lane L0 of BETA-CLOUD-PLAN (3.2): the gateway and web stacks' hand-set cdk contexts live in ops/pipeline/switches.json, one separate row per
// environment (beta, production). Nothing deploys from the file yet (lanes L1/L2 will). This test holds that every row carries every key the
// stacks read (app.ts contexts, cloud-release-pipeline.ts CLOUD_PIPELINE_SWITCHES), that the names the loader repeats equal the infra
// constants, that production's source kinds pass the PRODUCTION_SOURCE_KINDS rule, and that the rows, fed to the real stacks, make what
// the live beta templates carry (GATEWAY_AI_SOURCE_KINDS openai, GATEWAY_OFFERED_PRICES on, Rovara AI on, no disabled list, no exempt list).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, type Stack } from "aws-cdk-lib";
import { Code } from "aws-cdk-lib/aws-lambda";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import * as app from "../../infra/lib/app.js";
import * as cloudApp from "../../infra/lib/cloud-app.js";
import { CLOUD_AI_SOURCE_KINDS_ENV, CloudWebStack } from "../../infra/lib/cloud-web.js";
import * as pipeline from "../../infra/lib/cloud-release-pipeline.js";
import * as releaseActions from "../../infra/lib/cloud-release-actions.js";
import * as gateway from "../../infra/lib/model-gateway.js";
import { PRODUCTION_SOURCE_KINDS as CONTRACT_PRODUCTION_SOURCE_KINDS, productionSourceKindsAllowed } from "../../packages/contracts/src/model-sources.js";
import {
  CONTEXT_KEYS, DEFAULT_SWITCHES_PATH, DEPLOY_ACCOUNT_ENV, DEPLOY_ACCOUNT_PLACEHOLDER, deployAccountSourceFromEnv, resolveDeployAccount, GATEWAY_ROW_CONTEXT, OPTIONAL_NULL_KEYS, PENDING_ALLOWED_KEYS, PRODUCTION_SOURCE_KINDS, ROW_KEYS, SWITCHES_ENVIRONMENTS, WEB_ROW_CONTEXT,
  codeUrlFor, contextArgs, loadSwitches, parseSwitches, rowFor, type SwitchesFile,
} from "../../ops/pipeline/switches.js";

/** The repo's fake account (never a real one: the file is committed to a public copy). */
const FAKE = "123456789012";
const OTHER = "210987654321";
const SIGNED_IN = { resolved: FAKE, expected: FAKE };
const raw = readFileSync(DEFAULT_SWITCHES_PATH, "utf8");
const file = loadSwitches();
/** The file with every pending value filled by a placeholder, so each row can be fed to the real stacks. */
const filled: SwitchesFile = (() => {
  const copy = JSON.parse(raw) as SwitchesFile;
  for (const name of SWITCHES_ENVIRONMENTS) { copy.environments[name].codeUrl ??= "https://placeholder.execute-api.us-east-1.amazonaws.com"; copy.environments[name].pending = []; }
  return copy;
})();
const mutate = (change: (value: { environments: Record<string, Record<string, unknown>> }) => void): string => {
  const copy = JSON.parse(raw) as { environments: Record<string, Record<string, unknown>> };
  change(copy);
  return JSON.stringify(copy);
};
type Resource = { Type: string; Properties: Record<string, unknown> };
const serveEnv = (env: string) => {
  const context = contextArgs(env, "gateway", filled);
  const stack = app.buildAgentXApp(context).node.findChild("RovaraModelGateway") as Stack;
  const t = Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> };
  const task = Object.entries(t.Resources).find(([id, r]) => r.Type === "AWS::ECS::TaskDefinition" && id.startsWith("ServeTask"))![1];
  const container = (task.Properties.ContainerDefinitions as Array<{ Environment: Array<{ Name: string; Value: unknown }> }>)[0]!;
  return { vars: Object.fromEntries(container.Environment.map((e) => [e.Name, e.Value])), template: JSON.stringify(t) };
};

// The web stack as app.ts makes it from the web context (the built web app is not needed: a stub app directory and inline code, as the other web contract tests use).
const appDirectory = (() => { const d = mkdtempSync(join(tmpdir(), "rovara-switches-web-")); mkdirSync(join(d, "assets")); writeFileSync(join(d, "index.html"), "<!doctype html>"); writeFileSync(join(d, "assets", "index-abc.js"), "export {};"); return d; })();
const webServerEnv = (env: string) => {
  const context = contextArgs(env, "web", filled, SIGNED_IN);
  const productOn = app.productAiOn(context[CONTEXT_KEYS.productAi], CONTEXT_KEYS.productAi);
  const stack = new CloudWebStack(new App(), "RovaraCloudWeb", {
    environmentName: env, env: { region: context[CONTEXT_KEYS.region]!, ...(context[CONTEXT_KEYS.deployAccount] === undefined ? {} : { account: context[CONTEXT_KEYS.deployAccount]! }) },
    appDirectory, code: Code.fromInline("export const handler = async () => ({});"),
    ...(productOn ? { productAi: true } : {}), ...app.aiSourceKindsContext(context[CONTEXT_KEYS.aiSourceKinds]), ...app.rovaraAiExemptContext(context[CONTEXT_KEYS.rovaraAiExempt]),
  });
  const t = Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> };
  const server = Object.entries(t.Resources).find(([id, r]) => r.Type === "AWS::Lambda::Function" && id.startsWith("Server"))![1];
  return { stack, vars: (server.Properties.Environment as { Variables: Record<string, unknown> }).Variables };
};

describe("ops/pipeline/switches.json: separate beta and production rows", () => {
  it("has exactly a beta row and a production row, each with every key", () => {
    expect(Object.keys(file.environments).sort()).toEqual(["beta", "production"]);
    for (const name of SWITCHES_ENVIRONMENTS) {
      const row = file.environments[name] as unknown as Record<string, unknown>;
      expect(Object.keys(row).sort(), name).toEqual([...ROW_KEYS].sort());
      for (const key of ROW_KEYS) if (row[key] === null) expect([...OPTIONAL_NULL_KEYS, ...PENDING_ALLOWED_KEYS], `${name}.${key}`).toContain(key);
    }
    expect(file.environments.beta).not.toBe(file.environments.production);
  });

  it("holds the beta settings (read from the beta stack templates and parameters, 2026-11-24), plus `bedrock` among the source kinds (DEC 254zzz524: the company's own Bedrock for its agents)", () => {
    expect(file.environments.beta).toEqual({
      region: "us-east-1", deployAccount: DEPLOY_ACCOUNT_PLACEHOLDER, codeUrl: "https://lznfb0pf48.execute-api.us-east-1.amazonaws.com",
      aiSourceKinds: "openai,bedrock", productAi: "on", rovaraAi: "on", rovaraAiExempt: null, rovaraAiDisabled: null,
      offeredPrices: "on", providerSecretNames: "generated", pending: [],
    });
  });

  it("holds production's settings, read from the live production stacks by the prod session (read-only, 2026-11-24)", () => {
    expect(file.environments.production).toEqual({
      region: "us-east-1", deployAccount: null, codeUrl: "https://3m38w35kz2.execute-api.us-east-1.amazonaws.com", aiSourceKinds: "openai", productAi: "on", rovaraAi: "on", rovaraAiExempt: null,
      rovaraAiDisabled: null, offeredPrices: "on", providerSecretNames: "generated", pending: [],
    });
    expect(codeUrlFor("production", file)).toBe("https://3m38w35kz2.execute-api.us-east-1.amazonaws.com");
    expect(codeUrlFor("beta", file)).toBe("https://lznfb0pf48.execute-api.us-east-1.amazonaws.com");
  });

  it("refuses to use a row whose required value is still pending (a synthetic row: no row is pending today)", () => {
    const pendingText = mutate((v) => { v.environments.production!.codeUrl = null; v.environments.production!.pending = ["codeUrl"]; });
    const pending = parseSwitches(pendingText);
    expect(() => rowFor("production", pending)).toThrow(/codeUrl.*pending/u);
    expect(() => contextArgs("production", "gateway", pending)).toThrow(/pending/u);
    expect(() => codeUrlFor("production", pending)).toThrow(/pending/u);
    expect(rowFor("beta", pending).codeUrl).toBe("https://lznfb0pf48.execute-api.us-east-1.amazonaws.com");
    for (const name of SWITCHES_ENVIRONMENTS) expect(file.environments[name].pending, name).toEqual([]);
  });

  it("holds no secret value or key material", () => {
    expect(raw).not.toMatch(/AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{16}|-----BEGIN|"password"|"secret"|"token"/u);
  });
});

describe("the loader's names equal the infra constants they repeat", () => {
  it("the context keys", () => {
    expect(CONTEXT_KEYS).toEqual({
      gatewayEnvironment: gateway.MODEL_GATEWAY_CONTEXT_KEY, webEnvironment: cloudApp.CLOUD_APP_CONTEXT_KEY, region: "agentxRegion", deployAccount: pipeline.DEPLOY_ACCOUNT_CONTEXT_KEY,
      aiSourceKinds: app.AI_SOURCE_KINDS_CONTEXT_KEY, productAi: gateway.MODEL_GATEWAY_PRODUCT_CONTEXT_KEY, rovaraAi: gateway.MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY,
      rovaraAiExempt: gateway.MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY, rovaraAiDisabled: gateway.MODEL_GATEWAY_ROVARA_AI_DISABLED_CONTEXT_KEY,
      offeredPrices: gateway.MODEL_GATEWAY_OFFERED_PRICES_CONTEXT_KEY,
      providerSecretNames: gateway.MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY,
    });
    expect(pipeline.PIPELINE_AI_SOURCE_KINDS_CONTEXT_KEY).toBe(CONTEXT_KEYS.aiSourceKinds);
  });

  it("every cdk context app.ts reads is covered by a key of the row (a new context needs a new key here)", () => {
    const modules: Record<string, unknown>[] = [app, cloudApp, pipeline, releaseActions, gateway];
    const source = readFileSync(new URL("../../infra/lib/app.ts", import.meta.url), "utf8");
    const read = [...source.matchAll(/tryGetContext\(([A-Za-z_]+|"[A-Za-z]+")\)/gu)].map((m) => m[1]!);
    expect(read.length).toBeGreaterThanOrEqual(12);
    const resolved = read.map((name) => {
      if (name.startsWith('"')) return name.slice(1, -1);
      const hit = modules.map((m) => m[name]).find((value) => typeof value === "string");
      if (hit === undefined) throw new Error(`cannot resolve ${name}`);
      return hit;
    });
    // The pipeline and release-actions contexts are those stacks' own selectors, not gateway or web settings.
    const covered = new Set<string>([...Object.values(CONTEXT_KEYS), pipeline.CLOUD_PIPELINE_CONTEXT_KEY, releaseActions.CLOUD_RELEASE_ACTIONS_CONTEXT_KEY]);
    for (const key of resolved) expect(covered.has(key), `app.ts reads ${key}`).toBe(true);
    // And the other way: each key of the row that is a context is read by app.ts.
    for (const key of [...GATEWAY_ROW_CONTEXT, ...WEB_ROW_CONTEXT]) expect(resolved, key).toContain(CONTEXT_KEYS[key]);
  });

  it("production's allowed source kinds", () => {
    expect([...PRODUCTION_SOURCE_KINDS]).toEqual([...CONTRACT_PRODUCTION_SOURCE_KINDS]);
  });
});

describe("each row against CLOUD_PIPELINE_SWITCHES and the PRODUCTION_SOURCE_KINDS rule", () => {
  it("agrees with the pipeline's switches and deploy account for the same environment", () => {
    for (const name of SWITCHES_ENVIRONMENTS) {
      const row = file.environments[name];
      expect(pipeline.CLOUD_PIPELINE_SWITCHES[name], name).toEqual({ productAi: true, aiSourceKinds: row.aiSourceKinds });
      // A row names the placeholder exactly when the pipeline deploys into another account (the id itself lives in neither this file nor the test).
      expect(pipeline.CLOUD_PIPELINE_SEPARATE_ACCOUNT_ENVS.includes(name) ? DEPLOY_ACCOUNT_PLACEHOLDER : null, name).toBe(row.deployAccount);
      // The web deploy's `-c` arguments the pipeline builds today are the same switches this file produces for the web stack.
      const web = contextArgs(name, "web", filled, SIGNED_IN);
      for (const arg of pipeline.pipelineDeployContext(name)) {
        const [key, value] = arg.replace(/^-c /u, "").split("=");
        expect(web[key!], `${name} ${key}`).toBe(value);
      }
    }
  });

  it("production's source kinds pass the production rule, and a production row naming another kind is refused on load", () => {
    expect(productionSourceKindsAllowed(file.environments.production.aiSourceKinds)).toBe(true);
    expect(() => parseSwitches(mutate((v) => { v.environments.production!.aiSourceKinds = "openai,openrouter"; }))).toThrow(/production may switch on only/u);
    expect(() => parseSwitches(mutate((v) => { v.environments.production!.rovaraAiExempt = `org_${"a".repeat(20)}`; }))).toThrow(/never production/u);
    // DEC 254zzz520: bring-your-own Bedrock has no switch: a row that still carries the old key is an unknown key.
    expect(() => parseSwitches(mutate((v) => { v.environments.production!.bedrockByo = "on"; }))).toThrow(/unknown key bedrockByo/u);
    // Beta is a named test environment and may carry other kinds.
    expect(() => parseSwitches(mutate((v) => { v.environments.beta!.aiSourceKinds = "openai,openrouter"; }))).not.toThrow();
  });

  it("refuses a row with a missing key, an unknown key, a bare null, or a missing environment", () => {
    expect(() => parseSwitches(mutate((v) => { delete v.environments.beta!.offeredPrices; }))).toThrow(/missing key offeredPrices/u);
    expect(() => parseSwitches(mutate((v) => { v.environments.beta!.extra = "x"; }))).toThrow(/unknown key extra/u);
    expect(() => parseSwitches(mutate((v) => { v.environments.beta!.codeUrl = null; }))).toThrow(/null but not listed in pending/u);
    expect(() => parseSwitches(mutate((v) => { v.environments.production!.codeUrl = null; }))).toThrow(/null but not listed in pending/u);
    expect(() => parseSwitches(mutate((v) => { v.environments.beta!.codeUrl = "https://beta.rovara.dev/"; }))).toThrow(/no path or trailing slash/u);
    expect(() => parseSwitches(mutate((v) => { delete v.environments.production; }))).toThrow(/exactly beta, production/u);
  });
});

describe("the rows fed to the real stacks", () => {
  it("beta's gateway is what the live beta template carries, plus bring-your-own Bedrock (DEC 254zzz520)", () => {
    const { vars, template } = serveEnv("beta");
    expect(vars[gateway.MODEL_GATEWAY_ENV.aiSourceKinds]).toBe("openai,bedrock");
    expect(vars[gateway.MODEL_GATEWAY_ENV.offeredPrices]).toBe("on");
    // The live GATEWAY_ROVARA_AI_MODELS (read 2026-11-24) is exactly what `rovaraAi: on` expands to.
    expect(vars[gateway.MODEL_GATEWAY_ENV.rovaraAiModels]).toBe(`${gateway.ROVARA_AI_US_MODELS},${gateway.ROVARA_AI_US_CONVERSE_MODELS}`);
    expect(vars[gateway.MODEL_GATEWAY_ENV.rovaraAiExempt]).toBeUndefined();
    expect(vars[gateway.MODEL_GATEWAY_ENV.agentModelsDisabled]).toBeUndefined();
    // DEC 254zzz520: the retained broker role and the external-id key are part of beta (the settings of a company's own role come later, per company).
    expect(vars[gateway.MODEL_GATEWAY_ENV.bedrockBrokerRole]).toBeDefined();
    expect(vars[gateway.MODEL_GATEWAY_ENV.bedrockExternalIdKey]).toBeDefined();
    expect(template).toContain("RovaraBedrockBroker-beta");
    expect(vars[gateway.MODEL_GATEWAY_ENV.productKeysTable]).toBeDefined();
    expect(template).toContain("ProviderKeyanthropic");
  });

  it("production's gateway and web stacks are made with its row (the production source kinds rule runs at synth)", () => {
    const { vars, template } = serveEnv("production");
    expect(vars[gateway.MODEL_GATEWAY_ENV.aiSourceKinds]).toBe("openai");
    // DEC 254zzz520: production carries the retained broker role and the external-id key under its own names.
    expect(vars[gateway.MODEL_GATEWAY_ENV.bedrockBrokerRole]).toBeDefined();
    expect(vars[gateway.MODEL_GATEWAY_ENV.bedrockExternalIdKey]).toBeDefined();
    expect(template).toContain("RovaraBedrockBroker-production");
    expect(vars[gateway.MODEL_GATEWAY_ENV.offeredPrices]).toBe("on");
    expect(vars[gateway.MODEL_GATEWAY_ENV.rovaraAiExempt]).toBeUndefined();
    expect(webServerEnv("production").vars[CLOUD_AI_SOURCE_KINDS_ENV]).toBe("openai");
  });

  it("beta's web stack is made with its row and the deploy account", () => {
    const context = contextArgs("beta", "web", filled, SIGNED_IN);
    expect(context).toEqual({
      rovaraCloudApp: "beta", agentxRegion: "us-east-1", agentxAccount: FAKE, rovaraModelGatewayProductAi: "on", rovaraAiSourceKinds: "openai,bedrock",
    });
    const { stack, vars } = webServerEnv("beta");
    expect(stack.account).toBe(FAKE);
    expect(vars[CLOUD_AI_SOURCE_KINDS_ENV]).toBe("openai,bedrock");
  });

  it("the gateway context lists exactly the hand command's contexts, and none for the default secret names", () => {
    expect(contextArgs("beta", "gateway", filled)).toEqual({
      rovaraModelGateway: "beta", agentxRegion: "us-east-1", rovaraModelGatewayProductAi: "on", rovaraModelGatewayRovaraAi: "on",
      rovaraAiSourceKinds: "openai,bedrock", rovaraModelGatewayOfferedPrices: "on",
    });
    expect(contextArgs("production", "gateway", filled)).toEqual({
      rovaraModelGateway: "production", agentxRegion: "us-east-1", rovaraModelGatewayProductAi: "on", rovaraModelGatewayRovaraAi: "on",
      rovaraAiSourceKinds: "openai", rovaraModelGatewayOfferedPrices: "on",
    });
    const fixed = JSON.parse(raw) as SwitchesFile;
    fixed.environments.beta.providerSecretNames = "fixed";
    expect(contextArgs("beta", "gateway", fixed)[CONTEXT_KEYS.providerSecretNames]).toBe("fixed");
  });
});

describe("the deploy account is resolved at deploy time, never committed", () => {
  it("beta carries the placeholder and production the pipeline's own account (null)", () => {
    expect(file.environments.beta.deployAccount).toBe(DEPLOY_ACCOUNT_PLACEHOLDER);
    expect(file.environments.production.deployAccount).toBeNull();
  });

  it("uses the resolved account when it equals the expected one", () => {
    expect(contextArgs("beta", "web", file, SIGNED_IN)[CONTEXT_KEYS.deployAccount]).toBe(FAKE);
    expect(resolveDeployAccount(file.environments.beta, SIGNED_IN)).toBe(FAKE);
  });

  it("passes no account for a null row, and the gateway never needs one", () => {
    expect(resolveDeployAccount(file.environments.production, {})).toBeNull();
    expect(contextArgs("production", "web", file, {})[CONTEXT_KEYS.deployAccount]).toBeUndefined();
    expect(contextArgs("beta", "gateway", file, {})[CONTEXT_KEYS.deployAccount]).toBeUndefined();
  });

  it("refuses when the account is unresolved or the source is missing", () => {
    expect(() => contextArgs("beta", "web", file, {})).toThrow(/not set/u);
    expect(() => contextArgs("beta", "web", file, { expected: FAKE })).toThrow(new RegExp(`${DEPLOY_ACCOUNT_ENV.resolved}.*not set`, "u"));
    expect(() => contextArgs("beta", "web", file, { resolved: "" , expected: FAKE })).toThrow(/not set/u);
    expect(() => contextArgs("beta", "web", file, { resolved: "${DEPLOY_ACCOUNT}", expected: FAKE })).toThrow(/12-digit/u);
    expect(() => contextArgs("beta", "web", file, { resolved: "None", expected: FAKE })).toThrow(/12-digit/u);
  });

  it("refuses when the expected account is missing or not an account id", () => {
    expect(() => contextArgs("beta", "web", file, { resolved: FAKE })).toThrow(new RegExp(`${DEPLOY_ACCOUNT_ENV.expected}.*not set`, "u"));
    expect(() => contextArgs("beta", "web", file, { resolved: FAKE, expected: "abc" })).toThrow(/12-digit/u);
  });

  it("refuses when the signed-in account differs from the expected one", () => {
    expect(() => contextArgs("beta", "web", file, { resolved: FAKE, expected: OTHER })).toThrow(/does not match/u);
    expect(() => contextArgs("beta", "web", file, { resolved: OTHER, expected: FAKE })).toThrow(/does not match/u);
  });

  it("reads both values from the environment variables the stage exports", () => {
    expect(deployAccountSourceFromEnv({ [DEPLOY_ACCOUNT_ENV.resolved]: FAKE, [DEPLOY_ACCOUNT_ENV.expected]: FAKE })).toEqual({ resolved: FAKE, expected: FAKE });
    expect(deployAccountSourceFromEnv({})).toEqual({ resolved: undefined, expected: undefined });
  });

  it("refuses a literal account id (or any other value) in the file", () => {
    expect(() => parseSwitches(mutate((v) => { v.environments.beta!.deployAccount = FAKE; }))).toThrow(/never written in this file/u);
    expect(() => parseSwitches(mutate((v) => { v.environments.production!.deployAccount = "someone"; }))).toThrow(/null or/u);
  });

  it("no file under ops/pipeline/ holds a 12-digit number, and this test holds only the fake account", () => {
    const twelve = /(?<![0-9])[0-9]{12}(?![0-9])/gu;
    const dir = new URL("../../ops/pipeline/", import.meta.url);
    const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const entry of files) expect(readFileSync(join(entry.parentPath, entry.name), "utf8").match(twelve) ?? [], entry.name).toEqual([]);
    const own = readFileSync(new URL(import.meta.url), "utf8").match(twelve) ?? [];
    expect([...new Set(own)].sort()).toEqual([OTHER, FAKE].sort());
  });
});
