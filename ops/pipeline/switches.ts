// The per-environment settings of the gateway and web stacks (BETA-CLOUD-PLAN 1.3, 3.2; lane L0), read from ops/pipeline/switches.json.
// Today nothing reads this file: lanes L1/L2 (ops/pipeline/stage.ts, the Cloud actions of the one release pipeline) will call
// `contextArgs` and `codeUrlFor` instead of a typed hand command or CLOUD_PIPELINE_SWITCHES.
// Node runs this file directly, so only erasable syntax and no imports beyond node: (the contract test tests/contract/pipeline-switches.test.ts
// holds every name below equal to the infra constants it repeats).
import { readFileSync } from "node:fs";

export type SwitchesEnvironment = "beta" | "production";
export const SWITCHES_ENVIRONMENTS: readonly SwitchesEnvironment[] = ["beta", "production"];

/** Repeated from packages/contracts/src/model-sources.ts PRODUCTION_SOURCE_KINDS (a contract test holds the two equal). */
export const PRODUCTION_SOURCE_KINDS: readonly string[] = ["openai", "bedrock"];

export interface SwitchesRow {
  region: string;
  /**
   * The account the Cloud stacks deploy into when it is not the pipeline's own (`-c agentxAccount`, web and app stacks); null: the pipeline's own.
   * Never a literal account id (the file is committed to a public copy): the placeholder DEPLOY_ACCOUNT_PLACEHOLDER, resolved at deploy time by `resolveDeployAccount`.
   */
  deployAccount: typeof DEPLOY_ACCOUNT_PLACEHOLDER | null;
  /** The Rovara Code install's RAW api address: the web and gateway stacks' CodeUrl parameter (its issuer is `<codeUrl>/v1/auth`). Never a custom domain. */
  codeUrl: string | null;
  /** `-c rovaraAiSourceKinds`: the same value goes to Cloud (CLOUD_AI_SOURCE_KINDS) and the gateway (GATEWAY_AI_SOURCE_KINDS). */
  aiSourceKinds: string;
  /** `-c rovaraModelGatewayProductAi`: "on". */
  productAi: "on";
  /** `-c rovaraModelGatewayRovaraAi`: "on" (the built-in allow-list) or `<agent model>=<bedrock id>,...` pairs. */
  rovaraAi: string;
  /** `-c rovaraModelGatewayRovaraAiExempt`: company ids, null: not passed (never for production). */
  rovaraAiExempt: string | null;
  /** `-c rovaraModelGatewayRovaraAiDisabled`: model names, null: not passed (the gateway's default). */
  rovaraAiDisabled: string | null;
  /** `-c rovaraModelGatewayOfferedPrices`: "on". */
  offeredPrices: "on";
  /** `-c rovaraModelGatewayProviderSecretNames`: "generated" is the default and is not passed; "fixed" keeps an old environment's fixed names. */
  providerSecretNames: "generated" | "fixed";
  /** Required keys not read yet (null in this row). A row with any is refused by `rowFor`. */
  pending: string[];
}

export interface SwitchesFile {
  schema: 1;
  about: string;
  environments: Record<SwitchesEnvironment, SwitchesRow>;
}

/** Every key a row must carry (the gateway and web stacks' contexts plus the CodeUrl parameter, region and account). */
export const ROW_KEYS: readonly string[] = [
  "region", "deployAccount", "codeUrl", "aiSourceKinds", "productAi", "rovaraAi", "rovaraAiExempt", "rovaraAiDisabled", "offeredPrices", "providerSecretNames", "pending",
];
/** The keys that may be null because the context is simply not passed. */
export const OPTIONAL_NULL_KEYS: readonly string[] = ["deployAccount", "rovaraAiExempt", "rovaraAiDisabled"];
/** The keys that may be listed in `pending` (required, value not read yet). */
export const PENDING_ALLOWED_KEYS: readonly string[] = ["codeUrl"];

/** The cdk context key each row key becomes (infra/lib/app.ts, model-gateway.ts, cloud-release-pipeline.ts, cloud-app.ts). A contract test holds them equal. */
export const CONTEXT_KEYS = {
  gatewayEnvironment: "rovaraModelGateway",
  webEnvironment: "rovaraCloudApp",
  region: "agentxRegion",
  deployAccount: "agentxAccount",
  aiSourceKinds: "rovaraAiSourceKinds",
  productAi: "rovaraModelGatewayProductAi",
  rovaraAi: "rovaraModelGatewayRovaraAi",
  rovaraAiExempt: "rovaraModelGatewayRovaraAiExempt",
  rovaraAiDisabled: "rovaraModelGatewayRovaraAiDisabled",
  offeredPrices: "rovaraModelGatewayOfferedPrices",
  providerSecretNames: "rovaraModelGatewayProviderSecretNames",
} as const;

