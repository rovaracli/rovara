// 0.5.7: the custom domain, from the command line's side: how it is set (agentx signin cloud), what the deploy sends for it, and which address the CLI records and uses.
import type { ReleaseManifest } from "@rovara-code/contracts";
import { describe, expect, it } from "vitest";
import { CloudSignInAnswersSchema } from "../../packages/cli/src/deploy/answer-schemas.js";
import { publicAddress } from "../../packages/cli/src/deploy/deploy-environment.js";
import { stackParameters, type InstallAnswers } from "../../packages/cli/src/deploy/parameters.js";
import { customDomainParameterName, customDomainParameters, readCustomDomain, writeCustomDomain } from "../../packages/cli/src/environments/custom-domain.js";
import { EnvironmentSettingsSchema, readEnvironmentSettings, settingsParameterName, writeEnvironmentSettings, type EnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { readInstallAnswers, writeInstallAnswers } from "../../packages/cli/src/init/install-state.js";
import { runSigninCloud, type CloudSignInFlags } from "../../packages/cli/src/signin/cloud.js";
import type { SigninServices } from "../../packages/cli/src/signin/commands.js";
import { CloudSignInAnswersSchema as CloudSignIn056, EnvironmentSettingsSchema as Settings056 } from "../support/settings-schema-056.js";
import { stagingSettings } from "../support/environment-fixtures.js";
import { SIGN_IN_PARAMETERS, fakeCloudFormation } from "../support/fake-cloudformation.js";
import { HOLDER, T0, fakeSlackApi, memoryInitSecrets, sampleAnswers, scriptedPrompter } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const ACCOUNT = "123456789012";
const DOMAIN = "staging.rovara.dev";
const ZONE = "Z08286002FKUL2VBSO3MO";
const API = "https://abc123.execute-api.us-west-2.amazonaws.com";

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

const record = async (h: Awaited<ReturnType<typeof harness>>) => readCustomDomain(h.store, "staging");

describe("agentx signin cloud --custom-domain", () => {
  it("records the name and zone in a record of its own, changes nothing in AWS or in the settings and install answers, and says the next upgrade applies it", async () => {
    const h = await harness();
    const settingsBefore = h.store.values.get(settingsParameterName("staging"));
    expect(await run(h, { customDomain: DOMAIN, hostedZoneId: ZONE }, true)).toEqual({ changed: true });
    expect(await record(h)).toEqual({ domainName: DOMAIN, hostedZoneId: ZONE });
    expect(h.store.values.has(customDomainParameterName("staging"))).toBe(true);
    // The settings and the install answers are exactly what they were: a 0.5.6 command reads both, and refuses keys it does not know.
    expect(h.store.values.get(settingsParameterName("staging"))).toBe(settingsBefore);
    expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toBeUndefined();
    expect((await readInstallAnswers(h.store, "staging"))?.cloudSignIn).toBeUndefined();
    expect(h.cloudFormation.calls.map((call) => call.name)).not.toContain("CreateChangeSetCommand");
    expect(h.lines.join("\n")).toContain("Custom domain: off -> staging.rovara.dev (hosted zone Z08286002FKUL2VBSO3MO)");
    expect(h.lines.join("\n")).toContain("applied by the next agentx upgrade");
  });

  it("keeps the other cloud sign-in settings, and --no-custom-domain deletes only the record", async () => {
    const github = { githubClientId: "Iv1.0123456789abcdef", githubClientSecretArn: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:agentx/staging/github-oauth-AbCdEf` };
    const h = await harness({ settings: { ...installed, cloudSignIn: github } });
    await writeCustomDomain(h.store, "staging", { domainName: DOMAIN, hostedZoneId: ZONE });
    await run(h, { noCustomDomain: true }, true);
    expect(await record(h)).toBeUndefined();
    expect((await readEnvironmentSettings(h.store, "staging"))?.cloudSignIn).toEqual(github);
  });

  it("refuses to change a recorded domain to another name in one step, and accepts the same name again", async () => {
    const h = await harness();
    await writeCustomDomain(h.store, "staging", { domainName: DOMAIN, hostedZoneId: ZONE });
    await expect(run(h, { customDomain: "other.rovara.dev", hostedZoneId: ZONE }, true)).rejects.toThrow(/two steps/);
    expect(await record(h)).toEqual({ domainName: DOMAIN, hostedZoneId: ZONE });
    expect(await run(h, { customDomain: DOMAIN, hostedZoneId: ZONE }, true)).toEqual({ changed: false });
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
    expect(await record(h)).toBeUndefined();
  });
});

describe("a 0.5.6 command still reads what 0.5.7 wrote (emergency rollback)", () => {
  it("the 0.5.6 strict settings schema parses the settings after the domain was recorded and after a deploy wrote a custom controlPlaneUrl", async () => {
    const h = await harness();
    await run(h, { customDomain: DOMAIN, hostedZoneId: ZONE }, true);
    const stored = JSON.parse(h.store.values.get(settingsParameterName("staging"))!) as unknown;
    expect(Settings056.safeParse(stored).success).toBe(true);
    // What a deploy writes once the domain is live: the same keys, with the domain as controlPlaneUrl.
    const live = { ...(stored as EnvironmentSettings), controlPlaneUrl: publicAddress(API, `https://${DOMAIN}`) };
    expect(Settings056.safeParse(live).success).toBe(true);
    expect(EnvironmentSettingsSchema.safeParse(live).success).toBe(true);
  });

  it("the current settings and cloud sign-in schemas have exactly the 0.5.6 keys, so nothing 0.5.7 adds can be seen by a strict 0.5.6 schema", () => {
    expect(Object.keys(EnvironmentSettingsSchema.shape).sort()).toEqual(Object.keys(Settings056.shape).sort());
    expect(Object.keys(CloudSignInAnswersSchema.shape).sort()).toEqual(Object.keys(CloudSignIn056.shape).sort());
    expect(CloudSignInAnswersSchema.safeParse({ customDomainName: DOMAIN, customDomainHostedZoneId: ZONE }).success).toBe(false);
  });
});

describe("what the deploy sends", () => {
  const answers = (extra: Partial<InstallAnswers>): InstallAnswers => ({
    env: "staging", region: "us-west-2", account: ACCOUNT, release: {} as ReleaseManifest,
    models: { orchestrator: "a", classifier: "b", worker: "c" }, identity: { mode: "cognito" },
    github: { account: "acme", appId: "123", installationId: "456", privateKeySecretArn: `arn:aws:secretsmanager:us-west-2:${ACCOUNT}:secret:agentx/staging/github-app-AbCdEf` },
    callbackSigningKey: "k".repeat(40), ...extra,
  });
  const outputs = { access: { ArtifactBucketName: "b" } } as never;

  it("sends the name and zone to the access stack on the hosted cloud, and empty values when there is no domain, so a removal reaches the stack", () => {
    const domain = { domainName: DOMAIN, hostedZoneId: ZONE };
    expect(stackParameters("access", answers({ cloud: true, customDomain: domain }), outputs, { packages: false })).toMatchObject({ CustomDomainName: DOMAIN, CustomDomainHostedZoneId: ZONE });
    expect(stackParameters("access", answers({ cloud: true }), outputs, { packages: false })).toMatchObject({ CustomDomainName: "", CustomDomainHostedZoneId: "" });
    // Not the hosted cloud: no stack declares them, so none is sent.
    expect(stackParameters("access", answers({ customDomain: domain }), outputs, { packages: false })).not.toHaveProperty("CustomDomainName");
    expect(customDomainParameters(domain)).toEqual({ CustomDomainName: DOMAIN, CustomDomainHostedZoneId: ZONE });
  });
});

describe("which address the CLI records", () => {
  it("records the PublicUrl output for people when the stack has one, else the API's own", () => {
    expect(publicAddress(API, `https://${DOMAIN}`)).toBe(`https://${DOMAIN}`);
    expect(publicAddress(API, API)).toBe(API);
    expect(publicAddress(API, undefined)).toBe(API);
    expect(publicAddress(API, "")).toBe(API);
  });
});
