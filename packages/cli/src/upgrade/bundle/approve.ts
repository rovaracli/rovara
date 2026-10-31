// Enterprise foundations, N6 fix round 1: the customer's approval. Run by the customer's own administrator with the customer's own credentials, after checking the
// bundle's id. The bundle is verified first (signature, every hash, the id named on the command line); then its deployable files are placed under approved/<id>/ in the
// customer's approval bucket and, LAST, approvals/<id>.json is written: it pins the exact object versions and the stack parameters the deployment may set.
// Deleting that record (`bundle withdraw`) withdraws the approval; the deployer reads the current record on every start.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ApprovalRecordSchema,
  BUNDLE_MANIFEST_FILE,
  BUNDLE_SIGNATURE_FILE,
  agentXError,
  approvedFileKey,
  bundleApprovalKey,
  sha256OfBytes,
  type ApprovalRecord,
} from "@agentx/contracts";
import type { VerifiedBundle } from "./verify.js";

export interface ApprovalStore {
  /** Writes an object and returns the version id the bucket gave it. */
  put(key: string, body: Buffer): Promise<{ versionId: string }>;
  /** Deletes the current version (the bucket keeps a delete marker). */
  remove(key: string): Promise<void>;
}

export async function approveBundle(input: { bundle: VerifiedBundle; approvedBy: string; parameters: unknown; rollback: boolean; store: ApprovalStore; now: () => number }): Promise<ApprovalRecord> {
  const { bundle } = input;
  const parameters = ApprovalRecordSchema.shape.parameters.safeParse(input.parameters ?? {});
  if (!parameters.success) throw agentXError("CONFIG_INVALID", "the parameters file must be {\"<stack part>\": {\"<ParameterName>\": \"<value>\"}} for foundation, identity, runtime, control-plane or slack");
  const names = [BUNDLE_MANIFEST_FILE, BUNDLE_SIGNATURE_FILE, ...bundle.manifest.files.filter((entry) => entry.kind !== "image" && entry.kind !== "notes").map((entry) => entry.file)];
  const files: ApprovalRecord["files"] = [];
  for (const file of names) {
    // From the verified private copy: the bytes that were hashed are the bytes placed.
    const body = await readFile(join(bundle.copyDir, ...file.split("/")));
    const { versionId } = await input.store.put(approvedFileKey(bundle.bundleId, file), body);
    files.push({ file, versionId, sha256: sha256OfBytes(body), bytes: body.length });
  }
  const record = ApprovalRecordSchema.parse({
    schemaVersion: 1, bundleId: bundle.bundleId, version: bundle.manifest.version, approvedAt: new Date(input.now()).toISOString(), approvedBy: input.approvedBy,
    files, parameters: parameters.data, rollback: input.rollback,
  });
  await input.store.put(bundleApprovalKey(bundle.bundleId), Buffer.from(JSON.stringify(record)));
  return record;
}

export async function withdrawApproval(input: { bundleId: string; store: ApprovalStore }): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(input.bundleId)) throw agentXError("CONFIG_INVALID", "a bundle id is 64 hexadecimal characters");
  await input.store.remove(bundleApprovalKey(input.bundleId));
}
