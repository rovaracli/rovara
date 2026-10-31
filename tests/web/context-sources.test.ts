// @vitest-environment jsdom
// Lane E, task E8: the Sources of a project and the MCP servers of an Enterprise org, as an admin uses them.
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { ContextSources } from "../../packages/ui/src/screens/admin/projects/ContextSources.js";
import { McpServers } from "../../packages/ui/src/screens/admin/connections/McpServers.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";

const hash = (char: string) => char.repeat(64);
const approved = { serverId: "mcpsim000001", label: "SIM", status: "approved", transport: { kind: "http", address: "https://sim.corp.example/mcp" }, probe: { tools: [{ name: "search_tickets", description: "Search", annotation: "read_only" }] }, requestedAt: "2026-11-01T10:00:00Z" };
const tools = [
 { name: "search_tickets", description: "Search tickets", schemaHash: hash("a"), annotation: "read_only", nameSuggestsChange: false, takesAddress: false },
 { name: "lookup_page", description: "Look up a page", schemaHash: hash("b"), annotation: "unannotated", nameSuggestsChange: false, takesAddress: false },
 { name: "close_ticket", description: "Close", schemaHash: hash("c"), annotation: "unsafe", nameSuggestsChange: true, takesAddress: true },
];

function sourcesHost(options: { pending?: unknown[]; sources?: unknown[]; forbidden?: boolean } = {}) {
 const posts: ApiRequest[] = [];
 const f = fakeHost(async (input: ApiRequest): Promise<ApiResponse> => {
  if (input.method === "POST") posts.push(input);
  if (input.path === "/v1/app/projects/payments/context-sources") return options.forbidden ? { status: 403, body: { error: { code: "FORBIDDEN", message: "no" } } } : { status: 200, body: { project: "payments", document: { revision: 1, sources: options.sources ?? [] }, pending: options.pending ?? [] } };
  if (input.path === "/v1/app/org/mcp-servers") return { status: 200, body: { servers: [approved] } };
  if (input.path === "/v1/app/connections") return { status: 200, body: { connections: [{ connectionId: "con_aaaaaaaaaaaaaaaaaaaa", label: "Wiki", type: "mcp" }, { connectionId: "con_bbbbbbbbbbbbbbbbbbbb", label: "Tracker", type: "linear" }] } };
  if (input.path.endsWith("/discover")) return { status: 200, body: { tools } };
  if (input.path.endsWith("/changes")) return { status: 202, body: { status: "NEEDS_CONFIRMATION", changeId: "11111111-1111-4111-8111-111111111111", needsSecondAdmin: [] } };
  return { status: 200, body: {} };
 });
 return { ...f, posts };
}
const mountSources = (f: ReturnType<typeof sourcesHost>) => renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(ContextSources, { project: "payments" }) }) }));

describe("a project's Sources", () => {
 it("hides itself from someone who may not change them", async () => {
  const f = sourcesHost({ forbidden: true });
  const view = mountSources(f);
  await waitFor(() => expect(f.request).toHaveBeenCalled());
  await waitFor(() => expect(view.container.textContent).toBe(""));
 });
 it("offers the stages that read and judge, never Build, and turns code in queries off", async () => {
  const f = sourcesHost();
  mountSources(f);
  await screen.findByText("This project has no sources.");
  for (const word of ["Understand", "Plan", "Plan check", "Review"]) expect(screen.getByLabelText(word)).toBeTruthy();
  expect(screen.queryByLabelText("Build")).toBeNull();
  expect(screen.getByText(/never reads these sources while it writes code/i)).toBeTruthy();
  expect(screen.getByLabelText<HTMLInputElement>(/Allow code in its queries/).checked).toBe(false);
 });
 it("offers only MCP connections and servers that were allowed, and walks tick, confirm and propose", async () => {
  const f = sourcesHost();
  mountSources(f);
  const server = await screen.findByLabelText<HTMLSelectElement>("Server");
  expect([...server.options].map(option => option.text)).toEqual(["Choose a server", "Wiki (connection)", "SIM (on your network)"]);
  fireEvent.change(server, { target: { value: "s:mcpsim000001" } });
  fireEvent.click(screen.getByRole("button", { name: "Show its tools" }));
  await screen.findByText("search_tickets");
  // a tool that says it changes things cannot be ticked
  expect(screen.getByLabelText<HTMLInputElement>("close_ticket").disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "SIM" } });
  fireEvent.change(screen.getByLabelText("Short id"), { target: { value: "sim" } });
  fireEvent.click(screen.getByLabelText("search_tickets"));
  fireEvent.click(screen.getByLabelText("lookup_page"));
  const propose = screen.getByRole<HTMLButtonElement>("button", { name: "Propose this source" });
  // an unannotated tool needs the confirmation before the source can be proposed
  expect(propose.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/I confirm this tool only reads/));
  expect(propose.disabled).toBe(false);
  fireEvent.click(propose);
  await screen.findByText(/Proposed\. Confirm it below/);
  const post = f.posts.find(request => request.path.endsWith("/changes"))!;
  expect(post.body).toMatchObject({ kind: "set", source: {
   sourceId: "sim", label: "SIM", server: { kind: "registered_server", serverId: "mcpsim000001" }, stages: ["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "REVIEW"], quotes: "citations_only", sendCodeSnippets: false,
   tools: [{ upstreamName: "search_tickets", role: "read", schemaHash: hash("a") }, { upstreamName: "lookup_page", role: "read", schemaHash: hash("b"), attestedReadOnly: true }],
  } });
  expect(JSON.stringify(post.body)).not.toContain("IMPLEMENT");
  expect(JSON.stringify(post.body)).not.toContain("close_ticket");
 });
 it("shows a change waiting, says when a second admin is needed, and confirms or turns it down", async () => {
  const f = sourcesHost({ pending: [{ changeId: "11111111-1111-4111-8111-111111111111", kind: "set", sourceId: "sim", proposedBy: "dev1", proposedAt: "t", secondAdminReasons: ["lookup_page does not say it only reads"], source: { sourceId: "sim", label: "SIM", server: { kind: "connection", connectionId: "con_aaaaaaaaaaaaaaaaaaaa" }, tools: [], stages: ["PLAN"], quotes: "citations_only", retention: "team_record", limits: { callsPerStage: 25, bytesPerResult: 16384, bytesPerStage: 196608 }, liveFacts: [], sendCodeSnippets: false } }] });
  mountSources(f);
  await screen.findByText(/A second admin must confirm: lookup_page does not say it only reads/);
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(f.posts.some(request => request.path.endsWith("/confirm"))).toBe(true));
 });
 it("shows the broker's sentence when a change is refused, and never a stack", async () => {
  const f = fakeHost(async input => {
   if (input.path === "/v1/app/projects/payments/context-sources") return { status: 200, body: { project: "payments", document: { revision: 0, sources: [{ sourceId: "sim", label: "SIM", server: { kind: "connection", connectionId: "con_aaaaaaaaaaaaaaaaaaaa" }, tools: [], stages: ["PLAN"], quotes: "citations_only", retention: "team_record", limits: { callsPerStage: 25, bytesPerResult: 16384, bytesPerStage: 196608 }, liveFacts: [], sendCodeSnippets: false }] }, pending: [] } };
   if (input.method === "POST") return { status: 400, body: { error: { code: "CONFIG_INVALID", message: "server: a context source needs a read-only connection; this one can also write" } } };
   return { status: 404, body: {} };
  });
  renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(ContextSources, { project: "payments" }) }) }));
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  expect((await screen.findByRole("alert")).textContent).toBe("server: a context source needs a read-only connection; this one can also write");
 });
});

