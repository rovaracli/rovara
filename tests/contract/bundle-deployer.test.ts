/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- expect.stringMatching and parsed JSON are untyped */
// Enterprise foundations, N6 fix round 1 (review C1, C2, I1, I2, I4): the customer-owned deployer. The operator can only send a bundle id; what is deployed, with
// which parameters, and what is recorded, is decided here from the customer's approval and the signed bundle. Each test names the guard it protects.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approvedFileKey, bundleApprovalKey, bundleTrustParameter, deployLockParameter, deployProgressParameter, installedBundleParameter, operatorAccessStateParameter, releaseHighWaterParameter, restorePointParameter } from "@agentx/cloud-contracts";
import { builtBundle, newTestKey, type BuiltBundle } from "../support/bundle-fixture.js";
import { T0, World } from "../support/deployer-world.js";

const made: BuiltBundle[] = [];
afterEach(async () => { await Promise.all(made.splice(0).map((bundle) => bundle.cleanup())); });
const build = async (options?: Parameters<typeof builtBundle>[0]) => { const bundle = await builtBundle(options); made.push(bundle); return bundle; };
const PARTS = ["foundation", "identity", "runtime", "control-plane", "slack"];
/** What changed anything but the alert and the one-run lock. */
const changes = (world: World) => world.log.filter((line) => (line.startsWith("cfn.") || line.startsWith("ssm.put") || line.startsWith("s3.put") || line.startsWith("ssm.delete")) && !line.endsWith("/deploy/lock"));

async function ready(options: Parameters<typeof builtBundle>[0] & { seed?: Partial<Parameters<World["seed"]>[0]>; approve?: Parameters<World["approve"]>[1] } = {}) {
  const bundle = await build(options);
  const world = new World();
  world.seed({ key: bundle.key.publicKeyPem, ...options.seed });
  await world.approve(bundle, options.approve);
  return { bundle, world };
}

describe("the deployer: a bundle id is the whole request", () => {
  it("deploys the fixed stacks in order from the verified bytes, through the customer's deploy role, then records the install", async () => {
    const { bundle, world } = await ready();
    const result = await world.run({ bundleId: bundle.bundleSha256 });
    expect(result).toEqual({ status: "done", bundleId: bundle.bundleSha256, done: PARTS, remaining: [] });
    expect(world.changeSets.map((set) => set.stackName)).toEqual(PARTS.map((part) => `agentx-ent-${part}`));
    for (const set of world.changeSets) {
      expect(set.roleArn).toBe("arn:aws:iam::123456789012:role/agentx-ent-cloudformation");
      expect(set.templateUrl).toMatch(new RegExp(`^https://approvals-bucket\\.s3\\.us-east-1\\.amazonaws\\.com/deploying/${bundle.bundleSha256}/`));
    }
    // The bytes CloudFormation reads are the verified, rendered bytes.
    const uploaded = world.uploaded.get(`deploying/${bundle.bundleSha256}/foundation.template.json`)!;
    expect(uploaded.toString("utf8")).toBe(`${JSON.stringify({ Resources: {} })}\n`);
    // The restore point is written before the first change set; the install records come after the last.
    const restore = world.log.findIndex((line) => line.startsWith(`ssm.put ${restorePointParameter("ent", new Date(world.now).toISOString())}`));
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(restore).toBeLessThan(world.log.findIndex((line) => line.startsWith("cfn.create")));
    expect(JSON.parse(world.params.get(installedBundleParameter("ent"))!)).toMatchObject({ bundleId: bundle.bundleSha256, version: "1.4.0" });
    expect(JSON.parse(world.params.get("/agentx/ent/settings")!)).toMatchObject({ version: "1.4.0" });
    expect(world.params.has(deployProgressParameter("ent"))).toBe(false);
  });

  it("accepts nothing but a bundle id: no extra field, no template, no stack, no parameter", async () => {
    const { bundle, world } = await ready();
    const id = bundle.bundleSha256;
    for (const request of [undefined, null, "x", {}, { bundleId: "short" }, { bundleId: id.toUpperCase() }, { bundleId: id, stack: "agentx-ent-access" }, { bundleId: id, parameters: { OidcIssuer: "https://evil" } }, { bundleId: id, templateUrl: "https://evil/x.json" }, { bundleId: id, stackName: "x" }, [id]]) {
      const result = await world.run(request);
      expect(result.status, JSON.stringify(request)).toBe("refused");
    }
    expect(changes(world)).toEqual([]);
    expect(world.log.filter((line) => line.startsWith("s3.get"))).toEqual([]);
  });
});

