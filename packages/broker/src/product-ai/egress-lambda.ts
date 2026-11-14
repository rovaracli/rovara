// TE-F1e: the Lambda entry of the ProductModelEgress function (infra/lib/product-model-egress.ts). Response streaming (`awslambda.streamifyResponse`, the Node.js runtime's global): every port event is written
// as one or more records of the wire (`@agentx/cloud-contracts` product-model-egress.ts).
//
// DARK BY DEFAULT. F1-d's read seam, warning writer and session policy, and A1's `productModels` gate, are not on this base (F1-d is built in parallel). Until 9d merges F1-d and binds them here, the bound
// stand-ins answer "no source" and "gate off": every call is `not_found`, no key is read, nothing is reserved. Switching on also waits for the live TS-L self-tests (DEFERRED F1C-ENABLE-AFTER-TSL).
//
// Environment: STATE_TABLE_NAME, PRODUCT_MODEL_EGRESS_KEY_ARN (the capability key: GetPublicKey once per cold start), AGENTX_ENV and AGENTX_ACCOUNT_ID (ProductAiSecretsRole's ARN is built from them, as the
// other fixed-name roles are), AWS_REGION, and optionally PRODUCT_MODEL_EGRESS_DENY_SUFFIXES (comma-separated Rovara domains a model call may never go to).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetPublicKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { STSClient } from "@aws-sdk/client-sts";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { connectorSecretsRoleName, encodeProductModelRecord } from "@agentx/cloud-contracts";
import { environmentRolePath, familyErrorBody } from "@rovara-code/contracts";
import type { KeyObject } from "node:crypto";
import { modelEgressPublicKey } from "./capability.js";
import { defaultFamilyOf, defaultProductRowFor, handleProductModelEgress, type ProductModelEgressDependencies } from "./egress-handler.js";
import { createOperationScopeReader } from "./operation-scope.js";
import { createCloudProviderTransport } from "./provider-transport.js";
import { createProxySecretReader } from "./proxy-secret.js";
import { NO_GOOGLE_TOKEN_SOURCE, type ProductAiProxySessionPolicy } from "./seams.js";

/** F1-d's `productAiSecretsRoleName` (te-f1d.md fork F2), as agreed; replaced by F1-d's import on merge. */
export const productAiSecretsRoleNameStandIn = (env: string): string => `${connectorSecretsRoleName(env)}-product-ai`;

/** Until F1-d is merged: no session policy can be built, so no session is ever asked for (the loader below never returns a source). */
const UNBOUND_SESSION_POLICY: ProductAiProxySessionPolicy = () => {
  throw new Error("the product key store is not bound");
};

export function productModelEgressDependencies(env: NodeJS.ProcessEnv, log: (line: string) => void = (line) => console.log(line)): ProductModelEgressDependencies {
  const tableName = env.STATE_TABLE_NAME;
  const keyArn = env.PRODUCT_MODEL_EGRESS_KEY_ARN;
  const region = env.AWS_REGION;
  if (!tableName || !keyArn || !region || !env.AGENTX_ENV || !env.AGENTX_ACCOUNT_ID) throw new Error("the product model egress function is not configured");
  const configuration = { region, maxAttempts: 3 };
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(configuration));
  const kms = new KMSClient(configuration);
  let publicKey: Promise<KeyObject> | undefined;
  const partition = region.startsWith("cn-") ? "aws-cn" : region.startsWith("us-gov-") ? "aws-us-gov" : "aws";
  const denySuffixes = (env.PRODUCT_MODEL_EGRESS_DENY_SUFFIXES ?? "").split(",").map((part) => part.trim().toLowerCase()).filter((part) => part !== "");
  return {
    publicKey: () => {
      publicKey ??= kms.send(new GetPublicKeyCommand({ KeyId: keyArn })).then((answer) => modelEgressPublicKey(answer.PublicKey as Uint8Array));
      publicKey.catch(() => { publicKey = undefined; });
      return publicKey;
    },
    now: Date.now,
    readScope: createOperationScopeReader({ documentClient, tableName }),
    // F1-d binding point (A1 gate `productModels`): off until bound.
    gate: async () => false,
    // F1-d binding point (`loadProductSourceForRow`): no source until bound.
    loadSource: async () => undefined,
    rowFor: defaultProductRowFor,
    familyOf: defaultFamilyOf,
    keys: createProxySecretReader({
      roleArn: `arn:${partition}:iam::${env.AGENTX_ACCOUNT_ID}:role${environmentRolePath(env.AGENTX_ENV)}${productAiSecretsRoleNameStandIn(env.AGENTX_ENV)}`,
      secretArnPrefix: `arn:${partition}:secretsmanager:${region}:${env.AGENTX_ACCOUNT_ID}:secret:`,
      sts: new STSClient({ ...configuration, maxAttempts: 1 }),
      secretsFor: (credentials) => new SecretsManagerClient({ ...configuration, maxAttempts: 1, credentials }),
      sessionPolicy: UNBOUND_SESSION_POLICY,
    }),
    tokens: NO_GOOGLE_TOKEN_SOURCE,
    meter: { documentClient, tableName, now: Date.now },
    transport: createCloudProviderTransport({ denySuffixes }),
    // F1-d binding point (`recordProductSourceWarning`).
    recordWarning: async () => undefined,
    // Fixed fields only; the handler's per-call redactor has already cut any spelling of the call's key.
    log: (fields) => log(JSON.stringify({ component: "product-model-egress", ...fields })),
  };
}

