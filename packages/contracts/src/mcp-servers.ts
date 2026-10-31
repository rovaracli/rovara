// MCP servers on the customer's own network (Enterprise; design meta-repo-mcp.md 3.6 "Enterprise endpoints", lane E task E6, owner decision Q12).
//
// The admin does not edit infrastructure. They paste an address (or a stdio server's package) in settings. Rovara tests it, shows what it offers, and asks for
// approval. On approval the entry becomes part of the install's allow-list, which is nothing more than the set of approved entries: there is no second list to
// keep in step. Public never has these: its endpoints stay public https only (mcp-connector.ts).
import { z } from "zod";
import { ConnectionIdSchema } from "./agent-node.js";

export const McpServerIdSchema = z.string().regex(/^mcp[a-z0-9]{6,24}$/);

export const MCP_SERVER_STATUSES = ["awaiting_approval", "approved", "disabled"] as const;
export const McpServerStatusSchema = z.enum(MCP_SERVER_STATUSES);
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;

const OneLine = z.string().min(1).max(60).refine((value) => ![...value].some((char) => char.charCodeAt(0) <= 0x1f || char.charCodeAt(0) === 0x7f), "must be one line");

/** The address of a private HTTPS MCP server: https, no login, query or fragment; a DNS name or an IP address; any port. */
export function privateMcpAddressProblem(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return "address: that is not a web address"; }
  if (url.protocol !== "https:") return "address: must start with https://";
  if (url.username !== "" || url.password !== "") return "address: must not hold a user name or password";
  if (url.search !== "" || url.hash !== "") return "address: must not have a query or fragment";
  if (url.hostname === "") return "address: has no host";
  return undefined;
}

export const McpHttpAddressSchema = z.string().max(2_048).superRefine((value, context) => {
  const problem = privateMcpAddressProblem(value);
  if (problem !== undefined) context.addIssue({ code: "custom", message: problem });
});

/** An exact version (no range, no tag such as `latest`), so what runs is what the admin saw. */
export const EXACT_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,60}\/)?[a-z0-9][a-z0-9._-]{0,60}$/;
const ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]{1,100}$/;

/** A stdio server the MCP host runs: an npm package at an exact version (and, when the admin has one, its integrity hash), with fixed arguments. */
export const McpStdioSpecSchema = z.object({
  registry: z.literal("npm"),
  name: z.string().regex(NPM_NAME),
  version: z.string().regex(EXACT_VERSION),
  /** The `dist.integrity` the registry publishes for that version (`sha512-…`); the host refuses a package that does not match. */
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/=]{20,200}$/).optional(),
  /** Arguments after the package's own command. No shell is used; each is one plain word. */
  args: z.array(z.string().regex(ARGUMENT).refine((value) => !value.split("/").includes(".."), "no ..")).max(8),
}).strict();
export type McpStdioSpec = z.infer<typeof McpStdioSpecSchema>;

export const McpServerTransportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("http"), address: McpHttpAddressSchema }).strict(),
  z.object({ kind: z.literal("stdio"), spec: McpStdioSpecSchema }).strict(),
]);
export type McpServerTransport = z.infer<typeof McpServerTransportSchema>;

/** What the test showed. The tools are shown to the admin before they approve; the hash binds the approval to exactly this list. */
export const McpServerProbeSchema = z.object({
  at: z.string().max(40),
  toolsHash: z.string().regex(/^[0-9a-f]{64}$/),
  tools: z.array(z.object({
    name: z.string().max(64),
    description: z.string().max(300),
    annotation: z.enum(["read_only", "unannotated", "unsafe"]),
    schemaHash: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict()).max(100),
}).strict();
export type McpServerProbe = z.infer<typeof McpServerProbeSchema>;

export const McpServerEntrySchema = z.object({
  serverId: McpServerIdSchema,
  label: OneLine,
  status: McpServerStatusSchema,
  transport: McpServerTransportSchema,
  /** An org connection (type `mcp`) whose token is sent to an http server. Absent: the server needs none. */
  authConnectionId: ConnectionIdSchema.optional(),
  probe: McpServerProbeSchema,
  requestedBy: z.string().max(200),
  requestedAt: z.string().max(40),
  decidedBy: z.string().max(200).optional(),
  decidedAt: z.string().max(40).optional(),
}).strict();
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>;

/** The codes a test of an address can end in. They are fixed words: a server's own error text is never shown (it can hold addresses and banners). */
export const MCP_PROBE_FAILURES = {
  not_allowed_address: "That address is one Rovara never calls (this machine, a link-local or metadata address, or a multicast address).",
  dns_failed: "Rovara could not find that host name.",
  unreachable: "Rovara could not connect to that address.",
  timed_out: "The server did not answer in time.",
  unauthorized: "The server asked for a login. Add a connection with its token and choose it.",
  not_mcp: "The server answered, but not as an MCP server.",
  host_unavailable: "The MCP host is not set up in this install, so stdio servers cannot be used.",
  host_refused: "The MCP host would not start that package.",
} as const;
export type McpProbeFailure = keyof typeof MCP_PROBE_FAILURES;
