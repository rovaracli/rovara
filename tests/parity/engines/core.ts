// The parity suite's CORE engine: Rovara Code's core with the composition root's Cloud adapter modules (tests/support/cloud-core-fakes.ts; the real A1-A9
// modules once train/0515-adapters is merged), driven against a fake worker.
//
// Which composition: Code's core services beyond the task flow (callbacks, the decision gate and pages, merge tracking, evidence) are joined today by
// Code's own LOCAL composition (`startLocalRuntime`); Cloud's root (packages/broker/src/cloud/app) joins the flow and leaves the rest as seams (open
// question S0-Q1). So this engine runs the core through Code's local composition, with the SAME Cloud adapter modules registered over its defaults
// (storage wrapped with Cloud's retention rule, as the root does). What it compares is the core's behaviour on Cloud's adapters; the Cloud wiring of
// those services is what S0-Q1 owes.
//
// The worker is scripted per scenario step, as Code's own tests do (local-up-flow.test.ts): each job the core dispatches is answered through the REAL
// callback listener with the capability the flow issued.
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalRuntime, type LocalRuntime } from "@rovara-code/broker/local";
import { UNDERSTAND_ARTIFACT_NAME, createCandidateManifest, type AdapterRegistry, type DocumentStore, type StoredDocument, type TransactItem, type WorkerInvocation } from "@rovara-code/contracts";
import { cloudRetentionStore } from "../../../packages/broker/src/cloud/app/retention.js";
import { createFakeWorld, type FakeWorld } from "../../support/cloud-core-fakes.js";
import { planAnswer, planDocument } from "../../support/plan-documents.js";
import { keyFamily } from "../harness/normalize.js";
import type { Facet, Observation, ParityEngine, PlanSpec, Scenario, Step, StepSupport } from "../harness/types.js";

const SUPPORTED: ReadonlySet<Step["do"]> = new Set(["start", "plan.proposed", "plan.approve", "plan.requestChanges", "coding.done", "checks", "reviews", "published", "task.stop"]);

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
const checkReport = (outcome: "passed" | "failed", extraTry: "not_needed" | "given" = "not_needed") => ({
  status: "verified", source: "project", preambleVersion: "1", preambleSha256: "a".repeat(64), extraTry, agentClaim: "none",
  checks: [{ id: "readiness:0", label: "node --version", source: "project", before: "not_run", after: outcome, class: outcome === "passed" ? "passing" : "failing_no_before", output: outcome === "passed" ? "" : "1 failing", durationMs: 5, exitCode: outcome === "passed" ? 0 : 1 }],
});

interface Recorder {
  states: string[];
  decisions: string[];
  keys: Set<string>;
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
        const unreadable = task?.planUnreadable as { errors?: string[] } | undefined;
        if (process.env.PARITY_DEBUG === "1" && unreadable !== undefined) console.log(JSON.stringify({ parity: "core.planUnreadable", errors: unreadable.errors }));
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
    async put(request) { const result = await wrapped.put(request); if (result.applied) await after([request.item]); return result; },
    async update(request) { const result = await wrapped.update(request); if (result.applied) await after([request.key]); return result; },
    async delete(request) { return await wrapped.delete(request); },
    async transact(items) { const result = await wrapped.transact(items); if (result.applied) await after(items.filter((item) => item.kind !== "check").map(keyOf)); return result; },
  };
}

const companyOf = (task: Record<string, unknown> | undefined): string => (typeof task?.companyId === "string" ? task.companyId : typeof task?.orgId === "string" ? task.orgId : "");

/** The core gave the worker nothing to do for the next step: the task waits where it is (a real outcome, compared; not a crash). */
class Stalled extends Error {}

/** `STAGE/STATE`, with the block reason when blocked (a blocked task is the most telling difference). */
export function stateWord(workflow: { stage?: string; state?: string; blockReason?: string }): string {
  return `${String(workflow.stage)}/${String(workflow.state)}${workflow.state === "BLOCKED" && workflow.blockReason !== undefined ? `(${workflow.blockReason})` : ""}`;
}

export class CoreEngine implements ParityEngine {
  readonly name = "core";
  #root: string | undefined;
  #runtime: LocalRuntime | undefined;

  supports(step: Step): StepSupport {
    if (step.do === "reviews" && step.outcome === "findings") return { unsupported: "review findings send-back not scripted yet" };
    return SUPPORTED.has(step.do) ? true : { unsupported: "no driver for this step in the core engine yet" };
  }

  observes(facet: Facet): StepSupport {
    if (facet === "messages") return { unsupported: "no channel adapter is registered: A8's Slack channel is registered only once slackSwitchReadiness passes (CHANNEL_TENANTS backfill, bind, inbound wiring)" };
    if (facet === "audit") return { unsupported: "the Cloud audit sink (A7) is not registered yet; events are recorded by a stand-in" };
    return true;
  }

