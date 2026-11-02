/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- expect.stringMatching and parsed JSON are untyped */
// Enterprise foundations, N3b (owner decision 2026-10-31, option A): an Enterprise install's templates are built AT APPROVAL, from the release's own pinned CDK app and the install's
// recorded settings. Each test names the guard it protects; the lane report lists the mutation that makes each one fail.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalRecordSchema, BuiltManifestSchema, sha256OfBytes, synthContext, synthSettingsSha256 } from "@agentx/contracts";
import { buildAtApproval } from "../../packages/cli/src/upgrade/bundle/build-at-approval.js";
import { nodeSynthRunner, testRunner } from "../support/kit-runner.js";
import { FAKE_ASSET, SECOND_ASSET } from "../support/synth-kit-fixture.js";
import { readSynthSettings, recordSynthSettings } from "../../packages/cli/src/upgrade/bundle/synth-settings.js";
import type { BuiltBundle } from "../support/bundle-fixture.js";
import { EnterpriseWorld, INSTALL, SETTINGS_ENT } from "../support/enterprise-approval-world.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const made: BuiltBundle[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((bundle) => bundle.cleanup()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const refused = (promise: Promise<unknown>, pattern: RegExp) => expect(promise).rejects.toThrow(pattern);
const buildWith = async (world: EnterpriseWorld, settings = SETTINGS_ENT(), runner = testRunner) => {
  const verified = await world.verify();
  try {
    return await buildAtApproval({ bundle: verified, settings, runner });
  } finally {
    await verified.cleanup();
  }
};

