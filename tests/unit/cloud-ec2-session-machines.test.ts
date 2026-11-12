// Convergence lane A4 (cloud/ec2-machines): Cloud's EC2 machines adapter. Code's conformance suite runs against it in tests/conformance/; this file holds
// what that suite cannot see: one company's machines are never another's, the adapter launches exactly as the dispatcher does today (the same provisioner
// input, the same invoke token, and nothing a spec could add), and start, stop and end are idempotent and leave nothing running.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MachineError, type OrgId, type WorkerInvocation } from "@rovara-code/contracts";
import { createEc2Delivery } from "../../packages/broker/src/aws/ec2-delivery.js";
import { SESSION_MAX_INVOCATION_BYTES, sessionMachineId } from "../../packages/broker/src/aws/worker-machines/session-worker-machines.js";
import { workspaceCompanyReader } from "../../packages/broker/src/aws/worker-machines/workspace-company.js";
import { BINDING, COMPANY_A, COMPANY_B, DELETER_ARN, INSTALL_ORG, PROVISIONER_ARN, TABLE, createSessionMachinesWorld, invocationFor } from "../support/session-machines-world.js";

async function readyMachine(world: ReturnType<typeof createSessionMachinesWorld>, company: OrgId = COMPANY_A) {
  const workspaceId = world.workspace(company);
  const machines = world.machinesFor(company);
  const handle = await machines.start({ machineKey: workspaceId, companyId: company });
  await world.settle();
  expect((await machines.health(handle.machineId)).state).toBe("ready");
  return { workspaceId, machines, handle };
}

const sessionOf = (world: ReturnType<typeof createSessionMachinesWorld>, workspaceId: string) => world.db.get(`WORKSPACE#${workspaceId}`, "SESSION");

describe("EC2 machines: one company's machines are never another's", () => {
  it("does not start, stop, end, report on or hand a job to another company's machine, and says nothing that tells it from a missing one", async () => {
    const world = createSessionMachinesWorld();
    const { workspaceId, handle } = await readyMachine(world, COMPANY_A);
    const instance = [...world.instances.values()][0]!;
    const other = world.machinesFor(COMPANY_B);
    const missing = sessionMachineId(randomUUID());

    // Positive control: company A's own adapter reaches the machine (so the refusals below are the company check, not a broken world).
    expect((await world.machinesFor(COMPANY_A).health(handle.machineId)).state).toBe("ready");

    await expect(other.start({ machineKey: workspaceId, companyId: COMPANY_B })).rejects.toMatchObject({ code: "rejected", message: "no such workspace for this company" });
    await expect(other.start({ machineKey: randomUUID(), companyId: COMPANY_B })).rejects.toMatchObject({ code: "rejected", message: "no such workspace for this company" });
    // A spec naming another company than the adapter's is refused before anything is read.
    await expect(other.start({ machineKey: workspaceId, companyId: COMPANY_A })).rejects.toMatchObject({ code: "rejected", message: "this machine adapter serves another company" });
    expect(await other.health(handle.machineId)).toEqual(await other.health(missing));
    expect((await other.health(handle.machineId)).state).toBe("terminated");
    await other.stop(handle.machineId);
    await other.terminate(handle.machineId);
    const refusal = await other.deliver(handle.machineId, invocationFor(workspaceId)).catch((error: unknown) => error);
    const missingRefusal = await other.deliver(missing, invocationFor(workspaceId)).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(MachineError);
    expect(refusal).toMatchObject({ code: "not_found", message: (missingRefusal as MachineError).message });
    await world.settle();

    // Nothing moved: one provisioner run, no deleter, the instance still runs, the session is still READY, the worker was sent nothing.
    expect(world.executions.map((execution) => execution.stateMachineArn)).toEqual([PROVISIONER_ARN]);
    expect(instance.running).toBe(true);
    expect(sessionOf(world, workspaceId)).toMatchObject({ state: "READY" });
    expect(world.posts).toEqual([]);
  });

  it("reads the company from the workspace record on every call: the core's companyId, Cloud's orgId, or the install's org for a record that names none", async () => {
    const world = createSessionMachinesWorld();
    const read = workspaceCompanyReader(world.db, TABLE, INSTALL_ORG);
    expect(await read(world.workspace(COMPANY_B, "core"))).toBe(COMPANY_B);
    expect(await read(world.workspace(COMPANY_B, "cloud"))).toBe(COMPANY_B);
    expect(await read(world.workspace(undefined))).toBe(INSTALL_ORG);
    expect(await read(randomUUID())).toBeUndefined();
    // A core record whose companyId is not a company id is nobody's (never the install's).
    const damaged = world.workspace(COMPANY_B, "core");
    world.db.set({ ...world.db.get(`WORKSPACE#${damaged}`, "META")!, companyId: "org_A" });
    expect(await read(damaged)).toBeUndefined();

    // A workspace that moves to another company stops being reachable through the first company's adapter at once (nothing is cached).
    const { workspaceId, machines, handle } = await readyMachine(world, COMPANY_A);
    world.db.set({ ...world.db.get(`WORKSPACE#${workspaceId}`, "META")!, orgId: COMPANY_B });
    expect((await machines.health(handle.machineId)).state).toBe("terminated");
    expect((await world.machinesFor(COMPANY_B).health(handle.machineId)).state).toBe("ready");
  });

  it("keeps two companies' machines apart when both use the adapter at once", async () => {
    const world = createSessionMachinesWorld();
    const a = await readyMachine(world, COMPANY_A);
    const b = await readyMachine(world, COMPANY_B);
    expect(a.handle.machineId).not.toBe(b.handle.machineId);
    await a.machines.terminate(b.handle.machineId);
    await b.machines.terminate(a.handle.machineId);
    await world.settle();
    expect((await a.machines.health(a.handle.machineId)).state).toBe("ready");
    expect((await b.machines.health(b.handle.machineId)).state).toBe("ready");
  });
});

