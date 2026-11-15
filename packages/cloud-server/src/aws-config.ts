// What a deployed Cloud reads at run time rather than from its environment (PrepLabsAI/Rovara-cloud#11):
// - its own public address, from an SSM parameter the stack writes once CloudFront has a domain (the function can't name the
//   distribution that points at it without a cycle);
// - its secret as Rovara Code's sign-in client, from Secrets Manager.
// Both are read once and kept for a few minutes, so a rotated secret or a new address is picked up without a deploy.
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

/** How long a read value is kept before it is read again. */
export const CONFIG_TTL_MS = 5 * 60_000;

export interface CloudRuntimeConfig {
  /** Where people reach Cloud, such as https://d111111abcdef8.cloudfront.net (no trailing slash). */
  origin: string;
  /** Cloud's secret as Code's sign-in client. */
  clientSecret: string;
}

export interface CloudConfigSource {
  /** The SSM parameter holding Cloud's public address. */
  originParameter: string;
  /** The Secrets Manager secret holding Cloud's client secret, as a plain string. */
  clientSecretId: string;
}

export interface CloudConfigClients {
  ssm: Pick<SSMClient, "send">;
  secrets: Pick<SecretsManagerClient, "send">;
  now?: () => number;
}

/** A reader that answers the current config, reading the parameter and the secret again after CONFIG_TTL_MS. */
export function cloudConfigReader(source: CloudConfigSource, clients: CloudConfigClients = { ssm: new SSMClient({}), secrets: new SecretsManagerClient({}) }): () => Promise<CloudRuntimeConfig> {
  const now = clients.now ?? Date.now;
  let cached: { config: CloudRuntimeConfig; at: number } | undefined;
  let reading: Promise<CloudRuntimeConfig> | undefined;
  const read = async (): Promise<CloudRuntimeConfig> => {
    const [parameter, secret] = await Promise.all([
      clients.ssm.send(new GetParameterCommand({ Name: source.originParameter })),
      clients.secrets.send(new GetSecretValueCommand({ SecretId: source.clientSecretId })),
    ]);
    const origin = (parameter.Parameter?.Value ?? "").trim().replace(/\/+$/u, "");
    if (!/^https:\/\/[^/\s]+$/u.test(origin)) throw new Error(`${source.originParameter} must hold Cloud's https address`);
    const clientSecret = (secret.SecretString ?? "").trim();
    if (clientSecret === "") throw new Error(`${source.clientSecretId} is empty`);
    return { origin, clientSecret };
  };
  return async () => {
    if (cached !== undefined && now() - cached.at < CONFIG_TTL_MS) return cached.config;
    // Requests that arrive together share one read.
    reading ??= read().then((config) => { cached = { config, at: now() }; return config; }).finally(() => { reading = undefined; });
    return reading;
  };
}
