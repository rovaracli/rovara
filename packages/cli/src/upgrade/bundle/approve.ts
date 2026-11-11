// Enterprise foundations, N6 fix round 1: the customer's approval. Run by the customer's own administrator with the customer's own credentials, after checking the
// bundle's id. The bundle is verified first (signature, every hash, the id named on the command line); then its deployable files are placed under approved/<id>/ in the
// customer's approval bucket and, LAST, approvals/<id>.json is written: it pins the exact object versions and the stack parameters the deployment may set.
// Deleting that record (`bundle withdraw`) withdraws the approval; the deployer reads the current record on every start.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalRecordSchema, BUNDLE_MANIFEST_FILE, BUNDLE_PUBLIC_DEPLOYED_KINDS, BUNDLE_SIGNATURE_FILE, approvedFileKey, bundleApprovalKey, redactedSynthSettings, sha256OfBytes, type ApprovalRecord, type SynthSettings } from "@agentx/cloud-contracts";
import { agentXError } from "@rovara-code/contracts";
import type { BuiltBundle } from "./build-at-approval.js";
import type { VerifiedBundle } from "./verify.js";

export interface ApprovalStore {
  /** Writes an object and returns the version id the bucket gave it. */
  put(key: string, body: Buffer): Promise<{ versionId: string }>;
  /** Deletes the current version (the bucket keeps a delete marker). */
  remove(key: string): Promise<void>;
}

export async function approveBundle(input: { bundle: VerifiedBundle; approvedBy: string; parameters: unknown; rollback: boolean; store: ApprovalStore; now: () => number; /** An Enterprise install: the build made at this approval and the recorded settings it used. The bundle's own templates are then not placed at all. */ built?: { build: BuiltBundle; settings: SynthSettings } }): Promise<ApprovalRecord> {
  const { bundle } = input;
  const parameters = ApprovalRecordSchema.shape.parameters.safeParse(input.parameters ?? {});
  if (!parameters.success) throw agentXError("CONFIG_INVALID", "the parameters file must be {\"<stack part>\": {\"<ParameterName>\": \"<value>\"}} for foundation, identity, runtime, control-plane or slack");
  // The files placed: the signed lineage always; then either the bundle's own deployable files (Public), or only release.json and the build made for this install (Enterprise).
  const names = input.built === undefined
    ? [BUNDLE_MANIFEST_FILE, BUNDLE_SIGNATURE_FILE, ...bundle.manifest.files.filter((entry) => BUNDLE_PUBLIC_DEPLOYED_KINDS.includes(entry.kind)).map((entry) => entry.file)]
    : [BUNDLE_MANIFEST_FILE, BUNDLE_SIGNATURE_FILE, "release.json"];
  const files: ApprovalRecord["files"] = [];
  for (const file of names) {
    // From the verified private copy: the bytes that were hashed are the bytes placed.
    const body = await readFile(join(bundle.copyDir, ...file.split("/")));
    const { versionId } = await input.store.put(approvedFileKey(bundle.bundleId, file), body);
    files.push({ file, versionId, sha256: sha256OfBytes(body), bytes: body.length });
  }
  if (input.built !== undefined) {
    // The build's bytes, as built (held in memory since they were checked), pinned like every other file.
    for (const { file, body } of input.built.build.files) {
      const { versionId } = await input.store.put(approvedFileKey(bundle.bundleId, file), body);
      files.push({ file, versionId, sha256: sha256OfBytes(body), bytes: body.length });
    }
  }
  const record = ApprovalRecordSchema.parse({
    schemaVersion: 1, bundleId: bundle.bundleId, version: bundle.manifest.version, approvedAt: new Date(input.now()).toISOString(), approvedBy: input.approvedBy,
    files, parameters: parameters.data, rollback: input.rollback,
    ...(input.built === undefined ? {} : { build: { resultSha256: input.built.build.resultSha256, kitSha256: input.built.build.kitSha256, settingsSha256: input.built.build.settingsSha256, settings: redactedSynthSettings(input.built.settings) } }),
  });
  await input.store.put(bundleApprovalKey(bundle.bundleId), Buffer.from(JSON.stringify(record)));
  return record;
}

export async function withdrawApproval(input: { bundleId: string; store: ApprovalStore }): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(input.bundleId)) throw agentXError("CONFIG_INVALID", "a bundle id is 64 hexadecimal characters");
  await input.store.remove(bundleApprovalKey(input.bundleId));
}