describe("EC2 machines: no new worker power (decision 65)", () => {
  it("starts compute exactly as the dispatcher does today: the same provisioner, the same input, the same execution name, and nothing else", async () => {
    // Today's path: the dispatcher's ec2 delivery asks the session manager for the workspace's session.
    const today = createSessionMachinesWorld();
    const todayWorkspace = today.workspace(COMPANY_A);
    const deliver = createEc2Delivery({
      sessions: today.sessions, binding: async () => BINDING, sign: (message) => today.sign(message), post: async () => ({ status: 200, body: "{}" }), progress: async () => undefined,
      applicationPlanNotNegotiated: async () => undefined, planQualityNotNegotiated: async () => undefined, setupRecipesNotNegotiated: async () => undefined,
    });
    const invocation = invocationFor(todayWorkspace);
    expect(await deliver({ id: randomUUID(), workspaceId: todayWorkspace, operationId: invocation.operationId, deploymentMode: "ec2-ebs", invocation } as never, invocation as never)).toBe("WAITING_FOR_SESSION");

    // The adapter, for a workspace with the same binding.
    const adapter = createSessionMachinesWorld();
    const adapterWorkspace = adapter.workspace(COMPANY_A);
    await adapter.machinesFor(COMPANY_A).start({ machineKey: adapterWorkspace, companyId: COMPANY_A, projectName: "payments", labels: { workspaceId: adapterWorkspace } });

    const strip = (execution: (typeof today.executions)[number], workspaceId: string) => JSON.parse(JSON.stringify(execution).replaceAll(workspaceId, "<workspace>")) as unknown;
    expect(adapter.executions).toHaveLength(1);
    expect(today.executions).toHaveLength(1);
    expect(strip(adapter.executions[0]!, adapterWorkspace)).toEqual(strip(today.executions[0]!, todayWorkspace));
    expect(adapter.executions[0]).toMatchObject({ stateMachineArn: PROVISIONER_ARN, input: { launchTemplateId: BINDING.launchTemplateId, subnetId: BINDING.subnets[0]!.subnetId, volumeId: null } });
    // The provisioner's input has no field a spec could set: no image, user data, instance profile, network or metadata setting.
    expect(Object.keys(adapter.executions[0]!.input).sort()).toEqual(["availabilityZone", "generation", "launchTemplateId", "subnetId", "volumeId", "volumeSizeGiB", "volumeType", "workspaceId"]);
  });

  it("refuses a spec that asks for an image, sizes or an environment, before any compute starts", async () => {
    const world = createSessionMachinesWorld();
    const machines = world.machinesFor(COMPANY_A);
    for (const extra of [{ image: "ami-0123456789abcdef0" }, { resources: { cpu: 64 } }, { environment: { AGENTX_INVOKE_PUBLIC_KEY: "x" } }]) {
      await expect(machines.start({ machineKey: world.workspace(COMPANY_A), companyId: COMPANY_A, ...extra })).rejects.toMatchObject({ code: "rejected" });
    }
    // An empty environment is no request at all.
    await machines.start({ machineKey: world.workspace(COMPANY_A), companyId: COMPANY_A, environment: {} });
    expect(world.executions).toHaveLength(1);
  });

  it("signs the token today's dispatcher signs for the same job and session: the worker's own verifier accepts it, for this workspace and generation only", async () => {
    const world = createSessionMachinesWorld();
    const { workspaceId, machines, handle } = await readyMachine(world);
    const invocation = invocationFor(workspaceId);
    const signed: string[] = [];
    const recording = world.machinesFor(COMPANY_A, { sign: async (message) => { signed.push(Buffer.from(message).toString("ascii")); return world.sign(message); } });
    expect(await recording.deliver(handle.machineId, invocation)).toEqual({ duplicate: false });
    expect(world.posts.at(-1)).toMatchObject({ status: 200, operationId: invocation.operationId });

    // Today's path for the same job and the same READY session.
    const todaySigned: string[] = [];
    const deliver = createEc2Delivery({
      sessions: world.sessions, binding: async () => BINDING, sign: async (message) => { todaySigned.push(Buffer.from(message).toString("ascii")); return world.sign(message); },
      post: async () => ({ status: 200, body: "{}" }), progress: async () => undefined, now: () => Date.parse("2026-11-12T10:00:00.000Z"),
      applicationPlanNotNegotiated: async () => undefined, planQualityNotNegotiated: async () => undefined, setupRecipesNotNegotiated: async () => undefined,
    });
    expect(await deliver({ id: randomUUID(), workspaceId, operationId: invocation.operationId, deploymentMode: "ec2-ebs", invocation } as never, invocation as never)).toBe("DELIVERED");
    expect(signed).toEqual(todaySigned);
    expect(JSON.parse(Buffer.from(signed[0]!, "base64url").toString("utf8"))).toEqual({
      workspaceId, generation: 1, operationId: invocation.operationId, fence: 1, expiresAt: Math.floor(Date.parse("2026-11-12T10:00:00.000Z") / 1_000) + 60, purpose: "WORKSPACE",
    });
    void machines;
  });

  it("never sends project setup through a workspace's machine, nor a job for another workspace, nor one larger than a worker reads", async () => {
    const world = createSessionMachinesWorld();
    const { workspaceId, machines, handle } = await readyMachine(world);
    const setup = { ...invocationFor(workspaceId), kind: "project-setup-smoke", payload: { setupExecutionId: randomUUID(), subjectId: randomUUID(), approvalRevision: 1, transportCorrelationId: workspaceId } } as unknown as WorkerInvocation;
    await expect(machines.deliver(handle.machineId, setup)).rejects.toMatchObject({ code: "rejected" });
    await expect(machines.deliver(handle.machineId, invocationFor(randomUUID()))).rejects.toMatchObject({ code: "rejected" });
    const large = invocationFor(workspaceId);
    (large.payload as { prompt: string }).prompt = "x".repeat(SESSION_MAX_INVOCATION_BYTES);
    await expect(machines.deliver(handle.machineId, large)).rejects.toMatchObject({ code: "rejected" });
    expect(world.posts).toEqual([]);
  });
});

