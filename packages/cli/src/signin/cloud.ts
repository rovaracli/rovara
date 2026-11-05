// agentx signin cloud (Task 24): turn sign in with GitHub and Google on, change or off on an installed
// Rovara Cloud environment. init is the only other place these are set, and a resumed init refuses a
// changed answer, so an installed environment could never turn them on. The change goes where init
// stores it (the environment settings' cloudSignIn and init's own answers, so a later resume does not
// refuse the new value) and into the control-plane stack's parameters, which deploy and upgrade read
// back from the same settings. Runs under the environment lock. No secret value is read or printed.
// --email-from (Task 7) also sets the sender of the sign-in code email: Amazon SES must have verified the sending
// domain, and the account's sandbox status is reported (a warning, never a refusal).
import { DescribeStacksCommand, type Stack } from "@aws-sdk/client-cloudformation";
import { GetAccountCommand, GetEmailIdentityCommand } from "@aws-sdk/client-sesv2";
import { AgentXError, agentXError, environmentStackName } from "@agentx/contracts";
import { CloudSignInAnswersSchema, type CloudSignInAnswers } from "../deploy/answer-schemas.js";
import { updateStackParameters } from "../deploy/parameter-update.js";
import { withEnvironmentLock } from "../environments/lock.js";
import { readEnvironmentSettings, writeEnvironmentSettings, type EnvironmentSettings } from "../environments/settings.js";
import { readInstallAnswers, writeInstallAnswers } from "../init/install-state.js";
import { errorReason } from "./apply.js";
import { installed, type SigninServices } from "./commands.js";
import { describeEmailSender } from "./settings.js";

export interface CloudSignInFlags {
  githubClientId?: string; githubClientSecretArn?: string;
  googleClientId?: string; googleClientSecretArn?: string;
  noGithub?: boolean; noGoogle?: boolean;
  /** `Name <address>` or an address: the sender of the sign-in code email, sent through Amazon SES. */
  emailFrom?: string; noEmailFrom?: boolean;
  /** 0.5.7: a DNS name for the control plane, with the Route 53 hosted zone (in this account) that holds its DNS. Recorded in the settings; `agentx upgrade` applies it. */
  customDomain?: string; hostedZoneId?: string; noCustomDomain?: boolean;
}

export interface CloudSignInResult {
  changed: boolean;
  /** Register this as the GitHub OAuth app's authorization callback URL (the stack's CloudIdentityGitHubCallbackUrl output). */
  githubCallbackUrl?: string;
  /** Register this as the Google OAuth app's authorized redirect URI (CloudIdentityGoogleRedirectUri). */
  googleRedirectUri?: string;
}

type Method = "github" | "google";
const METHODS: Record<Method, { label: string; idFlag: string; arnFlag: string; offFlag: string; idParameter: string; arnParameter: string; idKey: "githubClientId" | "googleClientId"; arnKey: "githubClientSecretArn" | "googleClientSecretArn" }> = {
  github: { label: "GitHub", idFlag: "--github-client-id", arnFlag: "--github-client-secret-arn", offFlag: "--no-github", idParameter: "GitHubClientId", arnParameter: "GitHubClientSecretArn", idKey: "githubClientId", arnKey: "githubClientSecretArn" },
  google: { label: "Google", idFlag: "--google-client-id", arnFlag: "--google-client-secret-arn", offFlag: "--no-google", idParameter: "GoogleClientId", arnParameter: "GoogleClientSecretArn", idKey: "googleClientId", arnKey: "googleClientSecretArn" },
};
const METHOD_IDS = Object.keys(METHODS) as Method[];

const SECRET_ARN = /^arn:aws[a-z-]*:secretsmanager:([a-z0-9-]+):(\d{12}):secret:(.+)$/;
/** Secrets Manager adds a hyphen and six random characters to a secret's name to make its ARN. */
const SECRET_SUFFIX = /^(.+)-[A-Za-z0-9]{6}$/;

/** The secret's name inside its ARN, which is all that is shown of it. */
const secretNameOf = (arn: string): string => SECRET_SUFFIX.exec(SECRET_ARN.exec(arn)?.[3] ?? "")?.[1] ?? arn;

const describeMethod = (id: string | undefined, arn: string | undefined): string => (id === undefined || arn === undefined ? "off" : `on (client ${id}, secret ${secretNameOf(arn)})`);

