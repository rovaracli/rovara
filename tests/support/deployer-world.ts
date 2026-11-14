// Test support for the customer-owned bundle deployer: an in-memory bucket with object versions and delete markers, parameter store and CloudFormation.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { BUNDLE_PUBLIC_DEPLOYED_KINDS, BundleManifestSchema, approvedFileKey, bundleApprovalKey, bundleTrustParameter, operatorAccessStateParameter, sha256OfBytes, type ApprovalRecord } from "@agentx/cloud-contracts";
import { environmentStackName } from "@rovara-code/contracts";
import { runDeployer, type DeployerPorts, type StackState } from "../../packages/broker/src/bundle-deployer/deploy.js";
import type { BuiltBundle } from "./bundle-fixture.js";

export const DEPLOY_ROLE = "arn:aws:iam::123456789012:role/agentx-ent-cloudformation";
export const T0 = Date.parse("2026-10-31T12:00:00.000Z");

export class World {
  readonly versions = new Map<string, Array<{ versionId: string; body: Buffer | "deleted" }>>();
  readonly params = new Map<string, string>();
  readonly paramVersions = new Map<string, number>();
  readonly paramModified = new Map<string, number>();
  readonly stacks = new Map<string, StackState & { template?: string }>();
  readonly log: string[] = [];
  readonly changeSets: Array<{ stackName: string; name: string; templateUrl: string; parameters: unknown[]; roleArn: string }> = [];
  readonly uploaded = new Map<string, Buffer>();
  readonly uploadedVersions = new Map<string, string>();
  readonly alerts: string[] = [];
  failAlert = false;
  /** Runs after each stack wait, to change the world mid-run. */
  afterStack: ((stackName: string) => void) | undefined;
  now = T0;
  deadlineAt = T0 + 14 * 60_000;
  stackOutcome: Record<string, "complete" | "failed" | "timeout"> = {};
  failPut: string | undefined;
  private counter = 0;

  putObject(key: string, body: Buffer): string {
    const versionId = `v${++this.counter}`;
    this.versions.set(key, [...(this.versions.get(key) ?? []), { versionId, body }]);
    return versionId;
  }
  deleteObject(key: string): void {
    this.versions.set(key, [...(this.versions.get(key) ?? []), { versionId: `v${++this.counter}`, body: "deleted" }]);
  }

  ports(overrides: Partial<DeployerPorts> = {}): DeployerPorts {
    return {
      env: "ent", region: "us-east-1", bucket: "approvals-bucket", urlSuffix: "amazonaws.com", deployRoleArn: DEPLOY_ROLE,
      now: () => this.now, deadlineAt: this.deadlineAt,
      s3: {
        get: async (key, versionId) => {
          this.log.push(`s3.get ${key}${versionId === undefined ? "" : `@${versionId}`}`);
          const list = this.versions.get(key) ?? [];
          const found = versionId === undefined ? list[list.length - 1] : list.find((entry) => entry.versionId === versionId);
          return found === undefined || found.body === "deleted" ? undefined : found.body;
        },
        put: async (key, body) => { this.log.push(`s3.put ${key}`); this.uploaded.set(key, body); const versionId = this.putObject(`__copy__/${key}`, body); this.uploadedVersions.set(key, versionId); return { versionId }; },
      },
      alert: { publish: async (message) => { this.log.push("alert"); if (this.failAlert) throw new Error("sns down"); this.alerts.push(message); } },
      ssm: {
        get: async (name) => this.params.get(name),
        getVersioned: async (name) => { const value = this.params.get(name); return value === undefined ? undefined : { value, version: this.paramVersions.get(name) ?? 1, modifiedAt: this.paramModified.get(name) ?? this.now }; },
        put: async (name, value, options) => {
          this.log.push(`ssm.put ${name}`);
          if (this.failPut !== undefined && name.includes(this.failPut)) throw new Error("denied");
          if (options?.createOnly === true && this.params.has(name)) throw new Error("exists");
          this.paramVersions.set(name, this.params.has(name) ? (this.paramVersions.get(name) ?? 1) + 1 : 1);
          this.params.set(name, value);
          this.paramModified.set(name, this.now);
        },
        delete: async (name) => { this.log.push(`ssm.delete ${name}`); this.params.delete(name); this.paramVersions.delete(name); },
      },
      cfn: {
        describe: async (stackName) => this.stacks.get(stackName),
        getTemplate: async (stackName) => this.stacks.get(stackName)?.template,
        deleteChangeSet: async () => undefined,
        createChangeSet: async (input) => { this.log.push(`cfn.create ${input.stackName}`); this.changeSets.push(input); },
        waitChangeSet: async () => "ready",
        executeChangeSet: async (stackName) => { this.log.push(`cfn.execute ${stackName}`); },
        waitStack: async (stackName) => { const outcome = this.stackOutcome[stackName] ?? "complete"; this.afterStack?.(stackName); return outcome; },
      },
      ...overrides,
    };
  }
  run(request: unknown, overrides: Partial<DeployerPorts> = {}) { return runDeployer(request, this.ports(overrides)); }

