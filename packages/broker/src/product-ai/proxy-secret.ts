// TE-F1e step (d): how the ProductModelEgress function reads ONE product key. It assumes F1-d's ProductAiSecretsRole with the session tags `rovara:org=<org>` and `rovara:purpose=proxy` and a session policy
// narrowed to the one secret (F1-d's `productAiProxySessionPolicy`), then reads that secret's exact version. The function's own role has NO Secrets Manager permission: the tagged session is the only way to a key,
// and the role's policy text (F1-d) lets a proxy session read only a secret whose `rovara:org` tag is the session's org.
//
// Sessions and keys are cached per (org, project, source, secret version) for at most 10 minutes, inside ONE warm instance, and never keyed by anything a frame says: the key of the cache is built only from the
// source record the function loaded for the capability's own company and project. The cache is bounded (oldest dropped first).
import { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import type { OrgId } from "@rovara-code/contracts";
import type { AssumedCredentials, SecretsClient, StsClient } from "../connections/org-secrets.js";
import type { ProductAiProxySessionPolicy, ProductSourceForRow } from "./seams.js";

export const PROXY_SESSION_CACHE_MS = 10 * 60 * 1000;
const PROXY_SESSION_SECONDS = 900;
const CACHE_MAX = 256;
/** A session is not reused in its last minute. */
const EXPIRY_MARGIN_MS = 60 * 1000;

export interface ProxySecretReaderInput {
  /** ProductAiSecretsRole's ARN (built from the environment, like the other fixed-name roles). */
  readonly roleArn: string;
  /** `arn:<partition>:secretsmanager:<region>:<account>:secret:` */
  readonly secretArnPrefix: string;
  readonly sts: StsClient;
  readonly secretsFor: (credentials: AssumedCredentials) => SecretsClient;
  readonly sessionPolicy: ProductAiProxySessionPolicy;
  readonly now?: () => number;
}

/** The one key for a source, or undefined when it cannot be read (any failure: the caller answers its fixed refusal, never the failure's words). */
export interface ProxySecretReader {
  keyFor(orgId: OrgId, source: ProductSourceForRow): Promise<string | undefined>;
  /** For tests: how many cache entries are held. */
  size(): number;
}

/** The cache key: from the loaded source record only. */
export const proxyCacheKey = (orgId: OrgId, source: Pick<ProductSourceForRow, "project" | "sourceId" | "secretVersionId">): string => JSON.stringify([orgId, source.project, source.sourceId, source.secretVersionId]);

export function createProxySecretReader(input: ProxySecretReaderInput): ProxySecretReader {
  const now = input.now ?? Date.now;
  const cache = new Map<string, { key: string; untilMs: number }>();
  return {
    size: () => cache.size,
    async keyFor(orgId, source) {
      if (source.orgId !== orgId) return undefined;
      const cacheKey = proxyCacheKey(orgId, source);
      const held = cache.get(cacheKey);
      if (held !== undefined && held.untilMs > now()) return held.key;
      cache.delete(cacheKey);
      try {
        const assumed = await input.sts.send(new AssumeRoleCommand({
          RoleArn: input.roleArn,
          RoleSessionName: "product-model-egress",
          DurationSeconds: PROXY_SESSION_SECONDS,
          Tags: [{ Key: "rovara:org", Value: orgId }, { Key: "rovara:purpose", Value: "proxy" }],
          Policy: input.sessionPolicy(input.secretArnPrefix, source.secretName),
        }));
        const credentials = assumed.Credentials;
        if (credentials?.AccessKeyId === undefined || credentials.SecretAccessKey === undefined || credentials.SessionToken === undefined || credentials.Expiration === undefined) return undefined;
        const expiration = new Date(credentials.Expiration);
        const client = input.secretsFor({ accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken, expiration });
        const answer = await client.send(new GetSecretValueCommand({ SecretId: source.secretArn, VersionId: source.secretVersionId }));
        const key = answer.SecretString;
        if (typeof key !== "string" || key.length === 0) return undefined;
        const untilMs = Math.min(now() + PROXY_SESSION_CACHE_MS, expiration.getTime() - EXPIRY_MARGIN_MS);
        if (untilMs > now()) {
          if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
          cache.set(cacheKey, { key, untilMs });
        }
        return key;
      } catch {
        return undefined;
      }
    },
  };
}
