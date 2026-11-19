// @vitest-environment jsdom
import type { TaskMoneyV1 } from "../../packages/contracts/src/task-money.js";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { createMemoryRouter, RouterProvider } from "react-router";
import { SessionTile } from "../../packages/ui/src/screens/live/SessionTile.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { liveFixture } from "./support/live-fixture.js";
import { fakeHost } from "./support/fake-host.js";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { acceptSessionRead } from "../../packages/ui/src/api/sessions.js";
import { acceptLivePage, mergeLiveTiles } from "../../packages/ui/src/api/live.js";
import * as work from "../../packages/ui/src/api/work.js";
import { SessionHeader } from "../../packages/ui/src/screens/session/SessionHeader.js";
import { TaskSideCards } from "../../packages/ui/src/screens/session/TaskSideCards.js";
import { WorkList } from "../../packages/ui/src/screens/work/WorkList.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { sessionFixture } from "./support/session-fixture.js";
const money = (revision = 1) => ({ ...(JSON.parse(readFileSync("contracts/shared/task-money.v1.json", "utf8")) as { examples: TaskMoneyV1[] }).examples[0]!, revision });
it("merges finance revisions independently of session and live workflow timestamps", () => {
 const previous = sessionFixture({ money: money(8) }), next = sessionFixture({ money: money(7), updatedAt: "2026-10-24T00:00:00.000Z" });
 expect(acceptSessionRead(previous, next)).toMatchObject({ updatedAt: next.updatedAt, money: { revision: 8 } });
 expect(acceptSessionRead(next, previous)).toMatchObject({ updatedAt: next.updatedAt, money: { revision: 8 } });
 const tile = (rev: number, updatedAt: string) => ({ sessionId: previous.sessionId, money: money(rev), updatedAt }) as never;
 const before = { tiles: [tile(8, previous.updatedAt)] } as never, after = { tiles: [tile(7, next.updatedAt)] } as never;
 expect(acceptLivePage(before, after).tiles[0]?.money?.revision).toBe(8);
 expect(mergeLiveTiles([before, after])[0]?.money?.revision).toBe(8);
 expect(acceptSessionRead(previous, sessionFixture()).money).toBeUndefined();
});
it("uses financial revision for work rows while absent money remains unavailable", () => {
 const accept = Reflect.get(work, "acceptWorkTasks");
 expect(accept).toBeTypeOf("function");
 const raw = { taskId: "money-task", title: "Task", project: "payments", status: "CLOSED", updatedAt: "2026-11-18T00:00:00.000Z", money: money(8), spent: { usd: 999 } };
 const old = work.readTask(raw)!, next = work.readTask({ ...raw, money: money(7) })!;
 expect(accept([old], [next])[0]?.money?.revision).toBe(8);
 expect(accept([old], [work.readTask({ ...raw, money: undefined })!])[0]?.money).toBeUndefined();
});
it("shows one lower-bound phrase on side cards and keeps old-Code dollars unavailable", () => {
 const task = work.readTask({ taskId: "money-task", title: "Task", project: "payments", status: "CLOSED", updatedAt: "2026-11-18T00:00:00.000Z", money: money(), spent: { usd: 999 }, runLimit: { limitUsd: 999 } })!;
 const f = renderUi(h(TaskSideCards, { task, plan: undefined, events: [] }));
 expect(screen.getByText("under $0.01 (not yet confirmed)")).toBeTruthy();
 expect(screen.queryByText("$999.00")).toBeNull(); f.unmount();
 const legacy = work.readTask({ ...task, money: undefined, spent: { usd: 999 }, taskId: "legacy", status: "CLOSED" })!;
 const old = renderUi(h(TaskSideCards, { task: legacy, plan: work.readPlan({ runLimitUsd: 999 }), events: [] }));
 expect(screen.getByText("Cost unavailable")).toBeTruthy(); expect(old.container.textContent).not.toContain("$999.00"); old.unmount();
});

it("shows the same provisional receipt on the live tile", () => {
 const f = fakeHost(), tile = liveFixture({ money: money() });
 const router = createMemoryRouter([{ path: "/", element: h(SessionTile, { tile, onChanged: () => Promise.resolve() }) }], { initialEntries: ["/"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(RouterProvider, { router }) }) }));
 expect(screen.getByText("under $0.01 (not yet confirmed)")).toBeTruthy();
 expect(screen.queryByText("$1.20")).toBeNull(); view.unmount();
});

