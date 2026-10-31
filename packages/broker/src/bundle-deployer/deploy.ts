// Enterprise foundations, N6 fix round 1: the customer-owned bundle deployer. It runs in the CUSTOMER's account, under a role the customer's install creates,
// logged in the customer's CloudWatch. The Rovara operator role can only invoke it, and the whole of what it sends is a bundle id.
//
// For that id it: reads the customer's approval record (missing or deleted means not approved); reads the customer's trusted signing keys; reads each
// pinned object version and checks its hash against the record AND the signed manifest; verifies the signature; refuses an older version unless the customer
// approved a rollback; takes a restore point; then for each stack of a FIXED list deploys the verified bytes through the customer's deploy role, with every
// parameter either kept at its current value or taken from the approval. The caller never supplies a template, a stack, a parameter or a path.
//
// All outcomes are values, never thrown text: the only strings returned are fixed reasons and part names.
import {
  BUNDLE_PUBLIC_DEPLOYED_KINDS,
  BUILT_MANIFEST_FILE,
  BuiltManifestSchema,
  SynthSettingsSchema,
  accessTemplatesAgree,
  canonicalJson,
  editionBackupParameter,
  editionRecordParameter,
  redactedSynthSettings,
  synthKitSha256,
  synthSettingsParameter,
  synthSettingsSha256,
  BUNDLE_MANIFEST_FILE,
  BUNDLE_SIGNATURE_FILE,
  ApprovalRecordSchema,
  BundleManifestSchema,
  BundleSignatureSchema,
  DEPLOYER_PARTS,
  DEPLOY_LOCK_STALE_MS,
  DeployerRequestSchema,
  ReleaseManifestSchema,
  bundleApprovalKey,
  approvedFileKey,
  bundleTrustParameter,
  deployLockParameter,
  deployProgressParameter,
  operatorAccessStateParameter,
  deployingKey,
  environmentSettingsPrefix,
  environmentStackName,
  installedBundleParameter,
  renderTemplate,
  restorePointParameter,
  sha256OfBytes,
  verifyBundleSignature,
  type DeployerPart,
  type DeployerResult,
} from "@agentx/contracts";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export interface StackState {
  status: string;
  parameters: Record<string, string>;
}
export interface ChangeParameter {
  key: string;
  value?: string;
  usePrevious?: true;
}
export type ChangeSetOutcome = "ready" | "no-changes" | "failed";
export type StackWait = "complete" | "failed" | "timeout";

export interface DeployerPorts {
  env: string;
  region: string;
  bucket: string;
  /** The partition's S3 DNS suffix (`amazonaws.com`, `amazonaws.com.cn`), from the function's environment. */
  urlSuffix: string;
  deployRoleArn: string;
  now(): number;
  /** The time by which this invocation must stop starting new work (the function's timeout less a margin). */
  deadlineAt: number;
  s3: {
    /** The current version when `versionId` is absent; undefined when there is none (never written, or deleted). */
    get(key: string, versionId?: string): Promise<Buffer | undefined>;
    /** Returns the version id the bucket gave the object; the deployer hands CloudFormation that exact version. */
    put(key: string, body: Buffer): Promise<{ versionId: string | undefined }>;
  };
  /** The customer's alert topic. Publishing must succeed before the deployer acts. */
  alert: { publish(message: string): Promise<void> };
  ssm: {
    get(name: string): Promise<string | undefined>;
    /** The value with its version number and last-change time (ms), for the run lock. */
    getVersioned(name: string): Promise<{ value: string; version: number; modifiedAt: number | undefined } | undefined>;
    put(name: string, value: string, options?: { createOnly?: true }): Promise<void>;
    delete(name: string): Promise<void>;
  };
  cfn: {
    describe(stackName: string): Promise<StackState | undefined>;
    getTemplate(stackName: string): Promise<string | undefined>;
    deleteChangeSet(stackName: string, name: string): Promise<void>;
    createChangeSet(input: { stackName: string; name: string; templateUrl: string; parameters: ChangeParameter[]; roleArn: string }): Promise<void>;
    waitChangeSet(stackName: string, name: string, untilMs: number): Promise<ChangeSetOutcome>;
    executeChangeSet(stackName: string, name: string): Promise<void>;
    waitStack(stackName: string, untilMs: number): Promise<StackWait>;
  };
}

