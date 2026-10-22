// Plan 4 Task 13: the runtime every native connector shares. `nativeConnection` is an MCP connection whose tools run in the broker: it lists only the
// approved tools, validates every call's arguments against the tool's schema, and answers text of a bounded size. `vendorFetch` is the only way a tool
// reaches its vendor: one allowed host, https, no redirect, a bounded answer, and no credential in a failure. `safeLookup` refuses a non-public address when
// the connection is made. No test here reaches a network.
import { describe, expect, it, vi } from "vitest";
import { NativeToolRefusal, nativeConnection, type NativeTool } from "../../packages/broker/src/connectors/native/runtime.js";
import { VendorFetchError, safeLookup, safeVendorFetch, vendorFetch, vendorFetcher } from "../../packages/broker/src/connectors/native/vendor-fetch.js";

const TOKEN = "sntrys_VERYSECRETTOKEN0123456789";

const ROUTING = {
  properties: { organization: { type: "string", minLength: 1 }, projectSlug: { type: "string", minLength: 1 } },
  scopeOf: (values: Record<string, string>) => ({ organization: values["organization"]!, projectSlug: values["projectSlug"]! }),
};
type Scope = ReturnType<typeof ROUTING.scopeOf>;

const echo: NativeTool<Scope> = {
  name: "echo",
  description: "Echoes",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", maxLength: 10 },
      limit: { type: "integer", minimum: 1, maximum: 5 },
      mode: { type: "string", enum: ["a", "b"] },
      items: { type: "array", maxItems: 2, items: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } },
    },
    required: [],
    additionalProperties: false,
  },
  run: async (args, ctx) => ({ text: `echo ${JSON.stringify(args)} in ${ctx.scope.organization}/${ctx.scope.projectSlug}` }),
};
const big: NativeTool<Scope> = { name: "big", description: "Big", inputSchema: { type: "object", properties: {}, additionalProperties: false }, run: async () => ({ text: "x".repeat(50_000) }) };
const refusing: NativeTool<Scope> = { name: "refusing", description: "Refuses", inputSchema: { type: "object", properties: {}, additionalProperties: false }, run: async () => { throw new NativeToolRefusal("that issue is not in web"); } };
const failing: NativeTool<Scope> = { name: "failing", description: "Fails", inputSchema: { type: "object", properties: {}, additionalProperties: false }, run: async () => { throw new VendorFetchError("the vendor could not be reached"); } };
const crashing: NativeTool<Scope> = { name: "crashing", description: "Crashes", inputSchema: { type: "object", properties: {}, additionalProperties: false }, run: async () => { throw new Error(`boom with ${TOKEN}`); } };
const structured: NativeTool<Scope> = { name: "structured", description: "Structured", inputSchema: { type: "object", properties: {}, additionalProperties: false }, run: async () => ({ text: "two rows", structured: [{ id: 1 }, { id: 2 }] }) };
const ALL = [echo, big, refusing, failing, crashing, structured];
const SCOPE_ARGS = { organization: "acme", projectSlug: "web-app" };

function connection(approved: readonly string[], fetch: Parameters<typeof nativeConnection>[2]["fetch"] = vi.fn() as never) {
  return nativeConnection<Scope>(ALL, approved, { credential: { token: TOKEN, bindings: {} }, fetch, routing: ROUTING });
}
const textOf = (result: { content?: Array<{ text?: string | undefined }> | undefined }) => result.content?.map((entry) => entry.text ?? "").join("") ?? "";

