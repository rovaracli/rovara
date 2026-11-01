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

const packageRun = { ...approved, serverId: "mcppkg000001", label: "Notes", transport: { kind: "stdio", spec: { name: "@acme/wiki-mcp", version: "1.0.0", integrity: "sha512-x" } } };

function sourcesHost(options: { pending?: unknown[]; sources?: unknown[]; forbidden?: boolean; servers?: unknown[]; stdioAvailable?: boolean } = {}) {
 const posts: ApiRequest[] = [];
 const f = fakeHost(async (input: ApiRequest): Promise<ApiResponse> => {
  if (input.method === "POST") posts.push(input);
  if (input.path === "/v1/app/projects/payments/context-sources") return options.forbidden ? { status: 403, body: { error: { code: "FORBIDDEN", message: "no" } } } : { status: 200, body: { project: "payments", document: { revision: 1, sources: options.sources ?? [] }, pending: options.pending ?? [] } };
  if (input.path === "/v1/app/org/mcp-servers") return { status: 200, body: { servers: options.servers ?? [approved], ...(options.stdioAvailable === undefined ? {} : { stdioAvailable: options.stdioAvailable }) } };
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
 it("ME-16: does not offer an approved package-run server while package-run servers are off, and offers it when they are on", async () => {
  for (const [stdioAvailable, expected] of [[undefined, ["Choose a server", "Wiki (connection)", "SIM (on your network)"]], [false, ["Choose a server", "Wiki (connection)", "SIM (on your network)"]], [true, ["Choose a server", "Wiki (connection)", "SIM (on your network)", "Notes (on your network)"]]] as const) {
   const f = sourcesHost({ servers: [approved, packageRun], ...(stdioAvailable === undefined ? {} : { stdioAvailable }) });
   const view = mountSources(f);
   const server = await screen.findByLabelText<HTMLSelectElement>("Server");
   expect([...server.options].map(option => option.text), String(stdioAvailable)).toEqual(expected);
   view.unmount();
  }
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
   if (input.method === "GET") return { status: 200, body: { servers: list, stdioAvailable: true } };
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
it("sends the server's token with the address, once, and offers package-run servers only when the install has them", async () => {
  const posts: ApiRequest[] = [];
  const f = fakeHost(async (input: ApiRequest) => {
   if (input.method === "GET") return { status: 200, body: { servers: [], stdioAvailable: false } };
   posts.push(input);return { status: 400, body: { error: { code: "CONFIG_INVALID", message: "The server asked for a login. Check the token." } } };
  });
  renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(McpServers) }) }));
  await screen.findByText("No MCP servers added yet.");
  expect(screen.queryByLabelText("Rovara runs a package for it")).toBeNull();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Tracker" } });
  fireEvent.change(screen.getByLabelText("Address"), { target: { value: "https://x.example/mcp" } });
  fireEvent.change(screen.getByLabelText("Token (optional)"), { target: { value: "srv-token" } });
  expect(screen.getByLabelText<HTMLInputElement>("Token (optional)").type).toBe("password");
  fireEvent.click(screen.getByRole("button", { name: "Test it" }));
  await screen.findByRole("alert");
  expect(posts[0]!.body).toEqual({ label: "Tracker", transport: { kind: "http", address: "https://x.example/mcp" }, secret: "srv-token" });
 });
 it("sends a package with an exact version for a server Rovara runs, and shows the fixed sentence when the test fails", async () => {
  const posts: ApiRequest[] = [];
  const f = fakeHost(async (input: ApiRequest) => {
   if (input.method === "GET") return { status: 200, body: { servers: [], stdioAvailable: true } };
   posts.push(input);return { status: 400, body: { error: { code: "CONFIG_INVALID", message: "The server did not answer in time." } } };
  });
  renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(McpServers) }) }));
  await screen.findByText("No MCP servers added yet.");
  fireEvent.click(screen.getByLabelText("Rovara runs a package for it"));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Wiki" } });
  // The package form is its own chunk (T9): it arrives a moment after the choice.
  fireEvent.change(await screen.findByLabelText("Package"), { target: { value: "@acme/wiki-mcp" } });
  fireEvent.change(screen.getByLabelText("Exact version"), { target: { value: "1.4.2" } });
  fireEvent.change(screen.getByLabelText("Arguments"), { target: { value: "--read-only  --lang en" } });
  fireEvent.click(screen.getByRole("button", { name: "Test it" }));
  expect((await screen.findByRole("alert")).textContent).toBe("The server did not answer in time.");
  expect(posts[0]!.body).toEqual({ label: "Wiki", transport: { kind: "stdio", spec: { registry: "npm", name: "@acme/wiki-mcp", version: "1.4.2", args: ["--read-only", "--lang", "en"] } } });
 });

 describe("T9: a server Rovara runs from a package", () => {
  const spec = { name: "@acme/wiki-mcp", version: "2.0.1", integrity: `sha512-${"A".repeat(86)}==`, args: ["--read-only"], bundleHash: "ab12cd34ef56".padEnd(64, "0"), lockfileHash: hash("1"), destinations: [{ host: "wiki.corp.example", port: 443 }], secretEnv: ["WIKI_TOKEN"], size: { cpu: 256, memoryMiB: 512 } };
  const waiting = { ...approved, serverId: "mcpwiki000001", label: "Wiki", status: "awaiting_approval", hasSecret: true, transport: { kind: "stdio", spec }, install: { packageCount: 42, unpackedBytes: 12 * 1_048_576 }, probe: { tools: [{ name: "lookup_page", description: "Look up", annotation: "read_only" }] } };
  function host(over: { list?: unknown[]; reply?: (input: ApiRequest) => ApiResponse; stdioAvailable?: boolean } = {}) {
   const posts: ApiRequest[] = [];
   const f = fakeHost(async (input: ApiRequest): Promise<ApiResponse> => {
    if (input.method === "GET") return { status: 200, body: { servers: over.list ?? [], stdioAvailable: over.stdioAvailable ?? true } };
    posts.push(input);
    return over.reply?.(input) ?? { status: 202, body: { status: "NEEDS_APPROVAL", server: waiting } };
   });
   return { ...f, posts };
  }
  const mount = (f: ReturnType<typeof host>) => renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(McpServers) }) }));
  async function choosePackage() {
   fireEvent.click(await screen.findByLabelText("Rovara runs a package for it"));
   fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Wiki" } });
   fireEvent.change(await screen.findByLabelText("Package"), { target: { value: "@acme/wiki-mcp" } });
   fireEvent.change(screen.getByLabelText("Exact version"), { target: { value: "2.0.1" } });
  }
  it("sends the addresses, the secret names and the values once, with the values in the password fields", async () => {
   const f = host();
   mount(f);
   await choosePackage();
   fireEvent.change(screen.getByLabelText("Addresses it talks to"), { target: { value: "Wiki.Corp.Example:443\n\n 10.2.3.4:8443 " } });
   fireEvent.change(screen.getByLabelText("Add a secret name"), { target: { value: "wiki_token" } });
   fireEvent.click(screen.getByRole("button", { name: "Add this secret" }));
   const value = screen.getByLabelText<HTMLInputElement>("Value of WIKI_TOKEN");
   expect(value.type).toBe("password");
   fireEvent.change(value, { target: { value: "tok-9f3a" } });
   fireEvent.click(screen.getByRole("button", { name: "Test it" }));
   await screen.findByRole("button", { name: "Allow this server" });
   expect(f.posts).toHaveLength(1);
   expect(f.posts[0]!.body).toEqual({
    label: "Wiki", secrets: { WIKI_TOKEN: "tok-9f3a" },
    transport: { kind: "stdio", spec: { registry: "npm", name: "@acme/wiki-mcp", version: "2.0.1", args: [], destinations: [{ host: "wiki.corp.example", port: 443 }, { host: "10.2.3.4", port: 8443 }], secretEnv: ["WIKI_TOKEN"] } },
   });
  });
  it("refuses an address line without a port and a secret name without a value, before anything is sent", async () => {
   const f = host();
   mount(f);
   await choosePackage();
   fireEvent.change(screen.getByLabelText("Addresses it talks to"), { target: { value: "wiki.corp.example" } });
   fireEvent.click(screen.getByRole("button", { name: "Test it" }));
   expect((await screen.findByRole("alert")).textContent).toMatch(/host name and a port/u);
   fireEvent.change(screen.getByLabelText("Addresses it talks to"), { target: { value: "" } });
   fireEvent.change(screen.getByLabelText("Add a secret name"), { target: { value: "JIRA_TOKEN" } });
   fireEvent.click(screen.getByRole("button", { name: "Add this secret" }));
   fireEvent.click(screen.getByRole("button", { name: "Test it" }));
   await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/value for each secret name/u));
   expect(f.posts).toEqual([]);
  });
  it("says what the wait is while it installs and tests, and shows the broker's fixed sentence when it fails", async () => {
   let release: (response: ApiResponse) => void = () => undefined;
   const f = fakeHost(async (input: ApiRequest): Promise<ApiResponse> => input.method === "GET" ? { status: 200, body: { servers: [], stdioAvailable: true } } : new Promise<ApiResponse>(resolve => { release = resolve; }));
   renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(McpServers) }) }));
   await choosePackage();
   fireEvent.click(screen.getByRole("button", { name: "Test it" }));
   expect((await screen.findByRole("status")).textContent).toMatch(/Installing the package \(about 1 to 2 minutes\)/u);
   release({ status: 400, body: { error: { code: "CONFIG_INVALID", message: "This package needs a git dependency. Rovara installs only from your registry." } } });
   expect((await screen.findByRole("alert")).textContent).toBe("This package needs a git dependency. Rovara installs only from your registry.");
   // the form is back, and the secret value is not kept anywhere on the page
   expect(screen.getByRole("button", { name: "Test it" })).toBeTruthy();
  });
  it("shows the card before allowing: package, count and size, the addresses, the secret names, the fingerprint and the short bundle hash; no secret value", async () => {
   const f = host({ list: [waiting] });
   mount(f);
   fireEvent.click(await screen.findByRole("button", { name: "Review" }));
   const card = await screen.findByRole("group", { name: "What Rovara will run" });
   const text = card.textContent;
   expect(text).toContain("@acme/wiki-mcp@2.0.1");
   expect(text).toContain("42 packages, 12 MB once unpacked");
   expect(text).toContain("wiki.corp.example:443");
   expect(text).toContain("WIKI_TOKEN");
   expect(text).toContain(spec.integrity);
   expect(text).toContain("ab12cd34ef56");
   expect(text).toMatch(/does not run install steps/u);
   expect(document.body.textContent).not.toContain("tok-9f3a");
  });
  it("says so when a server may reach no address and is given no secrets", async () => {
   const bare = { ...waiting, transport: { kind: "stdio", spec: { ...spec, destinations: [], secretEnv: [] } }, hasSecret: undefined, install: undefined };
   mount(host({ list: [bare] }));
   fireEvent.click(await screen.findByRole("button", { name: "Review" }));
   const card = await screen.findByRole("group", { name: "What Rovara will run" });
   expect(card.textContent).toContain("may not reach any address");
   expect(card.textContent).toContain("given no secrets");
  });
  it("starts a proposal for a newer version from an approved one: same package, addresses and secret names, a blank version and blank values; the old one keeps serving", async () => {
   const f = host({ list: [{ ...waiting, status: "approved" }] });
   mount(f);
   fireEvent.click(await screen.findByRole("button", { name: "Add a newer version" }));
   expect((await screen.findByLabelText<HTMLInputElement>("Package")).value).toBe("@acme/wiki-mcp");
   expect(screen.getByLabelText<HTMLInputElement>("Exact version").value).toBe("");
   expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Wiki");
   expect(screen.getByLabelText<HTMLTextAreaElement>("Addresses it talks to").value).toBe("wiki.corp.example:443");
   expect(screen.getByLabelText<HTMLInputElement>("Value of WIKI_TOKEN").value).toBe("");
   expect(f.posts).toEqual([]);
   // the approved entry is still listed as allowed
   expect(screen.getByText(/Allowed/)).toBeTruthy();
  });
  it("offers no 'newer version' button for an entry that must be added again, or where package-run servers are not available", async () => {
   const again = mount(host({ list: [{ ...waiting, status: "needs_reapproval" }] }));
   await screen.findByText(/Add it again to approve/);
   expect(screen.queryByRole("button", { name: "Add a newer version" })).toBeNull();
   again.unmount();
   mount(host({ list: [{ ...waiting, status: "approved" }], stdioAvailable: false }));
   await screen.findByText(/Allowed/);
   expect(screen.queryByRole("button", { name: "Add a newer version" })).toBeNull();
  });
  it("refuses a port that is not 1 to 65535, before anything is sent", async () => {
   const f = host();
   mount(f);
   await choosePackage();
   for (const line of ["wiki.corp.example:0", "wiki.corp.example:65536", "wiki.corp.example:443443"]) {
    fireEvent.change(screen.getByLabelText("Addresses it talks to"), { target: { value: line } });
    fireEvent.click(screen.getByRole("button", { name: "Test it" }));
    expect((await screen.findByRole("alert")).textContent, line).toMatch(/host name and a port/u);
   }
   fireEvent.change(screen.getByLabelText("Addresses it talks to"), { target: { value: "wiki.corp.example:1\nwiki.corp.example:65535" } });
   fireEvent.click(screen.getByRole("button", { name: "Test it" }));
   await screen.findByRole("button", { name: "Allow this server" });
   expect((f.posts[0]!.body as { transport: { spec: { destinations: unknown } } }).transport.spec.destinations).toEqual([{ host: "wiki.corp.example", port: 1 }, { host: "wiki.corp.example", port: 65_535 }]);
  });
  it("clears the typed secret values after a failed test, so a retry asks for them again", async () => {
   const f = host({ reply: () => ({ status: 400, body: { error: { code: "CONFIG_INVALID", message: "The server did not answer in time." } } }) });
   mount(f);
   await choosePackage();
   fireEvent.change(screen.getByLabelText("Add a secret name"), { target: { value: "JIRA_TOKEN" } });
   fireEvent.click(screen.getByRole("button", { name: "Add this secret" }));
   fireEvent.change(screen.getByLabelText("Value of JIRA_TOKEN"), { target: { value: "tok-7b" } });
   fireEvent.click(screen.getByRole("button", { name: "Test it" }));
   await screen.findByText("The server did not answer in time.");
   expect(f.posts[0]!.body).toMatchObject({ secrets: { JIRA_TOKEN: "tok-7b" } });
   expect(screen.getByLabelText<HTMLInputElement>("Value of JIRA_TOKEN").value).toBe("");
   expect(document.body.innerHTML).not.toContain("tok-7b");
  });
  it("words the wait by how long it has been: installing first, then testing", async () => {
   const { progressWords } = await import("../../packages/ui/src/screens/admin/connections/McpPackageServer.js");
   expect(progressWords(0)).toMatch(/^Installing the package/u);
   expect(progressWords(74)).toMatch(/^Installing the package/u);
   expect(progressWords(75)).toMatch(/^Testing it/u);
   expect(progressWords(400)).toMatch(/^Testing it/u);
  });
  it("keeps the package form out of the startup code: McpServers loads it only through a dynamic import, and imports only its type", async () => {
   const { readFileSync } = await import("node:fs");
   const source = readFileSync("packages/ui/src/screens/admin/connections/McpServers.tsx", "utf8");
   const staticImports = source.split("\n").filter(line => /^import /u.test(line) && line.includes("McpPackageServer"));
   expect(staticImports).toEqual(['import type { PackageDraft } from "./McpPackageServer.js";']);
   expect(source.match(/import\("\.\/McpPackageServer\.js"\)/gu)).toHaveLength(2);
  });
 });

 describe("T10: recent starts and a paused server", () => {
  const spec = { name: "@acme/wiki-mcp", version: "2.0.1", integrity: `sha512-${"A".repeat(86)}==`, args: [], bundleHash: hash("b"), lockfileHash: hash("1"), destinations: [], secretEnv: [], size: { cpu: 256, memoryMiB: 512 } };
  const wiki = { ...approved, serverId: "mcpwiki000001", label: "Wiki", transport: { kind: "stdio", spec } };
  const mount = (list: unknown[], activity?: unknown) => {
   const f = fakeHost(async (input: ApiRequest): Promise<ApiResponse> => input.method === "GET" ? { status: 200, body: { servers: list, stdioAvailable: true, ...(activity === undefined ? {} : { activity }) } } : { status: 200, body: {} });
   renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(McpServers) }) }));
   return f;
  };
  it("says how many times a package-run server started in the last day, when it last started, and how it last stopped", async () => {
   mount([wiki], { mcpwiki000001: { starts24h: 3, lastStartAt: "2026-11-01T10:00:00.000Z", lastStop: { at: "2026-11-01T10:30:00.000Z", reason: "idle" }, keepsStopping: false } });
   const line = await screen.findByText(/Recent starts: 3 in the last day/);
   expect(line.textContent).toMatch(/It stopped when it was idle\./u);
   expect(line.textContent).not.toMatch(/keeps stopping/u);
  });
  it("says so when it has not started, and warns when it keeps stopping", async () => {
   mount([wiki], { mcpwiki000001: { starts24h: 0, lastStop: { at: "2026-11-01T10:30:00.000Z", reason: "crash" }, keepsStopping: true } });
   const line = await screen.findByText(/Recent starts: none in the last day/);
   expect(line.textContent).toMatch(/This server keeps stopping\. Rovara has paused starting it for a while\./u);
   expect(line.textContent).toMatch(/It stopped unexpectedly\./u);
  });
  it("shows no recent-starts line for an address-server or a server with no events", async () => {
   mount([approved, wiki], { mcpsim000001: { starts24h: 9, keepsStopping: false } });
   await screen.findByText("Wiki");
   expect(screen.queryByText(/Recent starts/)).toBeNull();
  });
  it("says a paused server's tools changed, offers to look again with the same version, and can turn it off", async () => {
   const f = mount([{ ...wiki, status: "changed_needs_review" }]);
   await screen.findByText(/Paused: its tools changed/);
   expect(screen.getByText(/Its tools are not the ones you allowed/)).toBeTruthy();
   expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
   fireEvent.click(screen.getByRole("button", { name: "Look at it again" }));
   expect((await screen.findByLabelText<HTMLInputElement>("Exact version")).value).toBe("2.0.1");
   expect(screen.getByLabelText<HTMLInputElement>("Package").value).toBe("@acme/wiki-mcp");
   fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
   await waitFor(() => expect(f.request.mock.calls.some(([request]) => (request).path.endsWith("/disable"))).toBe(true));
  });
 });
});
