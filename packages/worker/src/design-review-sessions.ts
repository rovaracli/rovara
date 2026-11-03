// Design review stage, DR5: the real sessions behind `DesignReviewPorts` (design-review.ts), and the one function the worker calls for a PLAN_CRITIQUE operation that carries a `designReview` binding.
// Each reviewer is a NEW pi session made by `createWorkspacePiSession` as an agent-run session: its own system prompt (the role prompt), no repository context files and no coding preamble, the
// read-only file tools (nothing for the merge step), and no history. The one user message is sent by `design-review.ts`; this file only wires pi to the port.
import { randomUUID } from "node:crypto";
import { DESIGN_REVIEW_ARTIFACT, PACKET_DELIVERY_BYTES_MAX, agentXError, type DesignReviewBinding } from "@agentx/contracts";
import type { ArtifactSink } from "./artifacts.js";
import { runDesignReview, modelKeyIdOf, type DesignReviewOptions, type DesignReviewPorts, type DesignReviewSession, type OpenDesignReviewSession } from "./design-review.js";
import type { FileOpsTarget } from "./file-ops-exec.js";
import { lazyModelProxy, modelAccessSource } from "./model-access.js";
import { createWorkspacePiSession, type PiSessionAdapter, type WorkspaceModelConfiguration } from "./pi-session.js";
import { assistantOutcome, failedTurn, type AssistantOutcome } from "./session-events.js";
import { designReviewRuntime } from "./task-model.js";
import { assistantText } from "./verification/extension.js";

const CAPABILITY_HEADER = "x-agentx-callback-capability";
const PACKET_PATH = "/v1/internal/design-review/packet";
const PACKET_TIMEOUT_MS = 60_000;
const READ_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

/** Whether this operation is the design-review form of the plan check. Plan check without the binding is unchanged. */
export function designReviewBindingOf(payload: { workflowMode?: string | undefined; designReview?: DesignReviewBinding | undefined }): DesignReviewBinding | undefined {
  return payload.workflowMode === "PLAN_CRITIQUE" ? payload.designReview : undefined;
}

/** The reviewer's packet from the broker's route, with the operation's capability. Bounded; anything but a JSON answer is an error (the reviewer then gives no result). */
export function brokerPacketSource(input: { brokerUrl: string; capability: string; fetch?: typeof fetch; signal?: AbortSignal }): DesignReviewPorts["loadPacket"] {
  const transport = input.fetch ?? fetch;
  return async ({ keySlot }) => {
    const signals = [AbortSignal.timeout(PACKET_TIMEOUT_MS), ...(input.signal === undefined ? [] : [input.signal])];
    const response = await transport(`${input.brokerUrl.replace(/\/$/u, "")}${PACKET_PATH}?slot=${encodeURIComponent(keySlot)}`, { method: "GET", headers: { [CAPABILITY_HEADER]: input.capability }, signal: AbortSignal.any(signals) });
    if (response.status === 401 || response.status === 403) throw agentXError("CALLBACK_FORBIDDEN", `the control plane refused a reviewer's packet (HTTP ${response.status})`);
    if (!response.ok || response.body === null) throw agentXError("RUNTIME_UNAVAILABLE", `the reviewer's packet could not be read (HTTP ${response.status})`);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > PACKET_DELIVERY_BYTES_MAX * 2) throw agentXError("RUNTIME_UNAVAILABLE", "the reviewer's packet is too large");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  };
}

/**
 * Security S16/N9: a reviewer reads through the SANDBOX file tools only. The local file tools (the dev local shell) are rooted at the whole workspace, where `agent-sessions/<planner>.jsonl` and `.agentx` hold the planner's own
 * conversation; the sandbox tools hide those folders. A worker without sandbox file tools does not run a design review at all: it fails closed, and the broker records the review as not run.
 */
export function reviewFileToolsOf(fileTools: FileOpsTarget | undefined): { fileTools: FileOpsTarget } {
  if (fileTools === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "a design review needs the sandbox file tools");
  return { fileTools };
}

export interface ReviewSessionOptions {
  rootPath: string;
  fileTools?: FileOpsTarget | undefined;
  localFileTools?: boolean | undefined;
  /** The model and adapter of one session. The default builds them from the binding's model and the key slot's proxy. */
  runtimeFor(open: OpenDesignReviewSession): { model: WorkspaceModelConfiguration; piAdapter?: PiSessionAdapter | undefined; keyId?: (() => Promise<string | undefined>) | undefined };
  onDiagnostic?: (message: string) => void;
}

