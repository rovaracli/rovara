// Script tokens on the core (area 36): made on the owner's local tokens page (the core never makes one for an API session token), used over the owner's
// API with `Authorization: Bearer <token>`. From Code's own tests (tests/unit/par-surfaces-script-tokens.test.ts).
import { formOf, raw, type CoreContext } from "../core-context.js";

/** Makes a token for `projects` with `permissions` on the tokens page, as the owner does, and answers the secret the page showed once. */
export async function makeCoreToken(ctx: CoreContext, projects: readonly string[], permissions: readonly string[]): Promise<string> {
  const opened = await ctx.api("/v1/local/pages/open", { method: "POST", body: { path: "/tokens", fresh: true } });
  if (opened.status !== 200) throw new Error(`the tokens page did not open (${String(opened.status)})`);
  const once = new URL(ctx.opened.at(-1)!);
  const hop = await raw(ctx.runtime.pagesUrl, { path: once.pathname, headers: { host: once.host } });
  const location = new URL(String(hop.headers.location), ctx.runtime.pagesUrl);
  const base = location.pathname.split("/").slice(0, 3).join("/");
  const drawn = await raw(ctx.runtime.pagesUrl, { path: `${base}/tokens`, headers: { host: location.host } });
  const form = formOf(drawn.body, "/tokens/create");
  const fields = new URLSearchParams(form.fields);
  fields.set("name", "CI deploy");
  for (const project of projects) fields.append("project", project);
  for (const permission of permissions) fields.append("permission", permission);
  const made = await raw(ctx.runtime.pagesUrl, { method: "POST", path: `${base}/tokens/create`, body: fields.toString(), headers: { host: location.host, origin: ctx.runtime.pagesUrl, "content-type": "application/x-www-form-urlencoded" } });
  const secret = /<code>(rvst_[0-9a-z]{20}_[0-9a-z]{20}_[A-Za-z0-9_-]{43})<\/code>/.exec(made.body)?.[1];
  if (secret === undefined) throw new Error(`the tokens page made no token (${String(made.status)})`);
  return secret;
}

/** One call to the owner's API with a script token. */
export async function callWithCoreToken(ctx: CoreContext, secret: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${ctx.runtime.url}${path}`, { method, headers: { authorization: `Bearer ${secret}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown> };
}
