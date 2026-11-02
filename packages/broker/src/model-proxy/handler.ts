// ModelAccessFunction: the only broker-side code that holds the model proxy master key (ruling R28).
// It runs in the VPC, where the proxy's internal load balancer is reachable; the broker Lambdas are
// not in the VPC and call it through ModelAccessInvoker. The master key is read once from Secrets
// Manager and kept in memory. Nothing here logs a key, the master key, or request arguments.
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { AgentXError, MODEL_ENDPOINT_SECRET_PREFIX, agentXError, isModelEndpointSecretRef } from "@agentx/contracts";
import { bedrockClaudeModelIds, listPricesPerMillion, proxyGeographyForRegion } from "@agentx/model-runtime/catalog";
import type { ModelAccess } from "./access.js";
import { endpointRangesFromEnvironment, modelEndpointChecker, CUSTOM_MODEL_ENDPOINTS_ENV } from "../model-sources/endpoint-qualification.js";
import { ModelProxyClient, type RoleAssumer } from "./client.js";
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

/**
 * The Bedrock probe's STS call. The session it gets is dropped unread. Only an access denial is an answer (the trust policy refused);
 * any other failure is not, and the caller reports the probe as unavailable.
 */
export function stsRoleAssumer(sts: { send(command: AssumeRoleCommand): Promise<unknown> }): RoleAssumer {
  return {
    async assumeRole({ roleArn, sessionName, externalId }) {
      try {
        await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: sessionName, ExternalId: externalId, DurationSeconds: 900 }));
        return true;
      } catch (error) {
        const name = typeof error === "object" && error !== null && "name" in error ? String((error).name) : "";
        if (name === "AccessDenied" || name === "AccessDeniedException") return false;
        throw error;
      }
    },
  };
}

/**
 * N8: reads the secret behind a company model endpoint's reference. Only a name under `rovara/model-endpoints/` is ever asked for (the function's IAM role is limited to the
 * same prefix, so this is the second fence, not the only one). Missing, not readable and empty are fixed refusals; any other failure is left to the caller as a read that
 * may work later. The value is returned to the proxy client alone and never logged.
 */
export function endpointSecretReader(secrets: { send(command: GetSecretValueCommand): Promise<{ SecretString?: string | undefined }> }): (reference: string) => Promise<string> {
  return async (reference) => {
    if (!isModelEndpointSecretRef(reference) || !reference.startsWith(MODEL_ENDPOINT_SECRET_PREFIX)) throw agentXError("CONFIG_INVALID", "the endpoint's secret reference is not valid");
    let found: { SecretString?: string | undefined };
    try {
      found = await secrets.send(new GetSecretValueCommand({ SecretId: reference }));
    } catch (error) {
      const name = typeof error === "object" && error !== null && "name" in error ? String((error).name) : "";
      if (name === "ResourceNotFoundException" || name === "AccessDeniedException") throw agentXError("CONFIG_INVALID", "the endpoint's secret could not be read; check that it exists under rovara/model-endpoints/ and that Rovara may read it");
      throw error;
    }
    const value = found.SecretString?.trim();
    if (value === undefined || value === "") throw agentXError("CONFIG_INVALID", "the endpoint's secret is empty or not a plain key");
    return value;
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
    case "upsertSource": return access.upsertSource(request.args).then(() => null);
    case "removeSource": return access.removeSource(request.args.orgId, request.args.sourceId).then(() => null);
    case "listSources": return access.listSources();
    case "checkEndpoint":
      // No checker, no pass: an endpoint address is never judged anywhere else.
      if (access.checkEndpoint === undefined) throw agentXError("CONFIG_INVALID", "custom model endpoints are not set up on this install");
      return access.checkEndpoint(request.args.url).then(() => null);
    case "checkSource": return access.checkSource(request.args.orgId, request.args.sourceId);
    case "auditKeys": return access.auditKeys(request.args.budgetMs === undefined ? undefined : { budgetMs: request.args.budgetMs });
    case "revokeKey": return access.revokeKey(request.args.key).then(() => null);
    case "blockKey": return access.blockKey(request.args.keyId).then(() => null);
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

/** The in-VPC address checker for company model endpoints: present only when the switch is "1" and the ranges parse. */
export function endpointAddressChecker(env: Record<string, string | undefined>): { checkEndpointHost?: (url: string) => Promise<void> } {
  if (env[CUSTOM_MODEL_ENDPOINTS_ENV] !== "1") return {};
  try {
    return { checkEndpointHost: modelEndpointChecker(endpointRangesFromEnvironment(env)) };
  } catch {
    return {};
  }
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
  const log = (entry: Record<string, unknown>): void => console.log(JSON.stringify({ component: "model-access", ...entry }));
  return createModelAccessHandler({
    access: new ModelProxyClient({
      log,
      baseUrl: requiredEnvironment("MODEL_PROXY_URL"),
      masterKey,
      fetch,
      now: Date.now,
      prices: listPricesPerMillion,
      // The models the proxy's own config serves for this region (the control plane builds the config from the same list).
      catalog: bedrockClaudeModelIds(proxyGeographyForRegion(requiredEnvironment("AWS_REGION"))),
      roles: stsRoleAssumer(new STSClient({})),
      resolveSecret: endpointSecretReader(secrets),
      // N8: the address of a company endpoint is judged here, inside the VPC, with the resolver the proxy connects with. Only when the install turned endpoints on; a bad range
      // setting leaves no checker (every address is then refused).
      ...endpointAddressChecker(process.env),
    }),
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
