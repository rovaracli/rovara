// Bring your own Bedrock (DEC 238, slice 1): the company connects its OWN AWS account's Bedrock for its agents. Nothing secret is
// stored. The company's AWS admin creates an invoke-only role (the CloudFormation template below, hosted on the docs site, DEC 238
// Q10) that trusts ONE fixed Rovara role, the "Bedrock broker", and only with:
//   - sts:ExternalId = the company's external id: `rvb-` + HMAC(install, company) under the gateway's own KMS HMAC key
//     (BedrockExternalIds). Rovara derives it from the VERIFIED company id each time; it is never typed, stored or taken from a
//     request, so company B can never send company A's external id;
//   - sts:RoleSessionName = the company id, so the customer's CloudTrail names the Rovara company that called.
// The gateway assumes broker -> customer role per call (bedrock-byo-sessions.ts) and signs Bedrock calls with that session. Bedrock
// bills the customer's account; Rovara's meter only enforces the one combined company cap (at list price, DEC 238 Q7).
//
// What the company connects (sealed in the product key store as provider "bedrock", company-level source only in slice 1):
//   {"scheme":"assume_role","roleArn":"arn:aws:iam::<acct>:role/RovaraBedrockInvoke-<company>","region":"us-west-2",
//    "models":{"claude-sonnet-5-5":"us.anthropic.claude-sonnet-5-5"},"allowGlobal":false}
// Parsing is strict and total: anything unexpected is refused as a whole.
import { createHash } from "node:crypto";
import { BEDROCK_CLAUDE_ID } from "./bedrock-transport.js";
import { COMPANY, record, whole } from "./model-gateway-token.js";

/** Every customer role's name starts with this; the broker may assume nothing else (infra/lib/model-gateway.ts). */
export const BEDROCK_BYO_ROLE_PREFIX = "RovaraBedrockInvoke-";
/**
 * The customer's role: commercial partition only (the broker lives there), no path (the template makes none), the fixed prefix.
 * IAM role names are at most 64 characters.
 */
export const BEDROCK_BYO_ROLE_ARN = /^arn:aws:iam::([0-9]{12}):role\/(RovaraBedrockInvoke-[A-Za-z0-9+=,.@_-]{1,44})$/u;
/** A commercial Region the customer's Bedrock runs in (GovCloud and China are other partitions: not offered). */
export const BEDROCK_BYO_REGION = /^(?:us|eu|ap|ca|sa|me|af|il|mx)-[a-z]+-[1-9]$/u;
/** At most this many models per connection (each becomes up to three IAM resource ARNs in the template's 4,096-byte parameter). */
export const BEDROCK_BYO_MODELS_MAX = 8;
const AGENT_MODEL = /^claude-[a-z0-9-]{1,80}$/u;
/** A region's inference-profile geographies (AWS system profile prefixes). `global.` is never one: global routing is off. */
export function geographiesOf(region: string): readonly string[] {
  if (region.startsWith("us-gov-")) return ["us-gov"];
  const area = region.split("-")[0];
  return area === "us" ? ["us"] : area === "eu" ? ["eu"] : area === "ap" ? ["apac", "jp", "au"] : area === "ca" ? ["ca"] : [];
}
/** `rvb-` + 40 hex characters (160 bits of the HMAC). AWS allows 2 to 1,224 characters of [\w+=,.@:/-]. */
export const BEDROCK_EXTERNAL_ID = /^rvb-[0-9a-f]{40}$/u;
export const BEDROCK_EXTERNAL_ID_PURPOSE = "rovara-bedrock-external-id/v1";

