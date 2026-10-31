/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.stringMatching and parsed JSON are untyped */
// N3b: the customer-owned deployer installs only the bytes an Enterprise approval pinned, and checks them again: against the approval record, the build's own manifest, the signed kit,
// the install's recorded settings and the install's edition. Each test tampers with one link of that chain.
import { afterEach, describe, expect, it } from "vitest";
import { BuiltManifestSchema, accessTemplatesAgree, approvedFileKey, bundleApprovalKey, editionRecordParameter, sha256OfBytes, synthSettingsParameter, templateWithoutCodeLocations, type ApprovalRecord } from "@agentx/contracts";
import type { BuiltBundle } from "../support/bundle-fixture.js";
import { EnterpriseWorld, SETTINGS_ENT } from "../support/enterprise-approval-world.js";

const made: BuiltBundle[] = [];
afterEach(async () => { await Promise.all(made.splice(0).map((bundle) => bundle.cleanup())); });
const changes = (ew: EnterpriseWorld) => ew.world.log.filter((line) => line.startsWith("cfn.create") || line.startsWith("cfn.execute"));

async function approved(options: Parameters<typeof EnterpriseWorld.create>[1] = {}) {
  const ew = await EnterpriseWorld.create(made, options);
  await ew.deployAsBuilt(options.settings);
  const { record } = await ew.approve();
  return { ew, record, id: ew.bundle.bundleSha256 };
}
const writeRecord = (ew: EnterpriseWorld, id: string, record: ApprovalRecord) => { ew.world.putObject(bundleApprovalKey(id), Buffer.from(JSON.stringify(record))); };
/** Replaces the stored bytes of a pinned object version WITHOUT touching the record: what someone with write access to the bucket's data could do. */
const corrupt = (ew: EnterpriseWorld, id: string, record: ApprovalRecord, file: string, edit: (text: string) => string) => {
  const pinned = record.files.find((entry) => entry.file === file)!;
  const entry = ew.world.versions.get(approvedFileKey(id, file))!.find((v) => v.versionId === pinned.versionId)!;
  entry.body = Buffer.from(edit((entry.body as Buffer).toString("utf8")), "utf8");
};
/** Writes new bytes for a file AND updates the record's pin, as someone who can write the record could. Returns the updated record (not yet written). */
const replace = (ew: EnterpriseWorld, id: string, record: ApprovalRecord, file: string, body: Buffer): ApprovalRecord => {
  const versionId = ew.world.putObject(approvedFileKey(id, file), body);
  return { ...record, files: record.files.map((entry) => (entry.file === file ? { ...entry, versionId, sha256: sha256OfBytes(body), bytes: body.length } : entry)) };
};
const bodyOf = (ew: EnterpriseWorld, id: string, record: ApprovalRecord, file: string): Buffer => {
  const pinned = record.files.find((entry) => entry.file === file)!;
  return ew.world.versions.get(approvedFileKey(id, file))!.find((v) => v.versionId === pinned.versionId)!.body as Buffer;
};
/** Rewrites the build's manifest consistently (record pin and result hash updated), as the approver's own credentials could. */
const rewriteManifest = (ew: EnterpriseWorld, id: string, record: ApprovalRecord, edit: (manifest: Record<string, unknown>) => void, pinResult = true): ApprovalRecord => {
  const manifest = JSON.parse(bodyOf(ew, id, record, "built/manifest.json").toString("utf8")) as Record<string, unknown>;
  edit(manifest);
  const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const next = replace(ew, id, record, "built/manifest.json", body);
  return pinResult ? { ...next, build: { ...next.build!, resultSha256: sha256OfBytes(body) } } : next;
};

