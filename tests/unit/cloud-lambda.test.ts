// Rovara Cloud on Lambda (PrepLabsAI/Rovara-cloud#11): the function URL's request and answer as Cloud's handler reads and writes them,
// and the address and client secret it reads at run time.
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { describe, expect, it } from "vitest";
import { CONFIG_TTL_MS, cloudConfigReader } from "../../packages/cloud-server/src/index.js";
import { cloudRequest, functionUrlResult, handler, type FunctionUrlEvent } from "../../scripts/cloud-lambda.js";

const event = (over: Partial<FunctionUrlEvent> & { method?: string } = {}): FunctionUrlEvent => ({
  rawPath: over.rawPath ?? "/v1/web/me", rawQueryString: over.rawQueryString ?? "", headers: over.headers ?? {},
  ...(over.cookies === undefined ? {} : { cookies: over.cookies }), ...(over.body === undefined ? {} : { body: over.body }),
  ...(over.isBase64Encoded === undefined ? {} : { isBase64Encoded: over.isBase64Encoded }), requestContext: { http: { method: over.method ?? "GET" } },
});

describe("the function URL's request and answer", () => {
  it("puts the cookies back in one cookie header, keeps the query, and lower-cases header names", () => {
    const request = cloudRequest(event({ cookies: ["rovara_session=abc", "other=1"], rawQueryString: "return_to=%2Fapp&x=1", headers: { "X-Rovara-CSRF": "t" } }));
    expect(request.headers.cookie).toBe("rovara_session=abc; other=1");
    expect(request.headers["x-rovara-csrf"]).toBe("t");
    expect(request.query.get("return_to")).toBe("/app");
  });

  it("decodes a base64 body, and drops a body on GET", () => {
    expect(cloudRequest(event({ method: "POST", body: Buffer.from('{"a":1}').toString("base64"), isBase64Encoded: true })).body).toBe('{"a":1}');
    expect(cloudRequest(event({ method: "POST", body: '{"a":1}' })).body).toBe('{"a":1}');
    expect(cloudRequest(event({ method: "GET", body: "ignored" }))).not.toHaveProperty("body");
  });

  it("answers Set-Cookie in `cookies`, as payload 2.0 wants, and every other header as it is", () => {
    const result = functionUrlResult({ status: 302, headers: { location: "/app", "set-cookie": "rovara_session=abc; HttpOnly; Secure" }, body: "" });
    expect(result).toEqual({ statusCode: 302, headers: { location: "/app" }, cookies: ["rovara_session=abc; HttpOnly; Secure"], body: "" });
    expect(functionUrlResult({ status: 200, headers: { "content-type": "application/json" }, body: "{}" })).not.toHaveProperty("cookies");
  });

  it("sends / to the app without reading any configuration", async () => {
    Object.assign(process.env, { CLOUD_TABLE: "t", CLOUD_ORIGIN_PARAMETER: "/p", CLOUD_CLIENT_SECRET_ID: "s", CLOUD_SESSIONS_KEY_ID: "k", CLOUD_APP_DIRECTORY: "/nowhere", ROVARA_CODE_URL: "https://code.example.test" });
    expect(await handler(event({ rawPath: "/" }))).toEqual({ statusCode: 302, headers: { location: "/app", "cache-control": "no-store" }, body: "" });
  });
});

describe("the address and secret read at run time", () => {
  const source = { originParameter: "/rovara-cloud/production/web/origin", clientSecretId: "rovara-cloud/production/code-client-secret" };
  const fakes = (origin: string, secret: string) => {
    const reads = { ssm: 0, secrets: 0 };
    const values = { origin, secret };
    const clock = { ms: 0 };
    const clients = {
      ssm: { send: async (command: unknown) => { expect(command).toBeInstanceOf(GetParameterCommand); reads.ssm += 1; return { Parameter: { Value: values.origin } }; } },
      secrets: { send: async (command: unknown) => { expect(command).toBeInstanceOf(GetSecretValueCommand); reads.secrets += 1; return { SecretString: values.secret }; } },
      now: () => clock.ms,
    } as unknown as Parameters<typeof cloudConfigReader>[1];
    return { reads, values, clock, read: cloudConfigReader(source, clients) };
  };

  it("reads once, shares the read with requests that arrive together, and reads again after five minutes", async () => {
    const { reads, values, clock, read } = fakes("https://d1.cloudfront.net/", " secret-1\n");
    const [a, b] = await Promise.all([read(), read()]);
    expect(a).toEqual({ origin: "https://d1.cloudfront.net", clientSecret: "secret-1" });
    expect(b).toEqual(a);
    expect(reads).toEqual({ ssm: 1, secrets: 1 });
    values.secret = "secret-2";
    clock.ms = CONFIG_TTL_MS - 1;
    expect((await read()).clientSecret).toBe("secret-1");
    clock.ms = CONFIG_TTL_MS;
    expect((await read()).clientSecret).toBe("secret-2");
    expect(reads).toEqual({ ssm: 2, secrets: 2 });
  });

  it("refuses an address that isn't https, and an empty secret", async () => {
    await expect(fakes("http://d1.cloudfront.net", "s").read()).rejects.toThrow(/https address/);
    await expect(fakes("https://d1.cloudfront.net/app", "s").read()).rejects.toThrow(/https address/);
    await expect(fakes("https://d1.cloudfront.net", "  ").read()).rejects.toThrow(/is empty/);
  });
});


describe("original-start reader raw request validation", () => {
  it.each([false, true])("preserves forbidden GET bodies through the production adapter (base64 %s)", async encoded => {
    const { httpWorld, confirmed, REQUEST } = await import("../support/server-read-http.js");
    const w = await httpWorld(confirmed);
    const adapted = cloudRequest(event({ rawPath: `/v1/web/task-start-requests/${REQUEST}`, method: "GET", cookies: ["rovara_cloud_session=cookie"], body: encoded ? Buffer.from("{}").toString("base64") : "{}", isBase64Encoded: encoded }));
    const result = await w.handler(adapted);
    expect(result?.status).toBe(400); expect(JSON.parse(result!.body)).toEqual({ error: { code: "CONFIG_INVALID", message: "That start request is invalid." } });
    expect(w.calls).toHaveLength(0);
  });
  it("rejects malformed body bytes with the fixed domain error before parsing", async () => {
    const { httpWorld, confirmed, REQUEST } = await import("../support/server-read-http.js");
    const w = await httpWorld(confirmed);
    const result = await w.handler({ method: "GET", path: `/v1/web/task-start-requests/${REQUEST}`, query: new URLSearchParams(), headers: { cookie: "rovara_cloud_session=cookie" }, body: "{" });
    expect(result?.status).toBe(400); expect(JSON.parse(result!.body)).toEqual({ error: { code: "CONFIG_INVALID", message: "That start request is invalid." } });
    expect(w.calls).toHaveLength(0);
  });
});