it("keeps legacy spend unavailable on each task surface when money is absent", () => {
 const task = work.readTask({ taskId: "legacy", title: "Task", project: "payments", status: "CLOSED", updatedAt: "2026-11-18T00:00:00.000Z", spent: { usd: 999 } })!;
 const cards = renderUi(h(TaskSideCards, { task, plan: undefined, events: [] }));
 expect(screen.getByText("Cost unavailable")).toBeTruthy(); expect(cards.container.textContent).not.toContain("$999.00"); cards.unmount();
 const list = renderUi(h(AppHostProvider, { host: fakeHost().host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(WorkList, { rows: [work.workRow(task, undefined, new Date("2026-11-18T00:00:00.000Z"))], selectedId: undefined, onSelect: () => undefined }) }) }));
 expect(screen.queryByText("Cost unavailable")).toBeNull(); expect(list.container.textContent).not.toContain("$999.00"); list.unmount();
 const f = fakeHost(), tile = liveFixture({ costUsd: 999 });
 const router = createMemoryRouter([{ path: "/", element: h(SessionTile, { tile, onChanged: () => Promise.resolve() }) }], { initialEntries: ["/"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(RouterProvider, { router }) }) }));
 expect(screen.getByText("Cost unavailable")).toBeTruthy(); expect(view.container.textContent).not.toContain("$999.00"); view.unmount();
});
it("shows only the configured money limit and meters only measured spend", () => {
 for (const maximum of [12_000_000, 0, undefined]) {
  const snapshot = money();
  snapshot.stop.taskMaximumMicros = maximum === undefined ? { state: "unavailable", reason: "not_measured" } : { state: "available", value: maximum };
  const task = work.readTask({ taskId: snapshot.taskId, title: "Task", project: "payments", status: "CLOSED", updatedAt: snapshot.asOf, money: snapshot, spent: { usd: 999 }, runLimit: { limitUsd: 999 } })!;
  const view = renderUi(h(TaskSideCards, { task, plan: work.readPlan({ runLimitUsd: 999 }), events: [] }));
  expect(view.container.textContent).not.toContain("$999.00");
  if (maximum === undefined) expect(view.container.textContent).not.toContain("Task limit");
  else expect(view.container.textContent).toContain(maximum === 0 ? "Task limit $0.00" : "Task limit $12.00");
  if (maximum === 12_000_000) {
   const meter = screen.getByRole("meter", { name: "Spent against the limit" });
   expect(meter.getAttribute("aria-valuemax")).toBe("12"); expect(meter.getAttribute("aria-valuenow")).toBe("0.00008");
  } else expect(screen.queryByRole("meter")).toBeNull();
  view.unmount();
 }
 const snapshot = money(); snapshot.stop.taskMaximumMicros = { state: "available", value: 12_000_000 }; snapshot.spentMicros = { state: "unavailable", reason: "not_measured" };
 const task = work.readTask({ taskId: snapshot.taskId, title: "Task", project: "payments", status: "CLOSED", updatedAt: snapshot.asOf })!;
 const view = renderUi(h(TaskSideCards, { task: { ...task, money: snapshot }, plan: undefined, events: [] }));
 expect(screen.queryByRole("meter")).toBeNull(); view.unmount();
});

it("keeps the outcome beside the receipt on a completed work row", () => {
 const snapshot = money();
 const task = work.readTask({ taskId: snapshot.taskId, title: "Task", project: "payments", status: "CLOSED", outcome: "MERGED", updatedAt: snapshot.asOf, money: snapshot, spent: { usd: 999 } })!;
 const view = renderUi(h(AppHostProvider, { host: fakeHost().host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(WorkList, { rows: [work.workRow(task, undefined, new Date(snapshot.asOf))], selectedId: undefined, onSelect: () => undefined }) }) }));
 expect(screen.getByText("Merged")).toBeTruthy();
 expect(screen.getByText("under $0.01 (not yet confirmed)")).toBeTruthy();
 expect(view.container.textContent).not.toContain("$999.00");
 view.unmount();
});

for (const terminal of [false, true]) for (const state of ["empty", "unmeasured", "partial-zero", "lower-bound"] as const) {
 it(`keeps ${state} money honest on every task surface (terminal=${String(terminal)})`, () => {
  const snapshot = money(0), zero = { state: "available", value: 0 } as const;
  snapshot.terminal = terminal;
  let words: string;
  if (state === "lower-bound") {
   snapshot.spentMicros = { state: "available", value: 1_230_000 };
   snapshot.estimatedMicros = { state: "available", value: 1_230_000 };
   words = terminal ? "About $1.23 (not yet confirmed)" : "About $1.23 so far";
  } else {
   snapshot.coverage = { ...snapshot.coverage, finalCalls: 0, estimatedCalls: 0, awaitingUsageCalls: 0 };
   snapshot.awaitingUsageCalls = zero;
   snapshot.awaitingUsageMicros = zero;
   snapshot.finalMicros = zero; snapshot.estimatedMicros = zero;
   if (state === "unmeasured") {
    snapshot.state = "unavailable"; snapshot.finality = "unavailable";
    snapshot.spentMicros = { state: "unavailable", reason: "not_measured" };
    words = "Cost unavailable";
   } else {
    snapshot.spentMicros = zero;
    if (state === "empty") {
     snapshot.state = "current"; snapshot.heldMicros = zero; snapshot.coverage.expectedCalls = zero;
     words = "No spend yet";
    } else words = "Cost unavailable";
   }
  }
  const header = renderUi(h(SessionHeader, { session: sessionFixture({ money: snapshot }), onAction: () => undefined }));
  expect(screen.getByText(words)).toBeTruthy(); header.unmount();
  const task = work.readTask({ taskId: snapshot.taskId, title: "Task", project: "payments", status: terminal ? "CLOSED" : "RUNNING", updatedAt: snapshot.asOf, money: snapshot, spent: { usd: 999 } })!;
  const cards = renderUi(h(TaskSideCards, { task, plan: undefined, events: [] }));
  expect(screen.getByText(words)).toBeTruthy(); cards.unmount();
  const list = renderUi(h(AppHostProvider, { host: fakeHost().host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(WorkList, { rows: [work.workRow(task, undefined, new Date(snapshot.asOf))], selectedId: undefined, onSelect: () => undefined }) }) }));
  expect(screen.getByText(words)).toBeTruthy(); list.unmount();
  const router = createMemoryRouter([{ path: "/", element: h(SessionTile, { tile: liveFixture({ money: snapshot }), onChanged: () => Promise.resolve() }) }], { initialEntries: ["/"] });
  const tile = renderUi(h(AppHostProvider, { host: fakeHost().host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(RouterProvider, { router }) }) }));
  expect(screen.getByText(words)).toBeTruthy(); tile.unmount();
 });
}
