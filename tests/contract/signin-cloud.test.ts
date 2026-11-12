// agentx signin cloud (Task 24): turn GitHub and Google sign-in on, change or off on an installed Rovara Cloud environment.
import { environmentStackName, type ReleaseManifest } from "@rovara-code/contracts";
import { describe, expect, it } from "vitest";
import { stackParameters } from "../../packages/cli/src/deploy/parameters.js";
import { readEnvironmentSettings, writeEnvironmentSettings, type EnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { assertResumeFlagsMatch } from "../../packages/cli/src/init/answers.js";
import { readInstallAnswers, writeInstallAnswers } from "../../packages/cli/src/init/install-state.js";
import { executeCli } from "../../packages/cli/src/main.js";
import type { SigninServices } from "../../packages/cli/src/signin/commands.js";
import { runSigninCloud, type CloudSignInFlags } from "../../packages/cli/src/signin/cloud.js";
import { stagingSettings } from "../support/environment-fixtures.js";
import { SIGN_IN_PARAMETERS, fakeCloudFormation } from "../support/fake-cloudformation.js";
import { HOLDER, T0, allStackOutputs, fakeSlackApi, memoryInitSecrets, sampleAnswers, scriptedPrompter } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const ACCOUNT = "123456789012";
const arnOf = (name: string, region = "us-east-1", account = ACCOUNT) => `arn:aws:secretsmanager:${region}:${account}:secret:${name}-AbCdEf`;
const GITHUB_ARN = arnOf("agentx/staging/github-oauth");
const GOOGLE_ARN = arnOf("agentx/staging/google-oauth");
const GITHUB_URL = "https://abc.execute-api.us-east-1.amazonaws.com/v1/auth/callback/github";
const GOOGLE_URI = "https://rovara-staging.auth.us-east-1.amazoncognito.com/oauth2/idpresponse";

const installed: EnvironmentSettings = {
  ...stagingSettings,
  cloud: true,
  access: { artifactBucket: "b", cloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", pullThroughPrefix: "agentx-staging" },
};
const CLOUD_PARAMETERS = { ...SIGN_IN_PARAMETERS, GitHubClientId: "", GitHubClientSecretArn: "", GoogleClientId: "", GoogleClientSecretArn: "" };

async function harness(options: { settings?: EnvironmentSettings; answers?: boolean; prompts?: Array<string | boolean>; parameters?: Record<string, string>; secrets?: Record<string, string> } = {}) {
  const store = new MemoryParameterStore();
  await writeEnvironmentSettings(store, options.settings ?? installed);
  const answers = options.answers === false ? undefined : sampleAnswers({ cloud: true, ...(options.settings?.cloudSignIn === undefined ? {} : { cloudSignIn: options.settings.cloudSignIn }) });
  if (answers !== undefined) await writeInstallAnswers(store, answers);
  const secrets = memoryInitSecrets(options.secrets ?? { "agentx/staging/github-oauth": "{}", "agentx/staging/google-oauth": "{}" });
  const cloudFormation = fakeCloudFormation({
    parameters: options.parameters ?? CLOUD_PARAMETERS,
    outputs: { CloudIdentityGitHubCallbackUrl: GITHUB_URL, CloudIdentityGoogleRedirectUri: GOOGLE_URI },
  });
  const prompter = scriptedPrompter(options.prompts ?? [true]);
  const lines: string[] = [];
  const services: SigninServices = {
    store, secrets, cloudFormation, identity: { get: async () => ({ account: ACCOUNT, arn: HOLDER }) },
    fetch: async () => { throw new TypeError("fetch failed"); }, slackApi: fakeSlackApi({}),
    prompter, processEnv: {}, write: (line) => lines.push(line), now: () => T0, sleep: async () => undefined, pollMs: 1,
  };
  return { services, store, secrets, cloudFormation, prompter, lines };
}

const run = (h: Awaited<ReturnType<typeof harness>>, flags: CloudSignInFlags, yes = false) => runSigninCloud(h.services, "staging", flags, yes);
const github = { githubClientId: "Iv1.0123456789abcdef", githubClientSecretArn: GITHUB_ARN };
const google = { googleClientId: "1234-abc.apps.googleusercontent.com", googleClientSecretArn: GOOGLE_ARN };
const NOTHING_CHANGED = (h: Awaited<ReturnType<typeof harness>>) => {
  expect(h.cloudFormation.calls.map((call) => call.name)).not.toContain("ExecuteChangeSetCommand");
  expect(h.cloudFormation.parameters).toEqual(CLOUD_PARAMETERS);
};

describe("agentx signin cloud", () => {
  it("turns GitHub sign-in on: settings, stored answers and the control-plane parameters, then the callback URL to register", async () => {
    const h = await harness();
    const result = await run(h, github);
    expect(result).toEqual({ changed: true, githubCallbackUrl: GITHUB_URL });
    expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toEqual(github);
    expect((await readInstallAnswers(h.store, "staging"))?.cloudSignIn).toEqual(github);
    expect(h.cloudFormation.parameters).toMatchObject({ GitHubClientId: github.githubClientId, GitHubClientSecretArn: GITHUB_ARN, GoogleClientId: "", GoogleClientSecretArn: "" });
    expect(h.store.values.has("/agentx/staging/lock")).toBe(false);
  });

  it("turns Google sign-in on, and reports the redirect URI to register", async () => {
    const h = await harness();
    const result = await run(h, google);
    expect(result).toEqual({ changed: true, googleRedirectUri: GOOGLE_URI });
    expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toEqual(google);
    expect(h.cloudFormation.parameters).toMatchObject({ GoogleClientId: google.googleClientId, GoogleClientSecretArn: GOOGLE_ARN, GitHubClientId: "" });
  });

  it("turns both on in one change, keeping the hosted domain prefix", async () => {
    const h = await harness({ settings: { ...installed, cloudSignIn: { domainPrefix: "rovara-staging" } } });
    const result = await run(h, { ...github, ...google });
    expect(result).toEqual({ changed: true, githubCallbackUrl: GITHUB_URL, googleRedirectUri: GOOGLE_URI });
    expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toEqual({ domainPrefix: "rovara-staging", ...github, ...google });
    expect((await readInstallAnswers(h.store, "staging"))?.cloudSignIn).toEqual({ domainPrefix: "rovara-staging", ...github, ...google });
    expect(h.cloudFormation.calls.filter((call) => call.name === "ExecuteChangeSetCommand")).toHaveLength(1);
  });

  it("leaves the method it was not asked about as it is", async () => {
    const before = { ...google, domainPrefix: "rovara-staging" };
    const h = await harness({ settings: { ...installed, cloudSignIn: before }, parameters: { ...CLOUD_PARAMETERS, GoogleClientId: google.googleClientId, GoogleClientSecretArn: GOOGLE_ARN } });
    await run(h, github);
    expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toEqual({ ...before, ...github });
    expect(h.cloudFormation.parameters).toMatchObject({ GoogleClientId: google.googleClientId, GoogleClientSecretArn: GOOGLE_ARN, GitHubClientId: github.githubClientId });
  });

  it("replaces GitHub's client id and secret, showing old -> new with the client id in full and only the secret's name", async () => {
    const before = github;
    const h = await harness({ settings: { ...installed, cloudSignIn: before }, parameters: { ...CLOUD_PARAMETERS, GitHubClientId: github.githubClientId, GitHubClientSecretArn: GITHUB_ARN }, secrets: { "agentx/staging/github-oauth": "{}", "agentx/staging/github-oauth-2": "{}" } });
    await run(h, { githubClientId: "Iv1.fedcba9876543210", githubClientSecretArn: arnOf("agentx/staging/github-oauth-2") });
    const printed = h.lines.join("\n");
    expect(printed).toContain("GitHub sign-in: on (client Iv1.0123456789abcdef, secret agentx/staging/github-oauth) -> on (client Iv1.fedcba9876543210, secret agentx/staging/github-oauth-2)");
    expect(printed).not.toContain("arn:aws:secretsmanager");
    expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toEqual({ githubClientId: "Iv1.fedcba9876543210", githubClientSecretArn: arnOf("agentx/staging/github-oauth-2") });
  });

  it("shows an off -> on change and asks once; --yes still prints it and asks nothing", async () => {
    const asked = await harness();
    await run(asked, github);
    expect(asked.lines.join("\n")).toContain("GitHub sign-in: off -> on (client Iv1.0123456789abcdef, secret agentx/staging/github-oauth)");
    expect(asked.prompter.asked).toEqual(["Apply this change?"]);
    const unasked = await harness({ prompts: [] });
    await run(unasked, github, true);
    expect(unasked.lines.join("\n")).toContain("GitHub sign-in: off -> on");
    expect(unasked.prompter.asked).toEqual([]);
    expect(unasked.cloudFormation.parameters.GitHubClientId).toBe(github.githubClientId);
  });

  it("changes nothing when the change is declined", async () => {
    const h = await harness({ prompts: [false] });
    await expect(run(h, github)).rejects.toThrow(/not applied; nothing changed/);
    NOTHING_CHANGED(h);
    expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toBeUndefined();
    expect((await readInstallAnswers(h.store, "staging"))?.cloudSignIn).toBeUndefined();
  });

  describe("--no-github and --no-google", () => {
    const both = { ...github, ...google, domainPrefix: "rovara-staging" };
    const parameters = { ...CLOUD_PARAMETERS, GitHubClientId: github.githubClientId, GitHubClientSecretArn: GITHUB_ARN, GoogleClientId: google.googleClientId, GoogleClientSecretArn: GOOGLE_ARN };

    it("--no-github removes GitHub from the settings, the stored answers and the stack, and keeps Google", async () => {
      const h = await harness({ settings: { ...installed, cloudSignIn: both }, parameters });
      const result = await run(h, { noGithub: true });
      expect(result).toEqual({ changed: true, googleRedirectUri: GOOGLE_URI });
      const expected = { ...google, domainPrefix: "rovara-staging" };
      expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toEqual(expected);
      expect((await readInstallAnswers(h.store, "staging"))?.cloudSignIn).toEqual(expected);
      expect(h.cloudFormation.parameters).toMatchObject({ GitHubClientId: "", GitHubClientSecretArn: "", GoogleClientId: google.googleClientId });
      expect(h.lines.join("\n")).toContain("GitHub sign-in: on (client Iv1.0123456789abcdef, secret agentx/staging/github-oauth) -> off");
    });

    it("--no-google removes Google, and the whole cloudSignIn once nothing is left", async () => {
      const h = await harness({ settings: { ...installed, cloudSignIn: { ...google } }, parameters: { ...CLOUD_PARAMETERS, GoogleClientId: google.googleClientId, GoogleClientSecretArn: GOOGLE_ARN } });
      await run(h, { noGoogle: true });
      expect(await readEnvironmentSettings(h.store, "staging")).not.toHaveProperty("cloudSignIn");
      expect(await readInstallAnswers(h.store, "staging")).not.toHaveProperty("cloudSignIn");
      expect(h.cloudFormation.parameters).toMatchObject({ GoogleClientId: "", GoogleClientSecretArn: "" });
    });

    it("does nothing, and says so, for a method that is already off", async () => {
      const h = await harness();
      expect(await run(h, { noGithub: true })).toEqual({ changed: false });
      NOTHING_CHANGED(h);
      expect(h.prompter.asked).toEqual([]);
    });

    it("refuses --no-github together with a GitHub client id or secret", async () => {
      const h = await harness();
      await expect(run(h, { noGithub: true, githubClientId: "Iv1.x" })).rejects.toThrow("--no-github cannot be combined with --github-client-id or --github-client-secret-arn");
      await expect(run(h, { noGoogle: true, googleClientSecretArn: GOOGLE_ARN })).rejects.toThrow("--no-google cannot be combined with --google-client-id or --google-client-secret-arn");
      expect(h.cloudFormation.calls).toEqual([]);
    });
  });

  describe("refusals, with nothing written", () => {
    const untouched = async (h: Awaited<ReturnType<typeof harness>>, before: string | undefined) => {
      expect(h.cloudFormation.calls.map((call) => call.name)).not.toContain("CreateChangeSetCommand");
      expect(h.store.values.get("/agentx/staging/settings")).toBe(before);
      expect(h.store.values.has("/agentx/staging/lock")).toBe(false);
    };

    it("refuses a half pair, in the same words init uses", async () => {
      const h = await harness();
      const before = h.store.values.get("/agentx/staging/settings");
      await expect(run(h, { githubClientId: github.githubClientId })).rejects.toThrow("CONFIG_INVALID: --github-client-id and --github-client-secret-arn go together");
      await expect(run(h, { githubClientSecretArn: GITHUB_ARN })).rejects.toThrow("--github-client-id and --github-client-secret-arn go together");
      await expect(run(h, { googleClientId: google.googleClientId })).rejects.toThrow("--google-client-id and --google-client-secret-arn go together");
      await expect(run(h, { googleClientSecretArn: GOOGLE_ARN })).rejects.toThrow("--google-client-id and --google-client-secret-arn go together");
      await untouched(h, before);
    });

    it("asks for something to change when no flag is given", async () => {
      const h = await harness();
      await expect(run(h, {})).rejects.toThrow(/give --github-client-id/);
      expect(h.cloudFormation.calls).toEqual([]);
    });

    it("refuses an environment that is not a Rovara Cloud install", async () => {
      const plain: EnvironmentSettings = { ...installed };
      delete plain.cloud;
      const h = await harness({ settings: plain });
      const before = h.store.values.get("/agentx/staging/settings");
      await expect(run(h, github)).rejects.toThrow("CONFIG_INVALID: only a Rovara Cloud install has these sign-in methods");
      await untouched(h, before);
    });

    it("refuses an environment that is not installed", async () => {
      const h = await harness();
      await expect(runSigninCloud(h.services, "nowhere", github, false)).rejects.toThrow("environment nowhere is not installed");
    });

    it.each([
      ["a secret in another region", arnOf("agentx/staging/github-oauth", "us-west-2"), "in this environment's own region and account (us-east-1, 123456789012)"],
      ["a secret in another account", arnOf("agentx/staging/github-oauth", "us-east-1", "999999999999"), "in this environment's own region and account (us-east-1, 123456789012)"],
      ["a secret outside the environment's prefix", arnOf("shared/github-oauth"), "must start with agentx/staging/"],
      ["another environment's secret", arnOf("agentx/prod/github-oauth"), "must start with agentx/staging/"],
      ["a secret that does not exist", arnOf("agentx/staging/no-such-secret"), "no secret exists at"],
      ["something that is not a Secrets Manager ARN", "arn:aws:s3:::bucket", "is not a Secrets Manager secret ARN"],
    ])("refuses %s", async (_name, arn, message) => {
      const h = await harness();
      const before = h.store.values.get("/agentx/staging/settings");
      await expect(run(h, { githubClientId: github.githubClientId, githubClientSecretArn: arn })).rejects.toThrow(message);
      await untouched(h, before);
      expect(await readInstallAnswers(h.store, "staging")).not.toHaveProperty("cloudSignIn");
    });

    it("names the prefix a secret must start with, and why, rather than widening the operator role", async () => {
      const h = await harness();
      const error = await run(h, { githubClientId: github.githubClientId, githubClientSecretArn: arnOf("shared/github-oauth") }).then(() => new Error("test setup: expected a refusal"), (caught: unknown) => caught as Error);
      expect(error.message).toContain("agentx/staging/");
      expect(error.message).toContain("operator role");
    });

    it("never reads a secret's value to check it exists", async () => {
      const h = await harness();
      let reads = 0;
      h.secrets.get = async () => { reads += 1; return undefined; };
      await run(h, github);
      expect(reads).toBe(0);
    });
  });

  it("checks the secret a flag names without its stray whitespace, and stores it trimmed", async () => {
    const h = await harness();
    await run(h, { githubClientId: ` ${github.githubClientId} `, githubClientSecretArn: ` ${GITHUB_ARN}\n` });
    expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toEqual(github);
  });

  it("refuses, writing nothing, a control-plane stack from before GitHub sign-in, and says to upgrade", async () => {
    const h = await harness({ parameters: SIGN_IN_PARAMETERS });
    await expect(run(h, github)).rejects.toThrow(/has no GitHubClientId, GitHubClientSecretArn parameter; it runs an older AgentX release, so upgrade it with agentx upgrade/);
    expect(h.cloudFormation.calls.map((call) => call.name)).not.toContain("CreateChangeSetCommand");
    expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toBeUndefined();
    expect((await readInstallAnswers(h.store, "staging"))?.cloudSignIn).toBeUndefined();
  });

  it("works on an install whose init answers were never stored", async () => {
    const h = await harness({ answers: false });
    await run(h, github);
    expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toEqual(github);
    expect(await readInstallAnswers(h.store, "staging")).toBeUndefined();
  });

  it("records the settings when the stack already matches (an earlier run stopped before recording)", async () => {
    const h = await harness({ parameters: { ...CLOUD_PARAMETERS, GitHubClientId: github.githubClientId, GitHubClientSecretArn: GITHUB_ARN } });
    const result = await run(h, github);
    expect(result).toEqual({ changed: true, githubCallbackUrl: GITHUB_URL });
    expect(h.cloudFormation.calls.map((call) => call.name)).not.toContain("ExecuteChangeSetCommand");
    expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toEqual(github);
    expect((await readInstallAnswers(h.store, "staging"))?.cloudSignIn).toEqual(github);
  });

  it("says what to run again when the settings cannot be recorded after the stack changed", async () => {
    const h = await harness();
    const put = h.store.put.bind(h.store);
    h.store.put = async (name, value, options) => {
      if (name === "/agentx/staging/settings") throw Object.assign(new Error("ThrottlingException"), { name: "ThrottlingException" });
      return put(name, value, options);
    };
    await expect(run(h, github)).rejects.toThrow(/agentx-staging-control-plane was updated, but recording the sign-in settings failed \(ThrottlingException\); run agentx signin cloud again with the same flags to record them/);
    expect(h.cloudFormation.parameters.GitHubClientId).toBe(github.githubClientId);
  });

  describe("what a later command sees", () => {
    it("a later init resume with the new flags reports no mismatch", async () => {
      const h = await harness();
      await run(h, github);
      const stored = (await readInstallAnswers(h.store, "staging"))!;
      expect(() => assertResumeFlagsMatch(stored, { githubSignInClientId: github.githubClientId, githubSignInClientSecretArn: GITHUB_ARN })).not.toThrow();
      // And the old answer is now the mismatch, which is what stops a resume from quietly undoing this change.
      expect(() => assertResumeFlagsMatch(stored, { githubSignInClientId: "Iv1.old" })).toThrow(/Iv1.old/);
    });

    it("a deploy's control-plane parameters carry GitHubClientId and GitHubClientSecretArn", async () => {
      const h = await harness();
      await run(h, github);
      const settings = (await readEnvironmentSettings(h.store, "staging"))!;
      const stacks = allStackOutputs("staging");
      const outputs = { access: stacks[environmentStackName("staging", "access")]!, foundation: stacks[environmentStackName("staging", "foundation")]!, identity: stacks[environmentStackName("staging", "identity")]!, "control-plane": stacks[environmentStackName("staging", "control-plane")]! };
      const parameters = stackParameters("control-plane", {
        env: "staging", region: settings.region, account: settings.account, release: {} as ReleaseManifest, models: settings.models, identity: { mode: "cognito" },
        github: { appId: "1", privateKeySecretArn: arnOf("agentx/staging/github-app") },
        ...(settings.cloud === true ? { cloud: true as const } : {}), ...(settings.cloudSignIn === undefined ? {} : { cloudSignIn: settings.cloudSignIn }),
      }, outputs, { packages: false });
      expect(parameters).toMatchObject({ GitHubClientId: github.githubClientId, GitHubClientSecretArn: GITHUB_ARN });
    });
  });

  describe("on the command line", () => {
    it("agentx signin cloud applies the change and prints the callback URL on stdout", async () => {
      const h = await harness({ prompts: [] });
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await executeCli([
        "--env", "staging", "signin", "cloud", "--yes",
        "--github-client-id", github.githubClientId, "--github-client-secret-arn", GITHUB_ARN,
      ], { stdout: { write: (text: string) => stdout.push(text) }, stderr: { write: (text: string) => stderr.push(text) }, signin: h.services });
      expect(h.lines.join("\n")).toContain("GitHub sign-in: off -> on");
      expect(stderr.join("")).toBe("");
      expect(code).toBe(0);
      expect(stdout.join("")).toBe(`Cloud sign-in updated.\nRegister this authorization callback URL with the GitHub OAuth app: ${GITHUB_URL}\n`);
      expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toEqual(github);
    });

    it("agentx signin cloud --no-github turns GitHub off", async () => {
      const h = await harness({ prompts: [], settings: { ...installed, cloudSignIn: github }, parameters: { ...CLOUD_PARAMETERS, GitHubClientId: github.githubClientId, GitHubClientSecretArn: GITHUB_ARN } });
      const stdout: string[] = [];
      const code = await executeCli(["--env", "staging", "signin", "cloud", "--yes", "--no-github"], { stdout: { write: (text: string) => stdout.push(text) }, stderr: { write: () => true }, signin: h.services });
      expect(code).toBe(0);
      expect(stdout.join("")).toBe("Cloud sign-in updated.\n");
      expect(await readEnvironmentSettings(h.store, "staging")).not.toHaveProperty("cloudSignIn");
    });

    it("agentx signin cloud --json answers with the result", async () => {
      const h = await harness({ prompts: [] });
      const stdout: string[] = [];
      const code = await executeCli(["--env", "staging", "--json", "signin", "cloud", "--yes", "--github-client-id", github.githubClientId, "--github-client-secret-arn", GITHUB_ARN], { stdout: { write: (text: string) => stdout.push(text) }, stderr: { write: () => true }, signin: h.services });
      expect(code).toBe(0);
      expect(JSON.parse(stdout.join(""))).toMatchObject({ data: { changed: true, githubCallbackUrl: GITHUB_URL } });
    });

    it("exits nonzero with the half-pair message", async () => {
      const h = await harness({ prompts: [] });
      const stderr: string[] = [];
      const code = await executeCli(["--env", "staging", "signin", "cloud", "--yes", "--github-client-id", github.githubClientId], { stdout: { write: () => true }, stderr: { write: (text: string) => stderr.push(text) }, signin: h.services });
      expect(code).not.toBe(0);
      expect(stderr.join("")).toContain("--github-client-id and --github-client-secret-arn go together");
    });
  });
});