/** The flags' own rules, which need no AWS call: each pair goes together, and --no-<method> stands alone. */
function checkFlags(flags: CloudSignInFlags): void {
  const off: Record<Method, boolean | undefined> = { github: flags.noGithub, google: flags.noGoogle };
  const given: Record<Method, [string | undefined, string | undefined]> = {
    github: [flags.githubClientId, flags.githubClientSecretArn], google: [flags.googleClientId, flags.googleClientSecretArn],
  };
  for (const method of METHOD_IDS) {
    const { label, idFlag, arnFlag, offFlag } = METHODS[method];
    const [id, arn] = given[method];
    if (off[method] === true && (id !== undefined || arn !== undefined)) throw agentXError("CONFIG_INVALID", `${offFlag} cannot be combined with ${idFlag} or ${arnFlag}`);
    if ((id === undefined) !== (arn === undefined)) {
      throw agentXError("CONFIG_INVALID", `${idFlag} and ${arnFlag} go together (omit both to leave ${label} sign-in as it is, or use ${offFlag} to turn it off)`);
    }
  }
  if (flags.noEmailFrom === true && flags.emailFrom !== undefined) throw agentXError("CONFIG_INVALID", "--no-email-from cannot be combined with --email-from");
  if (flags.emailFrom !== undefined) parseSender(flags.emailFrom);
  if (flags.noCustomDomain === true && (flags.customDomain !== undefined || flags.hostedZoneId !== undefined)) throw agentXError("CONFIG_INVALID", "--no-custom-domain cannot be combined with --custom-domain or --hosted-zone-id");
  if ((flags.customDomain === undefined) !== (flags.hostedZoneId === undefined)) {
    throw agentXError("CONFIG_INVALID", "--custom-domain and --hosted-zone-id go together (omit both to leave the custom domain as it is, or use --no-custom-domain to turn it off)");
  }
  if (flags.customDomain !== undefined) {
    const parsed = CloudSignInAnswersSchema.safeParse({ customDomainName: flags.customDomain.trim(), customDomainHostedZoneId: flags.hostedZoneId!.trim() });
    if (!parsed.success) throw agentXError("CONFIG_INVALID", `--custom-domain must be a lower-case DNS name such as staging.rovara.dev and --hosted-zone-id a Route 53 hosted zone id such as Z0123456789ABCDEFGHIJ (${parsed.error.issues[0]?.path.join(".") ?? "invalid"})`);
  }
  if (METHOD_IDS.every((method) => off[method] !== true && given[method][0] === undefined) && flags.emailFrom === undefined && flags.noEmailFrom !== true && flags.customDomain === undefined && flags.noCustomDomain !== true) {
    throw agentXError("CONFIG_INVALID", "give --github-client-id and --github-client-secret-arn, --google-client-id and --google-client-secret-arn, --email-from, --custom-domain and --hosted-zone-id, --no-github, --no-google, --no-email-from or --no-custom-domain");
  }
}

const SENDER = /^(?:[^<>]+?\s*<([^<>@\s,]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+))>|([^<>@\s,]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)))$/;

/** The sender as Cognito will show it, and the domain Amazon SES must have verified; the address is the part after the last @. */
function parseSender(value: string): { from: string; domain: string } {
  const from = value.trim();
  // A line break or other control character in the sender would reach the email's From header.
  const match = /\p{Cc}/u.test(from) ? null : SENDER.exec(from);
  const domain = (match?.[2] ?? match?.[4])?.toLowerCase();
  if (domain === undefined) throw agentXError("CONFIG_INVALID", `--email-from ${JSON.stringify(value)} is not "Name <address>" or an address with a domain, for example "Rovara <signin@rovara.dev>"`);
  return { from, domain };
}

const partitionOf = (settings: EnvironmentSettings): string => /^arn:(aws[a-z-]*):/.exec(settings.access?.cloudFormationRoleArn ?? "")?.[1] ?? "aws";

/**
 * The sender, once Amazon SES has verified its domain in the environment's region (SESv2 GetEmailIdentity; Cognito sends with that
 * identity, https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html). A sandbox account is only a warning, so a
 * staging install with verified test addresses still works. Nothing is changed here.
 */
