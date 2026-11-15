// Rovara Cloud against a Rovara Code install: the web app's pages and Cloud's server (packages/cloud-server) on one port.
// On this computer (build the app first, npm run build:web):
//
//   ROVARA_CODE_URL=https://<code api> ROVARA_CLIENT_SECRET_FILE=<file> npm run cloud:local
//
// Deployed, Cloud runs scripts/cloud-lambda.ts on Lambda (infra/lib/cloud-web.ts, #11). This entry's deployed mode was the
// Fargate app's, retired with it: configured by CLOUD_ORIGIN (its address), HOST, CLOUD_APP_DIRECTORY and CLOUD_ENVIRONMENT, it
// keeps sign-ins in a DynamoDB table (CLOUD_SESSIONS_TABLE) sealed with Cloud's KMS key (CLOUD_SESSIONS_KEY_ID), reading its
// client secret from Secrets Manager at run time (ROVARA_CLIENT_SECRET_ID); the file store and a secret in the environment are
// refused.
//
// Optional: ROVARA_CLIENT_ID (rovara-cloud), PORT (8787), HOST (127.0.0.1), CLOUD_ORIGIN (http://127.0.0.1:<port>),
// ROVARA_CLIENT_SECRET (instead of the file), ROVARA_SCOPES, CLOUD_SESSIONS_FILE (keeps people signed in across restarts,
// mode 600; this computer only), CLOUD_WORK_SESSIONS_FILE (keeps Cloud's sessions, mode 600), CLOUD_AUDIT_FILE (keeps Cloud's audit records, mode 600; this computer only), CLOUD_ORG_NAME,
// CLOUD_APP_DIRECTORY (the built app, packages/web/dist/app), CLOUD_LEGACY_SESSIONS_FILE (deployed: an older raw-cookie
// sessions file; its sign-ins are revoked at Code and the file removed).
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import {
  CodeClient, DynamoCloudAuditStore, DynamoSessionStore, EnvelopeSealer, KmsKeyService, LocalCloudAuditStore, LocalSessionStore, LocalWorkSessionStore, cloudDocumentClient, createCloudHandler,
  isDeployedEnvironment, secretsManagerSecret, type CloudAuditStore, type CodeSession, type SecretReader, type SessionStore,
} from "../packages/cloud-server/src/index.js";
import { createAppHandler } from "../packages/web/src/server/handler.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const codeUrl = required("ROVARA_CODE_URL");
const clientId = process.env.ROVARA_CLIENT_ID ?? "rovara-cloud";
// Where people reach Cloud. Rovara Code takes a loopback redirect only at exactly http://127.0.0.1:<port>/callback, and
// any other one only as an https URL registered for this client.
const origin = (process.env.CLOUD_ORIGIN ?? `http://127.0.0.1:${String(port)}`).replace(/\/$/, "");
const secure = origin.startsWith("https://");
if (!secure && origin !== `http://127.0.0.1:${String(port)}`) throw new Error(`CLOUD_ORIGIN must be an https address or http://127.0.0.1:${String(port)}`);
const redirectUri = `${origin}/callback`;
const deployed = isDeployedEnvironment(process.env);
let clientSecret: string | SecretReader;
let store: SessionStore;
let audit: CloudAuditStore;
if (deployed) {
  // Deployed: sign-ins in the table, sealed with Cloud's key; the secret from Secrets Manager when a token call needs it.
  if (process.env.ROVARA_CLIENT_SECRET !== undefined || process.env.ROVARA_CLIENT_SECRET_FILE !== undefined) {
    throw new Error("A deployed Cloud reads its client secret from Secrets Manager (ROVARA_CLIENT_SECRET_ID), never from its environment or a file");
  }
  // Short timeouts and few attempts, so a refresh's AWS calls stay well inside its 60-second hold on the session.
  const aws = { region: required("AWS_REGION"), maxAttempts: 2, requestHandler: { connectionTimeout: 2_000, requestTimeout: 4_000 } };
  clientSecret = secretsManagerSecret(new SecretsManagerClient(aws), required("ROVARA_CLIENT_SECRET_ID"));
  const db = cloudDocumentClient(new DynamoDBClient(aws));
  store = new DynamoSessionStore(db, required("CLOUD_SESSIONS_TABLE"), new EnvelopeSealer(new KmsKeyService(new KMSClient(aws), required("CLOUD_SESSIONS_KEY_ID"))));
  audit = new DynamoCloudAuditStore(db, required("CLOUD_SESSIONS_TABLE"));
} else {
  clientSecret = (process.env.ROVARA_CLIENT_SECRET ?? readFileSync(required("ROVARA_CLIENT_SECRET_FILE"), "utf8")).trim();
  store = new LocalSessionStore(process.env.CLOUD_SESSIONS_FILE ?? process.env.PROTOTYPE_SESSIONS_FILE);
  audit = new LocalCloudAuditStore(process.env.CLOUD_AUDIT_FILE);
}
const client = new CodeClient({
  baseUrl: codeUrl, clientId, clientSecret, redirectUri,
  scopes: process.env.ROVARA_SCOPES ?? "projects:members projects:create",
});

