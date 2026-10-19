// ModelAccessFunction: the only broker-side code that holds the model proxy master key (ruling R28).
// It runs in the VPC, where the proxy's internal load balancer is reachable; the broker Lambdas are
// not in the VPC and call it through ModelAccessInvoker. The master key is read once from Secrets
// Manager and kept in memory. Nothing here logs a key, the master key, or request arguments.
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { AgentXError, agentXError } from "@agentx/contracts";
import type { ModelAccess } from "./access.js";
import { ModelProxyClient } from "./client.js";
import { ModelAccessRequestSchema, type ModelAccessRequest, type ModelAccessResponse } from "./protocol.js";

/** Reads the secret on first use and keeps it; a failed read is not remembered, so the next call tries again. */
export function cachedSecret(read: () => Promise<string>): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return () => {
    pending ??= read().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

async function perform(access: ModelAccess, request: ModelAccessRequest): Promise<unknown> {
  switch (request.op) {
    case "upsertOrg": return access.upsertOrg(request.args.orgId, request.args.monthlyBudgetUsd).then(() => null);
    case "upsertMember": return access.upsertMember(request.args.orgId, request.args.developerId, request.args.monthlyBudgetUsd).then(() => null);
    case "spend": return access.spend(request.args.orgId, request.args.developerId);
    case "orgSpend": return access.orgSpend(request.args.orgId);
    case "keySpend": return access.keySpend(request.args.keyIds);
    case "mintKey": return access.mintKey(request.args);
    case "revokeKey": return access.revokeKey(request.args.key).then(() => null);
  }
}

/** The handler over any ModelAccess; the exported `handler` wires the real client. */
export function createModelAccessHandler(input: { access: ModelAccess; log?: (entry: Record<string, unknown>) => void }) {
  const log = input.log ?? ((entry) => console.log(JSON.stringify({ component: "model-access", ...entry })));
  return async (event: unknown): Promise<ModelAccessResponse> => {
    const parsed = ModelAccessRequestSchema.safeParse(event);
    if (!parsed.success) {
      // Field paths only: a value in the event may be a key.
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(request)"))].join(", ");
      log({ event: "model_access.rejected", code: "CONFIG_INVALID" });
      return { ok: false, code: "CONFIG_INVALID", message: `invalid model access request: ${fields}` };
    }
    const { op } = parsed.data;
    try {
      const result = await perform(input.access, parsed.data);
      log({ event: "model_access.done", op });
      return { ok: true, result };
    } catch (error) {
      if (error instanceof AgentXError) {
        log({ event: "model_access.failed", op, code: error.code });
        return { ok: false, code: error.code, message: error.message.slice(error.code.length + 2) };
      }
      log({ event: "model_access.failed", op, code: "MODEL_PROXY_UNAVAILABLE" });
      return { ok: false, code: "MODEL_PROXY_UNAVAILABLE", message: "model access failed unexpectedly" };
    }
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw agentXError("CONFIG_INVALID", `${name} is not set`);
  return value;
}

let wired: ReturnType<typeof createModelAccessHandler> | undefined;

function wire() {
  const secrets = new SecretsManagerClient({});
  const secretId = requiredEnvironment("MODEL_PROXY_MASTER_KEY_SECRET_ARN");
  const masterKey = cachedSecret(async () => {
    const value = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (value.SecretString === undefined || value.SecretString.trim() === "") throw new Error("master key secret is empty");
    return value.SecretString.trim();
  });
  return createModelAccessHandler({
    access: new ModelProxyClient({ baseUrl: requiredEnvironment("MODEL_PROXY_URL"), masterKey, fetch, now: Date.now }),
  });
}

export async function handler(event: unknown): Promise<ModelAccessResponse> {
  try {
    wired ??= wire();
  } catch {
    return { ok: false, code: "CONFIG_INVALID", message: "model access function is not configured" };
  }
  return wired(event);
}
