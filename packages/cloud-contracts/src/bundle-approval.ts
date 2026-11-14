// Enterprise foundations, task N6 fix round 1: the customer's approval of a bundle, and the customer-owned deployer that acts on it.
//
// An approval is a record the CUSTOMER writes to the approval bucket after checking a bundle's id (`approvals/<bundle id>.json`). It pins the exact
// S3 object versions of the files to deploy and the stack parameters the deployment may set. The deployer (a function in the customer's account that
// the Rovara operator role can only invoke with a bundle id) re-verifies the bundle against it and deploys. Deleting the record withdraws the approval.
import { z } from "zod";
import { environmentSettingsPrefix } from "@rovara-code/contracts";
import { ApprovalBuildSchema } from "./synth-build.js";

export const APPROVAL_PREFIX = "approvals/";
export const APPROVED_FILES_PREFIX = "approved/";
/** Where the deployer places the exact bytes it verified, so CloudFormation reads those bytes and nothing else. Only the deployer writes here. */
export const DEPLOYING_PREFIX = "deploying/";

const BundleId = z.string().regex(/^[a-f0-9]{64}$/);
const ParameterName = z.string().regex(/^[A-Za-z0-9]{1,255}$/);
const DEPLOY_PARTS = ["foundation", "identity", "runtime", "control-plane", "slack"] as const;
export type DeployerPart = (typeof DEPLOY_PARTS)[number];
export const DEPLOYER_PARTS: readonly DeployerPart[] = DEPLOY_PARTS;

export const ApprovalRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    bundleId: BundleId,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    approvedAt: z.iso.datetime(),
    approvedBy: z.string().min(1).max(256),
    /** The files the deployer reads from the bucket, each pinned to the object version the customer approved. `bundle.json` and `bundle.sig.json` are always listed. */
    files: z
      .array(z.object({ file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/).max(300), versionId: z.string().min(1).max(1024), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative() }).strict())
      .min(2)
      .max(2_000),
    /** Stack parameters the deployment may set, by stack part. Any other parameter keeps its current value; the caller never sets one. */
    parameters: z.partialRecord(z.enum(DEPLOY_PARTS), z.record(ParameterName, z.string().max(4_096))).default({}),
    /** True only when the customer approves moving back to this older version on purpose. */
    rollback: z.boolean().default(false),
    /**
     * A rollback approval only (0.5.17): the install it was checked against, the version its settings recorded and its release high-water mark (null: none
     * recorded). The deployer refuses the approval once either differs, so an approval checked against the rollback floors at one version is never deployed
     * after the install moved on. A rollback approval without it is refused (approve it again). A deployer that predates the field refuses the record.
     */
    rollbackFrom: z.object({ installedVersion: z.string().regex(/^\d+\.\d+\.\d+$/), highWater: z.string().regex(/^\d+\.\d+\.\d+$/).nullable() }).strict().optional(),
    /**
     * Present only for an Enterprise install's approval: the files above then include `built/...`, the templates and packages the approval built for this install
     * (task N3b), and this pins the hash of that result and of every setting it was built from. Absent: the bundle's own (Public) templates, as before. A deployer
     * that predates this field refuses the record (the schema is strict), which is the safe side.
     */
    build: ApprovalBuildSchema.optional(),
  })
  .strict();
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

/** The whole of what the operator sends. Nothing else is accepted. */
export const DeployerRequestSchema = z.object({ bundleId: BundleId }).strict();
export type DeployerRequest = z.infer<typeof DeployerRequestSchema>;

export const DeployerResultSchema = z.object({
  status: z.enum(["done", "in-progress", "refused", "failed"]),
  bundleId: BundleId.optional(),
  /** Parts already on the bundle, and parts still to do; fixed words and part names only, no free text from a stack. */
  done: z.array(z.string()).optional(),
  remaining: z.array(z.string()).optional(),
  reason: z.string().max(300).optional(),
}).strict();
export type DeployerResult = z.infer<typeof DeployerResultSchema>;

export const bundleDeployerFunctionName = (env: string): string => `agentx-${env}-bundle-deployer`;
export const bundleDeployerRoleName = (env: string): string => `agentx-${env}-bundle-deployer`;
export const bundleApprovalKey = (bundleId: string): string => `${APPROVAL_PREFIX}${bundleId}.json`;
export const approvedFileKey = (bundleId: string, file: string): string => `${APPROVED_FILES_PREFIX}${bundleId}/${file}`;
export const deployingKey = (bundleId: string, file: string): string => `${DEPLOYING_PREFIX}${bundleId}/${file}`;

/** The customer-written list of trusted bundle signing keys (a JSON array of PEM public keys). Only administrators write it; the operator role has no SSM access. */
export const bundleTrustParameter = (env: string): string => `${environmentSettingsPrefix(env)}bundle-trust/public-keys`;
/** Mirrors the access stack's OperatorAccessState switch (`enabled` | `suspended`) so a deployer run already started can read it before every stack. Written by the stack only. */
export const operatorAccessStateParameter = (env: string): string => `${environmentSettingsPrefix(env)}operator-access/state`;
/** Held (create-only, expiring) by the one deployer run that is working. */
/** A run that has held the lock longer than a function can run (15 minutes) is dead. */
export const DEPLOY_LOCK_STALE_MS = 20 * 60 * 1000;
export const deployLockParameter = (env: string): string => `${environmentSettingsPrefix(env)}deploy/lock`;
export const deployProgressParameter = (env: string): string => `${environmentSettingsPrefix(env)}deploy/progress`;

const BundleIdText = BundleId;
export const RestorePointSchema = z.object({
  schemaVersion: z.literal(1),
  takenAt: z.iso.datetime(),
  /** Restore the tables to this instant (point-in-time recovery). The same instant as takenAt: nothing of this upgrade is written before it. */
  pitrTimestamp: z.iso.datetime(),
  fromVersion: z.string().min(1),
  previousBundleId: BundleIdText.nullable(),
  targetVersion: z.string().min(1),
  targetBundleId: BundleIdText,
}).strict();
export type RestorePoint = z.infer<typeof RestorePointSchema>;
export const InstalledBundleSchema = z.object({ schemaVersion: z.literal(1), bundleId: BundleIdText, version: z.string().min(1), installedAt: z.iso.datetime() }).strict();
export type InstalledBundle = z.infer<typeof InstalledBundleSchema>;
export const installedBundleParameter = (env: string): string => `${environmentSettingsPrefix(env)}bundle`;
/** The highest release the install ever ran (a plain x.y.z), never lowered: `agentx upgrade --rollback-to` and `bundle approve --rollback` check the rollback floors from it. Written by the CLI and by the bundle deployer. */
export const releaseHighWaterParameter = (env: string): string => `${environmentSettingsPrefix(env)}release-high-water`;
export const restorePointParameter = (env: string, takenAt: string): string => `${environmentSettingsPrefix(env)}restore-points/${takenAt.replace(/[-:.]/g, "")}`;