describe("the deployer installs a build made at approval", () => {
  it("deploys exactly the pinned bytes: the built templates and the built package, through the customer's deploy role, then records the install", async () => {
    const { ew, record, id } = await approved();
    const result = await ew.world.run({ bundleId: id });
    expect(result).toEqual({ status: "done", bundleId: id, done: ["foundation", "identity", "runtime", "control-plane", "slack"], remaining: [] });
    for (const part of ["foundation", "control-plane"]) {
      const sent = ew.world.uploaded.get(`deploying/${id}/${part}.template.json`)!;
      expect(sent.equals(bodyOf(ew, id, record, `built/templates/${part}.template.json`))).toBe(true);
    }
    const asset = record.files.find((f) => f.file.startsWith("built/packages/"))!;
    expect(ew.world.uploaded.get(`deploying/${id}/${asset.file}`)!.equals(bodyOf(ew, id, record, asset.file))).toBe(true);
    const control = ew.world.changeSets.find((set) => set.stackName === "agentx-ent-control-plane")!;
    expect(control.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ key: expect.stringMatching(/AssetParameters.*S3Bucket/), value: "approvals-bucket" }), expect.objectContaining({ key: expect.stringMatching(/AssetParameters.*S3VersionKey/), value: `deploying/${id}/${asset.file}` })]));
    expect(JSON.parse(ew.world.params.get("/agentx/ent/settings")!)).toMatchObject({ version: "1.4.0" });
  });

  it("refuses a built template whose stored bytes changed after the approval, a package that did, and the build's manifest that did", async () => {
    for (const file of ["built/templates/control-plane.template.json", "built/packages/abcdef0123456789.zip", "built/manifest.json", "release.json"]) {
      const { ew, record, id } = await approved();
      corrupt(ew, id, record, file, (text) => `${text}x`);
      expect(await ew.world.run({ bundleId: id }), file).toMatchObject({ status: "refused", reason: expect.stringMatching(/does not match the approval record/) });
      expect(changes(ew), file).toEqual([]);
    }
  });

  it("refuses when the record is rewritten to a template the build's manifest does not list, and when the manifest is rewritten but not the pinned result", async () => {
    let { ew, record, id } = await approved();
    const swapped = replace(ew, id, record, "built/templates/control-plane.template.json", Buffer.from(`${JSON.stringify({ Resources: { Evil: { Type: "AWS::IAM::Role", Properties: {} } } })}\n`));
    writeRecord(ew, id, swapped);
    expect(await ew.world.run({ bundleId: id })).toMatchObject({ status: "refused", reason: expect.stringMatching(/built file is not the file the build's manifest lists/) });
    ({ ew, record, id } = await approved());
    writeRecord(ew, id, rewriteManifest(ew, id, record, (m) => { m.packages = []; }, false));
    expect(await ew.world.run({ bundleId: id })).toMatchObject({ status: "refused", reason: expect.stringMatching(/not the result the approval pinned/) });
    expect(changes(ew)).toEqual([]);
  });

  it("refuses an approval built from other settings than the install's recorded ones now, an unreadable or missing record, and a record of another install", async () => {
    const edits: Array<[string, (ew: EnterpriseWorld) => Promise<void> | void, RegExp]> = [
      ["changed", (ew) => ew.setSettings(SETTINGS_ENT({ rovaraEnterpriseEgressCidrs: "10.99.0.0/16", agentxAuditTsa: "off" })), /settings other than the ones now recorded/],
      ["a setting added", (ew) => ew.setSettings(SETTINGS_ENT({ rovaraEnterpriseEgressCidrs: "10.20.0.0/16", agentxAuditTsa: "off", agentxRovaraOrgId: "o-abc123def4" })), /settings other than the ones now recorded/],
      ["deleted", (ew) => { ew.world.params.delete(synthSettingsParameter("ent")); }, /recorded build settings are not readable/],
      ["garbage", (ew) => ew.setSettings("{nope"), /recorded build settings are not readable/],
      ["another region", (ew) => ew.setSettings({ ...SETTINGS_ENT({ rovaraEnterpriseEgressCidrs: "10.20.0.0/16", agentxAuditTsa: "off" }), region: "eu-west-1" }), /not this install's/],
      ["another identity mode", (ew) => ew.setSettings({ ...SETTINGS_ENT({ rovaraEnterpriseEgressCidrs: "10.20.0.0/16", agentxAuditTsa: "off" }), identityMode: "oidc" }), /not this install's/],
    ];
    for (const [name, edit, pattern] of edits) {
      const { ew, id } = await approved();
      await edit(ew);
      expect(await ew.world.run({ bundleId: id }), name).toMatchObject({ status: "refused", reason: expect.stringMatching(pattern) });
      expect(changes(ew), name).toEqual([]);
    }
  });

  it("refuses a build made by a kit other than the signed bundle's, and a build of another bundle, version, install or region", async () => {
    const cases: Array<[string, (m: Record<string, unknown>) => void, RegExp]> = [
      ["kit", (m) => { m.kitSha256 = "f".repeat(64); }, /kit other than the signed bundle's/],
      ["bundle", (m) => { m.bundleId = "e".repeat(64); }, /not of this bundle for this install/],
      ["version", (m) => { m.version = "9.9.9"; }, /not of this bundle for this install/],
      ["env", (m) => { m.env = "other"; }, /not of this bundle for this install/],
      ["region", (m) => { m.region = "eu-west-1"; }, /not of this bundle for this install/],
      ["settings", (m) => { m.settingsSha256 = "d".repeat(64); }, /settings other than the ones now recorded/],
    ];
    for (const [name, edit, pattern] of cases) {
      const { ew, record, id } = await approved();
      writeRecord(ew, id, rewriteManifest(ew, id, record, edit));
      expect(await ew.world.run({ bundleId: id }), name).toMatchObject({ status: "refused", reason: expect.stringMatching(pattern) });
      expect(changes(ew), name).toEqual([]);
    }
    const { ew, record, id } = await approved();
    writeRecord(ew, id, { ...record, build: { ...record.build!, kitSha256: "c".repeat(64) } });
    expect(await ew.world.run({ bundleId: id })).toMatchObject({ status: "refused", reason: expect.stringMatching(/kit other than the signed bundle's/) });
  });

  it("refuses a build that does not hold exactly the install's stacks, and an approval that pins a file the build does not list", async () => {
    let { ew, record, id } = await approved();
    const without = rewriteManifest(ew, id, record, (m) => { m.templates = (m.templates as Array<{ part: string }>).filter((t) => t.part !== "slack"); });
    writeRecord(ew, id, { ...without, files: without.files.filter((entry) => entry.file !== "built/templates/slack.template.json") });
    expect(await ew.world.run({ bundleId: id })).toMatchObject({ status: "refused", reason: expect.stringMatching(/does not hold exactly this install's stacks/) });
    ({ ew, record, id } = await approved());
    const extra = replace(ew, id, record, "built/manifest.json", bodyOf(ew, id, record, "built/manifest.json"));
    const stray = Buffer.from("stray");
    const versionId = ew.world.putObject(approvedFileKey(id, "built/templates/extra.json"), stray);
    writeRecord(ew, id, { ...extra, files: [...extra.files, { file: "built/templates/extra.json", versionId, sha256: sha256OfBytes(stray), bytes: stray.length }] });
    expect(await ew.world.run({ bundleId: id })).toMatchObject({ status: "refused", reason: expect.stringMatching(/approval pins a file the build does not list/) });
    expect(BuiltManifestSchema.safeParse(JSON.parse(bodyOf(ew, id, record, "built/manifest.json").toString("utf8"))).success).toBe(true);
  });

  it("refuses the bundle's own prebuilt templates for an Enterprise install, and a build for an install that is not Enterprise, or whose edition cannot be read", async () => {
    // The refusal "an Enterprise install takes only a build made at its own approval" stays for every approval that is not one.
    const publicApproval = await EnterpriseWorld.create(made);
    await publicApproval.world.approve(publicApproval.bundle);
    expect(await publicApproval.world.run({ bundleId: publicApproval.bundle.bundleSha256 })).toMatchObject({ status: "refused", reason: expect.stringMatching(/Enterprise install takes only a bundle built at its own approval/) });
    expect(changes(publicApproval)).toEqual([]);
    for (const edition of ["public", undefined]) {
      const { ew, id } = await approved();
      if (edition === undefined) ew.world.params.delete(editionRecordParameter("ent")); else ew.world.params.set(editionRecordParameter("ent"), edition);
      expect(await ew.world.run({ bundleId: id }), String(edition)).toMatchObject({ status: "refused", reason: expect.stringMatching(/is for an Enterprise install/) });
    }
    const garbage = await approved();
    garbage.ew.world.params.set(editionRecordParameter("ent"), "something else");
    expect(await garbage.ew.world.run({ bundleId: garbage.id })).toMatchObject({ status: "refused", reason: expect.stringMatching(/edition record is not readable/) });
    const unreadable = await approved();
    expect(await unreadable.ew.world.run({ bundleId: unreadable.id }, { ssm: { ...unreadable.ew.world.ports().ssm, get: async (name) => { if (name === editionRecordParameter("ent")) throw new Error("denied"); return unreadable.ew.world.params.get(name); } } })).toMatchObject({ status: "refused", reason: expect.stringMatching(/edition record could not be read/) });
    expect(changes(unreadable.ew)).toEqual([]);
  });

  it("keeps the Public path as it was: a Public install deploys the bundle's own templates, kit or no kit, and the kit is never placed", async () => {
    const ew = await EnterpriseWorld.create(made, { edition: "public" });
    ew.world.params.delete(editionRecordParameter("ent"));
    const { record } = await ew.world.approve(ew.bundle);
    expect(record.build).toBeUndefined();
    expect(record.files.some((f) => f.file.startsWith("synth-kit/"))).toBe(false);
    expect(await ew.world.run({ bundleId: ew.bundle.bundleSha256 })).toMatchObject({ status: "done" });
    expect(ew.world.uploaded.get(`deploying/${ew.bundle.bundleSha256}/foundation.template.json`)!.toString("utf8")).toBe(`${JSON.stringify({ Resources: {} })}\n`);
  });

  it("refuses when the access stack is not the deployed one, and accepts the same stack read from another code location", async () => {
    const { ew, id } = await approved();
    ew.world.stacks.set("agentx-ent-access", { ...ew.world.stacks.get("agentx-ent-access")!, template: JSON.stringify({ Resources: { Different: { Type: "AWS::SSM::Parameter", Properties: {} } } }) });
    expect(await ew.world.run({ bundleId: id })).toMatchObject({ status: "refused", reason: expect.stringMatching(/access stack is not the deployed one/) });
    expect(changes(ew)).toEqual([]);
  });
});

describe("comparing the access stack apart from where its code is read from", () => {
  const fn = (code: unknown, extra: Record<string, unknown> = {}) => ({ Resources: { Deployer: { Type: "AWS::Lambda::Function", Properties: { Code: code, Runtime: "nodejs22.x", ...extra }, Metadata: { "aws:asset:path": "asset.x" } } } });
  const hash = "a".repeat(64);
  const bootstrap = { Parameters: { BootstrapVersion: { Type: "String" } }, Rules: { CheckBootstrapVersion: { Assertions: [] } }, ...fn({ S3Bucket: { "Fn::Sub": "cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}" }, S3Key: `${hash}.zip` }) };
  const legacy = { Parameters: { [`AssetParameters${hash}S3Bucket`]: { Type: "String" }, [`AssetParameters${hash}S3VersionKey`]: { Type: "String" } }, ...fn({ S3Bucket: { Ref: `AssetParameters${hash}S3Bucket` }, S3Key: { "Fn::Join": ["", [{ "Fn::Select": [0, { "Fn::Split": ["||", { Ref: `AssetParameters${hash}S3VersionKey` }] }] }] ] } }) };
  it("agrees for the same code from bootstrap or from parameters, and disagrees for other code, other settings, or a template that cannot be read", () => {
    expect(accessTemplatesAgree(JSON.stringify(legacy), JSON.stringify(bootstrap))).toBe(true);
    const otherCode = JSON.parse(JSON.stringify(legacy).split(hash).join("b".repeat(64))) as object;
    expect(accessTemplatesAgree(JSON.stringify(otherCode), JSON.stringify(bootstrap))).toBe(false);
    expect(accessTemplatesAgree(JSON.stringify({ ...legacy, ...fn(legacy.Resources.Deployer.Properties.Code, { Runtime: "nodejs20.x" }) }), JSON.stringify(bootstrap))).toBe(false);
    expect(accessTemplatesAgree("{nope", JSON.stringify(bootstrap))).toBe(false);
    expect(accessTemplatesAgree(JSON.stringify(legacy), "")).toBe(false);
    expect(() => templateWithoutCodeLocations([1])).toThrow();
  });
});
