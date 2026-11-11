// `agentx connections list | add | remove | check` (Plan 3 Task 12b): the Linear, Jira and MCP connections an organization has given Rovara.
// Each command is one signed-in call to the control plane's /v1/app/connections routes. The secret of a new connection is read from stdin
// (hidden on a terminal), sent once in the request body and never printed, logged or kept; the control plane stores it where only the
// organization's own role session can read it, and never returns it.
import { randomUUID } from "node:crypto";
import { ConnectionAccessSchema, agentXError } from "@rovara-code/contracts";
import { z } from "zod";
import { sanitizeServerText } from "../auth.js";
import { developerRequest } from "./commands.js";
import type { DeveloperSessionDeps } from "./session.js";

const CheckSchema = z.object({ ok: z.boolean(), at: z.string() }).passthrough();
const ConnectionSchema = z.object({
  connectionId: z.string(),
  type: z.string(),
  label: z.string(),
  access: z.string(),
  hasCredential: z.boolean(),
  siteUrl: z.string().optional(),
  endpoint: z.string().optional(),
  vendor: z.string().optional(),
  lastCheck: CheckSchema.optional(),
}).passthrough();
const ListSchema = z.object({ connections: z.array(ConnectionSchema) });
const AddedSchema = z.object({ connection: ConnectionSchema });
const RemovedSchema = z.object({ removed: z.object({ connectionId: z.string() }) });
const CheckResultSchema = z.object({ ok: z.boolean(), message: z.string().optional() });

export type ConnectionView = z.infer<typeof ConnectionSchema>;

export async function connectionsList(deps: DeveloperSessionDeps, env: string | undefined): Promise<{ env: string; url: string; connections: ConnectionView[] }> {
  const { env: resolved, url, body } = await developerRequest(deps, env, "/v1/app/connections", ListSchema, { explain: true });
  return { env: resolved, url, connections: body.connections };
}

export function connectionsListText(result: { env: string; url: string; connections: readonly ConnectionView[] }): string {
  if (result.connections.length === 0) return `No connections yet on ${result.env} (${result.url}). Add one with agentx connections add <linear|jira|mcp>.\n`;
  const lines = [`Connections of your organization on ${result.env} (${result.url}):`];
  for (const connection of result.connections) {
    const where = connection.siteUrl ?? connection.endpoint;
    const check = connection.lastCheck === undefined ? "" : `  last check ${connection.lastCheck.ok ? "ok" : "failed"} (${sanitizeServerText(connection.lastCheck.at)})`;
    lines.push(`  ${sanitizeServerText(connection.connectionId)}  ${sanitizeServerText(connection.type)}  ${sanitizeServerText(connection.label)}  ${sanitizeServerText(connection.access)}  ${connection.hasCredential ? "credential saved" : "no credential"}${where === undefined ? "" : `  ${sanitizeServerText(where)}`}${check}`);
  }
  return `${lines.join("\n")}\n`;
}

/** What `agentx connections add` takes besides the secret. Only the options of the type are allowed. */
export interface ConnectionAddInput {
  type: string;
  label?: string | undefined;
  access?: string | undefined;
  siteUrl?: string | undefined;
  email?: string | undefined;
  endpoint?: string | undefined;
  vendor?: string | undefined;
  authHeader?: string | undefined;
  authPrefix?: string | undefined;
}

/** The types this command adds. The Plan 4 types (Sentry, Datadog, CloudWatch, Grafana, Vercel, PagerDuty) are added from the app, not here. */
const CliConnectionTypeSchema = z.enum(["linear", "jira", "mcp"]);
type ConnectionType = z.infer<typeof CliConnectionTypeSchema>;

const OPTIONS_OF = {
  linear: [],
  jira: ["siteUrl", "email"],
  mcp: ["endpoint", "vendor", "authHeader", "authPrefix"],
} as const satisfies Record<ConnectionType, readonly (keyof ConnectionAddInput)[]>;
const FLAG = { siteUrl: "--site-url", email: "--email", endpoint: "--endpoint", vendor: "--vendor", authHeader: "--auth-header", authPrefix: "--auth-prefix" } as const;