/** A new pi session for one reviewer or the merge step, behind the orchestration's port. */
export function createReviewSessionOpener(options: ReviewSessionOptions): DesignReviewPorts["openSession"] {
  return async (open) => {
    const runtime = options.runtimeFor(open);
    const sessionId = randomUUID();
    const handle = await createWorkspacePiSession({
      rootPath: options.rootPath,
      model: runtime.model,
      // An agent-run session is a planning session whatever else is said (pi-session.ts): at most the read-only file tools, and never a shell or a write.
      workflowMode: "PLAN",
      conversationId: sessionId,
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
      ...(options.fileTools === undefined ? {} : { fileTools: options.fileTools }),
      ...(options.localFileTools === undefined ? {} : { localFileTools: options.localFileTools }),
      agentTools: [...open.tools],
      agentRun: { systemPrompt: open.system, tools: [] },
    }, runtime.piAdapter);
    let lastOutcome: AssistantOutcome | undefined;
    let lastText: string | undefined;
    let first: { system: string; user: string; messages: number; systemObserved: boolean } | undefined;
    const files = new Set<string>();
    const unsubscribe = handle.subscribe((event) => {
      const value = event as { type?: unknown; toolName?: unknown; args?: unknown; message?: unknown } | undefined;
      if (value?.type === "tool_execution_start" && typeof value.toolName === "string" && READ_TOOLS.has(value.toolName)) {
        const path = value.args !== null && typeof value.args === "object" ? (value.args as { path?: unknown }).path : undefined;
        if (typeof path === "string" && files.size < 200) files.add(path.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 500));
      }
      const ended = assistantOutcome(event);
      if (ended !== undefined) { lastOutcome = ended; lastText = assistantText(value?.message); }
    });
    const session: DesignReviewSession = {
      sessionId,
      async prompt(text) {
        lastOutcome = undefined;
        lastText = undefined;
        // The first request of a session with no history is the system message and this one user message. A session that already holds messages would say so here.
        // The system text is what pi itself holds for the call (the role prompt PLUS whatever the harness adds, such as its cwd and date sections), read back from the session: it is not what we asked pi
        // to use. A handle that cannot say records nothing observed, and the worker then reports the reviewer as not sent as rendered.
        if (first === undefined) {
          const observed = handle.systemPromptText?.();
          first = { system: observed ?? "", user: text, messages: 1 + handle.getSessionStats().totalMessages + 1, systemObserved: observed !== undefined };
        }
        await handle.prompt(text);
        const failure = failedTurn(lastOutcome);
        if (failure !== undefined) throw failure;
        return lastText;
      },
      firstRequest: () => first,
      filesRead: () => [...files],
      tools: () => [...open.tools],
      keyId: async () => runtime.keyId?.(),
      usage: () => {
        const stats = handle.getSessionStats();
        return { tokensIn: Math.max(0, Math.trunc(stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite)), tokensOut: Math.max(0, Math.trunc(stats.tokens.output)), costUsd: Number.isFinite(stats.cost) ? Math.max(0, stats.cost) : 0 };
      },
      abort: () => handle.abort(),
      dispose: () => { unsubscribe(); handle.dispose(); },
    };
    return session;
  };
}

/**
 * The runtime of one slot: its model, its proxy route, and a key source of its own (`/v1/internal/model-access?slot=`), so no reviewer uses another's key. With no model proxy on this worker
 * the reviewer runs on the model as the install configures it and has no key id to report.
 */
export function slotRuntimeFor(input: { controlPlaneUrl: string; capability: string; proxyUrl: string | undefined; binding: DesignReviewBinding; environment?: NodeJS.ProcessEnv; fetch?: typeof fetch }): ReviewSessionOptions["runtimeFor"] {
  return (open) => {
    const declared = open.purpose === "merge" ? input.binding.merge : input.binding.reviewers.find((entry) => entry.keySlot === open.keySlot);
    // The model and route come from the binding, never from the port's caller: a slot the binding does not hold is refused.
    if (declared === undefined || declared.keySlot !== open.keySlot) throw agentXError("CONFIG_INVALID", "a design review session was asked for with a key slot the binding does not hold");
    const proxy = input.proxyUrl === undefined ? undefined
      : lazyModelProxy({ baseUrl: input.proxyUrl, source: modelAccessSource({ controlPlaneUrl: input.controlPlaneUrl, capability: input.capability, slot: declared.keySlot, ...(input.fetch === undefined ? {} : { fetch: input.fetch }) }) });
    const runtime = designReviewRuntime({ model: declared.model, modelRoute: declared.modelRoute }, proxy, input.environment);
    return { ...runtime, keyId: async () => (proxy === undefined ? undefined : modelKeyIdOf(await proxy.apiKey())) };
  };
}

/**
 * The design-review operation: runs every reviewer and the merge step, and uploads the result as `design-review.json`. The caller (run-task.ts) has already prepared the workspace and its file tools.
 */
export async function runDesignReviewOperation(input: {
  binding: DesignReviewBinding;
  ports: DesignReviewPorts;
  artifactSink: ArtifactSink;
  options?: DesignReviewOptions;
}): Promise<void> {
  const result = await runDesignReview(input.binding, input.ports, input.options);
  await input.artifactSink({ name: DESIGN_REVIEW_ARTIFACT, mediaType: "application/json", content: JSON.stringify(result) });
}

/** What run-task.ts needs for a design-review operation: the packet source and the per-slot models. Built by main.ts from the invocation's capability. */
export interface DesignReviewDependencies {
  loadPacket: DesignReviewPorts["loadPacket"];
  runtimeFor(binding: DesignReviewBinding): ReviewSessionOptions["runtimeFor"];
}

export function designReviewDependencies(input: { controlPlaneUrl: string; capability: string; proxyUrl: string | undefined; environment?: NodeJS.ProcessEnv; fetch?: typeof fetch }): DesignReviewDependencies {
  return {
    loadPacket: brokerPacketSource({ brokerUrl: input.controlPlaneUrl, capability: input.capability, ...(input.fetch === undefined ? {} : { fetch: input.fetch }) }),
    runtimeFor: (binding) => slotRuntimeFor({ ...input, binding }),
  };
}
