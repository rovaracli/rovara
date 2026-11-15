// Rovara Cloud on AWS Lambda (PrepLabsAI/Rovara-cloud#11): the same server as scripts/cloud-server.ts, behind CloudFront and a function
// URL, with its state in DynamoDB so any number of copies serve at once and a release replaces them with no gap. The app's built files
// come from S3 through CloudFront; only the page shell (with its per-request nonce) and the API come here. infra/lib/cloud-web.ts runs it.
//
// Environment: ROVARA_CODE_URL, ROVARA_CLIENT_ID (rovara-cloud), ROVARA_SCOPES, CLOUD_TABLE, CLOUD_ORIGIN_PARAMETER (the SSM parameter
// holding Cloud's https address), CLOUD_CLIENT_SECRET_ID (the secret holding Cloud's client secret), CLOUD_ORG_NAME, CLOUD_APP_DIRECTORY
// (the page shell, index.html).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  CodeClient, DynamoPresenceBoard, DynamoSessionStore, DynamoWorkSessionStore, cloudConfigReader, cloudDocumentClient, createCloudHandler,
  type CloudRequest, type CloudResponse,
} from "../packages/cloud-server/src/index.js";
import { createAppHandler } from "../packages/web/src/server/handler.js";

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
  const store = new DynamoSessionStore(db, table), work = new DynamoWorkSessionStore(db, table), presence = new DynamoPresenceBoard(db, table);
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
          client, store, work, presence, origin, callbackPath: "/callback", secureCookies: true,
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