describe("the customer's approval governs", () => {
  it("refuses a bundle with no approval, a withdrawn approval (record deleted), and an approval that names another bundle", async () => {
    const { bundle, world } = await ready();
    expect(await world.run({ bundleId: "0".repeat(64) })).toMatchObject({ status: "refused", reason: expect.stringMatching(/not approved/) });
    world.deleteObject(bundleApprovalKey(bundle.bundleSha256));
    expect(await world.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/withdrawn/) });
    expect(changes(world)).toEqual([]);
    const other = await ready();
    const stolen = other.world.versions.get(bundleApprovalKey(other.bundle.bundleSha256))!;
    other.world.versions.set(bundleApprovalKey("1".repeat(64)), stolen);
    expect(await other.world.run({ bundleId: "1".repeat(64) })).toMatchObject({ status: "refused", reason: expect.stringMatching(/names another bundle/) });
  });

  it("deploys the object versions the customer pinned, not whatever is current in the bucket", async () => {
    const { bundle, world } = await ready();
    const key = approvedFileKey(bundle.bundleSha256, "templates/us-east-1/slack.template.json");
    world.putObject(key, Buffer.from('{"Resources":{"Evil":{"Type":"AWS::IAM::User"}}}\n'));
    const result = await world.run({ bundleId: bundle.bundleSha256 });
    expect(result.status).toBe("done");
    expect(world.uploaded.get(`deploying/${bundle.bundleSha256}/slack.template.json`)!.toString("utf8")).not.toContain("Evil");
  });

  it("refuses a pinned file that does not match the record's hash, or is missing", async () => {
    const { bundle, world } = await ready();
    const key = approvedFileKey(bundle.bundleSha256, "templates/us-east-1/runtime.template.json");
    const record = JSON.parse((await world.ports().s3.get(bundleApprovalKey(bundle.bundleSha256)))!.toString("utf8")) as { files: Array<{ file: string; versionId: string }> };
    const pinned = record.files.find((entry) => entry.file === "templates/us-east-1/runtime.template.json")!;
    const versions = world.versions.get(key)!;
    versions.find((entry) => entry.versionId === pinned.versionId)!.body = Buffer.from("tampered");
    expect(await world.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/does not match the approval record/) });
    world.versions.set(key, []);
    expect(await world.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/is missing/) });
    expect(changes(world)).toEqual([]);
  });
});

describe("the approval record is checked against the files it pins (review: duplicate check)", () => {
  async function corruptRecord(world: World, bundle: BuiltBundle, edit: (entry: { file: string; sha256: string; bytes: number }) => void) {
    const key = bundleApprovalKey(bundle.bundleSha256);
    const record = JSON.parse((await world.ports().s3.get(key))!.toString("utf8")) as { files: Array<{ file: string; sha256: string; bytes: number }> };
    edit(record.files.find((entry) => entry.file === "legal/LICENSE")!);
    world.putObject(key, Buffer.from(JSON.stringify(record)));
  }
  it("refuses a record whose hash for a file is wrong although the file itself is the signed one", async () => {
    const { bundle, world } = await ready();
    await corruptRecord(world, bundle, (entry) => { entry.sha256 = "0".repeat(64); });
    expect(await world.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/does not match the approval record/) });
    expect(changes(world)).toEqual([]);
  });
  it("refuses a record whose size for a file is wrong although the hash is right", async () => {
    const { bundle, world } = await ready();
    await corruptRecord(world, bundle, (entry) => { entry.bytes += 1; });
    expect(await world.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/does not match the approval record/) });
    expect(changes(world)).toEqual([]);
  });
});

