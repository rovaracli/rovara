import { expect, it } from "vitest";
import { sessionLink } from "@agentx/contracts";
import { createTaskWeb, type TaskDocumentView } from "../../packages/broker/src/aws/task-web.js";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { sessionWorld, PRIYA } from "../support/agent-session-world.js";
const id = "ses_aaaaaaaaaaaaaaaaaaaa", taskId = "11111111-1111-4111-8111-111111111111";
const view: TaskDocumentView = { taskId, title: "Fix refunds", status: "Running", nextStep: "Checks", path: "QUICK", stage: "Checks", role: "owner", documents: [], checks: [], findings: [], pullRequests: [], history: [] };
it("keeps the canonical share link pointing at the web shell", () => {
 expect(sessionLink("https://cell.example", id)).toBe("https://cell.example/s/" + id);
});
it("removes the broker's legacy session-link response even for a signed-out visitor", async () => {
 const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
 const response = await h.handler({ version: "2.0", routeKey: "ANY /s/{proxy+}", rawPath: "/s/" + id, rawQueryString: "", headers: { host: "cell.example" }, requestContext: { requestId: "shared-link", http: { method: "GET" } } });
 expect(response.statusCode).toBe(404);
});
it("links an existing task session from the task page and omits the link for legacy tasks", async () => {
 const caller = sessionWorld().caller(PRIYA);
 for (const exists of [true, false]) {
 const web = createTaskWeb({ authenticateSession: async () => caller, getTaskDocumentView: async () => ({ ...view, ...(exists ? { sessionId: id } : {}) }) });
 const path = "/review/" + taskId + "/task";
 const response = await web({ method: "GET", path, requestId: "task-link", headers: { cookie: "__Host-agentx_review_session=11111111-1111-4111-8111-111111111111" } }, new URL(path, "https://cell.example"));
 expect(response.statusCode).toBe(200);
 if (exists) expect(response.body).toContain('href="/s/' + id + '">Open this task in Rovara: its decisions are on cards there</a>');
 else expect(response.body).not.toContain("Open this task in Rovara: its decisions are on cards there");
 }
});

it("never turns an invalid session id into a task-page link", async () => {
 const caller = sessionWorld().caller(PRIYA), path = "/review/" + taskId + "/task";
 const web = createTaskWeb({ authenticateSession: async () => caller, getTaskDocumentView: async () => ({ ...view, sessionId: '"><script>alert(1)</script>' }) });
 const response = await web({ method: "GET", path, requestId: "task-link", headers: { cookie: "__Host-agentx_review_session=11111111-1111-4111-8111-111111111111" } }, new URL(path, "https://cell.example"));
 expect(response.body.includes("Open this task in Rovara: its decisions are on cards there")).toBe(false);
});