type ContextRowKey = "aiSourceKinds" | "productAi" | "rovaraAi" | "rovaraAiExempt" | "rovaraAiDisabled" | "offeredPrices" | "providerSecretNames";
/** The row keys the gateway reads as context, in the order the hand command passed them. */
export const GATEWAY_ROW_CONTEXT: readonly ContextRowKey[] = ["productAi", "rovaraAi", "rovaraAiExempt", "rovaraAiDisabled", "aiSourceKinds", "offeredPrices", "providerSecretNames"];
/** The web stack reads fewer: the product AI switch, the source kinds and the exempt list (app.ts). */
export const WEB_ROW_CONTEXT: readonly ContextRowKey[] = ["productAi", "aiSourceKinds", "rovaraAiExempt"];

/** What a row's `deployAccount` holds instead of an account id. */
export const DEPLOY_ACCOUNT_PLACEHOLDER = "${DEPLOY_ACCOUNT}";
/** The two values the stage hands the loader at deploy time (neither is committed): the account the deploy role is signed in to, and the account the stage expects. */
export const DEPLOY_ACCOUNT_ENV = { resolved: "ROVARA_DEPLOY_CALLER_ACCOUNT", expected: "ROVARA_EXPECTED_DEPLOY_ACCOUNT" } as const;
export interface DeployAccountSource {
  /** The `Account` of `aws sts get-caller-identity` run with the deploy role's credentials (the stage reads it; this module makes no AWS call). */
  resolved?: string | undefined;
  /** The account this stage is meant to deploy into, from a source outside git (a pipeline variable or an SSM parameter value the stage exports). */
  expected?: string | undefined;
}
export function deployAccountSourceFromEnv(environment: Record<string, string | undefined> = process.env): DeployAccountSource {
  return { resolved: environment[DEPLOY_ACCOUNT_ENV.resolved], expected: environment[DEPLOY_ACCOUNT_ENV.expected] };
}

export const DEFAULT_SWITCHES_PATH = new URL("./switches.json", import.meta.url);

const text = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") throw new Error(`${what} must be a non-empty string`);
  return value;
};

/** Parses and checks switches.json text: every environment, every key, the right shapes, the pending rule and production's source kinds. */
export function parseSwitches(raw: string): SwitchesFile {
  const file = JSON.parse(raw) as { schema?: unknown; environments?: Record<string, Record<string, unknown>> };
  if (file.schema !== 1) throw new Error("switches.json: schema must be 1");
  const environments = file.environments;
  if (environments === undefined || typeof environments !== "object") throw new Error("switches.json: environments is missing");
  const names = Object.keys(environments).sort();
  if (names.join(",") !== [...SWITCHES_ENVIRONMENTS].sort().join(",")) throw new Error(`switches.json: environments must be exactly ${SWITCHES_ENVIRONMENTS.join(", ")} (one separate row each), found ${names.join(", ")}`);
  for (const name of SWITCHES_ENVIRONMENTS) {
    const row = environments[name]!;
    const where = `switches.json ${name}`;
    for (const key of ROW_KEYS) if (!Object.hasOwn(row, key)) throw new Error(`${where}: missing key ${key}`);
    const extra = Object.keys(row).filter((key) => !ROW_KEYS.includes(key));
    if (extra.length > 0) throw new Error(`${where}: unknown key ${extra.join(", ")}`);
    text(row.region, `${where}: region`);
    if (row.deployAccount !== null && row.deployAccount !== DEPLOY_ACCOUNT_PLACEHOLDER) throw new Error(`${where}: deployAccount must be null or ${DEPLOY_ACCOUNT_PLACEHOLDER}; an account id is never written in this file`);
    text(row.aiSourceKinds, `${where}: aiSourceKinds`);
    if (row.productAi !== "on") throw new Error(`${where}: productAi must be "on"`);
    text(row.rovaraAi, `${where}: rovaraAi`);
    for (const key of ["rovaraAiExempt", "rovaraAiDisabled"]) if (row[key] !== null) text(row[key], `${where}: ${key}`);
    if (row.offeredPrices !== "on") throw new Error(`${where}: offeredPrices must be "on"`);
    if (row.providerSecretNames !== "generated" && row.providerSecretNames !== "fixed") throw new Error(`${where}: providerSecretNames must be "generated" or "fixed"`);
    const pending = row.pending;
    if (!Array.isArray(pending) || pending.some((key) => typeof key !== "string")) throw new Error(`${where}: pending must be a list of key names`);
    for (const key of pending as string[]) {
      if (!PENDING_ALLOWED_KEYS.includes(key)) throw new Error(`${where}: ${key} cannot be pending`);
      if (row[key] !== null) throw new Error(`${where}: ${key} is pending, so its value must be null`);
    }
    // A required value is either filled or listed as pending: a bare null is never a silent "unknown".
    for (const key of PENDING_ALLOWED_KEYS) {
      if (row[key] === null && !(pending as string[]).includes(key)) throw new Error(`${where}: ${key} is null but not listed in pending`);
      if (row[key] !== null) text(row[key], `${where}: ${key}`);
    }
    if (typeof row.codeUrl === "string" && !/^https:\/\/[^/\s]+$/u.test(row.codeUrl)) throw new Error(`${where}: codeUrl must be an https address with no path or trailing slash`);
    // The production rule of the stacks (contracts PRODUCTION_SOURCE_KINDS): only kinds that passed their real-key check. Repeated so a bad row fails on load, not at synth.
    if (name === "production") {
      if (row.rovaraAiExempt !== null) throw new Error(`${where}: exempt companies are for named test environments, never production`);
      const kinds = (row.aiSourceKinds as string).split(",").map((kind) => kind.trim());
      if (kinds.some((kind) => !PRODUCTION_SOURCE_KINDS.includes(kind))) throw new Error(`${where}: production may switch on only these company AI sources: ${PRODUCTION_SOURCE_KINDS.join(", ")}`);
    }
  }
  return file as unknown as SwitchesFile;
}