const refused = (reason: string): DeployerResult => ({ status: "refused", reason });
const failed = (reason: string): DeployerResult => ({ status: "failed", reason });

const SettingsSchema = z.object({ version: z.string(), region: z.string(), identity: z.object({ mode: z.enum(["cognito", "oidc"]) }).passthrough() }).passthrough();
const ProgressSchema = z.object({ schemaVersion: z.literal(1), bundleId: z.string().regex(/^[a-f0-9]{64}$/), startedAt: z.iso.datetime(), done: z.array(z.string()) }).strict();

/** Safe states to start from; a stack in rollback-failed or in-progress is not touched. */
const SETTLED = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "IMPORT_COMPLETE"]);
/** Reserved for the last part of the invocation's budget: no new stack is started with less time than this. */
const MIN_BUDGET_MS = 4 * 60 * 1000;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
}

function semver(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}
/** Negative when a is older than b. Undefined when either is not a plain x.y.z. */
function compare(a: string, b: string): number | undefined {
  const left = semver(a);
  const right = semver(b);
  if (left === undefined || right === undefined) return undefined;
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return (left[index] as number) - (right[index] as number);
  return 0;
}

const LOCK_STALE_MS = DEPLOY_LOCK_STALE_MS;

/** The customer's switch. Anything but an explicit `enabled` (absent, unreadable, `suspended`) counts as off. */
async function isSuspended(ports: DeployerPorts): Promise<boolean> {
  try {
    return (await ports.ssm.get(operatorAccessStateParameter(ports.env))) !== "enabled";
  } catch {
    return true;
  }
}

/**
 * Every call: tell the customer's topic first (if that cannot be done, nothing is done), check the customer's switch, take the one-run lock, do the work, say how it
 * ended. The alert does not depend on CloudTrail data events.
 */
export async function runDeployer(rawRequest: unknown, ports: DeployerPorts): Promise<DeployerResult> {
  const parsedRequest = DeployerRequestSchema.safeParse(rawRequest);
  const bundleId = parsedRequest.success ? parsedRequest.data.bundleId : null;
  try {
    await ports.alert.publish(JSON.stringify({ event: "bundle-deployer.started", env: ports.env, bundleId }));
  } catch {
    return failed("the alert could not be sent, so nothing was done");
  }
  let result: DeployerResult;
  try {
    result = await guarded(rawRequest, ports);
  } catch {
    result = failed("an unexpected error stopped the deployment");
  }
  try {
    await ports.alert.publish(JSON.stringify({ event: "bundle-deployer.finished", env: ports.env, bundleId, status: result.status, ...(result.reason === undefined ? {} : { reason: result.reason }) }));
  } catch {
    // The start was reported; the end is reported when the topic works again. The result still goes to the caller.
  }
  return result;
}

