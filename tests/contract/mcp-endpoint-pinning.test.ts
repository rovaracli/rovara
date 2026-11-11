// Plan 3 Task 19 (Task 12b's hard acceptance item): before every MCP request the transport checks the endpoint again (`checkEndpointUrl`) and then connects
// only to the addresses that check returned, through a pinned lookup. A host that re-resolves to a private address between the check and the connection
// is therefore never reached, and one that already resolves there at the next request is refused by the next check.
import { createServer } from "node:http";
import { once } from "node:events";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { connectMcp } from "@agentx/gateway";
import { guardedConnect, mcpEndpointGuard, pinnedFetch, pinnedLookup } from "../../packages/broker/src/connections/pinned-endpoint.js";
import { mcpConnectorType } from "../../packages/broker/src/aws/connector-presets.js";
import { linearConnectorType } from "../../packages/broker/src/aws/linear-connector-type.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { readBrokerSource } from "../support/broker-source.js";

beforeAll(async () => { await loadSlackBroker(); }, 60_000);

const ENDPOINT = new URL("https://mcp.acme.dev/mcp");
const PUBLIC = "52.1.2.3";
const lookupOf = (addresses: readonly string[]) => (options?: object) => new Promise<unknown>((resolve) => { (pinnedLookup(addresses) as (host: string, options: object | undefined, callback: (...args: unknown[]) => void) => void)("anything.test", options, (...args: unknown[]) => resolve(args)); });

describe("pinnedLookup", () => {
  it("answers with the checked addresses whatever name it is asked for, in both shapes node uses", async () => {
    expect(await lookupOf([PUBLIC])({ all: true })).toEqual([null, [{ address: PUBLIC, family: 4 }]]);
    expect(await lookupOf([PUBLIC])({})).toEqual([null, PUBLIC, 4]);
    expect(await lookupOf(["2001:4860:4860::8888", PUBLIC])({ all: true })).toEqual([null, [{ address: "2001:4860:4860::8888", family: 6 }, { address: PUBLIC, family: 4 }]]);
  });

  it("keeps to the family asked for, and fails when no checked address has it", async () => {
    expect(await lookupOf(["2001:4860:4860::8888", PUBLIC])({ family: 4 })).toEqual([null, PUBLIC, 4]);
    const [error] = await lookupOf([PUBLIC])({ family: 6 }) as [Error];
    expect(error).toBeInstanceOf(Error);
  });

  it("refuses to be built with nothing, or with something that is not an address", () => {
    expect(() => pinnedLookup([])).toThrow();
    expect(() => pinnedLookup(["not-an-address"])).toThrow();
  });
});

