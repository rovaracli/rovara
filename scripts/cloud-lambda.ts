// Rovara Cloud on AWS Lambda (PrepLabsAI/Rovara-cloud#11): the same server as scripts/cloud-server.ts, behind CloudFront and a function
// URL, with its state in DynamoDB so any number of copies serve at once and a release replaces them with no gap. The app's built files
// come from S3 through CloudFront; only the page shell (with its per-request nonce) and the API come here. infra/lib/cloud-web.ts runs it.
//
// Environment: ROVARA_CODE_URL, ROVARA_CLIENT_ID (rovara-cloud), ROVARA_SCOPES, CLOUD_TABLE, CLOUD_ORIGIN_PARAMETER (the SSM parameter
// holding Cloud's https address), CLOUD_CLIENT_SECRET_ID (the secret holding Cloud's client secret), CLOUD_SESSIONS_KEY_ID (the KMS key
// that seals sign-ins), CLOUD_ORG_NAME, CLOUD_APP_DIRECTORY (the page shell, index.html); COMPANY_TABLE (Cloud's company data:
// settings and rules, invites, profile, the policy hook's install allow-list; absent, the company routes answer 501; the company is always
// the one Code's access check names, DEC 253z); CLOUD_AI_SOURCE_KINDS (DEC 254t: the company AI source kinds the owner switched on after
// their real-key checks, comma-separated; absent or empty, none); CLOUD_PRODUCT_KEYS_TABLE,
// CLOUD_PRODUCT_KEYS_KEY and CLOUD_PRODUCT_KEYS_MAC_KEY (the model gateway's product key table and KMS keys: the project product AI
// settings, all three or none; absent, those routes answer 501); CLOUD_MODEL_GATEWAY_URL (the model gateway's https address, for the
// Vertex AI connection test it runs for Cloud; empty or absent, a Vertex connect answers unavailable); CLOUD_BEDROCK_TEMPLATE_URL (the
// docs-site address of the customer's Bedrock role template, DEC 238; with the gateway's address it turns "your own Bedrock" on).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import {
  CodeClient, DynamoCloudAuditStore, DynamoCompanyStore, DynamoGatewayMeterReader, DynamoPresenceBoard, DynamoSessionStore, DynamoWorkSessionStore, EnvelopeSealer, KmsKeyService, cloudConfigReader, cloudDocumentClient, createCloudHandler, parseAiSourceKinds,
  type CloudRequest, type CloudResponse,
} from "../packages/cloud-server/src/index.js";
import { createAppHandler } from "../packages/web/src/server/handler.js";
import { credentialsFromEnvironment } from "../packages/model-gateway/src/aws.js";
import { awsKms, kmsFingerprinter } from "../packages/model-gateway/src/aws-kms.js";
import { Dynamo } from "../packages/model-gateway/src/dynamo.js";
import { DynamoProductKeyTable } from "../packages/model-gateway/src/dynamo-product-keys.js";
import { ProductKeyStore } from "../packages/model-gateway/src/product-keys.js";
import { gatewayBedrockCheck, gatewayBedrockSetup, gatewayVertexCheck } from "../packages/model-gateway/src/service-call.js";
import { bedrockModelPresets, bedrockSetupCommand, validTemplateUrl } from "../packages/model-gateway/src/bedrock-byo.js";
import { ROVARA_AI_US_MODELS } from "../packages/model-gateway/src/agent-ai.js";
import type { BedrockBackend } from "../packages/cloud-server/src/index.js";
import { kmsProductKeyService, ProductKeySealer } from "../packages/model-gateway/src/product-seal.js";

/**
 * The project product AI settings' store (B7): the gateway's write-only ProductKeyStore over its product key table, sealing with
 * its KMS key and fingerprinting with its HMAC key (this role may GenerateDataKey and GenerateMac, never Decrypt). Product keys
 * (AI Studio, and Vertex AI when the gateway's address is set: the gateway runs the federation test, service-call.ts, signed with
 * the same HMAC key) and the company's learning accounts (Anthropic, OpenAI, Gemini). Undefined unless all three are set.
 */
