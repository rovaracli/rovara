// The parity suite's CORE engine context: Rovara Code's core with the composition root's Cloud adapter modules (tests/support/cloud-core-fakes.ts), driven
// against a fake worker. Step drivers (core-drivers/*.ts) act on this context; the engine (core.ts) only runs them in order.
//
// Which composition: Code's core services beyond the task flow (callbacks, the decision gate and pages, merge tracking, evidence) are joined today by
// Code's own LOCAL composition (`startLocalRuntime`); Cloud's root (packages/broker/src/cloud/app) joins the flow and leaves the rest as seams (open
// question S0-Q1). So this engine runs the core through Code's local composition, with the SAME Cloud adapter modules registered over its defaults
// (storage wrapped with Cloud's retention rule, as the root does).
//
// The worker is scripted per step, as Code's own tests do (local-up-flow.test.ts): each job the core dispatches is answered through the REAL callback
// listener with the capability the flow issued. The clock is the process clock plus an offset a driver moves (decision timeouts, tracking polls).
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalRuntime, type LocalRuntime } from "@rovara-code/broker/local";
import { FakeChannelAdapter, localOwnerPrincipal } from "@rovara-code/broker/ports";
import { writeNotifyPrefs } from "@rovara-code/broker/core/notify";
import { developerIdOf } from "@rovara-code/broker/core/sessions";
import { IMPLICIT_COMPANY_ID, UNDERSTAND_ARTIFACT_NAME, type AdapterRegistry, type DocumentStore, type TransactItem, type WorkerInvocation } from "@rovara-code/contracts";
import { cloudRetentionStore } from "../../../packages/broker/src/cloud/app/retention.js";
import { createFakeWorld, type FakeWorld, type FakeWorldOptions } from "../../support/cloud-core-fakes.js";
import { planAnswer, planDocument } from "../../support/plan-documents.js";
import { keyFamily } from "../harness/normalize.js";
import type { PlanSpec, Scenario } from "../harness/types.js";

export const planTextOf = (plan: PlanSpec): string =>
  planAnswer(
    planDocument({ title: plan.title, why: [{ text: "Asked for in the parity scenario.", author: "Maya" }], claims: plan.claims.map((text, index) => ({ id: String(index + 1), text })), decisions: [] }),
    plan.testStatement === false ? {} : { checks: { checks: [], none_reason: "The project's own check (node --version) covers this change." } },
  );

/**
 * The worker's check report for the project's one check (node --version, the same check Cloud's journey project has). Cloud's journey worker runs the check
 * once after the change and has no "before" run, so a failure is `failing_no_before`, and the worker's own `reportStatus` makes that report `verified`
 * (only a regression of a check that passed before makes it `regression`). The core gets exactly that.
 */
export const checkReport = (outcome: "passed" | "failed", extraTry: "not_needed" | "given" = "not_needed") => ({
  status: "verified", source: "project", preambleVersion: "1", preambleSha256: "a".repeat(64), extraTry, agentClaim: "none",
  checks: [{ id: "readiness:0", label: "node --version", source: "project", before: "not_run", after: outcome, class: outcome === "passed" ? "passing" : "failing_no_before", output: outcome === "passed" ? "" : "1 failing", durationMs: 5, exitCode: outcome === "passed" ? 0 : 1 }],
});

export interface Recorder {
  states: string[];
  decisions: string[];
  keys: Set<string>;
  /** The attention kinds the core queued for a person, in order: one per NEW pending row (`NOTIFY_PENDING`; a rewrite of a row still waiting is the same notice). */
  notices: string[];
}

/** `STAGE/STATE`, with the block reason when blocked (a blocked task is the most telling difference). */
export function stateWord(workflow: { stage?: string; state?: string; blockReason?: string }): string {
  return `${String(workflow.stage)}/${String(workflow.state)}${workflow.state === "BLOCKED" && workflow.blockReason !== undefined ? `(${workflow.blockReason})` : ""}`;
}