async function checkSender(services: SigninServices, settings: EnvironmentSettings, value: string): Promise<{ emailFrom: string; emailSourceArn: string }> {
  const { from, domain } = parseSender(value);
  const ses = services.ses;
  if (ses === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "--email-from needs an Amazon SES client, and this command has none; nothing changed");
  let verified: boolean;
  try {
    verified = ((await ses.send(new GetEmailIdentityCommand({ EmailIdentity: domain }))) as { VerifiedForSendingStatus?: boolean }).VerifiedForSendingStatus === true;
  } catch (error) {
    if ((error as { name?: string }).name !== "NotFoundException") throw agentXError("RUNTIME_UNAVAILABLE", `could not look up ${domain} in Amazon SES (${errorReason(error)}); nothing changed`);
    verified = false;
  }
  if (!verified) throw agentXError("CONFIG_INVALID", `Amazon SES has not verified ${domain} in ${settings.region}; verify the domain in SES first`);
  try {
    const account = (await ses.send(new GetAccountCommand({}))) as { ProductionAccessEnabled?: boolean };
    if (account.ProductionAccessEnabled === false) {
      services.write(`Amazon SES is in its sandbox in ${settings.region}: sign-in codes will not reach unverified addresses until SES production access is granted (at most 200 messages a day until then). Verified test addresses still work.`);
    }
  } catch (error) {
    services.write(`could not check whether Amazon SES is in its sandbox in ${settings.region} (${errorReason(error)}); if it is, sign-in codes will not reach unverified addresses until SES production access is granted`);
  }
  return { emailFrom: from, emailSourceArn: `arn:${partitionOf(settings)}:ses:${settings.region}:${settings.account}:identity/${domain}` };
}

/**
 * The secret must be this environment's own, and in its region and account: the sign-in function is
 * granted exactly the ARN it is given, but the operator role can only describe secrets named
 * agentx/<env>/*, and AgentX does not widen that, so the name needs that prefix. DescribeSecret
 * (never GetSecretValue) proves it exists.
 */
async function checkSecret(services: SigninServices, settings: EnvironmentSettings, flag: string, arn: string): Promise<void> {
  const parts = SECRET_ARN.exec(arn);
  if (parts === null) throw agentXError("CONFIG_INVALID", `${flag} ${arn} is not a Secrets Manager secret ARN (arn:aws:secretsmanager:<region>:<account>:secret:<name>-<suffix>)`);
  const [, region, account, nameAndSuffix = ""] = parts;
  if (region !== settings.region || account !== settings.account) {
    throw agentXError("CONFIG_INVALID", `${flag} must name a secret in this environment's own region and account (${settings.region}, ${settings.account}), not ${region}, ${account}`);
  }
  const name = SECRET_SUFFIX.exec(nameAndSuffix)?.[1];
  if (name === undefined) throw agentXError("CONFIG_INVALID", `${flag} needs the secret's full ARN, which ends in a hyphen and six characters; ${arn} does not`);
  const prefix = `agentx/${settings.env}/`;
  if (!name.startsWith(prefix)) {
    throw agentXError("CONFIG_INVALID", `${flag}: the secret's name must start with ${prefix} (this one is ${name}); the operator role can only look at secrets under that prefix, and AgentX does not widen it. Create the secret as ${prefix}<name>, holding {"clientSecret": "..."}`);
  }
  let found: string | undefined;
  try {
    found = await services.secrets.arn(arn);
  } catch (error) {
    throw agentXError("RUNTIME_UNAVAILABLE", `could not look up the secret ${name} (${errorReason(error)}); nothing changed`);
  }
  if (found === undefined) throw agentXError("CONFIG_INVALID", `${flag}: no secret exists at ${arn}; create ${name} holding {"clientSecret": "..."}, then run this again`);
}

/** The settings' cloudSignIn after the flags: the methods the flags name replaced or removed, everything else kept. */
function nextSignIn(current: CloudSignInAnswers | undefined, flags: CloudSignInFlags, sender: { emailFrom: string; emailSourceArn: string } | undefined): CloudSignInAnswers | undefined {
  const next: CloudSignInAnswers = { ...current };
  if (flags.noEmailFrom === true) { delete next.emailFrom; delete next.emailSourceArn; }
  if (sender !== undefined) { next.emailFrom = sender.emailFrom; next.emailSourceArn = sender.emailSourceArn; }
  if (flags.noCustomDomain === true) { delete next.customDomainName; delete next.customDomainHostedZoneId; }
  if (flags.customDomain !== undefined && flags.hostedZoneId !== undefined) { next.customDomainName = flags.customDomain.trim(); next.customDomainHostedZoneId = flags.hostedZoneId.trim(); }
  if (flags.noGithub === true) { delete next.githubClientId; delete next.githubClientSecretArn; }
  if (flags.noGoogle === true) { delete next.googleClientId; delete next.googleClientSecretArn; }
  if (flags.githubClientId !== undefined && flags.githubClientSecretArn !== undefined) { next.githubClientId = flags.githubClientId.trim(); next.githubClientSecretArn = flags.githubClientSecretArn.trim(); }
  if (flags.googleClientId !== undefined && flags.googleClientSecretArn !== undefined) { next.googleClientId = flags.googleClientId.trim(); next.googleClientSecretArn = flags.googleClientSecretArn.trim(); }
  const parsed = CloudSignInAnswersSchema.safeParse(next);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `the cloud sign-in flags are invalid: ${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}`.trim());
  return Object.keys(parsed.data).length === 0 ? undefined : parsed.data;
}

