// Convergence lane A4: a world for Cloud's EC2 machines adapter with no AWS. The real SessionManager over the fake table; the provisioner and deleter
// state machines played by timers (each runs the same session steps the real machines call: recordVolume, recordInstance, markReady, markDeleted);
// fake EC2 instances; and a worker per instance that checks each invoke token with the worker's own verifier, against a P-256 key standing in for KMS.
import { generateKeyPairSync, randomUUID, sign as signBytes } from "node:crypto";
import { AGENTX_PROTOCOL_VERSION, WorkerInvocationSchema, type Ec2RuntimeBinding, type OrgId, type WorkerInvocation } from "@rovara-code/contracts";
import { SessionManager, type ProvisioningInput, type DeletionInput } from "../../packages/broker/src/aws/sessions.js";
import { SessionWorkerMachines, type SessionWorkerMachinesDependencies, type SessionWorkerPing } from "../../packages/broker/src/aws/worker-machines/session-worker-machines.js";
import { workspaceCompanyReader } from "../../packages/broker/src/aws/worker-machines/workspace-company.js";
import { invocationMatchesClaims, verifyInvokeAuthorization } from "../../packages/worker/src/invoke-auth.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";

export const COMPANY_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
export const COMPANY_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
/** The install's single org: a Cloud workspace record without an org belongs to it. */
export const INSTALL_ORG = COMPANY_A;
export const TABLE = "state";
export const PROVISIONER_ARN = "arn:aws:states:us-west-2:111122223333:stateMachine:provisioner";
export const DELETER_ARN = "arn:aws:states:us-west-2:111122223333:stateMachine:deleter";
export const WORKER_FEATURES = ["task.workflowMode", "task.structuredPlans"];

export const BINDING: Ec2RuntimeBinding = {
  deploymentMode: "ec2-ebs",
  launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }],
  volumeSizeGiB: 20,
  volumeType: "gp3",
};

interface Instance {
  instanceId: string;
  privateIp: string;
  workspaceId: string;
  generation: number;
  running: boolean;
  accepted: Set<string>;
  active: Set<string>;
}

export interface Execution {
  stateMachineArn: string;
  name: string;
  input: ProvisioningInput | DeletionInput;
}

export interface SessionMachinesWorld {
  db: FakeDynamoDb;
  sessions: SessionManager;
  executions: Execution[];
  instances: Map<string, Instance>;
  /** Every request a worker answered, with its HTTP status. */
  posts: Array<{ url: string; status: number; workspaceId?: string; operationId?: string }>;
  publicKey: string;
  /** A workspace record for a company (`orgId` as Cloud writes it, or `companyId` as the core writes it). */
  workspace(company: OrgId | undefined, form?: "cloud" | "core"): string;
  machinesFor(company: OrgId, overrides?: Partial<SessionWorkerMachinesDependencies>): SessionWorkerMachines;
  /** Waits for the state machines started so far to finish. */
  settle(): Promise<void>;
  /** The machine-side signer, as the dispatcher's KMS Sign would answer. */
  sign(message: Uint8Array): Promise<Uint8Array>;
  /** What the worker does when it ends a job (its terminal callback). */
  finish(instanceId: string, operationId: string): void;
  provisionerHolds: boolean;
}

export function invocationFor(workspaceId: string, operationId: string = randomUUID(), kind: "task" | "publish" = "task"): WorkerInvocation {
  return WorkerInvocationSchema.parse({
    protocolVersion: AGENTX_PROTOCOL_VERSION, operationId, workspaceId, fence: 1, projectRevision: 1, callbackCapability: "c".repeat(48),
    kind, payload: kind === "task" ? { conversationId: randomUUID(), prompt: "make the change" } : {},
  });
}

