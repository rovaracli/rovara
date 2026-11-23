// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, screen } from "@testing-library/react";
import { mount } from "./mount.js";
import { bodies, responder, ROOT } from "./fixtures.js";
import { readFileSync } from "node:fs";
const held = JSON.parse(readFileSync("tests/web/read-only/rules-lessons-read/held-states.json", "utf8")) as Array<{ section: number }>;
const refused = { status: 403, body: { error: { code: "FORBIDDEN", message: "Access ended" } } };
describe("G4 R1/R4/R5", () => {
 it("R1 removes cached private content after a failed identity refresh and on remount", async () => {
  let fail = false;const answer = responder();const view = mount(undefined, async r => fail && r.path === "/v1/app/me" ? refused : answer(r));
  await screen.findAllByText("Keep changes small.");fail = true;
  await act(async () => { await view.query.invalidateQueries(); });
  await screen.findByText(/You no longer have access to this page/);
  expect(screen.queryByText("Keep changes small.")).toBeNull();expect(screen.getByText("PROJECT-ACCESS-LOST")).toBeTruthy();expect(screen.getByRole("button", { name: "Load again" })).toBeTruthy();
  await act(async () => { await view.router.navigate("/app/admin/how-we-work");await view.router.navigate("/app/projects/payments?tab=how-we-work"); });
  expect(screen.queryByText("Keep changes small.")).toBeNull();
 });
 it("retains process facts after a non-access refresh failure", async () => {
  let fail = false;const answer = responder();const view = mount(undefined, async r => fail && r.path.endsWith("/how-we-work") ? { status: 400, body: {} } : answer(r));
  await screen.findAllByText("Keep changes small.");fail = true;await act(async () => { await view.query.invalidateQueries(); });
  expect(await screen.findByText(/Updated .* · Reconnecting/)).toBeTruthy();expect(screen.getAllByText("Keep changes small.").length).toBeGreaterThan(0);expect(screen.queryByRole("alert")).toBeNull();
 });
 it("R4 does not infer lesson absence from unavailable reads", async () => {
  const answer = responder();mount("/app/projects/payments?tab=lessons", async r => r.path.startsWith(ROOT + "/lessons") ? { status: 501, body: {} } : answer(r));
  expect((await screen.findAllByText(/can’t tell yet/)).length).toBeGreaterThan(0);expect(screen.queryByText("No lessons are shown in this list.")).toBeNull();
 });
 it("R5 keeps recipes hidden for members and makes no recipe read", async () => {
  const data = bodies();data.identity.developer.orgRole = "member";const view = mount("/app/admin/how-we-work/recipes", responder(data));
  await screen.findByText(/You no longer have access to this page/);expect(view.request.mock.calls.some(([r]) => r.path.includes("setup-recipes"))).toBe(false);
 });
 it("keeps the held-state registry on the seven group pages", () => { expect(held.map(row => row.section)).toEqual([13, 14, 15, 16, 25, 27, 35]); });
 it("shows loading instead of guessing an empty state", async () => { mount(undefined, () => new Promise(() => undefined));expect(await screen.findByRole("status")).toHaveProperty("textContent", "Reading this section…");expect(screen.queryByText("No lessons are shown in this list.")).toBeNull(); });
});
