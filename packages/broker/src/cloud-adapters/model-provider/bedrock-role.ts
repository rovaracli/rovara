// Convergence lane A3 (Cloud adapter, private): a company's own Amazon Bedrock role as a `model-provider` adapter on Code's port.
//
// It is Code's `bedrockModelProvider` (the address, the AWS Signature Version 4 sign-in, the formats and the capability rows are Code's, unchanged); only the credential is Cloud's: the role the
// company named in its AI source, assumed for 15 minutes with the company's external id (`rovara-<company>`, `bedrockExternalId`) and the session name the model proxy already uses
// (`rovara-<company>`, model-proxy/sources.ts), so the company's trust policy and its CloudTrail see the same caller as today. The session is cached until a minute before it expires, and calls
// that find it expired share one AssumeRole. AWS's own words (they quote the ARN) never leave: the problem is a fixed sentence.
//
// A provider is install-wide in Code's registry while a role is one company's, so each company source is its own adapter with its own id (`kind`, default `bedrock-<company tail>`); the id
// `amazon-bedrock` stays Code's (the install's own Bedrock).
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
  /** Default `bedrockExternalId(orgId)`, what the company's trust policy was told to require. */
  externalId?: string;
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
  const externalId = options.externalId ?? bedrockExternalId(options.orgId);
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
