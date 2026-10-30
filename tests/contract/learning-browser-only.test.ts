// v1.2 learning loop: learning writes (Remember, Forget, Accept, Dismiss, Reopen, Remove) are browser-only. A bearer-token call is refused by the real dispatcher before authentication or any
// table read; reads stay as they are.
import { describe, expect, it } from "vitest";
import { projectLearningKey, type OrgId } from "../../packages/contracts/src/index.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const WRITES: Array<[string, string]> = [
  ["GET", "learning"],
  ["POST", "learning/remember"],
  ["POST", "learning/corrections/c1/forget"],
  ["POST", "learning/suggestions/s1/accept"],
  ["POST", "learning/suggestions/s1/dismiss"],
  ["POST", "learning/dismissed/0123456789abcdef0123456789abcdef/reopen"],
  ["POST", "learning/rules/r1/remove"],
];

describe("learning writes need a live browser session", () => {
  it("refuses a bearer-token call to each write before authentication or any table read", async () => {
    const { loadSlackBroker } = await import("../support/slack-broker.js");
    await loadSlackBroker();
    const { routeDeveloperRequest } = await import("../../packages/broker/src/aws/developer-routes.js");
    const db = new FakeDynamoDb();
    for (const [method, path] of WRITES) {
      const request = { method, headers: { authorization: "Bearer never-authenticate-this" }, body: "{}" };
      await expect(routeDeveloperRequest({ documentClient: db } as never, request as never, new URL(`/v1/app/projects/web/${path}`, "https://app.example.test"))).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("live browser session") as unknown });
    }
    expect(db.commandNames()).toEqual([]);
  });

  it("gives the same refusal for an id that exists and one that does not, with no read", async () => {
    const { loadSlackBroker } = await import("../support/slack-broker.js");
    await loadSlackBroker();
    const { routeDeveloperRequest } = await import("../../packages/broker/src/aws/developer-routes.js");
    const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
    const db = new FakeDynamoDb();
    db.set({ ...projectLearningKey(ORG, "web", "SUGGESTION#real"), id: "real", status: "open" });
    db.set({ ...projectLearningKey(ORG, "web", "RULE#real"), id: "real", status: "active" });
    const answers: string[] = [];
    for (const id of ["real", "missing"]) {
      for (const path of [`learning/suggestions/${id}/accept`, `learning/rules/${id}/remove`, `learning/suggestions/${id}/dismiss`]) {
        const request = { method: "POST", headers: { authorization: "Bearer x" }, body: "{}" };
        answers.push(await routeDeveloperRequest({ documentClient: db } as never, request as never, new URL(`/v1/app/projects/web/${path}`, "https://app.example.test")).then(() => "answered", (error: { code?: string; message?: string }) => `${String(error.code)}:${String(error.message)}`));
      }
    }
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toMatch(/^FORBIDDEN:/);
    expect(db.commandNames()).toEqual([]);
  });

  it("refuses a bearer-token read (GET /learning) too, before any table read, and lets a browser session through the guard", async () => {
    const { loadSlackBroker } = await import("../support/slack-broker.js");
    await loadSlackBroker();
    const { routeDeveloperRequest } = await import("../../packages/broker/src/aws/developer-routes.js");
    const db = new FakeDynamoDb();
    const request = { method: "GET", headers: { authorization: "Bearer x" }, body: "" };
    await expect(routeDeveloperRequest({ documentClient: db } as never, request as never, new URL("/v1/app/projects/web/learning", "https://app.example.test"))).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("live browser session") as unknown });
    expect(db.commandNames()).toEqual([]);
    const caller = { developerId: "a".repeat(64), sessionId: "s", amr: "oidc", name: "x", orgId: "org_aaaaaaaaaaaaaaaaaaaa", orgRole: "member", browserSession: true } as never;
    const passed = await routeDeveloperRequest({ documentClient: db, tableName: "state", now: () => 1 } as never, request as never, new URL("/v1/app/projects/web/learning", "https://app.example.test"), { caller, csrf: "x" }).then(() => "answered", (error: { message?: string }) => String(error.message));
    expect(passed).not.toContain("live browser session");
  });
});