export function createSessionMachinesWorld(options: { startedAt?: number } = {}): SessionMachinesWorld {
  const db = new FakeDynamoDb();
  const executions: Execution[] = [];
  const instances = new Map<string, Instance>();
  const pending: Array<Promise<void>> = [];
  const posts: SessionMachinesWorld["posts"] = [];
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyText = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const clock = options.startedAt ?? Date.parse("2026-11-12T10:00:00.000Z");
  let ipCounter = 10;

  const sessions = new SessionManager({
    documentClient: db,
    tableName: TABLE,
    now: () => new Date(clock),
    chooseSubnet: (subnets) => subnets[0]!,
    executions: {
      provisionerArn: PROVISIONER_ARN,
      deleterArn: DELETER_ARN,
      async start(execution) {
        // Step Functions keeps one execution per name: a second start with the name of a running or finished one is refused (the session manager reads that as started).
        if (executions.some((started) => started.stateMachineArn === execution.stateMachineArn && started.name === execution.name)) {
          throw Object.assign(new Error("Execution Already Exists"), { name: "ExecutionAlreadyExists" });
        }
        const input = JSON.parse(execution.input) as ProvisioningInput | DeletionInput;
        executions.push({ stateMachineArn: execution.stateMachineArn, name: execution.name, input });
        const run = execution.stateMachineArn === PROVISIONER_ARN ? () => provision(input as ProvisioningInput) : () => remove(input as DeletionInput);
        pending.push(new Promise<void>((resolve, reject) => setTimeout(() => { run().then(resolve, reject); }, 0)));
        return `${execution.stateMachineArn.replace(":stateMachine:", ":execution:")}:${execution.name}`;
      },
    },
  });

  // The provisioner: a volume when there is none, an instance from the launch template, then READY once the worker answers.
  async function provision(input: ProvisioningInput): Promise<void> {
    while (world.provisionerHolds) await new Promise((resolve) => setTimeout(resolve, 1));
    const volumeId = input.volumeId ?? `vol-${randomUUID().replace(/-/g, "").slice(0, 17)}`;
    if (input.volumeId === null) await sessions.markVolume(input.workspaceId, input.generation, volumeId);
    const instanceId = `i-${randomUUID().replace(/-/g, "").slice(0, 17)}`;
    const privateIp = `10.42.0.${ipCounter++}`;
    instances.set(instanceId, { instanceId, privateIp, workspaceId: input.workspaceId, generation: input.generation, running: true, accepted: new Set(), active: new Set() });
    await sessions.markInstance(input.workspaceId, input.generation, instanceId, privateIp, "m7g.large");
    await sessions.markReady(input.workspaceId, input.generation, WORKER_FEATURES);
  }

  // The deleter: the instance, then the volume, then DELETED.
  async function remove(input: DeletionInput): Promise<void> {
    if (input.instanceId !== null) {
      const instance = instances.get(input.instanceId);
      if (instance !== undefined) instance.running = false;
    }
    await sessions.markDeleted(input.workspaceId);
  }

  const instanceAt = (url: string): Instance | undefined => {
    const host = new URL(url).hostname;
    return [...instances.values()].find((instance) => instance.privateIp === host && instance.running);
  };

  const ping = async (url: string): Promise<SessionWorkerPing | undefined> => {
    const instance = instanceAt(url);
    if (instance === undefined) throw new Error("connect ECONNREFUSED");
    return { status: instance.active.size === 0 ? "Healthy" : "HealthyBusy", activeOperations: instance.active.size, features: WORKER_FEATURES };
  };

  const post = async (url: string, init: { authorization: string; body: string }): Promise<{ status: number; body: string }> => {
    const instance = instanceAt(url);
    if (instance === undefined) throw new Error("connect ECONNREFUSED");
    const answer = (status: number, body: Record<string, unknown>, invocation?: WorkerInvocation) => {
      posts.push({ url, status, ...(invocation === undefined ? {} : { workspaceId: invocation.workspaceId, operationId: invocation.operationId }) });
      return { status, body: JSON.stringify(body) };
    };
    // The worker's own checks (packages/worker/src/server.ts): the token first, then the body against the token's claims.
    const verified = verifyInvokeAuthorization(init.authorization, { publicKey, workspaceId: instance.workspaceId, generation: instance.generation, now: () => Math.floor(clock / 1_000) });
    if (!verified.ok) return answer(401, { error: verified.reason });
    const invocation = WorkerInvocationSchema.parse(JSON.parse(init.body));
    if (!invocationMatchesClaims(invocation as never, verified.claims)) return answer(401, { error: "invocation_mismatch" }, invocation);
    if (invocation.kind === "steer" || invocation.kind === "peek") return answer(200, { accepted: true, outcome: invocation.kind === "steer" ? "steered" : "unavailable" }, invocation);
    const duplicate = instance.accepted.has(invocation.operationId);
    if (!duplicate) {
      instance.accepted.add(invocation.operationId);
      instance.active.add(invocation.operationId);
    }
    return answer(200, { accepted: true, operationId: invocation.operationId, status: "ACCEPTED", duplicate }, invocation);
  };

  const sign = async (message: Uint8Array) => new Uint8Array(signBytes("sha256", message, { key: privateKey, dsaEncoding: "der" }));

  const world: SessionMachinesWorld = {
    db, sessions, executions, instances, posts, publicKey: publicKeyText, provisionerHolds: false, sign,
    workspace(company, form = "cloud") {
      const workspaceId = randomUUID();
      db.set({
        pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", deploymentMode: "ec2-ebs", status: "READY", fence: 1,
        ...(company === undefined ? {} : form === "core" ? { companyId: company } : { orgId: company }),
      });
      return workspaceId;
    },
    machinesFor(company, overrides = {}) {
      return new SessionWorkerMachines({
        companyId: company,
        sessions,
        companyOfWorkspace: workspaceCompanyReader(db, TABLE, INSTALL_ORG),
        binding: async () => BINDING,
        async stopInstance(instanceId) {
          const instance = instances.get(instanceId);
          if (instance !== undefined) instance.running = false;
          return { gone: true };
        },
        sign,
        post,
        ping,
        now: () => clock,
        ...overrides,
      });
    },
    async settle() {
      while (pending.length > 0) await pending.shift();
    },
    finish(instanceId, operationId) {
      instances.get(instanceId)?.active.delete(operationId);
    },
  };
  return world;
}