describe("MCP servers on the network", () => {
 it("is not shown in the Public edition", async () => {
  const f = fakeHost(async () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "This feature is part of the Enterprise edition." } } }));
  const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(McpServers) }) }));
  await waitFor(() => expect(f.request).toHaveBeenCalled());
  await waitFor(() => expect(view.container.textContent).toBe(""));
 });
 it("walks paste, test, see what it offers, allow", async () => {
  const posts: ApiRequest[] = [];
  let list: unknown[] = [];
  const waiting = { ...approved, serverId: "mcpnew0000001", label: "Wiki", status: "awaiting_approval", probe: { tools: [{ name: "lookup_page", description: "Look up", annotation: "unannotated" }] } };
  const f = fakeHost(async (input: ApiRequest) => {
   if (input.method === "POST") posts.push(input);
   if (input.method === "GET") return { status: 200, body: { servers: list } };
   if (input.path.endsWith("/approve")) { list = [{ ...waiting, status: "approved" }];return { status: 200, body: { server: { ...waiting, status: "approved" } } }; }
   list = [waiting];return { status: 202, body: { status: "NEEDS_APPROVAL", server: waiting } };
  });
  renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(McpServers) }) }));
  await screen.findByText("No MCP servers added yet.");
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Wiki" } });
  fireEvent.change(screen.getByLabelText("Address"), { target: { value: " https://wiki.corp.example/mcp " } });
  fireEvent.click(screen.getByRole("button", { name: "Test it" }));
  await screen.findByRole("button", { name: "Allow this server" });
  expect(screen.getAllByText(/does not say whether it only reads/).length).toBeGreaterThan(0);
  expect(posts[0]!.body).toEqual({ label: "Wiki", transport: { kind: "http", address: "https://wiki.corp.example/mcp" } });
  // nothing is allowed until the admin says so
  expect(posts.some(request => request.path.endsWith("/approve"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Allow this server" }));
  await screen.findByText(/Allowed/);
  expect(posts.map(request => request.path)).toEqual(["/v1/app/org/mcp-servers", "/v1/app/org/mcp-servers/mcpnew0000001/approve"]);
 });
 it("sends a package with an exact version for a server Rovara runs, and shows the fixed sentence when the test fails", async () => {
  const posts: ApiRequest[] = [];
  const f = fakeHost(async (input: ApiRequest) => {
   if (input.method === "GET") return { status: 200, body: { servers: [] } };
   posts.push(input);return { status: 400, body: { error: { code: "CONFIG_INVALID", message: "The server did not answer in time." } } };
  });
  renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(McpServers) }) }));
  await screen.findByText("No MCP servers added yet.");
  fireEvent.click(screen.getByLabelText("Rovara runs a package for it"));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Wiki" } });
  fireEvent.change(screen.getByLabelText("Package"), { target: { value: "@acme/wiki-mcp" } });
  fireEvent.change(screen.getByLabelText("Exact version"), { target: { value: "1.4.2" } });
  fireEvent.change(screen.getByLabelText("Arguments"), { target: { value: "--read-only  --lang en" } });
  fireEvent.click(screen.getByRole("button", { name: "Test it" }));
  expect((await screen.findByRole("alert")).textContent).toBe("The server did not answer in time.");
  expect(posts[0]!.body).toEqual({ label: "Wiki", transport: { kind: "stdio", spec: { registry: "npm", name: "@acme/wiki-mcp", version: "1.4.2", args: ["--read-only", "--lang", "en"] } } });
 });
});