describe("building the install's templates at approval", () => {
  it("builds every stack and the package from the signed kit and the recorded settings, and nothing else", async () => {
    const world = await EnterpriseWorld.create(made, { kit: { recordInputs: true } });
    const built = await buildWith(world);
    expect(BuiltManifestSchema.parse(built.manifest)).toMatchObject({ bundleId: world.bundle.bundleSha256, version: "1.4.0", env: "ent", region: "us-east-1" });
    expect(built.manifest.templates.map((t) => t.part)).toEqual(["access", "foundation", "identity", "runtime", "control-plane", "slack"]);
    expect(built.manifest.packages).toHaveLength(1);
    const foundation = JSON.parse(built.files.find((f) => f.file === "built/templates/foundation.template.json")!.body.toString("utf8"));
    // The kit was given exactly the install's fixed values and its recorded settings.
    expect(foundation.Metadata.Inputs.context).toEqual(synthContext(SETTINGS_ENT()));
    expect(foundation.Metadata.Inputs.context).toMatchObject({ agentxEnv: "ent", agentxRegion: "us-east-1", agentxSynthesizer: "legacy", rovaraEdition: "enterprise", rovaraEnterpriseEgressCidrs: "10.20.0.0/16" });
    const control = JSON.parse(built.files.find((f) => f.file === "built/templates/control-plane.template.json")!.body.toString("utf8"));
    expect(control.Resources.Marker.Properties.Value).toContain("10.20.0.0/16");
    // The kit's hash is made from the SIGNED manifest's own entries for it: what a deployer holding only the signed manifest computes too.
    const { readFile } = await import("node:fs/promises");
    const { BundleManifestSchema, synthKitSha256 } = await import("@agentx/contracts");
    const signed = BundleManifestSchema.parse(JSON.parse(await readFile(join(world.bundle.dir, "bundle.json"), "utf8")));
    expect(built.manifest.kitSha256).toBe(synthKitSha256(signed.files));
    expect(built.manifest.kitSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(built.resultSha256).toBe(sha256OfBytes(built.manifestBytes));
  });

  it("is deterministic: the same bundle and settings give the same hash, in another directory, with the keys written in another order", async () => {
    const world = await EnterpriseWorld.create(made);
    const first = await buildWith(world);
    const elsewhere = await mkdtemp(join(tmpdir(), "other-tmp-"));
    roots.push(elsewhere);
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = elsewhere;
    let second;
    try {
      second = await buildWith(world, { ...SETTINGS_ENT({ agentxAuditTsa: "off", rovaraEnterpriseEgressCidrs: "10.20.0.0/16" }) });
    } finally {
      if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    }
    expect(second.resultSha256).toBe(first.resultSha256);
    expect(second.manifestBytes.equals(first.manifestBytes)).toBe(true);
    for (const file of first.files) expect(second.files.find((f) => f.file === file.file)!.body.equals(file.body)).toBe(true);
  });

  it("does not let the formatting or the order a kit chose change the hash: keys sorted, packages ordered by id", async () => {
    const plain = await buildWith(await EnterpriseWorld.create(made, { kit: { twoPackages: true }, extraPackage: true }));
    const reversed = await buildWith(await EnterpriseWorld.create(made, { kit: { twoPackages: true, reverseKeys: true }, extraPackage: true }));
    expect(plain.manifest.packages.map((p) => p.assetId)).toEqual([FAKE_ASSET, SECOND_ASSET].sort());
    // The two bundles differ in the kit (and so in its hash and the bundle id), but the templates and packages are the same bytes, in the same order.
    expect(reversed.manifest.templates).toEqual(plain.manifest.templates);
    expect(reversed.manifest.packages).toEqual(plain.manifest.packages);
  });

  it("changes the hash when a setting changes (the build is of THIS install's settings)", async () => {
    const world = await EnterpriseWorld.create(made);
    const a = await buildWith(world, SETTINGS_ENT({ rovaraEnterpriseEgressCidrs: "10.20.0.0/16" }));
    const b = await buildWith(world, SETTINGS_ENT({ rovaraEnterpriseEgressCidrs: "10.30.0.0/16" }));
    expect(a.resultSha256).not.toBe(b.resultSha256);
    expect(a.settingsSha256).not.toBe(b.settingsSha256);
    expect(a.kitSha256).toBe(b.kitSha256);
  });

  it("gives the kit no environment of the caller's and no input but the context: no credential, no CDK context variable", async () => {
    const world = await EnterpriseWorld.create(made, { kit: { recordInputs: true } });
    const planted = { AWS_SECRET_ACCESS_KEY: `fake${Math.random().toString(36).slice(2)}`, AWS_PROFILE: "x", CDK_CONTEXT_JSON: JSON.stringify({ rovaraEnterpriseEgressCidrs: "0.0.0.0/0", rovaraOperatorAccess: "enabled" }), HTTPS_PROXY: "http://proxy.invalid" };
    const before = Object.fromEntries(Object.keys(planted).map((key) => [key, process.env[key]]));
    Object.assign(process.env, planted);
    let built;
    try {
      built = await buildWith(world);
    } finally {
      for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const foundation = JSON.parse(built.files.find((f) => f.file === "built/templates/foundation.template.json")!.body.toString("utf8"));
    // (macOS adds __CF_USER_TEXT_ENCODING to every process it starts. bubblewrap sets PWD itself when it is given --chdir, to that directory, which is the kit's own work directory: it is
    // allowed only when it names the directory the kit runs in, so it is never the caller's.)
    // The kit decides whether PWD names its own directory while it runs: the build removes that directory when it ends, so the test cannot look at it afterwards.
    // The kit also says whether it was started IN its own work directory (the context file's), so a PWD that leaks from the caller cannot pass for the kit's own when the directory is wrong.
    const inputs = foundation.Metadata.Inputs as { environment: string[]; pwdIsCwd: boolean; cwdIsWorkDir: boolean };
    expect(inputs.cwdIsWorkDir).toBe(true);
    const ownPwd = inputs.pwdIsCwd && inputs.cwdIsWorkDir;
    expect(inputs.environment.filter((name) => name !== "__CF_USER_TEXT_ENCODING" && !(name === "PWD" && ownPwd))).toEqual(["HOME", "LANG", "LC_ALL", "NODE_ENV", "TMPDIR", "TZ"]);
    expect(foundation.Metadata.Inputs.context.rovaraEnterpriseEgressCidrs).toBe("10.20.0.0/16");
    expect(foundation.Metadata.Inputs.context.rovaraOperatorAccess).toBeUndefined();
    expect(JSON.stringify(built.files.map((f) => f.body.toString("latin1")))).not.toContain("proxy.invalid");
  });

  it.runIf(nodeSynthRunner.confined)("confines the kit to its own files where the platform can: it cannot read outside them", async () => {
    const world = await EnterpriseWorld.create(made, { kit: { readOutside: "/etc/hosts" } });
    const built = await buildWith(world);
    const foundation = JSON.parse(built.files.find((f) => f.file === "built/templates/foundation.template.json")!.body.toString("utf8"));
    expect(foundation.Metadata.Outside).toBe("blocked");
  });

  it("refuses a bundle with no kit, a kit for another Node, a kit that fails, and a kit that wrote more or less than it declared", async () => {
    await refused(buildWith(await EnterpriseWorld.create(made, { kit: false })), /carries no synthesis kit/);
    await refused(buildWith(await EnterpriseWorld.create(made, { kit: { nodeMajor: 18 } })), /built for Node 18/);
    await refused(buildWith(await EnterpriseWorld.create(made, { kit: { fail: true } })), /synthesis kit failed/);
    // A kit cannot bring settings of its own: kit.json takes no field beyond the ones it names.
    // (The builder refuses to sign such a kit, and the build refuses one signed by anyone else: both read kit.json with the same strict schema.)
    await expect(EnterpriseWorld.create(made, { kit: { kitJsonExtra: { context: { rovaraEnterpriseEgressCidrs: "0.0.0.0/0" } } } })).rejects.toThrow(/unrecognized/i);
    await refused(buildWith(await EnterpriseWorld.create(made, { kit: { strayFile: "extra.txt" } })), /wrote a file the build does not use/);
  });

  it("builds only the signed release's own Lambda packages: other bytes for a signed asset id, and a package the release does not list, are refused (review I3)", async () => {
    await refused(buildWith(await EnterpriseWorld.create(made, { kit: { otherPackageBytes: true } })), /not the signed release's package/);
    await refused(buildWith(await EnterpriseWorld.create(made, { kit: { twoPackages: true, unsignedPackage: true } })), /signed release lists/);
    // With the second package signed and the same bytes, the build goes through and names exactly the signed hashes.
    const ok = await buildWith(await EnterpriseWorld.create(made, { kit: { twoPackages: true }, extraPackage: true }));
    expect(ok.manifest.packages).toHaveLength(2);
  });

  it("refuses output that was built for no install, or that asks for code it does not hold, or names parameters its stack lacks", async () => {
    await refused(buildWith(await EnterpriseWorld.create(made, { kit: { placeholder: true } })), /placeholder/);
    await refused(buildWith(await EnterpriseWorld.create(made, { kit: { unknownAsset: true } })), /asks for code/);
    await refused(buildWith(await EnterpriseWorld.create(made, { kit: { omitParameters: true } })), /does not declare/);
    await refused(buildWith(await EnterpriseWorld.create(made, { kit: { badTemplate: "array" } })), /not a template/);
    await refused(buildWith(await EnterpriseWorld.create(made, { kit: { badTemplate: "no-resources" } })), /not a template/);
  });
});

describe("the recorded settings are the install's own", () => {
  const store = (): MemoryParameterStore => new MemoryParameterStore();
  it("refuse a missing record, an unreadable one, another environment's, another region's and another identity mode", async () => {
    const s = store();
    await refused(readSynthSettings(s, INSTALL), /no recorded build settings/);
    await s.put("/agentx/ent/synth-settings", "{not json");
    await refused(readSynthSettings(s, INSTALL), /not valid/);
    await s.put("/agentx/ent/synth-settings", JSON.stringify({ schemaVersion: 1 }));
    await refused(readSynthSettings(s, INSTALL), /not valid/);
    await s.put("/agentx/ent/synth-settings", JSON.stringify({ ...SETTINGS_ENT(), env: "other" }));
    await refused(readSynthSettings(s, INSTALL), /environment other/);
    await s.put("/agentx/ent/synth-settings", JSON.stringify({ ...SETTINGS_ENT(), region: "eu-west-1" }));
    await refused(readSynthSettings(s, INSTALL), /region eu-west-1/);
    await s.put("/agentx/ent/synth-settings", JSON.stringify({ ...SETTINGS_ENT(), identityMode: "oidc" }));
    await refused(readSynthSettings(s, INSTALL), /identity mode oidc/);
  });

  it("accept only the keys a build takes: no synthesizer, output directory, edition override, environment or any other context", async () => {
    const s = store();
    for (const key of ["agentxSynthesizer", "outdir", "rovaraEdition", "agentxEnv", "agentxRegion", "agentxIdentity", "agentxCloud", "CDK_CONTEXT_JSON", "agentxInstaller", "rovaraStdioMcpServers"]) {
      await refused(recordSynthSettings({ store: s, install: INSTALL, settings: { ...SETTINGS_ENT(), context: { [key]: "x" } } }), /not valid/);
    }
    await refused(recordSynthSettings({ store: s, install: INSTALL, settings: { ...SETTINGS_ENT(), edition: "public" } }), /not valid/);
    await refused(recordSynthSettings({ store: s, install: INSTALL, settings: { ...SETTINGS_ENT(), extra: 1 } }), /not valid/);
    await refused(recordSynthSettings({ store: s, install: INSTALL, settings: SETTINGS_ENT({ rovaraEnterpriseEgressCidrs: "10.0.0.0/8\u0000" }) }), /not valid/);
    // C1 controls (U+009B is a CSI), line separators and bidirectional marks and overrides would let a value read as something else on a terminal (review M3).
    for (const code of [0x7f, 0x80, 0x9b, 0x9f, 0x2028, 0x2029, 0x061c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069]) {
      await refused(recordSynthSettings({ store: s, install: INSTALL, settings: SETTINGS_ENT({ rovaraOperatorPrincipalArn: `arn:aws:iam::111122223333:role/x${String.fromCodePoint(code)}y` }) }), /not valid/);
    }
    expect(s.values.size).toBe(0);
    // An ordinary non-ASCII letter is fine.
    await recordSynthSettings({ store: s, install: INSTALL, settings: SETTINGS_ENT({ agentxEgressAllowDomains: "b\u00fccher.example.com" }) });
    // The DNS firewall allow-list is an install setting too (review I1): an upgrade must rebuild the foundation with it.
    await recordSynthSettings({ store: s, install: INSTALL, settings: SETTINGS_ENT({ agentxEgressAllowDomains: "pypi.internal.corp,*.artifactory.example.com" }) });
    expect(JSON.parse(s.values.get("/agentx/ent/synth-settings")!).context.agentxEgressAllowDomains).toBe("pypi.internal.corp,*.artifactory.example.com");
    const ok = await recordSynthSettings({ store: s, install: INSTALL, settings: SETTINGS_ENT() });
    expect(ok.sha256).toBe(synthSettingsSha256(SETTINGS_ENT()));
  });

  it("hash the same whatever order the keys were written in", () => {
    expect(synthSettingsSha256({ ...SETTINGS_ENT({ b: "1", a: "2" }) })).toBe(synthSettingsSha256(JSON.parse('{"context":{"a":"2","b":"1"},"identityMode":"cognito","region":"us-east-1","env":"ent","edition":"enterprise","schemaVersion":1}') as never));
  });
});

describe("agentx bundle approve, Enterprise", () => {
  it("builds, shows the build against the deployed stacks, places only the build, and writes the approval last with the result hash and every setting", async () => {
    const world = await EnterpriseWorld.create(made, { settings: SETTINGS_ENT({ rovaraEnterpriseEgressCidrs: "10.20.0.0/16", rovaraOperatorExternalId: "x".repeat(4) + "externalid-secret-12" }) });
    await world.deployAsBuilt(SETTINGS_ENT({ rovaraEnterpriseEgressCidrs: "10.20.0.0/16", rovaraOperatorExternalId: "x".repeat(4) + "externalid-secret-12" }));
    const order: string[] = [];
    const { record } = await world.approve({ beforeApproval: async () => { order.push(`images after ${String(world.puts.length)} puts`); } });
    ApprovalRecordSchema.parse(record);
    // Placed: the signed lineage and the build. Not placed: the bundle's own templates, packages, legal files, images, notes or the kit.
    expect(world.puts.filter((key) => key.includes("templates/us-east-1"))).toEqual([]);
    expect(world.puts.some((key) => /\/(images|notes|synth-kit|legal|packages)\//.test(key) && !key.includes("/built/"))).toBe(false);
    expect(world.puts).toEqual(expect.arrayContaining([`approved/${world.bundle.bundleSha256}/built/manifest.json`, `approved/${world.bundle.bundleSha256}/built/templates/control-plane.template.json`, `approved/${world.bundle.bundleSha256}/release.json`]));
    expect(world.puts[world.puts.length - 1]).toBe(`approvals/${world.bundle.bundleSha256}.json`);
    expect(world.puts.filter((key) => key.startsWith("approvals/"))).toHaveLength(1);
    expect(order).toEqual(["images after 0 puts"]);
    expect(record.build).toMatchObject({ settingsSha256: synthSettingsSha256(SETTINGS_ENT({ rovaraEnterpriseEgressCidrs: "10.20.0.0/16", rovaraOperatorExternalId: "x".repeat(4) + "externalid-secret-12" })) });
    expect(record.build!.settings.context.rovaraEnterpriseEgressCidrs).toBe("10.20.0.0/16");
    // A secret setting is pinned by its hash: it is in neither the record nor what was shown.
    expect(JSON.stringify(record)).not.toContain("externalid-secret-12");
    expect(world.output.join("\n")).not.toContain("externalid-secret-12");
    expect(record.build!.settings.context.rovaraOperatorExternalId).toMatch(/^sha256:[a-f0-9]{64}$/);
    // The summary says what changes.
    expect(world.output.join("\n")).toMatch(/result hash {3}[a-f0-9]{64}/);
    expect(world.output.join("\n")).toMatch(/access: unchanged/);
    expect(world.output.join("\n")).toMatch(/foundation: changed \(1 added, 1 removed/);
  });

  it("reads the edition from the record, or from its backup while a deploy has the record out of the way, and refuses when the two disagree", async () => {
    const { editionBackupParameter, editionRecordParameter } = await import("@agentx/contracts");
    const backupOnly = await EnterpriseWorld.create(made);
    await backupOnly.deployAsBuilt();
    await backupOnly.store.delete(editionRecordParameter("ent"));
    await backupOnly.store.put(editionBackupParameter("ent"), "enterprise");
    await backupOnly.approve();
    expect(backupOnly.puts.length).toBeGreaterThan(3);
    const disagree = await EnterpriseWorld.create(made);
    await disagree.deployAsBuilt();
    await disagree.store.put(editionBackupParameter("ent"), "public");
    await refused(disagree.approve(), /disagree/);
    expect(disagree.puts).toEqual([]);
  });

  it("is refused for an install that is not recorded as Enterprise, and for a bundle with no kit, before anything is placed", async () => {
    const garbage = await EnterpriseWorld.create(made, { edition: "something else" });
    await refused(garbage.approve(), /edition recorded for environment ent .* is not "enterprise" or "public"/);
    expect(garbage.puts).toEqual([]);
    const notEnterprise = await EnterpriseWorld.create(made, { edition: "public" });
    await refused(notEnterprise.approve(), /not recorded as an Enterprise install/);
    expect(notEnterprise.puts).toEqual([]);
    const noKit = await EnterpriseWorld.create(made, { kit: false });
    await noKit.deployAsBuilt().catch(() => undefined);
    await refused(noKit.approve(), /no synthesis kit/);
    expect(noKit.puts).toEqual([]);
  });

  it("is refused when the access stack would change, when a stack is not deployed, and when the settings are not recorded", async () => {
    const changed = await EnterpriseWorld.create(made);
    await changed.deployAsBuilt();
    changed.world.stacks.set("agentx-ent-access", { ...changed.world.stacks.get("agentx-ent-access")!, template: JSON.stringify({ Resources: { Other: { Type: "AWS::SSM::Parameter", Properties: {} } } }) });
    await refused(changed.approve(), /access stack is not the deployed one/);
    expect(changed.puts).toEqual([]);
    const missing = await EnterpriseWorld.create(made);
    await missing.deployAsBuilt();
    missing.world.stacks.delete("agentx-ent-runtime");
    await refused(missing.approve(), /runtime stack is not deployed/);
    const unrecorded = await EnterpriseWorld.create(made);
    await unrecorded.deployAsBuilt();
    await unrecorded.store.delete("/agentx/ent/synth-settings");
    await refused(unrecorded.approve(), /no recorded build settings/);
    expect(unrecorded.puts).toEqual([]);
  });

  it("asks before it writes, writes nothing when declined, and needs --yes without a terminal", async () => {
    const world = await EnterpriseWorld.create(made);
    await world.deployAsBuilt();
    await refused(world.approve({ yes: false, interactive: false }), /needs --yes/);
    await refused(world.approve({ yes: false, interactive: false, confirmFlag: "--approve-build" }), /needs --approve-build/);
    await refused(world.approve({ yes: false, interactive: true, ask: async () => "n" }), /not approved/);
    expect(world.puts).toEqual([]);
    const asked: string[] = [];
    await world.approve({ yes: false, interactive: true, ask: async (q) => { asked.push(q); return "yes"; } });
    expect(asked).toHaveLength(1);
    expect(world.puts.length).toBeGreaterThan(3);
  });

  it("never loads images or writes a thing for a refused build, and refuses an approval whose settings changed while it was built", async () => {
    const world = await EnterpriseWorld.create(made);
    await world.deployAsBuilt();
    let loaded = 0;
    world.world.stacks.delete("agentx-ent-slack");
    await refused(world.approve({ beforeApproval: async () => { loaded += 1; } }), /slack stack is not deployed/);
    expect(loaded).toBe(0);
    expect(world.puts).toEqual([]);
    await world.deployAsBuilt();
    await refused(world.approve({ beforeApproval: async () => { await world.store.put("/agentx/ent/synth-settings", JSON.stringify(SETTINGS_ENT({ rovaraEnterpriseEgressCidrs: "10.99.0.0/16" }))); } }), /changed while the build was made/);
    expect(world.puts).toEqual([]);
  });

  it("offers no option that reaches the build: the command takes a bundle, its id, parameters for the deployment, rollback, a key, a region, --yes and --write-build (a folder to write the build to), nothing else", async () => {
    const { Command } = await import("commander");
    const { registerUpgradeCommand } = await import("../../packages/cli/src/upgrade/cli.js");
    const program = new Command().option("--env <env>").option("--json").option("--config-dir <dir>");
    registerUpgradeCommand(program, { parameterStore: () => new MemoryParameterStore(), fetch, home: "/nonexistent", stdout: { write: () => true }, stderr: { write: () => true } });
    const approve = program.commands.find((c) => c.name() === "bundle")!.commands.find((c) => c.name() === "approve")!;
    expect(approve.options.map((o) => o.long).sort()).toEqual(["--approved-bundle-sha256", "--bundle", "--bundle-public-key", "--parameters", "--region", "--rollback", "--write-build", "--yes"]);
    const recordSettings = program.commands.find((c) => c.name() === "bundle")!.commands.find((c) => c.name() === "record-settings")!;
    expect(recordSettings.options.map((o) => o.long).sort()).toEqual(["--file", "--region"]);
  });
});

describe("the kit is part of the signed bundle", () => {
  it("names its entry as a .mjs file under synth-kit/, nothing else", async () => {
    const { SynthKitManifestSchema } = await import("@agentx/contracts");
    const kit = { schemaVersion: 1, format: "rovara-synth-kit", nodeMajor: 22, releaseSha256: "a".repeat(64), gitCommit: "b".repeat(40) };
    expect(SynthKitManifestSchema.safeParse({ ...kit, entry: "synth-kit/synth.mjs" }).success).toBe(true);
    for (const entry of ["synth-kit/synth.js", "other/synth.mjs", "synth.mjs", "synth-kit/../x.mjs"]) expect(SynthKitManifestSchema.safeParse({ ...kit, entry }).success, entry).toBe(false);
  });

  it("is refused at approval when the bundle's release is not the release the kit says it was made from", async () => {
    const world = await EnterpriseWorld.create(made);
    const verified = await world.verify();
    try {
      await expect(buildAtApproval({ bundle: { ...verified, manifest: { ...verified.manifest, gitCommit: "c".repeat(40) } }, settings: SETTINGS_ENT(), runner: testRunner })).rejects.toThrow(/made from another release/);
      const files = verified.manifest.files.map((entry) => (entry.file === "release.json" ? { ...entry, sha256: "d".repeat(64) } : entry));
      await expect(buildAtApproval({ bundle: { ...verified, manifest: { ...verified.manifest, files } }, settings: SETTINGS_ENT(), runner: testRunner })).rejects.toThrow(/made from another release/);
      // Positive control: the same bundle builds.
      await buildAtApproval({ bundle: verified, settings: SETTINGS_ENT(), runner: testRunner });
    } finally {
      await verified.cleanup();
    }
  });

  it("is listed, hashed and signed with the other files, and a changed kit file is refused like any changed file", async () => {
    const { readFile, writeFile } = await import("node:fs/promises");
    const { BundleManifestSchema } = await import("@agentx/contracts");
    const { verifyBundle } = await import("../../packages/cli/src/upgrade/bundle/verify.js");
    const world = await EnterpriseWorld.create(made);
    const manifest = BundleManifestSchema.parse(JSON.parse(await readFile(join(world.bundle.dir, "bundle.json"), "utf8")));
    expect(manifest.files.filter((f) => f.kind === "synth-kit").map((f) => f.file)).toEqual(["synth-kit/kit.json", "synth-kit/synth.mjs"]);
    await writeFile(join(world.bundle.dir, "synth-kit", "synth.mjs"), "// changed after signing\n");
    await expect(verifyBundle({ dir: world.bundle.dir, trustedKeys: [world.bundle.key.publicKeyPem] })).rejects.toThrow(/synth-kit\/synth.mjs does not match the signed manifest/);
  });

  it("keeps the kit's kind and directory together, and requires its kit.json", async () => {
    const { BundleManifestSchema } = await import("@agentx/contracts");
    const file = (name: string, kind: string) => ({ file: name, kind, sha256: "a".repeat(64), bytes: 1 });
    const base = { schemaVersion: 1, format: "rovara-release-bundle", version: "1.4.0", gitCommit: "b".repeat(40), images: [] };
    const release = file("release.json", "release-manifest");
    expect(BundleManifestSchema.safeParse({ ...base, files: [release, file("synth-kit/kit.json", "synth-kit"), file("synth-kit/synth.mjs", "synth-kit")] }).success).toBe(true);
    expect(BundleManifestSchema.safeParse({ ...base, files: [release, file("other/kit.json", "synth-kit")] }).success).toBe(false);
    expect(BundleManifestSchema.safeParse({ ...base, files: [release, file("synth-kit/evil.json", "template"), file("synth-kit/kit.json", "synth-kit")] }).success).toBe(false);
    expect(BundleManifestSchema.safeParse({ ...base, files: [release, file("synth-kit/synth.mjs", "synth-kit")] }).success).toBe(false);
  });

  it("is refused by the builder when it has no kit.json, names an entry it does not hold, or holds a link", async () => {
    const { mkdir, symlink, writeFile } = await import("node:fs/promises");
    const { buildBundle } = await import("../../scripts/release/bundle.js");
    const { writeRelease, IMAGES, fakeExporter, newTestKey, NO_KIT_CHECK } = await import("../support/bundle-fixture.js");
    const { writeFakeKit } = await import("../support/synth-kit-fixture.js");
    const root = await mkdtemp(join(tmpdir(), "kit-build-"));
    roots.push(root);
    const release = join(root, "release");
    await mkdir(release);
    await writeRelease(release);
    const attempt = async (name: string, prepare: (dir: string) => Promise<void>) => {
      const dir = join(root, name);
      await writeFakeKit(dir, { releaseSha256: sha256OfBytes(await readFile(join(release, "release.json"))) });
      await prepare(dir);
      return buildBundle({ releaseDir: release, out: join(root, `out-${name}`), images: IMAGES, exportImage: fakeExporter, signer: newTestKey().signer, synthKitDir: dir, kitCheck: NO_KIT_CHECK });
    };
    await expect(attempt("nokit", async (dir) => { await rm(join(dir, "kit.json")); })).rejects.toThrow(/no kit\.json/);
    const edited = (change: Record<string, string>) => async (dir: string) => {
      const kit = JSON.parse(await readFile(join(dir, "kit.json"), "utf8")) as Record<string, unknown>;
      await writeFile(join(dir, "kit.json"), JSON.stringify({ ...kit, ...change }));
    };
    await expect(attempt("otherhash", edited({ releaseSha256: "e".repeat(64) }))).rejects.toThrow(/different release/);
    await expect(attempt("othercommit", edited({ gitCommit: "e".repeat(40) }))).rejects.toThrow(/different release/);
    await attempt("rightrelease", async () => undefined);
    await expect(attempt("noentry", async (dir) => { await rm(join(dir, "synth.mjs")); })).rejects.toThrow(/entry is not in the kit/);
    await expect(attempt("link", async (dir) => { await symlink("/etc/hosts", join(dir, "evil.mjs")); })).rejects.toThrow(/link or a special file/);
    await expect(attempt("badjson", async (dir) => { await writeFile(join(dir, "kit.json"), "{}"); })).rejects.toThrow();
  });
});