describe("the deployer re-verifies the signed bundle", () => {
  it("refuses when no trusted key is set, when the key is not the signer's, and when the trust list is unreadable", async () => {
    const { bundle, world } = await ready();
    world.params.delete(bundleTrustParameter("ent"));
    expect(await world.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/no trusted signing key/) });
    world.params.set(bundleTrustParameter("ent"), JSON.stringify([newTestKey().publicKeyPem]));
    expect(await world.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/does not verify/) });
    world.params.set(bundleTrustParameter("ent"), "not json");
    expect(await world.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/not readable/) });
    expect(changes(world)).toEqual([]);
  });

  it("refuses a bundle whose signature file was swapped for another bundle's, even though the customer approved its files", async () => {
    const a = await build();
    const b = await build({ key: a.key, version: "1.4.1" });
    const world = new World();
    world.seed({ key: a.key.publicKeyPem });
    await writeFile(join(a.dir, "bundle.sig.json"), await readFile(join(b.dir, "bundle.sig.json")));
    await world.approve(a);
    expect(await world.run({ bundleId: a.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/does not verify/) });
  });

  it("refuses a bundle.json whose hash is not the id it was approved under", async () => {
    const { bundle, world } = await ready();
    const other = await build({ key: bundle.key, version: "1.4.1" });
    const sneaky = new World();
    sneaky.seed({ key: bundle.key.publicKeyPem });
    const { record } = await sneaky.approve(other);
    // The approval for `bundle` is made to point at `other`'s files.
    const forged = { ...record, bundleId: bundle.bundleSha256 };
    for (const entry of record.files) sneaky.versions.set(approvedFileKey(bundle.bundleSha256, entry.file), sneaky.versions.get(approvedFileKey(other.bundleSha256, entry.file))!);
    sneaky.putObject(bundleApprovalKey(bundle.bundleSha256), Buffer.from(JSON.stringify(forged)));
    expect(await sneaky.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/not the approved bundle/) });
    void world;
  });

  it("refuses an approval that pins a file the signed manifest does not list, or leaves out one it lists", async () => {
    const { bundle, world } = await ready();
    const recordBytes = (await world.ports().s3.get(bundleApprovalKey(bundle.bundleSha256)))!;
    const record = JSON.parse(recordBytes.toString("utf8")) as { files: Array<{ file: string; versionId: string; sha256: string; bytes: number }> };
    const extra = Buffer.from("extra");
    const versionId = world.putObject(approvedFileKey(bundle.bundleSha256, "legal/RELICENSED.md"), extra);
    world.putObject(bundleApprovalKey(bundle.bundleSha256), Buffer.from(JSON.stringify({ ...record, files: [...record.files, { file: "legal/RELICENSED.md", versionId, sha256: (await import("@agentx/cloud-contracts")).sha256OfBytes(extra), bytes: extra.length }] })));
    expect(await world.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/does not list/) });
    world.putObject(bundleApprovalKey(bundle.bundleSha256), Buffer.from(JSON.stringify({ ...record, files: record.files.filter((entry) => entry.file !== "legal/LICENSE") })));
    expect(await world.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/not the file the signed manifest lists/) });
    expect(changes(world)).toEqual([]);
  });

  it("refuses a correctly signed manifest whose version is not the one in the release it carries", async () => {
    const bundle = await build();
    const manifest = JSON.parse(await readFile(join(bundle.dir, "bundle.json"), "utf8")) as Record<string, unknown>;
    const bytes = Buffer.from(`${JSON.stringify({ ...manifest, version: "1.9.9" }, null, 2)}\n`);
    await writeFile(join(bundle.dir, "bundle.json"), bytes);
    const sig = JSON.parse(await readFile(join(bundle.dir, "bundle.sig.json"), "utf8")) as Record<string, unknown>;
    const { sha256OfBytes } = await import("@agentx/cloud-contracts");
    await writeFile(join(bundle.dir, "bundle.sig.json"), JSON.stringify({ ...sig, bundleSha256: sha256OfBytes(bytes), signature: (await bundle.key.signer.sign(bytes)).toString("base64") }));
    bundle.bundleSha256 = sha256OfBytes(bytes);
    const world = new World();
    world.seed({ key: bundle.key.publicKeyPem });
    await world.approve(bundle, { version: "1.9.9" });
    expect(await world.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/disagree about the version/) });
    expect(changes(world)).toEqual([]);
  });

  /** Rewrites the bundle's release.json with `edit`, then fixes its entry in bundle.json and signs again with the test key: a correctly signed bundle whose release.json differs from what this deployer's schema knows. */
  async function withReleaseEdited(edit: (release: Record<string, any>) => void) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const bundle = await build();
    const { sha256OfBytes } = await import("@agentx/cloud-contracts");
    const release = JSON.parse(await readFile(join(bundle.dir, "release.json"), "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    edit(release);
    const releaseBytes = Buffer.from(`${JSON.stringify(release, null, 2)}\n`);
    await writeFile(join(bundle.dir, "release.json"), releaseBytes);
    const manifest = JSON.parse(await readFile(join(bundle.dir, "bundle.json"), "utf8")) as { files: Array<{ file: string; sha256: string; bytes: number }> };
    const entry = manifest.files.find((file) => file.file === "release.json")!;
    entry.sha256 = sha256OfBytes(releaseBytes);
    entry.bytes = releaseBytes.length;
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(bundle.dir, "bundle.json"), bytes);
    const sig = JSON.parse(await readFile(join(bundle.dir, "bundle.sig.json"), "utf8")) as Record<string, unknown>;
    await writeFile(join(bundle.dir, "bundle.sig.json"), JSON.stringify({ ...sig, bundleSha256: sha256OfBytes(bytes), signature: (await bundle.key.signer.sign(bytes)).toString("base64") }));
    bundle.bundleSha256 = sha256OfBytes(bytes);
    const world = new World();
    world.seed({ key: bundle.key.publicKeyPem });
    await world.approve(bundle);
    return { bundle, world };
  }

  it("reads a release.json with fields it does not know (a later release may add some), and still checks every field it uses", async () => {
    const { bundle, world } = await withReleaseEdited((release) => {
      release.aFutureField = { anything: 1 };
      for (const t of release.templates) t.aFutureTemplateField = "x";
      for (const p of release.packages) p.aFuturePackageField = true;
      release.images.aFutureImage = "ignored";
    });
    expect((await world.run({ bundleId: bundle.bundleSha256 })).status).toBe("done");
    // A field it uses, wrong, is still a refusal; so is another schema version (the way to stop older deployers on purpose).
    for (const edit of [
      (release: Record<string, any>) => { release.packages[0].sha256 = "not-a-hash"; }, // eslint-disable-line @typescript-eslint/no-explicit-any
      (release: Record<string, any>) => { release.schemaVersion = 2; }, // eslint-disable-line @typescript-eslint/no-explicit-any
      (release: Record<string, any>) => { release.version = "one"; }, // eslint-disable-line @typescript-eslint/no-explicit-any
      (release: Record<string, any>) => { delete release.templates; }, // eslint-disable-line @typescript-eslint/no-explicit-any
    ]) {
      const bad = await withReleaseEdited((release) => { release.aFutureField = 1; edit(release); });
      expect(await bad.world.run({ bundleId: bad.bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/release.json is not valid/) });
    }
  });

  it("refuses when the approval, the manifest and the release disagree about the version", async () => {
    const { bundle, world } = await ready({ approve: { version: "9.9.9" } });
    expect(await world.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/disagree about the version/) });
  });
});