/**
 * An older deployed Cloud kept every sign-in in one file under the raw cookie: end each at Code, then remove the file.
 * The file stays (and is tried again at the next start) until every sign-in in it was ended at Code.
 */
async function retireLegacySessions(file: string): Promise<void> {
  if (!existsSync(file)) return;
  const sessions = Object.values(JSON.parse(readFileSync(file, "utf8")) as Record<string, CodeSession>).filter((each) => typeof each?.accessToken === "string");
  let revoked = 0;
  for (const each of sessions) if (await client.revoke(each)) revoked += 1;
  if (revoked === sessions.length) unlinkSync(file);
  console.log(JSON.stringify({ event: revoked === sessions.length ? "cloud.legacy_sessions_retired" : "cloud.legacy_sessions_kept", sessions: sessions.length, revoked }));
}
if (deployed && process.env.CLOUD_LEGACY_SESSIONS_FILE) {
  retireLegacySessions(process.env.CLOUD_LEGACY_SESSIONS_FILE).catch(() => { console.log(JSON.stringify({ event: "cloud.legacy_sessions_retire_failed" })); });
}

const cloud = createCloudHandler({
  client, store, audit,
  org: { orgId: "rovara", name: process.env.CLOUD_ORG_NAME ?? "Rovara", plan: "local" },
  callbackPath: "/callback", secureCookies: secure,
  work: new LocalWorkSessionStore(process.env.CLOUD_WORK_SESSIONS_FILE), origin,
});
const appDirectory = process.env.CLOUD_APP_DIRECTORY ?? join(resolve(process.cwd(), "packages/web/dist"), "app");
const app = createAppHandler({ appDirectory, assetOrigin: "", realtimeHttpHost: "", realtimeWsHost: "" });

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", origin);
  const method = req.method ?? "GET";
  if (url.pathname === "/") {
    res.writeHead(302, { location: "/app" }).end();
    return;
  }
  const headers = Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(", ") : value]));
  const answer = await cloud({ method, path: url.pathname, query: url.searchParams, headers, ...(method === "GET" || method === "HEAD" ? {} : { body: await readBody(req) }) });
  if (answer !== undefined) {
    res.writeHead(answer.status, answer.headers).end(answer.body);
    return;
  }
  const page = await app({ rawPath: url.pathname, headers, requestContext: { http: { method } } });
  // HSTS on a plain-HTTP loopback address would only get in the way.
  const pageHeaders = Object.fromEntries(Object.entries(page.headers ?? {}).filter(([name]) => secure || name.toLowerCase() !== "strict-transport-security")) as Record<string, string>;
  res.writeHead(page.statusCode, pageHeaders).end(page.isBase64Encoded === true ? Buffer.from(page.body, "base64") : page.body);
}

createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    console.error(error);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" }).end("Rovara Cloud failed; see its log.");
  });
}).listen(port, host, () => { console.log(`Rovara Cloud on ${origin}/app (listening on ${host}:${String(port)}), signing in through ${codeUrl} as ${clientId}`); });
