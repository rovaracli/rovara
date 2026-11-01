/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- parsed template JSON is untyped */
// BA-3: the release step that makes the REAL synthesis kit (the release's CDK app, aws-cdk-lib inside, bundled by esbuild), and the proof that approval can use it. This builds a real release
// (it needs `npm run build:web` first, as the release build does), the real kit from it, a signed bundle carrying the kit, and then runs the kit through the existing runner, verification
// and approval against a sample Enterprise install, on this computer. Each test names the guard it protects.
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILT_PARTS, BuiltManifestSchema, BundleManifestSchema, ENVIRONMENT_PLACEHOLDER, SynthKitManifestSchema, SynthOutputSchema, canonicalJson, sha256OfBytes, synthContext, synthKitSha256 } from "@agentx/contracts";
import { buildBundle } from "../../scripts/release/bundle.js";
import { RELEASE_SYNTH_ROOT, buildRelease, synthReleaseProfile } from "../../scripts/release/build.js";
import { ReleaseManifestSchema, type ReleaseManifest } from "../../scripts/release/manifest.js";
import { buildSynthKit, firstTreeDifference, selfCheck } from "../../scripts/release/synth-kit.js";
import { assertNoLookups, checkedContext } from "../../scripts/release/synth-kit/kit-checks.js";
import { verifyBundle } from "../../packages/cli/src/upgrade/bundle/verify.js";
import { buildAtApproval } from "../../packages/cli/src/upgrade/bundle/build-at-approval.js";
import { fakeExporter, IMAGES, newTestKey, type BuiltBundle } from "../support/bundle-fixture.js";
import { EnterpriseWorld, SETTINGS_ENT } from "../support/enterprise-approval-world.js";
import { testRunner } from "../support/kit-runner.js";
import { writeFakeKit } from "../support/synth-kit-fixture.js";

if (!existsSync("packages/web/dist/app/index.html")) throw new Error("the release build needs the web app first: run `npm run build:web`");

const made: BuiltBundle[] = [];
let root: string;
let release: ReleaseManifest;
let releaseDir: string;
let kitDir: string;
let built: BuiltBundle;
let sandboxed = false;

/** A sample Enterprise install's recorded settings: every kind of thing that adds to the stacks (operator access adds a Lambda function to the access stack). */
const OPERATOR_CONTEXT = {
  rovaraEnterpriseEgressCidrs: "10.20.0.0/16",
  agentxAuditTsa: "off",
  rovaraOperatorAccess: "enabled",
  rovaraOperatorPrincipalArn: "arn:aws:iam::210987654321:role/customer-operators",
  rovaraOperatorExternalId: "sample-install-external-id-0001",
  rovaraBundleApproverArns: "arn:aws:iam::123456789012:role/customer-approvers",
};

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "synth-kit-test-")));
  releaseDir = join(root, "release");
  kitDir = join(root, "kit");
  await buildRelease({ version: "1.4.0", out: releaseDir, gitCommit: "b".repeat(40) });
  release = ReleaseManifestSchema.parse(JSON.parse(await readFile(join(releaseDir, "release.json"), "utf8")));
  // The step under test: it runs the kit twice and against the release itself before it returns.
  sandboxed = (await buildSynthKit({ releaseDir, out: kitDir })).sandboxed;
  const key = newTestKey();
  const dir = join(root, "bundle");
  const { bundleSha256 } = await buildBundle({ releaseDir, out: dir, images: IMAGES.filter((image) => image.name === "litellm"), exportImage: fakeExporter, signer: key.signer, synthKitDir: kitDir });
  built = { root, dir, bundleSha256, key, cleanup: async () => undefined };
}, 1_800_000);
afterAll(async () => {
  await Promise.all(made.splice(0).map((bundle) => bundle.cleanup()));
  await rm(root, { recursive: true, force: true });
});

async function enterpriseWorld(context: Record<string, string>): Promise<EnterpriseWorld> {
  const world = new EnterpriseWorld(made);
  world.bundle = built;
  await world.setSettings(SETTINGS_ENT(context));
  await world.setEdition("enterprise");
  world.world.seed({ key: built.key.publicKeyPem });
  return world;
}

