// Rovara Cloud on this computer, against a Rovara Code install: the web app's pages and Cloud's server
// (packages/cloud-server) on one loopback port. Build the app first (npm run build:web).
//
//   ROVARA_CODE_URL=https://<code api> ROVARA_CLIENT_SECRET_FILE=<file> npm run cloud:local
//
// Optional: ROVARA_CLIENT_ID (rovara-cloud), PORT (8787), ROVARA_SCOPES, CLOUD_SESSIONS_FILE (keeps people signed in
// across restarts, mode 600), CLOUD_ORG_NAME.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { CodeClient, LocalSessionStore, createCloudHandler } from "../packages/cloud-server/src/index.js";
import { createAppHandler } from "../packages/web/src/server/handler.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const port = Number(process.env.PORT ?? 8787);
const codeUrl = required("ROVARA_CODE_URL");
const clientId = process.env.ROVARA_CLIENT_ID ?? "rovara-cloud";
// Rovara Code takes a loopback redirect only at exactly this path.
const redirectUri = `http://127.0.0.1:${String(port)}/callback`;
const client = new CodeClient({
  baseUrl: codeUrl, clientId, clientSecret: readFileSync(required("ROVARA_CLIENT_SECRET_FILE"), "utf8").trim(), redirectUri,
  scopes: process.env.ROVARA_SCOPES ?? "projects:members projects:create",
});
const cloud = createCloudHandler({
  client, store: new LocalSessionStore(process.env.CLOUD_SESSIONS_FILE ?? process.env.PROTOTYPE_SESSIONS_FILE),
  org: { orgId: "rovara", name: process.env.CLOUD_ORG_NAME ?? "Rovara", plan: "local" },
  callbackPath: "/callback", secureCookies: false,
});
const app = createAppHandler({ appDirectory: join(resolve(process.cwd(), "packages/web/dist"), "app"), assetOrigin: "", realtimeHttpHost: "", realtimeWsHost: "" });

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${String(port)}`);
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
  const pageHeaders = Object.fromEntries(Object.entries(page.headers ?? {}).filter(([name]) => name.toLowerCase() !== "strict-transport-security")) as Record<string, string>;
  res.writeHead(page.statusCode, pageHeaders).end(page.isBase64Encoded === true ? Buffer.from(page.body, "base64") : page.body);
}

createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    console.error(error);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" }).end("Rovara Cloud failed; see its terminal.");
  });
}).listen(port, "127.0.0.1", () => { console.log(`Rovara Cloud on http://127.0.0.1:${String(port)}/app, signing in through ${codeUrl} as ${clientId}`); });
