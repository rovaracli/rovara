// 0.5.7: the custom domain, from the command line's side: how it is set (agentx signin cloud), what the deploy sends for it, and which address the CLI records and uses.
import type { ReleaseManifest } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { CloudSignInAnswersSchema } from "../../packages/cli/src/deploy/answer-schemas.js";
import { publicAddresses } from "../../packages/cli/src/deploy/deploy-environment.js";
import { customDomainParameters, stackParameters, type InstallAnswers } from "../../packages/cli/src/deploy/parameters.js";
import { machineEndpoint, readEnvironmentSettings, writeEnvironmentSettings, type EnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { readInstallAnswers, writeInstallAnswers } from "../../packages/cli/src/init/install-state.js";
import { runSigninCloud, type CloudSignInFlags } from "../../packages/cli/src/signin/cloud.js";
import type { SigninServices } from "../../packages/cli/src/signin/commands.js";
import { describeCloudSignIn } from "../../packages/cli/src/signin/settings.js";
import { stagingSettings } from "../support/environment-fixtures.js";
import { SIGN_IN_PARAMETERS, fakeCloudFormation } from "../support/fake-cloudformation.js";
import { HOLDER, T0, fakeSlackApi, memoryInitSecrets, sampleAnswers, scriptedPrompter } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const ACCOUNT = "123456789012";
const DOMAIN = "staging.rovara.dev";
const ZONE = "Z08286002FKUL2VBSO3MO";
const API = "https://abc123.execute-api.us-west-2.amazonaws.com";
const set = { customDomainName: DOMAIN, customDomainHostedZoneId: ZONE };

const installed: EnvironmentSettings = {
  ...stagingSettings,
  cloud: true,
  access: { artifactBucket: "b", cloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", pullThroughPrefix: "agentx-staging-pull" },
};
const CLOUD_PARAMETERS = { ...SIGN_IN_PARAMETERS, GitHubClientId: "", GitHubClientSecretArn: "", GoogleClientId: "", GoogleClientSecretArn: "", CloudSignInEmailFrom: "", CloudSignInEmailSourceArn: "" };

async function harness(options: { settings?: EnvironmentSettings } = {}) {
  const store = new MemoryParameterStore();
  await writeEnvironmentSettings(store, options.settings ?? installed);
  await writeInstallAnswers(store, sampleAnswers({ cloud: true, ...(options.settings?.cloudSignIn === undefined ? {} : { cloudSignIn: options.settings.cloudSignIn }) }));
  const cloudFormation = fakeCloudFormation({ parameters: CLOUD_PARAMETERS, outputs: {} });
  const lines: string[] = [];
  const prompter = scriptedPrompter([true]);
  const services: SigninServices = {
    store, secrets: memoryInitSecrets({}), cloudFormation, identity: { get: async () => ({ account: ACCOUNT, arn: HOLDER }) },
    fetch: async () => { throw new TypeError("fetch failed"); }, slackApi: fakeSlackApi({}), prompter, processEnv: {}, write: (line) => lines.push(line), now: () => T0, sleep: async () => undefined, pollMs: 1,
  };
  return { services, store, cloudFormation, lines, prompter };
}
const run = (h: Awaited<ReturnType<typeof harness>>, flags: CloudSignInFlags, yes = false) => runSigninCloud(h.services, "staging", flags, yes);

describe("agentx signin cloud --custom-domain", () => {
  it("records the name and zone in the settings and the init answers, changes nothing in AWS, and says the next upgrade applies it", async () => {
    const h = await harness();
    expect(await run(h, { customDomain: DOMAIN, hostedZoneId: ZONE }, true)).toEqual({ changed: true });
    expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toEqual(set);
    expect((await readInstallAnswers(h.store, "staging"))?.cloudSignIn).toEqual(set);
    expect(h.cloudFormation.calls.map((call) => call.name)).not.toContain("CreateChangeSetCommand");
    expect(h.lines.join("\n")).toContain("Custom domain: off -> staging.rovara.dev (hosted zone Z08286002FKUL2VBSO3MO)");
    expect(h.lines.join("\n")).toContain("applied by the next agentx upgrade");
  });

  it("keeps the other cloud sign-in settings, and --no-custom-domain takes only the domain off", async () => {
    const github = { githubClientId: "Iv1.0123456789abcdef", githubClientSecretArn: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:agentx/staging/github-oauth-AbCdEf`, ...set };
    const h = await harness({ settings: { ...installed, cloudSignIn: github } });
    await run(h, { noCustomDomain: true }, true);
    const { customDomainName: _name, customDomainHostedZoneId: _zone, ...rest } = github;
    void _name; void _zone;
    expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toEqual(rest);
  });

  it.each([
    ["a name without a zone", { customDomain: DOMAIN }, /--custom-domain and --hosted-zone-id go together/],
    ["a zone without a name", { hostedZoneId: ZONE }, /--custom-domain and --hosted-zone-id go together/],
    ["a name that is not a lower-case DNS name", { customDomain: "Staging.Rovara.dev", hostedZoneId: ZONE }, /lower-case DNS name/],
    ["a zone that is not a hosted zone id", { customDomain: DOMAIN, hostedZoneId: "rovara.dev" }, /hosted zone id/],
    ["the domain and its removal together", { customDomain: DOMAIN, hostedZoneId: ZONE, noCustomDomain: true }, /cannot be combined/],
  ] as Array<[string, CloudSignInFlags, RegExp]>)("refuses %s, with nothing written", async (_name, flags, message) => {
    const h = await harness();
    await expect(run(h, flags, true)).rejects.toThrow(message);
    expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toBeUndefined();
  });

  it("shows in signin show", () => {
    expect(describeCloudSignIn(set)).toContain(`Custom domain: ${DOMAIN} (hosted zone ${ZONE})`);
    expect(describeCloudSignIn(undefined)).toContain("Custom domain: off");
  });
});

describe("the stored answers and what the deploy sends", () => {
  it("takes the name and the zone together or not at all", () => {
    expect(CloudSignInAnswersSchema.safeParse(set).success).toBe(true);
    expect(CloudSignInAnswersSchema.safeParse({ customDomainName: DOMAIN }).success).toBe(false);
    expect(CloudSignInAnswersSchema.safeParse({ customDomainHostedZoneId: ZONE }).success).toBe(false);
    expect(CloudSignInAnswersSchema.safeParse({ ...set, customDomainName: "rovara" }).success).toBe(false);
    expect(CloudSignInAnswersSchema.safeParse({}).success).toBe(true);
  });

  it("sends the two parameters to the access stack and the control plane on the hosted cloud, and nothing without a domain", () => {
    const answers = (extra: Partial<InstallAnswers>): InstallAnswers => ({
      env: "staging", region: "us-west-2", account: ACCOUNT, release: {} as ReleaseManifest,
      models: { orchestrator: "a", classifier: "b", worker: "c" }, identity: { mode: "cognito" },
      github: { account: "acme", appId: "123", installationId: "456", privateKeySecretArn: `arn:aws:secretsmanager:us-west-2:${ACCOUNT}:secret:agentx/staging/github-app-AbCdEf` },
      callbackSigningKey: "k".repeat(40), ...extra,
    });
    const outputs = { access: { ArtifactBucketName: "b" } } as never;
    const params = { CustomDomainName: DOMAIN, CustomDomainHostedZoneId: ZONE };
    expect(stackParameters("access", answers({ cloud: true, cloudSignIn: set }), outputs, { packages: false })).toMatchObject(params);
    expect(stackParameters("access", answers({ cloud: true }), outputs, { packages: false })).not.toHaveProperty("CustomDomainName");
    // Not the hosted cloud: no stack declares them, so none is sent.
    expect(stackParameters("access", answers({ cloudSignIn: set }), outputs, { packages: false })).not.toHaveProperty("CustomDomainName");
    expect(customDomainParameters(set)).toEqual(params);
    expect(customDomainParameters(undefined)).toEqual({});
  });
});

describe("which address the CLI records", () => {
  it("records the PublicUrl output for people, and the API's own beside it for machines, only when they differ", () => {
    expect(publicAddresses(API, `https://${DOMAIN}`)).toEqual({ controlPlaneUrl: `https://${DOMAIN}`, apiEndpoint: API });
    expect(publicAddresses(API, API)).toEqual({ controlPlaneUrl: API });
    expect(publicAddresses(API, undefined)).toEqual({ controlPlaneUrl: API });
    expect(publicAddresses(API, "")).toEqual({ controlPlaneUrl: API });
  });

  it("machines (the GitHub App's webhook) keep the API's own address", () => {
    expect(machineEndpoint({ controlPlaneUrl: `https://${DOMAIN}`, apiEndpoint: API })).toBe(API);
    expect(machineEndpoint({ controlPlaneUrl: API })).toBe(API);
  });
});
