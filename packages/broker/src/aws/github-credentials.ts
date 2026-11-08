// The GitHub App credentials as the broker and the plan evidence job build them: one definition, from the same environment
// (GITHUB_APP_CREDENTIAL_REF, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_SECRET_ARN) and the same secret.
import { GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { agentXError } from "@agentx/contracts";
import { appIdFromSecret, GitHubAppCredentialProvider, type GitHubAppCredentialProviderOptions, isWebhookSecretMissing, privateKeyFromSecret, webhookSecretFromSecret } from "../github-app.js";
import { requiredEnvironment } from "./lambda.js";

export interface GitHubAppCredentials {
  provider: GitHubAppCredentialProvider;
  /** The secret's ARN, for the connector credential registry. */
  privateKeySecretArn: string;
  /**
   * Reads the GitHub webhook HMAC key from the same secret. A copy with no valid key, or `refresh: true`, re-reads the
   * secret (at most once per REREAD_INTERVAL_MS per container), so a key added or changed after the container started is
   * picked up without a redeploy.
   */
  webhookSecret: (options?: { refresh?: boolean }) => Promise<string>;
  /**
   * Whether the App is set up on this install: its secret has a version and names an App (`agentx init` creates both). False is a state, not a failure: the Team record's GitHub sweeps skip an install with no App
   * instead of failing every hour. A secret that cannot be read for any other reason also answers false (the sweep tries again next hour).
   */
  ready: () => Promise<boolean>;
}

const REREAD_INTERVAL_MS = 30_000;

export function createGitHubAppCredentials(
  secretsManager: Pick<SecretsManagerClient, "send">,
  /** Rovara Cloud: refuses every token for an org whose GitHub connection does not hold the installation (Plan 2, Task 15). Absent elsewhere. */
  cloud?: Pick<GitHubAppCredentialProviderOptions, "requireInstallationBound">,
): GitHubAppCredentials {
  const privateKeySecretArn = requiredEnvironment("GITHUB_APP_PRIVATE_KEY_SECRET_ARN");
  const appIdSetting = process.env.GITHUB_APP_ID ?? "";
  let appSecret: Promise<string> | undefined;
  const loadSecret = (): Promise<string> => {
    appSecret ??= secretsManager.send(new GetSecretValueCommand({
      SecretId: privateKeySecretArn,
    })).then((response) => {
      const secret = response.SecretString ?? (
        response.SecretBinary === undefined
          ? undefined
          : Buffer.from(response.SecretBinary).toString("utf8")
      );
      if (!secret) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App private-key secret is empty");
      return secret;
    }).catch((error: unknown) => {
      appSecret = undefined;
      // The secret has no version until `agentx init` creates the GitHub App.
      if (error instanceof Error && error.name === "ResourceNotFoundException") {
        throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App private-key secret is empty; finish agentx init to create the GitHub App");
      }
      throw error;
    });
    return appSecret;
  };
  let app: Promise<{ appId: string; privateKey: string }> | undefined;
  const loadApp = (): Promise<{ appId: string; privateKey: string }> => {
    app ??= loadSecret().then((secret) => ({
      appId: appIdSetting !== "" ? appIdSetting : appIdFromSecret(secret),
      privateKey: privateKeyFromSecret(secret),
    })).catch((error: unknown) => {
      app = undefined;
      throw error;
    });
    return app;
  };
  // Forced re-reads are spaced out so a stream of unsigned requests cannot hammer Secrets Manager.
  let lastReread: number | undefined;
  const reread = (): Promise<string> => {
    const now = Date.now();
    if (lastReread === undefined || now - lastReread >= REREAD_INTERVAL_MS) {
      lastReread = now;
      appSecret = undefined;
      app = undefined;
    }
    return loadSecret();
  };
  const provider = new GitHubAppCredentialProvider({
    credentialRef: requiredEnvironment("GITHUB_APP_CREDENTIAL_REF"),
    appId: appIdSetting !== "" ? appIdSetting : async () => (await loadApp()).appId,
    getPrivateKey: () => loadSecret().then(privateKeyFromSecret),
    // The slug and the OAuth client come from the same secret; a forced read is spaced out like the webhook secret's.
    getAppSecret: (options) => (options?.refresh === true ? reread() : loadSecret()),
    ...(cloud?.requireInstallationBound === undefined ? {} : { requireInstallationBound: cloud.requireInstallationBound }),
    // What each repository token was asked for and what GitHub says it granted (v0.4.9 staging: a clone was refused although the exchange had answered 200 and nothing was logged).
    onTokenIssued: (issued) => console.log(JSON.stringify({ component: "broker", event: "github.installation_token_issued", ...issued })),
    // v0.4.9 staging: a clone sometimes got "Repository not found" for a token GitHub had just issued; each repository token is checked before the worker gets it.
    tokenReadiness: { onProbe: (event) => console.log(JSON.stringify({ component: "broker", event: "github.installation_token_probe", ...event })) },
  });
  const webhookSecret = async (options?: { refresh?: boolean }): Promise<string> => {
    if (options?.refresh === true) return webhookSecretFromSecret(await reread());
    try {
      return webhookSecretFromSecret(await loadSecret());
    } catch (error) {
      if (isWebhookSecretMissing(error)) return webhookSecretFromSecret(await reread());
      throw error;
    }
  };
  const ready = (): Promise<boolean> => loadApp().then(() => true, () => false);
  return { provider, privateKeySecretArn, webhookSecret, ready };
}
