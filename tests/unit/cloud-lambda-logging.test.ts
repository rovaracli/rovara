// Exercise the deployed entry's handler options, including its default console logger, without AWS or network calls.
import { expect, it, vi } from "vitest";
import type * as CloudServer from "../../packages/cloud-server/src/index.js";
import { DynamoSessionStore, DynamoWorkSessionStore, type CodeSession } from "../../packages/cloud-server/src/index.js";
import { handler } from "../../scripts/cloud-lambda.js";

vi.mock("../../packages/cloud-server/src/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof CloudServer>();
  return { ...actual, cloudConfigReader: () => async () => ({ origin: "https://cloud.example.test", clientSecret: "test-secret" }) };
});

it("logs only schema field names through the Lambda entry when no logger is supplied", async () => {
  vi.stubEnv("CLOUD_TABLE", "test-table");
  vi.stubEnv("CLOUD_ORIGIN_PARAMETER", "/test/origin");
  vi.stubEnv("CLOUD_CLIENT_SECRET_ID", "test-secret-id");
  vi.stubEnv("CLOUD_SESSIONS_KEY_ID", "test-key-id");
  vi.stubEnv("CLOUD_APP_DIRECTORY", "/nowhere");
  vi.stubEnv("ROVARA_CODE_URL", "https://code.example.test");
  for (const key of ["COMPANY_TABLE", "CLOUD_PRODUCT_KEYS_TABLE", "CLOUD_PRODUCT_KEYS_KEY", "CLOUD_PRODUCT_KEYS_MAC_KEY", "CLOUD_AI_SOURCE_KINDS", "CLOUD_ROVARA_AI_EXEMPT"]) vi.stubEnv(key, "");
  const access: CodeSession["access"] = { developerId: "a".repeat(64), displayName: "PRIVATE_PERSON", administrator: false, projects: [{ name: "private-project", access: "administrator" }], notices: [] };
  vi.spyOn(DynamoSessionStore.prototype, "get").mockResolvedValue({ accessToken: "test-token", csrf: "test-csrf", signedInAt: "2026-11-19T00:00:00Z", access });
  vi.spyOn(DynamoWorkSessionStore.prototype, "startedBy").mockResolvedValue([]);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if (path === "/v1/dev/access") return Response.json(access);
    if (path === "/v1/dev/client/projects/private-project") return Response.json({ name: "private-project", latestRevision: 0, repositories: [] });
    throw new Error("Unexpected request in Lambda test");
  }));
  const logged = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const result = await handler({ rawPath: "/v1/web/projects/private-project/overview", cookies: ["rovara_cloud_session=test-session"], requestContext: { http: { method: "GET" } } });
    expect(result.statusCode).toBe(200);
    expect(logged.mock.calls).toEqual([[JSON.stringify({ event: "cloud.response_shape_failure", fields: ["project"] })]]);
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); }
});
