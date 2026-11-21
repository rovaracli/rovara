import { expect, it } from "vitest";
import { CodeClient, type CodeSession } from "../../packages/cloud-server/src/index.js";
it.each([200, 202, 204])("unreadable Code %s cannot become a successful Cloud write even when an adapter ignores the body", async status => {
 let writes = 0;
 const client = new CodeClient({ baseUrl: "https://code.example.test", clientId: "synthetic", clientSecret: "synthetic", redirectUri: "https://cloud.example.test/callback", scopes: "", fetch: async () => { writes += 1; return new Response(status === 204 ? null : "not JSON", { status }); } });
 const session: CodeSession = { accessToken: "synthetic", csrf: "csrf", signedInAt: new Date().toISOString(), access: { developerId: "a".repeat(64), displayName: "Ada", administrator: false, projects: [], notices: [] } };
 await expect(client.json(session, "/v1/app/change", { method: "POST" })).rejects.toMatchObject({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE" } } });
 expect(writes).toBe(1);
});