export interface BedrockConnection {
  scheme: "assume_role";
  roleArn: string;
  region: string;
  /** The agent's (Anthropic) model name to the Bedrock Claude id or system inference profile called for it: the allow-list. */
  models: Readonly<Record<string, string>>;
  /** Global cross-Region routing (`global.` profiles): data may leave the geography. Off unless the admin turns it on (DEC 238 Q3). */
  allowGlobal: boolean;
}
/** The connection test's answer per model (bedrock-byo-sessions.ts). */
export const BEDROCK_MODEL_CHECKS = ["ready", "not_enabled", "refused", "not_found", "unavailable"] as const;
export type BedrockModelCheck = typeof BEDROCK_MODEL_CHECKS[number];
/** What Settings may show (nothing here is secret; the sealed connection is the same plus the scheme). */
export interface BedrockSummary {
  roleArn: string; region: string; models: Readonly<Record<string, string>>; allowGlobal: boolean;
  /** Each model's state at the last connection test, and when that test ran. */
  checks: Readonly<Record<string, BedrockModelCheck>>; checkedAt: number;
}

const exact = (r: Record<string, unknown>, keys: readonly string[]) => keys.every((k) => Object.hasOwn(r, k)) && Object.keys(r).length === keys.length;
/** A geography prefix of a system inference profile, or undefined for an in-Region model id. */
const geographyOf = (id: string): string | undefined => /^(?:[a-z]{2,4}|global)\.anthropic\./u.test(id) ? id.slice(0, id.indexOf(".")) : undefined;
/** The Bedrock model id without its geography prefix (the foundation model a profile routes to). */
const baseModel = (id: string): string => geographyOf(id) === undefined ? id : id.slice(id.indexOf(".") + 1);

/** Whether `id` may be called from `region`: in-Region, a profile of the Region's geography, or `global.` only when allowed. */
export function allowedBedrockModel(id: string, region: string, allowGlobal: boolean): boolean {
  if (typeof id !== "string" || !BEDROCK_CLAUDE_ID.test(id)) return false;
  const geo = geographyOf(id);
  if (geo === undefined) return true;
  if (geo === "global") return allowGlobal;
  return geographiesOf(region).includes(geo);
}

function validModels(value: unknown, region: string, allowGlobal: boolean): value is Record<string, string> {
  const models = record(value);
  if (models === undefined) return false;
  const entries = Object.entries(models);
  return entries.length >= 1 && entries.length <= BEDROCK_BYO_MODELS_MAX
    && entries.every(([name, id]) => AGENT_MODEL.test(name) && typeof id === "string" && allowedBedrockModel(id, region, allowGlobal));
}