  async run(scenario: Scenario): Promise<Observation> {
    const world: FakeWorld = createFakeWorld();
    const recorder: Recorder = { states: [], decisions: [], keys: new Set() };
    const root = await mkdtemp(join(tmpdir(), "rovara-parity-core-"));
    this.#root = root;
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const context = world.context();
    const registerAdapters = (registry: AdapterRegistry): void => {
      for (const module of world.modules) {
        if (module.point === "worker-machines") continue; // given to the runtime as `machines`
        // The local composition signs its owner in with its own session (identity) and decides on its own pages (approvers); Cloud's people adapters
        // (A6) need Cloud's sign-in. Area 25 is therefore compared only through what the decisions record, not through who may decide.
        if (module.point === "identity" || module.point === "approvers") continue;
        let adapter = module.create(context, registry) as unknown;
        if (module.point === "storage") adapter = recordingStore(adapter as DocumentStore, recorder);
        registry.register(module.point, module.name, adapter as never);
      }
    };
    const runtime = await startLocalRuntime({
      stateDirectory, cwd: join(root, "project"), environment: {}, gh: async () => undefined, workerImage: "worker:test", version: "9.9.9", machines: world.machines, timers: false,
      docker: { run: async () => ({ exitCode: 1, stdout: "", stderr: "docker is not available in the parity suite" }) },
      registerAdapters, openBrowser: async (url) => { opened.push(url); }, storage: "memory",
    });
    this.#runtime = runtime;
    // The composition root maps Cloud's own settings onto the core's flow options (S0-Q2): Cloud's journey install runs the Quick path with no Understand
    // step and no plan check, so the core is set the same way here. Left at Code's defaults, both show as differences (see the report).
    // Cloud's automatic fix switch (`af`) maps onto the core's autofix option, set the same way the Cloud engine sets it for a scenario with a failing check.
    if (scenario.steps.some((step) => step.do === "checks" && step.outcome === "fail")) runtime.app.flow.deps.autofix = { enabled: true, capUsd: 5, roundEstimateUsd: 1 };
    if (scenario.coreUsesCodeDefaults !== true) {
      runtime.app.flow.deps.understandFirst = false;
      runtime.app.flow.deps.planCheck = false;
    }
    const opened: string[] = [];
    const token = (await readFile(runtime.sessionTokenPath, "utf8")).trim();
    const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
      const response = await fetch(`${runtime.url}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const callback = async (job: WorkerInvocation, action: string, body: unknown) => {
      const answer = await send(job, action, body);
      // A worker that sent its result is done with the job: its machine is free for the next one (the fake machine is told, as a real one knows).
      if (action === "result") world.machines.finish(String(((await store.get({ pk: `WORKSPACE#${job.workspaceId}`, sk: "META" }))?.machine as { machineId?: string } | undefined)?.machineId), job.operationId);
      if (answer.status !== 200) throw new Error(`the core refused the ${action} callback of ${job.kind}: ${String(answer.status)} ${JSON.stringify(answer.body).slice(0, 300)}`);
      return answer;
    };
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
    const store = runtime.registry.require("storage");
    const model = world.hostModel;
    const base = model.headOf("main");
    // The project's check is the same one Cloud's journey project has (node --version), so a plan needs to propose none.
    const project = { name: "payments", revision: 1, setup: [], readiness: [{ cwd: "repo/demo", executable: "node", args: ["--version"], timeoutSeconds: 30 }], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: model.url, path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] };
    let taskId = "";
    let workspaceId = "";
    const seen = new Set<string>();
    const nextJob = async (): Promise<WorkerInvocation | undefined> => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await runtime.tick();
        const machineId = ((await store.get({ pk: `WORKSPACE#${workspaceId}`, sk: "META" }))?.machine as { machineId?: string } | undefined)?.machineId;
        const fresh = machineId === undefined ? undefined : world.machines.delivered(machineId).find((job) => !seen.has(job.operationId));
        if (fresh !== undefined) { seen.add(fresh.operationId); return fresh; }
      }
      return undefined;
    };
    const modeOf = (job: WorkerInvocation): string => (job.kind === "task" ? String((job.payload as { workflowMode?: string }).workflowMode) : job.kind);
    let pending: WorkerInvocation | undefined;
    const take = async (): Promise<WorkerInvocation> => {
      const job = pending ?? (await nextJob());
      pending = undefined;
      if (job === undefined) {
        const task = await store.get({ pk: `DEVTASK#${taskId}`, sk: "META" });
        const rows = (await store.queryIndex({ index: "workflow-dispatch-due", partition: `ORG#${companyOf(task)}#WORKFLOW_DISPATCH` })).items.map((row) => ({ kind: row.kind, next: row.nextAttemptAt, attempts: row.attempts, lastError: row.lastError }));
        throw new Stalled(`the core handed the worker no job (task ${stateWord((task?.workflow ?? {}) as never)}, dispatch rows ${JSON.stringify(rows)})`);
      }
      return job;
    };
    let commit = base;
    let tree = model.revision(base).tree;
    const candidate = () => [{ repositoryId: "demo", commitSha: commit, treeSha: tree, baseCommitSha: base }];
    /** Answers reading jobs (Understand, Plan, the plan check) until the task waits for a person. */
    const answerPlanning = async (plan: PlanSpec): Promise<void> => {
      for (let round = 0; round < 6; round += 1) {
        const job = await nextJob();
        if (job === undefined) return;
        const mode = modeOf(job);
        if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "core.job", mode }));
        if (mode === "UNDERSTAND") {
          await callback(job, "artifacts", { name: UNDERSTAND_ARTIFACT_NAME, mediaType: "application/json", content: JSON.stringify({ kind: "ready", path: "QUICK", restatement: plan.title, assumptions: [] }) });
          await callback(job, "result", { status: "SUCCEEDED" });
        } else if (mode === "PLAN") {
          await callback(job, "artifacts", { name: "plan.md", mediaType: "text/markdown", content: planTextOf(plan) });
          await callback(job, "result", { status: "SUCCEEDED" });
        } else if (mode === "PLAN_CRITIQUE") {
          await callback(job, "artifacts", { name: "plan-critique.md", mediaType: "text/markdown", content: "I read the plan.\n\n```rovara-plan-critique\n{\"verdict\":\"ok\",\"points\":[]}\n```\n" });
          await callback(job, "result", { status: "SUCCEEDED" });
        } else { pending = job; return; }
      }
    };
    const decidePlan = async (decision: "approve" | "changes", note?: string): Promise<void> => {
      const answer = await api("/v1/local/pages/open", { method: "POST", body: { path: `/plan/${taskId}` } });
      if (answer.status !== 200) throw new Error(`the plan page did not open (${String(answer.status)})`);
      const once = new URL(opened.at(-1)!);
      const hop = await raw(runtime.pagesUrl, { path: once.pathname, headers: { host: once.host } });
      const link = new URL(String(hop.headers.location), runtime.pagesUrl);
      const page = await raw(runtime.pagesUrl, { path: link.pathname + link.search, headers: { host: link.host } });
      const form = formOf(page.body, "/decide");
      const posted = await raw(runtime.pagesUrl, { method: "POST", path: form.action, body: new URLSearchParams({ ...form.fields, decision, ...(note === undefined ? {} : { note }) }).toString(), headers: { host: link.host, origin: runtime.pagesUrl, "content-type": "application/x-www-form-urlencoded" } });
      const outcome = /[?&]n=([a-z_]+)/.exec(String(posted.headers.location))?.[1];
      if (outcome !== (decision === "approve" ? "approved" : "changes")) throw new Error(`the plan decision was not taken (${String(outcome)})`);
    };

    let codingJob: WorkerInvocation | undefined;
    let skipNext = false;
    const sendCoding = async (outcome: "passed" | "failed", extraTry: "not_needed" | "given" = "not_needed"): Promise<void> => {
      const job = codingJob!;
      codingJob = undefined;
      await callback(job, "result", { status: "SUCCEEDED", result: { conversationId: "conversation", checks: checkReport(outcome, extraTry), workflowCandidateRepositories: candidate(), workflowCheckCandidateRepositories: candidate() } });
    };
    const runStep = async (step: Step, next: Step | undefined): Promise<void> => {
      switch (step.do) {
        case "start": {
          await api("/v1/admin/projects", { method: "POST", body: project });
          const started = await api("/v1/dev/tasks", { method: "POST", body: { requestId: "11111111-1111-4111-8111-111111111111", project: "payments", instructions: step.request, workflow: true, ...(step.path === undefined ? {} : { workflowPath: step.path }) } });
          if (started.status !== 201) throw new Error(`the core refused the start: ${JSON.stringify(started.body).slice(0, 200)}`);
          taskId = (started.body.task as { taskId: string }).taskId;
          const record = await store.get({ pk: `DEVTASK#${taskId}`, sk: "META" });
          workspaceId = typeof record?.workspaceId === "string" ? record.workspaceId : "";
          const prepare = await take();
          await callback(prepare, "result", { status: "SUCCEEDED", result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: base }] } });
          return;
        }
        case "plan.proposed": return await answerPlanning(step.plan);
        case "plan.approve": return await decidePlan("approve");
        case "plan.requestChanges":
          await decidePlan("changes", step.note);
          if (process.env.PARITY_DEBUG === "1") {
            const task = await store.get({ pk: `DEVTASK#${taskId}`, sk: "META" });
            const rows = (await store.queryIndex({ index: "workflow-dispatch-due", partition: `ORG#${companyOf(task)}#WORKFLOW_DISPATCH` })).items.map((row) => ({ kind: row.kind, next: row.nextAttemptAt, attempts: row.attempts, lastError: row.lastError }));
            console.log(JSON.stringify({ parity: "core.afterChanges", states: recorder.states, rows, now: new Date().toISOString() }));
          }
          return await answerPlanning(step.revised);
        case "coding.done": {
          codingJob = await take();
          commit = model.commit("work", Object.fromEntries(Object.entries(step.files).map(([path, content]) => [path, content])));
          tree = model.revision(commit).tree;
          // The coding run's result carries its checks' report: it is sent by the next `checks` step, or now (passing) when no `checks` step follows.
          if (next?.do !== "checks") await sendCoding("passed");
          return;
        }
        case "checks": {
          // A check that fails and then passes inside one coding run is the worker's one extra try (FR-006): the run reports it passed, with the extra try
          // given, as the real worker does. A check that fails with no pass after it is reported failed.
          if (step.outcome === "fail" && next?.do === "checks" && next.outcome === "pass") { await sendCoding("passed", "given"); skipNext = true; return; }
          if (skipNext) { skipNext = false; return; }
          if (codingJob === undefined) codingJob = await take();
          await sendCoding(step.outcome === "pass" ? "passed" : "failed");
          return;
        }
        case "reviews": {
          const job = await take();
          const digest = createCandidateManifest(candidate()).digest;
          const report = (role: "CRITIC" | "SECURITY") => ({ operationId: job.operationId, candidateDigest: digest, role, provider: "examplehost-model", version: "1", readOnly: true, recordedAt: new Date().toISOString(), status: "PASS", findings: [], ...(role === "CRITIC" ? { risk: "low" } : {}) });
          await callback(job, "result", { status: "SUCCEEDED", result: { conversationId: "conversation", workflowCandidateRepositories: candidate(), workflowReviews: [report("CRITIC"), report("SECURITY")] } });
          return;
        }
        case "published": {
          const job = await take();
          const payload = job.payload as Record<string, unknown>;
          const headBranch = String(payload.headBranch);
          model.branches.set(headBranch, commit);
          await callback(job, "pull-request", { repository: "demo", repositoryUrl: model.url, headBranch, baseBranch: "main", commit, title: payload.title, body: payload.body });
          await callback(job, "result", { status: "SUCCEEDED", result: { repository: "demo", number: 1, url: model.crUrl("1"), headBranch, baseBranch: "main", commit, checks: [], reconciled: false, draft: true } });
          return;
        }
        case "task.stop": {
          const stopped = await api(`/v1/dev/tasks/${taskId}/cancel`, { method: "POST", body: { requestId: "22222222-2222-4222-8222-222222222222" } });
          if (stopped.status !== 200) throw new Error(`the core refused the stop (${String(stopped.status)}): ${JSON.stringify(stopped.body).slice(0, 200)}`);
          await runtime.tick();
          return;
        }
        default: throw new Error(`the core engine does not drive ${step.do}`);
      }
    };
    for (const [index, step] of scenario.steps.entries()) {
      try {
        await runStep(step, scenario.steps[index + 1]);
      } catch (error) {
        // The core stopped where Cloud's path went on (or the other way round): the observation ends here, and the comparison shows where they part.
        if (!(error instanceof Stalled)) throw error;
        if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "core.stalled", step: step.do, why: error.message }));
        break;
      }
    }
    if (process.env.PARITY_DEBUG === "1") {
      const task = await store.get({ pk: `DEVTASK#${taskId}`, sk: "META" });
      console.log(JSON.stringify({ parity: "core.final", scenario: scenario.id, workflow: stateWord((task?.workflow ?? {}) as never), revision: (task?.workflow as { revision?: number } | undefined)?.revision, states: recorder.states }));
    }
    return {
      transitions: recorder.states, decisions: [...recorder.decisions], rows: [...recorder.keys],
      messages: [], spend: [...world.spend], audit: world.audit.map((event) => event.action),
      codeHost: model.changeRequests.map((entry) => (entry.draft ? "open_draft_pr" : "open_pr")),
    };
  }

  async dispose(): Promise<void> {
    await this.#runtime?.stop();
    if (this.#root !== undefined) await rm(this.#root, { recursive: true, force: true });
  }
}

interface RawReply { status: number; headers: Record<string, string | string[] | undefined>; body: string }

/** One request with exactly the headers given (from Code's tests/support/local-pages-fakes.ts). */
function raw(origin: string, input: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<RawReply> {
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
function formOf(page: string, suffix: string): { action: string; fields: Record<string, string> } {
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

export type { StoredDocument };
