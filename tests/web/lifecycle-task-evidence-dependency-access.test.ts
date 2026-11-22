// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { EvidenceEnvironmentSchema } from "@agentx/contracts/web";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";
import { TaskEvidenceDependencyAccessView } from "../../packages/ui/src/screens/session/TaskEvidenceDependencyAccessView.js";

const environment = (dependencies?: unknown, services: unknown[] = []) => EvidenceEnvironmentSchema.parse({
  tier: "sandbox", envRevision: 4, services, ...(dependencies === undefined ? {} : { dependencies }), data: "synthetic", accounts: [],
});

it("distinguishes an explicitly refused live service from unreadable dependency evidence", () => {
  renderUi(h(TaskEvidenceDependencyAccessView, { environment: environment([], [{ name: "payments", mode: "live-forbidden" }]) }));
  const refused = screen.getByRole("region", { name: "Live dependency access refused" });
  expect(refused.textContent).toContain("The check could not use this live service: payments.");
  expect(refused.textContent).toContain("The evidence does not prove the live integration.");
  expect(refused.textContent).toContain("Configure an allowed test service.");
  expect(refused.textContent).not.toMatch(/passed|failed|connected|provider/i);
});

it("uses the unreadable state when dependency evidence is absent, without claiming a test outcome", () => {
  renderUi(h(TaskEvidenceDependencyAccessView, { environment: environment() }));
  const unreadable = screen.getByRole("region", { name: "Dependency evidence unavailable" });
  expect(unreadable.textContent).toContain("The test dependency's status could not be read.");
  expect(unreadable.textContent).toContain("This is not proof that the code failed.");
  expect(unreadable.textContent).toContain("Load the dependency evidence.");
  expect(unreadable.textContent).not.toMatch(/passed|failed the test|live integration succeeded/i);
});

it("shows contract fallback reasons and keeps runner infrastructure distinct from dependency status", () => {
  const parsed = environment([
    { name: "payments", backing: "fake", label: "hand_written_fake", fellBack: { from: "test_account", reason: "test_account_unreachable" } },
    { name: "queue", backing: "none", label: "not_available", testsNotRun: 2, fellBack: { from: "emulated", reason: "did_not_start" } },
  ]);
  renderUi(h(TaskEvidenceDependencyAccessView, { environment: parsed }));
  const section = screen.getByRole("region", { name: "Dependency fallback" });
  const rows = [...section.querySelectorAll("li")].map(row => row.textContent ?? "");
  expect(rows.some(row => /payments.*test account unreachable/i.test(row))).toBe(true);
  expect(rows.some(row => /queue.*did not start/i.test(row))).toBe(true);
  expect(rows.some(row => /Runner infrastructure/i.test(row))).toBe(true);
  expect(section.textContent).not.toMatch(/test(s)? (passed|failed)|live integration (passed|succeeded)/i);
});