describe("pinnedFetch", () => {
  it("connects to the address it was given even though the name is not one anything resolves", async () => {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => { response.writeHead(200, { "content-type": "text/plain", "x-seen-host": String(request.headers.host) }).end(`${String(request.method)} ${String(request.url)} ${String(request.headers["content-type"])} ${body}`); });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
      // Which addresses are public is the guard's job (`mcpEndpointGuard`); the fetch itself only pins. 127.0.0.1 stands in for the checked address here.
      const fetchPinned = pinnedFetch(["127.0.0.1"]);
      const response = await fetchPinned(`http://never-resolves.invalid:${port}/path?q=1`, { method: "POST", body: "hello", headers: { "content-type": "text/plain" } });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("POST /path?q=1 text/plain hello");
      expect(response.headers.get("x-seen-host")).toBe(`never-resolves.invalid:${port}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("hands node's request the pinned lookup, so a name that resolves to a private address now is never asked", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const request = vi.fn((url: URL, options: Record<string, unknown>) => { seen.push(options); throw new Error("stop before any network"); });
    const fetchPinned = pinnedFetch([PUBLIC], { request: request as never });
    await expect(fetchPinned("https://mcp.acme.dev/mcp", { method: "POST", body: "{}" })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    const lookup = seen[0]!.lookup as (host: string, options: object, callback: (...args: unknown[]) => void) => void;
    const answer = await new Promise<unknown[]>((resolve) => lookup("mcp.acme.dev", { all: true }, (...args) => resolve(args)));
    expect(answer).toEqual([null, [{ address: PUBLIC, family: 4 }]]);
    // No agent that could reuse a connection made to somewhere else, and no redirect following.
    expect(seen[0]!.agent).toBe(false);
  });

  it("refuses a URL with a login whether or not it is held to an origin, making no connection (review A-M1)", async () => {
    const request = vi.fn(() => { throw new Error("stop before any network"); });
    await expect(pinnedFetch([PUBLIC], { request: request })("https://user:pw@mcp.acme.dev/mcp")).rejects.toThrow(/login/u);
    await expect(pinnedFetch([PUBLIC], { request: request, origin: "https://mcp.acme.dev" })("https://user:pw@mcp.acme.dev/mcp")).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a redirect instead of following it", async () => {
    const server = createServer((_request, response) => { response.writeHead(302, { location: "http://169.254.169.254/" }).end(); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
      await expect(pinnedFetch(["127.0.0.1"])(`http://x.invalid:${port}/`, { redirect: "error" })).rejects.toThrow(/redirect/u);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("ends the request when the caller's signal does", async () => {
    const server = createServer(() => undefined);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
      const controller = new AbortController();
      const pending = pinnedFetch(["127.0.0.1"])(`http://x.invalid:${port}/`, { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("mcpEndpointGuard", () => {
  it("checks the endpoint on every request, and refuses one that now resolves to a private address", async () => {
    const answers: string[][] = [[PUBLIC], ["10.0.0.5"]];
    const resolveHost = vi.fn(async () => answers.shift() ?? ["10.0.0.5"]);
    const guard = mcpEndpointGuard({ resolveHost, request: vi.fn() as never });
    expect(typeof await guard(ENDPOINT)).toBe("function");
    await expect(guard(ENDPOINT)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("not a public address") as string });
    expect(resolveHost).toHaveBeenCalledTimes(2);
  });

  it("refuses an endpoint the check refuses before it resolves anything", async () => {
    const resolveHost = vi.fn(async () => [PUBLIC]);
    const guard = mcpEndpointGuard({ resolveHost });
    await expect(guard(new URL("http://mcp.acme.dev/mcp"))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(guard(new URL("https://10.0.0.5/mcp"))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("a host that re-resolves to 10.x between the check and the connection is not reached: the connection uses the checked address", async () => {
    let now: string[] = [PUBLIC];
    const resolveHost = async () => now;
    const used: string[] = [];
    const request = vi.fn((_url: URL, options: Record<string, unknown>) => {
      // The system resolver now says 10.0.0.5, as an attacker's DNS would after the check. The request's own lookup is what node connects with.
      now = ["10.0.0.5"];
      const lookup = options.lookup as (host: string, options: object, callback: (...args: unknown[]) => void) => void;
      lookup("mcp.acme.dev", {}, (_error: unknown, address: unknown) => { used.push(String(address)); });
      throw new Error("stop before any network");
    });
    const fetchPinned = await mcpEndpointGuard({ resolveHost, request: request as never })(ENDPOINT);
    await expect(fetchPinned(ENDPOINT, { method: "POST", body: "{}" })).rejects.toThrow();
    expect(used).toEqual([PUBLIC]);
    // The next request checks again, and is refused.
    await expect(mcpEndpointGuard({ resolveHost })(ENDPOINT)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("the guard's fetch holds every request to the checked endpoint", () => {
  const guarded = async (request: unknown) => mcpEndpointGuard({ resolveHost: async () => [PUBLIC], request: request as never })(ENDPOINT);

  it("sends a request to the endpoint's own origin, on any path", async () => {
    const request = vi.fn(() => { throw new Error("stop before any network"); });
    await expect((await guarded(request))("https://mcp.acme.dev/other/path", { method: "POST", body: "{}" })).rejects.toThrow("stop before any network");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an IP literal", "https://127.0.0.1/mcp"], ["an IP literal in IPv6", "https://[::1]/mcp"], ["plain http", "http://mcp.acme.dev/mcp"],
    ["another host", "https://other.acme.dev/mcp"], ["another port", "https://mcp.acme.dev:8443/mcp"], ["a host that only starts like it", "https://mcp.acme.dev.evil.test/mcp"],
    ["a username and password (review A-M1: the origin ignores them, and node would send them as a Basic header)", "https://user:pw@mcp.acme.dev/mcp"],
    ["a username alone", "https://user@mcp.acme.dev/mcp"],
  ])("refuses %s and never opens a connection", async (_label, url) => {
    const request = vi.fn();
    await expect((await guarded(request))(url, { method: "POST", body: "{}" })).rejects.toThrow(/endpoint/u);
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a local server by IP literal even when the pin is to a public address (the probe from the review)", async () => {
    const hits: string[] = [];
    const server = createServer((request, response) => { hits.push(String(request.url)); response.end("reached"); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
      await expect((await guarded(undefined))(`http://127.0.0.1:${port}/`)).rejects.toThrow(/endpoint/u);
      expect(hits).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("the headers a pinned fetch forwards", () => {
  it("drops host, connection and transfer-encoding, and keeps the rest", async () => {
    const seen: Array<Record<string, string>> = [];
    const request = vi.fn((_url: URL, options: Record<string, unknown>) => { seen.push(options.headers as Record<string, string>); throw new Error("stop before any network"); });
    const fetchPinned = pinnedFetch([PUBLIC], { request: request as never });
    await expect(fetchPinned("https://mcp.acme.dev/mcp", {
      method: "POST", body: "{}", headers: { Host: "evil.internal", Connection: "keep-alive", "Transfer-Encoding": "chunked", "X-Keep": "1", Authorization: "Bearer t" },
    })).rejects.toThrow();
    expect(Object.keys(seen[0]!).sort()).toEqual(["authorization", "content-length", "x-keep"]);
  });
});

describe("guardedConnect", () => {
  const input = (endpoint = ENDPOINT) => ({ endpoint, token: "t", tools: ["a"], signal: new AbortController().signal }) as Parameters<typeof connectMcp>[0];

  it("runs the guard before every connection and hands the connection the pinned fetch", async () => {
    const pinned = vi.fn() as unknown as typeof fetch;
    const guard = vi.fn(async () => pinned);
    const base = vi.fn(async () => ({ tools: [], call: vi.fn(), close: vi.fn() })) as unknown as typeof connectMcp;
    const connect = guardedConnect(base, guard);
    await connect(input());
    await connect(input());
    expect(guard).toHaveBeenCalledTimes(2);
    expect(base).toHaveBeenCalledTimes(2);
    expect(vi.mocked(base).mock.calls[0]![0]).toMatchObject({ endpoint: ENDPOINT, fetchImplementation: pinned });
  });

  it("does not connect when the guard refuses", async () => {
    const base = vi.fn() as unknown as typeof connectMcp;
    const connect = guardedConnect(base, async () => { throw new Error("refused"); });
    await expect(connect(input())).rejects.toThrow("refused");
    expect(base).not.toHaveBeenCalled();
  });
});

describe("the MCP connector type", () => {
  const project = { name: "payments", revision: 1, repositories: [], setup: [], readiness: [], orchestratorInstructions: "x" } as never;
  const mcpConfig = {
    name: "sentry", type: "mcp", endpoint: "https://mcp.acme.dev/mcp", label: "Sentry issues", vendor: "Sentry", credentialRef: "sentry-key",
    scopes: [{ alias: "web", values: { project: "web" } }], scoping: { mode: "credential", acknowledgeUnscopedWrites: true }, tools: [{ name: "get_issue", access: "read" }],
  };

  it("connects through the guard when the broker has one, and through its own connect otherwise", async () => {
    const base = vi.fn(async () => ({ tools: [], call: vi.fn(), close: vi.fn() })) as unknown as typeof connectMcp;
    const refusing = vi.fn(async () => { throw new Error("refused"); });
    const guarded = mcpConnectorType.resolve(mcpConfig, project, { connect: base, endpointGuard: refusing });
    expect(guarded).not.toHaveProperty("unusable");
    if ("unusable" in guarded) return;
    await expect(guarded.connect!({ endpoint: ENDPOINT, token: "t", tools: [], signal: new AbortController().signal })).rejects.toThrow("refused");
    expect(base).not.toHaveBeenCalled();
    const plain = mcpConnectorType.resolve(mcpConfig, project, { connect: base });
    if ("unusable" in plain) throw new Error("unusable");
    expect(plain.connect).toBe(base);
  });

  it("leaves Linear's vendor-owned endpoint alone", () => {
    const linear = linearConnectorType.resolve({ name: "linear", type: "linear", credentialRef: "linear-key", scopes: [{ alias: "team", teamId: "c408e946-78aa-4db8-923e-f78053dd954f" }], tools: [{ name: "get_issue", access: "read" }] }, project, { endpointGuard: vi.fn() });
    if ("unusable" in linear) throw new Error("unusable");
    expect(linear.connect).toBeUndefined();
  });

  it("the production broker puts the guard on every request to a company's endpoint on Rovara Cloud", async () => {
    const source = readBrokerSource();
    expect(source).toContain("...(cloudOrgResolver === undefined ? {} : { mcpEndpointGuard: mcpEndpointGuard() }),");
  });

  it("the broker hands every connector type its endpoint guard", async () => {
    const { connectorTypeContext } = await import("../../packages/broker/src/aws/broker.js");
    const guard = vi.fn();
    const context = connectorTypeContext({ mcpEndpointGuard: guard }, undefined, async () => ({ system: "install" }));
    expect(context.endpointGuard).toBe(guard);
    expect(connectorTypeContext({}, undefined, async () => ({ system: "install" })).endpointGuard).toBeUndefined();
  });
});
