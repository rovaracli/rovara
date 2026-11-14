// TE-F1e "required test: no request reaches a real model host". The function's transport runs here with a DENY-BY-DEFAULT request stub: the only destination it may open is the CHECKED address of the row's host;
// anything else fails the test. A host that resolves to a private, loopback, link-local, shared or IPv4-mapped address is refused before any connection; the TLS name is the row's host; a redirect is handed back
// unfollowed; the answer and the time are bounded. (Secrets Manager, STS and DynamoDB are fakes in the other files and never use this transport.)
import { EventEmitter } from "node:events";
import type https from "node:https";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { OutboundRequest } from "@rovara-code/contracts";
import { EgressSsrfError, EgressUnreachableError, createCloudProviderTransport } from "../../packages/broker/src/product-ai/provider-transport.js";

const PUBLIC = "203.0.113.200".replace("203.0.113", "34.117.59"); // a public address (not a documentation range: those are forbidden by the core)
const request = (over: Partial<OutboundRequest> = {}): OutboundRequest => ({ host: "api.openai.com", method: "POST", path: "/v1/chat/completions", query: "", headers: [["content-type", "application/json"]], body: new TextEncoder().encode("{}"), ...over });

interface Opened { host: string; port: number; servername: string; path: string; headers: Record<string, string>; rejectUnauthorized: boolean }
/** A deny-by-default https.request: it records the destination and fails the test for anything but the checked address of the row's host. */
function stub(allowed: string, answer: { status: number; headers?: Record<string, string>; chunks?: string[]; hang?: boolean } = { status: 200, chunks: ["{}"] }) {
  const opened: Opened[] = [];
  const request = ((options: Opened, onResponse: (response: unknown) => void) => {
    opened.push(options);
    if (options.host !== allowed || options.port !== 443) throw new Error(`a connection to ${options.host}:${options.port} was attempted`);
    const call = new EventEmitter() as EventEmitter & { end(body: Buffer): void; destroy(): void };
    call.destroy = () => { call.emit("error", new Error("destroyed")); call.emit("close"); };
    call.end = () => {
      if (answer.hang === true) return;
      const body = Readable.from((answer.chunks ?? []).map((chunk) => Buffer.from(chunk))) as Readable & { statusCode?: number; headers?: Record<string, string> };
      body.statusCode = answer.status;
      body.headers = answer.headers ?? { "content-type": "application/json" };
      queueMicrotask(() => { onResponse(body); call.emit("close"); });
    };
    return call;
  }) as unknown as typeof https.request;
  return { request, opened };
}

describe("ProductModelEgress transport", () => {
  it("connects only to the checked address of the row's host, with the host as the TLS name and the certificate verified", async () => {
    const lookups: string[] = [];
    const { request: httpsRequest, opened } = stub(PUBLIC);
    const transport = createCloudProviderTransport({ lookup: async (name) => { lookups.push(name); return [PUBLIC]; }, request: httpsRequest });
    const answer = await transport(request({ query: "a=1" }));
    expect(answer.status).toBe(200);
    expect(lookups).toEqual(["api.openai.com."]);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ host: PUBLIC, port: 443, servername: "api.openai.com", path: "/v1/chat/completions?a=1", rejectUnauthorized: true });
    expect(opened[0]!.headers.host).toBe("api.openai.com");
  });

  it("refuses, before any connection, every answer holding a private, loopback, link-local, shared, reserved or IPv4-mapped address", async () => {
    for (const bad of [["127.0.0.1"], ["10.0.0.5"], ["169.254.169.254"], ["100.64.0.1"], ["172.16.0.1"], ["192.168.1.1"], ["::1"], ["::ffff:34.117.59.200"], ["fe80::1"], ["fd00::1"], [PUBLIC, "127.0.0.1"], []]) {
      const { request: httpsRequest, opened } = stub(PUBLIC);
      const transport = createCloudProviderTransport({ lookup: async () => bad, request: httpsRequest });
      await expect(transport(request()), bad.join(",")).rejects.toBeInstanceOf(EgressSsrfError);
      expect(opened, bad.join(",")).toHaveLength(0);
    }
  });

  it("refuses a host that is an address, has no dot, or is under an AWS or a denied suffix, without even resolving it", async () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]", "2130706433", "lambda.us-west-2.amazonaws.com", "x.lambda-url.us-west-2.on.aws", "api.openai.com.", "evil.rovara.example"]) {
      let resolved = false;
      const { request: httpsRequest, opened } = stub(PUBLIC);
      const transport = createCloudProviderTransport({ lookup: async () => { resolved = true; return [PUBLIC]; }, request: httpsRequest, denySuffixes: ["rovara.example"] });
      await expect(transport(request({ host })), host).rejects.toBeInstanceOf(EgressSsrfError);
      expect(resolved, host).toBe(false);
      expect(opened, host).toHaveLength(0);
    }
  });

  it("hands a redirect back unfollowed (one connection, the 3xx as it came)", async () => {
    const { request: httpsRequest, opened } = stub(PUBLIC, { status: 302, headers: { location: "http://169.254.169.254/latest" }, chunks: [] });
    const transport = createCloudProviderTransport({ lookup: async () => [PUBLIC], request: httpsRequest });
    const answer = await transport(request());
    expect(answer.status).toBe(302);
    expect(opened).toHaveLength(1);
  });

  it("stops reading past the response limit, and a resolver failure or a hang is a fixed unreachable error", async () => {
    const big = stub(PUBLIC, { status: 200, chunks: ["x".repeat(600), "y".repeat(600)] });
    const answer = await createCloudProviderTransport({ lookup: async () => [PUBLIC], request: big.request, responseBytesMax: 1000 })(request());
    const read = async () => { for await (const part of answer.body) void part; };
    await expect(read()).rejects.toBeInstanceOf(EgressUnreachableError);
    await expect(createCloudProviderTransport({ lookup: async () => { throw new Error("ENOTFOUND api.openai.com secret-ish detail"); }, request: big.request })(request())).rejects.toThrow(/^the provider could not be reached$/u);
    const hang = stub(PUBLIC, { status: 200, hang: true });
    await expect(createCloudProviderTransport({ lookup: async () => [PUBLIC], request: hang.request, totalMs: 20 })(request())).rejects.toBeInstanceOf(EgressUnreachableError);
  });
});
