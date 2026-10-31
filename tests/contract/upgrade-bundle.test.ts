// Enterprise foundations, N3: `rovara upgrade --bundle` verifies the signature and every hash before it changes anything, and records a restore point.
// Every verification step has a test that goes red when the step is removed (see the lane report's mutation table).
import { link, readFile, readdir, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetTemplateCommand } from "@aws-sdk/client-cloudformation";
import { afterEach, describe, expect, it } from "vitest";
import { BundleManifestSchema, sha256OfBytes } from "@agentx/contracts";
import { ParameterExistsError } from "../../packages/cli/src/environments/parameter-store.js";
import { readEnvironmentSettings, writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { installedBundleParameter, restorePointParameter } from "../../packages/cli/src/upgrade/bundle/restore-point.js";
import { verifyBundle } from "../../packages/cli/src/upgrade/bundle/verify.js";
import { runUpgrade, type UpgradeDependencies } from "../../packages/cli/src/upgrade/run.js";
import { builtBundle, newTestKey, type BuiltBundle } from "../support/bundle-fixture.js";
import { SETTINGS } from "../support/doctor-fakes.js";
import { allStackOutputs, memoryInitSecrets, scriptedDeployer, T0 } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const made: BuiltBundle[] = [];
afterEach(async () => { await Promise.all(made.splice(0).map((bundle) => bundle.cleanup())); });
const build = async (options?: Parameters<typeof builtBundle>[0]) => { const bundle = await builtBundle(options); made.push(bundle); return bundle; };
const refused = (promise: Promise<unknown>, pattern: RegExp) => expect(promise).rejects.toThrow(pattern);
const trust = (bundle: BuiltBundle) => [bundle.key.publicKeyPem];

describe("verifyBundle", () => {
  it("accepts an untouched bundle and names it by the hash of bundle.json", async () => {
    const bundle = await build();
    const verified = await verifyBundle({ dir: bundle.dir, trustedKeys: trust(bundle), approvedBundleSha256: bundle.bundleSha256 });
    expect(verified.bundleId).toBe(bundle.bundleSha256);
    expect(verified.release.manifest.version).toBe("1.4.0");
    expect(verified.manifest.images.map((image) => image.name)).toEqual(["litellm", "slack", "worker"]);
  });

  it("refuses everything when no key is trusted, and a bundle signed by a key that is not the trusted one", async () => {
    const bundle = await build();
    await refused(verifyBundle({ dir: bundle.dir, trustedKeys: [] }), /pins no bundle signing key/);
    await refused(verifyBundle({ dir: bundle.dir, trustedKeys: [newTestKey().publicKeyPem] }), /key this installation does not trust/);
    // A private key or junk in the trusted list never counts as trust.
    await refused(verifyBundle({ dir: bundle.dir, trustedKeys: ["-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", "junk"] }), /does not trust/);
  });

  it("refuses a bundle re-signed by an attacker's own key even when every hash is consistent", async () => {
    const bundle = await build();
    const attacker = await build();
    // The attacker's bundle is internally perfect; only the key differs.
    await refused(verifyBundle({ dir: attacker.dir, trustedKeys: trust(bundle) }), /does not trust/);
  });

  it("refuses one changed byte of bundle.json, of the signature, and of the signature's key id", async () => {
    const bundle = await build();
    const manifestPath = join(bundle.dir, "bundle.json");
    const original = await readFile(manifestPath);
    const flipped = Buffer.from(original); flipped[10] = flipped[10]! ^ 1;
    await writeFile(manifestPath, flipped);
    await refused(verifyBundle({ dir: bundle.dir, trustedKeys: trust(bundle) }), /names a different bundle.json/);
    // The signature file updated to the new bytes' hash: only the signature itself can catch it now.
    const sigFile = JSON.parse(await readFile(join(bundle.dir, "bundle.sig.json"), "utf8")) as Record<string, unknown>;
    await writeFile(join(bundle.dir, "bundle.sig.json"), JSON.stringify({ ...sigFile, bundleSha256: sha256OfBytes(flipped) }));
    await refused(verifyBundle({ dir: bundle.dir, trustedKeys: trust(bundle) }), /signature does not match/);
    await writeFile(join(bundle.dir, "bundle.sig.json"), JSON.stringify(sigFile));
    await writeFile(manifestPath, original);
    const sigPath = join(bundle.dir, "bundle.sig.json");
    const sig = JSON.parse(await readFile(sigPath, "utf8")) as { signature: string; keyId: string; bundleSha256: string };
    const bytes = Buffer.from(sig.signature, "base64"); bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 1;
    await writeFile(sigPath, JSON.stringify({ ...sig, signature: bytes.toString("base64") }));
    await refused(verifyBundle({ dir: bundle.dir, trustedKeys: trust(bundle) }), /signature does not match/);
    await writeFile(sigPath, JSON.stringify({ ...sig, keyId: "0".repeat(64) }));
    await refused(verifyBundle({ dir: bundle.dir, trustedKeys: trust(bundle) }), /does not trust/);
    // The unmodified pair still verifies: the refusals above were the edits.
    await writeFile(sigPath, JSON.stringify(sig));
    await verifyBundle({ dir: bundle.dir, trustedKeys: trust(bundle) });
  });

  it.each([
    ["a template", "templates/us-east-1/control-plane.template.json"],
    ["a package", "packages"],
    ["an image archive", "images/litellm.oci.tar"],
    ["the LiteLLM image's neighbour", "images/worker.oci.tar"],
    ["a legal document", "legal/LICENSE"],
    ["the release manifest", "release.json"],
    ["the notes", "notes/RELEASE-NOTES.md"],
  ])("refuses one changed byte in %s", async (_name, target) => {
    const bundle = await build();
    const file = target === "packages" ? `packages/${(await readdir(join(bundle.dir, "packages")))[0]}` : target;
    const path = join(bundle.dir, file);
    const data = Buffer.from(await readFile(path)); data[0] = data[0]! ^ 1;
    await writeFile(path, data);
    await refused(verifyBundle({ dir: bundle.dir, trustedKeys: trust(bundle) }), /does not match the signed manifest/);
  });

  it("refuses a file that grew or shrank by a byte even if the first bytes agree", async () => {
    const bundle = await build();
    const path = join(bundle.dir, "images/litellm.oci.tar");
    await writeFile(path, Buffer.concat([await readFile(path), Buffer.from("x")]));
    await refused(verifyBundle({ dir: bundle.dir, trustedKeys: trust(bundle) }), /images\/litellm.oci.tar does not match/);
  });

  it("refuses an extra file, a missing file, and a link", async () => {
    const bundle = await build();
    await writeFile(join(bundle.dir, "images", "extra.oci.tar"), "x");
    await refused(verifyBundle({ dir: bundle.dir, trustedKeys: trust(bundle) }), /in the directory but not in the signed manifest/);
    await unlink(join(bundle.dir, "images", "extra.oci.tar"));
    await rename(join(bundle.dir, "legal", "LICENSE"), join(bundle.root, "LICENSE.moved"));
    await refused(verifyBundle({ dir: bundle.dir, trustedKeys: trust(bundle) }), /missing from the directory/);
    await rename(join(bundle.root, "LICENSE.moved"), join(bundle.dir, "legal", "LICENSE"));
    await symlink(join(bundle.root, "LICENSE.moved"), join(bundle.dir, "link"));
    await refused(verifyBundle({ dir: bundle.dir, trustedKeys: trust(bundle) }), /link or a special file/);
    await unlink(join(bundle.dir, "link"));
    // A listed file replaced by a link to identical bytes elsewhere is also refused.
    const data = await readFile(join(bundle.dir, "legal", "LICENSE"));
    await writeFile(join(bundle.root, "elsewhere"), data);
    await unlink(join(bundle.dir, "legal", "LICENSE"));
    await symlink(join(bundle.root, "elsewhere"), join(bundle.dir, "legal", "LICENSE"));
    await refused(verifyBundle({ dir: bundle.dir, trustedKeys: trust(bundle) }), /link or a special file/);
  });

  it("refuses a bundle whose id is not the one the customer approved", async () => {
    const bundle = await build();
    await refused(verifyBundle({ dir: bundle.dir, trustedKeys: trust(bundle), approvedBundleSha256: "0".repeat(64) }), /not the approved bundle/);
    const other = await build({ key: bundle.key, version: "1.4.1" });
    await refused(verifyBundle({ dir: other.dir, trustedKeys: trust(bundle), approvedBundleSha256: bundle.bundleSha256 }), /not the approved bundle/);
    await verifyBundle({ dir: other.dir, trustedKeys: trust(bundle), approvedBundleSha256: other.bundleSha256.toUpperCase() });
  });

  it("refuses a missing or non-directory path, and a missing or oversize manifest or signature", async () => {
    const bundle = await build();
    await refused(verifyBundle({ dir: join(bundle.root, "nope"), trustedKeys: trust(bundle) }), /does not exist/);
    await refused(verifyBundle({ dir: join(bundle.dir, "release.json"), trustedKeys: trust(bundle) }), /not a directory/);
    await writeFile(join(bundle.dir, "bundle.sig.json"), "x".repeat(70_000));
    await refused(verifyBundle({ dir: bundle.dir, trustedKeys: trust(bundle) }), /larger than allowed/);
    await unlink(join(bundle.dir, "bundle.sig.json"));
    await refused(verifyBundle({ dir: bundle.dir, trustedKeys: trust(bundle) }), /bundle.sig.json is missing/);
    // bundle.json as a link to a real file with the same bytes is refused: it must be the file itself.
    const bytes = await readFile(join(bundle.dir, "bundle.json"));
    await writeFile(join(bundle.root, "real.json"), bytes);
    await unlink(join(bundle.dir, "bundle.json"));
    await symlink(join(bundle.root, "real.json"), join(bundle.dir, "bundle.json"));
    await refused(verifyBundle({ dir: bundle.dir, trustedKeys: trust(bundle) }), /bundle.json is not a regular file/);
  });

  /** Re-signs a hand-edited manifest with the real test key: what only the key holder (or a compromised pipeline) could do. */
  async function resign(bundle: BuiltBundle, edit: (manifest: ReturnType<typeof BundleManifestSchema.parse>) => unknown): Promise<void> {
    const manifest = BundleManifestSchema.parse(JSON.parse(await readFile(join(bundle.dir, "bundle.json"), "utf8")));
    const bytes = Buffer.from(`${JSON.stringify(edit(manifest), null, 2)}\n`);
    await writeFile(join(bundle.dir, "bundle.json"), bytes);
    const sig = JSON.parse(await readFile(join(bundle.dir, "bundle.sig.json"), "utf8")) as Record<string, unknown>;
    await writeFile(join(bundle.dir, "bundle.sig.json"), JSON.stringify({ ...sig, bundleSha256: sha256OfBytes(bytes), signature: (await bundle.key.signer.sign(bytes)).toString("base64") }));
  }

  it("refuses a correctly signed manifest that disagrees with the release inside it", async () => {
    const a = await build();
    await resign(a, (m) => ({ ...m, version: "9.9.9" }));
    await refused(verifyBundle({ dir: a.dir, trustedKeys: trust(a) }), /names another release/);
    const b = await build();
    await resign(b, (m) => ({ ...m, files: m.files.map((f) => (f.file === "legal/LICENSE" ? { ...f, kind: "template" } : f)) }));
    await refused(verifyBundle({ dir: b.dir, trustedKeys: trust(b) }), /lists legal\/LICENSE differently|differently than the signed manifest/);
    const c = await build();
    await resign(c, (m) => ({ ...m, images: m.images.map((i) => (i.name === "worker" ? { ...i, sourceRef: `r/x@sha256:${"d".repeat(64)}` } : i)) }));
    await refused(verifyBundle({ dir: c.dir, trustedKeys: trust(c) }), /image worker differs/);
  });

  it("refuses a correctly signed manifest that lists a release-file kind release.json does not", async () => {
    const bundle = await build();
    const extra = Buffer.from("not licensed\n");
    await writeFile(join(bundle.dir, "legal", "RELICENSED.md"), extra);
    await resign(bundle, (m) => ({ ...m, files: [...m.files, { file: "legal/RELICENSED.md", kind: "legal", sha256: sha256OfBytes(extra), bytes: extra.length }] }));
    await refused(verifyBundle({ dir: bundle.dir, trustedKeys: trust(bundle) }), /is in the bundle but not in release.json/);
  });

  it("refuses a signature file naming another bundle.json than the one beside it, even with a good signature", async () => {
    const bundle = await build();
    const sigPath = join(bundle.dir, "bundle.sig.json");
    const sig = JSON.parse(await readFile(sigPath, "utf8")) as Record<string, unknown>;
    await writeFile(sigPath, JSON.stringify({ ...sig, bundleSha256: "1".repeat(64) }));
    await refused(verifyBundle({ dir: bundle.dir, trustedKeys: trust(bundle) }), /names a different bundle.json/);
  });

  it("refuses a correctly signed manifest whose paths leave the directory (the schema's first guard)", async () => {
    const bundle = await build();
    await resign(bundle, (m) => ({ ...m, files: [...m.files, { file: "../outside", kind: "notes", sha256: "a".repeat(64), bytes: 1 }] }));
    await refused(verifyBundle({ dir: bundle.dir, trustedKeys: trust(bundle) }), /not a valid bundle manifest/);
  });
});

// The upgrade itself, with the AWS side faked. The store records every call so "nothing was touched" is a fact, not a hope.
const ADMIN = "arn:aws:sts::123456789012:assumed-role/Admin/alice";
const ACCESS_TEMPLATE = JSON.stringify({ Resources: {} });
const INSTALLED = { ...SETTINGS, version: "1.2.3", access: { artifactBucket: "agentx-staging-access-artifactbucket-abc", cloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", pullThroughPrefix: "agentx-staging" } };

const CONTROL_PLANE = { GitHubAppId: "123", GitHubAppPrivateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", BudgetMonthlyUsd: "250", CallbackSigningKey: "****" };

async function harness(bundle: BuiltBundle, overrides: Partial<UpgradeDependencies> = {}, store = new MemoryParameterStore()) {
  await writeEnvironmentSettings(store, INSTALLED);
  store.calls.length = 0;
  const events: string[] = [];
  const inner = scriptedDeployer(allStackOutputs(), Object.keys(allStackOutputs()));
  const deployer = { requests: inner.requests, deploy: async (request: Parameters<typeof inner.deploy>[0]) => { events.push(`deploy:${request.stackName}`); return inner.deploy(request); }, outputs: (name: string) => inner.outputs(name) };
  const lines: string[] = [];
  const touched: string[] = [];
  const deps: UpgradeDependencies = {
    store,
    stacks: { describe: async (name) => { touched.push(`describe:${name}`); return { status: "UPDATE_COMPLETE", outputs: allStackOutputs()[name] ?? {}, parameters: name === "agentx-staging-control-plane" ? CONTROL_PLANE : {} }; } },
    cloudFormation: { async send(command: unknown) { if (command instanceof GetTemplateCommand) return { TemplateBody: ACCESS_TEMPLATE }; throw new Error("unexpected"); } },
    identity: { get: async () => { touched.push("identity"); return { account: "123456789012", arn: ADMIN }; } },
    loadRelease: async () => { throw new Error("test setup: a bundle upgrade loads no other release"); },
    sourceRelease: async () => { throw new Error("test setup: no source release"); },
    verifyBundle: async (input) => verifyBundle({ ...input, trustedKeys: trust(bundle) }),
    loadBundleImages: async ({ bundle: verified }) => { events.push(`images:${verified.manifest.images.map((image) => image.name).join(",")}`); },
    notes: async () => undefined,
    prepare: async () => { touched.push("prepare"); return { deployer, store, secrets: memoryInitSecrets({ "agentx/staging/callback-signing-key": "k".repeat(43) }), holder: ADMIN, partition: "aws", cleanup: async () => undefined }; },
    cdkDiff: async () => "",
    ask: async () => "y",
    isInteractive: () => true,
    githubWebhook: () => ({ secrets: memoryInitSecrets({}), github: { async request() { throw new Error("unused"); } } as never }),
    doctor: async () => ({ env: "staging", region: "us-east-1", version: "1.4.0", engine: "templates", checks: [], failed: 0, warned: 0, passed: 1 }),
    write: (line) => lines.push(line),
    now: () => T0,
    cliVersion: "1.4.0",
    ...overrides,
  };
  return { deps, store, events, lines, touched, deployer };
}
const options = (bundle: BuiltBundle, extra: Record<string, unknown> = {}) => ({ env: "staging", yes: true, allowReplace: [] as string[], bundleDir: bundle.dir, ...extra });
const nothingTouched = (h: Awaited<ReturnType<typeof harness>>) => {
  expect(h.store.calls).toEqual([]);
  expect(h.touched).toEqual([]);
  expect(h.events).toEqual([]);
  expect(h.deployer.requests).toEqual([]);
};

describe("rovara upgrade --bundle", () => {
  it("records the restore point before the first image or stack changes, loads the images, deploys, then records the installed bundle", async () => {
    const bundle = await build();
    const h = await harness(bundle);
    const atFirstChange: Record<string, string | undefined> = {};
    h.deps.loadBundleImages = async () => {
      h.events.push("images");
      for (const [name, entry] of h.store.values) if (name.includes("restore-points")) atFirstChange[name] = entry;
    };
    const result = await runUpgrade(options(bundle), h.deps);
    expect(result).toMatchObject({ from: "1.2.3", to: "1.4.0" });
    expect(h.events[0]).toBe("images");
    expect(h.events.slice(1).every((event) => event.startsWith("deploy:"))).toBe(true);
    const name = restorePointParameter("staging", new Date(T0).toISOString());
    expect(Object.keys(atFirstChange)).toEqual([name]);
    expect(JSON.parse(atFirstChange[name]!)).toEqual({ schemaVersion: 1, takenAt: new Date(T0).toISOString(), pitrTimestamp: new Date(T0).toISOString(), fromVersion: "1.2.3", previousBundleId: null, targetVersion: "1.4.0", targetBundleId: bundle.bundleSha256 });
    expect(JSON.parse(h.store.values.get(installedBundleParameter("staging"))!)).toMatchObject({ bundleId: bundle.bundleSha256, version: "1.4.0" });
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.4.0");
  });

  it("names the previous bundle in the next restore point", async () => {
    const first = await build();
    const store = new MemoryParameterStore();
    const h1 = await harness(first, {}, store);
    await runUpgrade(options(first), h1.deps);
    const second = await build({ key: first.key, version: "1.4.1" });
    const h2 = await harness(second, {}, store);
    // harness() rewrites the settings at 1.2.3; the installed-bundle record is what carries over.
    await runUpgrade(options(second), { ...h2.deps, now: () => T0 + 60_000 });
    const point = JSON.parse(store.values.get(restorePointParameter("staging", new Date(T0 + 60_000).toISOString()))!) as { previousBundleId: string };
    expect(point.previousBundleId).toBe(first.bundleSha256);
  });

  it.each([
    ["a template", "templates/us-east-1/slack.template.json"],
    ["an image archive", "images/litellm.oci.tar"],
    ["bundle.json", "bundle.json"],
    ["bundle.sig.json", "bundle.sig.json"],
  ])("refuses a tampered byte in %s before the environment, the account, the lock or the registry is touched", async (_name, file) => {
    const bundle = await build();
    const path = join(bundle.dir, file);
    const data = Buffer.from(await readFile(path)); data[data.length - 4] = data[data.length - 4]! ^ 1;
    await writeFile(path, data);
    const h = await harness(bundle);
    await expect(runUpgrade(options(bundle), h.deps)).rejects.toThrow(/bundle refused|nothing was changed/);
    nothingTouched(h);
  });

  it("refuses an unapproved bundle id before anything is touched", async () => {
    const bundle = await build();
    const h = await harness(bundle);
    await expect(runUpgrade(options(bundle, { approvedBundleSha256: "f".repeat(64) }), h.deps)).rejects.toThrow(/not the approved bundle/);
    nothingTouched(h);
    const ok = await harness(bundle);
    await runUpgrade(options(bundle, { approvedBundleSha256: bundle.bundleSha256 }), ok.deps);
  });

  it("refuses when the restore point cannot be recorded: no image is loaded and no stack deployed", async () => {
    const bundle = await build();
    const store = new MemoryParameterStore();
    const realPut = store.put.bind(store);
    store.put = async (name, value, opts) => { if (name.includes("restore-points")) throw new Error("denied"); return realPut(name, value, opts); };
    const h = await harness(bundle, {}, store);
    await expect(runUpgrade(options(bundle), h.deps)).rejects.toThrow(/restore point could not be recorded/);
    expect(h.events).toEqual([]);
    expect(h.store.values.has(installedBundleParameter("staging"))).toBe(false);
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.2.3");
  });

  it("never overwrites a restore point, and does not record the bundle as installed when a stack fails", async () => {
    const bundle = await build();
    const store = new MemoryParameterStore();
    const name = restorePointParameter("staging", new Date(T0).toISOString());
    const h = await harness(bundle, {}, store);
    store.values.set(name, "earlier");
    await expect(runUpgrade(options(bundle), h.deps)).rejects.toThrow(/restore point already exists/);
    expect(store.values.get(name)).toBe("earlier");
    expect(ParameterExistsError).toBeDefined();
    store.values.delete(name);
    const failing = await harness(bundle, {}, store);
    const original = failing.deployer.deploy;
    failing.deployer.deploy = async (request) => { if (request.stackName.endsWith("-runtime")) throw new Error("boom"); return original(request); };
    await expect(runUpgrade(options(bundle), failing.deps)).rejects.toThrow();
    expect(store.values.has(installedBundleParameter("staging"))).toBe(false);
    expect(store.values.has(name)).toBe(true);
  });

  it("refuses a bundle with images when this agentx cannot load them, before anything is touched", async () => {
    const bundle = await build();
    const h = await harness(bundle, { loadBundleImages: undefined });
    await expect(runUpgrade(options(bundle), h.deps)).rejects.toThrow(/cannot load the bundle's images/);
    nothingTouched(h);
  });

  it("refuses to combine --bundle with another release source", async () => {
    const bundle = await build();
    for (const extra of [{ releaseDir: "/x" }, { to: "1.4.0" }, { source: "/x" }, { exportDir: "/x" }]) {
      const h = await harness(bundle);
      await expect(runUpgrade(options(bundle, extra), h.deps)).rejects.toThrow(/do not combine/);
      nothingTouched(h);
    }
    const h = await harness(bundle);
    await expect(runUpgrade({ env: "staging", yes: true, allowReplace: [], approvedBundleSha256: "a".repeat(64) }, h.deps)).rejects.toThrow(/applies to --bundle only/);
  });

  // N3b: a cdk-engine (Enterprise) install takes a bundle through the same approve-then-deploy path as everything else; nothing of the bundle's prebuilt templates is deployed.
  describe("on a cdk-engine install (built at approval)", () => {
    const cdkHarness = async (bundle: BuiltBundle, outcome: { status: string; done: string[] } | Error = { status: "done", done: ["foundation", "runtime"] }) => {
      const h = await harness(bundle);
      await writeEnvironmentSettings(h.store, { ...INSTALLED, engine: "cdk" });
      h.store.calls.length = 0;
      const calls: Array<{ bundleId: string; yes: boolean; engine: string }> = [];
      h.deps.approveAndDeploy = async ({ bundle: verified, settings, yes }) => {
        calls.push({ bundleId: verified.bundleId, yes, engine: settings.engine });
        if (outcome instanceof Error) throw outcome;
        return outcome;
      };
      return { ...h, calls };
    };

    it("builds, approves and starts the customer's deployer for exactly this bundle, deploys nothing itself, then runs doctor", async () => {
      const bundle = await build();
      const h = await cdkHarness(bundle);
      const result = await runUpgrade(options(bundle), h.deps);
      expect(h.calls).toEqual([{ bundleId: bundle.bundleSha256, yes: true, engine: "cdk" }]);
      expect(result).toMatchObject({ env: "staging", from: "1.2.3", to: "1.4.0", parts: ["foundation", "runtime"], doctor: { failed: 0 } });
      // The engine, the prebuilt templates and the restore point of the local path are untouched: the deployer owns them.
      expect(h.events).toEqual([]);
      expect(h.deployer.requests).toEqual([]);
      expect(h.touched).not.toContain("prepare");
      expect(h.store.values.has(installedBundleParameter("staging"))).toBe(false);
      expect([...h.store.values.keys()].some((name) => name.includes("restore-points"))).toBe(false);
    });

    it("needs no --source, and refuses what could change what is built: --no-reserved-concurrency", async () => {
      const bundle = await build();
      const h = await cdkHarness(bundle);
      await expect(runUpgrade(options(bundle, { reservedConcurrency: false }), h.deps)).rejects.toThrow(/recorded for it/);
      expect(h.calls).toEqual([]);
    });

    it("refuses when this agentx cannot build at approval, when the deployer did not finish, and a downgrade; and the Rovara operator still cannot run it", async () => {
      const bundle = await build();
      const none = await cdkHarness(bundle);
      delete none.deps.approveAndDeploy;
      await expect(runUpgrade(options(bundle), none.deps)).rejects.toThrow(/cannot build an install's templates at approval/);
      const unfinished = await cdkHarness(bundle, { status: "in-progress", done: ["foundation"] });
      await expect(runUpgrade(options(bundle), unfinished.deps)).rejects.toThrow(/did not finish \(in-progress\).*foundation.*the approval stands/);
      const old = await build({ version: "1.0.0" });
      const downgrade = await cdkHarness(old);
      await expect(runUpgrade(options(old), downgrade.deps)).rejects.toThrow(/older than 1\.2\.3/);
      expect(downgrade.calls).toEqual([]);
      const operator = await cdkHarness(bundle);
      operator.deps.identity = { get: async () => ({ account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/agentx-staging-rovara-operator/ana" }) };
      await expect(runUpgrade(options(bundle), operator.deps)).rejects.toThrow(/Rovara operator role starts approved deployments/);
      expect(operator.calls).toEqual([]);
    });

    it("needs --yes without a terminal, before anything is built", async () => {
      const bundle = await build();
      const h = await cdkHarness(bundle);
      h.deps.isInteractive = () => false;
      await expect(runUpgrade(options(bundle, { yes: false }), h.deps)).rejects.toThrow(/needs --yes/);
      expect(h.calls).toEqual([]);
    });
  });

  it("refuses a bundle older than the installed release, after verifying it, and records no restore point", async () => {
    const bundle = await build({ version: "1.0.0" });
    const h = await harness(bundle);
    await expect(runUpgrade(options(bundle), h.deps)).rejects.toThrow(/never moves an environment back/);
    expect([...h.store.values.keys()].some((name) => name.includes("restore-points"))).toBe(false);
    expect(h.events).toEqual([]);
  });
});


describe("the Rovara operator role (N6) runs no upgrade itself", () => {
  const OPERATOR = "arn:aws:sts::123456789012:assumed-role/agentx-staging-rovara-operator/alice@example.com";
  const asOperator = (bundle: BuiltBundle) => harness(bundle, { identity: { get: async () => ({ account: "123456789012", arn: OPERATOR }) } });

  it("is refused every upgrade this command runs, a verified and approved bundle included (it starts the deployer instead), before any lock, restore point, image or stack", async () => {
    const bundle = await build();
    for (const extra of [{}, { approvedBundleSha256: bundle.bundleSha256 }]) {
      const h = await asOperator(bundle);
      await expect(runUpgrade(options(bundle, extra), h.deps)).rejects.toThrow(/--deploy-approved/);
      expect(h.events).toEqual([]);
      expect([...h.store.values.keys()].some((name) => name.includes("restore-points") || name.endsWith("/lock") || name.endsWith("/bundle"))).toBe(false);
      expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.2.3");
    }
    const plain = await asOperator(bundle);
    await expect(runUpgrade({ env: "staging", yes: true, allowReplace: [], releaseDir: "/x" }, { ...plain.deps, loadRelease: async () => { throw new Error("must not load"); } })).rejects.toThrow(/--deploy-approved/);
    expect(plain.events).toEqual([]);
  });

  it("is not mistaken for the customer's own operator role (a different role name)", async () => {
    const bundle = await build();
    const own = await harness(bundle, { identity: { get: async () => ({ account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/agentx-staging-operator/bob" }) } });
    await runUpgrade(options(bundle), own.deps);
  });
});

describe("the bytes that were verified are the bytes used (review I4)", () => {
  it("reads the release, templates and packages from a private copy: changing the original after verification changes nothing that is deployed", async () => {
    const bundle = await build();
    const verified = await verifyBundle({ dir: bundle.dir, trustedKeys: trust(bundle) });
    const before = verified.release.template("slack", "us-east-1", "staging");
    await writeFile(join(bundle.dir, "templates/us-east-1/slack.template.json"), '{"Resources":{"Evil":{"Type":"AWS::IAM::User"}}}');
    await writeFile(join(bundle.dir, "release.json"), "{}");
    expect(verified.release.template("slack", "us-east-1", "staging")).toBe(before);
    expect(verified.release.manifest.version).toBe("1.4.0");
    expect(verified.copyDir).not.toBe(bundle.dir);
    const info = await stat(verified.copyDir);
    expect(info.mode & 0o777).toBe(0o700);
    expect((await stat(join(verified.copyDir, "release.json"))).mode & 0o777).toBe(0o400);
    await verified.cleanup();
    await expect(stat(verified.copyDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the private copy when verification fails, and when the upgrade ends", async () => {
    const bundle = await build();
    const before = (await readdir(tmpdir())).filter((name) => name.startsWith("rovara-bundle-")).length;
    await writeFile(join(bundle.dir, "legal", "LICENSE"), "changed");
    await refused(verifyBundle({ dir: bundle.dir, trustedKeys: trust(bundle) }), /does not match the signed manifest/);
    expect((await readdir(tmpdir())).filter((name) => name.startsWith("rovara-bundle-")).length).toBe(before);
    const good = await build();
    const h = await harness(good);
    await runUpgrade(options(good), h.deps);
    expect((await readdir(tmpdir())).filter((name) => name.startsWith("rovara-bundle-")).length).toBe(before);
  });

  it("refuses a file with another name on the disk (a hard link), which the checks cannot tell apart from the original", async () => {
    const bundle = await build();
    await link(join(bundle.dir, "legal", "LICENSE"), join(bundle.root, "other-name"));
    await refused(verifyBundle({ dir: bundle.dir, trustedKeys: trust(bundle) }), /hard link/);
  });
});