/** The connection a company admin sends (connect or rotate), or undefined. */
export function parseBedrockConnect(text: string): BedrockConnection | undefined {
  if (typeof text !== "string" || text.length > 4096) return undefined;
  let v: unknown;
  try { v = JSON.parse(text) as unknown; } catch { return undefined; }
  const r = record(v);
  if (r === undefined || !exact(r, ["scheme", "roleArn", "region", "models", "allowGlobal"]) || r.scheme !== "assume_role") return undefined;
  if (typeof r.roleArn !== "string" || !BEDROCK_BYO_ROLE_ARN.test(r.roleArn) || typeof r.region !== "string" || !BEDROCK_BYO_REGION.test(r.region) || typeof r.allowGlobal !== "boolean") return undefined;
  if (!validModels(r.models, r.region, r.allowGlobal)) return undefined;
  return { scheme: "assume_role", roleArn: r.roleArn, region: r.region, models: sortedModels(r.models), allowGlobal: r.allowGlobal };
}
const sortedModels = (models: Readonly<Record<string, string>>): Record<string, string> => Object.fromEntries(Object.entries(models).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** The canonical text sealed in the key store (the same connection always seals the same text). */
export function serializeBedrockConnection(c: BedrockConnection): string {
  return JSON.stringify({ scheme: "assume_role", roleArn: c.roleArn, region: c.region, models: sortedModels(c.models), allowGlobal: c.allowGlobal });
}

export function bedrockSummary(c: BedrockConnection, checks: Readonly<Record<string, BedrockModelCheck>>, checkedAt: number): BedrockSummary {
  return { roleArn: c.roleArn, region: c.region, models: sortedModels(c.models), allowGlobal: c.allowGlobal, checks: { ...checks }, checkedAt };
}
export function validBedrockSummary(v: unknown): v is BedrockSummary {
  const s = record(v); const checks = record(s?.checks);
  if (s === undefined || checks === undefined || !exact(s, ["roleArn", "region", "models", "allowGlobal", "checks", "checkedAt"])) return false;
  if (typeof s.roleArn !== "string" || !BEDROCK_BYO_ROLE_ARN.test(s.roleArn) || typeof s.region !== "string" || !BEDROCK_BYO_REGION.test(s.region) || typeof s.allowGlobal !== "boolean" || !whole(s.checkedAt)) return false;
  if (!validModels(s.models, s.region, s.allowGlobal)) return false;
  const ids = new Set(Object.values(s.models));
  return Object.entries(checks).every(([id, state]) => ids.has(id) && BEDROCK_MODEL_CHECKS.some((c) => c === state));
}

/**
 * The claim on a customer role, unique across every Rovara company of this install (DEC 238 Q5: a role already connected by
 * another company is refused). IAM role names are unique per account ignoring case and path, so the claim is the account and the
 * lower-cased name: `RovaraBedrockInvoke-X` and `rovarabedrockinvoke-x` are the same role.
 */
export function bedrockRoleClaim(roleArn: string): string {
  const match = BEDROCK_BYO_ROLE_ARN.exec(roleArn);
  if (match === null) throw new Error("invalid bedrock role");
  return `${match[1]}:${match[2]!.toLowerCase()}`;
}

/** What the external id's HMAC covers: sha256 of [purpose, install, company] (32 bytes, far under KMS's message limit). */
export function bedrockExternalIdMessage(iss: string, cid: string): Uint8Array {
  return createHash("sha256").update(JSON.stringify([BEDROCK_EXTERNAL_ID_PURPOSE, iss, cid])).digest();
}
export interface MacGenerator { generateMac(input: { KeyId: string; Message: Uint8Array }): Promise<{ Mac?: Uint8Array }> }
const EXTERNAL_IDS_MAX = 5_000;
/**
 * The company's external id, from the gateway's own KMS HMAC key (only the gateway's serving role may GenerateMac with it). The
 * key must never be deleted or replaced: every customer role's trust policy names the ids it makes. Cached per install and
 * company (the id never changes); a failure is never cached.
 */
export class BedrockExternalIds {
  readonly #ids = new Map<string, string>();
  constructor(private readonly kms: MacGenerator, private readonly keyId: string) {}
  async of(iss: string, cid: string): Promise<string> {
    if (typeof iss !== "string" || iss.length === 0 || iss.length > 2048 || typeof cid !== "string" || !COMPANY.test(cid)) throw new Error("bedrock external id unavailable");
    const key = JSON.stringify([iss, cid]);
    const known = this.#ids.get(key);
    if (known !== undefined) return known;
    let mac: Uint8Array | undefined;
    try { mac = (await this.kms.generateMac({ KeyId: this.keyId, Message: bedrockExternalIdMessage(iss, cid) })).Mac; } catch { throw new Error("bedrock external id unavailable"); }
    if (mac === undefined || mac.length !== 32) throw new Error("bedrock external id unavailable");
    const id = `rvb-${Buffer.from(mac).subarray(0, 20).toString("hex")}`;
    while (this.#ids.size >= EXTERNAL_IDS_MAX) { const first = this.#ids.keys().next(); if (first.done === true) break; this.#ids.delete(first.value); }
    this.#ids.set(key, id);
    return id;
  }
}

// ---- The customer's role: template and set-up -------------------------------------------------------------------------------

/** The Regions a geography's system profiles may route to, as an IAM Region pattern (the foundation-model ARNs they need). */
const GEOGRAPHY_REGIONS: Readonly<Record<string, string>> = { us: "us-*", eu: "eu-*", apac: "ap-*", jp: "ap-northeast-*", au: "ap-southeast-*", ca: "ca-*" };
/**
 * The IAM resources the customer's role may invoke for these models (least privilege, AWS's inference-profile prerequisites):
 *   in-Region model    arn:aws:bedrock:<region>::foundation-model/<id>
 *   `<geo>.` profile   the profile in <region> (any account: a system profile exists in the caller's own account only), plus the
 *                      foundation model in every Region of that geography
 *   `global.` profile  the profile, plus the foundation model in every Region and the Region-less ARN global routing uses
 */
export function bedrockResourceArns(c: Pick<BedrockConnection, "region" | "models">): string[] {
  const arns = new Set<string>();
  for (const id of Object.values(c.models)) {
    const geo = geographyOf(id); const base = baseModel(id);
    if (geo === undefined) { arns.add(`arn:aws:bedrock:${c.region}::foundation-model/${id}`); continue; }
    arns.add(`arn:aws:bedrock:${c.region}:*:inference-profile/${id}`);
    if (geo === "global") { arns.add(`arn:aws:bedrock:*::foundation-model/${base}`); arns.add(`arn:aws:bedrock:::foundation-model/${base}`); }
    else arns.add(`arn:aws:bedrock:${GEOGRAPHY_REGIONS[geo] ?? c.region}::foundation-model/${base}`);
  }
  return [...arns].sort();
}

/**
 * The CloudFormation template the company's AWS admin runs (docs/bedrock/rovara-bedrock-role.json is this, byte for byte; a test
 * holds them equal). It is served from the docs site (DEC 238 Q10), never from a public S3 bucket.
 */
export function bedrockRoleTemplate(): Record<string, unknown> {
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "Rovara: lets Rovara's agents call Amazon Bedrock in this account, on the models you chose, and nothing else. Bedrock bills this account.",
    Parameters: {
      CompanyId: { Type: "String", AllowedPattern: "^org_[0-9a-z]{20}$", Description: "Your Rovara company id (Rovara's session name in your CloudTrail)." },
      ExternalId: { Type: "String", AllowedPattern: "^rvb-[0-9a-f]{40}$", Description: "Your company's external id, shown in Rovara's settings." },
      BrokerRoleArn: { Type: "String", AllowedPattern: "^arn:aws:iam::[0-9]{12}:role/RovaraBedrockBroker-[a-z0-9-]{1,32}$", Description: "Rovara's Bedrock broker role, shown in Rovara's settings." },
      ModelResourceArns: { Type: "CommaDelimitedList", Description: "The Bedrock models and inference profiles Rovara may call, shown in Rovara's settings." },
      AllowGlobalRouting: { Type: "String", AllowedValues: ["false", "true"], Default: "false", Description: "true lets calls route to any AWS Region (global profiles): data may leave your geography." },
    },
    Conditions: { DenyGlobalRouting: { "Fn::Equals": [{ Ref: "AllowGlobalRouting" }, "false"] } },
    Resources: {
      RovaraBedrockInvokeRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: { "Fn::Sub": `${BEDROCK_BYO_ROLE_PREFIX}\${CompanyId}` },
          Description: "Rovara agents call Bedrock with this role (invoke only, on the chosen models).",
          MaxSessionDuration: 3600,
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [{
              Sid: "OnlyRovaraForThisCompany", Effect: "Allow", Principal: { AWS: { Ref: "BrokerRoleArn" } }, Action: "sts:AssumeRole",
              Condition: { StringEquals: { "sts:ExternalId": { Ref: "ExternalId" }, "sts:RoleSessionName": { Ref: "CompanyId" } } },
            }],
          },
          Policies: [{
            PolicyName: "InvokeChosenModelsOnly",
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                { Sid: "InvokeChosenModels", Effect: "Allow", Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], Resource: { Ref: "ModelResourceArns" } },
                { "Fn::If": ["DenyGlobalRouting", { Sid: "NoGlobalRouting", Effect: "Deny", Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], Resource: "*", Condition: { StringEquals: { "aws:RequestedRegion": "unspecified" } } }, { Ref: "AWS::NoValue" }] },
              ],
            },
          }],
        },
      },
    },
    Outputs: { RoleArn: { Description: "Paste this into Rovara's settings.", Value: { "Fn::GetAtt": ["RovaraBedrockInvokeRole", "Arn"] } } },
  };
}
/** The template file's exact text (2-space JSON and a final newline). */
export const bedrockRoleTemplateText = (): string => `${JSON.stringify(bedrockRoleTemplate(), null, 2)}\n`;