  /** The install as an administrator left it: settings, every stack, the trusted key. */
  seed(options: { key: string; version?: string; identityMode?: "cognito" | "oidc"; accessTemplate?: string; stackParameters?: Record<string, Record<string, string>> }): void {
    this.params.set("/agentx/ent/settings", JSON.stringify({ version: options.version ?? "1.2.3", region: "us-east-1", identity: { mode: options.identityMode ?? "cognito" }, updatedAt: "2026-10-01T00:00:00.000Z" }));
    this.params.set(bundleTrustParameter("ent"), JSON.stringify([options.key]));
    this.params.set(operatorAccessStateParameter("ent"), "enabled");
    for (const part of ["access", "foundation", "identity", "runtime", "control-plane", "slack"] as const) {
      this.stacks.set(environmentStackName("ent", part), { status: "UPDATE_COMPLETE", parameters: options.stackParameters?.[part] ?? {}, ...(part === "access" ? { template: options.accessTemplate ?? JSON.stringify({ Resources: {} }) } : {}) });
    }
  }

  /** What the customer's administrator does: place the files (not the images) and write the approval record last. */
  async approve(bundle: BuiltBundle, options: { parameters?: ApprovalRecord["parameters"]; rollback?: boolean; version?: string; /** A rollback's pin; default: the seeded install (1.2.3, no mark). null: none. */ rollbackFrom?: ApprovalRecord["rollbackFrom"] | null } = {}): Promise<{ record: ApprovalRecord }> {
    const manifest = BundleManifestSchema.parse(JSON.parse(await readFile(join(bundle.dir, "bundle.json"), "utf8")));
    const names = ["bundle.json", "bundle.sig.json", ...manifest.files.filter((entry) => BUNDLE_PUBLIC_DEPLOYED_KINDS.includes(entry.kind)).map((entry) => entry.file)];
    const files: ApprovalRecord["files"] = [];
    for (const file of names) {
      const body = await readFile(join(bundle.dir, file));
      files.push({ file, versionId: this.putObject(approvedFileKey(bundle.bundleSha256, file), body), sha256: sha256OfBytes(body), bytes: body.length });
    }
    const record: ApprovalRecord = { schemaVersion: 1, bundleId: bundle.bundleSha256, version: options.version ?? manifest.version, approvedAt: "2026-10-31T11:00:00.000Z", approvedBy: "security@customer.example", files, parameters: options.parameters ?? {}, rollback: options.rollback ?? false,
      ...(options.rollback === true && options.rollbackFrom !== null ? { rollbackFrom: options.rollbackFrom ?? { installedVersion: "1.2.3", highWater: null } } : {}) };
    this.putObject(bundleApprovalKey(bundle.bundleSha256), Buffer.from(JSON.stringify(record)));
    return { record };
  }
}
void readdir;