describe("nativeConnection", () => {
  it("lists only the approved tools, each read-only, with the routing arguments required in its schema", () => {
    const listed = connection(["echo", "structured"]).tools;
    expect(listed.map((tool) => tool.name)).toEqual(["echo", "structured"]);
    for (const tool of listed) {
      expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect((tool.inputSchema["required"] as string[]).slice(0, 2).sort()).toEqual(["organization", "projectSlug"]);
      expect(Object.keys(tool.inputSchema["properties"] as object)).toEqual(expect.arrayContaining(["organization", "projectSlug"]));
    }
    expect(connection([]).tools).toEqual([]);
    expect(connection(["nothing-like-it"]).tools).toEqual([]);
  });

  it("refuses to call a tool that was not approved, even one the runtime has", async () => {
    await expect(connection(["echo"]).call("big", SCOPE_ARGS)).rejects.toThrow("MCP tool not allowed or unavailable");
  });

  it("refuses an extra argument with the exact text and makes no vendor request", async () => {
    const fetch = vi.fn();
    const result = await connection(["echo"], fetch as never).call("echo", { ...SCOPE_ARGS, text: "hi", url: "https://evil.example/" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("echo: url is not allowed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a wrong-typed, out-of-range, unlisted-value or over-long argument at its path, and a missing routing value", async () => {
    const call = (args: Record<string, unknown>) => connection(["echo"]).call("echo", { ...SCOPE_ARGS, ...args });
    for (const [args, path] of [
      [{ limit: "3" }, "limit"], [{ limit: 3.5 }, "limit"], [{ limit: 0 }, "limit"], [{ limit: 6 }, "limit"], [{ text: 5 }, "text"], [{ text: "x".repeat(11) }, "text"],
      [{ mode: "c" }, "mode"], [{ items: "a" }, "items"], [{ items: [{}, {}, {}] }, "items"], [{ items: [{ name: 1 }] }, "items.0.name"], [{ items: [{ name: "a", extra: 1 }] }, "items.0.extra"],
    ] as const) {
      const result = await call(args);
      expect(textOf(result), JSON.stringify(args)).toBe(`echo: ${path} is not allowed`);
      expect(result.isError).toBe(true);
    }
    const missing = await connection(["echo"]).call("echo", { organization: "acme" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe("echo: projectSlug is required");
    expect(textOf(await connection(["echo"]).call("echo", { organization: "acme", projectSlug: 7 }))).toBe("echo: projectSlug is not allowed");
  });

  it("runs a valid call with the routing values as its scope and the rest as its arguments", async () => {
    const result = await connection(["echo"]).call("echo", { ...SCOPE_ARGS, text: "hi", limit: 2, mode: "a", items: [{ name: "n" }] });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe('echo {"text":"hi","limit":2,"mode":"a","items":[{"name":"n"}]} in acme/web-app');
  });

  it("truncates a long answer to 32,768 characters with (truncated), and passes structured content", async () => {
    const text = textOf(await connection(["big"]).call("big", SCOPE_ARGS));
    expect(text).toHaveLength(32_768);
    expect(text.endsWith("(truncated)")).toBe(true);
    const result = await connection(["structured"]).call("structured", SCOPE_ARGS);
    expect(textOf(result)).toBe("two rows");
    expect(result.structuredContent).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("answers a tool's refusal as an error with its words, a vendor failure with its fixed words, and anything else without naming what was thrown", async () => {
    const refused = await connection(["refusing"]).call("refusing", SCOPE_ARGS);
    expect(refused).toMatchObject({ isError: true });
    expect(textOf(refused)).toBe("that issue is not in web");
    expect(textOf(await connection(["failing"]).call("failing", SCOPE_ARGS))).toBe("the vendor could not be reached");
    const crashed = await connection(["crashing"]).call("crashing", SCOPE_ARGS);
    expect(crashed.isError).toBe(true);
    expect(textOf(crashed)).toBe("crashing failed");
    expect(JSON.stringify(crashed)).not.toContain(TOKEN);
  });
});

/** A `fetch` stand-in that answers with `respond` and records how it was called. */
function fakeFetch(respond: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url: url.href, init });
    return respond(url, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("vendorFetch", () => {
  const HOSTS = ["us.sentry.io"];
  const URL_OK = "https://us.sentry.io/api/0/organizations/acme/";

  it("reads a JSON answer, sends the caller's headers, and holds the request to the fixed-origin fetch that never follows a redirect", async () => {
    const { fn, calls } = fakeFetch(() => new Response(JSON.stringify({ slug: "acme" }), { status: 200, headers: { "content-type": "application/json" } }));
    const response = await vendorFetch({ url: URL_OK, allowedHosts: HOSTS, headers: { authorization: `Bearer ${TOKEN}` }, fetch: fn });
    expect(response).toMatchObject({ status: 200, json: { slug: "acme" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.redirect).toBe("error");
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses a redirect to another host and does not follow it", async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }));
    await expect(vendorFetch({ url: URL_OK, allowedHosts: HOSTS, fetch: fn })).rejects.toThrow("the vendor answered with a redirect, which is refused");
    expect(calls.map((call) => new URL(call.url).hostname)).toEqual(["us.sentry.io"]);
    // A fetch that refuses redirects by throwing (as the real one does under redirect: "error") is the same refusal.
    const throwing = fakeFetch(() => { throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") }); });
    await expect(vendorFetch({ url: URL_OK, allowedHosts: HOSTS, fetch: throwing.fn })).rejects.toThrow("the vendor answered with a redirect, which is refused");
  });

  it("refuses a 2 MB answer, and one that is longer than it said", async () => {
    const { fn } = fakeFetch(() => new Response("x".repeat(2 * 1024 * 1024), { status: 200 }));
    await expect(vendorFetch({ url: URL_OK, allowedHosts: HOSTS, fetch: fn })).rejects.toThrow("the vendor answered with more than a connector reads");
    const small = fakeFetch(() => new Response("y".repeat(200), { status: 200 }));
    await expect(vendorFetch({ url: URL_OK, allowedHosts: HOSTS, maxBytes: 100, fetch: small.fn })).rejects.toThrow("more than a connector reads");
    expect((await vendorFetch({ url: URL_OK, allowedHosts: HOSTS, maxBytes: 200, fetch: small.fn })).text).toHaveLength(200);
  });

  it("refuses any host but the allowed ones, another scheme and a login, making no request", async () => {
    const { fn, calls } = fakeFetch(() => new Response("{}"));
    for (const url of ["https://evil.example/", "https://de.sentry.io/", "http://us.sentry.io/api/0/", "https://user:pw@us.sentry.io/api/0/", "https://169.254.169.254/", "not a url"]) {
      await expect(vendorFetch({ url, allowedHosts: HOSTS, fetch: fn }), url).rejects.toThrow("the request is not to an allowed vendor address");
    }
    expect(calls).toEqual([]);
  });

  it("names no token, header or URL in a failure, however the transport words it", async () => {
    const leaky = fakeFetch(() => { throw new Error(`connect failed to ${URL_OK}?token=${TOKEN} with Authorization: Bearer ${TOKEN}`); });
    const error = await vendorFetch({ url: `${URL_OK}?q=1`, allowedHosts: HOSTS, headers: { authorization: `Bearer ${TOKEN}` }, fetch: leaky.fn }).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(VendorFetchError);
    expect((error as Error).message).toBe("the vendor could not be reached");
    expect(JSON.stringify([(error as Error).message, (error as Error).name, (error as Error).toString()])).not.toContain(TOKEN);
  });

  it("gives up on a vendor that does not answer, with a fixed message", async () => {
    const hang = fakeFetch((_url, init) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error)); }));
    await expect(vendorFetch({ url: URL_OK, allowedHosts: HOSTS, timeoutMs: 20, fetch: hang.fn })).rejects.toThrow("the vendor did not answer in time");
  });

  it("vendorFetcher reads a path against its base, and reaches nothing else", async () => {
    const { fn, calls } = fakeFetch(() => new Response("[]", { status: 200 }));
    const fetcher = vendorFetcher({ base: new URL("https://us.sentry.io/api/0/"), fetch: fn, headers: { authorization: `Bearer ${TOKEN}` } });
    expect((await fetcher("organizations/acme/")).status).toBe(200);
    expect(calls[0]!.url).toBe("https://us.sentry.io/api/0/organizations/acme/");
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    await expect(fetcher("https://evil.example/x")).rejects.toThrow("not to an allowed vendor address");
    await expect(fetcher("//evil.example/x")).rejects.toThrow("not to an allowed vendor address");
    expect(calls).toHaveLength(1);
  });
});

/** Runs a node-style lookup and answers its callback arguments. */
const lookupWith = (addresses: string[] | Error, options: object = { all: true }) =>
  new Promise<unknown[]>((resolve) => {
    safeLookup(async () => { if (addresses instanceof Error) throw addresses; return addresses; })("vendor.example", options, ((...args: unknown[]) => resolve(args)));
  });

describe("safeLookup (rebinding, Review Focus 6)", () => {
  it("refuses 10.0.0.5, 169.254.169.254 and ::1 when the connection is made, and accepts 52.1.2.3", async () => {
    for (const address of ["10.0.0.5", "169.254.169.254", "::1", "127.0.0.1", "192.168.1.1", "172.16.0.1", "fd00::1", "100.64.0.1"]) {
      const [error] = await lookupWith([address]) as [Error & { code?: string }];
      expect(error, address).toBeInstanceOf(Error);
      expect(error.code).toBe("ECONNREFUSED");
      expect(error.message).not.toContain(address);
    }
    expect(await lookupWith(["52.1.2.3"])).toEqual([null, [{ address: "52.1.2.3", family: 4 }]]);
    expect(await lookupWith(["52.1.2.3"], {})).toEqual([null, "52.1.2.3", 4]);
  });

  it("refuses a name when any one of its addresses is not public, or it has none, or the lookup fails", async () => {
    const [mixed] = await lookupWith(["52.1.2.3", "10.0.0.5"]) as [Error];
    expect(mixed).toBeInstanceOf(Error);
    expect((await lookupWith([]))[0]).toBeInstanceOf(Error);
    const [failed] = await lookupWith(new Error("SERVFAIL for vendor.example")) as [Error & { code?: string }];
    expect(failed.code).toBe("ENOTFOUND");
    expect(failed.message).not.toContain("SERVFAIL");
  });

  it("is the lookup the default vendor fetch connects through, asked at connect time", async () => {
    const seen: Array<{ lookup: (host: string, options: object, callback: (...args: unknown[]) => void) => void }> = [];
    const request = vi.fn((_url: URL, options: never) => { seen.push(options); throw new Error("stop before any network"); });
    const resolveHost = vi.fn(async () => ["10.0.0.5"]);
    await expect(safeVendorFetch({ resolveHost, request: request as never })("https://us.sentry.io/api/0/")).rejects.toThrow();
    expect(resolveHost).not.toHaveBeenCalled();
    // Node asks the lookup when it connects; a name that resolves privately then is refused.
    const answer = await new Promise<unknown[]>((resolve) => seen[0]!.lookup("us.sentry.io", { all: true }, (...args) => resolve(args)));
    expect((answer[0] as Error).message).toContain("not public");
    expect(resolveHost).toHaveBeenCalledWith("us.sentry.io");
  });
});