export function loadSwitches(path: URL | string = DEFAULT_SWITCHES_PATH): SwitchesFile {
  return parseSwitches(readFileSync(path, "utf8"));
}

/** The row of an environment, refused while any required value is still pending. */
export function rowFor(env: string, file: SwitchesFile = loadSwitches()): SwitchesRow {
  if (!(SWITCHES_ENVIRONMENTS as readonly string[]).includes(env)) throw new Error(`no switches row for environment ${env}`);
  const row = file.environments[env as SwitchesEnvironment];
  if (row.pending.length > 0) throw new Error(`switches.json ${env}: ${row.pending.join(", ")} not read yet (pending); fill it from the live stack before using this row`);
  return row;
}

/** The CodeUrl stack parameter of an environment. */
export function codeUrlFor(env: string, file: SwitchesFile = loadSwitches()): string {
  return rowFor(env, file).codeUrl!;
}

const accountId = (value: string | undefined, what: string): string => {
  if (value === undefined || value === "") throw new Error(`${what} is not set; refusing to deploy without it`);
  if (!/^[0-9]{12}$/u.test(value)) throw new Error(`${what} is not a 12-digit account id`);
  return value;
};

/**
 * The account a row deploys into. null: the pipeline's own (nothing passed). The placeholder: the signed-in account of the deploy role, which must
 * equal the expected account the stage holds outside git; unresolved, unset or different is refused, so a deploy never goes to an unchecked account.
 */
export function resolveDeployAccount(row: SwitchesRow, source: DeployAccountSource = deployAccountSourceFromEnv()): string | null {
  if (row.deployAccount === null) return null;
  const resolved = accountId(source.resolved, `the deploy account (${DEPLOY_ACCOUNT_ENV.resolved}, the sts get-caller-identity account of the deploy role)`);
  const expected = accountId(source.expected, `the expected deploy account (${DEPLOY_ACCOUNT_ENV.expected})`);
  if (resolved !== expected) throw new Error(`the signed-in deploy account does not match the expected deploy account (${DEPLOY_ACCOUNT_ENV.resolved} vs ${DEPLOY_ACCOUNT_ENV.expected}); refusing to deploy`);
  return resolved;
}

/** The cdk context (name to value) the environment's gateway or web deploy carries: what the hand command passed, now from the file. The web target resolves the deploy account (see resolveDeployAccount). */
export function contextArgs(env: string, target: "gateway" | "web", file: SwitchesFile = loadSwitches(), account: DeployAccountSource = deployAccountSourceFromEnv()): Record<string, string> {
  const row = rowFor(env, file);
  const context: Record<string, string> = {
    [target === "gateway" ? CONTEXT_KEYS.gatewayEnvironment : CONTEXT_KEYS.webEnvironment]: env,
    [CONTEXT_KEYS.region]: row.region,
  };
  const deployAccount = target === "web" ? resolveDeployAccount(row, account) : null;
  if (deployAccount !== null) context[CONTEXT_KEYS.deployAccount] = deployAccount;
  for (const key of target === "gateway" ? GATEWAY_ROW_CONTEXT : WEB_ROW_CONTEXT) {
    const value = row[key];
    // The default secret-name mode is the absence of the context (the live templates were made without it).
    if (value === null || (key === "providerSecretNames" && value === "generated")) continue;
    context[CONTEXT_KEYS[key]] = value;
  }
  return context;
}
