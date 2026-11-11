// agentx signin cloud --email-from / --no-email-from (Task 7): sign-in codes from a branded Amazon SES sender.
// SES is a fake client; nothing here reaches AWS.
import { environmentStackName, type ReleaseManifest } from "@rovara-code/contracts";
import { describe, expect, it } from "vitest";
import { CloudSignInAnswersSchema } from "../../packages/cli/src/deploy/answer-schemas.js";
import { stackParameters } from "../../packages/cli/src/deploy/parameters.js";
import { readEnvironmentSettings, writeEnvironmentSettings, type EnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { readInstallAnswers, writeInstallAnswers } from "../../packages/cli/src/init/install-state.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { runSigninCloud, type CloudSignInFlags } from "../../packages/cli/src/signin/cloud.js";
import { runSigninShow, type SigninServices } from "../../packages/cli/src/signin/commands.js";
import { stagingSettings } from "../support/environment-fixtures.js";
import { SIGN_IN_PARAMETERS, fakeCloudFormation } from "../support/fake-cloudformation.js";
import { HOLDER, T0, allStackOutputs, fakeSlackApi, memoryInitSecrets, sampleAnswers, scriptedPrompter } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const ACCOUNT = "123456789012";
const FROM = "Rovara <signin@rovara.dev>";
const SOURCE_ARN = `arn:aws:ses:us-east-1:${ACCOUNT}:identity/rovara.dev`;
const GITHUB_ARN = `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:agentx/staging/github-oauth-AbCdEf`;
const SANDBOX_WARNING = "Amazon SES is in its sandbox in us-east-1: sign-in codes will not reach unverified addresses until SES production access is granted (at most 200 messages a day until then). Verified test addresses still work.";

const installed: EnvironmentSettings = {
  ...stagingSettings,
  cloud: true,
  access: { artifactBucket: "b", cloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", pullThroughPrefix: "agentx-staging" },
};
const CLOUD_PARAMETERS = { ...SIGN_IN_PARAMETERS, GitHubClientId: "", GitHubClientSecretArn: "", GoogleClientId: "", GoogleClientSecretArn: "", CloudSignInEmailFrom: "", CloudSignInEmailSourceArn: "" };

interface SesScript { identity?: { VerifiedForSendingStatus?: boolean } | "missing" | "denied"; account?: { ProductionAccessEnabled?: boolean } | "denied" }
function fakeSes(script: SesScript = {}) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> {
      calls.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "GetEmailIdentityCommand") {
        const identity = script.identity ?? { VerifiedForSendingStatus: true };
        if (identity === "missing") throw Object.assign(new Error("Email identity does not exist"), { name: "NotFoundException" });
        if (identity === "denied") throw Object.assign(new Error("not authorized"), { name: "AccessDeniedException" });
        return identity;
      }
      if (command.constructor.name === "GetAccountCommand") {
        const account = script.account ?? { ProductionAccessEnabled: true };
        if (account === "denied") throw Object.assign(new Error("not authorized"), { name: "AccessDeniedException" });
        return account;
      }
      throw new Error(`unexpected SES command ${command.constructor.name}`);
    },
  };
}

async function harness(options: { settings?: EnvironmentSettings; ses?: SesScript; parameters?: Record<string, string>; prompts?: Array<string | boolean> } = {}) {
  const store = new MemoryParameterStore();
  await writeEnvironmentSettings(store, options.settings ?? installed);
  await writeInstallAnswers(store, sampleAnswers({ cloud: true, ...(options.settings?.cloudSignIn === undefined ? {} : { cloudSignIn: options.settings.cloudSignIn }) }));
  const cloudFormation = fakeCloudFormation({ parameters: options.parameters ?? CLOUD_PARAMETERS, outputs: {} });
  const ses = fakeSes(options.ses);
  const prompter = scriptedPrompter(options.prompts ?? [true]);
  const lines: string[] = [];
  const services: SigninServices = {
    store, secrets: memoryInitSecrets({ "agentx/staging/github-oauth": "{}" }), cloudFormation, ses, identity: { get: async () => ({ account: ACCOUNT, arn: HOLDER }) },
    fetch: async () => { throw new TypeError("fetch failed"); }, slackApi: fakeSlackApi({}),
    prompter, processEnv: {}, write: (line) => lines.push(line), now: () => T0, sleep: async () => undefined, pollMs: 1,
  };
  return { services, store, cloudFormation, ses, prompter, lines };
}
type Harness = Awaited<ReturnType<typeof harness>>;
const run = (h: Harness, flags: CloudSignInFlags, yes = false) => runSigninCloud(h.services, "staging", flags, yes);
const withSender = { emailFrom: FROM, emailSourceArn: SOURCE_ARN };

