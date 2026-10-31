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
  BUNDLE_MANIFEST_FILE,
  BUNDLE_SIGNATURE_FILE,
  ApprovalRecordSchema,
  BundleManifestSchema,
  BundleSignatureSchema,
  DEPLOYER_PARTS,
  DeployerRequestSchema,
  ReleaseManifestSchema,
  bundleApprovalKey,
  approvedFileKey,
  bundleTrustParameter,
  deployProgressParameter,
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
  deployRoleArn: string;
  now(): number;
  /** The time by which this invocation must stop starting new work (the function's timeout less a margin). */
  deadlineAt: number;
  s3: {
    /** The current version when `versionId` is absent; undefined when there is none (never written, or deleted). */
    get(key: string, versionId?: string): Promise<Buffer | undefined>;
    put(key: string, body: Buffer): Promise<void>;
  };
  ssm: {
    get(name: string): Promise<string | undefined>;
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

export async function runDeployer(rawRequest: unknown, ports: DeployerPorts): Promise<DeployerResult> {
  const parsedRequest = DeployerRequestSchema.safeParse(rawRequest);
  if (!parsedRequest.success) return refused("the request must be exactly a bundle id");
  const bundleId = parsedRequest.data.bundleId;
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
  // The files that are deployed must be exactly the signed ones (images and notes stay out of the bucket).
  const needed = manifest.files.filter((entry) => entry.kind !== "image" && entry.kind !== "notes");
  const neededNames = new Set(needed.map((entry) => entry.file));
  for (const entry of needed) {
    const body = bytesByFile.get(entry.file);
    if (body === undefined || body.length !== entry.bytes || sha256OfBytes(body) !== entry.sha256) return refused("a deployed file is not the file the signed manifest lists");
  }
  for (const file of bytesByFile.keys()) {
    if (file !== BUNDLE_MANIFEST_FILE && file !== BUNDLE_SIGNATURE_FILE && !neededNames.has(file)) return refused("the approval pins a file the signed manifest does not list");
  }
  let release;
  try {
    release = ReleaseManifestSchema.parse(JSON.parse((bytesByFile.get("release.json") as Buffer).toString("utf8")));
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

  const parts: DeployerPart[] = DEPLOYER_PARTS.filter((part) => part !== "identity" || settings.identity.mode !== "oidc");
  const templateFor = (part: DeployerPart | "access"): string | undefined => {
    const entry = release.templates.find((candidate) => candidate.region === region && candidate.part === part);
    const body = entry === undefined ? undefined : bytesByFile.get(entry.file);
    return body === undefined ? undefined : renderTemplate(body.toString("utf8"), env);
  };
  // The access stack holds the operator role and the deployer; this path never deploys it.
  const accessTemplate = templateFor("access");
  const deployedAccess = await ports.cfn.getTemplate(environmentStackName(env, "access"));
  if (accessTemplate === undefined || deployedAccess === undefined) return refused("the access stack could not be compared");
  try {
    if (JSON.stringify(canonical(JSON.parse(accessTemplate))) !== JSON.stringify(canonical(JSON.parse(deployedAccess)))) {
      return refused("the bundle changes the access stack, which only your administrators deploy");
    }
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
    for (const pkg of release.packages) {
      if (!pkg.parts.includes(part)) continue;
      // Packages are read from the bucket's approved copy, whose hash was checked above.
      if (declared[pkg.bucketParameter] !== undefined) values.set(pkg.bucketParameter, bucket);
      if (declared[pkg.keyParameter] !== undefined) values.set(pkg.keyParameter, approvedFileKey(bundleId, pkg.file));
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
    await ports.s3.put(key, Buffer.from(text, "utf8"));
    const changeSetName = `rovara-${bundleId.slice(0, 12)}-${part}`;
    await ports.cfn.deleteChangeSet(stackName, changeSetName);
    await ports.cfn.createChangeSet({ stackName, name: changeSetName, templateUrl: `https://${bucket}.s3.${region}.amazonaws.com/${key}`, parameters, roleArn: ports.deployRoleArn });
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
