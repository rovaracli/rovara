// MODEL-PROXY-TLS in the CLI: the recorded install setting every upgrade re-applies, and the checks before an upgrade deploys anything:
// M1 no silent removal of TLS, L1 no removal of the legacy listeners under workers that still hold the plain-http address, L3 a domain ACM can validate.
import { describe, expect, it } from "vitest";
import { MODEL_PROXY_TLS_CONTEXT_KEYS } from "../../infra/lib/model-proxy-tls.js";
import { cdkAppArguments } from "../../packages/cli/src/deploy/cdk-engine.js";
import { MODEL_PROXY_TLS_PREVIOUS_CONTEXT_KEYS } from "../../infra/lib/model-proxy-tls.js";
import { editionRecordName } from "../../packages/cli/src/deploy/edition.js";
import {
  MODEL_PROXY_TLS_CONTEXT, MODEL_PROXY_TLS_PREVIOUS_CONTEXT, clearModelProxyTlsPrevious, previousAfterChange, readModelProxyTlsRecord, assertModelProxyTlsDeploy, modelProxyTlsContextArguments, modelProxyTlsDnsRefusals, modelProxyTlsRefusals, modelProxyTlsSettingName, parseModelProxyTlsSetting,
  readModelProxyTlsSetting, writeModelProxyTlsSetting, type DnsLookups, type ModelProxyTlsSetting, type ModelProxyTlsState,
} from "../../packages/cli/src/deploy/model-proxy-tls.js";
import { runConfigSet } from "../../packages/cli/src/config/commands.js";
import { readEnvironmentSettings, writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { runUpgrade, type UpgradeDependencies } from "../../packages/cli/src/upgrade/run.js";
import { seeded, services } from "../support/config-services.js";
import { allStackOutputs, fakeRelease } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const NAME = "model-proxy.staging.rovara.dev";
const ZONE = "Z08286002FKUL2VBSO3MO";
const SETTING: ModelProxyTlsSetting = { name: NAME, zoneId: ZONE, legacyHttp: false };
const KEEP: ModelProxyTlsSetting = { ...SETTING, legacyHttp: true };
const PUBLISHED = new Date("2026-11-12T10:00:00Z");
const before = new Date("2026-11-11T10:00:00Z");
const after = new Date("2026-11-12T11:00:00Z");

const codeError = (code: string) => Object.assign(new Error(code), { code });
/** Public DNS, faked: name servers and CAA records by name; anything else has none. */
function dns(records: { ns?: Record<string, string[]>; caa?: Record<string, Array<{ critical: number; issue?: string }>>; broken?: boolean } = {}): DnsLookups {
  return {
    resolveNs: async (name) => { if (records.broken === true) throw codeError("ESERVFAIL"); const found = records.ns?.[name]; if (found === undefined) throw codeError("ENODATA"); return found; },
    resolveCaa: async (name) => { const found = records.caa?.[name]; if (found === undefined) throw codeError("ENODATA"); return found; },
  };
}
const ROUTE53 = { "rovara.dev": ["ns-1.awsdns-01.org", "ns-2.awsdns-02.com"] };

describe("the recorded setting", () => {
  it("names the same context keys the synth reads", () => {
    expect(MODEL_PROXY_TLS_CONTEXT).toEqual(MODEL_PROXY_TLS_CONTEXT_KEYS);
  });

  it("parses what a person types, and refuses what the synth would refuse", () => {
    expect(parseModelProxyTlsSetting(`name=${NAME};zoneId=${ZONE}`, "staging")).toEqual(SETTING);
    expect(parseModelProxyTlsSetting(`name=${NAME}; zoneId=${ZONE}; legacyHttp=keep`, "staging")).toEqual(KEEP);
    expect(parseModelProxyTlsSetting("off", "staging")).toBe("off");
    for (const bad of [`name=${NAME}`, `zoneId=${ZONE}`, `name=Proxy.Example.com;zoneId=${ZONE}`, `name=x.us-west-2.elb.amazonaws.com;zoneId=${ZONE}`, `name=${NAME};zoneId=${ZONE};legacyHttp=yes`, `name=${NAME};zoneId=${ZONE};colour=blue`, `name=${NAME};name=${NAME};zoneId=${ZONE}`]) {
      expect(() => parseModelProxyTlsSetting(bad, "staging"), bad).toThrow(/modelProxy\.tls/u);
    }
  });

  it("round-trips through the store; off reads as none; an unreadable record refuses instead of reading as off", async () => {
    const store = new MemoryParameterStore();
    expect(await readModelProxyTlsSetting(store, "staging")).toBeUndefined();
    await writeModelProxyTlsSetting(store, "staging", KEEP);
    expect(await readModelProxyTlsSetting(store, "staging")).toEqual(KEEP);
    await writeModelProxyTlsSetting(store, "staging", "off");
    expect(await readModelProxyTlsSetting(store, "staging")).toBeUndefined();
    await store.put(modelProxyTlsSettingName("staging"), JSON.stringify({ v: 1, enabled: true, name: "BAD NAME", zoneId: ZONE, legacyHttp: false }));
    await expect(readModelProxyTlsSetting(store, "staging")).rejects.toThrow("can't be read");
    await store.put(modelProxyTlsSettingName("staging"), "garbage");
    await expect(readModelProxyTlsSetting(store, "staging")).rejects.toThrow("can't be read");
  });

  it("is passed to every cdk command as its -c pairs", () => {
    expect(modelProxyTlsContextArguments(KEEP)).toEqual(["-c", `rovaraModelProxyTlsName=${NAME}`, "-c", `rovaraModelProxyTlsZoneId=${ZONE}`, "-c", "rovaraModelProxyLegacyHttp=keep"]);
    const args = cdkAppArguments({ env: "staging", region: "us-west-2", identityMode: "cognito", modelProxyTls: SETTING });
    expect(args.join(" ")).toContain(`-c rovaraModelProxyTlsName=${NAME} -c rovaraModelProxyTlsZoneId=${ZONE} -c rovaraModelProxyLegacyHttp=off`);
    expect(cdkAppArguments({ env: "staging", region: "us-west-2", identityMode: "cognito" }).join(" ")).not.toContain("rovaraModelProxy");
  });

  it("agentx config set modelProxy.tls records it for a cdk install and refuses the prebuilt templates", async () => {
    const store = await seeded();
    const templates = services({ store });
    await expect(runConfigSet(templates, "staging", { key: "modelProxy.tls", value: `name=${NAME};zoneId=${ZONE}`, yes: true })).rejects.toThrow("deployed from source");
    expect(await readModelProxyTlsSetting(store, "staging")).toBeUndefined();
    const settings = (await readEnvironmentSettings(store, "staging"))!;
    await writeEnvironmentSettings(store, { ...settings, engine: "cdk" });
    const cdk = services({ store });
    expect(await runConfigSet(cdk, "staging", { key: "modelProxy.tls", value: `name=${NAME};zoneId=${ZONE};legacyHttp=keep`, yes: true })).toEqual({ changed: true });
    expect(await readModelProxyTlsSetting(store, "staging")).toEqual(KEEP);
    expect(cdk.lines.join("\n")).toContain("every upgrade after it keeps it");
  });
});

const state = (overrides: Partial<ModelProxyTlsState> = {}): ModelProxyTlsState => ({ deployedUrl: `https://${NAME}`, urlParameter: { value: `https://${NAME}`, lastModified: PUBLISHED }, workers: [], ...overrides });

describe("M-1: the previous name keeps its cleanup grants for one upgrade", () => {
  const OTHER = "proxy.staging.rovara.dev";
  const BROUGHT = "arn:aws:acm:us-west-2:944937319445:certificate/11111111-2222-3333-4444-555555555555";

  it("names the same context keys the synth reads", () => {
    expect(MODEL_PROXY_TLS_PREVIOUS_CONTEXT).toEqual(MODEL_PROXY_TLS_PREVIOUS_CONTEXT_KEYS);
  });

  it("keeps the old setting as the previous one only when the change removes what it built", () => {
    const requested = { name: NAME, zoneId: ZONE, requestedCertificate: true };
    expect(previousAfterChange({ setting: SETTING }, "off")).toEqual(requested);
    expect(previousAfterChange({ setting: SETTING }, { ...SETTING, name: OTHER })).toEqual(requested);
    expect(previousAfterChange({ setting: SETTING }, { ...SETTING, zoneId: "Z0ANOTHERZONE1" })).toEqual(requested);
    expect(previousAfterChange({ setting: SETTING }, { ...SETTING, certificateArn: BROUGHT })).toEqual(requested);
    // Nothing built is removed: legacyHttp only, or the first setting.
    expect(previousAfterChange({ setting: SETTING }, KEEP)).toBeUndefined();
    expect(previousAfterChange({}, SETTING)).toBeUndefined();
    // A brought certificate leaves no certificate or validation record of the stack's own.
    expect(previousAfterChange({ setting: { ...SETTING, certificateArn: BROUGHT } }, "off")).toEqual({ name: NAME, zoneId: ZONE, requestedCertificate: false });
    // A pending previous (no upgrade has applied the last change) is what is deployed, so it stays.
    expect(previousAfterChange({ setting: { ...SETTING, name: OTHER }, previous: requested }, { ...SETTING, name: "third.staging.rovara.dev" })).toEqual(requested);
  });

  it("is stored with the record, passed as -c pairs, and cleared after an upgrade", async () => {
    const store = new MemoryParameterStore();
    const previous = { name: NAME, zoneId: ZONE, requestedCertificate: true };
    await writeModelProxyTlsSetting(store, "staging", "off", previous);
    expect(await readModelProxyTlsRecord(store, "staging")).toEqual({ previous });
    expect(cdkAppArguments({ env: "staging", region: "us-west-2", identityMode: "cognito", modelProxyTlsPrevious: previous }).join(" "))
      .toContain(`-c rovaraModelProxyTlsPreviousName=${NAME} -c rovaraModelProxyTlsPreviousZoneId=${ZONE} -c rovaraModelProxyTlsPreviousCertificate=requested`);
    expect(await clearModelProxyTlsPrevious(store, "staging")).toBe(true);
    expect(await readModelProxyTlsRecord(store, "staging")).toEqual({});
    expect(await clearModelProxyTlsPrevious(store, "staging")).toBe(false);
  });

  it("config set records the previous name and prints the manual cleanup", async () => {
    const store = await seeded();
    const settings = (await readEnvironmentSettings(store, "staging"))!;
    await writeEnvironmentSettings(store, { ...settings, engine: "cdk" });
    await writeModelProxyTlsSetting(store, "staging", SETTING);
    const cdk = services({ store });
    await runConfigSet(cdk, "staging", { key: "modelProxy.tls", value: `name=${OTHER};zoneId=${ZONE}`, yes: true });
    expect(await readModelProxyTlsRecord(store, "staging")).toEqual({ setting: { ...SETTING, name: OTHER }, previous: { name: NAME, zoneId: ZONE, requestedCertificate: true } });
    expect(cdk.lines.join("\n")).toContain(`delete them by hand`);
  });
});

describe("M-2: not on an Enterprise install until its bundle path carries the setting", () => {
  it("refuses config set modelProxy.tls on edition=enterprise", async () => {
    const store = await seeded();
    const settings = (await readEnvironmentSettings(store, "staging"))!;
    await writeEnvironmentSettings(store, { ...settings, engine: "cdk" });
    await store.put(editionRecordName("staging"), "enterprise");
    await expect(runConfigSet(services({ store }), "staging", { key: "modelProxy.tls", value: `name=${NAME};zoneId=${ZONE}`, yes: true })).rejects.toThrow("Enterprise");
    expect(await readModelProxyTlsSetting(store, "staging")).toBeUndefined();
  });
});

describe("M1: no silent removal of TLS", () => {
  it("refuses a deploy with no TLS setting on an install that serves HTTPS, unless --allow-tls-removal", () => {
    const refused = modelProxyTlsRefusals({ env: "staging", setting: undefined, state: state() });
    expect(refused.join(" ")).toContain("--allow-tls-removal");
    expect(modelProxyTlsRefusals({ env: "staging", setting: undefined, state: state(), allowTlsRemoval: true })).toEqual([]);
    // Plain http today, or no proxy yet: nothing to lose.
    expect(modelProxyTlsRefusals({ env: "staging", setting: undefined, state: state({ deployedUrl: "http://internal-x.us-west-2.elb.amazonaws.com:4000" }) })).toEqual([]);
    expect(modelProxyTlsRefusals({ env: "staging", setting: undefined, state: state({ deployedUrl: undefined }) })).toEqual([]);
  });

  it("agentx upgrade refuses before anything is prepared or deployed", async () => {
    const store = await seeded();
    let prepared = 0;
    const deps = {
      store,
      // The upgrade tests' stacks (tests/contract/upgrade-run.test.ts), with a control plane that already serves the proxy over HTTPS.
      stacks: { describe: async (name: string) => name.endsWith("control-plane")
        ? { status: "UPDATE_COMPLETE", outputs: { ...allStackOutputs()[name], ModelProxyUrl: `https://${NAME}` }, parameters: { GitHubAppId: "123", GitHubAppPrivateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", BudgetMonthlyUsd: "250" } }
        : { status: "UPDATE_COMPLETE", outputs: allStackOutputs()[name] ?? {}, parameters: {} } },
      cloudFormation: { send: async () => ({ TemplateBody: "{}" }) },
      identity: { get: async () => ({ account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/Admin/alice" }) },
      loadRelease: async () => ({ ...fakeRelease("1.3.0"), template: () => "{}" }),
      notes: async () => undefined,
      cdkDiff: async () => "",
      prepare: async () => { prepared += 1; throw new Error("prepared"); },
      write: () => undefined, now: () => 0, cliVersion: "1.3.0", ask: async () => "y", isInteractive: () => true,
    } as unknown as UpgradeDependencies;
    const error = await runUpgrade({ env: "staging", yes: true, allowReplace: [] }, deps).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("--allow-tls-removal");
    expect(prepared).toBe(0);
  });
});

describe("L1: the legacy listeners stay until every worker that had the plain-http address is gone", () => {
  it("refuses while a worker launched before the https address was published still runs", () => {
    const refused = modelProxyTlsRefusals({ env: "staging", setting: SETTING, state: state({ workers: [{ id: "i-old", launchTime: before }, { id: "i-new", launchTime: after }] }) });
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("i-old");
    expect(refused[0]).toContain("legacyHttp=keep");
    expect(modelProxyTlsRefusals({ env: "staging", setting: SETTING, state: state({ workers: [{ id: "i-new", launchTime: after }] }) })).toEqual([]);
    expect(modelProxyTlsRefusals({ env: "staging", setting: SETTING, state: state({ workers: [{ id: "i-old", launchTime: before }] }), allowLegacyHttpRemoval: true })).toEqual([]);
  });

  it("counts every running worker when the https address is not published yet (TLS without keep on a plain-http install)", () => {
    const plain = state({ deployedUrl: "http://internal-x.us-west-2.elb.amazonaws.com:4000", urlParameter: { value: "http://internal-x.us-west-2.elb.amazonaws.com:4000", lastModified: PUBLISHED }, workers: [{ id: "i-new", launchTime: after }] });
    expect(modelProxyTlsRefusals({ env: "staging", setting: SETTING, state: plain })).toHaveLength(1);
    expect(modelProxyTlsRefusals({ env: "staging", setting: SETTING, state: { ...plain, workers: [] } })).toEqual([]);
  });

  it("never checks the workers while the legacy listeners are kept", async () => {
    let asked: boolean | undefined;
    await assertModelProxyTlsDeploy({ env: "staging", setting: KEEP, readState: async (wanted) => { asked = wanted.workers; return state({ workers: [{ id: "i-old", launchTime: before }] }); }, dns: dns() });
    expect(asked).toBe(false);
    await expect(assertModelProxyTlsDeploy({ env: "staging", setting: SETTING, readState: async (wanted) => { asked = wanted.workers; return state({ workers: [{ id: "i-old", launchTime: before }] }); }, dns: dns() })).rejects.toThrow("i-old");
    expect(asked).toBe(true);
  });
});

describe("L3: the domain must let ACM validate before the certificate is first requested", () => {
  it("passes a Route 53 delegated domain with no CAA records, or a CAA that names Amazon", async () => {
    expect(await modelProxyTlsDnsRefusals(NAME, dns({ ns: ROUTE53 }))).toEqual([]);
    expect(await modelProxyTlsDnsRefusals(NAME, dns({ ns: ROUTE53, caa: { "rovara.dev": [{ critical: 0, issue: "amazon.com" }, { critical: 0, issue: "letsencrypt.org" }] } }))).toEqual([]);
  });

  it("refuses a domain served elsewhere, an undelegated one, a CAA that leaves Amazon out, and DNS it cannot read", async () => {
    expect((await modelProxyTlsDnsRefusals(NAME, dns({ ns: { "rovara.dev": ["ns1.example-dns.net"] } }))).join(" ")).toContain("not Route 53");
    expect((await modelProxyTlsDnsRefusals(NAME, dns())).join(" ")).toContain("delegated");
    // The closest CAA set decides: one at the name itself overrides a permissive parent.
    expect((await modelProxyTlsDnsRefusals(NAME, dns({ ns: ROUTE53, caa: { [NAME]: [{ critical: 0, issue: "letsencrypt.org" }], "rovara.dev": [{ critical: 0, issue: "amazon.com" }] } }))).join(" ")).toContain("CAA");
    expect((await modelProxyTlsDnsRefusals(NAME, dns({ broken: true }))).join(" ")).toContain("could not be read");
  });

  it("runs only when a certificate is about to be requested", async () => {
    const broken = dns({ broken: true });
    // Already served under the name, or a brought certificate: no DNS lookups.
    await assertModelProxyTlsDeploy({ env: "staging", setting: KEEP, readState: async () => state(), dns: broken });
    await assertModelProxyTlsDeploy({ env: "staging", setting: { ...KEEP, certificateArn: "arn:aws:acm:us-west-2:944937319445:certificate/11111111-2222-3333-4444-555555555555" }, readState: async () => state({ deployedUrl: "http://x:4000" }), dns: broken });
    // First request on a plain-http install: checked, and refused when the DNS cannot be read.
    await expect(assertModelProxyTlsDeploy({ env: "staging", setting: KEEP, readState: async () => state({ deployedUrl: "http://x:4000" }), dns: broken })).rejects.toThrow("could not be read");
  });
});
