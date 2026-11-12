// MODEL-PROXY-TLS (decisions 110 and 127): the model proxy's HTTPS name as a recorded install setting, and the checks every deploy makes before it synthesizes.
//
// The synth reads the TLS settings from CDK context (infra/lib/model-proxy-tls.ts). A context that is passed by hand on one upgrade and forgotten on the next would synthesize the
// plain-http proxy again and quietly take TLS away. So the choice is recorded in the environment's own SSM folder (`agentx config set modelProxy.tls ...`), like the Team record's
// switch, and every cdk command passes it back. Before anything is built:
//   - M1: a deploy that would take TLS away from an install whose control plane serves it (its ModelProxyUrl output is https) is refused, unless --allow-tls-removal says so;
//   - L1: a deploy that drops the legacy plain-http listeners is refused while a worker that launched before the https address was published still runs (a worker keeps the address
//     it was given at launch, for up to SESSION_MAX_LIFETIME_MS), unless --allow-legacy-http-removal says so;
//   - L3: before the certificate is first requested, the name's domain must be delegated to Route 53 and no CAA record may forbid Amazon, or ACM's DNS validation waits up to 72 hours.
import { agentXError, environmentSettingsPrefix, MODEL_PROXY_URL_PARAMETER } from "@rovara-code/contracts";
import type { ParameterStore } from "../environments/parameter-store.js";

/** The CDK context keys the synth reads (infra/lib/model-proxy-tls.ts MODEL_PROXY_TLS_CONTEXT_KEYS; tests/contract/model-proxy-tls-setting.test.ts keeps the two equal). */
export const MODEL_PROXY_TLS_CONTEXT = {
  name: "rovaraModelProxyTlsName",
  zoneId: "rovaraModelProxyTlsZoneId",
  certificateArn: "rovaraModelProxyTlsCertificateArn",
  legacyHttp: "rovaraModelProxyLegacyHttp",
} as const;

/** The recorded choice, beside the environment settings. */
export const modelProxyTlsSettingName = (env: string): string => `${environmentSettingsPrefix(env)}model-proxy-tls`;

export interface ModelProxyTlsSetting {
  name: string;
  zoneId: string;
  certificateArn?: string;
  /** Keep the old plain-http listeners beside HTTPS (step 1 of the rollout). */
  legacyHttp: boolean;
}

