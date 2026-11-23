// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { mount } from "./mount.js";
describe("G4 canonical read entries", () => {
 it("mounts How we work and its history, learned and effective model slots", async () => {
  mount();
  await screen.findAllByText("Keep changes small.");
  expect(await screen.findByRole("heading", { name: "Rules for every task in this project" })).toBeTruthy();
  expect(await screen.findByRole("heading", { name: "What changed, and when" })).toBeTruthy();
  expect((await screen.findAllByText(/Version 2/)).length).toBeGreaterThan(0);
  expect(screen.getAllByRole("link").map(link => link.textContent)).toEqual(["Rules", "Learned", "Models by stage", "History", "AI models for each step", "See all 1 version"]);
  expect(screen.getByRole("link", { name: "Rules" }).getAttribute("aria-current")).toBe("page");
 });
 it("shows Learned, Models by stage and History as their own views through the view query", async () => {
  const learned = mount("/app/projects/payments?tab=how-we-work&view=learned");expect(await screen.findByRole("heading", { name: "This week" })).toBeTruthy();expect(screen.queryByRole("heading", { name: "What changed, and when" })).toBeNull();learned.unmount();
  const models = mount("/app/projects/payments?tab=how-we-work&view=models");expect(await screen.findByRole("heading", { name: "The model each stage uses" })).toBeTruthy();models.unmount();
  mount("/app/projects/payments?tab=how-we-work&view=history");expect(await screen.findByRole("heading", { name: "1 version" })).toBeTruthy();
 });
 it("preserves the lessons query alias: the legacy lessons tab opens Learned", async () => { mount("/app/projects/payments?tab=lessons");expect(await screen.findByRole("heading", { name: "This week" })).toBeTruthy();expect((await screen.findAllByText("Retry only idempotent calls")).length).toBeGreaterThan(0); });
 it("does not claim the Settings slot: the host owns tab=settings, so this entry shows Rules", async () => { mount("/app/projects/payments?tab=settings");expect(await screen.findByRole("heading", { name: "Rules for every task in this project" })).toBeTruthy();expect(screen.queryByRole("heading", { name: "The model each stage uses" })).toBeNull(); });
 it("mounts company rules at its admin-relative route", async () => { mount("/app/admin/how-we-work");expect(await screen.findByText(/One currently authorized project maintainer/)).toBeTruthy(); });
 it("mounts recipe metadata and command text", async () => { mount("/app/admin/how-we-work/recipes");expect(await screen.findByText("Node service")).toBeTruthy();expect(screen.getByText("npm ci")).toBeTruthy(); });
});
