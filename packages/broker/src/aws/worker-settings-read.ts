// The worker settings an environment's workers run with, read from SSM (set by each release). Shared by the session steps (which launch a worker with them) and the broker (which reads the worker image from them to name the
// base image of a saved project image): one reader, one set of rules.
import { BOOT_STAGE2_SHA256_PARAMETER, MODEL_FALLBACK_NONE, MODEL_FALLBACK_PATTERN, MODEL_PROXY_URL_PARAMETER, WORKER_SETTING_PARAMETERS, getParametersInBatches, type SsmGetParametersAnswer } from "@agentx/contracts";

/** What a worker runs with besides its own workspace: set by each release in SSM. */
export interface WorkerSettings {
  workerImage: string;
  /**
   * The SHA-256 of the stage 2 boot script the worker image carries, set by the same deploy that set `workerImage` (Task 10). Read only
   * in a named environment; absent from the SSM setting means a release before the boot split.
   */
  bootStage2Sha256?: string;
  /** The browser executor image, once a release carries one; workers boot without EXECUTOR_IMAGE until then. */
  executorImage?: string;
  modelProvider: string;
  modelId: string;
  promptCacheRetention: "short" | "long";
  openRouterSecretArn?: string;
  openRouterProviders?: string;
  anthropicSecretArn?: string;
  openaiSecretArn?: string;
  /** A named environment's model proxy; its workers call models through it (Task 14). */
  modelProxyUrl?: string;
  /** MODEL3: the chosen Bedrock fallback model, when one was chosen (`none` and an absent setting both leave it out). */
  modelFallback?: string;
}

/**
 * Reads the worker settings from SSM under `prefix`. A named environment adds two more names (the proxy URL and the stage 2 hash) to the nine
 * worker settings: eleven, past GetParameters' limit of ten per call, so the read goes through getParametersInBatches. A parameter SSM
 * does not find is absent from the merged answer and fails the launch ("is missing") as it did with one call.
 */
export async function readWorkerSettings(
  read: (names: string[]) => Promise<SsmGetParametersAnswer>,
  options: { prefix: string; modelProxyRequired: boolean },
): Promise<WorkerSettings> {
  // The proxy URL and the stage 2 hash are named environments' settings, and only their functions may read them (see modelProxyRequired).
  const names = Object.fromEntries(Object.entries({
    ...WORKER_SETTING_PARAMETERS,
    ...(options.modelProxyRequired ? { modelProxyUrl: MODEL_PROXY_URL_PARAMETER, bootStage2Sha256: BOOT_STAGE2_SHA256_PARAMETER } : {}),
  }).map(([key, name]) => [key, `${options.prefix}${name}`])) as Record<keyof typeof WORKER_SETTING_PARAMETERS | "modelProxyUrl" | "bootStage2Sha256", string>;
  const response = await getParametersInBatches(Object.values(names), read);
  const values = new Map(response.Parameters.map((parameter) => [parameter.Name, parameter.Value]));
  const setting = (key: keyof typeof WORKER_SETTING_PARAMETERS) => {
    const value = values.get(names[key]);
    if (!value) throw new Error(`SSM parameter ${names[key]} is missing`);
    return value;
  };
  const promptCacheRetention = setting("promptCacheRetention");
  if (promptCacheRetention !== "short" && promptCacheRetention !== "long") throw new Error("worker prompt cache retention must be short or long");
  // Absent from SSM (a release before the setting existed) or "none" both mean not configured.
  const optional = (key: "openRouterSecretArn" | "openRouterProviders" | "anthropicSecretArn" | "openaiSecretArn" | "modelProxyUrl" | "bootStage2Sha256" | "executorImage") => {
    const value = values.get(names[key]);
    return value && value !== "none" ? { [key]: value } : {};
  };
  // The fallback is a choice: only an id of the setting's alphabet travels to the worker; "none", absent and anything else leave it out (the worker then fails by name).
  const fallback = values.get(names.modelFallback)?.trim();
  const modelFallback = fallback !== undefined && fallback !== MODEL_FALLBACK_NONE && MODEL_FALLBACK_PATTERN.test(fallback) ? { modelFallback: fallback } : {};
  return { ...modelFallback, ...optional("openRouterSecretArn"), ...optional("openRouterProviders"), ...optional("anthropicSecretArn"), ...optional("openaiSecretArn"), ...optional("modelProxyUrl"), ...optional("bootStage2Sha256"), ...optional("executorImage"), workerImage: setting("workerImage"), modelProvider: setting("modelProvider"), modelId: setting("modelId"), promptCacheRetention };
}

