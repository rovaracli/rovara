// The layout of the Cloud steps (L2-STAGE-CLI-INTERFACE.md 2.2), read from config.json and gate-policy.json. Node-only imports (Node runs this file directly).
import { readFileSync } from "node:fs";
import type { GatePhase, PipelineEnv, StackPart } from "./types.ts";

export interface PipelineConfig {
  schema: 1;
  trunkBranches: string[];
  releaseTagPattern: string;
  bootstrapQualifier: string;
  ssmPrefix: string;
  ssmChecksPrefix: string;
  stackNames: Record<StackPart | "gatewayImages", string>;
  stackIds: Record<StackPart, string>;
  environments: Record<PipelineEnv, { profile: string | null }>;
  /** `codeGateway`: the commands that make a Code checkout ready to synthesize the gateway stacks (#1478 phase 2); run without AWS credentials. */
  build: { common: string[]; web: string[]; codeGateway: string[] };
  releaseCheck: { paths: string[]; intervalSeconds: number };
}

export interface GatePolicy { schema: 1; required: Record<GatePhase, string[]> }

export const DEFAULT_CONFIG_PATH = new URL("./config.json", import.meta.url);
export const DEFAULT_GATE_POLICY_PATH = new URL("./gate-policy.json", import.meta.url);

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "");

export function parseConfig(raw: string): PipelineConfig {
  const file = JSON.parse(raw) as Partial<PipelineConfig> & Record<string, unknown>;
  if (file.schema !== 1) throw new Error("config.json: schema must be 1");
  if (!isStringList(file.trunkBranches) || file.trunkBranches.length === 0) throw new Error("config.json: trunkBranches must be a non-empty list");
  if (typeof file.releaseTagPattern !== "string") throw new Error("config.json: releaseTagPattern must be a string");
  new RegExp(file.releaseTagPattern, "u");
  if (typeof file.bootstrapQualifier !== "string" || !/^[a-z0-9]{1,16}$/u.test(file.bootstrapQualifier)) throw new Error("config.json: bootstrapQualifier is not a CDK qualifier");
  if (typeof file.ssmPrefix !== "string" || !file.ssmPrefix.startsWith("/") || !file.ssmPrefix.includes("{env}")) throw new Error("config.json: ssmPrefix must start with / and contain {env}");
  if (typeof file.ssmChecksPrefix !== "string" || !file.ssmChecksPrefix.startsWith("/") || !file.ssmChecksPrefix.includes("{env}")) throw new Error("config.json: ssmChecksPrefix must start with / and contain {env}");
  for (const key of ["gateway", "web", "app", "gatewayImages"]) {
    const name = (file.stackNames as Record<string, unknown> | undefined)?.[key];
    if (typeof name !== "string" || !name.includes("{env}")) throw new Error(`config.json: stackNames.${key} must contain {env}`);
  }
  for (const key of ["gateway", "web", "app"]) {
    const id = (file.stackIds as Record<string, unknown> | undefined)?.[key];
    if (typeof id !== "string" || id === "") throw new Error(`config.json: stackIds.${key} must be a name`);
  }
  const envs = file.environments as Record<string, { profile?: unknown }> | undefined;
  for (const env of ["beta", "production"]) {
    const row = envs?.[env];
    if (row === undefined || !(row.profile === null || typeof row.profile === "string")) throw new Error(`config.json: environments.${env}.profile must be a name or null`);
  }
  const build = file.build as { common?: unknown; web?: unknown; codeGateway?: unknown } | undefined;
  if (!isStringList(build?.common) || !isStringList(build?.web)) throw new Error("config.json: build.common and build.web must be command lists");
  if (!isStringList(build?.codeGateway)) throw new Error("config.json: build.codeGateway must be a command list (the Code checkout's install and build, for the gateway stacks)");
  const check = file.releaseCheck as { paths?: unknown; intervalSeconds?: unknown } | undefined;
  if (!isStringList(check?.paths) || typeof check.intervalSeconds !== "number" || check.intervalSeconds <= 0) throw new Error("config.json: releaseCheck needs paths and a positive intervalSeconds");
  return file as unknown as PipelineConfig;
}

export function loadConfig(path: URL | string = DEFAULT_CONFIG_PATH): PipelineConfig {
  return parseConfig(readFileSync(path, "utf8"));
}

export function parseGatePolicy(raw: string): GatePolicy {
  const file = JSON.parse(raw) as { schema?: unknown; required?: Record<string, unknown> };
  if (file.schema !== 1) throw new Error("gate-policy.json: schema must be 1");
  for (const phase of ["preflight", "change-sets", "gateway-live", "proof"]) {
    if (!isStringList(file.required?.[phase])) throw new Error(`gate-policy.json: required.${phase} must be a list of gate names`);
  }
  return file as unknown as GatePolicy;
}

export function loadGatePolicy(path: URL | string = DEFAULT_GATE_POLICY_PATH): GatePolicy {
  return parseGatePolicy(readFileSync(path, "utf8"));
}

const fill = (template: string, env: string): string => template.replaceAll("{env}", env);

export function stackName(config: PipelineConfig, env: PipelineEnv, part: StackPart | "gatewayImages"): string {
  return fill(config.stackNames[part], env);
}
export function ssmPrefixFor(config: PipelineConfig, env: PipelineEnv): string {
  return fill(config.ssmPrefix, env);
}
export function ssmChecksPrefixFor(config: PipelineConfig, env: PipelineEnv): string {
  return fill(config.ssmChecksPrefix, env);
}
export function lastGoodParameter(config: PipelineConfig, env: PipelineEnv): string {
  return `${ssmPrefixFor(config, env)}/last-good`;
}
export function releaseTagRegex(config: PipelineConfig): RegExp {
  return new RegExp(config.releaseTagPattern, "u");
}
/** The change set name every stack of one execution gets (the staging pack's name). */
export function changeSetNameFor(exec8: string): string {
  return `rovara-pipeline-${exec8}`;
}