interface ResponseStream { write(chunk: Uint8Array): unknown; end(): void }
type StreamifyResponse = (handler: (event: unknown, stream: ResponseStream) => Promise<void>) => unknown;
/** The Node.js runtime's `awslambda.streamifyResponse`, when this runs inside Lambda. */
const streamify = (): StreamifyResponse | undefined => {
  const runtime = (globalThis as { awslambda?: { streamifyResponse?: unknown } }).awslambda;
  return typeof runtime?.streamifyResponse === "function" ? (runtime.streamifyResponse as StreamifyResponse).bind(runtime) : undefined;
};

let cached: ProductModelEgressDependencies | undefined;

/** Writes one call's events to the stream as records. Exported for tests. */
export async function streamProductModelEgress(deps: ProductModelEgressDependencies, event: unknown, stream: ResponseStream): Promise<void> {
  let headStatus: number | undefined;
  let settled = false;
  try {
    for await (const value of handleProductModelEgress(deps, event)) {
      if (value.kind === "head") headStatus = value.status;
      if (value.kind === "settle") settled = true;
      const records = value.kind === "head" ? encodeProductModelRecord({ kind: "head", head: { status: value.status, headers: value.headers.map(([name, header]) => [name, header] as [string, string]) } })
        : value.kind === "chunk" ? encodeProductModelRecord({ kind: "chunk", bytes: value.bytes })
          : encodeProductModelRecord({ kind: "settle", settle: { status: value.status, class: value.class, ...(value.refusal === undefined ? {} : { refusal: value.refusal }), ...(value.inputTokens === undefined ? {} : { inputTokens: value.inputTokens }), ...(value.outputTokens === undefined ? {} : { outputTokens: value.outputTokens }), costMicros: value.costMicros, estimated: value.estimated, ...(value.overrun === true ? { overrun: true as const } : {}) } });
      for (const record of records) stream.write(record);
    }
  } catch {
    // An unexpected throw (REVIEW-1 L-9): one fixed log field, and the stream still ends in the port's order with a fixed answer. No word of the error is written or logged.
    try {
      deps.log({ event: "failed" });
    } catch {
      // Nothing more to do.
    }
    if (!settled) {
      const records = headStatus === undefined
        ? [
          ...encodeProductModelRecord({ kind: "head", head: { status: 502, headers: [["content-type", "application/json"]] } }),
          ...encodeProductModelRecord({ kind: "chunk", bytes: familyErrorBody("openai_compatible", 502, "The provider could not be reached.", "rovara_unreachable") }),
          ...encodeProductModelRecord({ kind: "settle", settle: { status: 502, class: "provider_error", costMicros: 0, estimated: false } }),
        ]
        // After the head: what the call cost is on the meter (a reservation that did not settle stays counted); the worker reads a provider error.
        : encodeProductModelRecord({ kind: "settle", settle: { status: headStatus, class: "provider_error", costMicros: 0, estimated: true } });
      for (const record of records) stream.write(record);
    }
  } finally {
    stream.end();
  }
}

export const handler = streamify()?.(async (event, stream) => {
  cached ??= productModelEgressDependencies(process.env);
  await streamProductModelEgress(cached, event, stream);
});