/** The connection a command line describes and what its secret is called, checked before anything is asked or sent. */
export function parseConnectionAdd(input: ConnectionAddInput): { type: ConnectionType; connection: Record<string, unknown>; secretName: string; secretOf: (value: string) => Record<string, unknown> } {
  const type = CliConnectionTypeSchema.safeParse(input.type);
  if (!type.success) throw agentXError("CONFIG_INVALID", `the type must be one of ${CliConnectionTypeSchema.options.join(", ")}`);
  if (input.label === undefined || input.label.trim() === "") throw agentXError("CONFIG_INVALID", "give the connection a name with --label");
  const access = ConnectionAccessSchema.safeParse(input.access ?? "read");
  if (!access.success) throw agentXError("CONFIG_INVALID", "--access must be read or read_write");
  const allowed: readonly (keyof ConnectionAddInput)[] = OPTIONS_OF[type.data];
  for (const name of Object.keys(FLAG) as Array<keyof typeof FLAG>) {
    if (input[name] !== undefined && !allowed.includes(name)) throw agentXError("CONFIG_INVALID", `${FLAG[name]} does not belong to a ${type.data} connection`);
  }
  const require = (name: keyof typeof FLAG): string => {
    const value = input[name];
    if (value === undefined || value === "") throw agentXError("CONFIG_INVALID", `a ${type.data} connection needs ${FLAG[name]}`);
    return value;
  };
  const common = { type: type.data, label: input.label, access: access.data };
  switch (type.data) {
    case "linear":
      return { type: "linear", connection: common, secretName: "Linear API key", secretOf: (apiKey) => ({ apiKey }) };
    case "jira": {
      const siteUrl = require("siteUrl");
      const email = require("email");
      return { type: "jira", connection: { ...common, siteUrl }, secretName: "Jira API token", secretOf: (apiToken) => ({ email, apiToken }) };
    }
    case "mcp": {
      const endpoint = require("endpoint");
      const vendor = require("vendor");
      const auth = input.authHeader === undefined && input.authPrefix === undefined ? undefined
        : { ...(input.authHeader === undefined ? {} : { header: input.authHeader }), ...(input.authPrefix === undefined ? {} : { prefix: input.authPrefix }) };
      return { type: "mcp", connection: { ...common, endpoint, vendor, ...(auth === undefined ? {} : { auth }) }, secretName: "MCP server token", secretOf: (token) => ({ token }) };
    }
  }
}

/** A secret as typed or piped: one value, with no space or line break inside. Never echoed in a message. */
export function cleanConnectionSecret(raw: string, what: string): string {
  const value = raw.trim();
  if (value === "") throw agentXError("CONFIG_INVALID", `the ${what} is empty`);
  if (/\s/.test(value)) throw agentXError("CONFIG_INVALID", `the ${what} contains spaces or line breaks; paste only the value`);
  return value;
}

export async function connectionsAdd(
  deps: DeveloperSessionDeps, env: string | undefined, parsed: ReturnType<typeof parseConnectionAdd>, secret: string,
): Promise<{ env: string; url: string; connection: ConnectionView }> {
  const { env: resolved, url, body } = await developerRequest(deps, env, "/v1/app/connections", AddedSchema, {
    method: "POST", explain: true, body: { requestId: randomUUID(), connection: parsed.connection, secret: parsed.secretOf(secret) },
  });
  return { env: resolved, url, connection: body.connection };
}

export const connectionsAddText = (result: { connection: ConnectionView }) =>
  `Added the ${sanitizeServerText(result.connection.type)} connection ${sanitizeServerText(result.connection.label)} (${sanitizeServerText(result.connection.connectionId)}). Run agentx connections check ${sanitizeServerText(result.connection.connectionId)} to test it.\n`;

export async function connectionsRemove(deps: DeveloperSessionDeps, env: string | undefined, connectionId: string): Promise<{ env: string; url: string; connectionId: string }> {
  const { env: resolved, url, body } = await developerRequest(deps, env, `/v1/app/connections/${encodeURIComponent(connectionId)}`, RemovedSchema, { method: "DELETE", body: { requestId: randomUUID() }, explain: true });
  return { env: resolved, url, connectionId: body.removed.connectionId };
}

export const connectionsRemoveText = (result: { connectionId: string }) =>
  `Removed the connection ${sanitizeServerText(result.connectionId)}. Its secret is scheduled for deletion and can be recovered for 7 days.\n`;

export async function connectionsCheck(deps: DeveloperSessionDeps, env: string | undefined, connectionId: string): Promise<{ env: string; url: string; connectionId: string; ok: boolean; message?: string }> {
  const { env: resolved, url, body } = await developerRequest(deps, env, `/v1/app/connections/${encodeURIComponent(connectionId)}/check`, CheckResultSchema, { method: "POST", body: { requestId: randomUUID() }, explain: true });
  return { env: resolved, url, connectionId, ok: body.ok, ...(body.message === undefined ? {} : { message: body.message }) };
}

export const connectionsCheckText = (result: { connectionId: string; message?: string }) =>
  `The connection ${sanitizeServerText(result.connectionId)} works${result.message === undefined ? "" : ` (${sanitizeServerText(result.message)})`}.\n`;
