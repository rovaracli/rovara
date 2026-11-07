// @vitest-environment jsdom
// UX2 slice 2 item 3: review findings and "send back" live on the task page, with the same authority as Slack: the findings are listed, Resolve findings sends each one's choice (a reason for each
// accepted one) with the page's revision and code, and Send back to coding sends the owner's note; a reader who may not act is told who decides instead.
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { FindingsActions } from "../../packages/ui/src/screens/session/FindingsActions.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { taskFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { workspaceWorkflow } from "./support/workspace-fixture.js";

const repositories = [{ repositoryId: "acme/payments", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }];
const digest = createHash("sha256").update(JSON.stringify({ schemaVersion: 1, repositories }), "utf8").digest("hex"), findingId = "f".repeat(64);
const task = (offer: Record<string, unknown>) => taskFixture({
 workflow: { ...workspaceWorkflow(), stage: "REVIEW", state: "BLOCKED", revision: 9, candidate: { schemaVersion: 1, repositories, digest } },
 reviewFindings: { findings: [{ findingId, role: "SECURITY", text: "<script>alert(1)</script> refunds skip the lock", file: "src/refund.ts", line: 12 }], resolve: true, sendBack: true, ...offer },
});
function setup(value: ReturnType<typeof task>, mayAct = true) {
 const f = fakeHost(async () => ({ status: 200, body: { task: {} } })), query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(FindingsActions, { task: value, sessionId: SESSION_FIXTURE_ID, mayAct }) }) }));
 return { ...f, ...ui, close() { ui.unmount();query.clear(); } };
}

it("lists the findings as plain text and resolves them with the page's revision and code", async () => {
 const f = setup(task({}));
 expect(screen.getByText("<script>alert(1)</script> refunds skip the lock")).toBeTruthy();expect(f.container.querySelector("script")).toBeNull();
 expect(screen.getByText("src/refund.ts:12")).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "Resolve findings" }));
 await waitFor(() => expect(f.request).toHaveBeenCalled());
 const [sent] = f.request.mock.calls[0]!;
 expect(sent).toMatchObject({ method: "POST", path: "/v1/app/tasks/11111111-1111-4111-8111-111111111111/workflow/review-findings" });
 expect(sent.body).toMatchObject({ expectedRevision: 9, candidateDigest: digest, resolutions: [{ findingId, action: "FIX", note: "" }] });
 expect(await screen.findByRole("status")).toBeTruthy();
 f.close();
});

it("asks a reason for each accepted finding before it sends", async () => {
 const f = setup(task({}));
 fireEvent.click(screen.getByLabelText("Accept it"));
 expect(screen.getByRole("button", { name: "Resolve findings" })).toHaveProperty("disabled", true);
 fireEvent.change(screen.getByLabelText("Why it's fine as it is"), { target: { value: "Guarded upstream" } });
 fireEvent.click(screen.getByRole("button", { name: "Resolve findings" }));
 await waitFor(() => expect(f.request).toHaveBeenCalled());
 expect(f.request.mock.calls[0]![0].body).toMatchObject({ resolutions: [{ findingId, action: "ACCEPT", note: "Guarded upstream" }] });
 f.close();
});

it("sends a task back to coding with the owner's note, or Slack's words when none is given", async () => {
 const f = setup(task({ resolve: false }));
 expect(screen.queryByRole("button", { name: "Resolve findings" })).toBeNull();
 fireEvent.click(screen.getByRole("button", { name: "Send back to coding" }));
 await waitFor(() => expect(f.request).toHaveBeenCalled());
 expect(f.request.mock.calls[0]![0]).toMatchObject({ path: "/v1/app/tasks/11111111-1111-4111-8111-111111111111/workflow/send-back", body: { expectedRevision: 9, instructions: "Fix the problems listed above, then report what changed." } });
 f.close();
});

it("offers nothing to a reader who may not act, and says who decides", () => {
 const f = setup(task({}), false);
 expect(screen.queryByRole("button")).toBeNull();expect(screen.getByText("The task owner decides what happens to these findings.")).toBeTruthy();
 f.close();
});
