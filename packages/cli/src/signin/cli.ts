// The `agentx signin` command group (spec 025 FR-045, FR-046) and the developer sign-in flags that
// agentx init shares (F14), kept out of main.ts. Builds real AWS and Slack clients only when a test
// has not overridden them.
import { agentXError } from "@rovara-code/contracts";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { STSClient } from "@aws-sdk/client-sts";
import type { Command } from "commander";
import { stsCallerIdentity } from "../environments/adopt.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { secretsManagerInitSecrets } from "../init/context.js";
import { processPrompter, unattendedPrompter, type SecretSource, type TextWriter } from "../init/prompts.js";
import { slackWebApi } from "../init/slack-app.js";
import { formatSuccess } from "../output.js";
import { checkLines } from "./check.js";
import { runSigninCloud, type CloudSignInFlags } from "./cloud.js";
import { SIGNIN_FLAG_NAMES, type SigninFlags, type SigninSecretFlags } from "./collect.js";
import { runSigninCheck, runSigninDisable, runSigninEnable, runSigninShow, type SigninServices } from "./commands.js";

/** Keeps only the entries that have a value, so an optional property is absent rather than undefined. */
export function definedEntries<T extends object>(record: { [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

/** A secret's source from its `-file` and `-env` flags; undefined when neither was given (the prompt asks). */
export function secretSource(file?: string, envName?: string): SecretSource | undefined {
  return file === undefined && envName === undefined ? undefined : { ...(file === undefined ? {} : { file }), ...(envName === undefined ? {} : { envName }) };
}

/** The developer sign-in flags, as commander names them from SIGNIN_FLAG_NAMES. */
export interface SignInCommandOptions {
  slackClientId?: string; slackClientSecretFile?: string; slackClientSecretEnv?: string;
  signinOidcIssuer?: string; signinOidcClientId?: string; signinOidcClientSecretFile?: string; signinOidcClientSecretEnv?: string;
  signinOidcRequiredClaim?: string; signinOidcRequiredValues?: string; signinOidcDisplayName?: string;
}

/** Adds the developer sign-in flags (F14): the same names on agentx signin enable and agentx init. */
export function addSignInOptions(command: Command): Command {
  const names = SIGNIN_FLAG_NAMES;
  return command
    .option(`${names.slackClientId} <id>`, "the Slack app's Client ID (Basic Information, App Credentials)")
    .option(`${names.slackClientSecret}-file <path>`, "file holding the Slack app's Client Secret")
    .option(`${names.slackClientSecret}-env <NAME>`, "environment variable holding the Slack app's Client Secret")
    .option(`${names.oidcIssuer} <url>`, "company sign-in issuer URL, for example https://acme.okta.com")
    .option(`${names.oidcClientId} <id>`, "client ID of the company sign-in app")
    .option(`${names.oidcClientSecret}-file <path>`, "file holding the company sign-in app's client secret")
    .option(`${names.oidcClientSecret}-env <NAME>`, "environment variable holding the company sign-in app's client secret")
    .option(`${names.oidcRequiredClaim} <claim>`, "claim a person must carry to use AgentX, for example groups; empty for none")
    .option(`${names.oidcRequiredValues} <values>`, "comma-separated values of the required claim that may use AgentX")
    .option(`${names.oidcDisplayName} <name>`, "name on the sign-in button, for example Okta");
}

export function signInFlags(options: SignInCommandOptions): { flags: SigninFlags; secretFlags: SigninSecretFlags } {
  return {
    flags: definedEntries<SigninFlags>({
      slackClientId: options.slackClientId, oidcIssuer: options.signinOidcIssuer, oidcClientId: options.signinOidcClientId,
      oidcRequiredClaim: options.signinOidcRequiredClaim, oidcRequiredValues: options.signinOidcRequiredValues, oidcDisplayName: options.signinOidcDisplayName,
    }),
    secretFlags: definedEntries<SigninSecretFlags>({
      slackClientSecret: secretSource(options.slackClientSecretFile, options.slackClientSecretEnv),
      oidcClientSecret: secretSource(options.signinOidcClientSecretFile, options.signinOidcClientSecretEnv),
    }),
  };
}

export interface SigninCommandContext {
  /** Test overrides (CliDependencies.signin). */
  overrides?: Partial<SigninServices>;
  /** The CLI's region-scoped SSM store. */
  parameterStore: (region?: string) => ParameterStore;
  fetch: typeof fetch;
  stdout: TextWriter;
  stderr: TextWriter;
}

const globalOptions = (command: Command) => command.optsWithGlobals<{ env: string; json: boolean }>();

export function registerSigninCommands(program: Command, context: SigninCommandContext): void {
  const signin = program.command("signin").description("choose how developers sign in: Slack, your company's sign-in, or both; on a Rovara Cloud install, GitHub and Google (operator role)");
  /** Real AWS and Slack clients for --region, each built only when a test has not overridden it. */
  const signinServices = (region: string | undefined, yes: boolean): SigninServices => {
    const overrides = context.overrides ?? {};
    const config = region === undefined ? {} : { region };
    return {
      store: overrides.store ?? context.parameterStore(region),
      secrets: overrides.secrets ?? secretsManagerInitSecrets(new SecretsManagerClient(config)),
      cloudFormation: overrides.cloudFormation ?? new CloudFormationClient(config),
      ses: overrides.ses ?? new SESv2Client(config),
      identity: overrides.identity ?? stsCallerIdentity(new STSClient(config)),
      fetch: overrides.fetch ?? context.fetch,
      slackApi: overrides.slackApi ?? slackWebApi(context.fetch),
      prompter: overrides.prompter ?? (yes ? unattendedPrompter() : processPrompter(context.stderr)),
      processEnv: overrides.processEnv ?? process.env,
      write: overrides.write ?? ((line) => { context.stderr.write(`${line}\n`); }),
      now: overrides.now ?? Date.now,
      ...(overrides.sleep === undefined ? {} : { sleep: overrides.sleep }),
      ...(overrides.pollMs === undefined ? {} : { pollMs: overrides.pollMs }),
    };
  };
  const signinMethod = (method: string): "slack" | "oidc" => {
    if (method !== "slack" && method !== "oidc") throw agentXError("CONFIG_INVALID", `unknown sign-in method ${JSON.stringify(method)}; use slack or oidc`);
    return method;
  };
  const changedText = (changed: boolean) => (changed ? "Developer sign-in updated.\n" : "Nothing to change.\n");
  const regionOption = "--region <region>";
  const regionHelp = "AWS region of the environment; defaults to your AWS configuration";
  signin
    .command("show")
    .description("show which sign-in methods are on and what the control plane offers")
    .option(regionOption, regionHelp)
    .action(async (options: { region?: string }, command: Command) => {
      const globals = globalOptions(command);
      const result = await runSigninShow(signinServices(options.region, false), globals.env);
      context.stdout.write(globals.json ? formatSuccess(result.data, true) : `${result.lines.join("\n")}\n`);
    });
  addSignInOptions(
    signin
      .command("enable")
      .description("turn on Slack sign-in or company sign-in; shows the change to the control plane and asks first")
      .argument("<method>", "slack or oidc")
      .option(regionOption, regionHelp)
      .option("--yes", "apply without asking; the change is still printed", false),
  ).action(async (method: string, options: SignInCommandOptions & { region?: string; yes: boolean }, command: Command) => {
    const globals = globalOptions(command);
    const { flags, secretFlags } = signInFlags(options);
    const result = await runSigninEnable(signinServices(options.region, options.yes), globals.env, signinMethod(method), flags, secretFlags, options.yes);
    context.stdout.write(globals.json ? formatSuccess(result, true) : changedText(result.changed));
  });
  signin
    .command("disable")
    .description("turn a sign-in method off; everyone signed in with it is signed out")
    .argument("<method>", "slack or oidc")
    .option(regionOption, regionHelp)
    .option("--yes", "apply without asking; the change is still printed", false)
    .action(async (method: string, options: { region?: string; yes: boolean }, command: Command) => {
      const globals = globalOptions(command);
      const result = await runSigninDisable(signinServices(options.region, options.yes), globals.env, signinMethod(method), options.yes);
      context.stdout.write(globals.json ? formatSuccess(result, true) : changedText(result.changed));
    });
  signin
    .command("cloud")
    .description("turn GitHub and Google sign-in on, change or off, and choose the sender of sign-in code emails, on a Rovara Cloud install; shows the change and asks first")
    .option("--github-client-id <id>", "the GitHub OAuth app's client id (with --github-client-secret-arn)")
    .option("--github-client-secret-arn <arn>", "the Secrets Manager secret holding the GitHub OAuth client secret as {\"clientSecret\": ...}; its name must start with agentx/<env>/")
    .option("--google-client-id <id>", "the Google OAuth client id (with --google-client-secret-arn)")
    .option("--google-client-secret-arn <arn>", "the Secrets Manager secret holding the Google client secret as {\"clientSecret\": ...}; its name must start with agentx/<env>/")
    .option("--email-from <sender>", "send sign-in codes from this Amazon SES sender, \"Name <address>\" or an address; its domain must be verified in SES in the environment's region")
    .option("--no-email-from", "send sign-in codes from Amazon Cognito's default sender again")
    .option("--custom-domain <name>", "put the control plane at this DNS name too, for example staging.rovara.dev (with --hosted-zone-id); applied by the next agentx upgrade. The API's own address keeps working")
    .option("--hosted-zone-id <id>", "the Route 53 hosted zone, in this account, that holds the custom domain's DNS; only the domain's own records are added to it")
    .option("--no-custom-domain", "take the custom domain off again (the API's own address was never turned off)")
    .option("--no-github", "turn GitHub sign-in off")
    .option("--no-google", "turn Google sign-in off")
    .option(regionOption, regionHelp)
    .option("--yes", "apply without asking; the change is still printed", false)
    .action(async (options: { githubClientId?: string; githubClientSecretArn?: string; googleClientId?: string; googleClientSecretArn?: string; emailFrom?: string | false; customDomain?: string | false; hostedZoneId?: string; github: boolean; google: boolean; region?: string; yes: boolean }, command: Command) => {
      const globals = globalOptions(command);
      const flags = definedEntries<CloudSignInFlags>({
        githubClientId: options.githubClientId, githubClientSecretArn: options.githubClientSecretArn,
        googleClientId: options.googleClientId, googleClientSecretArn: options.googleClientSecretArn,
        // With both --email-from and --no-email-from declared, commander sets false for the negated one.
        emailFrom: typeof options.emailFrom === "string" ? options.emailFrom : undefined, noEmailFrom: options.emailFrom === false ? true : undefined,
        customDomain: typeof options.customDomain === "string" ? options.customDomain : undefined, noCustomDomain: options.customDomain === false ? true : undefined,
        hostedZoneId: options.hostedZoneId,
        // commander names a lone --no-<x> option <x>, true unless the flag was given.
        noGithub: options.github ? undefined : true, noGoogle: options.google ? undefined : true,
      });
      const result = await runSigninCloud(signinServices(options.region, options.yes), globals.env, flags, options.yes);
      context.stdout.write(globals.json ? formatSuccess(result, true) : [
        result.changed ? "Cloud sign-in updated.\n" : "Nothing to change.\n",
        ...(result.githubCallbackUrl === undefined ? [] : [`Register this authorization callback URL with the GitHub OAuth app: ${result.githubCallbackUrl}\n`]),
        ...(result.googleRedirectUri === undefined ? [] : [`Register this authorized redirect URI with the Google OAuth app: ${result.googleRedirectUri}\n`]),
      ].join(""));
    });
  signin
    .command("check")
    .description("check every piece developer sign-in needs, and say what to fix")
    .option(regionOption, regionHelp)
    .action(async (options: { region?: string }, command: Command) => {
      const globals = globalOptions(command);
      const checks = await runSigninCheck(signinServices(options.region, false), globals.env);
      context.stdout.write(globals.json ? formatSuccess(checks, true) : `${checkLines(checks).join("\n")}\n`);
      const failed = checks.filter((check) => !check.ok).length;
      if (failed > 0) throw agentXError("CONFIG_INVALID", `${failed} developer sign-in check${failed === 1 ? "" : "s"} failed; fix what each one names, then run agentx signin check again`);
    });
}
