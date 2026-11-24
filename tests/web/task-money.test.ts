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
import { TaskSideCards } from "../../packages/ui/src/screens/session/TaskSideCards.js";
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

it("shows the own-task receipt and limit, and no figures for another readable task without money", () => {
 const own = money();
 own.terminal = false;
 own.spentMicros = { state: "available", value: 1_230_000 };
 own.estimatedMicros = { state: "available", value: 1_230_000 };
 own.stop.taskMaximumMicros = { state: "available", value: 12_000_000 };
 const task = work.readTask({ taskId: own.taskId, title: "Own task", project: "payments", status: "RUNNING", updatedAt: own.asOf, money: own })!;
 const view = renderUi(h(TaskSideCards, { task, plan: undefined, events: [] }));
 expect(view.container.textContent).toContain("About $1.23 so far");
 expect(view.container.textContent).toContain("Task limit $12.00");
 view.unmount();
 const other = work.readTask({ taskId: "other-readable-task", title: "Other task", project: "payments", status: "RUNNING", updatedAt: own.asOf, spent: { usd: 1.23 }, runLimit: { limitUsd: 12 } })!;
 const hidden = renderUi(h(TaskSideCards, { task: other, plan: undefined, events: [] }));
 expect(hidden.container.textContent).toContain("Cost unavailable");
 expect(hidden.container.textContent).not.toContain("$");
 expect(screen.queryByRole("meter")).toBeNull();
 hidden.unmount();
});