export function productAiStore(env: Readonly<Record<string, string | undefined>>): ProductKeyStore | undefined {
  const table = env.CLOUD_PRODUCT_KEYS_TABLE; const key = env.CLOUD_PRODUCT_KEYS_KEY; const macKey = env.CLOUD_PRODUCT_KEYS_MAC_KEY;
  const set = [table, key, macKey].filter((v) => v !== undefined && v !== "").length;
  if (set === 0) return undefined;
  if (set !== 3) throw new Error("product AI settings: CLOUD_PRODUCT_KEYS_TABLE, CLOUD_PRODUCT_KEYS_KEY and CLOUD_PRODUCT_KEYS_MAC_KEY go together");
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "";
  const gatewayText = env.CLOUD_MODEL_GATEWAY_URL ?? "";
  if (gatewayText !== "" && !/^https:\/\/[^/\s]+$/u.test(gatewayText)) throw new Error("product AI settings: CLOUD_MODEL_GATEWAY_URL is https:// and a host, no path");
  const gateway = gatewayText === "" ? undefined : gatewayText;
  const credentials = credentialsFromEnvironment(env);
  const kms = awsKms({ region, credentials });
  return new ProductKeyStore({
    table: new DynamoProductKeyTable(new Dynamo({ region, credentials }), table!),
    sealer: new ProductKeySealer(kmsProductKeyService(kms, key!)), fingerprint: kmsFingerprinter(kms, macKey!), providers: ["gemini", "vertex", "anthropic", "openai", "bedrock", "openrouter", "endpoint"],
    ...(gateway === undefined ? {} : {
      vertexCheck: gatewayVertexCheck({ address: gateway, issuer: `${env.ROVARA_CODE_URL ?? ""}/v1/auth`, kms, macKeyId: macKey! }),
      // DEC 238: the gateway tests a company's Bedrock role (only it may assume the broker); without it a connect answers unavailable.
      bedrockCheck: gatewayBedrockCheck({ address: gateway, issuer: `${env.ROVARA_CODE_URL ?? ""}/v1/auth`, kms, macKeyId: macKey! }),
    }),
  });
}

/**
 * "Your own Bedrock" (DEC 238) settings: the company's external id and Rovara's broker role from the gateway (a signed call), the
 * role template's docs-site address (never an S3 bucket: DEC 238 Q10), the CloudShell command and the model presets. Undefined
 * (the routes answer 501) unless the product key store, the gateway's address and the template address are all set.
 */
export function bedrockBackend(env: Readonly<Record<string, string | undefined>>): BedrockBackend | undefined {
  const templateUrl = env.CLOUD_BEDROCK_TEMPLATE_URL ?? "";
  const gateway = env.CLOUD_MODEL_GATEWAY_URL ?? ""; const macKey = env.CLOUD_PRODUCT_KEYS_MAC_KEY ?? "";
  if (templateUrl === "") return undefined;
  if (!validTemplateUrl(templateUrl)) throw new Error("bedrock settings: CLOUD_BEDROCK_TEMPLATE_URL is an https docs-site address of a .json file, never S3");
  if (gateway === "" || macKey === "") throw new Error("bedrock settings: CLOUD_BEDROCK_TEMPLATE_URL needs CLOUD_MODEL_GATEWAY_URL and the product key settings");
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "";
  const setup = gatewayBedrockSetup({ address: gateway, issuer: `${env.ROVARA_CODE_URL ?? ""}/v1/auth`, kms: awsKms({ region, credentials: credentialsFromEnvironment(env) }), macKeyId: macKey });
  return {
    async setup(cid) { const got = await setup(cid); return got === undefined ? undefined : { ...got, templateUrl }; },
    command: (made, cid, choice) => bedrockSetupCommand({ templateUrl: made.templateUrl, brokerRoleArn: made.brokerRoleArn, externalId: made.externalId, cid, region: choice.region, models: choice.models, allowGlobal: choice.allowGlobal, ...(choice.productModels === undefined ? {} : { productModels: choice.productModels }), ...(choice.project === undefined ? {} : { project: choice.project }) }),
    presets: (region) => bedrockModelPresets(region, ROVARA_AI_US_MODELS),
  };
}

/** A function URL's (and an HTTP API's) request, payload version 2.0: the fields Cloud reads. */
export interface FunctionUrlEvent {
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string } };
}

/** The answer in payload version 2.0: Set-Cookie goes in `cookies`, one entry per cookie. */
export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body: string;
  isBase64Encoded?: boolean;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** The request as Cloud's handler reads it: lower-case headers, and the cookies back in one `cookie` header. */
export function cloudRequest(event: FunctionUrlEvent): CloudRequest {
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  if (event.cookies !== undefined && event.cookies.length > 0) headers.cookie = event.cookies.join("; ");
  const method = event.requestContext.http.method;
  const body = event.body === undefined ? undefined : event.isBase64Encoded === true ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  return { method, path: event.rawPath, query: new URLSearchParams(event.rawQueryString ?? ""), headers, ...(method === "GET" || method === "HEAD" || body === undefined ? {} : { body }) };
}

/** Cloud's answer in payload version 2.0. */
export function functionUrlResult(answer: CloudResponse): FunctionUrlResult {
  const headers: Record<string, string> = {};
  let cookies: string[] | undefined;
  for (const [name, value] of Object.entries(answer.headers)) {
    if (name.toLowerCase() === "set-cookie") cookies = [...(cookies ?? []), value];
    else headers[name] = value;
  }
  return { statusCode: answer.status, headers, ...(cookies === undefined ? {} : { cookies }), body: answer.body };
}