/** The store as the root wraps it, plus a recorder of every task state and every key written (the engine's own observation, not a behaviour). */
function recordingStore(inner: DocumentStore, recorder: Recorder): DocumentStore {
  const wrapped = cloudRetentionStore(inner);
  const after = async (keys: readonly { pk: string; sk: string }[]): Promise<void> => {
    for (const key of keys) {
      recorder.keys.add(keyFamily(key.pk, key.sk));
      if (key.pk.startsWith("DEVTASK#") && key.sk === "META") {
        const task = await inner.get(key);
        const workflow = task?.workflow as { stage?: string; state?: string; blockReason?: string; decisions?: Array<{ decision: string }> } | undefined;
        if (workflow?.stage !== undefined) recorder.states.push(stateWord(workflow));
        if (workflow?.decisions !== undefined) recorder.decisions.splice(0, recorder.decisions.length, ...workflow.decisions.map((decision) => decision.decision));
      }
    }
  };
  const keyOf = (item: TransactItem) => (item.kind === "put" ? { pk: item.item.pk, sk: item.item.sk } : item.key);
  return {
    get indexes() { return wrapped.indexes; },
    ...(wrapped.ttlAttribute === undefined ? {} : { ttlAttribute: wrapped.ttlAttribute }),
    ...(wrapped.changes === undefined ? {} : { changes: wrapped.changes }),
    get: (key) => wrapped.get(key),
    getMany: (keys) => wrapped.getMany(keys),
    query: (request) => wrapped.query(request),
    queryIndex: (request) => wrapped.queryIndex(request),
    async put(request) {
      // A notice queued for a person: counted once per new pending row (the messages facet, facets-support/messages.ts).
      const notice = request.item.entityType === "NOTIFY_PENDING" && (await inner.get(request.item)) === undefined ? request.item.kind : undefined;
      const result = await wrapped.put(request);
      if (result.applied) {
        await after([request.item]);
        if (typeof notice === "string") recorder.notices.push(notice);
      }
      return result;
    },
    async update(request) { const result = await wrapped.update(request); if (result.applied) await after([request.key]); return result; },
    async delete(request) { return await wrapped.delete(request); },
    async transact(items) { const result = await wrapped.transact(items); if (result.applied) await after(items.filter((item) => item.kind !== "check").map(keyOf)); return result; },
  };
}

export const companyOf = (task: Record<string, unknown> | undefined): string => (typeof task?.companyId === "string" ? task.companyId : typeof task?.orgId === "string" ? task.orgId : "");

/** The core gave the worker nothing to do for the next step: the task waits where it is (a real outcome, compared; not a crash). */
export class Stalled extends Error {}

export interface RawReply { status: number; headers: Record<string, string | string[] | undefined>; body: string }

/** One request with exactly the headers given (from Code's tests/support/local-pages-fakes.ts). */
export function raw(origin: string, input: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<RawReply> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: url.hostname, port: Number(url.port), method: input.method ?? "GET", path: input.path, headers: input.headers, setHost: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    outgoing.end(input.body);
  });
}

