// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { RequestStep } from "../../packages/ui/src/screens/session/RequestStep.js";
import { workRow } from "../../packages/ui/src/api/work.js";
import { readEvents, readPlan, readTask } from "../../packages/ui/src/api/work.js";

const instant = "2026-11-22T01:30:00.000Z";
afterEach(() => { vi.unstubAllEnvs(); });
for (const [zone, expected] of [["America/Los_Angeles", "Nov 21, 2026, 5:30 PM"], ["Pacific/Auckland", "Nov 22, 2026, 2:30 PM"]] as const) {
 it(`renders the request's recorded instant in ${zone}`, () => {
  vi.stubEnv("TZ", zone);
  const row = workRow(readTask({ taskId: "11111111-1111-4111-8111-111111111111", title: "Fix", project: "web", phase: "BUILD", createdAt: instant, updatedAt: instant })!, undefined, new Date(instant));
  const view = renderUi(h(RequestStep, { row, plan: undefined }));
  expect(view.container.textContent).toContain(expected);
  expect(view.container.textContent).not.toContain("UTC");
 });
}

import { screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ProjectScopeContext } from "../../packages/ui/src/screens/admin/admin-context.js";
import { SignInClientsScreen } from "../../packages/ui/src/screens/admin/access/SignInClientsScreen.js";
import { TaskStopEnforcement } from "../../packages/ui/src/screens/admin/TaskStopEnforcement.js";
import { ReadSection, checkedTime } from "../../packages/ui/src/screens/admin/models/read.js";
import { ReadState } from "../../packages/ui/src/screens/admin/projects/read.js";
import { localWhenWords, whenWords } from "../../packages/ui/src/screens/session/DecisionsCard.js";
import { expiresText } from "../../packages/ui/src/screens/setup/limits-text.js";
import { AuditScreen } from "../../packages/ui/src/screens/admin/audit/AuditScreen.js";
import { fakeHost } from "./support/fake-host.js";
import { inViewerZones, VIEWER_INSTANT } from "./support/viewer-zones.js";
import type { ReactElement } from "react";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";

const scope = { orgId: "org_aaaaaaaaaaaaaaaaaaaa", company: "Acme", developerId: "a".repeat(64), role: "owner", checking: false } as const;
function mountScreen(element: ReactElement, respond: (request: ApiRequest) => ApiResponse) {
 const f = fakeHost(async request => respond(request)), query = createQueryClient();
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(ProjectScopeContext.Provider, { value: scope, children: element }) }) }) }));
 return { ...view, query, close() { view.unmount();query.clear(); } };
}
it("renders sign-in-client dates in both viewer zones", async () => {
 await inViewerZones(async expected => {
  const f = mountScreen(h(SignInClientsScreen), () => ({ status: 200, body: { clients: [{ clientId: "test", name: "Test client", kind: "web", createdAt: VIEWER_INSTANT, lastUsedAt: VIEWER_INSTANT }] } }));
  try { await screen.findByText("Test client");expect(f.container.textContent?.split(expected.date)).toHaveLength(3); } finally { f.close(); }
 });
});
it("renders enforcement preview time in both viewer zones", async () => {
 await inViewerZones(async expected => {
  const f = mountScreen(h(TaskStopEnforcement, { orgId: scope.orgId, checking: false }), request => ({ status: 200, body: request.method === "GET" ? { orgId: scope.orgId, revision: 1, state: "disabled" } : { orgId: scope.orgId, revision: 1, reviewId: "11111111-1111-4111-8111-111111111111", digest: "a".repeat(64), complete: true, capturedAt: VIEWER_INSTANT, expiresAt: "2026-11-23T01:30:00.000Z", tasks: [], truncated: false, counts: { refuse_next_admission: 0, new_window_at_stop: 0, retain_current_window: 0, exempt: 0 } } }));
  try { expect(await screen.findByText(`As of ${expected.timestamp}. Work can start or finish after this preview.`)).toBeTruthy(); } finally { f.close(); }
 });
});
it("renders decision and setup-expiry words in both viewer zones", async () => {
 await inViewerZones(async expected => {
  expect(whenWords(VIEWER_INSTANT)).toBe(expected.clock);
  expect(localWhenWords(VIEWER_INSTANT)).toBe(expected.clock);
  expect(expiresText("2026-11-21T01:30:00.000Z")).toBe(`It expires at ${expected.timestamp}.`);
  expect(checkedTime(VIEWER_INSTANT)).toBe(expected.timestamp);
 });
});
// Use a real query result with retained data, rather than fabricating UseQueryResult fields.
function ReadTimes({ project = false, stale = false }: { project?: boolean; stale?: boolean }) {
 const read = useQuery({ queryKey: ["viewer-local-read"], queryFn: () => Promise.reject(new Error("offline")), enabled: stale, retry: false });
 return project ? h(ReadState, { read, label: "projects", children: () => "Kept project" }) : h(ReadSection, { read, label: "models", children: () => "Kept model" });
}
for (const project of [false, true]) it(`renders ${project ? "project" : "model"} stale-read times in both viewer zones`, async () => {
 await inViewerZones(async expected => {
  const f = mountScreen(h(ReadTimes, { project, stale: true }), () => ({ status: 404, body: {} }));
  f.query.setQueryData(["viewer-local-read"], { value: "kept" }, { updatedAt: Date.parse(VIEWER_INSTANT) });
  try { expect(await screen.findByText(`Updated ${expected.timestamp} · Reconnecting`)).toBeTruthy(); } finally { f.close(); }
 });
});
it("renders the model snapshot's successful read time in both viewer zones", async () => {
 await inViewerZones(async expected => {
  const f = mountScreen(h(ReadTimes), () => ({ status: 404, body: {} }));
  f.query.setQueryData(["viewer-local-read"], { value: "kept" }, { updatedAt: Date.parse(VIEWER_INSTANT) });
  try { expect(await screen.findByText(`Read at ${expected.timestamp}. This is a stored snapshot.`)).toBeTruthy(); } finally { f.close(); }
 });
});
it("renders audit record instants locally while retaining explicitly UTC range inputs", async () => {
 await inViewerZones(async expected => {
  const f = mountScreen(h(AuditScreen), () => ({ status: 200, body: { records: [{ id: "one", source: "cloud", at: VIEWER_INSTANT, actor: { developerId: scope.developerId, name: "Priya" }, action: "company.rules.changed", subject: "Rules", outcome: "ok" }], engine: { state: "connected" } } }));
  try { expect(await screen.findByText(expected.timestamp)).toBeTruthy();expect(screen.getByLabelText("From (UTC)")).toBeTruthy();expect(screen.getByLabelText("Through (UTC)")).toBeTruthy(); } finally { f.close(); }
 });
});

