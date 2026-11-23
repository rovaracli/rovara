// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { mount } from "./test-support.js";
import { detail, reply } from "./fixtures.js";
import { day } from "../../../../packages/ui/src/screens/wiki-skills-read/parts.js";

it("skill detail uses one returned snapshot across list divergence and detail refresh", async () => {
 let current = { ...detail, skill: { ...detail.skill, currentVersion: 3, activeVersion: 2, approvals: 0, approvedByYou: false, retired: true, description: "Retired description", content: "Retired version three" } };
 const f = mount("/app/projects/web?tab=skills", r => r.path.endsWith("/skills/safe-retries") ? { status: 200, body: current } : reply(r));
 try {
  fireEvent.click((await screen.findAllByRole("button", { name: "Open safe-retries" }))[0]!);
  await screen.findByText("Retired version three");
  const rail = () => within(screen.getByRole("region", { name: "Versions" }));
  expect(rail().getByText("0 of 2 approvals")).toBeTruthy();
  expect(rail().queryByText(/you approved|Version 1/)).toBeNull();
  expect(screen.getByText("Retired description")).toBeTruthy();
  expect(screen.getByText("Retired", { selector: ".rv-wsr-chip" })).toBeTruthy();
  expect(screen.queryByText("New version to review")).toBeNull();
  expect(rail().getByText("Version 2 · in use")).toBeTruthy();
  current = { ...current, skill: { ...current.skill, currentVersion: 4, activeVersion: 3, approvals: 1, approvedByYou: true, retired: false, description: "Fresh description", content: "Fresh version four" } };
  await act(async () => { await f.client.refetchQueries({ predicate: q => q.queryKey.at(-1) === "skill:safe-retries" }); });
  await screen.findByText("Fresh version four");
  expect(rail().getByText("1 of 2 approvals · you approved")).toBeTruthy();
  expect(rail().getByText("Version 4 · newest")).toBeTruthy();
  expect(rail().getByText("Version 3 · in use")).toBeTruthy();
  expect(rail().queryByText(/Version 1|Version 2/)).toBeNull();
  expect(screen.getByText("Fresh description")).toBeTruthy();
  expect(screen.getByText("New version to review")).toBeTruthy();
  expect(screen.queryByText("Retired description")).toBeNull();
 } finally { f.close(); }
});

it.each(["skills", "ask"])("%s reconnecting uses the viewer's clock without a date, seconds or forced zone", async view => {
 let failing = false;
 const f = mount("/app/projects/web?tab=" + (view === "ask" ? "wiki&view=ask" : "skills"), r => failing && (view === "ask" ? r.path === "/v1/app/me" : r.path.endsWith("/skills")) ? { status: 503, body: {} } : reply(r));
 try {
  if (view === "ask") await screen.findByText("Existing answer: Can't tell yet.");
  else await screen.findAllByRole("button", { name: "Open safe-retries" });
  const key = f.client.getQueryCache().findAll().find(q => q.queryKey.at(-1) === (view === "ask" ? "identity" : "skills"))!.queryKey;
  const at = f.client.getQueryState(key)!.dataUpdatedAt;
  failing = true;
  await act(async () => { await f.client.refetchQueries({ queryKey: key, exact: true }); });
  expect((await screen.findByText(/^Updated .* · Reconnecting$/)).textContent).toBe("Updated " + new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) + " · Reconnecting");
  expect(screen.getAllByText(/Reconnecting/)).toHaveLength(1);
  expect(screen.queryByText(/Read from Rovara/)).toBeNull();
 } finally { f.close(); }
});

it("calendar gap dates keep their served day while instants use the viewer's zone", async () => {
 const f = mount("/app/projects/web?tab=wiki&view=gaps");
 try {
  const row = (await screen.findByRole("heading", { name: "How are retries handled?" })).closest("li")!;
  const format = (at: Date) => at.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(at.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) });
  expect(row.textContent).toContain("last asked " + format(new Date(2026, 10, 21)));
  expect(day("2026-11-21T00:00:00.000Z")).toBe(format(new Date("2026-11-21T00:00:00.000Z")));
  expect(day("unreadable")).toBe("unreadable");
 } finally { f.close(); }
});

it.each([
 { activeVersion: undefined, retired: false, waiting: true },
 { activeVersion: 2, retired: false, waiting: false },
 { activeVersion: undefined, retired: true, waiting: false },
])("detail snapshot handles no older active version ($activeVersion/$retired)", async state => {
 const f = mount("/app/projects/web?tab=skills", r => r.path.endsWith("/skills/safe-retries") ? { status: 200, body: { ...detail, skill: { ...detail.skill, activeVersion: state.activeVersion, retired: state.retired } } } : reply(r));
 try {
  fireEvent.click((await screen.findAllByRole("button", { name: "Open safe-retries" }))[0]!);
  await screen.findByText(detail.skill.content);
  expect(within(screen.getByRole("region", { name: "Versions" })).getAllByRole("listitem")).toHaveLength(1);
  expect(screen.queryByText(/Version (1|undefined) · in use/)).toBeNull();
  expect(screen.queryByText("Text of this version: Can't tell yet.")).toBeNull();
  expect(screen.queryByText("New version to review") !== null).toBe(state.waiting);
 } finally { f.close(); }
});