describe("the kit the release step makes", () => {
  it("is a kit.json, one ES module with the CDK app inside, the code map and the release's own code packages, and no way to build code from source", async () => {
    expect(SynthKitManifestSchema.parse(JSON.parse(await readFile(join(kitDir, "kit.json"), "utf8")))).toMatchObject({ entry: "synth-kit/synth.mjs", nodeMajor: 22 });
    const files = (await readdir(kitDir)).sort();
    expect(files).toEqual(["code", "code-map.json", "kit.json", "synth.mjs"]);
    const entry = await readFile(join(kitDir, "synth.mjs"), "utf8");
    // aws-cdk-lib is inside (the kit needs nothing from node_modules), and its own source bundler is not.
    expect(entry).toContain("LegacyStackSynthesizer");
    expect(entry).not.toMatch(/aws-cdk-lib\/aws-lambda-nodejs\/lib\//);
    expect(entry).not.toMatch(/from "esbuild"|require\("esbuild"\)/);
    // Every code package in the kit is a package the release signs, byte for byte (the kit copies; it does not make code).
    const listed = new Map([...release.packages, ...(release.enterprisePackages ?? [])].map((pkg) => [pkg.assetId, pkg.sha256]));
    const codeFiles = await readdir(join(kitDir, "code"));
    expect(codeFiles.length).toBeGreaterThan(0);
    for (const file of codeFiles) expect(sha256OfBytes(await readFile(join(kitDir, "code", file))), file).toBe(listed.get(file.replace(/\.zip$/, "")));
    const map = JSON.parse(await readFile(join(kitDir, "code-map.json"), "utf8")) as { functions: Array<{ path: string; assetId: string }> };
    expect(map.functions.some((fn) => fn.path === "AgentXControlPlane/Broker")).toBe(true);
    expect(map.functions.some((fn) => fn.path.startsWith("AgentXAccess/"))).toBe(true);
    expect(new Set(map.functions.map((fn) => `${fn.assetId}.zip`))).toEqual(new Set(codeFiles));
  });

  it("goes into the signed bundle: the kit files are signed as the kit, and the Enterprise-only code is signed as a package", async () => {
    const signed = BundleManifestSchema.parse(JSON.parse(await readFile(join(built.dir, "bundle.json"), "utf8")));
    const kitFiles = signed.files.filter((entry) => entry.kind === "synth-kit").map((entry) => entry.file);
    expect(kitFiles).toEqual(expect.arrayContaining(["synth-kit/kit.json", "synth-kit/synth.mjs", "synth-kit/code-map.json"]));
    for (const pkg of release.enterprisePackages ?? []) expect(signed.files.find((entry) => entry.file === pkg.file)).toMatchObject({ kind: "package", sha256: pkg.sha256 });
    const verified = await verifyBundle({ dir: built.dir, trustedKeys: [built.key.publicKeyPem], approvedBundleSha256: built.bundleSha256 });
    await verified.cleanup();
  });
});

describe("approval with the real kit", () => {
  it("verifies the bundle, runs the kit for a sample Enterprise install and approves what it built, with the access stack's deployer included", async () => {
    const world = await enterpriseWorld(OPERATOR_CONTEXT);
    await world.deployAsBuilt(SETTINGS_ENT(OPERATOR_CONTEXT));
    const { record } = await world.approve();
    expect(record.build).toBeDefined();
    const files = [...world.world.versions.keys()].filter((key) => key.includes("/built/"));
    expect(files.some((key) => key.endsWith("built/manifest.json"))).toBe(true);
    // What was built: every stack for the install, named for the install and not for the release's placeholder.
    const verified = await verifyBundle({ dir: built.dir, trustedKeys: [built.key.publicKeyPem], approvedBundleSha256: built.bundleSha256 });
    try {
      const result = await buildAtApproval({ bundle: verified, settings: SETTINGS_ENT(OPERATOR_CONTEXT), runner: testRunner });
      expect(BuiltManifestSchema.parse(result.manifest).templates.map((t) => t.part)).toEqual(["access", "foundation", "identity", "runtime", "control-plane", "slack"]);
      expect(record.build?.resultSha256).toBe(result.resultSha256);
      expect(record.build?.kitSha256).toBe(synthKitSha256(BundleManifestSchema.parse(JSON.parse(await readFile(join(built.dir, "bundle.json"), "utf8"))).files));
      // The packages are the signed release's, and the Enterprise-only one (the operator-access deployer) is among them, for the access stack.
      const signed = new Map([...release.packages, ...(release.enterprisePackages ?? [])].map((pkg) => [pkg.assetId, pkg.sha256]));
      for (const pkg of result.manifest.packages) expect(pkg.sha256, pkg.assetId).toBe(signed.get(pkg.assetId));
      const accessPackages = result.manifest.packages.filter((pkg) => pkg.parts.includes("access"));
      expect(accessPackages.map((pkg) => pkg.assetId)).toEqual((release.enterprisePackages ?? []).map((pkg) => pkg.assetId));
      expect(result.manifest.packages.filter((pkg) => pkg.parts.includes("control-plane")).length).toBeGreaterThanOrEqual(release.packages.length);
      const access = result.files.find((file) => file.file === "built/templates/access.template.json")!.body.toString("utf8");
      expect(access).toContain("agentx-ent-rovara-operator");
      expect(access).not.toContain(ENVIRONMENT_PLACEHOLDER);
      const control = JSON.parse(result.files.find((file) => file.file === "built/templates/control-plane.template.json")!.body.toString("utf8"));
      expect(JSON.stringify(control)).toContain("10.20.0.0/16");
      expect(control.Resources).toBeDefined();
    } finally {
      await verified.cleanup();
    }
  }, 600_000);

  it("makes the templates a build from source makes for the same Enterprise install (the stand-in for the source bundler changes nothing the templates say)", async () => {
    const context = synthContext(SETTINGS_ENT(OPERATOR_CONTEXT));
    const parent = await realpath(await mkdtemp(join(tmpdir(), "kit-parity-")));
    await mkdir(RELEASE_SYNTH_ROOT, { recursive: true });
    const synthDir = await mkdtemp(join(RELEASE_SYNTH_ROOT, "run-"));
    try {
      const workDir = join(parent, "work");
      const outDir = join(parent, "out");
      await mkdir(workDir, { mode: 0o700 });
      await mkdir(join(outDir, "templates"), { recursive: true, mode: 0o700 });
      await mkdir(join(outDir, "packages"), { recursive: true, mode: 0o700 });
      const contextFile = join(workDir, "context.json");
      await writeFile(contextFile, canonicalJson({ context }), { mode: 0o400 });
      await testRunner.run({ entry: join(kitDir, "synth.mjs"), kitDir, contextFile, outDir, workDir });
      const { assembly } = synthReleaseProfile({ context, outdir: synthDir });
      const fromSource = new Map(assembly.stacks.map((stack) => [stack.stackName, stack]));
      for (const part of BUILT_PARTS) {
        const stack = fromSource.get(`agentx-ent-${part}`);
        expect(stack, part).toBeDefined();
        const kitTemplate = JSON.parse(await readFile(join(outDir, "templates", `${part}.template.json`), "utf8")) as unknown;
        expect(canonicalJson(kitTemplate) === canonicalJson(stack!.template), `${part} template differs from a build from source`).toBe(true);
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(synthDir, { recursive: true, force: true });
    }
  }, 600_000);

  it("is deterministic with the real kit: other settings, other directories, other temp folder, same bytes twice", async () => {
    const verified = await verifyBundle({ dir: built.dir, trustedKeys: [built.key.publicKeyPem], approvedBundleSha256: built.bundleSha256 });
    const elsewhere = await mkdtemp(join(tmpdir(), "other-tmp-"));
    const previous = process.env.TMPDIR;
    try {
      const settings = SETTINGS_ENT({ ...OPERATOR_CONTEXT, rovaraEnterpriseEgressCidrs: "10.30.0.0/16,10.31.0.0/16" });
      const first = await buildAtApproval({ bundle: verified, settings, runner: testRunner });
      process.env.TMPDIR = elsewhere;
      const second = await buildAtApproval({ bundle: verified, settings, runner: testRunner });
      expect(second.resultSha256).toBe(first.resultSha256);
      // Another setting is another hash (the build really is made from the settings).
      const other = await buildAtApproval({ bundle: verified, settings: SETTINGS_ENT({ ...OPERATOR_CONTEXT, rovaraEnterpriseEgressCidrs: "10.40.0.0/16" }), runner: testRunner });
      expect(other.resultSha256).not.toBe(first.resultSha256);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
      await rm(elsewhere, { recursive: true, force: true });
      await verified.cleanup();
    }
  }, 600_000);

  it("runs in the operating system sandbox where this computer has one (so the macOS profile is enough for the real kit)", () => {
    // On macOS the existing profile (no network, writes only to its two directories, credential folders unreadable) ran the real kit above: nothing needed loosening.
    if (process.platform === "darwin") expect(sandboxed).toBe(true);
  });
});

describe("the kit's prebuilt code", () => {
  /** A copy of the kit with `change` applied, and the output of one run of it. Fails or returns the output tree. */
  async function runVariant(change: (copy: string) => Promise<void>): Promise<void> {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "kit-variant-")));
    try {
      const copy = join(parent, "kit");
      await cp(kitDir, copy, { recursive: true, mode: constants.COPYFILE_FICLONE });
      await change(copy);
      const workDir = join(parent, "work");
      const outDir = join(parent, "out");
      await mkdir(workDir, { mode: 0o700 });
      await mkdir(join(outDir, "templates"), { recursive: true, mode: 0o700 });
      await mkdir(join(outDir, "packages"), { recursive: true, mode: 0o700 });
      const contextFile = join(workDir, "context.json");
      await writeFile(contextFile, canonicalJson({ context: synthContext(SETTINGS_ENT(OPERATOR_CONTEXT)) }), { mode: 0o400 });
      await testRunner.run({ entry: join(copy, "synth.mjs"), kitDir: copy, contextFile, outDir, workDir });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }

  it("runs unchanged (positive control for the two refusals below)", async () => {
    await runVariant(async () => undefined);
  }, 300_000);

  it("stops when a function is missing from the code map: it never falls back to building from source", async () => {
    await expect(runVariant(async (copy) => {
      const path = join(copy, "code-map.json");
      const map = JSON.parse(await readFile(path, "utf8")) as { functions: Array<{ path: string }> };
      map.functions = map.functions.filter((fn) => fn.path !== "AgentXControlPlane/Broker");
      await writeFile(path, JSON.stringify(map));
    })).rejects.toThrow(/no prebuilt code for the function AgentXControlPlane\/Broker/);
  }, 300_000);

  it("stops when the access stack's function is missing from the code map (the Enterprise-only one)", async () => {
    await expect(runVariant(async (copy) => {
      const path = join(copy, "code-map.json");
      const map = JSON.parse(await readFile(path, "utf8")) as { functions: Array<{ path: string }> };
      const before = map.functions.length;
      map.functions = map.functions.filter((fn) => !fn.path.startsWith("AgentXAccess/"));
      expect(map.functions.length).toBeLessThan(before);
      await writeFile(path, JSON.stringify(map));
    })).rejects.toThrow(/no prebuilt code for the function AgentXAccess\//);
  }, 300_000);

  it("stops when a code package the map names is not in the kit", async () => {
    await expect(runVariant(async (copy) => {
      const [first] = await readdir(join(copy, "code"));
      await rm(join(copy, "code", first!));
    })).rejects.toThrow(/carries no code package/);
  }, 300_000);

  it("names a function twice only once (a duplicated map entry is refused)", async () => {
    await expect(runVariant(async (copy) => {
      const path = join(copy, "code-map.json");
      const map = JSON.parse(await readFile(path, "utf8")) as { functions: unknown[] };
      map.functions.push(map.functions[0]);
      await writeFile(path, JSON.stringify(map));
    })).rejects.toThrow(/names .* twice/);
  }, 300_000);

  it("a kit output validates as the build expects it", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "kit-output-")));
    try {
      const workDir = join(parent, "work");
      const outDir = join(parent, "out");
      await mkdir(workDir, { mode: 0o700 });
      await mkdir(join(outDir, "templates"), { recursive: true, mode: 0o700 });
      await mkdir(join(outDir, "packages"), { recursive: true, mode: 0o700 });
      const contextFile = join(workDir, "context.json");
      await writeFile(contextFile, canonicalJson({ context: synthContext(SETTINGS_ENT(OPERATOR_CONTEXT)) }), { mode: 0o400 });
      await testRunner.run({ entry: join(kitDir, "synth.mjs"), kitDir, contextFile, outDir, workDir });
      const output = SynthOutputSchema.parse(JSON.parse(await readFile(join(outDir, "kit-output.json"), "utf8")));
      expect(output.packages.length).toBeGreaterThan(release.packages.length - 1);
      expect(output.packages.map((pkg) => pkg.assetId)).toEqual([...output.packages.map((pkg) => pkg.assetId)].sort());
      // Nothing of the machine or the run in any output (no absolute path, no temp folder name).
      const text = JSON.stringify(await Promise.all((await readdir(join(outDir, "templates"))).map((file) => readFile(join(outDir, "templates", file), "utf8"))));
      expect(text).not.toContain(parent);
      expect(text).not.toContain(tmpdir());
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 300_000);
});