/** The hidden fields of the first form whose action ends with `suffix` (from Code's tests/support/local-pages-fakes.ts). */
export function formOf(page: string, suffix: string): { action: string; fields: Record<string, string> } {
  const decode = (text: string) => text.replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  for (const match of page.matchAll(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)) {
    const action = decode(match[1] ?? "");
    if (!action.endsWith(suffix)) continue;
    const fields: Record<string, string> = {};
    for (const input of (match[2] ?? "").matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[decode(input[1] ?? "")] = decode(input[2] ?? "");
    return { action, fields };
  }
  throw new Error(`no form ending ${suffix}`);
}

/** The channel adapter's name on the core and the conversation the owner is told in. */
export const PARITY_CHANNEL = "chat";
export const PARITY_CONVERSATION = { channel: PARITY_CHANNEL, tenant: "T0PARITY", space: "C0PARITY", thread: "1700000000.000100" } as const;

export interface CoreContext {
  scenario: Scenario;
  /** The chat adapter: what the core delivered (`channel.delivered`). */
  channel: FakeChannelAdapter;
  world: FakeWorld;
  runtime: LocalRuntime;
  store: DocumentStore;
  recorder: Recorder;
  /** The engine's clock offset from the process clock (ms); `advance` moves it. */
  clock: { offsetMs: number; now(): Date; advance(ms: number): void };
  /** Browser addresses the runtime opened (the local pages hand one over per open). */
  opened: string[];
  task: { taskId: string; workspaceId: string; base: string; commit: string; tree: string; codingJob?: WorkerInvocation; skipNext?: boolean; pending?: WorkerInvocation };
  /** What drivers saw that a facet reports (messages, extra audit or spend words). */
  extra: { messages: string[]; spend: string[]; audit: string[]; codeHost: string[] };
  api(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: Record<string, unknown> }>;
  callback(job: WorkerInvocation, action: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  /** Raw callback answer (no refusal check), for a driver that expects a refusal. */
  send(job: WorkerInvocation, action: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  nextJob(): Promise<WorkerInvocation | undefined>;
  /** The next job, or `Stalled` when the core hands none. */
  take(): Promise<WorkerInvocation>;
  modeOf(job: WorkerInvocation): string;
  candidate(): Array<{ repositoryId: string; commitSha: string; treeSha: string; baseCommitSha: string }>;
  answerPlanning(plan: PlanSpec): Promise<void>;
  decidePlan(decision: "approve" | "changes", note?: string): Promise<void>;
  sendCoding(outcome: "passed" | "failed", extraTry?: "not_needed" | "given"): Promise<void>;
  readTask(): Promise<Record<string, unknown> | undefined>;
  project: Record<string, unknown>;
}

export interface CoreContextOptions {
  world?: FakeWorldOptions;
}

export async function createCoreContext(scenario: Scenario, root: string, options: CoreContextOptions = {}): Promise<CoreContext> {
  const world = createFakeWorld(options.world);
  const recorder: Recorder = { states: [], decisions: [], keys: new Set(), notices: [] };
  // The chat the person is told in (the messages facet): Code's in-process fake channel adapter, which records what Rovara sends it.
  const channel = new FakeChannelAdapter();
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const context = world.context();
  const registerAdapters = (registry: AdapterRegistry): void => {
    for (const module of world.modules) {
      if (module.point === "worker-machines") continue; // given to the runtime as `machines`
      // The local composition signs its owner in with its own session (identity) and decides on its own pages (approvers); Cloud's people adapters
      // (A6) need Cloud's sign-in. Area 25 compares what the decisions record and who Cloud's approvers adapter accepts (core-drivers/approvals.ts).
      if (module.point === "identity" || module.point === "approvers") continue;
      let adapter = module.create(context, registry) as unknown;
      if (module.point === "storage") adapter = recordingStore(adapter as DocumentStore, recorder);
      registry.register(module.point, module.name, adapter as never);
    }
    registry.register("channel", PARITY_CHANNEL, channel);
  };
  const clock = { offsetMs: 0, now: () => new Date(Date.now() + clock.offsetMs), advance: (ms: number) => { clock.offsetMs += ms; } };
  const opened: string[] = [];
  const runtime = await startLocalRuntime({
    stateDirectory, cwd: join(root, "project"), environment: {}, gh: async () => undefined, workerImage: "worker:test", version: "9.9.9", machines: world.machines, timers: false,
    docker: { run: async () => ({ exitCode: 1, stdout: "", stderr: "docker is not available in the parity suite" }) },
    registerAdapters, openBrowser: async (url) => { opened.push(url); }, storage: "memory", now: () => clock.now(),
  });
  const token = (await readFile(runtime.sessionTokenPath, "utf8")).trim();
  // The owner is told in that chat (their notice settings name its conversation), as a Cloud member is told in Slack.
  await writeNotifyPrefs({ store: runtime.registry.require("storage"), now: () => clock.now() }, IMPLICIT_COMPANY_ID, developerIdOf(localOwnerPrincipal()), { targets: [{ channel: PARITY_CHANNEL, conversation: PARITY_CONVERSATION }], channel: "slack" });
  const store = runtime.registry.require("storage");
  const model = world.hostModel;
  const base = model.headOf("main");
  const send = (job: WorkerInvocation, action: string, body: unknown) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const text = JSON.stringify(body);
    const outgoing = httpRequest({
      host: "127.0.0.1", port: runtime.callbackPort, method: "POST", setHost: false, path: `/v1/internal/workspaces/${job.workspaceId}/operations/${job.operationId}/${action}`,
      headers: { host: `host.docker.internal:${runtime.callbackPort}`, "content-type": "application/json", "content-length": Buffer.byteLength(text), "x-agentx-callback-capability": job.callbackCapability },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown> }));
    });
    outgoing.on("error", reject);
    outgoing.end(text);
  });
  const ctx: CoreContext = {
    scenario, world, runtime, store, recorder, clock, opened, channel,
    task: { taskId: "", workspaceId: "", base, commit: base, tree: model.revision(base).tree },
    extra: { messages: [], spend: [], audit: [], codeHost: [] },
    // The project's check is the same one Cloud's journey project has (node --version), so a plan needs to propose none.
    project: { name: "payments", revision: 1, setup: [], readiness: [{ cwd: "repo/demo", executable: "node", args: ["--version"], timeoutSeconds: 30 }], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: model.url, path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] },
    async api(path, init = {}) {
      const response = await fetch(`${runtime.url}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
      const text = await response.text();
      return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown> };
    },
    send,
    async callback(job, action, body) {
      const answer = await send(job, action, body);
      // A worker that sent its result is done with the job: its machine is free for the next one (the fake machine is told, as a real one knows).
      if (action === "result") world.machines.finish(String(((await store.get({ pk: `WORKSPACE#${job.workspaceId}`, sk: "META" }))?.machine as { machineId?: string } | undefined)?.machineId), job.operationId);
      if (answer.status !== 200) throw new Error(`the core refused the ${action} callback of ${job.kind}: ${String(answer.status)} ${JSON.stringify(answer.body).slice(0, 300)}`);
      return answer;
    },
    async nextJob() {
      const seen = seenJobs;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await runtime.tick();
        const machineId = ((await store.get({ pk: `WORKSPACE#${ctx.task.workspaceId}`, sk: "META" }))?.machine as { machineId?: string } | undefined)?.machineId;
        const fresh = machineId === undefined ? undefined : world.machines.delivered(machineId).find((job) => !seen.has(job.operationId));
        if (fresh !== undefined) { seen.add(fresh.operationId); return fresh; }
      }
      return undefined;
    },
    async take() {
      const job = ctx.task.pending ?? (await ctx.nextJob());
      delete ctx.task.pending;
      if (job === undefined) {
        const task = await ctx.readTask();
        const rows = (await store.queryIndex({ index: "workflow-dispatch-due", partition: `ORG#${companyOf(task)}#WORKFLOW_DISPATCH` })).items.map((row) => ({ kind: row.kind, next: row.nextAttemptAt, attempts: row.attempts, lastError: row.lastError }));
        throw new Stalled(`the core handed the worker no job (task ${stateWord((task?.workflow ?? {}))}, dispatch rows ${JSON.stringify(rows)})`);
      }
      return job;
    },
    modeOf: (job) => (job.kind === "task" ? String((job.payload as { workflowMode?: string }).workflowMode) : job.kind),
    candidate: () => [{ repositoryId: "demo", commitSha: ctx.task.commit, treeSha: ctx.task.tree, baseCommitSha: ctx.task.base }],
    async answerPlanning(plan) {
      for (let round = 0; round < 6; round += 1) {
        const job = await ctx.nextJob();
        if (job === undefined) return;
        const mode = ctx.modeOf(job);
        if (mode === "UNDERSTAND") {
          await ctx.callback(job, "artifacts", { name: UNDERSTAND_ARTIFACT_NAME, mediaType: "application/json", content: JSON.stringify({ kind: "ready", path: "QUICK", restatement: plan.title, assumptions: [] }) });
          await ctx.callback(job, "result", { status: "SUCCEEDED" });
        } else if (mode === "PLAN") {
          await ctx.callback(job, "artifacts", { name: "plan.md", mediaType: "text/markdown", content: planTextOf(plan) });
          await ctx.callback(job, "result", { status: "SUCCEEDED" });
        } else if (mode === "PLAN_CRITIQUE") {
          await ctx.callback(job, "artifacts", { name: "plan-critique.md", mediaType: "text/markdown", content: "I read the plan.\n\n```rovara-plan-critique\n{\"verdict\":\"ok\",\"points\":[]}\n```\n" });
          await ctx.callback(job, "result", { status: "SUCCEEDED" });
        } else { ctx.task.pending = job; return; }
      }
    },
    async decidePlan(decision, note) {
      const answer = await ctx.api("/v1/local/pages/open", { method: "POST", body: { path: `/plan/${ctx.task.taskId}` } });
      if (answer.status !== 200) throw new Error(`the plan page did not open (${String(answer.status)})`);
      const once = new URL(opened.at(-1)!);
      const hop = await raw(runtime.pagesUrl, { path: once.pathname, headers: { host: once.host } });
      const link = new URL(String(hop.headers.location), runtime.pagesUrl);
      const page = await raw(runtime.pagesUrl, { path: link.pathname + link.search, headers: { host: link.host } });
      const form = formOf(page.body, "/decide");
      const posted = await raw(runtime.pagesUrl, { method: "POST", path: form.action, body: new URLSearchParams({ ...form.fields, decision, ...(note === undefined ? {} : { note }) }).toString(), headers: { host: link.host, origin: runtime.pagesUrl, "content-type": "application/x-www-form-urlencoded" } });
      const outcome = /[?&]n=([a-z_]+)/.exec(String(posted.headers.location))?.[1];
      if (outcome !== (decision === "approve" ? "approved" : "changes")) throw new Error(`the plan decision was not taken (${String(outcome)})`);
    },
    async sendCoding(outcome, extraTry = "not_needed") {
      const job = ctx.task.codingJob!;
      delete ctx.task.codingJob;
      await ctx.callback(job, "result", { status: "SUCCEEDED", result: { conversationId: "conversation", checks: checkReport(outcome, extraTry), workflowCandidateRepositories: ctx.candidate(), workflowCheckCandidateRepositories: ctx.candidate() } });
    },
    readTask: () => store.get({ pk: `DEVTASK#${ctx.task.taskId}`, sk: "META" }),
  };
  const seenJobs = new Set<string>();
  return ctx;
}

export async function coreRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "rovara-parity-core-"));
}
