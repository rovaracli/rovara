// Plan 5 Task 19 through the real broker: until Plan 6 supplies its HandoffRuntime the move route is reachable and answers RUNTIME_UNAVAILABLE with the plan's words, for the owner
// and for nobody else, whatever the body asks; nothing is started, cancelled or written. (The moves themselves are in agent-session-handoff.test.ts over Plan 6's seam.)
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { agentSessionKey } from "@rovara-code/contracts";
import { MAYA, OMAR, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

beforeAll(async () => { await loadSlackBroker(); });

describe("the move route in the real broker before Plan 6", () => {
  it("answers 503 RUNTIME_UNAVAILABLE with the exact text to the owner, for a move either way, and writes nothing", async () => {
    const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
    const started = await h.dev(MAYA, "POST", "/v1/app/agents/root-cause-analyst/runs", { requestId: randomUUID(), project: "payments", input: { text: "Why did checkout fail?" } });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const taskId = (started.body.task as { taskId: string }).taskId;
    const sessionId = (h.db.get(`DEVTASK#${taskId}`, "META") as { sessionId: string }).sessionId;
    const before = h.db.items.size;
    const toMac = await h.dev(MAYA, "POST", `/v1/app/sessions/${sessionId}/handoff`, { requestId: randomUUID(), to: "mac", deviceId: "dvc_0123456789abcdefghij" });
    expect(toMac.status).toBe(503);
    expect(toMac.body.error).toEqual({ code: "RUNTIME_UNAVAILABLE", message: "Moving a session between a Mac and the cloud isn't ready yet." });
    const toCloud = await h.dev(MAYA, "POST", `/v1/app/sessions/${sessionId}/handoff`, { requestId: randomUUID(), to: "cloud", repository: "acme/web", branch: "feat/x", headSha: "a".repeat(40), summary: "where it stands" });
    expect(toCloud.status).toBe(503);
    expect(toCloud.body.error).toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: "Moving a session between a Mac and the cloud isn't ready yet." });
    expect(h.db.items.size).toBe(before);
    expect(h.db.get(agentSessionKey(TEST_ORG, sessionId, "META"))).toMatchObject({ kind: "task", where: { kind: "cloud" }, revision: 1 });
    // Nobody else gets as far as the answer: a person who can't see the session is told it isn't there; a body that doesn't fit is refused before anything else.
    expect((await h.dev(OMAR, "POST", `/v1/app/sessions/${sessionId}/handoff`, { requestId: randomUUID(), to: "mac", deviceId: "dvc_0123456789abcdefghij" })).status).toBe(404);
    expect((await h.dev(MAYA, "POST", `/v1/app/sessions/${sessionId}/handoff`, { requestId: randomUUID(), to: "moon" })).status).toBe(400);
    expect((await h.dev(MAYA, "GET", `/v1/app/sessions/${sessionId}/handoff`)).status).toBe(404);
  });
});
