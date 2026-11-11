// An Enterprise install as the approval and the deployer see it: the customer's Parameter Store (CLI side), the deployer's world (bucket, stacks, Parameter Store), and a signed bundle
// that carries a synthesis kit. `approve` is `bundle approve` against it.

import { editionRecordParameter, synthSettingsParameter, type ApprovalRecord, type SynthSettings } from "@agentx/cloud-contracts";
import { environmentStackName } from "@rovara-code/contracts";
import type { ApprovalStore } from "../../packages/cli/src/upgrade/bundle/approve.js";
import { approveEnterpriseBundle, type ApproveEnterpriseInput } from "../../packages/cli/src/upgrade/bundle/approve-enterprise.js";
import { buildAtApproval } from "../../packages/cli/src/upgrade/bundle/build-at-approval.js";
import { testRunner } from "./kit-runner.js";
import { verifyBundle, type VerifiedBundle } from "../../packages/cli/src/upgrade/bundle/verify.js";
import type { EnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { builtBundle, type BuiltBundle } from "./bundle-fixture.js";
import { SETTINGS } from "./doctor-fakes.js";
import { World, T0 } from "./deployer-world.js";
import { MemoryParameterStore } from "./memory-parameter-store.js";
import type { FakeKitOptions } from "./synth-kit-fixture.js";

export const INSTALL: EnvironmentSettings = { ...SETTINGS, env: "ent", region: "us-east-1", engine: "cdk", version: "1.2.3", identity: { ...SETTINGS.identity, mode: "cognito" }, stacks: { access: "agentx-ent-access", foundation: "agentx-ent-foundation", identity: "agentx-ent-identity", runtime: "agentx-ent-runtime", "control-plane": "agentx-ent-control-plane", slack: "agentx-ent-slack" } };

export const SETTINGS_ENT = (context: Record<string, string> = { rovaraEnterpriseEgressCidrs: "10.20.0.0/16", agentxAuditTsa: "off" }): SynthSettings => ({ schemaVersion: 1, edition: "enterprise", env: "ent", region: "us-east-1", identityMode: "cognito", context });

export class EnterpriseWorld {
  readonly store = new MemoryParameterStore();
  readonly world = new World();
  readonly puts: string[] = [];
  readonly output: string[] = [];
  bundle!: BuiltBundle;
  constructor(readonly made: BuiltBundle[]) {}

  static async create(made: BuiltBundle[], options: { kit?: FakeKitOptions | false; settings?: SynthSettings; edition?: string; version?: string; extraPackage?: boolean } = {}): Promise<EnterpriseWorld> {
    const w = new EnterpriseWorld(made);
    w.bundle = await builtBundle({ ...(options.kit === false ? {} : { kit: options.kit ?? {} }), ...(options.version === undefined ? {} : { version: options.version }), ...(options.extraPackage === true ? { extraPackage: true } : {}) });
    made.push(w.bundle);
    const settings = options.settings ?? SETTINGS_ENT();
    await w.setSettings(settings);
    await w.setEdition(options.edition ?? "enterprise");
    w.world.seed({ key: w.bundle.key.publicKeyPem });
    return w;
  }

  async setSettings(settings: SynthSettings | string): Promise<void> {
    const text = typeof settings === "string" ? settings : JSON.stringify(settings);
    await this.store.put(synthSettingsParameter("ent"), text);
    this.world.params.set(synthSettingsParameter("ent"), text);
  }
  async setEdition(edition: string): Promise<void> {
    await this.store.put(editionRecordParameter("ent"), edition);
    this.world.params.set(editionRecordParameter("ent"), edition);
  }

  verify(): Promise<VerifiedBundle> {
    return verifyBundle({ dir: this.bundle.dir, trustedKeys: [this.bundle.key.publicKeyPem], approvedBundleSha256: this.bundle.bundleSha256 });
  }

  /** Makes the deployed stacks what an install that was built from the same bundle would have: the access stack exactly, the others older. */
  async deployAsBuilt(settings: SynthSettings = SETTINGS_ENT()): Promise<void> {
    const verified = await this.verify();
    try {
      const built = await buildAtApproval({ bundle: verified, settings, runner: testRunner });
      for (const part of ["access", "foundation", "identity", "runtime", "control-plane", "slack"] as const) {
        const file = built.files.find((entry) => entry.file === `built/templates/${part}.template.json`)?.body.toString("utf8");
        const stack = this.world.stacks.get(environmentStackName("ent", part))!;
        this.world.stacks.set(environmentStackName("ent", part), { ...stack, template: part === "access" ? file : JSON.stringify({ Resources: { Old: { Type: "AWS::SSM::Parameter", Properties: { Type: "String", Value: "x" } } } }) } as typeof stack);
      }
    } finally {
      await verified.cleanup();
    }
  }

  approvalStore(): ApprovalStore {
    return { put: async (key, body) => { this.puts.push(key); return { versionId: this.world.putObject(key, body) }; }, remove: async (key) => { this.world.deleteObject(key); } };
  }

  async approve(overrides: Partial<ApproveEnterpriseInput> = {}): Promise<{ record: ApprovalRecord }> {
    const verified = await this.verify();
    try {
      const { record } = await approveEnterpriseBundle({
        bundle: verified, install: INSTALL, store: this.store, runner: testRunner, approvalStore: this.approvalStore(),
        readDeployedTemplate: async (stackName) => this.world.stacks.get(stackName)?.template,
        approvedBy: "arn:aws:sts::123456789012:assumed-role/security/alice", parameters: {}, rollback: false, now: () => T0, yes: true, interactive: false,
        ask: async () => "y", write: (line) => this.output.push(line), ...overrides,
      });
      return { record };
    } finally {
      await verified.cleanup();
    }
  }
}