describe("agentx signin cloud --email-from", () => {
  it("writes both settings, the stored init answers and the control-plane parameters, after asking SES about the domain", async () => {
    const h = await harness();
    expect(await run(h, { emailFrom: FROM })).toEqual({ changed: true });
    expect(h.ses.calls[0]).toEqual({ name: "GetEmailIdentityCommand", input: { EmailIdentity: "rovara.dev" } });
    expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toEqual(withSender);
    expect((await readInstallAnswers(h.store, "staging"))?.cloudSignIn).toEqual(withSender);
    expect(h.cloudFormation.parameters).toMatchObject({ CloudSignInEmailFrom: FROM, CloudSignInEmailSourceArn: SOURCE_ARN, GitHubClientId: "" });
    expect(h.store.values.has("/agentx/staging/lock")).toBe(false);
  });

  it("builds the SES identity ARN from the environment's partition, region and account, and takes a bare address", async () => {
    const h = await harness({ settings: { ...installed, region: "us-west-2", access: { ...installed.access!, cloudFormationRoleArn: "arn:aws-us-gov:iam::123456789012:role/agentx-staging-cloudformation" } } });
    await run(h, { emailFrom: "signin@rovara.dev" });
    expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toEqual({ emailFrom: "signin@rovara.dev", emailSourceArn: `arn:aws-us-gov:ses:us-west-2:${ACCOUNT}:identity/rovara.dev` });
  });

  it("keeps the GitHub and Google settings it was not asked about", async () => {
    const github = { githubClientId: "Iv1.0123456789abcdef", githubClientSecretArn: GITHUB_ARN };
    const h = await harness({ settings: { ...installed, cloudSignIn: github }, parameters: { ...CLOUD_PARAMETERS, GitHubClientId: github.githubClientId, GitHubClientSecretArn: GITHUB_ARN } });
    await run(h, { emailFrom: FROM });
    expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toEqual({ ...github, ...withSender });
    expect(h.cloudFormation.parameters).toMatchObject({ GitHubClientId: github.githubClientId, CloudSignInEmailFrom: FROM });
  });

  it("shows old -> new for the sender and asks once", async () => {
    const h = await harness();
    await run(h, { emailFrom: FROM });
    expect(h.lines.join("\n")).toContain(`Sign-in email: Amazon Cognito default sender -> ${FROM} (Amazon SES)`);
    expect(h.prompter.asked).toEqual(["Apply this change?"]);
  });

  describe("an unverified domain is refused, with nothing written", () => {
    const REFUSAL = "Amazon SES has not verified rovara.dev in us-east-1; verify the domain in SES first";
    const untouched = async (h: Harness) => {
      expect(h.cloudFormation.calls.map((call) => call.name)).not.toContain("CreateChangeSetCommand");
      expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toBeUndefined();
      expect((await readInstallAnswers(h.store, "staging"))?.cloudSignIn).toBeUndefined();
      expect(h.store.values.has("/agentx/staging/lock")).toBe(false);
    };

    it.each([
      ["a domain SES reports as not verified", { VerifiedForSendingStatus: false } as const],
      ["a domain with no status", {} as const],
      ["a domain SES does not know", "missing" as const],
    ])("%s", async (_name, identity) => {
      const h = await harness({ ses: { identity } });
      await expect(run(h, { emailFrom: FROM })).rejects.toThrow(`CONFIG_INVALID: ${REFUSAL}`);
      await untouched(h);
    });

    it("an SES error other than not-found stops the change and says so, rather than calling the domain unverified", async () => {
      const h = await harness({ ses: { identity: "denied" } });
      await expect(run(h, { emailFrom: FROM })).rejects.toThrow(/RUNTIME_UNAVAILABLE: could not look up rovara.dev in Amazon SES/);
      await untouched(h);
    });
  });

  describe("the SES sandbox", () => {
    it("prints a warning that codes will not reach unverified addresses, and still applies the change", async () => {
      const h = await harness({ ses: { account: { ProductionAccessEnabled: false } } });
      expect(await run(h, { emailFrom: FROM })).toEqual({ changed: true });
      expect(h.lines).toContain(SANDBOX_WARNING);
      expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toEqual(withSender);
    });

    it("prints the warning before it asks to apply", async () => {
      const h = await harness({ ses: { account: { ProductionAccessEnabled: false } } });
      await run(h, { emailFrom: FROM });
      const warned = h.lines.indexOf(SANDBOX_WARNING);
      expect(warned).toBeGreaterThanOrEqual(0);
      expect(h.lines.findIndex((line) => line.includes("Sign-in email:"))).toBeGreaterThan(warned);
    });

    it("says nothing about the sandbox once SES has production access", async () => {
      const h = await harness({ ses: { account: { ProductionAccessEnabled: true } } });
      await run(h, { emailFrom: FROM });
      expect(h.lines.join("\n")).not.toContain("sandbox");
    });

    it("warns that it could not tell, rather than failing, when the account status cannot be read", async () => {
      const h = await harness({ ses: { account: "denied" } });
      expect(await run(h, { emailFrom: FROM })).toEqual({ changed: true });
      expect(h.lines.join("\n")).toContain("could not check whether Amazon SES is in its sandbox in us-east-1");
    });
  });

  it("changes nothing when the change is declined", async () => {
    const h = await harness({ prompts: [false] });
    await expect(run(h, { emailFrom: FROM })).rejects.toThrow(/not applied; nothing changed/);
    expect(h.cloudFormation.parameters).toEqual(CLOUD_PARAMETERS);
    expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toBeUndefined();
  });

  it.each([
    ["no address", "Rovara"],
    ["trailing text after the address", "<signin@rovara.dev>x"],
    ["a name with a line break", "Rovara\nBcc: x <signin@rovara.dev>"],
    ["a name with a control character", "Rovara\u0007 <signin@rovara.dev>"],
    ["two addresses", "a@rovara.dev, b@rovara.dev"],
    ["an address with no domain dot", "signin@localhost"],
    ["a name with an angle bracket", "Ro<vara <signin@rovara.dev>"],
  ])("refuses %s, with no SES call", async (_name, value) => {
    const h = await harness();
    await expect(run(h, { emailFrom: value })).rejects.toThrow(/CONFIG_INVALID: --email-from .* is not "Name <address>" or an address/);
    expect(h.ses.calls).toEqual([]);
    expect(h.cloudFormation.calls).toEqual([]);
  });

  it("refuses --email-from together with --no-email-from, and does not need SES for it", async () => {
    const h = await harness();
    await expect(run(h, { emailFrom: FROM, noEmailFrom: true })).rejects.toThrow("--no-email-from cannot be combined with --email-from");
    expect(h.ses.calls).toEqual([]);
  });

  it("refuses an install whose services carry no SES client", async () => {
    const h = await harness();
    const withoutSes: SigninServices = { ...h.services };
    delete withoutSes.ses;
    await expect(runSigninCloud(withoutSes, "staging", { emailFrom: FROM }, false)).rejects.toThrow(/Amazon SES client/);
  });
});

