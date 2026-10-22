// Plan 3 Task 35: a signed-in CLI against a fake control plane, for the agent, approval and spend commands. Each route the fake knows
// is "METHOD /path" (the query is part of the key when the test names one); every request is recorded with its body.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { routeFetch } from "./developer-fakes.js";

export const CELL = "https://abc123.execute-api.us-west-2.amazonaws.com";
const ISSUER = `${CELL}/v1/auth`;
const entry = { url: CELL, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` };

export interface RecordedCall { method: string; path: string; query: string; body: unknown }
export type Answer = Response | ((body: unknown) => Response);

const dirs: string[] = [];
export async function cleanHarnessDirs(): Promise<void> {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

/** A fresh home with a signed-in developer, and a CLI whose fetch answers only the given routes. */
export async function agentsCli(routes: Record<string, Answer>, options: { env?: Record<string, string | undefined>; confirm?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "rovara-agents-cli-"));
  dirs.push(home);
  await saveDeveloperEnvironment(home, "staging", entry);
  const tokenStore = new InMemoryTokenStore();
  await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "access", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
  const calls: RecordedCall[] = [];
  const opened: string[] = [];
  const fetchImplementation = routeFetch(async (url, init) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, path: url.pathname, query: url.search, body });
    const answer = routes[`${method} ${url.pathname}${url.search}`] ?? routes[`${method} ${url.pathname}`];
    if (answer === undefined) return Response.json({ error: { code: "NOT_FOUND", message: `NOT_FOUND: no fake for ${method} ${url.pathname}${url.search}` } }, { status: 404 });
    return typeof answer === "function" ? answer(body) : answer.clone();
  });
  const out: string[] = [];
  const err: string[] = [];
  const run = (argv: string[]) => executeCli(argv, {
    fetchImplementation, tokenStore, environments: { home },
    login: { openBrowser: async (url) => { opened.push(url); } },
    ...(options.env === undefined ? {} : { processEnv: options.env }),
    ...(options.confirm === undefined ? {} : { confirm: async () => options.confirm! }),
    stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) },
  });
  const file = async (name: string, content: unknown) => {
    const path = join(home, name);
    await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
    return path;
  };
  return { run, calls, out, err, opened, file, home, stdout: () => out.join(""), stderr: () => err.join("") };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