async function guarded(rawRequest: unknown, ports: DeployerPorts): Promise<DeployerResult> {
  if (!DeployerRequestSchema.safeParse(rawRequest).success) return refused("the request must be exactly a bundle id");
  if (await isSuspended(ports)) return refused("the operator's access is suspended by the customer");
  // One run at a time (a second would delete the first's change set).
  const lockName = deployLockParameter(ports.env);
  const held = await ports.ssm.getVersioned(lockName);
  if (held !== undefined) {
    // The lock's own start time; a lock that cannot be read is dated by when the parameter last changed, so it too ends. With no date at all it counts as fresh.
    let since: number | undefined;
    try {
      since = z.object({ startedAt: z.number() }).passthrough().parse(JSON.parse(held.value)).startedAt;
    } catch {
      since = held.modifiedAt;
    }
    if (since === undefined || ports.now() - since < LOCK_STALE_MS) return refused("another run of this deployer is active");
  }
  // Taking the lock: a fresh lock is created create-only. A stale one is overwritten and then read back: this run proceeds only if the parameter holds exactly its own value
  // at exactly the next version, so two runs that both saw the same stale lock cannot both go on (at worst both stop, and the next call succeeds).
  const token = `${ports.now()}-${randomUUID()}`;
  const mine = JSON.stringify({ startedAt: ports.now(), token });
  try {
    await ports.ssm.put(lockName, mine, held === undefined ? { createOnly: true } : undefined);
    if (held !== undefined) {
      const after = await ports.ssm.getVersioned(lockName);
      if (after === undefined || after.value !== mine || after.version !== held.version + 1) return refused("another run of this deployer is active");
    }
  } catch {
    return refused("another run of this deployer is active");
  }
  try {
    return await deployVerified(rawRequest, ports);
  } finally {
    // Only the run that holds the lock releases it.
    if ((await ports.ssm.get(lockName)) === mine) await ports.ssm.delete(lockName);
  }
}