import { CompanyDomainsScreen } from "../../packages/ui/src/screens/admin/domains/CompanyDomainsScreen.js";
it("renders the existing company-domain view's dates in both viewer zones", async () => {
 await inViewerZones(async expected => {
  const f = mountScreen(h(CompanyDomainsScreen), () => ({ status: 200, body: { domains: [{ domain: "acme.example", state: "verified", addedAt: VIEWER_INSTANT, verifiedAt: VIEWER_INSTANT, missingSince: VIEWER_INSTANT, lastCheckedAt: VIEWER_INSTANT, record: { type: "TXT", name: "_rovara-verify.acme.example", value: "rovara-verify=" + "c".repeat(40) } }], max: 20, lostAfterDays: 3 } }));
  try { await screen.findByText("acme.example");expect(screen.getAllByText(`since ${expected.date}`, { exact: false })).toHaveLength(2);expect(screen.getByText(`Last checked ${expected.date}`, { exact: false })).toBeTruthy();expect(f.container.textContent).not.toContain(" UTC"); } finally { f.close(); }
 });
});

import { BuildStep } from "../../packages/ui/src/screens/session/BuildStep.js";
import { TaskSideCards } from "../../packages/ui/src/screens/session/TaskSideCards.js";
import { KnownFailingMarks } from "../../packages/ui/src/screens/project/KnownFailingMarks.js";
import { EnvironmentPanel } from "../../packages/ui/src/screens/project/EnvironmentPanel.js";
import { dateWords } from "../../packages/ui/src/screens/project/lessons/lessons-text.js";
import { EvidenceTab } from "../../packages/ui/src/screens/session/EvidenceTab.js";
import { taskFixture } from "./support/session-fixture.js";