/** The server, built on the first request and kept while this copy lives; its address and secret are read again every few minutes. */
let built: ReturnType<typeof build> | undefined;

function build() {
  const db = cloudDocumentClient(new DynamoDBClient({}));
  const table = required("CLOUD_TABLE");
  const config = cloudConfigReader({ originParameter: required("CLOUD_ORIGIN_PARAMETER"), clientSecretId: required("CLOUD_CLIENT_SECRET_ID") });
  // Short timeouts and few attempts, so a refresh's KMS calls stay well inside its hold on the session.
  const kms = new KMSClient({ maxAttempts: 2, requestHandler: { connectionTimeout: 2_000, requestTimeout: 4_000 } });
  const store = new DynamoSessionStore(db, table, new EnvelopeSealer(new KmsKeyService(kms, required("CLOUD_SESSIONS_KEY_ID")))), work = new DynamoWorkSessionStore(db, table), presence = new DynamoPresenceBoard(db, table), audit = new DynamoCloudAuditStore(db, table);
  const companyTable = process.env.COMPANY_TABLE;
  // DEC 254t: the AI source kinds this install's owner switched on (none when unset); a malformed setting stops the server here.
  const aiSourceKinds = parseAiSourceKinds(process.env.CLOUD_AI_SOURCE_KINDS);
  // People and limits (cost report slice A6): the model gateway's meter table, read only. Unset: that page answers "not set up" (501). It needs a read grant on the gateway's
  // meter table (leading keys CO#*) that the stacks do not give yet: an owner decision before it is set.
  const meterTable = process.env.CLOUD_GATEWAY_METER_TABLE;
  const peopleSpend = companyTable && meterTable ? new DynamoGatewayMeterReader(db, meterTable, `${required("ROVARA_CODE_URL")}/v1/auth`) : undefined;
  const company = companyTable ? { store: new DynamoCompanyStore(db, companyTable), aiSourceKinds, ...(peopleSpend === undefined ? {} : { peopleSpend }) } : undefined;
  const productStore = productAiStore(process.env);
  const bedrock = productStore === undefined ? undefined : bedrockBackend(process.env);
  const productAi = productStore === undefined ? undefined : { store: productStore, issuer: `${required("ROVARA_CODE_URL")}/v1/auth`, ...(bedrock === undefined ? {} : { bedrock }) };
  const app = createAppHandler({ appDirectory: required("CLOUD_APP_DIRECTORY"), assetOrigin: "", realtimeHttpHost: "", realtimeWsHost: "" });
  // One Cloud handler per address and secret: a new pair (a rotated secret) gets a new client.
  let current: { key: string; handle: ReturnType<typeof createCloudHandler> } | undefined;
  const cloud = async () => {
    const { origin, clientSecret } = await config();
    const key = `${origin}\n${clientSecret}`;
    if (current?.key !== key) {
      const client = new CodeClient({
        baseUrl: required("ROVARA_CODE_URL"), clientId: process.env.ROVARA_CLIENT_ID ?? "rovara-cloud", clientSecret, redirectUri: `${origin}/callback`,
        scopes: process.env.ROVARA_SCOPES ?? "projects:members projects:create",
      });
      current = {
        key,
        handle: createCloudHandler({
          client, store, work, presence, audit, origin, callbackPath: "/callback", secureCookies: true, ...(company === undefined ? {} : { company }), ...(productAi === undefined ? {} : { productAi }),
          // Lead 4 J3: the smart Just answer's Ask boxes. Off unless this is exactly "1": set it only after the gateway's answers purpose (L4-E) is merged AND deployed, and Code's answers are set up.
          ...(process.env.ROVARA_ANSWERS_ENABLED === "1" ? { answersEnabled: true } : {}),
          org: { orgId: "rovara", name: process.env.CLOUD_ORG_NAME ?? "Rovara", plan: "cloud" },
        }),
      };
    }
    return current.handle;
  };
  return { cloud, app };
}

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  built ??= build();
  const request = cloudRequest(event);
  if (request.path === "/") return { statusCode: 302, headers: { location: "/app", "cache-control": "no-store" }, body: "" };
  const answer = await (await built.cloud())(request);
  if (answer !== undefined) return functionUrlResult(answer);
  const page = await built.app({ rawPath: request.path, headers: request.headers, requestContext: { http: { method: request.method } } });
  return { statusCode: page.statusCode, headers: page.headers ?? {}, body: page.body, ...(page.isBase64Encoded === true ? { isBase64Encoded: true } : {}) };
}
