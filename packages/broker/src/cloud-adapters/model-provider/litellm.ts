// Convergence lane A3 (Cloud adapter, private): Cloud's model proxy (LiteLLM) as a `model-provider` adapter on Code's port.
//
// PER TASK: an instance is built for one task (`task`: its company and task id), asks `taskKey` for that task's key only, and keeps its own "why no key" sentence, so one instance can never sign
// task A's call with task B's key, or report B's problem for A. It is never put in the shared registry; the task flow builds it when the task's model call is routed.
//
// The proxy is where a company's own keys live (its AI sources) and where spend caps are enforced; a task never holds a provider key, it holds a short-lived proxy key minted for the task and
// its developer (`ModelAccess.mintKey`, ruling R48: inference routes only). So this provider signs in with a bearer key that is that minted key (`taskKey()`, given by the composition root,
// read when a call is made), and speaks the three formats on the exact inference paths the load balancer forwards (`INFERENCE_PATHS`): `/v1/messages`, `/v1/responses`, `/chat/completions`.
//
// Capabilities are claimed conservatively: LiteLLM forwards each format to the source's own provider and translates when the source speaks another, so only what survives a translation is
// claimed (no forced tool choice: an OpenAI-compatible source behind it can drop it silently).
//
// The address must pass Code's address rule (https, or this computer). Cloud's inference listener today is plain http on an internal load balancer (infra/lib/model-proxy.ts), which that rule
// refuses: an owner choice (a TLS listener, or a port rule for a private address) before this adapter can be wired. Until then it is built and tested against an https address only.
import { INFERENCE_PATHS, MODEL_PROVIDER_ID_PATTERN, assertModelProvider, type ModelFormatCapabilities, type ModelProviderAdapter, type ModelProviderPrices, type SecretValue } from "@rovara-code/contracts";

export const LITELLM_PROVIDER_ID = "rovara-model-proxy";

export const LITELLM_MESSAGES_CAPABILITIES: ModelFormatCapabilities = { forcedToolChoice: false, parallelToolCalls: true, reasoning: "thinking", reasoningReturned: true, promptCaching: true, streamUsage: true };
export const LITELLM_RESPONSES_CAPABILITIES: ModelFormatCapabilities = { forcedToolChoice: false, parallelToolCalls: true, reasoning: "effort", reasoningReturned: false, promptCaching: false, streamUsage: true };
export const LITELLM_CHAT_CAPABILITIES: ModelFormatCapabilities = { forcedToolChoice: false, parallelToolCalls: true, reasoning: "effort", reasoningReturned: false, promptCaching: false, streamUsage: true };

const pathOf = (transport: (typeof INFERENCE_PATHS)[number]["transport"]): string => INFERENCE_PATHS.find((entry) => entry.transport === transport)!.path;

/** The one task (and its company and developer) a provider instance signs for. */
export interface LiteLlmTaskContext {
  companyId: string;
  taskId: string;
}

export interface CloudLiteLlmOptions {
  /** The proxy's inference address (`https://host[:port]`). */
  address: string;
  /** The task this instance signs for. One instance per task: an instance never signs another task's call. */
  task: LiteLlmTaskContext;
  /** The short-lived proxy key minted for exactly this task (`ModelAccess.mintKey`), read when a call is made. Undefined: no key (the proxy answers a fixed sentence). */
  taskKey: (task: Readonly<LiteLlmTaskContext>) => Promise<SecretValue | undefined>;
  kind?: string;
  defaultModel?: string;
  prices?: ModelProviderPrices;
}

export function cloudLiteLlmProvider(options: CloudLiteLlmOptions): ModelProviderAdapter {
  const kind = options.kind ?? LITELLM_PROVIDER_ID;
  if (!MODEL_PROVIDER_ID_PATTERN.test(kind)) throw new Error("the model proxy's provider id is a plain id");
  if (!/^org_[0-9a-z]{20}$/u.test(options.task.companyId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(options.task.taskId)) throw new Error("a model proxy provider is built for one company's task");
  const task = Object.freeze({ companyId: options.task.companyId, taskId: options.task.taskId });
  let problem: string | undefined;
  return assertModelProvider({
    kind,
    name: "Rovara model proxy",
    address: options.address,
    signIn: { kind: "bearer-key" },
    formats: [
      { format: "anthropic-messages", pathOverride: pathOf("anthropic-messages"), capabilities: LITELLM_MESSAGES_CAPABILITIES },
      { format: "openai-responses", pathOverride: pathOf("openai-responses"), capabilities: LITELLM_RESPONSES_CAPABILITIES },
      { format: "openai-completions", pathOverride: pathOf("openai-completions"), capabilities: LITELLM_CHAT_CAPABILITIES },
    ],
    ...(options.defaultModel === undefined ? {} : { defaultModel: options.defaultModel }),
    ...(options.prices === undefined ? {} : { prices: options.prices }),
    credentialProblem: () => problem,
    async credential() {
      try {
        const key = await options.taskKey(task);
        problem = key === undefined ? "no model proxy key was minted for this task" : undefined;
        return key;
      } catch {
        problem = "the model proxy key could not be minted right now";
        return undefined;
      }
    },
  });
}