for (const named of [true, false]) it(`renders ${named ? "plan-task" : "unassigned"} build activity locally in both viewer zones`, async () => {
 await inViewerZones(async expected => {
  const events = readEvents({ events: [{ seq: 1, at: VIEWER_INSTANT, kind: "progress", text: "Building", ...(named ? { taskItemId: "T1" } : {}) }] });
  const tasks = named ? readPlan({ tasks: [{ id: "T1", title: "Build", status: "running" }] }).tasks : [];
  const f = renderUi(h(BuildStep, { tasks, events }));
  try {
   const stamp = f.container.querySelector("time");
   expect(f.container.querySelector('[role="log"] b')?.textContent).toBe(expected.zone === "America/Los_Angeles" ? "17:30:00" : "14:30:00");
   expect(stamp?.getAttribute("datetime")).toBe(VIEWER_INSTANT);
  } finally { f.unmount(); }
 });
});
it("renders task history locally in both viewer zones and retains its machine instant", async () => {
 await inViewerZones(async expected => {
  const task = readTask({ taskId: "11111111-1111-4111-8111-111111111111", title: "Fix", project: "web", phase: "BUILD", createdAt: VIEWER_INSTANT, updatedAt: VIEWER_INSTANT })!;
  const events = readEvents({ events: [{ seq: 1, at: VIEWER_INSTANT, kind: "progress", text: "Started" }] });
  const f = renderUi(h(TaskSideCards, { task, plan: undefined, events }));
  try {
   const stamp = f.container.querySelector('[aria-label="History"] .mono');
   expect(stamp?.textContent).toBe(expected.zone === "America/Los_Angeles" ? "17:30" : "14:30");
   expect(stamp?.getAttribute("datetime")).toBe(VIEWER_INSTANT);
  } finally { f.unmount(); }
 });
});
it("renders known-failing mark dates locally in both viewer zones", async () => {
 await inViewerZones(async expected => {
  const f = mountScreen(h(KnownFailingMarks, { project: "web" }), () => ({ status: 200, body: { max: 500, marks: [{ name: "unit", checkId: "check", markedBy: "b".repeat(64), markedByName: "Maya", markedByYou: false, markedAt: VIEWER_INSTANT, epoch: 1 }] } }));
  try { expect(await screen.findByText(`Check check · Marked by Maya on ${expected.date}`)).toBeTruthy(); } finally { f.close(); }
 });
});
it("renders saved-environment build and failure dates locally in both viewer zones", async () => {
 await inViewerZones(async expected => {
  const f = mountScreen(h(EnvironmentPanel, { project: "web" }), () => ({ status: 200, body: { health: "needs_repair", canReset: false, image: { builtAt: VIEWER_INSTANT, ageDays: 3, status: "stale" }, lastFailure: { at: VIEWER_INSTANT, reason: "secrets_found" } } }));
  try {
   expect(await screen.findByText(`Saved copy built 3 days ago (${expected.date}). A task could not use it, so a new one is due.`)).toBeTruthy();
   expect(screen.getByText(`The last build failed on ${expected.date} (secrets found).`)).toBeTruthy();
  } finally { f.close(); }
 });
});
it("formats lesson dates locally rather than slicing the UTC date", async () => {
 await inViewerZones(async expected => { expect(dateWords(Date.parse(VIEWER_INSTANT))).toBe(expected.date); });
});

it("renders evidence service recording dates locally in both viewer zones", async () => {
 await inViewerZones(async expected => {
  const task = taskFixture({ evidence: { schemaVersion: 1, candidateDigest: "a".repeat(64), checks: [], api: [], browser: [], notTested: [], selection: { method: "full", selected: 0, total: 0 }, environment: { tier: "sandbox", envRevision: 1, data: "synthetic", accounts: [], services: [{ name: "Payments", mode: "mocked", recordedAt: VIEWER_INSTANT }] } } });
  const f = mountScreen(h(EvidenceTab, { task }), () => ({ status: 404, body: {} }));
  try { expect(screen.getByText(`: mocked, recorded ${expected.date}`)).toBeTruthy(); } finally { f.close(); }
 });
});

it("keeps an unreadable request instant visible rather than inventing a local date", () => {
 const row = workRow(readTask({ taskId: "11111111-1111-4111-8111-111111111111", title: "Fix", project: "web", phase: "BUILD", createdAt: instant, updatedAt: instant })!, undefined, new Date(instant));
 row.task.createdAt = "not-a-recorded-instant";
 const view = renderUi(h(RequestStep, { row, plan: undefined }));
 expect(view.container.textContent).toContain("Started not-a-recorded-instant");
});
it("keeps an unreadable task-page decision instant visible", () => {
 expect(localWhenWords("not-a-recorded-instant")).toBe("not-a-recorded-instant");
});


import { BedrockConnection } from "../../packages/ui/src/screens/admin/ai-spending/BedrockConnection.js";
import { Clock } from "../../packages/ui/src/screens/session/merge-parts.js";
it("renders the Bedrock check and recovery deadline locally in both viewer zones", async () => {
 await inViewerZones(async expected => {
  const at = Date.parse(VIEWER_INSTANT);
  const identity = { developer: { id: scope.developerId, name: "Priya", orgRole: "owner" }, org: { orgId: scope.orgId, name: "Acme", plan: "team" }, identities: [] };
  const f = mountScreen(h(BedrockConnection), request => ({ status: 200, body: request.path === "/v1/app/me" ? identity : {
   revision: 1, canChange: true, usage: "AWS bills your account.", removedUntil: at,
   connection: { connected: true, connectedAt: at, updatedAt: at, checkedAt: at, roleArn: "arn:aws:iam::123456789012:role/fixture", region: "us-west-2", allowGlobal: false, models: [], productModels: [] },
  } }));
  try {
   expect(await screen.findByText(`Region: us-west-2. Connected: Yes. Checked: ${expected.timestamp}`)).toBeTruthy();
   expect(await screen.findByText(`Recovery available until ${expected.timestamp}.`)).toBeTruthy();
  } finally { f.close(); }
 });
});
it("renders the merge clock's full hover instant locally and retains its machine instant", async () => {
 await inViewerZones(async expected => {
  const f = renderUi(h(Clock, { at: VIEWER_INSTANT }));
  try {
   const stamp = f.container.querySelector("time");
   expect(stamp?.getAttribute("title")).toBe(expected.timestamp);
   expect(stamp?.getAttribute("datetime")).toBe(VIEWER_INSTANT);
  } finally { f.unmount(); }
 });
});