/** The stack parameters of the methods the flags name; a method they leave alone keeps its deployed values. */
function stackChanges(next: CloudSignInAnswers | undefined, flags: CloudSignInFlags): Record<string, string> {
  const named: Record<Method, boolean> = {
    github: flags.noGithub === true || flags.githubClientId !== undefined, google: flags.noGoogle === true || flags.googleClientId !== undefined,
  };
  const entries: Array<[string, string]> = [
    ...METHOD_IDS.filter((method) => named[method]).flatMap((method): Array<[string, string]> => {
      const { idParameter, arnParameter, idKey, arnKey } = METHODS[method];
      return [[idParameter, next?.[idKey] ?? ""], [arnParameter, next?.[arnKey] ?? ""]];
    }),
    ...(flags.noEmailFrom === true || flags.emailFrom !== undefined ? [["CloudSignInEmailFrom", next?.emailFrom ?? ""] as [string, string], ["CloudSignInEmailSourceArn", next?.emailSourceArn ?? ""] as [string, string]] : []),
  ];
  return Object.fromEntries(entries);
}

/** `record` with its cloudSignIn set to `signIn`, or without one: an optional property is absent, never undefined. */
function withSignIn<T extends { cloudSignIn?: CloudSignInAnswers | undefined }>(record: T, signIn: CloudSignInAnswers | undefined, more: Partial<T>): T {
  const copy = { ...record, ...more };
  if (signIn === undefined) delete copy.cloudSignIn;
  else copy.cloudSignIn = signIn;
  return copy;
}

const notApplied = (stackName: string) => agentXError("CONFIG_INVALID", `the cloud sign-in change to ${stackName} was not applied; nothing changed`);
const sameSignIn = (a: CloudSignInAnswers | undefined, b: CloudSignInAnswers | undefined) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());

const describeChange = (label: string, was: string, now: string): string => (was === now ? `  ${label}: ${now}` : `  ${label}: ${was} -> ${now}`);

const describeCustomDomain = (signIn: CloudSignInAnswers | undefined): string => (signIn?.customDomainName === undefined ? "off" : `${signIn.customDomainName} (hosted zone ${signIn.customDomainHostedZoneId ?? "?"})`);

/** The change's own words, with each method's old and new state and only a secret's name. */
function summaryLines(env: string, before: CloudSignInAnswers | undefined, after: CloudSignInAnswers | undefined): string[] {
  return [
    `Cloud sign-in for ${env}:`,
    ...METHOD_IDS.map((method) => {
      const { label, idKey, arnKey } = METHODS[method];
      const was = describeMethod(before?.[idKey], before?.[arnKey]);
      const now = describeMethod(after?.[idKey], after?.[arnKey]);
      return was === now ? `  ${label} sign-in: ${now}` : `  ${label} sign-in: ${was} -> ${now}`;
    }),
    describeChange("Sign-in email", describeEmailSender(before?.emailFrom), describeEmailSender(after?.emailFrom)),
    describeChange("Custom domain", describeCustomDomain(before), describeCustomDomain(after)),
  ];
}

/** The stack's outputs, or none: a failed read must not turn a change that was made into a failure. */
async function stackOutputs(services: SigninServices, stackName: string): Promise<Record<string, string>> {
  try {
    const stack = ((await services.cloudFormation.send(new DescribeStacksCommand({ StackName: stackName }))) as { Stacks?: Stack[] }).Stacks?.[0];
    return Object.fromEntries((stack?.Outputs ?? []).flatMap((output) => (output.OutputKey === undefined ? [] : [[output.OutputKey, output.OutputValue ?? ""]])));
  } catch {
    return {};
  }
}