const TEMPLATE_URL = /^https:\/\/[a-z0-9.-]{1,253}\/[A-Za-z0-9._~/-]{1,512}\.json$/u;
/** A docs-site template URL: https, a plain path to a .json file, and never an S3 host (DEC 238 Q10). */
export function validTemplateUrl(url: unknown): url is string {
  if (typeof url !== "string" || !TEMPLATE_URL.test(url)) return false;
  const host = new URL(url).hostname;
  return !/(?:^|\.)s3[.-]|\.amazonaws\.com$/u.test(host);
}
export interface BedrockSetupInput { templateUrl: string; brokerRoleArn: string; externalId: string; cid: string; region: string; models: Readonly<Record<string, string>>; allowGlobal: boolean }
/**
 * The set-up, run by the customer's AWS admin in AWS CloudShell (opened in their Region). CloudFormation's one-click quick-create
 * link only takes a template stored in Amazon S3 (checked in AWS's docs 2026-11-15), and DEC 238 Q10 rules out a public bucket,
 * so the one step is a single command: fetch the template from the docs site and deploy it with every parameter filled in.
 * Every value is checked first, so the command holds nothing a shell could read as more than one word.
 */
export function bedrockSetupCommand(input: BedrockSetupInput): { cloudShellUrl: string; command: string; stackName: string } {
  if (!validTemplateUrl(input.templateUrl) || !/^arn:aws:iam::[0-9]{12}:role\/RovaraBedrockBroker-[a-z0-9-]{1,32}$/u.test(input.brokerRoleArn)
    || !BEDROCK_EXTERNAL_ID.test(input.externalId) || !COMPANY.test(input.cid) || !BEDROCK_BYO_REGION.test(input.region)
    || typeof input.allowGlobal !== "boolean" || !validModels(input.models, input.region, input.allowGlobal)) throw new Error("invalid bedrock setup");
  const arns = bedrockResourceArns({ region: input.region, models: input.models });
  const stackName = `rovara-bedrock-${input.cid.replace("_", "-")}`;
  const command = [
    `curl -fsSL ${input.templateUrl} -o rovara-bedrock-role.json`,
    `aws cloudformation deploy --region ${input.region} --stack-name ${stackName} --template-file rovara-bedrock-role.json --capabilities CAPABILITY_NAMED_IAM`
      + ` --parameter-overrides CompanyId=${input.cid} ExternalId=${input.externalId} BrokerRoleArn=${input.brokerRoleArn} ModelResourceArns=${arns.join(",")} AllowGlobalRouting=${String(input.allowGlobal)}`,
    `aws cloudformation describe-stacks --region ${input.region} --stack-name ${stackName} --query "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue" --output text`,
  ].join(" && ");
  return { cloudShellUrl: `https://${input.region}.console.aws.amazon.com/cloudshell/home?region=${input.region}`, command, stackName };
}

/**
 * Presets for the model picker: every Claude model Rovara's AI offers (agent-ai.ts ROVARA_AI_US_MODELS), on the system profile of
 * the chosen Region's geography (the first one, e.g. `eu.` from eu-west-1). Empty for a Region with no geography.
 */
export function bedrockModelPresets(region: string, rovaraModels: string): Record<string, string> {
  const geo = BEDROCK_BYO_REGION.test(region) ? geographiesOf(region)[0] : undefined;
  if (geo === undefined) return {};
  const out: Record<string, string> = {};
  for (const pair of rovaraModels.split(",")) {
    const [name, id] = pair.split("=");
    if (name === undefined || id === undefined || !AGENT_MODEL.test(name) || !/^us\.anthropic\./u.test(id)) continue;
    out[name] = `${geo}.${id.slice(3)}`;
  }
  return out;
}