describe("the release's determinism self-check", () => {
  async function fakeKit(options: Parameters<typeof writeFakeKit>[1]): Promise<string> {
    const dir = join(root, `fake-${Math.random().toString(36).slice(2)}`);
    await writeFakeKit(dir, options);
    return dir;
  }

  it("refuses a kit whose two runs differ", async () => {
    const dir = await fakeKit({ leakPath: true });
    await expect(selfCheck({ kitRoot: dir, release, releaseDir, runner: testRunner })).rejects.toThrow(/not deterministic/);
  }, 300_000);

  it("passes the determinism part for a steady kit (and then fails on the release's own templates, which the stand-in kit does not make)", async () => {
    const dir = await fakeKit({});
    await expect(selfCheck({ kitRoot: dir, release, releaseDir, runner: testRunner })).rejects.toThrow(/differs from the release's own|made no/);
  }, 300_000);

  it("finds the first difference between two output trees, and none between equal ones", async () => {
    const a = join(root, "tree-a");
    const b = join(root, "tree-b");
    for (const dir of [a, b]) {
      await mkdir(join(dir, "templates"), { recursive: true });
      await writeFile(join(dir, "templates", "x.json"), "same");
    }
    expect(await firstTreeDifference(a, b)).toBeUndefined();
    await writeFile(join(b, "templates", "x.json"), "other");
    expect(await firstTreeDifference(a, b)).toBe("templates/x.json differs");
    await writeFile(join(a, "templates", "x.json"), "other");
    await copyFile(join(a, "templates", "x.json"), join(a, "extra.json"));
    expect(await firstTreeDifference(a, b)).toMatch(/different files/);
  });
});

describe("the kit makes no AWS call", () => {
  it("stops when the app asks for something to be looked up in an account", () => {
    expect(() => assertNoLookups({ missing: [{ key: "vpc-provider:account=1:filter.vpc-id=vpc-1:region=us-east-1" }] })).toThrow(/looked up in an AWS account/);
    expect(() => assertNoLookups({ missing: [] })).not.toThrow();
    expect(() => assertNoLookups({})).not.toThrow();
  });

  it("takes only text settings", () => {
    expect(checkedContext({ a: "b" })).toEqual({ a: "b" });
    for (const bad of [null, [], "x", { a: 1 }, { a: { b: "c" } }, Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${String(i)}`, "v"]))]) expect(() => checkedContext(bad)).toThrow();
  });
});