export async function runSigninCloud(services: SigninServices, env: string, flags: CloudSignInFlags, yes: boolean): Promise<CloudSignInResult> {
  checkFlags(flags);
  const first = await installed(services, env);
  if (first.cloud !== true) throw agentXError("CONFIG_INVALID", `only a Rovara Cloud install has these sign-in methods; ${env} was not installed with --rovara-cloud`);
  for (const method of METHOD_IDS) {
    const { idKey, arnKey, arnFlag } = METHODS[method];
    // Trimmed here as nextSignIn trims what it stores, so the secret checked is the secret kept.
    const arn = flags[arnKey]?.trim();
    if (flags[idKey] !== undefined && arn !== undefined) await checkSecret(services, first, arnFlag, arn);
  }
  // Checked like the secrets, before the lock, and the warning is printed before the change is shown.
  const sender = flags.emailFrom === undefined ? undefined : await checkSender(services, first, flags.emailFrom);
  const holder = (await services.identity.get()).arn;
  return withEnvironmentLock({ store: services.store, env, holder, command: "signin cloud", now: services.now }, async () => {
    // Read again under the lock, so a change made while the secrets were checked is kept.
    const settings = (await readEnvironmentSettings(services.store, env)) ?? first;
    const roleArn = settings.access?.cloudFormationRoleArn;
    if (roleArn === undefined) throw agentXError("CONFIG_INVALID", `environment ${env}'s settings name no CloudFormation role; run agentx env use --env ${env}, or agentx init --resume`);
    const stackName = settings.stacks["control-plane"] ?? environmentStackName(env, "control-plane");
    // Read before the stack changes, so answers that cannot be read stop the change instead of following it.
    const answers = await readInstallAnswers(services.store, env);
    const next = nextSignIn(settings.cloudSignIn, flags, sender);
    const summary = summaryLines(env, settings.cloudSignIn, next);
    const confirm = async (text: string) => { services.write(text); return yes || services.prompter.confirm("Apply this change?", { defaultValue: false }); };

    let asked = false;
    const { changed: stackChanged } = await updateStackParameters({
      cloudFormation: services.cloudFormation, stackName, roleArn, changes: stackChanges(next, flags), label: "config",
      write: services.write, now: services.now,
      ...(services.sleep === undefined ? {} : { sleep: services.sleep }),
      ...(services.pollMs === undefined ? {} : { pollMs: services.pollMs }),
      confirm: async ({ changes }) => {
        asked = true;
        return confirm([...summary, `${stackName} will change: ${changes.map((change) => `${change.action} ${change.logicalId} (${change.type})`).join(", ") || "parameters only"}`].join("\n"));
      },
    });
    const settingsChanged = !sameSignIn(settings.cloudSignIn, next);
    const domainNamed = flags.customDomain !== undefined || flags.noCustomDomain === true;
    // The domain is never changed on the live stack here: the deploy role's grants for it are in the access stack, which `agentx upgrade` deploys first, and then the control plane.
    const domainNote = domainNamed ? [`The custom domain is recorded here and applied by the next agentx upgrade of ${env} (the access stack first, then the control plane); nothing in AWS changes until then.`] : [];
    if (!stackChanged && settingsChanged && !asked && !(await confirm([...summary, ...domainNote, `${stackName} already has the other parameters; the settings will record this.`].join("\n")))) throw notApplied(stackName);
    if (settingsChanged || stackChanged) {
      try {
        await writeEnvironmentSettings(services.store, withSignIn(settings, next, { updatedAt: new Date(services.now()).toISOString() }));
        if (answers !== undefined) await writeInstallAnswers(services.store, withSignIn(answers, next, {}));
      } catch (error) {
        const what = stackChanged ? `${stackName} was updated` : `${stackName} already had these parameters`;
        throw error instanceof AgentXError
          ? agentXError(error.code, `${what}, but recording the sign-in settings failed (${errorReason(error)}); run agentx signin cloud again with the same flags to record them`)
          : agentXError("RUNTIME_UNAVAILABLE", `${what}, but recording the sign-in settings failed (${errorReason(error)}); run agentx signin cloud again with the same flags to record them`);
      }
    }
    if (domainNamed && (settingsChanged || stackChanged)) services.write(domainNote.join("\n"));
    const outputs = next?.githubClientId === undefined && next?.googleClientId === undefined ? {} : await stackOutputs(services, stackName);
    const githubCallbackUrl = next?.githubClientId === undefined ? undefined : outputs.CloudIdentityGitHubCallbackUrl;
    const googleRedirectUri = next?.googleClientId === undefined ? undefined : outputs.CloudIdentityGoogleRedirectUri;
    return {
      changed: stackChanged || settingsChanged,
      ...(githubCallbackUrl === undefined || githubCallbackUrl === "" ? {} : { githubCallbackUrl }),
      ...(googleRedirectUri === undefined || googleRedirectUri === "" ? {} : { googleRedirectUri }),
    };
  });
}