describe("direction, restore point and the fixed stack set", () => {
  it("refuses an older bundle unless the customer approved a rollback, and refuses a release-less install", async () => {
    const old = await ready({ version: "1.0.0" });
    expect(await old.world.run({ bundleId: old.bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/no rollback was approved/) });
    const back = await ready({ version: "1.0.0", approve: { rollback: true } });
    expect((await back.world.run({ bundleId: back.bundle.bundleSha256 })).status).toBe("done");
    const unversioned = await ready({ seed: { version: "unversioned" } });
    expect(await unversioned.world.run({ bundleId: unversioned.bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/not a release version/) });
  });

  // 0.5.17: the release high-water mark (the highest release the install ever ran) is raised by the deployer's own installs and never lowered, so the CLI's
  // rollback floors (upgrade/target.ts) still apply after a rollback this deployer made.
  it("raises the release high-water mark: to the installed version before the first change, to the bundle's after the last; a rollback never lowers it", async () => {
    const up = await ready();
    expect((await up.world.run({ bundleId: up.bundle.bundleSha256 })).status).toBe("done");
    expect(up.world.params.get(releaseHighWaterParameter("ent"))).toBe("1.4.0");
    const first = up.world.log.findIndex((line) => line === `ssm.put ${releaseHighWaterParameter("ent")}`);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(up.world.log.findIndex((line) => line.startsWith("cfn.create")));
    const back = await ready({ version: "1.0.0", approve: { rollback: true } });
    expect((await back.world.run({ bundleId: back.bundle.bundleSha256 })).status).toBe("done");
    expect(back.world.params.get(releaseHighWaterParameter("ent"))).toBe("1.2.3");
    expect(JSON.parse(back.world.params.get("/agentx/ent/settings")!)).toMatchObject({ version: "1.0.0" });
    const higher = await ready({ version: "1.0.0", approve: { rollback: true } });
    higher.world.params.set(releaseHighWaterParameter("ent"), "2.0.0");
    expect((await higher.world.run({ bundleId: higher.bundle.bundleSha256 })).status).toBe("done");
    expect(higher.world.params.get(releaseHighWaterParameter("ent"))).toBe("2.0.0");
  });

  it("refuses an unreadable high-water mark, and changes nothing when it cannot be written", async () => {
    const bad = await ready();
    bad.world.params.set(releaseHighWaterParameter("ent"), "latest");
    expect(await bad.world.run({ bundleId: bad.bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/high-water mark is not a release version/) });
    expect(changes(bad.world)).toEqual([]);
    const denied = await ready();
    denied.world.failPut = "release-high-water";
    expect(await denied.world.run({ bundleId: denied.bundle.bundleSha256 })).toMatchObject({ status: "failed", reason: expect.stringMatching(/high-water mark could not be written/) });
    expect(denied.world.log.some((line) => line.startsWith("cfn."))).toBe(false);
  });

  it("changes nothing when the restore point cannot be written, and refuses while another bundle's deployment is unfinished", async () => {
    const { bundle, world } = await ready();
    world.failPut = "restore-points";
    expect(await world.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "failed" });
    expect(world.log.some((line) => line.startsWith("cfn."))).toBe(false);
    world.failPut = undefined;
    world.params.set(deployProgressParameter("ent"), JSON.stringify({ schemaVersion: 1, bundleId: "2".repeat(64), startedAt: "2026-10-31T10:00:00.000Z", done: [] }));
    expect(await world.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/another bundle's deployment is unfinished/) });
    expect(world.log.some((line) => line.startsWith("cfn."))).toBe(false);
  });

  it("only updates: a missing stack, or one that is not settled, is refused, and the access stack is never deployed or changed", async () => {
    const { bundle, world } = await ready();
    world.stacks.delete("agentx-ent-runtime");
    expect(await world.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/runtime stack does not exist/) });
    expect(world.changeSets.map((set) => set.stackName)).toEqual(["agentx-ent-foundation", "agentx-ent-identity"]);
    const stuck = await ready();
    stuck.world.stacks.get("agentx-ent-foundation")!.status = "UPDATE_ROLLBACK_FAILED";
    expect(await stuck.world.run({ bundleId: stuck.bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/not in a state/) });
    for (const set of [...world.changeSets, ...stuck.world.changeSets]) expect(set.stackName).not.toMatch(/-access$/);
  });

  it("refuses a bundle that changes the access stack (the stack that holds the operator role and the deployer), before touching anything", async () => {
    const { bundle, world } = await ready({ seed: { accessTemplate: JSON.stringify({ Resources: { Older: { Type: "AWS::S3::Bucket" } } }) } });
    expect(await world.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/access stack is not the deployed one/) });
    expect(changes(world)).toEqual([]);
  });

  it("refuses an install in another region than the function's", async () => {
    const { bundle, world } = await ready();
    world.params.set("/agentx/ent/settings", JSON.stringify({ version: "1.2.3", region: "eu-west-1", identity: { mode: "cognito" } }));
    expect(await world.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/another region/) });
    expect(changes(world)).toEqual([]);
  });

  it("skips the identity stack when the install brings its own provider", async () => {
    const { bundle, world } = await ready({ seed: { identityMode: "oidc" } });
    expect((await world.run({ bundleId: bundle.bundleSha256 })).done).toEqual(["foundation", "runtime", "control-plane", "slack"]);
  });
});

