// Org connections (Plan 3, ruling R62): the credentials a company gives Rovara for its trackers and MCP servers.
// A connection is a record with no secret in it; its key or token lives in a Secrets Manager secret named from the
// org id and the connection id, which only a role session tagged with that org can read.
import { z } from "zod";
import { ConnectionIdSchema } from "./agent.js";
import { McpAuthSchema, McpEndpointSchema } from "./mcp-connector.js";
import { orgScoped, type OrgId, type OrgKey } from "./org.js";

export const ConnectionTypeSchema = z.enum(["linear", "jira", "mcp"]);
export type ConnectionType = z.infer<typeof ConnectionTypeSchema>;

export const ConnectionAccessSchema = z.enum(["read", "read_write"]);
export type ConnectionAccess = z.infer<typeof ConnectionAccessSchema>;

export const CONNECTION_LABEL_MAX = 64;

const LabelSchema = z.string().trim().min(1).max(CONNECTION_LABEL_MAX)
  // eslint-disable-next-line no-control-regex -- a label is one line of plain text
  .refine((label) => !/[\u0000-\u001f\u007f\u2028\u2029]/.test(label), "must be one line");

/** `https://<site>.atlassian.net`: one DNS label under atlassian.net, no path, so the token only ever goes to Atlassian. */
export const JiraSiteUrlSchema = z.string().regex(/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/, "must be https://<site>.atlassian.net");

const McpVendorSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 .&+-]{0,31}$/);

const Common = { connectionId: ConnectionIdSchema, label: LabelSchema, access: ConnectionAccessSchema } as const;

export const OrgConnectionSchema = z.discriminatedUnion("type", [
  z.object({ ...Common, type: z.literal("linear") }).strict(),
  z.object({ ...Common, type: z.literal("jira"), siteUrl: JiraSiteUrlSchema }).strict(),
  z.object({ ...Common, type: z.literal("mcp"), endpoint: McpEndpointSchema, vendor: McpVendorSchema, auth: McpAuthSchema.optional() }).strict(),
]);
export type OrgConnection = z.infer<typeof OrgConnectionSchema>;

/** A key or token goes in an HTTP header, so it is printable ASCII with no space or line break. */
const SecretText = z.string().regex(/^[\x21-\x7e]{1,8192}$/, "must be 1 to 8192 printable characters with no space");

/** What a secret holds, by connection type: a Linear API key, a Jira API token, an MCP bearer token. Write-only: nothing returns it. */
export const ConnectionSecretSchemas = {
  linear: z.object({ apiKey: SecretText }).strict(),
  jira: z.object({ apiToken: SecretText }).strict(),
  mcp: z.object({ token: SecretText }).strict(),
} as const;

export const ConnectionSecretSchema = z.union([ConnectionSecretSchemas.linear, ConnectionSecretSchemas.jira, ConnectionSecretSchemas.mcp]);
export type ConnectionSecret = z.infer<typeof ConnectionSecretSchema>;

/** The secret's one value, whatever the type calls it. */
export function connectionSecretToken(type: ConnectionType, secret: ConnectionSecret): string {
  return type === "linear" ? (secret as { apiKey: string }).apiKey : type === "jira" ? (secret as { apiToken: string }).apiToken : (secret as { token: string }).token;
}

/** One connection's partition: its META record. */
export function connectionKey(orgId: OrgId, connectionId: string): OrgKey {
  return { pk: orgScoped(orgId, `CONNECTION#${connectionId}`), sk: "META" };
}

/** The org's connection directory: one item per connection, for listing without reading every partition. */
export function connectionsKey(orgId: OrgId, connectionId: string): OrgKey {
  return { pk: orgScoped(orgId, "CONNECTIONS"), sk: connectionId };
}
