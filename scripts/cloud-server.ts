// Rovara Cloud against a Rovara Code install: the web app's pages and Cloud's server (packages/cloud-server) on one port.
// On this computer (build the app first, npm run build:web):
//
//   ROVARA_CODE_URL=https://<code api> ROVARA_CLIENT_SECRET_FILE=<file> npm run cloud:local
//
// Deployed (infra/lib/cloud-app.ts), the same server runs in a container behind an HTTPS address, configured by
// CLOUD_ORIGIN (that address), HOST, ROVARA_CLIENT_SECRET and CLOUD_APP_DIRECTORY.
//
// Optional: ROVARA_CLIENT_ID (rovara-cloud), PORT (8787), HOST (127.0.0.1), CLOUD_ORIGIN (http://127.0.0.1:<port>),
// ROVARA_CLIENT_SECRET (instead of the file), ROVARA_SCOPES, CLOUD_SESSIONS_FILE (keeps people signed in across restarts,
// mode 600), CLOUD_WORK_SESSIONS_FILE (keeps Cloud's sessions, mode 600), CLOUD_ORG_NAME, CLOUD_APP_DIRECTORY (the built
// app, packages/web/dist/app).
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler } from "../packages/cloud-server/src/index.js";
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
const clientSecret = process.env.ROVARA_CLIENT_SECRET ?? readFileSync(required("ROVARA_CLIENT_SECRET_FILE"), "utf8");
const client = new CodeClient({
  baseUrl: codeUrl, clientId, clientSecret: clientSecret.trim(), redirectUri,
  scopes: process.env.ROVARA_SCOPES ?? "projects:members projects:create",
});
const cloud = createCloudHandler({
  client, store: new LocalSessionStore(process.env.CLOUD_SESSIONS_FILE ?? process.env.PROTOTYPE_SESSIONS_FILE),
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
