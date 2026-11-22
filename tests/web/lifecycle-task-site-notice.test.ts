// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectAllowedWebsitesResultReaderSchema, SetupJournalReplySchema } from "@agentx/contracts/web";
import { TaskSiteNoticeView } from "../../packages/ui/src/screens/session/TaskSiteNoticeView.js";

afterEach(cleanup);

const journal = SetupJournalReplySchema.parse({
 status: "ready",
 entries: [{ n: 4, source: "agent", command: "pytest tests/refunds -q", exitCode: 1, durationMs: 12_000, timedOut: false, flagged: false, blockedHosts: ["api.paymock.example"], tail: "ConnectionError: api.paymock.example refused", startedAt: "2026-11-20T15:08:00.000Z" }],
 hostAsks: [],
});

const pendingRequest = ProjectAllowedWebsitesResultReaderSchema.parse({
 kind: "proposal", proposalId: "f1de14f9-f00e-4e48-9147-d0d97fb224c0", proposedBy: "a".repeat(64), status: "pending", baseRevision: 4,
 beforeDomains: ["docs.acme.example"], afterDomains: ["api.paymock.example", "docs.acme.example"], createdAt: "2026-11-20T15:10:22.000Z", expiresAt: "2026-11-27T15:10:22.000Z",
});

describe("TaskSiteNoticeView", () => {
 it("shows the exact host and command from blocked-run evidence", () => {
  render(createElement(TaskSiteNoticeView, { project: "payments", state: { kind: "blocked", journal, entryN: 4 } }));

  expect(screen.getByRole("heading", { name: "A setup run recorded a blocked host" })).toBeTruthy();
  expect(screen.getByText("api.paymock.example")).toBeTruthy();
  expect(screen.getByText("pytest tests/refunds -q")).toBeTruthy();
 });

 it("reports only the project request state returned by the server", () => {
  render(createElement(TaskSiteNoticeView, { project: "payments", state: { kind: "request-result", result: pendingRequest } }));

  expect(screen.getByRole("heading", { name: "Project website proposal" })).toBeTruthy();
  expect(screen.getByText("Waiting for review")).toBeTruthy();
  expect(screen.getByText("f1de14f9-f00e-4e48-9147-d0d97fb224c0")).toBeTruthy();
  expect(screen.getByText("This response does not show that the host is approved on every machine or that the task continued.")).toBeTruthy();
 });

 it("drops cached blocked evidence when the latest read fails", () => {
  const { rerender } = render(createElement(TaskSiteNoticeView, { project: "payments", state: { kind: "blocked", journal, entryN: 4 } }));
  rerender(createElement(TaskSiteNoticeView, { project: "payments", state: { kind: "read-failed" } }));

  expect(screen.getByRole("alert").textContent).toContain("could not be read");
  expect(screen.queryByText("api.paymock.example")).toBeNull();
  expect(screen.queryByText("pytest tests/refunds -q")).toBeNull();
 });
});
