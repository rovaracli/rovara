// agentx github oauth set (Plan 2, Task 12): the shared GitHub App of a Rovara Cloud install asks each installer for user
// authorization, so its OAuth client id and client secret must be in the App secret. A new App gets both from GitHub's manifest
// conversion; an App made before this plan has neither, and this command stores them. Only that App secret changes: the other
// fields (the private key, the webhook secret) are kept as they are. The client secret is read hidden (or from stdin), is never
// printed or logged, and is never put in an error.
import { agentXError } from "@rovara-code/contracts";
import { readEnvironmentSettings, type EnvironmentSettings } from "../environments/settings.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { InitSecrets } from "../init/context.js";
import { appSettingsUrl, githubAppJwt, githubAppSecretName, githubInstallCallbackUrl, parseAppSecret, type GitHubApi } from "../init/github-app.js";
import { cleanSecret, secretFromSource, type Prompter } from "../init/prompts.js";

export interface GithubOauthServices {
  store: ParameterStore;
  secrets: Pick<InitSecrets, "get" | "put">;
  /** Only the App's own lookup: its owner decides which settings page the checklist names. */
  github: Pick<GitHubApi, "getApp">;
  prompter: Prompter;
  processEnv: NodeJS.ProcessEnv;
  write: (line: string) => void;
  now: () => number;
  /** All of standard input, for --client-secret-stdin. */
  readStdin: () => Promise<string>;
}

export interface GithubOauthFlags { clientId: string; clientSecretStdin?: boolean }

const CLIENT_ID = /^[A-Za-z0-9._-]{1,100}$/;

/** The secret's JSON object, so every field this code does not know stays. Never throws a parser error, which quotes input. */
function secretObject(raw: string, name: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* the one message below; never echo the value */ }
  throw agentXError("CONFIG_INVALID", `secret ${name} is not an AgentX GitHub App secret`);
}

/** What to change on an App created before this plan, by hand, because GitHub's API cannot change these settings. */
export function oauthChecklist(input: { settingsUrl: string; installCallbackUrl: string }): string[] {
  return [
    `In the GitHub App settings (${input.settingsUrl}):`,
    "1. Make it public (Advanced, Make public).",
    `2. Set the Callback URL to ${input.installCallbackUrl}.`,
    "3. Tick Request user authorization (OAuth) during installation, and Redirect on update.",
    "4. Under Permissions, Organization permissions, set Members to Read-only.",
    "5. Generate a client secret, and paste it here.",
  ];
}

export async function runGithubOauthSet(services: GithubOauthServices, env: string, flags: GithubOauthFlags): Promise<{ env: string }> {
  const clientId = flags.clientId.trim();
  if (!CLIENT_ID.test(clientId)) throw agentXError("CONFIG_INVALID", "--client-id is the GitHub App's Client ID (General, About, Client ID), for example Iv23li...; it has no spaces");
  const settings: EnvironmentSettings | undefined = await readEnvironmentSettings(services.store, env);
  if (settings === undefined) throw agentXError("CONFIG_INVALID", `environment ${env} is not installed in this account and region; check --env and --region`);
  if (settings.cloud !== true) throw agentXError("CONFIG_INVALID", "only a Rovara Cloud install connects GitHub per organization");
  const name = githubAppSecretName(env);
  const raw = await services.secrets.get(name);
  if (raw === undefined) throw agentXError("CONFIG_INVALID", `secret ${name} does not exist; run agentx init so its GitHub App step creates the App`);
  const app = parseAppSecret(raw, name);
  const stored = secretObject(raw, name);

  const github = await services.github.getApp(githubAppJwt({ appId: app.appId, privateKey: app.privateKey, nowSeconds: Math.floor(services.now() / 1000) }));
  for (const line of oauthChecklist({ settingsUrl: appSettingsUrl(github.owner, app.slug), installCallbackUrl: githubInstallCallbackUrl(settings.controlPlaneUrl) })) services.write(line);

  const clientSecret = flags.clientSecretStdin === true
    ? cleanSecret(await services.readStdin(), "GitHub App client secret")
    : await secretFromSource({ what: "GitHub App client secret", flag: "--client-secret-stdin", source: {}, processEnv: services.processEnv, prompter: services.prompter });
  try {
    await services.secrets.put(name, JSON.stringify({ ...stored, clientId, clientSecret }));
  } catch (error) {
    // Only the error's name: never its message or cause, which could echo the request.
    throw agentXError("RUNTIME_UNAVAILABLE", `could not store the client secret in ${name} (${error instanceof Error ? error.name : "unknown error"})`);
  }
  return { env };
}