async function deployVerified(rawRequest: unknown, ports: DeployerPorts): Promise<DeployerResult> {
  const bundleId = DeployerRequestSchema.parse(rawRequest).bundleId;
  const { env, region, bucket } = ports;

  // 1. The customer's approval. Deleting the record withdraws it.
  const approvalBytes = await ports.s3.get(bundleApprovalKey(bundleId));
  if (approvalBytes === undefined) return refused("this bundle is not approved, or its approval was withdrawn");
  let approval;
  try {
    approval = ApprovalRecordSchema.parse(JSON.parse(approvalBytes.toString("utf8")));
  } catch {
    return refused("the approval record is not valid");
  }
  if (approval.bundleId !== bundleId) return refused("the approval record names another bundle");

  // 2. The customer's trusted signing keys (written by an administrator; the operator cannot write them).
  const trustText = await ports.ssm.get(bundleTrustParameter(env));
  let trustedKeys: string[];
  try {
    const parsed: unknown = trustText === undefined ? [] : JSON.parse(trustText);
    trustedKeys = z.array(z.string()).parse(parsed);
  } catch {
    return refused("the trusted signing keys are not readable");
  }
  if (trustedKeys.length === 0) return refused("no trusted signing key is set for this install");

  // 3. Every pinned object version, read once, hashed against the record. The bytes held here are the bytes deployed.
  const bytesByFile = new Map<string, Buffer>();
  for (const entry of approval.files) {
    const body = await ports.s3.get(approvedFileKey(bundleId, entry.file), entry.versionId);
    if (body === undefined) return refused("a file the approval pins is missing");
    if (body.length !== entry.bytes || sha256OfBytes(body) !== entry.sha256) return refused("a file does not match the approval record");
    bytesByFile.set(entry.file, body);
  }

  // 4. The signed manifest.
  const manifestBytes = bytesByFile.get(BUNDLE_MANIFEST_FILE);
  const signatureBytes = bytesByFile.get(BUNDLE_SIGNATURE_FILE);
  if (manifestBytes === undefined || signatureBytes === undefined) return refused("the approval does not include the signed manifest");
  if (sha256OfBytes(manifestBytes) !== bundleId) return refused("the manifest is not the approved bundle");
  let signature;
  try {
    signature = BundleSignatureSchema.parse(JSON.parse(signatureBytes.toString("utf8")));
  } catch {
    return refused("the signature file is not valid");
  }
  const checked = verifyBundleSignature({ manifestBytes, signature, trustedKeys });
  if (!checked.ok) return refused("the signature does not verify against a trusted key");
  let manifest;
  try {
    manifest = BundleManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  } catch {
    return refused("the manifest is not valid");
  }
  const signedRelease = manifest.files.find((entry) => entry.file === "release.json");
  const releaseBytes = bytesByFile.get("release.json");
  if (signedRelease === undefined || releaseBytes === undefined || releaseBytes.length !== signedRelease.bytes || sha256OfBytes(releaseBytes) !== signedRelease.sha256) return refused("release.json is not the file the signed manifest lists");
  let release;
  try {
    release = ReleaseManifestSchema.parse(JSON.parse(releaseBytes.toString("utf8")));
  } catch {
    return refused("release.json is not valid");
  }
  if (release.version !== manifest.version || release.gitCommit !== manifest.gitCommit || approval.version !== manifest.version) return refused("the approval, the manifest and the release disagree about the version");

  // 5. The install, and the direction.
  const settingsText = await ports.ssm.get(`${environmentSettingsPrefix(env)}settings`);
  let settings;
  try {
    settings = SettingsSchema.parse(JSON.parse(settingsText ?? ""));
  } catch {
    return refused("the install's settings are not readable");
  }
  if (settings.region !== region) return refused("the install is in another region");
  const direction = compare(settings.version, manifest.version);
  if (direction === undefined) return refused("the installed version is not a release version");
  if (direction > 0 && !approval.rollback) return refused("this bundle is older than the installed release and no rollback was approved");

  // The edition of the install decides which kind of approval may deploy to it: an Enterprise install takes only a build made at its own approval (below), and an install
  // that is not Enterprise never takes one. An edition record that cannot be read is a refusal, never "not Enterprise".
  // The record, or its backup while a deploy has the record out of the way; both present must agree.
  let edition: string | undefined;
  try {
    const record = await ports.ssm.get(editionRecordParameter(env));
    const backup = await ports.ssm.get(editionBackupParameter(env));
    if (record !== undefined && backup !== undefined && record !== backup) return refused("the install's edition record and its backup disagree");
    edition = record ?? backup;
  } catch {
    return refused("the install's edition record could not be read");
  }
  if (edition !== undefined && edition !== "enterprise" && edition !== "public") return refused("the install's edition record is not readable");

  // What is deployed, whichever kind of approval it is: the version, the access stack, each stack's template, each package's bytes and where its parameters go.
  interface PlanPackage { file: string; assetId: string; parts: readonly string[]; bucketParameter: string; keyParameter: string; hashParameter: string }
  let accessTemplate: string | undefined;
  let templateFor: (part: DeployerPart) => string | undefined;
  let packages: PlanPackage[];
  const parts: DeployerPart[] = DEPLOYER_PARTS.filter((part) => part !== "identity" || settings.identity.mode !== "oidc");
  let accessRefusal: string;

  if (approval.build === undefined) {
    // The bundle's own (Public) templates.
    if (edition === "enterprise") return refused("an Enterprise install takes only a bundle built at its own approval (agentx bundle approve); this approval holds the bundle's prebuilt templates");
    // The files that are deployed must be exactly the signed ones (images, notes and the synthesis kit stay out of the bucket).
    const needed = manifest.files.filter((entry) => BUNDLE_PUBLIC_DEPLOYED_KINDS.includes(entry.kind));
    const neededNames = new Set(needed.map((entry) => entry.file));
    for (const entry of needed) {
      const body = bytesByFile.get(entry.file);
      if (body === undefined || body.length !== entry.bytes || sha256OfBytes(body) !== entry.sha256) return refused("a deployed file is not the file the signed manifest lists");
    }
    for (const file of bytesByFile.keys()) {
      if (file !== BUNDLE_MANIFEST_FILE && file !== BUNDLE_SIGNATURE_FILE && !neededNames.has(file)) return refused("the approval pins a file the signed manifest does not list");
    }
    const publicTemplate = (part: DeployerPart | "access"): string | undefined => {
      const entry = release.templates.find((candidate) => candidate.region === region && candidate.part === part);
      const body = entry === undefined ? undefined : bytesByFile.get(entry.file);
      return body === undefined ? undefined : renderTemplate(body.toString("utf8"), env);
    };
    accessTemplate = publicTemplate("access");
    templateFor = publicTemplate;
    packages = [];
    for (const pkg of release.packages) packages.push(pkg);
    accessRefusal = "the bundle's access stack is not the deployed one (an Enterprise install's access stack is not in a Public bundle); only your administrators deploy the access stack";
  } else {
    // A build made at approval. Nothing here is built: the bytes the approval pinned are checked against the signed kit, the recorded settings and the build's own manifest.
    if (edition !== "enterprise") return refused("a build made at approval is for an Enterprise install, and this install is not recorded as one");
    const build = approval.build;
    const builtManifestBytes = bytesByFile.get(BUILT_MANIFEST_FILE);
    if (builtManifestBytes === undefined) return refused("the approval does not include the build's manifest");
    if (sha256OfBytes(builtManifestBytes) !== build.resultSha256) return refused("the build's manifest is not the result the approval pinned");
    let built;
    try {
      built = BuiltManifestSchema.parse(JSON.parse(builtManifestBytes.toString("utf8")));
    } catch {
      return refused("the build's manifest is not valid");
    }
    // The settings the build used are the install's recorded settings now. An administrator who changed them since invalidates the approval.
    let recorded;
    try {
      recorded = SynthSettingsSchema.parse(JSON.parse((await ports.ssm.get(synthSettingsParameter(env))) ?? ""));
    } catch {
      return refused("the install's recorded build settings are not readable");
    }
    if (recorded.env !== env || recorded.region !== region || recorded.identityMode !== settings.identity.mode) return refused("the recorded build settings are not this install's");
    const settingsHash = synthSettingsSha256(recorded);
    if (settingsHash !== build.settingsSha256 || settingsHash !== built.settingsSha256) return refused("this approval was built from settings other than the ones now recorded for the install; approve the bundle again");
    if (canonicalJson(redactedSynthSettings(recorded)) !== canonicalJson(build.settings)) return refused("the settings shown in the approval are not the recorded ones");
    // The build is of this bundle, of this signed kit, for this install.
    const kitHash = synthKitSha256(manifest.files);
    if (kitHash !== build.kitSha256 || kitHash !== built.kitSha256) return refused("the build was made by a kit other than the signed bundle's");
    if (built.bundleId !== bundleId || built.version !== manifest.version || built.gitCommit !== manifest.gitCommit || built.env !== env || built.region !== region) return refused("the build is not of this bundle for this install");
    // The files pinned are exactly the signed lineage and the build's own files, each equal to what the build's manifest says.
    const builtEntries = [...built.templates, ...built.packages];
    const expectedFiles = new Set([BUNDLE_MANIFEST_FILE, BUNDLE_SIGNATURE_FILE, "release.json", BUILT_MANIFEST_FILE, ...builtEntries.map((entry) => entry.file)]);
    for (const file of bytesByFile.keys()) if (!expectedFiles.has(file)) return refused("the approval pins a file the build does not list");
    for (const entry of builtEntries) {
      const body = bytesByFile.get(entry.file);
      if (body === undefined || body.length !== entry.bytes || sha256OfBytes(body) !== entry.sha256) return refused("a built file is not the file the build's manifest lists");
    }
    // Lambda code is the SIGNED release's, byte for byte: a built package must be the package the signed manifest lists for its asset id (review I3).
    for (const pkg of built.packages) {
      const signedPackage = manifest.files.find((entry) => entry.kind === "package" && entry.file === `packages/${pkg.assetId}.zip`);
      if (signedPackage === undefined || signedPackage.sha256 !== pkg.sha256 || signedPackage.bytes !== pkg.bytes) return refused("a built package is not the signed release's package");
    }
    const wanted = new Set<string>(["access", ...parts]);
    const have = new Set<string>(built.templates.map((entry) => entry.part));
    if (wanted.size !== have.size || [...wanted].some((part) => !have.has(part))) return refused("the build does not hold exactly this install's stacks");
    const builtTemplate = (part: DeployerPart | "access"): string | undefined => {
      const entry = built.templates.find((candidate) => candidate.part === part);
      return entry === undefined ? undefined : bytesByFile.get(entry.file)?.toString("utf8");
    };
    accessTemplate = builtTemplate("access");
    templateFor = builtTemplate;
    packages = built.packages.map((pkg) => ({ file: pkg.file, assetId: pkg.assetId, parts: pkg.parts, bucketParameter: pkg.bucketParameter, keyParameter: pkg.keyParameter, hashParameter: pkg.hashParameter }));
    accessRefusal = "the build's access stack is not the deployed one; only your administrators deploy the access stack";
  }

  // The access stack holds the operator role and the deployer; this path never deploys it.
  const deployedAccess = await ports.cfn.getTemplate(environmentStackName(env, "access"));
  if (accessTemplate === undefined || deployedAccess === undefined) return refused("the access stack could not be compared");
  try {
    const same = approval.build === undefined
      ? JSON.stringify(canonical(JSON.parse(accessTemplate))) === JSON.stringify(canonical(JSON.parse(deployedAccess)))
      : accessTemplatesAgree(accessTemplate, deployedAccess);
    if (!same) return refused(accessRefusal);
  } catch {
    return refused("the access stack could not be compared");
  }

  // 6. Progress, and the restore point before the first change.
  let progressText = await ports.ssm.get(deployProgressParameter(env));
  let progress;
  if (progressText === undefined) {
    const takenAt = new Date(ports.now()).toISOString();
    const installed = await ports.ssm.get(installedBundleParameter(env));
    let previousBundleId: string | null;
    try {
      previousBundleId = installed === undefined ? null : z.object({ bundleId: z.string() }).passthrough().parse(JSON.parse(installed)).bundleId;
    } catch {
      return refused("the record of the installed bundle is not readable");
    }
    const restorePoint = { schemaVersion: 1, takenAt, pitrTimestamp: takenAt, fromVersion: settings.version, previousBundleId, targetVersion: manifest.version, targetBundleId: bundleId };
    try {
      await ports.ssm.put(restorePointParameter(env, takenAt), JSON.stringify(restorePoint), { createOnly: true });
      progress = { schemaVersion: 1 as const, bundleId, startedAt: takenAt, done: [] as string[] };
      await ports.ssm.put(deployProgressParameter(env), JSON.stringify(progress), { createOnly: true });
    } catch {
      return failed("the restore point or the progress record could not be written");
    }
    progressText = JSON.stringify(progress);
  }
  try {
    progress = ProgressSchema.parse(JSON.parse(progressText));
  } catch {
    return refused("the deployment progress record is not readable");
  }
  if (progress.bundleId !== bundleId) return refused("another bundle's deployment is unfinished");

  // 7. The fixed stacks, in order. Each is updated, never created or deleted.
  const done = new Set(progress.done);
  for (const part of parts) {
    if (done.has(part)) continue;
    if (ports.now() > ports.deadlineAt - MIN_BUDGET_MS) return { status: "in-progress", bundleId, done: [...done], remaining: parts.filter((p) => !done.has(p)) };
    // The customer's switch is read before every stack, so suspending stops a run that is already going (the stack being updated finishes; no next one starts).
    if (await isSuspended(ports)) return { status: "refused", bundleId, done: [...done], remaining: parts.filter((p) => !done.has(p)), reason: "the operator's access was suspended by the customer; the deployment stopped before the next stack" };
    const stackName = environmentStackName(env, part);
    const stack = await ports.cfn.describe(stackName);
    if (stack === undefined) return refused(`the ${part} stack does not exist; this path only updates stacks`);
    if (stack.status.endsWith("_IN_PROGRESS")) {
      const waited = await ports.cfn.waitStack(stackName, ports.deadlineAt);
      if (waited === "timeout") return { status: "in-progress", bundleId, done: [...done], remaining: parts.filter((p) => !done.has(p)) };
      if (waited === "failed") return failed(`the ${part} stack update failed; see its events`);
      continue;
    }
    if (!SETTLED.has(stack.status)) return refused(`the ${part} stack is not in a state this path updates`);

    const text = templateFor(part);
    if (text === undefined) return refused(`the bundle has no ${part} template for this region`);
    let template: { Parameters?: Record<string, { Default?: unknown }> };
    try {
      template = JSON.parse(text) as typeof template;
    } catch {
      return refused(`the ${part} template is not valid`);
    }
    const declared = template.Parameters ?? {};
    const values = new Map<string, string>();
    for (const pkg of packages) {
      if (!pkg.parts.includes(part)) continue;
      // Lambda reads the CURRENT object at a key, so the verified bytes are copied to a key only this function may write, and that key is what the stack gets.
      const bytes = bytesByFile.get(pkg.file);
      if (bytes === undefined) return refused("a package the release lists is not in the approval");
      const packageKey = deployingKey(bundleId, pkg.file);
      if (declared[pkg.bucketParameter] !== undefined || declared[pkg.keyParameter] !== undefined) await ports.s3.put(packageKey, bytes);
      if (declared[pkg.bucketParameter] !== undefined) values.set(pkg.bucketParameter, bucket);
      if (declared[pkg.keyParameter] !== undefined) values.set(pkg.keyParameter, packageKey);
      if (declared[pkg.hashParameter] !== undefined) values.set(pkg.hashParameter, pkg.assetId);
    }
    const pinned = approval.parameters[part] ?? {};
    for (const [name, value] of Object.entries(pinned)) {
      if (declared[name] === undefined) return refused(`the approval sets ${name}, which the ${part} template does not declare`);
      if (values.has(name)) return refused(`the approval sets ${name}, which the bundle's own packages set`);
      values.set(name, value);
    }
    const parameters: ChangeParameter[] = [];
    for (const name of Object.keys(declared).sort()) {
      const set = values.get(name);
      if (set !== undefined) parameters.push({ key: name, value: set });
      else if (stack.parameters[name] !== undefined) parameters.push({ key: name, usePrevious: true });
      else if (declared[name]?.Default === undefined) return refused(`the ${part} template has a new parameter ${name} with no value in the approval`);
    }

    // The verified bytes go to a prefix only this function writes, and CloudFormation reads them from there.
    const key = deployingKey(bundleId, `${part}.template.json`);
    const copy = await ports.s3.put(key, Buffer.from(text, "utf8"));
    if (copy.versionId === undefined) return refused("the approval bucket returned no version id; it must be versioned");
    const changeSetName = `rovara-${bundleId.slice(0, 12)}-${part}`;
    await ports.cfn.deleteChangeSet(stackName, changeSetName);
    await ports.cfn.createChangeSet({ stackName, name: changeSetName, templateUrl: `https://${bucket}.s3.${region}.${ports.urlSuffix}/${key}?versionId=${encodeURIComponent(copy.versionId)}`, parameters, roleArn: ports.deployRoleArn });
    const outcome = await ports.cfn.waitChangeSet(stackName, changeSetName, ports.deadlineAt);
    if (outcome === "failed") return failed(`the ${part} change set could not be created`);
    if (outcome === "ready") {
      await ports.cfn.executeChangeSet(stackName, changeSetName);
      const waited = await ports.cfn.waitStack(stackName, ports.deadlineAt);
      if (waited === "timeout") return { status: "in-progress", bundleId, done: [...done], remaining: parts.filter((p) => !done.has(p)) };
      if (waited === "failed") return failed(`the ${part} stack update failed; see its events`);
    }
    done.add(part);
    await ports.ssm.put(deployProgressParameter(env), JSON.stringify({ ...progress, done: [...done] }));
  }

  // 8. Every stack is on the bundle: record it, move the version, and close the progress record.
  const installedAt = new Date(ports.now()).toISOString();
  await ports.ssm.put(installedBundleParameter(env), JSON.stringify({ schemaVersion: 1, bundleId, version: manifest.version, installedAt }));
  await ports.ssm.put(`${environmentSettingsPrefix(env)}settings`, JSON.stringify({ ...(JSON.parse(settingsText as string) as Record<string, unknown>), version: manifest.version, updatedAt: installedAt }));
  await ports.ssm.delete(deployProgressParameter(env));
  return { status: "done", bundleId, done: parts, remaining: [] };
}