const DNS_NAME = /^(?=.{1,64}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const AWS_OWN_NAME = /(?:^|\.)amazonaws\.com(?:\.cn)?$/u;
const HOSTED_ZONE_ID = /^Z[0-9A-Z]{4,31}$/u;
const ACM_CERTIFICATE_ARN = /^arn:aws(?:-[a-z]+)*:acm:[a-z]{2}(?:-[a-z]+)+-\d:\d{12}:certificate\/[0-9A-Za-z-]{1,128}$/u;
const FIX = (env: string) => `agentx --env ${env} config set modelProxy.tls "name=<dns name>;zoneId=<public hosted zone id>[;certificateArn=<arn>][;legacyHttp=keep|off]" (or off)`;

/** `off`, or the setting as typed: `name=...;zoneId=...[;certificateArn=...][;legacyHttp=keep|off]`. Anything else is refused with the form. */
export function parseModelProxyTlsSetting(value: string, env: string): ModelProxyTlsSetting | "off" {
  const text = value.trim();
  if (text === "off") return "off";
  const fields = new Map<string, string>();
  for (const part of text.split(";").map((piece) => piece.trim()).filter((piece) => piece !== "")) {
    const at = part.indexOf("=");
    const key = at < 0 ? part : part.slice(0, at).trim();
    if (!["name", "zoneId", "certificateArn", "legacyHttp"].includes(key) || at < 0) throw agentXError("CONFIG_INVALID", `modelProxy.tls: unknown or empty field ${JSON.stringify(key.slice(0, 40))}; use ${FIX(env)}; nothing changed`);
    if (fields.has(key)) throw agentXError("CONFIG_INVALID", `modelProxy.tls: ${key} is given twice; nothing changed`);
    fields.set(key, part.slice(at + 1).trim());
  }
  const name = fields.get("name") ?? "";
  const zoneId = fields.get("zoneId") ?? "";
  const certificateArn = fields.get("certificateArn");
  const legacyHttp = fields.get("legacyHttp") ?? "off";
  if (!DNS_NAME.test(name) || AWS_OWN_NAME.test(name)) throw agentXError("CONFIG_INVALID", `modelProxy.tls: name must be a lower-case DNS name of your own of at most 64 characters (not an amazonaws.com name); use ${FIX(env)}; nothing changed`);
  if (!HOSTED_ZONE_ID.test(zoneId)) throw agentXError("CONFIG_INVALID", `modelProxy.tls: zoneId must be the Route 53 id of the public hosted zone the name goes in, such as Z0123456789ABCDEFGHIJ; nothing changed`);
  if (certificateArn !== undefined && !ACM_CERTIFICATE_ARN.test(certificateArn)) throw agentXError("CONFIG_INVALID", "modelProxy.tls: certificateArn must be the ARN of an issued ACM certificate in this region; nothing changed");
  if (legacyHttp !== "keep" && legacyHttp !== "off") throw agentXError("CONFIG_INVALID", "modelProxy.tls: legacyHttp is keep or off; nothing changed");
  return { name, zoneId, ...(certificateArn === undefined ? {} : { certificateArn }), legacyHttp: legacyHttp === "keep" };
}

/** The recorded setting, or undefined when none is recorded or it is recorded as off. A record that does not read refuses: a typo must never read as off, which would take TLS away. */
export async function readModelProxyTlsSetting(store: ParameterStore, env: string): Promise<ModelProxyTlsSetting | undefined> {
  const stored = await store.get(modelProxyTlsSettingName(env));
  if (stored === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(stored.value); } catch { parsed = undefined; }
  const record = parsed as { v?: unknown; enabled?: unknown; name?: unknown; zoneId?: unknown; certificateArn?: unknown; legacyHttp?: unknown } | undefined;
  const fail = () => agentXError("CONFIG_INVALID", `${modelProxyTlsSettingName(env)} can't be read; fix it with ${FIX(env)} before deploying`);
  if (record === undefined || record === null || record.v !== 1 || typeof record.enabled !== "boolean") throw fail();
  if (!record.enabled) return undefined;
  if (typeof record.name !== "string" || typeof record.zoneId !== "string" || typeof record.legacyHttp !== "boolean" || (record.certificateArn !== undefined && typeof record.certificateArn !== "string")) throw fail();
  const text = `name=${record.name};zoneId=${record.zoneId}${record.certificateArn === undefined ? "" : `;certificateArn=${record.certificateArn}`};legacyHttp=${record.legacyHttp ? "keep" : "off"}`;
  let setting: ModelProxyTlsSetting | "off";
  try { setting = parseModelProxyTlsSetting(text, env); } catch { throw fail(); }
  if (setting === "off") throw fail();
  return setting;
}

export async function writeModelProxyTlsSetting(store: ParameterStore, env: string, setting: ModelProxyTlsSetting | "off"): Promise<void> {
  await store.put(modelProxyTlsSettingName(env), JSON.stringify(setting === "off" ? { v: 1, enabled: false } : { v: 1, enabled: true, ...setting }));
}

/** The synth context of the setting, as `-c` pairs. */
export function modelProxyTlsContextArguments(setting: ModelProxyTlsSetting): string[] {
  return [
    "-c", `${MODEL_PROXY_TLS_CONTEXT.name}=${setting.name}`,
    "-c", `${MODEL_PROXY_TLS_CONTEXT.zoneId}=${setting.zoneId}`,
    ...(setting.certificateArn === undefined ? [] : ["-c", `${MODEL_PROXY_TLS_CONTEXT.certificateArn}=${setting.certificateArn}`]),
    "-c", `${MODEL_PROXY_TLS_CONTEXT.legacyHttp}=${setting.legacyHttp ? "keep" : "off"}`,
  ];
}

/** What the deployed install looks like, read before a deploy. */
export interface ModelProxyTlsState {
  /** The control plane's ModelProxyUrl output, or undefined (no stack or no proxy yet). */
  deployedUrl: string | undefined;
  /** The worker URL parameter (`<settings prefix>model-proxy-url`) and when it last changed: the moment new workers started being given its value. */
  urlParameter: { value: string; lastModified: Date } | undefined;
  /** The install's worker instances that are pending or running, with their launch times. */
  workers: ReadonlyArray<{ id: string; launchTime: Date }>;
}

/**
 * M1 and L1: why this deploy must not run, or an empty list. `setting` is what this deploy will synthesize with (undefined: no TLS). `allowTlsRemoval` and `allowLegacyHttpRemoval` are
 * the person's explicit flags.
 */
export function modelProxyTlsRefusals(input: { env: string; setting: ModelProxyTlsSetting | undefined; state: ModelProxyTlsState; allowTlsRemoval?: boolean; allowLegacyHttpRemoval?: boolean }): string[] {
  const { env, setting, state } = input;
  const refusals: string[] = [];
  const deployedHttps = state.deployedUrl?.startsWith("https://") === true;
  if (setting === undefined && deployedHttps && input.allowTlsRemoval !== true) {
    refusals.push(`${env}'s model proxy serves HTTPS (${state.deployedUrl}), and this deploy would put it back on plain http: no model proxy TLS setting is recorded. Record it with ${FIX(env)}, or pass --allow-tls-removal to take TLS away on purpose. Nothing was deployed.`);
  }
  if (setting !== undefined && !setting.legacyHttp && input.allowLegacyHttpRemoval !== true) {
    // A worker keeps the address it was given at launch. Those launched before the https address was published (or every running one, if it is not published yet) may still call plain http.
    const published = state.urlParameter !== undefined && state.urlParameter.value === `https://${setting.name}` ? state.urlParameter.lastModified : undefined;
    const stale = state.workers.filter((worker) => published === undefined || worker.launchTime.getTime() < published.getTime());
    if (stale.length > 0) {
      const oldest = [...stale].sort((a, b) => a.launchTime.getTime() - b.launchTime.getTime())[0]!;
      refusals.push(`${stale.length} worker instance${stale.length === 1 ? "" : "s"} launched before ${published === undefined ? "the model proxy's https address is published" : `the https address was published (${published.toISOString()})`} still run${stale.length === 1 ? "s" : ""} (oldest ${oldest.id}, launched ${oldest.launchTime.toISOString()}) and may call the proxy over plain http; this deploy removes the plain-http listeners. Record legacyHttp=keep until they finish (workers live at most 14 days), or pass --allow-legacy-http-removal. Nothing was deployed.`);
    }
  }
  return refusals;
}

/** Public DNS lookups the L3 check makes (node:dns/promises in production; a fake in tests). A name with no such records rejects with code ENODATA or ENOTFOUND. */
export interface DnsLookups {
  resolveNs(name: string): Promise<string[]>;
  resolveCaa(name: string): Promise<Array<{ critical: number; issue?: string | undefined }>>;
}

/** The CAA issuer names that let ACM issue (AWS's documented list). */
export const AMAZON_CAA_ISSUERS: readonly string[] = ["amazon.com", "amazontrust.com", "awstrust.com", "amazonaws.com"];

const noRecords = (error: unknown): boolean => error instanceof Error && ["ENODATA", "ENOTFOUND"].includes((error as Error & { code?: string }).code ?? "");

/**
 * L3: before ACM is first asked for the certificate (no brought certificate and the name is not yet served), check in public DNS that (1) the closest delegated domain above the name
 * is served by Route 53 name servers, so the validation record CloudFormation writes in the zone is the one the internet sees, and (2) the closest CAA record set at or above the name,
 * if any, lets Amazon issue. A lookup that fails for any other reason refuses too (fail closed): ACM would otherwise wait up to 72 hours and the upgrade with it.
 */
export async function modelProxyTlsDnsRefusals(name: string, dns: DnsLookups): Promise<string[]> {
  const labels = name.split(".");
  const ancestors = labels.slice(1).map((_, index) => labels.slice(index + 1).join(".")).filter((each) => each.includes("."));
  const refusals: string[] = [];
  try {
    let servers: string[] | undefined;
    for (const domain of ancestors) {
      try { const found = await dns.resolveNs(domain); if (found.length > 0) { servers = found; break; } } catch (error) { if (!noRecords(error)) throw error; }
    }
    if (servers === undefined) refusals.push(`no domain above ${name} is delegated in public DNS, so ACM cannot validate the certificate (it would wait up to 72 hours). Nothing was deployed.`);
    else if (!servers.every((server) => /\.awsdns-\d+\.[a-z.]+\.?$/iu.test(server))) refusals.push(`the domain above ${name} is served by ${servers.join(", ")}, not Route 53, so the validation record written in the hosted zone would not be seen and ACM would wait up to 72 hours. Delegate the domain to the zone's name servers first. Nothing was deployed.`);
    for (const domain of [name, ...ancestors]) {
      let records: Awaited<ReturnType<DnsLookups["resolveCaa"]>> = [];
      try { records = await dns.resolveCaa(domain); } catch (error) { if (!noRecords(error)) throw error; }
      const issuers = records.flatMap((record) => (record.issue === undefined ? [] : [record.issue.split(";")[0]!.trim().toLowerCase()]));
      if (records.length === 0) continue;
      if (!issuers.some((issuer) => AMAZON_CAA_ISSUERS.includes(issuer))) refusals.push(`the CAA records of ${domain} do not let Amazon issue certificates (allowed: ${issuers.join(", ") || "none"}), so ACM cannot issue one for ${name}. Add a CAA issue record for amazon.com. Nothing was deployed.`);
      break;
    }
  } catch {
    refusals.push(`the public DNS of ${name} could not be read (name servers and CAA), so the certificate check could not run. Try again; nothing was deployed.`);
  }
  return refusals;
}

/** The worker URL parameter's name (the control plane writes it, infra/lib/model-proxy.ts). */
export const workerModelProxyUrlParameter = (env: string): string => `${environmentSettingsPrefix(env)}${MODEL_PROXY_URL_PARAMETER}`;

/** Every check before a deploy; throws CONFIG_INVALID with every reason when any refuses. */
export async function assertModelProxyTlsDeploy(input: {
  env: string;
  setting: ModelProxyTlsSetting | undefined;
  /** `workers`: whether the worker instances are needed (only when the legacy listeners go). */
  readState: (options: { workers: boolean }) => Promise<ModelProxyTlsState>;
  dns: DnsLookups;
  allowTlsRemoval?: boolean;
  allowLegacyHttpRemoval?: boolean;
}): Promise<void> {
  const state = await input.readState({ workers: input.setting !== undefined && !input.setting.legacyHttp && input.allowLegacyHttpRemoval !== true });
  const refusals = modelProxyTlsRefusals({ env: input.env, setting: input.setting, state, ...(input.allowTlsRemoval === true ? { allowTlsRemoval: true } : {}), ...(input.allowLegacyHttpRemoval === true ? { allowLegacyHttpRemoval: true } : {}) });
  const firstCertificate = input.setting !== undefined && input.setting.certificateArn === undefined && state.deployedUrl !== `https://${input.setting.name}`;
  if (firstCertificate) refusals.push(...await modelProxyTlsDnsRefusals(input.setting!.name, input.dns));
  if (refusals.length > 0) throw agentXError("CONFIG_INVALID", `Model proxy TLS: ${refusals.join(" ")}`);
}
