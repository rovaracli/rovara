// @vitest-environment jsdom
import { expect, it } from "vitest";
import { createElement as h } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { SessionControls } from "../../packages/ui/src/screens/session/SessionControls.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { meFixture } from "./support/fixtures.js";
import { sessionFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";

function setup(action: "stop" | "watch", status: number) {
 const base = sessionFixture(), session = sessionFixture({ you: { ...base.you, actions: [action] } });
 const f = fakeHost(async request => request.path === "/v1/app/me" ? { status: 200, body: meFixture() } : request.method === "GET" ? { status: 200, body: { session } } : { status, body: status === 202 ? { status: "NEEDS_CONFIRMATION", changes: [] } : {} });
 const query = createQueryClient();query.setQueryData(["session", SESSION_FIXTURE_ID], session);
 const tree = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(SessionControls, { id: SESSION_FIXTURE_ID, agent: "Agent", actions: [action], following: false, onChanged: async () => undefined }) }) });
 const ui = renderUi(tree());
 return { ...f, ...ui, query, tree, writes: () => f.request.mock.calls.filter(([request]) => request.method !== "GET") };
}

it("F2: Stop after 503 stays locked through remount and Check does not write", async () => {
 const f = setup("stop", 503);
 await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop" }).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button", { name: "Stop" }));fireEvent.click(screen.getByRole("button", { name: "Stop and end the machine" }));
 await screen.findByText(/This session action was not confirmed/);
 f.unmount();const next = renderUi(f.tree());
 await screen.findByText(/This session action was not confirmed/);
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop" }).disabled).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Check" }));
 await waitFor(() => expect(f.request.mock.calls.filter(([request]) => request.method === "GET").length).toBeGreaterThan(2));
 expect(f.writes()).toHaveLength(1);next.unmount();f.query.clear();
});

it("F3: a 202 Follow never claims unchanged and keeps the action locked", async () => {
 const f = setup("watch", 202);
 await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Follow" }).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button", { name: "Follow" }));
 await screen.findByText(/Your follow change is not confirmed/);
 expect(screen.queryByText(/Following hasn't changed/)).toBeNull();
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Follow" }).disabled).toBe(true);
 f.unmount();f.query.clear();
});

it("F1/B1: each merged leaf has a real production owner and imported CSS is packaged", () => {
 const owners: Record<string, string[]> = {
  SessionScreen: ["TaskSessionEntryReadRecoveryView", "TaskControlsReadRecoveryView", "TaskStartReceiptView", "TaskDraftReturnView"],
  SessionControls: ["TaskSessionControlOutcomeView"], CloseTaskDialog: ["TaskCloseProgressStatusView"],
  TaskActions: ["TaskContinuationRefusalView"], EvidenceTab: ["TaskSiteNoticeView"],
  UnderstandQuestions: ["ClarificationResponseStatusView"], MoneyBanners: ["TaskBudgetPauseView"],
  FixWithAgentPanel: ["TaskDiagnosisResultStatusView"],
  AnsweredSection: ["AnswerReceiptView"],
 };
 for (const [owner, leaves] of Object.entries(owners)) {
  const source = readFileSync(`packages/ui/src/screens/session/${owner}.tsx`, "utf8");
  for (const leaf of leaves) expect(source, `${owner} must mount ${leaf}`).toMatch(new RegExp(`<${leaf}\\b`));
 }
 expect(readFileSync("packages/ui/src/screens/session/PipelineTab.tsx", "utf8")).toMatch(/<FixWithAgentPanel\b/);
 expect(readFileSync("scripts/ui-copy-assets.mjs", "utf8")).toContain('"screens/session/answer-receipt.css"');
});