describe("EC2 machines: idempotent, and nothing left running", () => {
  it("starts one provisioning however often it is asked, and hands one job to the worker once per operation", async () => {
    const world = createSessionMachinesWorld();
    world.provisionerHolds = true;
    const workspaceId = world.workspace(COMPANY_A);
    const machines = world.machinesFor(COMPANY_A);
    const handles = await Promise.all([1, 2, 3].map(() => machines.start({ machineKey: workspaceId, companyId: COMPANY_A })));
    expect(new Set(handles.map((handle) => handle.machineId)).size).toBe(1);
    expect(handles.every((handle) => handle.state === "starting")).toBe(true);
    // A job for a machine still starting waits (it is retried), and nothing is signed or sent.
    await expect(machines.deliver(handles[0]!.machineId, invocationFor(workspaceId))).rejects.toMatchObject({ code: "not_ready", retryable: true });
    world.provisionerHolds = false;
    await world.settle();
    expect(world.executions.filter((execution) => execution.stateMachineArn === PROVISIONER_ARN)).toHaveLength(1);
    expect(world.instances.size).toBe(1);
    const job = invocationFor(workspaceId);
    expect(await machines.deliver(handles[0]!.machineId, job)).toEqual({ duplicate: false });
    expect(await machines.deliver(handles[0]!.machineId, job)).toEqual({ duplicate: true });
    expect([...world.instances.values()][0]!.accepted.size).toBe(1);
  });

  it("stops by ending the instance and keeping the volume, as often as asked; starting again wakes the same machine on the same volume", async () => {
    const world = createSessionMachinesWorld();
    const { workspaceId, machines, handle } = await readyMachine(world);
    const first = [...world.instances.values()][0]!;
    const volumeId = (sessionOf(world, workspaceId) as { volumeId: string }).volumeId;
    await machines.stop(handle.machineId);
    await machines.stop(handle.machineId);
    expect(first.running).toBe(false);
    expect((await machines.health(handle.machineId)).state).toBe("stopped");
    const woken = await machines.start({ machineKey: workspaceId, companyId: COMPANY_A });
    expect(woken.machineId).toBe(handle.machineId);
    await world.settle();
    expect(world.executions.filter((execution) => execution.stateMachineArn === PROVISIONER_ARN).map((execution) => (execution.input as { volumeId: string | null }).volumeId)).toEqual([null, volumeId]);
    expect((await machines.health(handle.machineId)).state).toBe("ready");
  });

  it("does not stop a machine that runs an operation, and does not end one while it is starting: both are retried, and nothing is orphaned", async () => {
    const world = createSessionMachinesWorld();
    const { workspaceId, machines, handle } = await readyMachine(world);
    world.db.set({ ...world.db.get(`WORKSPACE#${workspaceId}`, "META")!, activeOperationId: randomUUID() });
    await expect(machines.stop(handle.machineId)).rejects.toMatchObject({ code: "unavailable", retryable: true });
    expect([...world.instances.values()][0]!.running).toBe(true);

    const starting = world.workspace(COMPANY_A);
    world.provisionerHolds = true;
    const pending = await machines.start({ machineKey: starting, companyId: COMPANY_A });
    await expect(machines.terminate(pending.machineId)).rejects.toMatchObject({ code: "unavailable", retryable: true });
    world.provisionerHolds = false;
    await world.settle();
    // Once it is up, the end goes through: the deleter ends the instance and the volume, and a second end changes nothing.
    await machines.terminate(pending.machineId);
    await machines.terminate(pending.machineId);
    await world.settle();
    expect(world.executions.filter((execution) => execution.stateMachineArn === DELETER_ARN)).toHaveLength(1);
    expect((await machines.health(pending.machineId)).state).toBe("terminated");
    expect([...world.instances.values()].filter((instance) => instance.workspaceId === starting && instance.running)).toEqual([]);
    await expect(machines.start({ machineKey: starting, companyId: COMPANY_A })).rejects.toMatchObject({ code: "not_found" });
  });

  it("answers a worker's refusals in the port's words, and an unreachable worker as one to retry", async () => {
    const world = createSessionMachinesWorld();
    const { workspaceId, handle } = await readyMachine(world);
    const answering = (status: number) => world.machinesFor(COMPANY_A, { post: async () => ({ status, body: "{}" }) });
    await expect(answering(401).deliver(handle.machineId, invocationFor(workspaceId))).rejects.toMatchObject({ code: "unauthorized" });
    for (const status of [400, 409, 413]) await expect(answering(status).deliver(handle.machineId, invocationFor(workspaceId))).rejects.toMatchObject({ code: "rejected" });
    await expect(answering(503).deliver(handle.machineId, invocationFor(workspaceId))).rejects.toMatchObject({ code: "unavailable", retryable: true });
    await expect(world.machinesFor(COMPANY_A, { post: async () => { throw new Error("connect ETIMEDOUT 10.42.0.10:8080"); } }).deliver(handle.machineId, invocationFor(workspaceId)))
      .rejects.toMatchObject({ code: "unavailable", message: "the worker could not be reached" });
    // A worker that stops answering /ping is unhealthy (the core waits), never ready.
    expect((await world.machinesFor(COMPANY_A, { ping: async () => undefined }).health(handle.machineId)).state).toBe("unhealthy");
  });
});
