// Convergence lane A3 (Cloud adapter, private): a company's own Amazon Bedrock role as a `model-provider` adapter on Code's port.
//
// It is Code's `bedrockModelProvider` (the address, the AWS Signature Version 4 sign-in, the formats and the capability rows are Code's, unchanged); only the credential is Cloud's: the role the
// company named in its AI source, assumed for 15 minutes with the company's external id (`rovara-<company>`, `bedrockExternalId`) and the session name the model proxy already uses
// (`rovara-<company>`, model-proxy/sources.ts), so the company's trust policy and its CloudTrail see the same caller as today. The session is cached until a minute before it expires, and calls
// that find it expired share one AssumeRole. AWS's own words (they quote the ARN) never leave: the problem is a fixed sentence.
//
// A provider is install-wide in Code's registry while a role is one company's, so a company's role providers are NEVER put in the shared registry: `companyBedrockProviders` builds them per
// company and answers only the calling company's ids, so company A can never select company B's role. The id `amazon-bedrock` stays Code's (the install's own Bedrock).
import { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { bedrockModelProvider } from "@rovara-code/broker";
import { MODEL_PROVIDER_ID_PATTERN, OrgIdSchema, assertModelProvider, bedrockExternalId, type ModelProviderAdapter, type ModelProviderPrices, type OrgId } from "@rovara-code/contracts";

const ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/u;
const AWS_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/u;
const SESSION_SECONDS = 900;
const REFRESH_BEFORE_MS = 60_000;
export const BEDROCK_ROLE_PROBLEM = "the company's Bedrock role could not be assumed; check its trust policy and external id";

export interface RoleStsClient {
  send(command: AssumeRoleCommand): Promise<{ Credentials?: { AccessKeyId?: string | undefined; SecretAccessKey?: string | undefined; SessionToken?: string | undefined; Expiration?: Date | undefined } | undefined }>;
}

export interface CloudBedrockRoleOptions {
  orgId: OrgId;
  region: string;
  roleArn: string;
  /** The provider id. Default `bedrock-<the company id without org_>`. */
  kind?: string;
  defaultModel?: string;
  prices?: ModelProviderPrices;
  sts: RoleStsClient;
  now?: () => number;
}

export function cloudBedrockRoleProvider(options: CloudBedrockRoleOptions): ModelProviderAdapter {
  if (!OrgIdSchema.safeParse(options.orgId).success) throw new Error("a company Bedrock role belongs to a company id");
  if (!ROLE_ARN.test(options.roleArn)) throw new Error("a company Bedrock role is an IAM role ARN");
  if (!AWS_REGION.test(options.region)) throw new Error("a company Bedrock role names an AWS region");
  const kind = options.kind ?? `bedrock-${options.orgId.slice(4)}`;
  if (!MODEL_PROVIDER_ID_PATTERN.test(kind) || kind === "amazon-bedrock") throw new Error("a company Bedrock role's provider id is its own plain id, not amazon-bedrock");
  const now = options.now ?? Date.now;
  // Always the company's own external id, never a caller's choice: a role trusting `rovara-<company A>` can then never be assumed on behalf of company B (confused deputy).
  const externalId = bedrockExternalId(options.orgId);
  let cached: { value: { accessKeyId: string; secretAccessKey: string; sessionToken: string }; until: number } | undefined;
  let inflight: Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> | undefined;
  let problem: string | undefined;
  const credentials = () => {
    if (cached !== undefined && cached.until > now()) return Promise.resolve(cached.value);
    inflight ??= (async () => {
      try {
        const out = await options.sts.send(new AssumeRoleCommand({ RoleArn: options.roleArn, RoleSessionName: `rovara-${options.orgId}`, ExternalId: externalId, DurationSeconds: SESSION_SECONDS }));
        const got = out.Credentials;
        if (got?.AccessKeyId === undefined || got.SecretAccessKey === undefined || got.SessionToken === undefined) throw new Error("no credentials");
        const value = { accessKeyId: got.AccessKeyId, secretAccessKey: got.SecretAccessKey, sessionToken: got.SessionToken };
        cached = { value, until: (got.Expiration?.getTime() ?? now() + SESSION_SECONDS * 1_000) - REFRESH_BEFORE_MS };
        problem = undefined;
        return value;
      } catch {
        cached = undefined;
        problem = BEDROCK_ROLE_PROBLEM;
        throw new Error(BEDROCK_ROLE_PROBLEM);
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };
  const base = bedrockModelProvider({
    region: options.region,
    credentials,
    ...(options.defaultModel === undefined ? {} : { defaultModel: options.defaultModel }),
    ...(options.prices === undefined ? {} : { prices: options.prices }),
  });
  return assertModelProvider({ ...base, kind, name: "Amazon Bedrock (company role)", credentialProblem: () => problem ?? base.credentialProblem?.() });
}

/** A company's Bedrock role source, as its AI sources record it. */
export interface CompanyBedrockRoleSource {
  sourceId: string;
  region: string;
  roleArn: string;
  defaultModel?: string;
  prices?: ModelProviderPrices;
}

const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,9}$/u;

/** A source that was not used, and why (a fixed sentence: no ARN). The company's other sources still serve. */
export interface SkippedBedrockSource {
  sourceId: string;
  reason: string;
}

export interface CompanyBedrockProviderSet {
  providers: ReadonlyMap<string, ModelProviderAdapter>;
  skipped: readonly SkippedBedrockSource[];
}

/**
 * The per-company view of company Bedrock roles. `select(companyId, kind)` answers a provider only when that id is one of THAT company's sources; another company's id (or any id built for
 * another company) is undefined.
 *
 * Live data: the company's source list is read on EVERY call, so a deleted or changed source stops being used at once. Only the built provider (and so its AssumeRole session) is kept, keyed
 * by everything that defines it (company, source id, role ARN, region, default model, prices); a changed source gets a new provider and the old one is dropped. A source that cannot be used
 * (a bad id, a duplicate id, a bad ARN or region) is skipped with a reason; it never takes the company's other sources down. A duplicate id is skipped in EVERY copy (neither is trusted).
 */
export function companyBedrockProviders(options: { sts: RoleStsClient; sources: (orgId: OrgId) => Promise<readonly CompanyBedrockRoleSource[]>; now?: () => number }) {
  const kept = new Map<string, ModelProviderAdapter>();
  const keyOf = (orgId: OrgId, source: CompanyBedrockRoleSource): string =>
    JSON.stringify([orgId, source.sourceId, source.roleArn, source.region, source.defaultModel ?? null, source.prices ?? null]);
  const forCompany = async (orgId: OrgId): Promise<CompanyBedrockProviderSet> => {
    if (!OrgIdSchema.safeParse(orgId).success) throw new Error("company Bedrock roles are looked up by company id");
    const sources = await options.sources(orgId);
    const counts = new Map<string, number>();
    for (const source of sources) counts.set(source.sourceId, (counts.get(source.sourceId) ?? 0) + 1);
    const providers = new Map<string, ModelProviderAdapter>();
    const skipped: SkippedBedrockSource[] = [];
    const live = new Set<string>();
    for (const source of sources) {
      const sourceId = String(source.sourceId).slice(0, 40);
      if (!SOURCE_ID.test(source.sourceId)) { skipped.push({ sourceId, reason: "the source id is not a short plain id" }); continue; }
      if ((counts.get(source.sourceId) ?? 0) > 1) { skipped.push({ sourceId, reason: "two sources of this company have this id" }); continue; }
      const key = keyOf(orgId, source);
      let provider = kept.get(key);
      if (provider === undefined) {
        try {
          provider = cloudBedrockRoleProvider({
            orgId, region: source.region, roleArn: source.roleArn, sts: options.sts, kind: `bedrock-${orgId.slice(4)}-${source.sourceId}`,
            ...(source.defaultModel === undefined ? {} : { defaultModel: source.defaultModel }), ...(source.prices === undefined ? {} : { prices: source.prices }), ...(options.now === undefined ? {} : { now: options.now }),
          });
        } catch {
          skipped.push({ sourceId, reason: "the source's role, region, model or prices are not valid" });
          continue;
        }
        kept.set(key, provider);
      }
      live.add(key);
      providers.set(provider.kind, provider);
    }
    // Providers of this company's sources that are gone or changed are dropped, so the cache holds only what is live.
    const prefix = JSON.stringify([orgId]).slice(0, -1);
    for (const key of kept.keys()) if (key.startsWith(`${prefix},`) && !live.has(key)) kept.delete(key);
    return { providers, skipped };
  };
  return {
    forCompany,
    async select(orgId: OrgId, kind: string): Promise<ModelProviderAdapter | undefined> {
      return (await forCompany(orgId)).providers.get(kind);
    },
  };
}