describe("parameters: never from the caller", () => {
  const TEMPLATE = { Parameters: { OidcIssuer: { Type: "String" }, BudgetMonthlyUsd: { Type: "String", Default: "100" }, NewThing: { Type: "String", Default: "x" }, Required: { Type: "String" } }, Resources: {} };
  const seed = { stackParameters: { "control-plane": { OidcIssuer: "https://idp.customer.example", BudgetMonthlyUsd: "250", Required: "kept" } } };

  it("keeps every existing parameter at its current value (UsePreviousValue) and sets only what the approval pins", async () => {
    const { bundle, world } = await ready({ templates: { "control-plane": TEMPLATE }, seed, approve: { parameters: { "control-plane": { BudgetMonthlyUsd: "300" } } } });
    expect((await world.run({ bundleId: bundle.bundleSha256 })).status).toBe("done");
    const set = world.changeSets.find((entry) => entry.stackName === "agentx-ent-control-plane")!;
    expect(set.parameters).toEqual([
      { key: "BudgetMonthlyUsd", value: "300" },
      { key: "OidcIssuer", usePrevious: true },
      { key: "Required", usePrevious: true },
    ]);
  });

  it("refuses a pinned parameter the template does not declare, one the bundle's packages set, and a new parameter with no value", async () => {
    const undeclared = await ready({ templates: { "control-plane": TEMPLATE }, seed, approve: { parameters: { "control-plane": { AdminClaim: "evil" } } } });
    expect(await undeclared.world.run({ bundleId: undeclared.bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/AdminClaim, which the control-plane template does not declare/) });
    const fresh = await ready({ templates: { "control-plane": { ...TEMPLATE, Parameters: { ...TEMPLATE.Parameters, Brand: { Type: "String" } } } }, seed });
    expect(await fresh.world.run({ bundleId: fresh.bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/new parameter Brand with no value/) });
    expect(fresh.world.changeSets.map((set) => set.stackName)).not.toContain("agentx-ent-control-plane");
    const pkg = await ready({ templates: { "control-plane": { Parameters: { B: { Type: "String" }, K: { Type: "String" }, H: { Type: "String" } }, Resources: {} } }, seed: { stackParameters: { "control-plane": { B: "x", K: "y", H: "z" } } }, approve: { parameters: { "control-plane": { K: "approved/other.zip" } } } });
    expect(await pkg.world.run({ bundleId: pkg.bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/which the bundle's own packages set/) });
  });

  it("points a package's code parameters at the bundle's own approved copy, with the hashed asset id", async () => {
    const { bundle, world } = await ready({ templates: { "control-plane": { Parameters: { B: { Type: "String" }, K: { Type: "String" }, H: { Type: "String" } }, Resources: {} } }, seed: { stackParameters: { "control-plane": { B: "old", K: "old", H: "old" } } } });
    expect((await world.run({ bundleId: bundle.bundleSha256 })).status).toBe("done");
    const set = world.changeSets.find((entry) => entry.stackName === "agentx-ent-control-plane")!;
    expect(set.parameters).toEqual([
      { key: "B", value: "approvals-bucket" },
      { key: "H", value: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { key: "K", value: expect.stringMatching(new RegExp(`^deploying/${bundle.bundleSha256}/packages/[a-f0-9]{64}\\.zip$`)) },
    ]);
  });
});

describe("what CloudFormation and Lambda read is the verified bytes, by version (review N1, N3, N7)", () => {
  const PKG_TEMPLATE = { Parameters: { B: { Type: "String" }, K: { Type: "String" }, H: { Type: "String" } }, Resources: {} };
  const seedPkg = { stackParameters: { "control-plane": { B: "x", K: "y", H: "z" } } };

  it("copies each package's verified bytes to a key only the deployer writes and points the stack there, so overwriting the approved object afterwards changes nothing deployed", async () => {
    const { bundle, world } = await ready({ templates: { "control-plane": PKG_TEMPLATE }, seed: seedPkg });
    const original = await readFile(join(bundle.dir, "packages", (await (await import("node:fs/promises")).readdir(join(bundle.dir, "packages")))[0]!));
    for (const [key] of world.versions) if (key.includes("/packages/")) world.putObject(key, Buffer.from("Evil code, uploaded after the approval"));
    expect((await world.run({ bundleId: bundle.bundleSha256 })).status).toBe("done");
    const set = world.changeSets.find((entry) => entry.stackName === "agentx-ent-control-plane")!;
    const keyParameter = (set.parameters as Array<{ key: string; value?: string }>).find((parameter) => parameter.key === "K")!.value!;
    expect(keyParameter.startsWith(`deploying/${bundle.bundleSha256}/packages/`)).toBe(true);
    expect(world.uploaded.get(keyParameter)!.equals(original)).toBe(true);
    expect(world.uploaded.get(keyParameter)!.toString()).not.toContain("Evil");
  });

  it("hands CloudFormation the exact object version it just wrote (a swap of the key in between is not read), under the partition's suffix", async () => {
    const { bundle, world } = await ready();
    await world.run({ bundleId: bundle.bundleSha256 }, { urlSuffix: "amazonaws.com.cn" });
    for (const set of world.changeSets) {
      const key = set.templateUrl.replace(/^https:\/\/[^/]+\//, "").replace(/\?versionId=.*$/, "");
      expect(set.templateUrl).toMatch(/^https:\/\/approvals-bucket\.s3\.us-east-1\.amazonaws\.com\.cn\/deploying\//);
      expect(set.templateUrl.endsWith(`?versionId=${world.uploadedVersions.get(key)!}`)).toBe(true);
    }
    expect(world.changeSets.length).toBe(5);
  });

  it("refuses when the bucket gives no version id (it must be versioned)", async () => {
    const { bundle, world } = await ready();
    const ports = world.ports();
    const result = await (await import("../../packages/broker/src/bundle-deployer/deploy.js")).runDeployer({ bundleId: bundle.bundleSha256 }, { ...ports, s3: { ...ports.s3, put: async (key, body) => ({ versionId: (await ports.s3.put(key, body), undefined) }) } });
    expect(result).toMatchObject({ status: "refused", reason: expect.stringMatching(/must be versioned/) });
    expect(world.changeSets).toEqual([]);
  });
});

describe("the customer is told first, and can stop a run (review N2, N4, N6)", () => {
  it("publishes to the customer's topic before anything else, on every call, and again with the outcome", async () => {
    const { bundle, world } = await ready();
    await world.run({ bundleId: bundle.bundleSha256 });
    expect(world.log[0]).toBe("alert");
    expect(world.log.indexOf("alert")).toBeLessThan(world.log.findIndex((line) => line.startsWith("s3.get")));
    expect(world.alerts.map((message) => JSON.parse(message) as unknown)).toEqual([
      { event: "bundle-deployer.started", env: "ent", bundleId: bundle.bundleSha256 },
      { event: "bundle-deployer.finished", env: "ent", bundleId: bundle.bundleSha256, status: "done" },
    ]);
    const bad = new World();
    await bad.run({ bundleId: "x", parameters: {} });
    expect(bad.alerts.map((message) => (JSON.parse(message) as { event: string; bundleId: unknown }))).toEqual([
      { event: "bundle-deployer.started", env: "ent", bundleId: null },
      expect.objectContaining({ event: "bundle-deployer.finished", bundleId: null, status: "refused" }),
    ]);
  });

  it("does nothing at all when the customer's topic cannot be told", async () => {
    const { bundle, world } = await ready();
    world.failAlert = true;
    expect(await world.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "failed", reason: expect.stringMatching(/alert could not be sent/) });
    expect(world.log.filter((line) => line !== "alert")).toEqual([]);
  });

  it("refuses to start while the customer has suspended access, and treats a missing or unreadable switch as suspended", async () => {
    const { bundle, world } = await ready();
    for (const value of ["suspended", undefined, "ENABLED", ""]) {
      if (value === undefined) world.params.delete(operatorAccessStateParameter("ent")); else world.params.set(operatorAccessStateParameter("ent"), value);
      expect(await world.run({ bundleId: bundle.bundleSha256 }), String(value)).toMatchObject({ status: "refused", reason: expect.stringMatching(/suspended/) });
    }
    expect(changes(world)).toEqual([]);
    expect(world.log.filter((line) => line.startsWith("s3.get"))).toEqual([]);
  });

  it("treats a switch it cannot read as suspended, and refuses when two runs race for the lock", async () => {
    const { bundle, world } = await ready();
    const ports = world.ports();
    const { runDeployer } = await import("../../packages/broker/src/bundle-deployer/deploy.js");
    const unreadable = await runDeployer({ bundleId: bundle.bundleSha256 }, { ...ports, ssm: { ...ports.ssm, get: async (name) => { if (name === operatorAccessStateParameter("ent")) throw new Error("throttled"); return ports.ssm.get(name); } } });
    expect(unreadable).toMatchObject({ status: "refused", reason: expect.stringMatching(/suspended/) });
    expect(changes(world)).toEqual([]);
    // The other run took the lock between this run's read and its create-only write.
    world.params.set(deployLockParameter("ent"), JSON.stringify({ startedAt: world.now }));
    const raced = await runDeployer({ bundleId: bundle.bundleSha256 }, { ...ports, ssm: { ...ports.ssm, get: async (name) => (name === deployLockParameter("ent") ? undefined : ports.ssm.get(name)) } });
    expect(raced).toMatchObject({ status: "refused", reason: expect.stringMatching(/another run/) });
    expect(changes(world)).toEqual([]);
  });

  it("takes over a stale lock atomically: a run whose read-back shows another writer's value or version stops, so two runs never both go on", async () => {
    const { bundle, world } = await ready();
    const ports = world.ports();
    const { runDeployer } = await import("../../packages/broker/src/bundle-deployer/deploy.js");
    world.params.set(deployLockParameter("ent"), JSON.stringify({ startedAt: world.now - 30 * 60_000 }));
    // Another run takes the lock right after this one's write.
    const racing = { ...ports, ssm: { ...ports.ssm, put: async (name: string, value: string, options?: { createOnly?: true }) => {
      await ports.ssm.put(name, value, options);
      if (name === deployLockParameter("ent")) { world.params.set(name, JSON.stringify({ startedAt: world.now, token: "other" })); world.paramVersions.set(name, (world.paramVersions.get(name) ?? 1) + 1); }
    } } };
    expect(await runDeployer({ bundleId: bundle.bundleSha256 }, racing)).toMatchObject({ status: "refused", reason: expect.stringMatching(/another run/) });
    expect(changes(world)).toEqual([]);
    // The other run's lock is not released by this one.
    expect(JSON.parse(world.params.get(deployLockParameter("ent"))!).token).toBe("other");
  });

  it("checks both the value and the version on read-back, and releases only its own lock", async () => {
    const { bundle, world } = await ready();
    const { runDeployer } = await import("../../packages/broker/src/bundle-deployer/deploy.js");
    const ports = world.ports();
    const stale = () => world.params.set(deployLockParameter("ent"), JSON.stringify({ startedAt: world.now - 30 * 60_000 }));
    const afterPut = (change: () => void) => ({ ...ports, ssm: { ...ports.ssm, put: async (name: string, value: string, options?: { createOnly?: true }) => { await ports.ssm.put(name, value, options); if (name === deployLockParameter("ent")) change(); } } });
    // Another writer's value at the version this run expected.
    stale();
    expect(await runDeployer({ bundleId: bundle.bundleSha256 }, afterPut(() => world.params.set(deployLockParameter("ent"), JSON.stringify({ startedAt: world.now, token: "other" }))))).toMatchObject({ status: "refused", reason: expect.stringMatching(/another run/) });
    // This run's own value, but a version that shows a second write happened.
    world.params.delete(deployLockParameter("ent"));
    stale();
    expect(await runDeployer({ bundleId: bundle.bundleSha256 }, afterPut(() => world.paramVersions.set(deployLockParameter("ent"), (world.paramVersions.get(deployLockParameter("ent")) ?? 1) + 1)))).toMatchObject({ status: "refused", reason: expect.stringMatching(/another run/) });
    expect(changes(world)).toEqual([]);
    // A run whose lock was taken over while it worked leaves the new holder's lock alone.
    world.params.delete(deployLockParameter("ent"));
    world.afterStack = (stackName) => { if (stackName === "agentx-ent-foundation") world.params.set(deployLockParameter("ent"), JSON.stringify({ startedAt: world.now, token: "new holder" })); };
    expect((await world.run({ bundleId: bundle.bundleSha256 })).status).toBe("done");
    expect(JSON.parse(world.params.get(deployLockParameter("ent"))!).token).toBe("new holder");
  });

  it("dates a lock it cannot read by when it last changed: fresh keeps out, older than a run can last is taken over; with no date it stays", async () => {
    const { bundle, world } = await ready();
    world.params.set(deployLockParameter("ent"), "garbage");
    world.paramModified.set(deployLockParameter("ent"), world.now - 60_000);
    expect(await world.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/another run/) });
    world.paramModified.set(deployLockParameter("ent"), world.now - 21 * 60_000);
    expect((await world.run({ bundleId: bundle.bundleSha256 })).status).toBe("done");
    expect(world.params.has(deployLockParameter("ent"))).toBe(false);
    const ports = world.ports();
    const { runDeployer } = await import("../../packages/broker/src/bundle-deployer/deploy.js");
    world.params.set(deployLockParameter("ent"), "garbage");
    const undated = { ...ports, ssm: { ...ports.ssm, getVersioned: async (name: string) => { const found = await ports.ssm.getVersioned(name); return found === undefined ? undefined : { ...found, modifiedAt: undefined }; } } };
    expect(await runDeployer({ bundleId: bundle.bundleSha256 }, undated)).toMatchObject({ status: "refused", reason: expect.stringMatching(/another run/) });
  });

  it("stops a run already going when the customer suspends: the stack being updated finishes, no next stack starts, the progress is kept", async () => {
    const { bundle, world } = await ready();
    world.afterStack = (stackName) => { if (stackName === "agentx-ent-identity") world.params.set(operatorAccessStateParameter("ent"), "suspended"); };
    const result = await world.run({ bundleId: bundle.bundleSha256 });
    expect(result).toMatchObject({ status: "refused", done: ["foundation", "identity"], remaining: ["runtime", "control-plane", "slack"], reason: expect.stringMatching(/suspended by the customer/) });
    expect(world.changeSets.map((set) => set.stackName)).toEqual(["agentx-ent-foundation", "agentx-ent-identity"]);
    expect(JSON.parse(world.params.get(deployProgressParameter("ent"))!).done).toEqual(["foundation", "identity"]);
    expect(world.params.has(installedBundleParameter("ent"))).toBe(false);
    // Resumed when the customer turns it back on.
    world.afterStack = undefined;
    world.params.set(operatorAccessStateParameter("ent"), "enabled");
    expect((await world.run({ bundleId: bundle.bundleSha256 })).status).toBe("done");
  });

  it("runs one at a time: a fresh lock refuses, a stale one is taken over, and the lock is released when the run ends or is refused", async () => {
    const { bundle, world } = await ready();
    world.params.set(deployLockParameter("ent"), JSON.stringify({ startedAt: world.now - 60_000 }));
    expect(await world.run({ bundleId: bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/another run/) });
    expect(world.params.has(deployLockParameter("ent"))).toBe(true);
    expect(changes(world)).toEqual([]);
    world.params.set(deployLockParameter("ent"), JSON.stringify({ startedAt: world.now - 21 * 60_000 }));
    expect((await world.run({ bundleId: bundle.bundleSha256 })).status).toBe("done");
    expect(world.params.has(deployLockParameter("ent"))).toBe(false);
    world.params.delete(bundleApprovalKey(bundle.bundleSha256));
    world.deleteObject(bundleApprovalKey(bundle.bundleSha256));
    expect((await world.run({ bundleId: bundle.bundleSha256 })).status).toBe("refused");
    expect(world.params.has(deployLockParameter("ent"))).toBe(false);
  });
});

describe("a long deployment resumes instead of starting what it cannot finish", () => {
  it("returns in-progress with no new stack started when the time is nearly out, then continues from the recorded progress", async () => {
    const { bundle, world } = await ready();
    world.now = world.deadlineAt - 60_000;
    const first = await world.run({ bundleId: bundle.bundleSha256 }, { deadlineAt: world.deadlineAt });
    expect(first).toMatchObject({ status: "in-progress", done: [], remaining: PARTS });
    expect(world.changeSets).toEqual([]);
    world.now = T0 + 5_000;
    // Two stacks fit in this invocation's budget; the third times out in its stack wait.
    world.stackOutcome["agentx-ent-runtime"] = "timeout";
    const second = await world.run({ bundleId: bundle.bundleSha256 });
    expect(second).toMatchObject({ status: "in-progress", done: ["foundation", "identity"], remaining: ["runtime", "control-plane", "slack"] });
    world.stackOutcome = {};
    world.stacks.get("agentx-ent-runtime")!.status = "UPDATE_IN_PROGRESS";
    const third = await world.run({ bundleId: bundle.bundleSha256 });
    expect(third.status).toBe("done");
    expect(world.log.filter((line) => line.startsWith("cfn.create agentx-ent-foundation"))).toHaveLength(1);
  });

  it("reports a failed stack update as failed, and does not mark it done or record the install", async () => {
    const { bundle, world } = await ready();
    world.stackOutcome["agentx-ent-identity"] = "failed";
    const result = await world.run({ bundleId: bundle.bundleSha256 });
    expect(result).toMatchObject({ status: "failed", reason: "the identity stack update failed; see its events" });
    expect(JSON.parse(world.params.get(deployProgressParameter("ent"))!).done).toEqual(["foundation"]);
    expect(world.params.has(installedBundleParameter("ent"))).toBe(false);
    expect(JSON.parse(world.params.get("/agentx/ent/settings")!).version).toBe("1.2.3");
  });
});