describe("agentx signin cloud --no-email-from", () => {
  const before = { ...withSender, domainPrefix: "rovara-staging" };
  const parameters = { ...CLOUD_PARAMETERS, CloudSignInEmailFrom: FROM, CloudSignInEmailSourceArn: SOURCE_ARN };

  it("clears both settings and both parameters, which goes back to Cognito's default sender, without asking SES", async () => {
    const h = await harness({ settings: { ...installed, cloudSignIn: before }, parameters });
    expect(await run(h, { noEmailFrom: true })).toEqual({ changed: true });
    expect(h.ses.calls).toEqual([]);
    expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toEqual({ domainPrefix: "rovara-staging" });
    expect((await readInstallAnswers(h.store, "staging"))?.cloudSignIn).toEqual({ domainPrefix: "rovara-staging" });
    expect(h.cloudFormation.parameters).toMatchObject({ CloudSignInEmailFrom: "", CloudSignInEmailSourceArn: "" });
    expect(h.lines.join("\n")).toContain(`Sign-in email: ${FROM} (Amazon SES) -> Amazon Cognito default sender`);
  });

  it("does nothing, and says so, when no sender is set", async () => {
    const h = await harness();
    expect(await run(h, { noEmailFrom: true })).toEqual({ changed: false });
    expect(h.prompter.asked).toEqual([]);
    expect(h.cloudFormation.parameters).toEqual(CLOUD_PARAMETERS);
  });
});

