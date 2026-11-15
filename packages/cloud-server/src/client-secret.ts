// Cloud's secret as Code's sign-in client, read from Secrets Manager at run time (migration plan v3.2, 7.2 change 4),
// never from the task's environment. Kept in memory for a few minutes so a changed secret is picked up without a restart.
// The secret and the cause of a failed read never reach a log or an error.
import { GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/** Reads the client secret when a call to Code's token endpoint needs it. */
export type SecretReader = () => Promise<string>;

export class ClientSecretUnavailable extends Error {
  constructor() {
    super("Rovara Cloud couldn't read its Code client secret.");
    this.name = "ClientSecretUnavailable";
  }
}

const KEEP_MS = 5 * 60_000;

export function secretsManagerSecret(secrets: Pick<SecretsManagerClient, "send">, secretId: string, options: { now?: () => number } = {}): SecretReader {
  const now = options.now ?? Date.now;
  let kept: { value: string; until: number } | undefined;
  return async () => {
    if (kept !== undefined && now() < kept.until) return kept.value;
    let value: string | undefined;
    try {
      value = (await secrets.send(new GetSecretValueCommand({ SecretId: secretId }))).SecretString?.trim();
    } catch {
      value = undefined;
    }
    if (value === undefined || value === "") throw new ClientSecretUnavailable();
    kept = { value, until: now() + KEEP_MS };
    return value;
  };
}