describe("the stored settings and deploy parameters", () => {
  it("accepts emailFrom and emailSourceArn only together, and an SES identity ARN", () => {
    expect(CloudSignInAnswersSchema.safeParse(withSender).success).toBe(true);
    expect(CloudSignInAnswersSchema.safeParse({ emailFrom: FROM }).success).toBe(false);
    expect(CloudSignInAnswersSchema.safeParse({ emailSourceArn: SOURCE_ARN }).success).toBe(false);
    expect(CloudSignInAnswersSchema.safeParse({ emailFrom: FROM, emailSourceArn: "arn:aws:s3:::bucket" }).success).toBe(false);
  });

  it("a deploy's control-plane parameters include CloudSignInEmailFrom and CloudSignInEmailSourceArn", async () => {
    const h = await harness();
    await run(h, { emailFrom: FROM });
    const settings = (await readEnvironmentSettings(h.store, "staging"))!;
    const stacks = allStackOutputs("staging");
    const outputs = { access: stacks[environmentStackName("staging", "access")]!, foundation: stacks[environmentStackName("staging", "foundation")]!, identity: stacks[environmentStackName("staging", "identity")]!, "control-plane": stacks[environmentStackName("staging", "control-plane")]! };
    const answers = {
      env: "staging", region: settings.region, account: settings.account, release: {} as ReleaseManifest, models: settings.models, identity: { mode: "cognito" as const },
      github: { appId: "1", privateKeySecretArn: GITHUB_ARN }, callbackSigningKey: "k".repeat(40), cloud: true as const,
    };
    expect(stackParameters("control-plane", { ...answers, cloudSignIn: settings.cloudSignIn! }, outputs, { packages: false })).toMatchObject({ CloudSignInEmailFrom: FROM, CloudSignInEmailSourceArn: SOURCE_ARN });
    expect(stackParameters("control-plane", answers, outputs, { packages: false })).not.toHaveProperty("CloudSignInEmailFrom");
  });
});

describe("agentx signin show on a Rovara Cloud install", () => {
  it("reports GitHub, Google and the sign-in email sender, and never a secret", async () => {
    const github = { githubClientId: "Iv1.0123456789abcdef", githubClientSecretArn: GITHUB_ARN };
    const h = await harness({ settings: { ...installed, cloudSignIn: { ...github, ...withSender } } });
    const shown = await runSigninShow(h.services, "staging");
    expect(shown.lines).toEqual(expect.arrayContaining([
      "GitHub sign-in: on (client Iv1.0123456789abcdef)",
      "Google sign-in: off",
      `Sign-in email: ${FROM} (Amazon SES)`,
    ]));
    expect(shown.lines.join("\n")).not.toContain("arn:aws:secretsmanager");
    expect(shown.data).toMatchObject({ cloudSignIn: { github: { clientId: "Iv1.0123456789abcdef" }, google: null, emailFrom: FROM } });
  });

  it("names Cognito's default sender when none is set, and leaves a non-cloud install's output as it was", async () => {
    const cloud = await harness();
    expect((await runSigninShow(cloud.services, "staging")).lines).toEqual(expect.arrayContaining(["GitHub sign-in: off", "Google sign-in: off", "Sign-in email: Amazon Cognito default sender"]));
    const plainSettings: EnvironmentSettings = { ...installed };
    delete plainSettings.cloud;
    const plain = await harness({ settings: plainSettings });
    expect((await runSigninShow(plain.services, "staging")).lines.join("\n")).not.toContain("Sign-in email");
  });
});

describe("on the command line", () => {
  it("agentx signin cloud --email-from applies the change and prints the sandbox warning on stderr", async () => {
    const h = await harness({ prompts: [], ses: { account: { ProductionAccessEnabled: false } } });
    const stdout: string[] = [];
    const code = await executeCli(["--env", "staging", "signin", "cloud", "--yes", "--email-from", FROM], { stdout: { write: (text: string) => stdout.push(text) }, stderr: { write: () => true }, signin: h.services });
    expect(code).toBe(0);
    expect(stdout.join("")).toBe("Cloud sign-in updated.\n");
    expect(h.lines).toContain(SANDBOX_WARNING);
    expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toEqual(withSender);
  });

  it("agentx signin cloud --no-email-from goes back to the default sender", async () => {
    const h = await harness({ prompts: [], settings: { ...installed, cloudSignIn: withSender }, parameters: { ...CLOUD_PARAMETERS, CloudSignInEmailFrom: FROM, CloudSignInEmailSourceArn: SOURCE_ARN } });
    const code = await executeCli(["--env", "staging", "signin", "cloud", "--yes", "--no-email-from"], { stdout: { write: () => true }, stderr: { write: () => true }, signin: h.services });
    expect(code).toBe(0);
    expect(await readEnvironmentSettings(h.store, "staging")).not.toHaveProperty("cloudSignIn");
  });

  it("agentx signin cloud --email-from exits nonzero for an unverified domain", async () => {
    const h = await harness({ prompts: [], ses: { identity: { VerifiedForSendingStatus: false } } });
    const stderr: string[] = [];
    const code = await executeCli(["--env", "staging", "signin", "cloud", "--yes", "--email-from", FROM], { stdout: { write: () => true }, stderr: { write: (text: string) => stderr.push(text) }, signin: h.services });
    expect(code).not.toBe(0);
    expect(stderr.join("")).toContain("Amazon SES has not verified rovara.dev in us-east-1; verify the domain in SES first");
  });
});
